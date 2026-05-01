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
const POLL_INTERVAL_MS        = 300_000;       // poll every 5 min (credit budget)
// Budget-tuned for Helius Developer plan. 80 wallets × 288 ticks/day ×
// 10 credits = ~230K/day, leaves headroom for the rest of the pipeline.
// The 10-min cluster window still covers 2 ticks so clusters detectable.
const TOP_N_WATCHED           = 80;
const PER_WALLET_TX_LIMIT     = 5;             // last 5 swaps each wallet
const INTER_WALLET_DELAY_MS   = 250;           // gentler on rate limit at lower cadence
const SEEN_TX_TTL_MS          = 6 * 3_600_000; // forget signatures after 6h
const ALERT_COOLDOWN_HOURS    = 24;            // dedupe alerts per coin

// ─── State ───────────────────────────────────────────────────────────────────

const seenSignatures = new Map();                   // sig → expiresAt
const clusterMap     = new Map();                   // token → Map<wallet, buyAtMs>
const sellClusterMap = new Map();                   // token → Map<wallet, sellAtMs>
const EXIT_THRESHOLD = 2;                            // ≥2 winners dumping = WHALE EXIT alert

// KOL priority list — public wallets with documented alpha. These get
// polled EVERY tick ahead of the main watchlist, and a single buy from
// any of them triggers a TG alert immediately (no cluster threshold).
// Override via KOL_WALLETS env var (comma-separated addresses).
const DEFAULT_KOL_WALLETS = [
  // Cupsey (prolific micro-cap caller)
  'suqh5sHtr8HyJ7q8scBimULPkPpA557prMG47xCHQfK',
  // Unipcs (bonjaxxxxx) — memecoin KOL
  '7iabBMwmSvS4CFPcjW2XYZY53bUCHqXjASJABqWvaXrF',
  // Ansem public trading wallet
  'BCnqTiQAkAQzAhRyB2xHAnGPbD1k7yfFzMK4gZjVpZ8k',
  // Add more known KOLs here or via KOL_WALLETS env
];
function getKolWallets() {
  const env = (process.env.KOL_WALLETS || '').split(',').map(s => s.trim()).filter(Boolean);
  return env.length ? env : DEFAULT_KOL_WALLETS;
}
let _watchedWallets  = [];                          // [{address, category, score}]
let _walletRefreshAt = 0;
let _pollTimer       = null;
let _db              = null;
let _handler         = null;                        // ({ ca, clusterSize, sampleBuyMs }) => Promise

// Telemetry — exposed via getWatcherStats() for the diagnostic endpoint.
// Lets the operator see "is the watcher actually polling?" without
// reading every log line.
const _watcherTelemetry = {
  startedAt:        null,
  lastTickAt:       null,
  totalTicks:       0,
  lastTickSwapsSeen: 0,
  helius200:        0,
  helius429:        0,
  helius4xx:        0,
  helius5xx:        0,
  heliusErrors:     0,
  lastHeliusStatus: null,
  lastHeliusError:  null,
};

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
  _watcherTelemetry.startedAt = Date.now();
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
    isRunning:        _pollTimer != null,
    telemetry:        { ..._watcherTelemetry },
    secondsSinceLastTick: _watcherTelemetry.lastTickAt
      ? Math.round((Date.now() - _watcherTelemetry.lastTickAt) / 1000)
      : null,
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
  _watcherTelemetry.lastTickAt = Date.now();
  _watcherTelemetry.totalTicks += 1;
  _watcherTelemetry.lastTickSwapsSeen = 0;

  await refreshWatchedWallets();
  pruneSeenSignatures();
  pruneClusterMap();

  // KOL wallets are processed FIRST every tick. A single KOL buy always
  // emits an alert (bypass cluster threshold + cooldown — these public
  // alpha wallets each have 60%+ micro-cap hit rates).
  const kolList = getKolWallets().map(addr => ({
    address: addr, category: 'WINNER', score: 999, isKol: true,
  }));
  const kolAddrs = new Set(kolList.map(w => w.address));
  const watchFiltered = _watchedWallets.filter(w => !kolAddrs.has(w.address));
  const allWallets = [...kolList, ...watchFiltered];

  if (!allWallets.length) {
    console.log('[smart-money] tick — no wallets to poll');
    return;
  }

  let totalSwaps = 0;
  for (const w of allWallets) {
    try {
      const swaps = await fetchWalletSwaps(w.address);
      totalSwaps += swaps.length;
      for (const tx of swaps) {
        if (!tx?.signature || seenSignatures.has(tx.signature)) continue;
        seenSignatures.set(tx.signature, Date.now() + SEEN_TX_TTL_MS);

        const boughtMint = extractBoughtMint(tx, w.address);
        const soldMint   = extractSoldMint(tx, w.address);
        if (boughtMint && !isStableOrWrapped(boughtMint)) {
          onWinnerBuy(boughtMint, w, tx);
        }
        if (soldMint && !isStableOrWrapped(soldMint)) {
          onWinnerSell(soldMint, w, tx);
        }
      }
    } catch (err) {
      // Individual wallet failure shouldn't kill the loop
    }
    await sleep(INTER_WALLET_DELAY_MS);
  }
  _watcherTelemetry.lastTickSwapsSeen = totalSwaps;
  // Heartbeat log every tick so operator can confirm polling is alive.
  // Includes Helius response counters so a sudden 429/4xx surge is visible
  // without scraping the diagnostic endpoint.
  console.log(`[smart-money] heartbeat — tick ${_watcherTelemetry.totalTicks}, polled ${allWallets.length} wallets, ${totalSwaps} swaps fetched | helius 200=${_watcherTelemetry.helius200} 429=${_watcherTelemetry.helius429} 4xx=${_watcherTelemetry.helius4xx} 5xx=${_watcherTelemetry.helius5xx} err=${_watcherTelemetry.heliusErrors}${_watcherTelemetry.lastHeliusError ? ' lastErr="' + _watcherTelemetry.lastHeliusError.slice(0,80) + '"' : ''}`);
}

async function fetchWalletSwaps(address) {
  const url = `${HELIUS_API_BASE}/addresses/${address}/transactions?type=SWAP&api-key=${process.env.HELIUS_API_KEY}&limit=${PER_WALLET_TX_LIMIT}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    _watcherTelemetry.lastHeliusStatus = res.status;
    if (res.ok) {
      _watcherTelemetry.helius200 += 1;
      _watcherTelemetry.lastHeliusError = null;
    } else if (res.status === 429) {
      _watcherTelemetry.helius429 += 1;
      // Capture body once for diagnosis (rate-limit messages tell us if
      // it's a credit issue vs an RPS issue).
      try {
        const body = await res.text();
        _watcherTelemetry.lastHeliusError = `HTTP 429: ${body.slice(0, 200)}`;
      } catch {}
      return [];
    } else if (res.status >= 500) {
      _watcherTelemetry.helius5xx += 1;
      _watcherTelemetry.lastHeliusError = `HTTP ${res.status}`;
      return [];
    } else {
      _watcherTelemetry.helius4xx += 1;
      try {
        const body = await res.text();
        _watcherTelemetry.lastHeliusError = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      } catch {
        _watcherTelemetry.lastHeliusError = `HTTP ${res.status}`;
      }
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    _watcherTelemetry.heliusErrors += 1;
    _watcherTelemetry.lastHeliusError = `${err.name}: ${err.message}`;
    return [];
  }
}

function extractBoughtMint(tx, walletAddress) {
  // Helius Enhanced Transactions shape: tokenTransfers[] with fromUserAccount/toUserAccount/mint
  const transfers = tx.tokenTransfers ?? [];
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

// Mirror of extractBoughtMint — finds the non-stable mint the wallet sent
// OUT (sold). A swap has both sides; the user's intent is captured by
// whichever side is the meme token.
function extractSoldMint(tx, walletAddress) {
  const transfers = tx.tokenTransfers ?? [];
  let best = null;
  for (const t of transfers) {
    if (t.fromUserAccount !== walletAddress) continue;
    if (!t.mint) continue;
    if (isStableOrWrapped(t.mint)) continue;
    const amt = Number(t.tokenAmount ?? 0);
    if (!best || amt > Number(best.tokenAmount ?? 0)) best = t;
  }
  return best?.mint ?? null;
}

// Persist every detected buy to wallet_activity so we can later query
// "every token wallet X bought" or "which wallets are accumulating token Y."
function recordWalletActivity(wallet, tokenMint, tx, side = 'BUY') {
  if (!_db || !wallet?.address || !tokenMint || !tx?.signature) return;
  try {
    const xfer = (tx.tokenTransfers ?? []).find(t =>
      (side === 'BUY'
        ? t.toUserAccount === wallet.address
        : t.fromUserAccount === wallet.address)
      && t.mint === tokenMint
    );
    const amount = xfer ? Number(xfer.tokenAmount ?? 0) : null;
    _db.prepare(`
      INSERT OR IGNORE INTO wallet_activity
        (wallet_address, token_mint, tx_signature, side, token_amount, block_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(wallet.address, tokenMint, tx.signature, side, amount, tx.timestamp || null);
  } catch (err) {
    // Don't let DB write errors stop the watcher loop — log once and move on
    console.warn('[smart-money] wallet_activity write failed:', err.message);
  }
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

  // Persist EVERY detected buy to wallet_activity — even ones that don't
  // trigger an alert. Builds a permanent ledger the oracle can query
  // ("show me every token wallet X bought this week").
  recordWalletActivity(wallet, token, tx);

  if (!clusterMap.has(token)) clusterMap.set(token, new Map());
  const buyers = clusterMap.get(token);
  // Record only the first buy per wallet in this window
  if (!buyers.has(wallet.address)) buyers.set(wallet.address, now);

  const fresh = Array.from(buyers.values()).filter(t => now - t <= CLUSTER_WINDOW_MS);
  const clusterSize = fresh.length;

  const tag = wallet.isKol ? '⭐ KOL' : `🐋 ${wallet.category}`;
  console.log(`[smart-money] ${tag} buy detected — token=${token.slice(0,8)} clusterNow=${clusterSize}`);

  // KOL wallets always trigger — bypass cluster threshold + cooldown.
  if (wallet.isKol) {
    emitAlert(token, 'kol', clusterSize);
    return;
  }
  // Cluster alert: ≥3 distinct winners within 10 min
  if (clusterSize >= CLUSTER_THRESHOLD) {
    emitAlert(token, 'cluster', clusterSize);
  } else {
    // Single-winner alert (lower priority; still goes through the pipeline)
    emitAlert(token, 'single', clusterSize);
  }
}

// Mirror of onWinnerBuy for the sell side — tracks which tracked wallets
// are DUMPING a coin. When ≥EXIT_THRESHOLD distinct winners dump inside
// the 10-min window, emit a WHALE_EXIT alert (TG warning, skip pipeline).
function onWinnerSell(token, wallet, tx) {
  const now = Date.now();

  // Log SELL to wallet_activity ledger (override default side='BUY')
  recordWalletActivity(wallet, token, tx, 'SELL');

  if (!sellClusterMap.has(token)) sellClusterMap.set(token, new Map());
  const sellers = sellClusterMap.get(token);
  if (!sellers.has(wallet.address)) sellers.set(wallet.address, now);

  const fresh = Array.from(sellers.values()).filter(t => now - t <= CLUSTER_WINDOW_MS);
  const exitSize = fresh.length;

  console.log(`[smart-money] 📉 ${wallet.category} SELL detected — token=${token.slice(0,8)} exitCluster=${exitSize}`);

  if (exitSize >= EXIT_THRESHOLD) {
    emitAlert(token, 'exit', exitSize);
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
  // Same prune for sells
  for (const [token, sellers] of sellClusterMap) {
    for (const [addr, t] of sellers) {
      if (now - t > CLUSTER_WINDOW_MS) sellers.delete(addr);
    }
    if (!sellers.size) sellClusterMap.delete(token);
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
  // KOL alerts and WHALE_EXIT warnings always fire — different info content
  // from prior BUY alerts so the 24h dedupe doesn't apply.
  if (kind === 'kol' || kind === 'exit') return false;
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
