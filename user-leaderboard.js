/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  user-leaderboard.js — Phanes-style group leaderboard for CA drops
 *
 *  Listens to every text message in the Telegram group; when a message
 *  contains a valid Solana contract address, records:
 *     (user_id, username, contract_address, mcap_at_call, posted_at)
 *
 *  Periodically refreshes peak_mcap / peak_multiple via DexScreener.
 *  /grouplb returns top users by best multiple + win rate over a window.
 *
 *  Pulse's own auto-post CA beacons are recorded too — Pulse appears
 *  alongside human users on the same leaderboard.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

// Base58 alphabet excludes 0/O/I/l. Solana addresses are 32-44 chars
// (mostly 43-44). The regex catches embedded CAs in any message text.
const SOLANA_CA_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

// Special pseudo-user-id for Pulse's own posts so the bot can rank
// alongside human users.
export const PULSE_USER_ID   = 'PULSE_BOT';
export const PULSE_USERNAME  = 'PulseCaller';

export function ensureUserLeaderboardSchema(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_calls (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id          TEXT NOT NULL,
        username         TEXT,
        first_name       TEXT,
        contract_address TEXT NOT NULL,
        token            TEXT,
        called_at        TEXT DEFAULT (datetime('now')),
        mcap_at_call     REAL,
        peak_mcap        REAL,
        peak_multiple    REAL,
        last_checked_at  TEXT,
        chat_id          TEXT,
        message_id       INTEGER,
        UNIQUE(user_id, contract_address)
      );
      CREATE INDEX IF NOT EXISTS idx_uc_user ON user_calls(user_id);
      CREATE INDEX IF NOT EXISTS idx_uc_at   ON user_calls(called_at DESC);
      CREATE INDEX IF NOT EXISTS idx_uc_ca   ON user_calls(contract_address);
      CREATE INDEX IF NOT EXISTS idx_uc_check ON user_calls(last_checked_at ASC);
    `);
  } catch (err) {
    console.warn('[user-lb] schema:', err.message);
  }
}

export function extractCAsFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(SOLANA_CA_REGEX) || [];
  // Solana addresses skew long (43-44 chars); filter very short matches that
  // are usually noise (transaction sigs are often 88 chars; we miss those
  // intentionally — looking specifically for token addresses).
  return [...new Set(matches)].filter(s => s.length >= 32 && s.length <= 44);
}

/**
 * Insert a user-call record. Deduped per (user_id, contract_address) — only
 * the first time a user posts a given CA counts. Returns true if inserted,
 * false if already existed.
 */
export function recordUserCall(db, opts) {
  const {
    userId, username = null, firstName = null,
    contractAddress, token = null, mcap = null,
    chatId = null, messageId = null,
  } = opts;
  if (!userId || !contractAddress) return false;
  try {
    const info = db.prepare(`
      INSERT OR IGNORE INTO user_calls
        (user_id, username, first_name, contract_address, token, mcap_at_call, chat_id, message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, username, firstName, contractAddress, token, mcap, chatId, messageId);
    return info.changes > 0;
  } catch (err) {
    console.warn(`[user-lb] insert failed for ${userId} / ${contractAddress?.slice(0,8)}: ${err.message}`);
    return false;
  }
}

/**
 * Refresh peak_mcap / peak_multiple for stale rows. `fetchMcap(ca)` is an
 * injected function that returns { marketCap } or null. Called every ~5min.
 */
export async function refreshPeaks(db, fetchMcap, batchSize = 60) {
  if (!fetchMcap) return { checked: 0, updated: 0 };
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT id, contract_address, mcap_at_call, peak_mcap
      FROM user_calls
      WHERE mcap_at_call IS NOT NULL AND mcap_at_call > 0
        AND (last_checked_at IS NULL OR last_checked_at < datetime('now', '-5 minutes'))
      ORDER BY last_checked_at ASC NULLS FIRST
      LIMIT ?
    `).all(batchSize);
  } catch (err) {
    console.warn('[user-lb] refresh query:', err.message);
    return { checked: 0, updated: 0 };
  }
  if (rows.length === 0) return { checked: 0, updated: 0 };

  const update = db.prepare(`
    UPDATE user_calls
    SET peak_mcap = ?, peak_multiple = ?, last_checked_at = datetime('now')
    WHERE id = ?
  `);
  let updated = 0;
  for (const r of rows) {
    try {
      const data = await fetchMcap(r.contract_address);
      if (!data || data.marketCap == null) continue;
      const currentMcap = Number(data.marketCap);
      if (!Number.isFinite(currentMcap) || currentMcap <= 0) continue;
      const newPeak = Math.max(Number(r.peak_mcap) || 0, currentMcap);
      const peakMult = newPeak / r.mcap_at_call;
      update.run(newPeak, +peakMult.toFixed(4), r.id);
      updated++;
    } catch { /* skip */ }
  }
  return { checked: rows.length, updated };
}

const TIMEFRAME_MAP = {
  '24h': "-1 day",
  '7d':  "-7 days",
  '30d': "-30 days",
  'all': "-100 years",
};

export function getGroupLeaderboard(db, timeframe = '7d') {
  const cutoff = TIMEFRAME_MAP[timeframe] || TIMEFRAME_MAP['7d'];
  try {
    const rows = db.prepare(`
      SELECT
        user_id,
        COALESCE(MAX(username), MAX(first_name), user_id) AS display_name,
        COUNT(*) AS total_calls,
        SUM(CASE WHEN peak_multiple >= 2 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN peak_multiple IS NOT NULL AND peak_multiple < 1 THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN peak_multiple IS NULL THEN 1 ELSE 0 END) AS pending,
        ROUND(AVG(peak_multiple), 2) AS avg_multiple,
        ROUND(MAX(peak_multiple), 2) AS best_multiple
      FROM user_calls
      WHERE called_at > datetime('now', ?)
      GROUP BY user_id
      HAVING total_calls >= 1
      ORDER BY
        CASE WHEN best_multiple IS NULL THEN 1 ELSE 0 END,
        best_multiple DESC,
        wins DESC,
        total_calls DESC
      LIMIT 20
    `).all(cutoff);

    // Compute hit rate (wins / resolved) per row
    return rows.map(r => {
      const resolved = (r.wins ?? 0) + (r.losses ?? 0);
      return {
        ...r,
        hit_rate_pct: resolved > 0 ? Math.round((r.wins / resolved) * 100) : null,
      };
    });
  } catch (err) {
    console.warn('[user-lb] leaderboard query:', err.message);
    return [];
  }
}

export function getGroupStats(db, timeframe = '7d') {
  const cutoff = TIMEFRAME_MAP[timeframe] || TIMEFRAME_MAP['7d'];
  try {
    return db.prepare(`
      SELECT
        COUNT(DISTINCT user_id) AS users,
        COUNT(*) AS calls,
        SUM(CASE WHEN peak_multiple >= 2 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN peak_multiple IS NOT NULL AND peak_multiple < 1 THEN 1 ELSE 0 END) AS losses,
        ROUND(AVG(peak_multiple), 2) AS avg_multiple,
        ROUND(MAX(peak_multiple), 2) AS best_multiple
      FROM user_calls
      WHERE called_at > datetime('now', ?)
    `).get(cutoff);
  } catch (err) {
    console.warn('[user-lb] group stats:', err.message);
    return { users: 0, calls: 0, wins: 0, losses: 0 };
  }
}

export function getUserCallsCount(db) {
  try { return db.prepare(`SELECT COUNT(*) as n FROM user_calls`).get().n; }
  catch { return 0; }
}

// ─── CA-drop auto-reply card (replaces Phanes) ───────────────────────────────

const _cardReplyDedupe = new Map(); // `${chatId}:${ca}` → epoch ms of last reply
const CARD_DEDUPE_MS = 5 * 60 * 1000;

function fmtMcap(n) {
  if (n == null || !Number.isFinite(Number(n))) return '?';
  const v = Number(n);
  if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000)     return '$' + (v / 1_000).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}
function fmtPct(n, decimals = 1) {
  if (n == null || !Number.isFinite(Number(n))) return '?';
  const v = Number(n);
  return (v >= 0 ? '+' : '') + v.toFixed(decimals) + '%';
}
function fmtAge(ms) {
  if (!ms || !Number.isFinite(ms)) return '?';
  const sec = Math.floor(ms / 1000);
  if (sec < 60)        return sec + 's';
  const min = Math.floor(sec / 60);
  if (min < 60)        return min + 'm';
  const hr  = min / 60;
  if (hr  < 24)        return hr.toFixed(1) + 'h';
  return Math.floor(hr / 24) + 'd';
}

/**
 * Build a Phanes-style HTML card for a CA. Returns null if essential data
 * can't be fetched. Caller is responsible for sending the reply.
 *
 *   db          — better-sqlite3 instance (for Pulse-score lookup in candidates table)
 *   ca          — the contract address
 *   heliusKey   — process.env.HELIUS_API_KEY
 *   escapeHtml  — server.js's escapeHtml fn (passed in to avoid circular import)
 */
export async function buildCACard(db, ca, heliusKey, escapeHtml) {
  if (!ca) return null;
  const safe = (s) => escapeHtml ? escapeHtml(String(s)) : String(s).replace(/[<>&]/g, '');

  // 1. DexScreener — primary source for MCap, vol, price, security flags
  let pair = null;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, {
      signal: AbortSignal.timeout(6_000),
    });
    if (r.ok) {
      const j = await r.json();
      pair = (j.pairs || []).find(p => p.chainId === 'solana');
    }
  } catch { /* skip */ }
  if (!pair) return null;  // can't even price it → not a useful card

  // 2. Helius — mint authority, freeze authority, supply
  let heliusMeta = null;
  if (heliusKey) {
    try {
      const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'asset', method: 'getAsset',
          params: { id: ca },
        }),
        signal: AbortSignal.timeout(6_000),
      });
      if (r.ok) heliusMeta = (await r.json())?.result;
    } catch { /* skip */ }
  }

  // 3. Pulse's own analysis if we have one in the candidates table
  let pulseAnalysis = null;
  try {
    pulseAnalysis = db.prepare(`
      SELECT composite_score, final_decision, claude_verdict, setup_type
      FROM candidates
      WHERE contract_address = ?
      ORDER BY id DESC LIMIT 1
    `).get(ca);
  } catch { /* skip */ }

  // ── Compose the card ──
  const token   = pair.baseToken?.symbol  || '?';
  const name    = pair.baseToken?.name    || '';
  const ageMs   = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : null;
  const mcap    = pair.marketCap || pair.fdv;
  const liq     = pair.liquidity?.usd;
  const price   = pair.priceUsd;
  const change1h = pair.priceChange?.h1;
  const change24h = pair.priceChange?.h24;
  const buys1h  = pair.txns?.h1?.buys  ?? 0;
  const sells1h = pair.txns?.h1?.sells ?? 0;
  const vol24h  = pair.volume?.h24;

  // Security flags from Helius getAsset
  const auth         = heliusMeta?.authorities ?? [];
  const mintRevoked  = !auth.some(a => (a.scopes || []).includes('full'));
  const ownership    = heliusMeta?.ownership || {};
  const isFrozen     = ownership.frozen === true;

  let lines = [];
  lines.push(`🪙 <b>$${safe(token)}</b>${name ? ' <i>(' + safe(name).slice(0, 24) + ')</i>' : ''}`);
  lines.push(`<code>${safe(ca)}</code>`);
  lines.push(`#SOL · 🌱 ${fmtAge(ageMs)}`);
  lines.push('');
  lines.push(`📊 <b>Stats</b>`);
  if (price != null)   lines.push(`├ Price  $${Number(price).toPrecision(4)} <i>${fmtPct(change24h)} 24h</i>`);
  if (mcap  != null)   lines.push(`├ MCap   <b>${fmtMcap(mcap)}</b>`);
  if (vol24h != null)  lines.push(`├ Vol    ${fmtMcap(vol24h)} <i>24h</i>`);
  if (liq   != null)   lines.push(`├ LP     ${fmtMcap(liq)}`);
  if (buys1h || sells1h) lines.push(`└ 1H     ${fmtPct(change1h)} · 🟢 ${buys1h} 🔴 ${sells1h}`);
  lines.push('');
  lines.push(`🔒 <b>Security</b>`);
  lines.push(`├ Mint    ${mintRevoked ? '✓ revoked' : '⚠️ active'}`);
  lines.push(`└ Freeze  ${isFrozen ? '⚠️ frozen!' : '✓ none'}`);

  if (pulseAnalysis?.composite_score != null) {
    lines.push('');
    const s = pulseAnalysis.composite_score;
    const dec = pulseAnalysis.final_decision || '?';
    const setup = pulseAnalysis.setup_type ? ` · ${safe(pulseAnalysis.setup_type)}` : '';
    lines.push(`🧠 <b>Pulse: ${s}/100</b> · ${safe(dec)}${setup}`);
  }

  // Quick links
  lines.push('');
  const dexLink   = pair.url || `https://dexscreener.com/solana/${ca}`;
  const pumpLink  = `https://pump.fun/coin/${ca}`;
  const birdLink  = `https://birdeye.so/token/${ca}?chain=solana`;
  const solscanLink = `https://solscan.io/token/${ca}`;
  lines.push(`<a href="${dexLink}">DEX</a> · <a href="${pumpLink}">PUMP</a> · <a href="${birdLink}">BIRD</a> · <a href="${solscanLink}">SCAN</a>`);

  return lines.join('\n');
}

/**
 * Returns true if we should reply with a card for this (chatId, ca) — false
 * if we already replied within the dedupe window.
 */
export function shouldReplyCard(chatId, ca) {
  const key = `${chatId}:${ca}`;
  const last = _cardReplyDedupe.get(key);
  if (last && Date.now() - last < CARD_DEDUPE_MS) return false;
  _cardReplyDedupe.set(key, Date.now());
  // Periodic cleanup: keep map under 1000 entries
  if (_cardReplyDedupe.size > 1000) {
    const cutoff = Date.now() - CARD_DEDUPE_MS;
    for (const [k, t] of _cardReplyDedupe) if (t < cutoff) _cardReplyDedupe.delete(k);
  }
  return true;
}
