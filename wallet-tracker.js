/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  modules/wallet-tracker.js — Real-Time Wallet Monitoring via Helius
 *
 *  Responsibilities:
 *    - Register / deregister Helius webhooks for tracked wallets
 *    - Parse incoming webhook events into normalized BuyEvent / SellEvent
 *    - Emit events for sniper-engine and portfolio-builder to consume
 *    - Maintain wallet subscription state in Postgres
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import EventEmitter from 'events';
import { query, queryOne, queryAll, logEvent } from '../db/client.js';

const HELIUS_API  = 'https://api.helius.xyz/v0';
const HELIUS_RPC  = () => `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ''}`;

// ─── Event Types ──────────────────────────────────────────────────────────────

export const EVENTS = {
  WALLET_BUY:     'wallet:buy',
  WALLET_SELL:    'wallet:sell',
  WALLET_SWAP:    'wallet:swap',
  TRACKER_ERROR:  'tracker:error',
};

// ─── WalletTracker ────────────────────────────────────────────────────────────

export class WalletTracker extends EventEmitter {
  constructor() {
    super();
    this.heliusKey    = process.env.HELIUS_API_KEY ?? '';
    this.webhookUrl   = process.env.WALLET_TRACKER_WEBHOOK_URL ?? '';
    this.webhookId    = process.env.HELIUS_WEBHOOK_ID ?? null; // single webhook for all wallets
    this.trackedAddresses = new Set();
    this.initialized  = false;
  }

  async init() {
    if (!this.heliusKey) {
      console.warn('[tracker] No HELIUS_API_KEY — wallet tracking disabled');
      return;
    }
    if (!this.webhookUrl) {
      console.warn('[tracker] No WALLET_TRACKER_WEBHOOK_URL — cannot register webhook');
    }

    // Load tracked wallets from DB
    const rows = await queryAll(
      `SELECT address FROM wallets WHERE is_active = TRUE AND is_followable = TRUE`
    );
    for (const r of rows) this.trackedAddresses.add(r.address);

    // Sync Helius webhook to match current tracked set
    if (this.webhookUrl && this.trackedAddresses.size > 0) {
      await this.syncWebhook();
    }

    this.initialized = true;
    console.log(`[tracker] Initialized — tracking ${this.trackedAddresses.size} wallets`);
    await logEvent('INFO', 'TRACKER_INIT', `Tracking ${this.trackedAddresses.size} wallets`);
  }

  // ─── Helius Webhook Management ──────────────────────────────────────────────

  async syncWebhook() {
    const addresses = Array.from(this.trackedAddresses);
    if (!this.webhookUrl) return;

    const key = this.heliusKey;

    try {
      if (this.webhookId) {
        // Update existing webhook
        const res = await fetch(`${HELIUS_API}/webhooks/${this.webhookId}?api-key=${key}`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            webhookURL:     this.webhookUrl,
            transactionTypes: ['SWAP', 'TOKEN_MINT', 'TRANSFER'],
            accountAddresses: addresses,
            webhookType:    'enhanced',
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const err = await res.text();
          console.warn('[tracker] Webhook update failed:', err.slice(0, 200));
        } else {
          console.log(`[tracker] Webhook updated — ${addresses.length} addresses`);
        }
      } else {
        // Create new webhook
        const res = await fetch(`${HELIUS_API}/webhooks?api-key=${key}`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            webhookURL:       this.webhookUrl,
            transactionTypes: ['SWAP', 'TOKEN_MINT', 'TRANSFER'],
            accountAddresses: addresses,
            webhookType:      'enhanced',
          }),
          signal: AbortSignal.timeout(15_000),
        });

        if (res.ok) {
          const data = await res.json();
          this.webhookId = data.webhookID;
          console.log(`[tracker] Webhook created: ${this.webhookId}`);
          await logEvent('INFO', 'WEBHOOK_CREATED', `id=${this.webhookId}`);
        } else {
          const err = await res.text();
          console.warn('[tracker] Webhook creation failed:', err.slice(0, 200));
        }
      }
    } catch (err) {
      console.error('[tracker] syncWebhook error:', err.message);
    }
  }

  async addWallet(address) {
    if (this.trackedAddresses.has(address)) return;
    this.trackedAddresses.add(address);

    await query(
      `INSERT INTO helius_subscriptions (wallet_address, webhook_id, is_active)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (wallet_address) DO UPDATE SET is_active = TRUE`,
      [address, this.webhookId]
    );

    await this.syncWebhook();
    console.log(`[tracker] Added wallet: ${address}`);
  }

  async removeWallet(address) {
    this.trackedAddresses.delete(address);

    await query(
      `UPDATE helius_subscriptions SET is_active = FALSE WHERE wallet_address = $1`,
      [address]
    );

    await this.syncWebhook();
    console.log(`[tracker] Removed wallet: ${address}`);
  }

  // ─── Webhook Event Parser ────────────────────────────────────────────────────

  /**
   * Called by the Express webhook route when Helius fires.
   * @param {Array} events — Helius enhanced transaction array
   */
  async processWebhookPayload(events) {
    if (!Array.isArray(events)) events = [events];

    for (const event of events) {
      try {
        await this._processEvent(event);
      } catch (err) {
        console.error('[tracker] Event processing error:', err.message);
        this.emit(EVENTS.TRACKER_ERROR, err);
      }
    }
  }

  async _processEvent(event) {
    const { signature, feePayer, type, tokenTransfers = [], nativeTransfers = [], timestamp } = event;

    // Only care about wallets we track
    if (!this.trackedAddresses.has(feePayer)) return;

    const blockTime = timestamp ? new Date(timestamp * 1000) : new Date();

    // ── Detect BUY: SOL or USDC goes out, SPL token comes in ─────────────────
    const inflows  = tokenTransfers.filter(t => t.toUserAccount === feePayer);
    const outflows = tokenTransfers.filter(t => t.fromUserAccount === feePayer);

    const solOut = nativeTransfers.filter(t => t.fromUserAccount === feePayer)
      .reduce((s, t) => s + (t.amount ?? 0), 0) / 1e9;

    for (const inflow of inflows) {
      // Skip SOL/WSOL inflows — those are sells
      if (this._isStable(inflow.mint)) continue;

      // Check if SOL left the wallet (indicating a buy)
      const isBuy = solOut > 0.001 || outflows.some(o => this._isStable(o.mint));

      const normalized = {
        walletAddress: feePayer,
        signature,
        type:          isBuy ? 'BUY' : 'SWAP',
        tokenAddress:  inflow.mint,
        tokenSymbol:   inflow.symbol ?? null,
        tokenAmount:   inflow.tokenAmount ?? 0,
        solAmount:     solOut,
        valueUsd:      null, // enriched downstream
        blockTime,
        rawEvent:      event,
      };

      if (isBuy) {
        console.log(`[tracker] BUY detected: ${feePayer.slice(0,8)}… → ${inflow.symbol ?? inflow.mint.slice(0,8)}…`);
        await this._persistTransaction(normalized, 'BUY');
        await this._updateLastActive(feePayer);
        this.emit(EVENTS.WALLET_BUY, normalized);
      } else {
        this.emit(EVENTS.WALLET_SWAP, normalized);
      }
    }

    // ── Detect SELL: SPL token goes out, SOL comes in ─────────────────────────
    for (const outflow of outflows) {
      if (this._isStable(outflow.mint)) continue;

      const solIn = nativeTransfers.filter(t => t.toUserAccount === feePayer)
        .reduce((s, t) => s + (t.amount ?? 0), 0) / 1e9;

      if (solIn > 0.001) {
        const normalized = {
          walletAddress: feePayer,
          signature,
          type:          'SELL',
          tokenAddress:  outflow.mint,
          tokenSymbol:   outflow.symbol ?? null,
          tokenAmount:   outflow.tokenAmount ?? 0,
          solAmount:     solIn,
          valueUsd:      null,
          blockTime,
          rawEvent:      event,
        };

        console.log(`[tracker] SELL detected: ${feePayer.slice(0,8)}… ← ${outflow.symbol ?? outflow.mint.slice(0,8)}…`);
        await this._persistTransaction(normalized, 'SELL');
        await this._updateLastActive(feePayer);
        this.emit(EVENTS.WALLET_SELL, normalized);
      }
    }
  }

  _isStable(mint) {
    const stables = new Set([
      'So11111111111111111111111111111111111111112',   // WSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
    ]);
    return stables.has(mint);
  }

  async _persistTransaction(normalized, txType) {
    try {
      const wallet = await queryOne(
        'SELECT id FROM wallets WHERE address = $1',
        [normalized.walletAddress]
      );
      if (!wallet) return;

      await query(
        `INSERT INTO wallet_transactions
           (wallet_id, wallet_address, signature, tx_type, token_address, token_symbol,
            sol_amount, token_amount, value_usd, block_time, is_entry, is_exit, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (signature) DO NOTHING`,
        [
          wallet.id, normalized.walletAddress, normalized.signature,
          txType, normalized.tokenAddress, normalized.tokenSymbol,
          normalized.solAmount, normalized.tokenAmount, normalized.valueUsd,
          normalized.blockTime,
          txType === 'BUY',
          txType === 'SELL',
          JSON.stringify(normalized.rawEvent),
        ]
      );
    } catch (err) {
      console.warn('[tracker] Persist tx error:', err.message);
    }
  }

  async _updateLastActive(address) {
    await query(
      'UPDATE wallets SET last_active_at = NOW() WHERE address = $1',
      [address]
    );
  }

  // ─── Fetch Historical Transactions ─────────────────────────────────────────

  async fetchHistoricalTrades(walletAddress, limit = 100) {
    if (!this.heliusKey) return [];
    try {
      const res = await fetch(
        `${HELIUS_API}/addresses/${walletAddress}/transactions?api-key=${this.heliusKey}&limit=${limit}&type=SWAP`,
        { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(20_000) }
      );
      if (!res.ok) return [];
      return await res.json();
    } catch (err) {
      console.warn(`[tracker] Historical fetch failed for ${walletAddress}:`, err.message);
      return [];
    }
  }

  getTrackedCount() {
    return this.trackedAddresses.size;
  }

  isTracked(address) {
    return this.trackedAddresses.has(address);
  }
}

// Singleton
export const tracker = new WalletTracker();
