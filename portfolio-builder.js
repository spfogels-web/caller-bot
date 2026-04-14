/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  modules/portfolio-builder.js — Portfolio Allocation & Analytics Engine
 *
 *  Responsibilities:
 *    - Build tiered wallet portfolio (Tier 1/2/3 allocation)
 *    - Compute portfolio-level stats (total PnL, open exposure, etc.)
 *    - Rebalance allocations based on updated trust scores
 *    - Smart-money discovery via Birdeye
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import { query, queryOne, queryAll, logEvent } from '../db/client.js';
import { syncWalletStatsFromBirdeye, computeTrustScore, upsertWallet } from './wallet-ranker.js';

// ─── Default Tier Allocations (USD per trade) ─────────────────────────────────

const TIER_DEFAULTS = {
  1: { allocationUsd: 200, label: 'Elite' },
  2: { allocationUsd: 100, label: 'Strong' },
  3: { allocationUsd: 50,  label: 'Emerging' },
};

// ─── Portfolio Stats ──────────────────────────────────────────────────────────

export async function getPortfolioStats() {
  const [overview, byWallet, byToken, openPositions] = await Promise.all([
    queryOne(`
      SELECT
        COUNT(*)                                           AS total_trades,
        COUNT(*) FILTER (WHERE status = 'OPEN')           AS open_trades,
        COUNT(*) FILTER (WHERE status = 'CLOSED')         AS closed_trades,
        COUNT(*) FILTER (WHERE pnl_usd > 0)               AS winning_trades,
        COUNT(*) FILTER (WHERE pnl_usd < 0)               AS losing_trades,
        SUM(pnl_usd) FILTER (WHERE status = 'CLOSED')     AS total_pnl_usd,
        SUM(entry_usd) FILTER (WHERE status = 'CLOSED')   AS total_invested_usd,
        AVG(roi_pct) FILTER (WHERE status = 'CLOSED')     AS avg_roi_pct,
        AVG(hold_time_sec) FILTER (WHERE status = 'CLOSED') AS avg_hold_sec,
        SUM(entry_usd) FILTER (WHERE status = 'OPEN')     AS open_exposure_usd,
        COUNT(*) FILTER (WHERE exit_reason = 'take_profit')   AS take_profit_exits,
        COUNT(*) FILTER (WHERE exit_reason = 'stop_loss')     AS stop_loss_exits,
        COUNT(*) FILTER (WHERE exit_reason = 'trailing_stop') AS trailing_exits,
        COUNT(*) FILTER (WHERE exit_reason = 'wallet_sold')   AS wallet_sold_exits
      FROM copied_trades
    `),

    queryAll(`
      SELECT
        ct.wallet_address,
        w.label AS wallet_label,
        w.trust_score,
        w.tier,
        COUNT(*) FILTER (WHERE ct.status = 'CLOSED')          AS trades,
        COUNT(*) FILTER (WHERE ct.pnl_usd > 0)                AS wins,
        SUM(ct.pnl_usd) FILTER (WHERE ct.status = 'CLOSED')   AS pnl_usd,
        AVG(ct.roi_pct) FILTER (WHERE ct.status = 'CLOSED')   AS avg_roi_pct,
        SUM(ct.entry_usd) FILTER (WHERE ct.status = 'CLOSED') AS total_invested
      FROM copied_trades ct
      LEFT JOIN wallets w ON w.address = ct.wallet_address
      WHERE ct.status IN ('CLOSED', 'OPEN')
      GROUP BY ct.wallet_address, w.label, w.trust_score, w.tier
      ORDER BY pnl_usd DESC NULLS LAST
      LIMIT 20
    `),

    queryAll(`
      SELECT
        token_address, token_symbol,
        COUNT(*)                                             AS trades,
        COUNT(*) FILTER (WHERE pnl_usd > 0)                 AS wins,
        SUM(pnl_usd) FILTER (WHERE status = 'CLOSED')       AS pnl_usd,
        AVG(roi_pct) FILTER (WHERE status = 'CLOSED')       AS avg_roi_pct,
        MIN(entry_price_usd)                                 AS min_entry,
        MAX(exit_price_usd)                                  AS max_exit
      FROM copied_trades
      WHERE status = 'CLOSED'
      GROUP BY token_address, token_symbol
      ORDER BY pnl_usd DESC NULLS LAST
      LIMIT 20
    `),

    queryAll(`
      SELECT pp.*, ct.entry_time, ct.take_profit_pct, ct.stop_loss_pct,
             ct.wallet_address, w.label AS wallet_label, w.tier
      FROM portfolio_positions pp
      JOIN copied_trades ct ON ct.id = pp.copied_trade_id
      LEFT JOIN wallets w ON w.address = pp.wallet_address
      ORDER BY pp.opened_at DESC
    `),
  ]);

  const closedTrades = Number(overview.closed_trades ?? 0);
  const wins         = Number(overview.winning_trades ?? 0);
  const winRate      = closedTrades > 0 ? ((wins / closedTrades) * 100).toFixed(1) : '0';

  return {
    overview: {
      ...overview,
      win_rate_pct: winRate,
      sniper_success_rate: closedTrades > 0
        ? ((wins / closedTrades) * 100).toFixed(1)
        : '0',
    },
    byWallet:      byWallet.map(enrichWalletRow),
    byToken,
    openPositions,
  };
}

function enrichWalletRow(row) {
  const trades = Number(row.trades ?? 0);
  const wins   = Number(row.wins ?? 0);
  return {
    ...row,
    win_rate: trades > 0 ? ((wins / trades) * 100).toFixed(1) : '0',
  };
}

// ─── Tier Allocation ──────────────────────────────────────────────────────────

/**
 * Rebuild portfolio: score all tracked wallets and update their tier
 * allocations based on trust score.
 */
export async function rebuildPortfolio(tierOverrides = {}) {
  const tiers = { ...TIER_DEFAULTS, ...tierOverrides };
  const wallets = await queryAll(
    `SELECT * FROM wallets WHERE is_active = TRUE AND total_trades >= 5`
  );

  let updated = 0;
  for (const wallet of wallets) {
    const { score, tier, isFollowable } = computeTrustScore(wallet);
    const alloc = tiers[tier]?.allocationUsd ?? 50;

    await query(
      `UPDATE wallets SET
         trust_score = $1, tier = $2, is_followable = $3,
         allocation_usd = CASE WHEN allocation_usd = 0 THEN $4 ELSE allocation_usd END,
         last_scored_at = NOW(), updated_at = NOW()
       WHERE id = $5`,
      [score, tier, isFollowable, alloc, wallet.id]
    );
    updated++;
  }

  console.log(`[portfolio] Rebuilt — ${updated} wallets scored`);
  await logEvent('INFO', 'PORTFOLIO_REBUILT', `${updated} wallets rescored`);
  return updated;
}

/**
 * Get ranked wallet portfolio for dashboard display.
 */
export async function getPortfolioWallets({ tier = null, followableOnly = false } = {}) {
  const conditions = ['w.is_active = TRUE'];
  const params = [];

  if (tier) { params.push(tier); conditions.push(`w.tier = $${params.length}`); }
  if (followableOnly) conditions.push('w.is_followable = TRUE');

  return queryAll(
    `SELECT
       w.*,
       COUNT(ct.id) FILTER (WHERE ct.status = 'CLOSED')             AS total_copied,
       COUNT(ct.id) FILTER (WHERE ct.pnl_usd > 0)                   AS copied_wins,
       SUM(ct.pnl_usd) FILTER (WHERE ct.status = 'CLOSED')          AS copied_pnl,
       COUNT(ct.id) FILTER (WHERE ct.status = 'OPEN')               AS open_positions
     FROM wallets w
     LEFT JOIN copied_trades ct ON ct.wallet_address = w.address
     WHERE ${conditions.join(' AND ')}
     GROUP BY w.id
     ORDER BY w.trust_score DESC, w.tier ASC, w.win_rate DESC
     ${params.length ? `LIMIT 100` : ''}`,
    params
  );
}

// ─── Smart Money Discovery via Birdeye ────────────────────────────────────────

export async function discoverSmartWallets(birdeyeKey, limit = 20) {
  if (!birdeyeKey) {
    console.warn('[portfolio] No BIRDEYE_API_KEY — skipping smart money discovery');
    return [];
  }

  try {
    const res = await fetch(
      `https://public-api.birdeye.so/v1/wallet/list_full_portfolio?limit=${limit}`,
      {
        headers: { 'X-API-KEY': birdeyeKey, 'x-chain': 'solana', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) {
      // Try alternative endpoint
      const res2 = await fetch(
        `https://public-api.birdeye.so/trader/gainers-losers?type=1W&sort_by=PnL&sort_type=desc&limit=${limit}`,
        {
          headers: { 'X-API-KEY': birdeyeKey, 'x-chain': 'solana' },
          signal: AbortSignal.timeout(15_000),
        }
      );
      if (!res2.ok) return [];
      const data2 = await res2.json();
      return processSmartMoneyList(data2?.data?.items ?? [], birdeyeKey);
    }
    const data = await res.json();
    return processSmartMoneyList(data?.data ?? [], birdeyeKey);
  } catch (err) {
    console.warn('[portfolio] Smart money discovery failed:', err.message);
    return [];
  }
}

async function processSmartMoneyList(wallets, birdeyeKey) {
  const discovered = [];
  for (const w of wallets.slice(0, 20)) {
    const address = w.wallet ?? w.address;
    if (!address) continue;

    try {
      const existing = await queryOne('SELECT id FROM wallets WHERE address = $1', [address]);
      if (existing) continue; // already tracked

      // Sync stats from Birdeye
      const stats = await syncWalletStatsFromBirdeye(address, birdeyeKey);
      if (!stats) continue;

      // Only add if meets minimum criteria
      if (Number(stats.total_trades ?? 0) < 10) continue;
      if (Number(stats.win_rate ?? 0) < 40) continue;

      await upsertWallet(address, {
        ...stats,
        source:      'birdeye_smart_money',
        is_active:   true,
        follow_mode: 'manual', // require manual approval
      });

      discovered.push(address);
      console.log(`[portfolio] Discovered smart wallet: ${address.slice(0,8)}`);
    } catch (err) {
      console.warn(`[portfolio] Failed to process wallet ${address.slice(0,8)}:`, err.message);
    }
  }

  await logEvent('INFO', 'SMART_MONEY_DISCOVERY', `Discovered ${discovered.length} new wallets`);
  return discovered;
}

// ─── Blacklist ────────────────────────────────────────────────────────────────

export async function blacklistWallet(address, reason, addedBy = 'system') {
  await query(
    `INSERT INTO wallet_blacklist (address, reason, added_by)
     VALUES ($1, $2, $3) ON CONFLICT (address) DO UPDATE SET reason = $2`,
    [address, reason, addedBy]
  );
  await query(
    `UPDATE wallets SET is_followable = FALSE, follow_mode = 'disabled', is_active = FALSE
     WHERE address = $1`,
    [address]
  );
}

export async function getBlacklists() {
  const [tokens, wallets] = await Promise.all([
    queryAll('SELECT * FROM token_blacklist ORDER BY created_at DESC'),
    queryAll('SELECT * FROM wallet_blacklist ORDER BY created_at DESC'),
  ]);
  return { tokens, wallets };
}
