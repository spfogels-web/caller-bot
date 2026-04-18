/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  scanner.js — v5 ALPHA LENNIX — 0min to 4hr, more calls, more data
 *
 *  CHANGES FROM v4:
 *    - MIN_PAIR_AGE_MINUTES reduced from 3 → 0 (brand new coins allowed)
 *    - DEFAULT_FILTERS early/mid thresholds lowered significantly
 *    - QUICK_SCORE_AUTO_PROMOTE lowered 52 → 40
 *    - QUICK_SCORE_WATCHLIST lowered 35 → 28
 *    - QUICK_SCORE_DROP lowered 25 → 20
 *    - NEW_LAUNCH promote threshold lowered to 35
 *    - Fresh launch traction threshold lowered
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import { logEvent } from './db.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const CHAIN = 'solana';

const MAX_PROMOTED_CANDIDATES = Number(process.env.MAX_CANDIDATES      ?? 30);
const MAX_TOKENS_TO_FETCH     = Number(process.env.MAX_TOKENS_TO_FETCH ?? 200);
const DEX_BATCH_SIZE          = Number(process.env.DEX_BATCH_SIZE      ?? 30);

const RESCAN_SCHEDULE_MINUTES = [1, 3, 7, 15];
const MAX_RESCANS             = RESCAN_SCHEDULE_MINUTES.length;

// CHANGED: Lowered all thresholds to get more coins promoted and called
const QUICK_SCORE_AUTO_PROMOTE = Number(process.env.QUICK_SCORE_AUTO_PROMOTE ?? 40);
const QUICK_SCORE_WATCHLIST    = Number(process.env.QUICK_SCORE_WATCHLIST    ?? 28);
const QUICK_SCORE_DROP         = Number(process.env.QUICK_SCORE_DROP         ?? 20);

// CHANGED: 0 minimum age — allow brand new coins from the moment they appear
const MIN_PAIR_AGE_MINUTES = 0;
const MAX_PAIR_AGE_HOURS   = Number(process.env.MAX_PAIR_AGE_HOURS ?? 4);

const DEFAULT_FILTERS = {
  // v7: RECENCY > ACTIVITY for fresh launches
  // Fresh tokens (0-2h) only need mcap in range — stealth launches have no volume yet
  // Older tokens (2-4h) need proven activity to justify evaluation
  fresh: {
    // PRIMARY SCAN: all tokens 0-2h in mcap range, regardless of volume
    // Stealth launches with organic intent won't have volume yet — that's the point
    minLiquidity: 3_000,     // just needs a pool
    minVolume1h:  0,         // no volume requirement — recency is the signal
    minBuys1h:    0,         // no buys requirement
    minTxns1h:    0,         // no txn requirement
    minMarketCap: 7_000,     // slightly below $8K to catch coins approaching sweet spot
    maxMarketCap: 60_000,    // primary gem range
    maxAgeHours:  2,         // 0-2h window
  },
  active: {
    // SECONDARY SCAN: older tokens only if showing activity (volume spikes, fresh wallets)
    minLiquidity: 8_000,
    minVolume1h:  2_000,     // must have real trading activity
    minBuys1h:    10,
    minTxns1h:    20,
    minMarketCap: 8_000,
    maxMarketCap: 85_000,
    maxAgeHours:  4,
  },
};

// ─── In-memory pre-enrichment watchlist ──────────────────────────────────────
const SCANNER_WATCHLIST = new Map();

// ─── Utilities ────────────────────────────────────────────────────────────────

function nowMs()             { return Date.now(); }
function clamp(v, min, max)  { return Math.max(min, Math.min(max, v)); }
function safeNum(v, fb = 0)  { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function minutesToMs(m)      { return m * 60 * 1000; }

function getStageByAgeHours(h) {
  if (h == null)  return 'UNKNOWN';
  if (h < 0.083)  return 'LAUNCH';
  if (h < 0.333)  return 'EARLY';
  if (h < 1)      return 'DEVELOPING';
  if (h < 6)      return 'ESTABLISHED';
  return 'MATURE';
}

function getRescanDelayMs(scanCount) {
  const idx = Math.min(scanCount, RESCAN_SCHEDULE_MINUTES.length - 1);
  return minutesToMs(RESCAN_SCHEDULE_MINUTES[idx]);
}

// ─── DEX Screener Fetchers ────────────────────────────────────────────────────

async function fetchTrendingPairs() {
  const pairs  = new Map();
  const tokens = new Set();

  // ── SOURCE 1: Latest token profiles (brand new launches) ─────────────────
  try {
    const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const data  = await res.json();
      const items = Array.isArray(data) ? data : (data?.data ?? []);
      let count = 0;
      for (const item of items) {
        const addr = item?.tokenAddress ?? item?.address;
        if (addr && item?.chainId === CHAIN) {
          tokens.add(addr);
          count++;
        }
      }
      console.log(`[scanner] Source 1 (latest profiles): ${count} Solana tokens`);
    } else {
      console.warn(`[scanner] token-profiles/latest HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[scanner] Source 1 failed: ${err.message}`);
  }

  // ── SOURCE 2: Latest boosts (recently active tokens) ─────────────────────
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/latest/v1', {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const data  = await res.json();
      const items = Array.isArray(data) ? data : (data?.data ?? []);
      let count = 0;
      for (const item of items) {
        const addr = item?.tokenAddress ?? item?.address;
        if (addr && item?.chainId === CHAIN) {
          tokens.add(addr);
          count++;
        }
      }
      console.log(`[scanner] Source 2 (latest boosts): ${count} Solana tokens`);
    } else {
      console.warn(`[scanner] token-boosts/latest HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[scanner] Source 2 failed: ${err.message}`);
  }

  // ── Batch lookup full pair data for tokens from sources 1+2 ──────────────
  if (tokens.size > 0) {
    const tokenList = Array.from(tokens).slice(0, MAX_TOKENS_TO_FETCH);
    console.log(`[scanner] Batch fetching pair data for ${tokenList.length} tokens…`);

    for (let i = 0; i < tokenList.length; i += DEX_BATCH_SIZE) {
      const batch = tokenList.slice(i, i + DEX_BATCH_SIZE).join(',');
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${batch}`,
          { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(12_000) }
        );
        if (!res.ok) continue;
        const data = await res.json();
        for (const pair of (data?.pairs ?? [])) {
          if (!pair?.pairAddress || pair?.chainId !== CHAIN || !pair?.pairCreatedAt) continue;
          const ageHours = (Date.now() - pair.pairCreatedAt) / 3_600_000;
          if (ageHours > MAX_PAIR_AGE_HOURS) continue;
          pairs.set(pair.pairAddress, pair);
        }
      } catch (err) {
        console.warn(`[scanner] Token batch fetch failed: ${err.message}`);
      }
      if (i + DEX_BATCH_SIZE < tokenList.length) {
        await new Promise(r => setTimeout(r, 400));
      }
    }
    console.log(`[scanner] After token batch lookup: ${pairs.size} pairs with data`);
  }

  // ── SOURCE 3: Community takeovers ────────────────────────────────────────
  try {
    const res = await fetch('https://api.dexscreener.com/community-takeovers/latest/v1', {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data  = await res.json();
      const items = Array.isArray(data) ? data : [];
      let count = 0;
      for (const item of items) {
        const addr = item?.tokenAddress;
        if (addr && item?.chainId === CHAIN) {
          tokens.add(addr);
          count++;
        }
      }
      if (count > 0) console.log(`[scanner] Source 3 (community takeovers): ${count} Solana tokens`);
    }
  } catch (err) {
    console.warn(`[scanner] Source 3 (takeovers) failed: ${err.message}`);
  }

  // ── SOURCE 4: Pump.fun search ─────────────────────────────────────────────
  const pumpSearches = ['pump', 'pumpfun'];
  for (const term of pumpSearches) {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/search?q=${term}`,
        { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10_000) }
      );
      if (res.ok) {
        const data = await res.json();
        let added = 0;
        for (const pair of (data?.pairs ?? [])) {
          if (pair?.chainId !== CHAIN || !pair?.pairAddress || !pair?.pairCreatedAt) continue;
          const ageHours = (Date.now() - pair.pairCreatedAt) / 3_600_000;
          if (ageHours > MAX_PAIR_AGE_HOURS) continue;
          if (!pairs.has(pair.pairAddress)) {
            pairs.set(pair.pairAddress, pair);
            added++;
          }
        }
        if (added > 0) console.log(`[scanner] Source 4 (pump search '${term}'): +${added} new pairs (total: ${pairs.size})`);
      }
    } catch (err) {
      console.warn(`[scanner] Source 4 ('${term}') failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Dedup by token CA, keep highest liquidity pair per token ─────────────
  const byTokenCA = new Map();
  for (const pair of pairs.values()) {
    if (!pair.pairCreatedAt) continue;
    const tokenCA = pair.baseToken?.address;
    if (!tokenCA) continue;
    const existing = byTokenCA.get(tokenCA);
    if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
      byTokenCA.set(tokenCA, pair);
    }
  }

  // Sort newest-first, enforce max age as final safety net
  const allPairs = Array.from(byTokenCA.values())
    .filter(p => {
      const ageHours = (Date.now() - p.pairCreatedAt) / 3_600_000;
      return ageHours <= MAX_PAIR_AGE_HOURS;
    })
    .sort((a, b) => b.pairCreatedAt - a.pairCreatedAt);

  const newestAge = allPairs[0]?.pairCreatedAt
    ? Math.round((Date.now() - allPairs[0].pairCreatedAt) / 60000)
    : null;

  const totalBeforeAgeFilter = byTokenCA.size;
  console.log(
    `[scanner] Token dedup: ${pairs.size} pairs -> ${totalBeforeAgeFilter} unique tokens -> ${allPairs.length} within ${MAX_PAIR_AGE_HOURS}h | ` +
    `Newest: ${newestAge != null ? newestAge + 'min old' : 'unknown'}`
  );

  return allPairs;
}

export async function fetchPairByAddress(contractAddress) {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${contractAddress}`,
      { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    const data  = await res.json();
    const pairs = (data?.pairs ?? []).filter(p => p.chainId === CHAIN);
    if (!pairs.length) return null;
    return pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  } catch (err) {
    console.warn('[scanner] fetchPairByAddress failed:', err.message);
    return null;
  }
}

// ─── Pair Normalizer ──────────────────────────────────────────────────────────

export function normalizePair(pair) {
  const pairAgeSec = pair.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / 1000
    : null;

  const buys24h  = pair.txns?.h24?.buys   ?? null;
  const sells24h = pair.txns?.h24?.sells  ?? null;
  const buys6h   = pair.txns?.h6?.buys    ?? null;
  const sells6h  = pair.txns?.h6?.sells   ?? null;
  const buys1h   = pair.txns?.h1?.buys    ?? null;
  const sells1h  = pair.txns?.h1?.sells   ?? null;

  const volume24h = pair.volume?.h24 ?? null;
  const volume6h  = pair.volume?.h6  ?? null;
  const volume1h  = pair.volume?.h1  ?? null;

  const total1h  = safeNum(buys1h)  + safeNum(sells1h);
  const total6h  = safeNum(buys6h)  + safeNum(sells6h);
  const total24h = safeNum(buys24h) + safeNum(sells24h);

  const pairAgeHours = pairAgeSec !== null ? pairAgeSec / 3600 : null;

  return {
    token:           pair.baseToken?.symbol  ?? null,
    tokenName:       pair.baseToken?.name    ?? null,
    contractAddress: pair.baseToken?.address ?? null,
    pairAddress:     pair.pairAddress        ?? null,
    chain:           CHAIN,
    dex:             pair.dexId              ?? null,

    priceUsd:    parseFloat(pair.priceUsd ?? 0) || null,
    marketCap:   pair.marketCap ?? pair.fdv ?? null,
    liquidity:   pair.liquidity?.usd ?? null,
    volume24h, volume6h, volume1h,

    priceChange24h: pair.priceChange?.h24 ?? null,
    priceChange6h:  pair.priceChange?.h6  ?? null,
    priceChange1h:  pair.priceChange?.h1  ?? null,
    priceChange5m:  pair.priceChange?.m5  ?? null,

    buys24h, sells24h, buys6h, sells6h, buys1h, sells1h,
    txns24h: total24h, txns6h: total6h, txns1h: total1h,

    buySellRatio1h:  total1h  > 0 ? safeNum(buys1h)  / total1h  : null,
    buySellRatio6h:  total6h  > 0 ? safeNum(buys6h)  / total6h  : null,
    buySellRatio24h: total24h > 0 ? safeNum(buys24h) / total24h : null,
    volumeVelocity:  safeNum(volume6h) > 0 ? safeNum(volume1h) / safeNum(volume6h) : null,
    buyVelocity:     safeNum(buys6h)   > 0 ? safeNum(buys1h)   / safeNum(buys6h)   : null,
    txnVelocity:     total6h           > 0 ? total1h / total6h : null,

    pairAgeHours,
    pairCreatedAt: pair.pairCreatedAt ?? null,
    stage:         getStageByAgeHours(pairAgeHours),

    website:  pair.info?.websites?.[0]?.url                                 ?? null,
    twitter:  pair.info?.socials?.find(s => s.type === 'twitter')?.url      ?? null,
    telegram: pair.info?.socials?.find(s => s.type === 'telegram')?.url     ?? null,
    labels:   pair.labels ?? [],

    holders: null, top10HolderPct: null, holderGrowth24h: null,
    devWalletPct: null, bundleRisk: null, bubbleMapRisk: null,
    deployerHistoryRisk: null, walletClusterRisk: null,
    sniperWalletCount: null, insiderWalletPct: null,
    smartMoneyPresence: null, freshWalletInflows: null,
    mintAuthority: null, freezeAuthority: null, lpLocked: null,
    volumeQuality: null, narrativeTags: [], notes: [],
    birdeyeOk: false, heliusOk: false, bubblemapOk: false,
  };
}

// ─── Stage-aware Pre-Filters ──────────────────────────────────────────────────

function applyAdaptivePreFilters(candidate, modeConfig = {}) {
  const age    = candidate.pairAgeHours;
  const liq    = safeNum(candidate.liquidity);
  const mcap   = safeNum(candidate.marketCap);
  const vol1h  = safeNum(candidate.volume1h);
  const vol24h = safeNum(candidate.volume24h);
  const b1h    = safeNum(candidate.buys1h);
  const b24h   = safeNum(candidate.buys24h);
  const t1h    = safeNum(candidate.txns1h);
  const t24h   = safeNum(candidate.txns24h);

  if (candidate.chain !== CHAIN) return { pass: false, reason: `wrong chain: ${candidate.chain}` };
  if (!candidate.contractAddress) return { pass: false, reason: 'missing contract address' };

  // CHANGED: MIN_PAIR_AGE_MINUTES is now 0 — no minimum age enforced
  // Brand new coins are allowed through from the moment they appear
  if (MIN_PAIR_AGE_MINUTES > 0 && age !== null && age < (MIN_PAIR_AGE_MINUTES / 60)) {
    return {
      pass: false,
      reason: `too new: ${(age * 60).toFixed(1)}min < ${MIN_PAIR_AGE_MINUTES}min minimum`,
    };
  }

  // Mode overrides
  const minLiq  = modeConfig.minLiquidity     ?? null;
  const minMcap = modeConfig.minMarketCap     ?? null;
  const maxMcap = modeConfig.maxMarketCap     ?? null;
  const minAge  = modeConfig.minPairAgeHours  ?? null;
  const maxAge  = modeConfig.maxPairAgeHours  ?? null;
  const minB24h = modeConfig.minBuys24h       ?? null;
  const minT24h = modeConfig.minTxns24h       ?? null;

  // CHANGED: minPairAgeHours is 0 in NEW_COINS mode so this never blocks
  if (minAge !== null && minAge > 0 && age !== null && age < minAge) {
    return { pass: false, reason: `too new: ${(age * 60).toFixed(1)}min` };
  }
  if (maxAge !== null && age !== null && age > maxAge) {
    return { pass: false, reason: `too old: ${age.toFixed(1)}h > ${maxAge}h` };
  }
  if (minLiq !== null && liq < minLiq) {
    return { pass: false, reason: `liq $${liq.toFixed(0)} < $${minLiq}` };
  }
  if (minMcap !== null && mcap > 0 && mcap < minMcap) {
    return { pass: false, reason: `mcap $${mcap.toFixed(0)} < $${minMcap}` };
  }
  if (maxMcap !== null && mcap > maxMcap) {
    return { pass: false, reason: `mcap $${(mcap / 1e6).toFixed(1)}M > $${(maxMcap / 1e6).toFixed(1)}M` };
  }

  const F = DEFAULT_FILTERS.fresh;
  const A = DEFAULT_FILTERS.active;

  // ── PRIMARY: Fresh launches (0-2h) — recency > activity ────────────────
  // Stealth launches won't have volume yet. If it's in our mcap range and
  // has a pool, let it through for full scoring. The Foundation Signals
  // engine will catch fake/dead tokens.
  if (age != null && age <= F.maxAgeHours) {
    if (liq   < F.minLiquidity) return { pass: false, reason: `fresh liq $${liq.toFixed(0)} < $${F.minLiquidity}` };
    if (mcap  > 0 && mcap < F.minMarketCap) return { pass: false, reason: `fresh mcap $${mcap.toFixed(0)} < $${F.minMarketCap}` };
    if (mcap  > F.maxMarketCap) return { pass: false, reason: `fresh mcap $${(mcap/1000).toFixed(0)}K > $${F.maxMarketCap/1000}K` };
    return { pass: true, reason: `fresh launch (${age!=null?(age*60).toFixed(0)+'min':'?'}) — recency priority` };
  }

  // ── SECONDARY: Older tokens (2-4h) — need proven activity ──────────────
  // After 2h, a token should have trading activity. No activity = dead.
  const maxPairAge = maxAge ?? A.maxAgeHours;
  if (age != null && age > maxPairAge) {
    return { pass: false, reason: `too old: ${age.toFixed(1)}h > ${maxPairAge}h` };
  }

  if (liq   < (minLiq  ?? A.minLiquidity)) return { pass: false, reason: `active liq $${liq.toFixed(0)} < $${A.minLiquidity}` };
  if (vol1h < A.minVolume1h)               return { pass: false, reason: `active 1h vol $${vol1h.toFixed(0)} < $${A.minVolume1h}` };
  if (b1h   < A.minBuys1h)                return { pass: false, reason: `active buys1h ${b1h} < ${A.minBuys1h}` };
  if (t1h   < A.minTxns1h)                return { pass: false, reason: `active txns1h ${t1h} < ${A.minTxns1h}` };
  if (mcap  > 0 && mcap < (minMcap ?? A.minMarketCap)) return { pass: false, reason: `active mcap too low` };
  if (mcap  > (maxMcap ?? A.maxMarketCap)) return { pass: false, reason: `active mcap too high` };

  const sellRatio = t1h > 0 ? safeNum(candidate.sells1h) / t1h : 0;
  if (sellRatio > 0.80) return { pass: false, reason: `extreme sell pressure (${(sellRatio*100).toFixed(0)}% sells)` };

  const pc24h = candidate.priceChange24h ?? null;
  if (pc24h !== null && pc24h < -80) return { pass: false, reason: `massive dump ${pc24h.toFixed(0)}%` };

  return { pass: true, reason: 'passed active-stage filters' };
}

// ─── Quick Score ─────────────────────────────────────────────────────────────

function inferCandidateType(candidate) {
  const age      = candidate.pairAgeHours;
  const p5       = safeNum(candidate.priceChange5m);
  const p1       = safeNum(candidate.priceChange1h);
  const volVel   = candidate.volumeVelocity ?? 0;
  const buyVel   = candidate.buyVelocity    ?? 0;
  const buyRatio = candidate.buySellRatio1h ?? 0.5;

  // CHANGED: Extended NEW_LAUNCH window to 0.5h (was 0.25h)
  if (age != null && age < 0.5)                               return 'NEW_LAUNCH';
  if (p5 > 8  && buyRatio > 0.55 && volVel > 0.20)           return 'EARLY_MOMENTUM';
  if (p1 > 15 && volVel > 0.30   && buyVel > 0.30)           return 'BREAKOUT';
  if (p1 > 0  && safeNum(candidate.priceChange6h) > 0)       return 'LATE_TREND';
  return 'STANDARD';
}

function computeQuickScore(candidate) {
  let score = 35;

  const liq    = safeNum(candidate.liquidity);
  const mcap   = safeNum(candidate.marketCap);
  const vol1h  = safeNum(candidate.volume1h);
  const b1h    = safeNum(candidate.buys1h);
  const t1h    = safeNum(candidate.txns1h);
  const p5     = safeNum(candidate.priceChange5m);
  const p1     = safeNum(candidate.priceChange1h);
  const p6     = safeNum(candidate.priceChange6h);
  const br1h   = candidate.buySellRatio1h;
  const volVel = candidate.volumeVelocity;
  const buyVel = candidate.buyVelocity;
  const age    = candidate.pairAgeHours;

  if      (liq >= 100_000) score += 15;
  else if (liq >=  50_000) score += 10;
  else if (liq >=  20_000) score +=  5;
  else if (liq >=   8_000) score +=  2;
  else if (liq <    5_000) score -= 10;

  if      (vol1h >= 50_000) score += 15;
  else if (vol1h >= 15_000) score +=  8;
  else if (vol1h >=  5_000) score +=  4;
  else if (vol1h >=  2_000) score +=  2;

  if      (b1h >= 80) score += 12;
  else if (b1h >= 30) score +=  7;
  else if (b1h >= 10) score +=  3;

  if      (t1h >= 100) score += 8;
  else if (t1h >=  40) score += 4;
  else if (t1h >=  20) score += 2;

  if      (p5 >= 20) score += 12;
  else if (p5 >=  8) score +=  7;
  else if (p5 >=  2) score +=  3;
  else if (p5 <= -12) score -= 8;

  if      (p1 >= 40) score += 10;
  else if (p1 >= 15) score +=  6;
  else if (p1 >=  5) score +=  3;
  else if (p1 <= -20) score -= 8;

  if (p6 > 0 && p1 > 0) score += 4;

  if (br1h !== null) {
    if      (br1h >= 0.60 && br1h <= 0.85) score += 10;
    else if (br1h >= 0.50 && br1h < 0.60)  score +=  5;
    else if (br1h >  0.90)                 score -=  4;
    else if (br1h <  0.40)                 score -= 10;
  }

  if (volVel !== null) {
    if      (volVel >= 0.45) score += 10;
    else if (volVel >= 0.25) score +=  5;
    else if (volVel >= 0.10) score +=  2;
    else if (volVel <  0.05) score -=  5;
  }
  if (buyVel !== null) {
    if      (buyVel >= 0.45) score += 8;
    else if (buyVel >= 0.25) score += 4;
    else if (buyVel >= 0.10) score += 2;
  }

  const socials = [candidate.website, candidate.twitter, candidate.telegram].filter(Boolean).length;
  if      (socials === 3)                            score += 6;
  else if (socials === 2)                            score += 3;
  else if (socials === 1)                            score += 1;
  else if (socials === 0 && age != null && age > 2)  score -= 4;

  if (mcap > 0 && mcap < 5_000)          score -= 4;
  else if (mcap > 0 && mcap <= 500_000)   score += 6;
  else if (mcap > 0 && mcap <= 2_000_000) score += 3;

  const candidateType = inferCandidateType(candidate);
  // CHANGED: NEW_LAUNCH boost applies even with fewer buys (5 vs 10)
  if (candidateType === 'NEW_LAUNCH' && p5 >= 0 && b1h >= 5) score += 12;
  if (candidateType === 'EARLY_MOMENTUM')                      score +=  8;

  // Cap quick_score at 70 — this is just a basic pre-filter pass, not a full
  // composite. The remaining 30 points are reserved for the full scoring
  // pipeline (Claude + OpenAI + structure analysis) so the user can tell
  // immediately whether a 100 is "scanner approved" vs "actually elite".
  return { score: clamp(Math.round(score), 0, 70), candidateType };
}

// ─── Scanner Watchlist ────────────────────────────────────────────────────────

function upsertScannerWatchlist(candidate, quickScore, candidateType, reason) {
  const ca  = candidate.contractAddress;
  if (!ca) return;
  const now = nowMs();
  const ex  = SCANNER_WATCHLIST.get(ca);

  SCANNER_WATCHLIST.set(ca, {
    contractAddress: ca,
    token:           candidate.token      ?? null,
    candidate,
    candidateType,
    addedAt:         ex?.addedAt          ?? now,
    lastSeenAt:      now,
    nextScanAt:      now + getRescanDelayMs(ex?.scanCount ?? 0),
    scanCount:       (ex?.scanCount ?? 0),
    bestQuickScore:  Math.max(ex?.bestQuickScore ?? 0, quickScore),
    lastQuickScore:  quickScore,
    reason,
  });
}

function removeFromScannerWatchlist(ca) { SCANNER_WATCHLIST.delete(ca); }

function getDueScannerEntries() {
  const now = nowMs();
  return [...SCANNER_WATCHLIST.values()]
    .filter(e => e.nextScanAt <= now)
    .sort((a, b) => a.nextScanAt - b.nextScanAt)
    .slice(0, 25);
}

// ─── Promotion Logic ─────────────────────────────────────────────────────────

function shouldPromoteNow(candidate, quickScore, candidateType) {
  const age    = candidate.pairAgeHours ?? 999;
  const p5     = safeNum(candidate.priceChange5m);
  const br1h   = candidate.buySellRatio1h ?? 0;
  const volVel = candidate.volumeVelocity ?? 0;

  // CHANGED: NEW_LAUNCH threshold lowered to 35 (was max(42, 42))
  const autoPromoteThreshold = candidateType === 'NEW_LAUNCH'
    ? Math.max(35, QUICK_SCORE_AUTO_PROMOTE - 10)
    : QUICK_SCORE_AUTO_PROMOTE;

  if (quickScore >= autoPromoteThreshold)                                       return { promote: true, reason: `quick score ${quickScore} >= ${autoPromoteThreshold}` };
  // CHANGED: NEW_LAUNCH with any positive 5m momentum promotes
  if (candidateType === 'NEW_LAUNCH' && quickScore >= 32 && p5 >= 0)           return { promote: true, reason: 'new launch with momentum' };
  if (candidateType === 'EARLY_MOMENTUM' && quickScore >= 38)                   return { promote: true, reason: 'early momentum' };
  if (candidateType === 'BREAKOUT' && quickScore >= 42)                         return { promote: true, reason: 'breakout' };
  // CHANGED: Fresh launch traction — lower thresholds
  if (age < 0.5 && p5 >= 3 && br1h >= 0.50 && volVel >= 0.10 && quickScore >= 32) return { promote: true, reason: 'fresh launch traction' };
  return { promote: false, reason: 'not ready' };
}

function shouldWatchlist(candidate, quickScore) {
  const age  = candidate.pairAgeHours ?? 999;
  const p5   = safeNum(candidate.priceChange5m);
  const b1h  = safeNum(candidate.buys1h);
  const v1h  = safeNum(candidate.volume1h);

  if (quickScore >= QUICK_SCORE_WATCHLIST)               return { watch: true, reason: 'meets watchlist threshold' };
  // CHANGED: Wider net for fresh tokens — any positive signal
  if (age < 2 && (p5 >= 0 || b1h >= 5 || v1h >= 500))  return { watch: true, reason: 'fresh token with early activity' };
  return { watch: false, reason: 'not worth watching' };
}

// ─── Fresh Pair Processing ────────────────────────────────────────────────────

function processFreshPair(pair, isRecentlySeen, modeConfig = {}, scanLog = null) {
  const ca = pair.baseToken?.address;
  if (!ca) return { action: 'SKIP', reason: 'missing address' };

  if (isRecentlySeen && isRecentlySeen(ca)) {
    if (scanLog) { const c = normalizePair(pair); scanLog(c, 0, 'DEDUPED', 'recently seen'); }
    return { action: 'DEDUPED', reason: 'recently seen' };
  }
  if (SCANNER_WATCHLIST.has(ca)) {
    if (scanLog) { const c = normalizePair(pair); scanLog(c, 0, 'DEDUPED', 'in scanner watchlist'); }
    return { action: 'DEDUPED', reason: 'in scanner watchlist' };
  }

  const candidate = normalizePair(pair);
  const pre       = applyAdaptivePreFilters(candidate, modeConfig);

  if (!pre.pass) {
    if (scanLog) scanLog(candidate, 0, 'SKIP', pre.reason);
    return { action: 'SKIP', reason: pre.reason };
  }

  const quick = computeQuickScore(candidate);
  candidate.quickScore    = quick.score;
  candidate.candidateType = quick.candidateType;

  if (scanLog) scanLog(candidate, quick.score, 'SCANNED', pre.reason);

  const promote = shouldPromoteNow(candidate, quick.score, quick.candidateType);
  if (promote.promote) {
    candidate.notes = candidate.notes ?? [];
    candidate.notes.push(`Scanner promote: ${promote.reason}`);
    if (scanLog) scanLog(candidate, quick.score, 'PROMOTE', promote.reason);
    return { action: 'PROMOTE', candidate, reason: promote.reason };
  }

  const watch = shouldWatchlist(candidate, quick.score);
  if (watch.watch) {
    upsertScannerWatchlist(candidate, quick.score, quick.candidateType, watch.reason);
    if (scanLog) scanLog(candidate, quick.score, 'WATCHLIST', watch.reason);
    return { action: 'WATCHLIST', candidate, reason: watch.reason };
  }

  if (scanLog) scanLog(candidate, quick.score, 'SKIP', 'quick score too weak');
  return { action: 'SKIP', reason: 'quick score too weak' };
}

// ─── Rescan Processing ────────────────────────────────────────────────────────

async function processDueScannerRescans(isRecentlySeen, modeConfig = {}) {
  const due      = getDueScannerEntries();
  const promoted = [];

  for (const entry of due) {
    const ca = entry.contractAddress;

    if (isRecentlySeen && isRecentlySeen(ca)) { removeFromScannerWatchlist(ca); continue; }

    const latestPair = await fetchPairByAddress(ca);
    entry.scanCount  = (entry.scanCount ?? 0) + 1;

    if (!latestPair) {
      if (entry.scanCount >= MAX_RESCANS) removeFromScannerWatchlist(ca);
      else { entry.nextScanAt = nowMs() + getRescanDelayMs(entry.scanCount); SCANNER_WATCHLIST.set(ca, entry); }
      continue;
    }

    const candidate = normalizePair(latestPair);
    candidate.candidateType = entry.candidateType;

    const pre = applyAdaptivePreFilters(candidate, modeConfig);
    if (!pre.pass) {
      if (entry.scanCount >= MAX_RESCANS) removeFromScannerWatchlist(ca);
      else { entry.candidate = candidate; entry.nextScanAt = nowMs() + getRescanDelayMs(entry.scanCount); SCANNER_WATCHLIST.set(ca, entry); }
      continue;
    }

    const quick    = computeQuickScore(candidate);
    candidate.quickScore    = quick.score;
    candidate.candidateType = quick.candidateType;

    const improved = quick.score > (entry.lastQuickScore ?? 0) + 5;
    const promote  = shouldPromoteNow(candidate, quick.score, quick.candidateType);

    if (promote.promote || improved) {
      candidate.notes = candidate.notes ?? [];
      candidate.notes.push(promote.promote
        ? `Rescan promote (${entry.scanCount}): ${promote.reason}`
        : `Rescan promote (${entry.scanCount}): score ${entry.lastQuickScore} → ${quick.score}`
      );
      promoted.push(candidate);
      removeFromScannerWatchlist(ca);
      continue;
    }

    if (quick.score < QUICK_SCORE_DROP || entry.scanCount >= MAX_RESCANS) {
      removeFromScannerWatchlist(ca); continue;
    }

    entry.candidate      = candidate;
    entry.lastQuickScore = quick.score;
    entry.bestQuickScore = Math.max(entry.bestQuickScore ?? 0, quick.score);
    entry.candidateType  = quick.candidateType;
    entry.nextScanAt     = nowMs() + getRescanDelayMs(entry.scanCount);
    SCANNER_WATCHLIST.set(ca, entry);
  }

  return promoted;
}

// ─── Snapshot ────────────────────────────────────────────────────────────────

export function getScannerWatchlistSnapshot() {
  return [...SCANNER_WATCHLIST.values()].map(e => ({
    contractAddress: e.contractAddress,
    token:           e.token,
    candidateType:   e.candidateType,
    scanCount:       e.scanCount,
    lastQuickScore:  e.lastQuickScore,
    bestQuickScore:  e.bestQuickScore,
    nextScanAt:      e.nextScanAt,
    reason:          e.reason,
  }));
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function runScanner(isRecentlySeen, modeConfig = {}, scanLog = null) {
  console.log(`[scanner] Mode: ${modeConfig.name ?? 'DEFAULT'} | watchlist: ${SCANNER_WATCHLIST.size}`);
  logEvent('INFO', 'SCANNER_CYCLE_START', JSON.stringify({
    mode: modeConfig.name ?? 'DEFAULT', watchlistSize: SCANNER_WATCHLIST.size,
  }));

  let rawPairs = [];
  try {
    rawPairs = await fetchTrendingPairs();
  } catch (err) {
    console.error('[scanner] Fatal fetch error:', err.message);
    logEvent('ERROR', 'SCANNER_FETCH_FATAL', err.message);
  }

  console.log(`[scanner] ${rawPairs.length} raw pairs to evaluate`);

  const promotedFresh = [];
  const stats = { raw: rawPairs.length, promoted: 0, watchlisted: 0, skipped: 0, deduped: 0 };

  for (const pair of rawPairs) {
    const result = processFreshPair(pair, isRecentlySeen, modeConfig, scanLog);
    if      (result.action === 'PROMOTE')   { promotedFresh.push(result.candidate); stats.promoted++; }
    else if (result.action === 'WATCHLIST') { stats.watchlisted++; }
    else if (result.action === 'DEDUPED')   { stats.deduped++; }
    else                                    { stats.skipped++; }
  }

  const promotedRescans = await processDueScannerRescans(isRecentlySeen, modeConfig);

  const seen = new Map();
  for (const c of [...promotedFresh, ...promotedRescans]) {
    const existing = seen.get(c.contractAddress);
    if (!existing || safeNum(c.quickScore) > safeNum(existing.quickScore)) {
      seen.set(c.contractAddress, c);
    }
  }

  const finalCandidates = [...seen.values()]
    .sort((a, b) => safeNum(b.quickScore, 0) - safeNum(a.quickScore, 0))
    .slice(0, MAX_PROMOTED_CANDIDATES);

  console.log(
    `[scanner] Done — fresh:${stats.promoted} watchlisted:${stats.watchlisted} ` +
    `skipped:${stats.skipped} deduped:${stats.deduped} ` +
    `rescanPromoted:${promotedRescans.length} final:${finalCandidates.length} ` +
    `scannerWatchlist:${SCANNER_WATCHLIST.size}`
  );

  logEvent('INFO', 'SCANNER_CYCLE_COMPLETE', JSON.stringify({
    ...stats,
    rescanPromoted:      promotedRescans.length,
    finalCandidates:     finalCandidates.length,
    scannerWatchlistSize: SCANNER_WATCHLIST.size,
  }));

  return finalCandidates;
}
