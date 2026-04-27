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
