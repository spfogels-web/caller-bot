/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  enricher.js — adaptive onchain data enrichment layer v6 (NEW-GEM-FOCUSED)
 *
 *  v6 fixes:
 *    - Helius tx analysis now queries pairAddress first (not token CA)
 *      — new tokens' swap activity lives on the pool, not the mint
 *    - BubbleMap skipped for tokens under 2h (returns PENDING, not null)
 *    - LP lock returns null (unknown) instead of 0 (unlocked) when unconfirmable
 *    - Full scanner data fallback — Birdeye takes 10-20min to index new tokens
 *    - Enrichment batched 3 at a time instead of serial 1500ms delay
 *    - Per-service timeouts (Birdeye=12s, Helius=10s, BubbleMap=8s)
 *    - Birdeye retried once for very new tokens (sometimes needs a moment)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import { logEvent } from './db.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const BIRDEYE_BASE   = 'https://public-api.birdeye.so';
const BUBBLEMAP_BASE = 'https://api-legacy.bubblemaps.io';

// Per-service timeouts — don't let one slow service block others
const BIRDEYE_TIMEOUT   = 12_000;
const HELIUS_TIMEOUT    = 10_000;
const BUBBLEMAP_TIMEOUT =  8_000;

// Skip BubbleMap for tokens under this age — it won't have indexed them yet
const BUBBLEMAP_MIN_AGE_HOURS = 2;

const getHeliusRpc = () =>
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ''}`;
const getHeliusApi = () =>
  `https://api.helius.xyz/v0`;

// Free Solana public RPC — use for basic calls to save Helius credits
const SOLANA_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

const getBirdeyeKey    = () => process.env.BIRDEYE_API_KEY ?? '';
const getHeliusKey    = () => process.env.HELIUS_API_KEY  ?? '';
const getLunarCrushKey = () => process.env.LUNARCRUSH_API_KEY ?? '';

const LUNARCRUSH_BASE = 'https://lunarcrush.com/api4/public';

const LP_PROGRAM_IDS = new Set([
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',     // Orca Whirlpool
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP',     // Orca
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',     // Raydium
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',     // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',     // Raydium CPMM
  'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS',     // Raydium Route
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',     // Jupiter
  'MoonCVVNZFSYkqNXP6bxHLPL6QQXiB9AFMKSq3hRMBm',     // Moonshot
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',     // pump.fun v1
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',     // pump.fun AMM (post-migration)
  'TSWAPaqyCSx2KABk68Shruf4rp7CxcAi343YCz73zk',     // Tensor
  'So11111111111111111111111111111111111111112',     // Wrapped SOL
  'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW',     // pump.fun fee recipient
]);
// Extra owners that should ALWAYS be treated as 'not a dev wallet' even though
// their token-account addresses vary per token. We resolve the owner of each
// token account via getMultipleAccounts and filter by this set.
const CONTRACT_OWNERS = new Set([
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',     // pump.fun curve owns its token accounts
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',     // pump.fun AMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',     // Orca
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',     // Raydium pool token accounts
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'MoonCVVNZFSYkqNXP6bxHLPL6QQXiB9AFMKSq3hRMBm',
]);

// Known burn/lock addresses for LP token detection
const BURN_ADDRESSES = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111',
]);

// ─── Utilities ────────────────────────────────────────────────────────────────

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function pct(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

/**
 * Classify the LP-security state of a token from burn / lock percentages +
 * unlock timestamp. Values are 0-100 percentages.
 *
 * Thresholds are tuned for a SHORT-HOLD caller bot — memecoins rarely live
 * 24h, so any lock covering that window is effectively "safe for the hold".
 * A 3-day lock is plenty of runway for a 10x play that fires in minutes.
 *
 *   BURNED          — ≥95% burned (safest — unrugable)
 *   LOCKED_LONG     — ≥80% locked, unlock >30d away
 *   LOCKED_MEDIUM   — ≥80% locked, unlock 7-30d out (safe for any hold window)
 *   LOCKED_SHORT    — ≥80% locked, unlock 1-7d out (still covers typical hold)
 *   LOCKED_IMMINENT — ≥80% locked, unlock within 24h (actual rug window)
 *   PARTIAL         — 50-80% burn+lock: some LP secured, rest free
 *   UNLOCKED        — <20% burn+lock, dev holds LP directly (high rug risk)
 *   UNKNOWN         — no Birdeye data (don't reward or penalize)
 *
 * Note: pump.fun bonding-curve tokens are returned as UNKNOWN here because
 * they have no LP yet — the bonding curve is program-controlled, not
 * LP-rugable. The merge layer re-tags those as BONDING_CURVE.
 */
function classifyLpSecurity(burnedPct, lockedPct, unlockTimeSec) {
  const burn  = Number.isFinite(burnedPct) ? burnedPct : 0;
  const lock  = Number.isFinite(lockedPct) ? lockedPct : 0;
  const safe  = burn + lock;

  if (burnedPct == null && lockedPct == null) return 'UNKNOWN';
  if (burn >= 95) return 'BURNED';

  if (safe >= 80) {
    if (!Number.isFinite(unlockTimeSec)) return 'LOCKED_LONG';
    const daysOut = (unlockTimeSec * 1000 - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysOut >= 30)  return 'LOCKED_LONG';
    if (daysOut >= 7)   return 'LOCKED_MEDIUM';
    if (daysOut >= 1)   return 'LOCKED_SHORT';
    return 'LOCKED_IMMINENT';
  }

  if (safe >= 50) return 'PARTIAL';
  if (safe <  20) return 'UNLOCKED';
  return 'PARTIAL';
}

async function safeFetch(url, options = {}, label = 'fetch', timeoutMs = 12_000) {
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch {}
      console.warn(`[enricher:${label}] HTTP ${res.status} — ${body.slice(0, 150)}`);
      logEvent('WARN', `ENRICHER_HTTP_${res.status}`, `${label} ${url.slice(0, 100)}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.warn(`[enricher:${label}] ${err.name}: ${err.message}`);
    return null;
  }
}

// Previously we routed these 4 methods to api.mainnet-beta.solana.com to
// save Helius credits. That endpoint is aggressively rate-limited and was
// failing ~20% of calls, leaving enrichment with holes (missing holders,
// top10, owner info) that silently hurt scoring. Re-route everything to
// Helius RPC — the cost is ~750 credits/day (<0.3% of budget) vs. ~150
// corrupted enrichments/day we were running on.
const FREE_RPC_METHODS = new Set(); // kept for backwards compat; empty now

async function heliusRpc(method, params, label = 'rpc') {
  const useFreeRpc = FREE_RPC_METHODS.has(method);
  const url = useFreeRpc ? SOLANA_PUBLIC_RPC : getHeliusRpc();

  if (!useFreeRpc && !getHeliusKey()) {
    console.warn('[enricher:helius] No HELIUS_API_KEY for enhanced call');
    return null;
  }

  return safeFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: label, method, params }),
    },
    useFreeRpc ? `solana:${label}` : `helius:${label}`,
    useFreeRpc ? 8_000 : HELIUS_TIMEOUT
  );
}

// ─── Birdeye Enricher ─────────────────────────────────────────────────────────

async function enrichWithBirdeye(ca) {
  const result = { birdeyeOk: false };
  const key = getBirdeyeKey();

  if (!key) {
    console.warn('[enricher:birdeye] No BIRDEYE_API_KEY');
    return result;
  }

  const headers = {
    'X-API-KEY': key,
    'x-chain': 'solana',
    'Accept': 'application/json',
  };

  const [overview, security] = await Promise.all([
    safeFetch(`${BIRDEYE_BASE}/defi/token_overview?address=${ca}`, { headers }, 'birdeye:overview', BIRDEYE_TIMEOUT),
    safeFetch(`${BIRDEYE_BASE}/defi/token_security?address=${ca}`, { headers }, 'birdeye:security', BIRDEYE_TIMEOUT),
  ]);

  if (overview?.data) {
    const d = overview.data;
    result.birdeyeOk       = true;
    result.holders         = d.holder ?? null;
    result.priceUsd        = d.price ?? null;
    result.marketCap       = d.mc ?? d.fdv ?? d.realMc ?? null;
    result.liquidity       = d.liquidity ?? d.realLiquidity ?? null;
    result.volume24h       = d.v24hUSD ?? d.v24h ?? null;
    result.volume6h        = d.v6hUSD ?? d.v6h ?? null;
    result.volume1h        = d.v1hUSD ?? d.v1h ?? null;
    result.holderGrowth24h = d.uniqueWallet24hChangePercent ?? null;
    result.priceChange24h  = d.priceChange24hPercent ?? d.priceChange24h ?? null;
    result.priceChange1h   = d.priceChange1hPercent  ?? d.priceChange1h  ?? null;
    result.priceChange6h   = d.priceChange6hPercent  ?? d.priceChange6h  ?? null;
    result.priceChange5m   = d.priceChange5mPercent  ?? d.priceChange5m  ?? null;

    // Pull token name/symbol from Birdeye if not already set
    if (d.symbol)  result.token     = result.token || d.symbol;
    if (d.name)    result.tokenName = result.tokenName || d.name;
    console.log(`[enricher:birdeye] ✓ holders:${result.holders} mcap:${result.marketCap?.toFixed?.(0) ?? '?'} symbol:${result.token ?? '?'}`);
  } else {
    console.warn('[enricher:birdeye] ✗ no overview (token may be too new for Birdeye index)');
  }

  if (security?.data) {
    const s = security.data;
    result.birdeyeOk = true;

    if (s.top10HolderPercent != null) result.top10HolderPct = s.top10HolderPercent * 100;
    if (s.creatorPercentage != null)  result.devWalletPct   = s.creatorPercentage * 100;
    else if (s.ownerPercentage != null) result.devWalletPct = s.ownerPercentage * 100;

    if (s.freezeAuthority != null) result.freezeAuthority = s.freezeAuthority ? 1 : 0;
    if (s.isMutable != null)       result.mintAuthority   = s.isMutable ? 1 : 0;

    // ── LP SECURITY — broader parse of Birdeye's security fields ─────────
    // Birdeye returns a bag of LP fields under different names depending on
    // age/source. Read them all greedily so we can classify properly later.
    //   - lpBurnedPercentage / lpBurnPercentage — how much LP sent to burn
    //   - lockInfo.lockedPercent / lpLockedPercentage — how much in lockers
    //   - lockInfo.unlockTime — unix seconds when lock releases
    const lpBurnedPct = toNum(s.lpBurnedPercentage ?? s.lpBurnPercentage, null);
    const lpLockedPct = toNum(s.lpLockedPercentage ?? s.lockInfo?.lockedPercent, null);
    const unlockTime  = toNum(s.lockInfo?.unlockTime ?? s.lpUnlockAt, null);
    if (lpBurnedPct != null) result.lpBurnedPct    = lpBurnedPct;
    if (lpLockedPct != null) result.lpLockedPct    = lpLockedPct;
    if (unlockTime  != null) result.lpUnlockAtSec  = unlockTime;

    // Legacy lpLocked flag — still set for backwards compat when clearly safe
    if (s.lpBurned === true || lpBurnedPct >= 95 || (lpLockedPct ?? 0) >= 80) {
      result.lpLocked = 1;
    }

    // Compose lpSecurityStatus for scorer/caption consumption
    result.lpSecurityStatus = classifyLpSecurity(lpBurnedPct, lpLockedPct, unlockTime);

    console.log(`[enricher:birdeye] ✓ security — top10:${result.top10HolderPct?.toFixed?.(1) ?? '?'}% dev:${result.devWalletPct?.toFixed?.(1) ?? '?'}% lp:${result.lpSecurityStatus ?? '?'}`);
  } else {
    console.warn('[enricher:birdeye] ✗ no security data');
  }

  return result;
}

// Birdeye with one retry for very new tokens
async function enrichWithBirdeyeWithRetry(ca, pairAgeHours) {
  const result = await enrichWithBirdeye(ca);

  // If Birdeye failed and token is under 30min, wait 2s and try once more
  // Birdeye sometimes needs a moment to index brand new tokens
  if (!result.birdeyeOk && pairAgeHours != null && pairAgeHours < 0.5) {
    console.log('[enricher:birdeye] Retrying for new token in 2s...');
    await new Promise(r => setTimeout(r, 2000));
    return enrichWithBirdeye(ca);
  }

  return result;
}

// ─── Helius Enricher ──────────────────────────────────────────────────────────

async function enrichWithHelius(ca, pairAddress = null) {
  const result = { heliusOk: false };
  const key = getHeliusKey();

  if (!key) {
    console.warn('[enricher:helius] No HELIUS_API_KEY');
    return result;
  }

  const [mintData, holdersData, supplyData, txData] = await Promise.all([
    heliusRpc('getAccountInfo', [ca, { encoding: 'jsonParsed' }], 'mintInfo'),
    heliusRpc('getTokenLargestAccounts', [ca, { commitment: 'finalized' }], 'topHolders'),
    heliusRpc('getTokenSupply', [ca], 'supply'),
    fetchHeliusTransactions(ca, pairAddress, key),
  ]);

  // Log what Helius returned so we can diagnose data gaps
  const holdersCount = holdersData?.result?.value?.length ?? 0;
  const supplyOk = !!supplyData?.result?.value;
  const txCount = Array.isArray(txData) ? txData.length : 0;
  console.log(`[enricher:helius] Raw data — holders:${holdersCount} supply:${supplyOk?'✓':'✗'} txns:${txCount} mint:${mintData?.result?.value?'✓':'✗'}`);

  // ── Mint / Freeze / Supply ────────────────────────────────────────────────
  const mintInfo = mintData?.result?.value?.data?.parsed?.info;
  if (mintInfo) {
    result.heliusOk        = true;
    result.mintAuthority   = mintInfo.mintAuthority ? 1 : 0;
    result.freezeAuthority = mintInfo.freezeAuthority ? 1 : 0;
    result.tokenSupply     = mintInfo.supply ?? null;
    result.decimals        = mintInfo.decimals ?? null;
  }

  // ── Top Holder Analysis ────────────────────────────────────────────────────
  const holders    = holdersData?.result?.value ?? [];
  const supplyInfo = supplyData?.result?.value  ?? null;

  if (holders.length && supplyInfo) {
    result.heliusOk = true;
    const totalSupply = Number(supplyInfo.amount);

    if (totalSupply > 0) {
      // BUGFIX v2: pump.fun curve and LP pools were slipping through because
      // ownership has TWO layers for token accounts:
      //   1. Token account → owned by a wallet (could be human OR a PDA)
      //   2. That wallet → owned by a PROGRAM (System Program = human,
      //      pump.fun = bonding curve, Raydium = pool, etc.)
      // We need to resolve BOTH layers then check if the wallet is itself
      // a PDA of a known contract.
      let resolvedOwners = {};       // tokenAcct → wallet address
      let walletOwnerPrograms = {};  // wallet address → program that owns it
      try {
        // Step 1 — token account → wallet owner
        const topAddrs = holders.slice(0, 20).map(h => h.address);
        const tokenAcctRes = await heliusRpc(
          'getMultipleAccounts',
          [topAddrs, { encoding: 'jsonParsed', commitment: 'confirmed' }],
          'holderOwners'
        );
        const tokenAccts = tokenAcctRes?.result?.value ?? [];
        const walletsToCheck = [];
        tokenAccts.forEach((acct, i) => {
          const owner = acct?.data?.parsed?.info?.owner;
          if (owner) {
            resolvedOwners[topAddrs[i]] = owner;
            walletsToCheck.push(owner);
          }
        });

        // Step 2 — wallet → program that owns the account
        // Human wallets are owned by System Program (11111111111111111111111111111111).
        // Contract PDAs are owned by pump.fun / Raydium / etc.
        if (walletsToCheck.length) {
          const uniqueWallets = [...new Set(walletsToCheck)];
          const walletRes = await heliusRpc(
            'getMultipleAccounts',
            [uniqueWallets, { commitment: 'confirmed' }],   // no jsonParsed — we just need top-level .owner
            'walletOwners'
          );
          const walletInfo = walletRes?.result?.value ?? [];
          walletInfo.forEach((info, i) => {
            if (info?.owner) walletOwnerPrograms[uniqueWallets[i]] = info.owner;
          });
        }
      } catch (err) {
        console.warn('[enricher:helius] owner resolution failed:', err.message);
      }

      const isContractAccount = (holderAddress) => {
        // 1. Static block-list (token-account addresses that we always skip)
        if (LP_PROGRAM_IDS.has(holderAddress)) return true;
        // 2. Pair address
        if (pairAddress && holderAddress === pairAddress) return true;
        // 3. Owner wallet itself is a known LP address
        const ownerWallet = resolvedOwners[holderAddress];
        if (ownerWallet && LP_PROGRAM_IDS.has(ownerWallet)) return true;
        // 4. MOST IMPORTANT — the owner wallet is a PDA of a known contract program
        //    (this is how pump.fun bonding curves are caught)
        const ownerProgram = walletOwnerPrograms[ownerWallet];
        if (ownerProgram && CONTRACT_OWNERS.has(ownerProgram)) return true;
        return false;
      };

      const realHolders = holders.filter(h => !isContractAccount(h.address));
      result.contractHoldersFiltered = holders.length - realHolders.length;

      const top10    = realHolders.slice(0, 10);
      const top10Amt = top10.reduce((s, h) => s + Number(h.amount), 0);
      result.top10HolderPct_helius = pct(top10Amt, totalSupply);

      if (realHolders[0]) {
        result.devWalletPct_helius = pct(Number(realHolders[0].amount), totalSupply);
        result.devWalletAddress    = realHolders[0].address;
      }

      result.holderList = realHolders.slice(0, 20).map(h => ({
        address: h.address,
        pct:     pct(Number(h.amount), totalSupply),
      }));

      // FIXED: LP lock detection — only set 1 if we can confirm lock/burn
      // Return null (unknown) instead of 0 (unlocked) when unconfirmable
      const lpBurned    = holders.some(h => BURN_ADDRESSES.has(h.address));
      const lpInLocker  = holders.some(h => LP_PROGRAM_IDS.has(h.address));
      result.lpLocked_helius = (lpBurned || lpInLocker) ? 1 : null;
      // null = unknown = no penalty in scorer
      // Previously this was returning 0 for "not in known lockers" which caused -20

      const top5    = realHolders.slice(0, 5);
      const top5Amt = top5.reduce((s, h) => s + Number(h.amount), 0);
      result.top5HolderPct = pct(top5Amt, totalSupply);

      const holderPcts = result.holderList.map(h => h.pct).filter(v => v != null);
      if (holderPcts.length >= 3) {
        const avgTop3 = holderPcts.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
        result.holderDistributionScore = clamp(Math.round(100 - avgTop3 * 2), 0, 100);
      }
    }
  }

  // ── Launch Window Analysis ────────────────────────────────────────────────
  if (Array.isArray(txData) && txData.length) {
    result.heliusOk = true;

    const txs       = txData;
    const launchTxs = txs.slice(0, 30);
    const feePayers = launchTxs.map(tx => tx.feePayer).filter(Boolean);
    const uniqueBuyers  = uniq(feePayers);
    const uniqueCount   = uniqueBuyers.length;
    const totalTxs      = launchTxs.length;

    result.launchTxCount            = totalTxs;
    result.launchUniqueBuyerCount   = uniqueCount;
    result.launchUniqueBuyerRatio   = totalTxs > 0 ? uniqueCount / totalTxs : null;

    const buyerFrequency = {};
    for (const payer of feePayers) {
      buyerFrequency[payer] = (buyerFrequency[payer] ?? 0) + 1;
    }

    const freqValues    = Object.values(buyerFrequency).sort((a, b) => b - a);
    const topBuyerTxs   = freqValues[0] ?? 0;
    const top3BuyerTxs  = freqValues.slice(0, 3).reduce((a, b) => a + b, 0);

    result.launchTopBuyerShare  = totalTxs > 0 ? topBuyerTxs / totalTxs : null;
    result.launchTop3BuyerShare = totalTxs > 0 ? top3BuyerTxs / totalTxs : null;

    if (totalTxs >= 3) { // lowered from 5 — even 3 txns can reveal bundling
      const bundleRatio = uniqueCount / totalTxs;

      if      (bundleRatio < 0.25) result.bundleRisk_helius = 'SEVERE';
      else if (bundleRatio < 0.40) result.bundleRisk_helius = 'HIGH';
      else if (bundleRatio < 0.60) result.bundleRisk_helius = 'MEDIUM';
      else if (bundleRatio < 0.80) result.bundleRisk_helius = 'LOW';
      else                         result.bundleRisk_helius = 'NONE';

      result.sniperWalletCount = Math.max(0, totalTxs - uniqueCount);
    } else if (totalTxs > 0) {
      // Even 1-2 txns — mark as LOW, at least it's not "?"
      result.bundleRisk_helius = 'LOW';
      result.sniperWalletCount = 0;
    }

    let launchQuality = 50;
    if (result.launchUniqueBuyerRatio != null) {
      if      (result.launchUniqueBuyerRatio >= 0.75) launchQuality += 20;
      else if (result.launchUniqueBuyerRatio >= 0.55) launchQuality += 10;
      else if (result.launchUniqueBuyerRatio < 0.35)  launchQuality -= 20;
    }
    if (result.launchTopBuyerShare != null) {
      if      (result.launchTopBuyerShare > 0.30) launchQuality -= 15;
      else if (result.launchTopBuyerShare < 0.15) launchQuality += 5;
    }
    if (result.launchTop3BuyerShare != null) {
      if      (result.launchTop3BuyerShare > 0.60) launchQuality -= 20;
      else if (result.launchTop3BuyerShare < 0.35) launchQuality += 8;
    }

    result.launchQualityScore = clamp(Math.round(launchQuality), 0, 100);

    result.freshWalletInflows = launchTxs.some(
      tx => tx.type === 'SWAP' && (tx.source === 'UNKNOWN' || tx.source == null)
    );
  }

  return result;
}

/**
 * FIXED: Query pair address first for swap transactions.
 * On Solana, new Raydium pairs' swap activity is on the pool address,
 * not the token's mint address. Old code queried the mint = 0 results.
 */
async function fetchHeliusTransactions(ca, pairAddress, key) {
  // Try pair address first — this is where Raydium swap txns live
  if (pairAddress && pairAddress !== ca) {
    const result = await safeFetch(
      `${getHeliusApi()}/addresses/${pairAddress}/transactions?api-key=${key}&limit=50&type=SWAP`,
      { headers: { 'Accept': 'application/json' } },
      'helius:tx:pair',
      HELIUS_TIMEOUT
    );

    if (result && Array.isArray(result) && result.length > 0) {
      console.log(`[enricher:helius] ✓ ${result.length} txns via pairAddress`);
      return result;
    }
    console.log('[enricher:helius] pairAddress txns empty, trying token CA...');
  }

  // Fall back to token CA
  const result = await safeFetch(
    `${getHeliusApi()}/addresses/${ca}/transactions?api-key=${key}&limit=50&type=SWAP`,
    { headers: { 'Accept': 'application/json' } },
    'helius:tx:ca',
    HELIUS_TIMEOUT
  );

  if (result && Array.isArray(result)) {
    console.log(`[enricher:helius] ${result.length > 0 ? '✓' : '✗'} ${result.length} txns via tokenCA`);
  }
  return result;
}

// ─── BubbleMap Enricher ───────────────────────────────────────────────────────

async function enrichWithBubbleMap(ca) {
  const result = { bubblemapOk: false };

  const data = await safeFetch(
    `${BUBBLEMAP_BASE}/map-metadata?token=${ca}&chain=sol`,
    { headers: { 'Accept': 'application/json' } },
    'bubblemap',
    BUBBLEMAP_TIMEOUT
  );

  if (!data || data.status === 'error' || data.error) {
    console.warn('[enricher:bubblemap] ✗ no data');
    return result;
  }

  result.bubblemapOk = true;

  const score = data.decentralizationScore ?? null;
  if (score !== null) {
    if      (score >= 70) { result.bubbleMapRisk = 'CLEAN';     result.walletClusterRisk = 'NONE'; }
    else if (score >= 50) { result.bubbleMapRisk = 'MODERATE';  result.walletClusterRisk = 'LOW'; }
    else if (score >= 30) { result.bubbleMapRisk = 'CLUSTERED'; result.walletClusterRisk = 'HIGH'; }
    else                  { result.bubbleMapRisk = 'SEVERE';    result.walletClusterRisk = 'HIGH'; }
  }

  if (data.clusters?.length) {
    const insiders    = data.clusters.filter(c => c.isInsider === true || c.type === 'insider');
    const insiderPct  = insiders.reduce((s, c) => s + (c.percentage ?? 0), 0);
    if (insiderPct > 0) result.insiderWalletPct = insiderPct;

    result.clusterCount      = data.clusters.length;
    result.largestClusterPct = Math.max(...data.clusters.map(c => c.percentage ?? 0), 0);
  }

  if (data.freshWallets != null) {
    result.freshWalletInflows = data.freshWallets > 0;
    result.freshWalletCount   = data.freshWallets;
  }

  return result;
}

// ─── Derived Analysis ─────────────────────────────────────────────────────────

function inferNarrativeTags(candidate) {
  const text = `${candidate.tokenName ?? ''} ${candidate.token ?? ''}`.toLowerCase();
  const tags = [];
  const patterns = [
    [/\bai\b|gpt|llm|neural|agent|robot/, 'AI'],
    [/pepe|frog|wojak|chad/, 'MEME'],
    [/doge|shib|inu|dog|cat|puppy|kitty/, 'ANIMAL_MEME'],
    [/rwa|real.?world|asset|property/, 'RWA'],
    [/game|gaming|play|nft|metaverse/, 'GAMING'],
    [/pump|moon|gem|100x|1000x|rocket/, 'HYPE'],
    [/dao|gov|vote|protocol/, 'DAO'],
    [/defi|swap|yield|lend|farm|liquid/, 'DEFI'],
    [/trump|maga|political|biden|election/, 'POLITICAL'],
    [/elon|musk|grok|tesla|spacex/, 'ELON_META'],
    [/baby|mini|micro|tiny/, 'BABY_META'],
    [/sol|solana/, 'SOLANA_NATIVE'],
    [/btc|bitcoin|satoshi/, 'BTC_META'],
    [/anime|manga|waifu|kawaii/, 'ANIME'],
  ];

  for (const [pattern, tag] of patterns) {
    if (pattern.test(text)) tags.push(tag);
  }

  if (candidate.labels?.includes('PUMP')) tags.push('PUMP_FUN');
  return uniq(tags);
}

function analyzeVolumeQuality(candidate) {
  const buys   = candidate.buys24h  ?? 0;
  const sells  = candidate.sells24h ?? 0;
  const total  = buys + sells;
  const vol24h = candidate.volume24h ?? 0;

  if (total === 0) return 'UNKNOWN';

  const buyRatio = buys / total;
  if (buyRatio > 0.47 && buyRatio < 0.53 && vol24h > 500_000) return 'WASH';
  if (buyRatio >= 0.55 && buyRatio <= 0.80) return 'ORGANIC';
  if (buyRatio > 0.80 || buyRatio < 0.35) return 'MIXED';
  return 'ORGANIC';
}

function isChartExtended(candidate) {
  const c24 = candidate.priceChange24h ?? 0;
  const c6  = candidate.priceChange6h  ?? 0;
  const c1  = candidate.priceChange1h  ?? 0;
  if (c24 > 500 || c6 > 200 || c1 > 100) return true;
  if (c24 > 200 && c6 > 100) return true;
  return false;
}

function scoreSocialCompleteness(candidate) {
  let score = 0;
  if (candidate.website)  score += 33;
  if (candidate.twitter)  score += 33;
  if (candidate.telegram) score += 34;
  return score;
}

function inferDeployerRisk(enriched) {
  const devPct      = enriched.devWalletPct  ?? 0;
  const bundleRisk  = enriched.bundleRisk    ?? 'UNKNOWN';
  const top10       = enriched.top10HolderPct ?? 0;
  const insiderPct  = enriched.insiderWalletPct ?? 0;

  if (devPct > 20 || insiderPct > 30) return 'FLAGGED';
  if (bundleRisk === 'SEVERE')         return 'FLAGGED';
  if (bundleRisk === 'HIGH' || top10 > 60) return 'SUSPICIOUS';
  return 'CLEAN';
}

function deriveMicroMetrics(candidate) {
  const out = {};

  const volume1h  = toNum(candidate.volume1h,  0);
  const volume6h  = toNum(candidate.volume6h,  0);
  const volume24h = toNum(candidate.volume24h, 0);
  const buys1h    = toNum(candidate.buys1h,    0);
  const buys6h    = toNum(candidate.buys6h,    0);
  const sells1h   = toNum(candidate.sells1h,   0);
  const sells6h   = toNum(candidate.sells6h,   0);
  const txns1h    = buys1h + sells1h;
  const txns6h    = buys6h + sells6h;

  out.buySellRatio1h   = txns1h > 0 ? buys1h / txns1h : null;
  out.buySellRatio6h   = txns6h > 0 ? buys6h / txns6h : null;
  out.volumeVelocity   = volume6h > 0 ? volume1h / volume6h : null;
  out.buyVelocity      = buys6h   > 0 ? buys1h   / buys6h   : null;
  out.sellVelocity     = sells6h  > 0 ? sells1h  / sells6h  : null;
  out.txnVelocity      = txns6h   > 0 ? txns1h   / txns6h   : null;
  out.volume5mEstimate = volume1h > 0 ? volume1h / 12 : null;
  out.uniqueBuyers5mEstimate = buys1h > 0 ? Math.round(buys1h / 12) : null;
  out.netBuyPressure1h = txns1h > 0 ? (buys1h - sells1h) / txns1h : null;

  const p5 = toNum(candidate.priceChange5m, 0);
  const p1 = toNum(candidate.priceChange1h, 0);

  let firstDumpRecoveryScore = 50;
  if (p5 > 0 && p1 > 0)        firstDumpRecoveryScore += 10;
  if (p5 < 0 && p1 > 10)       firstDumpRecoveryScore += 18;
  if (p5 < -10 && p1 < 0)      firstDumpRecoveryScore -= 20;
  if (candidate.chartExtended)  firstDumpRecoveryScore -= 10;
  out.firstDumpRecoveryScore = clamp(Math.round(firstDumpRecoveryScore), 0, 100);

  let continuation = 50;
  if (p5 > 8)                          continuation += 12;
  if (p1 > 20)                         continuation += 12;
  if ((out.buySellRatio1h ?? 0) > 0.58) continuation += 8;
  if ((out.volumeVelocity ?? 0) > 0.25) continuation += 8;
  if ((out.buyVelocity ?? 0) > 0.25)    continuation += 8;
  if ((out.buySellRatio1h ?? 1) < 0.42) continuation -= 20;
  out.breakoutContinuationScore = clamp(Math.round(continuation), 0, 100);

  if (volume24h > 0 && volume1h > 0) {
    out.volume1hShareOf24h = volume1h / volume24h;
  }

  return out;
}

function addPlaceholderHistoryFields(enriched) {
  if (enriched.deployerWinRate    == null) enriched.deployerWinRate    = null;
  if (enriched.deployerRugRate    == null) enriched.deployerRugRate    = null;
  if (enriched.clusterWinRate     == null) enriched.clusterWinRate     = null;
  if (enriched.clusterRugRate     == null) enriched.clusterRugRate     = null;
  if (enriched.repeatWinningWallets == null) enriched.repeatWinningWallets = null;
  if (enriched.repeatRugWallets   == null) enriched.repeatRugWallets   = null;
  if (enriched.socialCreationRecency == null) enriched.socialCreationRecency = null;
  if (enriched.websiteDomainAge   == null) enriched.websiteDomainAge   = null;
}

function mergeEnrichmentData(candidate, birdeyeData, heliusData, bubblemapData, lunarData = {}) {
  const merged = {
    ...candidate,
    ...birdeyeData,
    ...heliusData,
    ...bubblemapData,
    ...lunarData,
  };

  // FIXED: Comprehensive scanner data fallback
  // Birdeye takes 10-20min to index new tokens — scanner data is often more accurate
  const scannerFallbackFields = [
    'marketCap', 'liquidity', 'volume24h', 'volume6h', 'volume1h',
    'priceChange24h', 'priceChange6h', 'priceChange1h', 'priceChange5m',
    'buys1h', 'sells1h', 'buys6h', 'sells6h', 'buys24h', 'sells24h',
    'txns1h', 'txns6h', 'txns24h', 'buySellRatio1h', 'buySellRatio6h',
    'volumeVelocity', 'buyVelocity', 'pairAgeHours', 'stage',
    'priceUsd',
  ];

  for (const field of scannerFallbackFields) {
    if (merged[field] == null && candidate[field] != null) {
      merged[field] = candidate[field];
    }
  }

  // Helius data takes priority for on-chain fields (more accurate than Birdeye)
  if (heliusData.top10HolderPct_helius != null) merged.top10HolderPct = heliusData.top10HolderPct_helius;
  if (heliusData.devWalletPct_helius   != null) merged.devWalletPct   = heliusData.devWalletPct_helius;
  if (heliusData.mintAuthority         != null) merged.mintAuthority   = heliusData.mintAuthority;
  if (heliusData.freezeAuthority       != null) merged.freezeAuthority = heliusData.freezeAuthority;
  if (heliusData.bundleRisk_helius     != null) merged.bundleRisk      = heliusData.bundleRisk_helius;

  // LP lock: only override if Helius confirmed it (null stays null = unknown)
  if (heliusData.lpLocked_helius === 1) {
    merged.lpLocked = 1;
  }
  // If lpLocked_helius is null, don't set merged.lpLocked to 0 — leave as null (unknown)

  // pump.fun pre-graduation tokens don't have an LP yet — all liquidity is
  // in the program-controlled bonding curve. Mark these as BONDING_CURVE so
  // the scorer treats them as "not an LP-rug vector" rather than UNLOCKED.
  // Detection: candidate.dex === 'pumpfun' and market cap < ~70K (graduation).
  if (
    (merged.lpSecurityStatus == null || merged.lpSecurityStatus === 'UNKNOWN') &&
    (candidate.dex === 'pumpfun' || candidate.dex === 'pump-fun' || candidate.dex === 'pump.fun') &&
    (merged.marketCap ?? 0) < 70_000
  ) {
    merged.lpSecurityStatus = 'BONDING_CURVE';
  }

  merged.heliusOk    = heliusData.heliusOk    ?? false;
  merged.birdeyeOk   = birdeyeData.birdeyeOk  ?? false;
  merged.bubblemapOk = bubblemapData.bubblemapOk ?? false;

  return merged;
}

// ─── Main Export ──────────────────────────────────────────────────────────────

// ─── LunarCrush Social Intelligence ──────────────────────────────────────────
// In-memory cache keyed by CA — rescans of the same token don't re-hit LC.
// Also a daily circuit breaker: once we see 429, we back off for the rest of
// the hour so we don't keep burning retries against a rate-limited API.
const _lcCache = new Map(); // ca -> { result, expiresAt }
const LC_CACHE_TTL_MS = 45 * 60 * 1000; // 45 minutes
let   _lcBreakerUntil = 0; // ms epoch — skip all calls until this time

async function enrichWithLunarCrush(tokenSymbol, contractAddress) {
  const result = { lunarCrushOk: false };
  const key = getLunarCrushKey();
  if (!key) {
    console.log('[enricher:lunarcrush] ✗ LUNARCRUSH_API_KEY not set');
    return result;
  }

  // Cache hit — same CA scanned/rescanned within TTL gets the stored result
  if (contractAddress) {
    const hit = _lcCache.get(contractAddress);
    if (hit && hit.expiresAt > Date.now()) {
      return hit.result;
    }
  }

  // Circuit breaker — if we hit rate-limit recently, skip entirely
  if (Date.now() < _lcBreakerUntil) {
    return result;
  }

  // v4 endpoint reality for fresh Solana memes:
  //   /coins/<X>/v1     — needs LC's internal coin ID (won't work for fresh CAs)
  //   /topic/<slug>/v1  — topic lookup, works for any symbol/keyword
  //   /coins/list/v1    — ALL coins, way too much; skip
  // Strategy: hit topic first (works for most symbols), fall back to coins endpoint.
  const queries = [];
  if (tokenSymbol)     queries.push({ path: `topic/${tokenSymbol.toLowerCase()}/v1`,        shape: 'topic' });
  if (contractAddress) queries.push({ path: `coins/${contractAddress}/v1`,                  shape: 'coins' });
  if (tokenSymbol)     queries.push({ path: `coins/${tokenSymbol.toUpperCase()}-solana/v1`, shape: 'coins' });

  const diagnostics = [];
  for (const { path, shape } of queries) {
    try {
      const res = await fetch(`${LUNARCRUSH_BASE}/${path}`, {
        headers: { 'Authorization': `Bearer ${key}` },
        signal: AbortSignal.timeout(6000),
      });
      diagnostics.push(`${path}→${res.status}`);
      if (res.status === 429) {
        // Daily quota hit — back off for 1 hour before trying again
        _lcBreakerUntil = Date.now() + 60 * 60 * 1000;
        console.log('[enricher:lunarcrush] 🚧 429 rate-limit — circuit broken for 60min');
        return result;
      }
      if (!res.ok) continue;
      const data = await res.json();
      const d = data?.data;
      if (!d) continue;

      result.lunarCrushOk = true;
      if (shape === 'topic') {
        // Topic endpoint fields
        result.socialScore        = d.interactions_24h ? Math.min(100, Math.round(Math.log10(d.interactions_24h + 1) * 15)) : null;
        result.socialVolume       = d.num_posts ?? null;
        result.socialVolume24h    = d.num_posts ?? d.interactions_24h ?? null;
        result.socialSentiment    = d.types_sentiment?.tweet ?? d.sentiment ?? null;
        result.twitterMentions    = d.num_posts ?? null;
        result.twitterEngagement  = d.interactions_24h ?? null;
        result.socialContributors = d.num_contributors ?? null;
        result.socialSpike        = (d.trend ?? '').toLowerCase() === 'up';
      } else {
        // Coins endpoint fields
        result.socialScore        = d.galaxy_score ?? d.alt_rank_30d ?? null;
        result.socialVolume       = d.social_volume ?? null;
        result.socialVolume24h    = d.social_volume_24h ?? d.social_volume ?? null;
        result.socialDominance    = d.social_dominance ?? null;
        result.socialSentiment    = d.sentiment ?? null;
        result.twitterMentions    = d.tweet_mentions ?? d.tweets ?? null;
        result.twitterEngagement  = d.tweet_interactions ?? null;
        result.twitterFollowers   = d.twitter_followers ?? null;
        result.socialContributors = d.social_contributors ?? null;
        result.galaxyScore        = d.galaxy_score ?? null;
        result.altRank            = d.alt_rank ?? null;
        result.newsVolume         = d.news ?? null;
        result.socialSpike        = (d.social_volume_24h ?? 0) > (d.social_volume ?? 1) * 2;
      }

      console.log(`[enricher:lunarcrush] ✓ ${shape} ${path} → score:${result.socialScore ?? '?'} sentiment:${result.socialSentiment ?? '?'} mentions:${result.twitterMentions ?? '?'}`);
      if (contractAddress) _lcCache.set(contractAddress, { result, expiresAt: Date.now() + LC_CACHE_TTL_MS });
      return result;
    } catch (e) {
      diagnostics.push(`${path}→threw:${e.message?.slice(0,40)}`);
    }
  }

  // No luck — cache the miss too so we don't keep asking for a token LC can't
  // resolve. Shorter TTL (15 min) so newly-indexed tokens get picked up soon.
  if (contractAddress) _lcCache.set(contractAddress, { result, expiresAt: Date.now() + 15 * 60 * 1000 });
  console.log(`[enricher:lunarcrush] ✗ no data for ${tokenSymbol ?? contractAddress?.slice(0,8) ?? '?'} · ${diagnostics.join(' · ')}`);
  return result;
}

export async function enrichCandidate(candidate) {
  const ca          = candidate.contractAddress;
  // `pairAddress` may get reassigned below (pre-flight DexScreener fills
  // it in when missing) — must be `let`, not `const`. Previously thrown:
  // "Assignment to constant variable" on every enrichment attempting the
  // pre-flight path, silently breaking enrichment for a big chunk of
  // Helius-listener-sourced candidates.
  let pairAddress   = candidate.pairAddress ?? null;
  const ageHours    = candidate.pairAgeHours ?? null;

  if (!ca) return candidate;

  console.log(`[enricher] ━━ Enriching $${candidate.token ?? ca} (${ca.slice(0, 8)}…) age:${ageHours != null ? ageHours.toFixed(1) + 'h' : '?'} pair:${pairAddress ? pairAddress.slice(0,8) : 'NONE'}`);

  // ── Pre-flight: if no pairAddress, grab it from DexScreener first ──────
  // Helius TX fetch needs the pair address to find swap transactions.
  // Tokens from the Helius WebSocket often have no pair address.
  if (!pairAddress) {
    try {
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, {
        headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(5000),
      });
      if (dexRes.ok) {
        const dexData = await dexRes.json();
        const pair = (dexData?.pairs ?? []).filter(p => p.chainId === 'solana').sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        if (pair?.pairAddress) {
          pairAddress = pair.pairAddress;
          // Also fill in missing basic data
          candidate.token      = candidate.token      ?? pair.baseToken?.symbol ?? null;
          candidate.tokenName  = candidate.tokenName  ?? pair.baseToken?.name ?? null;
          candidate.buys1h     = candidate.buys1h     ?? pair.txns?.h1?.buys ?? null;
          candidate.sells1h    = candidate.sells1h    ?? pair.txns?.h1?.sells ?? null;
          candidate.marketCap  = candidate.marketCap  ?? pair.marketCap ?? pair.fdv ?? null;
          candidate.liquidity  = candidate.liquidity  ?? pair.liquidity?.usd ?? null;
          if (pair.pairCreatedAt && candidate.pairAgeHours == null) {
            candidate.pairAgeHours = (Date.now() - pair.pairCreatedAt) / 3_600_000;
          }
          console.log(`[enricher] Pre-flight DexScreener: got pairAddress ${pairAddress.slice(0,8)} + basic data`);
        }
      }
    } catch (e) { console.warn('[enricher] Pre-flight DexScreener failed:', e.message); }
  }

  const isVeryNew = (candidate.pairAgeHours ?? ageHours) != null && (candidate.pairAgeHours ?? ageHours) < BUBBLEMAP_MIN_AGE_HOURS;

  const bubblemapPromise = isVeryNew
    ? Promise.resolve({ bubblemapOk: false, bubbleMapRisk: 'PENDING' })
    : enrichWithBubbleMap(ca);

  // Gate LunarCrush — skip for dead / low-traction tokens. LC doesn't index
  // tokens with no social footprint, so calling on $2K-mcap freshies just
  // burns our daily quota. Require either real volume OR real mcap before
  // we spend a LunarCrush request.
  const lcWorthCalling = (
    (candidate.marketCap ?? 0) >= 15_000 ||
    (candidate.volume1h  ?? 0) >= 5_000  ||
    (candidate.buys1h    ?? 0) >= 20
  );
  const lunarPromise = lcWorthCalling
    ? enrichWithLunarCrush(candidate.token, ca)
    : Promise.resolve({ lunarCrushOk: false });

  const [birdeyeData, heliusData, bubblemapData, lunarData] = await Promise.all([
    enrichWithBirdeyeWithRetry(ca, candidate.pairAgeHours ?? ageHours),
    enrichWithHelius(ca, pairAddress),
    bubblemapPromise,
    lunarPromise,
  ]);

  // ── DexScreener fallback — fill buys/sells/mcap if scanner didn't provide them ──
  if (candidate.buys1h == null || candidate.sells1h == null) {
    try {
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      if (dexRes.ok) {
        const dexData = await dexRes.json();
        const pair = (dexData?.pairs ?? [])
          .filter(p => p.chainId === 'solana')
          .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        if (pair) {
          candidate.buys1h     = candidate.buys1h     ?? pair.txns?.h1?.buys   ?? null;
          candidate.sells1h    = candidate.sells1h    ?? pair.txns?.h1?.sells  ?? null;
          candidate.buys6h     = candidate.buys6h     ?? pair.txns?.h6?.buys   ?? null;
          candidate.sells6h    = candidate.sells6h    ?? pair.txns?.h6?.sells  ?? null;
          candidate.buys24h    = candidate.buys24h    ?? pair.txns?.h24?.buys  ?? null;
          candidate.sells24h   = candidate.sells24h   ?? pair.txns?.h24?.sells ?? null;
          candidate.marketCap  = candidate.marketCap  ?? pair.marketCap ?? pair.fdv ?? null;
          candidate.liquidity  = candidate.liquidity  ?? pair.liquidity?.usd ?? null;
          candidate.volume1h   = candidate.volume1h   ?? pair.volume?.h1  ?? null;
          candidate.volume24h  = candidate.volume24h  ?? pair.volume?.h24 ?? null;
          candidate.token      = candidate.token      ?? pair.baseToken?.symbol ?? null;
          candidate.tokenName  = candidate.tokenName  ?? pair.baseToken?.name ?? null;
          candidate.priceChange5m  = candidate.priceChange5m  ?? pair.priceChange?.m5  ?? null;
          candidate.priceChange1h  = candidate.priceChange1h  ?? pair.priceChange?.h1  ?? null;
          candidate.priceChange6h  = candidate.priceChange6h  ?? pair.priceChange?.h6  ?? null;
          candidate.priceChange24h = candidate.priceChange24h ?? pair.priceChange?.h24 ?? null;
          if (pair.pairCreatedAt && candidate.pairAgeHours == null) {
            candidate.pairAgeHours = (Date.now() - pair.pairCreatedAt) / 3_600_000;
          }
          console.log(`[enricher:dexscreener] ✓ fallback — buys1h:${candidate.buys1h} sells1h:${candidate.sells1h} mcap:${candidate.marketCap}`);
        }
      }
    } catch (e) {
      console.warn(`[enricher:dexscreener] fallback failed: ${e.message}`);
    }
  }

  const enriched = mergeEnrichmentData(candidate, birdeyeData, heliusData, bubblemapData, lunarData);

  // Derived tags / flags
  enriched.narrativeTags = uniq([
    ...inferNarrativeTags(enriched),
    ...(enriched.narrativeTags ?? []),
  ]);

  enriched.volumeQuality = analyzeVolumeQuality(enriched);
  enriched.chartExtended = isChartExtended(enriched);
  enriched.socialScore   = scoreSocialCompleteness(enriched);

  enriched.socials = {
    website:  enriched.website  ?? null,
    twitter:  enriched.twitter  ?? null,
    telegram: enriched.telegram ?? null,
  };

  Object.assign(enriched, deriveMicroMetrics(enriched));

  if (enriched.launchQualityScore      == null) enriched.launchQualityScore      = null;
  if (enriched.launchTopBuyerShare     == null) enriched.launchTopBuyerShare     = null;
  if (enriched.launchTop3BuyerShare    == null) enriched.launchTop3BuyerShare    = null;
  if (enriched.launchUniqueBuyerRatio  == null) enriched.launchUniqueBuyerRatio  = null;

  if (!enriched.deployerHistoryRisk) {
    enriched.deployerHistoryRisk = inferDeployerRisk(enriched);
  }

  addPlaceholderHistoryFields(enriched);

  const notes = [...(candidate.notes ?? [])];

  if (!enriched.birdeyeOk)   notes.push('Birdeye unavailable — token may be too new to index (~15min)');
  if (!enriched.heliusOk)    notes.push('Helius unavailable — onchain data limited');
  if (isVeryNew)             notes.push('BubbleMap skipped — token under 2h old, not yet indexed');
  else if (!enriched.bubblemapOk) notes.push('BubbleMap unavailable — clustering unknown');

  if (enriched.mintAuthority   === 1) notes.push('WARNING: Mint authority ACTIVE');
  if (enriched.freezeAuthority === 1) notes.push('WARNING: Freeze authority ACTIVE');
  if (enriched.lpLocked === 0)        notes.push('WARNING: LP NOT locked');
  if (enriched.chartExtended)         notes.push('Chart overextended across timeframes');
  if (enriched.bundleRisk === 'HIGH' || enriched.bundleRisk === 'SEVERE') {
    notes.push(`WARNING: Bundle risk ${enriched.bundleRisk}`);
  }
  if ((enriched.top10HolderPct ?? 0) > 50) {
    notes.push(`WARNING: Top10 holders ${enriched.top10HolderPct?.toFixed?.(1)}%`);
  }
  if ((enriched.devWalletPct ?? 0) > 10) {
    notes.push(`WARNING: Dev wallet ${enriched.devWalletPct?.toFixed?.(1)}%`);
  }
  if (enriched.socialScore === 0 && !isVeryNew) notes.push('WARNING: Zero social presence');
  if (enriched.volumeQuality === 'WASH') notes.push('WARNING: Volume looks like wash trading');
  if ((enriched.launchTop3BuyerShare ?? 0) > 0.60) {
    notes.push(`WARNING: Launch top 3 buyers controlled ${(enriched.launchTop3BuyerShare * 100).toFixed(0)}% of first swaps`);
  }

  enriched.notes = notes;

  const summary =
    `birdeye:${enriched.birdeyeOk ? '✓' : '✗'} ` +
    `helius:${enriched.heliusOk ? '✓' : '✗'} ` +
    `bubblemap:${isVeryNew ? 'SKIP(new)' : enriched.bubblemapOk ? '✓' : '✗'} | ` +
    `holders:${enriched.holders ?? '?'} ` +
    `top10:${enriched.top10HolderPct?.toFixed?.(1) ?? '?'}% ` +
    `dev:${enriched.devWalletPct?.toFixed?.(1) ?? '?'}% ` +
    `bundle:${enriched.bundleRisk ?? '?'} ` +
    `mint:${enriched.mintAuthority ?? '?'} ` +
    `lp:${enriched.lpLocked ?? '?'} ` +
    `launchQ:${enriched.launchQualityScore ?? '?'} ` +
    `buyRatio1h:${enriched.buySellRatio1h != null ? enriched.buySellRatio1h.toFixed(2) : '?'}`;

  console.log(`[enricher] ━━ Done $${enriched.token ?? ca}: ${summary}`);

  logEvent('INFO', 'ENRICHMENT_COMPLETE', JSON.stringify({
    token:                  enriched.token,
    ca,
    pairAddress,
    ageHours,
    birdeyeOk:              enriched.birdeyeOk,
    heliusOk:               enriched.heliusOk,
    bubblemapOk:            enriched.bubblemapOk,
    bubblemapSkipped:       isVeryNew,
    top10HolderPct:         enriched.top10HolderPct,
    devWalletPct:           enriched.devWalletPct,
    bundleRisk:             enriched.bundleRisk,
    mintAuthority:          enriched.mintAuthority,
    lpLocked:               enriched.lpLocked,
    launchQualityScore:     enriched.launchQualityScore,
    launchUniqueBuyerRatio: enriched.launchUniqueBuyerRatio,
    breakoutContinuationScore: enriched.breakoutContinuationScore,
  }));

  return enriched;
}

/**
 * FIXED: Batch enrichment — 3 at a time instead of serial 1500ms delay
 * Old: 30 candidates × 1500ms = 45 seconds
 * New: 30 candidates in 10 batches of 3 × 500ms = ~16 seconds
 */
export async function enrichCandidates(candidates, delayMs = 500) {
  const enriched = [];
  const BATCH_SIZE = 3;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch   = candidates.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(c => enrichCandidate(c)));
    enriched.push(...results);

    if (i + BATCH_SIZE < candidates.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return enriched;
}
