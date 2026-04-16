/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ALPHA LENNIX — dune-wallet-scanner.js
 *  Dune Analytics Wallet Intelligence Engine
 *
 *  Uses your Dune API key to pull REAL profitable Solana wallet data:
 *
 *  QUERY SET 1 — Top PnL Wallets (pump.fun + Raydium)
 *    Finds wallets with highest realized profit on Solana meme coins
 *    in the last 30/60/90 days
 *
 *  QUERY SET 2 — Early Entry Wallets
 *    Finds wallets that consistently buy within first 5 minutes of launch
 *    and exit profitably — these are your "smart money" signals
 *
 *  QUERY SET 3 — Sniper Detection
 *    Identifies wallets that buy in the first 1-3 blocks of every token
 *    (MEV bots / snipers) — these should LOWER conviction, not raise it
 *
 *  QUERY SET 4 — Winner Wallet Cross-Reference
 *    When a call resolves as WIN, extracts which early holders were present
 *    and builds the winner wallet database over time
 *
 *  HOW TO USE:
 *    import { runDuneWalletScan, getWalletProfile } from './dune-wallet-scanner.js'
 *    await runDuneWalletScan()   // call on startup + every 4h
 *    getWalletProfile(address)   // called by enricher on each token's holders
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function setDb(dbInstance) { _db = dbInstance; }

// ─── Config ───────────────────────────────────────────────────────────────────

const DUNE_API     = 'https://api.dune.com/api/v1';
const DUNE_API_KEY = () => process.env.DUNE_API_KEY ?? null;

// How many wallets to track in memory
const MAX_WALLETS = 10_000;

// Minimum trades to trust a wallet's stats
const MIN_TRADES_FOR_TRUST = 5;

// ─── Wallet Categories ────────────────────────────────────────────────────────

export const CAT = {
  WINNER:     'WINNER',      // Proven 10x+ hunter, high win rate
  SMART:      'SMART_MONEY', // Good timing, consistent profits
  MOMENTUM:   'MOMENTUM',    // Follows momentum well
  SNIPER:     'SNIPER',      // First-block buyer, dumps fast
  CLUSTER:    'CLUSTER',     // Coordinated/suspicious
  FARM:       'FARM',        // Volume farmer
  RUG:        'RUG',         // Associated with rugs/fails
  NEUTRAL:    'NEUTRAL',     // Unknown / insufficient data
};

// Score colors for logging
const catEmoji = {
  WINNER: '🏆', SMART_MONEY: '🧠', MOMENTUM: '📈',
  SNIPER: '🎯', CLUSTER: '⚠️',  FARM: '🌾', RUG: '☠️', NEUTRAL: '⚪',
};

// ─── In-Memory Store ──────────────────────────────────────────────────────────

class WalletStore {
  constructor() {
    this.db           = new Map();   // address → WalletProfile
    this.blacklist    = new Set();   // known bad addresses
    this.lastSync     = null;
    this.syncSource   = null;
    this.totalLoaded  = 0;
  }

  set(address, profile) {
    this.db.set(address, { ...profile, address, updatedAt: Date.now() });
  }

  get(address) { return this.db.get(address) ?? null; }
  has(address) { return this.db.has(address); }
  isBlacklisted(addr) { return this.blacklist.has(addr); }
  addBlacklist(addr) { this.blacklist.add(addr); }
  size() { return this.db.size; }

  // Bulk load from Dune results
  loadBatch(profiles) {
    let count = 0;
    for (const p of profiles) {
      if (!p?.address || p.address.length < 30) continue;
      this.db.set(p.address, { ...p, updatedAt: Date.now() });
      count++;
      if (this.db.size >= MAX_WALLETS) break;
    }
    this.totalLoaded = this.db.size;
    return count;
  }

  // Cross-reference a list of addresses — returns intelligence summary
  crossRef(addresses = []) {
    if (!addresses.length) return emptyIntel();

    const buckets = {
      winner: [], smart: [], momentum: [],
      sniper: [], cluster: [], farm: [], rug: [],
    };
    let known = 0;

    for (const addr of addresses) {
      if (this.blacklist.has(addr)) {
        buckets.rug.push({ address: addr, score: 0, source: 'blacklist' });
        known++;
        continue;
      }
      const w = this.db.get(addr);
      if (!w) continue;
      known++;
      const cat = w.category ?? CAT.NEUTRAL;
      if (cat === CAT.WINNER)     buckets.winner.push(w);
      else if (cat === CAT.SMART) buckets.smart.push(w);
      else if (cat === CAT.MOMENTUM) buckets.momentum.push(w);
      else if (cat === CAT.SNIPER)   buckets.sniper.push(w);
      else if (cat === CAT.CLUSTER)  buckets.cluster.push(w);
      else if (cat === CAT.FARM)     buckets.farm.push(w);
      else if (cat === CAT.RUG)      buckets.rug.push(w);
    }

    return buildIntelSummary(buckets, addresses.length, known);
  }

  getStatus() {
    const cats = {};
    for (const w of this.db.values()) {
      const c = w.category ?? 'NEUTRAL';
      cats[c] = (cats[c] ?? 0) + 1;
    }
    return {
      totalWallets:  this.db.size,
      blacklisted:   this.blacklist.size,
      lastSync:      this.lastSync,
      syncSource:    this.syncSource,
      ageMinutes:    this.lastSync ? Math.round((Date.now() - this.lastSync) / 60_000) : null,
      isStale:       !this.lastSync || (Date.now() - this.lastSync) > 4 * 3_600_000,
      categories:    cats,
    };
  }
}

export const store = new WalletStore();

// ─── Intel Summary Builder ────────────────────────────────────────────────────

function buildIntelSummary(buckets, totalScanned, known) {
  const { winner, smart, momentum, sniper, cluster, farm, rug } = buckets;

  // Smart money score (0–100)
  let score = 0;
  score += winner.length   * 15;
  score += smart.length    * 8;
  score += momentum.length * 4;
  score -= sniper.length   * 5;
  score -= cluster.length  * 10;
  score -= rug.length      * 20;
  score = Math.max(0, Math.min(100, score));

  // Reduce if snipers outnumber winners 2:1
  if (sniper.length > winner.length * 2) score = Math.round(score * 0.5);

  // Cluster risk score (0–100)
  const clusterRisk = Math.min(100,
    cluster.length * 15 + rug.length * 25 + (farm.length > 5 ? 20 : 0)
  );

  // Verdict
  let walletVerdict = 'NEUTRAL';
  if (rug.length > 2 || cluster.length > 8)                           walletVerdict = 'MANIPULATED';
  else if (winner.length >= 5 && clusterRisk < 30)                    walletVerdict = 'VERY_BULLISH';
  else if (winner.length >= 3 && clusterRisk < 40)                    walletVerdict = 'BULLISH';
  else if (sniper.length > 15 && winner.length < 2)                   walletVerdict = 'SNIPER_DOMINATED';
  else if (cluster.length > 5 || rug.length > 0)                      walletVerdict = 'SUSPICIOUS';

  return {
    // Raw counts
    knownWinnerWalletCount:    winner.length,
    smartMoneyWalletCount:     smart.length,
    momentumWalletCount:       momentum.length,
    sniperWalletCount:         sniper.length,
    clusterWalletCount:        cluster.length,
    farmWalletCount:           farm.length,
    rugWalletCount:            rug.length,
    knownCount:                known,
    totalScanned,
    knownPct: totalScanned > 0 ? Math.round(known / totalScanned * 100) : 0,

    // Scores
    smartMoneyScore:       score,
    clusterRiskScore:      clusterRisk,
    suspiciousClusterScore: clusterRisk / 100,

    // Detail
    winnerWallets:  winner.slice(0, 10).map(w => w.address),
    sniperWallets:  sniper.slice(0, 10).map(w => w.address),
    topWinners:     winner.slice(0, 5).map(w => ({
      address:  w.address,
      score:    w.score,
      winRate:  w.winRate10x,
      avgRoi:   w.avgRoi,
      trades:   w.tradeCount,
    })),

    // Verdict
    walletVerdict,
    topWalletCategory: winner.length > 0 ? 'WINNER_OVERLAP'
      : smart.length > 0 ? 'SMART_MONEY'
      : sniper.length > 0 ? 'SNIPER_PRESENT'
      : 'NEUTRAL',
  };
}

function emptyIntel() {
  return {
    knownWinnerWalletCount:0, smartMoneyWalletCount:0, momentumWalletCount:0,
    sniperWalletCount:0, clusterWalletCount:0, farmWalletCount:0, rugWalletCount:0,
    knownCount:0, totalScanned:0, knownPct:0,
    smartMoneyScore:0, clusterRiskScore:0, suspiciousClusterScore:0,
    winnerWallets:[], sniperWallets:[], topWinners:[],
    walletVerdict:'NEUTRAL', topWalletCategory:'NEUTRAL',
  };
}

// ─── DUNE QUERIES ─────────────────────────────────────────────────────────────
// These are the actual SQL queries that run against Dune's Solana dataset.
// Dune has full Solana DEX trade data — pump.fun, Raydium, Meteora, etc.

const QUERIES = {

  // ── Q1: Gem Hunters — wallets buying early on pump.fun ───────────────────────
  // Very low requirements to get data on Dune free tier
  // project names on Dune Solana: 'pump.fun', 'pumpfun', 'pump_fun', 'pump'
  GEM_HUNTERS: `
    WITH early_buys AS (
      SELECT
        taker                                                       AS wallet_address,
        token_bought_address                                           AS token,
        block_time,
        amount_usd,
        ROW_NUMBER() OVER (
          PARTITION BY token_bought_address ORDER BY block_time ASC
        )                                                           AS buy_rank
      FROM dex.trades
      WHERE blockchain = 'solana'
        AND block_time >= NOW() - interval '7' day
        AND taker IS NOT NULL
        AND amount_usd > 5
    ),
    early_only AS (
      SELECT * FROM early_buys WHERE buy_rank <= 50
    )
    SELECT
      wallet_address,
      COUNT(DISTINCT token)           AS tokens_entered,
      SUM(amount_usd)                 AS total_invested_usd,
      AVG(amount_usd)                 AS avg_buy_usd,
      AVG(buy_rank)                   AS avg_entry_rank,
      MIN(buy_rank)                   AS best_entry_rank,
      MAX(block_time)                 AS last_active
    FROM early_only
    GROUP BY wallet_address
    HAVING COUNT(DISTINCT token) >= 2
    ORDER BY tokens_entered DESC, avg_entry_rank ASC
    LIMIT 3000
  `.trim(),

  // ── Q2: Top active traders on Solana DEXes (7 days — short window for speed) ─
  TOP_PNL_WALLETS: `
    SELECT
      taker                           AS wallet_address,
      COUNT(*)                        AS total_trades,
      SUM(amount_usd)                 AS total_volume_usd,
      AVG(amount_usd)                 AS avg_trade_usd,
      COUNT(DISTINCT token_bought_address) AS unique_tokens,
      MAX(block_time)                 AS last_active
    FROM dex.trades
    WHERE blockchain = 'solana'
      AND block_time >= NOW() - interval '7' day
      AND taker IS NOT NULL
      AND amount_usd BETWEEN 5 AND 500000
      AND token_sold_symbol IN ('SOL', 'WSOL', 'USDC', 'USDT')
    GROUP BY taker
    HAVING COUNT(*) >= 5
      AND COUNT(DISTINCT token_bought_address) >= 3
      AND SUM(amount_usd) > 100
    ORDER BY total_volume_usd DESC
    LIMIT 3000
  `.trim(),

  // ── Q3: Pump.fun traders — any project with short window ─────────────────────
  PUMPFUN_TOP_TRADERS: `
    SELECT
      taker                           AS wallet_address,
      COUNT(*)                        AS total_trades,
      SUM(amount_usd)                 AS total_volume_usd,
      AVG(amount_usd)                 AS avg_trade_usd,
      COUNT(DISTINCT token_bought_address) AS unique_tokens,
      MAX(block_time)                 AS last_active
    FROM dex.trades
    WHERE blockchain = 'solana'
      AND block_time >= NOW() - interval '7' day
      AND taker IS NOT NULL
      AND amount_usd > 5
      AND token_sold_symbol IN ('SOL', 'WSOL', 'USDC', 'USDT')
    GROUP BY taker
    HAVING COUNT(*) >= 3
      AND SUM(amount_usd) > 50
    ORDER BY total_volume_usd DESC
    LIMIT 3000
  `.trim(),

  // ── Q4: Early entry wallets (first 10 minutes) — 3 day window ────────────────
  EARLY_ENTRY_WALLETS: `
    WITH token_first_trade AS (
      SELECT
        token_bought_address               AS token,
        MIN(block_time)                 AS launch_time
      FROM dex.trades
      WHERE blockchain = 'solana'
        AND block_time >= NOW() - interval '3' day
        AND token_sold_symbol IN ('SOL', 'WSOL', 'USDC', 'USDT')
      GROUP BY token_bought_address
    ),
    early_buys AS (
      SELECT
        t.taker                         AS wallet_address,
        date_diff('second', f.launch_time, t.block_time) / 60.0 AS minutes_after_launch,
        t.amount_usd
      FROM dex.trades t
      JOIN token_first_trade f ON t.token_bought_address = f.token
      WHERE t.blockchain = 'solana'
        AND t.block_time >= NOW() - interval '3' day
        AND date_diff('second', f.launch_time, t.block_time) BETWEEN 0 AND 600
        AND t.token_sold_symbol IN ('SOL', 'WSOL', 'USDC', 'USDT')
        AND t.taker IS NOT NULL
    )
    SELECT
      wallet_address,
      COUNT(*)                          AS early_entries,
      AVG(minutes_after_launch)         AS avg_entry_minutes,
      AVG(amount_usd)                   AS avg_buy_usd
    FROM early_buys
    GROUP BY wallet_address
    HAVING COUNT(*) >= 2
    ORDER BY early_entries DESC
    LIMIT 2000
  `.trim(),

  // ── Q5: Sniper wallets (first 30 seconds) — 2 day window ─────────────────────
  SNIPER_WALLETS: `
    WITH token_first_trade AS (
      SELECT
        token_bought_address               AS token,
        MIN(block_time)                 AS launch_time
      FROM dex.trades
      WHERE blockchain = 'solana'
        AND block_time >= NOW() - interval '2' day
        AND token_sold_symbol IN ('SOL', 'WSOL', 'USDC', 'USDT')
      GROUP BY token_bought_address
    ),
    snipe_events AS (
      SELECT
        t.taker                         AS wallet_address,
        date_diff('second', f.launch_time, t.block_time) AS seconds_after_launch
      FROM dex.trades t
      JOIN token_first_trade f ON t.token_bought_address = f.token
      WHERE t.blockchain = 'solana'
        AND t.block_time >= NOW() - interval '2' day
        AND date_diff('second', f.launch_time, t.block_time) BETWEEN 0 AND 30
        AND t.token_sold_symbol IN ('SOL', 'WSOL', 'USDC', 'USDT')
        AND t.taker IS NOT NULL
    )
    SELECT
      wallet_address,
      COUNT(*)                          AS snipe_count,
      AVG(seconds_after_launch)         AS avg_seconds_after_launch
    FROM snipe_events
    GROUP BY wallet_address
    HAVING COUNT(*) >= 2
    ORDER BY snipe_count DESC
    LIMIT 1500
  `.trim(),

};
async function duneRequest(path, options = {}) {
  const key = DUNE_API_KEY();
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

/**
 * Execute a SQL query directly on Dune and wait for results.
 * Uses Dune's Query Engine (costs credits on paid plans, free on free tier with limits).
 */
async function runDuneSQL(sql, label = 'query', timeoutMs = 120_000) {
  console.log(`[dune] Executing: ${label}...`);

  // Step 1: Create a saved query (Dune requires a saved query to execute)
  // POST /api/v1/query  → returns { query_id }
  let queryId;
  try {
    const createData = await duneRequest('/query', {
      method: 'POST',
      body: JSON.stringify({
        name:       'pulse_caller_' + label + '_' + Date.now(),
        query_sql:  sql,
        is_private: false,
        parameters: [],
      }),
      timeout: 20_000,
    });
    queryId = createData.query_id;
    if (!queryId) throw new Error('No query_id returned from create');
    console.log('[dune] ' + label + ' query created: ' + queryId);
  } catch (err) {
    throw new Error('Query create failed for ' + label + ': ' + err.message);
  }

  // Step 2: Execute the saved query
  // POST /api/v1/query/{query_id}/execute → returns { execution_id }
  const execData = await duneRequest('/query/' + queryId + '/execute', {
    method: 'POST',
    body: JSON.stringify({ performance: 'medium' }),
    timeout: 30_000,
  });

  const execId = execData.execution_id;
  if (!execId) throw new Error('No execution_id for ' + label);
  console.log('[dune] ' + label + ' execution_id: ' + execId);

  // Step 3: Poll until complete
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(5_000);
    const status = await duneRequest('/execution/' + execId + '/status', { timeout: 10_000 });

    if (status.state === 'QUERY_STATE_COMPLETED') {
      const results = await duneRequest(
        '/execution/' + execId + '/results?limit=15000',
        { timeout: 30_000 }
      );
      const rows = results.result?.rows ?? [];
      console.log('[dune] ✓ ' + label + ': ' + rows.length + ' rows');
      return rows;
    }

    if (status.state?.includes('FAILED') || status.state?.includes('CANCELLED')) {
      throw new Error(label + ' ' + status.state + ': ' + (status.error?.message ?? ''));
    }

    console.log('[dune] ' + label + ' status: ' + status.state + ' (' + Math.round((Date.now() - (deadline - timeoutMs)) / 1000) + 's)');
  }

  throw new Error(label + ' timed out after ' + (timeoutMs / 1000) + 's');
}

/**
 * Fetch latest cached results for a query ID (no credits, instant).
 */
async function fetchCachedResults(queryId) {
  // Correct endpoint: /results/latest returns the most recent cached execution
  // /results (without /latest) returns execution history, not the data
  const data = await duneRequest(
    `/query/${queryId}/results/latest?limit=15000`,
    { method: 'GET', timeout: 15_000 }
  );
  return data.result?.rows ?? data.rows ?? [];
}

// ─── Known Public Query IDs (fallback when custom SQL fails) ──────────────────
// These are real public Dune queries. We try them before running our own SQL.

const PUBLIC_QUERY_IDS = [
  // Only use query IDs you own/control on your Dune account.
  // Set DUNE_WALLET_QUERY_ID in Railway env to a saved query on your account.
  // Set DUNE_QUERY_ID_2, DUNE_QUERY_ID_3 etc. for additional saved queries.
  // Leave blank to skip Phase 1 and go straight to Phase 2 (custom SQL).
  process.env.DUNE_WALLET_QUERY_ID,
  process.env.DUNE_QUERY_ID_2,
  process.env.DUNE_QUERY_ID_3,
].filter(Boolean);

// ─── Row Normalizers ──────────────────────────────────────────────────────────

function normalizeTopPnlRow(r) {
  const addr = r.wallet_address ?? r.taker ?? r.trader_id ?? r.address;
  if (!addr || addr.length < 30) return null;

  const totalTrades  = Number(r.total_trades ?? r.trades ?? 0);
  const totalVolume  = Number(r.total_volume_usd ?? r.total_pnl_usd ?? 0);
  const avgTrade     = Number(r.avg_trade_usd ?? r.avg_trade_pnl ?? 0);
  const uniqueTokens = Number(r.unique_tokens ?? 1);

  // win_rate_pct comes from pumpfun query; volume queries use trade count as proxy
  const winRatePct = Number(r.win_rate_pct ?? 0);
  // Without explicit win rate, estimate from avg trade size and diversity
  // Higher avg trade + more unique tokens = more likely smart money
  const estimatedWinRate = winRatePct > 0
    ? winRatePct / 100
    : Math.min(0.30, (uniqueTokens / Math.max(totalTrades, 1)) * 0.5);

  const profile = {
    address:       addr,
    tradeCount:    totalTrades,
    winRate10x:    estimatedWinRate,
    winRate3x:     estimatedWinRate * 0.8,
    avgRoi:        avgTrade,
    totalVolumeUsd: totalVolume,
    avgEntrySpeed: Number(r.avg_entry_minutes ?? 30),
    rugRate:       Number(r.rug_rate ?? 0),
    clusterScore:  Number(r.cluster_score ?? 0),
    uniqueTokens,
    lastActive:    r.last_active ?? null,
    source:        r.source ?? 'dune_top_pnl',
  };

  profile.score    = computeWalletScore(profile);
  profile.category = classifyWallet(profile);
  return profile;
}

function normalizeEarlyEntryRow(r) {
  const addr = r.wallet_address ?? r.address;
  if (!addr || addr.length < 30) return null;
  const existing = store.get(addr) ?? {};
  return {
    ...existing,
    address:       addr,
    earlyEntries:  Number(r.early_entries ?? 0),
    avgEntrySpeed: Number(r.avg_entry_minutes ?? 30),
    avgBuyUsd:     Number(r.avg_buy_usd ?? 0),
    activeDays:    Number(r.active_days ?? 0),
    source:        'dune_early_entry',
    // Upgrade category if this wallet enters very early
    category: (Number(r.avg_entry_minutes ?? 99) < 5 && Number(r.early_entries ?? 0) >= 10)
      ? CAT.SMART
      : (existing.category ?? CAT.NEUTRAL),
    score: existing.score ?? 30,
  };
}

function normalizeSniperRow(r) {
  const addr = r.wallet_address ?? r.address;
  if (!addr || addr.length < 30) return null;
  return {
    address:          addr,
    snipeCount:       Number(r.snipe_count ?? 0),
    avgSecondsAfter:  Number(r.avg_seconds_after_launch ?? 0),
    category:         CAT.SNIPER,
    score:            5,
    winRate10x:       0.1,
    tradeCount:       Number(r.snipe_count ?? 0),
    source:           'dune_sniper',
  };
}

function normalizePumpfunRow(r) {
  return normalizeTopPnlRow({ ...r, source: 'dune_pumpfun' });
}

// ─── Wallet Scoring & Classification ─────────────────────────────────────────

function computeWalletScore(w) {
  const {
    winRate10x = 0, winRate3x = 0, avgRoi = 0,
    tradeCount = 0, avgEntrySpeed = 99,
    rugRate = 0, clusterScore = 0, earlyEntries = 0,
  } = w;

  if (tradeCount < MIN_TRADES_FOR_TRUST) return 20;

  let score = 0;
  score += winRate10x * 35;
  score += winRate3x  * 15;
  score += Math.min(avgRoi / 500, 20);  // capped at 20 pts from ROI

  // Entry timing bonus
  if (avgEntrySpeed < 3)       score += 15;
  else if (avgEntrySpeed < 10) score += 10;
  else if (avgEntrySpeed < 30) score += 5;

  // Early entries bonus
  score += Math.min(earlyEntries * 0.5, 10);

  // Trade count credibility
  if (tradeCount > 50)  score += 5;
  if (tradeCount > 200) score += 5;

  // Penalties
  score -= rugRate    * 30;
  score -= clusterScore * 20;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function classifyWallet(w) {
  const {
    winRate10x = 0, avgEntrySpeed = 99, rugRate = 0,
    clusterScore = 0, tradeCount = 0, snipeCount = 0,
    avgSecondsAfter = 99,
  } = w;

  // Hard negatives first
  if (rugRate > 0.4)                                         return CAT.RUG;
  if (clusterScore > 0.7)                                    return CAT.CLUSTER;
  if (avgSecondsAfter < 5 && snipeCount > 20)                return CAT.SNIPER;
  if (avgEntrySpeed < 0.5 && tradeCount > 30)                return CAT.SNIPER;

  // Positives
  if (winRate10x > 0.35 && tradeCount >= 10)                 return CAT.WINNER;
  if (winRate10x > 0.20 && avgEntrySpeed < 15)               return CAT.SMART;
  if (winRate10x > 0.15 && tradeCount >= 20)                 return CAT.MOMENTUM;

  // Suspicious
  if (clusterScore > 0.4)                                    return CAT.CLUSTER;

  return CAT.NEUTRAL;
}

// ─── Main Scan Function ───────────────────────────────────────────────────────

let _scanning = false;

/**
 * Run a full Dune wallet scan. Call on startup + every 4 hours.
 * Tries multiple strategies in order, stopping when enough wallets are loaded.
 */
export async function runDuneWalletScan() {
  if (_scanning) {
    console.log('[dune] Scan already in progress — skipping');
    return;
  }
  const key = DUNE_API_KEY();
  if (!key) {
    console.warn('[dune] No DUNE_API_KEY — wallet intelligence disabled');
    return;
  }

  _scanning = true;
  const startMs = Date.now();
  console.log('[dune] ━━━ Starting wallet intelligence scan ━━━');

  let totalLoaded = 0;

  try {
    // ── PHASE 1: Try cached results from known public queries (free, instant) ──
    if (PUBLIC_QUERY_IDS.length > 0) {
      console.log('[dune] Phase 1: Fetching your saved Dune query results (' + PUBLIC_QUERY_IDS.length + ' queries)...');
      for (const qId of PUBLIC_QUERY_IDS) {
        try {
          const rows = await fetchCachedResults(qId);
          if (rows.length >= 10) {
            const profiles = rows.map(r => normalizeTopPnlRow(r) ?? normalizePumpfunRow(r)).filter(Boolean);
            const loaded = store.loadBatch(profiles);
            totalLoaded += loaded;
            console.log('[dune] Query ' + qId + ': ' + loaded + ' wallets loaded (cached)');
            if (totalLoaded >= 3000) break;
          } else {
            console.log('[dune] Query ' + qId + ': only ' + rows.length + ' rows cached — skipping');
          }
        } catch (err) {
          console.warn('[dune] Saved query ' + qId + ' failed: ' + err.message);
        }
      }
      console.log('[dune] Phase 1 complete: ' + totalLoaded + ' wallets from saved queries');
    } else {
      console.log('[dune] Phase 1: No saved query IDs configured — skipping to Phase 2');
      console.log('[dune] Tip: Set DUNE_WALLET_QUERY_ID in Railway env to load pre-computed wallet data instantly');
    }

        // ── PHASE 2: Run our own SQL queries for fresh data ───────────────────────
    console.log('[dune] Phase 2: Running 5 targeted SQL queries for gem-hunter wallets...');

    // 2a: GEM HUNTERS — wallets that enter early (<150th buyer) on pump.fun consistently
    // This is the PRIMARY signal — these wallets find gems before everyone else
    try {
      const rows = await runDuneSQL(QUERIES.GEM_HUNTERS, 'gem_hunters', 120_000);
      const profiles = rows.map(r => {
        const addr = r.wallet_address;
        if (!addr || addr.length < 30) return null;
        const entries = Number(r.tokens_entered ?? 0);
        const avgRank = Number(r.avg_entry_rank ?? 50);
        return {
          address: addr,
          tradeCount: entries,
          earlyEntries: entries,
          avgEntrySpeed: Number(r.avg_entry_minutes ?? r.avg_entry_rank ?? 5) || 5,
          avgEntryRank: avgRank,
          bestEntryRank: Number(r.best_entry_rank ?? avgRank),
          avgRoi: 0,
          winRate10x: entries >= 50 ? 0.25 : entries >= 20 ? 0.15 : 0.05,
          source: 'dune_gem_hunters',
          score: Math.min(100, Math.round(entries * 0.5 + Math.max(0, 50 - avgRank))),
          category: avgRank <= 20 && entries >= 20 ? 'WINNER' : avgRank <= 50 ? 'SMART_MONEY' : 'MOMENTUM',
        };
      }).filter(Boolean);
      const n = store.loadBatch(profiles);
      totalLoaded += n;
      console.log(`[dune] Gem hunters: +${n} early-entry wallets loaded`);
    } catch (err) {
      console.warn('[dune] Gem hunters query failed:', err.message);
    }

    // 2b: Top PnL wallets (direct profit signal)
    try {
      const rows = await runDuneSQL(QUERIES.TOP_PNL_WALLETS, 'top_pnl', 90_000);
      const profiles = rows.map(normalizeTopPnlRow).filter(Boolean);
      const n = store.loadBatch(profiles);
      totalLoaded += n;
      console.log(`[dune] Top PnL wallets: +${n} loaded`);
    } catch (err) {
      console.warn('[dune] Top PnL query failed:', err.message);
    }

    // 2c: Pump.fun specific traders
    try {
      const rows = await runDuneSQL(QUERIES.PUMPFUN_TOP_TRADERS, 'pumpfun_traders', 90_000);
      const profiles = rows.map(normalizePumpfunRow).filter(Boolean);
      const n = store.loadBatch(profiles);
      totalLoaded += n;
      console.log(`[dune] Pump.fun traders: +${n} loaded`);
    } catch (err) {
      console.warn('[dune] Pump.fun query failed:', err.message);
    }

    // 2c: Early entry wallets (merge into existing profiles)
    try {
      const rows = await runDuneSQL(QUERIES.EARLY_ENTRY_WALLETS, 'early_entry', 90_000);
      const profiles = rows.map(normalizeEarlyEntryRow).filter(Boolean);
      let n = 0;
      for (const p of profiles) { store.set(p.address, p); n++; }
      console.log(`[dune] Early entry wallets: ${n} merged`);
    } catch (err) {
      console.warn('[dune] Early entry query failed:', err.message);
    }

    // 2d: Sniper detection (these should LOWER a token's score)
    try {
      const rows = await runDuneSQL(QUERIES.SNIPER_WALLETS, 'snipers', 60_000);
      const profiles = rows.map(normalizeSniperRow).filter(Boolean);
      let n = 0;
      for (const p of profiles) { store.set(p.address, p); n++; }
      console.log(`[dune] Sniper wallets: ${n} tagged`);
    } catch (err) {
      console.warn('[dune] Sniper query failed:', err.message);
    }

    // 2e: Targeted lookup — classify brain_scan wallets that Dune hasn't seen yet
    if (_db) {
      try {
        const brainAddrs = _db.prepare(
          `SELECT address FROM tracked_wallets WHERE source='brain_scan' AND (category='NEUTRAL' OR category IS NULL) LIMIT 200`
        ).all().map(r => r.address).filter(a => a && a.length >= 32);

        if (brainAddrs.length > 0) {
          console.log(`[dune] Targeted lookup: ${brainAddrs.length} brain_scan wallets...`);
          const addrList = brainAddrs.map(a => `'${a}'`).join(', ');
          const targetSQL = `
            SELECT
              taker                                AS wallet_address,
              COUNT(*)                             AS total_trades,
              SUM(amount_usd)                      AS total_volume_usd,
              AVG(amount_usd)                      AS avg_trade_usd,
              COUNT(DISTINCT token_bought_address) AS unique_tokens,
              MAX(block_time)                      AS last_active
            FROM dex.trades
            WHERE blockchain = 'solana'
              AND block_time >= NOW() - interval '30' day
              AND taker IN (${addrList})
              AND token_sold_symbol IN ('SOL', 'WSOL', 'USDC', 'USDT')
              AND amount_usd >= 1
            GROUP BY taker
            HAVING COUNT(*) >= 1
            ORDER BY total_volume_usd DESC
          `.trim();

          const rows = await runDuneSQL(targetSQL, 'brain_scan_lookup', 120_000);
          const upsert = _db.prepare(`
            UPDATE tracked_wallets
            SET category=?, score=?, trade_count=?, avg_roi=?, notes=?, updated_at=datetime('now')
            WHERE address=? AND source!='manual'
          `);
          const tx = _db.transaction((results) => {
            let classified = 0;
            for (const r of results) {
              const addr = r.wallet_address;
              if (!addr || addr.length < 32) continue;
              const trades  = Number(r.total_trades  || 0);
              const volume  = Number(r.total_volume_usd || 0);
              const tokens  = Number(r.unique_tokens  || 0);
              let cat = 'NEUTRAL', score = 0;
              if      (volume >= 100000 && trades >= 30) { cat = 'WINNER';      score = 82; }
              else if (volume >= 20000  && tokens >= 8)  { cat = 'SMART_MONEY'; score = 65; }
              else if (volume >= 5000   && tokens >= 5)  { cat = 'SMART_MONEY'; score = 55; }
              else if (trades >= 20     && tokens >= 3)  { cat = 'MOMENTUM';    score = 42; }
              else if (trades >= 5)                      { cat = 'MOMENTUM';    score = 28; }
              if (cat !== 'NEUTRAL') {
                upsert.run(cat, score, trades, Math.round(volume / Math.max(1, trades)),
                  `Dune: ${trades} trades · $${Math.round(volume).toLocaleString()} vol · ${tokens} tokens`, addr);
                classified++;
              }
            }
            return classified;
          });
          const classified = tx(rows);
          console.log(`[dune] Brain-scan targeted lookup: ${rows.length} found in Dune, ${classified} classified`);
        }
      } catch (err) {
        console.warn('[dune] Brain-scan targeted lookup failed:', err.message);
      }
    }

  } catch (err) {
    console.error('[dune] Scan error:', err.message);
  } finally {
    _scanning = false;
    store.lastSync  = Date.now();
    store.syncSource = 'dune_full_scan';
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const cats = store.getStatus().categories;
    console.log(`[dune] ━━━ Scan complete in ${elapsed}s ━━━`);
    console.log(`[dune] Total wallets: ${store.size()}`);
    console.log(`[dune] Categories: ${JSON.stringify(cats)}`);

    // Persist to SQLite so wallets survive restarts
    await persistWalletsToDB();
  }
}

// ── Persist in-memory wallet store → tracked_wallets SQLite ─────────────────
async function persistWalletsToDB() {
  if (!_db) return;
  try {
    const upsert = _db.prepare(`
      INSERT INTO tracked_wallets
        (address, label, category, source, win_rate, avg_roi, trade_count,
         score, notes, dune_data, is_watchlist, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,datetime('now'))
      ON CONFLICT(address) DO UPDATE SET
        category   = excluded.category,
        win_rate   = excluded.win_rate,
        avg_roi    = excluded.avg_roi,
        trade_count= excluded.trade_count,
        score      = excluded.score,
        dune_data  = excluded.dune_data,
        updated_at = datetime('now')
    `);

    const tx = _db.transaction((wallets) => {
      let saved = 0;
      for (const [addr, w] of wallets) {
        if (!addr || addr.length < 30) continue;
        if (w.category === 'NEUTRAL') continue;  // skip neutrals to save space
        const label = w.category === 'WINNER' ? '🏆 Winner'
          : w.category === 'SMART_MONEY' ? '🧠 Smart Money'
          : w.category === 'SNIPER' ? '🎯 Sniper'
          : w.category === 'MOMENTUM' ? '📈 Momentum'
          : w.category === 'CLUSTER' ? '⚠ Cluster'
          : w.category === 'RUG' ? '☠ Rug'
          : null;
        upsert.run(
          addr, label, w.category,
          w.source ?? 'dune_scan',
          w.winRate10x ?? 0,
          w.avgRoi ?? 0,
          w.tradeCount ?? 0,
          w.score ?? 0,
          `Win rate: ${((w.winRate10x??0)*100).toFixed(0)}% | Avg ROI: $${Math.round(w.avgRoi??0)} | Trades: ${w.tradeCount??0}`,
          JSON.stringify({ earlyEntries: w.earlyEntries, avgEntrySpeed: w.avgEntrySpeed, avgEntryRank: w.avgEntryRank }),
        );
        saved++;
      }
      return saved;
    });

    const saved = tx(store.db.entries());
    console.log(`[dune] ✓ Persisted ${saved} wallets to tracked_wallets DB`);
  } catch (err) {
    console.warn('[dune] DB persist failed:', err.message);
  }
}

// ─── Winner Wallet Builder ────────────────────────────────────────────────────
// Called by missed-winner-tracker.js / server.js when a call resolves as WIN.
// Extracts which wallets held the token early and records them as winners.

/**
 * Record a winning token's early holders as potential winner wallets.
 * Call this when a call resolves as WIN.
 *
 * @param {string}   tokenAddress  - The winning token's contract address
 * @param {string[]} earlyHolders  - Wallet addresses that held early
 * @param {number}   peakMultiple  - How many X it went (e.g. 5.2 for 5x)
 */
export function recordWinnerWallets(tokenAddress, earlyHolders = [], peakMultiple = 1) {
  if (!earlyHolders.length) return;

  let upgraded = 0;
  for (const addr of earlyHolders) {
    const existing = store.get(addr) ?? {
      address: addr, tradeCount: 1, winRate10x: 0,
      avgRoi: 0, avgEntrySpeed: 30, category: CAT.NEUTRAL, score: 20,
    };

    // Accumulate win data
    existing.winCount          = (existing.winCount ?? 0) + 1;
    existing.totalWinMultiple  = (existing.totalWinMultiple ?? 0) + peakMultiple;
    existing.avgWinMultiple    = existing.totalWinMultiple / existing.winCount;
    existing.lastWinToken      = tokenAddress;
    existing.lastWinAt         = Date.now();
    existing.winTokens         = [...(existing.winTokens ?? []).slice(-9), tokenAddress];

    // Upgrade category if they've appeared in multiple winners
    if (existing.winCount >= 5 && existing.avgWinMultiple >= 3) {
      existing.category = CAT.WINNER;
      existing.score    = Math.min(100, (existing.score ?? 50) + 10);
      upgraded++;
    } else if (existing.winCount >= 2) {
      if (existing.category === CAT.NEUTRAL) existing.category = CAT.SMART;
    }

    store.set(addr, existing);
  }

  if (upgraded > 0) {
    console.log(`[dune] ★ ${upgraded} wallets upgraded to WINNER after ${tokenAddress.slice(0,8)} (${peakMultiple}x)`);
  }
}

/**
 * Record a rugged/lost token's holders as suspicious.
 */
export function recordRugWallets(tokenAddress, earlyHolders = []) {
  for (const addr of earlyHolders) {
    const existing = store.get(addr) ?? { address: addr, category: CAT.NEUTRAL };
    existing.rugCount = (existing.rugCount ?? 0) + 1;
    if (existing.rugCount >= 3) {
      existing.category = CAT.RUG;
      existing.score    = 5;
    }
    store.set(addr, existing);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a wallet's full intelligence profile.
 */
export function getWalletProfile(address) {
  if (!address) return null;
  if (store.isBlacklisted(address)) {
    return { address, category: CAT.RUG, score: 0, isBlacklisted: true };
  }
  return store.get(address);
}

/**
 * Cross-reference a list of holder addresses against the wallet DB.
 * Returns full intelligence summary used in scoring and Claude analysis.
 */
export function crossReferenceHolders(addresses = []) {
  return store.crossRef(addresses);
}

/**
 * Get the current status of the wallet intelligence system.
 */
export function getDuneWalletStatus() {
  const s = store.getStatus();
  return {
    ...s,
    scanning:       _scanning,
    apiKeyPresent:  !!DUNE_API_KEY(),
    ready:          s.totalWallets > 0,
    message: s.totalWallets > 0
      ? `${s.totalWallets.toLocaleString()} wallets loaded — ${catEmoji[CAT.WINNER]} ${s.categories?.WINNER ?? 0} winners · ${catEmoji[CAT.SNIPER]} ${s.categories?.SNIPER ?? 0} snipers`
      : 'Loading from Dune...',
  };
}

/**
 * Add a wallet to the blacklist (instant block on future tokens it's in).
 */
export function blacklistWallet(address, reason = '') {
  store.addBlacklist(address);
  store.set(address, {
    address, category: CAT.RUG, score: 0,
    blacklisted: true, blacklistReason: reason,
  });
  console.log(`[dune] Blacklisted: ${address.slice(0,8)} — ${reason}`);
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let _scanTimer = null;

/**
 * Start the wallet scan scheduler.
 * Runs immediately then every 4 hours.
 */
export function startWalletScanner() {
  if (!DUNE_API_KEY()) {
    console.warn('[dune] DUNE_API_KEY not set — wallet scanner inactive');
    console.warn('[dune] Add DUNE_API_KEY to Railway environment variables');
    return null;
  }

  // First scan after 10 seconds (let server boot first)
  setTimeout(() => runDuneWalletScan().catch(err =>
    console.error('[dune] Initial scan failed:', err.message)
  ), 10_000);

  // Then every 4 hours
  _scanTimer = setInterval(() => runDuneWalletScan().catch(err =>
    console.error('[dune] Scheduled scan failed:', err.message)
  ), 4 * 3_600_000);

  console.log('[dune] Wallet scanner started — first scan in 10s, then every 4h');
  return _scanTimer;
}

export function stopWalletScanner() {
  if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null; }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
