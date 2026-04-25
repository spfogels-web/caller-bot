/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  backfill-outcomes.js
 *  One-shot ATH backfill for past calls. Uses GeckoTerminal's free OHLCV API
 *  to find the TRUE peak market cap each call reached between called_at and
 *  now — fixes the bug where the live tracker only saw current (often dead)
 *  prices and incorrectly logged peak coins as LOSS.
 *
 *  Logic:
 *    1. Pull all calls with peak_multiple < 1.5 OR outcome != WIN
 *    2. For each: get pool address from GeckoTerminal, pull OHLCV between
 *       called_at and now, find max(high) price.
 *    3. Compute true peak_multiple = max_high / price_at_call
 *    4. If peak ≥ stored peak, update calls + audit_archive + calls_archive
 *       + coin_fingerprints
 *    5. If peak ≥ 1.5x and outcome != WIN, upgrade to WIN
 *
 *  GeckoTerminal free tier: 30 req/min — we throttle to 2.2s between requests.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
const RATE_LIMIT_MS = 2200; // ~27 req/min

let _lastReq = 0;
async function rateLimited(url) {
  const wait = Math.max(0, _lastReq + RATE_LIMIT_MS - Date.now());
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  _lastReq = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Find the most-liquid pool for a token (so OHLCV pulls real volume)
async function getPrimaryPool(ca) {
  try {
    const data = await rateLimited(`${GECKO_BASE}/networks/solana/tokens/${ca}/pools?page=1`);
    const pools = data?.data || [];
    if (!pools.length) return null;
    pools.sort((a, b) => parseFloat(b.attributes?.reserve_in_usd ?? 0) - parseFloat(a.attributes?.reserve_in_usd ?? 0));
    return pools[0]?.attributes?.address ?? null;
  } catch (err) {
    return null;
  }
}

// Find ATH price between fromMs and now via OHLCV bars
export async function findHistoricalPeak(ca, fromMs) {
  const poolAddress = await getPrimaryPool(ca);
  if (!poolAddress) return null;

  const fromSec = Math.floor(fromMs / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  const elapsedHours = Math.max(1, (nowSec - fromSec) / 3600);

  // Pick timeframe to fit the window into ≤1000 candles
  let timeframe, aggregate;
  if (elapsedHours <= 24)        { timeframe = 'minute'; aggregate = 5; }
  else if (elapsedHours <= 168)  { timeframe = 'minute'; aggregate = 15; }
  else if (elapsedHours <= 720)  { timeframe = 'hour';   aggregate = 1; }
  else                           { timeframe = 'hour';   aggregate = 4; }

  try {
    const url = `${GECKO_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=1000&currency=usd`;
    const data = await rateLimited(url);
    const ohlcv = data?.data?.attributes?.ohlcv_list || [];
    if (!ohlcv.length) return null;

    // ohlcv format: [[unixSec, open, high, low, close, volume], ...]
    // Filter to bars at or after fromSec
    const inRange = ohlcv.filter(c => c[0] >= fromSec);
    if (!inRange.length) return null;

    let peakBar = inRange[0];
    for (const c of inRange) if (c[2] > peakBar[2]) peakBar = c;

    return {
      peakPrice: peakBar[2],
      peakAtMs: peakBar[0] * 1000,
      barsAnalyzed: inRange.length,
      poolAddress,
      timeframe: `${aggregate}${timeframe[0]}`,
    };
  } catch (err) {
    return { error: err.message, poolAddress };
  }
}

/**
 * Run backfill across all calls in the DB. Returns a summary of changes.
 *
 * @param {object} dbInstance - better-sqlite3 instance
 * @param {object} opts
 * @param {boolean} opts.dryRun - if true, log changes but don't write
 * @param {number}  opts.limit  - max calls to process (default: all)
 * @param {boolean} opts.onlyLossesAndPending - skip already-WIN calls (default: true)
 */
export async function backfillCallOutcomes(dbInstance, opts = {}) {
  const { dryRun = false, limit = null, onlyLossesAndPending = true } = opts;
  const WIN_PEAK = 1.5;

  // Pull eligible calls
  let where = onlyLossesAndPending ? `WHERE (outcome IS NULL OR outcome != 'WIN' OR peak_multiple IS NULL OR peak_multiple < ?)` : '';
  let params = onlyLossesAndPending ? [WIN_PEAK] : [];
  let limitClause = limit ? ` LIMIT ${parseInt(limit)}` : '';
  const sql = `SELECT id, contract_address, token, called_at, price_at_call, market_cap_at_call,
                       peak_multiple, peak_mcap, outcome
               FROM calls
               ${where}
               ORDER BY called_at DESC${limitClause}`;
  const calls = dbInstance.prepare(sql).all(...params);

  console.log(`[backfill] Processing ${calls.length} call(s)...`);
  const summary = {
    total: calls.length,
    processed: 0,
    upgraded_to_win: 0,
    peak_updated: 0,
    no_pool_found: 0,
    no_price_data: 0,
    api_errors: 0,
    skipped_no_baseline: 0,
    changes: [],
  };

  for (const call of calls) {
    summary.processed++;
    const ca = call.contract_address;
    if (!ca) continue;

    // Need a baseline price to compute multiple
    const baselinePrice = call.price_at_call;
    if (!baselinePrice || baselinePrice <= 0) {
      summary.skipped_no_baseline++;
      continue;
    }

    // called_at is a SQLite datetime string — convert to ms
    const calledAtMs = new Date(call.called_at).getTime();
    if (!Number.isFinite(calledAtMs)) {
      summary.skipped_no_baseline++;
      continue;
    }

    const result = await findHistoricalPeak(ca, calledAtMs);
    if (!result) { summary.no_pool_found++; continue; }
    if (result.error) { summary.api_errors++; console.warn(`[backfill] $${call.token}: ${result.error}`); continue; }
    if (!result.peakPrice) { summary.no_price_data++; continue; }

    const truePeakMultiple = result.peakPrice / baselinePrice;
    const truePeakMcap = call.market_cap_at_call != null
      ? truePeakMultiple * call.market_cap_at_call
      : null;

    const storedPeak = call.peak_multiple ?? 0;
    const newPeak = Math.max(storedPeak, truePeakMultiple);

    const wasOutcome = call.outcome;
    const newOutcome = newPeak >= WIN_PEAK ? 'WIN'
                     : newPeak >= 0.9      ? 'NEUTRAL'
                     : newPeak >= 0.5      ? 'LOSS'
                     : 'RUG';

    const willUpgradePeak = truePeakMultiple > storedPeak + 0.01;
    const willUpgradeWin  = newOutcome === 'WIN' && wasOutcome !== 'WIN';

    if (!willUpgradePeak && !willUpgradeWin) {
      console.log(`[backfill] $${call.token}: peak=${truePeakMultiple.toFixed(2)}x stored=${storedPeak.toFixed(2)}x outcome=${wasOutcome} — no change`);
      continue;
    }

    if (willUpgradePeak) summary.peak_updated++;
    if (willUpgradeWin)  summary.upgraded_to_win++;

    summary.changes.push({
      id: call.id,
      token: call.token,
      ca,
      old_peak: storedPeak,
      new_peak: +truePeakMultiple.toFixed(3),
      old_outcome: wasOutcome,
      new_outcome: newOutcome,
      bars: result.barsAnalyzed,
      timeframe: result.timeframe,
    });

    if (!dryRun) {
      // Update calls row
      try {
        dbInstance.prepare(`
          UPDATE calls SET
            peak_multiple = CASE WHEN peak_multiple IS NULL OR ? > peak_multiple THEN ? ELSE peak_multiple END,
            peak_mcap     = CASE WHEN peak_mcap     IS NULL OR ? > peak_mcap     THEN ? ELSE peak_mcap     END,
            outcome       = CASE WHEN ? = 'WIN' OR outcome IS NULL THEN ? ELSE outcome END,
            outcome_source = CASE WHEN ? = 'WIN' AND (outcome IS NULL OR outcome != 'WIN') THEN 'BACKFILL' ELSE outcome_source END,
            outcome_set_at = CASE WHEN ? = 'WIN' AND (outcome IS NULL OR outcome != 'WIN') THEN datetime('now') ELSE outcome_set_at END,
            auto_resolved = CASE WHEN ? = 'WIN' THEN 1 ELSE auto_resolved END,
            auto_resolved_at = CASE WHEN ? = 'WIN' AND (outcome IS NULL OR outcome != 'WIN') THEN datetime('now') ELSE auto_resolved_at END
          WHERE id = ?
        `).run(
          truePeakMultiple, truePeakMultiple,
          truePeakMcap, truePeakMcap,
          newOutcome, newOutcome,
          newOutcome,
          newOutcome,
          newOutcome,
          newOutcome,
          call.id
        );
      } catch (err) { console.warn(`[backfill] calls update failed for $${call.token}:`, err.message); }

      // Cascade to audit_archive
      try {
        dbInstance.prepare(`
          UPDATE audit_archive
          SET peak_multiple = CASE WHEN peak_multiple IS NULL OR ? > peak_multiple THEN ? ELSE peak_multiple END,
              outcome = CASE WHEN ? = 'WIN' OR outcome IS NULL THEN ? ELSE outcome END,
              outcome_locked_at = CASE WHEN ? = 'WIN' THEN datetime('now') ELSE outcome_locked_at END
          WHERE contract_address = ?
        `).run(truePeakMultiple, truePeakMultiple, newOutcome, newOutcome, newOutcome, ca);
      } catch {}

      // Cascade to calls_archive
      try {
        dbInstance.prepare(`
          UPDATE calls_archive
          SET peak_multiple = CASE WHEN peak_multiple IS NULL OR ? > peak_multiple THEN ? ELSE peak_multiple END,
              outcome = CASE WHEN ? = 'WIN' OR outcome IS NULL THEN ? ELSE outcome END
          WHERE contract_address = ?
        `).run(truePeakMultiple, truePeakMultiple, newOutcome, newOutcome, ca);
      } catch {}

      // Cascade to coin_fingerprints (pattern matching library)
      try {
        dbInstance.prepare(`
          UPDATE coin_fingerprints
          SET peak_multiple = CASE WHEN peak_multiple IS NULL OR ? > peak_multiple THEN ? ELSE peak_multiple END,
              peak_mcap     = CASE WHEN peak_mcap     IS NULL OR ? > peak_mcap     THEN ? ELSE peak_mcap     END,
              outcome       = ?,
              peak_at_ms    = COALESCE(peak_at_ms, ?),
              resolved_at_ms = ?
          WHERE contract_address = ?
        `).run(truePeakMultiple, truePeakMultiple, truePeakMcap, truePeakMcap, newOutcome, result.peakAtMs, Date.now(), ca);
      } catch {}
    }

    console.log(`[backfill] $${call.token}: peak=${truePeakMultiple.toFixed(2)}x (was ${storedPeak.toFixed(2)}x) → ${wasOutcome} → ${newOutcome}${dryRun ? ' (DRY RUN)' : ''}`);
  }

  console.log('[backfill] DONE — summary:');
  console.log(`  total processed:  ${summary.processed}`);
  console.log(`  upgraded to WIN:  ${summary.upgraded_to_win}`);
  console.log(`  peak updated:     ${summary.peak_updated}`);
  console.log(`  no pool found:    ${summary.no_pool_found}`);
  console.log(`  no price data:    ${summary.no_price_data}`);
  console.log(`  API errors:       ${summary.api_errors}`);
  return summary;
}
