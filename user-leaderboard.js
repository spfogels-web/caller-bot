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

import { getPumpFunGraduationMcapUsd } from './helius-listener.js';

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

// Top calls (per CA, per caller) ranked by peak multiple — Phanes-style.
export function getTopCalls(db, timeframe = '1d', limit = 10) {
  const cutoff = TIMEFRAME_MAP[timeframe] || TIMEFRAME_MAP['7d'];
  try {
    return db.prepare(`
      SELECT
        user_id,
        COALESCE(username, first_name, user_id) AS display_name,
        token,
        contract_address,
        peak_multiple,
        mcap_at_call,
        peak_mcap,
        called_at
      FROM user_calls
      WHERE called_at > datetime('now', ?)
        AND peak_multiple IS NOT NULL
      ORDER BY peak_multiple DESC
      LIMIT ?
    `).all(cutoff, limit);
  } catch (err) {
    console.warn('[user-lb] top calls query:', err.message);
    return [];
  }
}

// Group stats — calls, hit rate, median return, total/avg return.
export function getRichGroupStats(db, timeframe = '1d') {
  const cutoff = TIMEFRAME_MAP[timeframe] || TIMEFRAME_MAP['7d'];
  try {
    const head = db.prepare(`
      SELECT
        COUNT(*) AS calls,
        COUNT(DISTINCT user_id) AS users,
        SUM(CASE WHEN peak_multiple >= 2 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN peak_multiple IS NOT NULL AND peak_multiple < 1 THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN peak_multiple IS NULL THEN 1 ELSE 0 END) AS pending,
        ROUND(AVG(peak_multiple), 2) AS avg_multiple,
        ROUND(MAX(peak_multiple), 2) AS best_multiple,
        ROUND(SUM(peak_multiple), 2) AS total_x
      FROM user_calls
      WHERE called_at > datetime('now', ?)
    `).get(cutoff);

    // Median across resolved peaks
    let median = null;
    try {
      const resolved = db.prepare(`
        SELECT peak_multiple FROM user_calls
        WHERE called_at > datetime('now', ?) AND peak_multiple IS NOT NULL
        ORDER BY peak_multiple ASC
      `).all(cutoff).map(r => r.peak_multiple);
      if (resolved.length) {
        const mid = Math.floor(resolved.length / 2);
        median = resolved.length % 2 === 0
          ? (resolved[mid - 1] + resolved[mid]) / 2
          : resolved[mid];
      }
    } catch {}

    const resolvedCount = (head?.wins ?? 0) + (head?.losses ?? 0);
    const hit_rate = resolvedCount > 0 ? Math.round((head.wins / resolvedCount) * 100) : null;
    return {
      ...head,
      median:   median != null ? +median.toFixed(2) : null,
      hit_rate,
    };
  } catch (err) {
    console.warn('[user-lb] rich stats:', err.message);
    return {};
  }
}

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

/**
 * Full profile for a single user — stats over all-time + last 10 calls.
 * Accepts numeric user_id, '@username', or plain username string.
 * Returns null if no calls exist for the resolved id.
 */
export function getUserProfileData(db, userIdOrUsername) {
  if (!userIdOrUsername) return null;
  let target = String(userIdOrUsername).trim();
  if (target.startsWith('@')) target = target.slice(1);

  // Try resolving username → user_id if the input wasn't already numeric
  let userId = target;
  if (!/^\d+$/.test(target) && target !== PULSE_USER_ID) {
    try {
      const row = db.prepare(
        `SELECT user_id FROM user_calls
         WHERE username = ? OR username = ?
         ORDER BY called_at DESC LIMIT 1`
      ).get(target, '@' + target);
      if (row) userId = row.user_id;
    } catch {}
  }

  let stats;
  try {
    stats = db.prepare(`
      SELECT
        COALESCE(MAX(username), MAX(first_name), user_id) AS display_name,
        COUNT(*) AS calls,
        SUM(CASE WHEN peak_multiple >= 2 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN peak_multiple IS NOT NULL AND peak_multiple < 1 THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN peak_multiple IS NULL THEN 1 ELSE 0 END) AS pending,
        ROUND(AVG(peak_multiple), 2) AS avg_multiple,
        ROUND(MAX(peak_multiple), 2) AS best_multiple,
        MIN(called_at) AS first_call
      FROM user_calls
      WHERE user_id = ?
    `).get(userId);
  } catch (err) {
    console.warn('[user-lb] profile stats:', err.message);
    return null;
  }
  if (!stats || !stats.calls) return null;

  let recent = [];
  try {
    recent = db.prepare(`
      SELECT contract_address, token, peak_multiple, called_at, mcap_at_call, peak_mcap
      FROM user_calls
      WHERE user_id = ?
      ORDER BY called_at DESC
      LIMIT 10
    `).all(userId);
  } catch {}

  let median = null;
  try {
    const peaks = db.prepare(`
      SELECT peak_multiple FROM user_calls
      WHERE user_id = ? AND peak_multiple IS NOT NULL
      ORDER BY peak_multiple ASC
    `).all(userId).map(r => r.peak_multiple);
    if (peaks.length) {
      const m = Math.floor(peaks.length / 2);
      median = peaks.length % 2 === 0 ? (peaks[m-1] + peaks[m]) / 2 : peaks[m];
    }
  } catch {}

  const resolved = (stats.wins ?? 0) + (stats.losses ?? 0);
  return {
    user_id: userId,
    display_name: stats.display_name,
    calls:        stats.calls,
    wins:         stats.wins ?? 0,
    losses:       stats.losses ?? 0,
    pending:      stats.pending ?? 0,
    hit_rate:     resolved > 0 ? Math.round(stats.wins * 100 / resolved) : null,
    avg_multiple: stats.avg_multiple,
    median:       median != null ? +median.toFixed(2) : null,
    best_multiple: stats.best_multiple,
    first_call:   stats.first_call,
    recent,
  };
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

function fmtSupply(n) {
  if (n == null || !Number.isFinite(Number(n))) return '?';
  const v = Number(n);
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toFixed(0) + 'B';
  if (v >= 1_000_000)     return (v / 1_000_000).toFixed(0) + 'M';
  if (v >= 1_000)         return (v / 1_000).toFixed(0) + 'K';
  return v.toFixed(0);
}

// Format a small price using subscript zeros: $0.0₂2388 instead of $0.000002388
function fmtPriceSub(price) {
  if (price == null || !Number.isFinite(Number(price))) return '?';
  const v = Number(price);
  if (v >= 1)      return '$' + v.toFixed(4);
  if (v >= 0.01)   return '$' + v.toFixed(4);
  // Count leading zeros after decimal
  const str = v.toFixed(20);
  const m = str.match(/^0\.(0+)(\d{1,4})/);
  if (!m) return '$' + v.toPrecision(4);
  const zeros = m[1].length;
  const digits = m[2];
  const subs = ['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉'];
  const subStr = String(zeros).split('').map(d => subs[+d]).join('');
  return `$0.0${subStr}${digits}`;
}

/**
 * Build a Phanes-style HTML card for a CA. Returns
 *   { caption, imageUrl } where imageUrl may be null.
 *   Caller decides whether to sendPhoto or sendMessage.
 *
 *   db          — better-sqlite3 instance (for Pulse-score + caller-stats lookups)
 *   ca          — the contract address
 *   heliusKey   — process.env.HELIUS_API_KEY
 *   escapeHtml  — server.js's escapeHtml fn (passed in to avoid circular import)
 *   postedBy    — optional { userId, username, firstName } for the "Called by" footer
 */
export async function buildCACard(db, ca, heliusKey, escapeHtml, postedBy = null) {
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
  if (!pair) return null;

  // 2. Helius getAsset — mint/freeze authority + supply + metadata
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

  // 3. Helius getTokenLargestAccounts — top 10 holder concentration
  let top10Pct = null;
  let totalSupply = null;
  if (heliusKey) {
    try {
      const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'top', method: 'getTokenLargestAccounts',
          params: [ca, { commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(6_000),
      });
      if (r.ok) {
        const j = await r.json();
        const accounts = j?.result?.value || [];
        const top10 = accounts.slice(0, 10).reduce((sum, a) => sum + Number(a.uiAmount || 0), 0);
        // Pull supply from getTokenSupply for percentage math
        const sr = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 'sup', method: 'getTokenSupply',
            params: [ca, { commitment: 'confirmed' }],
          }),
          signal: AbortSignal.timeout(6_000),
        });
        if (sr.ok) {
          const sj = await sr.json();
          totalSupply = Number(sj?.result?.value?.uiAmount || 0);
          if (totalSupply > 0) top10Pct = (top10 / totalSupply) * 100;
        }
      }
    } catch { /* skip */ }
  }

  // 4. Pulse's own analysis if we have one in the candidates table
  let pulseAnalysis = null;
  try {
    pulseAnalysis = db.prepare(`
      SELECT composite_score, final_decision, claude_verdict, setup_type
      FROM candidates
      WHERE contract_address = ?
      ORDER BY id DESC LIMIT 1
    `).get(ca);
  } catch { /* skip */ }

  // ── Pull fields ──
  const token       = pair.baseToken?.symbol  || '?';
  const name        = pair.baseToken?.name    || '';
  const ageMs       = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : null;
  const mcap        = pair.marketCap || pair.fdv;
  const liq         = pair.liquidity?.usd;
  const price       = Number(pair.priceUsd);
  const change1h    = pair.priceChange?.h1;
  const change24h   = pair.priceChange?.h24;
  const buys1h      = pair.txns?.h1?.buys  ?? 0;
  const sells1h     = pair.txns?.h1?.sells ?? 0;
  const vol24h      = pair.volume?.h24;
  // Image URL + bonding metadata: prefer DexScreener's pair.info.imageUrl,
  // then Helius DAS metadata, then pump.fun's API (catches fresh pump.fun
  // coins that DexScreener hasn't crawled yet — by far the most common
  // miss). Same pump.fun call also surfaces bonding curve progress for
  // the Bonding section below.
  let imageUrl = pair.info?.imageUrl || heliusMeta?.content?.links?.image || null;
  let pfData = null;
  try {
    const pf = await fetch(`https://frontend-api.pump.fun/coins/${ca}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5_000),
    });
    if (pf.ok) {
      pfData = await pf.json();
      if (!imageUrl) {
        const u = pfData?.image_uri || pfData?.image || null;
        if (u && /^https?:/.test(u)) imageUrl = u;
      }
    }
  } catch { /* skip — coin may not be on pump.fun */ }
  // Fourth fallback — DexScreener serves a generic token-icon CDN that often
  // works even when pair.info.imageUrl is null. Last-ditch before going text-only.
  if (!imageUrl) {
    imageUrl = `https://dd.dexscreener.com/ds-data/tokens/solana/${ca}.png`;
  }
  const websites    = pair.info?.websites || [];
  const socials     = pair.info?.socials  || [];

  // Security
  const auth        = heliusMeta?.authorities ?? [];
  const mintRevoked = !auth.some(a => (a.scopes || []).includes('full'));
  const isFrozen    = heliusMeta?.ownership?.frozen === true;

  // Caller stats (the "Called by" footer) — pulled from user_calls aggregate
  let callerStats = null;
  if (postedBy?.userId) {
    try {
      const row = db.prepare(`
        SELECT
          COUNT(*) AS calls,
          SUM(CASE WHEN peak_multiple >= 2 THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN peak_multiple IS NOT NULL AND peak_multiple < 1 THEN 1 ELSE 0 END) AS losses,
          ROUND(MAX(peak_multiple), 2) AS best
        FROM user_calls WHERE user_id = ?
      `).get(String(postedBy.userId));
      if (row && row.calls) {
        const resolved = (row.wins ?? 0) + (row.losses ?? 0);
        callerStats = {
          calls:    row.calls,
          winRate:  resolved > 0 ? Math.round((row.wins / resolved) * 100) : null,
          best:     row.best,
        };
      }
    } catch {}
  }

  // ── Compose caption (Phanes-style sectioned layout) ──
  const lines = [];
  // Header: ✅ Call for TokenName ($TICKER) | 🟣 SOL
  lines.push(`✅ <b>Call for</b> <b>${name ? safe(name).slice(0, 28) : safe(token)}</b> ($<b>${safe(token)}</b>)  |  🟣 <b>SOL</b>`);
  lines.push(`💰 <code>${safe(ca)}</code>`);
  lines.push('');

  // Stats — full Phanes-style with all granular fields
  lines.push(`📈 <b>Stats</b>`);
  if (price != null && Number.isFinite(price)) lines.push(`┣ Price: ${fmtPriceSub(price)}`);
  if (mcap   != null) lines.push(`┣ MC: <b>${fmtMcap(mcap)}</b>`);
  if (liq    != null) lines.push(`┣ LP: ${fmtMcap(liq)}`);
  if (vol24h != null) lines.push(`┣ Vol: ${fmtMcap(vol24h)} · Age: ${fmtAge(ageMs)}`);
  // 5m / 1h / 24h price changes with colored circles
  const changeRow = (() => {
    const fmt = (lbl, p) => {
      if (p == null) return null;
      const dot = p > 0 ? '🟢' : p < 0 ? '🔴' : '⚪';
      return `${lbl}: ${fmtPct(p, 0)} ${dot}`;
    };
    const parts = [fmt('5M', pair.priceChange?.m5), fmt('1H', change1h), fmt('24H', change24h)].filter(Boolean);
    return parts.join(' | ');
  })();
  if (changeRow) lines.push(`┣ ${changeRow}`);
  if (buys1h || sells1h) lines.push(`┗ 1H Txns: 🟢 ${buys1h} 🔴 ${sells1h}`);

  // Bonding curve (pump.fun lifecycle) — only render when we got pump.fun
  // data back, since most non-pump.fun launches won't have this. Shows the
  // % toward graduation for PRE_BOND coins, "MIGRATED" status for graduates,
  // and the King-of-the-Hill flag if applicable.
  if (pfData) {
    const usdMc       = Number(pfData.usd_market_cap ?? 0);
    const isComplete  = pfData.complete === true;
    // Pump.fun graduation threshold: SOL-denominated upstream so it floats.
    // Sourced from helius-listener.js's env-overridable helper.
    const GRAD_MCAP   = getPumpFunGraduationMcapUsd();
    const bondingPct  = !isComplete && usdMc > 0 ? Math.min(100, (usdMc / GRAD_MCAP) * 100) : (isComplete ? 100 : null);
    const replyCount  = pfData.reply_count ?? 0;
    const isKOTH      = !!pfData.king_of_the_hill_timestamp;
    lines.push('');
    lines.push(`🎯 <b>Bonding</b>`);
    if (isComplete) {
      lines.push(`┣ Status: ✅ <b>MIGRATED</b> to Raydium`);
      lines.push(`┗ Replies: ${replyCount}${isKOTH ? ' · 👑 KOTH' : ''}`);
    } else if (bondingPct != null) {
      const bar = (() => {
        const filled = Math.round((bondingPct / 100) * 12);
        return '🟩'.repeat(filled) + '⬜'.repeat(12 - filled);
      })();
      lines.push(`┣ Status: 🟠 <b>PRE-BOND</b> (${bondingPct.toFixed(1)}%)`);
      lines.push(`┣ ${bar}`);
      lines.push(`┣ Goal: $${(usdMc / 1000).toFixed(1)}K / $${(GRAD_MCAP / 1000).toFixed(0)}K`);
      lines.push(`┗ Replies: ${replyCount}${isKOTH ? ' · 👑 KOTH' : ''}`);
    }
  }

  // Security
  lines.push('');
  lines.push(`🔒 <b>Security</b>`);
  lines.push(`┣ Renounced: ${mintRevoked ? '⚪ Mint 🟢 Freeze 🟢' : 'Mint 🔴 Freeze ' + (isFrozen ? '🔴' : '🟢')}`);
  if (top10Pct != null) lines.push(`┣ Top 10: ${top10Pct.toFixed(1)}%${totalSupply ? ` · Sup: ${fmtSupply(totalSupply)}` : ''}`);
  lines.push(`┗ DEX Paid: ${pair.boosts?.active > 0 ? '🟢' : '⚪'}`);

  // Links
  let twitterHandle = null;
  if (websites.length || socials.length) {
    lines.push('');
    lines.push(`🔗 <b>Links</b>`);
    const linkRow = [];
    for (const w of websites.slice(0, 2)) if (w.url) linkRow.push(`🌐 <a href="${w.url}">Web</a>`);
    for (const s of socials) {
      if (s.url) {
        const t = (s.type || '').toLowerCase();
        const ic = t.includes('twitter') || t === 'x' ? '🐦' : t.includes('telegram') ? '💬' : '🔗';
        linkRow.push(`${ic} <a href="${s.url}">${safe(s.type || 'Link')}</a>`);
        // Capture the X/Twitter handle for profile lookup below
        if ((t.includes('twitter') || t === 'x') && !twitterHandle) {
          const m = s.url.match(/(?:twitter\.com|x\.com)\/(@?[A-Za-z0-9_]{1,32})/i);
          if (m) twitterHandle = m[1].replace(/^@/, '');
        }
      }
    }
    if (linkRow.length) lines.push(`┗ ${linkRow.join(' | ')}`);
  }

  // ── X / Twitter profile intel (only fires when X_BEARER_TOKEN is set
  //    AND we extracted a handle from the coin's socials). Cached 30min
  //    per handle in x-api.js so repeated card builds don't re-bill.
  if (twitterHandle && process.env.X_BEARER_TOKEN) {
    try {
      const { getUserByUsername, fmtAccountAge } = await import('./x-api.js');
      const xp = await getUserByUsername(twitterHandle);
      if (xp) {
        const followersFmt = (() => {
          const n = xp.followers || 0;
          if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
          if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
          return String(n);
        })();
        const verifiedTag = xp.verified
          ? (xp.verifiedType === 'business' ? ' 💼' : xp.verifiedType === 'government' ? ' 🏛' : ' ☑️')
          : '';
        lines.push('');
        lines.push(`🐦 <b>Twitter</b>`);
        lines.push(`┣ <a href="https://x.com/${safe(xp.username)}">@${safe(xp.username)}</a>${verifiedTag}`);
        lines.push(`┣ Followers: <b>${followersFmt}</b> · Age: <b>${fmtAccountAge(xp.createdAt)}</b>`);
        lines.push(`┗ Tweets: ${xp.tweetCount.toLocaleString()}`);
      }
    } catch { /* X API down or budget hit — skip silently */ }
  }

  // Charts row — clickable links to popular Solana chart/trade UIs
  lines.push('');
  lines.push(`📊 <b>Charts</b>`);
  lines.push(`┗ <a href="https://dexscreener.com/solana/${ca}">DS</a> | <a href="https://www.dextools.io/app/en/solana/pair-explorer/${ca}">DT</a> | <a href="https://photon-sol.tinyastro.io/en/lp/${ca}">PHO</a> | <a href="https://gmgn.ai/sol/token/${ca}">GMG</a> | <a href="https://birdeye.so/token/${ca}?chain=solana">BIRD</a>`);

  // Pulse score (highlighted — our edge over Phanes)
  if (pulseAnalysis?.composite_score != null) {
    lines.push('');
    const s = pulseAnalysis.composite_score;
    const dec = pulseAnalysis.final_decision || '?';
    const setup = pulseAnalysis.setup_type ? ` · ${safe(pulseAnalysis.setup_type)}` : '';
    lines.push(`🧠 <b>Pulse Score: ${s}/100</b> · ${safe(dec)}${setup}`);
  }

  // Called-by footer with tier badge, win-rate emoji, stats + Profile link.
  // Tier rules (call_count, win_rate combo) — easy to scan, encourages
  // improvement, mirrors how Sect/Phanes badge their callers.
  if (postedBy?.userId) {
    const callerName = postedBy.username
      ? '@' + safe(postedBy.username)
      : safe(postedBy.firstName || 'anon');
    const isPulse = String(postedBy.userId) === PULSE_USER_ID;
    const profileLink = isPulse
      ? null
      : (/^\d+$/.test(String(postedBy.userId))
          ? `<a href="tg://user?id=${postedBy.userId}">Profile</a>`
          : null);

    const tierFor = (calls, winRate) => {
      if (isPulse) return { icon: '⚡', label: 'Bot' };
      if (calls == null || calls < 4) return { icon: '🌱', label: 'Rookie' };
      const wr = winRate ?? 0;
      if (calls >= 50) {
        if (wr >= 60) return { icon: '👑', label: 'Master' };
        if (wr >= 40) return { icon: '🏆', label: 'Veteran' };
        return { icon: '⚠️', label: 'Risky' };
      }
      if (calls >= 20) {
        if (wr >= 40) return { icon: '💎', label: 'Pro' };
        return { icon: '🎰', label: 'Degen' };
      }
      // 4–19 calls
      if (wr >= 50) return { icon: '🎯', label: 'Sharpshooter' };
      return { icon: '🎲', label: 'Gamble' };
    };
    const wrEmoji = (wr) => {
      if (wr == null) return '';
      if (wr >= 70) return ' 🔥';
      if (wr >= 50) return ' ✨';
      if (wr >= 30) return ' 💀';
      return ' 📉';
    };

    lines.push('');
    lines.push(`👤 <b>Called by</b> ${isPulse ? '⚡ <b>Pulse</b>' : callerName}`);
    if (callerStats) {
      const tier = tierFor(callerStats.calls, callerStats.winRate);
      const wrTxt = callerStats.winRate != null
        ? Number(callerStats.winRate).toFixed(2) + '%'
        : '—';
      lines.push(`┣ ${tier.icon} <b>${safe(tier.label)}</b>`);
      lines.push(`┣ Win Rate: <b>${wrTxt}</b>${wrEmoji(callerStats.winRate)}`);
      lines.push(`┣ Calls: <b>${callerStats.calls}</b>`);
    } else {
      const tier = tierFor(0, null);
      lines.push(`┣ ${tier.icon} <b>${safe(tier.label)}</b>`);
      lines.push(`┣ <i>First call from this user</i>`);
    }
    if (profileLink) lines.push(`┗ ${profileLink}`);
  }

  // Inline keyboard: tap "Get P&L Card" → callback fires user's profile.
  // Only shown when we have a non-Pulse user_id we can route to.
  let replyMarkup = null;
  if (postedBy?.userId && String(postedBy.userId) !== PULSE_USER_ID) {
    replyMarkup = {
      inline_keyboard: [[
        { text: '📊 Get P&L Card', callback_data: `pnl:${postedBy.userId}` },
      ]],
    };
  } else if (postedBy?.userId === PULSE_USER_ID || String(postedBy?.userId) === PULSE_USER_ID) {
    replyMarkup = {
      inline_keyboard: [[
        { text: '⚡ Pulse Stats', callback_data: `pnl:${PULSE_USER_ID}` },
      ]],
    };
  }

  return { caption: lines.join('\n'), imageUrl, replyMarkup };
}

/**
 * Render a profile P&L card as HTML for inline keyboard callbacks.
 * Mirrors the /profile command output. Pass `escapeHtml` from server.js.
 */
export function renderProfileCardHtml(profile, escapeHtml) {
  const safe = (s) => escapeHtml ? escapeHtml(String(s)) : String(s).replace(/[<>&]/g, '');
  if (!profile) {
    return `<i>No call history yet for this user.</i>`;
  }
  const isPulse = profile.user_id === PULSE_USER_ID;
  const headerName = isPulse
    ? '⚡ <b>Pulse Caller</b>'
    : `<b>${safe(profile.display_name || 'anon').slice(0, 24)}</b>`;
  const emojiFor = (mult) => {
    if (mult == null)    return '🤔';
    if (mult >= 5)       return '🚀';
    if (mult >= 3)       return '🤩';
    if (mult >= 1.5)     return '😎';
    if (mult >= 1)       return '🙂';
    return '😞';
  };
  const fmtAgo = (ts) => {
    if (!ts) return '?';
    const ms = Date.now() - new Date(ts.includes('Z') ? ts : ts + 'Z').getTime();
    if (ms < 60_000) return Math.floor(ms / 1000) + 's ago';
    if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
    if (ms < 86_400_000) return (ms / 3_600_000).toFixed(1) + 'h ago';
    return Math.floor(ms / 86_400_000) + 'd ago';
  };
  let msg = `📊 <b>P&L CARD</b> — ${headerName}\n\n` +
            `📈 <b>All-Time Stats</b>\n` +
            `┣ Calls       <b>${profile.calls}</b>\n` +
            `┣ 🏆 Wins     <b>${profile.wins}</b>\n` +
            `┣ 💀 Losses   <b>${profile.losses}</b>\n` +
            `┣ ⏳ Pending  <b>${profile.pending}</b>\n` +
            `┣ Win Rate    <b>${profile.hit_rate != null ? profile.hit_rate + '%' : '—'}</b>\n` +
            `┣ Median      <b>${profile.median != null ? profile.median.toFixed(2) + 'x' : '—'}</b>\n` +
            `┣ Best        <b>${profile.best_multiple != null ? profile.best_multiple.toFixed(2) + 'x' : '—'}</b>\n` +
            `┗ Avg         <b>${profile.avg_multiple != null ? profile.avg_multiple.toFixed(2) + 'x' : '—'}</b>\n\n`;
  if (profile.recent && profile.recent.length > 0) {
    msg += `🏆 <b>Recent Calls</b>\n<blockquote>`;
    profile.recent.forEach((c) => {
      const tokLabel = c.token ? safe(c.token).slice(0, 14) : c.contract_address.slice(0, 6);
      const tok = c.contract_address
        ? `<a href="https://dexscreener.com/solana/${c.contract_address}">${tokLabel}</a>`
        : tokLabel;
      const mult = c.peak_multiple != null ? `<b>[${c.peak_multiple.toFixed(2)}x]</b>` : '<i>pending</i>';
      msg += `${emojiFor(c.peak_multiple)} 🪙 <b>${tok}</b>  ${mult}  <i>${fmtAgo(c.called_at)}</i>\n`;
    });
    msg += `</blockquote>`;
  }
  return msg;
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
