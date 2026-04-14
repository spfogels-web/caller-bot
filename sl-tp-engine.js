/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  sl-tp-engine.js — Stop Loss & Take Profit Calculator
 *
 *  Computes SL/TP levels for every call based on:
 *    - Token risk level (higher risk = tighter SL)
 *    - Stage (new launch vs established)
 *    - Liquidity (thin liq = tighter SL)
 *    - Structure grade (elite structure = wider TP runway)
 *    - Volatility signals (1h/5m price action)
 *    - Market regime
 *
 *  Returns price levels + percentage targets for the Telegram message.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

/**
 * Compute SL/TP for a candidate.
 *
 * @param {object} candidate — enriched candidate
 * @param {object} scoreResult — from computeFullScore()
 * @param {object} botConfig — NEW_COINS / TRENDING / WALLET_BOT config
 * @returns {object|null} SL/TP data
 */
export function computeSLTP(candidate, scoreResult, botConfig = {}) {
  const entryPrice = candidate.priceUsd;
  if (!entryPrice || entryPrice <= 0) return null;

  const stage     = scoreResult?.stage ?? 'UNKNOWN';
  const grade     = scoreResult?.structureGrade ?? 'AVERAGE';
  const risk      = scoreResult?.risk ?? 'MEDIUM';
  const liq       = Number(candidate.liquidity ?? 0);
  const mcap      = Number(candidate.marketCap ?? 0);
  const change1h  = Number(candidate.priceChange1h ?? 0);
  const change5m  = Number(candidate.priceChange5m ?? 0);
  const botId     = botConfig.id ?? 'TRENDING';

  // ── Stop Loss ────────────────────────────────────────────────────────────

  // Base SL by risk level
  let sl1Pct = {
    LOW:     12,
    MEDIUM:  18,
    HIGH:    22,
    EXTREME: 28,
  }[risk] ?? 18;

  let sl2Pct = sl1Pct * 1.6; // second SL is wider (partial exit zone)

  // Stage adjustments
  if (stage === 'LAUNCH' || stage === 'EARLY') {
    sl1Pct += 5;   // new launches are volatile — give more room
    sl2Pct += 7;
  } else if (stage === 'MATURE' || stage === 'ESTABLISHED') {
    sl1Pct -= 3;   // more established — tighter SL acceptable
    sl2Pct -= 4;
  }

  // Thin liquidity = tighter SL (slippage risk is real)
  if (liq < 10_000) {
    sl1Pct -= 3;
    sl2Pct -= 3;
  }

  // If already pumped hard, tighten SL (don't let winner turn to loss)
  if (change1h > 100) { sl1Pct -= 5; sl2Pct -= 6; }
  else if (change1h > 50) { sl1Pct -= 2; sl2Pct -= 3; }

  // Bot-specific SL
  if (botId === 'NEW_COINS') { sl1Pct += 5; sl2Pct += 6; }  // new coins volatile
  if (botId === 'WALLET_BOT') { sl1Pct += 3; sl2Pct += 4; } // trust wallet more

  sl1Pct = Math.max(8, Math.min(35, Math.round(sl1Pct)));
  sl2Pct = Math.max(sl1Pct + 5, Math.min(50, Math.round(sl2Pct)));

  // ── Take Profit ──────────────────────────────────────────────────────────

  // Base TP multipliers by structure grade
  const tpBase = {
    ELITE:   { tp1: 50, tp2: 120, tp3: 300 },
    CLEAN:   { tp1: 40, tp2: 100, tp3: 250 },
    AVERAGE: { tp1: 30, tp2:  80, tp3: 200 },
    MIXED:   { tp1: 25, tp2:  60, tp3: 150 },
    DIRTY:   { tp1: 20, tp2:  50, tp3: 120 },
  }[grade] ?? { tp1: 30, tp2: 80, tp3: 200 };

  // Stage adjustments for TP
  let tpMult = 1.0;
  if (stage === 'LAUNCH')       tpMult = 1.5;  // early = more upside potential
  else if (stage === 'EARLY')   tpMult = 1.3;
  else if (stage === 'MATURE')  tpMult = 0.7;  // late = less room

  // Momentum bonus: already moving fast = TP further
  if (change5m > 20 && change1h > 30) tpMult *= 1.2;

  // Mcap cap: gigantic mcap = less room
  if (mcap > 5_000_000)  tpMult *= 0.6;
  else if (mcap > 1_000_000) tpMult *= 0.8;
  else if (mcap < 50_000) tpMult *= 1.3;  // micro-cap = more room

  // Bot-specific TP
  if (botId === 'NEW_COINS') tpMult *= 1.4;  // new launches can 5-10x
  if (botId === 'WALLET_BOT') tpMult *= 1.2; // smart money signal = more conviction

  const tp1Pct = Math.round(tpBase.tp1 * tpMult);
  const tp2Pct = Math.round(tpBase.tp2 * tpMult);
  const tp3Pct = Math.round(tpBase.tp3 * tpMult);

  // ── Max Hold ──────────────────────────────────────────────────────────────

  const maxHoldHours = {
    LAUNCH:      1,
    EARLY:       2,
    DEVELOPING:  4,
    ESTABLISHED: 8,
    MATURE:      12,
    UNKNOWN:     6,
  }[stage] ?? 6;

  const maxHoldLabel = maxHoldHours < 1 ? `${maxHoldHours * 60}m` : `${maxHoldHours}h`;

  // ── Price Levels ──────────────────────────────────────────────────────────

  const sl1Price = entryPrice * (1 - sl1Pct / 100);
  const sl2Price = entryPrice * (1 - sl2Pct / 100);
  const tp1Price = entryPrice * (1 + tp1Pct / 100);
  const tp2Price = entryPrice * (1 + tp2Pct / 100);
  const tp3Price = entryPrice * (1 + tp3Pct / 100);

  return {
    entryPrice,
    stopLoss1:    sl1Price,
    stopLoss2:    sl2Price,
    slPct1:       sl1Pct,
    slPct2:       sl2Pct,
    tp1:          tp1Price,
    tp2:          tp2Price,
    tp3:          tp3Price,
    tp1Pct,
    tp2Pct,
    tp3Pct,
    maxHoldHours,
    maxHoldLabel,
    stage,
    grade,
    risk,
    botId,
    // Risk/reward ratios
    rr1: parseFloat((tp1Pct / sl1Pct).toFixed(2)),
    rr2: parseFloat((tp2Pct / sl1Pct).toFixed(2)),
    rr3: parseFloat((tp3Pct / sl1Pct).toFixed(2)),
  };
}

/**
 * Format SL/TP as a compact string for DB storage / logging.
 */
export function formatSLTPCompact(sltp) {
  if (!sltp) return 'N/A';
  return `SL:-${sltp.slPct1}%/-${sltp.slPct2}% TP:+${sltp.tp1Pct}%/+${sltp.tp2Pct}%/+${sltp.tp3Pct}% Hold:${sltp.maxHoldLabel}`;
}
