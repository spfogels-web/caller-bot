/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  bundle-detector.js — deep funding-source trace
 *
 *  The single highest-value rug predictor is the "coordinated bundle launch":
 *  one wallet funds N fresh wallets with SOL, each wallet buys the new token
 *  in block 0-1, all selling together a few minutes later.
 *
 *  Detection:
 *    1. Fetch the pair/token's first ~20 SWAP transactions via Helius
 *    2. Extract the first 5-10 unique buyer wallets
 *    3. For each buyer, trace their inbound SOL (who funded them?)
 *    4. If 3+ buyers share the same funder → BUNDLE_SETUP confirmed
 *
 *  Caches results in `bundle_checks` table for 24h to avoid repeat RPC spend.
 *  Typical cost: 1 + 5 = 6 Helius Enhanced Transactions calls per new coin.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const HELIUS_BASE = 'https://api.helius.xyz/v0';
const CACHE_TTL_HOURS = 24;

// Program IDs / addresses that fund EVERYONE (CEX hot wallets, Jupiter, Raydium)
// — having these as a "shared funder" is not a signal of coordination.
const IGNORE_FUNDERS = new Set([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',  // Binance hot
  'BXBkE2gMpT5UtDRe5xYxzeDt1k5oifuxRZxX2N6Yy5hq',  // Coinbase hot
  'BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6',  // Kraken hot
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',  // Jupiter fee
  'GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG',  // Raydium fee
  '3Ra8XX4cKH1P3N7dYHdFqZmNq8LhCuD4W2mi3ZRyCW9f',  // MEV sweeper
  // Plus SOL system addresses / wrapped
  'So11111111111111111111111111111111111111112',
  '11111111111111111111111111111111',
]);

async function heliusFetch(path) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  try {
    const url = `${HELIUS_BASE}${path}${path.includes('?') ? '&' : '?'}api-key=${key}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(9_000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function cacheGet(dbInstance, ca) {
  try {
    const row = dbInstance.prepare(`
      SELECT is_bundled, buyer_count, funder_overlap, top_funder, signals,
             (julianday('now') - julianday(checked_at)) * 24 AS age_hours
      FROM bundle_checks WHERE contract_address = ?
    `).get(ca);
    if (!row) return null;
    if (row.age_hours > CACHE_TTL_HOURS) return null;
    return {
      isBundled:     !!row.is_bundled,
      buyerCount:    row.buyer_count,
      funderOverlap: row.funder_overlap,
      topFunder:     row.top_funder,
      signals:       row.signals ? row.signals.split('|') : [],
      cached:        true,
    };
  } catch { return null; }
}

function cacheSet(dbInstance, ca, result) {
  try {
    dbInstance.prepare(`
      INSERT INTO bundle_checks
        (contract_address, is_bundled, buyer_count, funder_overlap, top_funder, signals, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(contract_address) DO UPDATE SET
        is_bundled     = excluded.is_bundled,
        buyer_count    = excluded.buyer_count,
        funder_overlap = excluded.funder_overlap,
        top_funder     = excluded.top_funder,
        signals        = excluded.signals,
        checked_at     = datetime('now')
    `).run(
      ca,
      result.isBundled ? 1 : 0,
      result.buyerCount ?? null,
      result.funderOverlap ?? null,
      result.topFunder ?? null,
      (result.signals || []).join('|')
    );
  } catch {}
}

/**
 * Run the deep bundle-detector check for a contract address.
 * Returns { isBundled, buyerCount, funderOverlap, topFunder, signals }
 * Caches results in bundle_checks for 24h.
 */
export async function detectBundleLaunch(tokenAddress, dbInstance) {
  if (!tokenAddress || !process.env.HELIUS_API_KEY) {
    return { isBundled: false, signals: ['no Helius key'], skipped: true };
  }

  // Cache first
  const cached = cacheGet(dbInstance, tokenAddress);
  if (cached) return cached;

  // 1. Fetch the TOKEN mint's recent txns (Helius returns parsed swaps)
  const tokenTxns = await heliusFetch(`/addresses/${tokenAddress}/transactions?type=SWAP&limit=20`);
  if (!Array.isArray(tokenTxns) || tokenTxns.length === 0) {
    const result = { isBundled: false, signals: ['no txn history'], buyerCount: 0 };
    cacheSet(dbInstance, tokenAddress, result);
    return result;
  }

  // 2. Find unique buyer wallets from the EARLIEST swaps (launch window)
  // Sort by timestamp ascending — oldest first — so we get actual bundle buyers
  tokenTxns.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const earlyBuyers = new Set();
  for (const tx of tokenTxns.slice(0, 15)) {
    const transfers = tx.tokenTransfers ?? [];
    for (const t of transfers) {
      if (t.mint === tokenAddress && t.toUserAccount) {
        // Skip LP / AMM program accounts (they receive on behalf of pool)
        // Simple heuristic: skip addresses that look like program derived accounts
        if (t.toUserAccount.length < 32) continue;
        earlyBuyers.add(t.toUserAccount);
        if (earlyBuyers.size >= 8) break;
      }
    }
    if (earlyBuyers.size >= 8) break;
  }

  const buyers = Array.from(earlyBuyers).slice(0, 8);
  if (buyers.length < 3) {
    const result = { isBundled: false, buyerCount: buyers.length, signals: ['too few early buyers to judge'] };
    cacheSet(dbInstance, tokenAddress, result);
    return result;
  }

  // 3. For each buyer, trace their funding source (first SOL in)
  const funderCounts = new Map();
  const signals = [];

  for (const buyer of buyers) {
    const hist = await heliusFetch(`/addresses/${buyer}/transactions?type=TRANSFER&limit=10`);
    if (!Array.isArray(hist) || hist.length === 0) continue;

    // Find the EARLIEST inbound SOL transfer — that's the funder
    hist.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    let funder = null;
    for (const tx of hist) {
      const nat = tx.nativeTransfers ?? [];
      for (const t of nat) {
        if (t.toUserAccount === buyer && t.amount > 0 && t.fromUserAccount) {
          if (IGNORE_FUNDERS.has(t.fromUserAccount)) continue;
          funder = t.fromUserAccount;
          break;
        }
      }
      if (funder) break;
    }
    if (funder) {
      funderCounts.set(funder, (funderCounts.get(funder) || 0) + 1);
    }
  }

  // 4. Count the top funder's overlap
  let topFunder = null;
  let topCount  = 0;
  for (const [f, n] of funderCounts) {
    if (n > topCount) { topCount = n; topFunder = f; }
  }

  const isBundled = topCount >= 3;
  if (isBundled) {
    signals.push(`${topCount}/${buyers.length} early buyers funded by ${topFunder?.slice(0,8)}…${topFunder?.slice(-4)}`);
  } else {
    signals.push(`no funder overlap (top ${topCount}/${buyers.length})`);
  }

  const result = {
    isBundled,
    buyerCount: buyers.length,
    funderOverlap: topCount,
    topFunder,
    signals,
  };
  cacheSet(dbInstance, tokenAddress, result);
  return result;
}
