/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  bonding-tracker.js — track pump.fun bonding-curve graduations on our calls
 *
 *  Every 15 minutes, scans the calls table for any call where:
 *     pump_fun_stage_at_call = 'PRE_BOND'  AND  bonded_at IS NULL
 *  …and re-checks pump.fun's API to see if the coin has now graduated to
 *  Raydium (i.e. bonded). When it has, sets bonded_at + bonded_mcap so
 *  the dashboard can compute bond rate (% of pre-bond calls that bonded).
 *
 *  Stops checking calls older than 14 days OR already bonded — keeps the
 *  poll loop tight.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const TICK_MS         = 15 * 60 * 1000;        // every 15min
const BOOT_DELAY_MS   = 4 * 60 * 1000;         // first run 4min after boot
const MAX_CHECK_AGE_DAYS = 14;
const REQUEST_TIMEOUT_MS = 6_000;
const INTER_CALL_DELAY_MS = 200;

let _tickTimer = null;
let _stats = {
  ticks:          0,
  callsChecked:   0,
  bondingsCaught: 0,
  lastTickAt:     null,
  lastError:      null,
};

async function fetchPumpFunCoin(mint) {
  try {
    // Pump.fun migrated to v3 host — the old frontend-api.pump.fun returns
    // Cloudflare 1016 now. helius-listener.js has the matching constant.
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

async function runBondingTick(dbInstance) {
  try {
    const rows = dbInstance.prepare(`
      SELECT id, contract_address, token, called_at
      FROM calls
      WHERE pump_fun_stage_at_call = 'PRE_BOND'
        AND bonded_at IS NULL
        AND called_at > datetime('now', '-${MAX_CHECK_AGE_DAYS} days')
      ORDER BY called_at DESC
      LIMIT 50
    `).all();

    if (!rows.length) {
      _stats.ticks++;
      _stats.lastTickAt = new Date().toISOString();
      _stats.lastError = null;
      return;
    }

    const upd = dbInstance.prepare(`
      UPDATE calls SET bonded_at = ?, bonded_mcap = ? WHERE id = ?
    `);

    let caught = 0;
    for (const r of rows) {
      const data = await fetchPumpFunCoin(r.contract_address);
      if (data?.complete === true) {
        const mc = Number(data?.usd_market_cap ?? 0) || null;
        upd.run(new Date().toISOString(), mc, r.id);
        caught++;
        console.log(`[bonding-tracker] 🎓 $${r.token ?? r.contract_address.slice(0,6)} BONDED (mcap=$${(mc/1000).toFixed(1)}K)`);
      }
      await sleep(INTER_CALL_DELAY_MS);
    }

    _stats.callsChecked   += rows.length;
    _stats.bondingsCaught += caught;
    _stats.ticks++;
    _stats.lastTickAt      = new Date().toISOString();
    _stats.lastError       = null;
    if (caught > 0) {
      console.log(`[bonding-tracker] tick complete — checked ${rows.length}, caught ${caught} new bondings`);
    }
  } catch (err) {
    console.error('[bonding-tracker] tick error:', err.message);
    _stats.lastError = err.message;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function startBondingTracker(dbInstance) {
  if (_tickTimer) return;
  console.log(`[bonding-tracker] starting — every ${TICK_MS/60_000}min, scans pre-bond calls in last ${MAX_CHECK_AGE_DAYS}d`);
  setTimeout(() => { runBondingTick(dbInstance).catch(() => {}); }, BOOT_DELAY_MS);
  _tickTimer = setInterval(() => {
    runBondingTick(dbInstance).catch(() => {});
  }, TICK_MS);
}

export function stopBondingTracker() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

export function getBondingTrackerStats() { return { ..._stats }; }

// Aggregate stats for the dashboard. MCap-based eligibility (was previously
// pump_fun_stage based, which only covered pump.fun coins). New definition:
//
//   ELIGIBLE  = called when MCap ≤ BONDING_ELIGIBLE_MAX_MCAP_USD (default $35K)
//               — these are "real pre-bond catches" with room to grow before
//               hitting the ~$44K graduation threshold
//   BONDED    = of those, peak_mcap ≥ PUMP_FUN_GRADUATION_MCAP_USD (default $44K)
//               — i.e. the coin reached graduation MCap
//   POST-BOND = called when MCap ≥ graduation threshold (already past the curve)
//
//   bondRate = bonded ÷ eligible
//
// Returned shape: same field names as before so the dashboard wiring keeps
// working. preBondCalls now means "eligible" (MCap-defined). Subset
// guarantees still hold because everything's a single SQL pass.
export function getBondRateStats(dbInstance) {
  try {
    const ELIGIBLE_MAX = Number(process.env.BONDING_ELIGIBLE_MAX_MCAP_USD) || 35_000;
    const GRAD_MCAP    = Number(process.env.PUMP_FUN_GRADUATION_MCAP_USD)  || 44_000;

    const aggSql = (whereClause) => `
      SELECT
        SUM(CASE WHEN market_cap_at_call IS NOT NULL AND market_cap_at_call <= ${ELIGIBLE_MAX} THEN 1 ELSE 0 END) AS pre_bond,
        SUM(CASE WHEN market_cap_at_call IS NOT NULL AND market_cap_at_call <= ${ELIGIBLE_MAX} AND COALESCE(peak_mcap, 0) >= ${GRAD_MCAP} THEN 1 ELSE 0 END) AS bonded,
        SUM(CASE WHEN market_cap_at_call IS NOT NULL AND market_cap_at_call >  ${GRAD_MCAP} THEN 1 ELSE 0 END) AS already_migrated,
        AVG(CASE WHEN market_cap_at_call IS NOT NULL AND market_cap_at_call <= ${ELIGIBLE_MAX} AND COALESCE(peak_mcap, 0) >= ${GRAD_MCAP} AND peak_multiple IS NOT NULL THEN peak_multiple END) AS avg_peak_bonded,
        AVG(CASE WHEN market_cap_at_call IS NOT NULL AND market_cap_at_call >  ${GRAD_MCAP} AND peak_multiple IS NOT NULL THEN peak_multiple END) AS avg_peak_postmig,
        SUM(CASE WHEN market_cap_at_call IS NOT NULL THEN 1 ELSE 0 END) AS tagged,
        COUNT(*) AS total
      FROM calls
      ${whereClause}
    `;
    const lifetime = dbInstance.prepare(aggSql('')).get();
    const last7d   = dbInstance.prepare(aggSql(`WHERE called_at > datetime('now', '-7 days')`)).get();

    const rate = (bonded, preBond) => {
      const b = Number(bonded || 0);
      const p = Number(preBond || 0);
      return p > 0 ? Math.round((b / p) * 100) : null;
    };
    const round1 = (v) => (v != null && Number.isFinite(v)) ? Math.round(v * 10) / 10 : null;
    const coverage = (tagged, total) => {
      const t = Number(total || 0);
      return t > 0 ? Math.round((Number(tagged || 0) / t) * 100) : null;
    };

    return {
      lifetime: {
        preBondCalls:     lifetime?.pre_bond ?? 0,
        bonded:           lifetime?.bonded ?? 0,
        bondRate:         rate(lifetime?.bonded, lifetime?.pre_bond),
        avgPeakBonded:    round1(lifetime?.avg_peak_bonded),
        postMigCalls:     lifetime?.already_migrated ?? 0,
        avgPeakPostMig:   round1(lifetime?.avg_peak_postmig),
        taggedCalls:      lifetime?.tagged ?? 0,
        totalCalls:       lifetime?.total ?? 0,
        coverage:         coverage(lifetime?.tagged, lifetime?.total),
      },
      last7d: {
        preBondCalls:    last7d?.pre_bond ?? 0,
        bonded:          last7d?.bonded ?? 0,
        bondRate:        rate(last7d?.bonded, last7d?.pre_bond),
        avgPeakBonded:   round1(last7d?.avg_peak_bonded),
        postMigCalls:    last7d?.already_migrated ?? 0,
        avgPeakPostMig:  round1(last7d?.avg_peak_postmig),
      },
      thresholds: {
        eligibleMaxMcapUsd: ELIGIBLE_MAX,
        gradMcapUsd:        GRAD_MCAP,
      },
    };
  } catch (err) {
    console.warn('[bonding-tracker] stats:', err.message);
    return {
      lifetime: { preBondCalls: 0, bonded: 0, bondRate: null, avgPeakBonded: null, postMigCalls: 0, avgPeakPostMig: null, taggedCalls: 0, totalCalls: 0, coverage: null },
      last7d:   { preBondCalls: 0, bonded: 0, bondRate: null, avgPeakBonded: null, postMigCalls: 0, avgPeakPostMig: null },
    };
  }
}
