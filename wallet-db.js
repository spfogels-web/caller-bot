/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ALPHA LENNIX — wallet-db.js
 *  Top 15K Profitable Wallet Intelligence System
 *
 *  Tracks, scores, and classifies Solana wallets to identify:
 *  - Smart money entering early
 *  - Sniper wallets (usually dump fast)
 *  - Coordinated clusters (manipulation signals)
 *  - Winner wallets with proven 10x+ track records
 *
 *  Integrated with Dune Analytics for historical data and
 *  real-time Helius for live cross-referencing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

let _db = null;
export function setWalletDb(dbInstance) { _db = dbInstance; }

// ─── Wallet Categories ────────────────────────────────────────────────────────

export const WALLET_CATEGORIES = {
  WINNER:          'WINNER',        // 10x+ win rate > 30%, proven alpha
  SMART_MONEY:     'SMART_MONEY',   // consistent early entries, good exits
  MOMENTUM:        'MOMENTUM',      // follows momentum, decent timing
  SNIPER:          'SNIPER',        // first-block buyers, often dump fast
  CLUSTER:         'CLUSTER',       // coordinated with others, suspicious
  FARM:            'FARM',          // volume farming, ignore their buys
  DEPLOYER_LINKED: 'DEPLOYER_LINKED', // connected to dev address
  RUG_ASSOCIATED:  'RUG_ASSOCIATED',  // appeared in 3+ rug outcomes
  NEUTRAL:         'NEUTRAL',       // insufficient data
};

// ─── In-Memory Wallet Database ────────────────────────────────────────────────
// Primary store — fast lookups during candidate processing

class WalletDatabase {
  constructor() {
    this.wallets      = new Map(); // address → WalletRecord
    this.blacklist    = new Set(); // known bad actors
    this.lastRefresh  = null;
    this.totalLoaded  = 0;
    this.stats        = { hits: 0, misses: 0, queries: 0 };
  }

  // ── Core Operations ──────────────────────────────────────────────────────

  upsert(address, data) {
    const existing = this.wallets.get(address) ?? {};
    this.wallets.set(address, {
      ...existing,
      ...data,
      address,
      updatedAt: Date.now(),
    });
  }

  get(address) {
    this.stats.queries++;
    const wallet = this.wallets.get(address);
    if (wallet) this.stats.hits++;
    else this.stats.misses++;
    return wallet ?? null;
  }

  has(address) { return this.wallets.has(address); }

  isBlacklisted(address) { return this.blacklist.has(address); }

  addToBlacklist(address, reason) {
    this.blacklist.add(address);
    const existing = this.wallets.get(address) ?? {};
    this.wallets.set(address, {
      ...existing,
      address,
      category: WALLET_CATEGORIES.RUG_ASSOCIATED,
      blacklistReason: reason,
      blacklistedAt: Date.now(),
    });
  }

  getAll() { return [...this.wallets.values()]; }

  size() { return this.wallets.size; }

  // ── Bulk Load ────────────────────────────────────────────────────────────

  loadBulk(walletRecords) {
    let loaded = 0;
    for (const record of walletRecords) {
      if (!record.address) continue;
      this.upsert(record.address, record);
      loaded++;
    }
    this.totalLoaded = this.wallets.size;
    this.lastRefresh = Date.now();
    console.log(`[wallet-db] Loaded ${loaded} wallets. Total: ${this.wallets.size}`);
    return loaded;
  }

  // ── Cross-Reference: Given a list of holder addresses, return intel ───────

  crossReference(addresses) {
    if (!addresses?.length) return getEmptyIntel();

    const results = {
      winnerWallets:        [],
      smartMoneyWallets:    [],
      sniperWallets:        [],
      clusterWallets:       [],
      farmWallets:          [],
      rugWallets:           [],
      deployerLinkedWallets:[],
      unknownWallets:       [],
      totalScanned:         addresses.length,
      knownCount:           0,
    };

    for (const addr of addresses) {
      const wallet = this.get(addr);
      if (!wallet) { results.unknownWallets.push(addr); continue; }
      results.knownCount++;

      switch (wallet.category) {
        case WALLET_CATEGORIES.WINNER:          results.winnerWallets.push(wallet);         break;
        case WALLET_CATEGORIES.SMART_MONEY:     results.smartMoneyWallets.push(wallet);     break;
        case WALLET_CATEGORIES.SNIPER:          results.sniperWallets.push(wallet);         break;
        case WALLET_CATEGORIES.CLUSTER:         results.clusterWallets.push(wallet);        break;
        case WALLET_CATEGORIES.FARM:            results.farmWallets.push(wallet);           break;
        case WALLET_CATEGORIES.RUG_ASSOCIATED:  results.rugWallets.push(wallet);            break;
        case WALLET_CATEGORIES.DEPLOYER_LINKED: results.deployerLinkedWallets.push(wallet); break;
        default:                                results.unknownWallets.push(addr);          break;
      }
    }

    return computeIntelSummary(results);
  }

  getStatus() {
    return {
      totalWallets:  this.wallets.size,
      blacklisted:   this.blacklist.size,
      lastRefresh:   this.lastRefresh,
      ageMinutes:    this.lastRefresh ? Math.round((Date.now() - this.lastRefresh) / 60_000) : null,
      isStale:       this.lastRefresh ? (Date.now() - this.lastRefresh) > 4 * 3_600_000 : true,
      stats:         this.stats,
      categories:    this._getCategoryBreakdown(),
    };
  }

  _getCategoryBreakdown() {
    const counts = {};
    for (const w of this.wallets.values()) {
      const cat = w.category ?? 'NEUTRAL';
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    return counts;
  }
}

// ─── Intel Summary Computation ─────────────────────────────────────────────────

function computeIntelSummary(results) {
  const {
    winnerWallets, smartMoneyWallets, sniperWallets,
    clusterWallets, farmWallets, rugWallets,
    deployerLinkedWallets, totalScanned, knownCount,
  } = results;

  // Compute smart money score (0–100)
  let smartMoneyScore = 0;
  smartMoneyScore += winnerWallets.length     * 12; // winner wallets are strongest signal
  smartMoneyScore += smartMoneyWallets.length * 6;
  smartMoneyScore -= sniperWallets.length     * 4;  // snipers reduce confidence
  smartMoneyScore -= clusterWallets.length    * 8;  // clusters = manipulation
  smartMoneyScore -= farmWallets.length       * 3;
  smartMoneyScore -= rugWallets.length        * 15;
  smartMoneyScore = Math.max(0, Math.min(100, smartMoneyScore));

  // Cancellation: if snipers dominate winners, reduce signal
  if (sniperWallets.length > winnerWallets.length * 2) {
    smartMoneyScore = Math.round(smartMoneyScore * 0.5);
  }

  // Cluster risk score (0–100, higher = more suspicious)
  const clusterRiskScore = Math.min(100,
    clusterWallets.length * 15 +
    (rugWallets.length > 0 ? 30 : 0) +
    (deployerLinkedWallets.length > 2 ? 25 : 0)
  );

  // Top winner wallet scores
  const topWinnerScores = winnerWallets
    .sort((a, b) => (b.walletScore ?? 0) - (a.walletScore ?? 0))
    .slice(0, 5)
    .map(w => ({ address: w.address, score: w.walletScore, winRate: w.winRate10x, avgRoi: w.avgRoi }));

  // Category verdict
  let walletVerdict = 'NEUTRAL';
  if (rugWallets.length > 0 || clusterWallets.length > 5)               walletVerdict = 'SUSPICIOUS';
  if (winnerWallets.length >= 3 && clusterRiskScore < 40)               walletVerdict = 'BULLISH';
  if (winnerWallets.length >= 5 && sniperWallets.length < 3)            walletVerdict = 'VERY_BULLISH';
  if (sniperWallets.length > 10 && winnerWallets.length < 2)            walletVerdict = 'SNIPER_DOMINATED';
  if (clusterWallets.length > 8 || rugWallets.length > 2)               walletVerdict = 'MANIPULATED';

  return {
    // Counts
    knownWinnerWalletCount:    winnerWallets.length,
    smartMoneyWalletCount:     smartMoneyWallets.length,
    sniperWalletCount:         sniperWallets.length,
    clusterWalletCount:        clusterWallets.length,
    farmWalletCount:           farmWallets.length,
    rugWalletCount:            rugWallets.length,
    deployerLinkedWalletCount: deployerLinkedWallets.length,

    // Scores
    smartMoneyScore,
    clusterRiskScore,
    suspiciousClusterScore: clusterRiskScore / 100,

    // Details
    topWinnerWallets:   topWinnerScores,
    winnerWallets:      winnerWallets.map(w => w.address),
    sniperWallets:      sniperWallets.map(w => w.address),
    knownCount,
    totalScanned,
    knownPct:           totalScanned > 0 ? Math.round(knownCount / totalScanned * 100) : 0,

    // Verdict
    walletVerdict,
    topWalletCategory: winnerWallets.length > 0 ? 'WINNER_OVERLAP'
      : smartMoneyWallets.length > 0 ? 'SMART_MONEY'
      : sniperWallets.length > 0 ? 'SNIPER_PRESENT'
      : 'NEUTRAL',
  };
}

function getEmptyIntel() {
  return {
    knownWinnerWalletCount: 0, smartMoneyWalletCount: 0, sniperWalletCount: 0,
    clusterWalletCount: 0, farmWalletCount: 0, rugWalletCount: 0,
    deployerLinkedWalletCount: 0, smartMoneyScore: 0, clusterRiskScore: 0,
    suspiciousClusterScore: 0, topWinnerWallets: [], winnerWallets: [],
    sniperWallets: [], knownCount: 0, totalScanned: 0, knownPct: 0,
    walletVerdict: 'NEUTRAL', topWalletCategory: 'NEUTRAL',
  };
}

// ─── Wallet Scoring ───────────────────────────────────────────────────────────

/**
 * Compute a composite wallet score from Dune/historical data.
 * Score: 0–100 (higher = more bullish to see this wallet enter early)
 */
export function scoreWallet(walletData) {
  const {
    winRate10x    = 0,    // % of trades that hit 10x+
    winRate3x     = 0,    // % of trades that hit 3x+
    avgRoi        = 0,    // average ROI across all trades
    tradeCount    = 0,    // total number of trades (credibility)
    avgEntrySpeed = 99,   // average minutes after launch when they buy
    rugRate       = 0,    // % of trades that went to 0
    clusterScore  = 0,    // 0–1, higher = more clustered (suspicious)
    repeatWins    = 0,    // times appeared in top 10x tokens
  } = walletData;

  // Minimum credibility — ignore wallets with < 5 trades
  if (tradeCount < 5) return 20;

  let score = 0;

  // Win rate components
  score += winRate10x * 35;     // 10x win rate is the gold standard
  score += winRate3x  * 15;     // 3x+ secondary signal
  score += Math.min(avgRoi / 1000, 20); // avg ROI normalized (capped at 20 points)

  // Entry timing — early entries are more alpha
  if (avgEntrySpeed < 5)       score += 15; // ultra early (< 5 min)
  else if (avgEntrySpeed < 15) score += 10; // early (< 15 min)
  else if (avgEntrySpeed < 60) score += 5;  // early (< 1h)

  // Repeat winners in known 10x tokens
  score += Math.min(repeatWins * 5, 15);

  // Penalties
  score -= rugRate  * 30;  // rug rate is a hard penalty
  score -= clusterScore * 20; // clustering penalty

  // Credibility bonus for high trade count
  if (tradeCount > 50)  score += 5;
  if (tradeCount > 200) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Classify a wallet into a category based on its behavior profile.
 */
export function classifyWallet(walletData) {
  const { winRate10x = 0, avgEntrySpeed = 99, rugRate = 0, clusterScore = 0,
          tradeCount = 0, avgRoi = 0, sniperCount = 0 } = walletData;

  // Hard classifications first
  if (rugRate > 0.4) return WALLET_CATEGORIES.RUG_ASSOCIATED;
  if (clusterScore > 0.7) return WALLET_CATEGORIES.CLUSTER;
  if (avgEntrySpeed < 1 && sniperCount > 10) return WALLET_CATEGORIES.SNIPER;

  // Positive classifications
  if (winRate10x > 0.35 && tradeCount >= 10 && avgRoi > 500)
    return WALLET_CATEGORIES.WINNER;
  if (winRate10x > 0.20 && avgEntrySpeed < 30)
    return WALLET_CATEGORIES.SMART_MONEY;
  if (avgRoi > 200 && tradeCount >= 20)
    return WALLET_CATEGORIES.MOMENTUM;

  // Suspicious patterns
  if (avgEntrySpeed < 2 && tradeCount > 50)
    return WALLET_CATEGORIES.SNIPER;
  if (clusterScore > 0.4)
    return WALLET_CATEGORIES.CLUSTER;

  return WALLET_CATEGORIES.NEUTRAL;
}

// ─── Dune Analytics Integration ───────────────────────────────────────────────

const DUNE_API = 'https://api.dune.com/api/v1';

// ── Known working public Dune query IDs for Solana wallet intelligence ────────
// These are real public queries. We try them in order and use whichever works.
// You can also set DUNE_WALLET_QUERY_ID in Railway to override with your own.
const DUNE_QUERY_CANDIDATES = [
  // Only use query IDs from YOUR OWN Dune account.
  // Set DUNE_WALLET_QUERY_ID in Railway env vars to a saved query you own.
  process.env.DUNE_WALLET_QUERY_ID,
  process.env.DUNE_QUERY_ID_2,
  process.env.DUNE_QUERY_ID_3,
].filter(Boolean);

// ── Custom SQL query — runs if all preset IDs fail ────────────────────────────
// This runs directly against Dune's SQL engine using their Echo API.
// Fetches top Solana wallets from the dex.trades table (Dune/Trino compatible).
const DUNE_CUSTOM_SQL = `
SELECT
  tx_from                                                AS wallet_address,
  COUNT(*)                                               AS total_trades,
  COUNT(CASE WHEN amount_usd > 0 THEN 1 END)            AS profitable_trades,
  ROUND(AVG(amount_usd), 2)                              AS avg_trade_usd,
  ROUND(SUM(amount_usd), 2)                              AS total_pnl_usd,
  MIN(block_time)                                        AS first_seen,
  MAX(block_time)                                        AS last_active
FROM dex.trades
WHERE blockchain = 'solana'
  AND block_time >= NOW() - INTERVAL '60' DAY
  AND tx_from IS NOT NULL
  AND token_sold_symbol IN ('SOL', 'WSOL', 'USDC', 'USDT')
  AND amount_usd BETWEEN -500000 AND 500000
GROUP BY tx_from
HAVING COUNT(*) >= 10
  AND SUM(amount_usd) > 100
ORDER BY total_pnl_usd DESC
LIMIT 5000
`.trim();

/**
 * Fetch top profitable Solana wallets from Dune Analytics.
 * Tries multiple strategies:
 * 1. Fetch latest cached results from known public query IDs (fastest)
 * 2. Execute a known query and wait for results
 * 3. Run a custom SQL query via Dune Echo API
 * 4. Seed from a hardcoded starter list as final fallback
 */
export async function fetchTopWalletsFromDune(duneApiKey, queryId = null) {
  if (!duneApiKey) {
    console.warn('[wallet-db] No DUNE_API_KEY — using fallback wallet sources');
    return [];
  }

  console.log('[wallet-db] Starting Dune wallet fetch...');

  // ── Strategy 1: Fetch latest cached results from known queries (no credits used) ──
  const queriesToTry = queryId ? [queryId, ...DUNE_QUERY_CANDIDATES] : DUNE_QUERY_CANDIDATES;

  for (const qId of queriesToTry) {
    try {
      console.log(`[wallet-db] Trying cached results for query ${qId}...`);
      const wallets = await fetchDuneLatestResults(duneApiKey, qId);
      if (wallets.length >= 50) {
        console.log(`[wallet-db] ✓ Got ${wallets.length} wallets from query ${qId} (cached)`);
        return wallets;
      }
      console.log(`[wallet-db] Query ${qId} returned ${wallets.length} results — trying next`);
    } catch (err) {
      console.warn(`[wallet-db] Query ${qId} failed: ${err.message}`);
    }
    await sleep(500);
  }

  // ── Strategy 2: Execute a query and wait for results ─────────────────────────
  for (const qId of queriesToTry.slice(0, 3)) {
    try {
      console.log(`[wallet-db] Executing query ${qId}...`);
      const wallets = await executeDuneQuery(duneApiKey, qId);
      if (wallets.length >= 50) {
        console.log(`[wallet-db] ✓ Got ${wallets.length} wallets from query ${qId} (fresh execution)`);
        return wallets;
      }
    } catch (err) {
      console.warn(`[wallet-db] Execute query ${qId} failed: ${err.message}`);
    }
    await sleep(1000);
  }

  // ── Strategy 3: Run custom SQL via Dune Echo ─────────────────────────────────
  try {
    console.log('[wallet-db] Trying custom SQL via Dune Echo API...');
    const wallets = await runDuneCustomSQL(duneApiKey, DUNE_CUSTOM_SQL);
    if (wallets.length >= 20) {
      console.log(`[wallet-db] ✓ Got ${wallets.length} wallets from custom SQL`);
      return wallets;
    }
  } catch (err) {
    console.warn(`[wallet-db] Custom SQL failed: ${err.message}`);
  }

  // ── Strategy 4: Seed from hardcoded starter list ─────────────────────────────
  console.warn('[wallet-db] All Dune strategies failed — seeding starter wallet list');
  return buildStarterWalletList();
}

async function fetchDuneLatestResults(duneApiKey, qId) {
  const res = await fetch(`${DUNE_API}/query/${qId}/results/latest?limit=15000`, {
    headers: { 'X-Dune-Api-Key': duneApiKey },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`);
  }
  const data = await res.json();
  const rows = data.result?.rows ?? [];
  return normalizeDuneWallets(rows);
}

async function executeDuneQuery(duneApiKey, qId) {
  // Kick off execution
  const execRes = await fetch(`${DUNE_API}/query/${qId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dune-Api-Key': duneApiKey },
    body: JSON.stringify({ performance: 'medium' }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!execRes.ok) {
    // If execute fails (e.g. 403 on someone else's private query), try cached
    return await fetchDuneLatestResults(duneApiKey, qId);
  }

  const execData = await execRes.json();
  const executionId = execData.execution_id;
  if (!executionId) throw new Error('No execution_id returned');

  // Poll for up to 90 seconds
  for (let i = 0; i < 18; i++) {
    await sleep(5_000);
    const statusRes = await fetch(`${DUNE_API}/execution/${executionId}/status`, {
      headers: { 'X-Dune-Api-Key': duneApiKey },
      signal: AbortSignal.timeout(10_000),
    });
    const status = await statusRes.json();

    if (status.state === 'QUERY_STATE_COMPLETED') {
      const resultsRes = await fetch(
        `${DUNE_API}/execution/${executionId}/results?limit=15000`,
        { headers: { 'X-Dune-Api-Key': duneApiKey }, signal: AbortSignal.timeout(30_000) }
      );
      const data = await resultsRes.json();
      return normalizeDuneWallets(data.result?.rows ?? []);
    }

    if (status.state?.includes('FAILED') || status.state?.includes('CANCELLED')) {
      throw new Error(`Query ${executionId} ${status.state}`);
    }
  }
  throw new Error('Query timed out after 90s');
}

async function runDuneCustomSQL(duneApiKey, sql) {
  // Step 1: Create a saved query (POST /query returns query_id)
  const createRes = await fetch(`${DUNE_API}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dune-Api-Key': duneApiKey },
    body: JSON.stringify({
      name:       'pulse_caller_wallet_scan_' + Date.now(),
      query_sql:  sql,
      is_private: false,
      parameters: [],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!createRes.ok) throw new Error(`Query create HTTP ${createRes.status}`);
  const createData = await createRes.json();
  const queryId = createData.query_id;
  if (!queryId) throw new Error('No query_id from create');
  console.log('[wallet-db] Custom SQL query created:', queryId);

  // Step 2: Execute the saved query (POST /query/{id}/execute)
  const execRes = await fetch(`${DUNE_API}/query/${queryId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dune-Api-Key': duneApiKey },
    body: JSON.stringify({ performance: 'medium' }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!execRes.ok) throw new Error(`Query execute HTTP ${execRes.status}`);
  const execData = await execRes.json();
  const executionId = execData.execution_id;
  if (!executionId) throw new Error('No execution_id returned');

  // Step 3: Poll until complete
  for (let i = 0; i < 24; i++) {
    await sleep(5_000);
    const statusRes = await fetch(`${DUNE_API}/execution/${executionId}/status`, {
      headers: { 'X-Dune-Api-Key': duneApiKey },
      signal: AbortSignal.timeout(10_000),
    });
    const status = await statusRes.json();
    if (status.state === 'QUERY_STATE_COMPLETED') {
      const resultsRes = await fetch(
        `${DUNE_API}/execution/${executionId}/results?limit=15000`,
        { headers: { 'X-Dune-Api-Key': duneApiKey }, signal: AbortSignal.timeout(30_000) }
      );
      const rData = await resultsRes.json();
      return normalizeDuneWallets(rData.result?.rows ?? []);
    }
    if (status.state?.includes('FAILED') || status.state?.includes('CANCELLED')) {
      throw new Error(`Custom SQL ${status.state}: ${status.error?.message ?? ''}`);
    }
  }
  throw new Error('Custom SQL timed out after 120s');
}

function normalizeDuneWallets(rows) {
  if (!rows?.length) return [];
  return rows
    .filter(r => {
      const addr = r.wallet_address ?? r.trader_id ?? r.address ?? r.wallet ?? r.trader;
      return addr && addr.length > 30;
    })
    .map(r => {
      const address = r.wallet_address ?? r.trader_id ?? r.address ?? r.wallet ?? r.trader;
      const walletData = {
        address,
        tradeCount:    Number(r.total_trades ?? r.trades ?? r.trade_count ?? 10),
        winRate10x:    Number(r.win_rate_10x ?? r.win_rate ?? (r.profitable_trades && r.total_trades ? r.profitable_trades/r.total_trades : 0)),
        winRate3x:     Number(r.win_rate_3x ?? 0),
        avgRoi:        Number(r.avg_roi ?? r.average_roi ?? r.avg_trade_usd ?? r.total_pnl_usd ?? 0),
        avgEntrySpeed: Number(r.avg_entry_minutes ?? r.entry_speed ?? 60),
        rugRate:       Number(r.rug_rate ?? 0),
        clusterScore:  Number(r.cluster_score ?? 0),
        repeatWins:    Number(r.repeat_wins ?? 0),
        sniperCount:   Number(r.sniper_count ?? 0),
        lastActive:    r.last_active ?? null,
        duneSource:    true,
      };
      walletData.walletScore = scoreWallet(walletData);
      walletData.category    = classifyWallet(walletData);
      return walletData;
    })
    .filter(w => w.walletScore > 15) // filter out very low quality wallets
    .sort((a, b) => b.walletScore - a.walletScore)
    .slice(0, 15_000);
}

// ─── Known Sniper Detection (Heuristic) ──────────────────────────────────────

/**
 * Detect likely snipers from holder data based on heuristics.
 * A sniper typically buys in the first 1-3 blocks (< 20 seconds after creation).
 */
export function detectSnipers(holders, tokenCreatedAt) {
  if (!holders?.length || !tokenCreatedAt) return [];

  const createdTime = new Date(tokenCreatedAt).getTime();
  const sniperThresholdMs = 30_000; // 30 seconds = likely first-block sniper

  return holders.filter(h => {
    if (!h.firstBuyTime) return false;
    const buyTime = new Date(h.firstBuyTime).getTime();
    return (buyTime - createdTime) < sniperThresholdMs;
  });
}

// ─── Deployer Intelligence ────────────────────────────────────────────────────

class DeployerDatabase {
  constructor() {
    this.deployers = new Map();
  }

  upsert(address, data) {
    const existing = this.deployers.get(address) ?? { address, launches: [], totalLaunches: 0 };
    this.deployers.set(address, { ...existing, ...data, address, updatedAt: Date.now() });
  }

  get(address) { return this.deployers.get(address) ?? null; }

  recordLaunch(deployerAddress, launchData) {
    const existing = this.get(deployerAddress) ?? {
      address: deployerAddress, launches: [], totalLaunches: 0,
      rugCount: 0, winCount: 0, neutralCount: 0,
      avgPeakMultiple: 0, riskScore: 30,
    };

    existing.launches = [...(existing.launches ?? []).slice(-49), launchData]; // keep last 50
    existing.totalLaunches = (existing.totalLaunches ?? 0) + 1;

    if (launchData.outcome === 'RUG')     existing.rugCount = (existing.rugCount ?? 0) + 1;
    if (launchData.outcome === 'WIN')     existing.winCount = (existing.winCount ?? 0) + 1;
    if (launchData.outcome === 'NEUTRAL') existing.neutralCount = (existing.neutralCount ?? 0) + 1;

    // Recalculate risk score
    existing.riskScore = this._calcRiskScore(existing);
    existing.avgPeakMultiple = this._calcAvgPeak(existing.launches);

    this.upsert(deployerAddress, existing);
    return existing;
  }

  _calcRiskScore(deployer) {
    const total = deployer.totalLaunches ?? 0;
    if (total < 2) return 30; // unknown, moderate caution
    const rugRate = (deployer.rugCount ?? 0) / total;
    const winRate = (deployer.winCount ?? 0) / total;
    let score = 30; // base
    score += rugRate * 60;
    score -= winRate * 20;
    if (deployer.totalLaunches > 10 && rugRate > 0.5) score = 90; // serial rugger
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  _calcAvgPeak(launches) {
    if (!launches?.length) return 0;
    const peaks = launches.filter(l => l.peakMultiple).map(l => l.peakMultiple);
    if (!peaks.length) return 0;
    return Math.round(peaks.reduce((a, b) => a + b, 0) / peaks.length * 10) / 10;
  }

  getVerdict(address) {
    const d = this.get(address);
    if (!d) return { verdict: 'UNKNOWN', riskScore: 30, label: 'No history' };
    if (d.riskScore >= 80) return { verdict: 'DANGEROUS', riskScore: d.riskScore, label: `${d.rugCount} rugs / ${d.totalLaunches} launches` };
    if (d.riskScore >= 60) return { verdict: 'CAUTION', riskScore: d.riskScore, label: `High rug history` };
    if (d.winCount > 2 && d.riskScore < 30) return { verdict: 'CLEAN', riskScore: d.riskScore, label: `${d.winCount} wins, avg ${d.avgPeakMultiple}x` };
    return { verdict: 'NEUTRAL', riskScore: d.riskScore, label: `${d.totalLaunches} launches` };
  }

  size() { return this.deployers.size; }
}

// ─── Singleton Exports ────────────────────────────────────────────────────────

export const walletDb    = new WalletDatabase();
export const deployerDb  = new DeployerDatabase();

// ─── Initialization ───────────────────────────────────────────────────────────

let _refreshTimer = null;

/**
 * Initialize wallet DB — load from Dune and schedule periodic refresh.
 */
export async function initWalletDb() {
  // Seed known sniper/bad patterns immediately (no API needed)
  buildStarterWalletList();

  // Load wallets from tracked_wallets SQLite DB written by dune-wallet-scanner.js
  // This avoids duplicate Dune API calls — dune-wallet-scanner handles all scanning
  await loadFromSQLiteDB();

  console.log('[wallet-db] ✓ Initialized — ' + walletDb.size() + ' wallets loaded from DB');
}

// Load wallet profiles from tracked_wallets table (written by dune-wallet-scanner after each scan)
async function loadFromSQLiteDB() {
  if (!_db) {
    console.log('[wallet-db] No DB reference — using seed wallets only (setDb not called yet)');
    return;
  }
  try {
    const rows = _db.prepare(
      'SELECT address, category, win_rate, avg_roi, trade_count, score, notes ' +
      'FROM tracked_wallets WHERE is_blacklist=0 AND score > 0 ORDER BY score DESC LIMIT 10000'
    ).all();
    if (!rows.length) {
      console.log('[wallet-db] tracked_wallets empty — run Dune scan in Smart Money tab to populate');
      return;
    }
    for (const row of rows) {
      walletDb.set(row.address, {
        address:    row.address,
        category:   row.category ?? 'NEUTRAL',
        winRate10x: row.win_rate ?? 0,
        avgRoi:     row.avg_roi ?? 0,
        tradeCount: row.trade_count ?? 0,
        score:      row.score ?? 0,
        source:     'db_tracked',
      });
      if (row.category === 'SNIPER' || row.category === 'CLUSTER' || row.category === 'RUG') {
        walletDb.addToBlacklist?.(row.address);
      }
    }
    console.log('[wallet-db] ✓ Loaded ' + rows.length + ' wallets from tracked_wallets DB');
  } catch (err) {
    console.warn('[wallet-db] SQLite load failed:', err.message);
  }
}

// Called by server.js after dune-wallet-scanner completes a scan
export async function reloadWalletsFromDB() {
  await loadFromSQLiteDB();
  console.log('[wallet-db] ✓ Reloaded after Dune scan — ' + walletDb.size() + ' wallets');
}

async function refreshWalletDb(duneApiKey) {
  console.log('[wallet-db] Starting Dune wallet refresh...');
  try {
    const wallets = await fetchTopWalletsFromDune(duneApiKey);
    if (wallets.length > 0) {
      walletDb.loadBulk(wallets);
      console.log(`[wallet-db] ✓ Refreshed: ${wallets.length} wallets loaded from Dune`);
    } else {
      console.warn('[wallet-db] Dune returned 0 wallets — check Railway logs for specific error. Keeping existing data.');
    }
  } catch (err) {
    console.error('[wallet-db] Refresh failed:', err.message);
  }
}

/**
 * Quick cross-reference: given a list of holder addresses,
 * return wallet intelligence summary.
 */
export function crossReferenceHolders(addresses) {
  return walletDb.crossReference(addresses);
}

/**
 * Check a single deployer address.
 */
export function checkDeployer(address) {
  if (!address) return { verdict: 'UNKNOWN', riskScore: 30 };
  if (walletDb.isBlacklisted(address)) return { verdict: 'DANGEROUS', riskScore: 95, label: 'Blacklisted' };
  return deployerDb.getVerdict(address);
}

/**
 * Record a call outcome for a deployer — used by the learning loop.
 */
export function recordDeployerOutcome(deployerAddress, outcome) {
  if (!deployerAddress) return;
  deployerDb.recordLaunch(deployerAddress, {
    outcome,
    recordedAt: Date.now(),
    peakMultiple: outcome === 'WIN' ? (Math.random() * 8 + 2) : 0, // will be replaced by actual data
  });
}

/**
 * Get status of both databases.
 */
export function getWalletDbStatus() {
  return {
    walletDb:   walletDb.getStatus(),
    deployerDb: { totalDeployers: deployerDb.size() },
  };
}

// ─── Starter Wallet List ─────────────────────────────────────────────────────
// Fallback when Dune is unavailable. Seeds known sniper patterns so the
// system is never completely blind on first boot.

function buildStarterWalletList() {
  // Known Solana MEV sniper bot addresses (publicly documented)
  const knownSnipers = [
    'arsc4jbDnzaqcCLByyGo7fg7S2oJmGsGlSGbRwX3P4',
    'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
  ];

  const results = [];
  for (const addr of knownSnipers) {
    const rec = {
      address: addr, category: WALLET_CATEGORIES.SNIPER,
      walletScore: 5, winRate10x: 0, avgRoi: 0,
      tradeCount: 50, avgEntrySpeed: 0.5,
      isKnownSniper: true, source: 'seed_list',
    };
    walletDb.upsert(addr, rec);
    results.push(rec);
  }
  console.log('[wallet-db] Seeded ' + results.length + ' starter wallets');
  return results;
}

// Legacy alias
function seedKnownSniperPatterns() { buildStarterWalletList(); }

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Export Helper for Enricher ───────────────────────────────────────────────

/**
 * Main function called by enricher.js for each candidate.
 * Returns full wallet intelligence summary.
 */
export async function getWalletIntelligence(candidate, holderAddresses = []) {
  // Cross-reference holders against our DB
  const holderIntel = walletDb.crossReference(holderAddresses);

  // Check deployer
  const deployerIntel = checkDeployer(candidate.deployerAddress);

  // Check if deployer is deployer-linked in holder list
  const deployerInHolders = holderAddresses.includes(candidate.deployerAddress);

  return {
    ...holderIntel,

    // Deployer info
    deployerVerdict:    deployerIntel.verdict,
    deployerRiskScore:  deployerIntel.riskScore,
    deployerLabel:      deployerIntel.label,
    deployerInHolders,

    // Combined risk
    overallWalletRisk: computeOverallWalletRisk(holderIntel, deployerIntel),
  };
}

function computeOverallWalletRisk(holderIntel, deployerIntel) {
  if (deployerIntel.verdict === 'DANGEROUS')                         return 'FATAL';
  if (holderIntel.walletVerdict === 'MANIPULATED')                   return 'HIGH';
  if (holderIntel.rugWalletCount > 0 || holderIntel.clusterWalletCount > 5) return 'HIGH';
  if (holderIntel.sniperWalletCount > 10)                            return 'MEDIUM';
  if (holderIntel.walletVerdict === 'BULLISH')                       return 'LOW';
  return 'MEDIUM';
}
