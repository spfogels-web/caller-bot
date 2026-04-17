// ─────────────────────────────────────────────────────────────────────────────
// solscan-wallet-enricher.js
//
// Backfills the `tracked_wallets` table with real win-rate / ROI numbers by
// pulling each wallet's recent token transfers from Solscan and cross-
// referencing them against our own `audit_archive` outcomes.
//
// Strategy
//   1. For each tracked wallet, fetch last ~200 token transfers (Solscan)
//   2. Look up every token the wallet touched in our `audit_archive`
//   3. Score the wallet on overlap with our resolved winners/losers
//        win_rate     = wins / (wins + losses)
//        avg_roi      = average peak_multiple over tokens this wallet touched
//        trade_count  = total Solscan transfers in window
//        wins_found_in / losses_in = counts
//   4. Persist back to tracked_wallets
//
// Why this approach
//   Computing absolute PnL from Solscan free data is unreliable — no
//   price-at-time info on free tier. But we already have outcome data on
//   tokens we promoted; if a wallet keeps showing up early on those, that's
//   smart money by definition.
//
// Rate limit: Solscan free tier is 5 req/sec. We sleep 250ms between calls
// (~4 rps) to stay under it with headroom.
// ─────────────────────────────────────────────────────────────────────────────

const SOLSCAN_API_KEY    = process.env.SOLSCAN_API_KEY;
const SOLSCAN_BASE       = 'https://pro-api.solscan.io/v2.0';
const REQUEST_TIMEOUT_MS = 9_000;
const RATE_DELAY_MS      = 250;          // 4 req/sec
const STALE_AFTER_HOURS  = 24;           // refresh wallets older than this
const MAX_PER_RUN        = 50;           // wallets to enrich per cron tick

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Solscan API call ───────────────────────────────────────────────────────
async function solscanFetchTransfers(address, pageSize = 100) {
  if (!SOLSCAN_API_KEY) {
    throw new Error('SOLSCAN_API_KEY missing — set it in Railway variables');
  }
  // Solscan Pro v2 splits results across pages; pull two pages to get ~200
  const all = [];
  let lastStatus = null;
  for (const page of [1, 2]) {
    const url = `${SOLSCAN_BASE}/account/transfer`
              + `?address=${encodeURIComponent(address)}`
              + `&page=${page}&page_size=${pageSize}`
              + `&sort_by=block_time&sort_order=desc`;
    let res;
    try {
      res = await fetch(url, {
        headers: {
          token: SOLSCAN_API_KEY,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error / timeout — return what we have so far
      console.warn(`[solscan] network error for ${address.slice(0, 8)}: ${err.message}`);
      break;
    }
    lastStatus = res.status;
    if (res.status === 429) {
      console.warn('[solscan] rate-limited, sleeping 5s');
      await sleep(5_000);
      break;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Solscan auth failed (${res.status}) — check SOLSCAN_API_KEY`);
    }
    if (!res.ok) {
      console.warn(`[solscan] ${res.status} for ${address.slice(0, 8)}`);
      break;
    }
    let json;
    try { json = await res.json(); } catch { break; }
    const items = json?.data ?? json?.result ?? json?.transfers ?? [];
    if (!Array.isArray(items) || !items.length) break;
    all.push(...items);
    if (items.length < pageSize) break;        // no more pages
    await sleep(RATE_DELAY_MS);
  }
  return { transfers: all, lastStatus };
}

// Normalize Solscan transfer rows into { tokenAddress, blockTime, side }.
// Side is 'IN' (wallet received tokens, i.e. bought) or 'OUT' (sold/sent).
function normalizeTransfers(transfers, walletAddress) {
  const wallet = walletAddress.toLowerCase();
  return transfers.map((t) => {
    const tokenAddress = (t.token_address || t.tokenAddress || t.mint || '').toString();
    const blockTime    = t.block_time || t.blockTime || t.time || null;
    const fromAddr     = (t.from_address || t.fromAddress || t.from || '').toLowerCase();
    const toAddr       = (t.to_address   || t.toAddress   || t.to   || '').toLowerCase();
    const side         = toAddr === wallet ? 'IN' : fromAddr === wallet ? 'OUT' : 'UNKNOWN';
    return { tokenAddress, blockTime, side };
  }).filter((t) => t.tokenAddress && t.tokenAddress.length >= 32);
}

// ─── Cross-reference with our audit_archive ─────────────────────────────────
function scoreWalletAgainstArchive(transfers, dbInstance) {
  if (!transfers.length) return null;
  const uniqueTokens = [...new Set(transfers.map((t) => t.tokenAddress))];
  if (!uniqueTokens.length) return null;

  // SQLite IN-list — chunk if huge to avoid SQL parameter limits
  const placeholders = uniqueTokens.map(() => '?').join(',');
  let archived = [];
  try {
    archived = dbInstance.prepare(
      `SELECT contract_address, outcome, peak_multiple, market_cap, final_decision
       FROM audit_archive WHERE contract_address IN (${placeholders})`
    ).all(...uniqueTokens);
  } catch (err) {
    console.warn('[solscan] archive lookup failed:', err.message);
    return null;
  }

  let wins = 0, losses = 0, peakSum = 0, peakCount = 0;
  for (const a of archived) {
    if (a.outcome === 'WIN') wins++;
    else if (a.outcome === 'LOSS') losses++;
    if (a.peak_multiple != null && a.peak_multiple > 0) {
      peakSum += a.peak_multiple;
      peakCount++;
    }
  }
  const decided  = wins + losses;
  const winRate  = decided > 0 ? wins / decided : null;
  const avgPeak  = peakCount > 0 ? peakSum / peakCount : null;
  // ROI = peak - 1 (so 2.0× peak = 100% ROI)
  const avgRoi   = avgPeak != null ? avgPeak - 1 : null;
  // Score: prefer wallets with high win rate AND meaningful sample size
  const score    = decided > 0
    ? Math.round((winRate * 60) + Math.min(decided * 2, 30) + Math.min((avgPeak ?? 0) * 5, 10))
    : 0;

  return {
    transferCount: transfers.length,
    overlapCount:  archived.length,
    wins,
    losses,
    decided,
    winRate,
    avgPeak,
    avgRoi,
    score,
  };
}

// ─── Persist back to tracked_wallets ────────────────────────────────────────
function categorizeWallet(stats) {
  if (!stats || stats.decided === 0) return 'NEUTRAL';
  if (stats.winRate >= 0.6  && stats.wins >= 3)  return 'WINNER';
  if (stats.winRate >= 0.4  && stats.wins >= 5)  return 'SMART_MONEY';
  if (stats.winRate >= 0.25 && stats.decided >= 8) return 'MOMENTUM';
  if (stats.losses > stats.wins * 2 && stats.losses >= 3) return 'CLUSTER';  // losing pattern → suspicious
  return 'NEUTRAL';
}

function persistEnrichment(address, stats, dbInstance) {
  if (!stats) return;
  const category = categorizeWallet(stats);
  try {
    // Upsert: insert if missing, update if present
    dbInstance.prepare(
      `INSERT INTO tracked_wallets
         (address, category, source, win_rate, avg_roi, trade_count,
          wins_found_in, losses_in, score, updated_at, last_seen)
       VALUES (?, ?, 'solscan', ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(address) DO UPDATE SET
         category      = excluded.category,
         win_rate      = excluded.win_rate,
         avg_roi       = excluded.avg_roi,
         trade_count   = excluded.trade_count,
         wins_found_in = excluded.wins_found_in,
         losses_in     = excluded.losses_in,
         score         = excluded.score,
         updated_at    = datetime('now'),
         last_seen     = datetime('now')`
    ).run(
      address, category,
      stats.winRate ?? 0, stats.avgRoi ?? 0, stats.transferCount,
      stats.wins, stats.losses, stats.score,
    );
  } catch (err) {
    console.warn('[solscan] persist failed for', address.slice(0, 8), err.message);
  }
}

// ─── Public entry points ────────────────────────────────────────────────────

/**
 * Enrich a single wallet — useful for triggered enrichment when a new
 * "early wallet" appears on a token we just promoted.
 */
export async function enrichWallet(address, dbInstance) {
  if (!address || !dbInstance) return null;
  try {
    const { transfers, lastStatus } = await solscanFetchTransfers(address, 100);
    if (!transfers.length) {
      // Mark as "scanned but empty" so this wallet moves out of the stale
      // queue. Without this, the same 50 dead wallets cycle every 6h and
      // the enricher reports "failed 50" forever. We stamp updated_at and
      // set trade_count=0 so categorizeWallet returns NEUTRAL next time.
      try {
        dbInstance.prepare(`
          UPDATE tracked_wallets
          SET trade_count = 0, updated_at = datetime('now'), last_seen = datetime('now')
          WHERE address = ?
        `).run(address);
        // Insert a stub row if one doesn't exist yet (early_wallets path)
        dbInstance.prepare(`
          INSERT OR IGNORE INTO tracked_wallets (address, category, source, updated_at, last_seen, trade_count)
          VALUES (?, 'NEUTRAL', 'solscan_empty', datetime('now'), datetime('now'), 0)
        `).run(address);
      } catch {}
      console.log(`[solscan-enricher] ${address.slice(0,8)}… no transfers (status=${lastStatus ?? 'none'}) — marked scanned, skipping future cycles`);
      return null;
    }
    const normalized = normalizeTransfers(transfers, address);
    const stats = scoreWalletAgainstArchive(normalized, dbInstance);
    if (stats) persistEnrichment(address, stats, dbInstance);
    return stats;
  } catch (err) {
    console.warn('[solscan-enricher] enrichWallet failed:', err.message);
    return null;
  }
}

/**
 * Background batch: pick the staler wallets and refresh their stats.
 * Runs on a 6h interval from server.js.
 */
export async function enrichStaleWallets(dbInstance, batchSize = MAX_PER_RUN) {
  if (!SOLSCAN_API_KEY) {
    console.warn('[solscan-enricher] skipped — SOLSCAN_API_KEY not set');
    return { enriched: 0, skipped: 'no-key' };
  }

  // Candidates to refresh: known tracked wallets + early-buyer wallets
  // from our promoted tokens that haven't been enriched yet.
  let wallets = [];
  try {
    wallets = dbInstance.prepare(
      `SELECT address FROM tracked_wallets
       WHERE updated_at < datetime('now', ?)
          OR updated_at IS NULL
       ORDER BY updated_at ASC NULLS FIRST
       LIMIT ?`
    ).all(`-${STALE_AFTER_HOURS} hours`, batchSize);
  } catch (err) {
    console.warn('[solscan-enricher] stale query failed:', err.message);
    return { enriched: 0, error: err.message };
  }

  // Also enrich any holder addresses from recent promoted tokens that
  // we don't yet have in tracked_wallets.
  if (wallets.length < batchSize) {
    try {
      const holderAddrs = dbInstance.prepare(
        `SELECT DISTINCT ew.wallet
         FROM early_wallets ew
         LEFT JOIN tracked_wallets tw ON tw.address = ew.wallet
         WHERE tw.address IS NULL
         LIMIT ?`
      ).all(batchSize - wallets.length);
      wallets.push(...holderAddrs.map((r) => ({ address: r.wallet })));
    } catch {}
  }

  if (!wallets.length) {
    return { enriched: 0, message: 'no stale wallets' };
  }

  console.log(`[solscan-enricher] enriching ${wallets.length} wallets...`);
  let ok = 0, fail = 0;
  for (const { address } of wallets) {
    if (!address) continue;
    try {
      const stats = await enrichWallet(address, dbInstance);
      if (stats) ok++; else fail++;
    } catch {
      fail++;
    }
    await sleep(RATE_DELAY_MS);
  }
  console.log(`[solscan-enricher] done — enriched ${ok}, failed ${fail}`);
  return { enriched: ok, failed: fail, total: wallets.length };
}

/**
 * Start the background interval. Call once from server.js startup.
 */
export function startSolscanEnrichmentLoop(dbInstance, intervalMs = 6 * 60 * 60_000) {
  if (!SOLSCAN_API_KEY) {
    console.warn('[solscan-enricher] not starting — SOLSCAN_API_KEY not set');
    return null;
  }
  console.log(`[solscan-enricher] starting (interval ${Math.round(intervalMs / 60000)} min)`);
  // First run after 60s so server has finished booting
  const first = setTimeout(() => {
    enrichStaleWallets(dbInstance).catch((e) =>
      console.warn('[solscan-enricher] first run failed:', e.message)
    );
  }, 60_000);
  const handle = setInterval(() => {
    enrichStaleWallets(dbInstance).catch((e) =>
      console.warn('[solscan-enricher] interval run failed:', e.message)
    );
  }, intervalMs);
  return { first, handle };
}
