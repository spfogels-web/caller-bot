/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  modules/wallet-ranker.js — Wallet Ranking & Trust Score Engine
 *
 *  Computes trust scores (0–100) based on:
 *    - Realized PnL, win rate, avg ROI
 *    - Average hold time (filters scalpers & bagholders)
 *    - Trade volume (filters low-sample wallets)
 *    - 7d/30d recency performance
 *    - Rug exposure rate penalty
 *
 *  Assigns tiers (1/2/3) and marks wallets as followable based on
 *  configurable thresholds.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import { query, queryOne, queryAll, logEvent } from '../db/client.js';

// ─── Scoring Weights ──────────────────────────────────────────────────────────

const WEIGHTS = {
  winRate:         0.30,   // most important signal
  avgRoi:          0.25,   // quality of wins matters more than size
  recentPerf:      0.20,   // 7d recency window
  consistency:     0.15,   // trade count & activity
  rugSafety:       0.10,   // rug exposure penalty
};

// ─── Default Thresholds ───────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = {
  minTrades:           10,
  minWinRate:          50,    // %
  minTrustScore:       55,
  tier1Score:          80,
  tier2Score:          65,
  maxRugExposureRate:  20,    // % — above this = hard penalty
  maxAvgHoldDays:      30,    // ignore ultra-long bagholders
  minAvgHoldMinutes:   2,     // ignore sub-2min scalpers
};

// ─── Score Calculation ────────────────────────────────────────────────────────

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

function scoreWinRate(winRate) {
  // 50% → 40pts, 60% → 60pts, 70% → 80pts, 80%+ → 100pts
  if (winRate >= 80)  return 100;
  if (winRate >= 70)  return 80 + (winRate - 70) * 2;
  if (winRate >= 60)  return 60 + (winRate - 60) * 2;
  if (winRate >= 50)  return 40 + (winRate - 50) * 2;
  if (winRate >= 40)  return 20 + (winRate - 40) * 2;
  return Math.max(0, winRate * 0.4);
}

function scoreAvgRoi(avgRoi) {
  // avgRoi is % per trade
  if (avgRoi >= 200) return 100;
  if (avgRoi >= 100) return 80 + (avgRoi - 100) / 5;
  if (avgRoi >= 50)  return 60 + (avgRoi - 50)  / 2.5;
  if (avgRoi >= 20)  return 40 + (avgRoi - 20)  / 1.5;
  if (avgRoi >= 0)   return avgRoi * 2;
  return Math.max(0, 50 + avgRoi);  // negative roi tanks score
}

function scoreRecentPerf(pnl7d, trades7d, winRate7d) {
  let score = 50;
  if (trades7d < 2) return 30; // not enough recent activity
  if (pnl7d > 5000) score += 30;
  else if (pnl7d > 1000) score += 20;
  else if (pnl7d > 0)    score += 10;
  else if (pnl7d < -2000) score -= 30;
  else if (pnl7d < 0)    score -= 15;

  if (winRate7d > 65) score += 20;
  else if (winRate7d > 50) score += 10;
  else if (winRate7d < 35) score -= 20;
  else if (winRate7d < 50) score -= 10;

  return clamp(score);
}

function scoreConsistency(totalTrades, trades30d, avgHoldSec) {
  let score = 0;
  // Trade volume
  if (totalTrades >= 200) score += 40;
  else if (totalTrades >= 50)  score += 30;
  else if (totalTrades >= 20)  score += 20;
  else if (totalTrades >= 10)  score += 10;
  else score -= 10;

  // Recency
  if (trades30d >= 20) score += 30;
  else if (trades30d >= 10) score += 20;
  else if (trades30d >= 5)  score += 10;
  else score -= 10;

  // Hold time quality (not a flipper, not a bagholder)
  const holdMin = avgHoldSec / 60;
  const holdDay = avgHoldSec / 86400;
  if (holdMin < 2)    score -= 20; // scalper
  else if (holdDay > 30) score -= 20; // bagholder
  else if (holdMin >= 30 && holdDay <= 7) score += 30; // sweet spot
  else score += 15;

  return clamp(score);
}

function scoreRugSafety(rugExposureRate, rugCount) {
  if (rugExposureRate === 0) return 100;
  if (rugExposureRate > 30 || rugCount > 5) return 0;
  if (rugExposureRate > 20) return 20;
  if (rugExposureRate > 10) return 50;
  if (rugExposureRate > 5)  return 70;
  return 85;
}

/**
 * Compute composite trust score for a wallet.
 * @param {object} wallet — row from wallets table
 * @returns {{ score: number, tier: number, isFollowable: boolean, breakdown: object }}
 */
export function computeTrustScore(wallet, thresholds = DEFAULT_THRESHOLDS) {
  const {
    win_rate = 0,
    avg_roi = 0,
    pnl_7d = 0,
    trades_7d = 0,
    win_rate_7d = 0,
    total_trades = 0,
    trades_30d = 0,
    avg_hold_time_sec = 0,
    rug_exposure_rate = 0,
    rug_exposure_count = 0,
  } = wallet;

  const breakdown = {
    winRate:    scoreWinRate(Number(win_rate)),
    avgRoi:     scoreAvgRoi(Number(avg_roi)),
    recentPerf: scoreRecentPerf(Number(pnl_7d), Number(trades_7d), Number(win_rate_7d)),
    consistency: scoreConsistency(Number(total_trades), Number(trades_30d), Number(avg_hold_time_sec)),
    rugSafety:  scoreRugSafety(Number(rug_exposure_rate), Number(rug_exposure_count)),
  };

  const composite = clamp(Math.round(
    breakdown.winRate    * WEIGHTS.winRate    +
    breakdown.avgRoi     * WEIGHTS.avgRoi     +
    breakdown.recentPerf * WEIGHTS.recentPerf +
    breakdown.consistency * WEIGHTS.consistency +
    breakdown.rugSafety  * WEIGHTS.rugSafety
  ));

  // Hard disqualifiers
  let adjustedScore = composite;
  if (Number(total_trades) < thresholds.minTrades) adjustedScore = Math.min(adjustedScore, 30);
  if (Number(rug_exposure_rate) > thresholds.maxRugExposureRate) adjustedScore = Math.min(adjustedScore, 40);

  const tier = adjustedScore >= thresholds.tier1Score ? 1
    : adjustedScore >= thresholds.tier2Score ? 2
    : 3;

  const isFollowable =
    adjustedScore >= thresholds.minTrustScore &&
    Number(total_trades) >= thresholds.minTrades &&
    Number(win_rate) >= thresholds.minWinRate &&
    Number(rug_exposure_rate) <= thresholds.maxRugExposureRate;

  return { score: adjustedScore, tier, isFollowable, breakdown };
}

// ─── DB Helpers ───────────────────────────────────────────────────────────────

export async function upsertWallet(address, data = {}) {
  const existing = await queryOne('SELECT id FROM wallets WHERE address = $1', [address]);
  if (existing) {
    const sets = Object.entries(data)
      .map(([k, v], i) => `${k} = $${i + 2}`)
      .join(', ');
    if (!sets) return existing;
    await query(
      `UPDATE wallets SET ${sets}, updated_at = NOW() WHERE address = $1`,
      [address, ...Object.values(data)]
    );
    return existing;
  } else {
    const cols = ['address', ...Object.keys(data)].join(', ');
    const vals = Object.values(data);
    const placeholders = vals.map((_, i) => `$${i + 2}`).join(', ');
    const result = await query(
      `INSERT INTO wallets (${cols}) VALUES ($1, ${placeholders}) RETURNING id`,
      [address, ...vals]
    );
    return result.rows[0];
  }
}

/**
 * Re-score a single wallet and persist result.
 */
export async function rescoreWallet(walletId) {
  const wallet = await queryOne('SELECT * FROM wallets WHERE id = $1', [walletId]);
  if (!wallet) return null;

  const { score, tier, isFollowable, breakdown } = computeTrustScore(wallet);

  await query(
    `UPDATE wallets SET
       trust_score = $1, tier = $2, is_followable = $3,
       last_scored_at = NOW(), updated_at = NOW()
     WHERE id = $4`,
    [score, tier, isFollowable, walletId]
  );

  await logEvent('INFO', 'WALLET_SCORED', `${wallet.address} score=${score} tier=${tier}`, {
    address: wallet.address, score, tier, isFollowable, breakdown,
  });

  return { score, tier, isFollowable, breakdown };
}

/**
 * Re-score ALL wallets in the database.
 */
export async function rescoreAllWallets() {
  const wallets = await queryAll('SELECT id FROM wallets WHERE is_active = TRUE');
  let updated = 0;
  for (const w of wallets) {
    try {
      await rescoreWallet(w.id);
      updated++;
    } catch (err) {
      console.warn(`[ranker] Failed to score wallet ${w.id}:`, err.message);
    }
  }
  console.log(`[ranker] Rescored ${updated}/${wallets.length} wallets`);
  return updated;
}

/**
 * Get ranked wallet list with pagination.
 */
export async function getRankedWallets({ limit = 50, offset = 0, tier = null, followableOnly = false } = {}) {
  const conditions = ['w.is_active = TRUE'];
  const params = [];

  if (tier) {
    params.push(tier);
    conditions.push(`w.tier = $${params.length}`);
  }
  if (followableOnly) {
    conditions.push('w.is_followable = TRUE');
  }

  params.push(limit, offset);
  const where = conditions.join(' AND ');

  return queryAll(
    `SELECT w.*,
       COUNT(ct.id) FILTER (WHERE ct.status = 'CLOSED') AS copied_closed,
       SUM(ct.pnl_usd) FILTER (WHERE ct.status = 'CLOSED') AS copied_pnl_usd
     FROM wallets w
     LEFT JOIN copied_trades ct ON ct.wallet_id = w.id
     WHERE ${where}
     GROUP BY w.id
     ORDER BY w.trust_score DESC, w.win_rate DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
}

/**
 * Pull wallet performance from Birdeye and update DB stats.
 */
export async function syncWalletStatsFromBirdeye(walletAddress, birdeyeApiKey) {
  if (!birdeyeApiKey) {
    console.warn('[ranker] No BIRDEYE_API_KEY — skipping stats sync');
    return null;
  }

  try {
    // Birdeye wallet PnL endpoint
    const headers = {
      'X-API-KEY':  birdeyeApiKey,
      'x-chain':    'solana',
      'Accept':     'application/json',
    };

    const [pnlRes, txRes] = await Promise.all([
      fetch(
        `https://public-api.birdeye.so/v1/wallet/token_list?wallet=${walletAddress}`,
        { headers, signal: AbortSignal.timeout(12_000) }
      ),
      fetch(
        `https://public-api.birdeye.so/v1/wallet/tx_list?wallet=${walletAddress}&limit=100`,
        { headers, signal: AbortSignal.timeout(12_000) }
      ),
    ]);

    const pnlData = pnlRes.ok ? await pnlRes.json() : null;
    const txData  = txRes.ok  ? await txRes.json()  : null;

    const stats = {};

    if (pnlData?.data) {
      stats.realized_pnl_usd   = pnlData.data.realizedPnl ?? 0;
      stats.unrealized_pnl_usd = pnlData.data.unrealizedPnl ?? 0;
    }

    if (txData?.data?.items) {
      const txs = txData.data.items;
      const sells = txs.filter(t => t.side === 'sell' || t.type === 'SELL');
      const wins  = sells.filter(t => (t.pnl ?? 0) > 0);
      stats.total_trades   = sells.length;
      stats.winning_trades = wins.length;
      stats.losing_trades  = sells.length - wins.length;
      stats.win_rate       = sells.length > 0
        ? parseFloat(((wins.length / sells.length) * 100).toFixed(2))
        : 0;
      stats.avg_roi = sells.length > 0
        ? parseFloat((sells.reduce((s, t) => s + (t.roi ?? 0), 0) / sells.length).toFixed(4))
        : 0;
      stats.last_active_at = txs[0]?.blockTime
        ? new Date(txs[0].blockTime * 1000).toISOString()
        : null;
    }

    if (Object.keys(stats).length > 0) {
      stats.stats_updated_at = new Date().toISOString();
      await upsertWallet(walletAddress, stats);
    }

    return stats;
  } catch (err) {
    console.warn(`[ranker] Birdeye sync failed for ${walletAddress}:`, err.message);
    return null;
  }
}
