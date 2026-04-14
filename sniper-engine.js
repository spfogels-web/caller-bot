/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  modules/sniper-engine.js — Sniper Execution Engine
 *
 *  Pipeline:
 *    wallet:buy event → trust gate → risk filter → portfolio gate
 *    → submit buy → track position → monitor exits (TP/SL/trailing/timer)
 *
 *  Uses Jupiter v6 aggregator for swaps.
 *  All state is persisted to Postgres.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import { query, queryOne, queryAll, logEvent } from '../db/client.js';
import { checkTokenRisk } from './token-risk-filter.js';
import { EVENTS } from './wallet-tracker.js';

const JUPITER_API    = 'https://quote-api.jup.ag/v6';
const WSOL_MINT      = 'So11111111111111111111111111111111111111112';
const SOL_DECIMALS   = 9;

// ─── SniperEngine ─────────────────────────────────────────────────────────────

export class SniperEngine {
  constructor(tracker) {
    this.tracker        = tracker;
    this.birdeyeKey     = process.env.BIRDEYE_API_KEY ?? '';
    this.walletPrivKey  = process.env.SNIPER_WALLET_PRIVATE_KEY ?? null;
    this.dryRun         = process.env.SNIPER_DRY_RUN !== 'false'; // default: dry run
    this.settings       = null;
    this.lastBuyTimes   = new Map();  // cooldown tracking: walletAddress → timestamp
    this.dailyLossUsd   = 0;
    this.dailyLossDate  = null;

    this._positionMonitorInterval = null;
  }

  async init() {
    this.settings = await queryOne(
      'SELECT * FROM sniper_settings WHERE is_global_default = TRUE LIMIT 1'
    );

    if (!this.settings) {
      console.warn('[sniper] No default settings found — using hardcoded defaults');
      this.settings = { min_trust_score: 60, allocation_usd: 50 };
    }

    // Listen for wallet buy events
    this.tracker.on(EVENTS.WALLET_BUY, (event) => this._onWalletBuy(event));
    this.tracker.on(EVENTS.WALLET_SELL, (event) => this._onWalletSell(event));

    // Start position monitor (check exits every 30 seconds)
    this._positionMonitorInterval = setInterval(
      () => this._monitorOpenPositions(),
      30_000
    );

    console.log(`[sniper] Initialized — dry_run=${this.dryRun}`);
    await logEvent('INFO', 'SNIPER_INIT', `dry_run=${this.dryRun}`);
  }

  async reloadSettings() {
    this.settings = await queryOne(
      'SELECT * FROM sniper_settings WHERE is_global_default = TRUE LIMIT 1'
    );
  }

  // ─── Wallet Buy Handler ────────────────────────────────────────────────────

  async _onWalletBuy(event) {
    const { walletAddress, tokenAddress, tokenSymbol, solAmount, blockTime } = event;
    const tag = `[sniper:${tokenSymbol ?? tokenAddress.slice(0,8)}]`;

    try {
      await this.reloadSettings();
      const s = this.settings;

      // ── 1. Wallet trust gate ──────────────────────────────────────────────
      const wallet = await queryOne(
        'SELECT * FROM wallets WHERE address = $1',
        [walletAddress]
      );
      if (!wallet) {
        console.log(`${tag} Skip: wallet not in DB`);
        return;
      }
      if (wallet.follow_mode === 'disabled') {
        console.log(`${tag} Skip: follow_mode=disabled`);
        return;
      }
      if (Number(wallet.trust_score) < Number(s.min_trust_score)) {
        await this._skipLog(walletAddress, tokenAddress, tokenSymbol,
          `Trust score ${wallet.trust_score} < ${s.min_trust_score}`);
        return;
      }

      // ── 2. Manual approval gate ───────────────────────────────────────────
      if (wallet.follow_mode === 'manual') {
        console.log(`${tag} Skip: wallet in manual mode — needs approval`);
        await this._queueForManualApproval(walletAddress, tokenAddress, event);
        return;
      }

      // ── 3. Cooldown check ─────────────────────────────────────────────────
      const lastBuy = this.lastBuyTimes.get(walletAddress) ?? 0;
      if (Date.now() - lastBuy < Number(s.cooldown_sec) * 1000) {
        await this._skipLog(walletAddress, tokenAddress, tokenSymbol,
          `Cooldown active — last buy ${Math.round((Date.now() - lastBuy)/1000)}s ago`);
        return;
      }

      // ── 4. Daily loss limit ───────────────────────────────────────────────
      const today = new Date().toDateString();
      if (this.dailyLossDate !== today) {
        this.dailyLossUsd = 0;
        this.dailyLossDate = today;
      }
      if (this.dailyLossUsd > Number(s.max_daily_loss_usd)) {
        await this._skipLog(walletAddress, tokenAddress, tokenSymbol,
          `Daily loss limit $${s.max_daily_loss_usd} hit`);
        return;
      }

      // ── 5. Portfolio gates ────────────────────────────────────────────────
      const openPositions = await queryOne(
        `SELECT COUNT(*) AS cnt, SUM(cost_basis_usd) AS total_usd
         FROM portfolio_positions WHERE wallet_address != '' `,
        []
      );
      const posCount = Number(openPositions?.cnt ?? 0);
      const posTotal = Number(openPositions?.total_usd ?? 0);

      if (posCount >= Number(s.max_open_positions)) {
        await this._skipLog(walletAddress, tokenAddress, tokenSymbol,
          `Max open positions (${s.max_open_positions}) reached`);
        return;
      }
      if (posTotal >= Number(s.max_portfolio_usd)) {
        await this._skipLog(walletAddress, tokenAddress, tokenSymbol,
          `Max portfolio size $${s.max_portfolio_usd} reached`);
        return;
      }

      // Already have this token open?
      const existing = await queryOne(
        `SELECT id FROM portfolio_positions WHERE token_address = $1`,
        [tokenAddress]
      );
      if (existing) {
        await this._skipLog(walletAddress, tokenAddress, tokenSymbol,
          'Token already in open positions');
        return;
      }

      // ── 6. Token risk filter ──────────────────────────────────────────────
      const riskCheck = await checkTokenRisk(tokenAddress, s, this.birdeyeKey);
      if (!riskCheck.pass) {
        await this._skipLog(walletAddress, tokenAddress, tokenSymbol,
          `Risk filter: ${riskCheck.reason}`);
        return;
      }

      // ── 7. Extension check: token already up too much from wallet's entry ──
      const walletEntryPrice = event.priceUsd ?? null;
      const currentPrice     = riskCheck.data?.price_usd ?? null;
      if (walletEntryPrice && currentPrice) {
        const extensionPct = ((currentPrice - walletEntryPrice) / walletEntryPrice) * 100;
        if (extensionPct > Number(s.max_extension_pct)) {
          await this._skipLog(walletAddress, tokenAddress, tokenSymbol,
            `Token extended ${extensionPct.toFixed(1)}% from wallet's entry`);
          return;
        }
      }

      // ── 8. Execute ────────────────────────────────────────────────────────
      console.log(`${tag} ✅ All gates passed — executing copy trade`);
      this.lastBuyTimes.set(walletAddress, Date.now());

      await this._executeBuy(wallet, event, riskCheck, s);

    } catch (err) {
      console.error(`${tag} Error:`, err.message);
      await logEvent('ERROR', 'SNIPER_BUY_ERROR', err.message, { walletAddress, tokenAddress });
    }
  }

  // ─── Execute Buy ───────────────────────────────────────────────────────────

  async _executeBuy(wallet, event, riskCheck, settings) {
    const { walletAddress, tokenAddress, tokenSymbol, signature: triggerSig, blockTime } = event;
    const allocationUsd = Math.min(
      Number(wallet.allocation_usd > 0 ? wallet.allocation_usd : settings.allocation_usd),
      Number(settings.max_per_token_usd)
    );

    const currentPriceUsd = riskCheck.data?.price_usd ?? 0;
    const solPriceUsd     = await this._getSolPrice();
    const solAmount       = solPriceUsd > 0 ? allocationUsd / solPriceUsd : 0;

    let txSig = null;
    let actualPriceUsd = currentPriceUsd;
    let entryUsd = allocationUsd;

    if (this.dryRun) {
      console.log(`[sniper] DRY RUN — would buy $${allocationUsd.toFixed(2)} of ${tokenSymbol ?? tokenAddress.slice(0,8)}`);
      txSig = `DRY_RUN_${Date.now()}`;
    } else {
      // Real execution via Jupiter
      const swapResult = await this._jupiterSwap(
        WSOL_MINT,
        tokenAddress,
        Math.round(solAmount * 1e9), // lamports
        Number(settings.slippage_bps)
      );
      if (!swapResult.success) {
        await logEvent('ERROR', 'SNIPER_SWAP_FAIL', swapResult.error, { tokenAddress });
        return;
      }
      txSig = swapResult.signature;
      actualPriceUsd = swapResult.outputPriceUsd ?? currentPriceUsd;
      entryUsd = swapResult.inputUsd ?? allocationUsd;
    }

    // ── Persist to copied_trades ───────────────────────────────────────────
    const trade = await query(
      `INSERT INTO copied_trades
         (wallet_id, wallet_address, trigger_tx_sig, token_address, token_symbol,
          entry_price_usd, entry_sol, entry_usd, entry_time, entry_tx_sig,
          entry_market_cap, entry_liquidity, take_profit_pct, stop_loss_pct,
          trailing_stop_pct, max_hold_sec, slippage_bps, status, wallet_trust_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'OPEN',$18)
       RETURNING id`,
      [
        wallet.id, walletAddress, triggerSig, tokenAddress, tokenSymbol,
        actualPriceUsd, solAmount, entryUsd, blockTime ?? new Date(), txSig,
        riskCheck.data?.market_cap_usd ?? null, riskCheck.data?.liquidity_usd ?? null,
        settings.take_profit_pct, settings.stop_loss_pct,
        settings.trailing_stop_pct, settings.max_hold_sec, settings.slippage_bps,
        wallet.trust_score,
      ]
    );
    const tradeId = trade.rows[0].id;

    // ── Open portfolio position ────────────────────────────────────────────
    await query(
      `INSERT INTO portfolio_positions
         (copied_trade_id, wallet_address, token_address, token_symbol,
          entry_price_usd, current_price_usd, quantity_tokens,
          cost_basis_usd, current_value_usd, peak_price_usd)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$7,$5)`,
      [
        tradeId, walletAddress, tokenAddress, tokenSymbol,
        actualPriceUsd,
        entryUsd > 0 && actualPriceUsd > 0 ? entryUsd / actualPriceUsd : 0,
        entryUsd,
      ]
    );

    console.log(`[sniper] ✅ Trade opened — ${tokenSymbol} @ $${actualPriceUsd} tx=${txSig?.slice(0,16)}`);
    await logEvent('INFO', 'TRADE_OPENED', `${tokenSymbol} @ $${actualPriceUsd}`, {
      tradeId, walletAddress, tokenAddress, entryUsd, actualPriceUsd,
    });
  }

  // ─── Position Monitor ──────────────────────────────────────────────────────

  async _monitorOpenPositions() {
    const positions = await queryAll(
      `SELECT pp.*, ct.take_profit_pct, ct.stop_loss_pct, ct.trailing_stop_pct,
              ct.max_hold_sec, ct.entry_time, ct.id AS trade_id, ct.wallet_address
       FROM portfolio_positions pp
       JOIN copied_trades ct ON ct.id = pp.copied_trade_id
       WHERE ct.status = 'OPEN'`
    );

    for (const pos of positions) {
      try {
        const currentPrice = await this._getTokenPrice(pos.token_address);
        if (!currentPrice) continue;

        const entryPrice    = Number(pos.entry_price_usd);
        const peakPrice     = Number(pos.peak_price_usd);
        const newPeak       = Math.max(peakPrice, currentPrice);
        const roi           = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;
        const drawFromPeak  = newPeak > 0 ? ((newPeak - currentPrice) / newPeak) * 100 : 0;
        const holdSec       = (Date.now() - new Date(pos.entry_time).getTime()) / 1000;

        // Update position
        const currentValue = Number(pos.quantity_tokens) * currentPrice;
        await query(
          `UPDATE portfolio_positions SET
             current_price_usd = $1, current_value_usd = $2,
             unrealized_pnl_usd = $3, unrealized_roi_pct = $4,
             peak_price_usd = $5, last_updated_at = NOW()
           WHERE id = $6`,
          [currentPrice, currentValue, currentValue - Number(pos.cost_basis_usd), roi, newPeak, pos.id]
        );

        // ── Exit conditions ────────────────────────────────────────────────
        let exitReason = null;

        if (roi >= Number(pos.take_profit_pct)) {
          exitReason = 'take_profit';
        } else if (roi <= -Math.abs(Number(pos.stop_loss_pct))) {
          exitReason = 'stop_loss';
        } else if (drawFromPeak >= Number(pos.trailing_stop_pct)) {
          exitReason = 'trailing_stop';
        } else if (holdSec >= Number(pos.max_hold_sec)) {
          exitReason = 'max_hold_timer';
        }

        if (exitReason) {
          await this._executeExit(pos, currentPrice, exitReason);
        }
      } catch (err) {
        console.warn('[sniper] Position monitor error:', err.message);
      }
    }
  }

  async _executeExit(pos, currentPrice, exitReason) {
    const pnlUsd    = (currentPrice - Number(pos.entry_price_usd)) * Number(pos.quantity_tokens);
    const roiPct    = Number(pos.entry_price_usd) > 0
      ? ((currentPrice - Number(pos.entry_price_usd)) / Number(pos.entry_price_usd)) * 100
      : 0;
    const holdSec   = Math.round((Date.now() - new Date(pos.entry_time ?? pos.opened_at).getTime()) / 1000);

    let exitSig = null;
    if (!this.dryRun) {
      // Execute sell via Jupiter
      const swapResult = await this._jupiterSwap(
        pos.token_address, WSOL_MINT,
        Math.round(Number(pos.quantity_tokens) * 1e9),
        300
      );
      exitSig = swapResult.success ? swapResult.signature : null;
    } else {
      exitSig = `DRY_RUN_EXIT_${Date.now()}`;
    }

    // Close position
    await query('DELETE FROM portfolio_positions WHERE id = $1', [pos.id]);

    // Update copied_trade
    await query(
      `UPDATE copied_trades SET
         status = 'CLOSED', exit_price_usd = $1, exit_usd = $2,
         exit_time = NOW(), exit_tx_sig = $3, exit_reason = $4,
         pnl_usd = $5, roi_pct = $6, hold_time_sec = $7, updated_at = NOW()
       WHERE id = $8`,
      [currentPrice, Number(pos.quantity_tokens) * currentPrice, exitSig,
       exitReason, pnlUsd, roiPct, holdSec, pos.trade_id]
    );

    // Track daily loss
    if (pnlUsd < 0) this.dailyLossUsd += Math.abs(pnlUsd);

    console.log(`[sniper] ❎ Exit ${pos.token_symbol} — ${exitReason} pnl=${pnlUsd.toFixed(2)} roi=${roiPct.toFixed(1)}%`);
    await logEvent('INFO', 'TRADE_CLOSED', `${pos.token_symbol} ${exitReason} pnl=$${pnlUsd.toFixed(2)}`, {
      tokenAddress: pos.token_address, exitReason, pnlUsd, roiPct, holdSec,
    });
  }

  // ─── Wallet Sell Handler ───────────────────────────────────────────────────

  async _onWalletSell(event) {
    const { walletAddress, tokenAddress } = event;
    // If we have an open position on this token triggered by this wallet,
    // optionally exit early (follow-sell mode)
    const pos = await queryOne(
      `SELECT pp.*, ct.id AS trade_id, ct.token_symbol
       FROM portfolio_positions pp
       JOIN copied_trades ct ON ct.id = pp.copied_trade_id
       WHERE pp.token_address = $1 AND pp.wallet_address = $2 AND ct.status = 'OPEN'`,
      [tokenAddress, walletAddress]
    );
    if (!pos) return;

    const currentPrice = await this._getTokenPrice(tokenAddress);
    if (currentPrice) {
      await this._executeExit(pos, currentPrice, 'wallet_sold');
    }
  }

  // ─── Jupiter Swap ──────────────────────────────────────────────────────────

  async _jupiterSwap(inputMint, outputMint, amountLamports, slippageBps) {
    try {
      // Get quote
      const quoteRes = await fetch(
        `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (!quoteRes.ok) return { success: false, error: `Quote failed: ${quoteRes.status}` };
      const quote = await quoteRes.json();

      if (!this.walletPrivKey) {
        return { success: false, error: 'No SNIPER_WALLET_PRIVATE_KEY set' };
      }

      // Get swap transaction
      const swapRes = await fetch(`${JUPITER_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse:        quote,
          userPublicKey:        process.env.SNIPER_WALLET_PUBLIC_KEY,
          wrapAndUnwrapSol:     true,
          prioritizationFeeLamports: Number(this.settings?.priority_fee_lamports ?? 100000),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!swapRes.ok) return { success: false, error: `Swap failed: ${swapRes.status}` };
      const swapData = await swapRes.json();

      // NOTE: In production, sign and send swapData.swapTransaction with the wallet keypair.
      // This requires @solana/web3.js. We return the unsigned tx here for the caller to sign.
      return {
        success:           true,
        signature:         `PENDING_${Date.now()}`, // Replace with actual confirmed sig
        unsignedTx:        swapData.swapTransaction,
        outputPriceUsd:    null, // Fetch separately after confirmation
        inputUsd:          null,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async _getTokenPrice(tokenAddress) {
    if (!this.birdeyeKey) return null;
    try {
      const res = await fetch(
        `https://public-api.birdeye.so/defi/price?address=${tokenAddress}`,
        {
          headers: { 'X-API-KEY': this.birdeyeKey, 'x-chain': 'solana' },
          signal: AbortSignal.timeout(8_000),
        }
      );
      const data = await res.json();
      return data?.data?.value ?? null;
    } catch { return null; }
  }

  async _getSolPrice() {
    try {
      const res = await fetch(
        `https://public-api.birdeye.so/defi/price?address=${WSOL_MINT}`,
        { headers: { 'X-API-KEY': this.birdeyeKey, 'x-chain': 'solana' }, signal: AbortSignal.timeout(8_000) }
      );
      const data = await res.json();
      return data?.data?.value ?? 150;
    } catch { return 150; }
  }

  async _skipLog(walletAddress, tokenAddress, symbol, reason) {
    console.log(`[sniper] Skip ${symbol ?? tokenAddress.slice(0,8)} — ${reason}`);
    await logEvent('INFO', 'SNIPER_SKIP', reason, { walletAddress, tokenAddress, reason });
  }

  async _queueForManualApproval(walletAddress, tokenAddress, event) {
    // Store as a pending copied_trade with status PENDING_APPROVAL
    const wallet = await queryOne('SELECT id FROM wallets WHERE address = $1', [walletAddress]);
    if (!wallet) return;
    await query(
      `INSERT INTO copied_trades
         (wallet_id, wallet_address, trigger_tx_sig, token_address, token_symbol,
          entry_time, status, wallet_trust_score)
       VALUES ($1,$2,$3,$4,$5,NOW(),'PENDING_APPROVAL',$6)
       ON CONFLICT DO NOTHING`,
      [wallet.id, walletAddress, event.signature, tokenAddress, event.tokenSymbol, wallet.trust_score]
    ).catch(() => {});
  }

  destroy() {
    if (this._positionMonitorInterval) {
      clearInterval(this._positionMonitorInterval);
    }
  }
}
