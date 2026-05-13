/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  subscription-engine.js — Solana Pay VIP subscriptions
 *
 *  Flow:
 *    1. User runs /subscribe on Telegram
 *    2. createPendingSubscription() generates a unique payment_ref (memo),
 *       quotes the current SOL price, inserts a PENDING row
 *    3. Bot replies with Solana Pay deeplink + manual payment details
 *    4. Payment watcher polls the recipient wallet every 30s. On a tx
 *       carrying our memo and the right SOL amount (±2% tolerance for
 *       fee/price drift), it activates the subscription
 *    5. On activation: generate one-time Telegram invite link, DM user,
 *       set expires_at = now + 30 days
 *    6. Daily expiry tracker DMs reminders 3 days / 1 day before expiry,
 *       then kicks the user from the VIP channel 24h after expiry
 *
 *  Env vars:
 *    SUBSCRIPTION_RECIPIENT_WALLET  — SOL address that receives payments
 *    SUBSCRIPTION_PRICE_USD         — monthly price (default 89)
 *    SUBSCRIPTION_DAYS              — subscription duration (default 30)
 *    TELEGRAM_GROUP_CHAT_ID         — VIP channel(s) to add paying users to
 *    HELIUS_API_KEY                 — for polling recipient wallet
 *    TELEGRAM_BOT_TOKEN             — for DMing invite links + kicking users
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

import { randomBytes, createHash } from 'crypto';

const DEFAULT_RECIPIENT_WALLET = 'BznUBLUjXh3jQH1AaVaPgQ48KwWUiD4LyxtfnGSexs7h';
const DEFAULT_PRICE_USD        = 89;
const DEFAULT_DAYS             = 30;
const TRIAL_DURATION_HOURS     = 48;
// Hash salt for phone numbers. Set TRIAL_PHONE_SALT env var to override.
// Using a fixed fallback means hashes are consistent across restarts,
// but for max security set a long random value in Railway env.
const PHONE_HASH_SALT = process.env.TRIAL_PHONE_SALT || 'pulse-caller-trial-2026';

const PAYMENT_POLL_INTERVAL_MS   = 30_000;       // 30s — fast enough that paying users see access within a minute
const EXPIRY_CHECK_INTERVAL_MS   = 60 * 60_000;  // hourly
const SOL_PRICE_CACHE_MS         = 60_000;       // 60s — Jupiter price cache
const PENDING_PAYMENT_WINDOW_MIN = 60;           // payments accepted up to 60 min after /subscribe quote
const AMOUNT_TOLERANCE_PCT       = 2;            // ±2% slippage tolerance (fees + price drift)

const HELIUS_RPC = (key) => `https://mainnet.helius-rpc.com/?api-key=${key}`;
const JUPITER_PRICE_URL = 'https://price.jup.ag/v6/price?ids=SOL';
const COINGECKO_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

let _db                  = null;
let _telegramBotToken    = null;
let _recipientWallet     = null;
let _priceUsd            = null;
let _subDays             = null;
let _vipChatIds          = [];
let _paymentPollTimer    = null;
let _expiryCheckTimer    = null;
let _solPriceCache       = { price: null, fetchedAt: 0 };
let _lastSeenSignature   = null;  // pagination cursor — only check NEW txs each tick
let _stats = {
  pendingCreated:   0,
  paymentsMatched:  0,
  invitesDelivered: 0,
  expiryRemindersSent: 0,
  usersRemoved:     0,
  lastPollAt:       null,
  lastError:        null,
};

// ─── Public API ──────────────────────────────────────────────────────────────

export function initSubscriptionEngine(opts) {
  _db               = opts.db;
  _telegramBotToken = opts.telegramBotToken;
  _recipientWallet  = (process.env.SUBSCRIPTION_RECIPIENT_WALLET || DEFAULT_RECIPIENT_WALLET).trim();
  _priceUsd         = Number(process.env.SUBSCRIPTION_PRICE_USD ?? DEFAULT_PRICE_USD);
  _subDays          = Number(process.env.SUBSCRIPTION_DAYS      ?? DEFAULT_DAYS);
  _vipChatIds       = (process.env.TELEGRAM_GROUP_CHAT_ID || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!_telegramBotToken) {
    console.warn('[subscriptions] No TELEGRAM_BOT_TOKEN — engine disabled');
    return;
  }
  if (!process.env.HELIUS_API_KEY) {
    console.warn('[subscriptions] No HELIUS_API_KEY — payment watcher disabled');
    return;
  }

  console.log(`[subscriptions] Engine starting — recipient ${_recipientWallet.slice(0,8)}…, price $${_priceUsd}/${_subDays}d, VIP chats: ${_vipChatIds.length}`);

  // Start payment poller after 20s (let DB + telegram init settle)
  setTimeout(() => {
    paymentTick().catch(err => console.warn('[subscriptions] first poll err:', err.message));
  }, 20_000);
  _paymentPollTimer = setInterval(() => {
    paymentTick().catch(err => console.warn('[subscriptions] poll err:', err.message));
  }, PAYMENT_POLL_INTERVAL_MS);

  // Start expiry tracker after 2 min, then hourly
  setTimeout(() => {
    expiryTick().catch(err => console.warn('[subscriptions] first expiry tick err:', err.message));
  }, 120_000);
  _expiryCheckTimer = setInterval(() => {
    expiryTick().catch(err => console.warn('[subscriptions] expiry tick err:', err.message));
  }, EXPIRY_CHECK_INTERVAL_MS);
}

export function getSubscriptionStats() {
  return { ..._stats, recipientWallet: _recipientWallet, priceUsd: _priceUsd, subDays: _subDays };
}

// ─── /subscribe Command Helper ───────────────────────────────────────────────

/**
 * Called by the Telegram /subscribe command handler.
 * Returns { ok, status, message } describing the user's situation:
 *  - existing ACTIVE → status + days remaining
 *  - existing PENDING (still in window) → repeat payment details
 *  - new → quote price + create PENDING row + return payment instructions
 */
export async function handleSubscribeRequest({ telegramId, username, chatId }) {
  if (!_db) return { ok: false, message: 'Subscription engine not initialized.' };
  if (!telegramId) return { ok: false, message: 'Could not identify your Telegram user.' };

  // Check for existing ACTIVE subscription
  const active = _db.prepare(`
    SELECT * FROM subscriptions
    WHERE telegram_id = ? AND status = 'ACTIVE'
    ORDER BY expires_at DESC LIMIT 1
  `).get(String(telegramId));
  if (active) {
    const daysLeft = Math.max(0, Math.ceil((new Date(active.expires_at).getTime() - Date.now()) / 86_400_000));
    return {
      ok:       true,
      status:   'ACTIVE',
      message:
        `✅ <b>VIP Active</b>\n\n` +
        `<b>Expires:</b> ${active.expires_at.split('T')[0]} <i>(${daysLeft} day${daysLeft===1?'':'s'} left)</i>\n` +
        `<b>Last payment:</b> $${active.amount_usd} on ${active.paid_at?.split('T')[0] ?? '?'}\n\n` +
        `Renew anytime — your time stacks, no gap in access.`,
      keyboard: buildActiveStatusKeyboard(),
    };
  }

  // Check for recent PENDING — reuse the quote if still within payment window
  const recent = _db.prepare(`
    SELECT * FROM subscriptions
    WHERE telegram_id = ? AND status = 'PENDING'
      AND created_at > datetime('now', '-${PENDING_PAYMENT_WINDOW_MIN} minutes')
    ORDER BY created_at DESC LIMIT 1
  `).get(String(telegramId));
  if (recent) {
    return {
      ok:        true,
      status:    'PENDING_REUSE',
      message:   formatPaymentInstructions(recent),
      keyboard:  buildPaymentKeyboard(recent),
      paymentRef: recent.payment_ref,
    };
  }

  // Fresh quote — fetch current SOL price
  const solPrice = await getSolPriceUsd();
  if (!solPrice || solPrice <= 0) {
    return { ok: false, message: '⚠️ Could not fetch SOL price right now. Try again in a moment.' };
  }
  const amountSol = +(_priceUsd / solPrice).toFixed(4);
  const paymentRef = generatePaymentRef();

  try {
    _db.prepare(`
      INSERT INTO subscriptions
        (telegram_id, username, chat_id, payment_ref, amount_usd, amount_sol, sol_price_usd, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `).run(
      String(telegramId),
      username ?? null,
      chatId != null ? String(chatId) : null,
      paymentRef,
      _priceUsd,
      amountSol,
      solPrice,
    );
    _stats.pendingCreated++;
  } catch (err) {
    return { ok: false, message: `⚠️ Failed to create payment request: ${err.message}` };
  }

  const sub = _db.prepare('SELECT * FROM subscriptions WHERE payment_ref = ?').get(paymentRef);
  return {
    ok:         true,
    status:     'PENDING_NEW',
    message:    formatPaymentInstructions(sub),
    keyboard:   buildPaymentKeyboard(sub),
    paymentRef,
  };
}

function formatPaymentInstructions(sub) {
  return (
    `💎 <b>PULSE CALLER VIP</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Get the calls <b>at entry</b>, not after the move.\n\n` +
    `<b>💰 Price:</b>  $${sub.amount_usd} for ${_subDays} days\n` +
    `<b>⚡ Pay:</b>    <code>${sub.amount_sol} SOL</code>\n` +
    `<b>📈 SOL @ </b> $${sub.sol_price_usd.toFixed(2)}\n\n` +
    `<b>📍 Wallet:</b>\n<code>${_recipientWallet}</code>\n\n` +
    `<b>🎯 Memo (REQUIRED):</b>\n<code>${sub.payment_ref}</code>\n\n` +
    `<i>The memo is how we match your payment to your account. Without it, you'll need to contact support.</i>\n\n` +
    `Once paid on-chain (~30 sec), you'll get your one-time VIP invite link DMed automatically.\n\n` +
    `⏱ Quote valid for <b>${PENDING_PAYMENT_WINDOW_MIN} min</b>.`
  );
}

// Inline keyboard for the payment card. Tap-and-go UX:
//   💎 Pay   → opens Solana Pay deeplink in Phantom / Solflare / etc.
//   📋 Copy  → Telegram copies the value to clipboard (Bot API 7.5+)
//   ✅ Check → manual payment poll for impatient users
//   ❌ Cancel→ abandon this quote
function buildPaymentKeyboard(sub) {
  const solanaPayUrl =
    `solana:${_recipientWallet}?amount=${sub.amount_sol}` +
    `&label=${encodeURIComponent('Pulse Caller VIP')}` +
    `&memo=${encodeURIComponent(sub.payment_ref)}`;
  return {
    inline_keyboard: [
      [
        { text: `💎 Pay ${sub.amount_sol} SOL`, url: solanaPayUrl },
      ],
      [
        { text: '📋 Copy Wallet', copy_text: { text: _recipientWallet } },
        { text: '📋 Copy Memo',   copy_text: { text: sub.payment_ref } },
      ],
      [
        { text: '✅ I Paid — Check Now', callback_data: `sub:check:${sub.payment_ref}` },
        { text: '❌ Cancel',              callback_data: `sub:cancel:${sub.payment_ref}` },
      ],
    ],
  };
}

// Inline keyboard for ACTIVE subscriber status card.
export function buildActiveStatusKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔄 Renew Early', callback_data: 'sub:renew' },
        { text: '📊 My Stats',    callback_data: 'sub:stats' },
      ],
    ],
  };
}

// Inline keyboard for users who don't have a subscription yet.
export function buildSubscribeCtaKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '💎 Subscribe Now', callback_data: 'sub:start' },
      ],
    ],
  };
}

// Reply keyboard (not inline) — used to request the user's phone number
// for trial activation. Telegram displays a "Share Phone" button that
// triggers the native phone-share confirmation flow.
export function buildTrialPhoneRequestKeyboard() {
  return {
    keyboard: [[
      { text: '📱 Share Phone & Start Trial', request_contact: true },
    ]],
    one_time_keyboard: true,
    resize_keyboard:   true,
  };
}

// ─── 48h Free Trial (phone-gated) ────────────────────────────────────────

function hashPhone(phoneRaw) {
  if (!phoneRaw) return null;
  const digits = String(phoneRaw).replace(/\D+/g, '');
  if (!digits) return null;
  return createHash('sha256')
    .update(digits + ':' + PHONE_HASH_SALT)
    .digest('hex');
}

/**
 * Activate a 48h trial for a user who just shared their phone number.
 * Phone-hash uniqueness is enforced at the DB level so a duplicate phone
 * (same number, different Telegram account) hits the UNIQUE constraint
 * and gets a "trial already used" response.
 *
 * Returns {ok, status, message, keyboard?} for the bot to reply with.
 */
export async function activateTrial({ telegramId, username, chatId, phoneRaw }) {
  if (!_db || !telegramId)         return { ok: false, message: '⚠️ Trial engine not ready.' };
  if (!phoneRaw)                   return { ok: false, message: '⚠️ No phone number received. Try /start again.' };

  const phoneHash = hashPhone(phoneRaw);
  if (!phoneHash) return { ok: false, message: '⚠️ Invalid phone number format.' };

  // Already used this phone for a trial? Show subscribe CTA.
  const existing = _db.prepare(
    `SELECT id, telegram_id, status, expires_at FROM subscriptions WHERE trial_phone_hash = ? LIMIT 1`
  ).get(phoneHash);
  if (existing) {
    const sameUser = String(existing.telegram_id) === String(telegramId);
    return {
      ok:      true,
      status:  'TRIAL_ALREADY_USED',
      message:
        `🚫 <b>Trial already used</b>\n\n` +
        (sameUser
          ? `You've already claimed your free trial on this number.\n\n`
          : `This phone number was already used to claim a trial.\n\n`) +
        `Subscribe for full VIP access — $89 / 30 days.`,
      keyboard: buildSubscribeCtaKeyboard(),
    };
  }

  // Active paid subscription? No trial needed.
  const activeSub = _db.prepare(`
    SELECT * FROM subscriptions
    WHERE telegram_id = ? AND status = 'ACTIVE'
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    LIMIT 1
  `).get(String(telegramId));
  if (activeSub) {
    return {
      ok:      true,
      status:  'ALREADY_VIP',
      message: `✅ You already have an ACTIVE VIP subscription — no trial needed!\n\nExpires ${activeSub.expires_at.split('T')[0]}.`,
    };
  }

  // Grant the trial — create a TRIAL subscription row + generate VIP invite
  const expiresAt = new Date(Date.now() + TRIAL_DURATION_HOURS * 3600 * 1000).toISOString();
  const trialRef  = 'trial-' + randomBytes(6).toString('base64url').slice(0, 8).toLowerCase();

  let inviteLink = null;
  let inviteError = null;
  const vipChatId = _vipChatIds[0];
  if (vipChatId) {
    try {
      inviteLink = await createTelegramInviteLink(vipChatId, expiresAt);
    } catch (err) { inviteError = err.message; }
  } else {
    inviteError = 'No TELEGRAM_GROUP_CHAT_ID configured';
  }

  try {
    _db.prepare(`
      INSERT INTO subscriptions
        (telegram_id, username, chat_id, payment_ref, amount_usd, amount_sol, sol_price_usd,
         status, expires_at, invite_link, invite_sent_at, trial_phone_hash, trial_started_at, notes)
      VALUES (?, ?, ?, ?, 0, 0, 0,
              'TRIAL', ?, ?, CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE NULL END,
              ?, datetime('now'), ?)
    `).run(
      String(telegramId),
      username ?? null,
      chatId != null ? String(chatId) : null,
      trialRef,
      expiresAt,
      inviteLink,
      inviteLink,
      phoneHash,
      inviteError ? `trial invite error: ${inviteError}` : null,
    );
  } catch (err) {
    // UNIQUE constraint violation on trial_phone_hash race — treat as
    // "already used" rather than an error.
    if (String(err.message).includes('UNIQUE')) {
      return {
        ok:       true,
        status:   'TRIAL_ALREADY_USED',
        message:  `🚫 <b>Trial already used</b>\n\nThis phone number was already used to claim a trial.\n\nSubscribe for full VIP access — $89 / 30 days.`,
        keyboard: buildSubscribeCtaKeyboard(),
      };
    }
    return { ok: false, message: `⚠️ Failed to start trial: ${err.message}` };
  }

  // Welcome DM with invite link
  const welcome =
    `🎁 <b>Your 48-hour VIP trial is LIVE</b>\n\n` +
    `For the next 48 hours you have full access to:\n` +
    `• ⚡ Live calls AT ENTRY (the VIP feed)\n` +
    `• 🧪 Deep AI analysis on any token\n` +
    `• 🔍 "Why was this called?" reasoning\n` +
    `• 🏆 Top calls + bot stats\n` +
    `• 👁 Active watchlist + wallet tracking\n\n` +
    (inviteLink
      ? `<b>Tap to join the VIP channel:</b>\n<a href="${inviteLink}">${inviteLink}</a>\n\n`
      : `(There was a hiccup generating your invite link automatically — DM the operator.)\n\n`) +
    `<b>Trial ends:</b> ${expiresAt.split('T')[0]} (${TRIAL_DURATION_HOURS}h from now)\n\n` +
    `Want to keep VIP access after the trial? Tap /subscribe anytime — $89 for 30 days.`;

  return {
    ok:       true,
    status:   'TRIAL_ACTIVATED',
    message:  welcome,
    keyboard: { inline_keyboard: [[{ text: '💎 Subscribe Anytime', callback_data: 'sub:start' }]] },
  };
}

/**
 * Check if a user has trial access (vs paid subscription).
 * Returns {hasTrial, expiresAt, hoursLeft} or null if no trial.
 */
export function getTrialStatus(telegramId) {
  if (!_db || !telegramId) return null;
  try {
    const row = _db.prepare(`
      SELECT expires_at FROM subscriptions
      WHERE telegram_id = ? AND status = 'TRIAL'
        AND expires_at > datetime('now')
      LIMIT 1
    `).get(String(telegramId));
    if (!row) return null;
    const expiresAt = new Date(row.expires_at);
    const hoursLeft = Math.max(0, (expiresAt.getTime() - Date.now()) / 3_600_000);
    return { hasTrial: true, expiresAt: row.expires_at, hoursLeft };
  } catch { return null; }
}

/**
 * Manually check a pending subscription's payment status.
 * Used by the "✅ I Paid — Check Now" button callback. Forces one tick of
 * the payment poller, then returns the latest state of the subscription.
 */
export async function checkSubscriptionStatus(paymentRef) {
  if (!_db || !paymentRef) return { ok: false, message: '⚠️ Engine not ready.' };
  try {
    await paymentTick();
  } catch {}
  const sub = _db.prepare('SELECT * FROM subscriptions WHERE payment_ref = ?').get(paymentRef);
  if (!sub) return { ok: false, message: '⚠️ Could not find your subscription. Run /subscribe to start fresh.' };
  if (sub.status === 'ACTIVE') {
    return {
      ok: true,
      message:
        `✅ <b>Payment received — you're VIP!</b>\n\n` +
        `Subscription active until <b>${sub.expires_at.split('T')[0]}</b>.\n\n` +
        (sub.invite_link
          ? `Your invite link was DMed to you. If you missed it, tap below:\n<a href="${sub.invite_link}">${sub.invite_link}</a>`
          : `Generating your invite link…`),
    };
  }
  if (sub.status === 'PENDING') {
    return {
      ok: true,
      message:
        `⏳ <b>Still waiting for your payment</b>\n\n` +
        `If you've already sent SOL, give it ~30 sec to confirm on-chain.\n\n` +
        `Memo: <code>${sub.payment_ref}</code>\n` +
        `Amount: <code>${sub.amount_sol} SOL</code>\n\n` +
        `Tap "Check Now" again in a minute.`,
    };
  }
  return { ok: true, message: `Subscription status: <b>${sub.status}</b>` };
}

/**
 * Cancel a pending subscription quote.
 */
export function cancelPendingSubscription(paymentRef) {
  if (!_db || !paymentRef) return false;
  try {
    const result = _db.prepare(`
      UPDATE subscriptions SET status='CANCELLED', notes='cancelled by user'
      WHERE payment_ref = ? AND status = 'PENDING'
    `).run(paymentRef);
    return result.changes > 0;
  } catch { return false; }
}

// ─── Payment Polling ─────────────────────────────────────────────────────────

async function paymentTick() {
  _stats.lastPollAt = new Date().toISOString();
  // Get all PENDING subscriptions inside the payment window
  const pending = _db.prepare(`
    SELECT * FROM subscriptions
    WHERE status = 'PENDING'
      AND created_at > datetime('now', '-${PENDING_PAYMENT_WINDOW_MIN} minutes')
  `).all();
  if (!pending.length) return;

  // Fetch recent SOL transfers TO the recipient wallet via Helius Enhanced API
  const txs = await fetchRecentRecipientTransfers();
  if (!txs.length) return;

  for (const tx of txs) {
    const memo = extractMemo(tx);
    if (!memo) continue;

    const match = pending.find(p => p.payment_ref === memo);
    if (!match) continue;

    // Sanity-check the SOL amount within tolerance
    const receivedSol = extractSolReceived(tx, _recipientWallet);
    if (receivedSol == null) continue;
    const expected = match.amount_sol;
    const lowerBound = expected * (1 - AMOUNT_TOLERANCE_PCT / 100);
    if (receivedSol < lowerBound) {
      console.warn(`[subscriptions] underpayment for ${match.payment_ref}: got ${receivedSol} SOL, expected ${expected} SOL — ignoring`);
      continue;
    }

    // Activate the subscription
    await activateSubscription(match, tx.signature, receivedSol);
  }
}

async function fetchRecentRecipientTransfers() {
  const key = process.env.HELIUS_API_KEY;
  if (!key || !_recipientWallet) return [];
  try {
    let url = `https://api.helius.xyz/v0/addresses/${_recipientWallet}/transactions?api-key=${key}&limit=20`;
    if (_lastSeenSignature) url += `&until=${_lastSeenSignature}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      _stats.lastError = `Helius ${res.status}`;
      return [];
    }
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      // Cache the newest signature so next tick only fetches what's new
      _lastSeenSignature = data[0].signature ?? _lastSeenSignature;
    }
    return Array.isArray(data) ? data : [];
  } catch (err) {
    _stats.lastError = err.message;
    return [];
  }
}

function extractMemo(tx) {
  // Helius enhanced txs can carry the memo in several places:
  //   instructions[].programId === MEMO_PROGRAM_ID
  //   tx.events?.memo
  //   description containing the memo
  const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
  const MEMO_PROGRAM_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
  if (Array.isArray(tx.instructions)) {
    for (const inst of tx.instructions) {
      if (inst.programId === MEMO_PROGRAM_ID || inst.programId === MEMO_PROGRAM_V1) {
        // Memo instruction data is base58 / utf8-decoded as 'data' field
        if (inst.data && typeof inst.data === 'string') return inst.data;
        if (inst.parsed && typeof inst.parsed === 'string') return inst.parsed;
      }
    }
  }
  // Helius also surfaces memo as a top-level event in some payloads
  if (tx.events?.memo) return String(tx.events.memo);
  // Fall back to scanning the description
  if (typeof tx.description === 'string') {
    const m = tx.description.match(/pls-[a-z0-9]{8,16}/i);
    if (m) return m[0];
  }
  return null;
}

function extractSolReceived(tx, walletAddress) {
  // Look at nativeTransfers — SOL movements
  if (Array.isArray(tx.nativeTransfers)) {
    let total = 0;
    for (const t of tx.nativeTransfers) {
      if (t.toUserAccount === walletAddress) {
        total += Number(t.amount || 0) / 1e9;  // lamports → SOL
      }
    }
    if (total > 0) return total;
  }
  // Some payloads use accountData.nativeBalanceChange
  if (Array.isArray(tx.accountData)) {
    const entry = tx.accountData.find(a => a.account === walletAddress);
    if (entry?.nativeBalanceChange != null) {
      const delta = Number(entry.nativeBalanceChange) / 1e9;
      if (delta > 0) return delta;
    }
  }
  return null;
}

async function activateSubscription(sub, txSig, receivedSol) {
  // Compute expiry
  const expiresAt = new Date(Date.now() + _subDays * 86_400_000).toISOString();

  // Generate one-time Telegram invite link to the primary VIP chat
  let inviteLink = null;
  let inviteError = null;
  const vipChatId = _vipChatIds[0];
  if (vipChatId) {
    try {
      inviteLink = await createTelegramInviteLink(vipChatId, expiresAt);
    } catch (err) {
      inviteError = err.message;
    }
  } else {
    inviteError = 'No TELEGRAM_GROUP_CHAT_ID configured';
  }

  // Update DB row
  try {
    _db.prepare(`
      UPDATE subscriptions
      SET status         = 'ACTIVE',
          paid_tx_sig    = ?,
          paid_at        = datetime('now'),
          expires_at     = ?,
          invite_link    = ?,
          invite_sent_at = CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE invite_sent_at END,
          notes          = ?
      WHERE id = ?
    `).run(
      txSig,
      expiresAt,
      inviteLink,
      inviteLink,
      inviteError ? `invite error: ${inviteError}` : null,
      sub.id,
    );
  } catch (err) {
    console.error(`[subscriptions] DB update failed for ${sub.payment_ref}: ${err.message}`);
    return;
  }

  _stats.paymentsMatched++;
  console.log(`[subscriptions] ✓ payment matched ref=${sub.payment_ref} tg=${sub.telegram_id} sol=${receivedSol.toFixed(4)} sig=${txSig.slice(0,12)}…`);

  // DM the user
  const msg = inviteLink
    ? `✅ <b>Payment confirmed — Welcome to PULSE CALLER VIP</b>\n\n` +
      `Subscription active until <b>${expiresAt.split('T')[0]}</b>.\n\n` +
      `<b>Your one-time invite link:</b>\n<a href="${inviteLink}">${inviteLink}</a>\n\n` +
      `Tap it to join the VIP channel. Link expires when you join (or when your subscription ends).\n\n` +
      `Renew anytime by running /subscribe again.`
    : `✅ <b>Payment confirmed!</b>\n\n` +
      `There was a hiccup generating your VIP invite automatically. The team has been notified and will DM you the link within 24 hours. Sorry for the delay.\n\n` +
      `Subscription active until <b>${expiresAt.split('T')[0]}</b>.`;

  try {
    await sendTelegramDM(sub.telegram_id, msg);
    _stats.invitesDelivered++;
  } catch (err) {
    console.warn(`[subscriptions] DM failed to ${sub.telegram_id}: ${err.message}`);
  }
}

// ─── Telegram API Helpers ────────────────────────────────────────────────────

async function createTelegramInviteLink(chatId, expiresAtIso) {
  if (!_telegramBotToken) throw new Error('No bot token');
  const expireDate = Math.floor(new Date(expiresAtIso).getTime() / 1000);
  const res = await fetch(`https://api.telegram.org/bot${_telegramBotToken}/createChatInviteLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:      chatId,
      expire_date:  expireDate,
      member_limit: 1,                 // one-time use only
      name:         `VIP sub (auto)`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.description || 'Telegram createChatInviteLink failed');
  return j.result?.invite_link || null;
}

async function sendTelegramDM(telegramId, html) {
  if (!_telegramBotToken) throw new Error('No bot token');
  const res = await fetch(`https://api.telegram.org/bot${_telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    telegramId,
      text:       html,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0,150)}`);
  }
  return res.json();
}

async function kickUserFromVipChannel(telegramId, chatId) {
  if (!_telegramBotToken) return false;
  try {
    // banChatMember + immediately unbanChatMember = remove without permaban
    await fetch(`https://api.telegram.org/bot${_telegramBotToken}/banChatMember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, user_id: telegramId, revoke_messages: false }),
      signal:  AbortSignal.timeout(10_000),
    });
    await new Promise(r => setTimeout(r, 1000));
    await fetch(`https://api.telegram.org/bot${_telegramBotToken}/unbanChatMember`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, user_id: telegramId, only_if_banned: true }),
      signal:  AbortSignal.timeout(10_000),
    });
    return true;
  } catch (err) {
    console.warn(`[subscriptions] kick failed for ${telegramId}: ${err.message}`);
    return false;
  }
}

// ─── Expiry Tracker ──────────────────────────────────────────────────────────

async function expiryTick() {
  if (!_db) return;
  const now = new Date();

  // 3-day reminder
  const threeDayCandidates = _db.prepare(`
    SELECT * FROM subscriptions
    WHERE status = 'ACTIVE'
      AND reminder_3d_at IS NULL
      AND expires_at IS NOT NULL
      AND datetime(expires_at, '-3 days') < datetime('now')
      AND expires_at > datetime('now')
  `).all();
  for (const sub of threeDayCandidates) {
    const daysLeft = Math.ceil((new Date(sub.expires_at).getTime() - now.getTime()) / 86_400_000);
    const msg =
      `⏰ <b>VIP renewal reminder</b>\n\n` +
      `Your Pulse Caller VIP subscription expires in <b>${daysLeft} day${daysLeft === 1 ? '' : 's'}</b> (${sub.expires_at.split('T')[0]}).\n\n` +
      `Renew anytime by running /subscribe — your access continues without interruption if paid before expiry.`;
    try {
      await sendTelegramDM(sub.telegram_id, msg);
      _db.prepare(`UPDATE subscriptions SET reminder_3d_at = datetime('now') WHERE id = ?`).run(sub.id);
      _stats.expiryRemindersSent++;
    } catch {}
  }

  // 1-day final reminder
  const oneDayCandidates = _db.prepare(`
    SELECT * FROM subscriptions
    WHERE status = 'ACTIVE'
      AND reminder_1d_at IS NULL
      AND expires_at IS NOT NULL
      AND datetime(expires_at, '-1 day') < datetime('now')
      AND expires_at > datetime('now')
  `).all();
  for (const sub of oneDayCandidates) {
    const msg =
      `⚠️ <b>VIP expires tomorrow</b>\n\n` +
      `Your access ends in less than 24 hours. Run /subscribe now to extend without losing access.`;
    try {
      await sendTelegramDM(sub.telegram_id, msg);
      _db.prepare(`UPDATE subscriptions SET reminder_1d_at = datetime('now') WHERE id = ?`).run(sub.id);
      _stats.expiryRemindersSent++;
    } catch {}
  }

  // Mark EXPIRED + kick from VIP channel after 24h grace
  const expired = _db.prepare(`
    SELECT * FROM subscriptions
    WHERE status = 'ACTIVE'
      AND expires_at IS NOT NULL
      AND datetime(expires_at, '+24 hours') < datetime('now')
  `).all();
  for (const sub of expired) {
    const vipChatId = _vipChatIds[0];
    if (vipChatId) {
      await kickUserFromVipChannel(sub.telegram_id, vipChatId);
    }
    _db.prepare(`
      UPDATE subscriptions
      SET status = 'EXPIRED_REMOVED', removed_at = datetime('now')
      WHERE id = ?
    `).run(sub.id);
    _stats.usersRemoved++;

    // Final notice DM
    try {
      await sendTelegramDM(sub.telegram_id,
        `Your Pulse Caller VIP subscription has expired and you've been removed from the VIP channel.\n\n` +
        `Re-subscribe anytime via /subscribe — invite is instant once payment confirms.`);
    } catch {}
  }

  // ── TRIAL EXPIRY HANDLING ────────────────────────────────────────────
  // Trials have a tighter cycle than paid subs (48h vs 30d) and need
  // their own reminders to drive conversion before the clock runs out.

  // 24h reminder
  const trial24h = _db.prepare(`
    SELECT * FROM subscriptions
    WHERE status = 'TRIAL'
      AND reminder_3d_at IS NULL
      AND expires_at IS NOT NULL
      AND datetime(expires_at, '-24 hours') < datetime('now')
      AND expires_at > datetime('now')
  `).all();
  for (const sub of trial24h) {
    try {
      await sendTelegramDM(sub.telegram_id,
        `⏰ <b>24 hours left of your VIP trial</b>\n\n` +
        `You're halfway through. Keep that live-call edge — subscribe for $89 / 30 days and your access never lapses.\n\n` +
        `Tap /subscribe to lock it in.`);
      _db.prepare(`UPDATE subscriptions SET reminder_3d_at = datetime('now') WHERE id = ?`).run(sub.id);
      _stats.expiryRemindersSent++;
    } catch {}
  }

  // 1h final-warning reminder
  const trial1h = _db.prepare(`
    SELECT * FROM subscriptions
    WHERE status = 'TRIAL'
      AND reminder_1d_at IS NULL
      AND expires_at IS NOT NULL
      AND datetime(expires_at, '-1 hour') < datetime('now')
      AND expires_at > datetime('now')
  `).all();
  for (const sub of trial1h) {
    try {
      await sendTelegramDM(sub.telegram_id,
        `⚠️ <b>Trial ends in 1 hour</b>\n\n` +
        `After this, you'll be moved back to the free tier and removed from the VIP channel.\n\n` +
        `Tap /subscribe now to keep your access — invite link stays the same, no gap.`);
      _db.prepare(`UPDATE subscriptions SET reminder_1d_at = datetime('now') WHERE id = ?`).run(sub.id);
      _stats.expiryRemindersSent++;
    } catch {}
  }

  // Trial expired — kick from VIP, mark TRIAL_EXPIRED. No grace period for
  // trials (paid subs get 24h grace; trials are firm — encourages quick
  // conversion).
  const trialExpired = _db.prepare(`
    SELECT * FROM subscriptions
    WHERE status = 'TRIAL'
      AND expires_at IS NOT NULL
      AND expires_at < datetime('now')
  `).all();
  for (const sub of trialExpired) {
    const vipChatId = _vipChatIds[0];
    if (vipChatId) {
      await kickUserFromVipChannel(sub.telegram_id, vipChatId);
    }
    _db.prepare(`
      UPDATE subscriptions
      SET status = 'TRIAL_EXPIRED', removed_at = datetime('now')
      WHERE id = ?
    `).run(sub.id);
    _stats.usersRemoved++;

    try {
      await sendTelegramDM(sub.telegram_id,
        `⏰ <b>Your 48h VIP trial has ended</b>\n\n` +
        `You've been moved back to the free tier. You'll still see milestone updates on big winners — but the calls hit VIP at entry, hours before they reach the free channel.\n\n` +
        `Tap /subscribe to keep live access — $89 for 30 days.`,
      );
    } catch {}
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generatePaymentRef() {
  // Short readable memo. Format: pls-<8 random alphanum chars>
  // Solana Memo program supports arbitrary bytes — keep short to leave room
  // for users to retype if their wallet UI mangles the auto-fill.
  return 'pls-' + randomBytes(6).toString('base64url').slice(0, 8).toLowerCase();
}

async function getSolPriceUsd() {
  if (_solPriceCache.price && Date.now() - _solPriceCache.fetchedAt < SOL_PRICE_CACHE_MS) {
    return _solPriceCache.price;
  }
  // Primary: Jupiter
  try {
    const res = await fetch(JUPITER_PRICE_URL, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      const j = await res.json();
      const price = Number(j?.data?.SOL?.price);
      if (price > 0) {
        _solPriceCache = { price, fetchedAt: Date.now() };
        return price;
      }
    }
  } catch {}
  // Fallback: CoinGecko
  try {
    const res = await fetch(COINGECKO_PRICE_URL, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      const j = await res.json();
      const price = Number(j?.solana?.usd);
      if (price > 0) {
        _solPriceCache = { price, fetchedAt: Date.now() };
        return price;
      }
    }
  } catch {}
  return _solPriceCache.price; // stale price is better than nothing
}
