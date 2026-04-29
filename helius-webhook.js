/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  helius-webhook.js
 *  Receives Enhanced webhook events from Helius for all tracked wallets
 *  and turns them into actionable signals:
 *    1. Stores every buy/sell in wallet_events table (history for win-rate calc)
 *    2. Detects CO-BUY SWARMS — when ≥3 tracked wallets buy the same CA within
 *       10 minutes, fires a swarm signal that triggers the bot's normal
 *       discovery + scoring pipeline (catches coins our scanner missed)
 *
 *  Helius Enhanced webhook payload shape:
 *    Array of parsed transactions, each with:
 *      - signature (unique tx hash)
 *      - timestamp (unix seconds)
 *      - type ('SWAP', 'TRANSFER', etc.)
 *      - tokenTransfers[] (parsed swap details)
 *      - nativeTransfers[] (SOL movements)
 *      - feePayer, source, ... etc
 *
 *  Setup: configures the webhook in Helius's dashboard, then pushes our
 *  4,806 wallet addresses programmatically via /api/helius/webhook/setup.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// Hooks wired by server.js on boot
let _onSwarmDetected = null;       // (ca, buyers[]) => void — fires when ≥3 tracked wallets co-buy
let _onWalletEvent   = null;       // (event) => void — fires on every parsed event (optional logging)
let _isWalletTracked = null;       // (address) => bool — checks if address is in our tracked DB

export function setSwarmHook(fn)         { _onSwarmDetected = typeof fn === 'function' ? fn : null; }
export function setEventHook(fn)         { _onWalletEvent   = typeof fn === 'function' ? fn : null; }
export function setIsWalletTrackedFn(fn) { _isWalletTracked = typeof fn === 'function' ? fn : null; }

// Restored to 3 after the webhook list was slimmed from 10K → 500 top-quality
// wallets (WINNER + KOL + ALPHA tiers, ≥10 SOL). With a curated 500-wallet
// list, 3 co-buys in 10 min IS real alpha — those are top performers, not
// noise. Score-floor guard (clusterMinScoreToPost in server.js) still blocks
// score-15/25 leakage even on 3-wallet clusters.
const SWARM_MIN_WALLETS = 3;
const SWARM_WINDOW_SEC  = 600;      // within 10 minutes
const SWARM_MIN_SOL     = 0.5;      // each buy ≥ 0.5 SOL (filter dust)
// Cooldown so a single hot coin doesn't fire 50 swarm signals back-to-back
const SWARM_COOLDOWN_MS = 30 * 60_000;
const _swarmFiredAt     = new Map(); // ca → ms epoch of last fire

/**
 * Parse a single Helius enhanced transaction into a normalized event we can
 * store. Returns null if the tx isn't a relevant swap/transfer.
 *
 * Helius "type" values we care about:
 *   - SWAP           → buy or sell of a token (most common)
 *   - TRANSFER       → SOL or token movement (used for funding chain detection)
 *   - UNKNOWN        → skip
 */
function parseEnhancedTx(tx) {
  if (!tx || !tx.signature || !tx.timestamp) return null;

  const txTime = Number(tx.timestamp);
  if (!Number.isFinite(txTime)) return null;

  const sig = tx.signature;
  const feePayer = tx.feePayer || tx.source || null;

  // SWAP — figure out who bought what
  if (tx.type === 'SWAP' || (Array.isArray(tx.tokenTransfers) && tx.tokenTransfers.length >= 2)) {
    const transfers = tx.tokenTransfers || [];
    // Find the wallet making the swap (feePayer or first user account)
    const wallet = feePayer;
    if (!wallet) return null;

    // Identify SOL leg vs token leg
    // Solana wrapped SOL mint: So11111111111111111111111111111111111111112
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const tokenLeg = transfers.find(t => t.mint && t.mint !== SOL_MINT);
    const solLeg   = transfers.find(t => t.mint === SOL_MINT);
    if (!tokenLeg) return null;

    // Direction: did the wallet RECEIVE the token (buy) or SEND it (sell)?
    const wallReceived = tokenLeg.toUserAccount === wallet || tokenLeg.toUser === wallet;
    const wallSent     = tokenLeg.fromUserAccount === wallet || tokenLeg.fromUser === wallet;
    const eventType = wallReceived ? 'BUY' : (wallSent ? 'SELL' : null);
    if (!eventType) return null;

    const solAmount = solLeg ? Math.abs(Number(solLeg.tokenAmount ?? solLeg.amount ?? 0)) : null;
    const tokenAmt  = Math.abs(Number(tokenLeg.tokenAmount ?? tokenLeg.amount ?? 0));

    return {
      wallet_address:  wallet,
      event_type:      eventType,
      contract_address: tokenLeg.mint,
      token_symbol:    tokenLeg.symbol || null,
      sol_amount:      solAmount,
      token_amount:    tokenAmt,
      mcap_at_event:   null,        // backfilled later if needed
      tx_signature:    sig,
      tx_timestamp:    txTime,
      raw:             { type: tx.type, source: tx.source },
    };
  }

  // TRANSFER — SOL movement (used for funding chain analysis later)
  if (tx.type === 'TRANSFER') {
    const native = (tx.nativeTransfers || [])[0];
    if (!native) return null;
    const isIn = !!_isWalletTracked && _isWalletTracked(native.toUserAccount);
    const isOut = !!_isWalletTracked && _isWalletTracked(native.fromUserAccount);
    if (!isIn && !isOut) return null;
    return {
      wallet_address:  isIn ? native.toUserAccount : native.fromUserAccount,
      event_type:      isIn ? 'TRANSFER_IN' : 'TRANSFER_OUT',
      contract_address: null,
      token_symbol:    null,
      sol_amount:      Math.abs(Number(native.amount ?? 0)) / 1e9, // lamports → SOL
      token_amount:    null,
      tx_signature:    sig,
      tx_timestamp:    txTime,
      raw:             { type: 'TRANSFER', counterparty: isIn ? native.fromUserAccount : native.toUserAccount },
    };
  }

  return null;
}

/**
 * Process a batch of Helius webhook events. Helius typically sends 1-50
 * events per webhook call. Returns counts for the response.
 */
export function processHeliusWebhookBatch(payload, dbHelpers) {
  if (!Array.isArray(payload)) return { ok: false, error: 'Expected array of transactions' };
  const { insertWalletEvent, getRecentBuyersForCA } = dbHelpers;

  let stored = 0;
  let skipped = 0;
  const swarmsToCheck = new Set();

  for (const tx of payload) {
    const evt = parseEnhancedTx(tx);
    if (!evt) { skipped++; continue; }

    // Only store events from wallets we actually track
    if (_isWalletTracked && !_isWalletTracked(evt.wallet_address)) {
      skipped++;
      continue;
    }

    insertWalletEvent(evt);
    stored++;
    if (_onWalletEvent) { try { _onWalletEvent(evt); } catch {} }

    // Co-buy swarm detection — only on BUY events with meaningful size
    if (evt.event_type === 'BUY' && evt.contract_address
        && (evt.sol_amount == null || evt.sol_amount >= SWARM_MIN_SOL)) {
      swarmsToCheck.add(evt.contract_address);
    }
  }

  // Run swarm check on each unique CA touched in this batch
  let swarmsFired = 0;
  for (const ca of swarmsToCheck) {
    const lastFired = _swarmFiredAt.get(ca) ?? 0;
    if (Date.now() - lastFired < SWARM_COOLDOWN_MS) continue;

    const buyers = getRecentBuyersForCA(ca, SWARM_WINDOW_SEC);
    const meaningfulBuyers = buyers.filter(b => (b.total_sol_in == null) || b.total_sol_in >= SWARM_MIN_SOL);
    if (meaningfulBuyers.length >= SWARM_MIN_WALLETS) {
      _swarmFiredAt.set(ca, Date.now());
      swarmsFired++;
      console.log(`[helius-webhook] 🐋 SWARM detected on ${ca}: ${meaningfulBuyers.length} tracked wallets bought in ${SWARM_WINDOW_SEC/60}min`);
      if (_onSwarmDetected) {
        try { _onSwarmDetected(ca, meaningfulBuyers); }
        catch (err) { console.warn('[helius-webhook] swarm hook err:', err.message); }
      }
    }
  }

  return { ok: true, received: payload.length, stored, skipped, swarmsFired };
}

/**
 * Helper: returns the right API key for Enhanced API calls.
 * Prefers HELIUS_ENHANCED_API_KEY (specifically scoped for Enhanced APIs +
 * webhooks) and falls back to HELIUS_API_KEY (the general one used by RPC).
 * This lets operators use separate keys for separate services if their
 * Helius account has multiple keys configured.
 */
export function getEnhancedApiKey() {
  return process.env.HELIUS_ENHANCED_API_KEY || process.env.HELIUS_API_KEY || null;
}

/**
 * Push our 4,806 wallet addresses to a Helius webhook by webhook ID.
 * Replaces the webhook's accountAddresses list with our current tracked set.
 * Idempotent — safe to call multiple times.
 *
 * Returns: { ok, registered, removed, skipped, error }
 */
export async function syncTrackedAddressesToHelius(webhookId, apiKey, addresses) {
  if (!webhookId || !apiKey) return { ok: false, error: 'webhookId or apiKey missing' };
  if (!Array.isArray(addresses) || addresses.length === 0) return { ok: false, error: 'no addresses' };

  // Helius caps at 100,000 addresses per webhook — we'll never hit that.
  // Filter to valid Solana base58 addresses (32-44 chars, no 0/O/I/l)
  const VALID_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const validAddresses = addresses.filter(a => typeof a === 'string' && VALID_ADDR.test(a));

  // First fetch current webhook config to preserve transaction types + URL
  let current = null;
  try {
    const r = await fetch(`https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${apiKey}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ok: false, error: 'GET webhook failed: HTTP ' + r.status + ' ' + (await r.text()).slice(0,200) };
    current = await r.json();
  } catch (err) { return { ok: false, error: 'GET webhook err: ' + err.message }; }

  // PUT updated config — only changing accountAddresses
  const body = {
    webhookURL:     current.webhookURL,
    transactionTypes: current.transactionTypes ?? ['SWAP'],
    accountAddresses: validAddresses,
    webhookType:    current.webhookType ?? 'enhanced',
    authHeader:     current.authHeader ?? '',
  };

  try {
    const r = await fetch(`https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${apiKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return { ok: false, error: 'PUT webhook failed: HTTP ' + r.status + ' ' + (await r.text()).slice(0,200) };
    const updated = await r.json();
    return {
      ok: true,
      registered: validAddresses.length,
      skipped: addresses.length - validAddresses.length,
      webhookURL: updated.webhookURL,
      transactionTypes: updated.transactionTypes,
    };
  } catch (err) { return { ok: false, error: 'PUT webhook err: ' + err.message }; }
}

/**
 * Create a brand-new Helius Enhanced webhook with the given URL + addresses.
 * Use this for first-time setup — replaces the manual dashboard click-through.
 * Returns: { ok, webhookID, webhookURL, registered, skipped, error }
 */
export async function createHeliusWebhook({ apiKey, webhookURL, accountAddresses = [], authHeader = '' }) {
  if (!apiKey)     return { ok: false, error: 'apiKey missing' };
  if (!webhookURL) return { ok: false, error: 'webhookURL missing' };

  const VALID_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const validAddresses = (accountAddresses || []).filter(a => typeof a === 'string' && VALID_ADDR.test(a));
  // Helius requires at least one accountAddress at creation. If we don't have
  // any yet, seed with a dummy SOL system address — the auto-sync will swap
  // in our real wallets within an hour.
  const seed = validAddresses.length ? validAddresses : ['So11111111111111111111111111111111111111112'];

  const body = {
    webhookURL,
    transactionTypes: ['SWAP'],
    accountAddresses: seed,
    webhookType:    'enhanced',
    authHeader:     authHeader || '',
  };

  try {
    const r = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return { ok: false, error: 'POST webhook failed: HTTP ' + r.status + ' ' + text.slice(0, 300) };
    }
    const created = await r.json();
    return {
      ok: true,
      webhookID:    created.webhookID,
      webhookURL:   created.webhookURL,
      registered:   seed.length,
      skipped:      (accountAddresses?.length ?? 0) - validAddresses.length,
      transactionTypes: created.transactionTypes,
    };
  } catch (err) { return { ok: false, error: 'POST webhook err: ' + err.message }; }
}

/**
 * List all webhooks on the account — useful for setup/debugging.
 */
export async function listHeliusWebhooks(apiKey) {
  if (!apiKey) return { ok: false, error: 'apiKey missing' };
  try {
    const r = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0,200) };
    const data = await r.json();
    return { ok: true, webhooks: data };
  } catch (err) { return { ok: false, error: err.message }; }
}
