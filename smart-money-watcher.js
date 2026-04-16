/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  smart-money-watcher.js
 *
 *  Watches the top N WINNER-tier wallets (populated by dune-wallet-scanner)
 *  for fresh token buys via Helius Enhanced Transactions. Emits two kinds
 *  of events:
 *
 *    1. single_winner  — one WINNER buys a fresh coin → check, maybe alert
 *    2. cluster        — ≥3 WINNERs buy the same coin within 10 min → AUTO-POST
 *
 *  The TG alert never reveals which wallets bought (per user request). It
 *  prepends a "🐋 BIG WALLET ALERT" / "🐋🐋🐋 WHALE CLUSTER ALERT" header
 *  to the standard call alert and lets the existing pipeline do the rest.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const HELIUS_API_BASE = 'https://api.helius.xyz/v0';

const CLUSTER_WINDOW_MS       = 10 * 60_000;  // 10-min sliding cluster window
const CLUSTER_THRESHOLD       = 3;             // ≥3 WINNER buys = cluster alert
const POLL_INTERVAL_MS        = 90_000;        // poll every 90s
const TOP_N_WATCHED           = 60;            // watch top 60 WINNERs
const PER_WALLET_TX_LIMIT     = 10;            // last 10 swaps each wallet
const INTER_WALLET_DELAY_MS   = 180;           // gentle rate-limit between reqs
const SEEN_TX_TTL_MS          = 6 * 3_600_000; // forget signatures after 6h
const ALERT_COOLDOWN_HOURS    = 24;            // dedupe alerts per coin

// ─── State ───────────────────────────────────────────────────────────────────

const seenSignatures = new Map();                   // sig → expiresAt
const clusterMap     = new Map();                   // token → Map<wallet, buyAtMs>
let _watchedWallets  = [];                          // [{address, category, score}]
let _walletRefreshAt = 0;
let _pollTimer       = null;
let _db              = null;
let _handler         = null;                        // ({ ca, clusterSize, sampleBuyMs }) => Promise

// ─── Public API ──────────────────────────────────────────────────────────────

export function startSmartMoneyWatcher(dbInstance, onDetected) {
  if (_pollTimer) { console.warn('[smart-money] already running'); return; }
  if (!process.env.HELIUS_API_KEY) {
    console.warn('[smart-money] HELIUS_API_KEY missing — watcher disabled');
    return;
  }
  _db      = dbInstance;
  _handler = onDetected;

  ensureAlertTable();

  console.log('[smart-money] Watcher starting — top ' + TOP_N_WATCHED + ' winner wallets, poll every ' + (POLL_INTERVAL_MS/1000) + 's');
  // First tick after 15s (let DB settle), then interval
  setTimeout(() => tick().catch(err => console.warn('[smart-money] first tick error:', err.message)), 15_000);
  _pollTimer = setInterval(() => {
    tick().catch(err => console.warn('[smart-money] tick error:', err.message));
  }, POLL_INTERVAL_MS);
}

export function stopSmartMoneyWatcher() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

export function getWatcherStats() {
  return {
    watchedWallets:   _watchedWallets.length,
    activeClusters:   clusterMap.size,
    seenSignatures:   seenSignatures.size,
    pollIntervalSec:  POLL_INTERVAL_MS / 1000,
    clusterThreshold: CLUSTER_THRESHOLD,
    clusterWindowMin: CLUSTER_WINDOW_MS / 60_000,
  };
}

// ─── Wallet Refresh ──────────────────────────────────────────────────────────

async function refreshWatchedWallets() {
  if (!_db) return;
  // Re-read the watchlist every 30 min so promotions from the dune scanner flow through
  if (Date.now() - _walletRefreshAt < 30 * 60_000 && _watchedWallets.length) return;
  try {
    const rows = _db.prepare(`
      SELECT address, category, score
      FROM tracked_wallets
      WHERE is_blacklist = 0
        AND category IN ('WINNER', 'SMART_MONEY')
      ORDER BY
        CASE category WHEN 'WINNER' THEN 0 ELSE 1 END,
        COALESCE(score, 0) DESC,
        COALESCE(wins_found_in, 0) DESC
      LIMIT ?
    `).all(TOP_N_WATCHED);
    _watchedWallets  = rows;
    _walletRefreshAt = Date.now();
    console.log('[smart-money] Watchlist refreshed: ' + rows.length + ' wallets (' +
      rows.filter(r => r.category === 'WINNER').length + ' WINNER, ' +
      rows.filter(r => r.category === 'SMART_MONEY').length + ' SMART_MONEY)');
  } catch (err) {
    console.warn('[smart-money] Watchlist refresh failed:', err.message);
  }
}

// ─── Polling Tick ────────────────────────────────────────────────────────────

async function tick() {
  await refreshWatchedWallets();
  if (!_watchedWallets.length) return;

  pruneSeenSignatures();
  pruneClusterMap();

  for (const w of _watchedWallets) {
    try {
      const swaps = await fetchWalletSwaps(w.address);
      for (const tx of swaps) {
        if (!tx?.signature || seenSignatures.has(tx.signature)) continue;
        seenSignatures.set(tx.signature, Date.now() + SEEN_TX_TTL_MS);

        const boughtMint = extractBoughtMint(tx, w.address);
        if (!boughtMint) continue;
        // Ignore WSOL / stablecoins — we're after meme tokens
        if (isStableOrWrapped(boughtMint)) continue;

        onWinnerBuy(boughtMint, w, tx);
      }
    } catch (err) {
      // Individual wallet failure shouldn't kill the loop
    }
    await sleep(INTER_WALLET_DELAY_MS);
  }
}

async function fetchWalletSwaps(address) {
  const url = `${HELIUS_API_BASE}/addresses/${address}/transactions?type=SWAP&api-key=${process.env.HELIUS_API_KEY}&limit=${PER_WALLET_TX_LIMIT}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function extractBoughtMint(tx, walletAddress) {
  // Helius Enhanced Transactions shape: tokenTransfers[] with fromUserAccount/toUserAccount/mint
  const transfers = tx.tokenTransfers ?? [];
  // The buyer is receiving the token — find a transfer TO the watched wallet
  // where the mint is NOT a stable/wrapped token. Prefer the largest transfer
  // if there are multiple (avoids picking up fee-token dust).
  let best = null;
  for (const t of transfers) {
    if (t.toUserAccount !== walletAddress) continue;
    if (!t.mint) continue;
    if (isStableOrWrapped(t.mint)) continue;
    const amt = Number(t.tokenAmount ?? 0);
    if (!best || amt > Number(best.tokenAmount ?? 0)) best = t;
  }
  return best?.mint ?? null;
}

const STABLE_OR_WRAPPED = new Set([
  'So11111111111111111111111111111111111111112',       // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',      // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',      // USDT
]);
function isStableOrWrapped(mint) { return STABLE_OR_WRAPPED.has(mint); }

// ─── Cluster Tracking + Alerts ──────────────────────────────────────────────

function onWinnerBuy(token, wallet, tx) {
  const now = Date.now();
  if (!clusterMap.has(token)) clusterMap.set(token, new Map());
  const buyers = clusterMap.get(token);
  // Record only the first buy per wallet in this window
  if (!buyers.has(wallet.address)) buyers.set(wallet.address, now);

  const fresh = Array.from(buyers.values()).filter(t => now - t <= CLUSTER_WINDOW_MS);
  const clusterSize = fresh.length;

  console.log(`[smart-money] 🐋 ${wallet.category} buy detected — token=${token.slice(0,8)} clusterNow=${clusterSize}`);

  // Cluster alert: ≥3 distinct winners within 10 min
  if (clusterSize >= CLUSTER_THRESHOLD) {
    emitAlert(token, 'cluster', clusterSize);
  } else {
    // Single-winner alert (lower priority; still goes through the pipeline)
    emitAlert(token, 'single', clusterSize);
  }
}

function pruneClusterMap() {
  const now = Date.now();
  for (const [token, buyers] of clusterMap) {
    for (const [addr, t] of buyers) {
      if (now - t > CLUSTER_WINDOW_MS) buyers.delete(addr);
    }
    if (!buyers.size) clusterMap.delete(token);
  }
}

function pruneSeenSignatures() {
  const now = Date.now();
  for (const [sig, exp] of seenSignatures) {
    if (exp < now) seenSignatures.delete(sig);
  }
}

// ─── Dedupe: don't double-alert on the same coin within 24h ─────────────────

function ensureAlertTable() {
  if (!_db) return;
  try {
    _db.exec(`
      CREATE TABLE IF NOT EXISTS smart_money_alerts (
        contract_address TEXT PRIMARY KEY,
        first_alert_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        alert_kind       TEXT,           -- 'single' | 'cluster'
        cluster_size     INTEGER,
        escalated_at     TEXT
      )
    `);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_sm_alerts_at ON smart_money_alerts(first_alert_at)`);
  } catch {}
}

function isOnCooldown(token, kind) {
  if (!_db) return false;
  try {
    const row = _db.prepare(`
      SELECT alert_kind, cluster_size,
             (julianday('now') - julianday(first_alert_at)) * 24 AS age_hours
      FROM smart_money_alerts
      WHERE contract_address = ?
    `).get(token);
    if (!row) return false;

    // Always let a fresh CLUSTER escalate a prior SINGLE, regardless of cooldown
    if (kind === 'cluster' && row.alert_kind === 'single') return false;

    return row.age_hours < ALERT_COOLDOWN_HOURS;
  } catch { return false; }
}

function recordAlert(token, kind, clusterSize) {
  if (!_db) return;
  try {
    _db.prepare(`
      INSERT INTO smart_money_alerts (contract_address, alert_kind, cluster_size)
      VALUES (?, ?, ?)
      ON CONFLICT(contract_address) DO UPDATE SET
        alert_kind   = excluded.alert_kind,
        cluster_size = MAX(cluster_size, excluded.cluster_size),
        escalated_at = CASE
          WHEN smart_money_alerts.alert_kind = 'single' AND excluded.alert_kind = 'cluster'
          THEN datetime('now') ELSE smart_money_alerts.escalated_at END
    `).run(token, kind, clusterSize);
  } catch (err) {
    console.warn('[smart-money] recordAlert failed:', err.message);
  }
}

function emitAlert(token, kind, clusterSize) {
  if (!_handler) return;
  if (isOnCooldown(token, kind)) return;
  recordAlert(token, kind, clusterSize);
  console.log(`[smart-money] 🚨 ALERT ${kind.toUpperCase()} — ca=${token} clusterSize=${clusterSize}`);
  Promise.resolve(_handler({ ca: token, kind, clusterSize }))
    .catch(err => console.warn('[smart-money] handler error:', err.message));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
