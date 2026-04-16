/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  wallet-tracker-server.js — Express API + Pipeline Orchestrator
 *
 *  Endpoints:
 *    POST /webhook/helius         — Helius real-time events
 *    GET  /api/wt/wallets         — Ranked wallet list
 *    GET  /api/wt/portfolio       — Portfolio stats
 *    GET  /api/wt/positions       — Open positions
 *    GET  /api/wt/trades          — Trade history
 *    GET  /api/wt/blacklists      — Blacklist data
 *    GET  /api/wt/settings        — Sniper settings
 *    POST /api/wt/wallets         — Add wallet
 *    POST /api/wt/wallets/:addr/approve  — Approve for auto-follow
 *    POST /api/wt/wallets/:addr/disable  — Disable wallet
 *    POST /api/wt/tokens/blacklist       — Blacklist token
 *    PUT  /api/wt/settings        — Update sniper settings
 *    POST /api/wt/discover        — Run smart money discovery
 *    POST /api/wt/portfolio/rebuild      — Rebuild portfolio allocations
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import express          from 'express';
import { query, queryOne, queryAll, logEvent } from './db/client.js';
import { tracker, EVENTS }    from './modules/wallet-tracker.js';
import { SniperEngine }        from './modules/sniper-engine.js';
import { blacklistToken, unblacklistToken } from './modules/token-risk-filter.js';
import {
  getRankedWallets, rescoreAllWallets,
  syncWalletStatsFromBirdeye, upsertWallet,
} from './modules/wallet-ranker.js';
import {
  getPortfolioStats, getPortfolioWallets,
  rebuildPortfolio, discoverSmartWallets,
  blacklistWallet, getBlacklists,
} from './modules/portfolio-builder.js';

const app     = express();
const PORT    = process.env.WALLET_TRACKER_PORT ?? 3100;
const BIRDEYE = process.env.BIRDEYE_API_KEY ?? '';

app.use(express.json({ limit: '10mb' }));

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Sniper Engine Instance ───────────────────────────────────────────────────
const sniper = new SniperEngine(tracker);

// ─── Startup ──────────────────────────────────────────────────────────────────
async function startup() {
  console.log('[wt-server] Starting wallet tracking system...');

  await tracker.init();
  await sniper.init();

  // Rescore wallets every hour
  setInterval(rescoreAllWallets, 60 * 60 * 1000);

  // Sync Birdeye stats every 4 hours
  setInterval(async () => {
    const wallets = await queryAll('SELECT address FROM wallets WHERE is_active = TRUE');
    for (const w of wallets) {
      await syncWalletStatsFromBirdeye(w.address, BIRDEYE).catch(() => {});
      await new Promise(r => setTimeout(r, 2000)); // rate limit
    }
  }, 4 * 60 * 60 * 1000);

  // Position cleanup: remove stale dry-run positions
  setInterval(async () => {
    await query(
      `DELETE FROM portfolio_positions WHERE last_updated_at < NOW() - INTERVAL '24 hours'`
    ).catch(() => {});
  }, 30 * 60 * 1000);

  console.log('[wt-server] ✅ Ready');
}

// ─── Helius Webhook ───────────────────────────────────────────────────────────

app.post('/webhook/helius', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately
  try {
    await tracker.processWebhookPayload(req.body);
  } catch (err) {
    console.error('[webhook] Error:', err.message);
  }
});

// ─── Wallets API ──────────────────────────────────────────────────────────────

app.get('/api/wt/wallets', async (req, res) => {
  try {
    const { tier, followable, limit = 50, offset = 0 } = req.query;
    const wallets = await getPortfolioWallets({
      tier:          tier ? Number(tier) : null,
      followableOnly: followable === 'true',
    });
    res.json({ ok: true, wallets, total: wallets.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/wt/wallets', async (req, res) => {
  try {
    const { address, label, followMode = 'manual', allocationUsd } = req.body;
    if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      return res.status(400).json({ ok: false, error: 'Invalid Solana address' });
    }

    await upsertWallet(address, {
      label:         label ?? null,
      follow_mode:   followMode,
      is_active:     true,
      allocation_usd: allocationUsd ?? 50,
      source:        'manual',
    });

    // Kick off stats sync in background
    syncWalletStatsFromBirdeye(address, BIRDEYE).catch(() => {});

    await tracker.addWallet(address);
    await logEvent('INFO', 'WALLET_ADDED', `Added ${address} label=${label}`);
    res.json({ ok: true, address });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/wt/wallets/:address/approve', async (req, res) => {
  try {
    const { address } = req.params;
    const { allocationUsd } = req.body ?? {};
    await query(
      `UPDATE wallets SET follow_mode = 'auto', is_followable = TRUE,
         allocation_usd = COALESCE($2, allocation_usd), updated_at = NOW()
       WHERE address = $1`,
      [address, allocationUsd ?? null]
    );
    await tracker.addWallet(address);
    await logEvent('INFO', 'WALLET_APPROVED', `Auto-follow approved: ${address}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/wt/wallets/:address/disable', async (req, res) => {
  try {
    const { address } = req.params;
    const { reason } = req.body ?? {};
    await query(
      `UPDATE wallets SET follow_mode = 'disabled', is_followable = FALSE,
         updated_at = NOW()
       WHERE address = $1`,
      [address]
    );
    await tracker.removeWallet(address);
    if (req.body?.blacklist) await blacklistWallet(address, reason ?? 'user disabled');
    await logEvent('INFO', 'WALLET_DISABLED', `${address} disabled`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/wt/wallets/:address/sync', async (req, res) => {
  try {
    const stats = await syncWalletStatsFromBirdeye(req.params.address, BIRDEYE);
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Portfolio API ────────────────────────────────────────────────────────────

app.get('/api/wt/portfolio', async (req, res) => {
  try {
    const stats = await getPortfolioStats();
    res.json({ ok: true, ...stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/wt/portfolio/rebuild', async (req, res) => {
  try {
    const { tier1, tier2, tier3 } = req.body ?? {};
    const tierOverrides = {};
    if (tier1) tierOverrides[1] = { allocationUsd: Number(tier1) };
    if (tier2) tierOverrides[2] = { allocationUsd: Number(tier2) };
    if (tier3) tierOverrides[3] = { allocationUsd: Number(tier3) };
    const count = await rebuildPortfolio(tierOverrides);
    res.json({ ok: true, walletsUpdated: count });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Trades API ───────────────────────────────────────────────────────────────

app.get('/api/wt/trades', async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Number(limit), Number(offset));

    const [trades, total] = await Promise.all([
      queryAll(
        `SELECT ct.*, w.label AS wallet_label, w.tier, w.trust_score
         FROM copied_trades ct
         LEFT JOIN wallets w ON w.address = ct.wallet_address
         ${where}
         ORDER BY ct.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      queryOne(
        `SELECT COUNT(*) AS cnt FROM copied_trades ${where}`,
        params.slice(0, -2)
      ),
    ]);

    res.json({ ok: true, trades, total: Number(total?.cnt ?? 0) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/wt/trades/:id/approve', async (req, res) => {
  try {
    // Manually approve a pending trade
    const trade = await queryOne('SELECT * FROM copied_trades WHERE id = $1', [req.params.id]);
    if (!trade || trade.status !== 'PENDING_APPROVAL') {
      return res.status(404).json({ ok: false, error: 'Trade not found or not pending' });
    }
    // Fire the sniper manually
    const wallet = await queryOne('SELECT * FROM wallets WHERE address = $1', [trade.wallet_address]);
    if (!wallet) return res.status(404).json({ ok: false, error: 'Wallet not found' });
    await query('DELETE FROM copied_trades WHERE id = $1', [req.params.id]);
    // Emit synthetic buy event
    tracker.emit(EVENTS.WALLET_BUY, {
      walletAddress:  trade.wallet_address,
      tokenAddress:   trade.token_address,
      tokenSymbol:    trade.token_symbol,
      signature:      trade.trigger_tx_sig,
      blockTime:      new Date(),
      solAmount:      0,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Settings API ─────────────────────────────────────────────────────────────

app.get('/api/wt/settings', async (req, res) => {
  try {
    const settings = await queryOne(
      'SELECT * FROM sniper_settings WHERE is_global_default = TRUE LIMIT 1'
    );
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/wt/settings', async (req, res) => {
  try {
    const allowed = [
      'allocation_usd','max_position_usd','slippage_bps','priority_fee_lamports',
      'take_profit_pct','stop_loss_pct','trailing_stop_pct','max_hold_sec',
      'min_liquidity_usd','min_market_cap_usd','max_market_cap_usd',
      'min_volume_24h_usd','max_top10_holder_pct','max_dev_wallet_pct',
      'require_lp_locked','require_mint_revoked','block_bundle_risk',
      'max_price_impact_pct','min_trust_score','min_wallet_trades',
      'min_win_rate','max_open_positions','max_portfolio_usd',
      'max_per_token_usd','cooldown_sec','max_daily_loss_usd','max_extension_pct',
    ];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ ok: false, error: 'No valid fields provided' });
    }
    const sets = Object.keys(updates).map((k, i) => `${k} = $${i + 1}`).join(', ');
    await query(
      `UPDATE sniper_settings SET ${sets}, updated_at = NOW() WHERE is_global_default = TRUE`,
      Object.values(updates)
    );
    await sniper.reloadSettings();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Blacklist API ────────────────────────────────────────────────────────────

app.get('/api/wt/blacklists', async (req, res) => {
  try {
    res.json({ ok: true, ...(await getBlacklists()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/wt/tokens/blacklist', async (req, res) => {
  try {
    const { address, reason } = req.body;
    await blacklistToken(address, reason, 'user');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/wt/tokens/blacklist/:address', async (req, res) => {
  try {
    await unblacklistToken(req.params.address);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Discovery ────────────────────────────────────────────────────────────────

app.post('/api/wt/discover', async (req, res) => {
  try {
    const discovered = await discoverSmartWallets(BIRDEYE, req.body?.limit ?? 20);
    res.json({ ok: true, discovered: discovered.length, addresses: discovered });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── System ───────────────────────────────────────────────────────────────────

app.get('/api/wt/status', (req, res) => {
  res.json({
    ok:              true,
    trackedWallets:  tracker.getTrackedCount(),
    dryRun:          sniper.dryRun,
    sniperActive:    true,
  });
});

app.get('/api/wt/log', async (req, res) => {
  try {
    const rows = await queryAll(
      `SELECT * FROM tracker_events ORDER BY created_at DESC LIMIT $1`,
      [Number(req.query.limit ?? 100)]
    );
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`[wt-server] Listening on port ${PORT}`);
  await startup();
});

export default app;
