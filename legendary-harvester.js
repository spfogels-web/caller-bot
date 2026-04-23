/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  legendary-harvester.js — external "legendary winner" wallet harvesting
 *
 *  Weekly job that finds the biggest Solana runs of the last 180 days
 *  (FARTCOIN/POPCAT/PNUT-tier) via a Dune query, then harvests their
 *  top 20 holders via Helius and upserts them into `tracked_wallets`
 *  as WINNER (highest existing tier — auto-feeds knownWinnerWalletCount
 *  which drives the Wallet Quality score in scorer-dual.js:343).
 *
 *  Flow:
 *   1. Weekly Dune SQL: tokens with $30M+ cumulative volume in 180d
 *      → that filter is robust enough to skip rugs, catches real runs.
 *   2. For each new mint (not already in legendary_harvest_log):
 *        - fetch top 20 token accounts via Helius getTokenLargestAccounts
 *        - resolve owner wallets via getMultipleAccounts
 *        - upsert into tracked_wallets as WINNER with source='legendary-harvester'
 *   3. Cache mint in legendary_harvest_log so we never re-scan
 *
 *  Unlike wallet-harvester.js (self-reinforcing from our own wins), this
 *  pulls external signal: the best wallets in the whole Solana meme market,
 *  regardless of whether we called any of them.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const HELIUS_RPC = (key) => `https://mainnet.helius-rpc.com/?api-key=${key}`;
const DUNE_API   = 'https://api.dune.com/api/v1';

const TICK_MS               = 7 * 24 * 60 * 60 * 1000;   // weekly
const BOOT_DELAY_MS         = 5 * 60 * 1000;             // 5 min after boot
const TOP_N_HOLDERS         = 20;
const INTER_COIN_DELAY_MS   = 800;
const MIN_VOLUME_USD        = 30_000_000;                // $30M cumulative vol = legendary tier
const LOOKBACK_DAYS         = 180;
const DUNE_EXEC_TIMEOUT_MS  = 180_000;                   // 3min — big aggregation

let _tickTimer = null;
let _stats = {
  runsCompleted:      0,
  legendaryCoinsFound: 0,
  coinsHarvested:     0,
  walletsAdded:       0,
  walletsUpgraded:    0,
  lastRunAt:          null,
  lastDuneRunAt:      null,
  lastError:          null,
};

function ensureLegendaryLogTable(dbInstance) {
  try {
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS legendary_harvest_log (
        contract_address TEXT PRIMARY KEY,
        harvested_at     TEXT DEFAULT (datetime('now')),
        holder_count     INTEGER,
        total_volume_usd REAL,
        first_seen       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lh_at ON legendary_harvest_log(harvested_at DESC);
    `);
  } catch (err) { console.warn('[legendary-harvester] table setup:', err.message); }
}

// ─── Dune query: find Solana tokens that did $30M+ cumulative volume ─────────
// Excludes stablecoins/WSOL. 30M+ volume over 180d = proven legendary run.
const LEGENDARY_SQL = `
  SELECT
    token_bought_mint_address AS contract_address,
    MIN(block_time) AS first_seen,
    MAX(block_time) AS last_active,
    SUM(amount_usd)  AS total_vol_usd,
    COUNT(*)         AS trade_count
  FROM dex_solana.trades
  WHERE block_time > NOW() - INTERVAL '${LOOKBACK_DAYS}' day
    AND amount_usd > 0
    AND token_bought_mint_address IS NOT NULL
    AND token_bought_mint_address NOT IN (
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    )
  GROUP BY token_bought_mint_address
  HAVING SUM(amount_usd) >= ${MIN_VOLUME_USD}
  ORDER BY total_vol_usd DESC
  LIMIT 150
`.trim();

async function duneRequest(path, options = {}) {
  const key = process.env.DUNE_API_KEY;
  if (!key) throw new Error('No DUNE_API_KEY');
  const res = await fetch(`${DUNE_API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Dune-Api-Key': key,
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(options.timeout ?? 20_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Dune API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function runDuneLegendaryQuery() {
  console.log('[legendary-harvester] kicking off Dune query...');
  const created = await duneRequest('/query', {
    method: 'POST',
    body: JSON.stringify({
      name:       'pulse_caller_legendary_' + Date.now(),
      query_sql:  LEGENDARY_SQL,
      is_private: false,
      parameters: [],
    }),
    timeout: 20_000,
  });
  const queryId = created.query_id;
  if (!queryId) throw new Error('No query_id');

  const exec = await duneRequest(`/query/${queryId}/execute`, {
    method: 'POST',
    body: JSON.stringify({ performance: 'medium' }),
    timeout: 30_000,
  });
  const execId = exec.execution_id;
  if (!execId) throw new Error('No execution_id');

  const deadline = Date.now() + DUNE_EXEC_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(8_000);
    const status = await duneRequest(`/execution/${execId}/status`, { timeout: 10_000 });
    if (status.state === 'QUERY_STATE_COMPLETED') {
      const results = await duneRequest(`/execution/${execId}/results?limit=200`, { timeout: 30_000 });
      const rows = results.result?.rows ?? [];
      console.log(`[legendary-harvester] ✓ dune returned ${rows.length} legendary coins`);
      _stats.lastDuneRunAt = new Date().toISOString();
      return rows;
    }
    if (status.state?.includes('FAILED') || status.state?.includes('CANCELLED')) {
      throw new Error(`Dune ${status.state}: ${status.error?.message ?? ''}`);
    }
  }
  throw new Error('Dune query timed out');
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
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.result?.value ?? []).slice(0, TOP_N_HOLDERS);
  } catch { return []; }
}

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
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const j = await res.json();
    const accounts = j.result?.value ?? [];
    return accounts.map(a => a?.data?.parsed?.info?.owner).filter(Boolean);
  } catch { return []; }
}

// SOL-tier categorized upsert. Candidate carries sol + category:
//   ≥100 SOL → WINNER, 8-99 → SMART_MONEY. Dust (<8) filtered upstream.
// Even though legendary coins attract proven whales, we still enforce the
// SOL bar so the WINNER tier stays SOL-backed (matches user convention).
// Upgrade category only if SOL tier is higher; never downgrade.
function upsertLegendaryWallet(dbInstance, candidate, mintContract) {
  const { address, sol, category: newCategory } = candidate;
  try {
    const existing = dbInstance.prepare(
      `SELECT id, category FROM tracked_wallets WHERE address = ?`
    ).get(address);

    if (!existing) {
      dbInstance.prepare(`
        INSERT INTO tracked_wallets (address, category, source, sol_balance, wins_found_in, last_seen, added_by, updated_at, notes)
        VALUES (?, ?, 'legendary-harvester', ?, 1, datetime('now'), 'auto', datetime('now'), ?)
      `).run(address, newCategory, sol, `Top holder of legendary coin ${mintContract.slice(0, 8)}`);
      _stats.walletsAdded++;
      return { added: true, upgraded: false };
    }

    if (existing.category === 'KOL' || existing.category === 'RUG_ASSOCIATED') {
      return { added: false, upgraded: false };
    }

    // Refresh sol_balance + bump counter
    dbInstance.prepare(`
      UPDATE tracked_wallets
      SET sol_balance   = ?,
          wins_found_in = COALESCE(wins_found_in, 0) + 1,
          last_seen     = datetime('now'),
          updated_at    = datetime('now')
      WHERE id = ?
    `).run(sol, existing.id);

    if (newCategory === 'WINNER' && existing.category !== 'WINNER') {
      dbInstance.prepare(`UPDATE tracked_wallets SET category='WINNER', updated_at=datetime('now') WHERE id = ?`).run(existing.id);
      _stats.walletsUpgraded++;
      return { added: false, upgraded: true };
    }
    return { added: false, upgraded: false };
  } catch (err) {
    console.warn(`[legendary-harvester] upsert ${address.slice(0,8)}: ${err.message}`);
    return { added: false, upgraded: false };
  }
}

async function runLegendaryTick(dbInstance, heliusKey) {
  try {
    ensureLegendaryLogTable(dbInstance);
    if (!process.env.DUNE_API_KEY) { _stats.lastError = 'No DUNE_API_KEY'; return; }
    if (!heliusKey)                 { _stats.lastError = 'No HELIUS_API_KEY'; return; }

    const rows = await runDuneLegendaryQuery();
    _stats.legendaryCoinsFound = rows.length;

    // Filter out mints we've already harvested
    const allMints = rows.map(r => r.contract_address).filter(Boolean);
    if (allMints.length === 0) {
      console.log('[legendary-harvester] no legendary coins returned');
      _stats.runsCompleted++;
      _stats.lastRunAt = new Date().toISOString();
      return;
    }

    const placeholders = allMints.map(() => '?').join(',');
    const alreadyScanned = new Set(
      dbInstance.prepare(`SELECT contract_address FROM legendary_harvest_log WHERE contract_address IN (${placeholders})`)
        .all(...allMints).map(r => r.contract_address)
    );
    const newMints = rows.filter(r => !alreadyScanned.has(r.contract_address));

    if (newMints.length === 0) {
      console.log(`[legendary-harvester] all ${rows.length} legendary coins already harvested — nothing new`);
      _stats.runsCompleted++;
      _stats.lastRunAt = new Date().toISOString();
      _stats.lastError = null;
      return;
    }
    console.log(`[legendary-harvester] harvesting ${newMints.length} new legendary coins (of ${rows.length} total)...`);

    // SOL-tier classify — every wallet lands in DB, categorized by SOL:
    // ≥100 WINNER · 8-99 SMART_MONEY · 1-7 MOMENTUM · <1 HARVESTED_TRADER.
    const { classifyAllBySol } = await import('./harvester-cleanup.js');

    let coinsHarvested = 0;
    for (const coin of newMints) {
      const ca = coin.contract_address;
      const tokenAccounts = await fetchTopHolders(ca, heliusKey);
      if (tokenAccounts.length === 0) { await sleep(INTER_COIN_DELAY_MS); continue; }

      const owners = await resolveTokenAccountOwners(tokenAccounts, heliusKey);
      if (owners.length === 0) { await sleep(INTER_COIN_DELAY_MS); continue; }

      const qualified = await classifyAllBySol(owners, heliusKey);
      let added = 0, upgraded = 0;
      for (const cand of qualified) {
        const r = upsertLegendaryWallet(dbInstance, cand, ca);
        if (r.added) added++;
        if (r.upgraded) upgraded++;
      }

      try {
        dbInstance.prepare(`
          INSERT OR REPLACE INTO legendary_harvest_log (contract_address, harvested_at, holder_count, total_volume_usd, first_seen)
          VALUES (?, datetime('now'), ?, ?, ?)
        `).run(ca, owners.length, Number(coin.total_vol_usd) || 0, String(coin.first_seen || ''));
      } catch {}

      coinsHarvested++;
      const volM = ((coin.total_vol_usd || 0) / 1e6).toFixed(1);
      console.log(`[legendary-harvester]   ${ca.slice(0,8)}… ($${volM}M vol): ${owners.length} owners → +${added} new, ${upgraded} upgraded`);
      await sleep(INTER_COIN_DELAY_MS);
    }

    _stats.coinsHarvested += coinsHarvested;
    _stats.runsCompleted++;
    _stats.lastRunAt = new Date().toISOString();
    _stats.lastError = null;
    console.log(`[legendary-harvester] tick complete — ${coinsHarvested} legendary coins harvested, ${_stats.walletsAdded} total added, ${_stats.walletsUpgraded} upgraded to WINNER`);
  } catch (err) {
    console.error('[legendary-harvester] tick error:', err.message);
    _stats.lastError = err.message;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function startLegendaryHarvester(dbInstance, heliusKey) {
  if (_tickTimer) return;
  if (!process.env.DUNE_API_KEY) {
    console.warn('[legendary-harvester] DUNE_API_KEY missing — harvester disabled');
    return;
  }
  if (!heliusKey) {
    console.warn('[legendary-harvester] HELIUS_API_KEY missing — harvester disabled');
    return;
  }
  console.log(`[legendary-harvester] starting — weekly run, ${LOOKBACK_DAYS}d lookback, $${MIN_VOLUME_USD/1e6}M+ volume filter`);
  setTimeout(() => { runLegendaryTick(dbInstance, heliusKey).catch(() => {}); }, BOOT_DELAY_MS);
  _tickTimer = setInterval(() => {
    runLegendaryTick(dbInstance, heliusKey).catch(() => {});
  }, TICK_MS);
}

export function stopLegendaryHarvester() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

export function getLegendaryStats(dbInstance) {
  const totalScanned = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM legendary_harvest_log`).get().n; }
    catch { return 0; }
  })();
  const totalWallets = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source='legendary-harvester'`).get().n; }
    catch { return 0; }
  })();
  const winnerWallets = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source='legendary-harvester' AND category='WINNER'`).get().n; }
    catch { return 0; }
  })();
  return { ..._stats, totalScanned, totalWallets, winnerWallets };
}

export async function triggerLegendaryHarvest(dbInstance, heliusKey) {
  return runLegendaryTick(dbInstance, heliusKey);
}
