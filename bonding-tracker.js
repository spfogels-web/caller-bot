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
    const res = await fetch(`https://frontend-api.pump.fun/coins/${mint}`, {
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

// Aggregate stats for the dashboard. Counts pre-bond calls + how many
// graduated. Returns { preBondCalls, bonded, bondRate, lifetime }.
export function getBondRateStats(dbInstance) {
  try {
    const lifetime = dbInstance.prepare(`
      SELECT
        SUM(CASE WHEN pump_fun_stage_at_call = 'PRE_BOND' THEN 1 ELSE 0 END) AS pre_bond,
        SUM(CASE WHEN pump_fun_stage_at_call = 'PRE_BOND' AND bonded_at IS NOT NULL THEN 1 ELSE 0 END) AS bonded,
        SUM(CASE WHEN pump_fun_stage_at_call = 'MIGRATED' THEN 1 ELSE 0 END) AS already_migrated,
        COUNT(*) AS total_calls
      FROM calls
    `).get();
    const last7d = dbInstance.prepare(`
      SELECT
        SUM(CASE WHEN pump_fun_stage_at_call = 'PRE_BOND' THEN 1 ELSE 0 END) AS pre_bond,
        SUM(CASE WHEN pump_fun_stage_at_call = 'PRE_BOND' AND bonded_at IS NOT NULL THEN 1 ELSE 0 END) AS bonded
      FROM calls
      WHERE called_at > datetime('now', '-7 days')
    `).get();
    const computeRate = (bonded, preBond) => {
      const b = Number(bonded || 0);
      const p = Number(preBond || 0);
      return p > 0 ? Math.round((b / p) * 100) : null;
    };
    return {
      lifetime: {
        preBondCalls:     lifetime?.pre_bond ?? 0,
        bonded:           lifetime?.bonded   ?? 0,
        bondRate:         computeRate(lifetime?.bonded, lifetime?.pre_bond),
        alreadyMigrated:  lifetime?.already_migrated ?? 0,
        totalCalls:       lifetime?.total_calls ?? 0,
      },
      last7d: {
        preBondCalls:  last7d?.pre_bond ?? 0,
        bonded:        last7d?.bonded   ?? 0,
        bondRate:      computeRate(last7d?.bonded, last7d?.pre_bond),
      },
    };
  } catch (err) {
    console.warn('[bonding-tracker] stats:', err.message);
    return { lifetime: { preBondCalls: 0, bonded: 0, bondRate: null }, last7d: {} };
  }
}
