/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  midcap-harvester.js — twice-daily $250K+ MCap winner sweep
 *
 *  The middle tier between wallet-harvester (passive, from our own WINs) and
 *  legendary-harvester (weekly, $30M+ runs only). There are hundreds of
 *  Solana coins doing $250K+ MCap every day — that's where fresh alpha lives
 *  before wallets become obvious. This sweeps them all twice a day.
 *
 *  Flow (runs at boot + every 12h):
 *   1. Dune SQL: Solana tokens with $500K+ cumulative volume in last 24h
 *      ($500K 24h vol ≈ $250K+ MCap — real runs, not dust).
 *   2. For each new mint (not in midcap_harvest_log):
 *        - top 20 holders via Helius
 *        - resolve owners
 *        - upsert into tracked_wallets as SMART_MONEY by default, bump to
 *          WINNER after 2+ appearances (lower bar than passive's 3+ since
 *          the source filter is stronger).
 *   3. Cache mint so we never re-scan the same coin.
 *
 *  Expected volume: 100-300 coins per run × 20 holders = 2K-6K wallet
 *  touches per sweep. Lots of overlap with existing DB, but net-new wallets
 *  will compound over weeks.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const HELIUS_RPC = (key) => `https://mainnet.helius-rpc.com/?api-key=${key}`;
const DUNE_API   = 'https://api.dune.com/api/v1';

const TICK_MS               = 12 * 60 * 60 * 1000;    // twice daily
const BOOT_DELAY_MS         = 8 * 60 * 1000;          // 8 min after boot
const TOP_N_HOLDERS         = 20;
const INTER_COIN_DELAY_MS   = 400;
const MIN_VOLUME_USD        = 250_000;                // $250K 24h vol — broader net per user request (was $500K)
const LOOKBACK_HOURS        = 24;
const DUNE_EXEC_TIMEOUT_MS  = 120_000;                // 2min

let _tickTimer = null;
let _stats = {
  runsCompleted:    0,
  midcapCoinsFound: 0,
  coinsHarvested:   0,
  walletsAdded:     0,
  walletsPromoted:  0,
  lastRunAt:        null,
  lastDuneRunAt:    null,
  lastError:        null,
};

function ensureMidcapLogTable(dbInstance) {
  try {
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS midcap_harvest_log (
        contract_address TEXT PRIMARY KEY,
        harvested_at     TEXT DEFAULT (datetime('now')),
        holder_count     INTEGER,
        volume_24h_usd   REAL
      );
      CREATE INDEX IF NOT EXISTS idx_mh_at ON midcap_harvest_log(harvested_at DESC);
    `);
  } catch (err) { console.warn('[midcap-harvester] table setup:', err.message); }
}

const MIDCAP_SQL = `
  SELECT
    token_bought_mint_address AS contract_address,
    MIN(block_time) AS first_seen,
    MAX(block_time) AS last_active,
    SUM(amount_usd)  AS vol_24h_usd,
    COUNT(*)         AS trade_count
  FROM dex_solana.trades
  WHERE block_time > NOW() - INTERVAL '${LOOKBACK_HOURS}' hour
    AND amount_usd > 0
    AND token_bought_mint_address IS NOT NULL
    AND token_bought_mint_address NOT IN (
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    )
  GROUP BY token_bought_mint_address
  HAVING SUM(amount_usd) >= ${MIN_VOLUME_USD}
     AND COUNT(*) >= 150
  ORDER BY vol_24h_usd DESC
  LIMIT 400
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

async function runDuneMidcapQuery() {
  console.log('[midcap-harvester] kicking off Dune query...');
  const created = await duneRequest('/query', {
    method: 'POST',
    body: JSON.stringify({
      name:       'pulse_caller_midcap_' + Date.now(),
      query_sql:  MIDCAP_SQL,
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
    await sleep(6_000);
    const status = await duneRequest(`/execution/${execId}/status`, { timeout: 10_000 });
    if (status.state === 'QUERY_STATE_COMPLETED') {
      const results = await duneRequest(`/execution/${execId}/results?limit=500`, { timeout: 30_000 });
      const rows = results.result?.rows ?? [];
      console.log(`[midcap-harvester] ✓ dune returned ${rows.length} midcap coins`);
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

// SOL-tier categorized upsert. Category is derived from SOL balance:
//   ≥100 → WINNER, 8-99 → SMART_MONEY. Wallets <8 SOL never reach here
//   (filter happens in runMidcapTick via filterAndClassifyBySol).
// Don't touch KOL or RUG_ASSOCIATED. Never downgrade existing WINNER.
function upsertMidcapWallet(dbInstance, candidate) {
  const { address, sol, category: newCategory } = candidate;
  try {
    const existing = dbInstance.prepare(
      `SELECT id, category, sol_balance FROM tracked_wallets WHERE address = ?`
    ).get(address);

    if (!existing) {
      dbInstance.prepare(`
        INSERT INTO tracked_wallets (address, category, source, sol_balance, wins_found_in, last_seen, added_by, updated_at)
        VALUES (?, ?, 'midcap-harvester', ?, 1, datetime('now'), 'auto', datetime('now'))
      `).run(address, newCategory, sol);
      _stats.walletsAdded++;
      return { added: true, promoted: false };
    }

    if (existing.category === 'KOL' || existing.category === 'RUG_ASSOCIATED') {
      return { added: false, promoted: false };
    }

    // Refresh sol_balance + bump counters
    dbInstance.prepare(`
      UPDATE tracked_wallets
      SET sol_balance   = ?,
          wins_found_in = COALESCE(wins_found_in, 0) + 1,
          last_seen     = datetime('now'),
          updated_at    = datetime('now')
      WHERE id = ?
    `).run(sol, existing.id);

    // Upgrade only if SOL tier is higher than current category warrants.
    // Never downgrade WINNER (protects curated high-SOL wallets).
    if (newCategory === 'WINNER' && existing.category !== 'WINNER') {
      dbInstance.prepare(`UPDATE tracked_wallets SET category='WINNER', updated_at=datetime('now') WHERE id = ?`).run(existing.id);
      _stats.walletsPromoted++;
      return { added: false, promoted: true };
    }
    return { added: false, promoted: false };
  } catch (err) {
    console.warn(`[midcap-harvester] upsert ${address.slice(0,8)}: ${err.message}`);
    return { added: false, promoted: false };
  }
}

async function runMidcapTick(dbInstance, heliusKey) {
  try {
    ensureMidcapLogTable(dbInstance);
    if (!process.env.DUNE_API_KEY) { _stats.lastError = 'No DUNE_API_KEY'; return; }
    if (!heliusKey)                 { _stats.lastError = 'No HELIUS_API_KEY'; return; }

    const rows = await runDuneMidcapQuery();
    _stats.midcapCoinsFound = rows.length;

    const allMints = rows.map(r => r.contract_address).filter(Boolean);
    if (allMints.length === 0) {
      console.log('[midcap-harvester] no midcap coins returned');
      _stats.runsCompleted++;
      _stats.lastRunAt = new Date().toISOString();
      return;
    }

    // Filter out mints we've harvested in the LAST 72H (refresh weekly,
    // holders change as new buyers appear, but not every 12h)
    const recentScanned = new Set(
      dbInstance.prepare(`
        SELECT contract_address FROM midcap_harvest_log
        WHERE harvested_at > datetime('now', '-72 hours')
      `).all().map(r => r.contract_address)
    );
    const newMints = rows.filter(r => !recentScanned.has(r.contract_address));

    if (newMints.length === 0) {
      console.log(`[midcap-harvester] all ${rows.length} midcap coins scanned in last 72h — nothing fresh`);
      _stats.runsCompleted++;
      _stats.lastRunAt = new Date().toISOString();
      _stats.lastError = null;
      return;
    }
    console.log(`[midcap-harvester] harvesting ${newMints.length} new midcap coins (of ${rows.length} total)...`);

    // SOL-tier filter: only wallets ≥ 8 SOL become candidates.
    // ≥100 SOL = WINNER, 8-99 = SMART_MONEY. Dust wallets are dropped.
    const { filterAndClassifyBySol } = await import('./harvester-cleanup.js');

    let coinsHarvested = 0;
    for (const coin of newMints) {
      const ca = coin.contract_address;
      const tokenAccounts = await fetchTopHolders(ca, heliusKey);
      if (tokenAccounts.length === 0) { await sleep(INTER_COIN_DELAY_MS); continue; }

      const owners = await resolveTokenAccountOwners(tokenAccounts, heliusKey);
      if (owners.length === 0) { await sleep(INTER_COIN_DELAY_MS); continue; }

      const qualified = await filterAndClassifyBySol(owners, heliusKey);
      let added = 0, promoted = 0;
      for (const cand of qualified) {
        const r = upsertMidcapWallet(dbInstance, cand);
        if (r.added) added++;
        if (r.promoted) promoted++;
      }

      try {
        dbInstance.prepare(`
          INSERT OR REPLACE INTO midcap_harvest_log (contract_address, harvested_at, holder_count, volume_24h_usd)
          VALUES (?, datetime('now'), ?, ?)
        `).run(ca, owners.length, Number(coin.vol_24h_usd) || 0);
      } catch {}

      coinsHarvested++;
      if (coinsHarvested % 20 === 0) {
        const volK = ((coin.vol_24h_usd || 0) / 1000).toFixed(0);
        console.log(`[midcap-harvester]   [${coinsHarvested}/${newMints.length}] ${ca.slice(0,8)}… ($${volK}K 24h): ${qualified.length}/${owners.length} ≥8 SOL, +${added} new, ${promoted} promoted`);
      }
      await sleep(INTER_COIN_DELAY_MS);
    }

    _stats.coinsHarvested += coinsHarvested;
    _stats.runsCompleted++;
    _stats.lastRunAt = new Date().toISOString();
    _stats.lastError = null;
    console.log(`[midcap-harvester] tick complete — ${coinsHarvested} midcap coins harvested, ${_stats.walletsAdded} total wallets added, ${_stats.walletsPromoted} promoted to WINNER`);
  } catch (err) {
    console.error('[midcap-harvester] tick error:', err.message);
    _stats.lastError = err.message;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function startMidcapHarvester(dbInstance, heliusKey) {
  if (_tickTimer) return;
  if (!process.env.DUNE_API_KEY) {
    console.warn('[midcap-harvester] DUNE_API_KEY missing — harvester disabled');
    return;
  }
  if (!heliusKey) {
    console.warn('[midcap-harvester] HELIUS_API_KEY missing — harvester disabled');
    return;
  }
  console.log(`[midcap-harvester] starting — twice-daily, ${LOOKBACK_HOURS}h lookback, $${MIN_VOLUME_USD/1000}K+ volume filter`);
  setTimeout(() => { runMidcapTick(dbInstance, heliusKey).catch(() => {}); }, BOOT_DELAY_MS);
  _tickTimer = setInterval(() => {
    runMidcapTick(dbInstance, heliusKey).catch(() => {});
  }, TICK_MS);
}

export function stopMidcapHarvester() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

export function getMidcapStats(dbInstance) {
  const totalScanned = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM midcap_harvest_log`).get().n; }
    catch { return 0; }
  })();
  const totalWallets = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source='midcap-harvester'`).get().n; }
    catch { return 0; }
  })();
  const winnerWallets = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source='midcap-harvester' AND category='WINNER'`).get().n; }
    catch { return 0; }
  })();
  return { ..._stats, totalScanned, totalWallets, winnerWallets };
}

export async function triggerMidcapHarvest(dbInstance, heliusKey) {
  return runMidcapTick(dbInstance, heliusKey);
}
