/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  exit-signal-monitor.js
 *  Real-time rug/dump detection on POSTed calls. Polls active calls every
 *  60s and fires Telegram alerts when one of 5 trigger patterns hits:
 *
 *    1. LP_PULL    — Liquidity dropped >25% since last check
 *    2. SELL_FLIP  — Buy ratio dropped to <35% with sells > buys
 *    3. WHALE_DUMP — Top 10 concentration jumped >5pp (whale unloading)
 *    4. DEEP_DROP  — Price dropped >40% from peak_mcap
 *    5. DEV_MOVE   — Dev wallet % dropped >2pp (dev selling)
 *
 *  Each trigger fires AT MOST ONCE per call (deduped via exit_alerts table).
 *  A call exits monitoring when:
 *    - Outcome locked as WIN with peak >= 5x (community probably exited)
 *    - Outcome locked as RUG (no point alerting after the fact)
 *    - 24h since called_at (lifecycle ended)
 *    - exit_monitor_disabled = 1 (operator override)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const DEXSCREENER_API = 'https://api.dexscreener.com';

// Optional Telegram sender wired by server.js
let _telegramHook = null;
export function setExitTelegramHook(fn) { _telegramHook = typeof fn === 'function' ? fn : null; }

// Trigger thresholds — could become autotunable later
const TRIGGERS = {
  LP_PULL_DROP_PCT:     25,   // liquidity dropped >25%
  SELL_FLIP_BR_MAX:     0.35, // buy ratio crashes below 35%
  SELL_FLIP_MIN_TXNS:   20,   // need real activity to trust the signal
  WHALE_DUMP_TOP10_JUMP: 5,   // top10 +5 percentage points
  DEEP_DROP_PEAK_PCT:   40,   // price dropped >40% from peak
  DEEP_DROP_MIN_PEAK:   2,    // only fire if call already had >=2x peak
  DEV_MOVE_PCT:         2,    // dev wallet dropped >2pp
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchCurrent(ca) {
  try {
    const res = await fetch(`${DEXSCREENER_API}/latest/dex/tokens/${ca}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs ?? [];
    if (!pairs.length) return null;
    const best = pairs.sort((a,b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    return {
      marketCap:    best.marketCap ?? best.fdv ?? 0,
      liquidity:    best.liquidity?.usd ?? 0,
      priceUsd:     parseFloat(best.priceUsd ?? 0),
      buys1h:       best.txns?.h1?.buys  ?? 0,
      sells1h:      best.txns?.h1?.sells ?? 0,
      buys5m:       best.txns?.m5?.buys  ?? 0,
      sells5m:      best.txns?.m5?.sells ?? 0,
      priceChange5m: best.priceChange?.m5  ?? 0,
      priceChange1h: best.priceChange?.h1  ?? 0,
    };
  } catch { return null; }
}

function alertHasFired(dbInstance, callId, triggerType) {
  try {
    const row = dbInstance.prepare(
      `SELECT id FROM exit_alerts WHERE call_id = ? AND trigger_type = ? LIMIT 1`
    ).get(callId, triggerType);
    return !!row;
  } catch { return false; }
}

function recordAlert(dbInstance, call, triggerType, triggerDetail, currentMcap, dropFromPeak) {
  try {
    dbInstance.prepare(`
      INSERT INTO exit_alerts (call_id, contract_address, token, trigger_type, trigger_detail, mcap_at_alert, mcap_at_peak, drop_from_peak)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(call.id, call.contract_address, call.token, triggerType, triggerDetail, currentMcap, call.peak_mcap || null, dropFromPeak);
  } catch (err) {
    console.warn('[exit] insert alert failed:', err.message);
  }
}

function fmt$(n) {
  if (n == null) return '?';
  if (n >= 1_000_000) return '$' + (n/1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return '$' + (n/1_000).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

function buildAlertMessage(call, triggerType, triggerDetail, current) {
  const peak = call.peak_mcap;
  const peakMult = call.peak_multiple ?? 1;
  const currentMcap = current.marketCap || 0;
  const dropFromPeak = peak > 0 ? ((peak - currentMcap) / peak) * 100 : 0;
  const dropFromCall = call.market_cap_at_call > 0 ? ((currentMcap - call.market_cap_at_call) / call.market_cap_at_call) * 100 : 0;

  const titles = {
    LP_PULL:    '🚨 EXIT NOW — LIQUIDITY PULLED',
    SELL_FLIP:  '🚨 EXIT NOW — SELLERS TAKING OVER',
    WHALE_DUMP: '🚨 EXIT NOW — WHALE UNLOADING',
    DEEP_DROP:  '🚨 EXIT NOW — DEEP DROP FROM PEAK',
    DEV_MOVE:   '🚨 EXIT NOW — DEV WALLET MOVING',
  };
  const title = titles[triggerType] || '🚨 EXIT SIGNAL';

  return (
    `${title}\n\n` +
    `<b>$${call.token || '?'}</b>\n` +
    `<code>${call.contract_address}</code>\n\n` +
    `<b>Trigger:</b> ${triggerDetail}\n\n` +
    `Current MC: <b>${fmt$(currentMcap)}</b>\n` +
    (peak > 0 ? `Peak MC:    <b>${fmt$(peak)}</b> (${peakMult.toFixed(2)}x)\n` : '') +
    (peak > 0 ? `From peak:  <b>${dropFromPeak >= 0 ? '-' : '+'}${Math.abs(dropFromPeak).toFixed(0)}%</b>\n` : '') +
    `From call:  <b>${dropFromCall >= 0 ? '+' : ''}${dropFromCall.toFixed(0)}%</b>\n\n` +
    `Buy/Sell 5m: <b>${current.buys5m}/${current.sells5m}</b>\n` +
    `Liq: <b>${fmt$(current.liquidity)}</b>\n\n` +
    `<a href="https://dexscreener.com/solana/${call.contract_address}">DEX</a> · <a href="https://pump.fun/${call.contract_address}">PF</a>`
  );
}

async function fireAlert(call, triggerType, triggerDetail, current, dbInstance) {
  recordAlert(dbInstance, call, triggerType, triggerDetail, current.marketCap, current.marketCap && call.peak_mcap ? ((call.peak_mcap - current.marketCap) / call.peak_mcap) * 100 : 0);
  console.log(`[exit] 🚨 ${triggerType} fired for $${call.token} — ${triggerDetail}`);
  if (_telegramHook) {
    try { await _telegramHook(buildAlertMessage(call, triggerType, triggerDetail, current)); }
    catch (err) { console.warn('[exit] telegram send failed:', err.message); }
  }
}

/**
 * Main loop — pulls all active calls, polls fresh data, evaluates triggers,
 * fires alerts for any that pass. Run every 60s from server.js.
 */
export async function runExitMonitor(dbInstance) {
  let calls;
  try {
    calls = dbInstance.prepare(`
      SELECT id, token, contract_address, called_at,
             market_cap_at_call, peak_multiple, peak_mcap, outcome,
             exit_monitor_last_check_at,
             exit_monitor_last_liquidity, exit_monitor_last_buy_ratio,
             exit_monitor_last_top10_pct, exit_monitor_last_dev_pct,
             exit_monitor_disabled
      FROM calls
      WHERE called_at > datetime('now', '-24 hours')
        AND (exit_monitor_disabled IS NULL OR exit_monitor_disabled = 0)
        AND (outcome IS NULL OR outcome = 'PENDING' OR outcome = 'WATCHLIST'
             OR (outcome = 'WIN' AND peak_multiple < 5))
      ORDER BY called_at DESC
      LIMIT 100
    `).all();
  } catch (err) {
    console.warn('[exit] query failed:', err.message);
    return { checked: 0, alerts: 0 };
  }

  let checked = 0;
  let alertsFired = 0;

  for (const call of calls) {
    const current = await fetchCurrent(call.contract_address);
    if (!current) { await sleep(150); continue; }
    checked++;

    const buys = current.buys5m + current.buys1h;
    const sells = current.sells5m + current.sells1h;
    const totalTxns = buys + sells;
    const currentBr = totalTxns > 0 ? buys / totalTxns : null;

    const lastLiq = call.exit_monitor_last_liquidity;
    const lastBr  = call.exit_monitor_last_buy_ratio;
    const lastTop10 = call.exit_monitor_last_top10_pct;
    const lastDev   = call.exit_monitor_last_dev_pct;

    // ── Trigger 1: LP_PULL ──
    if (lastLiq != null && current.liquidity > 0 && lastLiq > 0) {
      const drop = ((lastLiq - current.liquidity) / lastLiq) * 100;
      if (drop >= TRIGGERS.LP_PULL_DROP_PCT && !alertHasFired(dbInstance, call.id, 'LP_PULL')) {
        await fireAlert(call, 'LP_PULL',
          `Liquidity dropped ${drop.toFixed(0)}% (${fmt$(lastLiq)} → ${fmt$(current.liquidity)})`,
          current, dbInstance);
        alertsFired++;
      }
    }

    // ── Trigger 2: SELL_FLIP ──
    if (currentBr != null && currentBr < TRIGGERS.SELL_FLIP_BR_MAX && totalTxns >= TRIGGERS.SELL_FLIP_MIN_TXNS) {
      // Only fire if it FLIPPED from a healthy ratio (lastBr was >0.50)
      const flipped = lastBr == null || lastBr > 0.50;
      if (flipped && !alertHasFired(dbInstance, call.id, 'SELL_FLIP')) {
        await fireAlert(call, 'SELL_FLIP',
          `Buy ratio crashed to ${(currentBr*100).toFixed(0)}% (${sells} sells / ${buys} buys recent)`,
          current, dbInstance);
        alertsFired++;
      }
    }

    // ── Trigger 4: DEEP_DROP from peak ──
    // (Trigger 3 WHALE_DUMP and 5 DEV_MOVE need fresh holder/dev data — skipped
    // here since DexScreener doesn't expose those. Can add via Helius pull later.)
    if (call.peak_mcap > 0 && current.marketCap > 0 && (call.peak_multiple ?? 0) >= TRIGGERS.DEEP_DROP_MIN_PEAK) {
      const drop = ((call.peak_mcap - current.marketCap) / call.peak_mcap) * 100;
      if (drop >= TRIGGERS.DEEP_DROP_PEAK_PCT && !alertHasFired(dbInstance, call.id, 'DEEP_DROP')) {
        await fireAlert(call, 'DEEP_DROP',
          `Down ${drop.toFixed(0)}% from ${fmt$(call.peak_mcap)} peak (${call.peak_multiple.toFixed(2)}x)`,
          current, dbInstance);
        alertsFired++;
      }
    }

    // ── Update last-check snapshots so next pass can detect deltas ──
    try {
      dbInstance.prepare(`
        UPDATE calls SET
          exit_monitor_last_check_at = datetime('now'),
          exit_monitor_last_liquidity = ?,
          exit_monitor_last_buy_ratio = ?
        WHERE id = ?
      `).run(current.liquidity || null, currentBr, call.id);
    } catch {}

    await sleep(120); // gentle on DexScreener (under 300/min limit easily)
  }

  if (alertsFired > 0 || checked > 0) {
    console.log(`[exit] cycle complete — checked=${checked} active calls, fired ${alertsFired} new alerts`);
  }
  return { checked, alerts: alertsFired };
}

export function getExitMonitorStats(dbInstance) {
  try {
    const total = dbInstance.prepare('SELECT COUNT(*) AS n FROM exit_alerts').get().n;
    const last24h = dbInstance.prepare("SELECT COUNT(*) AS n FROM exit_alerts WHERE fired_at > datetime('now', '-24 hours')").get().n;
    const byType = dbInstance.prepare(`
      SELECT trigger_type, COUNT(*) AS n FROM exit_alerts
      GROUP BY trigger_type ORDER BY n DESC
    `).all();
    const recent = dbInstance.prepare(`
      SELECT token, trigger_type, trigger_detail, mcap_at_alert, drop_from_peak, fired_at
      FROM exit_alerts ORDER BY fired_at DESC LIMIT 20
    `).all();
    const activeCalls = dbInstance.prepare(`
      SELECT COUNT(*) AS n FROM calls
      WHERE called_at > datetime('now', '-24 hours')
        AND (exit_monitor_disabled IS NULL OR exit_monitor_disabled = 0)
        AND (outcome IS NULL OR outcome = 'PENDING' OR outcome = 'WATCHLIST'
             OR (outcome = 'WIN' AND peak_multiple < 5))
    `).get().n;
    return { total, last24h, byType, recent, activeCalls };
  } catch (err) {
    return { error: err.message };
  }
}
