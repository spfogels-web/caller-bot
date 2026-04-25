/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  whale-funding-tracker.js — catch whales funding burner wallets
 *
 *  Every 15 min:
 *   1. Pick top N whales from tracked_wallets (WINNER tier, sol_balance ≥ 50,
 *      seen active in the last 30 days)
 *   2. For each, hit Solscan's account-transfer endpoint for OUTGOING SOL
 *      transfers in the last 24h
 *   3. For each recipient:
 *        - NEW wallet → insert with category='WHALE_FUNDED'
 *        - EXISTING  → leave category, tag via whale_funding_events log
 *   4. Every transfer is recorded in whale_funding_events (funder, recipient,
 *      amount_sol, tx_sig UNIQUE, detected_at) — scorer uses this table to
 *      check "was any holder freshly funded by a whale in the last 48h?"
 *
 *  Signal value: whales fund fresh wallets only to trade with them. If that
 *  freshly-funded wallet then shows up as a holder of a new coin within
 *  hours, it's a near-real-time "whale is buying X through a burner" signal.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const SOLSCAN_BASE       = 'https://pro-api.solscan.io/v2.0';
const TICK_MS            = 15 * 60 * 1000;        // 15min
const BOOT_DELAY_MS      = 3 * 60 * 1000;         // 3min after boot
const TOP_WHALES         = 50;                     // top N per tick
const MIN_WHALE_SOL      = 50;
const LOOKBACK_HOURS     = 24;
const REQUEST_TIMEOUT_MS = 9_000;
const RATE_DELAY_MS      = 250;                    // 4 req/sec
const MIN_FUND_AMOUNT    = 0.1;                    // ignore tiny dust transfers (rent etc.)

// WSOL mint — Solscan returns this for wrapped-SOL transfers; for native SOL
// the token_address is typically empty or the native system program.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

let _tickTimer = null;
let _stats = {
  runsCompleted:        0,
  whalesScanned:        0,
  eventsRecorded:       0,
  newWalletsFunded:     0,
  lastRunAt:            null,
  lastError:            null,
};

export function ensureWhaleFundingSchema(dbInstance) {
  try {
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS whale_funding_events (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        funder_wallet    TEXT NOT NULL,
        recipient_wallet TEXT NOT NULL,
        amount_sol       REAL NOT NULL,
        tx_sig           TEXT UNIQUE,
        detected_at      TEXT DEFAULT (datetime('now')),
        funder_category  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wfe_recipient ON whale_funding_events(recipient_wallet, detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_wfe_funder    ON whale_funding_events(funder_wallet,    detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_wfe_at        ON whale_funding_events(detected_at DESC);
    `);
  } catch (err) { console.warn('[whale-funding] schema:', err.message); }
}

async function solscanFetchOutgoingTransfers(address, apiKey) {
  // Pro v2 filter: flow=out + block_time >= <lookback ts>
  // activity_type covers native SOL + SPL transfers
  const sinceTs = Math.floor((Date.now() - LOOKBACK_HOURS * 3_600_000) / 1000);
  const url = `${SOLSCAN_BASE}/account/transfer`
            + `?address=${encodeURIComponent(address)}`
            + `&flow=out`
            + `&block_time[]=${sinceTs}`
            + `&page=1&page_size=100`
            + `&sort_by=block_time&sort_order=desc`;
  try {
    const res = await fetch(url, {
      headers: { token: apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 429) { await sleep(5_000); return []; }
    if (!res.ok) return [];
    const json = await res.json();
    const items = json?.data ?? [];
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

// Filter for native-SOL OR WSOL transfers only. Skip SPL token transfers —
// those don't represent "I'm funding you to trade" behavior.
function isSolFunding(row) {
  const tokenAddr = (row.token_address || row.tokenAddress || row.mint || '').trim();
  const amount    = Number(row.amount || row.amount_sol || 0);
  if (amount < MIN_FUND_AMOUNT) return false;
  return tokenAddr === '' || tokenAddr === WSOL_MINT || tokenAddr.toLowerCase() === 'native';
}

function normalizeAmount(row) {
  // Solscan returns amounts in lamports for native SOL; WSOL already UI-adjusted
  const raw = Number(row.amount || row.amount_sol || 0);
  const tokenAddr = (row.token_address || row.mint || '').trim();
  if (tokenAddr === WSOL_MINT) return raw;     // already in SOL units
  if (raw > 1e6) return raw / 1e9;             // looks like lamports
  return raw;
}

function upsertFundedWallet(dbInstance, recipient, funder, amount, funderCategory) {
  try {
    const existing = dbInstance.prepare(
      `SELECT id, category FROM tracked_wallets WHERE address = ?`
    ).get(recipient);

    if (!existing) {
      dbInstance.prepare(`
        INSERT INTO tracked_wallets (address, category, source, last_seen, added_by, updated_at, notes)
        VALUES (?, 'WHALE_FUNDED', 'whale-funding-tracker', datetime('now'), 'auto', datetime('now'), ?)
      `).run(recipient, `Funded by whale ${funder.slice(0,8)}… (${funderCategory || 'WINNER'}) with ${amount.toFixed(2)} SOL`);
      _stats.newWalletsFunded++;
      return { added: true };
    }

    // Don't overwrite stronger categories — just refresh last_seen + add a note
    dbInstance.prepare(`
      UPDATE tracked_wallets
      SET last_seen  = datetime('now'),
          updated_at = datetime('now'),
          notes      = COALESCE(notes, '') || ' | whale-funded ' || datetime('now') || ' by ' || substr(?, 1, 8)
      WHERE id = ?
    `).run(funder, existing.id);
    return { added: false };
  } catch (err) {
    console.warn(`[whale-funding] upsert ${recipient.slice(0,8)}: ${err.message}`);
    return { added: false };
  }
}

async function runWhaleFundingTick(dbInstance, solscanKey) {
  try {
    ensureWhaleFundingSchema(dbInstance);
    if (!solscanKey) { _stats.lastError = 'No SOLSCAN_API_KEY'; return; }

    const whales = dbInstance.prepare(`
      SELECT address, category, sol_balance
      FROM tracked_wallets
      WHERE category = 'WINNER'
        AND sol_balance >= ?
        AND (last_seen IS NULL OR last_seen > datetime('now', '-30 days'))
      ORDER BY sol_balance DESC
      LIMIT ?
    `).all(MIN_WHALE_SOL, TOP_WHALES);

    if (whales.length === 0) {
      console.log('[whale-funding] no qualifying whales (need ≥50 SOL WINNER)');
      _stats.runsCompleted++;
      _stats.lastRunAt = new Date().toISOString();
      return;
    }
    console.log(`[whale-funding] scanning ${whales.length} whales for recent funding activity...`);

    let eventsRecorded = 0, newFunded = 0, errors = 0;

    const insertEvent = dbInstance.prepare(`
      INSERT OR IGNORE INTO whale_funding_events
        (funder_wallet, recipient_wallet, amount_sol, tx_sig, funder_category)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const whale of whales) {
      const transfers = await solscanFetchOutgoingTransfers(whale.address, solscanKey);
      if (transfers.length === 0) { await sleep(RATE_DELAY_MS); continue; }

      for (const row of transfers) {
        if (!isSolFunding(row)) continue;
        const to       = (row.to_address || row.to || '').toString();
        const from     = (row.from_address || row.from || '').toString();
        if (!to || to === from || to === whale.address) continue;
        const txSig    = (row.trans_id || row.tx_sig || row.signature || row.txHash || '').toString();
        const amount   = normalizeAmount(row);
        if (amount < MIN_FUND_AMOUNT) continue;

        try {
          const info = insertEvent.run(whale.address, to, amount, txSig || null, whale.category);
          if (info.changes > 0) {
            eventsRecorded++;
            const r = upsertFundedWallet(dbInstance, to, whale.address, amount, whale.category);
            if (r.added) newFunded++;
          }
        } catch { errors++; }
      }

      await sleep(RATE_DELAY_MS);
    }

    _stats.whalesScanned    = whales.length;
    _stats.eventsRecorded  += eventsRecorded;
    _stats.runsCompleted++;
    _stats.lastRunAt        = new Date().toISOString();
    _stats.lastError        = null;
    console.log(`[whale-funding] ✓ tick complete — ${eventsRecorded} new events, ${newFunded} new WHALE_FUNDED wallets, ${errors} errors`);
  } catch (err) {
    console.error('[whale-funding] tick error:', err.message);
    _stats.lastError = err.message;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function startWhaleFundingTracker(dbInstance) {
  if (_tickTimer) return;
  if (!process.env.SOLSCAN_API_KEY) {
    console.warn('[whale-funding] SOLSCAN_API_KEY missing — tracker disabled');
    return;
  }
  ensureWhaleFundingSchema(dbInstance);
  console.log('[whale-funding] starting — every 15min, top 50 whales, 24h lookback');
  setTimeout(() => { runWhaleFundingTick(dbInstance, process.env.SOLSCAN_API_KEY).catch(() => {}); }, BOOT_DELAY_MS);
  _tickTimer = setInterval(() => {
    runWhaleFundingTick(dbInstance, process.env.SOLSCAN_API_KEY).catch(() => {});
  }, TICK_MS);
}

export function stopWhaleFundingTracker() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

export function getWhaleFundingStats(dbInstance) {
  const totalEvents = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM whale_funding_events`).get().n; } catch { return 0; }
  })();
  const events24h = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM whale_funding_events WHERE detected_at > datetime('now', '-24 hours')`).get().n; } catch { return 0; }
  })();
  const fundedWallets = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(DISTINCT recipient_wallet) as n FROM whale_funding_events`).get().n; } catch { return 0; }
  })();
  const fundedNewWallets = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source='whale-funding-tracker'`).get().n; } catch { return 0; }
  })();
  return { ..._stats, totalEvents, events24h, fundedWallets, fundedNewWallets };
}

export function getRecentWhaleFundingEvents(dbInstance, limit = 40) {
  try {
    return dbInstance.prepare(`
      SELECT funder_wallet, recipient_wallet, amount_sol, tx_sig, detected_at, funder_category
      FROM whale_funding_events
      ORDER BY detected_at DESC
      LIMIT ?
    `).all(limit);
  } catch { return []; }
}

// Scorer lookup: given a list of holder addresses, return how many were
// whale-funded within the last `hoursBack` hours. Used in scorer-dual bonus.
export function countRecentlyWhaleFunded(dbInstance, holders, hoursBack = 48) {
  if (!holders || holders.length === 0) return 0;
  try {
    const placeholders = holders.map(() => '?').join(',');
    const row = dbInstance.prepare(`
      SELECT COUNT(DISTINCT recipient_wallet) as n
      FROM whale_funding_events
      WHERE recipient_wallet IN (${placeholders})
        AND detected_at > datetime('now', '-${Number(hoursBack) || 48} hours')
    `).get(...holders);
    return row?.n ?? 0;
  } catch { return 0; }
}

export async function triggerWhaleFundingScan(dbInstance) {
  return runWhaleFundingTick(dbInstance, process.env.SOLSCAN_API_KEY);
}
