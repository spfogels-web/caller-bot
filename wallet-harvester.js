/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  wallet-harvester.js — passive wallet database growth
 *
 *  Every 30 minutes:
 *   1. Find coins from our `calls` table that hit peak_multiple >= 2.0 in
 *      the last 48h (winners — by definition)
 *   2. Pull the top 20 token holders of each via Helius getTokenLargestAccounts
 *   3. Upsert into `tracked_wallets`:
 *        - new wallet  → insert with category='HARVESTED', wins_found_in=1
 *        - existing    → increment wins_found_in, update last_seen
 *        - wins_found_in >= 3 → auto-promote to category='WINNER'
 *
 *  Result: tracked_wallets grows organically from our own successful calls.
 *  The more winners we hit, the more alpha wallets we know about. Wallets
 *  that repeatedly show up across multiple winners get promoted to WINNER
 *  tier — that's where Axioscan's "alpha wallet graph" comes from.
 *
 *  Idempotent: caches harvested CAs in `harvest_log` so we don't re-scan
 *  the same coin every tick.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const HELIUS_RPC = (key) => `https://mainnet.helius-rpc.com/?api-key=${key}`;
const TICK_MS    = 30 * 60 * 1000;        // 30 minutes
const TOP_N_HOLDERS = 20;
const MIN_PEAK_MULTIPLE = 2.0;             // coin must have done ≥2x to count
const LOOKBACK_HOURS = 48;                  // harvest recent WINs
const AUTO_PROMOTE_APPEARANCES = 3;         // 3+ wins → auto-promote to WINNER
const INTER_COIN_DELAY_MS = 500;            // be gentle on Helius

let _tickTimer = null;
let _stats = {
  runsCompleted: 0,
  coinsHarvested: 0,
  walletsAdded: 0,
  walletsPromoted: 0,
  lastRunAt: null,
  lastError: null,
};

function ensureHarvestLogTable(dbInstance) {
  try {
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS wallet_harvest_log (
        contract_address TEXT PRIMARY KEY,
        harvested_at     TEXT DEFAULT (datetime('now')),
        holder_count     INTEGER,
        peak_multiple    REAL
      );
      CREATE INDEX IF NOT EXISTS idx_wh_at ON wallet_harvest_log(harvested_at DESC);
    `);
  } catch (err) { console.warn('[wallet-harvester] table setup:', err.message); }
}

async function fetchTopHolders(mint, heliusKey) {
  if (!heliusKey) return [];
  try {
    const res = await fetch(HELIUS_RPC(heliusKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts',
        params: [mint, { commitment: 'finalized' }],
      }),
      signal: AbortSignal.timeout(9_000),
    });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.result?.value ?? []).slice(0, TOP_N_HOLDERS);
  } catch { return []; }
}

// Resolve token-account addresses to their owner wallets. The largest
// holders of a SPL token are token accounts, not wallets — we need the
// owner to track the actual wallet.
async function resolveTokenAccountOwners(tokenAccounts, heliusKey) {
  if (!tokenAccounts.length || !heliusKey) return [];
  try {
    const res = await fetch(HELIUS_RPC(heliusKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts',
        params: [tokenAccounts.map(t => t.address), { encoding: 'jsonParsed' }],
      }),
      signal: AbortSignal.timeout(9_000),
    });
    if (!res.ok) return [];
    const j = await res.json();
    const accounts = j.result?.value ?? [];
    return accounts.map(a => a?.data?.parsed?.info?.owner).filter(Boolean);
  } catch { return []; }
}

function upsertHarvestedWallet(dbInstance, address) {
  try {
    const existing = dbInstance.prepare(
      `SELECT id, category, wins_found_in FROM tracked_wallets WHERE address = ?`
    ).get(address);

    if (!existing) {
      dbInstance.prepare(`
        INSERT INTO tracked_wallets (address, category, source, wins_found_in, last_seen, added_by, updated_at)
        VALUES (?, 'HARVESTED', 'wallet-harvester', 1, datetime('now'), 'auto', datetime('now'))
      `).run(address);
      _stats.walletsAdded++;
      return { added: true, promoted: false };
    }

    // Bump the appearance counter
    dbInstance.prepare(`
      UPDATE tracked_wallets
      SET wins_found_in = COALESCE(wins_found_in, 0) + 1,
          last_seen     = datetime('now'),
          updated_at    = datetime('now')
      WHERE id = ?
    `).run(existing.id);

    // Auto-promote after N confirmed winner-appearances
    const newCount = (existing.wins_found_in || 0) + 1;
    if (newCount >= AUTO_PROMOTE_APPEARANCES &&
        existing.category !== 'WINNER' &&
        existing.category !== 'KOL') {
      dbInstance.prepare(`
        UPDATE tracked_wallets
        SET category='WINNER', updated_at=datetime('now'), notes='auto-promoted from HARVESTED after '||wins_found_in||' winner appearances'
        WHERE id = ?
      `).run(existing.id);
      _stats.walletsPromoted++;
      return { added: false, promoted: true };
    }
    return { added: false, promoted: false };
  } catch (err) {
    console.warn(`[wallet-harvester] upsert ${address.slice(0,8)}: ${err.message}`);
    return { added: false, promoted: false };
  }
}

async function runHarvestTick(dbInstance, heliusKey) {
  try {
    ensureHarvestLogTable(dbInstance);
    if (!heliusKey) { _stats.lastError = 'No HELIUS_API_KEY'; return; }

    // Find resolved WIN coins from last LOOKBACK_HOURS that we haven't
    // harvested yet. peak_multiple >= MIN_PEAK_MULTIPLE = definitely a winner.
    const coins = dbInstance.prepare(`
      SELECT c.contract_address, c.token, c.peak_multiple
      FROM calls c
      LEFT JOIN wallet_harvest_log h ON h.contract_address = c.contract_address
      WHERE c.peak_multiple IS NOT NULL
        AND c.peak_multiple >= ?
        AND c.called_at > datetime('now', '-' || ? || ' hours')
        AND h.contract_address IS NULL
      ORDER BY c.peak_multiple DESC
      LIMIT 40
    `).all(MIN_PEAK_MULTIPLE, LOOKBACK_HOURS);

    if (coins.length === 0) {
      console.log('[wallet-harvester] no new winners to harvest');
      _stats.runsCompleted++;
      _stats.lastRunAt = new Date().toISOString();
      return;
    }
    console.log(`[wallet-harvester] harvesting ${coins.length} new winner coins...`);

    let coinsHarvested = 0;
    for (const coin of coins) {
      const ca = coin.contract_address;
      const tokenAccounts = await fetchTopHolders(ca, heliusKey);
      if (tokenAccounts.length === 0) { await sleep(INTER_COIN_DELAY_MS); continue; }

      const owners = await resolveTokenAccountOwners(tokenAccounts, heliusKey);
      let wallets = 0;
      for (const owner of owners) {
        const r = upsertHarvestedWallet(dbInstance, owner);
        if (r.added || r.promoted) wallets++;
      }

      try {
        dbInstance.prepare(`
          INSERT OR REPLACE INTO wallet_harvest_log (contract_address, harvested_at, holder_count, peak_multiple)
          VALUES (?, datetime('now'), ?, ?)
        `).run(ca, owners.length, coin.peak_multiple);
      } catch {}

      coinsHarvested++;
      console.log(`[wallet-harvester]   $${coin.token ?? ca.slice(0,6)} (${coin.peak_multiple.toFixed(2)}x): ${owners.length} owners → ${wallets} new/promoted`);
      await sleep(INTER_COIN_DELAY_MS);
    }

    _stats.coinsHarvested += coinsHarvested;
    _stats.runsCompleted++;
    _stats.lastRunAt = new Date().toISOString();
    _stats.lastError = null;
    console.log(`[wallet-harvester] tick complete — ${coinsHarvested} coins harvested, ${_stats.walletsAdded} total new wallets, ${_stats.walletsPromoted} promoted to WINNER`);
  } catch (err) {
    console.error('[wallet-harvester] tick error:', err.message);
    _stats.lastError = err.message;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function startWalletHarvester(dbInstance, heliusKey) {
  if (_tickTimer) return;
  if (!heliusKey) {
    console.warn('[wallet-harvester] HELIUS_API_KEY missing — harvester disabled');
    return;
  }
  console.log('[wallet-harvester] starting — running every 30min, 48h lookback, auto-promote at 3 appearances');
  // First run in 2min (give boot a breather), then every 30min
  setTimeout(() => { runHarvestTick(dbInstance, heliusKey).catch(() => {}); }, 2 * 60_000);
  _tickTimer = setInterval(() => {
    runHarvestTick(dbInstance, heliusKey).catch(() => {});
  }, TICK_MS);
}

export function stopWalletHarvester() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

export function getHarvesterStats(dbInstance) {
  const totalWallets = (() => {
    try {
      return dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source='wallet-harvester'`).get().n;
    } catch { return 0; }
  })();
  const winnerWallets = (() => {
    try {
      return dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source='wallet-harvester' AND category='WINNER'`).get().n;
    } catch { return 0; }
  })();
  const coinsHarvested = (() => {
    try {
      return dbInstance.prepare(`SELECT COUNT(*) as n FROM wallet_harvest_log`).get().n;
    } catch { return 0; }
  })();
  return { ..._stats, totalWallets, winnerWallets, coinsHarvested };
}

// Allow on-demand trigger via API
export async function triggerHarvest(dbInstance, heliusKey) {
  return runHarvestTick(dbInstance, heliusKey);
}
