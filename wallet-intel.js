/**
 * wallet-intel.js — Real-time wallet intelligence for token evaluation
 *
 * This is the MISSING LINK between token discovery and the Dune wallet cross-reference.
 * Every token that enters processCandidate() runs through here BEFORE scoring.
 *
 * What it does:
 * 1. Fetches the top 50 holder addresses for the token via Helius RPC
 * 2. Returns them as holderAddresses[] so processCandidate Step 2 can cross-ref against Dune DB
 * 3. Fetches deployer wallet address for reputation check
 * 4. Pulls momentum data from Birdeye when available
 * 5. Returns normalized intel object that flattenIntel() can merge into enrichedCandidate
 *
 * runQuickWalletIntel() — fast path for tokens <1h old (just holders + deployer)
 * runWalletIntel()      — full path for older tokens (holders + deployer + momentum)
 */

'use strict';

const HELIUS_RPC_URL = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : null;

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY ?? null;

// ─── Fetch top N token holder addresses via Helius RPC ───────────────────────
// Uses getTokenLargestAccounts — fastest way to get top holders on Solana
// Returns array of wallet addresses (not token accounts)

async function fetchHolderAddresses(contractAddress, limit = 50) {
  if (!HELIUS_RPC_URL || !contractAddress) return [];
  try {
    const res = await fetch(HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method:  'getTokenLargestAccounts',
        params:  [contractAddress],
      }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const accounts = data?.result?.value ?? [];

    // getTokenLargestAccounts returns token accounts, not wallet addresses
    // We need to resolve them to their owner (the actual wallet)
    if (!accounts.length) return [];

    // Batch resolve token accounts → owner wallets
    const addresses = accounts.slice(0, limit).map(a => a.address).filter(Boolean);
    if (!addresses.length) return [];

    // getMultipleAccounts to resolve owners
    const resolveRes = await fetch(HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2,
        method: 'getMultipleAccounts',
        params: [
          addresses,
          { encoding: 'jsonParsed', commitment: 'confirmed' },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resolveRes.ok) return addresses; // fallback: return token account addrs

    const resolveData = await resolveRes.json();
    const accountInfos = resolveData?.result?.value ?? [];

    const ownerWallets = accountInfos
      .map(info => {
        // SPL token account owner is in parsed.info.owner
        const owner = info?.data?.parsed?.info?.owner;
        return owner && owner.length > 30 ? owner : null;
      })
      .filter(Boolean);

    // Deduplicate (one wallet can hold multiple accounts)
    return [...new Set(ownerWallets)].slice(0, limit);
  } catch (err) {
    // Non-fatal — Dune step will just skip if empty
    console.warn('[wallet-intel] fetchHolderAddresses failed:', err.message);
    return [];
  }
}

// ─── Fetch deployer (mint authority / creator) wallet ────────────────────────

async function fetchDeployerWallet(contractAddress) {
  if (!HELIUS_RPC_URL || !contractAddress) return null;
  try {
    const res = await fetch(HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3,
        method: 'getAccountInfo',
        params: [contractAddress, { encoding: 'jsonParsed' }],
      }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Mint account — mintAuthority is the deployer
    const mintAuthority = data?.result?.value?.data?.parsed?.info?.mintAuthority;
    return mintAuthority || null;
  } catch {
    return null;
  }
}

// ─── Fetch momentum from Birdeye ─────────────────────────────────────────────

async function fetchBirdeyeMomentum(contractAddress) {
  if (!BIRDEYE_API_KEY || !contractAddress) return null;
  try {
    const res = await fetch(
      `https://public-api.birdeye.so/defi/token_overview?address=${contractAddress}`,
      {
        headers: { 'X-API-KEY': BIRDEYE_API_KEY, 'x-chain': 'solana' },
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const d = data?.data;
    if (!d) return null;

    const buys1h  = d.buy1h  ?? d.buy24h  ?? 0;
    const sells1h = d.sell1h ?? d.sell24h ?? 0;
    const total   = buys1h + sells1h;
    const buyVelocity = total > 0 ? buys1h / total : null;

    return {
      momentumGrade: buyVelocity != null
        ? buyVelocity > 0.65 ? 'STRONG'
        : buyVelocity > 0.50 ? 'HEALTHY'
        : buyVelocity > 0.35 ? 'NEUTRAL'
        : 'WEAK'
        : null,
      buyVelocity,
      uniqueBuyers5min: d.uniqueBuy5m ?? null,
      survivalScore:    null, // computed downstream
    };
  } catch {
    return null;
  }
}

// ─── QUICK intel (tokens <1h old) ────────────────────────────────────────────
// Fast path: just get holder list for Dune cross-ref + deployer
// Skip Birdeye to keep pipeline budget under control

export async function runQuickWalletIntel(candidate) {
  const ca = candidate.contractAddress;
  if (!ca) return {};

  try {
    // Parallel: holder addresses + deployer wallet
    const [holderAddresses, deployerWallet] = await Promise.all([
      fetchHolderAddresses(ca, 50),
      fetchDeployerWallet(ca),
    ]);

    return {
      holderAddresses,                     // → fed into Step 2 Dune cross-ref
      devWalletAddress: deployerWallet,    // → used for deployer reputation check
      walletIntelScore: null,
      clusterRisk: null,
      coordination: null,
      momentum: null,
      linkageAnalysis: null,
      deployerProfile: null,
    };
  } catch (err) {
    console.warn('[wallet-intel] runQuickWalletIntel error:', err.message);
    return {};
  }
}

// ─── FULL intel (tokens >1h old) ─────────────────────────────────────────────
// Adds Birdeye momentum data on top of the quick path

export async function runWalletIntel(candidate) {
  const ca = candidate.contractAddress;
  if (!ca) return {};

  try {
    // Parallel: holder addresses + deployer + Birdeye momentum
    const [holderAddresses, deployerWallet, momentum] = await Promise.all([
      fetchHolderAddresses(ca, 50),
      fetchDeployerWallet(ca),
      fetchBirdeyeMomentum(ca),
    ]);

    return {
      holderAddresses,
      devWalletAddress: deployerWallet,
      walletIntelScore: null,
      clusterRisk: null,
      coordination: null,
      momentum: momentum ?? null,
      linkageAnalysis: null,
      deployerProfile: null,
    };
  } catch (err) {
    console.warn('[wallet-intel] runWalletIntel error:', err.message);
    return {};
  }
}
