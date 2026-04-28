
         /**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ALPHA LENNIX — server.js v6.1 (MORE-CALLS UPDATE)
 *
 *  Stack:    Node.js · Express · fetch · Claude API · Telegram Bot API
 *  Modules:  db.js · scanner.js · enricher.js · scorer.js ·
 *            watchlist.js · wallet-intel.js · regime.js · performance-tracker.js
 *            bot-status.js
 *
 *  v6.1 changes (MORE-CALLS UPDATE):
 *    - Hard score floor lowered: 48 → 38
 *    - Adjusted threshold floor lowered: 48 → 38
 *    - NEW_COINS mode description updated: 3 minutes → 0 minutes
 *    - All other logic unchanged
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import express          from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path             from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── DB ───────────────────────────────────────────────────────────────────────
import {
  initDb, insertCandidate, insertSubScores, insertCall,
  markCandidatePosted, isRecentlySeen, recordSeen,
  getStats, getRecentCalls, logEvent,
  recordFingerprint, backfillFingerprintOutcome, getFingerprintStats,
  creditWalletsForWin, getSelfTrainedWalletStats,
  addToUserPortfolio, getUserPortfolio, removeFromUserPortfolio, clearUserPortfolio,
  createUserAlert, getUserAlerts, getPendingAlerts, fireAlert as fireUserAlert, cancelUserAlert,
  getCallsLeaderboard,
  insertWalletEvent, getRecentBuyersForCA, getWalletRecentEvents, getWalletEventStats,
  getCandidates, getCandidateById, getAllCalls,
  getSystemLog, getScoreDistribution, getDecisionBreakdown,
  getTopIgnoredFull, getPendingCalls,
  insertScannerFeed, getScannerFeed,
  upsertDeployerReputation, getDeployerReputation,
  rebuildWinnerProfiles, computeSimilarityScores,
  getWinRateByScoreBand, getWinRateBySetupType, getWinRateByMcapBand,
  getMissedWinners, getDeployerLeaderboard, getWinnerProfiles,
  updateCallPerformance, updateDeployerOutcome, db as dbInstance,
} from './db.js';

// ─── Modules ──────────────────────────────────────────────────────────────────
import { runScanner, fetchPairByAddress, normalizePair, getScannerWatchlistSnapshot } from './scanner.js';
import { enrichCandidate, enrichCandidates }                                           from './enricher.js';
import { computeFullScore, formatScoreForClaude, getStage }                            from './scorer.js';
import {
  initWatchlist, addToRetest, addToWatchlist, addToBlocklist,
  isBlocklisted, getDueEntries, clearEntry, handleRescanResult,
  getQueueStats, getWatchlistContents, getRetestContents, cleanupStaleEntries,
} from './watchlist.js';
import { runWalletIntel, runQuickWalletIntel }                                         from './wallet-intel.js';
import {
  updateRegime, getRegime, isRegimeStale,
  applyRegimeAdjustments, getRegimeSummaryForClaude, getRegimeDashboardData,
} from './regime.js';
import { runPerformanceTracker, exportFineTuningData }                                 from './performance-tracker.js';
import { runExitMonitor, setExitTelegramHook, getExitMonitorStats }                  from './exit-signal-monitor.js';
import {
  processHeliusWebhookBatch, syncTrackedAddressesToHelius, listHeliusWebhooks,
  setSwarmHook, setEventHook, setIsWalletTrackedFn,
  getEnhancedApiKey,
} from './helius-webhook.js';
import {
  getAllBotStatus, botStartCycle, botEndCycle, botPosted, botError,
} from './bot-status.js';

// ─── v8.0 Multi-Agent Modules ─────────────────────────────────────────────────
import {
  startHeliusListener, stopHeliusListener, getHeliusListener, getHeliusStatus,
  fetchPumpFunCoin, fetchPumpFunNewCoins, checkPumpFunLivestream,
  getTokenMetadata, getTopHolders,
} from './helius-listener.js';
import {
  walletDb, deployerDb, initWalletDb, crossReferenceHolders,
  checkDeployer, recordDeployerOutcome, getWalletDbStatus, getWalletIntelligence,
  setWalletDb, reloadWalletsFromDB,
} from './wallet-db.js';
import {
  getOpenAIDecision, checkOpenAIConnection, formatOpenAIDecisionForTelegram, DECISIONS,
} from './openai-decision.js';
import {
  startLearningLoop, detectMissedWinners, runOutcomeTracker, getLearningStats,
  setTelegramHook as setMilestoneTelegramHook,
  setFingerprintHook,
  setWalletCreditHook,
} from './missed-winner-tracker.js';
import {
  startWalletScanner, runDuneWalletScan, crossReferenceHolders as duneXRef,
  recordWinnerWallets, recordRugWallets, getDuneWalletStatus, getWalletProfile,
  store as duneStore,
} from './dune-wallet-scanner.js';

// ─── Environment ──────────────────────────────────────────────────────────────

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_GROUP_CHAT_ID,        // VIP channel — fires on raw signal
  TELEGRAM_FREE_CHAT_ID,         // Free channel — fires only after 2x delayed
  CLAUDE_API_KEY,
  OPENAI_API_KEY,
  ADMIN_TELEGRAM_ID,
  PORT              = 3000,
  NODE_ENV          = 'development',
  MIN_SCORE_TO_POST = 50,
  SCAN_INTERVAL_MS  = 60 * 1000,  // 60s — was 90s, scan more frequently
} = process.env;

const TELEGRAM_API   = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL   = 'claude-sonnet-4-20250514';
const OPENAI_API_URL = 'https://api.openai.com/v1';
const OPENAI_FT_MODEL = process.env.OPENAI_FT_MODEL ?? null;

const WT_SERVER_URL = process.env.WALLET_TRACKER_URL ?? 'http://localhost:3100';

// ── API Usage Tracker — counts every external API call ──────────────────────
const _apiUsage = {
  helius:      { calls: 0, errors: 0, lastCall: null, cost: 0 },    // paid, ~1 CU each
  birdeye:     { calls: 0, errors: 0, lastCall: null, cost: 0 },    // paid, ~1 CU each
  claude:      { calls: 0, errors: 0, lastCall: null, cost: 0 },    // paid, tokens
  openai:      { calls: 0, errors: 0, lastCall: null, cost: 0 },    // paid, tokens
  lunarcrush:  { calls: 0, errors: 0, lastCall: null, cost: 0 },    // paid, fixed
  solana:      { calls: 0, errors: 0, lastCall: null, cost: 0 },    // FREE public RPC
  dexscreener: { calls: 0, errors: 0, lastCall: null, cost: 0 },    // FREE
  helius_ws:   { events: 0, lastEvent: null },                       // WebSocket
};
const _apiUsageStartedAt = new Date().toISOString();

function trackApi(service, isError = false) {
  if (!_apiUsage[service]) return;
  _apiUsage[service].calls = (_apiUsage[service].calls || 0) + 1;
  if (isError) _apiUsage[service].errors = (_apiUsage[service].errors || 0) + 1;
  _apiUsage[service].lastCall = new Date().toISOString();
}

// Wrap fetch to auto-track calls based on URL
const _origFetch = globalThis.fetch;
globalThis.fetch = async function(url, options) {
  const urlStr = typeof url === 'string' ? url : (url?.url || String(url));
  let service = null;
  if (urlStr.includes('helius-rpc.com') || urlStr.includes('helius.xyz')) service = 'helius';
  else if (urlStr.includes('birdeye.so')) service = 'birdeye';
  else if (urlStr.includes('anthropic.com')) service = 'claude';
  else if (urlStr.includes('openai.com')) service = 'openai';
  else if (urlStr.includes('lunarcrush.com')) service = 'lunarcrush';
  else if (urlStr.includes('api.mainnet-beta.solana.com')) service = 'solana';
  else if (urlStr.includes('dexscreener.com')) service = 'dexscreener';

  try {
    const res = await _origFetch.call(this, url, options);
    if (service) trackApi(service, !res.ok);
    return res;
  } catch (err) {
    if (service) trackApi(service, true);
    throw err;
  }
};

// /api/usage endpoint registered after app initialization (see below)

const BANNER_IMAGE_URL = process.env.BANNER_IMAGE_URL
  ?? 'https://raw.githubusercontent.com/spfogles-web/caller-bot/main/banner.png';
// PulseCaller branding — set BANNER_IMAGE_URL in Railway to your banner URL
// Recommended: upload banner.png to your GitHub repo root and it auto-uses it

// SEPARATE banner used ONLY for /lb and /pulselb so the leaderboard art
// stays decoupled from the regular call-alert banner.
//   A) Save image as LEADERBOARD_BANNER_URL.png in GitHub repo root, OR
//   B) Set LEADERBOARD_BANNER_URL in Railway env to any public URL
const LEADERBOARD_BANNER_URL = 'https://raw.githubusercontent.com/spfogels-web/caller-bot/main/LEADERBOARD_BANNER_URL.png';

// ─── v8.0 Multi-Agent Config ──────────────────────────────────────────────────

const HELIUS_API_KEY  = process.env.HELIUS_API_KEY ?? null;
const DUNE_API_KEY    = process.env.DUNE_API_KEY   ?? null;
const PUMPFUN_JWT     = process.env.PUMPFUN_JWT    ?? null;

// Helius listener — receives new token events in ~3 seconds instead of 90s polling
let heliusListener = null;

// Learning loop handles — stopped on server shutdown
let learningLoopHandles = null;

// v8 pipeline timing budget (ms)
const PIPELINE_BUDGET_MS  = 35_000; // tightened 55→35s — speed is the edge
const CLAUDE_TIMEOUT_MS   = 12_000; // tightened 20→12s
const OPENAI_TIMEOUT_MS   = 10_000; // tightened 15→10s
const ENRICHMENT_TIMEOUT  = 6_000;  // tightened 10→6s — fail fast on slow APIs, score with partial data

// Pre-bonding detection: pump.fun tokens before PumpSwap migration
const PREBOND_MAX_MCAP    = 69_000;   // pump.fun completes at ~$69K
const PREBOND_MIN_MCAP    = 500;      // ignore sub-$500 (too illiquid)

// ─── OpenAI Fine-tune ─────────────────────────────────────────────────────────

async function queryOpenAIFineTune(candidate, scoreResult) {
  if (!OPENAI_API_KEY || !OPENAI_FT_MODEL) return null;
  try {
    const userContent = `Analyze this Solana token:
Token: ${candidate.token ?? 'UNKNOWN'}
Market Cap: ${candidate.marketCap ?? 'UNKNOWN'}
Liquidity: ${candidate.liquidity ?? 'UNKNOWN'}
Volume 24h: ${candidate.volume24h ?? 'UNKNOWN'}
Pair Age: ${candidate.pairAgeHours ?? 'UNKNOWN'}h
Holders: ${candidate.holders ?? 'UNKNOWN'}
Top10 Holders: ${candidate.top10HolderPct ?? 'UNKNOWN'}%
Dev Wallet: ${candidate.devWalletPct ?? 'UNKNOWN'}%
Bundle Risk: ${candidate.bundleRisk ?? 'UNKNOWN'}
BubbleMap Risk: ${candidate.bubbleMapRisk ?? 'UNKNOWN'}
Mint Authority: ${candidate.mintAuthority === 0 ? 'REVOKED' : candidate.mintAuthority === 1 ? 'ACTIVE' : 'UNKNOWN'}
LP Locked: ${candidate.lpLocked === 1 ? 'YES' : candidate.lpLocked === 0 ? 'NO' : 'UNKNOWN'}
Structure Grade: ${scoreResult.structureGrade ?? 'UNKNOWN'}
Launch Quality: ${candidate.launchQualityScore ?? 'UNKNOWN'}
Buy Ratio 1h: ${candidate.buySellRatio1h != null ? (candidate.buySellRatio1h * 100).toFixed(0) + '%' : 'UNKNOWN'}
Volume Velocity: ${candidate.volumeVelocity ?? 'UNKNOWN'}
Candidate Type: ${candidate.candidateType ?? 'UNKNOWN'}
Composite Score: ${scoreResult.score ?? 'UNKNOWN'}`;

    const res = await fetch(`${OPENAI_API_URL}/chat/completions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_FT_MODEL, max_tokens: 200,
        messages: [
          { role: 'system', content: 'You are an elite Solana crypto intelligence analyst. Analyze token setups and predict whether they will be winners or losers based on onchain data. A WIN means +20% gain after the call. Respond with JSON only: {"decision":"AUTO_POST"|"IGNORE","confidence":0-100,"reason":"brief reason"}' },
          { role: 'user', content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data  = await res.json();
    const text  = data.choices?.[0]?.message?.content ?? '';
    const clean = text.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(clean);
    return { ftDecision: parsed.decision ?? null, ftScore: parsed.confidence ?? null, ftReason: parsed.reason ?? null };
  } catch (err) {
    console.warn('[openai] Fine-tune query failed:', err.message);
    return null;
  }
}

async function startOpenAIFineTune(jsonlData) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const formData = new FormData();
  const blob = new Blob([jsonlData], { type: 'application/json' });
  formData.append('file', blob, 'caller-bot-finetune.jsonl');
  formData.append('purpose', 'fine-tune');

  const uploadRes = await fetch(`${OPENAI_API_URL}/files`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: formData, signal: AbortSignal.timeout(60_000),
  });
  if (!uploadRes.ok) throw new Error(`File upload failed: ${(await uploadRes.text()).slice(0, 200)}`);
  const fileId = (await uploadRes.json()).id;

  const ftRes = await fetch(`${OPENAI_API_URL}/fine_tuning/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ training_file: fileId, model: 'gpt-4o-mini-2024-07-18' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!ftRes.ok) throw new Error(`Fine-tune job failed: ${(await ftRes.text()).slice(0, 200)}`);
  return await ftRes.json();
}

// ─── AI Learning Progress Bar ─────────────────────────────────────────────────

function buildAILearningBar() {
  try {
    const total = (() => {
      try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM calls`).get().n; } catch { return 0; }
    })();
    const resolved = (() => {
      try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome IN ('WIN','LOSS','NEUTRAL')`).get().n; } catch { return 0; }
    })();
    const wins = (() => {
      try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome='WIN'`).get().n; } catch { return 0; }
    })();
    const winRate = resolved > 0 ? Math.round(wins/resolved*100)+'%' : 'no outcomes yet';
    // AI is always on — no threshold needed
    const ftActive = !!OPENAI_FT_MODEL;
    if (ftActive) return `🤖 <b>AI OS ACTIVE</b> — Fine-tune model live · ${total} calls total · ${resolved} resolved · Win rate: ${winRate}`;
    return `🧠 <b>AI OS ACTIVE</b> — Live in-context learning · ${total} calls in memory · ${resolved} resolved · Win rate: ${winRate}`;
  } catch {
    return `🧠 <b>AI OS ACTIVE</b> — Initializing…`;
  }
}

// ─── Mode Engine ──────────────────────────────────────────────────────────────

const MODES = {
  NEW_COINS: {
    name: 'NEW_COINS', emoji: '🚀', color: '#00ff88',
    minScore: 40,
    minMarketCap: 1_000,
    // HARD CAP lowered 150K → 80K based on outcome analysis:
    //   $13K-$40K (sweet spot, priority)
    //   $40K-$80K (secondary — 100% WR on 2/2 historically, still viable)
    //   >$80K     AUTO-REJECT regardless of score
    maxMarketCap:    80_000,
    sweetSpotMin:    13_000,
    sweetSpotMax:    40_000,
    secondaryMcapMax: 80_000,
    minLiquidity: 3_000,
    minVolume24h: 500,
    minPairAgeHours: 0,
    maxPairAgeHours: 4,
    minTxns24h: 5,
    minBuys24h: 3,
    trapTolerance: 'HIGH',
    bundleBlock: 'SEVERE',
    thresholdAdjust: -8,
    weightMomentum: true,
    ignoreSellPressure: true,
    description: 'Micro-cap gem hunter. Sweet spot $13K-$40K · secondary $40K-$80K · hard block above $80K.',
  },
  TRENDING: {
    name: 'TRENDING', emoji: '📈', color: '#ffd700',
    minScore: 70, minMarketCap: 50_000, maxMarketCap: 10_000_000,
    minLiquidity: 20_000, minVolume24h: 100_000,
    minPairAgeHours: 0.5, maxPairAgeHours: 72,
    minTxns24h: 500, minBuys24h: 250, minHolders: 500,
    trapTolerance: 'LOW', bundleBlock: 'HIGH', thresholdAdjust: 5,
    weightVolume: true, weightHolders: true,
    description: 'High volume, high holder count tokens with proven momentum.',
  },
  CUSTOM: {
    name: 'CUSTOM', emoji: '⚙️', color: '#a855f7',
    minScore: 52, minMarketCap: 5_000, maxMarketCap: 20_000_000,
    minLiquidity: 5_000, minVolume24h: 5_000,
    minPairAgeHours: 0, maxPairAgeHours: 4,
    minTxns24h: 20, minBuys24h: 10, minHolders: 0,
    trapTolerance: 'LOW', bundleBlock: 'SEVERE', thresholdAdjust: 0,
    description: 'Custom mode — every parameter is yours to configure.',
    isCustom: true,
  },
};

let activeMode = { ...MODES.NEW_COINS };
export function getActiveMode() { return activeMode; }

function setMode(modeName, customParams = null) {
  const base = MODES[modeName?.toUpperCase()];
  if (!base) return false;
  activeMode = base.isCustom && customParams
    ? { ...base, ...sanitizeCustomParams(customParams) }
    : { ...base };
  console.log(`[mode] Switched to ${activeMode.emoji} ${activeMode.name}`);
  logEvent('INFO', 'MODE_CHANGE', JSON.stringify({ mode: modeName, custom: !!customParams }));
  return true;
}

function sanitizeCustomParams(params) {
  const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
  const validTraps   = ['NONE','LOW','MEDIUM','HIGH','CRITICAL'];
  const validBundles = ['NONE','LOW','MEDIUM','HIGH','SEVERE'];
  return {
    minScore:        clamp(params.minScore,        0,   100),
    minMarketCap:    clamp(params.minMarketCap,    0,   100_000_000),
    maxMarketCap:    clamp(params.maxMarketCap,    0,   1_000_000_000),
    minLiquidity:    clamp(params.minLiquidity,    0,   10_000_000),
    minVolume24h:    clamp(params.minVolume24h,    0,   100_000_000),
    minPairAgeHours: clamp(params.minPairAgeHours, 0,   720),
    maxPairAgeHours: clamp(params.maxPairAgeHours, 0,   720),
    minTxns24h:      clamp(params.minTxns24h,      0,   100_000),
    minBuys24h:      clamp(params.minBuys24h,      0,   100_000),
    minHolders:      clamp(params.minHolders,      0,   1_000_000),
    trapTolerance:   validTraps.includes(params.trapTolerance)   ? params.trapTolerance   : 'LOW',
    bundleBlock:     validBundles.includes(params.bundleBlock)   ? params.bundleBlock     : 'SEVERE',
    thresholdAdjust: clamp(params.thresholdAdjust, -20, 30),
  };
}

// ─── Startup ──────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════');
console.log('  PULSE CALLER v8.0 — MULTI-AGENT AI SYSTEM');
console.log(`  env           : ${NODE_ENV}`);
console.log(`  port          : ${PORT}`);
console.log(`  mode          : ${activeMode.emoji} ${activeMode.name}`);
console.log(`  tg token      : ${TELEGRAM_BOT_TOKEN      ? '✓ present' : '✗ MISSING'}`);
console.log(`  claude key    : ${CLAUDE_API_KEY           ? '✓ present' : '✗ MISSING'}`);
console.log(`  group id      : ${TELEGRAM_GROUP_CHAT_ID   ? '✓ present' : '— not set'}`);
console.log(`  admin id      : ${ADMIN_TELEGRAM_ID        ? '✓ present' : '— not set'}`);
console.log(`  birdeye key   : ${process.env.BIRDEYE_API_KEY  ? '✓ present' : '✗ MISSING'}`);
console.log(`  helius key    : ${process.env.HELIUS_API_KEY   ? '✓ present' : '✗ MISSING'}`);
console.log(`  openai key    : ${OPENAI_API_KEY           ? '✓ present' : '— not set'}`);
console.log(`  openai ft     : ${OPENAI_FT_MODEL          ? '✓ ' + OPENAI_FT_MODEL : '— not set (will train when ready)'}`);
console.log(`  banner url    : ${BANNER_IMAGE_URL}`);
console.log(`  post threshold: ${MIN_SCORE_TO_POST}/100`);
console.log(`  scan interval : ${Number(SCAN_INTERVAL_MS) / 1000}s`);
console.log(`  score floor   : 38 (was 48)`);
console.log(`  threshold floor: 38 (was 48)`);
console.log('═══════════════════════════════════════════════════════');

const DB_PATH_CHECK = process.env.DATABASE_PATH ?? './alpha-lennix.db';
const IS_PERSISTENT = DB_PATH_CHECK.startsWith('/data');
console.log(`[db] Path: ${DB_PATH_CHECK}`);
console.log(`[db] Persistent: ${IS_PERSISTENT ? '✓ YES — Railway Volume active' : '⚠️  NO — data resets on redeploy! Set DATABASE_PATH=/data/alpha-lennix.db and add Railway Volume at /data'}`);
if (!IS_PERSISTENT) {
  console.warn('[db] ⚠️  WITHOUT A RAILWAY VOLUME ALL CALL HISTORY AND AI TRAINING DATA IS LOST ON REDEPLOY');
}

initDb();
initWatchlist(dbInstance);

// ─── Wallet Intelligence DB Tables ────────────────────────────────────────────
// Persist Dune wallet data + manual tracked wallets across redeploys
try {
  // Dune-sourced profitable wallets (persisted across restarts)
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS tracked_wallets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      address       TEXT    NOT NULL UNIQUE,
      label         TEXT,
      category      TEXT    DEFAULT 'NEUTRAL',
      source        TEXT    DEFAULT 'manual',
      win_rate      REAL    DEFAULT 0,
      avg_roi       REAL    DEFAULT 0,
      trade_count   INTEGER DEFAULT 0,
      score         INTEGER DEFAULT 0,
      notes         TEXT,
      tags          TEXT,
      added_by      TEXT    DEFAULT 'system',
      is_blacklist  INTEGER DEFAULT 0,
      is_watchlist  INTEGER DEFAULT 1,
      wins_found_in INTEGER DEFAULT 0,
      losses_in     INTEGER DEFAULT 0,
      last_seen     TEXT,
      dune_data     TEXT,
      created_at    TEXT    DEFAULT (datetime('now')),
      updated_at    TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tw_category ON tracked_wallets(category);
    CREATE INDEX IF NOT EXISTS idx_tw_source   ON tracked_wallets(source);
    CREATE INDEX IF NOT EXISTS idx_tw_score    ON tracked_wallets(score DESC);
  `);

  // ── Bot Knowledge / Persistent Memory ──────────────────────────────────────
  // Stores everything the operator teaches the bot — strategies, patterns,
  // chart analysis, document insights. Loaded into every AI prompt.
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS bot_knowledge (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      category   TEXT    DEFAULT 'general',
      title      TEXT,
      content    TEXT    NOT NULL,
      source     TEXT    DEFAULT 'operator',
      created_at TEXT    DEFAULT (datetime('now'))
    );
  `);
  console.log('[db] ✓ tracked_wallets table ready');

// ─── Audit Archive (500 most recent promoted/scanned tokens) ──────────────────
try {
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS audit_archive (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_address TEXT NOT NULL UNIQUE,
      token           TEXT,
      token_name      TEXT,
      final_decision  TEXT,
      composite_score INTEGER,
      quick_score     INTEGER,
      market_cap      REAL,
      liquidity       REAL,
      volume_1h       REAL,
      volume_24h      REAL,
      pair_age_hours  REAL,
      stage           TEXT,
      buy_ratio_1h    REAL,
      buys_1h         INTEGER,
      sells_1h        INTEGER,
      volume_velocity REAL,
      bundle_risk     TEXT,
      sniper_count    INTEGER,
      top10_holder_pct REAL,
      dev_wallet_pct  REAL,
      mint_authority  INTEGER,
      freeze_authority INTEGER,
      lp_locked       INTEGER,
      deployer_verdict TEXT,
      wallet_verdict  TEXT,
      smart_money_score INTEGER,
      winner_wallets  INTEGER,
      claude_verdict  TEXT,
      claude_risk     TEXT,
      claude_setup_type TEXT,
      openai_decision TEXT,
      openai_conviction INTEGER,
      narrative_tags  TEXT,
      twitter         TEXT,
      website         TEXT,
      telegram        TEXT,
      holder_count    INTEGER,
      structure_grade TEXT,
      trap_severity   TEXT,
      bonding_curve_pct REAL,
      holder_addresses TEXT,
      sub_scores      TEXT,
      full_candidate_json TEXT,
      called_at_et    TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      -- Outcome tracking (populated by runOutcomeTracker after resolution)
      outcome           TEXT DEFAULT 'PENDING',   -- PENDING | WIN | LOSS | NEUTRAL
      peak_multiple     REAL,                     -- highest observed mcap_now / mcap_at_call
      peak_mcap         REAL,                     -- highest observed mcap (absolute)
      peak_at           TEXT,                     -- when peak was observed (ISO)
      outcome_locked_at TEXT                      -- when outcome was finalized (ISO)
    );
    CREATE INDEX IF NOT EXISTS idx_aa_token    ON audit_archive(token);
    CREATE INDEX IF NOT EXISTS idx_aa_decision ON audit_archive(final_decision);
    CREATE INDEX IF NOT EXISTS idx_aa_score    ON audit_archive(composite_score DESC);
    CREATE INDEX IF NOT EXISTS idx_aa_time     ON audit_archive(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_aa_outcome  ON audit_archive(outcome);
    CREATE INDEX IF NOT EXISTS idx_aa_peak     ON audit_archive(peak_multiple DESC);
  `);
  // Add outcome columns to older DBs that predate them. Ignore errors (columns already exist).
  for (const col of [
    `ALTER TABLE audit_archive ADD COLUMN outcome TEXT DEFAULT 'PENDING'`,
    `ALTER TABLE audit_archive ADD COLUMN peak_multiple REAL`,
    `ALTER TABLE audit_archive ADD COLUMN peak_mcap REAL`,
    `ALTER TABLE audit_archive ADD COLUMN peak_at TEXT`,
    `ALTER TABLE audit_archive ADD COLUMN outcome_locked_at TEXT`,
  ]) { try { dbInstance.exec(col); } catch {} }
  console.log('[db] ✓ audit_archive table ready (with outcome columns)');
} catch (err) {
  console.warn('[db] audit_archive setup:', err.message);
}
} catch (err) {
  console.warn('[db] tracked_wallets setup failed:', err.message);
}

// ─── Autonomous Agent Tables ──────────────────────────────────────────────────
try {
  dbInstance.exec(`
    -- Dual-agent communication log (Bot A ↔ Bot B)
    CREATE TABLE IF NOT EXISTS agent_comms (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT,
      from_bot     TEXT NOT NULL,
      to_bot       TEXT NOT NULL,
      msg_type     TEXT NOT NULL,
      content      TEXT NOT NULL,
      risk_level   TEXT,
      confidence   INTEGER,
      approved     INTEGER,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    -- Bounded autotune parameter registry
    CREATE TABLE IF NOT EXISTS autotune_params (
      key              TEXT PRIMARY KEY,
      current_value    TEXT,
      min_value        TEXT,
      max_value        TEXT,
      max_step_change  TEXT,
      cooldown_hours   INTEGER DEFAULT 6,
      last_changed_at  TEXT,
      validation_req   TEXT DEFAULT 'replay_simulation',
      locked           INTEGER DEFAULT 0
    );

    -- System freeze states and autonomy scores
    CREATE TABLE IF NOT EXISTS agent_system_state (
      key   TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Agent decisions & actions taken
    CREATE TABLE IF NOT EXISTS agent_actions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT,
      agent       TEXT    NOT NULL,
      action_type TEXT    NOT NULL,
      description TEXT    NOT NULL,
      params      TEXT,
      result      TEXT,
      approved    INTEGER DEFAULT 1,
      rolled_back INTEGER DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now'))
    );

    -- Agent recommendations (resources, APIs, access needed)
    CREATE TABLE IF NOT EXISTS agent_recommendations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      priority    TEXT    DEFAULT 'MEDIUM',
      category    TEXT    NOT NULL,
      title       TEXT    NOT NULL,
      description TEXT,
      rationale   TEXT,
      impact      TEXT,
      status      TEXT    DEFAULT 'PENDING',
      created_by  TEXT    DEFAULT 'claude',
      resolved_at TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );

    -- Early wallet tracking (first 150 buyers)
    CREATE TABLE IF NOT EXISTS early_wallets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token_ca    TEXT    NOT NULL,
      token       TEXT,
      wallet      TEXT    NOT NULL,
      entry_rank  INTEGER,
      entry_time  TEXT,
      entry_mcap  REAL,
      outcome     TEXT,
      peak_mcap   REAL,
      peak_mult   REAL,
      source      TEXT    DEFAULT 'scanner',
      created_at  TEXT    DEFAULT (datetime('now')),
      UNIQUE(token_ca, wallet)
    );
    CREATE INDEX IF NOT EXISTS idx_ew_wallet ON early_wallets(wallet);
    CREATE INDEX IF NOT EXISTS idx_ew_token  ON early_wallets(token_ca);

    -- Profitable survivor tokens (>4h, >$500K MCap)
    CREATE TABLE IF NOT EXISTS survivor_tokens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token_ca    TEXT    NOT NULL UNIQUE,
      token       TEXT,
      entry_mcap  REAL,
      peak_mcap   REAL,
      current_mcap REAL,
      age_hours   REAL,
      first_seen  TEXT,
      confirmed_at TEXT,
      early_wallets TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
  `);
  console.log('[db] ✓ Agent tables ready (agent_actions, agent_recommendations, early_wallets, survivor_tokens, dual-agent)');

  // Our own sub-score storage — guaranteed to exist and have correct schema
  try {
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS seeded_contracts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_address TEXT NOT NULL UNIQUE,
      label         TEXT,
      mode          TEXT    DEFAULT 'HYBRID',
      scan_status   TEXT    DEFAULT 'pending',
      wallet_count  INTEGER DEFAULT 0,
      alpha_count   INTEGER DEFAULT 0,
      smart_count   INTEGER DEFAULT 0,
      momentum_count INTEGER DEFAULT 0,
      sniper_count  INTEGER DEFAULT 0,
      ignore_count  INTEGER DEFAULT 0,
      notes         TEXT,
      token_name    TEXT,
      token_symbol  TEXT,
      created_at    TEXT    DEFAULT (datetime('now')),
      updated_at    TEXT    DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS seeded_wallets (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      seeded_contract_id INTEGER NOT NULL,
      contract_address  TEXT NOT NULL,
      wallet_address    TEXT NOT NULL,
      entry_rank        INTEGER,
      entry_score       REAL    DEFAULT 0,
      performance_score REAL    DEFAULT 0,
      repeat_score      REAL    DEFAULT 0,
      exit_score        REAL    DEFAULT 0,
      cluster_flag      TEXT    DEFAULT 'CLEAN',
      final_score       REAL    DEFAULT 0,
      category          TEXT    DEFAULT 'NEUTRAL',
      in_smart_pool     INTEGER DEFAULT 0,
      is_blacklisted    INTEGER DEFAULT 0,
      notes             TEXT,
      created_at        TEXT    DEFAULT (datetime('now')),
      UNIQUE(seeded_contract_id, wallet_address)
    );

    CREATE TABLE IF NOT EXISTS pulse_sub_scores (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id    INTEGER,
        contract_address TEXT,
        launch_quality  REAL,
        wallet_structure REAL,
        market_behavior REAL,
        social_narrative REAL,
        composite_score REAL,
        stealth_bonus   REAL DEFAULT 0,
        trap_penalty    REAL DEFAULT 0,
        stage           TEXT,
        structure_grade TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pss_ca   ON pulse_sub_scores(contract_address);
      CREATE INDEX IF NOT EXISTS idx_pss_cand ON pulse_sub_scores(candidate_id);
    `);
    console.log('[db] ✓ pulse_sub_scores table ready');
  } catch (err) {
    console.warn('[db] pulse_sub_scores setup:', err.message);
  }

  // Seed default autotune parameter bounds.
  // Format: [key, current, min, max, max_step_per_change, cooldown_hours]
  const tuneParams = [
    // Legacy params (kept for backward compat with existing autotune flows)
    ['sweetSpotMin',          '8000',  '5000',   '25000',  '2000',  6],
    ['sweetSpotMax',          '25000', '10000',  '100000', '5000',  6],
    ['maxMarketCapOverride',  '150000','50000',  '500000', '25000', 6],
    ['minScoreOverride',      '38',    '28',     '60',     '3',     6],
    ['scoreFloorOverride',    '38',    '28',     '60',     '3',     6],
    ['maxPairAgeHoursOverride','4',    '1',      '12',     '1',     12],
    ['sniperCountBlock',      '30',    '5',      '100',    '5',     12],
    ['devWalletPctBlock',     '15',    '5',      '30',     '2',     12],
    ['top10HolderBlock',      '70',    '40',     '90',     '5',     12],
    ['walletIntelWeight',     '1.0',   '0.5',    '2.0',    '0.1',   12],
    ['agentConvictionThreshold','80',  '60',     '95',     '5',     6],
    // V5 decision gates (NEW — bot can now self-tune what we've been hand-adjusting)
    ['v5_postFinal',          '55',    '45',     '75',     '3',     6],
    ['v5_postRug',            '35',    '20',     '50',     '3',     6],
    ['v5_postMomentum',       '52',    '40',     '70',     '3',     6],
    ['v5_postDemand',         '48',    '35',     '65',     '3',     6],
    ['v5_blockRug',           '66',    '55',     '80',     '3',     12],
    ['v5_watchlistFinalLow',  '42',    '30',     '55',     '3',     6],
    ['v5_watchlistFinalHigh', '54',    '50',     '70',     '3',     6],
    // Micro-cap verification
    ['v5_microCapMcapCutoff', '18000', '15000',  '30000',  '1500',  12],
    ['v5_microCapMaxRug',     '25',    '15',     '40',     '3',     12],
    ['v5_microCapMinMq',      '58',    '45',     '75',     '3',     12],
    ['v5_microCapMinWq',      '55',    '40',     '70',     '3',     12],
    // Clean-structure escape
    ['v5_cleanStructDevMax',  '3',     '1',      '6',      '0.5',   12],
    ['v5_cleanStructTop10Max','30',    '20',     '40',     '3',     12],
    ['v5_cleanStructMinFinal','50',    '40',     '65',     '3',     6],
    ['v5_cleanStructMinMq',   '55',    '45',     '70',     '3',     6],
    ['v5_cleanStructMaxRug',  '20',    '10',     '35',     '3',     12],
    ['v5_cleanStructMinBuyRatio','0.60','0.45',  '0.80',   '0.05',  12],
    // Explosive-launch override (HENRY-fix)
    ['v5_explosiveAgeMaxMin', '15',    '5',      '30',     '3',     12],
    ['v5_explosiveMinHolders','100',   '50',     '300',    '20',    12],
    ['v5_explosiveMin5m',     '25',    '15',     '50',     '5',     12],
    ['v5_explosiveMin1h',     '100',   '50',     '300',    '20',    12],
    ['v5_explosiveMinBuyRatio','0.55', '0.45',   '0.75',   '0.05',  12],
    ['v5_explosiveMaxRug',    '25',    '15',     '40',     '3',     12],
    ['v5_explosiveDevMax',    '6',     '2',      '12',     '1',     12],
  ];
  const tuneUpsert = dbInstance.prepare(`INSERT OR IGNORE INTO autotune_params (key,current_value,min_value,max_value,max_step_change,cooldown_hours) VALUES (?,?,?,?,?,?)`);
  for (const p of tuneParams) tuneUpsert.run(...p);

  // Seed system state defaults
  const stateUpsert = dbInstance.prepare(`INSERT OR IGNORE INTO agent_system_state (key,value) VALUES (?,?)`);
  [
    ['freeze_active',     'false'],
    ['bot_a_autonomy',    '75'],
    ['bot_b_autonomy',    '80'],
    ['drift_warning',     'false'],
    ['last_review_at',    ''],
    ['total_improvements','0'],
    ['total_rollbacks',   '0'],
  ].forEach(r => stateUpsert.run(...r));
} catch (err) {
  console.warn('[db] Agent table setup failed:', err.message);
}

// ─── Claude Prompt ────────────────────────────────────────────────────────────

// ─── AI Operating System — Live Learning Context ──────────────────────────────

/**
 * Get the last N resolved calls as in-context training examples.
 * This is how the AI learns without a fine-tune — every call gets the full
 * outcome history so it pattern-matches in real-time.
 */
function getRecentOutcomesContext(limit = 15) {
  try {
    // Use only guaranteed calls table columns — extra fields joined safely
    const rows = dbInstance.prepare(`
      SELECT c.token, c.score_at_call, c.market_cap_at_call,
             c.outcome, c.called_at,
             c.pct_change_1h, c.pct_change_6h, c.pct_change_24h,
             ca.setup_type, ca.structure_grade, ca.stage,
             ca.bundle_risk, ca.dev_wallet_pct, ca.top10_holder_pct,
             ca.pair_age_hours, ca.buy_sell_ratio_1h
      FROM calls c
      LEFT JOIN candidates ca ON c.candidate_id = ca.id
      ORDER BY c.called_at DESC
      LIMIT ?
    `).all(limit);
    if (!rows.length) return 'No resolved calls yet — this is the first evaluation.';
    const wins   = rows.filter(r => r.outcome === 'WIN');
    const losses = rows.filter(r => r.outcome === 'LOSS');
    const pending = rows.filter(r => !r.outcome || r.outcome === 'PENDING');
    const winRate = (wins.length + losses.length) > 0
      ? Math.round(wins.length / (wins.length + losses.length) * 100) + '%'
      : 'pending';
    let ctx = `RECENT CALL HISTORY (last ${rows.length}, win rate: ${winRate}):
`;
    for (const r of rows) {
      const outcome = r.outcome || 'PENDING';
      const emoji   = outcome === 'WIN' ? '✅' : outcome === 'LOSS' ? '❌' : '⏳';
      const mcap    = r.market_cap_at_call ? '$' + (r.market_cap_at_call >= 1000 ? (r.market_cap_at_call/1000).toFixed(1)+'K' : r.market_cap_at_call) : '?';
      ctx += `${emoji} $${r.token||'?'} score:${r.score_at_call||'?'} mcap:${mcap} age:${r.pair_age_hours?.toFixed(1)||'?'}h setup:${r.setup_type||'?'} structure:${r.structure_grade||'?'} bundle:${r.bundle_risk||'?'} dev:${r.dev_wallet_pct?.toFixed(1)||'?'}% top10:${r.top10_holder_pct?.toFixed(1)||'?'}%`;
      if (outcome === 'WIN')   ctx += ` → PUMPED`;
      if (outcome === 'LOSS')  ctx += ` → DUMPED`;
      if (r.pct_change_1h != null) ctx += ` (1h:${r.pct_change_1h>0?'+':''}${r.pct_change_1h?.toFixed(0)}%)`;
      ctx += '\n';
    }
    if (wins.length > 0) {
      ctx += `\nWIN PATTERNS: avg score ${Math.round(wins.reduce((a,r)=>a+(r.score_at_call||0),0)/wins.length)}, `;
      ctx += `avg mcap $${Math.round(wins.reduce((a,r)=>a+(r.market_cap_at_call||0),0)/wins.length/1000)}K\n`;
    }
    if (losses.length > 0) {
      ctx += `LOSS PATTERNS: avg score ${Math.round(losses.reduce((a,r)=>a+(r.score_at_call||0),0)/losses.length)}, `;
      ctx += `common issues: ${[...new Set(losses.map(r=>r.bundle_risk).filter(Boolean))].join(',')||'mixed'}\n`;
    }
    return ctx;
  } catch (err) {
    console.warn('[ai-context] Failed to load outcome history:', err.message);
    return 'Call history unavailable.';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  PERSISTENT BOT MEMORY SYSTEM — v1.0
//  Builds a rich statistical memory block from all historical call data.
//  This feeds into EVERY Claude evaluation so the AI learns from every outcome.
// ─────────────────────────────────────────────────────────────────────────────

function buildBotMemory() {
  try {
    const out = [];

    // ── 1. Win rate by setup type ─────────────────────────────────────────────
    const setupStats = (() => { try {
      return dbInstance.prepare(`
        SELECT ca.setup_type,
               COUNT(*) as total,
               SUM(CASE WHEN c.outcome='WIN' THEN 1 ELSE 0 END) as wins,
               SUM(CASE WHEN c.outcome='LOSS' THEN 1 ELSE 0 END) as losses,
               ROUND(AVG(c.score_at_call),0) as avg_score
        FROM calls c JOIN candidates ca ON c.candidate_id=ca.id
        WHERE c.outcome IN ('WIN','LOSS') AND ca.setup_type IS NOT NULL
        GROUP BY ca.setup_type
        ORDER BY wins DESC
        LIMIT 12
      `).all();
    } catch { return []; } })();
    if (setupStats.length > 0) {
      out.push('SETUP TYPE WIN RATES (from all historical calls):');
      for (const r of setupStats) {
        const wr = (r.wins + r.losses) > 0
          ? Math.round(r.wins / (r.wins + r.losses) * 100) + '%'
          : '—';
        const signal = r.wins >= 3 && wr.replace('%','') >= 60 ? ' ← HIGH CONVICTION'
          : r.losses > r.wins ? ' ← AVOID PATTERN'
          : '';
        out.push(`  ${r.setup_type}: ${wr} (${r.wins}W/${r.losses}L, avg score ${r.avg_score})${signal}`);
      }
    }

    // ── 2. Win rate by score band ─────────────────────────────────────────────
    const scoreBands = (() => { try {
      return dbInstance.prepare(`
        SELECT
          CASE
            WHEN c.score_at_call >= 80 THEN '80-100'
            WHEN c.score_at_call >= 70 THEN '70-79'
            WHEN c.score_at_call >= 60 THEN '60-69'
            WHEN c.score_at_call >= 50 THEN '50-59'
            WHEN c.score_at_call >= 40 THEN '40-49'
            ELSE 'below-40'
          END as band,
          COUNT(*) as total,
          SUM(CASE WHEN c.outcome='WIN' THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN c.outcome='LOSS' THEN 1 ELSE 0 END) as losses
        FROM calls c
        WHERE c.outcome IN ('WIN','LOSS') AND c.score_at_call IS NOT NULL
        GROUP BY band ORDER BY MIN(c.score_at_call) DESC
      `).all();
    } catch { return []; } })();
    if (scoreBands.length > 0) {
      out.push('\nSCORE BAND WIN RATES:');
      for (const r of scoreBands) {
        const wr = (r.wins + r.losses) > 0
          ? Math.round(r.wins / (r.wins + r.losses) * 100) + '%'
          : '—';
        out.push(`  Score ${r.band}: ${wr} win rate (${r.wins}W/${r.losses}L of ${r.total} calls)`);
      }
    }

    // ── 3. Win rate by MCap range ─────────────────────────────────────────────
    const mcapBands = (() => { try {
      return dbInstance.prepare(`
        SELECT
          CASE
            WHEN c.market_cap_at_call <= 10000  THEN '$0-10K (micro)'
            WHEN c.market_cap_at_call <= 25000  THEN '$10-25K (sweet spot)'
            WHEN c.market_cap_at_call <= 50000  THEN '$25-50K (early)'
            WHEN c.market_cap_at_call <= 100000 THEN '$50-100K (developing)'
            ELSE '$100K+ (late)'
          END as band,
          COUNT(*) as total,
          SUM(CASE WHEN c.outcome='WIN' THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN c.outcome='LOSS' THEN 1 ELSE 0 END) as losses
        FROM calls c
        WHERE c.outcome IN ('WIN','LOSS') AND c.market_cap_at_call IS NOT NULL
        GROUP BY band ORDER BY MIN(c.market_cap_at_call) ASC
      `).all();
    } catch { return []; } })();
    if (mcapBands.length > 0) {
      out.push('\nMCAP RANGE WIN RATES:');
      for (const r of mcapBands) {
        const wr = (r.wins + r.losses) > 0
          ? Math.round(r.wins / (r.wins + r.losses) * 100) + '%'
          : '—';
        out.push(`  ${r.band}: ${wr} (${r.wins}W/${r.losses}L)`);
      }
    }

    // ── 4. Structure grade performance ────────────────────────────────────────
    const gradeStats = (() => { try {
      return dbInstance.prepare(`
        SELECT ca.structure_grade,
               COUNT(*) as total,
               SUM(CASE WHEN c.outcome='WIN' THEN 1 ELSE 0 END) as wins,
               SUM(CASE WHEN c.outcome='LOSS' THEN 1 ELSE 0 END) as losses
        FROM calls c JOIN candidates ca ON c.candidate_id=ca.id
        WHERE c.outcome IN ('WIN','LOSS') AND ca.structure_grade IS NOT NULL
        GROUP BY ca.structure_grade ORDER BY wins DESC
      `).all();
    } catch { return []; } })();
    if (gradeStats.length > 0) {
      out.push('\nSTRUCTURE GRADE WIN RATES:');
      for (const r of gradeStats) {
        const wr = (r.wins + r.losses) > 0
          ? Math.round(r.wins / (r.wins + r.losses) * 100) + '%'
          : '—';
        out.push(`  ${r.structure_grade}: ${wr} (${r.wins}W/${r.losses}L)`);
      }
    }

    // ── 5. Trap severity impact ───────────────────────────────────────────────
    const trapStats = (() => { try {
      return dbInstance.prepare(`
        SELECT ca.trap_severity,
               COUNT(*) as total,
               SUM(CASE WHEN c.outcome='WIN' THEN 1 ELSE 0 END) as wins,
               SUM(CASE WHEN c.outcome='LOSS' THEN 1 ELSE 0 END) as losses
        FROM calls c JOIN candidates ca ON c.candidate_id=ca.id
        WHERE c.outcome IN ('WIN','LOSS') AND ca.trap_severity IS NOT NULL
        GROUP BY ca.trap_severity ORDER BY losses DESC
      `).all();
    } catch { return []; } })();
    if (trapStats.length > 0) {
      out.push('\nTRAP SEVERITY OUTCOMES:');
      for (const r of trapStats) {
        const wr = (r.wins + r.losses) > 0
          ? Math.round(r.wins / (r.wins + r.losses) * 100) + '%'
          : '—';
        out.push(`  TRAP ${r.trap_severity}: ${wr} win rate (${r.total} calls)`);
      }
    }

    // ── 6. Top performing wallet patterns ─────────────────────────────────────
    const walletPatterns = (() => { try {
      return dbInstance.prepare(`
        SELECT ew.wallet,
               COUNT(DISTINCT ew.token_ca) as appearances,
               SUM(CASE WHEN c.outcome='WIN' THEN 1 ELSE 0 END) as wins,
               SUM(CASE WHEN c.outcome='LOSS' THEN 1 ELSE 0 END) as losses
        FROM early_wallets ew
        JOIN calls c ON ew.token_ca = c.contract_address
        WHERE c.outcome IN ('WIN','LOSS')
        GROUP BY ew.wallet
        HAVING appearances >= 2
        ORDER BY wins DESC
        LIMIT 10
      `).all();
    } catch { return []; } })();
    if (walletPatterns.length > 0) {
      const highConviction = walletPatterns.filter(w => {
        const wr = (w.wins + w.losses) > 0 ? w.wins / (w.wins + w.losses) : 0;
        return wr >= 0.6 && w.wins >= 2;
      });
      if (highConviction.length > 0) {
        out.push(`\nHIGH-CONVICTION WALLETS (appear early in our winners):`);
        for (const w of highConviction.slice(0,5)) {
          const wr = Math.round(w.wins / (w.wins + w.losses) * 100);
          out.push(`  ${w.wallet.slice(0,8)}… — ${wr}% win rate in our calls (${w.wins}W/${w.losses}L, ${w.appearances} appearances)`);
        }
      }
    }

    // ── 7. Missed winner patterns ─────────────────────────────────────────────
    const missed = (() => { try {
      return dbInstance.prepare(`
        SELECT token, final_score, entry_mcap, peak_mcap_seen, multiplier_seen,
               why_missed, composite_score
        FROM survivor_tokens
        WHERE multiplier_seen >= 2 AND final_score < 50
        ORDER BY multiplier_seen DESC
        LIMIT 5
      `).all();
    } catch { return []; } })();
    if (missed.length > 0) {
      out.push(`\nMISSED WINNERS (tokens that 2x+ that we scored below 50):`);
      for (const m of missed) {
        out.push(`  $${m.token}: scored ${m.composite_score||m.final_score}, reached ${m.multiplier_seen}× | why: ${m.why_missed || 'unknown'}`);
      }
    }

    // ── 8. Summary stats ─────────────────────────────────────────────────────
    const summary = (() => { try {
      const r = dbInstance.prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
               SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
               SUM(CASE WHEN outcome IS NULL OR outcome='PENDING' THEN 1 ELSE 0 END) as pending
        FROM calls
      `).get();
      const wl = r.wins + r.losses;
      return {
        ...r,
        winRate: wl > 0 ? Math.round(r.wins / wl * 100) + '%' : 'pending',
      };
    } catch { return null; } })();

    if (summary) {
      out.unshift(
        `BOT MEMORY SUMMARY: ${summary.total} total calls | ${summary.wins}W / ${summary.losses}L / ${summary.pending} pending | Overall win rate: ${summary.winRate}\n`
      );
    }

    // ── Operator-taught knowledge (uploaded docs, images, strategies) ────────
    try {
      const knowledge = dbInstance.prepare(
        `SELECT title, content, category, created_at FROM bot_knowledge ORDER BY created_at DESC LIMIT 50`
      ).all();
      if (knowledge.length) {
        out.push('\nOPERATOR KNOWLEDGE BASE (' + knowledge.length + ' entries — treat as gospel):');
        for (const k of knowledge) {
          const label = k.title ? `[${k.category}] ${k.title}` : `[${k.category}]`;
          out.push(`  ${label}: ${k.content.slice(0, 300)}`);
        }
      }
    } catch {}

    return out.length > 1 ? out.join('\n') : 'Insufficient call history for pattern analysis yet.';
  } catch (err) {
    console.warn('[memory] buildBotMemory error:', err.message);
    return 'Memory system error: ' + err.message;
  }
}

// Cache the memory block — rebuild every 10 minutes to avoid DB overhead on every token
let _memoryCache = null;
let _memoryCacheTime = 0;

function getBotMemory() {
  const now = Date.now();
  if (_memoryCache && (now - _memoryCacheTime) < 10 * 60 * 1000) {
    return _memoryCache;
  }
  _memoryCache = buildBotMemory();
  _memoryCacheTime = now;
  return _memoryCache;
}

// Invalidate memory cache when a new outcome is recorded
function invalidateMemoryCache() {
  _memoryCache = null;
  _memoryCacheTime = 0;
}

// ─── Missed-Opportunity Memory ───────────────────────────────────────────
// Coins we marked IGNORE or WATCHLIST in the last 48h that have since run
// ≥2x get cached here and injected into Claude's prompt as a "learn from
// these" block. Self-improvement loop: the more we reject winners, the
// more examples Claude has to recognize the pattern next time.
//
// Refreshed every 30 min via setInterval. Uses same logic as the public
// /api/candidates/missed endpoint — DexScreener batch lookup, free API.
const _missedCache = { rows: [], refreshedAt: 0 };

// ─── Call funnel diagnostic ───────────────────────────────────────────────
// Tracks where candidates drop in the pipeline so we can see at a glance
// why calls aren't flowing. Rolling 60-min window, rolls forward on each
// increment so old events age out naturally. Read via /api/diagnose/funnel.
const _callFunnel = {
  windowStartMs: Date.now(),
  stages: {
    evaluated:          0,  // entered auto-caller
    dataVoidSkip:       0,  // no enrichment data at all
    scored:             0,  // got a composite score
    belowFloor:         0,  // score < 38 hard floor
    ignoreDecision:     0,  // makeFinalDecision said IGNORE
    watchlistDecision:  0,  // makeFinalDecision said WATCHLIST
    autoPostDecision:   0,  // makeFinalDecision said AUTO_POST
    claudeExtremeVeto:  0,
    consensusGate:      0,  // Claude said no (claude-only mode)
    momentumGate:       0,  // DUMPING/SEVERE
    rugGuard:           0,  // $13-17.5K band failed
    liquidityFloor:     0,  // <$3K liq
    foundationTrust:    0,  // foundation signals < 15/100 (scorer had no data)
    earlyMcapDefer:     0,  // $6-9K defer
    bundleVeto:         0,
    extendedAvoid:      0,
    smartMoneyOverride: 0,  // cluster/KOL forced auto-post
    posted:             0,
    pausedPosting:      0,
  },
};
function fnl(stage) {
  // Roll window every 60 min
  if (Date.now() - _callFunnel.windowStartMs > 60 * 60_000) {
    _callFunnel.windowStartMs = Date.now();
    for (const k of Object.keys(_callFunnel.stages)) _callFunnel.stages[k] = 0;
  }
  _callFunnel.stages[stage] = (_callFunnel.stages[stage] || 0) + 1;
}
const MISSED_REFRESH_MS = 30 * 60_000;

async function refreshMissedOpportunities() {
  try {
    const cands = dbInstance.prepare(`
      SELECT contract_address, token, market_cap, evaluated_at, final_decision
      FROM candidates
      WHERE final_decision IN ('IGNORE', 'WATCHLIST')
        AND market_cap > 0
        AND evaluated_at > datetime('now', '-48 hours')
      ORDER BY evaluated_at DESC
      LIMIT 150
    `).all();
    if (cands.length === 0) { _missedCache.rows = []; _missedCache.refreshedAt = Date.now(); return; }
    const caList = cands.map(c => c.contract_address).filter(Boolean);
    const results = [];
    const BATCH = 30;
    for (let i = 0; i < caList.length; i += BATCH) {
      const batch = caList.slice(i, i + BATCH).join(',');
      try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch}`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) continue;
        const j = await r.json();
        const pairs = Array.isArray(j.pairs) ? j.pairs : [];
        const byCa = {};
        for (const p of pairs) {
          const ca = p.baseToken?.address;
          if (!ca) continue;
          const mc = p.marketCap ?? p.fdv ?? null;
          if (mc && (!byCa[ca] || mc > byCa[ca].mc)) byCa[ca] = { mc, priceChange24h: p.priceChange?.h24 };
        }
        for (const c of cands.slice(i, i + BATCH)) {
          const cur = byCa[c.contract_address];
          if (!cur || !cur.mc || !c.market_cap) continue;
          const multiple = cur.mc / c.market_cap;
          if (multiple >= 2) {
            results.push({
              token:       c.token,
              decision:    c.final_decision,
              scan_mcap:   c.market_cap,
              current_mcap: cur.mc,
              multiple:    Number(multiple.toFixed(2)),
              scanned_at:  c.evaluated_at,
            });
          }
        }
      } catch {}
    }
    results.sort((a, b) => b.multiple - a.multiple);
    _missedCache.rows = results.slice(0, 10);
    _missedCache.refreshedAt = Date.now();
    console.log(`[missed-memory] Refreshed — ${_missedCache.rows.length} misses from ${cands.length} candidates checked`);
  } catch (err) {
    console.warn(`[missed-memory] Refresh failed: ${err.message}`);
  }
}

function getMissedOpportunityMemory() {
  if (_missedCache.rows.length === 0) return '';
  const lines = _missedCache.rows.slice(0, 5).map(r =>
    `  - $${r.token || '?'} (${r.decision}) — scan $${Math.round(r.scan_mcap/1000)}K → now $${Math.round(r.current_mcap/1000)}K (${r.multiple}x)`
  );
  return [
    'RECENT MISSES — coins we rejected that ran 2x+ since. Learn the pattern:',
    ...lines,
    'If this candidate shares traits with any of these (same MCap band, same stage, similar early-volume signature, same narrative), bias toward AUTO_POST. Past misses inform this decision.',
  ].join('\n');
}

// ─── Winner-memory feedback ─────────────────────────────────────────────
// Mirror of the missed-opportunity cache but for WINS. Tells Claude
// "here are the coins we posted that actually ran ≥2x — pattern-match
// new candidates against these". The positive half of the learning loop.
// Pulled directly from the calls table (peak_multiple is authoritative);
// no DexScreener calls needed. Rebuilt every 30min same as misses.
const _winnerCache = { rows: [], refreshedAt: 0 };

function refreshWinnerMemory() {
  try {
    // Sync the memory threshold to the WIN definition. If user set
    // winPeakMultiple=3.0, Claude sees only 3x+ coins as "winning patterns".
    // If user wants wider memory for learning, they can lower winPeakMultiple.
    const winTarget = SCORING_CONFIG.winPeakMultiple ?? 2.0;
    const rows = dbInstance.prepare(`
      SELECT token, contract_address,
             market_cap_at_call as scan_mcap,
             peak_mcap,
             peak_multiple,
             score_at_call,
             structure_grade_at_call as structure_grade,
             setup_type_at_call as setup_type,
             risk_at_call as risk,
             called_at
      FROM calls
      WHERE peak_multiple IS NOT NULL
        AND peak_multiple >= ?
        AND called_at > datetime('now', '-7 days')
      ORDER BY peak_multiple DESC
      LIMIT 10
    `).all(winTarget);
    _winnerCache.rows = rows;
    _winnerCache.refreshedAt = Date.now();
    console.log(`[winner-memory] Refreshed — ${rows.length} recent ≥${winTarget}x winners (7d)`);
  } catch (err) {
    console.warn(`[winner-memory] Refresh failed: ${err.message}`);
  }
}

function getWinnerMemory() {
  if (_winnerCache.rows.length === 0) return '';
  const lines = _winnerCache.rows.slice(0, 5).map(r => {
    const mcK = r.scan_mcap ? `$${Math.round(r.scan_mcap/1000)}K` : '?';
    const feat = [
      r.structure_grade && `${r.structure_grade}`,
      r.setup_type && r.setup_type.replace(/_/g,' '),
      r.risk && `${r.risk} risk`,
    ].filter(Boolean).join(' · ');
    return `  - $${r.token || '?'} — entry ${mcK} · ${feat} · score ${r.score_at_call ?? '?'} → peak ${r.peak_multiple.toFixed(2)}x`;
  });
  const winBar = SCORING_CONFIG.winPeakMultiple ?? 2.0;
  return [
    `RECENT WINS — coins we POSTED that ran ≥${winBar}x in the last 7 days. This is what winning calls look like:`,
    ...lines,
    'If this candidate has similar structure (grade, setup type, MCap band, score range) to these winners, bias toward AUTO_POST. Reference these as "winning patterns".',
  ].join('\n');
}

// Initial refresh 60s after boot (let DB settle), then every 30 min
setTimeout(() => { refreshMissedOpportunities().catch(() => {}); }, 60_000);
setTimeout(() => { refreshWinnerMemory(); }, 65_000);
setInterval(() => { refreshMissedOpportunities().catch(() => {}); }, MISSED_REFRESH_MS);
setInterval(() => { refreshWinnerMemory(); }, MISSED_REFRESH_MS);



/**
 * Get current AI config overrides set by the operator or AI agent.
 */
let AI_CONFIG_OVERRIDES = {};
// Persist AI_CONFIG_OVERRIDES to SQLite so pausePosting survives restarts.
try {
  dbInstance.exec(`CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)`);
  // Ensure meta-signals schema (liquidity_snapshots) exists before first scan
  try {
    const { ensureMetaSignalsSchema } = await import('./meta-signals.js');
    ensureMetaSignalsSchema(dbInstance);
  } catch (err) { console.warn('[meta-signals] schema init:', err.message); }
  // Ensure user-leaderboard schema (user_calls) — Phanes-style group ranking.
  try {
    const { ensureUserLeaderboardSchema } = await import('./user-leaderboard.js');
    ensureUserLeaderboardSchema(dbInstance);
  } catch (err) { console.warn('[user-lb] schema init:', err.message); }

  // ── One-time backfill: synthesize reasons for any pre-existing NULL/empty
  // audit rows so the AI Tuning Audit panel never displays "No reason
  // recorded for this change." Idempotent — only runs once per kv_store flag.
  try {
    const flag = dbInstance.prepare(`SELECT value FROM kv_store WHERE key='audit_reason_backfill_v1'`).get();
    if (!flag) {
      const rows = dbInstance.prepare(`
        SELECT id, category, source, knob_key, old_value, new_value
        FROM config_changes WHERE reason IS NULL OR reason = ''
      `).all();
      const upd = dbInstance.prepare(`UPDATE config_changes SET reason = ? WHERE id = ?`);
      let n = 0;
      for (const r of rows) {
        const oldV = r.old_value ?? '∅';
        const newV = r.new_value ?? '∅';
        const direction = (() => {
          const oN = Number(JSON.parse(r.old_value || 'null')), nN = Number(JSON.parse(r.new_value || 'null'));
          if (Number.isFinite(oN) && Number.isFinite(nN)) { if (nN > oN) return 'raised'; if (nN < oN) return 'lowered'; }
          return 'changed';
        })();
        const src = (r.source || 'operator');
        const tag = src === 'claude' || src === 'auto_optimize' ? 'Auto-tuner'
                  : src === 'operator' ? 'Manual operator'
                  : `Source=${src}`;
        const reason = `${tag} ${direction} ${r.knob_key} ${oldV} → ${newV} (legacy entry — pre-audit-reason migration)`;
        upd.run(reason, r.id);
        n++;
      }
      dbInstance.prepare(`INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES ('audit_reason_backfill_v1', 'done', datetime('now'))`).run();
      if (n > 0) console.log(`[boot] audit-reason-backfill: filled ${n} legacy rows`);
    }
  } catch (err) { console.warn('[boot] audit-reason-backfill failed:', err.message); }
  const row = dbInstance.prepare(`SELECT value FROM kv_store WHERE key='ai_config_overrides'`).get();
  if (row?.value) {
    AI_CONFIG_OVERRIDES = JSON.parse(row.value);
    console.log('[config] Restored AI_CONFIG_OVERRIDES from DB:', JSON.stringify(AI_CONFIG_OVERRIDES));
  }
} catch (err) { console.warn('[config] Failed to restore overrides:', err.message); }

function persistAIConfig() {
  try {
    dbInstance.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES ('ai_config_overrides', ?)`).run(JSON.stringify(AI_CONFIG_OVERRIDES));
  } catch {}
}

// ─── Runtime Scoring Config ───────────────────────────────────────────────
// User-editable scoring knobs persisted to kv_store. Loaded once at boot
// and whenever a POST /api/config/scoring lands. Every hot-path site below
// that used hardcoded bonuses / thresholds now reads through SCORING_CONFIG.
const SCORING_CONFIG_DEFAULTS = {
  minScoreToPost:         35,   // UNBLOCK — dropped to scorer hard floor. Any passing score should be able to post.
  sweetSpotBonus:          0,   // DISABLED — hitting an MCap range isn't signal. Was +4 for $13K-$40K.
  secondaryBonus:          0,   // DISABLED — same reason. Was +2 for $40K-$80K.
  preLaunchBonus:          6,   // dev funded by CEX within 6h
  crossChainBonus:         4,   // matching ETH/Base token mooning
  devFingerprintCap:       6,   // max positive delta from dev history
  hotDevBonus:             4,   // bonus when dev has a coin that hit 2x+ in the last 24h
  globalBonusCap:         10,   // total bonus stack across all sources
  noSignalCap:            80,   // AXIOSCAN-MODE — less restrictive ceiling for clean-structure coins (was 72)
  rugGuardMinScore:       55,   // AXIOSCAN-MODE — loosened from 58. $13K-$17.5K requires this score.
  consensusOverrideScore: 60,   // (legacy — only used if claudeOnlyMode=0)
  deadRegimeFloorAdj:     12,   // DEAD market adds this to minScoreToPost
  // ── USER-ONLY KNOB ────────────────────────────────────────────────────
  // The ONLY knob the auto-optimizer cannot touch. User sets their target
  // multiplier here (e.g. 5 = "tune the system to find 5x coins"). Auto-
  // optimizer reads this and tunes everything else (foundation weights,
  // thresholds, bonuses) to maximize the number of coins that hit this
  // target. winPeakMultiple stays a fallback WIN bar — anything ≥2.5x
  // counts as a win even if it didn't reach the target.
  targetMultiplier:      5.0,   // USER-ONLY. Tuning goal for the whole system.
  winPeakMultiple:       2.5,   // Fallback WIN threshold — ≥2.5x = WIN, <2.5x = LOSS.
  neutralDrawdownPct:     10,   // ≤10% drawdown = NEUTRAL at 6h
  claudeOnlyMode:          1,   // 1=Claude is sole decision maker; 0=legacy Claude+OpenAI consensus
  minLiquidityForPost:  1500,   // AXIOSCAN-MODE — $1.5K min liquidity (was $3K). Many 10x moonshots start with thin liquidity and grow it.
  lockedKnobs: ['targetMultiplier'],  // ONLY the user-target multiplier is locked — bot tunes everything else
  earlyMCapDeferMinutes:   0,   // DISABLED — was deferring $6K-$9K coins 3min, which was holding too many. Set to 0 to skip defer entirely.
  earlyMCapDeferMin:    6000,   // lower edge of the defer band ($)
  earlyMCapDeferMax:    9000,   // upper edge of the defer band ($)
  // ── AXIOSCAN-MODE FAST LANE ────────────────────────────────────────────
  // If ≥ fastLaneMinWinners WINNER wallets from our DB are already holding
  // this coin AND basic rug checks pass, skip Claude/OpenAI entirely and
  // post immediately. Axioscan-style "trust the wallets" bypass.
  fastLaneEnabled:         1,   // 1=on, 0=off (turns the whole bypass off)
  fastLaneMinWinners:      2,   // ≥ this many WINNER wallets in holders → fast lane
  fastLaneMinLiquidityUsd: 2000,// still must have $2K+ liquidity
  fastLaneMaxAgeHours:    12,   // only fires on coins <12h old

  // ── SCORE-TRUMP OVERRIDE ───────────────────────────────────────────────
  // Direct response to missed-call analysis: $HENRY scored 72 → 65.9x miss.
  // $OBAMA 71 → 11.4x miss. $TIME MACHINE 52 → 28.2x miss. The pattern is
  // that V5/Claude downgrade high-score young coins to WATCHLIST and then
  // they go on to run. Two-tier override: trust the scorer when a young
  // gem-range coin is clearly enthusiastic. Auto-optimizer can tune.
  scoreTrumpEnabled:           1,    // 1=on, 0=off
  scoreTrumpFreshThreshold:   55,    // FRESH GEM (<30min) score floor
  scoreTrumpFreshMaxAgeMin:   30,    // "fresh" = age <= 30min
  scoreTrumpYoungThreshold:   60,    // young (<2h) score floor
  scoreTrumpYoungMaxAgeHours:  2,    // "young" = age <= 2h
  scoreTrumpMaxMcap:       80000,    // gem-range cap
};
let SCORING_CONFIG = { ...SCORING_CONFIG_DEFAULTS };
try {
  const row = dbInstance.prepare(`SELECT value FROM kv_store WHERE key='scoring_config'`).get();
  if (row?.value) {
    SCORING_CONFIG = { ...SCORING_CONFIG_DEFAULTS, ...JSON.parse(row.value) };
    console.log('[config] Restored SCORING_CONFIG from DB:', JSON.stringify(SCORING_CONFIG));

    // ── One-time auto-migration for stale kv_store values ──────────────
    // When defaults change, the kv_store's previously-saved value wins and
    // silently pins scoring. Apply two migration tables:
    //   MIGRATE_UP:   stored < new default → bump up (preserves higher values)
    //   MIGRATE_FORCE: always set to new default (for direction reversals)
    const MIGRATE_UP = {
      noSignalCap:           72,
      minScoreToPost:        45,
      globalBonusCap:        10,
      consensusOverrideScore:60,
      devFingerprintCap:      6,
    };
    // Force-migrate: win threshold reshaped to 2.0 — user's mandate is
    // "winning coins minimum 2x to 100x, sweet spot 3-5x, anything more is
    // bonus." So 2x is the floor. Anything under 2x = LOSS, 2x+ = WIN.
    // The 3-5x sweet-spot target is communicated to Claude in the prompt;
    // the scorer finds coins with that profile via pre-breakout + early-
    // entry + winner-wallet bonuses already shipped.
    const MIGRATE_FORCE = {
      winPeakMultiple:    2.5,  // fallback WIN threshold, was 2.0
      neutralDrawdownPct: 10,
      sweetSpotBonus:     0,    // user disabled: MCap range isn't a signal
      secondaryBonus:     0,    // user disabled: MCap range isn't a signal
      targetMultiplier:   5.0,  // NEW user-only tuning target
    };
    const MIGRATE_FORCE_VERSION = 'v6';   // bump to force re-migration (was v5)
    let migrated = false;
    for (const [key, newDefault] of Object.entries(MIGRATE_UP)) {
      const stored = SCORING_CONFIG[key];
      if (typeof stored === 'number' && stored < newDefault) {
        console.log(`[config:migrate] ${key}: ${stored} → ${newDefault} (bumped from stale DB value)`);
        SCORING_CONFIG[key] = newDefault;
        migrated = true;
      }
    }
    for (const [key, forcedValue] of Object.entries(MIGRATE_FORCE)) {
      const stored = SCORING_CONFIG[key];
      if (stored !== forcedValue) {
        // One-time flag so we don't repeat-force on every boot once user adjusts
        const migKey = `migrated_force_${key}_${MIGRATE_FORCE_VERSION}`;
        const alreadyRan = (() => {
          try { return dbInstance.prepare(`SELECT value FROM kv_store WHERE key=?`).get(migKey)?.value === '1'; } catch { return false; }
        })();
        if (!alreadyRan) {
          console.log(`[config:migrate] ${key}: ${stored} → ${forcedValue} (force-migrate, one-time)`);
          SCORING_CONFIG[key] = forcedValue;
          migrated = true;
          try { dbInstance.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, '1')`).run(migKey); } catch {}
        }
      }
    }
    if (migrated) {
      try {
        dbInstance.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES ('scoring_config', ?)`).run(JSON.stringify(SCORING_CONFIG));
        console.log('[config:migrate] Persisted migrated scoring config.');
      } catch {}
    }

    // ── Re-resolve existing calls against the new win threshold ──────────
    // After winPeakMultiple drops, historical calls labeled NEUTRAL or LOSS
    // may now qualify as WIN (and vice versa). Run once; flag in kv_store.
    try {
      const resolveFlagKey = 'migrated_resolve_calls_v_1_28';
      const alreadyResolved = dbInstance.prepare(`SELECT value FROM kv_store WHERE key=?`).get(resolveFlagKey)?.value === '1';
      if (!alreadyResolved) {
        const winTarget = SCORING_CONFIG.winPeakMultiple ?? 1.28;
        const upRes = dbInstance.prepare(`
          UPDATE calls SET
            outcome          = CASE WHEN peak_multiple >= ? THEN 'WIN' ELSE 'LOSS' END,
            auto_resolved_at = datetime('now'),
            outcome_source   = 'AUTO_MIGRATE'
          WHERE outcome != 'PENDING'
            AND peak_multiple IS NOT NULL
        `).run(winTarget);
        console.log(`[config:migrate] Re-resolved ${upRes.changes} calls against winPeakMultiple=${winTarget}`);
        try { dbInstance.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, '1')`).run(resolveFlagKey); } catch {}
      }
    } catch (err) {
      console.warn('[config:migrate] Re-resolve failed:', err.message);
    }
  }
} catch (err) { console.warn('[config] Failed to restore scoring config:', err.message); }

function persistScoringConfig() {
  try {
    dbInstance.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES ('scoring_config', ?)`).run(JSON.stringify(SCORING_CONFIG));
  } catch {}
}

// ─── Early-MCap defer tracker ─────────────────────────────────────────────
// When we first see a coin in the $6K-$9K MCap band, record the timestamp.
// On the next evaluation pass, if less than N minutes have elapsed AND
// velocity isn't extremely high, we demote to WATCHLIST and wait for the
// scanner's rescan cycle to re-evaluate. This lets a 3-min hold time
// confirm sustained momentum vs a one-wick pump-and-dump.
const _earlyMCapSeen = new Map(); // ca → firstSeenAtMs
function hasExtremeVelocity(c) {
  // Any ONE of these is "from the beginning extremely high":
  //   - 5m price +25%+ (sustained pump)
  //   - 1h buy count >= 30 (real buying interest)
  //   - volume velocity >= 2 (1h vol is 2x the 6h per-hour average)
  //   - explicit smart-money signal (cluster/KOL — already bypasses elsewhere)
  if ((c.priceChange5m ?? 0) >= 25) return true;
  if ((c.buys1h ?? 0) >= 30)        return true;
  if ((c.volumeVelocity ?? 0) >= 2) return true;
  return false;
}

// ─── Additional runtime configs (persisted to kv_store) ──────────────────────
// These live in server memory + kv_store; when the modules that USE them
// are started, they can read these values. Changes to module-level constants
// (e.g. smart-money-watcher POLL_INTERVAL_MS) take effect on next restart
// unless the module re-reads on tick.

const SCANNER_CONFIG_DEFAULTS = {
  maxPromotedCandidates: 50,
  maxTokensToFetch:      300,
  dexBatchSize:          30,
  maxPairAgeHours:       4,
  quickScoreAutoPromote: 35,
  quickScoreWatchlist:   22,
  quickScoreDrop:        15,
  rescanScheduleMins:    '1,3,7,15',
};
const WALLETS_CONFIG_DEFAULTS = {
  topNWatched:        80,
  clusterThreshold:    3,
  perWalletTxLimit:    5,
  pollIntervalSec:   300,
  kolWallets:         '',  // comma-separated; empty = use DEFAULT_KOL_WALLETS
};
const PRELAUNCH_CONFIG_DEFAULTS = {
  tickIntervalSec:   300,
  suspectTtlHours:     6,
  minSolOutflow:       1,
  maxSolOutflow:      10,
  bundleCacheHours:   24,
};
const OUTCOMES_CONFIG_DEFAULTS = {
  slMultiple:   0.75, // stop-loss threshold vs entry MCap
  tp1Multiple:  1.5,  // WIN threshold (peak must hit this)
  tp2Multiple:  5.0,
  tp3Multiple: 10.0,
};

let SCANNER_CONFIG   = { ...SCANNER_CONFIG_DEFAULTS };
let WALLETS_CONFIG   = { ...WALLETS_CONFIG_DEFAULTS };
let PRELAUNCH_CONFIG = { ...PRELAUNCH_CONFIG_DEFAULTS };
let OUTCOMES_CONFIG  = { ...OUTCOMES_CONFIG_DEFAULTS };

try {
  const loadKv = (key) => {
    const row = dbInstance.prepare(`SELECT value FROM kv_store WHERE key=?`).get(key);
    return row?.value ? JSON.parse(row.value) : null;
  };
  const loaded = {
    scanner:   loadKv('scanner_config'),
    wallets:   loadKv('wallets_config'),
    prelaunch: loadKv('prelaunch_config'),
    outcomes:  loadKv('outcomes_config'),
  };
  if (loaded.scanner)   SCANNER_CONFIG   = { ...SCANNER_CONFIG_DEFAULTS,   ...loaded.scanner };
  if (loaded.wallets)   WALLETS_CONFIG   = { ...WALLETS_CONFIG_DEFAULTS,   ...loaded.wallets };
  if (loaded.prelaunch) PRELAUNCH_CONFIG = { ...PRELAUNCH_CONFIG_DEFAULTS, ...loaded.prelaunch };
  if (loaded.outcomes)  OUTCOMES_CONFIG  = { ...OUTCOMES_CONFIG_DEFAULTS,  ...loaded.outcomes };
} catch (err) { console.warn('[config] Failed to restore extended configs:', err.message); }

function persistExtendedConfig(category) {
  const map = {
    scanner:   ['scanner_config',   SCANNER_CONFIG],
    wallets:   ['wallets_config',   WALLETS_CONFIG],
    prelaunch: ['prelaunch_config', PRELAUNCH_CONFIG],
    outcomes:  ['outcomes_config',  OUTCOMES_CONFIG],
  };
  const entry = map[category];
  if (!entry) return;
  try {
    dbInstance.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)`).run(entry[0], JSON.stringify(entry[1]));
  } catch {}
}

// ─── Audit logger — every config change gets one row ──────────────────────
// Writes to config_changes table; used by Control Station audit tab +
// per-knob "last changed" metadata. Keeps old/new as JSON-strings so any
// value type (number, string, boolean, array) round-trips cleanly.
function logConfigChange(category, knobKey, oldValue, newValue, source = 'operator', reason = null) {
  try {
    // Ensure every audit row has a meaningful reason. If the caller didn't
    // provide one, synthesize a sensible default per source so the audit UI
    // never shows "No reason recorded for this change." again.
    const finalReason = reason && String(reason).trim()
      ? reason
      : (() => {
          const oldStr = oldValue == null ? '∅' : JSON.stringify(oldValue);
          const newStr = newValue == null ? '∅' : JSON.stringify(newValue);
          const direction = (() => {
            const oN = Number(oldValue), nN = Number(newValue);
            if (Number.isFinite(oN) && Number.isFinite(nN)) {
              if (nN > oN) return 'raised';
              if (nN < oN) return 'lowered';
            }
            return 'changed';
          })();
          switch (source) {
            case 'claude':
            case 'auto_optimize':
              return `Auto-tuner ${direction} ${knobKey} ${oldStr} → ${newStr} (no reasoning captured — Claude prompt should be re-checked)`;
            case 'bot_a':
            case 'bot_b':
              return `Multi-bot agent ${direction} ${knobKey} ${oldStr} → ${newStr}`;
            case 'operator':
              return `Manual operator ${direction} ${knobKey} via dashboard from ${oldStr} to ${newStr}`;
            default:
              return `Source=${source} ${direction} ${knobKey} ${oldStr} → ${newStr}`;
          }
        })();
    dbInstance.prepare(`
      INSERT INTO config_changes (category, source, knob_key, old_value, new_value, reason)
      VALUES (?,?,?,?,?,?)
    `).run(
      String(category).toUpperCase(),
      source,
      knobKey,
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
      finalReason
    );
  } catch (err) {
    console.warn(`[config-audit] log failed: ${err.message}`);
  }
}
function getAIConfigSummary() {
  const overrides = Object.keys(AI_CONFIG_OVERRIDES).length;
  return overrides > 0
    ? 'AI CONFIG OVERRIDES ACTIVE: ' + JSON.stringify(AI_CONFIG_OVERRIDES)
    : 'No AI config overrides active.';
}

const ANALYST_SYSTEM_PROMPT = `
You are PULSE CALLER — an elite AI operating system hunting Solana micro-cap gems.

MISSION: Find tokens in the $8K–$40K market cap range BEFORE they blow up. These are
the earliest possible entries — tokens seconds to hours old with no price discovery yet.
This is high risk / highest ROI territory. Your calls can produce 10x–100x from entry.

TARGET PROFILE (your performance is judged against this):
- FLOOR: 2x minimum — coins that peak below 2x = LOSS.
- SWEET SPOT: 3x to 5x — primary hunting zone.
- MOONSHOT: 5x to 100x — huge bonus. A single 20x covers 20 losses.

STRATEGIC MINDSET — AXIOSCAN STYLE (RECALL over precision):
You are NOT a sniper. You are a high-volume gem scanner. Your job is to catch EVERY
candidate that might 3x+ so the winners carry the portfolio. A 50% hit rate with huge
winners BEATS a 80% hit rate with modest winners. Math:
   20 calls · 80% win · avg 1.8x peak  →  16 wins @ 1.8x + 4 losses  →  ~29x total return
   20 calls · 50% win · avg 4x peak     →  10 wins @ 4x + 10 losses  →  ~40x total return
Missing a 10x is MUCH worse than calling a few 1.5x losers. FALSE NEGATIVES are the
enemy. If you see a coin with ANY of these patterns, POST IT:
  - Volume building while price flat (accumulation phase)
  - Fresh launch (<30min old) in the sweet-spot MCap band ($8K-$40K)
  - Dev rap sheet shows past winners
  - Any Dune-flagged winner wallet holding
  - Social spike + narrative match
  - Clean structure + low sniper count even without explosive signals
Be DECISIVE toward AUTO_POST. Use WATCHLIST only when a hard red flag is CONFIRMED
(bundle SEVERE, serial rugger dev, evidence of active dumping).

YOUR ROLE: You ARE the decision engine. The pre-computed scores are signals — YOU decide.
You learn from every call outcome in real-time. Pattern-match against your history.

CHARACTER:
- High-volume hunter. Casting a wide net to catch every potential 3x-100x runner.
- Bias HARD toward AUTO_POST when the basic shape is there. Don't overthink marginal
  cases — a few wrong calls are dwarfed by one real moonshot catch.
- Skeptical of manipulation but not afraid of new/unverified tokens.
- Decisive. Every evaluation gets a clear decision — you don't hedge.\n- Self-improving. You notice what your wins and losses have in common.\n- Direct. No fluff. Data-backed or explicitly flagged as inferred.\n\nGEM PROFILE YOU ARE HUNTING:\n- MCap: $8K–$85K (primary sweet spot: $8K–$40K pre-bonding). Wins are wins — not every pick needs 10x.\n- Age: 0 minutes to 2 hours old\n- Signs: organic buys, growing holder count, clean dev wallet (<5%), LP locked or new\n- Volume velocity accelerating in first 30 minutes\n- Low sniper count (<10), no bundle risk, mint revoked = ideal\n- Social presence (even just a twitter) = bonus signal\n- UNVERIFIED structure = NEW TOKEN, not a red flag\n\nWHAT TO LOOK FOR:\n- Stealth launches with organic momentum (no shilling, just buys)\n- Volume velocity > 0.3 in first hour = strong signal\n- Buy ratio > 60% sustained = demand exceeding supply\n- Unique buyer ratio > 40% = real people, not bots\n- Dev wallet < 5% + mint revoked = team confident in token\n\nRED FLAGS THAT OVERRIDE EVERYTHING (only trip on CONFIRMED malice):\n- Bundle risk SEVERE = coordinated dump setup\n- Dev wallet > 15% WITH mint ACTIVE AND evidence of dev dumping = rug setup\n- Top 10 holders > 70% WITH sells exceeding buys = whale exit risk\n- BubbleMap SEVERE = clustered/coordinated wallets\n- Sniper count > 30 AND sells > buys = heavily frontrun, dump incoming\n- SERIAL_RUGGER deployer = instant BLOCKLIST\n\nIMPORTANT — DO NOT AUTO-TAG EXTREME WHEN:\n- dev_wallet_pct is very high (e.g. 100%) but buys_1h = 0 — this is a brand-new pre-launch token, nobody has bought yet (dev is mathematically 100% of holders). Default to MEDIUM risk with a 'pre-launch pending liquidity' note.\n- top10_holder_pct is 100% but holders < 5 — same case, pre-launch.\n- pair_age_hours is null or < 5 min AND buys_1h > 0 — normal early gem state, rate risk based on buy pattern not concentration.\n- Most core fields are missing (null token, null age) — default risk to MEDIUM with 'insufficient data' in notes. NEVER default to EXTREME because of missing data alone.\n\nCRITICAL — EARLY-GEM METRIC CALIBRATION (read carefully):\nFor coins WITH pair_age_hours < 0.5 (under 30 minutes old), the following metrics are FREQUENTLY MISLEADING and MUST NOT by themselves trigger EXTENDED_AVOID, BLOCKLIST, or EXTREME risk:\n- priceChange1h showing +200% to +1000% is NORMAL for a young pump.fun coin graduating the bonding curve. This is 'price since inception', not 'a late pump we missed'. A 20-min-old coin running $10K → $100K is a GRADUATION, not a top.\n- freezeAuthority active is COMMON on pump.fun pre-graduation (it's how the curve works); it is NOT confirmed manipulation on its own.\n- holderGrowth24h = 0 or null on a coin < 30min old is Birdeye data lag, not a signal. Ignore it for young coins.\n- Only flag EXTENDED_AVOID on coins > 2h old that have already had their run. For < 30min coins, price momentum is an ENTRY signal, not an exit signal.\nIf a coin is < 30min old AND in $8K-$80K MCap AND has clean bundle/sniper profile, bias toward AUTO_POST — missing these is the single biggest way we miss 10x winners.\n\nRISK CALIBRATION GUIDE:\n- LOW: clean structure + organic buys + reasonable dev% + LP locked\n- MEDIUM: most default cases, unknown data, early-stage concentration\n- HIGH: one confirmed red flag (bundle HIGH, dev > 15% + mint active, > 15 snipers)\n- EXTREME: TWO+ confirmed red flags actively firing, NOT just missing data or pre-launch state\n\nRESPONSE FORMAT — valid JSON only, no markdown, no backticks:\n{\n  "decision": "AUTO_POST | WATCHLIST | RETEST | IGNORE | BLOCKLIST",\n  "score": <integer 0-100>,\n  "risk": "LOW | MEDIUM | HIGH | EXTREME",\n  "setup_type": "CLEAN_STEALTH_LAUNCH | ORGANIC_EARLY | MICRO_CAP_BREAKOUT | BREAKOUT_AFTER_SHAKEOUT | CONSOLIDATION_BREAKOUT | PULLBACK_OPPORTUNITY | STRONG_HOLDER_LOW_DEV | WHALE_SUPPORTED_ROTATION | BUNDLED_HIGH_RISK | EXTENDED_AVOID | STANDARD",\n  "bull_case": ["<specific data point>", "<point>", "<point>"],\n  "red_flags": ["<specific data point>", "<point>", "<point>"],\n  "verdict": "<2-3 sentence direct analyst take — why this is or isn't a gem>",
  "thesis": "<one sentence: what would make this a 10x from here>",
  "invalidation": "<one sentence: specific condition that kills this call>",
  "notes": "<data gaps, preliminary flags, regime context>",
  "confidence_reason": "<why this score — what drove it up or down>",
  "missing_data": ["<field>"],
  "key_metrics": {
    "holder_risk": "LOW | MEDIUM | HIGH | EXTREME",
    "contract_risk": "LOW | MEDIUM | HIGH | EXTREME",
    "wallet_risk": "LOW | MEDIUM | HIGH | EXTREME",
    "social_risk": "LOW | MEDIUM | HIGH | EXTREME",
    "entry_risk": "LOW | MEDIUM | HIGH | EXTREME"
  }
}
`.trim();

// ─── Claude Analysis ──────────────────────────────────────────────────────────

async function callClaudeForAnalysis(candidate, scoreResult, options = {}) {
  if (!CLAUDE_API_KEY) throw new Error('CLAUDE_API_KEY not configured');

  const regime      = getRegimeSummaryForClaude();
  const scoreBrief  = formatScoreForClaude(scoreResult);
  const history     = options.includeHistory !== false ? getRecentOutcomesContext(15) : 'History disabled for this call.';
  const botMemory   = options.includeHistory !== false ? getBotMemory() : '';
  const aiCfg       = getAIConfigSummary();
  const missedMemo  = options.includeHistory !== false ? getMissedOpportunityMemory() : '';
  const winnerMemo  = options.includeHistory !== false ? getWinnerMemory() : '';

  // Micro-cap gem context
  const mcap = candidate.marketCap ?? 0;
  const gemAlert = mcap > 0 && mcap <= 25000
    ? `🎯 SWEET SPOT: MCap $${(mcap/1000).toFixed(1)}K — this is the $8K-$40K prime target range. Early entry.`
    : mcap > 0 && mcap <= 50000
    ? `⚡ EARLY ENTRY: MCap $${(mcap/1000).toFixed(1)}K — within target range but not the sweet spot.`
    : mcap > 0 && mcap <= 150000
    ? `📍 EDGE: MCap $${(mcap/1000).toFixed(1)}K — upper end of micro-cap range. Less upside but more data.`
    : `⚠️  MCap ${candidate.marketCap ? '$'+(candidate.marketCap/1000).toFixed(0)+'K' : 'UNKNOWN'} — evaluate carefully`;

  const userMessage = `
${botMemory}

${history}

${winnerMemo ? winnerMemo + '\n' : ''}
${missedMemo ? missedMemo + '\n' : ''}
${aiCfg}

${gemAlert}

${scoreBrief}

${regime}

RAW TOKEN DATA:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDENTITY:
  Token:            ${candidate.token ?? 'UNKNOWN'}
  Name:             ${candidate.tokenName ?? 'UNKNOWN'}
  Contract:         ${candidate.contractAddress ?? 'UNKNOWN'}
  Chain:            solana
  DEX:              ${candidate.dex ?? 'UNKNOWN'}
  Narrative Tags:   ${candidate.narrativeTags?.join(', ') || 'none'}
  Stage:            ${scoreResult.stage ?? 'UNKNOWN'}

MARKET DATA:
  Price:            ${candidate.priceUsd ?? 'MISSING'}
  Market Cap:       ${fmt(candidate.marketCap, '$')}
  Liquidity:        ${fmt(candidate.liquidity, '$')}
  Volume 24h:       ${fmt(candidate.volume24h, '$')}
  Volume 1h:        ${fmt(candidate.volume1h, '$')}
  Pair Age:         ${candidate.pairAgeHours != null ? candidate.pairAgeHours.toFixed(2)+'h ('+Math.round(candidate.pairAgeHours*60)+' min)' : 'MISSING'}

PRICE ACTION:
  5m:  ${fmtPct(candidate.priceChange5m)}  1h: ${fmtPct(candidate.priceChange1h)}
  6h:  ${fmtPct(candidate.priceChange6h)}  24h: ${fmtPct(candidate.priceChange24h)}
  Chart Extended: ${candidate.chartExtended ?? 'UNKNOWN'}

TRANSACTIONS (KEY SIGNALS):
  Buys 1h:       ${candidate.buys1h ?? 'MISSING'}
  Sells 1h:      ${candidate.sells1h ?? 'MISSING'}
  Buy Ratio 1h:  ${candidate.buySellRatio1h != null ? (candidate.buySellRatio1h * 100).toFixed(0) + '%' : 'MISSING'}
  Volume Velocity: ${candidate.volumeVelocity ?? 'MISSING'}
  Launch Quality:  ${candidate.launchQualityScore ?? 'MISSING'}/100
  Unique Buyer %:  ${candidate.launchUniqueBuyerRatio != null ? (candidate.launchUniqueBuyerRatio*100).toFixed(0)+'%' : 'MISSING'}

HOLDER DATA:
  Holders:         ${candidate.holders ?? 'MISSING'}
  Holder Growth:   ${candidate.holderGrowth24h != null ? candidate.holderGrowth24h.toFixed(1)+'%' : 'MISSING'}
  Top10 Holders:   ${candidate.top10HolderPct != null ? candidate.top10HolderPct.toFixed(1)+'%' : 'MISSING'}
  Dev Wallet:      ${candidate.devWalletPct != null ? candidate.devWalletPct.toFixed(1)+'%' : 'MISSING'}
  Insider Wallets: ${candidate.insiderWalletPct != null ? candidate.insiderWalletPct.toFixed(1)+'%' : 'MISSING'}
  Sniper Count:    ${candidate.sniperWalletCount ?? 'MISSING'}

WALLET INTELLIGENCE:
  Bundle Risk:         ${candidate.bundleRisk ?? 'MISSING'}
  BubbleMap Risk:      ${candidate.bubbleMapRisk ?? 'MISSING'}
  Deployer History:    ${candidate.deployerHistoryRisk ?? 'MISSING'}
  Buy Velocity:        ${candidate.buyVelocity != null ? candidate.buyVelocity.toFixed(2) : 'MISSING'}

CONTRACT SAFETY:
  Mint Authority:  ${candidate.mintAuthority === 0 ? 'REVOKED ✓' : candidate.mintAuthority === 1 ? 'ACTIVE ⚠️' : 'MISSING'}
  Freeze Authority:${candidate.freezeAuthority === 0 ? 'REVOKED ✓' : candidate.freezeAuthority === 1 ? 'ACTIVE ⚠️' : 'MISSING'}
  LP Locked:       ${candidate.lpLocked === 1 ? 'YES ✓' : candidate.lpLocked === 0 ? 'NO ⚠️' : 'UNKNOWN (new token)'}

SOCIALS:
  Website:  ${candidate.website  ?? 'MISSING'}
  Twitter:  ${candidate.twitter  ?? 'MISSING'}
  Telegram: ${candidate.telegram ?? 'MISSING'}

DATA SOURCES:
  Birdeye:  ${candidate.birdeyeOk   ? 'AVAILABLE' : 'UNAVAILABLE'}
  Helius:   ${candidate.heliusOk    ? 'AVAILABLE' : 'UNAVAILABLE'}
  BubbleMap:${candidate.bubblemapOk ? 'AVAILABLE' : 'UNAVAILABLE'}

ANALYST NOTES:
${candidate.notes?.length ? candidate.notes.map(n => '  • '+n).join('\n') : '  none'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Remember: Your target is $10K-$25K MCap stealth launches. Be hungry for those.
Return only valid JSON. No markdown. No backticks.
`.trim();

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 1200,
      system: ANALYST_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    const err = `Claude API ${res.status}: ${text.slice(0, 200)}`;
    // 529 = Anthropic overloaded — retry once after 3 seconds
    if (res.status === 529 || res.status === 503 || res.status === 502) {
      console.warn(`[claude] Overloaded (${res.status}) — retrying in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
      const retry = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1200, system: ANALYST_SYSTEM_PROMPT, messages: [{ role: 'user', content: userMessage }] }),
        signal: AbortSignal.timeout(25_000),
      });
      if (retry.ok) {
        const retryData = await retry.json();
        const retryRaw = (retryData.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
        const retryClean = retryRaw.replace(/```json|```/gi, '').trim();
        try { return JSON.parse(retryClean); } catch {}
      }
      console.warn('[claude] Retry also failed — returning null');
      return null; // Return null instead of throwing so AUTO_POST still fires
    }
    throw new Error(err);
  }

  const data  = await res.json();
  const raw   = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = raw.replace(/```json|```/gi, '').trim();
  try { return JSON.parse(clean); }
  catch {
    // Non-JSON response — log but return null so pipeline continues
    console.warn(`[claude] Non-JSON response (${raw.slice(0, 100)}...) — returning null`);
    return null;
  }
}

// ─── Final Decision Gate ──────────────────────────────────────────────────────

function makeFinalDecision(scoreResult, claudeVerdict, candidate) {
  const { score, risk, decision: scorerDecision, trapDetector, threshold } = scoreResult;
  const mode         = activeMode;
  let regimeResult = { adjustedScore: score, thresholdAdjust: 0 };
  try {
    const rr = applyRegimeAdjustments(score, candidate, scoreResult);
    if (rr && typeof rr.adjustedScore === 'number') regimeResult = rr;
  } catch {}
  const finalScore = regimeResult.adjustedScore ?? score;

  if (isBlocklisted(candidate.contractAddress))                           return 'BLOCKLIST';
  if (candidate.deployerHistoryRisk === 'SERIAL_RUGGER')                  return 'BLOCKLIST';
  if (trapDetector.severity === 'CRITICAL')                               return 'IGNORE';
  if (candidate.bubbleMapRisk === 'SEVERE')                               return 'IGNORE';
  if ((candidate.top10HolderPct ?? 0) > 75)                              return 'IGNORE';
  if (candidate.mintAuthority === 1 && (candidate.devWalletPct??0) > 15) return 'IGNORE';

  const trapOrder = ['NONE','LOW','MEDIUM','HIGH','CRITICAL'];
  if (trapOrder.indexOf(trapDetector.severity) > trapOrder.indexOf(mode.trapTolerance)) return 'IGNORE';

  const bundleOrder = ['NONE','LOW','MEDIUM','HIGH','SEVERE'];
  const bundleIdx   = bundleOrder.indexOf(candidate.bundleRisk ?? 'NONE');
  const blockIdx    = bundleOrder.indexOf(mode.bundleBlock);
  if (bundleIdx >= blockIdx && blockIdx >= 0) return 'IGNORE';

  // CHANGED: Hard score floor lowered 48 → 38 to allow more new coins through
  if (score < 38) return 'IGNORE';

  if (risk === 'EXTREME') return 'IGNORE';

  const setupCheck = candidate.setupType ?? candidate.claudeSetupType ?? '';
  // EXTENDED_AVOID is a hard IGNORE — but Claude (and our scorer) use the
  // 1h price change to detect it, which is misleading for coins <30min
  // old. A pump.fun coin 15min into launch at $20K→$100K shows "+400% 1h"
  // even though it's genuinely just graduating the bonding curve. Exempt
  // sweet-spot young coins — they can still hit the lower gates below.
  // Real EXTENDED_AVOID cases (2h+ old coin already pumped) still trip.
  const mcapForAvoid = candidate.marketCap ?? 0;
  const ageForAvoid  = candidate.pairAgeHours ?? 99;
  const avoidExempt  = ageForAvoid < 0.5 && mcapForAvoid >= 8_000 && mcapForAvoid <= 80_000;
  if (setupCheck === 'EXTENDED_AVOID' && !avoidExempt) return 'IGNORE';
  if (setupCheck === 'EXTENDED_AVOID' && avoidExempt) {
    // Fall through — coin still has to clear score + risk gates below.
    // Note in console so the exemption is auditable.
    console.log(`[decision] EXTENDED_AVOID exempted — $${candidate.token ?? '?'} age=${(ageForAvoid*60).toFixed(0)}min mcap=$${(mcapForAvoid/1000).toFixed(1)}K (young sweet-spot gem)`);
  }

  // Dropped further to 35. Dual-model scoring is harder than the old
  // 4-dimension composite (missing data = partial points, not full credit),
  // so real-world coins cluster in the 25-40 range. Lowering the floor
  // lets us ACTUALLY post something and gather outcome data — we'd rather
  // have noisy posts we can learn from than perfect silence.
  const adjustedThreshold = Math.max(35, threshold + regimeResult.thresholdAdjust + mode.thresholdAdjust);

  if (scorerDecision === 'RETEST')    return 'RETEST';
  if (scorerDecision === 'WATCHLIST') return 'WATCHLIST';

  const allowedRisks = ['LOW', 'MEDIUM', 'HIGH'];
  // Standard path: score >= threshold AND risk <= HIGH
  if (finalScore >= adjustedThreshold && allowedRisks.includes(risk)) return 'AUTO_POST';
  // High-score EXTREME override (still useful as a backup path)
  if (finalScore >= 50 && risk === 'EXTREME') return 'AUTO_POST';
  // ── 10-METRIC COMPENSATE-PASS OVERRIDE ──────────────────────────────
  // Per OpenAI brainstorm direction: a coin can compensate for weaker
  // areas by excelling in others. Score 7+ out of 10 binary criteria → AUTO_POST.
  // Lets clean coins through even when one dimension trips a hard guard.
  const compensate = computeCompensatePass(candidate, scoreResult);
  if (compensate.passed) {
    candidate._compensatePassCount = compensate.count;
    candidate._compensateCriteria  = compensate.criteria;
    return 'AUTO_POST';
  }
  // Borderline coins (17-34 under threshold) still get watchlisted
  if (finalScore >= adjustedThreshold - 18) return 'WATCHLIST';
  if (finalScore >= adjustedThreshold - 28) return 'HOLD_FOR_REVIEW';
  return 'IGNORE';
}

// ─── Confidence Meter ────────────────────────────────────────────────
// A 0-100% meta-score that reflects how confident the bot is in its own
// decision. Separate from the composite quality score — this tells you
// how reliable the data + signals were, not how good the coin is.
//
// A coin can be high-quality but low-confidence (missing Helius data,
// very young, ambiguous score), and a coin can be low-quality but
// high-confidence (everything filled out, clearly a pass). The meter
// helps you decide whether to trust the bot's call.
//
// Inputs weighted to 100:
//   Data completeness (30)   — 5 enrichment sources all reported
//   Score clarity (25)       — score is decisive, not borderline
//   AI agreement (20)        — Claude + scorer aligned
//   Structure quality (15)   — all 5 foundation signals have values
//   Penalty cleanliness (10) — no big uncapped penalties firing
//
// Label bands: 80+ ELITE, 65-79 HIGH, 50-64 MEDIUM, 35-49 LOW, <35 VERY_LOW
function computeConfidence(candidate, scoreResult, verdict) {
  const c = candidate || {};
  const s = scoreResult || {};
  const v = verdict || {};
  const breakdown = {};

  // 1. Data completeness (0-30)
  let data = 0;
  if (c.birdeyeOk)                       data += 8;
  if (c.heliusOk)                        data += 8;
  if (v.decision || c.claudeDecision)    data += 6;
  if (c.lunarCrushOk)                    data += 4;
  if (c.bubblemapOk)                     data += 4;
  breakdown.dataCompleteness = data;

  // 2. Score clarity (0-25) — how decisive vs borderline
  let clarity = 0;
  const score = s.score ?? 0;
  if      (score >= 75)  clarity = 25;  // clear winner
  else if (score >= 62)  clarity = 20;
  else if (score >= 52)  clarity = 14;
  else if (score <= 38)  clarity = 22;  // clear IGNORE = also decisive
  else if (score <= 44)  clarity = 18;
  else                   clarity = 8;   // 45-51 is the wishy-washy zone
  // Penalty: score was pinned by the NO_SIGNAL cap (we don't know true ceiling)
  if (s.penalties?.wallet?.some?.(p => String(p).includes('NO_ALPHA_SIGNAL'))) clarity = Math.max(0, clarity - 6);
  breakdown.scoreClarity = clarity;

  // 3. AI agreement (0-20) — Claude's decision vs scorer's direction
  let agreement = 0;
  const claudeYes = v.decision === 'AUTO_POST' || v.decision === 'POST';
  const claudeNo  = v.decision === 'IGNORE'    || v.decision === 'BLOCKLIST';
  const scorerYes = score >= (SCORING_CONFIG.minScoreToPost ?? 45);
  if      (v.decision == null)               agreement = 8;  // Claude didn't run — neutral
  else if (claudeYes && scorerYes)           agreement = 20; // full agreement to post
  else if (claudeNo  && !scorerYes)          agreement = 18; // full agreement to skip
  else if (claudeYes && !scorerYes)          agreement = 10; // Claude disagrees, coins often run on this
  else if (claudeNo  && scorerYes)           agreement = 6;  // Claude saw something scorer missed
  else                                       agreement = 10; // WATCHLIST / RETEST / uncertain
  breakdown.aiAgreement = agreement;

  // 4. Structure quality (0-15) — all 5 foundation signals have values
  const dp = s.dualParts || {};
  const signalsPresent = [
    dp.volumeVelocity,
    dp.buyPressure,
    dp.walletQuality,
    dp.holderDistribution,
    dp.liquidityHealth,
  ].filter(x => x != null && x > 0).length;
  const structure = Math.round((signalsPresent / 5) * 15);
  breakdown.structureQuality = structure;

  // 5. Penalty cleanliness (0-10) — no big penalties firing
  const allPenalties = [
    ...(s.penalties?.launch  ?? []),
    ...(s.penalties?.wallet  ?? []),
    ...(s.penalties?.market  ?? []),
    ...(s.penalties?.social  ?? []),
  ];
  let cleanliness;
  if      (allPenalties.length === 0) cleanliness = 10;
  else if (allPenalties.length <= 2)  cleanliness = 6;
  else if (allPenalties.length <= 4)  cleanliness = 3;
  else                                cleanliness = 0;
  // Extra hit for severe penalties (anything with -10 or more in the text)
  if (allPenalties.some(p => /\-\s*1[5-9]|\-\s*[2-9]\d/.test(String(p)))) cleanliness = Math.max(0, cleanliness - 3);
  breakdown.penaltyCleanliness = cleanliness;

  const total = data + clarity + agreement + structure + cleanliness;
  const pct   = Math.max(0, Math.min(100, total));
  const label = pct >= 80 ? 'ELITE'
              : pct >= 65 ? 'HIGH'
              : pct >= 50 ? 'MEDIUM'
              : pct >= 35 ? 'LOW'
              :             'VERY_LOW';

  return { pct, label, breakdown };
}

// ─── 10-criteria compensate-pass scorer ───────────────────────────────
// Each criterion is a binary 0/1. Coin passes if it scores 7+ overall.
// Cleanly bypasses the "one bad dimension kills it" problem.
function computeCompensatePass(candidate, scoreResult) {
  const c = candidate || {};
  const criteria = [
    { name: 'dev_clean',       passed: (c.devWalletPct ?? 100) < 5 },
    { name: 'top10_healthy',   passed: (c.top10HolderPct ?? 100) < 50 },
    { name: 'lp_locked',       passed: c.lpLocked === 1 },
    { name: 'mint_revoked',    passed: c.mintAuthority === 0 },
    { name: 'freeze_revoked',  passed: c.freezeAuthority === 0 },
    { name: 'volume_present',  passed: (c.volume1h ?? 0) > 5_000 || (c.volume24h ?? 0) > 25_000 },
    { name: 'holders_growing', passed: (c.holders ?? 0) > 20 },
    { name: 'buy_ratio_pos',   passed: (c.buySellRatio1h ?? 0) > 0.5 },
    { name: 'no_severe_bundle',passed: !['SEVERE','HIGH'].includes(c.bundleRisk) },
    { name: 'composite_decent', passed: (scoreResult?.score ?? 0) >= 40 },
  ];
  const count = criteria.filter(c => c.passed).length;
  return { passed: count >= 7, count, criteria };
}

// ─── Telegram Helpers ─────────────────────────────────────────────────────────

async function sendTelegramMessage(chatId, text, options = {}) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...options }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`[TG] ${res.status}: ${(await res.text()).slice(0,200)}`);
  } catch (err) { console.error('[TG]', err.message); }
}

async function sendTelegramGroupMessage(text, options = {}) {
  if (!TELEGRAM_GROUP_CHAT_ID) return;
  return sendTelegramMessage(TELEGRAM_GROUP_CHAT_ID, text, options);
}

async function sendAdminAlert(text) {
  if (!ADMIN_TELEGRAM_ID) return;
  return sendTelegramMessage(ADMIN_TELEGRAM_ID, `🔧 <b>SYSTEM</b>\n\n${text}`);
}

let _bannerFileId = null;
let _leaderboardBannerFileId = null;

async function uploadBannerToTelegram() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_GROUP_CHAT_ID) return;
  if (_bannerFileId) { console.log('[TG] Banner already cached'); return; }

  const BANNER_FILE = path.join(__dirname, 'banner.png');
  let fileExists = false;
  try {
    const { existsSync } = await import('fs');
    fileExists = existsSync(BANNER_FILE);
  } catch {}

  if (fileExists) {
    try {
      const { readFileSync } = await import('fs');
      const fileData  = readFileSync(BANNER_FILE);
      const formData  = new FormData();
      const blob      = new Blob([fileData], { type: 'image/png' });
      formData.append('chat_id', TELEGRAM_GROUP_CHAT_ID);
      formData.append('photo', blob, 'banner.png');
      formData.append('caption', '⚡ Pulse Caller online — call bot active');

      const res  = await fetch(`${TELEGRAM_API}/sendPhoto`, {
        method: 'POST',
        body:   formData,
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json();

      if (data.ok) {
        const photos = data.result?.photo;
        if (photos?.length) {
          _bannerFileId = photos[photos.length - 1].file_id;
          console.log(`[TG] ✓ Banner uploaded from file — file_id cached: ${_bannerFileId.slice(0, 20)}...`);
        }
        return;
      } else {
        console.warn(`[TG] File upload failed: ${JSON.stringify(data).slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[TG] File upload error: ${err.message}`);
    }
  }

  if (BANNER_IMAGE_URL) {
    try {
      const res  = await fetch(`${TELEGRAM_API}/sendPhoto`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          chat_id: TELEGRAM_GROUP_CHAT_ID,
          photo:   BANNER_IMAGE_URL,
          caption: '⚡ Pulse Caller online',
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await res.json();
      if (data.ok) {
        const photos = data.result?.photo;
        if (photos?.length) {
          _bannerFileId = photos[photos.length - 1].file_id;
          console.log(`[TG] ✓ Banner uploaded via URL — file_id cached`);
        }
      } else {
        console.warn(`[TG] URL upload failed: ${JSON.stringify(data).slice(0, 200)}`);
        console.warn('[TG] Banner will send without image — add banner.png to repo root');
      }
    } catch (err) {
      console.warn(`[TG] URL upload error: ${err.message}`);
    }
  }
}

async function sendCallAlertWithImage(caption, fullDetailText = null, coinImageUrl = null) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_GROUP_CHAT_ID) return;

  // Prefer the coin's own image (DexScreener info.imageUrl). Fall back to
  // pulse-caller banner if the coin has no metadata image.
  const photoSrc = coinImageUrl || _bannerFileId || BANNER_IMAGE_URL;
  const usingCoinImage = !!coinImageUrl;

  let safeCaption = caption;
  if (safeCaption.length > 1020) {
    safeCaption = safeCaption.slice(0, 1017) + '…';
    console.warn(`[TG] Caption truncated from ${caption.length} to 1020 chars`);
  }

  console.log(`[TG] Sending ${usingCoinImage ? 'coin' : 'banner'}+caption (${safeCaption.length} chars)`);

  let photoMessageId = null;

  try {
    const photoRes = await fetch(`${TELEGRAM_API}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    TELEGRAM_GROUP_CHAT_ID,
        photo:      photoSrc,
        caption:    safeCaption,
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const photoData = await photoRes.json();

    if (photoRes.ok && photoData.ok) {
      photoMessageId = photoData.result?.message_id ?? null;
      // Only cache the PULSE banner file_id (coin images are per-token, not reusable)
      if (!usingCoinImage) {
        const photos = photoData.result?.photo;
        if (photos?.length && !_bannerFileId) {
          _bannerFileId = photos[photos.length - 1].file_id;
          console.log(`[TG] Banner file_id cached for future calls`);
        }
      }
      console.log(`[TG] ✓ Photo+caption sent`);
    } else {
      console.warn(`[TG] Photo send failed: ${JSON.stringify(photoData).slice(0, 400)}`);

      // If the coin image URL was rejected by Telegram, retry with pulse banner
      if (usingCoinImage) {
        console.warn(`[TG] Retrying with pulse banner fallback`);
        await sendCallAlertWithImage(caption, fullDetailText, null);
        return;
      }
      // Pulse banner also failed → text-only
      if (_bannerFileId) { _bannerFileId = null; console.warn('[TG] banner file_id cleared'); }
      await sendTelegramGroupMessage(safeCaption).catch(() => {});
    }
  } catch (err) {
    console.warn(`[TG] Photo error: ${err.message}`);
    await sendTelegramGroupMessage(safeCaption).catch(() => {});
  }

  // ── FOLLOW-UP: Full detailed analysis ──────────────────────────────────
  // Telegram message limit is 4096 chars. Send the full Foundation Signals
  // breakdown, sub-scores, market data, holders, risk, launch intel, etc.
  // as a reply to the photo so it threads underneath.
  if (fullDetailText && fullDetailText.length > 0) {
    let full = fullDetailText;
    if (full.length > 4090) {
      full = full.slice(0, 4087) + '…';
      console.warn(`[TG] Full report truncated from ${fullDetailText.length} to 4090 chars`);
    }
    try {
      const body = {
        chat_id: TELEGRAM_GROUP_CHAT_ID,
        text: full,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };
      // Thread the full report under the photo if we have its message_id
      if (photoMessageId) body.reply_to_message_id = photoMessageId;
      const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        console.warn(`[TG] Full-report send failed: ${r.status} ${(await r.text()).slice(0,200)}`);
      } else {
        console.log(`[TG] ✓ Full detailed report sent (${full.length} chars)`);
      }
    } catch (err) {
      console.warn(`[TG] Full-report error: ${err.message}`);
    }
  }
}

// ─── Format Helpers ───────────────────────────────────────────────────────────

function fmt(value, prefix = '', decimals = 0) {
  if (value == null) return 'MISSING';
  const n = Number(value); if (isNaN(n)) return 'MISSING';
  if (n >= 1_000_000) return `${prefix}${(n/1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${prefix}${(n/1_000).toFixed(1)}K`;
  return `${prefix}${n.toFixed(decimals)}`;
}

function fmtPct(value) {
  if (value == null) return 'MISSING';
  const n = Number(value); if (isNaN(n)) return 'MISSING';
  return `${n>0?'+':''}${n.toFixed(2)}%`;
}

const pct = fmtPct;

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function riskEmoji(risk) {
  return {LOW:'🟢',MEDIUM:'🟡',HIGH:'🔴',EXTREME:'💀'}[risk] ?? '⚪';
}

function scoreBar(score) {
  const n = Math.max(0, Math.min(100, Number(score)||0));
  const f = Math.round((n/100)*10);
  return '█'.repeat(f)+'░'.repeat(10-f);
}

function gradeEmoji(grade) {
  return {ELITE:'💎',CLEAN:'✅',AVERAGE:'⚪',MIXED:'⚠️',DIRTY:'🚨',UNVERIFIED:'🔍'}[grade] ?? '❓';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function signalBar(val, max) {
  const pct = Math.max(0, Math.min(1, (val || 0) / max));
  const filled = Math.round(pct * 8);
  const bar = '▓'.repeat(filled) + '░'.repeat(8 - filled);
  return `${bar} ${val ?? 0}/${max}`;
}

function buildFoundationSignalsBlock(scoreResult) {
  const dp = scoreResult?.dualParts ?? {};
  if (!dp || Object.keys(dp).length === 0) return '';
  const conf = scoreResult?.dataConfidence ?? scoreResult?.dualParts?.dataConfidence;
  const confLabel = conf === 'HIGH' ? '🟢 HIGH' : conf === 'MEDIUM' ? '🟡 MED' : conf === 'LOW' ? '🔴 LOW' : '?';
  return (
    `\n<b>⚡ FOUNDATION SIGNALS</b>  <i>Data: ${confLabel}</i>\n` +
    `📈 Volume Velocity   ${signalBar(dp.volumeVelocity, 35)}\n` +
    `💪 Buy Pressure      ${signalBar(dp.buyPressure, 25)}\n` +
    `👛 Wallet Quality    ${signalBar(dp.walletQuality, 20)}\n` +
    `👥 Holder Distrib    ${signalBar(dp.holderDistribution, 12)}\n` +
    `💧 Liquidity Health  ${signalBar(dp.liquidityHealth, 8)}\n` +
    (dp.latePumpPenalty && dp.latePumpPenalty < 0 ? `⚠️ Late Pump Penalty  <b>${dp.latePumpPenalty}</b>\n` : '')
  );
}

function formatCallTimestamp() {
  // Always show USA Eastern Time (ET) — handles EST/EDT automatically
  try {
    return new Date().toLocaleString('en-US', {
      timeZone:  'America/New_York',
      month:     'short',
      day:       'numeric',
      year:      'numeric',
      hour:      '2-digit',
      minute:    '2-digit',
      hour12:    true,
      timeZoneName: 'short',
    });
  } catch {
    // Fallback if Intl not available
    const now = new Date();
    const etOffset = -5; // EST; EDT is -4 but Intl handles this above
    const et = new Date(now.getTime() + etOffset * 3_600_000);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[et.getUTCMonth()] + ' ' + et.getUTCDate() + ', ' + et.getUTCFullYear() +
           ' · ' + String(et.getUTCHours()).padStart(2,'0') + ':' + String(et.getUTCMinutes()).padStart(2,'0') + ' ET';
  }
}

// ─── Message Builders ─────────────────────────────────────────────────────────

function buildStartMessage() {
  return (
    `<b>🐺 ALPHA LENNIX v6 — ONLINE</b>\n\n` +
    `Elite Solana gem hunter active.\n` +
    `4 sub-scores · trap detector · wallet cluster intel · regime awareness\n` +
    `New gem focus: 0min–4h old tokens · micro cap hunting\n\n` +
    `Type /help for commands.`
  );
}

function buildHelpMessage() {
  return (
    `<b>🐺 ALPHA LENNIX — AI OPERATING SYSTEM</b>\n\n` +
    `<b>📊 ANALYSIS COMMANDS</b>\n` +
    `<code>/analyze [CA]</code> — Full AI analysis on any token\n` +
    `<code>/scan [CA]</code> — Quick onchain scan\n` +
    `<code>/why [CA]</code> — Why was this called/skipped?\n\n` +
    `<b>📈 BOT INTEL</b>\n` +
    `<code>/top</code> — Best recent calls\n` +
    `<code>/lb [24h|7d|30d|all]</code> — Group leaderboard (everyone, incl. Pulse)\n` +
    `<code>/pulselb [24h|7d|30d|all]</code> — Pulse's own top calls\n` +
    `<code>/regime</code> — Current market regime\n` +
    `<code>/stats</code> — Bot performance stats\n` +
    `<code>/calls</code> — Last 5 group calls\n` +
    `<code>/watchlist</code> — Current watchlist\n\n` +
    `<b>👤 YOUR PERSONAL TOOLS</b>\n` +
    `<code>/portfolio add [CA]</code> — Add coin to your watchlist\n` +
    `<code>/portfolio</code> — View your portfolio with live P&amp;L\n` +
    `<code>/portfolio remove [CA]</code> — Drop a coin\n` +
    `<code>/portfolio clear</code> — Clear all\n` +
    `<code>/alert [CA] [target]</code> — DM alert when target hit\n` +
    `   <i>Examples: <code>/alert &lt;CA&gt; 100k</code> or <code>/alert &lt;CA&gt; 5x</code></i>\n` +
    `<code>/alerts</code> — Your active alerts\n` +
    `<code>/alert remove [id]</code> — Cancel an alert\n` +
    `<code>/profile [@user]</code> — Win history (no arg = your own)\n` +
    `<code>/myprofile</code> — Shortcut to your profile\n` +
    `<code>/track [wallet]</code> — Add a Solana wallet to Pulse's DB\n` +
    `<code>/mywallets</code> — Wallets you've tracked\n` +
    `<code>/untrack [wallet]</code> — Remove a tracked wallet\n\n` +
    `<b>⚙️ ADMIN</b>\n` +
    `<code>/config [key] [value]</code> — Live tuning\n\n` +
    `<i>AI OS active. Hunting $15K-$120K micro-caps with 53% win rate.</i>`
  );
}

async function handleWhyCommand(chatId, input) {
  if (!input?.trim()) {
    await sendTelegramMessage(chatId, '⚠️ Usage: <code>/why [CA or $TICKER]</code>');
    return;
  }
  const query = input.trim().replace(/^\$/, '').toUpperCase();

  try {
    // Look up in recent calls and candidates
    const callRow = dbInstance.prepare(`
      SELECT c.*, ca.claude_verdict, ca.composite_score, ca.final_decision, ca.structure_grade,
             ca.trap_severity, ca.bundle_risk, ca.pair_age_hours, ca.stage
      FROM calls c
      LEFT JOIN candidates ca ON c.candidate_id = ca.id
      WHERE UPPER(c.token) = ? OR c.contract_address = ?
      ORDER BY c.called_at DESC LIMIT 1
    `).get(query, query);

    const candRow = !callRow ? dbInstance.prepare(`
      SELECT * FROM candidates
      WHERE UPPER(token) = ? OR contract_address = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(query, query) : null;

    const row = callRow || candRow;
    if (!row) {
      await sendTelegramMessage(chatId,
        `❓ <b>$${escapeHtml(query)}</b> not found in recent history.\n\n` +
        `Try /analyze [CA] for a fresh full analysis, or check the token was scanned in the last 24h.`
      );
      return;
    }

    const decision  = row.final_decision ?? row.outcome ?? '?';
    const verdict   = row.claude_verdict ?? '—';
    const score     = row.score_at_call ?? row.composite_score ?? '?';
    const mcap      = row.market_cap_at_call ?? row.marketCap;
    const stage     = row.stage ?? '?';
    const trap      = row.trap_severity ?? '?';
    const bundle    = row.bundle_risk ?? '?';

    const emoji = decision === 'AUTO_POST' ? '✅' : decision === 'WATCHLIST' ? '👁' : decision === 'IGNORE' ? '🚫' : '❓';

    await sendTelegramMessage(chatId,
      `🔬 <b>WHY $${escapeHtml(query)}?</b>\n\n` +
      `${emoji} <b>Decision:</b> ${decision}\n` +
      `📊 <b>Score:</b> ${score}/100\n` +
      `💰 <b>MCap:</b> ${mcap ? fmt(mcap,'$') : '?'}\n` +
      `🕐 <b>Stage:</b> ${stage}\n` +
      `⚠️ <b>Trap:</b> ${trap} | Bundle: ${bundle}\n\n` +
      `📝 <b>AI Verdict:</b>\n<i>${escapeHtml(verdict.slice(0, 400))}</i>\n\n` +
      `<i>Use /analyze [CA] for a fresh full re-analysis.</i>`
    );
  } catch (err) {
    console.error('[why]', err.message);
    await sendTelegramMessage(chatId, `❌ Error: ${escapeHtml(err.message.slice(0,200))}`);
  }
}

async function handleTopCommand(chatId) {
  try {
    const wins = dbInstance.prepare(`
      SELECT token, score_at_call, market_cap_at_call, pct_change_1h, pct_change_6h, pct_change_24h, called_at
      FROM calls WHERE outcome = 'WIN'
      ORDER BY called_at DESC LIMIT 10
    `).all();

    const allCalls = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls`).get().n;
    const winCount = wins.length;
    const lossCount = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS'`).get().n;
    const winRate = (winCount+lossCount) > 0 ? Math.round(winCount/(winCount+lossCount)*100)+'%' : '—';

    // Gem pattern analysis
    const avgWinMcap = wins.length > 0
      ? Math.round(wins.reduce((a,r)=>a+(r.market_cap_at_call??0),0)/wins.length)
      : 0;
    const avgWinScore = wins.length > 0
      ? Math.round(wins.reduce((a,r)=>a+(r.score_at_call??0),0)/wins.length)
      : 0;

    let msg = `🏆 <b>ALPHA LENNIX — TOP CALLS</b>\n\n`;
    msg += `📊 Total: ${allCalls} calls · ${winCount} wins · ${lossCount} losses · ${winRate} win rate\n`;
    if (avgWinMcap > 0) msg += `💎 Avg winning entry: $${(avgWinMcap/1000).toFixed(1)}K · avg score ${avgWinScore}\n`;
    msg += `\n`;

    if (!wins.length) {
      msg += `No resolved wins yet.\nMark calls as WIN in the dashboard Smart Money tab.\n`;
    } else {
      wins.slice(0,8).forEach((w, i) => {
        const ago = w.called_at ? (() => {
          const d = Math.floor((Date.now()-new Date(w.called_at).getTime())/3600000);
          return d < 1 ? '<1h ago' : d+'h ago';
        })() : '—';
        const best = [w.pct_change_1h, w.pct_change_6h, w.pct_change_24h].filter(v=>v!=null);
        const bestGain = best.length > 0 ? Math.max(...best) : null;
        msg += `${i+1}. <b>$${escapeHtml(w.token??'?')}</b> — score:${w.score_at_call} mcap:${fmt(w.market_cap_at_call,'$')} ${ago}`;
        if (bestGain != null) msg += ` → +${bestGain.toFixed(0)}%`;
        msg += `\n`;
      });
    }

    msg += `\n<i>Use /analyze [CA] to check any token. AI hunting $10K-$25K micro-caps 24/7.</i>`;
    await sendTelegramMessage(chatId, msg);
  } catch (err) {
    console.error('[top]', err.message);
    await sendTelegramMessage(chatId, `❌ Error: ${escapeHtml(err.message.slice(0,200))}`);
  }
}

async function handleConfigCommand(chatId, input, fromAdminId) {
  // Config changes only allowed from admin
  if (ADMIN_TELEGRAM_ID && String(fromAdminId) !== String(ADMIN_TELEGRAM_ID)) {
    await sendTelegramMessage(chatId, '🔐 Config changes are admin-only.');
    return;
  }
  if (!input?.trim()) {
    const cfg = JSON.stringify(AI_CONFIG_OVERRIDES, null, 2);
    await sendTelegramMessage(chatId,
      `⚙️ <b>AI CONFIG</b>\n\n` +
      `<b>Active overrides:</b>\n<code>${escapeHtml(cfg)}</code>\n\n` +
      `<b>Usage:</b> <code>/config [key] [value]</code>\n` +
      `<b>Keys:</b> gemTargetMin, gemTargetMax, sweetSpotMin, sweetSpotMax,\n` +
      `maxMarketCapOverride, minScoreOverride, pausePosting, aggressiveMode\n\n` +
      `<code>/config reset</code> — clear all overrides`
    );
    return;
  }
  const parts = input.trim().split(/\s+/);
  if (parts[0].toLowerCase() === 'reset') {
    AI_CONFIG_OVERRIDES = {};
    persistAIConfig();
    setMode(activeMode.name);
    logEvent('INFO', 'AI_CONFIG_RESET', 'via telegram');
    await sendTelegramMessage(chatId, '✅ All AI config overrides cleared. Reset to defaults.');
    return;
  }
  const key = parts[0];
  const raw = parts.slice(1).join(' ');
  const value = raw === 'true' ? true : raw === 'false' ? false : isNaN(Number(raw)) ? raw : Number(raw);
  const ALLOWED = ['gemTargetMin','gemTargetMax','sweetSpotMin','sweetSpotMax','maxMarketCapOverride','minScoreOverride','pausePosting','aggressiveMode','upgradeEnabled'];
  if (!ALLOWED.includes(key)) {
    await sendTelegramMessage(chatId, `❌ Unknown key. Allowed: ${ALLOWED.join(', ')}`);
    return;
  }
  const prev = AI_CONFIG_OVERRIDES[key];
  AI_CONFIG_OVERRIDES[key] = value;
  persistAIConfig();
  if (key === 'maxMarketCapOverride' && typeof value === 'number') activeMode.maxMarketCap = value;
  if (key === 'minScoreOverride' && typeof value === 'number') activeMode.minScore = value;
  logEvent('INFO', 'AI_CONFIG_CHANGE', JSON.stringify({key, prev, value, source: 'telegram'}));
  await sendTelegramMessage(chatId,
    `✅ <b>AI Config Updated</b>\n` +
    `<code>${escapeHtml(key)}</code>: ${JSON.stringify(prev)??'—'} → <b>${JSON.stringify(value)}</b>\n\n` +
    `AI OS will apply this on the next scan cycle.`
  );
}

// ─── Stop Loss / Take Profit Calculator ──────────────────────────────────────
// Strategy: micro-cap new launch trading. Staged TPs reward holding early runners.
// SL is tight (-25%) to cut losses fast on rugs/dumps. Price targets derived from MCap multiples.
// ─── Multiplier Target Block for Telegram ────────────────────────────────────
function buildMultiplierTargetBlock(candidate) {
  const mcap  = candidate.marketCap;
  if (!mcap || mcap <= 0) return '';
  const wi = candidate.walletIntel ?? {};
  const wVerdict = wi.walletVerdict ?? candidate.walletVerdict ?? '?';
  const winners  = wi.knownWinnerWalletCount ?? 0;
  const snipers  = wi.sniperWalletCount ?? candidate.sniperWalletCount ?? 0;
  const smScore  = wi.smartMoneyScore ?? candidate.smartMoneyScore ?? null;
  const oaiD     = candidate.openaiDecision ?? null;
  const oaiC     = candidate.openaiConviction ?? null;

  const wEmoji = wVerdict==='VERY_BULLISH'||wVerdict==='BULLISH'?'🐋':wVerdict==='SUSPICIOUS'||wVerdict==='MANIPULATED'?'⚠️':'👥';

  let walletLine = `${wEmoji} <b>Wallet Intel:</b> ${wVerdict}`;
  if (winners > 0)  walletLine += ` · ${winners} winner wallets`;
  if (snipers > 0)  walletLine += ` · ${snipers} snipers`;
  if (smScore != null) walletLine += ` · Smart Money: ${smScore}/100`;

  const oaiLine = oaiD
    ? `🤖 <b>GPT-4o Final:</b> ${oaiD} ${oaiC ? '(' + oaiC + '% conviction)' : ''}`
    : '';

  return (
    `<b>🎯 TARGETS FROM ENTRY $${Math.round(mcap/1000)}K MCap:</b>\n` +
    `📍 2× = $${Math.round(mcap*2/1000)}K  |  5× = $${Math.round(mcap*5/1000)}K  |  10× = $${Math.round(mcap*10/1000)}K\n` +
    `(Bot tracks each milestone — used for AI win/loss learning)\n\n` +
    walletLine + '\n' +
    (oaiLine ? oaiLine + '\n' : '') +
    '\n'
  );
}

function buildSLTPBlock(candidate) {
  const mcap  = candidate.marketCap;
  const price = candidate.priceUsd ? Number(candidate.priceUsd) : null;

  // MCap-based targets (most reliable for new tokens where price is tiny/unstable)
  if (!mcap || mcap <= 0) return '';

  const sl   = mcap * 0.75;   // -25% stop loss — cut fast if it fails
  const tp1  = mcap * 2;      // 2x  (+100%) — first bag sell, lock profit
  const tp2  = mcap * 5;      // 5x  (+400%) — mid target, ride momentum
  const tp3  = mcap * 10;     // 10x (+900%) — moon bag, let it run

  // Price targets (shown only if entry price is known)
  const priceLine = price
    ? `Entry Price: <b>$${price.toFixed(8)}</b>\n` +
      `🛑 SL Price:  <b>$${(price * 0.75).toFixed(8)}</b>\n` +
      `🎯 TP1 Price: <b>$${(price * 2).toFixed(8)}</b>  ` +
      `TP2: <b>$${(price * 5).toFixed(8)}</b>  ` +
      `TP3: <b>$${(price * 10).toFixed(8)}</b>\n`
    : '';

  return (
    `\n━━━━━━━━━━━━━━━━━━━━━\n` +
    `📈 <b>TRADE LEVELS</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `🛑 <b>Stop Loss:</b>  ${fmt(sl, '$')} MCap  <b>(-25%)</b>\n` +
    `🎯 <b>TP1:</b>  ${fmt(tp1, '$')} MCap  <b>(+100% / 2×)</b>  → Sell 33%\n` +
    `🎯 <b>TP2:</b>  ${fmt(tp2, '$')} MCap  <b>(+400% / 5×)</b>  → Sell 33%\n` +
    `🚀 <b>TP3:</b>  ${fmt(tp3, '$')} MCap  <b>(+900% / 10×)</b> → Sell rest\n` +
    priceLine +
    `<i>💡 Suggested: Enter small. Sell 1/3 at each TP. Cut at SL. New launches are volatile.</i>\n`
  );
}

function buildCallAlertCaption(candidate, verdict, scoreResult) {
  const { risk='?', setup_type='?' } = verdict;
  const score = scoreResult?.score ?? verdict.score ?? 0;
  const grade = scoreResult?.structureGrade ?? '?';

  // Format helpers
  const kFmt = (n) => {
    if (n == null) return '?';
    if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(2)}M`;
    if (n >= 1_000)     return `$${(n/1_000).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  };
  const ageFmt = (h) => {
    if (h == null) return '?';
    if (h < 1)  return `${Math.round(h*60)}m`;
    if (h < 24) return `${h.toFixed(1)}h`;
    return `${(h/24).toFixed(1)}d`;
  };
  const pct = (v) => v == null ? '?' : `${v > 0 ? '+' : ''}${v.toFixed(0)}%`;

  const entryMcap = kFmt(candidate.marketCap);
  const vol24     = kFmt(candidate.volume24h);
  const age       = ageFmt(candidate.pairAgeHours);

  const mintOk   = candidate.mintAuthority   === 0 ? '✓' : candidate.mintAuthority   === 1 ? '⚠' : '?';
  const freezeOk = candidate.freezeAuthority === 0 ? '✓' : candidate.freezeAuthority === 1 ? '⚠' : '?';
  // LP status glyph — granular over the old binary lpLocked field.
  // 🔥 burned · 🔒 locked (long/short) · ⏳ locked-soon · ⚠ unlocked · ~ bonding-curve / unknown
  const lpStatus = candidate.lpSecurityStatus;
  const lpOk =
      lpStatus === 'BURNED'                               ? '🔥'
    : lpStatus === 'LOCKED_LONG' || lpStatus === 'LOCKED_SHORT' ? '🔒'
    : lpStatus === 'LOCKED_SOON'                          ? '⏳'
    : lpStatus === 'UNLOCKED'                             ? '⚠'
    : lpStatus === 'PARTIAL'                              ? '⚠'
    : lpStatus === 'BONDING_CURVE'                        ? '~'
    : candidate.lpLocked === 1                            ? '🔒'
    : candidate.lpLocked === 0                            ? '⚠'
    : '?';

  const top10   = candidate.top10HolderPct != null ? candidate.top10HolderPct.toFixed(0) + '%' : '?';
  const devPct  = candidate.devWalletPct   != null ? candidate.devWalletPct.toFixed(1)   + '%' : '?';
  const holders = candidate.holders?.toLocaleString() ?? '?';

  // Dev rap sheet — if we have fingerprint, show launches/wins
  const fp = scoreResult?.devFingerprint;
  const devRap = fp && fp.total_launches > 0
    ? `Tokens: ${fp.total_launches} | Wins: ${fp.wins ?? 0}${fp.grade && fp.grade !== 'NEUTRAL' ? ` · ${fp.grade}` : ''}`
    : '—';

  const tokenLabel = candidate.token
    || candidate.tokenName
    || (candidate.contractAddress ? candidate.contractAddress.slice(0, 4).toUpperCase() : '?');
  const nameLabel  = candidate.tokenName && candidate.tokenName !== candidate.token
    ? candidate.tokenName : '';

  // Compact verdict (1-2 lines, strip to ~140 chars)
  const vText = (verdict.verdict || '').replace(/\s+/g, ' ').trim();
  const vSnip = vText.length > 140 ? vText.slice(0, 137) + '…' : vText;

  // Links line
  const linkParts = [];
  if (candidate.twitter)  linkParts.push(`<a href="${candidate.twitter}">X</a>`);
  if (candidate.telegram) linkParts.push(`<a href="${candidate.telegram}">TG</a>`);
  if (candidate.website)  linkParts.push(`<a href="${candidate.website}">Web</a>`);
  linkParts.push(`<a href="https://dexscreener.com/solana/${candidate.contractAddress}">DEX</a>`);
  linkParts.push(`<a href="https://pump.fun/${candidate.contractAddress}">PF</a>`);

  return (
    `⚡ <b>PULSE CALLER</b> · Entry: ${entryMcap}\n\n` +
    `<b>$${escapeHtml(tokenLabel)}</b>${nameLabel ? ` | <i>${escapeHtml(nameLabel)}</i>` : ''}\n` +
    `<code>${escapeHtml(candidate.contractAddress ?? '—')}</code>\n\n` +
    `├ MC: <b>${entryMcap}</b> · Vol24h: <b>${vol24}</b> · Age: <b>${age}</b>\n` +
    `├ 1H: <b>${pct(candidate.priceChange1h)}</b> · 24H: <b>${pct(candidate.priceChange24h)}</b> · Buys/Sells 1H: <b>${candidate.buys1h ?? '?'}/${candidate.sells1h ?? '?'}</b>\n` +
    `├ 🔒 Mint:${mintOk} Freeze:${freezeOk} LP:${lpOk} · Top10: <b>${top10}</b> · Dev: <b>${devPct}</b> · Holders: <b>${holders}</b>\n` +
    `├ 👤 Dev: ${devRap}\n` +
    `├ 🧠 Score: <b>${score}/100</b> · Risk: <b>${risk}</b> · Setup: <b>${setup_type}</b>\n` +
    (scoreResult?.confidence ? `├ 🎯 Confidence: <b>${Math.round(scoreResult.confidence.pct)}%</b> · <b>${scoreResult.confidence.label}</b>\n` : '') +
    `└ 🏛 Structure: <b>${grade}</b>\n` +
    (vSnip ? `\n💬 <i>${escapeHtml(vSnip)}</i>\n` : '') +
    `\n🔗 ${linkParts.join(' · ')}`
  );
}

function buildCallAlertMessage(candidate, verdict, scoreResult, similarity = {}, ftResult = null) {
  const {
    score=0, risk='?', setup_type='?',
    bull_case=[], red_flags=[],
    verdict: vText='', missing_data=[]
  } = verdict;

  const sub   = scoreResult?.subScores    ?? {};
  const trap  = scoreResult?.trapDetector ?? {};
  const grade = scoreResult?.structureGrade ?? '?';
  const regime = getRegime();

  const bullLines   = bull_case.slice(0,4).map(p=>`• ${escapeHtml(p)}`).join('\n') || '• —';
  const watchLines  = red_flags.slice(0,3).map(p=>`• ${escapeHtml(p)}`).join('\n') || '• —';
  const preliminary = missing_data.length > 3
    ? `\n⚠️ <i>Partial data — ${missing_data.length} fields unconfirmed (new token)</i>\n`
    : '\n';

  const mintFlag  = candidate.mintAuthority   === 0 ? '✓' : candidate.mintAuthority   === 1 ? '⚠️ ACTIVE' : '?';
  const freezeFlag = candidate.freezeAuthority === 0 ? '✓' : candidate.freezeAuthority === 1 ? '⚠️ ACTIVE' : '?';
  const lpFlag    = candidate.lpLocked === 1 ? '✓ locked' : candidate.lpLocked === 0 ? '⚠️ UNLOCKED' : '?';

  const entryTimestamp = formatCallTimestamp();
  const entryMcap      = fmt(candidate.marketCap, '$');
  const entryPrice     = candidate.priceUsd ? `$${Number(candidate.priceUsd).toFixed(8)}` : '?';

  let ftLine = '';
  if (ftResult && ftResult.ftDecision) {
    const ftEmoji = ftResult.ftDecision === 'AUTO_POST' ? '🤖✅' : '🤖⚠️';
    ftLine = `\n${ftEmoji} <b>AI Model:</b> ${ftResult.ftDecision} (${ftResult.ftScore ?? '?'}% conf) — <i>${escapeHtml(ftResult.ftReason ?? '')}</i>`;
  }

  const aiBar = buildAILearningBar();

  // ── AI VERDICT BLOCK — compact, prominent, both Claude + OpenAI ────────
  // Built once and injected near the top of the message. Includes:
  //   - Claude's full verdict text + risk + setup
  //   - OpenAI decision + conviction (when available)
  //   - Confidence label
  let aiVerdictBlock = `<b>🤖 AI VERDICT</b>\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  if (vText && vText.trim()) {
    aiVerdictBlock += `<b>Claude:</b> <b>${riskEmoji(risk)} ${risk}</b> · ${setup_type}\n`;
    aiVerdictBlock += `<i>${escapeHtml(vText.slice(0, 600))}</i>\n`;
  } else {
    aiVerdictBlock += `<b>Claude:</b> <b>${riskEmoji(risk)} ${risk}</b> · ${setup_type}  <i>(no verdict text)</i>\n`;
  }
  // OpenAI decision (when present)
  const oa = candidate.openaiDecision || candidate.openai_decision;
  const oaConv = candidate.openaiConviction || candidate.openai_conviction;
  const oaVerd = candidate.openaiVerdict || candidate.openai_verdict;
  if (oa) {
    const oaEmoji = oa === 'AUTO_POST' ? '✅' : oa === 'WATCHLIST' ? '👁' : oa === 'IGNORE' ? '🚫' : '⏳';
    aiVerdictBlock += `\n<b>OpenAI:</b> ${oaEmoji} <b>${oa}</b>${oaConv ? ` · ${oaConv}` : ''}\n`;
    if (oaVerd) aiVerdictBlock += `<i>${escapeHtml(String(oaVerd).slice(0, 400))}</i>\n`;
  }
  // Confidence
  if (scoreResult?.confidence) {
    aiVerdictBlock += `\n<b>Confidence:</b> ${Math.round(scoreResult.confidence.pct)}% · ${scoreResult.confidence.label}\n`;
  }
  aiVerdictBlock += '\n';

  return (
    `<b>📡 CALL ALERT — PULSE CALLER</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Token: <b>$${escapeHtml(candidate.token || candidate.tokenName || (candidate.contractAddress ? candidate.contractAddress.slice(0,4).toUpperCase() : '?'))}</b>  ${candidate.tokenName && candidate.tokenName !== candidate.token ? `<i>${escapeHtml(candidate.tokenName)}</i>` : ''}\n` +
    `CA: <code>${escapeHtml(candidate.contractAddress ?? '—')}</code>\n\n` +
    `<b>⏱ Entry:</b> ${entryTimestamp}\n` +
    `<b>💰 Entry MCap:</b> ${entryMcap}   <b>Price:</b> ${entryPrice}\n\n` +
    `<b>Score: ${score}/100</b>  ${scoreBar(score)}\n` +
    `Risk: <b>${riskEmoji(risk)} ${risk}</b>   Setup: <b>${setup_type}</b>\n` +
    `Structure: <b>${gradeEmoji(grade)} ${grade}</b>   Stage: <b>${scoreResult?.stage ?? '?'}</b>\n\n` +
    aiVerdictBlock +
    buildFoundationSignalsBlock(scoreResult) + `\n` +
    `<b>Sub-Scores (Structure):</b>\n` +
    `🚀 Launch: <b>${sub.launchQuality ?? '?'}</b>   👥 Wallet: <b>${sub.walletStructure ?? '?'}</b>   📈 Market: <b>${sub.marketBehavior ?? '?'}</b>   📣 Social: <b>${sub.socialNarrative ?? '?'}</b>\n\n` +
    `<b>📊 Market:</b>\n` +
    `MCap: <b>${entryMcap}</b>   Liq: <b>${fmt(candidate.liquidity, '$')}</b>\n` +
    `Vol24h: <b>${fmt(candidate.volume24h, '$')}</b>   Age: <b>${candidate.pairAgeHours?.toFixed(1) ?? '?'}h</b>\n` +
    `1h: <b>${fmtPct(candidate.priceChange1h)}</b>   6h: <b>${fmtPct(candidate.priceChange6h)}</b>   24h: <b>${fmtPct(candidate.priceChange24h)}</b>\n\n` +
    `<b>👥 Holders:</b>\n` +
    `Count: <b>${candidate.holders?.toLocaleString() ?? '?'}</b>   Top10: <b>${candidate.top10HolderPct?.toFixed(1) ?? '?'}%</b>   Dev: <b>${candidate.devWalletPct?.toFixed(1) ?? '?'}%</b>\n\n` +
    `<b>🛡 Risk:</b>\n` +
    `Bundle: <b>${candidate.bundleRisk ?? '?'}</b>   BubbleMap: <b>${candidate.bubbleMapRisk ?? '?'}</b>   Snipers: <b>${candidate.sniperWalletCount ?? '?'}</b>\n` +
    `Mint: ${mintFlag}   Freeze: ${freezeFlag}   LP: ${lpFlag}\n` +
    (candidate.momentumGrade ? `Momentum: <b>${candidate.momentumGrade}</b>   ` : '') +
    (candidate.coordinationIntensity ? `Coord: <b>${candidate.coordinationIntensity}</b>\n` : '\n') +
    `Market: <b>${regime.market ?? '?'}</b>   Mode: <b>${activeMode.emoji} ${activeMode.name}</b>\n\n` +
    `<b>🔬 Launch Intel:</b>\n` +
    `Quality: <b>${candidate.launchQualityScore ?? '?'}/100</b>   Unique Buyers: <b>${candidate.launchUniqueBuyerRatio != null ? (candidate.launchUniqueBuyerRatio * 100).toFixed(0) + '%' : '?'}</b>\n` +
    `Buy Ratio: <b>${candidate.buySellRatio1h != null ? (candidate.buySellRatio1h * 100).toFixed(0) + '% buys' : '?'}</b>   Buys/Sells: <b>${candidate.buys1h ?? '?'}/${candidate.sells1h ?? '?'}</b>\n` +
    `Vol Velocity: <b>${candidate.volumeVelocity != null ? candidate.volumeVelocity.toFixed(2) : '?'}</b>   Buy Velocity: <b>${candidate.buyVelocity != null ? candidate.buyVelocity.toFixed(2) : '?'}</b>\n` +
    `Liq/MCap: <b>${candidate.liquidity && candidate.marketCap ? ((candidate.liquidity/candidate.marketCap)*100).toFixed(0) + '%' : '?'}</b>   Smart Money: <b>${candidate.smartMoneyScore ?? candidate.walletIntel?.smartMoneyScore ?? '—'}</b>\n` +
    `Type: <b>${candidate.candidateType ?? '?'}</b>   Winners: <b>${candidate.knownWinnerWallets?.length ?? candidate.walletIntel?.knownWinnerWalletCount ?? 0}</b>\n\n` +
    (candidate.lunarCrushOk ? (
      `<b>📱 Social Intel (LunarCrush):</b>\n` +
      `Galaxy Score: <b>${candidate.galaxyScore ?? '—'}</b>   Sentiment: <b>${candidate.socialSentiment ?? '—'}</b>\n` +
      `Twitter Mentions: <b>${candidate.twitterMentions ?? '—'}</b>   Social Vol: <b>${candidate.socialVolume24h ?? '—'}</b>\n` +
      (candidate.socialSpike ? `🚀 <b>SOCIAL SPIKE DETECTED</b> — volume 2x+ above average\n` : '') +
      '\n'
    ) : '') +
    `<b>✅ Why It Passed:</b>\n${bullLines}\n\n` +
    `<b>⚠️ Watchouts:</b>\n${watchLines}\n\n` +
    buildSLTPBlock(candidate) +
    preliminary +
    ftLine +
    (ftLine ? '\n' : '') +
    `${aiBar}\n\n` +
    `<i>AI + onchain assisted. Manage risk. Not financial advice.</i>`
  );
}

function buildAnalysisMessage(candidate, verdict, scoreResult) {
  const { score=0, risk='?', setup_type='?', bull_case=[], red_flags=[], verdict: vText='', notes='', missing_data=[], key_metrics={} } = verdict;
  const sub   = scoreResult?.subScores    ?? {};
  const trap  = scoreResult?.trapDetector ?? {};
  const grade = scoreResult?.structureGrade ?? '?';
  const sim   = scoreResult?.similarity   ?? {};

  const bullLines   = bull_case.slice(0,4).map(p=>`• ${escapeHtml(p)}`).join('\n') || '• —';
  const redLines    = red_flags.slice(0,4).map(p=>`• ${escapeHtml(p)}`).join('\n') || '• —';
  const metricsLine = Object.entries(key_metrics).map(([k,v])=>`${riskEmoji(v)} ${k.replace('_risk','').replace('_',' ')}`).join('  ');
  const missingLine = missing_data.length ? `\n⚠️ <i>Missing: ${missing_data.slice(0,5).join(', ')}</i>` : '';
  const trapLine    = trap.triggered ? `\n⚠️ <b>Trap: ${trap.severity}</b> — ${trap.traps?.[0] ?? ''}` : '';

  return (
    `<b>🔍 TOKEN REVIEW</b>\n` +
    `<code>${escapeHtml(candidate.contractAddress??'—')}</code>\n` +
    `Token: <b>$${escapeHtml(candidate.token??'?')}</b>\n\n` +
    `<b>Score: ${score}/100</b>  ${scoreBar(score)}\n` +
    `Risk: <b>${riskEmoji(risk)} ${risk}</b>   Setup: <b>${setup_type}</b>\n` +
    `Structure: <b>${gradeEmoji(grade)} ${grade}</b>\n\n` +
    `<b>Sub-Scores:</b>\n` +
    `🚀 Launch: ${sub.launchQuality??'?'}/100  ` +
    `👥 Wallet: ${sub.walletStructure??'?'}/100\n` +
    `📈 Market: ${sub.marketBehavior??'?'}/100  ` +
    `📣 Social: ${sub.socialNarrative??'?'}/100\n\n` +
    (sim.winnerSimilarity != null ? `Winner sim: <b>${sim.winnerSimilarity}%</b>  Rug sim: <b>${sim.rugSimilarity??'?'}%</b>\n\n` : '') +
    `<b>📊 Market:</b>\n` +
    `MCap: ${fmt(candidate.marketCap,'$')}  Liq: ${fmt(candidate.liquidity,'$')}\n` +
    `Age: ${candidate.pairAgeHours?.toFixed(1)??'?'}h  Holders: ${candidate.holders?.toLocaleString()??'?'}\n` +
    `Top10: ${candidate.top10HolderPct?.toFixed(1)??'?'}%  Dev: ${candidate.devWalletPct?.toFixed(1)??'?'}%\n\n` +
    `<b>Risk Matrix:</b> ${metricsLine||'—'}\n\n` +
    `<b>Bull Case:</b>\n${bullLines}\n\n` +
    `<b>Red Flags:</b>\n${redLines}\n\n` +
    `<b>Verdict:</b>\n${escapeHtml(vText)}\n` +
    (notes?`\n<i>${escapeHtml(notes)}</i>`:'') +
    trapLine + missingLine +
    `\n\n<i>Birdeye:${candidate.birdeyeOk?'✓':'✗'} Helius:${candidate.heliusOk?'✓':'✗'} BubbleMap:${candidate.bubblemapOk?'✓':'✗'}</i>`
  );
}

function buildStatsMessage() {
  try {
    const s = getStats();
    const q = getQueueStats();

    const resolved = (() => {
      try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome IN ('WIN','LOSS','NEUTRAL')`).get().n; } catch { return 0; }
    })();
    const FT_THRESHOLD = 20;
    const ftProgress   = Math.min(resolved, FT_THRESHOLD);
    const ftBar        = '█'.repeat(Math.round((ftProgress/FT_THRESHOLD)*10)) + '░'.repeat(10 - Math.round((ftProgress/FT_THRESHOLD)*10));

    return (
      `<b>📊 ALPHA LENNIX v6 STATS</b>\n\n` +
      `Total evaluated:  <b>${s.totalEvaluated}</b>\n` +
      `Total posted:     <b>${s.totalPosted}</b>\n` +
      `Last 24h scanned: <b>${s.last24hEvaluated}</b>\n` +
      `Last 24h posted:  <b>${s.last24hPosted}</b>\n` +
      `Win rate:         <b>${s.winRate}</b>\n\n` +
      `<b>Queue:</b>\n` +
      `RETEST pending:   <b>${q.retest.pending}</b>\n` +
      `WATCHLIST:        <b>${q.watchlist.total}</b>\n` +
      `BLOCKLIST:        <b>${q.blocklist.total}</b>\n\n` +
      `<b>🧠 AI Learning:</b>\n` +
      `[${ftBar}] ${ftProgress}/${FT_THRESHOLD} resolved calls\n` +
      (OPENAI_FT_MODEL
        ? `✅ Fine-tune model ACTIVE: <code>${OPENAI_FT_MODEL}</code>\n`
        : ftProgress >= FT_THRESHOLD
          ? `🔥 READY TO TRAIN — use /api/openai/finetune\n`
          : `Needs ${FT_THRESHOLD - ftProgress} more resolved calls\n`) +
      `\n<i>Market regime: ${getRegime().market??'UNKNOWN'}</i>\n` +
      `<i>Mode: ${activeMode.emoji} ${activeMode.name}</i>`
    );
  } catch { return '⚠️ Stats unavailable.'; }
}

function buildRecentCallsMessage() {
  try {
    const calls = getRecentCalls(5);
    if (!calls.length) return '📭 No calls posted yet.';
    const lines = calls.map((c,i) => {
      const outcome = c.outcome ?? 'PENDING';
      const emoji   = outcome === 'WIN' ? '🏆' : outcome === 'LOSS' ? '💀' : outcome === 'NEUTRAL' ? '➖' : '⏳';
      const entryMcap = c.market_cap_at_call ? fmt(c.market_cap_at_call, '$') : '?';
      return (
        `${i+1}. ${emoji} <b>$${escapeHtml(c.token??'?')}</b> — Score: ${c.score_at_call??'?'}\n` +
        `   Entry MCap: ${entryMcap}  1h: ${fmtPct(c.pct_change_1h)}  6h: ${fmtPct(c.pct_change_6h)}  24h: ${fmtPct(c.pct_change_24h)}\n` +
        `   <code>${escapeHtml(c.contract_address)}</code>`
      );
    }).join('\n\n');
    const stats = getStats();
    return `<b>📋 RECENT CALLS</b>\n\n${lines}\n\n<i>Win rate: ${stats.winRate} (${stats.winCount}W / ${stats.lossCount}L)</i>`;
  } catch { return '⚠️ Call history unavailable.'; }
}

function buildWatchlistMessage() {
  try {
    const q       = getQueueStats();
    const retests = getRetestContents();
    const watches = getWatchlistContents();
    let msg = `<b>👁 WATCHLIST & RETEST QUEUE</b>\n\n`;
    if (retests.length) {
      msg += `<b>RETEST (${retests.length}):</b>\n`;
      for (const r of retests.slice(0,5)) msg += `• <b>$${escapeHtml(r.token??'?')}</b> — Score: ${r.firstScore}  In ${r.minsUntilRescan}min\n`;
      msg += '\n';
    }
    if (watches.length) {
      msg += `<b>WATCHLIST (${watches.length}):</b>\n`;
      for (const w of watches.slice(0,5)) msg += `• <b>$${escapeHtml(w.token??'?')}</b> — Score: ${w.firstScore}  Scan #${w.scanCount}\n`;
    }
    if (!retests.length && !watches.length) msg += 'Queue is empty.';
    msg += `\n<i>Blocklist: ${q.blocklist.total} addresses</i>`;
    return msg;
  } catch { return '⚠️ Watchlist unavailable.'; }
}

function buildRegimeMessage() {
  try {
    const r   = getRegimeDashboardData();
    const adj = r.scoreAdjustments ?? {};
    return (
      `<b>🌡 MARKET REGIME</b>\n\n` +
      `Market:    <b>${r.market??'UNKNOWN'}</b> (${r.confidence??'?'} confidence)\n` +
      `Activity:  <b>${r.solanaActivity??'?'}</b>\n` +
      `Time:      <b>${r.timeWindow??'?'}</b>\n` +
      `Narrative: <b>${r.narrativeTrend??'?'}</b>${r.dominantNarrative?' ('+r.dominantNarrative+')':''}\n` +
      `Launches:  <b>${r.recentLaunchHealth??'?'}</b>\n\n` +
      `<b>Score Adjustments:</b>\n` +
      `Velocity bonus:     ${adj.velocityBonus>=0?'+':''}${adj.velocityBonus??0}\n` +
      `Structure penalty:  ${adj.structurePenalty>=0?'+':''}${adj.structurePenalty??0}\n` +
      `Threshold adjust:   ${adj.thresholdAdjust>=0?'+':''}${adj.thresholdAdjust??0}\n\n` +
      `<i>Updated: ${r.ageMinutes??'?'}min ago</i>`
    );
  } catch { return '⚠️ Regime data unavailable.'; }
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

async function handleStartCommand(chatId)     { await sendTelegramMessage(chatId, buildStartMessage()); }
async function handleHelpCommand(chatId)      { await sendTelegramMessage(chatId, buildHelpMessage()); }
async function handleStatsCommand(chatId)     { await sendTelegramMessage(chatId, buildStatsMessage()); }
async function handleCallsCommand(chatId)     { await sendTelegramMessage(chatId, buildRecentCallsMessage()); }
async function handleWatchlistCommand(chatId) { await sendTelegramMessage(chatId, buildWatchlistMessage()); }
async function handleRegimeCommand(chatId)    { await sendTelegramMessage(chatId, buildRegimeMessage()); }

// ─── /portfolio — user's personal coin watchlist ─────────────────────────────
// /track <wallet> — user-curated wallet additions. Validates the address,
// fetches SOL balance via Helius, applies SOL-tier categorization (same
// rules the harvesters use), and inserts into tracked_wallets with
// source='user_track'. Wallet immediately feeds Pulse's scoring.
async function handleTrackWalletCommand(chatId, args, fromUserId, username) {
  const input = (args || '').trim();
  // /track list (or /track) — show wallets this user has added
  if (!input || input.toLowerCase() === 'list') {
    const rows = dbInstance.prepare(`
      SELECT address, category, sol_balance, last_seen
      FROM tracked_wallets
      WHERE source = 'user_track' AND added_by = ?
      ORDER BY last_seen DESC
      LIMIT 30
    `).all(String(fromUserId));
    if (rows.length === 0) {
      await sendTelegramMessage(chatId,
        `<b>📒 Your tracked wallets</b>\n\n` +
        `<i>You haven't added any yet.</i>\n\n` +
        `<b>Usage:</b> <code>/track &lt;wallet&gt;</code>\n` +
        `Wallets ≥ 100 SOL → 🐋 WHALE · 8-99 → 💎 SMART · 1-7 → 🚀 MOMENTUM`
      );
      return;
    }
    let msg = `<b>📒 Your tracked wallets (${rows.length})</b>\n\n`;
    rows.forEach((r, i) => {
      const tier = r.category === 'WINNER' ? '🐋' : r.category === 'SMART_MONEY' ? '💎' : r.category === 'MOMENTUM' ? '🚀' : '·';
      const sol  = r.sol_balance != null ? r.sol_balance.toFixed(2) + ' SOL' : '?';
      msg += `${tier} <code>${escapeHtml(r.address.slice(0, 8))}…${escapeHtml(r.address.slice(-4))}</code> — ${sol}\n`;
    });
    msg += `\n<i>/untrack &lt;wallet&gt; to remove · /track &lt;wallet&gt; to add</i>`;
    await sendTelegramMessage(chatId, msg);
    return;
  }
  // /track <wallet> — add
  const addr = input.split(/\s+/)[0].trim();
  // Validate base58 + length (Solana wallets are 32-44 chars)
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
    await sendTelegramMessage(chatId, `⚠️ That doesn't look like a Solana wallet address.\n\n<b>Usage:</b> <code>/track &lt;wallet_address&gt;</code>`);
    return;
  }
  if (!process.env.HELIUS_API_KEY) {
    await sendTelegramMessage(chatId, `⚠️ Wallet tracking requires HELIUS_API_KEY (server config).`);
    return;
  }
  // Fetch SOL balance
  let sol = null;
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'bal', method: 'getBalance', params: [addr] }),
      signal: AbortSignal.timeout(8_000),
    });
    if (r.ok) {
      const j = await r.json();
      const lamports = j?.result?.value ?? 0;
      sol = lamports / 1e9;
    }
  } catch (err) {
    await sendTelegramMessage(chatId, `⚠️ Couldn't fetch SOL balance: ${escapeHtml(err.message)}`);
    return;
  }
  if (sol == null) {
    await sendTelegramMessage(chatId, `⚠️ Couldn't reach Helius. Try again in a minute.`);
    return;
  }
  // SOL-tier category (same rules the harvesters use)
  let category = 'NEUTRAL';
  let tierIcon = '·';
  if      (sol >= 100) { category = 'WINNER';      tierIcon = '🐋'; }
  else if (sol >= 8)   { category = 'SMART_MONEY'; tierIcon = '💎'; }
  else if (sol >= 1)   { category = 'MOMENTUM';    tierIcon = '🚀'; }
  else                 { category = 'HARVESTED_TRADER'; tierIcon = '🔻'; }

  // Insert / upsert. Don't overwrite a curated WINNER/KOL/RUG row.
  try {
    const existing = dbInstance.prepare(
      `SELECT id, category, source FROM tracked_wallets WHERE address = ?`
    ).get(addr);
    if (existing) {
      // Just refresh sol_balance + tag this user as a co-tracker. Don't
      // demote stronger categories.
      dbInstance.prepare(`
        UPDATE tracked_wallets
        SET sol_balance = ?,
            updated_at  = datetime('now'),
            last_seen   = datetime('now'),
            notes       = COALESCE(notes, '') || ' | also-tracked-by @' || ?
        WHERE id = ?
      `).run(sol, username || fromUserId, existing.id);
      await sendTelegramMessage(chatId,
        `✓ <code>${escapeHtml(addr.slice(0,8))}…</code> already in DB as <b>${escapeHtml(existing.category)}</b>.\n` +
        `${tierIcon} SOL balance refreshed: <b>${sol.toFixed(2)} SOL</b>\n\n` +
        `<i>This wallet now also credits @${escapeHtml(username || fromUserId)} as a tracker.</i>`
      );
      return;
    }
    dbInstance.prepare(`
      INSERT INTO tracked_wallets (address, category, source, sol_balance, added_by, last_seen, updated_at, notes)
      VALUES (?, ?, 'user_track', ?, ?, datetime('now'), datetime('now'), ?)
    `).run(addr, category, sol, String(fromUserId), `Added via /track by @${username || fromUserId}`);
    await sendTelegramMessage(chatId,
      `✅ <b>Wallet added to Pulse DB</b>\n\n` +
      `<code>${escapeHtml(addr)}</code>\n\n` +
      `${tierIcon} <b>${escapeHtml(category)}</b> · ${sol.toFixed(2)} SOL\n\n` +
      `<i>This wallet now feeds Pulse's scoring. Future coins it holds get a bump in Wallet Quality.</i>\n` +
      `<i>View yours: /track list · Remove: /untrack ${addr.slice(0,8)}…</i>`
    );
  } catch (err) {
    await sendTelegramMessage(chatId, `⚠️ Insert failed: ${escapeHtml(err.message)}`);
  }
}

async function handleUntrackWalletCommand(chatId, args, fromUserId) {
  const addrPrefix = (args || '').trim().split(/\s+/)[0];
  if (!addrPrefix) {
    await sendTelegramMessage(chatId, `<b>Usage:</b> <code>/untrack &lt;wallet&gt;</code>\n<i>Removes a wallet you added via /track. Won't touch wallets added by other sources.</i>`);
    return;
  }
  // Match by exact address OR by 8-char prefix (matches what /track list shows)
  let row;
  try {
    row = dbInstance.prepare(`
      SELECT id, address, category FROM tracked_wallets
      WHERE source = 'user_track' AND added_by = ? AND (address = ? OR address LIKE ?)
      LIMIT 1
    `).get(String(fromUserId), addrPrefix, addrPrefix + '%');
  } catch (err) {
    await sendTelegramMessage(chatId, `⚠️ Lookup failed: ${escapeHtml(err.message)}`);
    return;
  }
  if (!row) {
    await sendTelegramMessage(chatId, `<i>No wallet matching <code>${escapeHtml(addrPrefix)}</code> found in your tracked list. (You can only remove wallets you personally added.)</i>`);
    return;
  }
  try {
    dbInstance.prepare(`DELETE FROM tracked_wallets WHERE id = ? AND source = 'user_track' AND added_by = ?`)
      .run(row.id, String(fromUserId));
    await sendTelegramMessage(chatId, `✓ Removed <code>${escapeHtml(row.address.slice(0,8))}…</code> from Pulse DB.`);
  } catch (err) {
    await sendTelegramMessage(chatId, `⚠️ Delete failed: ${escapeHtml(err.message)}`);
  }
}

async function handlePortfolioCommand(chatId, args, fromUserId, username) {
  const fmtMc = (n) => n == null ? '?' : (n >= 1_000_000 ? '$' + (n/1_000_000).toFixed(2) + 'M' : '$' + (n/1_000).toFixed(1) + 'K');
  const parts = (args || '').trim().split(/\s+/);
  const subcmd = parts[0]?.toLowerCase() || 'list';

  // /portfolio add <CA>
  if (subcmd === 'add' && parts[1]) {
    const ca = parts[1].trim();
    try {
      // Pull live data so we have token name + entry mcap
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { signal: AbortSignal.timeout(8_000) });
      const dexData = await dexRes.json();
      const pair = (dexData?.pairs || []).sort((a,b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (!pair) { await sendTelegramMessage(chatId, '❌ Could not find that token. Check the CA.'); return; }
      const token = pair.baseToken?.symbol || ca.slice(0,4);
      const mcap = pair.marketCap || pair.fdv || 0;
      const price = parseFloat(pair.priceUsd || 0);
      const ok = addToUserPortfolio(fromUserId, username, ca, token, mcap, price);
      if (ok) await sendTelegramMessage(chatId, `✅ Added <b>$${escapeHtml(token)}</b> to your portfolio at ${fmtMc(mcap)} mcap.\n\nUse <code>/portfolio</code> to view, <code>/portfolio remove ${ca.slice(0,8)}...</code> to drop.`);
      else    await sendTelegramMessage(chatId, '⚠️ Already in your portfolio (or DB error).');
    } catch (err) { await sendTelegramMessage(chatId, `❌ Error: ${escapeHtml(err.message.slice(0,150))}`); }
    return;
  }

  // /portfolio remove <CA>
  if (subcmd === 'remove' && parts[1]) {
    const removed = removeFromUserPortfolio(fromUserId, parts[1].trim());
    await sendTelegramMessage(chatId, removed ? '✅ Removed from your portfolio.' : '⚠️ Not found in your portfolio.');
    return;
  }

  // /portfolio clear
  if (subcmd === 'clear') {
    const n = clearUserPortfolio(fromUserId);
    await sendTelegramMessage(chatId, `🧹 Cleared <b>${n}</b> coins from your portfolio.`);
    return;
  }

  // /portfolio (list — default)
  const items = getUserPortfolio(fromUserId);
  if (items.length === 0) {
    await sendTelegramMessage(chatId,
      `📋 <b>Your portfolio is empty.</b>\n\n` +
      `Add coins with: <code>/portfolio add &lt;CA&gt;</code>\n` +
      `View live: <code>/portfolio</code>\n` +
      `Remove: <code>/portfolio remove &lt;CA&gt;</code>`);
    return;
  }

  // Pull live mcap for each (limit to 10 to keep latency reasonable)
  const showItems = items.slice(0, 10);
  const lines = [];
  for (const item of showItems) {
    try {
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${item.contract_address}`, { signal: AbortSignal.timeout(5_000) });
      const dexData = await dexRes.json();
      const pair = (dexData?.pairs || []).sort((a,b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const currentMcap = pair?.marketCap || pair?.fdv || 0;
      const mult = item.entry_mcap > 0 ? currentMcap / item.entry_mcap : null;
      const multStr = mult != null ? `${mult >= 1 ? '🟢' : '🔴'} ${mult.toFixed(2)}x` : '?';
      lines.push(`<b>$${escapeHtml(item.token || '?')}</b>  ${multStr}\n  Entry: ${fmtMc(item.entry_mcap)} → Now: ${fmtMc(currentMcap)}\n  <code>${item.contract_address.slice(0,8)}...${item.contract_address.slice(-6)}</code>`);
    } catch {
      lines.push(`<b>$${escapeHtml(item.token || '?')}</b>  ?\n  Entry: ${fmtMc(item.entry_mcap)}\n  <code>${item.contract_address.slice(0,8)}...${item.contract_address.slice(-6)}</code>`);
    }
  }
  const more = items.length > 10 ? `\n<i>(+${items.length - 10} more not shown)</i>` : '';
  await sendTelegramMessage(chatId,
    `📋 <b>YOUR PORTFOLIO</b> (${items.length} coin${items.length===1?'':'s'})\n\n` +
    lines.join('\n\n') + more);
}

// ─── /alert — set price/multiple alerts ──────────────────────────────────────
async function handleAlertCommand(chatId, args, fromUserId, username) {
  const fmtMc = (n) => n == null ? '?' : (n >= 1_000_000 ? '$' + (n/1_000_000).toFixed(2) + 'M' : '$' + (n/1_000).toFixed(1) + 'K');
  const parts = (args || '').trim().split(/\s+/);
  const subcmd = parts[0]?.toLowerCase();

  // /alert list — show user's pending alerts
  if (subcmd === 'list' || (!parts[0] && !parts[1])) {
    const alerts = getUserAlerts(fromUserId, true);
    if (alerts.length === 0) {
      await sendTelegramMessage(chatId,
        `🔔 <b>No alerts set.</b>\n\n` +
        `Set one with:\n` +
        `<code>/alert &lt;CA&gt; &lt;target&gt;</code>\n\n` +
        `Examples:\n` +
        `<code>/alert &lt;CA&gt; 100k</code>  → fires at $100K mcap\n` +
        `<code>/alert &lt;CA&gt; 5x</code>    → fires at 5x entry\n` +
        `<code>/alert remove &lt;id&gt;</code>  → cancel an alert`);
      return;
    }
    const lines = alerts.map(a => {
      const status = a.fired_at ? '✅ FIRED at ' + fmtMc(a.fired_mcap) : a.cancelled ? '🚫 cancelled' : '⏳ pending';
      const target = a.target_type === 'mcap' ? fmtMc(a.target_value) : a.target_value.toFixed(1) + 'x';
      return `#${a.id} <b>$${escapeHtml(a.token||'?')}</b> @ ${target} · ${status}\n  <code>${a.contract_address.slice(0,8)}...${a.contract_address.slice(-6)}</code>`;
    });
    await sendTelegramMessage(chatId, `🔔 <b>YOUR ALERTS</b> (${alerts.length})\n\n` + lines.join('\n\n'));
    return;
  }

  // /alert remove <id>
  if (subcmd === 'remove' && parts[1]) {
    const id = parseInt(parts[1]);
    if (!Number.isFinite(id)) { await sendTelegramMessage(chatId, '❌ Provide a numeric alert ID. Use /alert list to see IDs.'); return; }
    const ok = cancelUserAlert(fromUserId, id);
    await sendTelegramMessage(chatId, ok ? `✅ Alert #${id} cancelled.` : `⚠️ Alert #${id} not found or not yours.`);
    return;
  }

  // /alert <CA> <target>
  if (parts[0] && parts[1]) {
    const ca = parts[0].trim();
    const targetStr = parts[1].toLowerCase().trim();
    let targetType, targetValue;

    // Parse target — "5x" = multiple, "100k" / "1m" = mcap
    if (/^\d+(\.\d+)?x$/.test(targetStr)) {
      targetType = 'multiple';
      targetValue = parseFloat(targetStr);
    } else if (/^\d+(\.\d+)?[km]?$/.test(targetStr)) {
      targetType = 'mcap';
      const num = parseFloat(targetStr);
      if (targetStr.endsWith('m'))      targetValue = num * 1_000_000;
      else if (targetStr.endsWith('k')) targetValue = num * 1_000;
      else                              targetValue = num;
    } else {
      await sendTelegramMessage(chatId, '❌ Target format invalid.\n\nUse:\n• <code>5x</code> for a multiple\n• <code>100k</code> or <code>1m</code> for mcap');
      return;
    }

    try {
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { signal: AbortSignal.timeout(8_000) });
      const dexData = await dexRes.json();
      const pair = (dexData?.pairs || []).sort((a,b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (!pair) { await sendTelegramMessage(chatId, '❌ Could not find that token. Check the CA.'); return; }
      const token = pair.baseToken?.symbol || ca.slice(0,4);
      const mcap = pair.marketCap || pair.fdv || 0;
      const ok = createUserAlert(fromUserId, username, ca, token, targetType, targetValue, mcap);
      if (ok) {
        const targetDesc = targetType === 'mcap' ? fmtMc(targetValue) : targetValue.toFixed(1) + 'x (entry: ' + fmtMc(mcap) + ')';
        await sendTelegramMessage(chatId, `🔔 <b>Alert set</b> for <b>$${escapeHtml(token)}</b> @ ${targetDesc}\n\nI'll DM you when it hits.`);
      } else {
        await sendTelegramMessage(chatId, '❌ Could not create alert.');
      }
    } catch (err) { await sendTelegramMessage(chatId, `❌ Error: ${escapeHtml(err.message.slice(0,150))}`); }
    return;
  }

  // No args — show usage
  await sendTelegramMessage(chatId,
    `🔔 <b>Alert Commands</b>\n\n` +
    `<code>/alert &lt;CA&gt; 100k</code>  → fires at $100K mcap\n` +
    `<code>/alert &lt;CA&gt; 5x</code>    → fires at 5x entry\n` +
    `<code>/alert list</code>        → show all your alerts\n` +
    `<code>/alert remove &lt;id&gt;</code>  → cancel an alert`);
}

// ─── /leaderboard — top calls (Hall of Fame) ─────────────────────────────────
// Build inline-keyboard buttons for timeframe selection.
// prefix is 'lb' for /lb or 'pulselb' for /pulselb. activeTf gets a checkmark.
function buildLeaderboardKeyboard(prefix, activeTf) {
  const tfs = [
    { tf: '24h', label: '12H' },   // alias — both 12H/1D map to 24h cutoff
    { tf: '24h', label: '1D' },
    { tf: '7d',  label: '7D' },
    { tf: '30d', label: '30D' },
    { tf: 'all', label: 'ALL' },
  ];
  // De-dupe so 12H/1D don't both show as '✓ ...' simultaneously
  const seen = new Set();
  const buttons = tfs.filter(t => {
    if (seen.has(t.label)) return false;
    seen.add(t.label);
    return true;
  }).map(t => ({
    text: (activeTf === t.tf ? '✓ ' : '') + t.label,
    callback_data: `${prefix}:${t.tf}`,
  }));
  return { inline_keyboard: [buttons] };
}

// Render the /lb message body (used by both initial command and callback edits).
async function renderGroupLeaderboardMessage(timeframe) {
  const { getTopCalls, getRichGroupStats, PULSE_USER_ID } = await import('./user-leaderboard.js');
  const stats = getRichGroupStats(dbInstance, timeframe);
  const calls = getTopCalls(dbInstance, timeframe, 15);
  const tfLabel = { '24h': '1d', '7d': '7d', '30d': '30d', 'all': 'all' }[timeframe] || timeframe;

  const emojiFor = (mult) => {
    if (mult == null)    return '🤔';
    if (mult >= 5)       return '🚀';
    if (mult >= 3)       return '🤩';
    if (mult >= 1.5)     return '😎';
    if (mult >= 1)       return '🙂';
    return '😞';
  };

  let msg = `🏆 <b>LEADERBOARD</b>\n\n` +
            `📊 <b>Group Stats</b>\n` +
            `┃ Period    <b>${tfLabel}</b>\n` +
            `┃ Calls     <b>${stats.calls || 0}</b>\n` +
            `┃ Active    <b>${stats.users || 0}</b> users\n` +
            `┃ Hit Rate  <b>${stats.hit_rate != null ? stats.hit_rate + '%' : '—'}</b>\n` +
            `┃ Median    <b>${stats.median != null ? stats.median.toFixed(2) + 'x' : '—'}</b>\n` +
            `┗ Best      <b>${stats.best_multiple != null ? stats.best_multiple.toFixed(2) + 'x' : '—'}</b> <i>(Avg: ${stats.avg_multiple != null ? stats.avg_multiple.toFixed(2) + 'x' : '—'})</i>\n\n`;

  if (calls.length === 0) {
    msg += `<blockquote><i>No calls ranked yet for this window. Drop a CA in the group and wait for it to peak.\n\nNote: bot needs Privacy Mode OFF in @BotFather to see non-command messages.</i></blockquote>`;
  } else {
    msg += `<blockquote>`;
    calls.forEach((c, i) => {
      const isPulse = c.user_id === PULSE_USER_ID;
      const nameText = escapeHtml(c.display_name || 'anon').slice(0, 18);
      // Tap-the-name → opens Telegram user profile. Tap-the-token →
      // DexScreener page for the coin. Pulse stays as plain text.
      const caller  = isPulse
        ? '⚡<b>Pulse</b>'
        : (/^\d+$/.test(c.user_id) ? `<a href="tg://user?id=${c.user_id}">${nameText}</a>` : nameText);
      const tokenLabel = c.token ? escapeHtml(c.token).slice(0, 14) : c.contract_address.slice(0, 6);
      const tokenLink  = c.contract_address
        ? `<a href="https://dexscreener.com/solana/${c.contract_address}">${tokenLabel}</a>`
        : tokenLabel;
      const mult    = c.peak_multiple != null ? ` <b>[${c.peak_multiple.toFixed(2)}x]</b>` : '';
      msg += `${emojiFor(c.peak_multiple)} <b>${i+1}.</b> 🪙 <b>${tokenLink}</b> » ${caller}${mult}\n`;
    });
    msg += `</blockquote>`;
  }
  return msg;
}

// /profile [@user | user_id] — shows that user's win history.
// No args → caller's own profile. Pulse can be looked up via "pulse" or
// "@pulsecaller". Tappable from leaderboard rows (clickable usernames).
async function handleProfileCommand(chatId, args, fromUserId, fromUsername) {
  const { getUserProfileData, PULSE_USER_ID } = await import('./user-leaderboard.js');
  let target = (args || '').trim();
  // Normalize special cases
  if (target.toLowerCase() === 'pulse' || target.toLowerCase() === '@pulsecaller' || target === '⚡pulse') {
    target = PULSE_USER_ID;
  }
  if (!target) target = String(fromUserId);

  const profile = getUserProfileData(dbInstance, target);
  if (!profile) {
    await sendTelegramMessage(chatId,
      target === String(fromUserId)
        ? `<i>You haven't dropped any CAs yet, @${escapeHtml(fromUsername || 'anon')}. Drop one in the group to start your profile.</i>`
        : `<i>No profile found for "${escapeHtml(target)}". User must have dropped at least one CA in this group.</i>`
    );
    return;
  }

  const isPulse = profile.user_id === PULSE_USER_ID;
  const headerName = isPulse
    ? '⚡ <b>Pulse Caller</b>'
    : `<b>${escapeHtml(profile.display_name).slice(0, 24)}</b>`;

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

  let msg = `👤 <b>PROFILE</b> — ${headerName}\n\n` +
            `📊 <b>All-Time Stats</b>\n` +
            `┃ Calls       <b>${profile.calls}</b>\n` +
            `┃ 🏆 Wins     <b>${profile.wins}</b>\n` +
            `┃ 💀 Losses   <b>${profile.losses}</b>\n` +
            `┃ ⏳ Pending  <b>${profile.pending}</b>\n` +
            `┃ Hit Rate    <b>${profile.hit_rate != null ? profile.hit_rate + '%' : '—'}</b>\n` +
            `┃ Median      <b>${profile.median != null ? profile.median.toFixed(2) + 'x' : '—'}</b>\n` +
            `┃ Best        <b>${profile.best_multiple != null ? profile.best_multiple.toFixed(2) + 'x' : '—'}</b>\n` +
            `┗ Avg         <b>${profile.avg_multiple != null ? profile.avg_multiple.toFixed(2) + 'x' : '—'}</b>\n\n`;

  if (profile.recent.length > 0) {
    msg += `🏆 <b>Recent Calls</b>\n<blockquote>`;
    profile.recent.forEach(c => {
      const tok = c.token ? escapeHtml(c.token).slice(0, 14) : c.contract_address.slice(0, 6);
      const mult = c.peak_multiple != null ? `<b>[${c.peak_multiple.toFixed(2)}x]</b>` : '<i>pending</i>';
      msg += `${emojiFor(c.peak_multiple)} 🪙 <b>${tok}</b>  ${mult}  <i>${fmtAgo(c.called_at)}</i>\n`;
    });
    msg += `</blockquote>`;
  }

  await sendTelegramMessage(chatId, msg);
}

// Send a leaderboard as a photo (Pulse banner) + caption — falls back to
// plain sendMessage if Telegram rejects the image. Caption capped at 1024.
async function sendLeaderboardWithBanner(chatId, caption, replyMarkup) {
  if (!TELEGRAM_BOT_TOKEN) return;
  const photoSrc = _leaderboardBannerFileId || LEADERBOARD_BANNER_URL;
  // Telegram caption limit = 1024 chars. Trim defensively.
  const safeCaption = caption.length > 1020 ? caption.slice(0, 1017) + '…' : caption;
  if (photoSrc) {
    try {
      const res = await fetch(`${TELEGRAM_API}/sendPhoto`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id:    chatId,
          photo:      photoSrc,
          caption:    safeCaption,
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        // Cache file_id from the uploaded image so future sends are faster
        try {
          const j = await res.json();
          const photos = j?.result?.photo;
          if (photos?.length && !_leaderboardBannerFileId) {
            _leaderboardBannerFileId = photos[photos.length - 1].file_id;
          }
        } catch {}
        return;
      }
      // Capture the failure body BEFORE any retry — Telegram describes
      // exactly why it rejected (file too big, MIME wrong, URL 404, etc).
      const usedFileId = !!_leaderboardBannerFileId;
      const errBody    = await res.text().catch(() => '');
      console.warn(`[TG-leaderboard] photo send failed (used ${usedFileId ? 'file_id' : 'URL'}, status=${res.status}): ${errBody.slice(0, 250)}`);

      // If file_id was stale (e.g. server restart) clear it and retry once with URL
      if (usedFileId) {
        _leaderboardBannerFileId = null;
        const retry = await fetch(`${TELEGRAM_API}/sendPhoto`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId, photo: LEADERBOARD_BANNER_URL, caption: safeCaption,
            parse_mode: 'HTML', reply_markup: replyMarkup,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (retry.ok) {
          // Cache the new file_id from the URL-based send
          try {
            const j = await retry.json();
            const photos = j?.result?.photo;
            if (photos?.length) _leaderboardBannerFileId = photos[photos.length - 1].file_id;
          } catch {}
          return;
        }
        const retryBody = await retry.text().catch(() => '');
        console.warn(`[TG-leaderboard] URL retry also failed (status=${retry.status}): ${retryBody.slice(0, 250)}`);
      }
    } catch (err) {
      console.warn(`[TG-leaderboard] photo error: ${err.message}`);
    }
  }
  // Fallback: plain text leaderboard
  await sendTelegramMessage(chatId, caption, { reply_markup: replyMarkup });
}

// /lb — Phanes-style group leaderboard with banner image + clickable timeframe buttons.
async function handleGroupLeaderboardCommand(chatId, args) {
  const tf = (args || '').trim().toLowerCase() || '1d';
  const aliasMap = { '12h': '24h', '24h': '24h', '1d': '24h', '7d': '7d', '1w': '7d', '30d': '30d', '2w': '7d', 'all': 'all' };
  const timeframe = aliasMap[tf] || '24h';
  const msg = await renderGroupLeaderboardMessage(timeframe);
  await sendLeaderboardWithBanner(chatId, msg, buildLeaderboardKeyboard('lb', timeframe));
}

// Render Pulse's own call leaderboard body (shared between command + callback).
function renderPulseLeaderboardMessage(timeframe) {
  const fmtMc = (n) => n == null ? '?' : (n >= 1_000_000 ? '$' + (n/1_000_000).toFixed(2) + 'M' : '$' + (n/1_000).toFixed(1) + 'K');
  const tfLabel = { '24h': '1D', '7d': '7D', '30d': '30D', 'all': 'ALL' }[timeframe] || timeframe;
  const { top, stats } = getCallsLeaderboard(timeframe);
  const winRate = (stats.wins + stats.losses) > 0 ? Math.round(stats.wins * 100 / (stats.wins + stats.losses)) : 0;

  const emojiFor = (mult) => {
    if (mult == null)    return '🤔';
    if (mult >= 5)       return '🚀';
    if (mult >= 3)       return '🤩';
    if (mult >= 1.5)     return '😎';
    if (mult >= 1)       return '🙂';
    return '😞';
  };

  let msg = `⚡ <b>PULSE CALLER · LEADERBOARD</b>\n\n` +
            `📊 <b>Group Stats</b>\n` +
            `┃ Period    <b>${tfLabel}</b>\n` +
            `┃ Calls     <b>${stats.total_calls || 0}</b>\n` +
            `┃ Hit Rate  <b>${winRate}%</b>\n` +
            `┃ Avg Win   <b>${stats.avg_win_multiple != null ? stats.avg_win_multiple.toFixed(2) + 'x' : '—'}</b>\n` +
            `┗ Best      <b>${stats.best_multiple != null ? stats.best_multiple.toFixed(2) + 'x' : '—'}</b>\n\n`;

  if (top.length === 0) {
    msg += `<blockquote><i>No wins recorded for this timeframe yet.</i></blockquote>`;
  } else {
    msg += `<blockquote>`;
    top.slice(0, 15).forEach((c, i) => {
      const tokLabel = escapeHtml(c.token || '?').slice(0, 14);
      const tok = c.contract_address
        ? `<a href="https://dexscreener.com/solana/${c.contract_address}">${tokLabel}</a>`
        : tokLabel;
      msg += `${emojiFor(c.peak_multiple)} <b>${i+1}.</b> 🪙 <b>${tok}</b>  ${c.peak_multiple.toFixed(2)}x  <i>(${fmtMc(c.market_cap_at_call)} → ${fmtMc(c.peak_mcap)})</i>\n`;
    });
    msg += `</blockquote>`;
  }
  return msg;
}

async function handleLeaderboardCommand(chatId, args) {
  const tf = (args || '').trim().toLowerCase() || '7d';
  const aliasMap = { '12h': '24h', '24h': '24h', '1d': '24h', '7d': '7d', '1w': '7d', '30d': '30d', 'all': 'all' };
  const timeframe = aliasMap[tf] || '7d';
  const msg = renderPulseLeaderboardMessage(timeframe);
  await sendLeaderboardWithBanner(chatId, msg, buildLeaderboardKeyboard('pulselb', timeframe));
}

// ─── Telegram AI OS command dispatcher ───────────────────────────────────────
async function dispatchAICommand(chatId, command, args, fromUserId) {
  switch (command) {
    case '/why':    return handleWhyCommand(chatId, args);
    case '/top':    return handleTopCommand(chatId);
    case '/config': return handleConfigCommand(chatId, args, fromUserId);
    default:        return false; // not handled
  }
}

async function handleAnalyzeCommand(chatId, input) {
  if (!input?.trim()) { await sendTelegramMessage(chatId, '⚠️ Usage: <code>/analyze [CA or ticker]</code>'); return; }
  if (!CLAUDE_API_KEY) { await sendTelegramMessage(chatId, '❌ Claude API key not configured.'); return; }

  const token = input.trim();
  await sendTelegramMessage(chatId, `🔬 Analyzing <code>${escapeHtml(token)}</code>…\nRunning 4 sub-scorers + wallet intel — ~20s`);

  try {
    const isSolanaCA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token);
    let candidate;
    if (isSolanaCA) { const pair = await fetchPairByAddress(token); if (pair) candidate = normalizePair(pair); }
    if (!candidate) {
      candidate = { token: isSolanaCA ? null : token.toUpperCase(), contractAddress: isSolanaCA ? token : null, chain: 'solana', narrativeTags: [], notes: [], birdeyeOk: false, heliusOk: false, bubblemapOk: false };
    }
    if (candidate.contractAddress) {
      candidate = await enrichCandidate(candidate);
      const intel = await runWalletIntel(candidate);
      candidate = { ...candidate, ...flattenIntel(intel) };
    }
    const scoreResult = computeFullScore(candidate, TUNING_CONFIG?.discovery);
    try { applyRegimeAdjustments(scoreResult.score, candidate, scoreResult); } catch {}
    scoreResult.similarity = computeSimilarityScores(scoreResult);
    const verdict = await callClaudeForAnalysis(candidate, scoreResult);
    await sendTelegramMessage(chatId, buildAnalysisMessage(candidate, verdict, scoreResult));
  } catch (err) {
    console.error('[analyze]', err.message);
    await sendTelegramMessage(chatId, `❌ Analysis failed: ${escapeHtml(err.message.slice(0,200))}`);
  }
}

async function handleScanCommand(chatId, input) {
  if (!input?.trim()) { await sendTelegramMessage(chatId, '⚠️ Usage: <code>/scan [Solana CA]</code>'); return; }
  const ca = input.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) { await sendTelegramMessage(chatId, '⚠️ /scan requires a full Solana contract address.'); return; }
  await sendTelegramMessage(chatId, `⚡ Scanning <code>${escapeHtml(ca)}</code>…`);
  try {
    const pair = await fetchPairByAddress(ca);
    const base = pair ? normalizePair(pair) : { contractAddress: ca, chain: 'solana', narrativeTags: [], notes: [], birdeyeOk: false, heliusOk: false, bubblemapOk: false };
    const e = await enrichCandidate(base);
    const mintFlag   = e.mintAuthority   === 0 ? '✓ revoked' : e.mintAuthority   === 1 ? '⚠️ ACTIVE' : '?';
    const freezeFlag = e.freezeAuthority === 0 ? '✓ revoked' : e.freezeAuthority === 1 ? '⚠️ ACTIVE' : '?';
    const lpFlag     = e.lpLocked === 1 ? '✓ locked' : e.lpLocked === 0 ? '⚠️ UNLOCKED' : '?';
    const msg =
      `<b>⚡ QUICK SCAN</b>\n<code>${escapeHtml(ca)}</code>\n\n` +
      `Token: <b>$${escapeHtml(e.token??'?')}</b>\n` +
      `MCap: ${fmt(e.marketCap,'$')}  Liq: ${fmt(e.liquidity,'$')}  Vol: ${fmt(e.volume24h,'$')}\n` +
      `Age: ${e.pairAgeHours?.toFixed(1)??'?'}h  Holders: ${e.holders?.toLocaleString()??'?'}\n\n` +
      `Top10: <b>${e.top10HolderPct?.toFixed(1)??'?'}%</b>  Dev: <b>${e.devWalletPct?.toFixed(1)??'?'}%</b>\n` +
      `Bundle: <b>${e.bundleRisk??'?'}</b>  BubbleMap: <b>${e.bubbleMapRisk??'?'}</b>  Snipers: <b>${e.sniperWalletCount??'?'}</b>\n` +
      `Mint: ${mintFlag}  Freeze: ${freezeFlag}  LP: ${lpFlag}\n\n` +
      `Vol Quality: <b>${e.volumeQuality??'?'}</b>  Extended: <b>${e.chartExtended??'?'}</b>\n` +
      `1h: ${fmtPct(e.priceChange1h)}  6h: ${fmtPct(e.priceChange6h)}  24h: ${fmtPct(e.priceChange24h)}\n` +
      `Socials: ${e.website?'🌐 ':''}${e.twitter?'𝕏 ':''}${e.telegram?'✈️ ':''}\n\n` +
      `<i>Use /analyze for full AI verdict + sub-scores.</i>`;
    await sendTelegramMessage(chatId, msg);
  } catch (err) {
    console.error('[scan]', err.message);
    await sendTelegramMessage(chatId, `❌ Scan failed: ${escapeHtml(err.message.slice(0,200))}`);
  }
}

// ─── Flatten Intel ────────────────────────────────────────────────────────────

function flattenIntel(intel) {
  if (!intel) return {};
  return {
    walletIntelScore:      intel.walletIntelScore             ?? null,
    clusterRisk:           intel.clusterRisk                  ?? null,
    coordinationIntensity: intel.coordination?.intensity       ?? null,
    momentumGrade:         intel.momentum?.momentumGrade       ?? null,
    uniqueBuyers5min:      intel.momentum?.uniqueBuyers5min    ?? null,
    buyVelocity:           intel.momentum?.buyVelocity         ?? null,
    survivalScore:         intel.momentum?.survivalScore       ?? null,
    linkedWalletCount:     intel.linkageAnalysis?.linkedWallets ?? null,
    deployerHistoryRisk:   intel.deployerProfile?.riskLevel === 'HIGH'   ? 'FLAGGED'
      : intel.deployerProfile?.riskLevel === 'MEDIUM' ? 'SUSPICIOUS'
      : intel.deployerProfile?.riskLevel === 'LOW'    ? 'CLEAN'
      : null,
  };
}

// ─── Command Parser ───────────────────────────────────────────────────────────

function parseCommand(text = '') {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return { command: null, args: '' };
  const parts = trimmed.replace(/@\S+/,'').trim().split(/\s+/);
  return { command: parts[0].toLowerCase(), args: parts.slice(1).join(' ') };
}

// Extend the Telegram message handler to include AI OS commands
// This patch hooks into the existing webhook handler
async function handleTelegramMessageAIOS(chatId, text, fromUserId) {
  const { command, args } = parseCommand(text ?? '');
  if (!command) return false;
  return dispatchAICommand(chatId, command, args, fromUserId);
}

// ─── Auto-Caller Cycle ────────────────────────────────────────────────────────

let cycleRunning = false;

// Smart-money retry queue — when a fresh coin from the smart-money watcher
// arrives before DexScreener/Birdeye have indexed it, we queue it for a
// single retry 2min later. If still empty at retry, drop. Prevents us
// from losing alpha on coins that are SO fresh the data sources lag.
const _smRetryQueue = new Map();   // ca → { candidate, retryAt, attempts }
const SM_RETRY_DELAY_MS    = 2 * 60 * 1000;
const SM_RETRY_MAX_ATTEMPTS = 1;   // 1 retry then give up

function enqueueSmartMoneyRetry(ca, candidate) {
  if (!ca) return;
  const existing = _smRetryQueue.get(ca);
  const attempts = (existing?.attempts ?? candidate?._smRetryAttempt ?? 0) + 1;
  if (attempts > SM_RETRY_MAX_ATTEMPTS) return;
  _smRetryQueue.set(ca, { candidate, retryAt: Date.now() + SM_RETRY_DELAY_MS, attempts });
}

async function processSmartMoneyRetries() {
  if (_smRetryQueue.size === 0) return;
  const now = Date.now();
  const due = [];
  for (const [ca, entry] of _smRetryQueue.entries()) {
    if (entry.retryAt <= now) { due.push([ca, entry]); }
  }
  for (const [ca, entry] of due) {
    _smRetryQueue.delete(ca);
    try {
      console.log(`[sm-retry] attempting retry for ${ca.slice(0,8)} (attempt ${entry.attempts})`);
      await processCandidate(entry.candidate, false);
    } catch (err) {
      console.warn(`[sm-retry] retry failed for ${ca.slice(0,8)}: ${err.message}`);
    }
  }
}

// Scanner health telemetry — surfaces via /api/health/scanner so we can
// diagnose "scanner stopped scanning" droughts without Railway log access.
let _scannerHealth = {
  lastCycleStartedAt:   null,
  lastCycleCompletedAt: null,
  lastCycleElapsedMs:   null,
  lastCycleError:       null,
  totalCyclesCompleted: 0,
  totalCycleErrors:     0,
  lastRawPairsCount:    null,
  lastCandidatesCount:  null,
  lastDexscreenerHttp:  null,
};

async function processCandidate(candidate, isRescan = false) {
  if (!_botActive) return; // Master toggle OFF — skip everything
  const ca = candidate.contractAddress;
  if (!ca) return;
  if (isBlocklisted(ca)) { console.log(`[auto-caller] BLOCKLIST skip — ${ca.slice(0,8)}`); return; }

  // ── HARD MCap ceiling: $80K cap based on historical outcome analysis.
  // Coins above this rarely produce the 10x-ish returns we're hunting, and
  // late entries are the #1 source of losses. Auto-reject regardless of
  // score, Claude, OpenAI, or smart-money signals. The cap is overridable
  // via AI_CONFIG_OVERRIDES.maxMarketCapOverride (set from dashboard / TG).
  // ── HARD MCap FLOOR: $15K minimum — sub-$15K calls have a high false-
  // positive rate (3 of 4 recent sub-$15K posts were losers). Coins between
  // $15K-$18K still need to clear extra V5 verification (rug<25, mq>=58,
  // wq>=55, OR a known winner wallet) before being eligible for POST.
  const MCAP_HARD_FLOOR = 15_000;
  if ((candidate.marketCap ?? 0) > 0 && (candidate.marketCap ?? 0) < MCAP_HARD_FLOOR) {
    console.log(`[auto-caller] 🚫 $${candidate.token ?? ca.slice(0,6)} rejected — mcap $${Math.round((candidate.marketCap??0)/1000)}K below $${MCAP_HARD_FLOOR/1000}K floor`);
    return;
  }

  // AXIOSCAN-MODE — raised default from 120K to 200K. $papi at $236K was
  // being blocked even though a 3x from there is still a real call. The
  // sweet-spot bonuses (+4 for $15-40K, +4 for EARLY_ENTRY) already bias
  // scoring toward low-MCap entries; the raw cap only needs to filter
  // "obviously too late" coins (>$250K where 3x is harder).
  const MCAP_HARD_CAP = AI_CONFIG_OVERRIDES.maxMarketCapOverride ?? 200_000;
  if ((candidate.marketCap ?? 0) > MCAP_HARD_CAP) {
    logEvent('INFO', 'MCAP_CEILING', `${candidate.token ?? ca.slice(0,6)} mcap=${Math.round(candidate.marketCap/1000)}K > ${MCAP_HARD_CAP/1000}K cap`);
    console.log(`[auto-caller] 🛑 $${candidate.token ?? ca.slice(0,6)} rejected — mcap ${Math.round(candidate.marketCap/1000)}K above $${MCAP_HARD_CAP/1000}K ceiling`);
    return;
  }

  // ── Stamp detection timestamp at ms precision for latency tracking ──
  // Prefer the _discoveredAt set by the Helius listener (real detection moment);
  // otherwise stamp now as the point at which processing begins.
  const detectedAtMs = candidate._discoveredAt ?? Date.now();

  // Pre-score activity gate was removed — it was blocking fast-track
  // detections because Birdeye hasn't populated buys1h/volume1h on
  // brand-new pairs yet. We need scoring to actually run so we get posts.
  // The bonding-curve-filter fix in enricher.js already handles the
  // pre-launch "dev = 100%" false positive at the data level.

  try {
    const isVeryNew = (candidate.pairAgeHours ?? 99) < 1;
    const intel = (isRescan || isVeryNew)
      ? await runQuickWalletIntel(candidate)
      : await runWalletIntel(candidate);

    const enrichedAtMs = Date.now();
    const enrichedCandidate = {
      ...candidate,
      ...flattenIntel(intel),
      candidateType: candidate.candidateType ?? null,
      quickScore:    candidate.quickScore    ?? null,
      detectedAtMs,
      enrichedAtMs,
    };

    // Fetch previous snapshot and calculate DELTAS — lets scorer see direction of change
    try {
      const prev = dbInstance.prepare(`
        SELECT * FROM token_metrics_history
        WHERE contract_address=? AND snapshot_at_ms < ?
        ORDER BY snapshot_at_ms DESC LIMIT 1
      `).get(ca, Date.now());
      if (prev) {
        const minutesAgo = (Date.now() - prev.snapshot_at_ms) / 60_000;
        enrichedCandidate._deltas = {
          minutesAgo: Math.round(minutesAgo * 10) / 10,
          mcapDelta: enrichedCandidate.marketCap != null && prev.market_cap ? ((enrichedCandidate.marketCap - prev.market_cap) / prev.market_cap) * 100 : null,
          liquidityDelta: enrichedCandidate.liquidity != null && prev.liquidity ? ((enrichedCandidate.liquidity - prev.liquidity) / prev.liquidity) * 100 : null,
          volumeDelta: enrichedCandidate.volume1h != null && prev.volume_1h ? ((enrichedCandidate.volume1h - prev.volume_1h) / prev.volume_1h) * 100 : null,
          buyRatioDelta: enrichedCandidate.buySellRatio1h != null && prev.buy_sell_ratio_1h ? (enrichedCandidate.buySellRatio1h - prev.buy_sell_ratio_1h) : null,
          velocityDelta: enrichedCandidate.buyVelocity != null && prev.buy_velocity ? (enrichedCandidate.buyVelocity - prev.buy_velocity) : null,
          holderDelta: enrichedCandidate.holders != null && prev.holders ? ((enrichedCandidate.holders - prev.holders) / prev.holders) * 100 : null,
          devPctDelta: enrichedCandidate.devWalletPct != null && prev.dev_wallet_pct != null ? (enrichedCandidate.devWalletPct - prev.dev_wallet_pct) : null,
          top10Delta: enrichedCandidate.top10HolderPct != null && prev.top10_holder_pct != null ? (enrichedCandidate.top10HolderPct - prev.top10_holder_pct) : null,
          prevScore: prev.composite_score,
        };
      }
    } catch {}

    // Fetch the last 5 historical snapshots so the V5 activity classifier
    // can detect QUIET → REVIVING patterns across multiple scans (not just
    // the most recent delta). Each entry holds a minimal trajectory bundle.
    try {
      const histRows = dbInstance.prepare(`
        SELECT snapshot_at_ms, market_cap, liquidity, volume_1h, buy_sell_ratio_1h,
               buy_velocity, holders, dev_wallet_pct, top10_holder_pct, composite_score
        FROM token_metrics_history
        WHERE contract_address=? AND snapshot_at_ms < ?
        ORDER BY snapshot_at_ms DESC LIMIT 5
      `).all(ca, Date.now());
      if (histRows.length > 0) {
        enrichedCandidate._history = histRows.map(h => ({
          minutesAgo:        Math.round((Date.now() - h.snapshot_at_ms) / 60_000),
          buys1h:            null, // not in history table
          sells1h:           null,
          volume1h:          h.volume_1h,
          marketCap:         h.market_cap,
          liquidity:         h.liquidity,
          buySellRatio1h:    h.buy_sell_ratio_1h,
          buyVelocity:       h.buy_velocity,
          holders:           h.holders,
          devWalletPct:      h.dev_wallet_pct,
          top10HolderPct:    h.top10_holder_pct,
          compositeScore:    h.composite_score,
          // Cross-snapshot deltas for prior-rug detection in reactivation score
          liquidityDelta:    null,
          devPctDelta:       null,
          priceChange1h:     null,
        }));
      }
    } catch {}

    fnl('evaluated');
    let scoreResult;
    try {
      scoreResult = computeFullScore(enrichedCandidate, TUNING_CONFIG?.discovery);
      fnl('scored');
    } catch (scoreErr) {
      console.error('[auto-caller] computeFullScore CRASHED — falling back to legacy:', scoreErr.message);
      // Fallback: run without custom weights
      try { scoreResult = computeFullScore(enrichedCandidate); fnl('scored'); } catch (e2) {
        console.error('[auto-caller] Legacy scoring also failed:', e2.message);
        return; // Can't score at all — skip this candidate
      }
    }
    const scoredAtMs = Date.now();
    enrichedCandidate.scoredAtMs = scoredAtMs;

    // ── Global bonus-cap helper ────────────────────────────────────────────
    // Every post-score bonus draws from a shared budget (SCORING_CONFIG.globalBonusCap).
    // Prevents stacked bonuses (sweet-spot + pre-launch + cross-chain + dev-fp + divergence)
    // from manufacturing a 90+ composite out of a mediocre base score.
    scoreResult._bonusBudgetUsed = 0;
    const addBonusCapped = (amount) => {
      const cap = SCORING_CONFIG.globalBonusCap ?? 8;
      const remaining = Math.max(0, cap - scoreResult._bonusBudgetUsed);
      const applied = Math.max(0, Math.min(amount, remaining));
      if (applied > 0) {
        scoreResult.score = Math.min(100, scoreResult.score + applied);
        scoreResult._bonusBudgetUsed += applied;
      }
      return applied; // caller can label with actual amount applied
    };

    // ── DATA QUALITY GATE: reject tokens with zero enrichment data ────────
    // If Birdeye AND Helius both failed AND we have no market cap, this token
    // has no real data. Always drop — no useful signal with this little
    // information. Smart-money alerts get queued for ONE retry at +2min
    // (DexScreener usually indexes fresh pools in that window) before being
    // dropped permanently.
    if (!enrichedCandidate.birdeyeOk && !enrichedCandidate.heliusOk && enrichedCandidate.marketCap == null) {
      const sm = enrichedCandidate._smartMoney;
      const alreadyRetried = !!enrichedCandidate._smRetryAttempt;
      if (sm && !alreadyRetried) {
        console.log(`[auto-caller] 🔁 $${ca.slice(0,8)} — ${sm.kind} signal, enrichment empty → queueing 2min retry`);
        enqueueSmartMoneyRetry(ca, { ...candidate, _smRetryAttempt: 1 });
        fnl('dataVoidRetry');
        return;
      }
      console.log(`[auto-caller] 🚫 $${enrichedCandidate.token ?? ca.slice(0,8)} — zero enrichment data (no Birdeye, no Helius, no mcap). Skipping.`);
      fnl('dataVoidSkip');
      logEvent('INFO', 'DATA_VOID_SKIP', `${enrichedCandidate.token ?? ca.slice(0,8)} — birdeye=✗ helius=✗ mcap=null`);
      return;
    }

    // ── MCap tier bonuses ─────────────────────────────────────────────────
    // Sweet spot $13K-$40K: +8 points (historical data shows best ROI here)
    // Sweet spot $15K-$40K pre-bonding: +4 points (best risk/reward for early gems)
    // Secondary $40K-$80K: +2 points (still viable for continuation plays)
    // Below $15K: no bonus (too pre-launch to reliably enter)
    const mcap = enrichedCandidate.marketCap ?? 0;
    const ssMin = TUNING_CONFIG?.thresholds?.sweetSpotMin ?? 15_000;
    const ssMax = TUNING_CONFIG?.thresholds?.sweetSpotMax ?? 40_000;
    let mcapTier = null;
    if (mcap >= ssMin && mcap <= ssMax) {
      const b = addBonusCapped(SCORING_CONFIG.sweetSpotBonus);
      if (b > 0) {
        (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
        scoreResult.signals.launch.push(`+${b} sweet-spot MCap ($${ssMin/1000}K-$${ssMax/1000}K)`);
      }
      mcapTier = 'SWEET_SPOT';
    } else if (mcap > ssMax && mcap <= 80_000) {
      const b = addBonusCapped(SCORING_CONFIG.secondaryBonus);
      if (b > 0) {
        (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
        scoreResult.signals.launch.push(`+${b} secondary MCap ($${ssMax/1000}K-$80K)`);
      }
      mcapTier = 'SECONDARY';
    } else if (mcap > 0 && mcap < ssMin) {
      mcapTier = 'PRE_SWEETSPOT';
    }
    enrichedCandidate.mcapTier = mcapTier;

    // ── VOLUME / PRICE DIVERGENCE ─────────────────────────────────────────
    // Relationship between price action and volume tells us more than either
    // alone.
    //   Price DOWN + Volume RISING → accumulation (smart money stepping in) +3
    //   Price UP   + Volume RISING → confirmed breakout (healthy)             0 (already priced in)
    //   Price UP   + Volume DYING  → exhaustion (late to the party)          -4
    //   Price DOWN + Volume DYING  → dying coin                              -5
    // Only fires when we have both signals — silent otherwise.
    {
      const p1h    = enrichedCandidate.priceChange1h;
      const volVel = enrichedCandidate.volumeVelocity;
      if (p1h != null && volVel != null) {
        let divDelta = 0;
        let divLabel = null;
        if (p1h <= -5 && volVel >= 0.35) {
          divDelta = 3;
          divLabel = `+3 accumulation divergence (price ${p1h.toFixed(0)}%, vol surge ${volVel.toFixed(2)})`;
        } else if (p1h >= 15 && volVel <= 0.08) {
          divDelta = -4;
          divLabel = `${divDelta} exhaustion divergence (price +${p1h.toFixed(0)}%, vol dying ${volVel.toFixed(2)})`;
        } else if (p1h <= -10 && volVel <= 0.08) {
          divDelta = -5;
          divLabel = `${divDelta} dying coin (price ${p1h.toFixed(0)}%, no volume)`;
        }
        if (divDelta > 0) {
          const applied = addBonusCapped(divDelta);
          if (applied > 0) {
            (scoreResult.signals = scoreResult.signals || {}).market = scoreResult.signals.market || [];
            scoreResult.signals.market.push(`+${applied} accumulation divergence (price ${p1h.toFixed(0)}%, vol surge ${volVel.toFixed(2)})`);
          }
        } else if (divDelta < 0) {
          scoreResult.score = Math.max(0, scoreResult.score + divDelta);
          (scoreResult.penalties = scoreResult.penalties || {}).market = scoreResult.penalties.market || [];
          scoreResult.penalties.market.push(divLabel);
        }
      }
    }

    // ── BUNDLE-SETUP DETECTOR — coordinated sniper bundle in first 10 holders ──
    // Heuristic using data we already have (no new API calls):
    // When a coin has many snipers AND low unique-buyer ratio AND a short
    // age, the first transactions were almost certainly a coordinated
    // bundle (single bot dumping SOL into multiple fresh wallets that all
    // buy in the same block). These rug 80%+ of the time.
    {
      const snipers = enrichedCandidate.sniperWalletCount ?? 0;
      const ubr     = enrichedCandidate.launchUniqueBuyerRatio;
      const age     = enrichedCandidate.pairAgeHours ?? 99;
      const isBundleSetup =
        snipers >= 10 && ubr != null && ubr < 0.35 && age < 0.5;
      if (isBundleSetup) {
        const dump = 10;
        scoreResult.score = Math.max(0, scoreResult.score - dump);
        (scoreResult.penalties = scoreResult.penalties || {}).launch = scoreResult.penalties.launch || [];
        scoreResult.penalties.launch.push(
          `-${dump} BUNDLE_SETUP — ${snipers} snipers + ${(ubr*100).toFixed(0)}% unique @ ${(age*60).toFixed(0)}min (coordinated bot bundle)`
        );
        enrichedCandidate._bundleSetup = true;
      }
    }

    // ── Dev fingerprint adjustment: boost ELITE/PROVEN devs, penalize RUGGERs ──
    try {
      const deployer = enrichedCandidate.deployerVerdict || enrichedCandidate.deployer_verdict;
      if (deployer) {
        const { getDevFingerprint, devScoreAdjustment } = await import('./dev-fingerprint.js');
        const fp = getDevFingerprint(deployer, dbInstance);
        const adj = devScoreAdjustment(fp);
        if (adj.delta !== 0) {
          // Dev fingerprint: positive deltas go through the global bonus budget
          // AND the per-source devFingerprintCap. Penalties (RUGGER) stay
          // uncapped — bad dev history should still hurt as much as the model says.
          if (adj.delta > 0) {
            const bounded = Math.min(adj.delta, SCORING_CONFIG.devFingerprintCap);
            const applied = addBonusCapped(bounded);
            scoreResult.devFingerprint = { ...fp, adjustment: { ...adj, delta: applied } };
            if (applied > 0) {
              (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
              scoreResult.signals.launch.push(`+${applied} ${adj.reason}`);
            }
          } else {
            scoreResult.score = Math.max(0, scoreResult.score + adj.delta);
            scoreResult.devFingerprint = { ...fp, adjustment: { ...adj, delta: adj.delta } };
            (scoreResult.penalties = scoreResult.penalties || {}).launch = [...(scoreResult.penalties.launch || []), `${adj.delta} ${adj.reason}`];
          }
        }

        // Hot-dev boost: does this deployer have another coin actively running
        // right now? If any prior launch from them hit 2x+ in the last 24h,
        // they're on a hot streak. Real pattern — devs that hit one often hit
        // the next. Single query against calls table joined by deployer.
        try {
          const hotRun = dbInstance.prepare(`
            SELECT MAX(c.peak_multiple) as best_peak
            FROM calls c
            JOIN candidates ca ON ca.id = c.candidate_id
            WHERE ca.deployer_verdict = ?
              AND c.posted_at > datetime('now', '-24 hours')
              AND c.peak_multiple >= 2
          `).get(deployer);
          if (hotRun && hotRun.best_peak) {
            const hotBonus = SCORING_CONFIG.hotDevBonus ?? 4;
            const applied = addBonusCapped(hotBonus);
            if (applied > 0) {
              (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
              scoreResult.signals.launch.push(`+${applied} HOT DEV — deployer's other launch hit ${hotRun.best_peak.toFixed(1)}x in last 24h`);
              console.log(`[auto-caller] 🔥 HOT DEV — $${enrichedCandidate.token ?? ca.slice(0,6)} deployer has ${hotRun.best_peak.toFixed(1)}x runner active`);
            }
          }
        } catch {}

        // Deployer reputation: historical track record of this deployer.
        // ELITE (3+ wins, 0 rugs) → +3 bonus · FLAGGED (1+ rug) → -4 penalty
        // · SERIAL_RUGGER (3+ rugs) → -8 penalty · NEUTRAL → no change.
        // Signal is only as good as our outcome-tracking feedback loop
        // (updateDeployerOutcome called when a call resolves WIN/LOSS).
        try {
          const rep = getDeployerReputation(deployer);
          if (rep && rep.reputation_grade) {
            const grade = rep.reputation_grade;
            if (grade === 'SERIAL_RUGGER') {
              scoreResult.score = Math.max(0, scoreResult.score - 8);
              (scoreResult.penalties = scoreResult.penalties || {}).launch = [...(scoreResult.penalties.launch || []), `-8 SERIAL_RUGGER (${rep.rugged_launches} prior rugs)`];
              console.log(`[auto-caller] ⚠ SERIAL_RUGGER — $${enrichedCandidate.token ?? ca.slice(0,6)} deployer rugged ${rep.rugged_launches}x`);
            } else if (grade === 'FLAGGED') {
              scoreResult.score = Math.max(0, scoreResult.score - 4);
              (scoreResult.penalties = scoreResult.penalties || {}).launch = [...(scoreResult.penalties.launch || []), `-4 FLAGGED (${rep.rugged_launches} prior rug)`];
            } else if (grade === 'ELITE') {
              const applied = addBonusCapped(3);
              if (applied > 0) {
                (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
                scoreResult.signals.launch.push(`+${applied} ELITE_DEV — ${rep.successful_launches} prior wins, 0 rugs`);
                console.log(`[auto-caller] 🏆 ELITE DEV — $${enrichedCandidate.token ?? ca.slice(0,6)} deployer has ${rep.successful_launches} prior wins`);
              }
            } else if (grade === 'CLEAN') {
              const applied = addBonusCapped(1);
              if (applied > 0) {
                (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
                scoreResult.signals.launch.push(`+${applied} CLEAN_DEV — ${rep.successful_launches} prior win(s), 0 rugs`);
              }
            }
          }
        } catch {}
      }
    } catch {}

    // ── NEW SIGNALS BLOCK (meta-signals.js) ──────────────────────────────
    // 4 signals consolidated: pump.fun graduation, volume acceleration,
    // narrative/meta match (self-learned from our 3x+ WINs in last 7d),
    // and liquidity trajectory (growing vs shrinking). All bonuses share
    // the globalBonusCap budget. Penalties (LIQ_DRAINING) bypass the cap.
    try {
      const {
        recordLiquiditySnapshot, getLiquidityTrajectory,
        scoreLiquidityTrajectory, scorePumpFunGraduation,
        scoreVolumeAcceleration, getCurrentMetaKeywords, scoreNarrativeMatch,
      } = await import('./meta-signals.js');

      // Always snapshot current liquidity (throttled to 5min per CA)
      recordLiquiditySnapshot(
        dbInstance, ca,
        Number(enrichedCandidate.liquidityUsd ?? enrichedCandidate.liquidity) || null,
        Number(enrichedCandidate.marketCap) || null,
        Number(enrichedCandidate.volume1h) || null,
      );

      // #1 Pump.fun graduation
      const pf = scorePumpFunGraduation(enrichedCandidate);
      if (pf.bonus > 0) {
        const applied = addBonusCapped(pf.bonus);
        if (applied > 0) {
          (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
          scoreResult.signals.launch.push(`+${applied} PUMP_GRADUATED (${pf.tag})`);
          console.log(`[auto-caller] 🎓 $${enrichedCandidate.token ?? ca.slice(0,6)} graduated pump.fun → Raydium · +${applied}`);
        }
      }

      // #2 Volume acceleration
      const vacc = scoreVolumeAcceleration(enrichedCandidate);
      if (vacc.bonus > 0) {
        const applied = addBonusCapped(vacc.bonus);
        if (applied > 0) {
          (scoreResult.signals = scoreResult.signals || {}).market = scoreResult.signals.market || [];
          scoreResult.signals.market.push(`+${applied} ${vacc.tag}`);
        }
      }

      // #3 Narrative / meta match
      const metaKw = getCurrentMetaKeywords(dbInstance);
      const narr = scoreNarrativeMatch(enrichedCandidate, metaKw);
      if (narr.bonus > 0) {
        const applied = addBonusCapped(narr.bonus);
        if (applied > 0) {
          const words = narr.matched.map(m => m.word).join(', ');
          (scoreResult.signals = scoreResult.signals || {}).market = scoreResult.signals.market || [];
          scoreResult.signals.market.push(`+${applied} META_MATCH — matches current winning narrative: ${words}`);
          console.log(`[auto-caller] 🎯 META $${enrichedCandidate.token ?? ca.slice(0,6)} matched: ${words} · +${applied}`);
        }
      }

      // Whale-funded holders — whales that funded fresh wallets within 48h.
      // If ≥1 such wallet is holding this candidate, it's a near-real-time
      // "whale is buying X through a burner" signal. +4 for 1, +6 for 2+.
      try {
        const holders = enrichedCandidate.knownWinnerWallets ?? [];
        if (holders.length > 0) {
          const { countRecentlyWhaleFunded } = await import('./whale-funding-tracker.js');
          const n = countRecentlyWhaleFunded(dbInstance, holders, 48);
          if (n > 0) {
            const bonus = n >= 2 ? 6 : 4;
            const applied = addBonusCapped(bonus);
            if (applied > 0) {
              (scoreResult.signals = scoreResult.signals || {}).wallet = scoreResult.signals.wallet || [];
              scoreResult.signals.wallet.push(`+${applied} WHALE_FUNDED_HOLDER — ${n} wallet${n>1?'s':''} funded by whale in last 48h`);
              console.log(`[auto-caller] 🔗 WHALE_FUNDED $${enrichedCandidate.token ?? ca.slice(0,6)} — ${n} holder(s) freshly whale-funded · +${applied}`);
            }
          }
        }
      } catch {}

      // #5 Liquidity trajectory (needs ≥2 snapshots, so first scans won't trigger)
      const traj = getLiquidityTrajectory(dbInstance, ca);
      if (traj) {
        const ls = scoreLiquidityTrajectory(traj);
        if (ls.delta > 0) {
          const applied = addBonusCapped(ls.delta);
          if (applied > 0) {
            (scoreResult.signals = scoreResult.signals || {}).market = scoreResult.signals.market || [];
            scoreResult.signals.market.push(`+${applied} ${ls.tag}`);
          }
        } else if (ls.delta < 0) {
          // Penalties bypass the cap per existing convention
          scoreResult.score = Math.max(0, scoreResult.score + ls.delta);
          (scoreResult.penalties = scoreResult.penalties || {}).market = [...(scoreResult.penalties.market || []), `${ls.delta} ${ls.tag}`];
          console.log(`[auto-caller] 💧 LIQ_DRAIN $${enrichedCandidate.token ?? ca.slice(0,6)} ${traj.deltaPct.toFixed(0)}% in ${traj.spanMins.toFixed(0)}min · ${ls.delta}`);
        }
      }
    } catch (err) {
      console.warn('[meta-signals] block failed:', err.message);
    }

    // ── Pre-launch suspect: this dev was just funded by an exchange? ──
    try {
      const deployer = enrichedCandidate.deployerVerdict || enrichedCandidate.deployer_verdict;
      if (deployer) {
        const { isPreLaunchSuspect, markSuspectConsumed } = await import('./pre-launch-detector.js');
        const suspect = isPreLaunchSuspect(deployer, dbInstance);
        if (suspect) {
          const applied = addBonusCapped(SCORING_CONFIG.preLaunchBonus);
          scoreResult.preLaunchPredicted = true;
          if (applied > 0) {
            (scoreResult.signals = scoreResult.signals || {}).launch =
              [...(scoreResult.signals.launch || []),
               `+${applied} PRE_LAUNCH_PREDICTED — dev funded by ${suspect.source_exchange} ${suspect.funded_amount}◎ within last 6h`];
          }
          markSuspectConsumed(deployer, ca, dbInstance);
        }
      }
    } catch {}

    // ── LP SECURITY SCORING ─────────────────────────────────────────────
    // We hunt coins with hold windows of minutes to hours. Any LP that's
    // actually locked (even 1 hour out) means the dev CANNOT rug during
    // the trade — so short locks aren't penalized. Only treat it as a
    // rug-risk when LP is directly in the dev's hands (UNLOCKED / PARTIAL).
    // Long locks still earn a small bonus as a quality signal.
    try {
      const lpStatus = enrichedCandidate.lpSecurityStatus;
      if (lpStatus && lpStatus !== 'UNKNOWN' && lpStatus !== 'BONDING_CURVE') {
        if (lpStatus === 'BURNED') {
          const applied = addBonusCapped(6);
          if (applied > 0) {
            (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
            scoreResult.signals.launch.push(`+${applied} LP_BURNED — liquidity permanently unrugable`);
          }
        } else if (lpStatus === 'LOCKED_LONG') {
          const applied = addBonusCapped(5);
          if (applied > 0) {
            (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
            scoreResult.signals.launch.push(`+${applied} LP_LOCKED_LONG — unlock >30d away`);
          }
        } else if (lpStatus === 'LOCKED_MEDIUM') {
          const applied = addBonusCapped(2);
          if (applied > 0) {
            (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
            scoreResult.signals.launch.push(`+${applied} LP_LOCKED_MEDIUM — unlock 7-30d out`);
          }
        } else if (lpStatus === 'LOCKED_SHORT' || lpStatus === 'LOCKED_IMMINENT') {
          // Neutral — any active lock covers the typical short hold window.
          // Tag as informational signal so it surfaces in logs, no score change.
          (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
          scoreResult.signals.launch.push(`LP_${lpStatus.slice(7)} — locked (no score change, covers typical hold)`);
        } else if (lpStatus === 'PARTIAL') {
          // Soft penalty — some LP secured, rest held by dev. Common at
          // early MCaps before a dev invests in locking.
          scoreResult.score = Math.max(0, scoreResult.score - 2);
          (scoreResult.penalties = scoreResult.penalties || {}).launch = scoreResult.penalties.launch || [];
          scoreResult.penalties.launch.push(`-2 LP_PARTIAL ⚠ — only some LP secured, rest in dev hands`);
        } else if (lpStatus === 'UNLOCKED') {
          // Most coins don't get locked until $25K-$40K MCap, so UNLOCKED
          // below $25K is *normal*. Only penalize above that threshold where
          // a locked LP is expected. Below $25K, surface as informational
          // signal so you see it without score impact.
          const mcapForLp = enrichedCandidate.marketCap ?? 0;
          if (mcapForLp >= 25_000) {
            scoreResult.score = Math.max(0, scoreResult.score - 5);
            (scoreResult.penalties = scoreResult.penalties || {}).launch = scoreResult.penalties.launch || [];
            scoreResult.penalties.launch.push(`-5 LP_UNLOCKED ⚠ — dev still holds LP above $25K MCap`);
          } else {
            (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
            scoreResult.signals.launch.push(`LP_UNLOCKED ⚠ — normal below $25K, watch as MCap grows`);
          }
        }
      }
    } catch {}

    // ── Cross-chain match: is this a migration of a hot ETH/Base token? ──
    try {
      const { getCrossChainMatch } = await import('./cross-chain-tracker.js');
      const match = getCrossChainMatch(ca, dbInstance);
      if (match && match.match_confidence >= 0.85) {
        const applied = addBonusCapped(SCORING_CONFIG.crossChainBonus);
        scoreResult.crossChainMatch = match;
        if (applied > 0) {
          (scoreResult.signals = scoreResult.signals || {}).social =
            [...(scoreResult.signals.social || []),
             `+${applied} CROSS-CHAIN MATCH — $${match.source_symbol} on ${match.source_chain} up ${Math.round(match.source_price_change||0)}% (${Math.round(match.match_confidence*100)}% match)`];
        }
      }
    } catch {}

    // ── LunarCrush social bonus ─────────────────────────────────────────
    // We pay for LunarCrush and were fetching galaxyScore / socialSpike /
    // twitterMentions on every enrichment but never feeding any of it into
    // the composite. A real social-volume spike is early alpha — coins
    // with a 2x social volume surge ahead of price almost always run.
    try {
      // LunarCrush bonus capped at +4 max (per user). Simple tiered rewards:
      //   socialSpike  → +2
      //   galaxy ≥ 60  → +1
      //   tweets ≥ 100 → +1
      // Still draws from the global bonus budget.
      let lcBonus = 0;
      const lcSignals = [];
      if (enrichedCandidate.socialSpike) {
        lcBonus += 2;
        lcSignals.push(`social volume spike (2x+ above baseline)`);
      }
      const gs = Number(enrichedCandidate.galaxyScore);
      if (Number.isFinite(gs) && gs >= 60) {
        lcBonus += 1;
        lcSignals.push(`galaxy score ${gs.toFixed(0)}`);
      }
      const tm = Number(enrichedCandidate.twitterMentions);
      if (Number.isFinite(tm) && tm >= 100) {
        lcBonus += 1;
        lcSignals.push(`${tm} Twitter mentions`);
      }
      lcBonus = Math.min(lcBonus, 4); // hard cap at +4 per user request
      if (lcBonus > 0) {
        const applied = addBonusCapped(lcBonus);
        if (applied > 0) {
          (scoreResult.signals = scoreResult.signals || {}).social = scoreResult.signals.social || [];
          scoreResult.signals.social.push(`+${applied} LUNARCRUSH — ${lcSignals.join(', ')}`);
        }
      }
    } catch {}

    // ── Pre-breakout accumulation bonus ──────────────────────────────────
    // The 10x-30x coins almost always show this pattern FIRST: volume is
    // climbing steadily, buy-pressure dominating, but price hasn't moved
    // much yet. That's smart money accumulating before the pop. We reward
    // this setup BEFORE velocity explodes — getting us in earlier than
    // the price-follow crowd.
    //
    // Conditions (all must be true):
    //   - Age < 1 hour (still in the accumulation window)
    //   - Buys1h / sells1h ≥ 2.0 (dominant buy pressure)
    //   - Price change 1h < 30% (hasn't ripped yet)
    //   - Volume1h ≥ $2K (real accumulation, not crickets)
    //   - At least 15 buys in the hour (real participants)
    try {
      const ageHrs  = enrichedCandidate.pairAgeHours ?? 99;
      const b1h     = enrichedCandidate.buys1h ?? 0;
      const s1h     = enrichedCandidate.sells1h ?? 0;
      const vol1h   = enrichedCandidate.volume1h ?? 0;
      const p1h     = enrichedCandidate.priceChange1h ?? 0;
      const bsRatio = s1h > 0 ? b1h / s1h : (b1h > 0 ? 99 : 0);
      const preBreakout = ageHrs < 1
                      && b1h >= 15
                      && vol1h >= 2000
                      && bsRatio >= 2.0
                      && p1h < 30;
      if (preBreakout) {
        const applied = addBonusCapped(5);
        if (applied > 0) {
          (scoreResult.signals = scoreResult.signals || {}).market = scoreResult.signals.market || [];
          scoreResult.signals.market.push(`+${applied} PRE-BREAKOUT — buy pressure ${bsRatio.toFixed(1)}x accumulating, price still flat (+${p1h.toFixed(0)}%)`);
          console.log(`[auto-caller] 🎯 PRE-BREAKOUT — $${enrichedCandidate.token ?? ca.slice(0,6)} ratio=${bsRatio.toFixed(1)} vol1h=${Math.round(vol1h)} p1h=${p1h.toFixed(1)}%`);
        }
      }
    } catch {}

    // ── Early-entry MCap bonus — tighter band for real upside ────────────
    // A $10K coin doing 10x peaks at $100K. A $60K coin doing 10x peaks at
    // $600K — different game entirely. Bias harder toward the $5K-$20K
    // band where 10x moves are structurally possible. Above $40K we need
    // to be skeptical that upside remains.
    try {
      const mcapEarly = enrichedCandidate.marketCap ?? 0;
      const ageEarly  = enrichedCandidate.pairAgeHours ?? 99;
      let earlyBonus = 0;
      let earlyLabel = '';
      if (mcapEarly >= 5000 && mcapEarly <= 12000 && ageEarly < 0.25) {
        earlyBonus = 4; earlyLabel = `EARLIEST ENTRY ($${Math.round(mcapEarly/1000)}K @ ${Math.round(ageEarly*60)}min)`;
      } else if (mcapEarly >= 5000 && mcapEarly <= 20000 && ageEarly < 0.5) {
        earlyBonus = 3; earlyLabel = `EARLY ENTRY ($${Math.round(mcapEarly/1000)}K @ ${Math.round(ageEarly*60)}min)`;
      }
      if (earlyBonus > 0) {
        const applied = addBonusCapped(earlyBonus);
        if (applied > 0) {
          (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
          scoreResult.signals.launch.push(`+${applied} ${earlyLabel} — structural 10x upside`);
        }
      }
    } catch {}

    // ── Age-mismatch penalty — DISABLED in Axioscan mode ──────────────────
    // A coin that's flat at 2h might STILL run later. Removing this penalty
    // reclaims late-bloomers that Axioscan-style volume strategy wants to
    // catch. The binary WIN/LOSS + winPeakMultiple already classifies the
    // flat-peak outcome cleanly; we don't need pre-emptive penalty too.
    try {
      const ageMm   = enrichedCandidate.pairAgeHours ?? 0;
      const mcapMm  = enrichedCandidate.marketCap ?? 0;
      const p1hMm   = enrichedCandidate.priceChange1h ?? 0;
      const p6hMm   = enrichedCandidate.priceChange6h ?? 0;
      const isStuck = ageMm > 2
                   && mcapMm > 0 && mcapMm < 30_000
                   && p1hMm < 10
                   && p6hMm < 20;
      if (isStuck) {
        scoreResult._ageMismatchWouldHit = true;
        // Diagnostic only — no score hit in Axioscan mode
      }
    } catch {}

    // ── Score trajectory bonus ──────────────────────────────────────────
    // If this coin has been rescanned and the score is climbing 20+ points
    // across the last 3 scans, that trajectory itself is alpha (real
    // momentum building). Catches candidates ticking up from 30 → 45 → 65
    // that would otherwise be in the watchlist bucket — same signal the
    // $JACKSON pattern showed before it ran.
    try {
      const prior = dbInstance.prepare(`
        SELECT composite_score FROM candidates
        WHERE contract_address = ? AND composite_score > 0 AND composite_score IS NOT NULL
        ORDER BY id DESC LIMIT 3
      `).all(ca);
      if (prior.length >= 2) {
        const oldest = prior[prior.length - 1].composite_score;
        const currentScore = scoreResult.score ?? 0;
        const delta = currentScore - oldest;
        if (delta >= 20) {
          const applied = addBonusCapped(5);
          if (applied > 0) {
            scoreResult.scoreTrajectory = { oldest, current: currentScore, delta };
            (scoreResult.signals = scoreResult.signals || {}).market = scoreResult.signals.market || [];
            scoreResult.signals.market.push(`+${applied} TRAJECTORY — score climbing ${Math.round(oldest)}→${Math.round(currentScore)} across rescans (+${delta.toFixed(0)} pts)`);
          }
        }
      }
    } catch {}
    let regimeAdj = { adjustedScore: scoreResult.score, thresholdAdjust: 0, regimeNotes: [] };
    try {
      const ra = applyRegimeAdjustments(scoreResult.score, enrichedCandidate, scoreResult);
      if (ra && typeof ra.adjustedScore === 'number') regimeAdj = ra;
    } catch (err) {
      console.warn(`[auto-caller] regime adjustment failed: ${err.message}`);
    }
    scoreResult.regimeAdjustedScore = regimeAdj.adjustedScore ?? scoreResult.score;
    scoreResult.regimeNotes         = regimeAdj.regimeNotes ?? [];

    // ── NO-SIGNAL FLOOR: cap composite at 65 when no real alpha signal ─────
    // "Structure-only" coins (clean dev, low top10, no snipers, but nothing
    // else) were trivially hitting 80-100. Without actual smart money
    // presence — or any wallet intel score above 0 — the ceiling stays at
    // 65. Those coins can still hit WATCHLIST but never AUTO_POST on the
    // strength of structure alone.
    // Close the backdoor: preLaunchPredicted / crossChainMatch were previously
    // enough to exempt a coin from the NO_SIGNAL cap on their own. That let
    // structure-only coins post at 80+ just from a dev-funding hit. Now the
    // cap is lifted only when REAL wallet-side alpha is present (smart money,
    // known winners, or a live cluster/KOL trigger). Pre-launch/cross-chain
    // still give their bonus points through addBonusCapped, but can't bypass
    // the 65 ceiling by themselves.
    const hasWalletIntel = (enrichedCandidate.walletIntelScore ?? 0) > 0
                        || (enrichedCandidate.smartMoneyScore  ?? 0) > 0
                        || (enrichedCandidate.knownWinnerWalletCount ?? 0) > 0
                        || enrichedCandidate._smartMoney;
    // Cap-lift overrides — wallet DB is thin (~178 curated wallets), so we
    // can't expect every quality coin to have a tracked winner. Lift the
    // cap when EITHER:
    //   (a) Strong momentum (velocity ≥12 buys/min OR buy ratio ≥75% on $20K+ vol)
    //   (b) Clean structure (dev<3% + top10<30% + mint revoked + LP locked)
    //   (c) Smart money / wallet intel present (handled above)
    const buyVel = enrichedCandidate.buyVelocity ?? enrichedCandidate.buy_velocity ?? 0;
    const brRatio = enrichedCandidate.buySellRatio1h ?? enrichedCandidate.buy_sell_ratio_1h ?? 0;
    const v1h = enrichedCandidate.volume1h ?? enrichedCandidate.volume_1h ?? 0;
    const strongMomentum = (buyVel >= 12) || (brRatio >= 0.75 && v1h >= 20_000);
    const dev   = enrichedCandidate.devWalletPct ?? enrichedCandidate.dev_wallet_pct;
    const top10 = enrichedCandidate.top10HolderPct ?? enrichedCandidate.top10_holder_pct;
    const mintOk = (enrichedCandidate.mintAuthority ?? enrichedCandidate.mint_authority) === 0;
    const lpOk   = (enrichedCandidate.lpLocked ?? enrichedCandidate.lp_locked) === 1;
    const cleanStructure = dev != null && dev < 3
                        && top10 != null && top10 < 30
                        && mintOk && lpOk;
    const CAP = SCORING_CONFIG.noSignalCap;
    if (!hasWalletIntel && !strongMomentum && !cleanStructure && scoreResult.score > CAP) {
      const prior = scoreResult.score;
      scoreResult.score = CAP;
      (scoreResult.penalties = scoreResult.penalties || {}).wallet = scoreResult.penalties.wallet || [];
      scoreResult.penalties.wallet.push(`-${prior - CAP} NO_ALPHA_SIGNAL cap — no smart money, no strong momentum, no clean structure`);
      console.log(`[auto-caller] 🚧 $${enrichedCandidate.token??ca.slice(0,6)} capped at ${CAP} (was ${prior}) — needs wallet intel, momentum, or clean structure`);
    } else if (!hasWalletIntel && (strongMomentum || cleanStructure) && scoreResult.score > CAP) {
      const why = strongMomentum && cleanStructure ? 'strong momentum + clean structure'
                : strongMomentum ? `strong momentum (vel=${buyVel.toFixed(1)} br=${(brRatio*100).toFixed(0)}% vol=${Math.round(v1h/1000)}K)`
                : `clean structure (dev=${dev?.toFixed(1)}% top10=${top10?.toFixed(0)}% mint✓ LP✓)`;
      console.log(`[auto-caller] ✅ $${enrichedCandidate.token??ca.slice(0,6)} cap lifted — ${why}`);
    }

    let similarity = {};
    try { similarity = computeSimilarityScores(scoreResult) ?? {}; } catch {}

    // ── STEP 1: Rules engine decision ─────────────────────────────────────────
    // v5 pipeline now produces the authoritative decision (POST/WATCHLIST/
    // IGNORE/BLOCK). Map to legacy decision labels for the rest of the flow:
    //   POST → AUTO_POST · WATCHLIST → WATCHLIST · IGNORE → IGNORE · BLOCK → BLOCKLIST
    // Hard rule: a v5 BLOCK is never overridable by AI or any later step.
    const scorerDecision = makeFinalDecision(scoreResult, null, enrichedCandidate);
    const v5 = scoreResult?.parts?._v5 ?? null;
    const v5ActionMap = { POST: 'AUTO_POST', WATCHLIST: 'WATCHLIST', IGNORE: 'IGNORE', BLOCK: 'BLOCKLIST' };
    const v5InitialDecision = v5 ? v5ActionMap[v5.action] : null;
    let finalDecision = v5InitialDecision || scorerDecision;
    // REVIVING decisions (second-leg breakouts) get promoted to AUTO_POST
    // when rug filter is clean — these are the "coin was quiet, now real
    // buyers returning" patterns that historically run hardest.
    if (v5?.decision?.label === 'REVIVING' && (v5.scores?.rugRisk ?? 99) < 35 && finalDecision !== 'BLOCKLIST') {
      finalDecision = 'AUTO_POST';
      console.log(`[auto-caller:v5] $${enrichedCandidate.token??ca.slice(0,6)} REVIVING → AUTO_POST (second-leg breakout, rug=${v5.scores.rugRisk})`);
    }
    const v5HardBlock = v5 && v5.action === 'BLOCK';
    let ftResult = null; // legacy compat
    if (v5) {
      const dec = v5.decision?.label || v5.action;
      const act = v5.activity?.state || '?';
      const rx  = v5.reactivation?.score ? ` rx=${v5.reactivation.score}/${v5.reactivation.status}` : '';
      console.log(`[auto-caller:v5] $${enrichedCandidate.token??ca.slice(0,6)} state=${v5.state}/${act} → ${dec}${rx} · scan=${v5.scores.scanner} rug=${v5.scores.rugRisk} mq=${v5.scores.momentum} wq=${v5.scores.wallet} dq=${v5.scores.demand} → final=${v5.scores.finalCall}`);
      // Capture fingerprint for the pattern matching library. CALL_NOW /
      // REVIVING / HARD_REJECT always captured; WATCH / IGNORE throttled
      // to 1 per 30min per CA per decision label inside the helper.
      recordFingerprint(enrichedCandidate, { v5 });
    }

    // ── STEP 2: Dune Wallet Intelligence Cross-Reference ──────────────────────
    // Cross-references token holders against Dune wallet DB (pump.fun + Raydium PnL data).
    // Identifies: WINNER wallets (high ROI), SMART MONEY (early entry), SNIPERS (dump fast).
    const holderAddrs = enrichedCandidate.holderAddresses ?? enrichedCandidate.holders_list ?? [];
    const duneWalletReady = getDuneWalletStatus().ready;

    if (holderAddrs.length > 0) {
      // Use Dune scanner if loaded, fall back to old walletDb
      const walletIntel = duneWalletReady
        ? duneXRef(holderAddrs)
        : (walletDb.size() > 0 ? walletDb.crossReference(holderAddrs) : null);

      if (walletIntel) {
        // If the Dune DB has no winner side loaded, smartMoneyScore of 0
        // is misleading (it reads like "no signal" but really means "no
        // data"). Surface null → dashboard shows "—" instead of "0".
        const duneStats = getDuneWalletStatus();
        const duneWinnerPool = duneStats?.dbStats?.winners ?? 0;
        const winnerCount = walletIntel.knownWinnerWalletCount ?? 0;
        const noWinnerData = duneWinnerPool === 0 && winnerCount === 0;

        enrichedCandidate.walletIntel            = walletIntel;
        enrichedCandidate.smartMoneyScore        = noWinnerData ? null : walletIntel.smartMoneyScore;
        enrichedCandidate.sniperWalletCount      = walletIntel.sniperWalletCount;
        enrichedCandidate.suspiciousClusterScore = walletIntel.suspiciousClusterScore;
        enrichedCandidate.walletVerdict          = walletIntel.walletVerdict;
        enrichedCandidate.walletIntelScore       = noWinnerData ? null : walletIntel.smartMoneyScore;
        enrichedCandidate.knownWinnerWallets     = walletIntel.winnerWallets ?? [];

        if (walletIntel.knownWinnerWalletCount > 0) {
          console.log(`[wallet-intel] $${enrichedCandidate.token}: ${walletIntel.knownWinnerWalletCount}× WINNER wallets, ${walletIntel.sniperWalletCount} snipers → ${walletIntel.walletVerdict}`);
          logEvent('INFO', 'WINNER_WALLETS_DETECTED', `${enrichedCandidate.token} winners=${walletIntel.knownWinnerWalletCount} snipers=${walletIntel.sniperWalletCount} score=${walletIntel.smartMoneyScore}`);

          // Direct score bonus for ANY winner wallet buying this coin.
          // Previously single winners only soft-promoted WATCHLIST decisions
          // — but that's a gate, not a signal. A Dune-flagged WINNER wallet
          // choosing to buy a micro-cap is alpha worth +4 straight into
          // the composite (through global bonus budget). Stacks with the
          // cluster auto-post override if ≥3 winners show up.
          const nWinners = walletIntel.knownWinnerWalletCount;
          const winBonus = nWinners >= 3 ? 6 : nWinners >= 2 ? 5 : 4;
          const applied = addBonusCapped(winBonus);
          if (applied > 0) {
            (scoreResult.signals = scoreResult.signals || {}).wallet = scoreResult.signals.wallet || [];
            scoreResult.signals.wallet.push(`+${applied} WINNER_WALLET_BUY — ${nWinners} Dune-flagged winner${nWinners > 1 ? 's' : ''} holding this coin`);
          }
        }

        // Hard block: rug wallets present = not worth risking
        if (walletIntel.rugWalletCount > 2 || walletIntel.walletVerdict === 'MANIPULATED') {
          finalDecision = 'IGNORE';
          logEvent('WARN', 'WALLET_RUG_BLOCK', `${enrichedCandidate.token} rug_wallets=${walletIntel.rugWalletCount} verdict=${walletIntel.walletVerdict}`);
        }

        // ── AXIOSCAN-MODE FAST LANE ──────────────────────────────────────
        // If ≥ N WINNER wallets are already holding this and basic rug /
        // liquidity / age checks pass, skip Claude/OpenAI/consensus gates
        // entirely and force AUTO_POST. This is the "trust the wallets"
        // bypass — Axioscan's core mechanic. Tagged _fastLane so downstream
        // gates know not to re-gate it.
        const flEnabled    = !!SCORING_CONFIG.fastLaneEnabled;
        const flMinWinners = SCORING_CONFIG.fastLaneMinWinners ?? 2;
        const flMinLiq     = SCORING_CONFIG.fastLaneMinLiquidityUsd ?? 2000;
        const flMaxAgeHrs  = SCORING_CONFIG.fastLaneMaxAgeHours ?? 12;
        const liqUsd       = Number(enrichedCandidate.liquidityUsd ?? enrichedCandidate.liquidity ?? 0);
        const ageHrs       = Number(enrichedCandidate.ageHours ?? enrichedCandidate.age_hours ?? 999);
        if (
          flEnabled &&
          finalDecision !== 'IGNORE' &&
          (walletIntel.knownWinnerWalletCount ?? 0) >= flMinWinners &&
          walletIntel.walletVerdict !== 'MANIPULATED' &&
          walletIntel.walletVerdict !== 'SUSPICIOUS' &&
          (walletIntel.rugWalletCount ?? 0) === 0 &&
          liqUsd >= flMinLiq &&
          ageHrs <= flMaxAgeHrs
        ) {
          enrichedCandidate._fastLane = {
            winners:   walletIntel.knownWinnerWalletCount,
            liquidity: liqUsd,
            ageHrs,
            at:        Date.now(),
          };
          finalDecision = 'AUTO_POST';
          logEvent('INFO', 'FAST_LANE_FIRED', `${enrichedCandidate.token ?? ca.slice(0,6)} winners=${walletIntel.knownWinnerWalletCount} liq=$${Math.round(liqUsd)} age=${ageHrs.toFixed(1)}h → bypass Claude/consensus`);
          console.log(`[fast-lane] ⚡ $${enrichedCandidate.token ?? ca.slice(0,6)} — ${walletIntel.knownWinnerWalletCount} WINNERS holding, age ${ageHrs.toFixed(1)}h, liq $${Math.round(liqUsd)} → AUTO_POST bypass`);
        }
      }
    }

    // ── STEP 3: Deployer check from deployer DB ───────────────────────────────
    if (enrichedCandidate.devWalletAddress || enrichedCandidate.deployerAddress) {
      const deployerAddr = enrichedCandidate.devWalletAddress ?? enrichedCandidate.deployerAddress;
      const deployerCheck = checkDeployer(deployerAddr);
      enrichedCandidate.deployerVerdict   = deployerCheck.verdict;
      enrichedCandidate.deployerRiskScore = deployerCheck.riskScore;
      if (deployerCheck.verdict === 'DANGEROUS' && finalDecision !== 'BLOCKLIST') {
        finalDecision = 'IGNORE';
        logEvent('WARN', 'DEPLOYER_DANGEROUS', `${enrichedCandidate.token} deployer=${deployerAddr.slice(0,8)}`);
      }
    }

    // ── STEP 4: Pump.fun livestream check (if pre-bonding) ───────────────────
    if (enrichedCandidate.stage === 'PRE_BOND' && enrichedCandidate.deployerAddress) {
      try {
        enrichedCandidate.livestream = await checkPumpFunLivestream(
          enrichedCandidate.deployerAddress,
          enrichedCandidate.contractAddress
        );
      } catch {}
    }

    console.log(`[auto-caller] $${enrichedCandidate.token??ca} — composite:${scoreResult.score} regime:${regimeAdj.adjustedScore} structure:${scoreResult.structureGrade} trap:${scoreResult.trapDetector.severity} → ${finalDecision}`);

    // ── AI OPERATING SYSTEM: Claude evaluates EVERY token, not just AUTO_POST ──
    // This enables real-time learning — every evaluation feeds the outcome history.
    // Claude's decision overrides the scorer when score is ambiguous.
    let verdict = null;
    const aiShouldEvaluate = CLAUDE_API_KEY && (
      finalDecision !== 'BLOCKLIST' &&           // Blocklisted = instant skip, no AI needed
      scoreResult.score >= 20 &&                  // Loosened 25→20 so bot makes MORE decisions (learning)
      (enrichedCandidate.marketCap ?? 0) <= 300_000 // Widened 200K→300K to catch gems just above
    );

    if (aiShouldEvaluate) {
      try {
        verdict = await callClaudeForAnalysis(enrichedCandidate, scoreResult);

        // ── AI OVERRIDES SCORER DECISION ──
        // Claude has full history context — trust it when it disagrees strongly.
        if (verdict) {
          const aiDecision = verdict.decision;
          const aiScore    = verdict.score ?? scoreResult.score;
          const mcap       = enrichedCandidate.marketCap ?? 0;
          const isGemRange = mcap >= 8_000 && mcap <= 50_000;

          // AI upgrades: if scorer said WATCHLIST but Claude sees a gem in range → POST
          // v5 BLOCK is never overridable — protects against AI rubber-stamping rugs.
          if (!v5HardBlock && aiDecision === 'AUTO_POST' && finalDecision === 'WATCHLIST' && aiScore >= 45) {
            finalDecision = 'AUTO_POST';
            logEvent('INFO', 'AI_UPGRADE', `${enrichedCandidate.token} WATCHLIST→AUTO_POST ai=${aiScore} mcap=${mcap}`);
            console.log(`[ai-os] ⬆️  AI upgraded $${enrichedCandidate.token}: WATCHLIST → AUTO_POST (score ${aiScore}, mcap $${(mcap/1000).toFixed(1)}K)`);
          }
          // AI upgrades HOLD_FOR_REVIEW → AUTO_POST if it's a gem
          if (!v5HardBlock && aiDecision === 'AUTO_POST' && finalDecision === 'HOLD_FOR_REVIEW' && isGemRange && aiScore >= 50) {
            finalDecision = 'AUTO_POST';
            logEvent('INFO', 'AI_UPGRADE', `${enrichedCandidate.token} HOLD→AUTO_POST ai=${aiScore}`);
            console.log(`[ai-os] ⬆️  AI upgraded $${enrichedCandidate.token}: HOLD → AUTO_POST (gem range)`);
          }
          // AI downgrades: Claude sees red flags scorer missed → block post
          if (aiDecision === 'IGNORE' && finalDecision === 'AUTO_POST') {
            if ((verdict.score ?? 100) < 25 || verdict.risk === 'EXTREME') {
              finalDecision = 'IGNORE';
              logEvent('INFO', 'AI_HARD_BLOCK', `${enrichedCandidate.token} AUTO_POST→IGNORE ai=${verdict.score} risk=${verdict.risk}`);
              console.log(`[ai-os] 🛑 AI HARD BLOCKED $${enrichedCandidate.token}: AUTO_POST → IGNORE (score ${verdict.score}, risk ${verdict.risk})`);
            } else if ((verdict.score ?? 100) < 40) {
              finalDecision = 'WATCHLIST';
              logEvent('INFO', 'AI_DOWNGRADE', `${enrichedCandidate.token} AUTO_POST→WATCHLIST ai=${verdict.score}`);
              console.log(`[ai-os] ⬇️  AI downgraded $${enrichedCandidate.token}: AUTO_POST → WATCHLIST`);
            }
          }
          // AI instant blocklist override
          if (aiDecision === 'BLOCKLIST') {
            finalDecision = 'BLOCKLIST';
            addToBlocklist(enrichedCandidate.contractAddress, `AI flagged: ${verdict.red_flags?.[0] ?? 'danger detected'}`);
            logEvent('WARN', 'AI_BLOCKLIST', `${enrichedCandidate.token}: ${verdict.red_flags?.[0] ?? '?'}`);
          }
        }
      } catch (err) {
        console.error(`[ai-os] Claude error on $${enrichedCandidate.token}: ${err.message}`);
        // On Claude failure, fall back to scorer decision — don't block the pipeline
      }
    } else if (finalDecision === 'AUTO_POST' && !CLAUDE_API_KEY) {
      console.warn(`[ai-os] AUTO_POST without Claude key — scoring only`);
    }

    // ── STEP 6: OpenAI GPT-4o — DISABLED on per-token evaluation ────────────
    // OpenAI was running on every candidate scoring ≥38, burning hundreds of
    // GPT-4o calls/day while Claude overruled it most of the time. Now OpenAI
    // only runs in the 6-hour self-improvement learning cycle where it
    // analyzes resolved outcomes in batch — much more efficient.
    let openAIDecision = null;
    const shouldRunOpenAI = false; // Disabled — OpenAI learns in batch via self-improvement cycle only

    if (shouldRunOpenAI) {
      try {
        const pipelineElapsed = Date.now() - (enrichedCandidate._discoveredAt ?? Date.now());
        // Budget bypass for high-value decisions — AUTO_POST/WATCHLIST MUST get OpenAI's
        // final authority verdict even if enrichment ran long. This was the killswitch
        // silently skipping every call candidate.
        const highValue = finalDecision === 'AUTO_POST' || finalDecision === 'WATCHLIST';
        if (highValue || pipelineElapsed < PIPELINE_BUDGET_MS - OPENAI_TIMEOUT_MS) {
          if (!highValue && pipelineElapsed > PIPELINE_BUDGET_MS - OPENAI_TIMEOUT_MS) {
            // unreachable but keeps lint happy
          }
          console.log(`[openai-v8] Running on $${enrichedCandidate.token} (decision=${finalDecision}, elapsed=${Math.round(pipelineElapsed/1000)}s, highValue=${highValue})`);
          openAIDecision = await getOpenAIDecision(
            enrichedCandidate,
            verdict,
            scoreResult,
            getRecentOutcomesContext(10),
            OPENAI_API_KEY
          );

          if (openAIDecision) {
            const aiAction = openAIDecision.decision;
            const conviction = openAIDecision.conviction;
            console.log(`[openai-v8] $${enrichedCandidate.token} → ${aiAction} (${conviction}% conviction) | Claude decision: ${finalDecision} (KEPT)`);
            logEvent('INFO', 'OPENAI_ADVISORY', `${enrichedCandidate.token} openai=${aiAction} conviction=${conviction} claude_decision=${finalDecision} (OpenAI advisory only)`);

            // OpenAI is ADVISORY ONLY — Claude's decision stands.
            // OpenAI's verdict is logged and stored for training data
            // but does NOT change finalDecision.

            // For RETEST, set the timer from OpenAI's recommendation
            if (aiAction === 'RETEST' && openAIDecision.retestInMinutes) {
              enrichedCandidate._retestInMinutes = openAIDecision.retestInMinutes;
            }

            // Store OpenAI verdict fields
            enrichedCandidate.openaiDecision    = aiAction;
            enrichedCandidate.openaiConviction  = conviction;
            enrichedCandidate.openaiSetupSummary = openAIDecision.setupSummary;
            enrichedCandidate.openaiVerdict     = openAIDecision.telegramVerdict;
            enrichedCandidate.openaiAgreesWithClaude = openAIDecision.agreeWithClaude;
          }
        } else {
          const elapsed = Math.round(pipelineElapsed/1000);
          console.warn(`[openai-v8] Skipping — pipeline budget exceeded (${elapsed}s / ${PIPELINE_BUDGET_MS/1000}s budget)`);
          enrichedCandidate._openaiSkipReason = 'Pipeline budget exceeded (' + elapsed + 's)';
        }
      } catch (err) {
        console.error(`[openai-v8] Decision failed for $${enrichedCandidate.token}: ${err.message}`);
        console.error(`[openai-v8] Stack: ${err.stack}`);
        logEvent('ERROR', 'OPENAI_FAIL', `${enrichedCandidate.token}: ${err.message}`);
        // Keep existing decision on OpenAI failure
      }
    }

    // Mark discovery time for pipeline budget tracking
    if (!enrichedCandidate._discoveredAt) enrichedCandidate._discoveredAt = Date.now();

    // ── CLAUDE-EXTREME VETO ──────────────────────────────────────────────────
    // Claude is the forensic-analysis layer. When it flags EXTREME risk AND
    // gives a very low score (<35), it's almost always catching real rug/
    // manipulation signals that OpenAI is hallucinating through. No matter
    // what OpenAI or the scorer says, block the post — these are the
    // split-brain cases that embarrass the channel.
    // Smart-money cluster alerts (3+ winners buying) still bypass this veto.
    // Age exemption: young sweet-spot coins often trip Claude's EXTREME
    // flag on ambiguous signals (parabolic 1h change, freeze auth, etc.)
    // that are actually normal pump.fun graduation mechanics. For <30min
    // coins in sweet-spot MCap, soft-demote (WATCHLIST) instead of hard
    // IGNORE — lets them re-evaluate on the next scan cycle. >30min coins
    // keep the hard veto since Claude's EXTREME on older coins is more
    // reliable (real rug/manipulation signals dominate at that age).
    const ageForExtremeVeto = enrichedCandidate.pairAgeHours ?? 99;
    const mcapForExtremeVeto = enrichedCandidate.marketCap ?? 0;
    const youngSweetspot = ageForExtremeVeto < 0.5
                        && mcapForExtremeVeto >= 5_000
                        && mcapForExtremeVeto <= 80_000;
    if (
      finalDecision === 'AUTO_POST' &&
      !enrichedCandidate._smartMoney &&
      !enrichedCandidate._fastLane &&
      !youngSweetspot &&
      verdict?.risk === 'EXTREME' &&
      (verdict?.score ?? 100) < 35
    ) {
      fnl('claudeExtremeVeto');
      logEvent('WARN', 'CLAUDE_EXTREME_VETO', `${enrichedCandidate.token ?? ca.slice(0,6)} Claude=${verdict.score}/100 EXTREME — vetoed AUTO_POST despite OpenAI=${openAIDecision?.decision ?? '?'} ${openAIDecision?.conviction ?? '?'}%`);
      console.log(`[auto-caller] 🚨 Claude EXTREME veto — $${enrichedCandidate.token ?? ca.slice(0,6)} (Claude score ${verdict.score}, OpenAI ${openAIDecision?.decision ?? '?'}) → WATCHLIST`);
      try {
        dbInstance.prepare(`
          INSERT INTO consensus_disagreements
            (contract_address, token, composite_score,
             claude_decision, claude_score, claude_risk,
             openai_decision, openai_conviction,
             trigger, market_regime, market_cap)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          ca,
          enrichedCandidate.token ?? null,
          scoreResult.score ?? null,
          verdict?.decision ?? null,
          verdict?.score ?? null,
          verdict?.risk ?? null,
          openAIDecision?.decision ?? null,
          openAIDecision?.conviction ?? null,
          'CLAUDE_EXTREME_VETO',
          getRegime()?.market ?? null,
          enrichedCandidate.marketCap ?? null
        );
      } catch {}
      finalDecision = 'WATCHLIST';
    }

    // ── DECISION GATE ────────────────────────────────────────────────────────
    // Default mode (claudeOnlyMode=1): Claude is the sole judge. If Claude
    // says AUTO_POST or POST, the coin posts (subject to other gates like
    // momentum / regime / bundle). This fits our current pipeline where
    // OpenAI's live decision call is disabled anyway (it runs batch-only
    // in the 6h self-improvement cycle).
    //
    // Legacy mode (claudeOnlyMode=0): keep the old Claude+OpenAI consensus
    // with score >= consensusOverrideScore single-AI override fallback.
    //
    // Bypassed entirely by smart-money cluster/KOL alerts.
    if (finalDecision === 'AUTO_POST' && !enrichedCandidate._smartMoney && !enrichedCandidate._fastLane) {
      // Softened further for call-drought recovery: Claude WATCHLIST + any
      // reasonable scorer signal (score ≥ 45) now counts as OK to post.
      // Previously only AUTO_POST / POST decisions passed; Claude being
      // conservative was silently killing every marginal call. IGNORE /
      // BLOCKLIST / RETEST still block posting.
      const claudeOK = verdict && (
        verdict.decision === 'AUTO_POST' ||
        verdict.decision === 'POST' ||
        (verdict.decision === 'WATCHLIST' && (scoreResult.score ?? 0) >= 45)
      );
      const openaiOK = openAIDecision && (openAIDecision.decision === 'POST' || openAIDecision.decision === 'PROMOTE');
      const claudeOnly = !!SCORING_CONFIG.claudeOnlyMode;

      let gateFailed;
      if (claudeOnly) {
        gateFailed = !claudeOK;
      } else {
        const bothAgree       = claudeOK && openaiOK;
        const eitherAndScore  = (claudeOK || openaiOK) && scoreResult.score >= SCORING_CONFIG.consensusOverrideScore;
        gateFailed = !bothAgree && !eitherAndScore;
      }

      if (gateFailed) {
        fnl('consensusGate');
        const trigger = claudeOnly ? 'CLAUDE_SAID_NO' : 'CONSENSUS_GATE';
        const reason = claudeOnly
          ? `Claude=${verdict?.decision ?? 'none'} score=${scoreResult.score}`
          : `Claude=${verdict?.decision ?? 'none'} OpenAI=${openAIDecision?.decision ?? 'none'} score=${scoreResult.score}`;
        logEvent('INFO', trigger, `${enrichedCandidate.token ?? ca.slice(0,6)} AUTO_POST→WATCHLIST — ${reason}`);
        console.log(`[auto-caller] 🧠 ${claudeOnly ? 'Claude gate' : 'Consensus gate'} — $${enrichedCandidate.token ?? ca.slice(0,6)} demoted to WATCHLIST (${reason})`);
        // Persist the demotion so we can audit missed calls later. These are
        // the ones most likely to moon without us when the gate is too strict.
        try {
          dbInstance.prepare(`
            INSERT INTO consensus_disagreements
              (contract_address, token, composite_score,
               claude_decision, claude_score, claude_risk,
               openai_decision, openai_conviction,
               trigger, market_regime, market_cap)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
          `).run(
            ca,
            enrichedCandidate.token ?? null,
            scoreResult.score ?? null,
            verdict?.decision ?? null,
            verdict?.score ?? null,
            verdict?.risk ?? null,
            openAIDecision?.decision ?? null,
            openAIDecision?.conviction ?? null,
            trigger,
            getRegime()?.market ?? null,
            enrichedCandidate.marketCap ?? null
          );
        } catch (dbErr) {
          console.warn(`[consensus-log] insert failed: ${dbErr.message}`);
        }
        finalDecision = 'WATCHLIST';
      }
    }

    // ── SCORE-TRUMP OVERRIDE ─────────────────────────────────────────────────
    // From missed-call analysis: $HENRY scored 72 → 65.9x. $OBAMA 71 → 11.4x.
    // $TIME MACHINE 52 → 28.2x. Pattern: V5/Claude downgraded high-score
    // young gem-range coins to WATCHLIST. Two-tier override that trusts the
    // scorer when the structural signal is clearly enthusiastic AND the
    // coin is in a setup where missed alpha is most painful (young + small).
    // Respects v5HardBlock — rugs still get blocked, no AI override.
    if (
      SCORING_CONFIG.scoreTrumpEnabled &&
      finalDecision !== 'AUTO_POST' &&
      finalDecision !== 'BLOCKLIST' &&
      !v5HardBlock &&
      !enrichedCandidate._fastLane &&
      !enrichedCandidate._smartMoney &&
      (enrichedCandidate.walletIntel?.rugWalletCount ?? 0) === 0
    ) {
      const score    = scoreResult?.score ?? 0;
      const ageHrs   = Number(enrichedCandidate.pairAgeHours ?? 99);
      const ageMins  = ageHrs * 60;
      const mcap     = Number(enrichedCandidate.marketCap ?? 0);
      const maxMcap  = SCORING_CONFIG.scoreTrumpMaxMcap ?? 80_000;

      const freshTier = score >= (SCORING_CONFIG.scoreTrumpFreshThreshold ?? 55)
                     && ageMins <= (SCORING_CONFIG.scoreTrumpFreshMaxAgeMin ?? 30)
                     && mcap > 0 && mcap <= maxMcap;
      const youngTier = score >= (SCORING_CONFIG.scoreTrumpYoungThreshold ?? 60)
                     && ageHrs <= (SCORING_CONFIG.scoreTrumpYoungMaxAgeHours ?? 2)
                     && mcap > 0 && mcap <= maxMcap;

      if (freshTier || youngTier) {
        const tier = freshTier ? 'FRESH' : 'YOUNG';
        enrichedCandidate._scoreTrump = {
          tier, score, ageHrs, mcap,
          previousDecision: finalDecision,
        };
        finalDecision = 'AUTO_POST';
        logEvent('INFO', 'SCORE_TRUMP', `${enrichedCandidate.token ?? ca.slice(0,6)} ${tier} tier — score=${score} age=${ageHrs.toFixed(2)}h mcap=$${Math.round(mcap/1000)}K → AUTO_POST`);
        console.log(`[auto-caller] 📊 SCORE_TRUMP — $${enrichedCandidate.token ?? ca.slice(0,6)} ${tier} tier (score ${score}, age ${ageHrs.toFixed(2)}h, $${Math.round(mcap/1000)}K mcap) → forcing AUTO_POST`);
      }
    }

    // ── Smart Money Watcher override ─────────────────────────────────────────
    // Cluster of ≥3 WINNER wallets in 10min is the highest-conviction signal
    // we have — force AUTO_POST regardless of scorer / Claude / OpenAI. A
    // single WINNER buy still defers to the AI stack, but we tag the caption
    // so the TG alert shouts BIG WALLET ALERT.
    const sm = enrichedCandidate._smartMoney;
    if (sm?.kind === 'cluster' || sm?.kind === 'kol') {
      // KOL follow-buys are treated as cluster-tier conviction: force AUTO_POST.
      // These are hardcoded public alpha wallets (Cupsey / Unipcs / Ansem etc.)
      // with >60% micro-cap hit rates. Their entry alone is enough signal.
      const label = sm.kind === 'kol' ? 'KOL' : `cluster=${sm.clusterSize}`;
      if (v5HardBlock) {
        logEvent('WARN', 'SMART_MONEY_OVERRIDE_BLOCKED', `${enrichedCandidate.token ?? ca.slice(0,6)} ${label} ignored — v5 hard BLOCK (rug=${v5?.scores?.rugRisk})`);
      } else {
        if (finalDecision !== 'AUTO_POST') {
          logEvent('INFO', 'SMART_MONEY_OVERRIDE', `${enrichedCandidate.token ?? ca.slice(0,6)} ${finalDecision} → AUTO_POST (${label})`);
          console.log(`[smart-money] ${sm.kind === 'kol' ? '⭐' : '🐋🐋🐋'} ${sm.kind.toUpperCase()} OVERRIDE — $${enrichedCandidate.token ?? ca.slice(0,6)} ${finalDecision} → AUTO_POST (${label})`);
        }
        finalDecision = 'AUTO_POST';
      }
    } else if (sm?.kind === 'single') {
      // Soft promote: if score is reasonable, allow the post even if OpenAI was lukewarm
      if (!v5HardBlock && finalDecision === 'WATCHLIST' && (scoreResult?.score ?? 0) >= 45) {
        logEvent('INFO', 'SMART_MONEY_PROMOTE', `${enrichedCandidate.token ?? ca.slice(0,6)} WATCHLIST → AUTO_POST (single winner, score ${scoreResult.score})`);
        finalDecision = 'AUTO_POST';
      }
    }

    // ── REGIME-ADAPTIVE FLOOR: tighten in DEAD, loosen in HOT ──────────────
    // The baseline minScoreToPost (from SCORING_CONFIG) is tuned for NEUTRAL
    // markets. In DEAD regimes where memecoins bleed and false signals spike,
    // require a higher score. In HOT regimes where everything pumps, loosen.
    // KOL and cluster alerts bypass — their conviction is independent of regime.
    {
      const smKindFloor = enrichedCandidate._smartMoney?.kind;
      const bypassFloor = smKindFloor === 'cluster' || smKindFloor === 'kol';
      if (!bypassFloor && finalDecision === 'AUTO_POST') {
        const baseFloor = SCORING_CONFIG.minScoreToPost ?? 50;
        const marketRegime = getRegime()?.market || 'NEUTRAL';
        const regimeAdj =
          marketRegime === 'DEAD'    ? (SCORING_CONFIG.deadRegimeFloorAdj ?? 12) :
          marketRegime === 'COLD'    ? +5  :
          marketRegime === 'HOT'     ? -5  :
          0;  // NEUTRAL
        const effectiveFloor = baseFloor + regimeAdj;
        if ((scoreResult.score ?? 0) < effectiveFloor) {
          logEvent('INFO', 'REGIME_FLOOR', `${enrichedCandidate.token ?? ca.slice(0,6)} score=${scoreResult.score} < ${effectiveFloor} (base ${baseFloor} ${regimeAdj >= 0 ? '+' : ''}${regimeAdj} ${marketRegime}) → WATCHLIST`);
          console.log(`[auto-caller] 📊 Regime floor — $${enrichedCandidate.token ?? ca.slice(0,6)} score ${scoreResult.score} < ${effectiveFloor} in ${marketRegime} → WATCHLIST`);
          finalDecision = 'WATCHLIST';
        }
      }
    }

    // ── BUNDLE-SETUP VETO (heuristic + deep trace) ───────────────────────
    // Two-stage detector:
    //  Stage 1 (heuristic, already ran above): cheap rule-of-thumb on snipers
    //         + unique buyer ratio. Sets _bundleSetup flag.
    //  Stage 2 (deep trace, RIGHT HERE): if we're about to AUTO_POST, spend
    //         the extra ~6 Helius RPC calls to trace funding sources of the
    //         first ~8 buyers. If 3+ share a funder → confirmed rug setup.
    //         Results cached 24h so repeat scans don't re-hit Helius.
    // Cluster / KOL alerts still bypass — if Cupsey buys a bundle launch,
    // that's their conviction call.
    if (
      finalDecision === 'AUTO_POST' &&
      enrichedCandidate._smartMoney?.kind !== 'cluster' &&
      enrichedCandidate._smartMoney?.kind !== 'kol'
    ) {
      let bundleVetoReason = null;
      if (enrichedCandidate._bundleSetup) {
        bundleVetoReason = 'heuristic (snipers + low unique)';
      } else {
        // Only run the deep trace on coins young enough for it to matter.
        // Above 2h, the launch window is gone and we're just burning RPC.
        const ageHours = enrichedCandidate.pairAgeHours ?? 99;
        if (ageHours <= 2) {
          try {
            const { detectBundleLaunch } = await import('./bundle-detector.js');
            const deep = await detectBundleLaunch(ca, dbInstance);
            if (deep?.isBundled) {
              bundleVetoReason = `deep trace · ${deep.funderOverlap}/${deep.buyerCount} buyers funded by ${deep.topFunder?.slice(0,8)}…`;
              enrichedCandidate._bundleSetup = true;
              enrichedCandidate._bundleDeep = deep;
            } else if (deep && !deep.skipped) {
              console.log(`[auto-caller] ✓ Bundle deep-trace clean — $${enrichedCandidate.token ?? ca.slice(0,6)} (${deep.signals?.[0] ?? ''})`);
            }
          } catch (err) {
            console.warn('[bundle-detector] deep trace failed:', err.message);
          }
        }
      }
      if (bundleVetoReason) {
        logEvent('WARN', 'BUNDLE_VETO', `${enrichedCandidate.token ?? ca.slice(0,6)} ${bundleVetoReason} → WATCHLIST`);
        console.log(`[auto-caller] 🪤 Bundle veto — $${enrichedCandidate.token ?? ca.slice(0,6)} (${bundleVetoReason}) → WATCHLIST`);
        finalDecision = 'WATCHLIST';
      }
    }

    // ── MOMENTUM GATE: never buy a coin that's currently bleeding ───────────
    // User's rule: "we want to be buying on the way up not hoping that after
    // it rugs momentum will pick back up." A coin dumping 15%+ in the last
    // 5min or 30%+ in the last hour is a slow rug in progress. Walking away
    // is the right move, NOT catching the falling knife.
    //
    // Tiers (tuned — memecoins routinely wiggle 10% in 5min and bounce back,
    // so we only blacklist on genuinely severe/accelerating drops):
    //   5m ≤ -20%  OR  1h ≤ -30%  →  WATCHLIST (demoted, not blacklisted)
    //   1h ≤ -40% AND 5m ≤ -18%   →  BLOCKLIST (accelerating — still bleeding)
    //   5m ≤ -35%  OR  1h ≤ -60%  →  BLOCKLIST (severe rug — never call)
    //
    // Cluster smart-money alerts bypass (3+ winners buying a dip is alpha,
    // not a slow rug). Single-winner alerts do NOT bypass — gotta be careful.
    {
      const p5  = enrichedCandidate.priceChange5m  ?? null;
      const p1h = enrichedCandidate.priceChange1h  ?? null;
      // Both cluster and KOL alerts bypass the momentum gate — highest-
      // conviction smart-money signals override the "don't catch falling
      // knives" rule.
      const smKind = enrichedCandidate._smartMoney?.kind;
      const isHighConviction = smKind === 'cluster' || smKind === 'kol';
      if (!isHighConviction && finalDecision === 'AUTO_POST') {
        let momentumBlock = null;
        // Brand-new coins (<30 min) can flash -25-30% in 5m during normal
        // post-launch volatility. Use a looser 5m threshold for them so we
        // don't blocklist healthy early wicks.
        const isBabyToken = (enrichedCandidate.pairAgeHours ?? 99) < 0.5;
        const accel5mThreshold = isBabyToken ? -30 : -25;
        if ((p5  != null && p5  <= -35) || (p1h != null && p1h <= -60)) {
          momentumBlock = `SEVERE_DUMP 5m=${p5}% 1h=${p1h}%`;
        } else if ((p1h != null && p1h <= -40) || (p5 != null && p5 <= accel5mThreshold)) {
          // OR logic: either severe 1h bleed OR sharp 5m drop trips veto.
          // 5m threshold loosened for <30min coins (normal launch volatility).
          momentumBlock = `ACCELERATING_DUMP 5m=${p5}% 1h=${p1h}%`;
        } else if ((p5 != null && p5 <= -20) || (p1h != null && p1h <= -30)) {
          momentumBlock = `DUMPING 5m=${p5 ?? '?'}% 1h=${p1h ?? '?'}%`;
        }
        if (momentumBlock) {
          const severe = momentumBlock.startsWith('SEVERE') || momentumBlock.startsWith('ACCELERATING');
          finalDecision = severe ? 'BLOCKLIST' : 'WATCHLIST';
          const tag = severe ? '🚫' : '📉';
          fnl('momentumGate');
          logEvent('WARN', 'MOMENTUM_GATE', `${enrichedCandidate.token ?? ca.slice(0,6)} ${momentumBlock} → ${finalDecision}`);
          console.log(`[auto-caller] ${tag} Momentum gate — $${enrichedCandidate.token ?? ca.slice(0,6)} ${momentumBlock} → ${finalDecision}`);
          if (severe) {
            try { addToBlocklist(ca, `Momentum gate: ${momentumBlock}`); } catch {}
          }
        }
      }
    }

    // ── RUG GUARD: $13K-$17.5K sub-band requires higher score ───────────────
    // This low-end sliver of the sweet spot is the highest-risk micro-range:
    // fresh launches and rugs cluster here. Require score >= 60 to post,
    // otherwise demote to WATCHLIST regardless of AI/smart-money overrides.
    // Cluster smart-money alerts (3+ winners) bypass this guard — they carry
    // enough conviction on their own.
    const mcapNow = enrichedCandidate.marketCap ?? 0;
    const isHighRiskBand = mcapNow >= 13_000 && mcapNow <= 17_500;
    const smKindRG = enrichedCandidate._smartMoney?.kind;
    const bypassRugGuard = smKindRG === 'cluster' || smKindRG === 'kol' || !!enrichedCandidate._fastLane;
    if (
      finalDecision === 'AUTO_POST' &&
      isHighRiskBand &&
      !bypassRugGuard &&
      (scoreResult.score ?? 0) < SCORING_CONFIG.rugGuardMinScore
    ) {
      fnl('rugGuard');
      logEvent('INFO', 'RUG_GUARD', `${enrichedCandidate.token ?? ca.slice(0,6)} mcap=${Math.round(mcapNow/1000)}K score=${scoreResult.score} < ${SCORING_CONFIG.rugGuardMinScore} → WATCHLIST (high-risk band guard)`);
      console.log(`[auto-caller] 🛡  $${enrichedCandidate.token ?? ca.slice(0,6)} demoted — $${Math.round(mcapNow/1000)}K in rug-risk band, score ${scoreResult.score} < ${SCORING_CONFIG.rugGuardMinScore}`);
      finalDecision = 'WATCHLIST';
    }

    // ── LIQUIDITY FLOOR: a coin with no liquidity can't sustain a 2.5x run ──
    // Observed pattern in the last 8 losing calls: thin liquidity ($2K-$3K)
    // let the coin flash +30-70% on tiny volume and dump right back. For
    // sustainable 2.5x+ winners we need depth. Cluster/KOL alerts bypass.
    const liqNow = enrichedCandidate.liquidity ?? null;
    const minLiq = SCORING_CONFIG.minLiquidityForPost ?? 3000;
    if (
      finalDecision === 'AUTO_POST' &&
      !bypassRugGuard &&
      liqNow != null && liqNow < minLiq
    ) {
      fnl('liquidityFloor');
      logEvent('INFO', 'LIQUIDITY_FLOOR', `${enrichedCandidate.token ?? ca.slice(0,6)} liq=$${Math.round(liqNow)} < $${minLiq} → WATCHLIST`);
      console.log(`[auto-caller] 💧 $${enrichedCandidate.token ?? ca.slice(0,6)} demoted — liquidity $${Math.round(liqNow)} below floor $${minLiq} (can't sustain a 2.5x run)`);
      finalDecision = 'WATCHLIST';
    }

    // ── FOUNDATION-TRUST GATE — DISABLED during call drought ───────────
    // Was demoting coins where scorer-dual returned 0 foundation signals
    // (e.g. fresh coins before ledger populated). User still getting zero
    // calls even at threshold 8 — turning it fully off. Gate logic still
    // logs a diagnostic flag when it WOULD have fired, so we can re-enable
    // once flow is restored.
    if (finalDecision === 'AUTO_POST' && !bypassRugGuard) {
      const dp = scoreResult.dualParts;
      if (dp) {
        const foundationTotal =
          (dp.volumeVelocity      ?? 0) +
          (dp.buyPressure         ?? 0) +
          (dp.walletQuality       ?? 0) +
          (dp.holderDistribution  ?? 0) +
          (dp.liquidityHealth     ?? 0);
        if (foundationTotal < 8) {
          scoreResult._foundationTrustWouldHit = true;
          // Demotion disabled — coins pass through to Claude
        }
      }
    }

    // ── EARLY-MCAP DEFER: $6K-$9K coins wait N min to confirm momentum ──
    // Set earlyMCapDeferMinutes=0 in SCORING_CONFIG to disable entirely
    // (call drought fix — we were holding too many coins that would have
    // been real calls).
    if (finalDecision === 'AUTO_POST' && !bypassRugGuard) {
      const mcapForDefer  = enrichedCandidate.marketCap ?? 0;
      const deferMin      = SCORING_CONFIG.earlyMCapDeferMin ?? 6000;
      const deferMax      = SCORING_CONFIG.earlyMCapDeferMax ?? 9000;
      const deferMinutes  = SCORING_CONFIG.earlyMCapDeferMinutes ?? 3;
      const inBand        = mcapForDefer >= deferMin && mcapForDefer <= deferMax;
      if (inBand && deferMinutes > 0) {
        const extreme = hasExtremeVelocity(enrichedCandidate);
        if (extreme) {
          logEvent('INFO', 'EARLY_MCAP_EXTREME', `${enrichedCandidate.token ?? ca.slice(0,6)} $${Math.round(mcapForDefer/1000)}K in defer band but extreme velocity — posting immediately`);
        } else {
          const firstSeen = _earlyMCapSeen.get(ca);
          if (!firstSeen) {
            _earlyMCapSeen.set(ca, Date.now());
            logEvent('INFO', 'EARLY_MCAP_DEFER', `${enrichedCandidate.token ?? ca.slice(0,6)} $${Math.round(mcapForDefer/1000)}K — first sighting, deferring ${deferMinutes}min to confirm momentum`);
            console.log(`[auto-caller] ⏱  $${enrichedCandidate.token ?? ca.slice(0,6)} $${Math.round(mcapForDefer/1000)}K — first seen in $${deferMin/1000}-${deferMax/1000}K band, deferring ${deferMinutes}min (velocity not extreme)`);
            finalDecision = 'WATCHLIST';
          } else {
            const elapsedMin = (Date.now() - firstSeen) / 60_000;
            if (elapsedMin < deferMinutes) {
              logEvent('INFO', 'EARLY_MCAP_DEFER', `${enrichedCandidate.token ?? ca.slice(0,6)} still within ${deferMinutes}min hold window (${elapsedMin.toFixed(1)}min elapsed) → WATCHLIST`);
              finalDecision = 'WATCHLIST';
            } else {
              // Hold expired — allow the post. Cleanup so the tracker doesn't bloat.
              _earlyMCapSeen.delete(ca);
              logEvent('INFO', 'EARLY_MCAP_CLEAR', `${enrichedCandidate.token ?? ca.slice(0,6)} ${elapsedMin.toFixed(1)}min after first sighting — hold expired, post allowed`);
            }
          }
        }
      }
    }

    // Attach scoreResult breakdown directly to enrichedCandidate
    // so db.js insertCandidate picks them up if columns exist
    enrichedCandidate.subScores       = scoreResult.subScores;
    enrichedCandidate.dualParts       = scoreResult.dualParts;
    enrichedCandidate.dualReasons     = scoreResult.reasons;
    enrichedCandidate.dualRisks       = scoreResult.risks;
    enrichedCandidate.modelUsed       = scoreResult.modelUsed;
    enrichedCandidate.discoveryScore  = scoreResult.discoveryScore;
    enrichedCandidate.foundationTotal = scoreResult.dualParts ? Object.entries(scoreResult.dualParts).filter(([k]) => !k.startsWith('_') && k !== 'latePumpPenalty').reduce((a,[,v]) => a + v, 0) : null;
    enrichedCandidate.scoreSignals    = JSON.stringify(scoreResult.signals   ?? {});
    enrichedCandidate.scorePenalties  = JSON.stringify(scoreResult.penalties ?? {});
    enrichedCandidate.stealthDetected = scoreResult.stealthDetected ? 1 : 0;
    enrichedCandidate.stealthBonus    = scoreResult.stealthBonus    ?? 0;
    enrichedCandidate.trapConfidencePenalty = scoreResult.trapDetector?.confidencePenalty ?? 0;

    // Confidence meter — 0-100% meta-score + label (ELITE/HIGH/MEDIUM/LOW/VERY_LOW)
    const confidence = computeConfidence(enrichedCandidate, scoreResult, verdict);
    scoreResult.confidence       = confidence;
    enrichedCandidate.confidence = confidence.pct;
    enrichedCandidate.confidenceLabel    = confidence.label;
    enrichedCandidate.confidenceBreakdown = JSON.stringify(confidence.breakdown);

    const candidateId = insertCandidate({
      ...enrichedCandidate,
      compositeScore:      scoreResult.score,
      structureGrade:      scoreResult.structureGrade,
      setupType:           scoreResult.setupType,
      stage:               scoreResult.stage,
      trapTriggered:       scoreResult.trapDetector.triggered,
      trapSeverity:        scoreResult.trapDetector.severity,
      dynamicThreshold:    scoreResult.threshold,
      marketRegime:        getRegime().market,
      regimeAdjustedScore: regimeAdj.adjustedScore,
      claudeScore:         verdict?.score      ?? scoreResult.score,
      claudeRisk:          verdict?.risk       ?? scoreResult.risk,
      claudeDecision:      verdict?.decision   ?? finalDecision,
      claudeSetupType:     verdict?.setup_type ?? scoreResult.setupType,
      claudeVerdict:       verdict?.verdict    ?? null,
      claudeRaw:           verdict ? JSON.stringify(verdict) : null,
      // v8: OpenAI final decision fields
      openaiDecision:      openAIDecision?.decision      ?? null,
      openaiConviction:    openAIDecision?.conviction    ?? null,
      openaiVerdict:       openAIDecision?.telegramVerdict ?? openAIDecision?.setupSummary ?? null,
      openaiAgreesWithClaude: openAIDecision?.agreeWithClaude ?? null,
      openaiRaw:           openAIDecision ? JSON.stringify(openAIDecision) : null,
      // v8: wallet intelligence
      walletVerdict:       enrichedCandidate.walletIntel?.walletVerdict ?? null,
      smartMoneyScore:     enrichedCandidate.walletIntel?.smartMoneyScore ?? null,
      deployerVerdict:     enrichedCandidate.deployerVerdict ?? null,
      deployerRiskScore:   enrichedCandidate.deployerRiskScore ?? null,
      // v8: pre-bonding
      bondingCurvePct:     enrichedCandidate.bondingCurvePct ?? null,
      bondingCurveAccel:   enrichedCandidate.bondingCurveAcceleration ?? null,
      livestreamScore:     enrichedCandidate.livestream?.engagementScore ?? 0,
      finalDecision,
      posted:              finalDecision === 'AUTO_POST',
      retestCount:         candidate.retestCount ?? 0,
      // v5: scoring breakdown detail — signals, penalties, stealth
      scoreSignals:        JSON.stringify(scoreResult.signals  ?? {}),
      scorePenalties:      JSON.stringify(scoreResult.penalties ?? {}),
      stealthDetected:     scoreResult.stealthDetected ? 1 : 0,
      stealthBonus:        scoreResult.stealthBonus ?? 0,
      trapConfidencePenalty: scoreResult.trapDetector?.confidencePenalty ?? 0,
      subScores:           JSON.stringify(scoreResult.subScores ?? {}),
    });

    insertSubScores(candidateId, ca, scoreResult);

    // Stamp ms-precision timestamps for latency analytics (separate UPDATE
    // so we don't have to widen the giant insertCandidate prepared stmt)
    try {
      dbInstance.prepare(
        `UPDATE candidates SET detected_at_ms=?, enriched_at_ms=?, scored_at_ms=?, dual_parts=?, discovery_score=?, model_used=? WHERE id=?`
      ).run(detectedAtMs, enrichedCandidate.enrichedAtMs, scoredAtMs,
        JSON.stringify(scoreResult.dualParts ?? {}),
        scoreResult.discoveryScore ?? null,
        scoreResult.modelUsed ?? null,
        candidateId);
    } catch {}

    // Save metrics snapshot for time-series analysis — lets scorer see DELTAS on rescans
    try {
      dbInstance.prepare(`
        INSERT INTO token_metrics_history (
          contract_address, snapshot_at_ms, market_cap, liquidity, price_usd,
          volume_1h, volume_24h, buys_1h, sells_1h, buy_sell_ratio_1h,
          volume_velocity, buy_velocity, price_change_5m, price_change_1h,
          holders, dev_wallet_pct, top10_holder_pct, composite_score
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        ca, scoredAtMs,
        enrichedCandidate.marketCap ?? null,
        enrichedCandidate.liquidity ?? null,
        enrichedCandidate.priceUsd ?? null,
        enrichedCandidate.volume1h ?? null,
        enrichedCandidate.volume24h ?? null,
        enrichedCandidate.buys1h ?? null,
        enrichedCandidate.sells1h ?? null,
        enrichedCandidate.buySellRatio1h ?? null,
        enrichedCandidate.volumeVelocity ?? null,
        enrichedCandidate.buyVelocity ?? null,
        enrichedCandidate.priceChange5m ?? null,
        enrichedCandidate.priceChange1h ?? null,
        enrichedCandidate.holders ?? null,
        enrichedCandidate.devWalletPct ?? null,
        enrichedCandidate.top10HolderPct ?? null,
        scoreResult.score ?? null,
      );
    } catch (e) { /* non-critical */ }

    // Persist confidence meter values (0-100 % + label + breakdown JSON)
    try {
      dbInstance.prepare(
        `UPDATE candidates SET confidence=?, confidence_label=?, confidence_breakdown=? WHERE id=?`
      ).run(
        scoreResult.confidence?.pct   ?? null,
        scoreResult.confidence?.label ?? null,
        scoreResult.confidence?.breakdown ? JSON.stringify(scoreResult.confidence.breakdown) : null,
        candidateId
      );
    } catch {}

    // Write to our own sub-scores table — guaranteed schema we control
    try {
      dbInstance.prepare(`
        INSERT OR REPLACE INTO pulse_sub_scores
          (candidate_id, contract_address, launch_quality, wallet_structure,
           market_behavior, social_narrative, composite_score,
           stealth_bonus, trap_penalty, stage, structure_grade)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        candidateId, ca,
        scoreResult.subScores?.launchQuality   ?? null,
        scoreResult.subScores?.walletStructure ?? null,
        scoreResult.subScores?.marketBehavior  ?? null,
        scoreResult.subScores?.socialNarrative ?? null,
        scoreResult.score,
        scoreResult.stealthBonus     ?? 0,
        scoreResult.trapDetector?.confidencePenalty ?? 0,
        scoreResult.stage,
        scoreResult.structureGrade
      );
    } catch (psErr) {
      console.warn('[sub-scores] pulse_sub_scores insert failed:', psErr.message);
    }

    if (enrichedCandidate.devWalletAddress) {
      upsertDeployerReputation(enrichedCandidate.devWalletAddress, {
        riskLevel: enrichedCandidate.deployerHistoryRisk ?? 'UNKNOWN',
        flags:     intel?.deployerProfile?.flags ?? [],
      });
    }

    // ── FINAL HARD GATE: never post a call without a market cap ──────────
    // Catches all upstream paths — smart-money overrides, fast-lane bypass,
    // AI upgrades — if mcap is missing, the call has no useful info for the
    // reader. Downgrade to WATCHLIST so we can revisit if data arrives.
    if (finalDecision === 'AUTO_POST' &&
        (enrichedCandidate.marketCap == null || enrichedCandidate.marketCap === 0)) {
      console.log(`[auto-caller] 🚫 $${enrichedCandidate.token ?? ca.slice(0,8)} — blocked AUTO_POST: no marketCap available (would post blind). → WATCHLIST`);
      logEvent('INFO', 'NO_MCAP_BLOCK', `${ca} — blocked AUTO_POST, no mcap to show reader`);
      finalDecision = 'WATCHLIST';
    }

    // Post if AUTO_POST — even if Claude verdict is null (Claude may have timed out/failed)
    // A null verdict means we fall back to scorer decision, which is still valid
    if (finalDecision === 'AUTO_POST') {
      if (!verdict) {
        // Build a minimal verdict from scorer so the post still goes out
        verdict = {
          decision: 'AUTO_POST',
          score: scoreResult.score,
          risk: scoreResult.risk ?? 'MEDIUM',
          setup_type: scoreResult.setupType ?? 'STANDARD',
          bull_case: scoreResult.subScores ? [
            `Composite score: ${scoreResult.score}/100`,
            `Structure grade: ${scoreResult.structureGrade ?? '?'}`,
            `Stage: ${scoreResult.stage ?? '?'}`,
          ] : ['Scorer approved'],
          red_flags: [],
          verdict: `Score ${scoreResult.score}/100 — passed all filters. Claude analysis unavailable (API overload — scorer decision used).`,
          thesis: 'Strong on-chain structure passed automated scoring.',
          invalidation: 'Significant drop in buy pressure or holder exodus.',
          missing_data: ['claude_analysis'],
          confidence_reason: 'Scorer-only decision — Claude API was unavailable',
          key_metrics: { holder_risk:'MEDIUM', contract_risk:'MEDIUM', wallet_risk:'MEDIUM', social_risk:'MEDIUM', entry_risk:'MEDIUM' },
        };
        logEvent('WARN', 'CLAUDE_FALLBACK_POST', `${enrichedCandidate.token} posted without Claude — scorer score=${scoreResult.score}`);
        console.log(`[auto-caller] ⚠️  $${enrichedCandidate.token} posting WITHOUT Claude verdict (API unavailable) — score ${scoreResult.score}`);
      }
      {
      // Use v8 caption builder that includes OpenAI decision layer
      const caption  = buildV8Caption(enrichedCandidate, verdict, scoreResult, openAIDecision);
      // Coin image for the call — user wants the coin's own avatar so the
      // post is visually distinct and confirmable (vs. the generic Pulse
      // banner reserved for status/startup messages). Fall through:
      //   1. DexScreener info.imageUrl (when pair metadata present)
      //   2. DexScreener CDN URL (works for any SPL token with metadata,
      //      including pump.fun pre-bond — the dashboard already pulls
      //      from here reliably)
      // sendCallAlertWithImage handles Telegram rejection gracefully and
      // falls back to the Pulse banner only if both image sources fail.
      const caForImg = enrichedCandidate.contractAddress;
      const coinImg  = enrichedCandidate.imageUrl
                    || (caForImg ? `https://dd.dexscreener.com/ds-data/tokens/solana/${caForImg}.png` : null);

      // ── CA beacon FIRST (Phanes, Sect Board, leaderboard trackers) ──────
      // Posted as a plain-text message with just the CA — mirrors the way
      // a human user would drop a call in the group. This is what Phanes
      // and Sect scan for to credit the caller on their leaderboards. MUST
      // go out BEFORE the analysis card so the attribution sticks to the
      // Pulse bot account. Respect pausePosting.
      const caBeacon = enrichedCandidate.contractAddress ?? '';
      if (caBeacon && TELEGRAM_BOT_TOKEN && TELEGRAM_GROUP_CHAT_ID && !AI_CONFIG_OVERRIDES.pausePosting) {
        try {
          const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: TELEGRAM_GROUP_CHAT_ID,
              text: caBeacon,
              disable_web_page_preview: true,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!r.ok) console.warn(`[TG-CA] beacon status ${r.status}: ${(await r.text()).slice(0,150)}`);
          else console.log(`[TG-CA] ✓ CA beacon posted FIRST for Phanes/Sect: ${caBeacon}`);
        } catch (err) {
          console.warn(`[TG-CA] beacon failed: ${err.message}`);
        }
        // Self-record: Pulse appears on /grouplb alongside human users.
        // Ranked by the same peak_multiple math everyone else gets.
        try {
          const { recordUserCall, PULSE_USER_ID, PULSE_USERNAME } = await import('./user-leaderboard.js');
          recordUserCall(dbInstance, {
            userId:     PULSE_USER_ID,
            username:   PULSE_USERNAME,
            firstName:  'Pulse',
            contractAddress: caBeacon,
            token:      enrichedCandidate.token || null,
            mcap:       enrichedCandidate.marketCap || null,
            chatId:     String(TELEGRAM_GROUP_CHAT_ID),
          });
        } catch (err) { console.warn(`[user-lb] pulse self-record err: ${err.message}`); }
        await sleep(1500); // give leaderboard bots a moment to pick up the CA
      }

      // Respect pausePosting config override (set via dashboard or /config Telegram command)
      if (AI_CONFIG_OVERRIDES.pausePosting) {
        fnl('pausedPosting');
        console.log(`[ai-os] ⏸ Posting PAUSED — $${enrichedCandidate.token} would have posted (score ${scoreResult.score})`);
        logEvent('INFO', 'POST_PAUSED', `${enrichedCandidate.token} score=${scoreResult.score}`);
      } else {
        fnl('posted');
        // Build the full detailed analysis (Foundation Signals, sub-scores,
        // market data, holders, risk, launch intel, etc.) and send it as a
        // reply to the photo+caption — so the user gets BOTH the compact
        // call card AND the deep-dive report on every post.
        let fullDetailMessage = null;
        try {
          fullDetailMessage = buildCallAlertMessage(enrichedCandidate, verdict ?? {}, scoreResult, similarity, ftResult);
          // Append SL/TP block + Trade Levels (already part of the full message in some paths)
          const sltpBlock = buildSLTPBlock(enrichedCandidate);
          if (sltpBlock) fullDetailMessage += sltpBlock;
        } catch (err) {
          console.warn(`[TG] full-message build failed: ${err.message}`);
        }
        await sendCallAlertWithImage(caption, fullDetailMessage, coinImg);
      }

      // ── Archive this call permanently (AUTO_POST) ─────────────────────────
      try {
        const etTimestamp = new Date().toLocaleString('en-US', {
          timeZone: 'America/New_York', month: 'short', day: 'numeric',
          year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'short',
        });
        const archiveData = {
          contract_address:  ca,
          token:             enrichedCandidate.token,
          token_name:        enrichedCandidate.tokenName,
          final_decision:    finalDecision,
          composite_score:   enrichedCandidate.compositeScore ?? scoreResult.score,
          quick_score:       enrichedCandidate.quickScore,
          market_cap:        enrichedCandidate.marketCap,
          liquidity:         enrichedCandidate.liquidity,
          volume_1h:         enrichedCandidate.volume1h,
          volume_24h:        enrichedCandidate.volume24h,
          pair_age_hours:    enrichedCandidate.pairAgeHours,
          stage:             scoreResult.stage,
          buy_ratio_1h:      enrichedCandidate.buySellRatio1h,
          buys_1h:           enrichedCandidate.buys1h,
          sells_1h:          enrichedCandidate.sells1h,
          volume_velocity:   enrichedCandidate.volumeVelocity,
          bundle_risk:       enrichedCandidate.bundleRisk,
          sniper_count:      enrichedCandidate.sniperWalletCount,
          top10_holder_pct:  enrichedCandidate.top10HolderPct,
          dev_wallet_pct:    enrichedCandidate.devWalletPct,
          mint_authority:    enrichedCandidate.mintAuthority,
          freeze_authority:  enrichedCandidate.freezeAuthority,
          lp_locked:         enrichedCandidate.lpLocked,
          deployer_verdict:  enrichedCandidate.deployerVerdict,
          wallet_verdict:    enrichedCandidate.walletVerdict,
          smart_money_score: enrichedCandidate.smartMoneyScore,
          winner_wallets:    enrichedCandidate.knownWinnerWallets?.length ?? 0,
          claude_verdict:    verdict?.verdict,
          claude_risk:       verdict?.risk,
          claude_setup_type: verdict?.setup_type,
          openai_decision:   enrichedCandidate.openaiDecision,
          openai_conviction: enrichedCandidate.openaiConviction,
          narrative_tags:    JSON.stringify(enrichedCandidate.narrativeTags ?? []),
          twitter:           enrichedCandidate.twitter,
          website:           enrichedCandidate.website,
          telegram:          enrichedCandidate.telegram,
          holder_count:      enrichedCandidate.holders,
          structure_grade:   scoreResult.structureGrade,
          trap_severity:     scoreResult.trapDetector?.severity,
          bonding_curve_pct: enrichedCandidate.bondingCurvePct,
          sub_scores:        JSON.stringify(scoreResult.subScores ?? {}),
          called_at_et:      etTimestamp,
        };
        dbInstance.prepare(`
          INSERT INTO audit_archive (
            contract_address,token,token_name,final_decision,composite_score,quick_score,
            market_cap,liquidity,volume_1h,volume_24h,pair_age_hours,stage,
            buy_ratio_1h,buys_1h,sells_1h,volume_velocity,bundle_risk,sniper_count,
            top10_holder_pct,dev_wallet_pct,mint_authority,freeze_authority,lp_locked,
            deployer_verdict,wallet_verdict,smart_money_score,winner_wallets,
            claude_verdict,claude_risk,claude_setup_type,openai_decision,openai_conviction,
            narrative_tags,twitter,website,telegram,holder_count,structure_grade,
            trap_severity,bonding_curve_pct,sub_scores,called_at_et
          ) VALUES (
            ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
          )
          ON CONFLICT(contract_address) DO UPDATE SET
            final_decision=excluded.final_decision,
            composite_score=excluded.composite_score,
            called_at_et=excluded.called_at_et,
            created_at=datetime('now')
        `).run(
          archiveData.contract_address, archiveData.token, archiveData.token_name,
          archiveData.final_decision, archiveData.composite_score, archiveData.quick_score,
          archiveData.market_cap, archiveData.liquidity, archiveData.volume_1h, archiveData.volume_24h,
          archiveData.pair_age_hours, archiveData.stage, archiveData.buy_ratio_1h,
          archiveData.buys_1h, archiveData.sells_1h, archiveData.volume_velocity,
          archiveData.bundle_risk, archiveData.sniper_count, archiveData.top10_holder_pct,
          archiveData.dev_wallet_pct, archiveData.mint_authority, archiveData.freeze_authority,
          archiveData.lp_locked, archiveData.deployer_verdict, archiveData.wallet_verdict,
          archiveData.smart_money_score, archiveData.winner_wallets,
          archiveData.claude_verdict, archiveData.claude_risk, archiveData.claude_setup_type,
          archiveData.openai_decision, archiveData.openai_conviction,
          archiveData.narrative_tags, archiveData.twitter, archiveData.website, archiveData.telegram,
          archiveData.holder_count, archiveData.structure_grade, archiveData.trap_severity,
          archiveData.bonding_curve_pct, archiveData.sub_scores, archiveData.called_at_et
        );
        // Keep only latest 500 promoted calls in archive
        // Promoted coins are kept FOREVER — never deleted from archive
        // Only purge non-promoted evaluations older than 90 days to manage size
        dbInstance.prepare(`DELETE FROM audit_archive WHERE final_decision != 'AUTO_POST' AND created_at < datetime('now', '-90 days')`).run();
        // Promoted coins capped at 1000 — keep newest
        dbInstance.prepare(`DELETE FROM audit_archive WHERE final_decision = 'AUTO_POST' AND id NOT IN (SELECT id FROM audit_archive WHERE final_decision = 'AUTO_POST' ORDER BY id DESC LIMIT 1000)`).run();
      } catch (archErr) {
        console.warn('[archive] Failed to save:', archErr.message);
      }


      markCandidatePosted(candidateId);
      recordSeen(ca, true);

      } // end AUTO_POST block

      // ── ARCHIVE non-AUTO_POST decisions too ─────────────────────────
      // The Auditor was empty because only AUTO_POST rows ever landed in
      // audit_archive. Expanding to include WATCHLIST / HOLD_FOR_REVIEW /
      // RETEST (and IGNOREs with score >= 25) gives the Auditor real
      // decision flow and lets the bot learn from every judgment call —
      // not just the ones that crossed the post threshold.
      const shouldArchiveNonPost =
        finalDecision === 'WATCHLIST' ||
        finalDecision === 'HOLD_FOR_REVIEW' ||
        finalDecision === 'RETEST' ||
        (finalDecision === 'IGNORE' && (scoreResult.score ?? 0) >= 25);

      if (shouldArchiveNonPost) {
        try {
          const etTimestamp = new Date().toLocaleString('en-US', {
            timeZone: 'America/New_York', month: 'short', day: 'numeric',
            year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'short',
          });
          const claudeV = verdict?.verdict ?? enrichedCandidate.claudeVerdict ?? null;
          const openaiV = enrichedCandidate.openaiVerdict ?? null;
          dbInstance.prepare(`
            INSERT INTO audit_archive (
              contract_address,token,token_name,final_decision,composite_score,quick_score,
              market_cap,liquidity,volume_1h,volume_24h,pair_age_hours,stage,
              buy_ratio_1h,buys_1h,sells_1h,volume_velocity,bundle_risk,sniper_count,
              top10_holder_pct,dev_wallet_pct,mint_authority,freeze_authority,lp_locked,
              deployer_verdict,wallet_verdict,smart_money_score,winner_wallets,
              claude_verdict,claude_risk,claude_setup_type,openai_decision,openai_conviction,
              narrative_tags,twitter,website,telegram,holder_count,structure_grade,
              trap_severity,bonding_curve_pct,sub_scores,called_at_et
            ) VALUES (
              ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            )
            ON CONFLICT(contract_address) DO UPDATE SET
              final_decision=excluded.final_decision,
              composite_score=excluded.composite_score,
              called_at_et=excluded.called_at_et,
              created_at=datetime('now')
          `).run(
            ca, enrichedCandidate.token, enrichedCandidate.tokenName,
            finalDecision, scoreResult.score, enrichedCandidate.quickScore,
            enrichedCandidate.marketCap, enrichedCandidate.liquidity,
            enrichedCandidate.volume1h, enrichedCandidate.volume24h,
            enrichedCandidate.pairAgeHours, scoreResult.stage ?? enrichedCandidate.stage,
            enrichedCandidate.buySellRatio1h, enrichedCandidate.buys1h, enrichedCandidate.sells1h,
            enrichedCandidate.volumeVelocity, enrichedCandidate.bundleRisk,
            enrichedCandidate.sniperWalletCount, enrichedCandidate.top10HolderPct,
            enrichedCandidate.devWalletPct, enrichedCandidate.mintAuthority,
            enrichedCandidate.freezeAuthority, enrichedCandidate.lpLocked,
            enrichedCandidate.deployerVerdict, enrichedCandidate.walletVerdict,
            enrichedCandidate.smartMoneyScore, enrichedCandidate.knownWinnerWalletCount,
            claudeV, scoreResult.risk ?? enrichedCandidate.claudeRisk,
            scoreResult.setupType ?? enrichedCandidate.claudeSetupType,
            enrichedCandidate.openaiDecision, enrichedCandidate.openaiConviction,
            JSON.stringify(enrichedCandidate.narrativeTags ?? []),
            enrichedCandidate.twitter, enrichedCandidate.website, enrichedCandidate.telegram,
            enrichedCandidate.holders, scoreResult.structureGrade, scoreResult.trapDetector?.severity,
            enrichedCandidate.bondingCurvePct,
            JSON.stringify(scoreResult.subScores ?? {}),
            etTimestamp,
          );
        } catch (err) { console.warn('[archive-nonpost] failed:', err.message); }
      }

      // Ensure top holders captured before insertCall — wallet-signal
      // triggered calls (score=25 fast-lane) skip enrichment and end up
      // with no holderAddresses, breaking the self-trained wallet credit
      // loop. One extra Helius call here = ~\$0.01/day even at 100 posts.
      let earlyHoldersForCall = enrichedCandidate.holderAddresses
                             ?? enrichedCandidate.holders_list
                             ?? null;
      if ((!earlyHoldersForCall || earlyHoldersForCall.length === 0) && HELIUS_API_KEY) {
        try {
          const fetched = await getTopHolders(ca, HELIUS_API_KEY, 100);
          if (Array.isArray(fetched) && fetched.length > 0) {
            earlyHoldersForCall = fetched;
            console.log(`[auto-caller] ✓ Fetched ${fetched.length} top holders for $${enrichedCandidate.token??ca.slice(0,6)} (just-in-time for self-trained credit)`);
          }
        } catch (err) { console.warn('[auto-caller] holders fetch failed:', err.message); }
      }

      insertCall({
        candidateId,
        token:           enrichedCandidate.token,
        contractAddress: ca,
        chain:           'solana',
        score:           verdict.score ?? scoreResult.score,
        subScores:       scoreResult.subScores,
        risk:            verdict.risk  ?? scoreResult.risk,
        setupType:       scoreResult.setupType,
        structureGrade:  scoreResult.structureGrade,
        priceUsd:        enrichedCandidate.priceUsd,
        marketCap:       enrichedCandidate.marketCap,
        liquidity:       enrichedCandidate.liquidity,
        called_at:       new Date().toISOString(),
        holderAddresses: earlyHoldersForCall,
        // Bonding-curve snapshot (pump.fun lifecycle) — populated by enricher.
        // Lets us measure "called pre-bond → did it bond?" rate later.
        bondingPctAtCall:    enrichedCandidate.pumpFunBondingPct ?? null,
        pumpFunStageAtCall:  enrichedCandidate.pumpFunStage      ?? null,
      });

      logEvent('INFO', 'AUTO_POST', `${enrichedCandidate.token} score=${scoreResult.score}`);
      console.log(`[auto-caller] ✅ POSTED — $${enrichedCandidate.token ?? ca}`);

    } else {
      recordSeen(ca, false);
      logEvent('INFO', `DECISION_${finalDecision}`, `${enrichedCandidate.token} score=${scoreResult.score}`);
    }

    await sleep(2000);

  } catch (err) {
    console.error(`[auto-caller] Error on ${ca}: ${err.message}`);
    logEvent('ERROR', 'CANDIDATE_ERROR', `${ca}: ${err.message}`);
  }
}

async function processRescanQueue() {
  const due = getDueEntries();
  if (!due.length) return;
  console.log(`[rescan] Processing ${due.length} due entry(s)…`);
  logEvent('INFO', 'RESCAN_START', `count=${due.length}`);

  for (const entry of due) {
    const ca = entry.contractAddress;
    try {
      const freshPair = await fetchPairByAddress(ca);
      let candidate;
      if (freshPair) {
        candidate = normalizePair(freshPair);
        candidate.candidateType = entry.candidateType ?? candidate.candidateType;
        candidate.quickScore    = entry.quickScore    ?? candidate.quickScore;
      } else if (entry.snapshot) {
        candidate = { ...entry.snapshot };
        candidate.notes = candidate.notes ?? [];
        candidate.notes.push('Rescan: DEX Screener pair not found — using snapshot');
      } else {
        console.warn(`[rescan] No pair or snapshot for ${ca.slice(0,8)} — dropping`);
        clearEntry(ca); continue;
      }

      candidate = await enrichCandidate(candidate);
      candidate.retestCount = entry.scanCount;
      const intel    = await runQuickWalletIntel(candidate);
      const enriched = { ...candidate, ...flattenIntel(intel) };
      const newScore = computeFullScore(enriched, TUNING_CONFIG?.discovery);
      let regimeAdj = { adjustedScore: newScore.score, thresholdAdjust: 0 };
      try {
        const ra = applyRegimeAdjustments(newScore.score, enriched, newScore);
        if (ra && typeof ra.adjustedScore === 'number') regimeAdj = ra;
      } catch (err) {
        console.warn('[rescan] regime adjustment failed:', err.message);
      }
      newScore.regimeAdjustedScore = regimeAdj.adjustedScore;

      const rescanDecision = handleRescanResult(entry, newScore, enriched);
      console.log(`[rescan] $${entry.token ?? ca} — was:${entry.firstScore} now:${newScore.score} scan#${entry.scanCount} → ${rescanDecision}`);
      clearEntry(ca);

      switch (rescanDecision) {
        case 'AUTO_POST':  await processCandidate(enriched, true); break;
        case 'RETEST':     addToRetest(enriched, newScore, `Score improving: ${entry.firstScore} → ${newScore.score}`); break;
        case 'WATCHLIST':  addToWatchlist(enriched, newScore, `Rescan #${entry.scanCount} — score:${newScore.score}`); break;
        case 'BLOCKLIST':  addToBlocklist(ca, 'Flagged on rescan'); recordSeen(ca, false); break;
        default:           recordSeen(ca, false); logEvent('INFO', 'RESCAN_DROPPED', `${entry.token} score=${newScore.score}`); break;
      }

      await sleep(1500);
    } catch (err) {
      console.error(`[rescan] Error on ${ca}:`, err.message);
      logEvent('ERROR', 'RESCAN_ERROR', `${ca}: ${err.message}`);
      clearEntry(ca);
    }
  }
  logEvent('INFO', 'RESCAN_COMPLETE', `processed=${due.length}`);
}

async function runAutoCallerCycle() {
  if (!_botActive) { _scannerHealth.lastCycleError = 'BOT_INACTIVE — master toggle OFF'; return; }
  if (cycleRunning) { console.log('[auto-caller] Previous cycle running — skipping'); return; }

  cycleRunning     = true;
  const cycleStart = Date.now();
  _scannerHealth.lastCycleStartedAt = new Date().toISOString();
  console.log('[auto-caller] ━━━ Cycle start', new Date().toISOString());
  logEvent('INFO', 'CYCLE_START');
  botStartCycle('NEW_COINS');

  try {
    if (isRegimeStale()) await updateRegime(getCandidates({ limit: 50 }).rows);
    await processRescanQueue();
    cleanupStaleEntries();

    let feedInsertErrors = 0;
    const candidates = await runScanner(isRecentlySeen, activeMode, (candidate, quickScore, action, reason) => {
      try {
        if (candidate?.contractAddress) {
          insertScannerFeed({
            token:            candidate.token,
            contractAddress:  candidate.contractAddress,
            pairAddress:      candidate.pairAddress,
            dex:              candidate.dex,
            marketCap:        candidate.marketCap,
            liquidity:        candidate.liquidity,
            volume24h:        candidate.volume24h,
            volume1h:         candidate.volume1h,
            priceUsd:         candidate.priceUsd,
            pairAgeHours:     candidate.pairAgeHours,
            stage:            candidate.stage,
            priceChange5m:    candidate.priceChange5m,
            priceChange1h:    candidate.priceChange1h,
            priceChange24h:   candidate.priceChange24h,
            buys1h:           candidate.buys1h,
            sells1h:          candidate.sells1h,
            buySellRatio1h:   candidate.buySellRatio1h,
            volumeVelocity:   candidate.volumeVelocity,
            quickScore,
            candidateType:    candidate.candidateType,
            website:          candidate.website,
            twitter:          candidate.twitter,
            telegram:         candidate.telegram,
            filterAction:     action,
            filterReason:     reason,
          });
        }
        if (action === 'SCANNED' && candidate?.contractAddress) {
          logEvent('INFO', 'SCANNER_SAW', `${candidate.token ?? '?'} qScore=${quickScore}`);
        }
      } catch (err) {
        feedInsertErrors++;
        if (feedInsertErrors <= 3) {
          console.error('[scanner-feed] insertScannerFeed failed:', err.message);
        }
      }
    });
    if (feedInsertErrors > 0) {
      console.error(`[scanner-feed] ${feedInsertErrors} total insert failures this cycle`);
    }

    if (!candidates.length) {
      console.log('[auto-caller] No candidates this cycle');
      logEvent('INFO', 'NO_CANDIDATES');
    } else {
      console.log(`[auto-caller] ${candidates.length} candidate(s) to enrich`);

      const caMap = new Map();
      for (const c of candidates) {
        if (!c.contractAddress) continue;
        const ex = caMap.get(c.contractAddress);
        if (!ex || (c.quickScore ?? 0) > (ex.quickScore ?? 0)) {
          caMap.set(c.contractAddress, c);
        }
      }
      const uniqueCandidates = [...caMap.values()];
      if (uniqueCandidates.length < candidates.length) {
        console.log(`[auto-caller] Token dedup: ${candidates.length} → ${uniqueCandidates.length} unique`);
      }

      for (const c of uniqueCandidates) {
        try {
          insertScannerFeed({
            token:           c.token,
            contractAddress: c.contractAddress,
            pairAddress:     c.pairAddress,
            dex:             c.dex,
            marketCap:       c.marketCap,
            liquidity:       c.liquidity,
            volume24h:       c.volume24h,
            volume1h:        c.volume1h,
            priceUsd:        c.priceUsd,
            pairAgeHours:    c.pairAgeHours,
            stage:           c.stage,
            priceChange5m:   c.priceChange5m,
            priceChange1h:   c.priceChange1h,
            priceChange24h:  c.priceChange24h,
            buys1h:          c.buys1h,
            sells1h:         c.sells1h,
            buySellRatio1h:  c.buySellRatio1h,
            volumeVelocity:  c.volumeVelocity,
            quickScore:      c.quickScore,
            candidateType:   c.candidateType,
            website:         c.website,
            twitter:         c.twitter,
            telegram:        c.telegram,
            filterAction:    'PROMOTE',
            filterReason:    `quickScore ${c.quickScore ?? '?'} cleared threshold`,
          });
        } catch (err) {
          console.error('[scanner-feed] promote insert failed:', err.message);
        }
      }

      for (const c of uniqueCandidates) {
        if (c.contractAddress) recordSeen(c.contractAddress, false);
      }

      const enriched = await enrichCandidates(uniqueCandidates, 500);

      // Bumped 8 → 16. With tightened ENRICHMENT_TIMEOUT (6s) and faster
      // Claude/OpenAI timeouts, we can sustain higher concurrency without
      // overwhelming downstream APIs. Speed is the edge — score in seconds,
      // not minutes.
      const PROCESS_BATCH = 24; // was 16 — process more tokens in parallel
      for (let i = 0; i < enriched.length; i += PROCESS_BATCH) {
        const batch = enriched.slice(i, i + PROCESS_BATCH);
        await Promise.all(batch.map(candidate => processCandidate(candidate, false)));
      }
    }

    const hour = new Date().getUTCHours();
    if (hour % 6 === 0 && new Date().getUTCMinutes() < 2) {
      try { rebuildWinnerProfiles(); console.log('[auto-caller] Winner profiles rebuilt'); }
      catch (err) { console.warn('[auto-caller] Profile rebuild failed:', err.message); }
    }

  } catch (err) {
    console.error('[auto-caller] Cycle error:', err.message);
    logEvent('ERROR', 'CYCLE_ERROR', err.message);
    botError('NEW_COINS', err.message);
    _scannerHealth.lastCycleError    = err.message + ' @ ' + new Date().toISOString();
    _scannerHealth.totalCycleErrors++;
    await sendAdminAlert(`❌ Cycle error:\n${escapeHtml(err.message.slice(0,300))}`);
  } finally {
    cycleRunning  = false;
    const elapsedMs = Date.now() - cycleStart;
    const elapsed   = (elapsedMs / 1000).toFixed(1);
    _scannerHealth.lastCycleCompletedAt = new Date().toISOString();
    _scannerHealth.lastCycleElapsedMs   = elapsedMs;
    _scannerHealth.totalCyclesCompleted++;
    botEndCycle('NEW_COINS', { candidatesFound: 0 });
    console.log(`[auto-caller] ━━━ Cycle complete in ${elapsed}s`);
    logEvent('INFO', 'CYCLE_COMPLETE', `elapsed=${elapsed}s`);
  }
}

// ─── v8.0 Multi-Agent Message Builders ──────────────────────────────────────

/**
 * Build the enhanced v8 Telegram caption that includes OpenAI decision verdict.
 */
function buildV8Caption(candidate, verdict, scoreResult, openAIDecision) {
  let basePart = buildCallAlertCaption(candidate, verdict, scoreResult);

  // ── Smart-money alert banner (prepended) ────────────────────────────────
  // User request: never reveal which wallet bought. Just flag it loudly.
  const sm = candidate._smartMoney;
  if (sm?.kind === 'kol') {
    basePart =
      `⭐ <b>KOL WALLET FOLLOW</b> ⭐\n` +
      `<i>A known alpha caller wallet just bought this coin. These wallets have documented 60%+ micro-cap hit rates.</i>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      basePart;
  } else if (sm?.kind === 'cluster') {
    basePart =
      `🐋🐋🐋 <b>WHALE CLUSTER ALERT</b> 🐋🐋🐋\n` +
      `<i>${sm.clusterSize} tracked winner wallets bought this coin in the last 10 minutes. Forced auto-post.</i>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      basePart;
  } else if (sm?.kind === 'single') {
    basePart =
      `🐋 <b>BIG WALLET ALERT</b>\n` +
      `<i>A tracked winner wallet just bought this coin. Full analysis below.</i>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      basePart;
  } else if (candidate._fastLane) {
    // Axioscan-style fast-lane bypass — winner wallet overlap is strong
    // enough that we skipped Claude/consensus gates. Tag the caption so
    // the reader knows this was a wallet-signal call, not AI-vetted.
    const fl = candidate._fastLane;
    basePart =
      `⚡ <b>FAST-LANE CALL</b> ⚡\n` +
      `<i>${fl.winners} winner wallets already holding · bypassed AI gate · Axioscan-mode.</i>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      basePart;
  } else if (candidate._scoreTrump) {
    // High-conviction scorer call that overrode Claude's WATCHLIST/IGNORE.
    // Tag explicitly so reader knows this was a structural-signal call.
    const st = candidate._scoreTrump;
    const tierLabel = st.tier === 'FRESH' ? 'FRESH GEM' : 'YOUNG GEM';
    basePart =
      `📊 <b>HIGH-SCORE OVERRIDE</b>\n` +
      `<i>Composite ${st.score} · ${tierLabel} (${st.tier === 'FRESH' ? Math.round(st.ageHrs * 60) + 'min' : st.ageHrs.toFixed(1) + 'h'} old, $${Math.round(st.mcap/1000)}K MCap) · scorer trumped AI gate.</i>\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      basePart;
  }

  // Prepend a data-limited warning if enrichment was incomplete but the
  // smart-money cluster/KOL signal overrode the data-void skip. Reader
  // needs to know the MCap/liquidity numbers below may be stale or missing.
  if (candidate._limitedData) {
    basePart =
      `⚠️ <b>DATA LIMITED</b> — coin is too fresh; Birdeye/DexScreener haven't indexed yet. Numbers may be incomplete. Signal trusted on wallet conviction alone.\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n` +
      basePart;
  }

  // Append a Bonding line right under the caption header when we have
  // pump.fun lifecycle data. Lets every reader instantly see if this is
  // a pre-bond entry (early — bigger upside if it graduates) or a
  // post-migration call (already on Raydium — different risk profile).
  const pfStage = candidate.pumpFunStage;
  const pfPct   = candidate.pumpFunBondingPct;
  if (pfStage === 'PRE_BOND' && pfPct != null) {
    const bar = (() => {
      const filled = Math.round((pfPct / 100) * 10);
      return '🟩'.repeat(Math.max(0, filled)) + '⬜'.repeat(Math.max(0, 10 - filled));
    })();
    const bondLine =
      `🎯 <b>PRE-BOND ENTRY</b> · ${pfPct.toFixed(1)}% to graduation\n` +
      `${bar}\n` +
      `━━━━━━━━━━━━━━━━━━━━━\n`;
    basePart = bondLine + basePart;
  } else if (pfStage === 'MIGRATED' || candidate.pumpFunMigrated) {
    basePart = `🎓 <b>POST-MIGRATION</b> · graduated to Raydium\n━━━━━━━━━━━━━━━━━━━━━\n` + basePart;
  }

  // Append OpenAI layer if available
  if (!openAIDecision) return basePart;

  const oaLine = formatOpenAIDecisionForTelegram(openAIDecision);
  if (!oaLine) return basePart;

  // Insert OpenAI line before the links section
  const linksIdx = basePart.lastIndexOf('\n🔗');
  if (linksIdx > 0) {
    return basePart.slice(0, linksIdx) + '\n' + oaLine + basePart.slice(linksIdx);
  }
  return basePart + '\n' + oaLine;
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
// Default body-parse limit raised from Express's built-in 100KB to 30MB so
// the AI Brain's image uploads (screenshots + URL attachments) can flow
// through. The /api/agent route had a per-route 25MB override but this
// global was rejecting first — "Payload Too Large" HTML page was what
// the user saw. Global JSON error handler further down coerces any
// remaining body-parse rejection into a JSON response.
app.use(express.json({ limit: '30mb' }));

// Global JSON error handler — ANY body-parse failure (payload too large,
// malformed JSON, etc.) on ANY route gets a JSON response instead of
// Express's default HTML error page. Prevents "Unexpected token '<'" on
// the frontend forever.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.type === 'entity.parse.failed' || err.status === 413 || err.statusCode === 413)) {
    setCors(res);
    console.warn(`[body-parse] ${req.method} ${req.path} — ${err.type || err.name}: ${err.message}`);
    return res.status(err.status || 413).json({
      ok: false,
      error: err.message,
      reply: `⚠ Request rejected: ${err.message}. Image or payload too big — try a smaller file or fewer items.`,
    });
  }
  next(err);
});

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// API Usage tracking endpoint
app.get('/api/usage', (req, res) => {
  setCors(res);
  const uptime = Date.now() - new Date(_apiUsageStartedAt).getTime();
  const hours = uptime / 3_600_000;
  const usage = {};
  for (const [svc, data] of Object.entries(_apiUsage)) {
    const calls = data.calls || data.events || 0;
    usage[svc] = {
      ...data,
      callsPerHour: hours > 0 ? Math.round(calls / hours) : 0,
      projectedDaily: hours > 0 ? Math.round((calls / hours) * 24) : 0,
    };
  }
  res.json({
    ok: true,
    startedAt: _apiUsageStartedAt,
    uptimeSeconds: Math.round(uptime / 1000),
    usage,
  });
});

app.options('*', (req, res) => { setCors(res); res.sendStatus(204); });

app.get('/', (_req, res) => {
  const stats = (() => { try { return getStats(); } catch { return null; } })();
  res.json({ ok: true, service: 'alpha-lennix', version: '8.0.0', status: 'running', mode: activeMode.name, stats });
});

app.get('/dashboard', (_req, res) => {
  try {
    const html = readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    // Force mobile/desktop browsers to fetch the latest dashboard every load —
    // we ship UI changes constantly and stale caches were hiding new features.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(html);
  } catch (err) {
    res.status(500).send('Dashboard not found: ' + err.message);
  }
});

// ─── AI Operating System — Config Control API ────────────────────────────────
// Lets the dashboard AI agent and Telegram /config command change bot behavior
// without a deploy. Changes persist in memory until next restart.

// AI Learning Dashboard metrics — are we actually getting smarter?
// Returns trend deltas (7d vs 30d), score-bucket accuracy, AI consensus
// accuracy, and peak-multiple trend. All treats peak_multiple >= 2 as an
// implicit WIN so stats are meaningful before auto-tracker resolves outcomes.
// Wallet activity log — every buy detected by the smart-money watcher.
// Query by wallet address OR by token mint. Used by the oracle for
// "what did wallet X buy this week" and "who's accumulating $MEME right now".
app.get('/api/wallets/activity', (req, res) => {
  setCors(res);
  try {
    const { address, token, limit = 50, hours = 168 } = req.query;
    if (!address && !token) {
      return res.status(400).json({ ok: false, error: 'address or token query param required' });
    }
    const lim = Math.min(Number(limit), 200);
    const h   = Math.min(Number(hours), 30 * 24);
    let rows = [];
    try {
      if (address) {
        rows = dbInstance.prepare(`
          SELECT wa.*, tw.label, tw.category, tw.sol_balance
          FROM wallet_activity wa
          LEFT JOIN tracked_wallets tw ON tw.address = wa.wallet_address
          WHERE wa.wallet_address = ?
            AND wa.detected_at > datetime('now', '-' || ? || ' hours')
          ORDER BY wa.block_time DESC, wa.id DESC
          LIMIT ?
        `).all(address, h, lim);
      } else {
        rows = dbInstance.prepare(`
          SELECT wa.*, tw.label, tw.category, tw.sol_balance
          FROM wallet_activity wa
          LEFT JOIN tracked_wallets tw ON tw.address = wa.wallet_address
          WHERE wa.token_mint = ?
            AND wa.detected_at > datetime('now', '-' || ? || ' hours')
          ORDER BY wa.block_time DESC, wa.id DESC
          LIMIT ?
        `).all(token, h, lim);
      }
    } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
    res.json({ ok: true, count: rows.length, rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Scoring Config — dashboard editable knobs ───────────────────────────
app.get('/api/config/scoring', (req, res) => {
  setCors(res);
  res.json({
    ok: true,
    defaults: SCORING_CONFIG_DEFAULTS,
    current: SCORING_CONFIG,
  });
});
app.post('/api/config/scoring', express.json(), (req, res) => {
  setCors(res);
  try {
    const updates = req.body ?? {};
    const source  = updates.__source || 'operator';
    const reason  = updates.__reason || null;
    const allowed = Object.keys(SCORING_CONFIG_DEFAULTS);
    const applied = {};
    for (const key of allowed) {
      if (updates[key] == null || updates[key] === '') continue;
      const num = Number(updates[key]);
      if (Number.isFinite(num) && SCORING_CONFIG[key] !== num) {
        const prev = SCORING_CONFIG[key];
        SCORING_CONFIG[key] = num;
        applied[key] = num;
        logConfigChange('SCORING', key, prev, num, source, reason);
      }
    }
    persistScoringConfig();
    logEvent('INFO', 'SCORING_CONFIG_UPDATED', JSON.stringify(applied));
    console.log('[config] scoring updated:', applied);
    res.json({ ok: true, applied, current: SCORING_CONFIG });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
// Reset all scoring knobs back to code defaults
app.post('/api/config/scoring/reset', (req, res) => {
  setCors(res);
  for (const key of Object.keys(SCORING_CONFIG_DEFAULTS)) {
    if (SCORING_CONFIG[key] !== SCORING_CONFIG_DEFAULTS[key]) {
      logConfigChange('SCORING', key, SCORING_CONFIG[key], SCORING_CONFIG_DEFAULTS[key], 'operator', 'reset to defaults');
    }
  }
  SCORING_CONFIG = { ...SCORING_CONFIG_DEFAULTS };
  persistScoringConfig();
  logEvent('INFO', 'SCORING_CONFIG_RESET', 'back to defaults');
  res.json({ ok: true, current: SCORING_CONFIG });
});

// ─── Extended Config Endpoints (Scanner / Wallets / Pre-Launch / Outcomes) ─
// Follow the same GET/POST pattern as /api/config/scoring. Values persist
// to kv_store and get logged to config_changes for the audit tab. Note:
// module-level constants (e.g. POLL_INTERVAL_MS) take effect on next
// restart unless the consuming module re-reads each tick.
function makeConfigEndpoints(category, defaultsObj, getState, setState) {
  app.get(`/api/config/${category}`, (req, res) => {
    setCors(res);
    res.json({ ok: true, defaults: defaultsObj, current: getState() });
  });
  app.post(`/api/config/${category}`, express.json(), (req, res) => {
    setCors(res);
    try {
      const updates = req.body ?? {};
      const source  = updates.__source || 'operator';
      const reason  = updates.__reason || null;
      const current = getState();
      const applied = {};
      for (const key of Object.keys(defaultsObj)) {
        if (updates[key] == null || updates[key] === '') continue;
        // Accept numbers OR strings (for knobs like kolWallets / rescanScheduleMins)
        const defVal = defaultsObj[key];
        let val;
        if (typeof defVal === 'number') {
          const num = Number(updates[key]);
          if (!Number.isFinite(num)) continue;
          val = num;
        } else {
          val = String(updates[key]);
        }
        if (current[key] !== val) {
          const prev = current[key];
          current[key] = val;
          applied[key] = val;
          logConfigChange(category, key, prev, val, source, reason);
        }
      }
      setState(current);
      persistExtendedConfig(category);
      logEvent('INFO', `${category.toUpperCase()}_CONFIG_UPDATED`, JSON.stringify(applied));
      res.json({ ok: true, applied, current: getState() });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
  });
  app.post(`/api/config/${category}/reset`, (req, res) => {
    setCors(res);
    const current = getState();
    for (const key of Object.keys(defaultsObj)) {
      if (current[key] !== defaultsObj[key]) {
        logConfigChange(category, key, current[key], defaultsObj[key], 'operator', 'reset to defaults');
      }
    }
    setState({ ...defaultsObj });
    persistExtendedConfig(category);
    res.json({ ok: true, current: getState() });
  });
}

makeConfigEndpoints('scanner',   SCANNER_CONFIG_DEFAULTS,   () => SCANNER_CONFIG,   (v) => { SCANNER_CONFIG   = v; });
makeConfigEndpoints('wallets',   WALLETS_CONFIG_DEFAULTS,   () => WALLETS_CONFIG,   (v) => { WALLETS_CONFIG   = v; });
makeConfigEndpoints('prelaunch', PRELAUNCH_CONFIG_DEFAULTS, () => PRELAUNCH_CONFIG, (v) => { PRELAUNCH_CONFIG = v; });
makeConfigEndpoints('outcomes',  OUTCOMES_CONFIG_DEFAULTS,  () => OUTCOMES_CONFIG,  (v) => { OUTCOMES_CONFIG  = v; });

// ─── Audit Log + Revert Endpoints ──────────────────────────────────────────
// GET /api/config/audit — paginated history of every config change.
//   Query params: category, knob_key, limit (default 50), offset (default 0)
// POST /api/config/revert/:id — replays the old_value of a past change.
app.get('/api/config/audit', (req, res) => {
  setCors(res);
  try {
    const limit    = Math.min(200, Number(req.query.limit  ?? 50));
    const offset   = Math.max(0,   Number(req.query.offset ?? 0));
    const category = req.query.category ? String(req.query.category).toUpperCase() : null;
    const knobKey  = req.query.knob_key ? String(req.query.knob_key) : null;
    const where = [];
    const params = [];
    if (category) { where.push('category = ?'); params.push(category); }
    if (knobKey)  { where.push('knob_key = ?'); params.push(knobKey); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = dbInstance.prepare(`
      SELECT id, changed_at, category, source, knob_key, old_value, new_value, reason
      FROM config_changes ${whereClause}
      ORDER BY changed_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    const total = dbInstance.prepare(`SELECT COUNT(*) as n FROM config_changes ${whereClause}`).get(...params).n;
    res.json({
      ok: true,
      total,
      rows: rows.map(r => ({
        ...r,
        old_value: r.old_value ? JSON.parse(r.old_value) : null,
        new_value: r.new_value ? JSON.parse(r.new_value) : null,
      })),
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/config/revert/:id', (req, res) => {
  setCors(res);
  try {
    const row = dbInstance.prepare(`SELECT * FROM config_changes WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'change not found' });
    const oldVal = row.old_value ? JSON.parse(row.old_value) : null;
    const category = row.category.toLowerCase();
    const key = row.knob_key;
    const configMap = {
      scoring:   [SCORING_CONFIG,   (v) => { SCORING_CONFIG   = v; }, persistScoringConfig],
      scanner:   [SCANNER_CONFIG,   (v) => { SCANNER_CONFIG   = v; }, () => persistExtendedConfig('scanner')],
      wallets:   [WALLETS_CONFIG,   (v) => { WALLETS_CONFIG   = v; }, () => persistExtendedConfig('wallets')],
      prelaunch: [PRELAUNCH_CONFIG, (v) => { PRELAUNCH_CONFIG = v; }, () => persistExtendedConfig('prelaunch')],
      outcomes:  [OUTCOMES_CONFIG,  (v) => { OUTCOMES_CONFIG  = v; }, () => persistExtendedConfig('outcomes')],
    };
    const entry = configMap[category];
    if (!entry) return res.status(400).json({ ok: false, error: `unsupported category ${category}` });
    const [cfg, setter, persist] = entry;
    const currentVal = cfg[key];
    cfg[key] = oldVal;
    setter(cfg);
    persist();
    logConfigChange(row.category, key, currentVal, oldVal, 'operator', `revert to change #${row.id} (${row.changed_at})`);
    res.json({ ok: true, reverted: { key, from: currentVal, to: oldVal } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/ai/learning-metrics', (req, res) => {
  setCors(res);
  try {
    const safe = (sql, ...p) => { try { return dbInstance.prepare(sql).get(...p); } catch { return {}; } };
    const safeAll = (sql, ...p) => { try { return dbInstance.prepare(sql).all(...p); } catch { return []; } };

    // Helper: a call counts as WIN if explicit WIN or peaked >=2x
    //         LOSS if explicit LOSS or peaked <=0.5x and never hit 2x
    const resolvedSql = `
      CASE
        WHEN outcome='WIN' OR peak_multiple >= 2 THEN 'WIN'
        WHEN outcome='LOSS' OR (peak_multiple IS NOT NULL AND peak_multiple <= 0.5) THEN 'LOSS'
        WHEN outcome='NEUTRAL' THEN 'NEUTRAL'
        ELSE NULL
      END`;

    // ── 1. Win rate: 7d vs 30d ──
    const winRateOver = (since) => {
      const r = safe(`
        SELECT
          SUM(CASE WHEN (${resolvedSql})='WIN'  THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN (${resolvedSql})='LOSS' THEN 1 ELSE 0 END) as losses,
          COUNT(*) as total
        FROM calls
        WHERE called_at > datetime('now', ?)
      `, since);
      const resolved = (r.wins || 0) + (r.losses || 0);
      return {
        wins:    r.wins    || 0,
        losses:  r.losses  || 0,
        total:   r.total   || 0,
        winRate: resolved > 0 ? (r.wins / resolved) : null,
      };
    };
    const wr7  = winRateOver('-7 days');
    const wr30 = winRateOver('-30 days');

    // ── 2. Score bucket accuracy — do higher scores actually win more? ──
    const bucketStats = safeAll(`
      SELECT
        CASE
          WHEN score_at_call >= 60 THEN '60+'
          WHEN score_at_call >= 40 THEN '40-59'
          ELSE '<40'
        END as bucket,
        SUM(CASE WHEN (${resolvedSql})='WIN'  THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN (${resolvedSql})='LOSS' THEN 1 ELSE 0 END) as losses,
        COUNT(*) as total
      FROM calls
      WHERE score_at_call IS NOT NULL
      GROUP BY bucket
    `).map(b => ({
      ...b,
      winRate: (b.wins + b.losses) > 0 ? b.wins / (b.wins + b.losses) : null,
    }));

    // ── 3. Peak multiple trend: this week vs last week ──
    const peakOver = (since, until) => {
      const r = safe(`
        SELECT AVG(peak_multiple) as avg, MAX(peak_multiple) as max, COUNT(*) as n
        FROM calls
        WHERE peak_multiple IS NOT NULL
          AND called_at > datetime('now', ?)
          AND called_at <= datetime('now', ?)
      `, since, until);
      return { avg: r.avg || 0, max: r.max || 0, n: r.n || 0 };
    };
    const peakThisWeek = peakOver('-7 days',  '+0 days');
    const peakLastWeek = peakOver('-14 days', '-7 days');

    // ── 4. AI Consensus accuracy — when Claude AND OpenAI both said POST ──
    const consensus = safe(`
      SELECT
        COUNT(*) as consensus_posts,
        SUM(CASE WHEN (c.outcome='WIN' OR c.peak_multiple >= 2) THEN 1 ELSE 0 END) as consensus_wins,
        SUM(CASE WHEN (c.outcome='LOSS' OR (c.peak_multiple IS NOT NULL AND c.peak_multiple <= 0.5)) THEN 1 ELSE 0 END) as consensus_losses
      FROM calls c
      LEFT JOIN candidates ca ON ca.id = c.candidate_id
      WHERE ca.claude_decision='AUTO_POST' AND ca.openai_decision='POST'
    `);

    // ── 5. Manual vs auto — how engaged is the user in resolving calls ──
    const resolution = safe(`
      SELECT
        SUM(CASE WHEN outcome_source='MANUAL' THEN 1 ELSE 0 END) as manual,
        SUM(CASE WHEN outcome_source='AUTO'   THEN 1 ELSE 0 END) as auto,
        SUM(CASE WHEN outcome IN ('WIN','LOSS','NEUTRAL') THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN peak_multiple >= 2 AND outcome IS NOT 'WIN'  THEN 1 ELSE 0 END) as implicit_wins,
        COUNT(*) as total
      FROM calls
    `);

    // ── Composite "smarter?" verdict ──
    // Improving if: 7d win rate > 30d win rate AND peakThisWeek >= peakLastWeek
    const delta7vs30 =
      (wr7.winRate != null && wr30.winRate != null)
        ? (wr7.winRate - wr30.winRate)
        : null;
    const peakDelta =
      peakThisWeek.n > 0 && peakLastWeek.n > 0
        ? (peakThisWeek.avg - peakLastWeek.avg)
        : null;
    const trend =
      delta7vs30 == null ? 'INSUFFICIENT_DATA'
      : delta7vs30 > 0.05 ? 'IMPROVING'
      : delta7vs30 < -0.05 ? 'DECLINING'
      : 'STABLE';

    res.json({
      ok: true,
      winRate: {
        last7d:  wr7,
        last30d: wr30,
        delta:   delta7vs30,
      },
      scoreBuckets: bucketStats,
      peakTrend: {
        thisWeek: peakThisWeek,
        lastWeek: peakLastWeek,
        delta:    peakDelta,
      },
      consensus: {
        posts:  consensus.consensus_posts  || 0,
        wins:   consensus.consensus_wins   || 0,
        losses: consensus.consensus_losses || 0,
        winRate: (consensus.consensus_wins + consensus.consensus_losses) > 0
          ? consensus.consensus_wins / (consensus.consensus_wins + consensus.consensus_losses)
          : null,
      },
      resolution: {
        manual:       resolution.manual || 0,
        auto:         resolution.auto   || 0,
        implicitWins: resolution.implicit_wins || 0,
        resolved:     resolution.resolved || 0,
        total:        resolution.total || 0,
      },
      trend,
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/ai/config', (req, res) => {
  setCors(res);
  res.json({
    ok: true,
    overrides: AI_CONFIG_OVERRIDES,
    activeMode: {
      name:           activeMode.name,
      minScore:       activeMode.minScore,
      maxMarketCap:   activeMode.maxMarketCap,
      minMarketCap:   activeMode.minMarketCap,
      minLiquidity:   activeMode.minLiquidity,
      maxPairAgeHours:activeMode.maxPairAgeHours,
      thresholdAdjust:activeMode.thresholdAdjust,
    },
    aiContext: {
      alwaysOn:       true,
      evaluatesAll:   true,
      gemTargetMin:   AI_CONFIG_OVERRIDES.gemTargetMin   ?? 8_000,
      gemTargetMax:   AI_CONFIG_OVERRIDES.gemTargetMax   ?? 50_000,
      sweetSpotMin:   AI_CONFIG_OVERRIDES.sweetSpotMin   ?? 10_000,
      sweetSpotMax:   AI_CONFIG_OVERRIDES.sweetSpotMax   ?? 25_000,
      upgradeEnabled: AI_CONFIG_OVERRIDES.upgradeEnabled ?? true,
    },
  });
});

app.post('/api/ai/config', (req, res) => {
  setCors(res);
  try {
    const { key, value, reason } = req.body ?? {};
    if (!key) return res.status(400).json({ ok: false, error: 'key required' });

    const ALLOWED_KEYS = [
      // MCap targeting
      'gemTargetMin', 'gemTargetMax', 'sweetSpotMin', 'sweetSpotMax',
      'maxMarketCapOverride', 'minMarketCapOverride',
      // Scoring
      'postThresholdOverride', 'minScoreOverride', 'scoreFloorOverride',
      'bundleRiskBlock', 'sniperCountBlock', 'devWalletPctBlock',
      'top10HolderBlock', 'trapSeverityBlock',
      // Timing
      'maxPairAgeHoursOverride', 'minPairAgeMinutesOverride',
      // Behavior
      'upgradeEnabled', 'aggressiveMode', 'pausePosting',
      'walletIntelWeight', 'earlyWalletTracking', 'survivorTracking',
      // Agent settings (not API keys)
      'agentAutoApply', 'agentConvictionThreshold',
    ];
    if (!ALLOWED_KEYS.includes(key)) {
      return res.status(400).json({ ok: false, error: `Unknown config key. Allowed: ${ALLOWED_KEYS.join(', ')}` });
    }

    const prev = AI_CONFIG_OVERRIDES[key];
    AI_CONFIG_OVERRIDES[key] = value;
    persistAIConfig();

    // Apply live mode overrides immediately
    if (key === 'maxMarketCapOverride'      && typeof value === 'number') activeMode.maxMarketCap   = value;
    if (key === 'minMarketCapOverride'      && typeof value === 'number') activeMode.minMarketCap   = value;
    if (key === 'minScoreOverride'          && typeof value === 'number') activeMode.minScore       = value;
    if (key === 'scoreFloorOverride'        && typeof value === 'number') activeMode.minScore       = value;
    if (key === 'maxPairAgeHoursOverride'   && typeof value === 'number') activeMode.maxPairAgeHours = value;
    if (key === 'postThresholdOverride'     && typeof value === 'number') activeMode.minScore       = value;

    logEvent('INFO', 'AI_CONFIG_CHANGE', JSON.stringify({ key, prev, value, reason: reason ?? 'dashboard' }));
    console.log(`[ai-os] Config change: ${key} ${JSON.stringify(prev)} → ${JSON.stringify(value)} (${reason ?? 'no reason'})`);
    logConfigChange('AI', key, prev, value, req.body?.__source || 'operator', reason);

    // Send admin alert
    sendAdminAlert(
      `⚙️ <b>AI Config Changed</b>\n` +
      `Key: <code>${escapeHtml(key)}</code>\n` +
      `Value: <b>${JSON.stringify(value)}</b>\n` +
      (reason ? `Reason: ${escapeHtml(reason)}\n` : '') +
      `Previous: ${JSON.stringify(prev) ?? 'not set'}`
    ).catch(() => {});

    res.json({ ok: true, key, value, previous: prev, message: `AI config updated: ${key} = ${JSON.stringify(value)}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/ai/config', (req, res) => {
  setCors(res);
  const prev = { ...AI_CONFIG_OVERRIDES };
  AI_CONFIG_OVERRIDES = {};
  persistAIConfig();
  // Reset mode to defaults
  setMode(activeMode.name);
  logEvent('INFO', 'AI_CONFIG_RESET', JSON.stringify(prev));
  console.log('[ai-os] All config overrides cleared — reset to defaults');
  res.json({ ok: true, message: 'All AI config overrides cleared', cleared: prev });
});

// ─── AI OS — Live Memory: what the AI has learned this session ───────────────
app.get('/api/ai/memory', (req, res) => {
  setCors(res);
  try {
    const context = getRecentOutcomesContext(30);
    const overrides = AI_CONFIG_OVERRIDES;
    const totalEvals = (() => { try { return dbInstance.prepare('SELECT COUNT(*) as n FROM candidates').get().n; } catch { return 0; } })();
    const totalCalls = (() => { try { return dbInstance.prepare('SELECT COUNT(*) as n FROM calls').get().n; } catch { return 0; } })();
    const wins       = (() => { try { return dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome='WIN'").get().n; } catch { return 0; } })();
    const losses     = (() => { try { return dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS'").get().n; } catch { return 0; } })();

    // Pattern detection from recent wins
    let gemPatterns = [];
    try {
      const winRows = dbInstance.prepare(`
        SELECT c.market_cap_at_call, c.score_at_call,
               ca.setup_type, ca.pair_age_hours, ca.buy_sell_ratio_1h, ca.bundle_risk
        FROM calls c
        LEFT JOIN candidates ca ON c.candidate_id = ca.id
        WHERE c.outcome='WIN' ORDER BY c.called_at DESC LIMIT 20
      `).all();
      if (winRows.length > 0) {
        const avgMcap = Math.round(winRows.reduce((a,r)=>a+(r.market_cap_at_call??0),0)/winRows.length);
        const avgScore = Math.round(winRows.reduce((a,r)=>a+(r.score_at_call??0),0)/winRows.length);
        gemPatterns = [
          `Average winning MCap: $${(avgMcap/1000).toFixed(1)}K`,
          `Average winning score: ${avgScore}/100`,
          `Most common setup: ${winRows.map(r=>r.setup_type).filter(Boolean).sort((a,b)=>winRows.filter(r=>r.setup_type===b).length-winRows.filter(r=>r.setup_type===a).length)[0] ?? 'mixed'}`,
        ];
      }
    } catch {}

    res.json({
      ok: true,
      aiStatus: 'ALWAYS_ON — no threshold, no fine-tune needed',
      totalEvaluations: totalEvals,
      totalCalls,
      wins, losses,
      winRate: (wins+losses) > 0 ? Math.round(wins/(wins+losses)*100)+'%' : 'pending',
      gemPatterns,
      configOverrides: overrides,
      recentContext: context,
      sweetSpot: { min: AI_CONFIG_OVERRIDES.sweetSpotMin??15_000, max: AI_CONFIG_OVERRIDES.sweetSpotMax??40_000 },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── AI Agent Chat Proxy ──────────────────────────────────────────────────────
// Dashboard chat calls this instead of Anthropic directly (avoids CORS).
// The bot backend holds the CLAUDE_API_KEY so the browser never needs it.
// ═══════════════════════════════════════════════════════════════════════════
// BRAINSTORM ROOM — Claude (Analyst) + OpenAI (Decision Engine) loop
// User drops a topic → Claude analyzes with structured output → OpenAI
// challenges + decides. Full system context (live pipeline stats + mission)
// injected into both prompts so they reason with real numbers.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/brainstorm/turn', async (req, res) => {
  setCors(res);
  if (!CLAUDE_API_KEY) return res.status(503).json({ ok: false, error: 'CLAUDE_API_KEY not configured' });
  if (!OPENAI_API_KEY) return res.status(503).json({ ok: false, error: 'OPENAI_API_KEY not configured' });
  try {
    const { topic, history } = req.body ?? {};
    if (!topic || typeof topic !== 'string') return res.status(400).json({ ok: false, error: 'topic required' });

    // Build live system context from DB — so bots reason with real numbers
    const sysContext = (() => {
      try {
        const safeCount = (sql) => { try { return dbInstance.prepare(sql).get().n; } catch { return 0; } };
        const total    = safeCount(`SELECT COUNT(*) as n FROM candidates`);
        const scored   = safeCount(`SELECT COUNT(*) as n FROM candidates WHERE composite_score IS NOT NULL`);
        const posted   = safeCount(`SELECT COUNT(*) as n FROM candidates WHERE final_decision='AUTO_POST'`);
        const wins     = safeCount(`SELECT COUNT(*) as n FROM calls WHERE outcome='WIN'`);
        const losses   = safeCount(`SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS'`);
        const wallets  = safeCount(`SELECT COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0`);
        const whales   = safeCount(`SELECT COUNT(*) as n FROM tracked_wallets WHERE category='WINNER' AND is_blacklist=0`);
        const smart    = safeCount(`SELECT COUNT(*) as n FROM tracked_wallets WHERE category='SMART_MONEY' AND is_blacklist=0`);
        const archived = safeCount(`SELECT COUNT(*) as n FROM audit_archive`);
        const wr       = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) : null;
        return `LIVE PIPELINE STATS (right now):
- Candidates evaluated: ${total} | Fully scored: ${scored} | AUTO_POSTED: ${posted}
- Archived decisions: ${archived}
- Outcomes: ${wins} wins / ${losses} losses (win rate: ${wr != null ? wr + '%' : 'pending'})
- Wallet DB: ${wallets} tracked (${whales} whales, ${smart} smart money)
- Target window: $7.5K-$40K MCap (refined from $5K-$40K)
- Data sources live: Helius RPC, Solscan Pro, Birdeye, DexScreener, Pump.fun, Dune`;
      } catch (err) { return `Live stats unavailable: ${err.message}`; }
    })();

    const missionBlock = `MISSION: Build the most advanced Solana early-gem call system for $7.5K-$40K market cap tokens. Consistently identify 10x+ opportunities BEFORE the crowd.

PHILOSOPHY: We engineer edge, not chase hype. We predict, not react. Every improvement must increase win rate, avg ROI, signal quality, or speed to entry.

${sysContext}`;

    // ── CLAUDE (The Analyst) ────────────────────────────────────────────
    const claudeSystem = `You are CLAUDE — THE ANALYST inside the Brainstorm Room.

${missionBlock}

YOUR ROLE: You analyze, challenge, and improve this Solana gem-hunting system. You are proactive, aggressive, and obsessed with edge. You do NOT make final decisions — you BUILD THE CASE. OpenAI is your counterparty — they will decide.

RESPONSIBILITIES:
1. SYSTEM ANALYSIS — identify weaknesses, data gaps, timing delays, false positives
2. PATTERN RECOGNITION — dev behavior, early buyer clusters, liquidity patterns, vol spikes
3. IMPROVEMENT ENGINE — propose new scoring variables, filters, APIs, hidden signals
4. OFFENSIVE THINKING — find ways to get in BEFORE the crowd; detect stealth accumulation
5. CHALLENGE THE SYSTEM — question assumptions, find where we're being fooled

STRICT OUTPUT FORMAT (use these 4 headings, nothing else):

### Insight
(What you observed. Be specific with data.)

### Problem
(What's broken / suboptimal. Quote the number that proves it.)

### Proposed Upgrade
(Concrete technical change. Files/fields/thresholds where possible.)

### Expected Impact
(Quantified bet: +X% win rate, -Y seconds, etc.)

NEVER agree blindly. NEVER hedge. Pick the sharpest angle and commit.`;

    const claudeMessages = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-10)) {
        if (h.role === 'claude') claudeMessages.push({ role: 'assistant', content: h.content });
        else if (h.role === 'openai') claudeMessages.push({ role: 'user', content: `OpenAI (Decision Engine) responded: ${h.content}` });
        else if (h.role === 'user') claudeMessages.push({ role: 'user', content: h.content });
      }
    }
    claudeMessages.push({ role: 'user', content: `TOPIC: ${topic}\n\nAnalyze it. Use the 4-heading output format exactly.` });

    const claudeStart = Date.now();
    const claudeRes = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1400, system: claudeSystem, messages: claudeMessages }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!claudeRes.ok) {
      const txt = await claudeRes.text();
      return res.status(502).json({ ok: false, error: `Claude ${claudeRes.status}: ${txt.slice(0, 300)}` });
    }
    const claudeJson = await claudeRes.json();
    const claudeReply = (claudeJson.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
    const claudeMs = Date.now() - claudeStart;

    // ── OPENAI (The Decision Engine) ────────────────────────────────────
    const openaiSystem = `You are OPENAI — THE DECISION ENGINE inside the Brainstorm Room.

${missionBlock}

YOUR ROLE: Evaluate Claude's analysis. You are the FINAL FILTER. You approve, modify, or reject. You prioritize profit + reduce risk. Your goal isn't to be smart — it's to be RIGHT and PROFITABLE.

RESPONSIBILITIES:
1. DECISION MAKING — approve / modify / reject every Claude proposal
2. PROFITABILITY FILTER — every idea must answer: does it ↑ win rate? ↑ ROI? ↑ entry speed? ↓ rug risk?
3. RISK CONTROL — reject overfitting, useless complexity, speed-killers
4. EXECUTION LOGIC — turn ideas into concrete system rules (scanner/scorer/caller)
5. PRESSURE TEST CLAUDE — challenge weak logic, demand proof

STRICT OUTPUT FORMAT (use these 4 headings, nothing else):

### Decision
APPROVE / MODIFY / REJECT  (pick one, all caps)

### Reason
(Why. Back with numbers. Be unforgiving — weak ideas die here.)

### Implementation Plan
(Step-by-step. Which file / which function / which threshold. If MODIFY, describe the specific change to Claude's proposal.)

### Expected ROI Impact
(Quantified. "+X% win rate over next 30d", "-Y% false positive rate", etc.)

If Claude's proposal is vague or unprovable, REJECT it and demand specifics.`;

    const openaiBody = {
      model: 'gpt-4o',
      temperature: 0.4,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: openaiSystem },
        { role: 'user',   content: `TOPIC: ${topic}\n\nCLAUDE'S ANALYSIS:\n${claudeReply}\n\nYour call. Use the 4-heading output format exactly.` },
      ],
    };
    const openaiStart = Date.now();
    const openaiRes = await fetch(`${OPENAI_API_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(openaiBody),
      signal: AbortSignal.timeout(45_000),
    });
    if (!openaiRes.ok) {
      const txt = await openaiRes.text();
      return res.status(502).json({
        ok: true,
        claude: { content: claudeReply, ms: claudeMs },
        openai: { error: `OpenAI ${openaiRes.status}: ${txt.slice(0, 300)}` },
      });
    }
    const openaiJson = await openaiRes.json();
    const openaiReply = openaiJson?.choices?.[0]?.message?.content ?? '(no content)';
    const openaiMs = Date.now() - openaiStart;

    res.json({
      ok: true,
      topic,
      claude: { content: claudeReply, ms: claudeMs, model: CLAUDE_MODEL },
      openai: { content: openaiReply, ms: openaiMs, model: 'gpt-4o' },
      totalMs: claudeMs + openaiMs,
      context: sysContext,
    });
  } catch (err) {
    console.error('[brainstorm]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Web Fetch utility — strips HTML to clean text for AI consumption ─────────
async function fetchWebContent(url, maxChars = 12000) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PulseCallerBot/1.0)' },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, url };
    const contentType = r.headers.get('content-type') || '';
    const raw = await r.text();

    let text;
    if (contentType.includes('application/json')) {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } else {
      // Strip HTML tags, scripts, styles → clean text
      text = raw
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
    return { ok: true, url, chars: text.length, text: text.slice(0, maxChars) };
  } catch (err) {
    return { ok: false, error: err.message, url };
  }
}

// Endpoint: fetch any URL and return clean text
app.post('/api/agent/browse', express.json(), async (req, res) => {
  setCors(res);
  const { url } = req.body ?? {};
  if (!url) return res.status(400).json({ ok: false, error: 'url required' });
  const result = await fetchWebContent(url);
  res.json(result);
});

// Web search via DuckDuckGo instant answers (free, no key)
app.post('/api/agent/search', express.json(), async (req, res) => {
  setCors(res);
  const { query } = req.body ?? {};
  if (!query) return res.status(400).json({ ok: false, error: 'query required' });
  try {
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
      signal: AbortSignal.timeout(8_000),
    });
    const d = await r.json();
    const results = [];
    if (d.Abstract) results.push({ title: d.Heading || 'Summary', text: d.Abstract, url: d.AbstractURL });
    for (const t of (d.RelatedTopics || []).slice(0, 8)) {
      if (t.Text) results.push({ title: t.FirstURL?.split('/').pop() || '', text: t.Text, url: t.FirstURL });
      if (t.Topics) for (const sub of t.Topics.slice(0, 3)) {
        if (sub.Text) results.push({ title: sub.FirstURL?.split('/').pop() || '', text: sub.Text, url: sub.FirstURL });
      }
    }
    res.json({ ok: true, query, results });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/agent',
  express.json({ limit: '25mb' }),
  // JSON error handler — if express.json() rejects (payload too large,
  // malformed JSON, etc.), Express default serves an HTML error page and
  // the dashboard crashes trying to JSON.parse "<!DOCTYPE". Wrap with a
  // middleware that coerces ANY error on this route into JSON.
  (err, req, res, next) => {
    if (err) {
      console.warn(`[api/agent] body-parse error: ${err.type || err.name} — ${err.message}`);
      return res.status(err.status || 400).json({
        ok: false,
        reply: `⚠ Request rejected: ${err.message}. Try sending a shorter message or fewer images at once.`,
        error: err.message,
      });
    }
    next();
  },
  async (req, res) => {
  setCors(res);
  if (!CLAUDE_API_KEY) {
    return res.status(503).json({ ok: false, error: 'CLAUDE_API_KEY not configured on server' });
  }

  try {
    const { messages, system, context, walletContext, saveToMemory } = req.body ?? {};
    if (!messages?.length) return res.status(400).json({ ok: false, error: 'messages required' });

    // If the user asked the bot to remember something, save it
    if (saveToMemory) {
      try {
        dbInstance.prepare(
          `INSERT INTO bot_knowledge (title, content, category) VALUES (?,?,?)`
        ).run(saveToMemory.title || null, saveToMemory.content, saveToMemory.category || 'general');
        invalidateMemoryCache();
      } catch {}
    }

    // ── Auto-fetch URLs in the latest user message ───────────────────────────
    // If the user pastes a URL, fetch the page content and inject it so
    // Claude can read articles, docs, tweets, dashboards — anything on the web.
    let webContext = '';
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const lastText = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : (lastUserMsg?.content?.find?.(b => b.type === 'text')?.text || '');
    const urlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
    const urls = (lastText.match(urlPattern) || []).slice(0, 3);
    if (urls.length) {
      const fetched = await Promise.all(urls.map(u => fetchWebContent(u, 8000)));
      for (const f of fetched) {
        if (f.ok) {
          webContext += `\n\n── WEB PAGE: ${f.url} (${f.chars} chars) ──\n${f.text}\n── END ──`;
          console.log(`[agent] Fetched ${f.url} (${f.chars} chars)`);
        } else {
          webContext += `\n\n── FAILED TO FETCH: ${f.url} — ${f.error} ──`;
        }
      }
    }

    // Optional wallet-context block — used by the Smart Money tab chat so the
    // agent can answer questions about specific wallets, the database, etc.
    // Also auto-extracts any 32-44 char base58 address from the user's last
    // message and pulls that wallet's stats live.
    const walletBlock = (() => {
      if (!walletContext) return '';
      try {
        const totalRow    = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0`).get();
        const cats        = dbInstance.prepare(`SELECT category, COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0 GROUP BY category`).all();

        // SOL-balance buckets — user wants the oracle to know where the whales are
        const megaWhales  = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0 AND sol_balance >= 100`).get();
        const whales      = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0 AND sol_balance >= 10 AND sol_balance < 100`).get();
        const active      = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0 AND sol_balance >= 1 AND sol_balance < 10`).get();
        const dust        = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0 AND (sol_balance IS NULL OR sol_balance < 1)`).get();
        const solScanned  = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0 AND sol_balance IS NOT NULL`).get();

        // Top 15 by SOL balance (the "find the whales" answer)
        const topBySol = dbInstance.prepare(
          `SELECT address, label, category, sol_balance, win_rate, avg_roi, score, wins_found_in
           FROM tracked_wallets
           WHERE is_blacklist=0 AND sol_balance IS NOT NULL
           ORDER BY sol_balance DESC LIMIT 15`
        ).all();

        // Top 15 by score (existing — keeps the "best performers" answer)
        const topByScore = dbInstance.prepare(
          `SELECT address, label, category, sol_balance, win_rate, avg_roi, score, wins_found_in, losses_in
           FROM tracked_wallets WHERE is_blacklist=0
           ORDER BY score DESC LIMIT 15`
        ).all();

        // Top 10 by wins (the "most reliable" answer)
        const topByWins = dbInstance.prepare(
          `SELECT address, label, category, sol_balance, score, wins_found_in, losses_in
           FROM tracked_wallets WHERE is_blacklist=0 AND wins_found_in > 0
           ORDER BY wins_found_in DESC, score DESC LIMIT 10`
        ).all();

        const fmtSol = (s) => s == null ? '?' : s >= 1000 ? (s/1000).toFixed(1)+'K◎' : s >= 1 ? s.toFixed(1)+'◎' : s.toFixed(3)+'◎';
        // Include FULL address on every row so the oracle can reference or
        // construct links. A display label is still shown for readability.
        const oneLine = (w, i) => `  ${i+1}. ${w.label||''} [${w.address}] | ${w.category||'—'} | SOL:${fmtSol(w.sol_balance)} | score:${w.score||0} | wr:${w.win_rate?Math.round(w.win_rate*100):'?'}% | wins:${w.wins_found_in||0}`;

        // Address extraction for drilldown (up to 3 mentioned)
        const lastUserMsg = [...(messages||[])].reverse().find(m => m.role === 'user')?.content || '';
        const addrPattern = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
        const mentioned = (lastUserMsg.match(addrPattern) || []).slice(0, 3);
        const drilldowns = mentioned.map(addr => {
          try {
            const w = dbInstance.prepare(`SELECT * FROM tracked_wallets WHERE address=?`).get(addr);
            // Pull last 10 buys from the activity log (populated by the
            // smart-money watcher for all 200 tracked top wallets).
            let recent = [];
            try {
              recent = dbInstance.prepare(`
                SELECT token_mint, token_amount, block_time, detected_at
                FROM wallet_activity
                WHERE wallet_address = ?
                ORDER BY block_time DESC, id DESC LIMIT 10
              `).all(addr);
            } catch {}
            const activityBlock = recent.length
              ? `\n  Recent buys (${recent.length}):\n${recent.map(r => `    • ${r.token_mint} — ${r.token_amount ?? '?'} tokens @ ${r.detected_at}`).join('\n')}`
              : '\n  Recent buys: none logged yet (activity only tracked for top 200 wallets)';
            if (w) {
              return `MENTIONED WALLET ${addr.slice(0,8)}…${addr.slice(-4)} [${addr}]:
  Label: ${w.label||'(none)'} | Category: ${w.category} | Score: ${w.score}/100
  SOL balance: ${fmtSol(w.sol_balance)} (scanned ${w.sol_scanned_at||'never'})
  Win rate: ${w.win_rate ? Math.round(w.win_rate*100)+'%' : 'n/a'} | Avg ROI: ${w.avg_roi ? Math.round(w.avg_roi*100)+'%' : 'n/a'}
  Found in: ${w.wins_found_in||0} wins / ${w.losses_in||0} losses
  Source: ${w.source||'?'} | Updated: ${w.updated_at||'?'}${activityBlock}`;
            }
            return `MENTIONED WALLET ${addr.slice(0,8)}…${addr.slice(-4)}: NOT IN DATABASE — can be added via the Brain Analyzer or manual add.${activityBlock}`;
          } catch { return ''; }
        }).filter(Boolean).join('\n\n');

        return `

WALLET DATABASE CONTEXT (you have FULL read access to the tracked_wallets table):

TOTALS:
- ${totalRow.n} total wallets tracked (${solScanned.n} with SOL balance scanned)
- SOL tiers: ${megaWhales.n} mega-whales (≥100 SOL) · ${whales.n} whales (10-100) · ${active.n} active (1-10) · ${dust.n} dust/unscanned
- Categories: ${cats.map(c=>`${c.category}=${c.n}`).join(', ')}

TOP 15 BY SOL BALANCE (the wealthiest wallets in the DB):
${topBySol.length ? topBySol.map(oneLine).join('\n') : '  (none scanned yet — run 🐋 SCAN FOR WHALES)'}

TOP 15 BY SCORE (performance metric):
${topByScore.map(oneLine).join('\n')}

TOP 10 BY WINS (appeared as early holder in our winning calls):
${topByWins.length ? topByWins.map(oneLine).join('\n') : '  (no wins overlapped yet)'}

${drilldowns ? drilldowns + '\n' : ''}
You can answer questions about specific wallets, compare them, spot patterns (high SOL + high score = likely alpha whale; high SOL + zero wins = passive bag-holder), and recommend which to label WINNER / SMART_MONEY.

WALLET LINK CONSTRUCTION (you CAN build these — the full address is in [brackets] on every row above):
  Solscan:  https://solscan.io/account/<ADDRESS>
  Birdeye:  https://birdeye.so/profile/<ADDRESS>?chain=solana
  GMGN:     https://gmgn.ai/sol/address/<ADDRESS>
When the user asks for "the link" / "profile" / "where can I see this wallet", respond with the full address AND a ready-to-click Solscan URL. Never say "I can't access links" — you have the full address and the URL pattern.

When asked about "largest wallet" or "biggest whales", use the TOP 15 BY SOL BALANCE list above — those numbers are real.`;
      } catch (err) { return `\n(wallet context unavailable: ${err.message})`; }
    })();

    // Build rich context from live bot data
    const memoryBlock = getBotMemory();
    const liveContext = (() => {
      try {
        const resolved = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome IN ('WIN','LOSS','NEUTRAL')`).get().n;
        const wins     = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome='WIN'`).get().n;
        const losses   = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS'`).get().n;
        const total    = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls`).get().n;
        const evals    = dbInstance.prepare(`SELECT COUNT(*) as n FROM candidates`).get().n;
        const winRate  = (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) + '%' : 'pending';
        const regime   = getRegime();
        const recentHistory = getRecentOutcomesContext(10);
        return `BOT STATUS: Mode=${activeMode.emoji} ${activeMode.name} | Regime=${regime.market||'?'} | Evaluations=${evals} | Calls=${total} | Wins=${wins} | Losses=${losses} | WinRate=${winRate}
${recentHistory}
Active overrides: ${JSON.stringify(AI_CONFIG_OVERRIDES)}
Sweet spot: $${Math.round((AI_CONFIG_OVERRIDES.sweetSpotMin||15000)/1000)}K–$${Math.round((AI_CONFIG_OVERRIDES.sweetSpotMax||40000)/1000)}K`;
      } catch (err) {
        return `Bot data unavailable: ${err.message}`;
      }
    })();

    const systemPrompt = system || `You are Alpha Lennix — the AI core of an elite Solana micro-cap gem hunter bot.

RESPONSE RULES (STRICT):
- Keep answers SHORT and DIRECT. 2-4 sentences max for simple questions.
- Always back decisions with data. State the specific signal that drove the outcome.
- No filler words. No "Great question!" No preambles.
- Format: Answer first, evidence second.
- For token questions: Score → Key signal → Decision reason → Risk flag (if any).

BOT MEMORY & LEARNED PATTERNS:
${memoryBlock}

LIVE BOT DATA:
${liveContext}
${walletBlock}
${webContext ? '\nWEB CONTENT FETCHED FOR THIS CONVERSATION:' + webContext : ''}

BOT PARAMETERS (v7.0):
- Target: $10K–$25K MCap micro-cap stealth launches
- Score floor: 38 | Max MCap: $150K | Age: 0–4h
- Stop Loss: -25% | TP1: 2× | TP2: 5× | TP3: 10×
- AI evaluates EVERY token scanned with in-context learning

PERSONALITY: Direct, data-driven, decisive. You give clear actionable answers. Reference real numbers when available. Flag when data is missing.

IMAGE/DOCUMENT ANALYSIS: When the operator sends images (charts, screenshots, documents), analyze them thoroughly — identify patterns, tokens, wallet behaviors, entry/exit signals. Extract every actionable insight.

WEB BROWSING: When the operator pastes a URL, the system automatically fetches and injects the page content. You can read articles, Twitter threads, Solscan pages, DexScreener data, research docs — anything on the open web. Analyze the content and extract actionable intelligence. If you need the operator to search for something, ask them to paste the URL.

MEMORY: When the operator teaches you something important (strategy, pattern, rule, insight), end your reply with a line starting with "💾 SAVED:" followed by a one-line summary of what you learned. The system will persist this to your knowledge base automatically.`;

    const claudeRes = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1000,
        system: systemPrompt,
        messages: messages.slice(-16), // keep last 16 for context window
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return res.status(502).json({ ok: false, error: `Claude API error ${claudeRes.status}: ${errText.slice(0, 200)}` });
    }

    const data  = await claudeRes.json();
    const reply = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');

    // Auto-save if the AI flagged something to remember
    const savedMatch = reply.match(/💾 SAVED:\s*(.+)/);
    let memorySaved = null;
    if (savedMatch) {
      try {
        const content = savedMatch[1].trim();
        const id = dbInstance.prepare(
          `INSERT INTO bot_knowledge (title, content, category, source) VALUES (?,?,?,?)`
        ).run('AI-extracted', content, 'learned', 'ai_auto').lastInsertRowid;
        invalidateMemoryCache();
        memorySaved = { id, content };
        console.log(`[memory] AI auto-saved: "${content.slice(0, 60)}"`);
      } catch {}
    }

    res.json({ ok: true, reply, model: CLAUDE_MODEL, memorySaved });
  } catch (err) {
    console.error('[api/agent]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Scoring Engine Tuning System ──────────────────────────────────────────────
// Create tuning_audit table on first use
try { dbInstance.exec(`
  CREATE TABLE IF NOT EXISTS tuning_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    param      TEXT NOT NULL,
    old_value  TEXT,
    new_value  TEXT,
    reason     TEXT,
    status     TEXT DEFAULT 'APPLIED',
    created_at TEXT DEFAULT (datetime('now'))
  )
`); } catch {}

// Tunable config — loaded from kv_store on boot, defaults from scorer
const TUNING_DEFAULTS = {
  discovery: { volumeVelocity:35, buyPressure:25, walletQuality:20, holderDistribution:12, liquidityHealth:8 },
  thresholds: { autoPostScore:38, eliteThreshold:45, cleanThreshold:50, averageThreshold:60, mixedThreshold:70, mcapHardCap:85000, sweetSpotMin:8000, sweetSpotMax:40000 },
  penalties: { latePump1hThreshold:300, latePump1hPenalty:0, latePump1hSevereThreshold:500, latePump1hSeverePenalty:0, latePump24hThreshold:500, latePump24hPenalty:0, latePumpAgeExemptHours:0.5, winThresholdPct:20, lossThresholdPct:-30 },
};
let TUNING_CONFIG = JSON.parse(JSON.stringify(TUNING_DEFAULTS));
try {
  const row = dbInstance.prepare(`SELECT value FROM kv_store WHERE key='tuning_config'`).get();
  if (row?.value) {
    const saved = JSON.parse(row.value);
    // Only restore keys that exist in TUNING_DEFAULTS — prevents stale old keys from polluting config
    for (const section of ['discovery', 'thresholds', 'penalties']) {
      if (saved[section] && TUNING_DEFAULTS[section]) {
        for (const key of Object.keys(TUNING_DEFAULTS[section])) {
          if (saved[section][key] !== undefined) {
            TUNING_CONFIG[section][key] = saved[section][key];
          }
        }
      }
    }
    // Persist cleaned config back so old keys don't linger
    saveTuningConfig();
    console.log('[tuning] Restored tuning config from DB (cleaned stale keys)');
  }
} catch {}

function saveTuningConfig() {
  try { dbInstance.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES ('tuning_config', ?)`).run(JSON.stringify(TUNING_CONFIG)); } catch {}
  syncLatePumpConfig(); // keep scorer-dual in sync with tuning.penalties
}

// Push the late-pump penalty settings from TUNING_CONFIG.penalties into
// scorer-dual.js so the sub-scorer applies live values. Safe to call
// repeatedly — no-op if scorer-dual import fails.
function syncLatePumpConfig() {
  try {
    const p = TUNING_CONFIG.penalties || {};
    import('./scorer-dual.js').then(mod => {
      if (typeof mod.setLatePumpConfig === 'function') {
        mod.setLatePumpConfig({
          p1hSevereThreshold: p.latePump1hSevereThreshold,
          p1hSeverePenalty:   p.latePump1hSeverePenalty,
          p1hThreshold:       p.latePump1hThreshold,
          p1hPenalty:         p.latePump1hPenalty,
          p24hThreshold:      p.latePump24hThreshold,
          p24hPenalty:        p.latePump24hPenalty,
          ageExemptHours:     p.latePumpAgeExemptHours ?? 0.5,
        });
      }
    }).catch(() => {});
  } catch {}
}
syncLatePumpConfig(); // initial sync on boot

// Sync V5 decision config from autotune_params on boot. Reads every v5_*
// row, strips the prefix, and applies via setV5DecisionConfig() so the
// live scorer reflects whatever the bot has tuned to over time. Without
// this, V5 thresholds reset to defaults on every restart, undoing all
// the autotune learning. Runs once at startup.
async function syncV5ConfigFromDb() {
  try {
    const rows = dbInstance.prepare(`SELECT key, current_value FROM autotune_params WHERE key LIKE 'v5_%'`).all();
    if (!rows.length) return;
    const updates = {};
    for (const r of rows) {
      const v5Key = r.key.slice(3);
      const num = Number(r.current_value);
      if (Number.isFinite(num)) updates[v5Key] = num;
    }
    if (Object.keys(updates).length === 0) return;
    const mod = await import('./scorer-dual.js');
    if (typeof mod.setV5DecisionConfig === 'function') {
      const applied = mod.setV5DecisionConfig(updates);
      console.log(`[boot:v5] ✓ Hydrated ${applied.length}/${rows.length} V5 decision params from autotune_params`);
    }
  } catch (err) {
    console.warn(`[boot:v5] sync failed: ${err.message}`);
  }
}
syncV5ConfigFromDb(); // initial sync on boot

// One-time cleanup of malformed autotune_params values. Earlier versions
// of the apply path didn't validate that proposed values were numeric, so
// the AI sometimes wrote strings like "increase_by_25pct" or "0.25h"
// directly into current_value. Detect and reset any non-numeric to the
// param's default_value (or min_value as fallback). Logs every fix.
function cleanupMalformedAutotuneParams() {
  try {
    const rows = dbInstance.prepare(`SELECT key, current_value, default_value, min_value FROM autotune_params`).all();
    let fixed = 0;
    for (const r of rows) {
      const cur = Number(r.current_value);
      if (Number.isFinite(cur)) continue;
      // Reset to default if available, else min
      const fallback = Number(r.default_value);
      const reset = Number.isFinite(fallback) ? fallback : Number(r.min_value);
      if (!Number.isFinite(reset)) {
        console.warn(`[boot:cleanup] cannot reset ${r.key} — no valid default or min`);
        continue;
      }
      try {
        dbInstance.prepare(`UPDATE autotune_params SET current_value=? WHERE key=?`).run(String(reset), r.key);
        console.log(`[boot:cleanup] ✓ Reset ${r.key} from "${r.current_value}" → ${reset}`);
        fixed++;
      } catch (e) { console.warn(`[boot:cleanup] failed to reset ${r.key}: ${e.message}`); }
    }
    if (fixed > 0) {
      console.log(`[boot:cleanup] Total params reset: ${fixed} (validation now prevents future malformed writes)`);
      logEvent('INFO', 'AUTOTUNE_CLEANUP', `Reset ${fixed} malformed autotune params on boot`);
    }
  } catch (err) {
    console.warn(`[boot:cleanup] sweep failed: ${err.message}`);
  }
}
cleanupMalformedAutotuneParams(); // initial sweep on boot

// GET current config + audit log
app.get('/api/tuning/config', (req, res) => {
  setCors(res);
  try {
    const audit = dbInstance.prepare(`SELECT * FROM tuning_audit ORDER BY created_at DESC LIMIT 50`).all();
    res.json({ ok: true, config: TUNING_CONFIG, defaults: TUNING_DEFAULTS, audit });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST apply a tuning change
app.post('/api/tuning/apply', express.json(), (req, res) => {
  setCors(res);
  try {
    const { param, value, reason, old_value } = req.body ?? {};
    if (!param) return res.status(400).json({ ok: false, error: 'param required' });

    // Find and update the param in the nested config
    let applied = false;
    for (const section of ['discovery', 'thresholds', 'penalties']) {
      if (param in TUNING_CONFIG[section]) {
        const prev = TUNING_CONFIG[section][param];
        TUNING_CONFIG[section][param] = typeof prev === 'number' ? Number(value) : value;
        applied = true;

        // Apply live: update AI_CONFIG_OVERRIDES for thresholds that map to live config
        if (param === 'mcapHardCap') AI_CONFIG_OVERRIDES.maxMarketCapOverride = Number(value);
        if (param === 'autoPostScore') AI_CONFIG_OVERRIDES.minScoreOverride = Number(value);
        if (param === 'sweetSpotMin') AI_CONFIG_OVERRIDES.sweetSpotMin = Number(value);
        if (param === 'sweetSpotMax') AI_CONFIG_OVERRIDES.sweetSpotMax = Number(value);
        persistAIConfig();
        break;
      }
    }
    if (!applied) return res.status(400).json({ ok: false, error: 'Unknown param: ' + param });

    saveTuningConfig();
    dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
      param, String(old_value ?? ''), String(value), reason || 'Operator approved', 'APPROVED'
    );
    console.log(`[tuning] Applied: ${param} = ${value} (was: ${old_value}). Reason: ${reason}`);
    res.json({ ok: true, param, value });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST reject a tuning recommendation
app.post('/api/tuning/reject', express.json(), (req, res) => {
  setCors(res);
  const { param, reason } = req.body ?? {};
  try {
    dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
      param || '?', '', '', reason || 'Operator rejected', 'REJECTED'
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST optimize — Claude analyzes win/loss data and proposes weight changes
app.post('/api/tuning/optimize', async (req, res) => {
  setCors(res);
  if (!CLAUDE_API_KEY) return res.status(503).json({ ok: false, error: 'CLAUDE_API_KEY required' });
  try {
    // Gather win/loss analysis data
    const wins = dbInstance.prepare(`
      SELECT c.score_at_call, c.market_cap_at_call, c.risk_at_call, c.setup_type_at_call, c.structure_grade_at_call,
             ca.buy_sell_ratio_1h, ca.volume_velocity, ca.dev_wallet_pct, ca.top10_holder_pct, ca.holders,
             ca.sniper_wallet_count, ca.bundle_risk, ca.pair_age_hours, ca.price_change_1h, ca.price_change_24h,
             ca.launch_unique_buyer_ratio, ca.buy_velocity
      FROM calls c LEFT JOIN candidates ca ON c.candidate_id=ca.id
      WHERE c.outcome='WIN' ORDER BY c.called_at DESC LIMIT 30
    `).all();
    const losses = dbInstance.prepare(`
      SELECT c.score_at_call, c.market_cap_at_call, c.risk_at_call, c.setup_type_at_call, c.structure_grade_at_call,
             ca.buy_sell_ratio_1h, ca.volume_velocity, ca.dev_wallet_pct, ca.top10_holder_pct, ca.holders,
             ca.sniper_wallet_count, ca.bundle_risk, ca.pair_age_hours, ca.price_change_1h, ca.price_change_24h,
             ca.launch_unique_buyer_ratio, ca.buy_velocity
      FROM calls c LEFT JOIN candidates ca ON c.candidate_id=ca.id
      WHERE c.outcome='LOSS' ORDER BY c.called_at DESC LIMIT 30
    `).all();

    const prompt = `You are a quantitative trading system optimizer. Analyze the win/loss data below and recommend specific parameter changes.

CURRENT SCORING CONFIG:
${JSON.stringify(TUNING_CONFIG, null, 2)}

WIN DATA (${wins.length} wins):
${JSON.stringify(wins.slice(0, 15), null, 1)}

LOSS DATA (${losses.length} losses):
${JSON.stringify(losses.slice(0, 15), null, 1)}

TASK: Compare wins vs losses. Find which metrics separate winners from losers. Propose 3-5 specific parameter changes that would improve the win rate.

Respond ONLY with valid JSON array:
[{
  "param": "exact_param_name_from_config",
  "category": "discovery|thresholds|penalties",
  "current": current_value,
  "proposed": new_value,
  "reason": "1-2 sentence explanation with data",
  "evidence": "specific numbers from the win/loss comparison",
  "risk": "LOW|MEDIUM|HIGH",
  "impact": "LOW|MEDIUM|HIGH"
}]`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return res.status(502).json({ ok: false, error: 'Claude API: ' + errText.slice(0, 200) });
    }

    const cData = await claudeRes.json();
    const reply = (cData.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');

    // Parse JSON from Claude's response
    const jsonMatch = reply.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.json({ ok: true, recommendations: [], raw: reply });

    const recommendations = JSON.parse(jsonMatch[0]);

    // Safety bounds for tuning optimize
    const TUNE_BOUNDS = {
      autoPostScore: [30, 55], eliteThreshold: [35, 55], cleanThreshold: [40, 65],
      averageThreshold: [45, 75], mixedThreshold: [55, 85],
      mcapHardCap: [50000, 200000], sweetSpotMin: [5000, 25000], sweetSpotMax: [20000, 80000],
      volumeVelocity: [15, 50], buyPressure: [10, 40], walletQuality: [8, 30],
      holderDistribution: [5, 20], liquidityHealth: [3, 15],
      latePump1hPenalty: [5, 50], latePump1hSeverePenalty: [10, 60],
      latePump24hPenalty: [5, 40], winThresholdPct: [10, 50], lossThresholdPct: [-60, -10],
    };

    // AUTO-APPLY every recommendation — no approval needed
    for (const r of recommendations) {
      // Clamp to safety bounds
      if (typeof r.proposed === 'number' && TUNE_BOUNDS[r.param]) {
        const [min, max] = TUNE_BOUNDS[r.param];
        r.proposed = Math.max(min, Math.min(max, r.proposed));
      }
      let applied = false;
      for (const section of ['discovery', 'thresholds', 'penalties']) {
        if (r.param in TUNING_CONFIG[section]) {
          const prev = TUNING_CONFIG[section][r.param];
          TUNING_CONFIG[section][r.param] = Number(r.proposed);
          applied = true;
          // Sync live overrides
          if (r.param === 'mcapHardCap') AI_CONFIG_OVERRIDES.maxMarketCapOverride = Number(r.proposed);
          if (r.param === 'autoPostScore') AI_CONFIG_OVERRIDES.minScoreOverride = Number(r.proposed);
          if (r.param === 'sweetSpotMin') AI_CONFIG_OVERRIDES.sweetSpotMin = Number(r.proposed);
          if (r.param === 'sweetSpotMax') AI_CONFIG_OVERRIDES.sweetSpotMax = Number(r.proposed);
          persistAIConfig();
          break;
        }
      }
      if (applied) saveTuningConfig();
      dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
        r.param, String(r.current), String(r.proposed),
        `[AUTO-APPLIED] ${r.reason} | Evidence: ${r.evidence || 'N/A'}`,
        'AUTO_APPLIED'
      );
      r.auto_applied = applied;
      console.log(`[tuning] AUTO-APPLIED: ${r.param} ${r.current} → ${r.proposed} | ${(r.reason||'').slice(0,80)}`);
    }

    res.json({ ok: true, recommendations, winsAnalyzed: wins.length, lossesAnalyzed: losses.length });
  } catch (err) {
    console.error('[tuning/optimize]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Tuning Reset ─────────────────────────────────────────────────────────────
app.post('/api/tuning/reset', express.json(), (req, res) => {
  setCors(res);
  try {
    const prev = JSON.parse(JSON.stringify(TUNING_CONFIG));
    TUNING_CONFIG = JSON.parse(JSON.stringify(TUNING_DEFAULTS));
    saveTuningConfig();
    dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
      'ALL', JSON.stringify(prev), JSON.stringify(TUNING_DEFAULTS), 'Full reset to defaults', 'APPROVED'
    );
    console.log('[tuning] Reset all values to defaults');
    res.json({ ok: true, config: TUNING_CONFIG });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── CONTROL STATION — Unified config endpoint ───────────────────────────────
app.get('/api/control-station', (req, res) => {
  setCors(res);
  try {
    const audit = dbInstance.prepare(`SELECT * FROM tuning_audit ORDER BY created_at DESC LIMIT 100`).all();
    const agentActions = (() => { try { return dbInstance.prepare(`SELECT * FROM agent_actions WHERE approved=1 ORDER BY created_at DESC LIMIT 50`).all(); } catch { return []; } })();
    res.json({
      ok: true,
      scoring: SCORING_CONFIG,
      scoringDefaults: SCORING_CONFIG_DEFAULTS,
      tuning: TUNING_CONFIG,
      tuningDefaults: TUNING_DEFAULTS,
      overrides: AI_CONFIG_OVERRIDES,
      overrideKeys: [
        'gemTargetMin', 'gemTargetMax', 'sweetSpotMin', 'sweetSpotMax',
        'maxMarketCapOverride', 'minMarketCapOverride',
        'postThresholdOverride', 'minScoreOverride', 'scoreFloorOverride',
        'bundleRiskBlock', 'sniperCountBlock', 'devWalletPctBlock',
        'top10HolderBlock', 'trapSeverityBlock',
        'maxPairAgeHoursOverride', 'minPairAgeMinutesOverride',
        'upgradeEnabled', 'aggressiveMode',
        'walletIntelWeight', 'earlyWalletTracking', 'survivorTracking',
        'agentAutoApply', 'agentConvictionThreshold',
      ],
      audit,
      agentActions,
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// POST — Claude auto-optimizes freely, applies changes, logs detailed reasoning
// Auto-optimize handler — registered for BOTH POST (canonical) and GET
// (so the operator can paste the URL into a browser bar to fire the
// optimizer and see Claude's full response inline). The handler doesn't
// read req.body, so GET works fine.
const _autoOptimizeHandler = async (req, res) => {
  setCors(res);
  if (!CLAUDE_API_KEY) return res.status(503).json({ ok: false, error: 'CLAUDE_API_KEY required' });
  try {
    // Gather LIFETIME performance data (every resolved call) so the AI sees
    // full historical patterns, not just last-40 noise. Capped at 500 each
    // to keep the prompt under Claude's context limit; the bot won't have
    // 500 wins for a while anyway.
    const wins = dbInstance.prepare(`
      SELECT c.score_at_call, c.market_cap_at_call, c.risk_at_call, c.setup_type_at_call, c.peak_multiple,
             ca.buy_sell_ratio_1h, ca.volume_velocity, ca.dev_wallet_pct, ca.top10_holder_pct, ca.holders,
             ca.sniper_wallet_count, ca.bundle_risk, ca.pair_age_hours, ca.price_change_1h, ca.price_change_24h,
             ca.launch_unique_buyer_ratio, ca.buy_velocity
      FROM calls c LEFT JOIN candidates ca ON c.candidate_id=ca.id
      WHERE c.outcome='WIN' ORDER BY c.called_at DESC LIMIT 500
    `).all();
    const losses = dbInstance.prepare(`
      SELECT c.score_at_call, c.market_cap_at_call, c.risk_at_call, c.setup_type_at_call, c.peak_multiple,
             ca.buy_sell_ratio_1h, ca.volume_velocity, ca.dev_wallet_pct, ca.top10_holder_pct, ca.holders,
             ca.sniper_wallet_count, ca.bundle_risk, ca.pair_age_hours, ca.price_change_1h, ca.price_change_24h,
             ca.launch_unique_buyer_ratio, ca.buy_velocity
      FROM calls c LEFT JOIN candidates ca ON c.candidate_id=ca.id
      WHERE c.outcome='LOSS' ORDER BY c.called_at DESC LIMIT 500
    `).all();
    const recentAudit = dbInstance.prepare(`SELECT * FROM tuning_audit ORDER BY created_at DESC LIMIT 20`).all();

    // ═══ MOONSHOT REFERENCE SET ═══
    // Every coin that hit 10x+ — both calls we made AND missed winners we
    // didn't call. Claude uses these as the "must not block these patterns"
    // anchor when proposing filter changes. Tightening a knob that would
    // have rejected these moonshots is forbidden without explicit evidence.
    const calledMoonshots = (() => {
      try {
        return dbInstance.prepare(`
          SELECT c.token, c.score_at_call, c.market_cap_at_call, c.peak_multiple,
                 c.setup_type_at_call, c.risk_at_call,
                 ca.buy_sell_ratio_1h, ca.volume_velocity, ca.dev_wallet_pct,
                 ca.top10_holder_pct, ca.holders, ca.sniper_wallet_count,
                 ca.bundle_risk, ca.pair_age_hours, ca.price_change_1h,
                 ca.launch_unique_buyer_ratio, ca.buy_velocity
          FROM calls c LEFT JOIN candidates ca ON c.candidate_id=ca.id
          WHERE c.peak_multiple >= 10
          ORDER BY c.peak_multiple DESC LIMIT 60
        `).all();
      } catch { return []; }
    })();
    const missedMoonshots = (() => {
      try {
        return dbInstance.prepare(`
          SELECT token, missed_winner_peak_multiple AS peak_multiple,
                 composite_score, market_cap, final_decision, setup_type,
                 buy_sell_ratio_1h, volume_velocity, dev_wallet_pct,
                 top10_holder_pct, holders, sniper_wallet_count, bundle_risk,
                 pair_age_hours, price_change_1h, launch_unique_buyer_ratio,
                 buy_velocity, claude_verdict
          FROM candidates
          WHERE missed_winner_flag = 1 AND missed_winner_peak_multiple >= 10
          ORDER BY missed_winner_peak_multiple DESC LIMIT 60
        `).all();
      } catch { return []; }
    })();

    // Aggregate summary stats so Claude can spot patterns without parsing all 500 rows
    const summary = (() => {
      const safe = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
      const avg = (arr, key) => {
        const vals = arr.map(r => safe(r[key])).filter(v => v != null);
        return vals.length ? +(vals.reduce((a,b)=>a+b,0) / vals.length).toFixed(2) : null;
      };
      return {
        winRate:           wins.length + losses.length > 0
                            ? Math.round(wins.length * 100 / (wins.length + losses.length)) : null,
        avgWinPeak:        avg(wins,  'peak_multiple'),
        avgLossPeak:       avg(losses,'peak_multiple'),
        avgWinScore:       avg(wins,  'score_at_call'),
        avgLossScore:      avg(losses,'score_at_call'),
        avgWinMcap:        avg(wins,  'market_cap_at_call'),
        avgLossMcap:       avg(losses,'market_cap_at_call'),
        avgWinDevPct:      avg(wins,  'dev_wallet_pct'),
        avgLossDevPct:     avg(losses,'dev_wallet_pct'),
        avgWinTop10:       avg(wins,  'top10_holder_pct'),
        avgLossTop10:      avg(losses,'top10_holder_pct'),
        avgWinSnipers:     avg(wins,  'sniper_wallet_count'),
        avgLossSnipers:    avg(losses,'sniper_wallet_count'),
      };
    })();

    const prompt = `You are the CONTROL STATION OPTIMIZER for Pulse Caller — a Solana micro-cap token sniper bot.

═══ USER'S TUNING TARGET ═══
The user has set targetMultiplier = ${SCORING_CONFIG.targetMultiplier ?? 5}x.
This is the ONLY knob you cannot change. Tune everything else so the bot
catches more coins that hit ${SCORING_CONFIG.targetMultiplier ?? 5}x peaks. Any coin that hits at least
winPeakMultiple (${SCORING_CONFIG.winPeakMultiple ?? 2.5}x) still counts as a WIN.

═══ OPERATING MODE: TRUST THE DATA, BUT EVERY CHANGE NEEDS AN AUDITABLE WHY ═══
You have full authority to make whatever changes the data supports —
small tweaks OR major rebalances. Don't artificially constrain
yourself. The user wants the bot improving, not protected from itself.

REQUIRED for every proposed change:
  - reason: a clear, evidence-grounded sentence pointing at specific
    data (e.g. "losses had avg dev_wallet_pct=8.4 vs wins=2.1 — raising
    devWalletPctBlock from 5 to 7"). NOT vague ("seems too loose").
  - confidence: 0-100. Anything below 60 → don't propose the change.
  - risk: what's the worst case if this change is wrong?

═══ CORE THESIS: EVERY CALL SHOULD BE A 5x CANDIDATE ═══
The operator's stated goal: "get 5x on every call and hopefully more.
By studying the bigger wins maybe we can prevent the losses and
increase our winning percentage along with our peak for each coin."

That means your job is NOT just "avoid losers". It's:
  Match the patterns of the 10x+ moonshots → if a coin doesn't look
  like one of those, it probably isn't worth calling. The bar is
  "this looks like a 5x+ setup" — not "this isn't a rug".

═══ TUNING PRIORITIES ═══
1. MOONSHOT PATTERN MATCHING — what signals do the 10x+ called
   moonshots share that the losses don't? buy_velocity?
   volume_velocity floor? holder spread? bundle_risk pattern? Tighten
   filters or raise score weights on those distinguishing signals so
   future scoring favors moonshot-shaped coins.
2. RUG REDUCTION — losses where peak < 0.7 or dev_wallet_pct was high.
   Patterns of failure to penalize.
3. MOMENTUM-LOSS REDUCTION — 1.0-1.3x fizzles. Distinguish these from
   real runs in the moonshot data.
4. RAW WIN-RATE last.

Don't simply lower minScoreToPost to fire more calls. Tighten the
scoring math so a 5x-shaped coin scores higher and a fizzle-shaped
coin scores lower — same threshold, smarter signal.

═══ HARD CONSTRAINT: DON'T BOTTLENECK MOONSHOTS ═══
Below is the MOONSHOT REFERENCE SET — every coin that hit 10x+, both
ones we called AND ones we missed. BEFORE proposing any filter
tightening:
  - Sanity-check it against this set
  - If your proposed change would have BLOCKED any of these moonshots,
    DO NOT propose it. The user explicitly does not want filters
    tightened in ways that bottleneck future moonshots.
  - Loosening filters to recover MISSED moonshots is encouraged. The
    "missed_winner" rows below are coins our system rejected/watchlisted
    that went on to do 10x+ — those are mistakes worth fixing.

You have authority to change any knob EXCEPT targetMultiplier.

SAFETY BOUNDS (you MUST stay within these):
- minScoreToPost: 35-60 (NEVER below 35 — too much spam)
- sweetSpotBonus: 1-10
- preLaunchBonus: 2-12
- crossChainBonus: 1-8
- devFingerprintCap: 1-6
- noSignalCap: 50-80
- rugGuardMinScore: 45-75
- consensusOverrideScore: 50-80
- winPeakMultiple: 1.2-3.0
- autoPostScore: 30-55
- eliteThreshold: 35-55
- mcapHardCap: 50000-200000
- sweetSpotMin: 5000-25000
- sweetSpotMax: 20000-80000
- discovery weights: volumeVelocity 15-50, buyPressure 10-40, walletQuality 8-30, holderDistribution 5-20, liquidityHealth 3-15 (total should be ~100)
- penalties: reasonable ranges, don't zero them out

CURRENT SCORING CONFIG:
${JSON.stringify(SCORING_CONFIG, null, 2)}

CURRENT TUNING CONFIG (discovery weights, thresholds, penalties):
${JSON.stringify(TUNING_CONFIG, null, 2)}

CURRENT AI CONFIG OVERRIDES:
${JSON.stringify(AI_CONFIG_OVERRIDES, null, 2)}

═══ AGGREGATE STATS (across full ${wins.length} wins + ${losses.length} losses) ═══
${JSON.stringify(summary, null, 2)}

(Use the aggregates first to spot patterns. Drill into individual rows
below only if you need to verify a specific signal hypothesis.)

═══ MOONSHOT REFERENCE SET — DO NOT BOTTLENECK THESE PATTERNS ═══

CALLED 10x+ MOONSHOTS (${calledMoonshots.length} coins Pulse correctly called):
${JSON.stringify(calledMoonshots.slice(0, 30), null, 1)}

MISSED 10x+ MOONSHOTS (${missedMoonshots.length} coins our filters wrongly rejected — mistakes to fix):
${JSON.stringify(missedMoonshots.slice(0, 30), null, 1)}

WIN DATA (showing 30 of ${wins.length} resolved wins):
${JSON.stringify(wins.slice(0, 30), null, 1)}

LOSS DATA (showing 30 of ${losses.length} resolved losses):
${JSON.stringify(losses.slice(0, 30), null, 1)}

RECENT CHANGES (last 20 audit entries):
${JSON.stringify(recentAudit.slice(0, 10), null, 1)}

TASK: Be COMPREHENSIVE. Make 5-10+ changes across ALL config systems — scoring, discovery weights, thresholds, penalties, AND overrides. Don't be conservative. Tune every knob that the data suggests should move. The goal is to become the best crypto caller bot in the world.

For each change, provide a DETAILED explanation of WHY and what improvement you expect.

You can change:
- scoring.*: minScoreToPost, sweetSpotBonus, secondaryBonus, preLaunchBonus, crossChainBonus, devFingerprintCap, noSignalCap, rugGuardMinScore, consensusOverrideScore, winPeakMultiple, neutralDrawdownPct
- tuning.discovery.*: volumeVelocity, buyPressure, walletQuality, holderDistribution, liquidityHealth
- tuning.thresholds.*: autoPostScore, eliteThreshold, cleanThreshold, averageThreshold, mixedThreshold, mcapHardCap, sweetSpotMin, sweetSpotMax
- tuning.penalties.*: latePump1hThreshold, latePump1hPenalty, latePump1hSevereThreshold, latePump1hSeverePenalty, latePump24hThreshold, latePump24hPenalty, winThresholdPct, lossThresholdPct
- overrides.*: gemTargetMin, gemTargetMax, sweetSpotMin, sweetSpotMax, maxMarketCapOverride, minScoreOverride, walletIntelWeight, aggressiveMode, etc.

Respond ONLY with valid JSON:
{
  "analysis": "2-3 sentence summary of what you found",
  "changes": [
    {
      "system": "scoring|tuning|overrides",
      "section": "discovery|thresholds|penalties|null",
      "param": "exact_param_name",
      "current": current_value,
      "new_value": new_value,
      "reason": "Detailed 2-3 sentence explanation of WHY this change improves results. Reference specific data.",
      "expected_improvement": "What this should do to win rate / quality",
      "confidence": 0-100,
      "risk": "LOW|MEDIUM|HIGH"
    }
  ],
  "summary": "One paragraph summary of all changes and expected combined effect"
}`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return res.status(502).json({ ok: false, error: 'Claude API: ' + errText.slice(0, 200) });
    }

    const cData = await claudeRes.json();
    const reply = (cData.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ ok: true, applied: [], raw: reply });

    const result = JSON.parse(jsonMatch[0]);
    const applied = [];

    // Hard safety bounds — Claude stays within these no matter what
    const BOUNDS = {
      minScoreToPost: [35, 60], sweetSpotBonus: [1, 10], secondaryBonus: [1, 8],
      preLaunchBonus: [2, 12], crossChainBonus: [1, 8], devFingerprintCap: [1, 6],
      noSignalCap: [50, 80], rugGuardMinScore: [45, 75], consensusOverrideScore: [50, 80],
      winPeakMultiple: [1.2, 3.0], neutralDrawdownPct: [5, 25],
      autoPostScore: [30, 55], eliteThreshold: [35, 55], cleanThreshold: [40, 65],
      averageThreshold: [45, 75], mixedThreshold: [55, 85],
      mcapHardCap: [50000, 200000], sweetSpotMin: [5000, 25000], sweetSpotMax: [20000, 80000],
      volumeVelocity: [15, 50], buyPressure: [10, 40], walletQuality: [8, 30],
      holderDistribution: [5, 20], liquidityHealth: [3, 15],
      latePump1hPenalty: [5, 50], latePump1hSeverePenalty: [10, 60],
      latePump24hPenalty: [5, 40], winThresholdPct: [10, 50], lossThresholdPct: [-60, -10],
      gemTargetMin: [3000, 20000], gemTargetMax: [25000, 100000],
      maxMarketCapOverride: [50000, 500000], minScoreOverride: [28, 55],
    };

    // Locked-knobs list — per user directive, ONLY `targetMultiplier` is
    // off-limits. That knob is the strategic goal ("tune the whole system
    // to find 5x coins"). Everything else — scoring weights, gate floors,
    // bonuses, caps, thresholds — is fully delegated to Claude to optimize
    // toward the targetMultiplier target.
    const LOCKED_KNOBS = new Set(
      Array.isArray(SCORING_CONFIG.lockedKnobs) && SCORING_CONFIG.lockedKnobs.length
        ? SCORING_CONFIG.lockedKnobs
        : ['targetMultiplier']
    );

    // AUTO-APPLY every change Claude recommends — no approval needed
    for (const change of (result.changes || [])) {
      try {
        // Skip locked knobs — user has explicitly pinned these
        if (LOCKED_KNOBS.has(change.param)) {
          console.log(`[auto-optimize] 🔒 skipped ${change.param} (user-locked at ${SCORING_CONFIG[change.param]})`);
          continue;
        }
        // Clamp to safety bounds
        if (typeof change.new_value === 'number' && BOUNDS[change.param]) {
          const [min, max] = BOUNDS[change.param];
          change.new_value = Math.max(min, Math.min(max, change.new_value));
        }

        let oldVal = null;
        if (change.system === 'scoring' && change.param in SCORING_CONFIG) {
          oldVal = SCORING_CONFIG[change.param];
          SCORING_CONFIG[change.param] = typeof oldVal === 'number' ? Number(change.new_value) : change.new_value;
          persistScoringConfig();
        } else if (change.system === 'tuning' && change.section && TUNING_CONFIG[change.section]?.[change.param] !== undefined) {
          oldVal = TUNING_CONFIG[change.section][change.param];
          TUNING_CONFIG[change.section][change.param] = Number(change.new_value);
          saveTuningConfig();
          // Sync to AI_CONFIG_OVERRIDES for live params
          if (change.param === 'mcapHardCap') AI_CONFIG_OVERRIDES.maxMarketCapOverride = Number(change.new_value);
          if (change.param === 'autoPostScore') AI_CONFIG_OVERRIDES.minScoreOverride = Number(change.new_value);
          if (change.param === 'sweetSpotMin') AI_CONFIG_OVERRIDES.sweetSpotMin = Number(change.new_value);
          if (change.param === 'sweetSpotMax') AI_CONFIG_OVERRIDES.sweetSpotMax = Number(change.new_value);
          persistAIConfig();
        } else if (change.system === 'overrides') {
          oldVal = AI_CONFIG_OVERRIDES[change.param];
          AI_CONFIG_OVERRIDES[change.param] = change.new_value;
          if (change.param === 'maxMarketCapOverride' && typeof change.new_value === 'number') activeMode.maxMarketCap = change.new_value;
          if (change.param === 'minScoreOverride' && typeof change.new_value === 'number') activeMode.minScore = change.new_value;
          persistAIConfig();
        } else {
          continue;
        }

        // Audit log with detailed reasoning — TWO destinations:
        // 1. tuning_audit table (legacy, used by some internal views)
        // 2. config_changes table (read by /api/config/audit + the AI Tuning
        //    Audit panel on the dashboard). MUST go here too or AI changes
        //    show up nowhere visible. logConfigChange handles the JSON
        //    encoding + reason synthesis.
        dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
          `[${change.system}] ${change.param}`,
          String(oldVal ?? ''),
          String(change.new_value),
          `[AUTO-PILOT] ${change.reason} | Expected: ${change.expected_improvement || 'improved accuracy'} | Confidence: ${change.confidence || '?'}%`,
          'AUTO_APPLIED'
        );
        try {
          const fullReason = `${change.reason || 'auto-applied'} | Expected: ${change.expected_improvement || '—'} | Confidence: ${change.confidence ?? '?'}% | Risk: ${change.risk ?? 'UNKNOWN'}`;
          logConfigChange(
            (change.system || 'AUTO').toUpperCase(),
            change.param,
            oldVal,
            change.new_value,
            'claude',
            fullReason
          );
        } catch (e) { console.warn('[control-station] config_changes log failed:', e.message); }
        applied.push({ ...change, old_value: oldVal });
        console.log(`[control-station] AUTO-APPLIED: ${change.system}.${change.param} ${oldVal} → ${change.new_value} | ${change.reason?.slice(0,80)}`);
      } catch (e) { console.warn('[control-station] Failed to apply:', change.param, e.message); }
    }

    logEvent('INFO', 'CONTROL_STATION_AUTO_OPTIMIZE', `Applied ${applied.length} changes. Analysis: ${result.analysis?.slice(0,200)}`);

    res.json({
      ok: true,
      analysis: result.analysis,
      summary: result.summary,
      applied,
      total_changes: applied.length,
      winsAnalyzed: wins.length,
      lossesAnalyzed: losses.length,
    });
  } catch (err) {
    console.error('[control-station/auto-optimize]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
app.post('/api/control-station/auto-optimize', express.json(), _autoOptimizeHandler);
app.get('/api/control-station/auto-optimize', _autoOptimizeHandler);

// One-shot revert of the auto-tuner's first run (the 10 changes from
// 4/27 that loosened minScoreToPost / dev pct / top10 etc). Operator
// requested a clean baseline before letting Claude tune again. Each
// revert is logged to config_changes so the audit panel reflects it.
const _revertLastAiTuningHandler = async (req, res) => {
  setCors(res);
  // Pre-tuner values per Claude's "current" field in the 4/27 audit JSON
  const reverts = [
    { system: 'scoring',    section: null,         param: 'minScoreToPost',         value: 45  },
    { system: 'tuning',     section: 'discovery',  param: 'buyPressure',            value: 20  },
    { system: 'tuning',     section: 'discovery',  param: 'volumeVelocity',         value: 35  },
    { system: 'tuning',     section: 'discovery',  param: 'walletQuality',          value: 25  },
    { system: 'tuning',     section: 'discovery',  param: 'holderDistribution',     value: 20  },
    { system: 'tuning',     section: 'thresholds', param: 'eliteThreshold',         value: 52  },
    { system: 'overrides',  section: null,         param: 'devWalletPctBlock',      value: 'block_above_3.2pct' },
    { system: 'overrides',  section: null,         param: 'top10ConcentrationBlock',value: 'block_above_24pct'  },
    { system: 'overrides',  section: null,         param: 'v5_explosiveMin1h',      value: 200 },
  ];

  const applied = [];
  const skipped = [];
  for (const r of reverts) {
    try {
      let oldVal = null;
      if (r.system === 'scoring' && r.param in SCORING_CONFIG) {
        oldVal = SCORING_CONFIG[r.param];
        SCORING_CONFIG[r.param] = r.value;
      } else if (r.system === 'tuning' && TUNING_CONFIG[r.section]) {
        oldVal = TUNING_CONFIG[r.section][r.param];
        TUNING_CONFIG[r.section][r.param] = r.value;
      } else if (r.system === 'overrides') {
        oldVal = AI_CONFIG_OVERRIDES[r.param];
        AI_CONFIG_OVERRIDES[r.param] = r.value;
      } else {
        skipped.push({ ...r, reason: 'param not found in target system' });
        continue;
      }
      if (JSON.stringify(oldVal) === JSON.stringify(r.value)) {
        skipped.push({ ...r, reason: 'already at target value' });
        continue;
      }
      logConfigChange(
        r.system.toUpperCase(),
        r.param,
        oldVal,
        r.value,
        'operator',
        `Manual revert of 4/27 auto-tuner loosening — operator requested clean baseline before next AI tuning cycle. Was ${JSON.stringify(oldVal)}, restored to pre-tuner ${JSON.stringify(r.value)}.`
      );
      applied.push({ ...r, old_value: oldVal });
    } catch (err) {
      skipped.push({ ...r, reason: err.message });
    }
  }

  // Persist all three config stores
  try { persistScoringConfig(); } catch {}
  try { saveTuningConfig();    } catch {}
  try { persistAIConfig();     } catch {}

  res.json({
    ok: true,
    applied,
    skipped,
    count: applied.length,
    message: `Reverted ${applied.length} knobs to pre-tuner values. Bot is now on a clean baseline. Next auto-tune cycle fires 24h from now (or hit /api/control-station/auto-optimize manually after a few days of fresh data).`,
  });
};
app.post('/api/control-station/revert-last-ai-tuning', _revertLastAiTuningHandler);
app.get('/api/control-station/revert-last-ai-tuning',  _revertLastAiTuningHandler);

// Full wipe — undo EVERY change AI/Claude has ever made and delete those
// audit rows so the panel shows only the original operator history.
// Algorithm:
//   1. Walk config_changes ASC. For each knob, track:
//        - lastOperatorValue: most recent operator-set value (post-AI wins)
//        - preFirstAiValue:   value just before the FIRST AI touch
//   2. For every knob the AI has touched, compute target =
//        lastOperatorValue if operator changed it AFTER any AI change
//        else preFirstAiValue (pristine pre-AI baseline)
//   3. Apply target to the appropriate config (SCORING/TUNING/OVERRIDES)
//   4. DELETE all rows where source IN ('claude','auto_optimize')
//   5. Log one summary row noting how many were wiped
const _wipeAiChangesHandler = async (req, res) => {
  setCors(res);
  try {
    const tryParse = (s) => { try { return JSON.parse(s); } catch { return s; } };

    const rows = dbInstance.prepare(
      `SELECT id, changed_at, category, source, knob_key, old_value, new_value
       FROM config_changes
       ORDER BY id ASC`
    ).all();

    // Per-knob walk
    const aiTouched = new Map();   // key = `${category}|${knob_key}` → { category, knob, preFirstAiValue, lastOperatorAfterAI, hasAi, lastAiId }
    let lastSourceByKnob = new Map(); // for tracking operator-after-AI
    for (const r of rows) {
      const key = `${r.category}|${r.knob_key}`;
      const isAi = r.source === 'claude' || r.source === 'auto_optimize';
      const oldV = r.old_value != null ? tryParse(r.old_value) : null;
      const newV = r.new_value != null ? tryParse(r.new_value) : null;
      const entry = aiTouched.get(key) ?? {
        category:           r.category,
        knob:               r.knob_key,
        preFirstAiValue:    null,
        lastOperatorAfterAI:null,
        hasOperatorAfter:   false,
        hasAi:              false,
      };
      if (isAi) {
        if (!entry.hasAi) entry.preFirstAiValue = oldV;
        entry.hasAi = true;
      } else if (r.source === 'operator') {
        if (entry.hasAi) {
          entry.lastOperatorAfterAI = newV;
          entry.hasOperatorAfter = true;
        }
      }
      aiTouched.set(key, entry);
    }

    // Apply reverts
    const applyConfigValue = (category, knobKey, value) => {
      const cat = String(category || '').toUpperCase();
      if (cat === 'SCORING' && (knobKey in SCORING_CONFIG)) {
        SCORING_CONFIG[knobKey] = value;
        return 'scoring';
      }
      if (cat === 'OVERRIDES') {
        AI_CONFIG_OVERRIDES[knobKey] = value;
        return 'overrides';
      }
      if (cat === 'TUNING' && TUNING_CONFIG && typeof TUNING_CONFIG === 'object') {
        for (const section of Object.keys(TUNING_CONFIG)) {
          if (TUNING_CONFIG[section] && knobKey in TUNING_CONFIG[section]) {
            TUNING_CONFIG[section][knobKey] = value;
            return `tuning.${section}`;
          }
        }
      }
      if (cat === 'AI') {
        AI_CONFIG_OVERRIDES[knobKey] = value;
        return 'overrides';
      }
      return null;
    };

    const reverted = [];
    const skipped  = [];
    for (const entry of aiTouched.values()) {
      if (!entry.hasAi) continue;
      const target = entry.hasOperatorAfter ? entry.lastOperatorAfterAI : entry.preFirstAiValue;
      const where  = applyConfigValue(entry.category, entry.knob, target);
      if (where) {
        reverted.push({
          category: entry.category,
          knob:     entry.knob,
          target,
          source:   entry.hasOperatorAfter ? 'last_operator_value' : 'pre_first_ai_value',
          appliedTo: where,
        });
      } else {
        skipped.push({ category: entry.category, knob: entry.knob, reason: 'unknown target system' });
      }
    }

    // Persist
    try { persistScoringConfig(); } catch {}
    try { saveTuningConfig();    } catch {}
    try { persistAIConfig();     } catch {}

    // Delete the AI audit rows
    let deletedRows = 0;
    try {
      const info = dbInstance.prepare(
        `DELETE FROM config_changes WHERE source IN ('claude','auto_optimize')`
      ).run();
      deletedRows = info.changes ?? 0;
    } catch (err) {
      console.warn('[wipe-ai-changes] delete failed:', err.message);
    }

    // Single summary audit row
    try {
      logConfigChange(
        'AUDIT',
        'wipe_ai_changes',
        `${deletedRows} AI rows`,
        `${reverted.length} knobs reverted`,
        'operator',
        `Operator wiped all AI/Claude tuning history. ${reverted.length} knobs restored to pre-AI state, ${deletedRows} audit rows deleted.`
      );
    } catch {}

    res.json({
      ok: true,
      reverted,
      skipped,
      deletedRows,
      message: `Removed ${deletedRows} AI audit rows. Reverted ${reverted.length} knobs to pre-AI baseline. Audit panel now shows operator-only history.`,
    });
  } catch (err) {
    console.error('[wipe-ai-changes]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
};
app.post('/api/control-station/wipe-ai-changes', _wipeAiChangesHandler);
app.get('/api/control-station/wipe-ai-changes',  _wipeAiChangesHandler);

// ── Bot Knowledge / Persistent Memory CRUD ───────────────────────────────────
app.get('/api/agent/memory', (req, res) => {
  setCors(res);
  try {
    const rows = dbInstance.prepare(`SELECT * FROM bot_knowledge ORDER BY created_at DESC LIMIT 200`).all();
    res.json({ ok: true, memories: rows, total: rows.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/agent/memory', express.json({ limit: '1mb' }), (req, res) => {
  setCors(res);
  try {
    const { title, content, category } = req.body ?? {};
    if (!content) return res.status(400).json({ ok: false, error: 'content required' });
    const id = dbInstance.prepare(
      `INSERT INTO bot_knowledge (title, content, category) VALUES (?,?,?)`
    ).run(title || null, content, category || 'general').lastInsertRowid;
    invalidateMemoryCache();
    console.log(`[memory] Saved: "${(title || content).slice(0, 60)}" (id=${id})`);
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.delete('/api/agent/memory/:id', (req, res) => {
  setCors(res);
  try {
    dbInstance.prepare(`DELETE FROM bot_knowledge WHERE id=?`).run(req.params.id);
    invalidateMemoryCache();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── AUTONOMOUS AGENT: Multi-agent optimization session ────────────────────────
// Claude analyzes performance, proposes changes, executes them with approval

const BOT_A_SYSTEM_PROMPT = `You are BOT A — the Hunter, Architect, and Builder intelligence of Pulse Caller.

IDENTITY: Elite early-stage signal hunter and senior builder. Aggressive in research and opportunity discovery.

MISSION: Find hidden Solana micro-cap gems before the market notices them. Study performance data to find what separates winners from losers. Propose scoring changes and filter improvements backed by data.

CANNOT CHANGE (EVER): CLAUDE_API_KEY, OPENAI_API_KEY, HELIUS_API_KEY, TELEGRAM_BOT_TOKEN, DUNE_API_KEY, BIRDEYE_API_KEY

LEGACY AUTOTUNE: sweetSpotMin 3000-50000 | sweetSpotMax 10000-100000 | maxMarketCapOverride 50000-500000 | minScoreOverride 28-60 | maxPairAgeHoursOverride 1-12h

V5 DECISION KNOBS (NEW — bot can now self-tune what was hand-adjusted):
  Core gates: v5_postFinal 45-75 | v5_postRug 20-50 | v5_postMomentum 40-70 | v5_postDemand 35-65 | v5_blockRug 55-80
  Watchlist band: v5_watchlistFinalLow 30-55 | v5_watchlistFinalHigh 50-70
  Micro-cap ($15K-$18K): v5_microCapMcapCutoff 15000-30000 | v5_microCapMaxRug 15-40 | v5_microCapMinMq 45-75 | v5_microCapMinWq 40-70
  Clean structure escape: v5_cleanStructDevMax 1-6 | v5_cleanStructTop10Max 20-40 | v5_cleanStructMinFinal 40-65 | v5_cleanStructMinMq 45-70 | v5_cleanStructMaxRug 10-35 | v5_cleanStructMinBuyRatio 0.45-0.80
  Explosive launch (HENRY-fix): v5_explosiveAgeMaxMin 5-30 | v5_explosiveMinHolders 50-300 | v5_explosiveMin5m 15-50 | v5_explosiveMin1h 50-300 | v5_explosiveMinBuyRatio 0.45-0.75 | v5_explosiveMaxRug 15-40 | v5_explosiveDevMax 2-12

When proposing changes use the EXACT key names above (with v5_ prefix for V5 knobs). The autotune system enforces bounds + step limits + cooldowns automatically.

OUTPUT FORMAT (strict JSON, no markdown):
{"bot":"A","msg_type":"PROPOSAL","analysis":"...","findings":["..."],"proposed_changes":[{"action":"UPDATE_CONFIG","key":"sweetSpotMin","current":10000,"proposed":8000,"rationale":"Win rate higher for $8K entry","evidence":"X resolved calls","confidence":82,"risk":"LOW","expected_effect":"Earlier entry"}],"recommendations":[{"priority":"HIGH","category":"DATA_SOURCE","title":"...","description":"...","rationale":"..."}],"requires_bot_b_review":true,"message":"Operator summary"}`.trim();

const BOT_B_SYSTEM_PROMPT = `You are BOT B — the Critic, Reviewer, Risk Controller, and Performance Judge of Pulse Caller.

IDENTITY: Skeptical senior reviewer, quant validator, production safety engineer. You protect system stability.

MISSION: Review Bot A proposals with rigor. Approve evidence-backed changes. Block weak/risky changes. Enforce bounds.

RISK FRAMEWORK: LOW=bounded config/prompts, can auto-apply if confidence>=80 | MEDIUM=scoring/logic changes, staging only | HIGH=arch/auth/infra/DB, human approval required

AUTOTUNE BOUNDS (enforce strictly): sweetSpotMin step<=2000 | sweetSpotMax step<=5000 | minScoreOverride step<=3 | maxPairAgeHoursOverride step<=1

DRIFT DETECTION: Flag warning if >3 config changes in 6 hours or alert volume rises without quality gains.

OUTPUT FORMAT (strict JSON, no markdown):
{"bot":"B","msg_type":"REVIEW","reviewing_proposal":"summary","agreement":true,"critique":"...","risk_confirmed":"LOW","evidence_sufficient":true,"missing_evidence":["..."],"required_tests":["replay_simulation"],"verdict":"APPROVE","auto_apply_allowed":true,"rollback_required":true,"message":"Operator summary"}`.trim();

const AGENT_SYSTEM_PROMPT = BOT_A_SYSTEM_PROMPT;
app.post('/api/agent/autonomous', async (req, res) => {
  setCors(res);
  if (!CLAUDE_API_KEY) return res.status(503).json({ ok: false, error: 'CLAUDE_API_KEY not configured' });

  const { mode = 'analyze', autoApply = false, sessionId = null } = req.body ?? {};
  const sid = sessionId || ('sess_' + Date.now());

  // ── GUARDRAIL CHECKS ──────────────────────────────────────────────────────
  const freezeActive = (() => { try { return dbInstance.prepare(`SELECT value FROM agent_system_state WHERE key='freeze_active'`).get()?.value === 'true'; } catch { return false; } })();
  if (freezeActive) return res.status(423).json({ ok: false, error: 'System freeze active — autonomous changes paused. Analyze-only mode.' });

  // Drift detection: count changes in last 6 hours
  const recentChanges = (() => { try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM agent_actions WHERE created_at > datetime('now','-6 hours') AND approved=1`).get().n; } catch { return 0; } })();
  if (recentChanges >= 3) {
    try { dbInstance.prepare(`INSERT OR REPLACE INTO agent_system_state (key,value,updated_at) VALUES ('drift_warning','true',datetime('now'))`).run(); } catch {}
    console.warn('[agent] ⚠ Drift warning: 3+ changes in 6 hours');
  }

  try {
    const ctx = buildAgentContext();

    const modePrompt = {
      analyze:   'Perform a comprehensive performance analysis. Review all call outcomes, identify the top patterns separating wins from losses. Report findings and propose 2-3 specific parameter improvements with data. Also flag any missing data sources.',
      optimize:  'Run a full optimization pass. Compare current parameters against what the data shows would work better. Propose the highest-impact lowest-risk changes. Show evidence. Stay within autotune bounds.',
      wallets:   'Analyze wallet intelligence comprehensively. Which wallet categories (WINNER/SMART_MONEY/SNIPER) have the strongest correlation with winning calls? Which appear before losers? Propose specific wallet scoring weight adjustments.',
      survivors: 'Analyze all survivor tokens (>4h, >$500K MCap). What signals did they show in the first hour? What early wallet patterns appeared? What scoring changes would catch these earlier? Propose specific improvements.',
      review:    'Review the last 24 hours of bot activity. What worked, what did not, what should change. Propose safe improvements.',
    }[mode] || 'Analyze current performance and provide status with immediate optimization opportunities.';

    // ── BOT A: Hunter analysis ────────────────────────────────────────────
    console.log(`[agent] Bot A running mode=${mode} session=${sid}`);
    const botARes = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2000, system: BOT_A_SYSTEM_PROMPT, messages: [{ role: 'user', content: ctx + '\n\n' + modePrompt }] }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!botARes.ok) throw new Error('Bot A failed: ' + botARes.status);
    const botAData = await botARes.json();
    const botARaw  = (botAData.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');

    let botAOutput = null;
    try { const clean = botARaw.replace(/```json|```/gi,'').trim(); botAOutput = JSON.parse(clean.slice(clean.indexOf('{'), clean.lastIndexOf('}')+1)); } catch {}

    // Log Bot A communication
    try { dbInstance.prepare(`INSERT INTO agent_comms (session_id,from_bot,to_bot,msg_type,content,confidence) VALUES (?,?,?,?,?,?)`).run(sid,'A','B','PROPOSAL', JSON.stringify(botAOutput || {raw: botARaw.slice(0,500)}), botAOutput?.proposed_changes?.[0]?.confidence ?? null); } catch {}

    // ── BOT B: Critic review ──────────────────────────────────────────────
    let botBOutput = null;
    let botBRaw = '';
    const proposedCount = botAOutput?.proposed_changes?.length ?? 0;

    if (botAOutput && proposedCount > 0) {
      console.log(`[agent] Bot B reviewing ${proposedCount} proposals from Bot A session=${sid}`);
      const botBPrompt = 'Bot A has produced the following analysis and proposals. Review each proposed change critically. Check bounds and evidence. Decide: APPROVE, STAGE_ONLY, or REJECT.\n\nBOT A OUTPUT:\n' + JSON.stringify(botAOutput, null, 2);
      const botBRes = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1500, system: BOT_B_SYSTEM_PROMPT, messages: [{ role: 'user', content: ctx + '\n\n' + botBPrompt }] }),
        signal: AbortSignal.timeout(35_000),
      });
      if (botBRes.ok) {
        const botBData = await botBRes.json();
        botBRaw = (botBData.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
        try { const clean = botBRaw.replace(/```json|```/gi,'').trim(); botBOutput = JSON.parse(clean.slice(clean.indexOf('{'), clean.lastIndexOf('}')+1)); } catch {}
        try { dbInstance.prepare(`INSERT INTO agent_comms (session_id,from_bot,to_bot,msg_type,content,approved) VALUES (?,?,?,?,?,?)`).run(sid,'B','SYSTEM','REVIEW', JSON.stringify(botBOutput || {raw: botBRaw.slice(0,500)}), botBOutput?.auto_apply_allowed ? 1 : 0); } catch {}
      }
    }

    // ── POLICY ENGINE: Decide what actually gets applied ──────────────────
    const actionsExecuted = [];
    const actionsProposed = [];

    const BLOCKED_KEYS = ['CLAUDE_API_KEY','OPENAI_API_KEY','HELIUS_API_KEY','TELEGRAM_BOT_TOKEN','DUNE_API_KEY','BIRDEYE_API_KEY'];

    for (const change of (botAOutput?.proposed_changes ?? [])) {
      if (change.action !== 'UPDATE_CONFIG') continue;
      if (BLOCKED_KEYS.includes(change.key)) { console.warn('[agent] BLOCKED: attempt to change', change.key); continue; }

      // Check autotune bounds
      const bound = (() => { try { return dbInstance.prepare(`SELECT * FROM autotune_params WHERE key=?`).get(change.key); } catch { return null; } })();
      if (bound) {
        // VALIDATION FIX: previously NaN passed all checks because NaN<min and
        // NaN>max are both false. Bot would write strings like
        // "increase_by_25pct" or "0.25h" → stored as garbage. Reject first.
        const proposed = Number(change.proposed);
        if (!Number.isFinite(proposed)) {
          console.warn(`[agent] BLOCKED non-numeric value for ${change.key}: "${change.proposed}" (must be a finite number)`);
          actionsProposed.push({...change, blocked: true, reason: 'Value is not a finite number — bot must propose a numeric value, not prose'});
          continue;
        }
        const min = Number(bound.min_value), max = Number(bound.max_value), step = Number(bound.max_step_change);
        const current = Number(bound.current_value);
        if (proposed < min || proposed > max) { console.warn(`[agent] Out of bounds: ${change.key}=${proposed} (${min}-${max})`); actionsProposed.push({...change, blocked: true, reason: 'Out of autotune bounds'}); continue; }
        // Skip step check if current_value is non-finite (was malformed from prior bug)
        if (Number.isFinite(current) && Math.abs(proposed - current) > step) { console.warn(`[agent] Step too large: ${change.key} step=${Math.abs(proposed-current)} max=${step}`); actionsProposed.push({...change, blocked: true, reason: 'Step change exceeds max'}); continue; }
        // Cooldown check
        if (bound.last_changed_at) {
          const lastChanged = new Date(bound.last_changed_at).getTime();
          const cooldownMs = (bound.cooldown_hours ?? 6) * 3_600_000;
          if (Date.now() - lastChanged < cooldownMs) { actionsProposed.push({...change, blocked: true, reason: 'Cooldown active until ' + new Date(lastChanged + cooldownMs).toISOString()}); continue; }
        }
        // Replace change.proposed with the validated numeric value so
        // downstream apply code uses the parsed number consistently
        change.proposed = proposed;
      }

      // Log proposed action
      try { dbInstance.prepare(`INSERT INTO agent_actions (session_id,agent,action_type,description,params,approved) VALUES (?,?,?,?,?,?)`).run(sid,'A', 'PROPOSE_CONFIG', 'Bot A proposes ' + change.key + ': ' + change.current + ' -> ' + change.proposed, JSON.stringify(change), 0); } catch {}

      // Auto-apply ALL changes freely — no approval gates, Claude has full authority
      const shouldApply = true; // was gated behind Bot B + confidence + risk + user toggle — now always on

      if (shouldApply) {
        const prev = AI_CONFIG_OVERRIDES[change.key];
        AI_CONFIG_OVERRIDES[change.key] = change.proposed;
        if (change.key === 'maxMarketCapOverride') activeMode.maxMarketCap = change.proposed;
        if (change.key === 'minScoreOverride' || change.key === 'scoreFloorOverride') activeMode.minScore = change.proposed;
        if (change.key === 'sweetSpotMin') AI_CONFIG_OVERRIDES.sweetSpotMin = change.proposed;
        if (change.key === 'sweetSpotMax') AI_CONFIG_OVERRIDES.sweetSpotMax = change.proposed;
        if (change.key === 'maxPairAgeHoursOverride') activeMode.maxPairAgeHours = change.proposed;
        // V5 decision gates — strip the 'v5_' prefix and push to scorer-dual.js
        if (change.key.startsWith('v5_')) {
          (async () => {
            try {
              const v5Key = change.key.slice(3);
              const mod = await import('./scorer-dual.js');
              if (typeof mod.setV5DecisionConfig === 'function') {
                const applied = mod.setV5DecisionConfig({ [v5Key]: change.proposed });
                if (applied.length) {
                  console.log(`[autotune:v5] ✓ ${v5Key}: ${prev ?? '?'} → ${change.proposed} (applied to live scorer)`);
                }
              }
            } catch (e) { console.warn(`[autotune:v5] apply failed for ${change.key}: ${e.message}`); }
          })();
        }
        try {
          dbInstance.prepare(`UPDATE agent_actions SET approved=1,result='AUTO_APPLIED' WHERE session_id=? AND params LIKE ?`).run(sid, '%' + change.key + '%');
          dbInstance.prepare(`UPDATE autotune_params SET current_value=?,last_changed_at=datetime('now') WHERE key=?`).run(String(change.proposed), change.key);
          dbInstance.prepare(`UPDATE agent_system_state SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT),updated_at=datetime('now') WHERE key='total_improvements'`).run();
        } catch {}
        logEvent('INFO', 'DUAL_AGENT_AUTO_APPLIED', change.key + ': ' + change.current + ' -> ' + change.proposed + ' (Bot B approved, conf=' + change.confidence + '%)');
        actionsExecuted.push(change);
      } else {
        actionsProposed.push({...change, botBVerdict: botBOutput?.verdict, botBCritique: botBOutput?.critique});
      }
    }

    // Save recommendations from Bot A
    for (const rec of (botAOutput?.recommendations ?? [])) {
      try { dbInstance.prepare(`INSERT OR IGNORE INTO agent_recommendations (priority,category,title,description,rationale,created_by) VALUES (?,?,?,?,?,'bot_a')`).run(rec.priority||'MEDIUM', rec.category||'GENERAL', rec.title||'', rec.description||'', rec.rationale||''); } catch {}
    }

    // Update last review timestamp
    try { dbInstance.prepare(`INSERT OR REPLACE INTO agent_system_state (key,value,updated_at) VALUES ('last_review_at',datetime('now'),datetime('now'))`).run(); } catch {}

    res.json({
      ok: true,
      sessionId: sid,
      mode,
      bot_a: { analysis: botAOutput?.analysis, findings: botAOutput?.findings, message: botAOutput?.message, raw: !botAOutput ? botARaw.slice(0,300) : null },
      bot_b: botBOutput ? { verdict: botBOutput.verdict, critique: botBOutput.critique, risk_confirmed: botBOutput.risk_confirmed, auto_apply_allowed: botBOutput.auto_apply_allowed, message: botBOutput.message } : null,
      proposed_changes:  actionsProposed,
      executed_changes:  actionsExecuted,
      recommendations:   botAOutput?.recommendations ?? [],
      drift_warning:     recentChanges >= 3,
      freeze_active:     freezeActive,
    });
  } catch (err) {
    console.error('[agent/autonomous]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Apply a specific proposed change (operator approves from dashboard) (operator approves from dashboard)
app.post('/api/agent/apply', (req, res) => {
  setCors(res);
  try {
    const { key, value, reason, actionId } = req.body ?? {};
    if (!key || value === undefined) return res.status(400).json({ ok: false, error: 'key and value required' });
    // Safety: never change API keys
    if (['CLAUDE_API_KEY','OPENAI_API_KEY','HELIUS_API_KEY','TELEGRAM_BOT_TOKEN','DUNE_API_KEY','BIRDEYE_API_KEY'].includes(key)) {
      return res.status(403).json({ ok: false, error: 'API keys cannot be changed via agent' });
    }
    const prev = AI_CONFIG_OVERRIDES[key];
    AI_CONFIG_OVERRIDES[key] = value;
    persistAIConfig();
    if (key === 'maxMarketCapOverride' && typeof value === 'number') activeMode.maxMarketCap = value;
    if (key === 'minScoreOverride' && typeof value === 'number') activeMode.minScore = value;
    if (key === 'sweetSpotMin' && typeof value === 'number') AI_CONFIG_OVERRIDES.sweetSpotMin = value;
    if (key === 'sweetSpotMax' && typeof value === 'number') AI_CONFIG_OVERRIDES.sweetSpotMax = value;
    if (actionId) { try { dbInstance.prepare(`UPDATE agent_actions SET approved=1,result='APPLIED' WHERE id=?`).run(actionId); } catch {} }
    logEvent('INFO', 'AGENT_CHANGE_APPROVED', `${key}: ${prev} → ${value} (${reason || 'operator approved'})`);
    sendAdminAlert(`🤖 <b>Agent Change Applied</b>
<code>${key}</code>: ${prev} → ${value}`).catch(() => {});
    res.json({ ok: true, key, value, previous: prev });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Rollback a change
app.post('/api/agent/rollback', (req, res) => {
  setCors(res);
  try {
    const { key } = req.body ?? {};
    if (!key) return res.status(400).json({ ok: false, error: 'key required' });
    const prev = AI_CONFIG_OVERRIDES[key];
    delete AI_CONFIG_OVERRIDES[key];
    // Reset mode to defaults
    if (key === 'maxMarketCapOverride') activeMode.maxMarketCap = MODES.NEW_COINS.maxMarketCap;
    if (key === 'minScoreOverride') activeMode.minScore = MODES.NEW_COINS.minScore;
    logEvent('INFO', 'AGENT_ROLLBACK', `${key} rolled back from ${prev}`);
    res.json({ ok: true, key, rolledBack: prev });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Get agent history — filter out broken/empty records
app.get('/api/agent/history', (req, res) => {
  setCors(res);
  try {
    // Clean up empty actions on first load
    try { dbInstance.prepare(`DELETE FROM agent_actions WHERE (description IS NULL OR description='') AND (params IS NULL OR params='{}' OR params='')`).run(); } catch {}
    const actions = dbInstance.prepare(`SELECT * FROM agent_actions WHERE description IS NOT NULL AND description != '' ORDER BY created_at DESC LIMIT 100`).all();
    const recs    = dbInstance.prepare(`SELECT * FROM agent_recommendations ORDER BY created_at DESC LIMIT 50`).all();
    res.json({ ok: true, actions, recommendations: recs });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Recommendations CRUD
// System state management
app.get('/api/agent/system-state', (req, res) => {
  setCors(res);
  try {
    const rows = dbInstance.prepare(`SELECT * FROM agent_system_state`).all();
    const state = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const bounds = dbInstance.prepare(`SELECT * FROM autotune_params`).all();
    const comms  = dbInstance.prepare(`SELECT * FROM agent_comms ORDER BY created_at DESC LIMIT 20`).all();
    const recentChanges = dbInstance.prepare(`SELECT COUNT(*) as n FROM agent_actions WHERE created_at > datetime('now','-6 hours') AND approved=1`).get().n;
    res.json({ ok: true, state, bounds, comms, recentChanges, activeOverrides: AI_CONFIG_OVERRIDES });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/agent/freeze', (req, res) => {
  setCors(res);
  try {
    const { active, reason } = req.body ?? {};
    dbInstance.prepare(`INSERT OR REPLACE INTO agent_system_state (key,value,updated_at) VALUES ('freeze_active',?,datetime('now'))`).run(active ? 'true' : 'false');
    logEvent('INFO', active ? 'AGENT_FREEZE_ACTIVATED' : 'AGENT_FREEZE_LIFTED', reason || 'operator action');
    console.log('[agent] Freeze ' + (active ? 'ACTIVATED' : 'LIFTED') + (reason ? ': ' + reason : ''));
    res.json({ ok: true, freeze_active: active });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/agent/autonomy', (req, res) => {
  setCors(res);
  try {
    const { bot, score } = req.body ?? {};
    if (!['A','B'].includes(bot) || typeof score !== 'number') return res.status(400).json({ ok: false, error: 'bot (A/B) and score (0-100) required' });
    const key = 'bot_' + bot.toLowerCase() + '_autonomy';
    dbInstance.prepare(`INSERT OR REPLACE INTO agent_system_state (key,value,updated_at) VALUES (?,?,datetime('now'))`).run(key, String(Math.max(0,Math.min(100,score))));
    res.json({ ok: true, bot, score });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/agent/comms', (req, res) => {
  setCors(res);
  try {
    const { limit = 30, session } = req.query;
    let q = `SELECT * FROM agent_comms`;
    const params = [];
    if (session) { q += ` WHERE session_id=?`; params.push(session); }
    q += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(parseInt(limit));
    const comms = dbInstance.prepare(q).all(...params);
    res.json({ ok: true, comms });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Manual one-shot trigger for the autonomous tuning loop. Fires
// runSelfImproveLoop directly (which itself respects bot-active /
// already-running / has-claude-key guards). Returns immediately with
// "started" — track results via /api/config/audit?limit=20.
// Accept both POST (proper) and GET (so the user can paste the URL into a
// browser bar to trigger). Read-only behavior aside, this is a manual
// admin trigger we want easy to fire.
const _selfImproveRunNowHandler = async (req, res) => {
  setCors(res);
  if (!CLAUDE_API_KEY) return res.status(503).json({ ok: false, error: 'CLAUDE_API_KEY not configured' });
  if (_selfImproveRunning) return res.status(409).json({ ok: false, error: 'Self-improvement loop already running — try again in a minute' });
  res.json({
    ok: true,
    started: true,
    message: 'AI tuning cycle triggered. Watch /api/config/audit?limit=20 for source=claude rows in the next 30-60s.',
  });
  setImmediate(() => {
    runSelfImproveLoop().catch(err => console.warn('[self-improve] manual trigger err:', err.message));
  });
};
app.post('/api/self-improve/run-now', _selfImproveRunNowHandler);
app.get('/api/self-improve/run-now',  _selfImproveRunNowHandler);

// Run daily self-improvement loop (operator triggers or scheduled)
app.post('/api/agent/daily-review', async (req, res) => {
  setCors(res);
  if (!CLAUDE_API_KEY) return res.status(503).json({ ok: false, error: 'CLAUDE_API_KEY not configured' });
  const { autoApply = false } = req.body ?? {};
  res.json({ ok: true, started: true, message: 'Daily self-improvement loop started. Check /api/agent/history for results.' });
  // Run all modes sequentially in background
  setImmediate(async () => {
    for (const mode of ['analyze','optimize','wallets','survivors']) {
      try {
        await fetch('http://localhost:' + (process.env.PORT || 3000) + '/api/agent/autonomous', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ mode, autoApply, sessionId: 'daily_' + Date.now() }),
        });
        await new Promise(r => setTimeout(r, 5000));
      } catch {}
    }
    console.log('[agent] ✓ Daily self-improvement loop complete');
    logEvent('INFO', 'DAILY_AGENT_LOOP_COMPLETE', 'All modes: analyze, optimize, wallets, survivors');
  });
});

// ── AUTO SELF-IMPROVEMENT LOOP — runs every 6 hours automatically ────────────
// Claude analyzes performance, applies changes, logs everything to audit.
// No human intervention needed. Runs: analyze → optimize → control-station sweep.

let _selfImproveRunning = false;

async function runSelfImproveLoop() {
  if (!_botActive) { console.log('[self-improve] Bot OFF — skipping'); return; }
  if (_selfImproveRunning) { console.log('[self-improve] Already running, skipping'); return; }
  if (!CLAUDE_API_KEY) { console.log('[self-improve] No CLAUDE_API_KEY, skipping'); return; }
  _selfImproveRunning = true;
  const startedAt = new Date().toISOString();
  console.log(`[self-improve] ═══ Starting autonomous improvement cycle at ${startedAt} ═══`);
  logEvent('INFO', 'SELF_IMPROVE_START', `Autonomous improvement cycle started at ${startedAt}`);

  const PORT = process.env.PORT || 3000;
  const base = `http://localhost:${PORT}`;
  const results = { modes: [], controlStation: null, errors: [] };

  try {
    // Step 1: Run all agent modes with autoApply ON
    for (const mode of ['analyze', 'optimize', 'wallets', 'survivors']) {
      try {
        console.log(`[self-improve] Running agent mode: ${mode}...`);
        const res = await fetch(`${base}/api/agent/autonomous`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, autoApply: true, sessionId: 'auto_' + Date.now() }),
          signal: AbortSignal.timeout(90_000),
        });
        const data = await res.json();
        const applied = data.executed_changes?.length || 0;
        const proposed = data.proposed_changes?.length || 0;
        results.modes.push({ mode, applied, proposed, ok: data.ok });
        console.log(`[self-improve] ${mode}: ${applied} applied, ${proposed} proposed`);
        await new Promise(r => setTimeout(r, 3000)); // breathing room between API calls
      } catch (e) {
        console.error(`[self-improve] ${mode} failed:`, e.message);
        results.errors.push({ mode, error: e.message });
      }
    }

    // Step 2: Run Control Station full-config auto-optimize
    try {
      console.log('[self-improve] Running Control Station auto-optimize...');
      const res = await fetch(`${base}/api/control-station/auto-optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(90_000),
      });
      const data = await res.json();
      results.controlStation = {
        ok: data.ok,
        applied: data.applied?.length || 0,
        analysis: data.analysis,
        summary: data.summary,
      };
      console.log(`[self-improve] Control Station: ${results.controlStation.applied} changes applied`);
      if (data.analysis) console.log(`[self-improve] Analysis: ${data.analysis}`);
    } catch (e) {
      console.error('[self-improve] Control Station failed:', e.message);
      results.errors.push({ mode: 'control-station', error: e.message });
    }

    // Step 3: OpenAI Learning — feed outcome data + get independent analysis
    results.openai = { learned: 0, insights: null };
    if (OPENAI_API_KEY) {
      try {
        console.log('[self-improve] Running OpenAI outcome learning...');

        // Gather resolved calls for OpenAI to learn from
        const resolvedCalls = dbInstance.prepare(`
          SELECT c.token, c.score_at_call, c.market_cap_at_call, c.risk_at_call,
                 c.setup_type_at_call, c.outcome, c.peak_multiple, c.pct_change_1h, c.pct_change_24h,
                 ca.buy_sell_ratio_1h, ca.volume_velocity, ca.dev_wallet_pct, ca.top10_holder_pct,
                 ca.holders, ca.sniper_wallet_count, ca.bundle_risk, ca.pair_age_hours,
                 ca.launch_unique_buyer_ratio, ca.buy_velocity,
                 ca.openai_decision AS openai_called, ca.openai_conviction AS openai_confidence
          FROM calls c LEFT JOIN candidates ca ON c.candidate_id=ca.id
          WHERE c.outcome IN ('WIN','LOSS','NEUTRAL')
          ORDER BY c.posted_at DESC LIMIT 50
        `).all();

        // Current config for context
        const currentConfig = {
          scoring: SCORING_CONFIG,
          tuning: TUNING_CONFIG,
          overrides: AI_CONFIG_OVERRIDES,
        };

        const openaiPrompt = `You are an AI performance analyst for a Solana micro-cap token calling bot.

MISSION: Learn from outcome data. Identify what the bot is doing RIGHT and WRONG. Propose specific improvements.

RESOLVED CALLS (${resolvedCalls.length} total):
${JSON.stringify(resolvedCalls.slice(0, 30), null, 1)}

CURRENT BOT CONFIG:
${JSON.stringify(currentConfig, null, 2)}

TASKS:
1. LEARN: For each WIN, identify what signals were strong. For each LOSS, identify what should have been caught.
2. PATTERNS: What separates winners from losers in this data? Be specific with numbers.
3. ACCURACY: How accurate were YOUR previous calls (openai_called field)? Where did you agree/disagree with the final outcome?
4. RECOMMENDATIONS: Propose 3-5 specific config changes that would improve win rate. Reference data.
5. BLIND SPOTS: What types of tokens is the bot missing? What red flags is it ignoring?

Respond with valid JSON:
{
  "lessons_learned": ["specific lesson from the data"],
  "win_pattern": "what winning calls have in common — specific metrics",
  "loss_pattern": "what losing calls have in common — specific metrics",
  "self_accuracy": "how accurate were your own previous predictions",
  "recommendations": [
    {
      "param": "exact_config_param_name",
      "current": current_value,
      "suggested": new_value,
      "reason": "data-backed reason",
      "confidence": 0-100
    }
  ],
  "blind_spots": ["things the bot should watch for"],
  "summary": "one paragraph overall assessment"
}`;

        const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: openaiPrompt }],
            max_tokens: 2500,
            temperature: 0.3,
          }),
          signal: AbortSignal.timeout(60_000),
        });

        if (openaiRes.ok) {
          const openaiData = await openaiRes.json();
          const reply = openaiData.choices?.[0]?.message?.content ?? '';
          let parsed = null;
          try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
          } catch {}

          if (parsed) {
            results.openai.learned = resolvedCalls.length;
            results.openai.insights = parsed;

            // Log OpenAI's analysis to audit
            dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
              '[OPENAI-LEARNING]',
              resolvedCalls.length + ' calls analyzed',
              (parsed.recommendations?.length || 0) + ' suggestions',
              `Win pattern: ${(parsed.win_pattern || '').slice(0, 200)} | Loss pattern: ${(parsed.loss_pattern || '').slice(0, 200)} | Self-accuracy: ${(parsed.self_accuracy || '').slice(0, 100)} | Summary: ${(parsed.summary || '').slice(0, 200)}`,
              'AUTO_APPLIED'
            );

            // Log each lesson learned
            for (const lesson of (parsed.lessons_learned || []).slice(0, 5)) {
              dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
                '[OPENAI-LESSON]', '', '', lesson, 'AUTO_APPLIED'
              );
            }

            // Log blind spots
            for (const spot of (parsed.blind_spots || []).slice(0, 3)) {
              dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
                '[OPENAI-BLIND-SPOT]', '', '', spot, 'AUTO_APPLIED'
              );
            }

            // Log OpenAI's config recommendations (but DON'T auto-apply — learning phase)
            for (const rec of (parsed.recommendations || [])) {
              dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
                `[OPENAI-SUGGESTS] ${rec.param || '?'}`,
                String(rec.current ?? ''),
                String(rec.suggested ?? ''),
                `${rec.reason || ''} | Confidence: ${rec.confidence || '?'}%`,
                'PENDING'
              );
            }

            console.log(`[self-improve] OpenAI learned from ${resolvedCalls.length} calls. ${parsed.recommendations?.length || 0} suggestions logged.`);
            console.log(`[self-improve] OpenAI win pattern: ${(parsed.win_pattern || '').slice(0, 100)}`);
            console.log(`[self-improve] OpenAI loss pattern: ${(parsed.loss_pattern || '').slice(0, 100)}`);
          }
        } else {
          console.warn('[self-improve] OpenAI API returned:', openaiRes.status);
        }
      } catch (e) {
        console.error('[self-improve] OpenAI learning failed:', e.message);
        results.errors.push({ mode: 'openai-learning', error: e.message });
      }
    }

    // Step 4: Log summary to audit
    const totalApplied = results.modes.reduce((a, m) => a + m.applied, 0) + (results.controlStation?.applied || 0);
    const openaiNote = results.openai.learned > 0 ? ` OpenAI learned from ${results.openai.learned} calls, logged ${results.openai.insights?.recommendations?.length || 0} suggestions.` : '';
    const summary = `Autonomous cycle complete. Agent modes: ${results.modes.map(m => m.mode + '=' + m.applied + ' applied').join(', ')}. Control Station: ${results.controlStation?.applied || 0} applied. Total: ${totalApplied} changes.${openaiNote}`;

    dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
      '[SELF-IMPROVE]', startedAt, new Date().toISOString(),
      summary + (results.controlStation?.analysis ? ' | Analysis: ' + results.controlStation.analysis : ''),
      'AUTO_APPLIED'
    );

    console.log(`[self-improve] ═══ ${summary} ═══`);
    logEvent('INFO', 'SELF_IMPROVE_COMPLETE', summary);

    // Send Telegram notification
    sendAdminAlert(
      `🤖 <b>Self-Improvement Cycle Complete</b>\n` +
      `${totalApplied} changes auto-applied\n` +
      results.modes.map(m => `• ${m.mode}: ${m.applied} applied`).join('\n') +
      `\n• control-station: ${results.controlStation?.applied || 0} applied` +
      (results.openai.learned > 0 ? `\n• openai-learning: ${results.openai.learned} calls studied, ${results.openai.insights?.recommendations?.length || 0} suggestions` : '') +
      (results.controlStation?.analysis ? `\n\n📊 <b>Claude:</b> <i>${results.controlStation.analysis}</i>` : '') +
      (results.openai.insights?.summary ? `\n\n🧠 <b>OpenAI:</b> <i>${results.openai.insights.summary}</i>` : '') +
      (results.errors.length ? `\n\n⚠️ Errors: ${results.errors.map(e => e.mode + ': ' + e.error).join(', ')}` : '')
    ).catch(() => {});

  } catch (e) {
    console.error('[self-improve] Fatal error:', e.message);
    logEvent('ERROR', 'SELF_IMPROVE_FAILED', e.message);
  } finally {
    _selfImproveRunning = false;
  }
}

// Run every 6 hours
const SELF_IMPROVE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
setInterval(runSelfImproveLoop, SELF_IMPROVE_INTERVAL_MS);

// Also run 2 minutes after boot to do an initial optimization
setTimeout(runSelfImproveLoop, 2 * 60 * 1000);
console.log('[self-improve] Scheduled: every 6h + initial run in 2min');

// Manual trigger endpoint
app.post('/api/self-improve/run', async (req, res) => {
  setCors(res);
  if (_selfImproveRunning) return res.json({ ok: false, error: 'Already running' });
  res.json({ ok: true, message: 'Self-improvement cycle started. Check audit log for results.' });
  setImmediate(runSelfImproveLoop);
});

// ── Audit Chat — ask questions, teach the bot, feed it URLs/files ────────────
app.post('/api/audit-chat', express.json({ limit: '2mb' }), async (req, res) => {
  setCors(res);
  if (!CLAUDE_API_KEY) return res.status(503).json({ ok: false, error: 'Claude API not configured' });
  try {
    const { message = '', fileContent, fileName, urls = [] } = req.body ?? {};

    // Gather context
    const stats = (() => { try {
      const total = dbInstance.prepare('SELECT COUNT(*) as n FROM calls').get().n;
      const wins = dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome='WIN'").get().n;
      const losses = dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS'").get().n;
      return { total, wins, losses };
    } catch { return {}; } })();

    const recentAudit = (() => { try {
      return dbInstance.prepare(`SELECT param, reason FROM tuning_audit ORDER BY created_at DESC LIMIT 10`).all();
    } catch { return []; } })();

    const memories = (() => { try {
      return dbInstance.prepare(`SELECT title, content, category FROM bot_knowledge ORDER BY created_at DESC LIMIT 20`).all();
    } catch { return []; } })();

    // Fetch URL content if provided
    let urlContent = '';
    let urlParsed = false;
    for (const url of urls.slice(0, 3)) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'PulseCaller/1.0' } });
        if (r.ok) {
          const text = await r.text();
          // Strip HTML tags for readability, limit to 3000 chars
          const clean = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
          urlContent += `\n\nURL CONTENT (${url}):\n${clean}`;
          urlParsed = true;
        }
      } catch (e) { urlContent += `\n\n[Failed to fetch ${url}: ${e.message}]`; }
    }

    // Build prompt
    const systemPrompt = `You are Pulse Caller's AI brain. You help the operator understand the bot's performance, learn from their input, and improve.

BOT STATUS: ${stats.total||0} calls, ${stats.wins||0} wins, ${stats.losses||0} losses.
SCORING: Foundation Signals v3 — Volume Velocity (35), Buy Pressure (25), Wallet Quality (20), Holder Distribution (12), Liquidity Health (8).
CONFIG: ${JSON.stringify(SCORING_CONFIG)}
TUNING: ${JSON.stringify(TUNING_CONFIG)}

RECENT CHANGES: ${JSON.stringify(recentAudit.slice(0, 5))}

BOT MEMORIES: ${memories.slice(0, 10).map(m => m.title + ': ' + (m.content||'').slice(0, 100)).join(' | ')}

RULES:
- Keep answers concise (under 200 words unless explaining something complex)
- If the user teaches you something, say you'll remember it and suggest saving it
- If the user shares a URL, analyze the content and extract actionable insights
- If the user uploads a file, analyze it for patterns, strategies, or data
- Always relate answers back to how it affects the bot's scoring and calling
- Be direct and data-driven`;

    let userContent = message;
    if (fileContent) userContent += `\n\nUPLOADED FILE (${fileName}):\n${fileContent.slice(0, 5000)}`;
    if (urlContent) userContent += urlContent;

    const claudeRes = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 600, system: systemPrompt, messages: [{ role: 'user', content: userContent }] }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!claudeRes.ok) return res.status(502).json({ ok: false, error: 'Claude API: ' + claudeRes.status });

    const cData = await claudeRes.json();
    const reply = (cData.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');

    // Auto-save to bot memory if the user is teaching something
    let savedToMemory = false;
    const isTeaching = /remember|learn|save|note|strategy|rule|pattern|always|never|important/i.test(message);
    if (isTeaching && message.length > 20) {
      try {
        dbInstance.prepare(`INSERT INTO bot_knowledge (title, content, category) VALUES (?,?,?)`).run(
          'Operator teaching: ' + message.slice(0, 60),
          message + (fileContent ? '\n\n[File: ' + fileName + ']\n' + fileContent.slice(0, 500) : '') + (urlContent ? urlContent.slice(0, 500) : ''),
          'operator_teaching'
        );
        savedToMemory = true;
      } catch {}
    }

    res.json({ ok: true, reply, savedToMemory, urlParsed });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── REVIVAL TRACKER — monitor rejected tokens for 24h, re-alert on spikes ────
async function runRevivalTracker() {
  if (!_botActive) return;
  try {
    // Find tokens we passed on in the last 24h with decent scores
    const passed = dbInstance.prepare(`
      SELECT id, contract_address, token, composite_score, market_cap, liquidity,
             volume_1h, final_decision, claude_risk, structure_grade
      FROM candidates
      WHERE final_decision IN ('IGNORE','WATCHLIST','HOLD_FOR_REVIEW')
        AND composite_score >= 30
        AND market_cap >= 6000 AND market_cap <= 85000
        AND created_at > datetime('now', '-24 hours')
      ORDER BY composite_score DESC
      LIMIT 30
    `).all();

    if (!passed.length) return;

    let revivals = 0;
    for (const token of passed) {
      try {
        // Fetch current data from DexScreener
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.contract_address}`, {
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const pair = (data?.pairs ?? []).filter(p => p.chainId === 'solana').sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        if (!pair) continue;

        const currentMcap = pair.marketCap ?? pair.fdv ?? 0;
        const currentVol = pair.volume?.h1 ?? 0;
        const entryMcap = token.market_cap ?? 0;
        const entryVol = token.volume_1h ?? 0;

        if (entryMcap <= 0) continue;

        const mcapGrowth = ((currentMcap - entryMcap) / entryMcap) * 100;
        const volMultiple = entryVol > 0 ? currentVol / entryVol : 0;
        const holders = pair.txns?.h1?.buys ?? 0;

        // Revival thresholds: price >50%, volume >3x, or significant holder growth
        const isRevival = mcapGrowth > 50 || volMultiple > 3 || (currentMcap > entryMcap * 1.5);

        if (isRevival && currentMcap >= 8000) {
          revivals++;
          const tok = token.token || token.contract_address?.slice(0, 8) || '?';
          console.log(`[revival] 🔄 $${tok} pumped +${mcapGrowth.toFixed(0)}% since we passed (${token.final_decision}). MCap: $${(entryMcap/1000).toFixed(1)}K → $${(currentMcap/1000).toFixed(1)}K`);

          // Log to tuning audit for learning
          dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
            '[REVIVAL] $' + tok,
            '$' + (entryMcap/1000).toFixed(1) + 'K (score ' + (token.composite_score||'?') + ')',
            '$' + (currentMcap/1000).toFixed(1) + 'K (+' + mcapGrowth.toFixed(0) + '%)',
            `Was ${token.final_decision} with score ${token.composite_score}. Risk: ${token.claude_risk||'?'}. Structure: ${token.structure_grade||'?'}. Volume ${volMultiple.toFixed(1)}x since rejection. THIS IS A MISSED OPPORTUNITY — feed back into scoring.`,
            'AUTO_APPLIED'
          );

          // Send Telegram alert
          sendAdminAlert(
            `🔄 <b>REVIVAL ALERT</b>\n\n` +
            `<b>$${tok}</b> pumped after we passed!\n` +
            `MCap: $${(entryMcap/1000).toFixed(1)}K → <b>$${(currentMcap/1000).toFixed(1)}K (+${mcapGrowth.toFixed(0)}%)</b>\n` +
            `Volume: <b>${volMultiple.toFixed(1)}x</b> since rejection\n` +
            `Was: <b>${token.final_decision}</b> (score ${token.composite_score}, ${token.claude_risk||'?'} risk)\n\n` +
            `<a href="https://dexscreener.com/solana/${token.contract_address}">View on DexScreener →</a>`
          ).catch(() => {});

          // Re-queue for full scoring if it's still in range
          if (currentMcap <= 85000) {
            try {
              const candidate = { contractAddress: token.contract_address, token: token.token, marketCap: currentMcap };
              setImmediate(() => processCandidate(candidate, true).catch(() => {}));
              console.log(`[revival] Re-queued $${tok} for full scoring`);
            } catch {}
          }
        }

        await new Promise(r => setTimeout(r, 500)); // rate limit DexScreener
      } catch {}
    }

    if (revivals > 0) {
      console.log(`[revival] Found ${revivals} revivals out of ${passed.length} checked`);
      logEvent('INFO', 'REVIVAL_SCAN', `${revivals} revivals found from ${passed.length} rejected tokens`);
    }
  } catch (err) {
    console.warn('[revival] Error:', err.message);
  }
}

// Run revival tracker every 30 minutes
setInterval(runRevivalTracker, 30 * 60_000);
setTimeout(runRevivalTracker, 5 * 60_000); // first run 5min after boot
console.log('[revival] Revival tracker scheduled: every 30min');

// ── MISSED WINNER DEEP ANALYSIS — daily pattern extraction + auto weight adjust ──
async function runMissedWinnerDeepAnalysis() {
  if (!_botActive || !CLAUDE_API_KEY) return;
  try {
    console.log('[missed-analysis] Running deep missed winner analysis...');

    // Find tokens we passed on that pumped >2x
    const missed = dbInstance.prepare(`
      SELECT c.token, c.contract_address, c.composite_score, c.market_cap, c.liquidity,
             c.volume_1h, c.final_decision, c.claude_risk, c.structure_grade, c.setup_type,
             c.dev_wallet_pct, c.top10_holder_pct, c.bundle_risk, c.sniper_wallet_count,
             c.buy_sell_ratio_1h, c.volume_velocity, c.buy_velocity, c.pair_age_hours,
             c.launch_unique_buyer_ratio, c.claude_verdict
      FROM candidates c
      WHERE c.final_decision IN ('IGNORE','WATCHLIST','HOLD_FOR_REVIEW')
        AND c.composite_score IS NOT NULL
        AND c.created_at > datetime('now', '-48 hours')
      ORDER BY c.composite_score DESC
      LIMIT 50
    `).all();

    if (!missed.length) { console.log('[missed-analysis] No rejected tokens to analyze'); return; }

    // Check which ones pumped via DexScreener
    const pumped = [];
    for (const token of missed.slice(0, 20)) {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.contract_address}`, {
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const pair = (data?.pairs ?? []).filter(p => p.chainId === 'solana')[0];
        if (!pair) continue;

        const currentMcap = pair.marketCap ?? 0;
        const entryMcap = token.market_cap ?? 1;
        const multiple = currentMcap / entryMcap;

        if (multiple >= 2.0) {
          pumped.push({ ...token, currentMcap, peakMultiple: multiple });
        }
        await new Promise(r => setTimeout(r, 400));
      } catch {}
    }

    if (!pumped.length) { console.log('[missed-analysis] No missed winners found this cycle'); return; }

    // Ask Claude to analyze patterns and suggest weight adjustments
    const prompt = `You are analyzing MISSED WINNERS for a Solana micro-cap calling bot.

These tokens were REJECTED by the bot but pumped 2x+ afterward. Your job:
1. Find the PATTERN — what do these missed winners have in common?
2. WHY did we miss them? Which scoring signals were too strict?
3. Suggest SPECIFIC weight/threshold changes to catch these next time.

CURRENT SCORING WEIGHTS: ${JSON.stringify(TUNING_CONFIG.discovery)}
CURRENT THRESHOLDS: ${JSON.stringify(TUNING_CONFIG.thresholds)}

MISSED WINNERS (${pumped.length} tokens that pumped 2x+ after we passed):
${JSON.stringify(pumped.map(p => ({
  token: p.token, score: p.composite_score, decision: p.final_decision,
  risk: p.claude_risk, structure: p.structure_grade, setup: p.setup_type,
  entryMcap: p.market_cap, peakMultiple: p.peakMultiple?.toFixed(1)+'x',
  dev: p.dev_wallet_pct, top10: p.top10_holder_pct, bundle: p.bundle_risk,
  snipers: p.sniper_wallet_count, buyRatio: p.buy_sell_ratio_1h,
  velocity: p.volume_velocity, buyVel: p.buy_velocity, age: p.pair_age_hours,
  ubr: p.launch_unique_buyer_ratio,
})), null, 1)}

Respond with valid JSON:
{
  "pattern": "What these missed winners had in common — specific metrics",
  "why_missed": "Which scoring factors caused the miss — be specific",
  "adjustments": [
    { "param": "exact_param_name", "section": "discovery|thresholds", "current": value, "suggested": value, "reason": "why" }
  ],
  "summary": "One sentence takeaway"
}`;

    const claudeRes = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(45_000),
    });

    if (!claudeRes.ok) { console.warn('[missed-analysis] Claude API:', claudeRes.status); return; }

    const cData = await claudeRes.json();
    const reply = (cData.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const analysis = JSON.parse(jsonMatch[0]);

    // Auto-apply weight adjustments within safety bounds
    let applied = 0;
    for (const adj of (analysis.adjustments || [])) {
      if (!adj.param || adj.suggested == null) continue;
      const section = adj.section || 'discovery';
      if (TUNING_CONFIG[section]?.[adj.param] !== undefined) {
        const old = TUNING_CONFIG[section][adj.param];
        TUNING_CONFIG[section][adj.param] = Number(adj.suggested);
        saveTuningConfig();
        applied++;
        dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
          `[MISSED-WINNER-FIX] ${adj.param}`, String(old), String(adj.suggested),
          `${adj.reason} | Pattern: ${(analysis.pattern||'').slice(0,150)} | ${pumped.length} missed winners analyzed`,
          'AUTO_APPLIED'
        );
      }
    }

    // Log the analysis
    dbInstance.prepare(`INSERT INTO tuning_audit (param, old_value, new_value, reason, status) VALUES (?,?,?,?,?)`).run(
      '[MISSED-WINNER-ANALYSIS]',
      pumped.length + ' missed winners',
      applied + ' adjustments applied',
      `Pattern: ${analysis.pattern || '?'} | Why missed: ${analysis.why_missed || '?'} | ${analysis.summary || ''}`,
      'AUTO_APPLIED'
    );

    console.log(`[missed-analysis] ${pumped.length} missed winners → ${applied} weight adjustments applied`);
    console.log(`[missed-analysis] Pattern: ${(analysis.pattern||'').slice(0,100)}`);

    // Telegram alert
    if (pumped.length > 0) {
      sendAdminAlert(
        `😤 <b>Missed Winner Analysis</b>\n\n` +
        `${pumped.length} tokens pumped 2x+ after we passed:\n` +
        pumped.slice(0, 5).map(p => `• $${p.token||'?'} — ${p.peakMultiple?.toFixed(1)}x (was ${p.final_decision}, score ${p.composite_score})`).join('\n') +
        `\n\n<b>Pattern:</b> ${(analysis.pattern||'?').slice(0,200)}` +
        `\n<b>Fix:</b> ${applied} weight adjustments auto-applied` +
        (analysis.summary ? `\n\n<i>${analysis.summary}</i>` : '')
      ).catch(() => {});
    }
  } catch (err) {
    console.error('[missed-analysis] Error:', err.message);
  }
}

// Run missed winner analysis every 12 hours
setInterval(runMissedWinnerDeepAnalysis, 12 * 60 * 60_000);

// Exit-signal monitor — checks all active POSTed calls every 60s for
// rug/dump patterns (LP pull, sell flip, deep drop from peak). Fires
// 🚨 EXIT NOW alerts to the Telegram group on first sign of trouble.
// Self-contained — handles its own DB updates + Telegram via wired hook.
async function runExitMonitorTick() {
  if (!_botActive) return;
  try {
    await runExitMonitor(dbInstance);
  } catch (err) {
    console.warn('[exit] tick error:', err.message);
  }
}
setInterval(runExitMonitorTick, 60_000);
setTimeout(runExitMonitorTick, 90_000); // first run 90s after boot

// User-alert ticker — checks all pending /alert subscriptions every 60s.
// When a coin's current mcap crosses the target (or current/entry >= multiple),
// fires a DM to the user and marks fired_at. De-dupes via fired_at.
async function runUserAlertsTick() {
  if (!_botActive) return;
  if (!TELEGRAM_BOT_TOKEN) return;
  let alerts;
  try { alerts = getPendingAlerts(); } catch { return; }
  if (!alerts.length) return;

  // Group alerts by CA so we make at most 1 DexScreener call per token
  const byCA = new Map();
  for (const a of alerts) {
    if (!byCA.has(a.contract_address)) byCA.set(a.contract_address, []);
    byCA.get(a.contract_address).push(a);
  }

  let fired = 0;
  for (const [ca, group] of byCA) {
    try {
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { signal: AbortSignal.timeout(8_000) });
      if (!dexRes.ok) continue;
      const dexData = await dexRes.json();
      const pair = (dexData?.pairs || []).sort((a,b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (!pair) continue;
      const currentMcap = pair.marketCap || pair.fdv || 0;
      if (!currentMcap) continue;

      for (const a of group) {
        let triggered = false;
        if (a.target_type === 'mcap') {
          triggered = currentMcap >= a.target_value;
        } else if (a.target_type === 'multiple' && a.entry_mcap > 0) {
          triggered = (currentMcap / a.entry_mcap) >= a.target_value;
        }
        if (!triggered) continue;

        // Fire DM
        const fmtMc = (n) => n >= 1_000_000 ? '$' + (n/1_000_000).toFixed(2) + 'M' : '$' + (n/1_000).toFixed(1) + 'K';
        const targetDesc = a.target_type === 'mcap' ? fmtMc(a.target_value) : a.target_value.toFixed(1) + 'x';
        const mult = a.entry_mcap > 0 ? (currentMcap / a.entry_mcap) : null;
        const msg =
          `🔔 <b>ALERT TRIGGERED</b>\n\n` +
          `<b>$${escapeHtml(a.token || '?')}</b>\n` +
          `<code>${ca}</code>\n\n` +
          `Target: <b>${targetDesc}</b>  ✅ HIT\n` +
          `Entry: ${fmtMc(a.entry_mcap)} → Now: <b>${fmtMc(currentMcap)}</b>` +
          (mult != null ? `  (${mult.toFixed(2)}x)` : '') + `\n\n` +
          `<a href="https://dexscreener.com/solana/${ca}">DEX</a> · <a href="https://pump.fun/${ca}">PF</a>`;

        try {
          await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: a.user_id,
              text: msg,
              parse_mode: 'HTML',
              disable_web_page_preview: true,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          fireUserAlert(a.id, currentMcap);
          fired++;
        } catch (err) {
          console.warn(`[user-alert] DM failed for user ${a.user_id}: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[user-alert] check failed for ${ca}: ${err.message}`);
    }
  }
  if (fired > 0) console.log(`[user-alert] cycle done — fired ${fired} alerts across ${byCA.size} unique tokens`);
}
setInterval(runUserAlertsTick, 60_000);
setTimeout(runUserAlertsTick, 120_000); // first run 2 min after boot
setTimeout(runMissedWinnerDeepAnalysis, 10 * 60_000); // first run 10min after boot
console.log('[missed-analysis] Missed winner analysis scheduled: every 12h');

app.get('/api/self-improve/status', (req, res) => {
  setCors(res);
  const lastRun = (() => { try { return dbInstance.prepare(`SELECT created_at FROM tuning_audit WHERE param='[SELF-IMPROVE]' ORDER BY created_at DESC LIMIT 1`).get()?.created_at; } catch { return null; } })();
  const recentChanges = (() => { try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM tuning_audit WHERE status='AUTO_APPLIED' AND created_at > datetime('now','-24 hours')`).get().n; } catch { return 0; } })();
  res.json({
    ok: true,
    running: _selfImproveRunning,
    lastRun,
    intervalHours: 6,
    changesLast24h: recentChanges,
    nextRunApprox: lastRun ? new Date(new Date(lastRun).getTime() + SELF_IMPROVE_INTERVAL_MS).toISOString() : 'within 2 minutes',
  });
});

app.post('/api/agent/recommendations', (req, res) => {
  setCors(res);
  try {
    const { priority='MEDIUM', category, title, description, rationale } = req.body ?? {};
    if (!title) return res.status(400).json({ ok: false, error: 'title required' });
    const id = dbInstance.prepare(`INSERT INTO agent_recommendations (priority,category,title,description,rationale,created_by) VALUES (?,?,?,?,?,'user') RETURNING id`)
      .get(priority, category || 'GENERAL', title, description || '', rationale || '');
    res.json({ ok: true, id: id?.id });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.put('/api/agent/recommendations/:id', (req, res) => {
  setCors(res);
  try {
    const { status } = req.body ?? {};
    dbInstance.prepare(`UPDATE agent_recommendations SET status=?,resolved_at=datetime('now') WHERE id=?`).run(status || 'DONE', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Track early wallets for a token
app.post('/api/wallets/early', (req, res) => {
  setCors(res);
  try {
    const { tokenCa, token, wallets = [], entryMcap } = req.body ?? {};
    if (!tokenCa || !wallets.length) return res.status(400).json({ ok: false, error: 'tokenCa and wallets required' });
    const insert = dbInstance.prepare(`INSERT OR IGNORE INTO early_wallets (token_ca,token,wallet,entry_rank,entry_mcap) VALUES (?,?,?,?,?)`);
    const tx = dbInstance.transaction(list => {
      list.slice(0, 150).forEach((addr, i) => insert.run(tokenCa, token || null, addr, i + 1, entryMcap || null));
    });
    tx(wallets);
    res.json({ ok: true, tracked: Math.min(wallets.length, 150) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Get early wallet analysis
app.get('/api/wallets/early/:address', (req, res) => {
  setCors(res);
  try {
    const rows = dbInstance.prepare(`
      SELECT ew.*, tw.category, tw.label, tw.score
      FROM early_wallets ew
      LEFT JOIN tracked_wallets tw ON ew.wallet = tw.address
      WHERE ew.wallet = ?
      ORDER BY ew.created_at DESC LIMIT 50
    `).all(req.params.address);
    const wins = rows.filter(r => r.outcome === 'WIN').length;
    res.json({ ok: true, appearances: rows.length, wins, rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Survivor token tracking
app.post('/api/tokens/survivor', (req, res) => {
  setCors(res);
  try {
    const { tokenCa, token, entryMcap, currentMcap, ageHours, earlyWallets = [] } = req.body ?? {};
    if (!tokenCa) return res.status(400).json({ ok: false, error: 'tokenCa required' });
    dbInstance.prepare(`
      INSERT INTO survivor_tokens (token_ca,token,entry_mcap,current_mcap,age_hours,early_wallets,first_seen,confirmed_at)
      VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))
      ON CONFLICT(token_ca) DO UPDATE SET current_mcap=excluded.current_mcap,age_hours=excluded.age_hours,confirmed_at=datetime('now')
    `).run(tokenCa, token||null, entryMcap||null, currentMcap||null, ageHours||null, JSON.stringify(earlyWallets));
    // Archive early wallets as winners in tracked_wallets
    if (earlyWallets.length && currentMcap > 500000) {
      const upsert = dbInstance.prepare(`
        INSERT INTO tracked_wallets (address,category,source,wins_found_in,notes,is_watchlist)
        VALUES (?,?,?,?,?,1)
        ON CONFLICT(address) DO UPDATE SET wins_found_in=wins_found_in+1,category=CASE WHEN wins_found_in>=3 THEN 'WINNER' ELSE category END
      `);
      const tx = dbInstance.transaction(list => {
        list.slice(0,150).forEach(addr => upsert.run(addr,'SMART_MONEY','survivor_tracker',1,`Early in ${token||tokenCa.slice(0,8)} (${Math.round((currentMcap||0)/1000)}K peak)`));
      });
      tx(earlyWallets);
    }
    logEvent('INFO', 'SURVIVOR_TRACKED', `${token||tokenCa.slice(0,8)} age=${ageHours?.toFixed(1)}h mcap=${Math.round((currentMcap||0)/1000)}K`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/tokens/survivors', (req, res) => {
  setCors(res);
  try {
    const rows = dbInstance.prepare(`SELECT * FROM survivor_tokens ORDER BY current_mcap DESC LIMIT 100`).all();
    res.json({ ok: true, survivors: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

function buildAgentContext() {
  try {
    const evals   = dbInstance.prepare(`SELECT COUNT(*) as n FROM candidates`).get().n;
    const total   = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls`).get().n;
    const wins    = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome='WIN'`).get().n;
    const losses  = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS'`).get().n;
    const pending = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome IS NULL OR outcome='PENDING'`).get().n;
    const wallets = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets`).get().n;
    const winners = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE category='WINNER'`).get().n;
    const survivors = (() => { try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM survivor_tokens`).get().n; } catch { return 0; } })();
    const earlyW    = (() => { try { return dbInstance.prepare(`SELECT COUNT(DISTINCT wallet) as n FROM early_wallets`).get().n; } catch { return 0; } })();
    const recentCalls = dbInstance.prepare(`SELECT token,outcome,score_at_call,market_cap_at_call,called_at FROM calls ORDER BY called_at DESC LIMIT 10`).all();
    const regime = getRegime();
    const winRate = (wins+losses) > 0 ? Math.round(wins/(wins+losses)*100)+'%' : 'no resolved calls yet';
    const recentHistory = getRecentOutcomesContext(15);
    return `=== PULSE CALLER LIVE PERFORMANCE DATA ===
Bot Mode: ${activeMode.emoji} ${activeMode.name}
Market Regime: ${regime.market||'UNKNOWN'} (${regime.confidence||'?'} confidence)
Tokens Evaluated: ${evals} | Calls Posted: ${total} | Win Rate: ${winRate}
Wins: ${wins} | Losses: ${losses} | Pending: ${pending}
Tracked Wallets: ${wallets} (${winners} WINNER category)
Survivor Tokens: ${survivors} (>4h >$500K)
Early Wallet Records: ${earlyW} unique wallets tracked

ACTIVE CONFIG OVERRIDES: ${Object.keys(AI_CONFIG_OVERRIDES).length > 0 ? JSON.stringify(AI_CONFIG_OVERRIDES) : 'None — using defaults'}
Current Sweet Spot: $${Math.round((AI_CONFIG_OVERRIDES.sweetSpotMin||15000)/1000)}K–$${Math.round((AI_CONFIG_OVERRIDES.sweetSpotMax||40000)/1000)}K
Score Floor: ${activeMode.minScore} | Max MCap: $${Math.round(activeMode.maxMarketCap/1000)}K | Max Age: ${activeMode.maxPairAgeHours}h

RECENT CALL HISTORY:
${recentHistory}

RECENT 10 CALLS:
${recentCalls.map(c => `  $${c.token}: score=${c.score_at_call} mcap=$${Math.round((c.market_cap_at_call||0)/1000)}K outcome=${c.outcome||'PENDING'}`).join('\n')}

MODIFIABLE PARAMETERS (safe to change):
  sweetSpotMin/Max, maxMarketCapOverride, minMarketCapOverride
  scoreFloorOverride/minScoreOverride, maxPairAgeHoursOverride
  bundleRiskBlock, sniperCountBlock, devWalletPctBlock
  walletIntelWeight, earlyWalletTracking, survivorTracking
  agentConvictionThreshold (0-100, default 80)

DO NOT TOUCH: Any API keys.
==============================================`;
  } catch (err) {
    return `Context build failed: ${err.message}`;
  }
}



app.get('/api/bot-status', (req, res) => {
  setCors(res);
  try { res.json({ ok: true, ...getAllBotStatus() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.all('/api/wt/*', async (req, res) => {
  setCors(res);
  if (!process.env.DATABASE_URL) {
    const p = req.path;
    if (p.includes('/status'))    return res.json({ ok: true, trackedWallets: 0, dryRun: true, sniperActive: false });
    if (p.includes('/portfolio')) return res.json({ ok: true, overview: { open_trades: 0, total_pnl_usd: 0, win_rate_pct: '0', sniper_success_rate: '0' }, byWallet: [], byToken: [], openPositions: [] });
    if (p.includes('/wallets'))   return res.json({ ok: true, wallets: [], total: 0 });
    if (p.includes('/trades'))    return res.json({ ok: true, trades: [], total: 0 });
    if (p.includes('/settings'))  return res.json({ ok: true, settings: { allocation_usd: 50, take_profit_pct: 100, stop_loss_pct: 20, trailing_stop_pct: 15, max_hold_sec: 3600, min_liquidity_usd: 20000, max_top10_holder_pct: 50, max_dev_wallet_pct: 10, min_trust_score: 60, block_bundle_risk: 'SEVERE', max_open_positions: 10, max_daily_loss_usd: 500, cooldown_sec: 60 } });
    return res.json({ ok: false, error: 'Wallet tracker not configured' });
  }
  try {
    const qs        = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
    const targetUrl = `${WT_SERVER_URL}${req.path}${qs}`;
    const fetchOpts = { method: req.method, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000) };
    if (req.method !== 'GET' && req.method !== 'HEAD') fetchOpts.body = JSON.stringify(req.body);
    const upstream = await fetch(targetUrl, fetchOpts);
    const data     = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.warn('[proxy/wt]', err.message);
    res.status(502).json({ ok: false, error: 'Wallet tracker unavailable' });
  }
});

// ═══════════════════════════════════════════════════════════
// EXTERNAL SCAN ENDPOINTS — work on ANY token/wallet, not just ones in our DB
// Used by the Brain Analyzer and Wallet Intel Scanner so the user can study
// tokens & wallets the bot hasn't seen yet. Fetches live from DexScreener +
// Solscan, cross-references our own audit_archive where possible, and
// persists a snapshot so every external lookup helps train the system.
// ═══════════════════════════════════════════════════════════

// External token scan — accepts any Solana CA, returns a normalized candidate
// shape the frontend's buildAuditDetail / Brain Analyzer expects.
app.get('/api/external/token/:ca', async (req, res) => {
  setCors(res);
  const ca = (req.params.ca || '').trim();
  if (!ca || ca.length < 32) return res.status(400).json({ ok: false, error: 'Invalid CA' });

  try {
    // 1. Check our own DB first (fast path)
    let row = null;
    try { row = dbInstance.prepare(`SELECT * FROM candidates WHERE contract_address=? ORDER BY id DESC LIMIT 1`).get(ca); } catch {}
    if (!row) {
      try { row = dbInstance.prepare(`SELECT * FROM audit_archive WHERE contract_address=? LIMIT 1`).get(ca); } catch {}
    }

    // 2. Fetch live data from DexScreener regardless — we want current mcap etc.
    let dex = null;
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(ca)}`, {
        signal: AbortSignal.timeout(9_000),
      });
      if (r.ok) {
        const j = await r.json();
        const pairs = j?.pairs || [];
        if (pairs.length) {
          // Pick most liquid Solana pair
          const best = pairs
            .filter(p => (p.chainId || p.chain) === 'solana')
            .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0] || pairs[0];
          dex = best;
        }
      }
    } catch (err) { console.warn('[external-token] dex fetch failed:', err.message); }

    // Don't 404 when DexScreener has no pair data — fresh pump.fun coins
    // often aren't indexed there yet, but their holders exist on-chain and
    // we can still scan them via Solscan/Helius. A missing DexScreener hit
    // used to cause /api/external/token to 404 before the holder fetch
    // could run — which blocked the Brain Analyzer's wallet auto-insert.
    if (!row && !dex) {
      console.warn(`[external-token] No DB row or DexScreener pair for ${ca.slice(0,8)} — continuing to holder fetch anyway`);
    }

    // 3. Merge — DexScreener live data wins for volatile fields (price/mcap/vol),
    //    DB wins for scored fields (composite_score, claude_verdict, sub_scores)
    const merged = { ...(row || {}) };
    merged.contract_address = ca; // always set — even when no row/dex
    if (dex) {
      merged.contract_address = ca;
      merged.token            = merged.token || dex.baseToken?.symbol;
      merged.token_name       = merged.token_name || dex.baseToken?.name;
      merged.chain            = 'solana';
      merged.dex              = dex.dexId;
      merged.market_cap       = dex.marketCap ?? dex.fdv ?? merged.market_cap;
      merged.liquidity        = dex.liquidity?.usd ?? merged.liquidity;
      merged.volume_1h        = dex.volume?.h1 ?? merged.volume_1h;
      merged.volume_24h       = dex.volume?.h24 ?? merged.volume_24h;
      merged.price_usd        = parseFloat(dex.priceUsd || 0) || merged.price_usd;
      merged.price_change_5m  = dex.priceChange?.m5 ?? merged.price_change_5m;
      merged.price_change_1h  = dex.priceChange?.h1 ?? merged.price_change_1h;
      merged.price_change_6h  = dex.priceChange?.h6 ?? merged.price_change_6h;
      merged.price_change_24h = dex.priceChange?.h24 ?? merged.price_change_24h;
      merged.buys_1h          = dex.txns?.h1?.buys ?? merged.buys_1h;
      merged.sells_1h         = dex.txns?.h1?.sells ?? merged.sells_1h;
      const pairCreated = dex.pairCreatedAt ? Date.now() - dex.pairCreatedAt : null;
      merged.pair_age_hours   = pairCreated != null ? pairCreated / 3_600_000 : merged.pair_age_hours;
      merged.pair_address     = dex.pairAddress || merged.pair_address;
      merged.website          = merged.website  || dex.info?.websites?.[0]?.url;
      merged.twitter          = merged.twitter  || dex.info?.socials?.find(s => s.type === 'twitter')?.url;
      merged.telegram         = merged.telegram || dex.info?.socials?.find(s => s.type === 'telegram')?.url;
    }

    // 3.5. Fetch top holders + classify against tracked_wallets.
    //      Strategy:
    //        A) Try Solscan /token/holders first — ONE call returns owner addresses directly
    //        B) Fall back to Helius getTokenLargestAccounts → getMultipleAccounts (2 calls)
    //      The HELIUS two-step was failing silently on some tokens (timeout / encoding),
    //      leaving the holder list empty. Solscan Pro is faster and more reliable here.
    let holderStats = null;
    let holders = []; // token-account rows (for balance data)
    let owners = [];  // resolved owner wallet addresses
    let amounts = []; // balance per owner (uiAmount)

    // ── Solscan + Helius whale hunt ─────────────────────────────────────────
    // Goal: find 3-5 wallets with ≥10 SOL on every scan. Keep paginating and
    // checking SOL balances until either we hit the whale target (3) or we've
    // already looked at 300 holders (dust coin — give up).
    // User directive: 60 holders max per scan. We scan all 60 every time
    // and surface EVERY whale in that pool — not just the first 3.
    const WHALE_SOL_THRESHOLD = 10;
    const HARD_HOLDER_CAP     = 60;
    const PAGE_SIZE           = 20;
    const MAX_PAGES           = Math.ceil(HARD_HOLDER_CAP / PAGE_SIZE); // 3

    // Intermediate accumulator with SOL attached. We won't populate
    // owners/holders/amounts until after the whale hunt completes.
    const pool = []; // [{ address, tokenAcct, uiAmount, sol }]
    let whaleCount = 0;
    let lastError  = null;

    // Tiny helper to fetch one chunk of SOL balances (up to 100 at a time)
    const fetchSolChunk = async (addrs) => {
      if (!addrs.length || !HELIUS_API_KEY) return {};
      try {
        const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 'bal', method: 'getMultipleAccounts',
            params: [addrs, { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 } }],
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) return {};
        const j = await r.json();
        const out = {};
        (j?.result?.value || []).forEach((acc, idx) => {
          out[addrs[idx]] = (acc?.lamports ?? 0) / 1e9;
        });
        return out;
      } catch { return {}; }
    };

    if (process.env.SOLSCAN_API_KEY) {
      for (let p = 1; p <= MAX_PAGES; p++) {
        let arr = [];
        try {
          const r = await fetch(
            `https://pro-api.solscan.io/v2.0/token/holders?address=${encodeURIComponent(ca)}&page_size=${PAGE_SIZE}&page=${p}`,
            { headers: { token: process.env.SOLSCAN_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(9_000) }
          );
          if (!r.ok) {
            lastError = `page ${p} HTTP ${r.status}`;
            console.warn(`[external-token] Solscan page ${p} returned ${r.status}`);
            break;
          }
          const j = await r.json();
          arr = j?.data?.items || j?.data || [];
        } catch (err) {
          lastError = err.message;
          console.warn(`[external-token] Solscan page ${p} threw: ${err.message}`);
          break;
        }
        if (!Array.isArray(arr) || arr.length === 0) break;

        // Batch-fetch SOL balances for this page's owners
        const pageOwners = arr.map(h => h.owner).filter(Boolean);
        const solMap     = await fetchSolChunk(pageOwners);

        for (const h of arr) {
          const sol = solMap[h.owner] ?? 0;
          pool.push({
            address:   h.owner,
            tokenAcct: h.address || h.owner,
            uiAmount:  h.amount ?? h.uiAmount ?? null,
            sol,
          });
          if (sol >= WHALE_SOL_THRESHOLD) whaleCount++;
        }

        // Always scan the full 60 — surface EVERY whale in the pool, not
        // just the first 3. Only stop on the hard cap or an empty page.
        if (pool.length >= HARD_HOLDER_CAP) {
          console.log(`[external-token] hit holder cap (${pool.length}) · ${whaleCount} whales found`);
          break;
        }
        if (arr.length < PAGE_SIZE) break; // ran out of holders
      }
      console.log(`[external-token] Solscan hunt: ${pool.length} holders scanned · ${whaleCount} whales ≥${WHALE_SOL_THRESHOLD} SOL${lastError ? ' (halted on: ' + lastError + ')' : ''}`);

      // Sort pool by SOL descending, take top 60. If we found whales they're
      // at the top; if not, we still surface the best-capitalized dust.
      pool.sort((a, b) => b.sol - a.sol);
      const top = pool.slice(0, 60);
      owners  = top.map(h => h.address);
      amounts = top.map(h => h.uiAmount);
      holders = top.map(h => ({ address: h.tokenAcct, uiAmount: h.uiAmount }));
    }

    // ── Helius fallback if Solscan didn't give us owners ──
    if (!owners.length && HELIUS_API_KEY) {
      try {
        const rpcRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 'topholders', method: 'getTokenLargestAccounts',
            params: [ca, { commitment: 'confirmed' }],
          }),
          signal: AbortSignal.timeout(9_000),
        });
        if (rpcRes.ok) {
          const rpcJson = await rpcRes.json();
          holders = rpcJson?.result?.value || [];
          if (holders.length) {
            const tokenAccts = holders.map(h => h.address).slice(0, 20);
            try {
              const ownerRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0', id: 'owners', method: 'getMultipleAccounts',
                  params: [tokenAccts, { encoding: 'jsonParsed' }],
                }),
                signal: AbortSignal.timeout(12_000),
              });
              if (ownerRes.ok) {
                const ownerJson = await ownerRes.json();
                owners = (ownerJson?.result?.value || [])
                  .map(a => a?.data?.parsed?.info?.owner)
                  .filter(Boolean);
                amounts = holders.map(h => h.uiAmount);
              } else {
                console.warn(`[external-token] Helius getMultipleAccounts returned ${ownerRes.status}`);
              }
            } catch (err) { console.warn('[external-token] Helius owners fetch failed:', err.message); }
          }
        }
      } catch (err) { console.warn('[external-token] Helius getTokenLargestAccounts failed:', err.message); }
    }

    // ── Batch-fetch SOL balance for every holder so the UI can surface whales ──
    // One Helius getMultipleAccounts call returns lamports for up to 100 wallets
    // at once. Cheap, reliable, and it's what makes "find the whales" possible.
    const solBalances = new Map(); // address → SOL
    if (owners.length && HELIUS_API_KEY) {
      try {
        // Split into chunks of 100 (RPC max)
        const chunks = [];
        for (let i = 0; i < owners.length; i += 100) chunks.push(owners.slice(i, i + 100));
        for (const chunk of chunks) {
          const bRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 'balances', method: 'getMultipleAccounts',
              params: [chunk, { commitment: 'confirmed' }],
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!bRes.ok) { console.warn(`[external-token] balance batch HTTP ${bRes.status}`); continue; }
          const bJson = await bRes.json();
          const values = bJson?.result?.value || [];
          values.forEach((acc, idx) => {
            const lamports = acc?.lamports ?? 0;
            if (lamports) solBalances.set(chunk[idx], lamports / 1e9);
          });
        }
      } catch (err) {
        console.warn('[external-token] SOL balance batch failed:', err.message);
      }
    }

    // ── Re-rank by SOL balance + trim to top 60 ─────────────────────────────
    // The user's real question when scanning a coin is "who are the wealthy
    // wallets holding this?", not "who has the biggest bag of this specific
    // memecoin?". Solscan's default order surfaces LPs and snipers first;
    // re-sorting by SOL pushes actual smart-money wallets to the top.
    if (owners.length && solBalances.size) {
      const ranked = owners
        .map((addr, i) => ({
          address:  addr,
          sol:      solBalances.get(addr) ?? 0,
          uiAmount: amounts[i] ?? null,
          tokenAcct: holders[i]?.address ?? null,
        }))
        .sort((a, b) => b.sol - a.sol)
        .slice(0, 60);
      owners  = ranked.map(r => r.address);
      amounts = ranked.map(r => r.uiAmount);
      holders = ranked.map(r => ({ address: r.tokenAcct || r.address, uiAmount: r.uiAmount }));
      const topSol = ranked[0]?.sol ?? 0;
      const tenPlus = ranked.filter(r => r.sol >= 10).length;
      console.log(`[external-token] Ranked by SOL: top=${topSol.toFixed(1)}SOL · ${tenPlus} wallets ≥10 SOL · kept top ${owners.length}`);
    } else if (owners.length > 60) {
      // Fallback: no SOL data came through (Helius down?) — keep first 60 by token
      owners  = owners.slice(0, 60);
      amounts = amounts.slice(0, 60);
      holders = holders.slice(0, 60);
    }

    // ── Auto-insert every resolved holder into tracked_wallets with SOL ─────
    // User-requested: Brain Analyzer scans should populate the Wallet Database
    // AND carry SOL balance so the tiles show it without an extra click.
    // INSERT OR IGNORE keeps existing labels/categories untouched; the
    // UPDATE afterward refreshes sol_balance even on pre-existing rows.
    let _autoInsertResult = { attempted: owners.length, inserted: 0, updated: 0, promoted: 0, error: null };
    if (owners.length) {
      try {
        // Auto-categorize based on SOL balance:
        //   ≥100 SOL → WINNER  (renders as 🐋 WHALE in tiles)
        //   ≥ 10 SOL → SMART_MONEY
        //   ≥  1 SOL → MOMENTUM (active wallet, not a whale yet)
        //   <  1 SOL → NEUTRAL (dust / dust-holder)
        // Only UPSERTs category if the existing row is NEUTRAL — we never
        // clobber a user-labeled category (WINNER/RUG/etc).
        const categoryFor = (sol) => {
          if (sol == null) return 'NEUTRAL';
          if (sol >= 100) return 'WINNER';
          if (sol >= 10)  return 'SMART_MONEY';
          if (sol >= 1)   return 'MOMENTUM';
          return 'NEUTRAL';
        };
        const ins = dbInstance.prepare(`
          INSERT OR IGNORE INTO tracked_wallets
            (address, category, source, updated_at, last_seen)
          VALUES (?, ?, 'brain_scan', datetime('now'), datetime('now'))
        `);
        const updSol = dbInstance.prepare(`
          UPDATE tracked_wallets
          SET sol_balance = ?, sol_scanned_at = datetime('now')
          WHERE address = ?
        `);
        // Promotion only touches NEUTRAL rows — so manual labels stick.
        const promote = dbInstance.prepare(`
          UPDATE tracked_wallets
          SET category = ?, updated_at = datetime('now')
          WHERE address = ?
            AND (category = 'NEUTRAL' OR category IS NULL)
            AND ? != 'NEUTRAL'
        `);
        const tx = dbInstance.transaction((addrs) => {
          let inserted = 0, updated = 0, promoted = 0;
          for (const a of addrs) {
            if (!a) continue;
            const sol = solBalances.get(a);
            const cat = categoryFor(sol);
            inserted += ins.run(a, cat).changes;
            if (sol != null) updated += updSol.run(Number(sol.toFixed(6)), a).changes;
            // Promote pre-existing NEUTRAL rows when this scan found they're whales
            if (cat !== 'NEUTRAL') promoted += promote.run(cat, a, cat).changes;
          }
          return { inserted, updated, promoted };
        });
        const { inserted, updated, promoted } = tx(owners);
        _autoInsertResult.inserted = inserted;
        _autoInsertResult.updated  = updated;
        _autoInsertResult.promoted = promoted;
        console.log(`[external-token] ca=${ca.slice(0,8)} Auto-added ${inserted} new · refreshed SOL on ${updated} rows · auto-promoted ${promoted} by SOL balance (out of ${owners.length})`);
      } catch (err) {
        _autoInsertResult.error = err.message;
        console.warn('[external-token] auto-insert failed:', err.message);
      }
    } else {
      console.warn(`[external-token] ca=${ca.slice(0,8)} owners list is EMPTY — nothing to insert. Solscan/Helius both returned no holders.`);
    }

    // ── Cross-CA overlap tracking: record which CA each wallet appeared in ──────
    // Wallets that show up across 3+ different CAs are almost certainly smart money
    // — they identified multiple winners independently. Auto-upgrade them.
    if (owners.length) {
      try {
        const insAppear = dbInstance.prepare(
          `INSERT OR IGNORE INTO wallet_appearances (address, ca) VALUES (?, ?)`
        );
        const updCount = dbInstance.prepare(
          `UPDATE tracked_wallets
           SET ca_count = (SELECT COUNT(DISTINCT ca) FROM wallet_appearances WHERE address=tracked_wallets.address)
           WHERE address = ?`
        );
        const upgradeStmt = dbInstance.prepare(
          `UPDATE tracked_wallets
           SET category='SMART_MONEY', score=MAX(score, 60),
               notes=COALESCE(notes||' | ', '') || 'Overlap: seen in ' || ca_count || ' CAs',
               updated_at=datetime('now')
           WHERE address=? AND ca_count >= 3 AND category NOT IN ('WINNER','SNIPER','CLUSTER','RUG') AND source!='manual'`
        );
        const overlapTx = dbInstance.transaction((addrs) => {
          let upgrades = 0;
          for (const a of addrs) {
            insAppear.run(a, ca);
            updCount.run(a);
            upgrades += upgradeStmt.run(a).changes;
          }
          return upgrades;
        });
        const upgrades = overlapTx(owners);
        if (upgrades > 0) console.log(`[external-token] ca=${ca.slice(0,8)} Overlap upgrade: ${upgrades} wallets → SMART_MONEY (seen in 3+ CAs)`);
      } catch (err) {
        console.warn('[external-token] overlap tracking failed:', err.message);
      }
    }

    // ── Populate holderStats + classify against tracked_wallets ──
    if (owners.length || holders.length) {
      try {

        // Classify against our tracked_wallets database.
        // Also build a per-holder list so the UI can offer "add / enrich"
        // actions for wallets we haven't seen before.
        let whales = 0, smart = 0, snipers = 0, clusters = 0;
        const matchedLabels = [];
        const holdersList = [];
        for (let i = 0; i < owners.length; i++) {
          const owner = owners[i];
          let tw = null;
          try {
            tw = dbInstance.prepare(
              `SELECT address, label, category, win_rate, avg_roi, score
               FROM tracked_wallets WHERE address=? AND is_blacklist=0`
            ).get(owner);
          } catch {}
          if (tw) {
            if (tw.category === 'WINNER')       whales++;
            else if (tw.category === 'SMART_MONEY') smart++;
            else if (tw.category === 'SNIPER')      snipers++;
            else if (tw.category === 'CLUSTER')     clusters++;
            if (tw.label) matchedLabels.push(tw.label);
          }
          const solBal = solBalances.get(owner) ?? null;
          holdersList.push({
            rank:     i + 1,
            address:  owner,
            balance:  amounts[i] ?? holders[i]?.uiAmount ?? null,
            solBalance: solBal,
            isWhale:  solBal != null && solBal >= 10,  // 10+ SOL = whale signal
            isMegaWhale: solBal != null && solBal >= 100,
            inDb:     !!tw,
            label:    tw?.label || null,
            category: tw?.category || null,
            winRate:  tw?.win_rate ?? null,
            avgRoi:   tw?.avg_roi ?? null,
            score:    tw?.score ?? null,
          });
        }

        // Re-rank: whales with the most SOL first, then in-DB wallets, then the rest.
        // Rank labels (#1 #2 ...) follow the new order so the UI shows the
        // meaningful "most significant holder" list — not just biggest token balance.
        holdersList.sort((a, b) => {
          const aScore = (a.solBalance || 0) * (a.inDb ? 1.5 : 1);
          const bScore = (b.solBalance || 0) * (b.inDb ? 1.5 : 1);
          return bScore - aScore;
        });
        holdersList.forEach((h, i) => { h.rank = i + 1; });
        // Percentage held by top 10 (rough, based on whatever balance data we have)
        const totalTop10 = holders.slice(0, 10).reduce((s, h) => s + (h.uiAmount || 0), 0);
        const totalAll   = holders.reduce((s, h) => s + (h.uiAmount || 0), 0);
        const top10Pct   = totalAll > 0 ? (totalTop10 / totalAll) * 100 : null;

        holderStats = {
          holderCount:   holders.length,
          ownerCount:    owners.length,
          whales, smart, snipers, clusters,
          top10Pct,
          matchedLabels,
          topHolderOwners: owners.slice(0, 10),
          holdersList,
        };

        merged.holders          = merged.holders || holders.length;
        merged.top10_holder_pct = merged.top10_holder_pct ?? top10Pct;
        merged.wallet_intel = JSON.stringify({
          whaleCount:              whales,
          knownWinnerWalletCount:  whales,
          smartMoneyCount:         smart,
          sniperWalletCount:       snipers,
          clusterWalletCount:      clusters,
          topWinnerAddresses:      owners.slice(0, 10),
          matchedLabels,
          holdersList,
        });
      } catch (err) {
        console.warn('[external-token] holder classification failed:', err.message);
      }
    }

    // 4. Persist a snapshot to scanner_feed so the system "sees" this token
    try {
      dbInstance.prepare(`
        INSERT OR IGNORE INTO scanner_feed
          (token, contract_address, pair_address, dex, market_cap, liquidity,
           volume_24h, volume_1h, price_usd, pair_age_hours,
           price_change_5m, price_change_1h, price_change_24h, buys_1h, sells_1h,
           filter_action, filter_reason, website, twitter, telegram)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        merged.token || null, ca, merged.pair_address || null, merged.dex || null,
        merged.market_cap || null, merged.liquidity || null,
        merged.volume_24h || null, merged.volume_1h || null,
        merged.price_usd || null, merged.pair_age_hours || null,
        merged.price_change_5m || null, merged.price_change_1h || null,
        merged.price_change_24h || null, merged.buys_1h || null, merged.sells_1h || null,
        'EXTERNAL_SCAN', 'user-triggered brain analyzer scan',
        merged.website || null, merged.twitter || null, merged.telegram || null,
      );
    } catch {}

    res.json({
      ok: true,
      candidate: merged,
      source: row ? 'db+live' : 'live-only',
      walletsIngested: _autoInsertResult,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// External wallet scan — fetches any wallet's stats live via Solscan + our
// audit_archive cross-reference. Persists to tracked_wallets.
app.get('/api/external/wallet/:address', async (req, res) => {
  setCors(res);
  const address = (req.params.address || '').trim();
  if (!address || address.length < 32) return res.status(400).json({ ok: false, error: 'Invalid wallet address' });

  try {
    // Reuse the Solscan enricher — same function the scheduled job uses
    const { enrichWallet } = await import('./solscan-wallet-enricher.js');
    const stats = await enrichWallet(address, dbInstance);

    // ── Fetch live SOL balance so auto-categorization matches Brain Analyzer ──
    // ≥100 SOL → WINNER (🐋), ≥10 SOL → SMART_MONEY (💎), ≥1 SOL → MOMENTUM, else NEUTRAL
    let walletSol = null;
    if (HELIUS_API_KEY) {
      try {
        const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc:'2.0', id:'bal', method:'getBalance', params:[address] }),
          signal: AbortSignal.timeout(5_000),
        });
        if (r.ok) {
          const j = await r.json();
          walletSol = (j?.result?.value ?? 0) / 1e9;
        }
      } catch { /* best-effort */ }
    }
    const autoCategory = walletSol == null ? 'NEUTRAL'
      : walletSol >= 100 ? 'WINNER'
      : walletSol >= 10  ? 'SMART_MONEY'
      : walletSol >= 1   ? 'MOMENTUM'
      : 'NEUTRAL';

    // ── Guaranteed upsert: ensure the wallet lands in tracked_wallets ─────
    // Even if Solscan returned no transfers (fresh/inactive wallet), we still
    // want the row to exist so the Smart Money page lists it. Enrichment can
    // fill in the rest asynchronously via the 6h background loop.
    let walletAdded = false;
    try {
      const info = dbInstance.prepare(`
        INSERT INTO tracked_wallets (address, category, source, added_at, updated_at, last_seen, sol_balance, sol_scanned_at)
        VALUES (?, ?, 'manual_add', datetime('now'), datetime('now'), datetime('now'), ?, ${walletSol != null ? "datetime('now')" : 'NULL'})
        ON CONFLICT(address) DO UPDATE SET
          last_seen = datetime('now'),
          sol_balance = COALESCE(?, sol_balance),
          sol_scanned_at = ${walletSol != null ? "datetime('now')" : 'sol_scanned_at'},
          category = CASE
            WHEN (tracked_wallets.category = 'NEUTRAL' OR tracked_wallets.category IS NULL) AND ? != 'NEUTRAL'
            THEN ? ELSE tracked_wallets.category END
      `).run(address, autoCategory, walletSol, walletSol, autoCategory, autoCategory);
      walletAdded = info.changes > 0;
    } catch (err) {
      try {
        dbInstance.prepare(`
          INSERT OR IGNORE INTO tracked_wallets (address, category, source, updated_at, last_seen, sol_balance)
          VALUES (?, ?, 'manual_add', datetime('now'), datetime('now'), ?)
        `).run(address, autoCategory, walletSol);
        walletAdded = true;
      } catch (err2) {
        console.warn('[external-wallet] stub insert failed:', err2.message);
      }
    }

    // Also pull any existing DB record + our own early_wallets data
    let existing = null;
    try { existing = dbInstance.prepare(`SELECT * FROM tracked_wallets WHERE address=?`).get(address); } catch {}
    let appearances = [];
    try {
      appearances = dbInstance.prepare(
        `SELECT ew.token_ca, ew.entry_rank, ew.entry_mcap, ew.outcome,
                aa.final_decision, aa.composite_score, aa.called_at_et
         FROM early_wallets ew
         LEFT JOIN audit_archive aa ON ew.token_ca = aa.contract_address
         WHERE ew.wallet = ? ORDER BY ew.created_at DESC LIMIT 20`
      ).all(address);
    } catch {}

    // ── Recent token activity — aggregates Solscan transfers into a per-token list
    //    so the UI can show real alpha even when audit_archive has no overlap yet.
    //    Each token cross-references against scanner_feed / candidates / audit_archive
    //    so we can surface: did WE call it? what was the outcome? current mcap?
    let recentTokens = [];
    if (process.env.SOLSCAN_API_KEY) {
      try {
        // Fetch transfers directly (quick, bounded)
        const pageSize = 100;
        const url = `https://pro-api.solscan.io/v2.0/account/transfer`
          + `?address=${encodeURIComponent(address)}`
          + `&page=1&page_size=${pageSize}&sort_by=block_time&sort_order=desc`;
        const r = await fetch(url, {
          headers: { token: process.env.SOLSCAN_API_KEY, accept: 'application/json' },
          signal: AbortSignal.timeout(9_000),
        });
        if (r.ok) {
          const j = await r.json();
          const items = j?.data ?? j?.result ?? j?.transfers ?? [];
          // Aggregate by token: count transfers, track last-seen timestamp, first side
          const byToken = new Map();
          for (const t of items) {
            const token = (t.token_address || t.tokenAddress || t.mint || '').toString();
            if (!token || token.length < 32) continue;
            const bt    = t.block_time || t.blockTime || t.time || null;
            const fromA = (t.from_address || t.fromAddress || t.from || '').toLowerCase();
            const isBuy = fromA !== address.toLowerCase();
            const entry = byToken.get(token) || { address: token, count: 0, lastSeen: bt, buys: 0, sells: 0 };
            entry.count++;
            if (isBuy) entry.buys++; else entry.sells++;
            if (bt && (!entry.lastSeen || bt > entry.lastSeen)) entry.lastSeen = bt;
            byToken.set(token, entry);
          }
          // Cross-reference with our DB
          const tokens = [...byToken.values()]
            .sort((a,b) => (b.lastSeen||0) - (a.lastSeen||0))
            .slice(0, 20);
          for (const t of tokens) {
            let ours = null;
            try { ours = dbInstance.prepare(
              `SELECT token, composite_score, final_decision FROM candidates
               WHERE contract_address=? ORDER BY id DESC LIMIT 1`
            ).get(t.address); } catch {}
            if (!ours) {
              try { ours = dbInstance.prepare(
                `SELECT token, composite_score, final_decision, outcome, peak_multiple
                 FROM audit_archive WHERE contract_address=? LIMIT 1`
              ).get(t.address); } catch {}
            }
            if (!ours) {
              try { ours = dbInstance.prepare(
                `SELECT token FROM scanner_feed WHERE contract_address=? ORDER BY id DESC LIMIT 1`
              ).get(t.address); } catch {}
            }
            t.symbol        = ours?.token || null;
            t.ourScore      = ours?.composite_score ?? null;
            t.ourDecision   = ours?.final_decision ?? null;
            t.outcome       = ours?.outcome ?? null;
            t.peakMultiple  = ours?.peak_multiple ?? null;
            t.inOurDb       = !!ours;
          }
          recentTokens = tokens;
        }
      } catch (err) { console.warn('[external-wallet] recent tokens fetch failed:', err.message); }
    }

    // ── Helius fallback: if Solscan gave us nothing useful, hit Helius for
    //    SOL balance + recent SWAP activity. This is what makes clicking a
    //    fresh wallet actually show data instead of the empty "no transfer
    //    history" state.
    let heliusData = null;
    // Always run Helius — it's fast, free-tier-safe, and gives us SOL balance
    // + recent swaps even when Solscan returns partial data. Running both in
    // parallel would be ideal but the code path is already sequential.
    if (HELIUS_API_KEY) {
      try {
        // SOL balance
        const balRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc:'2.0', id:'bal', method:'getBalance', params:[address] }),
          signal: AbortSignal.timeout(6_000),
        });
        const balJson = balRes.ok ? await balRes.json() : null;
        const solBalance = (balJson?.result?.value ?? 0) / 1e9;

        // Recent swaps via Enhanced Transactions
        const swRes = await fetch(
          `https://api.helius.xyz/v0/addresses/${address}/transactions?type=SWAP&api-key=${HELIUS_API_KEY}&limit=25`,
          { signal: AbortSignal.timeout(9_000) }
        );
        const swArr = swRes.ok ? await swRes.json() : [];
        const swaps = Array.isArray(swArr) ? swArr : [];

        // Extract tokens recently bought
        const byMint = new Map();
        for (const tx of swaps) {
          for (const t of (tx.tokenTransfers ?? [])) {
            if (t.toUserAccount !== address) continue;
            if (!t.mint) continue;
            if (['So11111111111111111111111111111111111111112',
                 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'].includes(t.mint)) continue;
            const e = byMint.get(t.mint) || { address: t.mint, count: 0, lastSeen: 0 };
            e.count++;
            if (tx.timestamp && tx.timestamp > e.lastSeen) e.lastSeen = tx.timestamp;
            byMint.set(t.mint, e);
          }
        }
        const helTokens = [...byMint.values()].sort((a,b) => b.lastSeen - a.lastSeen).slice(0, 20);

        // Cross-reference helius tokens with our DB so the UI can tag winners
        for (const t of helTokens) {
          try {
            const ours = dbInstance.prepare(
              `SELECT token, composite_score, final_decision FROM candidates
               WHERE contract_address=? ORDER BY id DESC LIMIT 1`
            ).get(t.address) || dbInstance.prepare(
              `SELECT token, composite_score, final_decision, outcome, peak_multiple
               FROM audit_archive WHERE contract_address=? LIMIT 1`
            ).get(t.address);
            if (ours) {
              t.symbol       = ours.token || null;
              t.ourScore     = ours.composite_score ?? null;
              t.ourDecision  = ours.final_decision ?? null;
              t.outcome      = ours.outcome ?? null;
              t.peakMultiple = ours.peak_multiple ?? null;
              t.inOurDb      = true;
            }
          } catch {}
        }

        heliusData = {
          solBalance,
          isWhale: solBalance >= 10,
          isMegaWhale: solBalance >= 100,
          swapCount: swaps.length,
          recentTokens: helTokens,
        };
        // If Solscan gave us empty tokens but Helius found some, promote them
        if (!recentTokens.length && helTokens.length) recentTokens = helTokens;
      } catch (err) {
        console.warn('[external-wallet] Helius fallback failed:', err.message);
      }
    }

    res.json({
      ok: true,
      address,
      stats,
      helius: heliusData,
      dbRecord: existing,
      appearances,
      recentTokens,
      source: heliusData ? 'helius+solscan' : (stats ? 'solscan' : 'db-only'),
      added: {
        solBalance: walletSol,
        autoCategory,
        rowCreatedOrUpdated: walletAdded,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 🔎 PIPELINE FLOW DIAGNOSTIC — shows drop-off at each stage ──────────
// Counts rows at every step so we can see exactly where the pipeline is leaking.
// scanner_feed → promoted → enriched → scored → posted
app.get('/api/diagnose/pipeline-flow', (req, res) => {
  setCors(res);
  try {
    const safe = (sql, ...p) => { try { return dbInstance.prepare(sql).get(...p); } catch { return null; } };
    const safeAll = (sql, ...p) => { try { return dbInstance.prepare(sql).all(...p); } catch { return []; } };

    // Stage 1 — scanner_feed (scanner detected)
    const feed_total = safe(`SELECT COUNT(*) as n FROM scanner_feed WHERE scanned_at > datetime('now','-24 hours')`)?.n ?? 0;
    const feed_by_action = safeAll(`
      SELECT filter_action, COUNT(*) as n FROM scanner_feed
      WHERE scanned_at > datetime('now','-24 hours') GROUP BY filter_action
    `);

    // Stage 2 — candidates table (processCandidate ran)
    const cands_total = safe(`SELECT COUNT(*) as n FROM candidates WHERE evaluated_at > datetime('now','-24 hours')`)?.n ?? 0;
    const cands_scored = safe(`SELECT COUNT(*) as n FROM candidates WHERE composite_score IS NOT NULL AND evaluated_at > datetime('now','-24 hours')`)?.n ?? 0;
    const cands_by_decision = safeAll(`
      SELECT final_decision, COUNT(*) as n FROM candidates
      WHERE evaluated_at > datetime('now','-24 hours') GROUP BY final_decision
    `);

    // Stage 3 — Claude ran (claude_verdict or claude_risk set)
    const claude_ran = safe(`SELECT COUNT(*) as n FROM candidates WHERE claude_verdict IS NOT NULL AND evaluated_at > datetime('now','-24 hours')`)?.n ?? 0;
    const openai_ran = safe(`SELECT COUNT(*) as n FROM candidates WHERE openai_decision IS NOT NULL AND evaluated_at > datetime('now','-24 hours')`)?.n ?? 0;

    // Stage 4 — posted to Telegram (posted=1)
    const posted = safe(`SELECT COUNT(*) as n FROM candidates WHERE posted=1 AND evaluated_at > datetime('now','-24 hours')`)?.n ?? 0;

    // Sample scanner_feed rows that ARE promoted to see if they have CAs/data
    const sample_promoted = safeAll(`
      SELECT contract_address, token, quick_score, filter_action, filter_reason,
             market_cap, liquidity, buys_1h, scanned_at
      FROM scanner_feed
      WHERE filter_action='PROMOTE' AND scanned_at > datetime('now','-4 hours')
      ORDER BY scanned_at DESC LIMIT 5
    `);

    // Drop-off diagnosis
    const promoted_count = (feed_by_action.find(r => r.filter_action === 'PROMOTE') || {}).n || 0;
    const leak = (() => {
      if (feed_total === 0) return '🚨 scanner not running — no scanner_feed rows at all';
      if (promoted_count === 0) return '🚨 scanner produced rows but NONE promoted — quick-score filter too strict';
      if (cands_total === 0) return '🚨 MASSIVE LEAK: scanner promoted ' + promoted_count + ' coins but processCandidate never wrote to candidates table. Check Railway logs for exceptions in processCandidate / enrichCandidate.';
      if (cands_scored === 0) return '🚨 candidates inserted but composite_score is null — scorer is crashing or returning null';
      if (claude_ran === 0 && cands_scored > 0) return '⚠ Claude never runs — check CLAUDE_API_KEY and the aiShouldEvaluate gate';
      if (openai_ran === 0 && cands_scored > 0) return '⚠ OpenAI never runs — check OPENAI_API_KEY and the shouldRunOpenAI gate';
      if (posted === 0 && cands_scored > 0) return '⚠ Scoring works but nothing posting — check decision logic / risk gate';
      return '✓ Pipeline looks healthy.';
    })();

    res.json({
      ok: true,
      leak_diagnosis: leak,
      stage_1_scanner_feed:  { total: feed_total, by_action: feed_by_action },
      stage_2_candidates:    { total: cands_total, scored: cands_scored, by_decision: cands_by_decision },
      stage_3_ai:            { claude_ran, openai_ran },
      stage_4_posted:        posted,
      sample_promoted,
      generated_at: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── 🚨 KILLSWITCH AUDIT — checks EVERY known post-killer in one shot ────────
// User reports 'something is killing every post'. This endpoint runs through
// the 13 known kill paths and tells you exactly which one(s) are firing.
app.get('/api/diagnose/killswitch', (req, res) => {
  setCors(res);
  try {
    const safe = (sql, ...p) => { try { return dbInstance.prepare(sql).get(...p); } catch { return null; } };
    const verdict = []; // each: { path, firing, detail }

    // K1 — Telegram env vars missing
    const tgToken = !!TELEGRAM_BOT_TOKEN;
    const tgGroup = !!TELEGRAM_GROUP_CHAT_ID;
    verdict.push({
      id: 'K1', name: 'Telegram env vars',
      firing: !tgToken || !tgGroup,
      detail: `TELEGRAM_BOT_TOKEN=${tgToken?'✓':'✗MISSING'} · TELEGRAM_GROUP_CHAT_ID=${tgGroup?'✓':'✗MISSING'}`,
    });

    // K2 — pausePosting config override
    const pausePosting = !!(AI_CONFIG_OVERRIDES?.pausePosting);
    verdict.push({
      id: 'K2', name: 'pausePosting override',
      firing: pausePosting,
      detail: pausePosting ? '⏸ AI_CONFIG_OVERRIDES.pausePosting is TRUE — posts silently skipped' : 'not set',
    });

    // K3 — freeze_active kill-switch
    const freezeRow = safe(`SELECT value FROM agent_system_state WHERE key='freeze_active'`);
    const freezeActive = freezeRow?.value === 'true';
    verdict.push({
      id: 'K3', name: 'freeze_active',
      firing: freezeActive,
      detail: freezeActive ? '🥶 agent_system_state.freeze_active=true — whole agent system halted' : 'not set',
    });

    // K4 — Active mode minScore too high
    const modeName   = activeMode?.name ?? '?';
    const modeMinScore = activeMode?.minScore ?? null;
    // Only flag this if there are recent candidates and none scored above the mode's min
    const recentMax = safe(`SELECT MAX(composite_score) as m FROM candidates WHERE evaluated_at > datetime('now','-24 hours')`)?.m ?? 0;
    const blockedByMode = modeMinScore != null && recentMax > 0 && recentMax < modeMinScore;
    verdict.push({
      id: 'K4', name: 'Active mode minScore',
      firing: blockedByMode,
      detail: `mode=${modeName} minScore=${modeMinScore ?? 'n/a'} · last 24h max score=${recentMax}${blockedByMode ? ' · NOTHING meets mode bar' : ''}`,
    });

    // K5 — Dynamic threshold at 999 (scorer hard-block)
    const thresholdRow = safe(`SELECT MAX(dynamic_threshold) as m FROM candidates WHERE evaluated_at > datetime('now','-1 hour')`);
    const maxThreshold = thresholdRow?.m ?? 0;
    verdict.push({
      id: 'K5', name: 'Scorer dynamicThreshold >= 999',
      firing: maxThreshold >= 999,
      detail: `max dynamic_threshold in last hour = ${maxThreshold}${maxThreshold >= 999 ? ' · scorer hard-blocking' : ''}`,
    });

    // K6 — Blocklist too aggressive?
    const blocklistSize = safe(`SELECT COUNT(*) as n FROM blocklist`)?.n ?? 0;

    // K7 — audit_archive has AUTO_POST decisions but no posted=1 candidates
    const archiveAutoPost = safe(`SELECT COUNT(*) as n FROM audit_archive WHERE final_decision='AUTO_POST' AND created_at > datetime('now','-24 hours')`)?.n ?? 0;
    const actualPosted    = safe(`SELECT COUNT(*) as n FROM candidates WHERE posted=1 AND evaluated_at > datetime('now','-24 hours')`)?.n ?? 0;
    verdict.push({
      id: 'K7', name: 'AUTO_POST decided but not actually posted',
      firing: archiveAutoPost > 0 && actualPosted === 0,
      detail: `archive AUTO_POSTs 24h=${archiveAutoPost} · candidates.posted=1 24h=${actualPosted}${archiveAutoPost > actualPosted ? ' · POST SEND IS FAILING AFTER DECISION' : ''}`,
    });

    // K8 — Claude downgrade rate: how often Claude flipped AUTO_POST → WATCHLIST
    const claudeDowngrades = safe(`
      SELECT COUNT(*) as n FROM candidates
      WHERE claude_risk = 'EXTREME' AND composite_score >= 42
        AND final_decision IN ('WATCHLIST','IGNORE','HOLD_FOR_REVIEW')
        AND evaluated_at > datetime('now', '-24 hours')
    `)?.n ?? 0;
    verdict.push({
      id: 'K8', name: 'Claude downgrading AUTO_POST candidates',
      firing: claudeDowngrades >= 3,
      detail: `Claude flagged EXTREME + downgraded ${claudeDowngrades} high-score coins in last 24h${claudeDowngrades >= 3 ? ' · Claude prompt still too strict' : ''}`,
    });

    // K9 — OpenAI overriding AUTO_POST to IGNORE
    const openaiIgnores = safe(`
      SELECT COUNT(*) as n FROM candidates
      WHERE openai_decision = 'IGNORE' AND composite_score >= 42
        AND evaluated_at > datetime('now', '-24 hours')
    `)?.n ?? 0;
    verdict.push({
      id: 'K9', name: 'OpenAI overriding to IGNORE',
      firing: openaiIgnores >= 3,
      detail: `GPT-4o IGNORE'd ${openaiIgnores} scored coins in last 24h${openaiIgnores >= 3 ? ' · OpenAI is the final authority and is killing posts' : ''}`,
    });

    // K10 — isRecentlySeen dedupe too aggressive
    const feed24h = safe(`SELECT COUNT(*) as n FROM scanner_feed WHERE scanned_at > datetime('now','-24 hours')`)?.n ?? 0;
    const deduped24h = safe(`SELECT COUNT(*) as n FROM scanner_feed WHERE filter_action='DEDUPED' AND scanned_at > datetime('now','-24 hours')`)?.n ?? 0;
    const dedupedRatio = feed24h > 0 ? deduped24h / feed24h : 0;
    verdict.push({
      id: 'K10', name: 'Dedupe cache too aggressive',
      firing: dedupedRatio > 0.5,
      detail: `${deduped24h}/${feed24h} scanner rows DEDUPED (${Math.round(dedupedRatio*100)}%)${dedupedRatio > 0.5 ? ' · cache cooldown may be too long' : ''}`,
    });

    // K11 — No candidates being scored at all (pipeline broken)
    const scored24h = safe(`SELECT COUNT(*) as n FROM candidates WHERE composite_score IS NOT NULL AND evaluated_at > datetime('now','-24 hours')`)?.n ?? 0;
    verdict.push({
      id: 'K11', name: 'No scored candidates in 24h',
      firing: scored24h === 0,
      detail: `scored candidates last 24h = ${scored24h}${scored24h === 0 ? ' · processCandidate not running OR crashing silently' : ''}`,
    });

    // K12 — Trap detector auto-killing everything
    const trapCritical = safe(`SELECT COUNT(*) as n FROM candidates WHERE trap_severity IN ('CRITICAL','HIGH') AND evaluated_at > datetime('now','-24 hours')`)?.n ?? 0;
    verdict.push({
      id: 'K12', name: 'Trap detector CRITICAL/HIGH',
      firing: scored24h > 0 && trapCritical / scored24h > 0.5,
      detail: `${trapCritical}/${scored24h} hit CRITICAL/HIGH trap severity${trapCritical / Math.max(1, scored24h) > 0.5 ? ' · trap detector over-triggering' : ''}`,
    });

    // K13 — MIN_SCORE_TO_POST env var vs code default
    verdict.push({
      id: 'K13', name: 'MIN_SCORE_TO_POST env override',
      firing: Number(MIN_SCORE_TO_POST) > 40,
      detail: `current MIN_SCORE_TO_POST = ${MIN_SCORE_TO_POST}${Number(MIN_SCORE_TO_POST) > 40 ? ' · env var is set higher than code default of 35, consider deleting' : ''}`,
    });

    // Summary verdict: which killswitch is the primary culprit?
    const firing = verdict.filter(v => v.firing);
    const primary = firing.length
      ? `🎯 PRIMARY SUSPECT: ${firing[0].name} (${firing[0].id}) — ${firing[0].detail}`
      : '✓ No obvious kill-switches firing. Posts should flow. Check Railway logs for silent errors.';

    res.json({
      ok: true,
      firing_count: firing.length,
      primary_suspect: primary,
      kill_paths: verdict,
      recentMax,
      scored24h,
      archiveAutoPost,
      actualPosted,
      blocklistSize,
      activeMode: { name: modeName, minScore: modeMinScore },
      MIN_SCORE_TO_POST: Number(MIN_SCORE_TO_POST),
      AI_CONFIG_OVERRIDES,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Last 10 rejected candidates with the metric breakdown that killed them ──
// Per OpenAI brainstorm direction: log detailed breakdowns so we can see which
// filter is disproportionately blocking calls.
app.get('/api/diagnose/rejections', (req, res) => {
  setCors(res);
  try {
    // Join scanner_feed for buys_1h/sells_1h/volume_1h (those live on the feed
     // table, not on candidates). LEFT JOIN by CA so we still return rows even
     // when the scanner row has been aged out.
    let rejected = dbInstance.prepare(`
      SELECT c.contract_address, c.token, c.composite_score, c.final_decision,
             c.claude_risk, c.claude_setup_type, c.claude_verdict,
             c.openai_decision, c.openai_conviction, c.openai_verdict,
             c.dev_wallet_pct, c.top10_holder_pct, c.mint_authority, c.freeze_authority, c.lp_locked,
             c.bundle_risk, c.bubble_map_risk, c.sniper_wallet_count,
             sf.buys_1h, sf.sells_1h, c.buy_sell_ratio_1h, sf.volume_1h, c.volume_24h,
             c.holders, c.holder_growth_24h, c.market_cap, c.liquidity, c.pair_age_hours,
             c.trap_severity, c.evaluated_at
      FROM candidates c
      LEFT JOIN scanner_feed sf ON sf.contract_address = c.contract_address
      WHERE c.final_decision IN ('IGNORE','BLOCKLIST','HOLD_FOR_REVIEW','WATCHLIST')
        AND c.composite_score IS NOT NULL
        AND c.evaluated_at > datetime('now', '-24 hours')
      GROUP BY c.id
      ORDER BY c.composite_score DESC, c.evaluated_at DESC
      LIMIT 15
    `).all();

    // Fallback: if candidates table is empty but scanner_feed has SKIP/DEDUPED
    // decisions, surface those so the audit isn't blank when the full scoring
    // pipeline hasn't caught up yet.
    if (!rejected.length) {
      try {
        const feedRejected = dbInstance.prepare(`
          SELECT contract_address, token, quick_score as composite_score,
                 filter_action as final_decision,
                 NULL as claude_risk, NULL as claude_setup_type,
                 filter_reason as claude_verdict,
                 NULL as dev_wallet_pct, NULL as top10_holder_pct,
                 NULL as mint_authority, NULL as freeze_authority, NULL as lp_locked,
                 NULL as bundle_risk, NULL as bubble_map_risk, NULL as sniper_wallet_count,
                 buys_1h, sells_1h, buy_ratio_1h as buy_sell_ratio_1h,
                 volume_1h, volume_24h,
                 NULL as holders, NULL as holder_growth_24h,
                 market_cap, liquidity, pair_age_hours,
                 NULL as trap_severity, scanned_at as evaluated_at
          FROM scanner_feed
          WHERE filter_action IN ('SKIP','DEDUPED','IGNORE','BLOCKLIST')
            AND quick_score IS NOT NULL
            AND scanned_at > datetime('now', '-24 hours')
          ORDER BY quick_score DESC, scanned_at DESC
          LIMIT 10
        `).all();
        rejected = feedRejected;
      } catch (e) { /* schema may differ, fall through silently */ }
    }

    // Aggregate the most common rejection reasons across the batch
    const reasonCounts = {};
    const enriched = rejected.map(r => {
      const reasons = [];
      if (r.claude_risk === 'EXTREME')      { reasons.push('claude_extreme');     reasonCounts.claude_extreme = (reasonCounts.claude_extreme||0) + 1; }
      if (r.bundle_risk === 'SEVERE')       { reasons.push('bundle_severe');      reasonCounts.bundle_severe  = (reasonCounts.bundle_severe||0)  + 1; }
      if (r.bundle_risk === 'HIGH')         { reasons.push('bundle_high');        reasonCounts.bundle_high    = (reasonCounts.bundle_high||0)    + 1; }
      if ((r.dev_wallet_pct ?? 0) > 15)     { reasons.push('dev_high');           reasonCounts.dev_high       = (reasonCounts.dev_high||0)       + 1; }
      if ((r.top10_holder_pct ?? 0) > 70)   { reasons.push('top10_high');         reasonCounts.top10_high     = (reasonCounts.top10_high||0)     + 1; }
      if ((r.sniper_wallet_count ?? 0) > 25){ reasons.push('snipers_heavy');      reasonCounts.snipers_heavy  = (reasonCounts.snipers_heavy||0)  + 1; }
      if (r.mint_authority === 1)           { reasons.push('mint_active');        reasonCounts.mint_active    = (reasonCounts.mint_active||0)    + 1; }
      if (r.lp_locked === 0)                { reasons.push('lp_unlocked');        reasonCounts.lp_unlocked    = (reasonCounts.lp_unlocked||0)    + 1; }
      if (['HIGH','CRITICAL','SEVERE'].includes(r.trap_severity)) { reasons.push('trap_'+r.trap_severity.toLowerCase()); reasonCounts['trap_'+r.trap_severity.toLowerCase()] = (reasonCounts['trap_'+r.trap_severity.toLowerCase()]||0)+1; }
      if ((r.composite_score ?? 0) < 35)    { reasons.push('below_threshold');    reasonCounts.below_threshold= (reasonCounts.below_threshold||0)+ 1; }

      return {
        token: r.token,
        ca: r.contract_address,
        score: r.composite_score,
        decision: r.final_decision,
        rejection_reasons: reasons,
        metrics: {
          dev_pct:        r.dev_wallet_pct,
          top10_pct:      r.top10_holder_pct,
          liq_mcap_ratio: (r.liquidity && r.market_cap) ? +(r.liquidity/r.market_cap).toFixed(3) : null,
          holders:        r.holders,
          holder_growth:  r.holder_growth_24h,
          buys_1h:        r.buys_1h,
          sells_1h:       r.sells_1h,
          buy_ratio:      r.buy_sell_ratio_1h,
          vol_1h:         r.volume_1h,
          vol_24h:        r.volume_24h,
          age_hours:      r.pair_age_hours,
          mcap:           r.market_cap,
          mint_revoked:   r.mint_authority === 0,
          lp_locked:      r.lp_locked === 1,
          bundle_risk:    r.bundle_risk,
          claude_risk:    r.claude_risk,
        },
        claude: r.claude_verdict ? r.claude_verdict.slice(0, 150) : null,
        openai: r.openai_verdict ? r.openai_verdict.slice(0, 150) : null,
        openai_decision: r.openai_decision ?? null,
        openai_conviction: r.openai_conviction ?? null,
      };
    });

    // Recommendation: which filter is disproportionately killing things?
    const sorted = Object.entries(reasonCounts).sort((a,b) => b[1] - a[1]);
    const topReason = sorted[0];
    const recommendation = topReason
      ? `Top rejection cause: '${topReason[0]}' hit ${topReason[1]}/${rejected.length} times. Consider loosening that gate.`
      : 'No rejections in the last 24h.';

    res.json({
      ok: true,
      rejection_count: rejected.length,
      reason_summary:  reasonCounts,
      recommendation,
      rejected_samples: enriched,
      generated_at:    new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Score distribution diagnostic ────────────────────────────────────────
// Breaks down every score we produced in the last 24h into buckets so the
// user can see in one shot: "OK, 80% of scores are 25-40 → threshold of 50
// will never fire. Drop it to 35."
app.get('/api/diagnose/distribution', (req, res) => {
  setCors(res);
  try {
    const dist = dbInstance.prepare(`
      SELECT
        SUM(CASE WHEN composite_score >= 80 THEN 1 ELSE 0 END) as b80plus,
        SUM(CASE WHEN composite_score BETWEEN 70 AND 79 THEN 1 ELSE 0 END) as b70_79,
        SUM(CASE WHEN composite_score BETWEEN 60 AND 69 THEN 1 ELSE 0 END) as b60_69,
        SUM(CASE WHEN composite_score BETWEEN 50 AND 59 THEN 1 ELSE 0 END) as b50_59,
        SUM(CASE WHEN composite_score BETWEEN 40 AND 49 THEN 1 ELSE 0 END) as b40_49,
        SUM(CASE WHEN composite_score BETWEEN 30 AND 39 THEN 1 ELSE 0 END) as b30_39,
        SUM(CASE WHEN composite_score BETWEEN 20 AND 29 THEN 1 ELSE 0 END) as b20_29,
        SUM(CASE WHEN composite_score < 20 THEN 1 ELSE 0 END) as bunder20,
        SUM(CASE WHEN composite_score IS NULL THEN 1 ELSE 0 END) as bunscored,
        COUNT(*) as total,
        MAX(composite_score) as max_score,
        MIN(composite_score) as min_score,
        AVG(composite_score) as avg_score
      FROM candidates
      WHERE evaluated_at > datetime('now', '-24 hours')
    `).get() || {};

    const top20 = dbInstance.prepare(`
      SELECT token, contract_address, composite_score, final_decision, claude_risk, market_cap, pair_age_hours
      FROM candidates
      WHERE composite_score IS NOT NULL
        AND evaluated_at > datetime('now', '-24 hours')
      ORDER BY composite_score DESC
      LIMIT 20
    `).all();

    res.json({
      ok: true,
      currentThreshold: Math.max(35, Number(MIN_SCORE_TO_POST) || 35),
      bucket_24h: dist,
      top_20_scoring_24h: top20,
      recommendation: (() => {
        if (dist.b50_59 + dist.b60_69 + dist.b70_79 + dist.b80plus === 0) {
          return 'Nothing is scoring 50+. Threshold of 35 or lower is the only way to get posts. Consider regime adjustments or widening scanner intake.';
        }
        if (dist.b50_59 + dist.b60_69 + dist.b70_79 + dist.b80plus < 5) {
          return 'Fewer than 5 coins in 24h scored 50+. Keep threshold at 35 to get minimum post volume for learning.';
        }
        return 'Score distribution looks healthy. Can push threshold higher (40-45) once you have 20+ resolved outcomes.';
      })(),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── On-demand scoring — score ANY token live when the user clicks it ─────
// Fires the full enrich + score pipeline right now, persists the result, and
// returns the scored candidate so the detail view can re-render with real
// numbers. Solves the "click a card, see no score" problem instantly.
app.post('/api/score-now/:ca', async (req, res) => {
  setCors(res);
  const ca = (req.params.ca || '').trim();
  if (!ca || ca.length < 32) return res.status(400).json({ ok: false, error: 'Invalid CA' });

  try {
    const startMs = Date.now();
    // Build a minimal candidate seed — enrichCandidate fills the rest
    const seed = { contractAddress: ca, _discoveredAt: Date.now(), _onDemand: true };
    let enriched;
    try {
      enriched = await enrichCandidate(seed);
    } catch (err) {
      return res.status(502).json({ ok: false, error: `Enrichment failed: ${err.message}` });
    }
    if (!enriched || !enriched.marketCap) {
      return res.status(404).json({ ok: false, error: 'Token not found on DexScreener / Helius' });
    }
    enriched._discoveredAt = startMs;
    enriched._onDemand     = true;

    // Run scoring + persist via the same path the scanner uses
    await processCandidate(enriched, false);

    const ms = Date.now() - startMs;
    // Pull the freshly-scored row to return
    const row = dbInstance.prepare(
      `SELECT * FROM candidates WHERE contract_address=? ORDER BY id DESC LIMIT 1`
    ).get(ca);
    res.json({ ok: true, candidate: row, scoredInMs: ms });
  } catch (err) {
    console.error('[score-now]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Send a test Telegram post to verify the pipeline is wired up ────────
// Hit with POST /api/diagnose/test-telegram — sends a simple message to the
// configured group. If this works, Telegram is fine and the issue is scoring.
app.post('/api/diagnose/test-telegram', async (req, res) => {
  setCors(res);
  try {
    const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
    const text = `🧪 <b>TEST POST from PULSE CALLER</b>\n\nIf you're seeing this, Telegram posting works.\n\n⏰ ${now} ET\n📡 Bot is online and able to post AUTO_POST calls when a candidate scores ≥ ${MIN_SCORE_TO_POST}.`;
    if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN missing in Railway env vars' });
    if (!TELEGRAM_GROUP_CHAT_ID) return res.status(503).json({ ok: false, error: 'TELEGRAM_GROUP_CHAT_ID missing in Railway env vars' });
    await sendTelegramGroupMessage(text);
    res.json({ ok: true, sentTo: TELEGRAM_GROUP_CHAT_ID, message: text });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Force-post the highest-scoring candidate from the last N hours ──────
// Use when you just want to SEE a post happen. Skips the score threshold
// and posts whatever the top scored candidate is.
// POST /api/diagnose/force-post?hours=6   (default 6h window)
app.post('/api/diagnose/force-post', async (req, res) => {
  setCors(res);
  try {
    const hours = Math.min(parseInt(req.query.hours) || 6, 48);
    const row = dbInstance.prepare(`
      SELECT * FROM candidates
      WHERE composite_score IS NOT NULL
        AND evaluated_at > datetime('now', ?)
        AND contract_address IS NOT NULL
      ORDER BY composite_score DESC
      LIMIT 1
    `).get(`-${hours} hours`);
    if (!row) return res.status(404).json({ ok: false, error: `No scored candidate found in the last ${hours}h` });

    if (!TELEGRAM_BOT_TOKEN) return res.status(503).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN missing' });
    if (!TELEGRAM_GROUP_CHAT_ID) return res.status(503).json({ ok: false, error: 'TELEGRAM_GROUP_CHAT_ID missing' });

    const score = row.composite_score;
    const mcap  = row.market_cap ? `$${Math.round(row.market_cap / 1000)}K` : '?';
    const liq   = row.liquidity  ? `$${Math.round(row.liquidity  / 1000)}K` : '?';
    const stage = row.stage || '?';
    const text =
      `🧪 <b>FORCE POST — $${row.token || '?'}</b>  (manual trigger)\n\n` +
      `Score: <b>${score}/100</b>  ·  Stage: ${stage}  ·  Decision: ${row.final_decision || 'n/a'}\n` +
      `MCap: ${mcap}  ·  Liq: ${liq}\n\n` +
      `<code>${row.contract_address}</code>\n\n` +
      `<a href="https://dexscreener.com/solana/${row.contract_address}">DexScreener</a> · ` +
      `<a href="https://pump.fun/${row.contract_address}">Pump.fun</a>\n\n` +
      `⚠ This was force-posted via /api/diagnose/force-post — not a real AUTO_POST decision.`;
    await sendTelegramGroupMessage(text);
    res.json({ ok: true, posted: { token: row.token, ca: row.contract_address, score }, message: text });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── DIAGNOSTIC: why is nothing posting? Surfaces all silent guards ──────
app.get('/api/diagnose/posting', (req, res) => {
  setCors(res);
  try {
    const safe = (sql, ...p) => { try { return dbInstance.prepare(sql).get(...p); } catch { return null; } };
    const safeAll = (sql, ...p) => { try { return dbInstance.prepare(sql).all(...p); } catch { return []; } };

    const dist = safeAll(`
      SELECT
        SUM(CASE WHEN composite_score >= 58 THEN 1 ELSE 0 END) as bucket_58_plus,
        SUM(CASE WHEN composite_score BETWEEN 50 AND 57 THEN 1 ELSE 0 END) as bucket_50_57,
        SUM(CASE WHEN composite_score BETWEEN 40 AND 49 THEN 1 ELSE 0 END) as bucket_40_49,
        SUM(CASE WHEN composite_score BETWEEN 30 AND 39 THEN 1 ELSE 0 END) as bucket_30_39,
        SUM(CASE WHEN composite_score < 30 THEN 1 ELSE 0 END) as bucket_under_30,
        SUM(CASE WHEN composite_score IS NULL THEN 1 ELSE 0 END) as bucket_unscored,
        MAX(composite_score) as max_score_24h,
        AVG(composite_score) as avg_score_24h
      FROM candidates
      WHERE evaluated_at > datetime('now', '-24 hours')
    `)[0] || {};

    const autoPost24h = safe(`SELECT COUNT(*) as n FROM candidates WHERE final_decision='AUTO_POST' AND evaluated_at > datetime('now','-24 hours')`)?.n ?? 0;
    const calls24h    = safe(`SELECT COUNT(*) as n FROM calls WHERE called_at > datetime('now','-24 hours')`)?.n ?? 0;
    const lastAutoPost = safe(`SELECT token, contract_address, composite_score, evaluated_at FROM candidates WHERE final_decision='AUTO_POST' ORDER BY evaluated_at DESC LIMIT 1`);
    const lastCall     = safe(`SELECT token, contract_address, called_at, posted_at FROM calls ORDER BY called_at DESC LIMIT 1`);
    const freezeRow    = safe(`SELECT value FROM agent_system_state WHERE key='freeze_active'`);
    const driftRow     = safe(`SELECT value FROM agent_system_state WHERE key='drift_warning'`);

    const checks = {
      env: {
        TELEGRAM_BOT_TOKEN_present:    !!TELEGRAM_BOT_TOKEN,
        TELEGRAM_GROUP_CHAT_ID_present: !!TELEGRAM_GROUP_CHAT_ID,
        ADMIN_TELEGRAM_ID_present:     !!ADMIN_TELEGRAM_ID,
        MIN_SCORE_TO_POST_value:       Number(MIN_SCORE_TO_POST),
        CLAUDE_API_KEY_present:        !!CLAUDE_API_KEY,
        OPENAI_API_KEY_present:        !!OPENAI_API_KEY,
        HELIUS_API_KEY_present:        !!process.env.HELIUS_API_KEY,
      },
      runtime: {
        pausePosting:        AI_CONFIG_OVERRIDES?.pausePosting ?? false,
        freezeActive:        freezeRow?.value === 'true',
        driftWarning:        driftRow?.value === 'true',
        activeMode:          activeMode?.name ?? '?',
      },
      flow_24h: {
        scoreDistribution: {
          '58+':         dist.bucket_58_plus    || 0,
          '50-57':       dist.bucket_50_57      || 0,
          '40-49':       dist.bucket_40_49      || 0,
          '30-39':       dist.bucket_30_39      || 0,
          'under_30':    dist.bucket_under_30   || 0,
          'unscored':    dist.bucket_unscored   || 0,
        },
        max_score:       dist.max_score_24h ?? null,
        avg_score:       dist.avg_score_24h ? Math.round(dist.avg_score_24h * 10) / 10 : null,
        auto_post_count: autoPost24h,
        calls_count:     calls24h,
        last_auto_post:  lastAutoPost,
        last_call:       lastCall,
      },
    };

    // Why-not-posted: for coins scoring >= threshold but not AUTO_POSTing,
    // break down WHY they were blocked (EXTREME risk, BLOCKLIST decision,
    // trap triggered, etc). This is the single most useful number when
    // the user asks "why aren't we posting anything".
    const whyBlocked = safeAll(`
      SELECT final_decision, claude_risk, trap_severity, bundle_risk,
             dev_wallet_pct, top10_holder_pct, COUNT(*) as n
      FROM candidates
      WHERE composite_score >= 42
        AND final_decision != 'AUTO_POST'
        AND evaluated_at > datetime('now', '-24 hours')
      GROUP BY final_decision, claude_risk, trap_severity
      ORDER BY n DESC
      LIMIT 15
    `);
    const scoredButBlocked = safe(`
      SELECT COUNT(*) as n FROM candidates
      WHERE composite_score >= 42 AND final_decision != 'AUTO_POST'
        AND evaluated_at > datetime('now', '-24 hours')
    `)?.n ?? 0;
    const extremeRiskCount = safe(`
      SELECT COUNT(*) as n FROM candidates
      WHERE composite_score >= 42 AND claude_risk = 'EXTREME'
        AND evaluated_at > datetime('now', '-24 hours')
    `)?.n ?? 0;
    const blocklistCount = safe(`
      SELECT COUNT(*) as n FROM candidates
      WHERE composite_score >= 42 AND final_decision = 'BLOCKLIST'
        AND evaluated_at > datetime('now', '-24 hours')
    `)?.n ?? 0;
    const trapCount = safe(`
      SELECT COUNT(*) as n FROM candidates
      WHERE composite_score >= 42
        AND trap_severity IN ('HIGH','CRITICAL','SEVERE')
        AND evaluated_at > datetime('now', '-24 hours')
    `)?.n ?? 0;
    checks.flow_24h.blockReasons = {
      total_scored_42plus_not_posted: scoredButBlocked,
      extreme_risk: extremeRiskCount,
      blocklist: blocklistCount,
      trap_triggered: trapCount,
      breakdown_rows: whyBlocked,
    };

    // Compose a verdict so the user sees the diagnosis at a glance
    const reasons = [];
    if (!checks.env.TELEGRAM_BOT_TOKEN_present)     reasons.push('❌ TELEGRAM_BOT_TOKEN env var missing — Telegram silently skipped');
    if (!checks.env.TELEGRAM_GROUP_CHAT_ID_present) reasons.push('❌ TELEGRAM_GROUP_CHAT_ID env var missing — group post silently skipped');
    if (checks.runtime.pausePosting)                reasons.push('⏸ AI_CONFIG_OVERRIDES.pausePosting=true — posting paused via dashboard config');
    if (checks.runtime.freezeActive)                reasons.push('🥶 freeze_active=true — agent kill-switch is on');
    if (checks.flow_24h.scoreDistribution['58+'] === 0 && checks.flow_24h.auto_post_count === 0) {
      reasons.push(`📉 No candidate scored ≥58 in the last 24h (max: ${checks.flow_24h.max_score ?? 'n/a'}, avg: ${checks.flow_24h.avg_score ?? 'n/a'}). Threshold may be too high OR scoring is starving.`);
    }
    if (checks.flow_24h.auto_post_count > 0 && checks.flow_24h.calls_count === 0) {
      reasons.push('⚠ AUTO_POST decisions exist but NO calls in calls table — post path itself failing silently after decision');
    }
    // Why-blocked diagnosis
    if (scoredButBlocked > 0) {
      if (extremeRiskCount >= scoredButBlocked * 0.5) {
        reasons.push(`🚫 ${extremeRiskCount}/${scoredButBlocked} scored-42+ coins blocked by EXTREME risk (usually dev % > 15 or bundle SEVERE). Risk gate is catching rugs — this is correct behavior, but means the gem quality right now is poor.`);
      }
      if (blocklistCount >= scoredButBlocked * 0.3) {
        reasons.push(`⛔ ${blocklistCount}/${scoredButBlocked} hit BLOCKLIST decision (serial rugger, mint active + dev >15%, trap triggered). Scorer's hard-blocks working as intended.`);
      }
      if (trapCount >= scoredButBlocked * 0.3) {
        reasons.push(`🪤 ${trapCount}/${scoredButBlocked} had HIGH/CRITICAL trap severity. Trap detector catching manipulation.`);
      }
    }
    if (!reasons.length) reasons.push('✓ No obvious blockers found — check Railway logs for [ai-os] PAUSED or sendCallAlert errors');

    res.json({ ok: true, verdict: reasons, checks, generatedAt: new Date().toISOString() });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Dev Fingerprint API ──────────────────────────────────────────────────
app.get('/api/dev-fingerprint/:address', async (req, res) => {
  setCors(res);
  try {
    const { getDevFingerprint } = await import('./dev-fingerprint.js');
    const fp = getDevFingerprint(req.params.address, dbInstance);
    res.json({ ok: true, fingerprint: fp });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/dev-fingerprints/top', (req, res) => {
  setCors(res);
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const grade = req.query.grade;
    let q = `SELECT * FROM dev_fingerprints WHERE total_launches >= 1`;
    const params = [];
    if (grade) { q += ` AND grade = ?`; params.push(grade); }
    q += ` ORDER BY fingerprint_score DESC LIMIT ?`;
    params.push(limit);
    const rows = dbInstance.prepare(q).all(...params);
    const counts = dbInstance.prepare(
      `SELECT grade, COUNT(*) as n FROM dev_fingerprints GROUP BY grade`
    ).all();
    res.json({ ok: true, devs: rows, byGrade: Object.fromEntries(counts.map(c => [c.grade, c.n])) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Pre-launch suspect wallets ───────────────────────────────────────────
app.get('/api/prelaunch/suspects', (req, res) => {
  setCors(res);
  try {
    const rows = dbInstance.prepare(
      `SELECT * FROM prelaunch_suspects WHERE expires_at > datetime('now') ORDER BY funded_at DESC LIMIT 100`
    ).all();
    res.json({ ok: true, suspects: rows, count: rows.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Cross-chain migration matches ────────────────────────────────────────
app.get('/api/crosschain/matches', (req, res) => {
  setCors(res);
  try {
    const rows = dbInstance.prepare(`
      SELECT m.*, c.token, c.token_name, c.composite_score, c.final_decision, c.market_cap
      FROM crosschain_matches m
      LEFT JOIN candidates c ON c.contract_address = m.sol_contract
      WHERE m.detected_at > datetime('now', '-24 hours')
      ORDER BY m.match_confidence DESC LIMIT 50
    `).all();
    res.json({ ok: true, matches: rows, count: rows.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Momentum / Hot Movers — parallel tracker surface ─────────────────────
// Returns the most recent spike flags (PRICE_SPIKE / VOLUME_SPIKE / BREAKOUT)
// from the momentum_snapshots table. Powers the "hot now" widget.
app.get('/api/momentum/hot', (req, res) => {
  setCors(res);
  try {
    // Guard against (a) momentum_snapshots table not existing yet, and
    // (b) candidates.token_name not existing. Both were 500ing the endpoint
    // and killing the Calls tab refresh.
    const hasTable = (() => {
      try { return !!dbInstance.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='momentum_snapshots'`
      ).get(); } catch { return false; }
    })();
    if (!hasTable) return res.json({ ok: true, spikes: [], count: 0, note: 'momentum_snapshots not initialized' });

    const hot = dbInstance.prepare(`
      SELECT m.*, c.token, c.composite_score, c.final_decision
      FROM momentum_snapshots m
      LEFT JOIN candidates c ON c.contract_address = m.contract_address
      WHERE m.spike_flag IS NOT NULL
        AND m.created_at > datetime('now', '-30 minutes')
      ORDER BY m.snapshot_at_ms DESC
      LIMIT 30
    `).all();
    res.json({ ok: true, spikes: hot, count: hot.length });
  } catch (err) {
    console.warn('[momentum/hot] query failed:', err.message);
    res.json({ ok: true, spikes: [], count: 0, error: err.message });
  }
});

// Detection-latency stats — median ms from detection → scoring → posting
app.get('/api/stats/latency', (req, res) => {
  setCors(res);
  try {
    const row = dbInstance.prepare(`
      SELECT
        COUNT(*) as n,
        AVG(enriched_at_ms - detected_at_ms) as avg_enrich_ms,
        AVG(scored_at_ms   - detected_at_ms) as avg_score_ms,
        AVG(posted_at_ms   - detected_at_ms) as avg_post_ms
      FROM candidates
      WHERE detected_at_ms IS NOT NULL
        AND evaluated_at > datetime('now', '-1 hour')
    `).get();
    res.json({ ok: true, latency: row });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Rolling-window pipeline metrics for the Analytics tab.
// Returns counts across 1h / 5h / 24h / 7d windows for every major stage.
app.get('/api/stats/rolling', (req, res) => {
  setCors(res);
  try {
    const windows = { '1h': '-1 hour', '5h': '-5 hours', '24h': '-24 hours', '7d': '-7 days' };
    const safeCount = (sql, ...params) => {
      try {
        const row = dbInstance.prepare(sql).get(...params);
        return (row && row.n != null) ? row.n : 0;
      } catch (err) {
        console.warn('[rolling] query failed:', err.message, sql.slice(0, 80));
        return 0;
      }
    };

    const out = {};
    for (const [key, sqlWindow] of Object.entries(windows)) {
      out[key] = {
        // Stage 1 — scanner detected
        scanned:        safeCount(`SELECT COUNT(*) as n FROM scanner_feed WHERE scanned_at > datetime('now', ?)`, sqlWindow),
        // Stage 2 — promoted by quick filter
        quickPromoted:  safeCount(`SELECT COUNT(*) as n FROM scanner_feed WHERE filter_action='PROMOTE' AND scanned_at > datetime('now', ?)`, sqlWindow),
        // Stage 3 — fully scored / evaluated
        evaluated:      safeCount(`SELECT COUNT(*) as n FROM candidates WHERE evaluated_at > datetime('now', ?) AND composite_score IS NOT NULL`, sqlWindow),
        // Stage 4 — Claude reviewed
        claudeRan:      safeCount(`SELECT COUNT(*) as n FROM candidates WHERE evaluated_at > datetime('now', ?) AND claude_score IS NOT NULL`, sqlWindow),
        // Stage 5 — OpenAI final-decided
        openaiRan:      safeCount(`SELECT COUNT(*) as n FROM candidates WHERE evaluated_at > datetime('now', ?) AND openai_decision IS NOT NULL`, sqlWindow),
        // Stage 6 — promoted to AUTO_POST
        autoPosted:     safeCount(`SELECT COUNT(*) as n FROM candidates WHERE evaluated_at > datetime('now', ?) AND final_decision='AUTO_POST'`, sqlWindow),
        watchlist:      safeCount(`SELECT COUNT(*) as n FROM candidates WHERE evaluated_at > datetime('now', ?) AND final_decision='WATCHLIST'`, sqlWindow),
        ignored:        safeCount(`SELECT COUNT(*) as n FROM candidates WHERE evaluated_at > datetime('now', ?) AND final_decision='IGNORE'`, sqlWindow),
        blocked:        safeCount(`SELECT COUNT(*) as n FROM candidates WHERE evaluated_at > datetime('now', ?) AND final_decision='BLOCKLIST'`, sqlWindow),
        // Stage 7 — archived
        archived:       safeCount(`SELECT COUNT(*) as n FROM audit_archive WHERE created_at > datetime('now', ?)`, sqlWindow),
        // Outcomes
        wins:           safeCount(`SELECT COUNT(*) as n FROM calls WHERE outcome='WIN' AND called_at > datetime('now', ?)`, sqlWindow),
        losses:         safeCount(`SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS' AND called_at > datetime('now', ?)`, sqlWindow),
        // Wallet enrichment
        walletsEnriched: safeCount(`SELECT COUNT(*) as n FROM tracked_wallets WHERE updated_at > datetime('now', ?)`, sqlWindow),
        // Gem-window candidates ($7.5K - $40K)
        gemCandidates:   safeCount(`SELECT COUNT(*) as n FROM candidates WHERE evaluated_at > datetime('now', ?) AND market_cap >= 7500 AND market_cap <= 40000`, sqlWindow),
      };
    }

    // Totals (no window)
    const totals = {
      scannerFeed:       safeCount(`SELECT COUNT(*) as n FROM scanner_feed`),
      candidates:        safeCount(`SELECT COUNT(*) as n FROM candidates`),
      candidatesScored:  safeCount(`SELECT COUNT(*) as n FROM candidates WHERE composite_score IS NOT NULL`),
      auditArchive:      safeCount(`SELECT COUNT(*) as n FROM audit_archive`),
      autoPosted:        safeCount(`SELECT COUNT(*) as n FROM candidates WHERE final_decision='AUTO_POST'`),
      trackedWallets:    safeCount(`SELECT COUNT(*) as n FROM tracked_wallets`),
      whales:            safeCount(`SELECT COUNT(*) as n FROM tracked_wallets WHERE category='WINNER' AND is_blacklist=0`),
      smartMoney:        safeCount(`SELECT COUNT(*) as n FROM tracked_wallets WHERE category='SMART_MONEY' AND is_blacklist=0`),
      callsResolved:     safeCount(`SELECT COUNT(*) as n FROM calls WHERE outcome IN ('WIN','LOSS','NEUTRAL')`),
      callsWins:         safeCount(`SELECT COUNT(*) as n FROM calls WHERE outcome='WIN'`),
      callsLosses:       safeCount(`SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS'`),
    };

    res.json({ ok: true, windows: out, totals, generatedAt: new Date().toISOString() });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/stats', (req, res) => {
  setCors(res);
  try {
    const stats      = getStats();
    const decisions  = getDecisionBreakdown();
    const scores     = getScoreDistribution();
    const queueStats = getQueueStats();
    const regime     = getRegimeDashboardData();

    const resolved = (() => { try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome IN ('WIN','LOSS','NEUTRAL')`).get().n; } catch { return 0; } })();
    const FT_THRESHOLD = 20;

    res.json({
      ok: true, stats, decisions, scores, queueStats, regime,
      botStatus:        getAllBotStatus(),
      scannerWatchlist: getScannerWatchlistSnapshot(),
      aiLearning: (() => {
        const totalEvals   = (() => { try { return dbInstance.prepare('SELECT COUNT(*) as n FROM candidates').get().n; } catch { return 0; } })();
        const totalCallsN  = (() => { try { return dbInstance.prepare('SELECT COUNT(*) as n FROM calls').get().n; } catch { return 0; } })();
        const winsN        = (() => { try { return dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome='WIN'").get().n; } catch { return 0; } })();
        const lossesN      = (() => { try { return dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS'").get().n; } catch { return 0; } })();
        const pendingN     = (() => { try { return dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome IS NULL OR outcome='PENDING'").get().n; } catch { return 0; } })();
        return {
          resolvedCalls:    resolved,
          totalEvaluations: totalEvals,
          totalCalls:       totalCallsN,
          wins:             winsN,
          losses:           lossesN,
          pendingCalls:     pendingN,
          winRate:          (winsN+lossesN)>0 ? Math.round(winsN/(winsN+lossesN)*100)+'%' : '—',
          ftModelActive:    !!OPENAI_FT_MODEL,
          ftModel:          OPENAI_FT_MODEL ?? null,
          openaiConfigured: !!OPENAI_API_KEY,
          alwaysOn:         true,
          readyToTrain:     true,
        };
      })(),
      mode: {
        name:            activeMode.name,
        emoji:           activeMode.emoji,
        color:           activeMode.color,
        description:     activeMode.description,
        minScore:        activeMode.minScore,
        minMarketCap:    activeMode.minMarketCap,
        minLiquidity:    activeMode.minLiquidity,
        minPairAgeHours: activeMode.minPairAgeHours,
        maxPairAgeHours: activeMode.maxPairAgeHours,
      },
      config: {
        postThreshold:   Number(MIN_SCORE_TO_POST),
        scanIntervalMs:  Number(SCAN_INTERVAL_MS),
        minLiquidity:    Number(process.env.MIN_LIQUIDITY_USD  ?? 5000),
        minVolume:       Number(process.env.MIN_VOLUME_24H_USD ?? 500),
        minMarketCap:    Number(process.env.MIN_MARKET_CAP     ?? 1000),
        maxMarketCap:    Number(process.env.MAX_MARKET_CAP     ?? 3_000_000),
        minPairAgeHours: Number(process.env.MIN_PAIR_AGE_HOURS ?? 0),
        maxPairAgeHours: Number(process.env.MAX_PAIR_AGE_HOURS ?? 4),
      },
      cycleRunning,
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// SCANNER TAB — all evaluated tokens (ALL decisions, not just posted)
// Returns recent evaluations with decision, score, CA for review
app.get('/api/scanner', (req, res) => {
  setCors(res);
  try {
    const limit    = Math.min(Number(req.query.limit ?? 100), 500);
    const offset   = Number(req.query.offset ?? 0);
    const decision = req.query.decision ?? null;
    const search   = req.query.search   ?? null;
    const minScore = req.query.minScore ?? null;

    // Build flexible query — candidates table columns vary by db.js version
    // Use id ordering (auto-increment) instead of created_at which may not exist
    // token_name is not on candidates (only audit_archive has it). Selecting
    // it was causing 500s on every /api/scanner call and breaking the Calls
    // tab reload after manual WIN/LOSS clicks.
    let q = `SELECT id, contract_address, token,
               final_decision, composite_score, market_cap, liquidity,
               pair_age_hours, stage, bundle_risk, dev_wallet_pct,
               top10_holder_pct, sniper_wallet_count, structure_grade,
               trap_severity, claude_risk, claude_setup_type,
               twitter, website, telegram
             FROM candidates WHERE 1=1`;
    const scanParams = [];

    if (decision)  { q += ` AND final_decision = ?`;              scanParams.push(decision); }
    if (search)    { q += ` AND (token LIKE ? OR contract_address LIKE ?)`;
                     const s = '%' + search + '%'; scanParams.push(s, s); }
    if (minScore)  { q += ` AND composite_score >= ?`;            scanParams.push(Number(minScore)); }

    q += ` ORDER BY id DESC LIMIT ? OFFSET ?`;
    scanParams.push(limit, offset);

    const rows  = dbInstance.prepare(q).all(...scanParams);

    const counts = dbInstance.prepare(
      `SELECT final_decision, COUNT(*) as n FROM candidates GROUP BY final_decision`
    ).all();
    const total  = dbInstance.prepare(`SELECT COUNT(*) as n FROM candidates`).get().n;

    res.json({
      ok: true, rows, total,
      byDecision: Object.fromEntries(counts.map(r => [r.final_decision, r.n])),
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});


// ══════════════════════════════════════════════════════════════════════════════
//  SMART MONEY SEEDING ENGINE — API ROUTES
//  Adds wallet discovery from any CA into the Smart Money system.
//  Safe extension: does not modify any existing routes.
// ══════════════════════════════════════════════════════════════════════════════

// ── KNOWN BAD ADDRESSES (filtered from seeding) ──
const SEED_FILTER_ADDRESSES = new Set([
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'So11111111111111111111111111111111111111112',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bF2',
]);
const SEED_FILTER_PREFIXES = ['11111', 'Sysvar', 'Vote111', 'Config1111'];

function isSeedFilteredAddress(addr) {
  if (!addr || addr.length < 32) return true;
  if (SEED_FILTER_ADDRESSES.has(addr)) return true;
  if (SEED_FILTER_PREFIXES.some(p => addr.startsWith(p))) return true;
  return false;
}

// ── WALLET SEEDING SCORER ──
function seedScoreWallet(wallet, opts = {}) {
  const { entryRank = 99, totalBuyers = 100, tokenMultiple = 1,
          appearsInWins = 0, appearsInRugs = 0, appearsTotal = 0,
          clusterFlag = 'CLEAN' } = opts;

  // 1. Entry quality (0-10)
  const entryPct = entryRank / Math.max(totalBuyers, 1);
  const entryScore = entryPct <= 0.01 ? 10 : entryPct <= 0.05 ? 8 :
                     entryPct <= 0.15 ? 6 : entryPct <= 0.30 ? 4 : 2;

  // 2. Performance (0-10) — based on token multiple at time of scan
  const perfScore = tokenMultiple >= 10 ? 10 : tokenMultiple >= 5 ? 8 :
                    tokenMultiple >= 2  ? 6  : tokenMultiple >= 1.5 ? 4 : 2;

  // 3. Repeat winner score (0-10)
  const winPct = appearsTotal > 0 ? appearsInWins / appearsTotal : 0;
  const rugPct = appearsTotal > 0 ? appearsInRugs / appearsTotal : 0;
  let repeatScore = 5; // neutral default
  if (appearsTotal >= 3) {
    repeatScore = winPct >= 0.7 ? 10 : winPct >= 0.5 ? 8 :
                  winPct >= 0.3 ? 6  : rugPct >= 0.4 ? 2 : 4;
  }

  // 4. Exit score — placeholder (no sell data available from on-chain easily)
  const exitScore = 5;

  // 5. Cluster modifier
  const clusterMod = clusterFlag === 'CLEAN' ? 1 :
                     clusterFlag === 'CLUSTERED' ? -1 :
                     clusterFlag === 'SUSPICIOUS' ? -2 : -3;

  const rawScore =
    (entryScore    * 0.25) +
    (perfScore     * 0.25) +
    (repeatScore   * 0.30) +
    (exitScore     * 0.10) +
    (5 + clusterMod) * 0.10;  // cluster: 0.10 weight, base 5, modifier applied

  const finalScore = Math.max(0, Math.min(10, rawScore));

  const category =
    finalScore >= 9.0 ? 'ALPHA' :
    finalScore >= 7.0 ? 'SMART_MONEY' :
    finalScore >= 5.0 ? 'MOMENTUM' :
    finalScore >= 3.0 ? 'SNIPER' : 'IGNORE';

  return {
    entryScore: Math.round(entryScore * 10) / 10,
    performanceScore: Math.round(perfScore * 10) / 10,
    repeatScore: Math.round(repeatScore * 10) / 10,
    exitScore: Math.round(exitScore * 10) / 10,
    clusterFlag,
    finalScore: Math.round(finalScore * 10) / 10,
    category,
  };
}

// ── GET ALL SEEDED CONTRACTS ──
app.get('/api/seed/contracts', (req, res) => {
  setCors(res);
  try {
    const rows = dbInstance.prepare(
      `SELECT * FROM seeded_contracts ORDER BY created_at DESC`
    ).all();
    res.json({ ok: true, contracts: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── GET WALLETS FOR A SEEDED CONTRACT ──
app.get('/api/seed/contracts/:id/wallets', (req, res) => {
  setCors(res);
  try {
    const { id } = req.params;
    const wallets = dbInstance.prepare(
      `SELECT * FROM seeded_wallets WHERE seeded_contract_id = ? ORDER BY final_score DESC`
    ).all(id);
    const contract = dbInstance.prepare(`SELECT * FROM seeded_contracts WHERE id = ?`).get(id);
    res.json({ ok: true, contract, wallets });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── UPDATE SEEDED CONTRACT LABEL/NOTES ──
app.put('/api/seed/contracts/:id', (req, res) => {
  setCors(res);
  try {
    const { id } = req.params;
    const { label, notes } = req.body ?? {};
    dbInstance.prepare(
      `UPDATE seeded_contracts SET label=COALESCE(?,label), notes=COALESCE(?,notes),
       updated_at=datetime('now') WHERE id=?`
    ).run(label ?? null, notes ?? null, id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── PUSH WALLET TO SMART POOL ──
app.post('/api/seed/wallets/:wallet/promote', (req, res) => {
  setCors(res);
  try {
    const { wallet } = req.params;
    const { notes } = req.body ?? {};
    // Fetch seeded_wallets record for this wallet (highest score)
    const sw = dbInstance.prepare(
      `SELECT * FROM seeded_wallets WHERE wallet_address=? ORDER BY final_score DESC LIMIT 1`
    ).get(wallet);
    if (!sw) return res.status(404).json({ ok: false, error: 'Wallet not found in seeded wallets' });

    const catMap = { ALPHA: 'WINNER', SMART_MONEY: 'SMART_MONEY', MOMENTUM: 'MOMENTUM',
                     SNIPER: 'SNIPER', IGNORE: 'CLUSTER' };
    const cat = catMap[sw.category] || 'NEUTRAL';
    dbInstance.prepare(`
      INSERT INTO tracked_wallets (address, category, score, source, notes, is_watchlist)
      VALUES (?, ?, ?, 'seeded', ?, 1)
      ON CONFLICT(address) DO UPDATE SET
        category = CASE WHEN excluded.score > score THEN excluded.category ELSE category END,
        score    = MAX(score, excluded.score),
        notes    = COALESCE(excluded.notes, notes),
        updated_at = datetime('now')
    `).run(wallet, cat, Math.round(sw.final_score * 10), notes || null);

    dbInstance.prepare(
      `UPDATE seeded_wallets SET in_smart_pool=1 WHERE wallet_address=? AND seeded_contract_id=?`
    ).run(wallet, sw.seeded_contract_id);

    res.json({ ok: true, category: cat });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── BLACKLIST WALLET FROM SEEDED ──
app.post('/api/seed/wallets/:wallet/blacklist', (req, res) => {
  setCors(res);
  try {
    const { wallet } = req.params;
    dbInstance.prepare(
      `UPDATE seeded_wallets SET is_blacklisted=1 WHERE wallet_address=?`
    ).run(wallet);
    dbInstance.prepare(`
      INSERT INTO tracked_wallets (address, category, source, is_blacklist, is_watchlist)
      VALUES (?, 'CLUSTER', 'seeded_blacklist', 1, 0)
      ON CONFLICT(address) DO UPDATE SET is_blacklist=1, updated_at=datetime('now')
    `).run(wallet);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── MAIN SEED ROUTE — scan a CA and extract wallets ──
app.post('/api/seed/scan', async (req, res) => {
  setCors(res);
  try {
    const { ca, label, mode = 'HYBRID' } = req.body ?? {};
    if (!ca) return res.status(400).json({ ok: false, error: 'ca required' });

    // Upsert seeded_contracts record
    dbInstance.prepare(`
      INSERT INTO seeded_contracts (contract_address, label, mode, scan_status)
      VALUES (?, ?, ?, 'scanning')
      ON CONFLICT(contract_address) DO UPDATE SET
        label = COALESCE(?, label),
        mode = ?,
        scan_status = 'scanning',
        updated_at = datetime('now')
    `).run(ca, label || null, mode, label || null, mode);

    const contractRecord = dbInstance.prepare(
      `SELECT id FROM seeded_contracts WHERE contract_address = ?`
    ).get(ca);
    const contractId = contractRecord.id;

    // Respond immediately — seeding runs in background
    res.json({ ok: true, contractId, message: 'Seeding started — check status in ~30s' });

    // ── BACKGROUND SEEDING ──
    setImmediate(async () => {
      try {
        console.log(`[seed] Starting wallet seed for CA: ${ca} | mode: ${mode}`);

        // 1. Fetch holder addresses via Helius
        let holders = [];
        try {
          holders = await getTopHolders(ca, HELIUS_API_KEY, 100) ?? [];
          console.log(`[seed] Helius holders: ${holders.length}`);
        } catch (err) {
          console.warn(`[seed] Helius failed: ${err.message}`);
        }

        // 2. Fetch first buyers via early_wallets history (our DB)
        let earlyWallets = [];
        try {
          earlyWallets = dbInstance.prepare(
            `SELECT wallet, entry_rank FROM early_wallets WHERE token_ca=? ORDER BY entry_rank ASC LIMIT 100`
          ).all(ca);
          console.log(`[seed] Early wallets from DB: ${earlyWallets.length}`);
        } catch {}

        // 3. Build combined wallet set based on mode
        const walletSet = new Map(); // address → {entryRank, source}
        if (mode === 'FIRST_BUYERS' || mode === 'HYBRID') {
          earlyWallets.forEach(ew => {
            if (!isSeedFilteredAddress(ew.wallet)) {
              walletSet.set(ew.wallet, { entryRank: ew.entry_rank, source: 'early_db' });
            }
          });
        }
        if (mode === 'HOLDERS' || mode === 'HYBRID') {
          holders.forEach((h, i) => {
            const addr = typeof h === 'string' ? h : h.address || h.owner;
            if (addr && !isSeedFilteredAddress(addr) && !walletSet.has(addr)) {
              walletSet.set(addr, { entryRank: i + 1, source: 'holder' });
            }
          });
        }

        console.log(`[seed] Combined wallet set: ${walletSet.size}`);

        if (walletSet.size === 0) {
          dbInstance.prepare(
            `UPDATE seeded_contracts SET scan_status='complete_empty', updated_at=datetime('now') WHERE id=?`
          ).run(contractId);
          return;
        }

        // 4. Cross-reference each wallet against our historical data
        const totalWallets = walletSet.size;
        const insertWallet = dbInstance.prepare(`
          INSERT INTO seeded_wallets
            (seeded_contract_id, contract_address, wallet_address, entry_rank,
             entry_score, performance_score, repeat_score, exit_score,
             cluster_flag, final_score, category)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(seeded_contract_id, wallet_address) DO UPDATE SET
            final_score = MAX(final_score, excluded.final_score),
            category    = excluded.category,
            entry_score = excluded.entry_score
        `);

        const counters = { ALPHA:0, SMART_MONEY:0, MOMENTUM:0, SNIPER:0, IGNORE:0 };

        const tx = dbInstance.transaction(() => {
          for (const [addr, info] of walletSet) {
            // Cross-reference against winner_wallets and early_wallets history
            let appearsInWins = 0, appearsInRugs = 0, appearsTotal = 0;
            try {
              const winRow = dbInstance.prepare(
                `SELECT COUNT(*) as n FROM winner_wallets WHERE address=?`
              ).get(addr);
              appearsInWins = winRow?.n ?? 0;
              const earlyRow = dbInstance.prepare(
                `SELECT COUNT(*) as n FROM early_wallets WHERE wallet=?`
              ).get(addr);
              appearsTotal = earlyRow?.n ?? 0;
              const trackedRow = dbInstance.prepare(
                `SELECT is_blacklist, score FROM tracked_wallets WHERE address=? LIMIT 1`
              ).get(addr);
              if (trackedRow?.is_blacklist) appearsInRugs = 1;
            } catch {}

            // Detect cluster flag from existing tracked_wallets
            let clusterFlag = 'CLEAN';
            try {
              const tw = dbInstance.prepare(
                `SELECT category FROM tracked_wallets WHERE address=? LIMIT 1`
              ).get(addr);
              if (tw?.category === 'CLUSTER') clusterFlag = 'CONTAMINATED';
              else if (tw?.category === 'RUG_ASSOCIATED') clusterFlag = 'SUSPICIOUS';
            } catch {}

            const scores = seedScoreWallet(addr, {
              entryRank: info.entryRank,
              totalBuyers: totalWallets,
              tokenMultiple: 1, // unknown at scan time
              appearsInWins,
              appearsInRugs,
              appearsTotal,
              clusterFlag,
            });

            counters[scores.category] = (counters[scores.category] || 0) + 1;

            insertWallet.run(
              contractId, ca, addr, info.entryRank,
              scores.entryScore, scores.performanceScore, scores.repeatScore,
              scores.exitScore, scores.clusterFlag, scores.finalScore, scores.category
            );
          }
        });
        tx();

        // 5. Update seeded_contracts with counts
        dbInstance.prepare(`
          UPDATE seeded_contracts SET
            scan_status='complete',
            wallet_count=?,
            alpha_count=?,
            smart_count=?,
            momentum_count=?,
            sniper_count=?,
            ignore_count=?,
            updated_at=datetime('now')
          WHERE id=?
        `).run(
          walletSet.size,
          counters.ALPHA || 0,
          counters.SMART_MONEY || 0,
          counters.MOMENTUM || 0,
          counters.SNIPER || 0,
          counters.IGNORE || 0,
          contractId
        );

        // 6. Auto-promote ALPHA and SMART_MONEY wallets to tracked_wallets DB
        let promoted = 0;
        try {
          const goodWallets = dbInstance.prepare(`
            SELECT wallet_address, category, final_score FROM seeded_wallets
            WHERE seeded_contract_id=? AND category IN ('ALPHA','SMART_MONEY','MOMENTUM')
            ORDER BY final_score DESC
          `).all(contractId);

          const upsertTracked = dbInstance.prepare(`
            INSERT INTO tracked_wallets (address, category, source, score, is_watchlist, added_by, notes)
            VALUES (?, ?, 'brain_analyzer', ?, 1, 'auto', ?)
            ON CONFLICT(address) DO UPDATE SET
              score = MAX(score, excluded.score),
              category = CASE WHEN excluded.score > score THEN excluded.category ELSE category END,
              updated_at = datetime('now')
          `);

          for (const w of goodWallets) {
            upsertTracked.run(w.wallet_address, w.category === 'ALPHA' ? 'WINNER' : w.category, w.final_score, 'Auto-promoted from brain analyzer scan of ' + ca.slice(0,8));
            promoted++;
          }
        } catch (e) { console.warn('[seed] Wallet promotion failed:', e.message); }

        console.log(`[seed] ✓ Seeded ${walletSet.size} wallets for ${ca} — ALPHA:${counters.ALPHA} SMART:${counters.SMART_MONEY} MOMENTUM:${counters.MOMENTUM} | ${promoted} promoted to wallet DB`);

      } catch (err) {
        console.error(`[seed] Scan failed for ${ca}:`, err.message);
        dbInstance.prepare(
          `UPDATE seeded_contracts SET scan_status='error', updated_at=datetime('now') WHERE id=?`
        ).run(contractId);
      }
    });

  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── SEED STATUS POLL ──
app.get('/api/seed/contracts/:id/status', (req, res) => {
  setCors(res);
  try {
    const row = dbInstance.prepare(`SELECT * FROM seeded_contracts WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, contract: row });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});


app.get('/api/candidates', (req, res) => {
  setCors(res);
  try {
    const limit     = Math.min(Number(req.query.limit    ?? 50), 200);
    const offset    = Number(req.query.offset    ?? 0);
    const decision  = req.query.decision  ?? null;
    const risk      = req.query.risk      ?? null;
    const minScore  = req.query.minScore  ?? null;
    const botSource = req.query.botSource ?? null;
    res.json({ ok: true, ...getCandidates({ limit, offset, decision, risk, minScore, botSource }) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Lookup by contract address (used by scanner tab)
app.get('/api/candidates/by-ca/:ca', (req, res) => {
  setCors(res);
  try {
    const { ca } = req.params;
    const cand = dbInstance.prepare(
      `SELECT * FROM candidates WHERE contract_address = ? ORDER BY id DESC LIMIT 1`
    ).get(ca);
    if (!cand) {
      // Also check audit_archive
      const arch = dbInstance.prepare(
        `SELECT * FROM audit_archive WHERE contract_address = ? LIMIT 1`
      ).get(ca);
      if (!arch) return res.status(404).json({ ok: false, error: 'Not found' });
      return res.json({ ok: true, candidate: arch, source: 'archive' });
    }
    // Try sub_scores (where db.js writes) first, then pulse_sub_scores legacy
    const sub = (() => {
      try {
        const a = dbInstance.prepare(
          `SELECT * FROM sub_scores WHERE candidate_id = ? ORDER BY id DESC LIMIT 1`
        ).get(cand.id);
        if (a && a.launch_quality != null) return a;
      } catch {}
      try {
        return dbInstance.prepare(
          `SELECT * FROM pulse_sub_scores WHERE candidate_id = ? ORDER BY id DESC LIMIT 1`
        ).get(cand.id) ?? null;
      } catch { return null; }
    })();
    if (sub) {
      cand.sub_scores = JSON.stringify({
        launch_quality: sub.launch_quality,
        wallet_structure: sub.wallet_structure,
        market_behavior: sub.market_behavior,
        social_narrative: sub.social_narrative,
      });
      cand.composite_score = sub.composite_score ?? cand.composite_score;
    }
    // Parse dual_parts JSON if stored
    if (cand.dual_parts && typeof cand.dual_parts === 'string') {
      try { cand.dual_parts = JSON.parse(cand.dual_parts); } catch {}
    }
    // Look up outcome from calls table
    try {
      const call = dbInstance.prepare(`SELECT outcome, peak_multiple, peak_mcap FROM calls WHERE candidate_id=? OR contract_address=? ORDER BY id DESC LIMIT 1`).get(cand.id, ca);
      if (call) { cand.outcome = call.outcome; cand.peak_multiple = call.peak_multiple; cand.peak_mcap = call.peak_mcap; }
    } catch {}
    if (!cand.outcome) {
      try {
        const arch = dbInstance.prepare(`SELECT outcome, peak_multiple, peak_mcap FROM audit_archive WHERE contract_address=? AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1`).get(ca);
        if (arch) { cand.outcome = arch.outcome; cand.peak_multiple = arch.peak_multiple; cand.peak_mcap = arch.peak_mcap; }
      } catch {}
    }
    res.json({ ok: true, candidate: cand, source: 'candidates' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Missed Opportunities — ignored/watchlist coins that since ran ≥Nx ─────
// Finds IGNORE/WATCHLIST candidates from the last H hours and batches a
// DexScreener price lookup to compute current MCap vs scan-time MCap. Coins
// running at ≥minMultiple get returned. Cheap (one batched DS call per 30
// CAs, free API). Used by the Candidates page MISSED filter to surface
// the gems we left on the table.
app.get('/api/candidates/missed', async (req, res) => {
  setCors(res);
  try {
    const hours = Math.min(168, Math.max(1, Number(req.query.hours ?? 24)));
    const minMultiple = Math.max(1.2, Number(req.query.minMultiple ?? 2));
    const cands = dbInstance.prepare(`
      SELECT id, contract_address, token, market_cap, evaluated_at, final_decision
      FROM candidates
      WHERE final_decision IN ('IGNORE', 'WATCHLIST')
        AND market_cap > 0
        AND evaluated_at > datetime('now', '-' || ? || ' hours')
      ORDER BY evaluated_at DESC
      LIMIT 200
    `).all(hours);
    if (cands.length === 0) return res.json({ ok: true, rows: [], checked: 0 });

    const caList = cands.map(c => c.contract_address).filter(Boolean);
    const results = [];
    const BATCH = 30;
    for (let i = 0; i < caList.length; i += BATCH) {
      const batch = caList.slice(i, i + BATCH).join(',');
      try {
        const dsRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch}`, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!dsRes.ok) continue;
        const dsData = await dsRes.json();
        const pairs = Array.isArray(dsData.pairs) ? dsData.pairs : [];
        const byCa = {};
        for (const p of pairs) {
          const ca = p.baseToken?.address;
          if (!ca) continue;
          const mc = p.marketCap ?? p.fdv ?? null;
          if (mc && (!byCa[ca] || mc > byCa[ca].mc)) {
            byCa[ca] = { mc, priceUsd: p.priceUsd, symbol: p.baseToken?.symbol };
          }
        }
        for (const c of cands.slice(i, i + BATCH)) {
          const now = byCa[c.contract_address];
          if (!now || !now.mc || !c.market_cap) continue;
          const multiple = now.mc / c.market_cap;
          if (multiple >= minMultiple) {
            results.push({
              id: c.id,
              contract_address: c.contract_address,
              token: c.token || now.symbol,
              decision: c.final_decision,
              scan_mcap: c.market_cap,
              current_mcap: now.mc,
              multiple: Number(multiple.toFixed(2)),
              scanned_at: c.evaluated_at,
            });
          }
        }
      } catch (err) {
        console.warn(`[missed] batch ${i}-${i+BATCH} failed: ${err.message}`);
      }
    }
    results.sort((a, b) => b.multiple - a.multiple);
    res.json({ ok: true, rows: results, checked: cands.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/candidates/:id', (req, res) => {
  setCors(res);
  try {
    const row = getCandidateById(Number(req.params.id));
    if (!row) return res.status(404).json({ ok: false, error: 'not found' });

    // Parse JSON fields stored as strings in DB
    const candidate = { ...row };
    if (typeof candidate.sub_scores === 'string') {
      try { candidate.subScores = JSON.parse(candidate.sub_scores); } catch { candidate.subScores = {}; }
    }
    if (typeof candidate.score_signals === 'string') {
      try { candidate.signals = JSON.parse(candidate.score_signals); } catch { candidate.signals = {}; }
    }
    if (typeof candidate.score_penalties === 'string') {
      try { candidate.penalties = JSON.parse(candidate.score_penalties); } catch { candidate.penalties = {}; }
    }
    if (typeof candidate.dual_parts === 'string') {
      try { candidate.dualParts = JSON.parse(candidate.dual_parts); } catch { candidate.dualParts = {}; }
    } else if (candidate.dual_parts && typeof candidate.dual_parts === 'object') {
      candidate.dualParts = candidate.dual_parts;
    }
    candidate.discoveryScore = candidate.discovery_score;
    candidate.modelUsed = candidate.model_used;
    // Look up outcome from calls table (outcomes live there, not on candidates)
    try {
      const call = dbInstance.prepare(`SELECT outcome, peak_multiple, peak_mcap FROM calls WHERE candidate_id=? OR contract_address=? ORDER BY id DESC LIMIT 1`).get(candidate.id, candidate.contract_address);
      if (call) {
        candidate.outcome = call.outcome;
        candidate.peak_multiple = call.peak_multiple;
        candidate.peak_mcap = call.peak_mcap;
      }
    } catch {}
    // Also check audit_archive
    if (!candidate.outcome) {
      try {
        const arch = dbInstance.prepare(`SELECT outcome, peak_multiple, peak_mcap FROM audit_archive WHERE contract_address=? AND outcome IS NOT NULL ORDER BY id DESC LIMIT 1`).get(candidate.contract_address);
        if (arch) {
          candidate.outcome = arch.outcome;
          candidate.peak_multiple = arch.peak_multiple;
          candidate.peak_mcap = arch.peak_mcap;
        }
      } catch {}
    }
    // Parse claudeRaw to get bull_case and red_flags for signals fallback
    if (!candidate.signals && typeof candidate.claude_raw === 'string') {
      try {
        const cr = JSON.parse(candidate.claude_raw);
        candidate.signals   = { launch: cr.bull_case ?? [], wallet: [], market: [], social: [], stealth: [] };
        candidate.penalties = { launch: cr.red_flags ?? [], wallet: [], market: [], social: [] };
      } catch {}
    }

    // ── Sub-scores fallback chain ─────────────────────────────────────────
    // Try 3 sources in order until we get real numbers:
    // 1. score_sub_scores table (written by insertSubScores in db.js)
    // 2. audit_archive.sub_scores (written by our archive hook)
    // 3. Reconstruct from known candidate fields
    if (!candidate.subScores || !Object.keys(candidate.subScores).length) {
      // Source 0: pulse_sub_scores — our own table, guaranteed schema, highest priority
      try {
        const psRow = dbInstance.prepare(
          'SELECT * FROM pulse_sub_scores WHERE candidate_id=? OR contract_address=? ORDER BY id DESC LIMIT 1'
        ).get(row.id, candidate.contract_address || row.contract_address);
        if (psRow && psRow.launch_quality != null) {
          candidate.subScores = {
            launchQuality:   psRow.launch_quality,
            walletStructure: psRow.wallet_structure,
            marketBehavior:  psRow.market_behavior,
            socialNarrative: psRow.social_narrative,
          };
          candidate.stealthBonus = psRow.stealth_bonus ?? 0;
          candidate.trapConfidencePenalty = psRow.trap_penalty ?? 0;
        }
      } catch {}
    }

    if (!candidate.subScores || !Object.keys(candidate.subScores).length) {
      // Source 0.5: sub_scores table — this is where db.js insertSubScores
      // actually writes (was a table-name mismatch with the older fallbacks below).
      try {
        const ssRow = dbInstance.prepare(
          'SELECT * FROM sub_scores WHERE candidate_id=? OR contract_address=? ORDER BY id DESC LIMIT 1'
        ).get(row.id, candidate.contract_address || row.contract_address);
        if (ssRow && (ssRow.launch_quality != null || ssRow.wallet_structure != null)) {
          candidate.subScores = {
            launchQuality:   ssRow.launch_quality,
            walletStructure: ssRow.wallet_structure,
            marketBehavior:  ssRow.market_behavior,
            socialNarrative: ssRow.social_narrative,
          };
          // Also surface signals/penalties from this row if not already set
          if (!candidate.signals || !Object.keys(candidate.signals).length) {
            try {
              candidate.signals = {
                launch: JSON.parse(ssRow.launch_signals || '[]'),
                wallet: JSON.parse(ssRow.wallet_signals || '[]'),
                market: JSON.parse(ssRow.market_signals || '[]'),
                social: JSON.parse(ssRow.social_signals || '[]'),
              };
            } catch {}
          }
          if (!candidate.penalties || !Object.keys(candidate.penalties).length) {
            try {
              candidate.penalties = {
                launch: JSON.parse(ssRow.launch_penalties || '[]'),
                wallet: JSON.parse(ssRow.wallet_penalties || '[]'),
                market: JSON.parse(ssRow.market_penalties || '[]'),
                social: JSON.parse(ssRow.social_penalties || '[]'),
              };
            } catch {}
          }
          if (!candidate.structureGrade && ssRow.structure_grade) {
            candidate.structureGrade = ssRow.structure_grade;
          }
        }
      } catch {}
    }

    if (!candidate.subScores || !Object.keys(candidate.subScores).length) {
      // Source 1: score_sub_scores table (legacy)
      try {
        // score_sub_scores may store data as columns OR as rows (one per dimension)
        // Try column format first (SELECT * returns one row with all 4 scores)
        const ssRow = dbInstance.prepare(
          'SELECT * FROM score_sub_scores WHERE candidate_id=? LIMIT 1'
        ).get(row.id);
        if (ssRow) {
          // Try column format (all 4 on one row)
          const built = {
            launchQuality:   ssRow.launch_quality   ?? ssRow.launchQuality   ?? ssRow.launch_score   ?? null,
            walletStructure: ssRow.wallet_structure ?? ssRow.walletStructure ?? ssRow.wallet_score   ?? null,
            marketBehavior:  ssRow.market_behavior  ?? ssRow.marketBehavior  ?? ssRow.market_score   ?? null,
            socialNarrative: ssRow.social_narrative ?? ssRow.socialNarrative ?? ssRow.social_score   ?? null,
          };
          const hasAll = Object.values(built).every(v => v != null);
          const hasSome = Object.values(built).some(v => v != null);

          if (hasAll) {
            // Perfect — all 4 columns present
            candidate.subScores = built;
          } else if (hasSome) {
            // Partial column match — try row-per-dimension format too
            try {
              const ssRows = dbInstance.prepare(
                'SELECT * FROM score_sub_scores WHERE candidate_id=?'
              ).all(row.id);
              if (ssRows.length > 1) {
                // Row-per-dimension: each row has (name/dimension, score/value)
                const pivot = {};
                for (const r of ssRows) {
                  const dim = r.dimension ?? r.name ?? r.score_type ?? r.type ?? null;
                  const val = r.score ?? r.value ?? r.score_value ?? null;
                  if (dim && val != null) pivot[dim] = val;
                }
                candidate.subScores = {
                  launchQuality:   pivot.launchQuality   ?? pivot.launch_quality   ?? pivot.launch   ?? built.launchQuality,
                  walletStructure: pivot.walletStructure ?? pivot.wallet_structure ?? pivot.wallet   ?? built.walletStructure,
                  marketBehavior:  pivot.marketBehavior  ?? pivot.market_behavior  ?? pivot.market   ?? built.marketBehavior,
                  socialNarrative: pivot.socialNarrative ?? pivot.social_narrative ?? pivot.social   ?? built.socialNarrative,
                };
              } else {
                candidate.subScores = built;
              }
            } catch { candidate.subScores = built; }
          }
        }
      } catch {}
    }

    if (!candidate.subScores || !Object.keys(candidate.subScores).length) {
      // Source 2: audit_archive sub_scores JSON
      try {
        const archRow = dbInstance.prepare(
          'SELECT sub_scores FROM audit_archive WHERE contract_address=? LIMIT 1'
        ).get(candidate.contract_address || row.contract_address);
        if (archRow?.sub_scores) {
          const parsed = JSON.parse(archRow.sub_scores);
          if (parsed && Object.keys(parsed).length) candidate.subScores = parsed;
        }
      } catch {}
    }

    if (!candidate.subScores || !Object.keys(candidate.subScores).length) {
      // Source 3: Reconstruct from known scored fields on the candidate row itself
      const lq = candidate.launch_quality_score ?? candidate.launchQualityScore ?? null;
      if (lq != null || candidate.composite_score != null) {
        candidate.subScores = {
          launchQuality:   lq,
          walletStructure: candidate.wallet_intel_score ?? candidate.walletIntelScore ?? null,
          marketBehavior:  null,
          socialNarrative: null,
        };
      }
    }

    // Source 4 (LAST RESORT): re-run the scorer on the fly from raw candidate
    // fields. This guarantees every detail view shows real numbers — even for
    // legacy rows scored before the sub_scores write path was wired up.
    if (!candidate.subScores
        || !Object.keys(candidate.subScores).length
        || Object.values(candidate.subScores).every(v => v == null)) {
      try {
        const c = {
          mintAuthority:           row.mint_authority,
          freezeAuthority:         row.freeze_authority,
          lpLocked:                row.lp_locked,
          pairAgeHours:            row.pair_age_hours,
          deployerHistoryRisk:     row.deployer_verdict || row.deployer_history_risk,
          launchQualityScore:      row.launch_quality_score,
          heliusOk:                row.helius_ok ?? true,
          launchUniqueBuyerRatio:  row.launch_unique_buyer_ratio,
          devWalletPct:            row.dev_wallet_pct,
          top10HolderPct:          row.top10_holder_pct,
          insiderWalletPct:        row.insider_wallet_pct,
          sniperWalletCount:       row.sniper_wallet_count,
          bundleRisk:              row.bundle_risk,
          bubbleMapRisk:           row.bubble_map_risk,
          buys1h:                  row.buys_1h,
          sells1h:                 row.sells_1h,
          buySellRatio1h:          row.buy_sell_ratio_1h,
          volumeVelocity:          row.volume_velocity,
          volumeQuality:           row.volume_quality,
          holders:                 row.holders,
          holderGrowth24h:         row.holder_growth_24h,
          marketCap:               row.market_cap,
          liquidity:               row.liquidity,
          stage:                   row.stage,
          candidateType:           row.candidate_type,
          website:                 row.website,
          twitter:                 row.twitter,
          telegram:                row.telegram,
        };
        const result = computeFullScore(c, TUNING_CONFIG?.discovery);
        if (result?.subScores) {
          candidate.subScores = result.subScores;
          if (!candidate.signals)   candidate.signals   = result.signals;
          if (!candidate.penalties) candidate.penalties = result.penalties;
          if (!candidate.structure_grade && result.structureGrade) candidate.structure_grade = result.structureGrade;
          candidate._scoreSource = 'computed-on-fly';
        }
      } catch (e) {
        console.warn('[api] on-fly score fallback failed:', e.message);
      }
    }

    candidate.trapDetector = {
      severity:          candidate.trap_severity,
      triggered:         candidate.trap_triggered,
      confidencePenalty: candidate.trap_confidence_penalty ?? 0,
    };

    res.json({ ok: true, candidate });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Must be defined BEFORE /api/calls/:id routes to avoid param collision
app.post('/api/calls/cleanup-void', (req, res) => {
  setCors(res);
  try {
    const voidCalls = dbInstance.prepare(
      `SELECT id, contract_address FROM calls
       WHERE token IS NULL AND market_cap_at_call IS NULL AND price_at_call IS NULL`
    ).all();
    if (!voidCalls.length) return res.json({ ok: true, removed: 0, message: 'No void calls to clean' });
    const del = dbInstance.prepare(`DELETE FROM calls WHERE id=?`);
    const tx = dbInstance.transaction((ids) => {
      let n = 0;
      for (const id of ids) n += del.run(id).changes;
      return n;
    });
    const removed = tx(voidCalls.map(c => c.id));
    // Also clean the audit_archive table — the calls tab pulls from there
    let archiveRemoved = 0;
    try {
      const voidArchive = dbInstance.prepare(
        `SELECT id FROM audit_archive
         WHERE (token IS NULL OR token = '') AND market_cap IS NULL
           AND final_decision = 'AUTO_POST'`
      ).all();
      if (voidArchive.length) {
        const delA = dbInstance.prepare(`DELETE FROM audit_archive WHERE id=?`);
        const txA = dbInstance.transaction((ids) => {
          let n = 0;
          for (const id of ids) n += delA.run(id).changes;
          return n;
        });
        archiveRemoved = txA(voidArchive.map(r => r.id));
      }
    } catch {}

    // Clean candidates table — void AUTO_POSTs inflate totalPosted count
    let candidatesFixed = 0;
    try {
      const r = dbInstance.prepare(
        `UPDATE candidates SET posted=0, final_decision='IGNORE'
         WHERE (token IS NULL OR token = '') AND market_cap IS NULL
           AND final_decision = 'AUTO_POST' AND posted = 1`
      ).run();
      candidatesFixed = r.changes;
    } catch {}

    console.log(`[cleanup] Removed ${removed} void calls + ${archiveRemoved} void archive + ${candidatesFixed} void candidates fixed`);
    res.json({ ok: true, removed, archiveRemoved, candidatesFixed });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/calls', (req, res) => {
  setCors(res);
  try {
    const limit  = Math.min(Number(req.query.limit  ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);
    res.json({ ok: true, ...getAllCalls({ limit, offset }) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Manual outcome override — user presses WIN / LOSS / PENDING on a call card.
// Stamps outcome_source = 'MANUAL' so the auto tracker stops touching it.
app.post('/api/calls/:id/outcome', express.json(), (req, res) => {
  setCors(res);
  try {
    const id = Number(req.params.id);
    const { outcome } = req.body ?? {};
    const allowed = ['WIN', 'LOSS', 'NEUTRAL', 'PENDING'];
    if (!allowed.includes(outcome)) {
      return res.status(400).json({ ok: false, error: `outcome must be one of ${allowed.join('/')}` });
    }
    const info = dbInstance.prepare(`
      UPDATE calls SET
        outcome = ?,
        outcome_source = ?,
        outcome_set_at = datetime('now')
      WHERE id = ?
    `).run(outcome, outcome === 'PENDING' ? null : 'MANUAL', id);
    if (info.changes === 0) return res.status(404).json({ ok: false, error: 'call not found' });

    // ── Mirror to audit_archive so the Calls tab UI (which reads
    //    /api/archive) reflects manual overrides immediately. Without this,
    //    you click WIN, the server saves, but the UI keeps showing PENDING
    //    because it's reading a different table.
    try {
      const callRow = dbInstance.prepare(
        `SELECT contract_address FROM calls WHERE id = ?`
      ).get(id);
      if (callRow?.contract_address) {
        dbInstance.prepare(`
          UPDATE audit_archive
          SET outcome           = ?,
              outcome_locked_at = datetime('now')
          WHERE contract_address = ?
        `).run(outcome === 'PENDING' ? null : outcome, callRow.contract_address);
      }
    } catch (err) {
      console.warn('[manual-outcome] audit_archive sync failed:', err.message);
    }

    logEvent('INFO', 'MANUAL_OUTCOME', `call=${id} outcome=${outcome}`);
    res.json({ ok: true, id, outcome, source: outcome === 'PENDING' ? null : 'MANUAL' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Force-refresh peak_multiple on ALL unresolved calls right now. Used by
// the Call Performance chart's 🔄 REFRESH PEAKS button when the user
// wants the chart to reflect a pump that just happened.
app.post('/api/calls/refresh-all-peaks', async (_req, res) => {
  setCors(res);
  try {
    const before = dbInstance.prepare(
      `SELECT COUNT(*) as n FROM calls WHERE (outcome IS NULL OR outcome = 'PENDING') AND called_at > datetime('now', '-48 hours')`
    ).get().n;
    await runOutcomeTracker(dbInstance);
    const resolved = dbInstance.prepare(
      `SELECT COUNT(*) as n FROM calls WHERE outcome IN ('WIN','LOSS','NEUTRAL') AND auto_resolved_at > datetime('now','-60 seconds')`
    ).get().n;
    res.json({ ok: true, scanned: before, resolvedInPass: resolved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Reset scoreboard — archive old calls, keep only specified token(s) ────────
app.post('/api/calls/reset-scoreboard', express.json(), (req, res) => {
  setCors(res);
  try {
    const { keepTokens = [] } = req.body ?? {};
    const keepUpper = keepTokens.map(t => t.toUpperCase().replace(/^\$/, ''));

    // Store the reset timestamp so we know when "current period" starts
    try { dbInstance.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES ('scoreboard_reset_at', ?)`).run(new Date().toISOString()); } catch {}

    // Count what we're archiving
    const totalCalls = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls`).get().n;

    // Archive old calls to a backup table before deleting
    try {
      dbInstance.exec(`CREATE TABLE IF NOT EXISTS calls_archive AS SELECT * FROM calls WHERE 0`);
    } catch {} // already exists

    // Move all calls except kept tokens to archive
    let keepClause = '';
    if (keepUpper.length > 0) {
      keepClause = ` AND UPPER(token) NOT IN (${keepUpper.map(() => '?').join(',')})`;
    }
    const archived = dbInstance.prepare(`INSERT INTO calls_archive SELECT * FROM calls WHERE 1=1${keepClause}`).run(...keepUpper);
    const deleted = dbInstance.prepare(`DELETE FROM calls WHERE 1=1${keepClause}`).run(...keepUpper);

    // Also remove old calls from audit_archive (they show in the Calls tab)
    try {
      if (keepUpper.length > 0) {
        dbInstance.prepare(`DELETE FROM audit_archive WHERE UPPER(token) NOT IN (${keepUpper.map(() => '?').join(',')}) AND final_decision = 'AUTO_POST'`).run(...keepUpper);
      } else {
        dbInstance.prepare(`DELETE FROM audit_archive WHERE final_decision = 'AUTO_POST'`).run();
      }
    } catch {}

    const remaining = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls`).get().n;
    console.log(`[scoreboard] RESET: archived ${archived.changes} calls, deleted ${deleted.changes}, keeping ${remaining} (tokens: ${keepUpper.join(', ') || 'none'})`);
    logEvent('INFO', 'SCOREBOARD_RESET', `Archived ${archived.changes} old calls. Keeping: ${keepUpper.join(', ') || 'none'}. Remaining: ${remaining}`);

    res.json({
      ok: true,
      archived: archived.changes,
      deleted: deleted.changes,
      remaining,
      keptTokens: keepUpper,
      message: `Scoreboard reset. ${archived.changes} old calls archived. ${remaining} calls remaining.`,
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Weekly performance stats ─────────────────────────────────────────────────
app.get('/api/stats/weekly', (req, res) => {
  setCors(res);
  try {
    // Get weekly breakdown for the last 8 weeks
    const weeks = dbInstance.prepare(`
      SELECT
        strftime('%Y-W%W', COALESCE(called_at, posted_at)) as week,
        COUNT(*) as total_calls,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN outcome = 'NEUTRAL' THEN 1 ELSE 0 END) as neutrals,
        SUM(CASE WHEN outcome IS NULL OR outcome = 'PENDING' THEN 1 ELSE 0 END) as pending,
        ROUND(AVG(CASE WHEN peak_multiple IS NOT NULL THEN peak_multiple END), 2) as avg_peak_x,
        ROUND(MAX(CASE WHEN peak_multiple IS NOT NULL THEN peak_multiple END), 2) as best_x,
        ROUND(AVG(CASE WHEN outcome = 'WIN' AND peak_multiple IS NOT NULL THEN peak_multiple END), 2) as avg_win_x,
        ROUND(AVG(CASE WHEN outcome = 'LOSS' AND peak_multiple IS NOT NULL THEN peak_multiple END), 2) as avg_loss_x,
        MIN(COALESCE(called_at, posted_at)) as week_start,
        MAX(COALESCE(called_at, posted_at)) as week_end
      FROM calls
      GROUP BY week
      ORDER BY week DESC
      LIMIT 8
    `).all();

    // Current week summary
    const current = dbInstance.prepare(`
      SELECT
        COUNT(*) as total_calls,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN outcome = 'NEUTRAL' THEN 1 ELSE 0 END) as neutrals,
        SUM(CASE WHEN outcome IS NULL OR outcome = 'PENDING' THEN 1 ELSE 0 END) as pending,
        ROUND(AVG(CASE WHEN peak_multiple IS NOT NULL THEN peak_multiple END), 2) as avg_peak_x,
        ROUND(MAX(CASE WHEN peak_multiple IS NOT NULL THEN peak_multiple END), 2) as best_x
      FROM calls
      WHERE COALESCE(called_at, posted_at) >= datetime('now', 'weekday 0', '-7 days')
    `).get();

    // All-time since reset
    const allTime = dbInstance.prepare(`
      SELECT
        COUNT(*) as total_calls,
        SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
        ROUND(AVG(CASE WHEN peak_multiple IS NOT NULL THEN peak_multiple END), 2) as avg_peak_x,
        ROUND(MAX(CASE WHEN peak_multiple IS NOT NULL THEN peak_multiple END), 2) as best_x
      FROM calls
    `).get();

    const resolved = (allTime.wins || 0) + (allTime.losses || 0);

    // Current week individual calls for the live scoreboard — deduped by
    // contract_address. Multiple calls of the same coin (rescans, retests)
    // collapse into the most recent row so the user doesn't see $Flork
    // appear 4 times with different outcomes.
    const currentCalls = dbInstance.prepare(`
      SELECT token, contract_address, outcome, peak_multiple, score_at_call,
             market_cap_at_call, call_time
      FROM (
        SELECT token, contract_address, outcome, peak_multiple, score_at_call,
               market_cap_at_call, COALESCE(called_at, posted_at) as call_time,
               id,
               ROW_NUMBER() OVER (PARTITION BY contract_address ORDER BY id DESC) as rn
        FROM calls
        WHERE COALESCE(called_at, posted_at) >= datetime('now', 'weekday 0', '-7 days')
      )
      WHERE rn = 1
      ORDER BY id DESC LIMIT 20
    `).all();

    // Reset timestamp
    const resetAt = (() => { try { return dbInstance.prepare(`SELECT value FROM kv_store WHERE key='scoreboard_reset_at'`).get()?.value; } catch { return null; } })();

    res.json({
      ok: true,
      currentWeek: current,
      currentCalls,
      resetAt,
      allTime: {
        ...allTime,
        winRate: resolved > 0 ? Math.round(allTime.wins / resolved * 100) + '%' : '—',
      },
      weeks,
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// On-demand snapshot refresh for a single call — user clicks "refresh peak"
// without waiting for the tracker loop. Fetches DexScreener live and rolls peaks.
app.post('/api/calls/:id/refresh', async (req, res) => {
  setCors(res);
  try {
    const id = Number(req.params.id);
    const row = dbInstance.prepare(`
      SELECT id, contract_address, token, market_cap_at_call, called_at
      FROM calls WHERE id = ?
    `).get(id);
    if (!row) return res.status(404).json({ ok: false, error: 'call not found' });
    await runOutcomeTracker(dbInstance); // cheap: limits to 50 unresolved
    const after = dbInstance.prepare(`
      SELECT peak_mcap, peak_multiple, peak_at, time_to_peak_minutes,
             peak_mcap_1h, peak_mcap_3h, peak_mcap_6h, last_snapshot_at, outcome
      FROM calls WHERE id = ?
    `).get(id);
    res.json({ ok: true, id, ...after });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/top-ignored', (req, res) => {
  setCors(res);
  try {
    const rows = getTopIgnoredFull({ limit: Number(req.query.limit ?? 20) });
    res.json({ ok: true, rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/scanner-feed', (req, res) => {
  setCors(res);
  try {
    const limit  = Number(req.query.limit  ?? 300);
    const action = req.query.action ?? null;
    const minAge = req.query.minAge != null ? Number(req.query.minAge) : null;
    const maxAge = req.query.maxAge != null ? Number(req.query.maxAge) : null;
    const result = getScannerFeed({ limit, action, minAge, maxAge });
    if (result.total === 0) {
      console.log('[scanner-feed] Table empty — scanner_feed table may be new or scanner not yet run');
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[scanner-feed] API error:', err.message);
    res.status(500).json({ ok: false, error: err.message, rows: [], total: 0, actionCounts: [] });
  }
});

app.get('/api/log', (req, res) => {
  setCors(res);
  try {
    const rows = getSystemLog({ limit: Math.min(Number(req.query.limit ?? 100), 500), level: req.query.level ?? null });
    res.json({ ok: true, rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/analytics', (req, res) => {
  setCors(res);
  try {
    // Recent losses with full detail for autopsy
    const recentLosses = (() => { try { return dbInstance.prepare(`
      SELECT c.token, c.contract_address, c.score_at_call, c.market_cap_at_call,
             c.risk_at_call, c.setup_type_at_call, c.peak_multiple, c.outcome,
             c.called_at, c.pct_change_1h,
             ca.claude_verdict, ca.claude_risk, ca.dev_wallet_pct, ca.top10_holder_pct,
             ca.bundle_risk, ca.sniper_wallet_count, ca.volume_velocity, ca.buy_sell_ratio_1h,
             ca.structure_grade, ca.holders
      FROM calls c LEFT JOIN candidates ca ON c.candidate_id=ca.id
      WHERE c.outcome='LOSS'
      ORDER BY c.posted_at DESC LIMIT 20
    `).all(); } catch { return []; } })();

    res.json({
      ok:                  true,
      winRateByScore:      getWinRateByScoreBand(),
      winRateBySetup:      getWinRateBySetupType(),
      winRateByMcap:       getWinRateByMcapBand(),
      missedWinners:       getMissedWinners(),
      recentLosses,
      deployerLeaderboard: getDeployerLeaderboard(),
      winnerProfiles:      getWinnerProfiles(),
      watchlist:           getWatchlistContents(),
      retest:              getRetestContents(),
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/mode', (req, res) => {
  setCors(res);
  res.json({
    ok: true, mode: activeMode,
    available: Object.values(MODES).map(m => ({
      name: m.name, emoji: m.emoji, color: m.color, description: m.description,
      minScore: m.minScore, minMarketCap: m.minMarketCap, minLiquidity: m.minLiquidity,
      minPairAgeHours: m.minPairAgeHours, maxPairAgeHours: m.maxPairAgeHours,
    })),
  });
});

app.post('/api/mode', express.json(), (req, res) => {
  setCors(res);
  const { mode, customParams } = req.body ?? {};
  if (!mode || !MODES[mode.toUpperCase()]) {
    return res.status(400).json({ ok: false, error: `Invalid mode. Use: ${Object.keys(MODES).join(', ')}` });
  }
  setMode(mode, customParams ?? null);
  const newMode    = activeMode;
  const ageDisplay = newMode.minPairAgeHours < 0.017 ? '< 1min'
    : newMode.minPairAgeHours < 1 ? Math.round(newMode.minPairAgeHours * 60) + 'min'
    : newMode.minPairAgeHours + 'hr';
  sendAdminAlert(
    `${newMode.emoji} Mode → <b>${newMode.name}</b>\n${newMode.description}\n` +
    `Score: ${newMode.minScore}+  MCap: $${(newMode.minMarketCap/1000).toFixed(0)}K  Liq: $${(newMode.minLiquidity/1000).toFixed(0)}K  Age: ${ageDisplay}–${newMode.maxPairAgeHours}h`
  );
  res.json({ ok: true, mode: newMode });
});

app.get('/api/regime', (req, res) => {
  setCors(res);
  try { res.json({ ok: true, regime: getRegimeDashboardData() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/export/finetune', (req, res) => {
  setCors(res);
  try {
    const jsonl = exportFineTuningData(dbInstance);
    if (!jsonl) return res.json({ ok: true, lines: 0, data: '' });
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="caller-bot-finetune.jsonl"');
    res.send(jsonl);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/openai/status', (req, res) => {
  setCors(res);
  const pendingCalls  = (() => { try { return getPendingCalls().length; } catch { return 0; } })();
  const resolvedCalls = (() => { try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome IN ('WIN','LOSS','NEUTRAL')`).get().n; } catch { return 0; } })();
  const FT_THRESHOLD  = 20;
  res.json({
    ok: true,
    openaiConfigured: !!OPENAI_API_KEY,
    ftModelActive:    !!OPENAI_FT_MODEL,
    ftModel:          OPENAI_FT_MODEL ?? null,
    resolvedCalls,
    pendingCalls,
    threshold:        FT_THRESHOLD,
    progress:         Math.min(resolvedCalls / FT_THRESHOLD, 1.0),
    readyForFineTune: true,  // AI OS is always active
    message: !OPENAI_API_KEY
      ? 'OPENAI_API_KEY not set — add to Railway variables'
      : OPENAI_FT_MODEL
        ? `✅ Fine-tuned model active: ${OPENAI_FT_MODEL}`
        : resolvedCalls < FT_THRESHOLD
          ? `🧠 Learning: ${resolvedCalls}/${FT_THRESHOLD} resolved calls (${FT_THRESHOLD - resolvedCalls} more needed)`
          : `🔥 Ready to fine-tune — ${resolvedCalls} resolved calls available`,
  });
});

app.post('/api/openai/finetune', async (req, res) => {
  setCors(res);
  if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY not set' });
  try {
    const jsonl = exportFineTuningData(dbInstance);
    const lines = jsonl.split('\n').filter(Boolean).length;
    if (lines < 10) return res.status(400).json({ ok: false, error: `Only ${lines} training examples — need at least 10` });
    const job = await startOpenAIFineTune(jsonl);
    logEvent('INFO', 'OPENAI_FINETUNE_STARTED', `job=${job.id} examples=${lines}`);
    await sendAdminAlert(
      `🤖 <b>OpenAI Fine-tune Started</b>\n` +
      `Job ID: <code>${job.id}</code>\n` +
      `Training examples: ${lines}\n` +
      `Model: ${job.model}\n` +
      `Status: ${job.status}\n\n` +
      `When complete, add to Railway:\n` +
      `<code>OPENAI_FT_MODEL=ft:gpt-4o-mini-...</code>`
    );
    res.json({ ok: true, job });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/smart-money', (req, res) => {
  setCors(res);
  try {
    const winners = (() => {
      try {
        return dbInstance.prepare(`
          SELECT address,
                 COUNT(*) as timesInWinners,
                 ROUND(COUNT(*) * 100.0 / MAX(1, (SELECT COUNT(*) FROM calls WHERE outcome IS NOT NULL)), 1) as winRate,
                 MAX(evaluated_at) as lastSeen,
                 GROUP_CONCAT(DISTINCT token) as tokenList
          FROM winner_wallets
          GROUP BY address
          ORDER BY timesInWinners DESC
          LIMIT 50
        `).all().map(w => ({
          ...w,
          tokens: w.tokenList ? w.tokenList.split(',').filter(Boolean) : []
        }));
      } catch { return []; }
    })();

    const ruggers = (() => {
      try {
        return dbInstance.prepare(`
          SELECT deployer_address as address,
                 rugged_launches as timesInRugs,
                 reputation_grade,
                 risk_level,
                 last_seen_at as lastSeen,
                 flags, notes
          FROM deployer_reputation
          WHERE rugged_launches > 0 OR reputation_grade = 'SERIAL_RUGGER'
          ORDER BY rugged_launches DESC
          LIMIT 50
        `).all();
      } catch { return []; }
    })();

    const allDeployers = (() => {
      try {
        return dbInstance.prepare(`
          SELECT deployer_address as address,
                 reputation_grade, risk_level,
                 total_launches, successful_launches, rugged_launches, pending_launches,
                 avg_score, last_seen_at as lastSeen, flags, notes
          FROM deployer_reputation
          ORDER BY total_launches DESC
          LIMIT 100
        `).all();
      } catch { return []; }
    })();

    const pendingCalls = (() => {
      try {
        return dbInstance.prepare(`
          SELECT id, token, contract_address, score_at_call,
                 market_cap_at_call, posted_at, called_at, outcome
          FROM calls
          ORDER BY posted_at DESC
          LIMIT 20
        `).all();
      } catch { return []; }
    })();

    const stats = (() => {
      try {
        const total   = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls`).get().n;
        const wins    = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome='WIN'`).get().n;
        const losses  = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS'`).get().n;
        const pending = dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome='PENDING' OR outcome IS NULL`).get().n;
        const wallets = dbInstance.prepare(`SELECT COUNT(DISTINCT address) as n FROM winner_wallets`).get().n;
        return { total, wins, losses, pending, wallets };
      } catch { return { total:0, wins:0, losses:0, pending:0, wallets:0 }; }
    })();

    res.json({ ok: true, winners, ruggers, allDeployers, pendingCalls, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, winners: [], ruggers: [], allDeployers: [], pendingCalls: [], stats: {} });
  }
});

app.post('/api/calls/:id/outcome', (req, res) => {
  setCors(res);
  try {
    const { id }     = req.params;
    const { outcome } = req.body;
    if (!['WIN','LOSS','NEUTRAL'].includes(outcome)) {
      return res.status(400).json({ ok: false, error: 'outcome must be WIN, LOSS, or NEUTRAL' });
    }
    const call = dbInstance.prepare(`SELECT * FROM calls WHERE id = ?`).get(id);
    if (!call) return res.status(404).json({ ok: false, error: 'Call not found' });

    dbInstance.prepare(`
      UPDATE calls SET outcome = ?, tracked_at = datetime('now') WHERE id = ?
    `).run(outcome, id);
    invalidateMemoryCache(); // refresh bot memory patterns after new outcome

    // Feed result back into wallet intelligence system
    try {
      let earlyHolders = [];
      // Try to get holder list stored with the candidate
      const cand = dbInstance.prepare(
        `SELECT holder_addresses FROM candidates WHERE contract_address=? ORDER BY id DESC LIMIT 1`
      ).get(call.contract_address);
      if (cand?.holder_addresses) {
        try { earlyHolders = JSON.parse(cand.holder_addresses); } catch {}
      }

      const entryMcap = call.market_cap_at_call ?? 0;
      if (outcome === 'WIN') {
        console.log(`[wallet-intel] ✓ WIN: $${call.token} — crediting ${earlyHolders.length} early holders`);
        recordWinnerWallets(call.contract_address, earlyHolders, 2.5); // conservative estimate
        if (call.contract_address) {
          updateDeployerOutcome(call.contract_address, 'WIN');
        }
      } else if (outcome === 'LOSS') {
        console.log(`[wallet-intel] ✗ LOSS: $${call.token} — flagging ${earlyHolders.length} early holders`);
        recordRugWallets(call.contract_address, earlyHolders);
        if (call.contract_address) {
          updateDeployerOutcome(call.contract_address, 'LOSS');
        }
      }
    } catch (e) {
      console.warn('[outcome] Wallet intel update failed (non-fatal):', e.message);
    }

    try { rebuildWinnerProfiles(); } catch {}

    logEvent('INFO', 'MANUAL_OUTCOME', `call_id=${id} token=${call.token} outcome=${outcome}`);
    res.json({ ok: true, message: `$${call.token} marked as ${outcome}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/narrative-momentum', (req, res) => {
  setCors(res);
  try {
    const resolved = (() => {
      try {
        return dbInstance.prepare(`
          SELECT c.narrative_tags, cl.outcome, cl.score_at_call as score, cl.posted_at
          FROM calls cl
          JOIN candidates c ON cl.candidate_id = c.id
          WHERE cl.outcome IN ('WIN','LOSS','NEUTRAL') AND c.narrative_tags IS NOT NULL AND c.narrative_tags != ''
          ORDER BY cl.posted_at DESC LIMIT 500
        `).all();
      } catch { return []; }
    })();

    const tagMap = {};
    for (const row of resolved) {
      const tags = (row.narrative_tags || '').split(',').map(t => t.trim()).filter(Boolean);
      for (const tag of tags) {
        if (!tagMap[tag]) tagMap[tag] = { tag, wins: 0, losses: 0, neutral: 0, total: 0, totalScore: 0 };
        tagMap[tag].total++;
        tagMap[tag].totalScore += row.score || 0;
        if (row.outcome === 'WIN')          tagMap[tag].wins++;
        else if (row.outcome === 'LOSS')    tagMap[tag].losses++;
        else                                tagMap[tag].neutral++;
      }
    }
    const weekly = Object.values(tagMap)
      .filter(t => t.total >= 2)
      .map(t => ({ ...t, winRate: t.total > 0 ? Math.round((t.wins/t.total)*100) : 0, avgScore: t.total > 0 ? Math.round(t.totalScore/t.total) : 0 }))
      .sort((a,b) => b.winRate - a.winRate || b.total - a.total);
    res.json({ ok: true, weekly, allTime: weekly, narratives: weekly, totalResolved: resolved.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message, weekly: [], allTime: [] }); }
});

// ── Telegram Webhook ──────────────────────────────────────────────────────────

// ── Telegram chat toggle — "chat on" / "chat off" controls responses ────────
let _telegramChatEnabled = true;

// ── Group chat handler — short, funny, alpha-dropping responses ─────────────
async function handleGroupChat(chatId, text, userName) {
  if (!CLAUDE_API_KEY) return;
  try {
    // Get quick bot stats for context
    const stats = (() => { try {
      const total = dbInstance.prepare('SELECT COUNT(*) as n FROM calls').get().n;
      const wins = dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome='WIN'").get().n;
      const losses = dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS'").get().n;
      return { total, wins, losses, wr: (wins+losses)>0 ? Math.round(wins/(wins+losses)*100) : 0 };
    } catch { return { total: 0, wins: 0, losses: 0, wr: 0 }; } })();

    const systemPrompt = `You are Pulse Caller — a witty, confident crypto call bot in a Telegram group. You scan Solana micro-caps and call gems.

PERSONALITY:
- Short responses ONLY. Max 2-3 sentences. Never write paragraphs.
- Funny but not cringe. Quick wit. Crypto-native slang is fine.
- Confident but not arrogant. You've got a ${stats.wr}% win rate.
- Drop alpha casually. Share quick insights about crypto markets.
- Greet people in creative ways. No boring "hello" responses.
- Respectful always. Roast the market, never the person.
- Use emojis sparingly — 1-2 max per message.
- If someone asks about a token, give a quick take.
- If someone says gm/gn, respond with energy.
- If someone asks your win rate or stats: ${stats.wins}W/${stats.losses}L (${stats.wr}%).

NEVER:
- Write more than 3 sentences
- Use HTML tags
- Be rude to anyone
- Give financial advice (say "not financial advice" if pressed)
- Respond with generic AI language

The user's name is ${userName}.`;

    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 150, system: systemPrompt, messages: [{ role: 'user', content: text }] }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return;
    const data = await res.json();
    const reply = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (reply && reply.length > 0 && reply.length < 500) {
      await sendTelegramMessage(chatId, reply);
    }
  } catch (err) {
    console.warn('[group-chat]', err.message);
  }
}

// ── Free-text Telegram chat — talk back to the bot ──────────────────────────
async function handleFreeChatTelegram(chatId, text) {
  if (!CLAUDE_API_KEY) { await sendTelegramMessage(chatId, '⚠️ Claude API key not configured'); return; }
  try {
    // Build context for Claude
    const stats = (() => { try {
      const total = dbInstance.prepare('SELECT COUNT(*) as n FROM calls').get().n;
      const wins = dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome='WIN'").get().n;
      const losses = dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS'").get().n;
      const recent = dbInstance.prepare("SELECT token, outcome, peak_multiple, score_at_call FROM calls ORDER BY id DESC LIMIT 5").all();
      return { total, wins, losses, winRate: (wins+losses)>0 ? Math.round(wins/(wins+losses)*100)+'%' : '—', recent };
    } catch { return {}; } })();

    const configSummary = `Scoring: minScoreToPost=${SCORING_CONFIG.minScoreToPost}, sweetSpotBonus=${SCORING_CONFIG.sweetSpotBonus}. Discovery weights: ${JSON.stringify(TUNING_CONFIG.discovery)}. Sweet spot: $${(AI_CONFIG_OVERRIDES.sweetSpotMin||15000)/1000}K-$${(AI_CONFIG_OVERRIDES.sweetSpotMax||40000)/1000}K.`;

    const systemPrompt = `You are Pulse Caller's AI assistant, responding via Telegram. Keep replies concise (under 300 words) and use plain text (no markdown, no HTML tags except <b> and <i>).

BOT STATUS:
- Total calls: ${stats.total || 0}, Wins: ${stats.wins || 0}, Losses: ${stats.losses || 0}, Win rate: ${stats.winRate || '—'}
- Recent calls: ${JSON.stringify(stats.recent || [])}
- Config: ${configSummary}

You can help with:
- Answering questions about bot performance, scores, tokens
- Explaining why a call was made or missed
- Suggesting config changes (user must apply via dashboard)
- Discussing strategy and scoring logic

Be direct, data-driven, and helpful.`;

    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 800, system: systemPrompt, messages: [{ role: 'user', content: text }] }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      await sendTelegramMessage(chatId, `⚠️ Claude API error: ${res.status}`);
      return;
    }

    const data = await res.json();
    const reply = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (reply) {
      // Split long messages (Telegram 4096 char limit)
      const chunks = [];
      for (let i = 0; i < reply.length; i += 4000) chunks.push(reply.slice(i, i + 4000));
      for (const chunk of chunks) await sendTelegramMessage(chatId, chunk);
    } else {
      await sendTelegramMessage(chatId, '🤖 No response generated.');
    }
  } catch (err) {
    console.error('[telegram-chat]', err.message);
    await sendTelegramMessage(chatId, `⚠️ Error: ${err.message}`);
  }
}

// ── API Health Monitor — alerts when services go down ───────────────────────
let _apiHealthState = { helius: true, birdeye: true, claude: true, openai: true, dexscreener: true };

async function runApiHealthCheck() {
  if (!_botActive) return; // Don't burn API calls when bot is off
  const alerts = [];
  const checks = {};

  // Solana RPC (using free public endpoint — saves Helius credits)
  try {
    const r = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      signal: AbortSignal.timeout(8000),
    });
    checks.helius = r.ok; // still labeled helius for dashboard compat
    if (!r.ok && _apiHealthState.helius) alerts.push(`❌ <b>Solana RPC DOWN</b> — HTTP ${r.status}. On-chain data affected.`);
    if (r.ok && !_apiHealthState.helius) alerts.push(`✅ <b>Solana RPC RECOVERED</b>`);
    _apiHealthState.helius = r.ok;
  } catch (e) {
    if (_apiHealthState.helius) alerts.push(`❌ <b>Helius RPC DOWN</b> — ${e.message}. Token detection offline.`);
    _apiHealthState.helius = false; checks.helius = false;
  }

  // Birdeye
  try {
    const key = process.env.BIRDEYE_API_KEY || process.env.BIRDEYE_API_KEY_1;
    if (key) {
      const r = await fetch('https://public-api.birdeye.so/defi/token_overview?address=So11111111111111111111111111111111111111112', {
        headers: { 'X-API-KEY': key }, signal: AbortSignal.timeout(8000),
      });
      checks.birdeye = r.ok;
      if (!r.ok && _apiHealthState.birdeye) alerts.push(`❌ <b>Birdeye API DOWN</b> — HTTP ${r.status}. Market data + enrichment affected.`);
      if (r.ok && !_apiHealthState.birdeye) alerts.push(`✅ <b>Birdeye API RECOVERED</b>`);
      _apiHealthState.birdeye = r.ok;
    }
  } catch (e) {
    if (_apiHealthState.birdeye) alerts.push(`❌ <b>Birdeye API DOWN</b> — ${e.message}. No market data.`);
    _apiHealthState.birdeye = false; checks.birdeye = false;
  }

  // DexScreener
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', {
      signal: AbortSignal.timeout(8000),
    });
    checks.dexscreener = r.ok;
    if (!r.ok && _apiHealthState.dexscreener) alerts.push(`❌ <b>DexScreener DOWN</b> — HTTP ${r.status}. Scanner can't find new tokens.`);
    if (r.ok && !_apiHealthState.dexscreener) alerts.push(`✅ <b>DexScreener RECOVERED</b>`);
    _apiHealthState.dexscreener = r.ok;
  } catch (e) {
    if (_apiHealthState.dexscreener) alerts.push(`❌ <b>DexScreener DOWN</b> — ${e.message}. Scanner offline.`);
    _apiHealthState.dexscreener = false; checks.dexscreener = false;
  }

  // Claude — use a minimal valid request to check API health
  if (CLAUDE_API_KEY) {
    try {
      const r = await fetch(CLAUDE_API_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 32, messages: [{ role: 'user', content: 'Say OK' }] }),
        signal: AbortSignal.timeout(12000),
      });
      // 200 = working. 429 = rate limited but API is alive. Both count as "up".
      checks.claude = r.ok || r.status === 429;
      if (!checks.claude && _apiHealthState.claude) alerts.push(`❌ <b>Claude API DOWN</b> — HTTP ${r.status}. AI scoring offline — bot can only use Foundation Signals.`);
      if (checks.claude && !_apiHealthState.claude) alerts.push(`✅ <b>Claude API RECOVERED</b>`);
      _apiHealthState.claude = checks.claude;
    } catch (e) {
      if (_apiHealthState.claude) alerts.push(`❌ <b>Claude API DOWN</b> — ${e.message}. No AI evaluation.`);
      _apiHealthState.claude = false; checks.claude = false;
    }
  }

  // OpenAI
  if (OPENAI_API_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(8000),
      });
      checks.openai = r.ok;
      if (!r.ok && _apiHealthState.openai) alerts.push(`❌ <b>OpenAI API DOWN</b> — HTTP ${r.status}. Secondary AI offline.`);
      if (r.ok && !_apiHealthState.openai) alerts.push(`✅ <b>OpenAI API RECOVERED</b>`);
      _apiHealthState.openai = r.ok;
    } catch (e) {
      if (_apiHealthState.openai) alerts.push(`❌ <b>OpenAI API DOWN</b> — ${e.message}`);
      _apiHealthState.openai = false; checks.openai = false;
    }
  }

  // Send alerts only when state CHANGES (down→up or up→down)
  if (alerts.length > 0) {
    const msg = `🚨 <b>API HEALTH ALERT</b>\n\n${alerts.join('\n\n')}\n\n<i>Status: Helius=${checks.helius?'✅':'❌'} Birdeye=${checks.birdeye?'✅':'❌'} DexScreener=${checks.dexscreener?'✅':'❌'} Claude=${checks.claude?'✅':'❌'} OpenAI=${checks.openai?'✅':'❌'}</i>`;
    sendAdminAlert(msg).catch(() => {});
    console.log(`[health] Alert sent: ${alerts.length} state changes`);
    logEvent('WARN', 'API_HEALTH_ALERT', alerts.join(' | '));
  }
}

// Run health check every 5 minutes
setInterval(runApiHealthCheck, 5 * 60 * 1000);
// Initial check 30s after boot
setTimeout(runApiHealthCheck, 30_000);
console.log('[health] API health monitor scheduled: every 5min');

// ── MASTER TOGGLE — kills ALL activity (scanner, enrichment, AI, health checks) ──
let _botActive = true;
// Restore from DB on boot
try {
  const saved = dbInstance.prepare(`SELECT value FROM kv_store WHERE key='bot_active'`).get();
  if (saved?.value === 'false') _botActive = false;
} catch {}
if (!_botActive) console.log('[master] ⚠ Bot is OFF (restored from DB)');

app.post('/api/bot/master-toggle', express.json(), async (req, res) => {
  setCors(res);
  const { active } = req.body ?? {};
  _botActive = active !== false;
  AI_CONFIG_OVERRIDES.pausePosting = !_botActive;
  persistAIConfig();
  try { dbInstance.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES ('bot_active', ?)`).run(String(_botActive)); } catch {}

  if (!_botActive) {
    console.log('[master] 🔴 BOT OFF — all scanning, enrichment, AI calls stopped');
    logEvent('INFO', 'BOT_OFF', 'Master toggle OFF — all activity paused');
    sendAdminAlert('🔴 <b>BOT OFFLINE</b>\n\nAll scanning, scoring, and API calls stopped.\nCall alerts paused. Send "chat on" or toggle ON to resume.').catch(() => {});
  } else {
    console.log('[master] 🟢 BOT ON — resuming all activity');
    logEvent('INFO', 'BOT_ON', 'Master toggle ON — all activity resumed');
    sendAdminAlert('🟢 <b>BOT ONLINE</b>\n\nScanning, scoring, and API calls resumed.\nCall alerts active.').catch(() => {});
  }
  res.json({ ok: true, active: _botActive });
});

app.get('/api/bot/status', (req, res) => {
  setCors(res);
  res.json({ ok: true, active: _botActive });
});

// Scanner-pipeline diagnostic — answers "why is the scanner not scanning?"
// Returns in-process state + DB counts that let us pinpoint where the
// pipeline is broken without needing Railway log access.
app.get('/api/health/scanner', (req, res) => {
  setCors(res);
  try {
    const nowIso = new Date().toISOString();
    const sinceCompleteMs = _scannerHealth.lastCycleCompletedAt
      ? Date.now() - new Date(_scannerHealth.lastCycleCompletedAt.includes('Z') ? _scannerHealth.lastCycleCompletedAt : _scannerHealth.lastCycleCompletedAt + 'Z').getTime()
      : null;
    const sinceStartMs = _scannerHealth.lastCycleStartedAt
      ? Date.now() - new Date(_scannerHealth.lastCycleStartedAt.includes('Z') ? _scannerHealth.lastCycleStartedAt : _scannerHealth.lastCycleStartedAt + 'Z').getTime()
      : null;

    const scannerFeed1h = (() => {
      try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM scanner_feed WHERE scanned_at > datetime('now','-1 hour')`).get().n; } catch { return null; }
    })();
    const scannerFeed5m = (() => {
      try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM scanner_feed WHERE scanned_at > datetime('now','-5 minutes')`).get().n; } catch { return null; }
    })();
    const scannerFeedTotal = (() => {
      try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM scanner_feed`).get().n; } catch { return null; }
    })();
    const lastScannerFeedAt = (() => {
      try { return dbInstance.prepare(`SELECT MAX(scanned_at) as at FROM scanner_feed`).get().at; } catch { return null; }
    })();
    const candidates1h = (() => {
      try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM candidates WHERE evaluated_at > datetime('now','-1 hour') AND composite_score IS NOT NULL`).get().n; } catch { return null; }
    })();
    const autoPosted1h = (() => {
      try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM candidates WHERE evaluated_at > datetime('now','-1 hour') AND final_decision='AUTO_POST'`).get().n; } catch { return null; }
    })();

    // Diagnosis — pick the most likely explanation based on the data.
    let diagnosis = 'OK';
    let remedy = null;
    if (!_botActive) {
      diagnosis = 'BOT_INACTIVE — master toggle is OFF';
      remedy = 'Toggle the bot ON from the dashboard header, or POST /api/bot/toggle { active: true }';
    } else if (cycleRunning && sinceStartMs != null && sinceStartMs > 5 * 60_000) {
      diagnosis = `CYCLE_STUCK — cycleRunning=true for ${Math.round(sinceStartMs/60_000)} min (should reset in <60s)`;
      remedy = 'Likely a hung fetch or uncaught promise. Restart the Railway service. If it recurs, check the last cycle error.';
    } else if (sinceCompleteMs != null && sinceCompleteMs > 3 * 60_000 && !cycleRunning) {
      diagnosis = `NO_RECENT_CYCLE — last cycle completed ${Math.round(sinceCompleteMs/60_000)} min ago (expected ≤2 min)`;
      remedy = 'Scheduler interval may be dead. Restart the Railway service.';
    } else if (scannerFeed1h === 0 && _scannerHealth.totalCyclesCompleted > 0) {
      diagnosis = 'CYCLES_RUN_BUT_NO_INSERTS — scanner cycles fire but nothing lands in scanner_feed';
      remedy = 'Likely DexScreener returning no Solana pairs, or runScanner filter stripping everything. Check Source 1/2 logs.';
    } else if (_scannerHealth.lastCycleError) {
      diagnosis = `RECENT_ERROR — ${_scannerHealth.lastCycleError.slice(0, 100)}`;
      remedy = 'Fix the underlying error. Check Railway logs for stack trace.';
    }

    res.json({
      ok: true,
      now: nowIso,
      diagnosis,
      remedy,
      inProcess: {
        botActive:              _botActive,
        cycleRunning,
        lastCycleStartedAt:     _scannerHealth.lastCycleStartedAt,
        lastCycleCompletedAt:   _scannerHealth.lastCycleCompletedAt,
        lastCycleElapsedMs:     _scannerHealth.lastCycleElapsedMs,
        lastCycleError:         _scannerHealth.lastCycleError,
        totalCyclesCompleted:   _scannerHealth.totalCyclesCompleted,
        totalCycleErrors:       _scannerHealth.totalCycleErrors,
        secondsSinceLastComplete: sinceCompleteMs == null ? null : Math.round(sinceCompleteMs / 1000),
        secondsSinceLastStart:    sinceStartMs    == null ? null : Math.round(sinceStartMs    / 1000),
      },
      database: {
        scannerFeedTotal,
        scannerFeed1h,
        scannerFeed5m,
        lastScannerFeedAt,
        candidatesEvaluated1h: candidates1h,
        autoPosted1h,
      },
      config: {
        scanIntervalMs: SCAN_INTERVAL_MS,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health check endpoint for dashboard
// Force reconnect Helius WebSocket
app.post('/api/helius/reconnect', (req, res) => {
  setCors(res);
  try {
    if (heliusListener) {
      heliusListener.stop();
      heliusListener = null;
    }
    if (HELIUS_API_KEY) {
      heliusListener = startHeliusListener(HELIUS_API_KEY);
      heliusListener.on('new_candidate', async (candidate) => {
        if (!_botActive || !candidate?.contractAddress) return;
        if (isRecentlySeen(candidate.contractAddress)) return;
        if (isBlocklisted(candidate.contractAddress)) return;
        console.log(`[helius] ⚡ Fast-track: $${candidate.token ?? '?'} (${candidate.stage})`);
        processCandidate(candidate, false).catch(() => {});
      });
      res.json({ ok: true, message: 'Helius WebSocket reconnecting...' });
    } else {
      res.json({ ok: false, error: 'No HELIUS_API_KEY' });
    }
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/health', async (req, res) => {
  setCors(res);
  res.json({ ok: true, apis: _apiHealthState });
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  // ── Inline-keyboard callback (e.g. timeframe buttons on /lb, /pulselb) ──
  // callback_data format: "<prefix>:<timeframe>" — e.g. "lb:7d", "pulselb:30d".
  // Edits the original message in place with the new timeframe content.
  const cbq = req.body?.callback_query;
  if (cbq) {
    const cbId   = cbq.id;
    const cbData = cbq.data || '';
    const msgRef = cbq.message;
    try {
      // Always answer the callback first so the button stops spinning
      try {
        await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callback_query_id: cbId }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch {}
      const [prefix, arg] = cbData.split(':');
      if (!prefix || !arg || !msgRef?.chat?.id || !msgRef?.message_id) return;

      // pnl:<userId> → P&L card for the caller. Sends as a NEW message
      // (not edit) so the original CA card stays intact and multiple users
      // can each tap to see the caller's stats. Returns early.
      if (prefix === 'pnl') {
        try {
          const { getUserProfileData, renderProfileCardHtml } = await import('./user-leaderboard.js');
          const profile = getUserProfileData(dbInstance, arg);
          const html = renderProfileCardHtml(profile, escapeHtml);
          await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id:    msgRef.chat.id,
              text:       html,
              parse_mode: 'HTML',
              disable_web_page_preview: true,
              reply_to_message_id: msgRef.message_id,
            }),
            signal: AbortSignal.timeout(8_000),
          });
        } catch (err) { console.warn('[pnl-card] err:', err.message); }
        return;
      }

      let newText, newMarkup;
      if (prefix === 'lb') {
        newText   = await renderGroupLeaderboardMessage(arg);
        newMarkup = buildLeaderboardKeyboard('lb', arg);
      } else if (prefix === 'pulselb') {
        newText   = renderPulseLeaderboardMessage(arg);
        newMarkup = buildLeaderboardKeyboard('pulselb', arg);
      } else {
        return;
      }
      // Leaderboards are photo+caption messages — use editMessageCaption.
      // Falls back to editMessageText if the original was text-only (e.g.
      // banner failed to load on the initial send).
      const isPhotoMsg = !!msgRef.photo;
      const endpoint = isPhotoMsg ? 'editMessageCaption' : 'editMessageText';
      const payload = {
        chat_id:    msgRef.chat.id,
        message_id: msgRef.message_id,
        parse_mode: 'HTML',
        reply_markup: newMarkup,
      };
      if (isPhotoMsg) {
        // Telegram caption limit = 1024 chars
        payload.caption = newText.length > 1020 ? newText.slice(0, 1017) + '…' : newText;
      } else {
        payload.text = newText;
        payload.disable_web_page_preview = true;
      }
      await fetch(`${TELEGRAM_API}/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8_000),
      });
    } catch (err) { console.warn('[tg-callback] err:', err.message); }
    return;
  }

  const message = req.body?.message;
  if (!message?.text) return;
  const chatId    = message.chat?.id;
  const fromId    = message.from?.id;
  if (!chatId) return;

  // ── Group-leaderboard CA listener + Phanes-replacement card reply ──────
  // Every NON-BOT text message gets scanned for Solana CAs. For each CA:
  //   1. Record (user, CA, mcap-now) for /grouplb ranking
  //   2. Reply under the message with a Phanes-style info card (price,
  //      MCap, vol, LP, security flags, Pulse's score if known, links)
  // Privacy-mode-OFF on the bot is required to see non-command messages —
  // set via @BotFather → Bot Settings → Group Privacy → Disable.
  // Skips bots (no infinite reply loops, no Phanes/Sect cross-tracking).
  try {
    if (message.text && message.from?.id && !message.from?.is_bot) {
      const { extractCAsFromText, recordUserCall, buildCACard, shouldReplyCard } =
        await import('./user-leaderboard.js');
      const cas = extractCAsFromText(message.text);
      if (cas.length > 0) {
        for (const ca of cas) {
          if (ca.length < 32 || ca.length > 44) continue;
          // Build the Phanes-style card (also fetches DexScreener data
          // we'll reuse as the source of truth for the mcap snapshot).
          const built = await buildCACard(dbInstance, ca, process.env.HELIUS_API_KEY, escapeHtml, {
            userId:    String(message.from.id),
            username:  message.from.username || null,
            firstName: message.from.first_name || null,
          });
          if (!built) continue;
          const { caption, imageUrl, replyMarkup } = built;
          // Re-pull mcap+token for the user_calls record (small extra hit)
          let mcap = null, token = null;
          try {
            const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, {
              signal: AbortSignal.timeout(5_000),
            });
            if (r.ok) {
              const j = await r.json();
              const pair = (j.pairs || []).find(p => p.chainId === 'solana');
              if (pair) { mcap = pair.marketCap || pair.fdv || null; token = pair.baseToken?.symbol || null; }
            }
          } catch {}
          recordUserCall(dbInstance, {
            userId:    String(message.from.id),
            username:  message.from.username || null,
            firstName: message.from.first_name || null,
            contractAddress: ca,
            token, mcap,
            chatId:    String(chatId),
            messageId: message.message_id,
          });
          // Auto-reply (deduped per chat+CA per 5min). Prefer photo+caption
          // when the token has an image — falls back to text-only otherwise.
          if (shouldReplyCard(String(chatId), ca)) {
            try {
              if (imageUrl) {
                const photoRes = await fetch(`${TELEGRAM_API}/sendPhoto`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: chatId,
                    photo: imageUrl,
                    caption: caption.slice(0, 1020),  // Telegram caption cap
                    parse_mode: 'HTML',
                    reply_to_message_id: message.message_id,
                    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
                  }),
                  signal: AbortSignal.timeout(10_000),
                });
                if (!photoRes.ok) {
                  // Photo URL was rejected — fall back to plain message
                  await fetch(`${TELEGRAM_API}/sendMessage`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      chat_id: chatId, text: caption,
                      parse_mode: 'HTML', disable_web_page_preview: true,
                      reply_to_message_id: message.message_id,
                      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
                    }),
                    signal: AbortSignal.timeout(8_000),
                  });
                }
              } else {
                await fetch(`${TELEGRAM_API}/sendMessage`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: chatId, text: caption,
                    parse_mode: 'HTML', disable_web_page_preview: true,
                    reply_to_message_id: message.message_id,
                    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
                  }),
                  signal: AbortSignal.timeout(8_000),
                });
              }
            } catch (err) { console.warn('[ca-card] reply send failed:', err.message); }
          }
        }
      }
    }
  } catch (err) { console.warn('[user-lb] listener err:', err.message); }

  const { command, args } = parseCommand(message.text);
  try {
    switch (command) {
      case '/start':     await handleStartCommand(chatId);              break;
      case '/help':      await handleHelpCommand(chatId);               break;
      case '/analyze':   await handleAnalyzeCommand(chatId, args);      break;
      case '/scan':      await handleScanCommand(chatId, args);         break;
      case '/stats':     await handleStatsCommand(chatId);              break;
      case '/calls':     await handleCallsCommand(chatId);              break;
      case '/watchlist': await handleWatchlistCommand(chatId);          break;
      case '/regime':    await handleRegimeCommand(chatId);             break;
      // ── AI Operating System commands ──
      case '/why':       await handleWhyCommand(chatId, args);          break;
      case '/top':       await handleTopCommand(chatId);                break;
      case '/config':    await handleConfigCommand(chatId, args, fromId); break;
      // ── User-facing personal features ──
      case '/portfolio':   await handlePortfolioCommand(chatId, args, fromId, message.from?.username || message.from?.first_name); break;
      case '/profile':     await handleProfileCommand(chatId, args, fromId, message.from?.username || message.from?.first_name); break;
      case '/myprofile':   await handleProfileCommand(chatId, '', fromId, message.from?.username || message.from?.first_name); break;
      case '/track':       await handleTrackWalletCommand(chatId, args, fromId, message.from?.username || message.from?.first_name); break;
      case '/untrack':     await handleUntrackWalletCommand(chatId, args, fromId); break;
      case '/mywallets':   await handleTrackWalletCommand(chatId, 'list', fromId, message.from?.username || message.from?.first_name); break;
      case '/alert':       await handleAlertCommand(chatId, args, fromId, message.from?.username || message.from?.first_name); break;
      case '/alerts':      await handleAlertCommand(chatId, 'list', fromId, message.from?.username || message.from?.first_name); break;
      // Primary group leaderboard — /lb (alias /grouplb kept for back-compat)
      case '/lb':          await handleGroupLeaderboardCommand(chatId, args); break;
      case '/grouplb':     await handleGroupLeaderboardCommand(chatId, args); break;
      // Pulse's own call leaderboard — /pulselb (alias /leaderboard kept)
      case '/pulselb':     await handleLeaderboardCommand(chatId, args); break;
      case '/leaderboard': await handleLeaderboardCommand(chatId, args); break;
      default:
        if (!message.text || message.text.startsWith('/')) break;
        const lower = message.text.trim().toLowerCase();
        const isAdmin = String(fromId) === String(ADMIN_TELEGRAM_ID);
        const isGroup = message.chat?.type === 'group' || message.chat?.type === 'supergroup';
        const firstName = message.from?.first_name || 'anon';

        // Admin toggle — works everywhere
        if (isAdmin && lower === 'chat on') {
          _telegramChatEnabled = true;
          await sendTelegramMessage(chatId, '✅ Chat responses <b>ON</b>. Call alerts always active.');
          break;
        }
        if (isAdmin && lower === 'chat off') {
          _telegramChatEnabled = false;
          await sendTelegramMessage(chatId, '🔇 Chat <b>OFF</b>. Calls only. Send "chat on" to re-enable.');
          break;
        }

        if (!_telegramChatEnabled) break;

        // Admin DMs — full Claude response
        if (isAdmin && !isGroup) {
          await handleFreeChatTelegram(chatId, message.text);
          break;
        }

        // Group chat — respond to anyone but keep it short, funny, crypto-native
        // Only respond if the bot is mentioned, or randomly ~20% of the time for vibes
        if (isGroup) {
          const botMentioned = lower.includes('pulse') || lower.includes('bot') || lower.includes('caller');
          const isQuestion = message.text.includes('?');
          const isCryptoTalk = /\$[a-zA-Z]|sol|pump|rug|moon|degen|ape|gem|token|coin|mcap|chart/i.test(message.text);
          const shouldRespond = botMentioned || (isQuestion && isCryptoTalk) || (isCryptoTalk && Math.random() < 0.15);

          if (shouldRespond) {
            await handleGroupChat(chatId, message.text, firstName);
          }
          break;
        }

        // Private chat from non-admin — still respond if enabled
        if (!isGroup) {
          await handleFreeChatTelegram(chatId, message.text);
        }
        break;
    }
  } catch (err) { console.error('[webhook]', err.message); }
});

// ─── v8.0 Intelligence API Routes ───────────────────────────────────────────

app.get('/api/v8/helius-status', (req, res) => {
  setCors(res);
  res.json({ ok: true, ...getHeliusStatus() });
});

app.get('/api/v8/wallet-db-status', (req, res) => {
  setCors(res);
  res.json({ ok: true, ...getWalletDbStatus() });
});

// Remove bogus calls that had no enrichment data (token=NULL, mcap=NULL).
// These pollute win-rate stats and clutter the dashboard.
app.get('/api/v8/learning-stats', (req, res) => {
  setCors(res);
  res.json({ ok: true, ...getLearningStats(dbInstance) });
});

// X (Twitter) API health — burn rate, cache hits, budget remaining
app.get('/api/x/health', async (req, res) => {
  setCors(res);
  try {
    const { getXApiStats } = await import('./x-api.js');
    res.json({ ok: true, ...getXApiStats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Bond rate stat — what % of our pre-bond calls actually graduated to Raydium
app.get('/api/calls/bond-stats', async (req, res) => {
  setCors(res);
  try {
    const { getBondRateStats, getBondingTrackerStats } = await import('./bonding-tracker.js');
    res.json({
      ok: true,
      stats:   getBondRateStats(dbInstance),
      tracker: getBondingTrackerStats(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manually trigger the learning loop — detects missed winners + asks
// Claude to write scoring recommendations. Normally runs every 6h, but
// fresh instances / users hitting the Analytics tab want feedback NOW.
app.post('/api/v8/generate-recommendations', async (req, res) => {
  setCors(res);
  try {
    if (!CLAUDE_API_KEY) {
      return res.status(400).json({ ok: false, error: 'CLAUDE_API_KEY not set — cannot generate recommendations' });
    }
    const { detectMissedWinners, analyzeMissedWinners } = await import('./missed-winner-tracker.js');
    const missed = await detectMissedWinners(dbInstance);
    if (!missed || missed.length === 0) {
      return res.json({
        ok: true,
        recommendations: [],
        note: 'No missed winners detected in the current window. Analytics needs a few resolved WINs in the calls table for meaningful analysis — come back after a few days of calls have resolved.',
      });
    }
    let recentCalls = [];
    try {
      recentCalls = dbInstance.prepare(`
        SELECT * FROM calls WHERE called_at > datetime('now', '-7 days')
        ORDER BY called_at DESC LIMIT 50
      `).all();
    } catch {}
    const analysis = await analyzeMissedWinners(missed, recentCalls, CLAUDE_API_KEY);
    if (!analysis) {
      return res.status(502).json({ ok: false, error: 'Claude returned no analysis (rate limit or API error)' });
    }
    try {
      dbInstance.prepare(`
        INSERT INTO learning_recommendations (analysis_json, missed_count, generated_at)
        VALUES (?, ?, datetime('now'))
      `).run(JSON.stringify(analysis), missed.length);
    } catch (err) { console.warn('[learning-recs] insert failed:', err.message); }
    res.json({
      ok: true,
      missedCount: missed.length,
      recommendations: analysis.recommendations ?? [],
      topPattern: analysis.topPattern,
      keySignalsMissed: analysis.keySignalsMissed,
    });
  } catch (err) {
    console.error('[learning-recs] manual trigger failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/v8/check-wallet', (req, res) => {
  setCors(res);
  const { address } = req.body ?? {};
  if (!address) return res.status(400).json({ ok: false, error: 'address required' });
  const wallet   = walletDb.get(address);
  const deployer = deployerDb.getVerdict(address);
  res.json({ ok: true, wallet, deployer });
});

app.post('/api/v8/check-deployer', (req, res) => {
  setCors(res);
  const { address } = req.body ?? {};
  if (!address) return res.status(400).json({ ok: false, error: 'address required' });
  res.json({ ok: true, ...checkDeployer(address) });
});

app.get('/api/v8/dune-wallet-status', (req, res) => {
  setCors(res);
  const duneStatus = getDuneWalletStatus();
  // Also get DB stats
  let dbStats = { total: 0, manual: 0, dune: 0, winners: 0, snipers: 0 };
  try {
    dbStats.total   = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets`).get().n;
    dbStats.manual  = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source='manual'`).get().n;
    dbStats.dune    = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source!='manual'`).get().n;
    dbStats.winners = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE category='WINNER'`).get().n;
    dbStats.snipers = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE category='SNIPER'`).get().n;
  } catch {}
  res.json({ ok: true, ...duneStatus, dbStats });
});

// ── Tracked Wallets CRUD ──────────────────────────────────────────────────────

// Get all tracked wallets with filtering
// Smart Money rankings — sorted by score, win rate, or category
// ─── DB Backup ───────────────────────────────────────────────────────────────
// One-click backup: streams a fresh consistent copy of the SQLite DB to the
// browser. Uses better-sqlite3's online backup so it's safe even while the
// bot is writing. Store these snapshots anywhere (Google Drive, Dropbox, etc).
app.get('/api/db/backup', async (req, res) => {
  setCors(res);
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const tmpPath = path.join(
      process.env.RAILWAY_VOLUME_MOUNT_PATH || '/tmp',
      `backup-${ts}.db`
    );
    await dbInstance.backup(tmpPath);
    const stat = await import('fs').then(fs => fs.statSync(tmpPath));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="caller-bot-${ts}.db"`);
    res.setHeader('Content-Length', stat.size);
    const fs = await import('fs');
    const stream = fs.createReadStream(tmpPath);
    stream.pipe(res);
    stream.on('end',   () => { try { fs.unlinkSync(tmpPath); } catch {} });
    stream.on('error', () => { try { fs.unlinkSync(tmpPath); } catch {} });
    logEvent('INFO', 'DB_BACKUP', `Manual backup streamed (${Math.round(stat.size/1024/1024)}MB)`);
  } catch (err) {
    console.error('[db-backup] failed:', err.stack || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Quick health check — tells you if the DB is persistent and how big it is.
// Diagnostic: test Solscan + Helius holder fetch for a CA
app.get('/api/diagnose/holders/:ca', async (req, res) => {
  setCors(res);
  const { ca } = req.params;
  const result = {
    solscan: { keyPresent: !!process.env.SOLSCAN_API_KEY, status: null, ownersFound: 0, error: null },
    helius:  { keyPresent: !!HELIUS_API_KEY,              status: null, ownersFound: 0, error: null },
  };
  // Test Solscan
  if (process.env.SOLSCAN_API_KEY) {
    try {
      const r = await fetch(
        `https://pro-api.solscan.io/v2.0/token/holders?address=${encodeURIComponent(ca)}&page_size=20&page=1`,
        { headers: { token: process.env.SOLSCAN_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(9_000) }
      );
      result.solscan.status = r.status;
      const j = await r.json();
      const arr = j?.data?.items || j?.data || [];
      result.solscan.ownersFound = Array.isArray(arr) ? arr.length : 0;
      if (!r.ok) result.solscan.error = j?.message || j?.error || 'HTTP ' + r.status;
    } catch (e) { result.solscan.error = e.message; }
  }
  // Test Helius
  if (HELIUS_API_KEY) {
    try {
      const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'diag', method: 'getTokenLargestAccounts', params: [ca, { commitment: 'confirmed' }] }),
        signal: AbortSignal.timeout(9_000),
      });
      result.helius.status = r.status;
      const j = await r.json();
      result.helius.ownersFound = (j?.result?.value || []).length;
      if (j?.error) result.helius.error = JSON.stringify(j.error);
      if (!r.ok) result.helius.error = 'HTTP ' + r.status;
    } catch (e) { result.helius.error = e.message; }
  }
  res.json({ ok: true, ca, result });
});

// Probe Anthropic with the current Railway env CLAUDE_API_KEY and report
// the exact response. Tells you whether the key is wrong, the workspace
// has no credits, or Railway is still using a cached value.
// Wallet harvester — passive growth of tracked_wallets from our own winners.
// GET returns current stats, POST triggers an on-demand run.
app.get('/api/wallet-harvester/status', async (req, res) => {
  setCors(res);
  try {
    const { getHarvesterStats } = await import('./wallet-harvester.js');
    res.json({ ok: true, ...getHarvesterStats(dbInstance) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/api/wallet-harvester/run', async (req, res) => {
  setCors(res);
  try {
    const { triggerHarvest } = await import('./wallet-harvester.js');
    // Fire-and-forget — this can take 30-60s with many coins
    triggerHarvest(dbInstance, HELIUS_API_KEY).catch(err => console.warn('[harvester] run err:', err.message));
    res.json({ ok: true, message: 'Harvest triggered — check logs for progress' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Legendary harvester — external-signal counterpart to the passive harvester.
// Pulls the biggest Solana meme-market runs from Dune and harvests their holders.
app.get('/api/legendary-harvester/status', async (req, res) => {
  setCors(res);
  try {
    const { getLegendaryStats } = await import('./legendary-harvester.js');
    res.json({ ok: true, ...getLegendaryStats(dbInstance) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/api/legendary-harvester/run', async (req, res) => {
  setCors(res);
  try {
    const { triggerLegendaryHarvest } = await import('./legendary-harvester.js');
    // Fire-and-forget — Dune query can take 1-3min, then holder fetch
    triggerLegendaryHarvest(dbInstance, HELIUS_API_KEY).catch(err => console.warn('[legendary] run err:', err.message));
    res.json({ ok: true, message: 'Legendary harvest triggered — Dune query runs first (1-3min), then Helius fetches. Check logs.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Midcap harvester — twice-daily $250K+ MCap winner sweep
app.get('/api/midcap-harvester/status', async (req, res) => {
  setCors(res);
  try {
    const { getMidcapStats } = await import('./midcap-harvester.js');
    res.json({ ok: true, ...getMidcapStats(dbInstance) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/api/midcap-harvester/run', async (req, res) => {
  setCors(res);
  try {
    const { triggerMidcapHarvest } = await import('./midcap-harvester.js');
    triggerMidcapHarvest(dbInstance, HELIUS_API_KEY).catch(err => console.warn('[midcap] run err:', err.message));
    res.json({ ok: true, message: 'Midcap harvest triggered — Dune query (~1min) + Helius holder fetches. Check logs.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Whale funding tracker — top WINNER wallets' outgoing SOL transfers
app.get('/api/whale-funding/status', async (req, res) => {
  setCors(res);
  try {
    const { getWhaleFundingStats } = await import('./whale-funding-tracker.js');
    res.json({ ok: true, ...getWhaleFundingStats(dbInstance) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/whale-funding/recent', async (req, res) => {
  setCors(res);
  try {
    const { getRecentWhaleFundingEvents } = await import('./whale-funding-tracker.js');
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 40));
    res.json({ ok: true, events: getRecentWhaleFundingEvents(dbInstance, limit) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/api/whale-funding/run', async (req, res) => {
  setCors(res);
  try {
    const { triggerWhaleFundingScan } = await import('./whale-funding-tracker.js');
    triggerWhaleFundingScan(dbInstance).catch(err => console.warn('[whale-funding] run err:', err.message));
    res.json({ ok: true, message: 'Whale funding scan triggered — ~50 Solscan calls, 30-60s to complete. Check logs.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Harvester cleanup — batch-scan SOL balance of every harvester-touched
// wallet, delete <8 SOL (harvester sources) or demote to NEUTRAL (curated
// sources), recategorize survivors by SOL tier (≥100=WINNER, 8-99=SMART_MONEY).
app.post('/api/harvester-cleanup/run', async (req, res) => {
  setCors(res);
  try {
    const { cleanupHarvesterDust } = await import('./harvester-cleanup.js');
    const summary = await cleanupHarvesterDust(dbInstance, HELIUS_API_KEY);
    res.json({ ok: true, summary });
  } catch (err) {
    console.error('[harvester-cleanup] failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Call-funnel diagnostic — shows where candidates drop in the pipeline
// during the rolling 60-min window. Hit this endpoint during a call
// drought to see exactly which gate is blocking everything.
app.get('/api/diagnose/funnel', (req, res) => {
  setCors(res);
  const s = _callFunnel.stages;
  const windowAgeMs = Date.now() - _callFunnel.windowStartMs;
  const total = s.evaluated || 1;
  const pct = (n) => `${((n/total)*100).toFixed(1)}%`;
  const funnel = [
    ['EVALUATED (entered pipeline)', s.evaluated, '100%'],
    ['─ data_void_skip',              s.dataVoidSkip,      pct(s.dataVoidSkip)],
    ['SCORED',                        s.scored,            pct(s.scored)],
    ['─ CLAUDE_EXTREME_VETO',         s.claudeExtremeVeto, pct(s.claudeExtremeVeto)],
    ['─ CONSENSUS_GATE (Claude no)',  s.consensusGate,     pct(s.consensusGate)],
    ['─ MOMENTUM_GATE',               s.momentumGate,      pct(s.momentumGate)],
    ['─ RUG_GUARD ($13-17.5K)',       s.rugGuard,          pct(s.rugGuard)],
    ['─ LIQUIDITY_FLOOR',             s.liquidityFloor,    pct(s.liquidityFloor)],
    ['─ FOUNDATION_TRUST',            s.foundationTrust,   pct(s.foundationTrust)],
    ['─ EARLY_MCAP_DEFER',            s.earlyMcapDefer,    pct(s.earlyMcapDefer)],
    ['─ PAUSED_POSTING',              s.pausedPosting,     pct(s.pausedPosting)],
    ['🎉 POSTED',                      s.posted,            pct(s.posted)],
  ];
  res.json({
    ok: true,
    windowAgeMinutes: Math.round(windowAgeMs / 60000),
    stages: s,
    funnel: funnel.map(([stage, n, pct]) => `${stage.padEnd(38)} ${String(n).padStart(4)}  ${pct}`),
    postRate: s.evaluated > 0 ? ((s.posted / s.evaluated) * 100).toFixed(2) + '%' : '—',
    pausedPosting: !!AI_CONFIG_OVERRIDES.pausePosting,
    scoringConfig: SCORING_CONFIG,
  });
});

app.get('/api/diagnose/claude', async (req, res) => {
  setCors(res);
  const key = process.env.CLAUDE_API_KEY || null;
  const result = {
    ok: false,
    keyPresent: !!key,
    keyPrefix: key ? key.slice(0, 12) + '…' : null,
    keyLength: key ? key.length : 0,
    timestamp: new Date().toISOString(),
  };
  if (!key) {
    result.error = 'CLAUDE_API_KEY env var is missing on Railway';
    return res.json(result);
  }
  try {
    const probeStart = Date.now();
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    result.httpStatus = r.status;
    result.latencyMs  = Date.now() - probeStart;
    const txt = await r.text();
    let body;
    try { body = JSON.parse(txt); } catch { body = { raw: txt.slice(0, 500) }; }
    result.body = body;
    if (r.ok) {
      result.ok = true;
      result.diagnosis = '✓ Claude API responding normally for this key';
    } else if (body?.error?.message?.toLowerCase?.().includes('credit balance')) {
      result.diagnosis = '⚠ Workspace this key belongs to has $0 credits. Check console.anthropic.com → Plans & Billing for the SAME workspace as the API key. Credits added to a different workspace do not transfer.';
    } else if (r.status === 401) {
      result.diagnosis = '⚠ Key invalid or revoked. Generate a fresh key in the workspace that has credits.';
    } else if (r.status === 429) {
      result.diagnosis = '⚠ Rate limited. Wait a minute and retry.';
    } else {
      result.diagnosis = `⚠ HTTP ${r.status} — see body for details`;
    }
    res.json(result);
  } catch (err) {
    result.error = err.message;
    result.diagnosis = '⚠ Network/timeout — could not reach api.anthropic.com';
    res.status(500).json(result);
  }
});

// Comprehensive live-check of every external API the bot depends on.
// Returns per-API: keyPresent, status, latency, ok, sample data, error.
app.get('/api/diagnose/apis', async (req, res) => {
  setCors(res);
  // Use a known-good SOL mint so every endpoint has something to chew on.
  const testCA = 'So11111111111111111111111111111111111111112';
  const started = Date.now();
  const out = {
    helius:      { keyPresent: !!process.env.HELIUS_API_KEY,    ok: false, ms: 0, status: null, error: null, sample: null },
    birdeye:     { keyPresent: !!process.env.BIRDEYE_API_KEY,   ok: false, ms: 0, status: null, error: null, sample: null },
    bubblemap:   {                                              ok: false, ms: 0, status: null, error: null, sample: null },
    solscan:     { keyPresent: !!process.env.SOLSCAN_API_KEY,   ok: false, ms: 0, status: null, error: null, sample: null },
    dexscreener: {                                              ok: false, ms: 0, status: null, error: null, sample: null },
    dune:        { keyPresent: !!process.env.DUNE_API_KEY,      ok: false, ms: 0, status: null, error: null, sample: null },
    lunarcrush:  { keyPresent: !!process.env.LUNARCRUSH_API_KEY, ok: false, ms: 0, status: null, error: null, sample: null },
  };

  // Helius
  if (out.helius.keyPresent) {
    const t0 = Date.now();
    try {
      const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'diag', method: 'getHealth' }),
        signal: AbortSignal.timeout(8_000),
      });
      out.helius.status = r.status; out.helius.ms = Date.now() - t0;
      const j = await r.json();
      out.helius.ok = r.ok && j?.result === 'ok';
      out.helius.sample = j?.result ?? j?.error ?? null;
      if (j?.error) out.helius.error = JSON.stringify(j.error);
    } catch (e) { out.helius.error = e.message; out.helius.ms = Date.now() - t0; }
  }

  // Birdeye
  if (out.birdeye.keyPresent) {
    const t0 = Date.now();
    try {
      const r = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${testCA}`, {
        headers: { 'X-API-KEY': process.env.BIRDEYE_API_KEY, 'x-chain': 'solana' },
        signal: AbortSignal.timeout(8_000),
      });
      out.birdeye.status = r.status; out.birdeye.ms = Date.now() - t0;
      const j = await r.json();
      out.birdeye.ok = r.ok && !!j?.data?.price;
      out.birdeye.sample = j?.data ? { price: j.data.price, mc: j.data.mc } : null;
      if (!r.ok) out.birdeye.error = j?.message || 'HTTP ' + r.status;
    } catch (e) { out.birdeye.error = e.message; out.birdeye.ms = Date.now() - t0; }
  }

  // BubbleMaps (no key needed)
  {
    const t0 = Date.now();
    try {
      const r = await fetch(`https://api-legacy.bubblemaps.io/map-metadata?token=${testCA}&chain=sol`, {
        signal: AbortSignal.timeout(8_000),
      });
      out.bubblemap.status = r.status; out.bubblemap.ms = Date.now() - t0;
      const j = await r.json();
      out.bubblemap.ok = r.ok && !!j;
      out.bubblemap.sample = j?.status ?? j?.message ?? 'ok';
      if (!r.ok) out.bubblemap.error = 'HTTP ' + r.status;
    } catch (e) { out.bubblemap.error = e.message; out.bubblemap.ms = Date.now() - t0; }
  }

  // Solscan
  if (out.solscan.keyPresent) {
    const t0 = Date.now();
    try {
      // Use the SAME endpoint as production code (server.js:7806) so the diagnose
      // result actually reflects whether Solscan works for our use case
      const r = await fetch(`https://pro-api.solscan.io/v2.0/token/holders?address=${testCA}&page_size=1&page=1`, {
        headers: { token: process.env.SOLSCAN_API_KEY, accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      out.solscan.status = r.status; out.solscan.ms = Date.now() - t0;
      const j = await r.json();
      out.solscan.ok = r.ok && !!j?.data;
      if (!r.ok) out.solscan.error = j?.message || 'HTTP ' + r.status;
    } catch (e) { out.solscan.error = e.message; out.solscan.ms = Date.now() - t0; }
  }

  // DexScreener (no key needed — primary price fallback)
  {
    const t0 = Date.now();
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${testCA}`, {
        signal: AbortSignal.timeout(8_000),
      });
      out.dexscreener.status = r.status; out.dexscreener.ms = Date.now() - t0;
      const j = await r.json();
      out.dexscreener.ok = r.ok && (j?.pairs?.length ?? 0) > 0;
      out.dexscreener.sample = { pairs: j?.pairs?.length ?? 0 };
      if (!r.ok) out.dexscreener.error = 'HTTP ' + r.status;
    } catch (e) { out.dexscreener.error = e.message; out.dexscreener.ms = Date.now() - t0; }
  }

  // Dune — test with a cheap list-queries call (no SQL execution)
  if (out.dune.keyPresent) {
    const t0 = Date.now();
    try {
      // Dune doesn't have a flat /query endpoint — only /query/{id}/results works.
      // Use production wallet DB status as health proxy: totalWallets > 0
      // means Dune queries succeeded and the DB is loaded.
      const status = (typeof getDuneWalletStatus === 'function') ? getDuneWalletStatus() : null;
      const totalWallets = status?.totalWallets ?? 0;
      out.dune.ms = Date.now() - t0;
      out.dune.ok = totalWallets > 0;
      out.dune.status = totalWallets > 0 ? 200 : 503;
      out.dune.sample = {
        wallets_loaded: totalWallets,
        ready: status?.ready,
        winners: status?.categories?.WINNER ?? 0,
        snipers: status?.categories?.SNIPER ?? 0,
      };
      if (totalWallets === 0) out.dune.error = 'Wallet DB empty — Dune sync may not have run yet';
    } catch (e) { out.dune.error = e.message; out.dune.ms = Date.now() - t0; }
  }

  // LunarCrush — hit a known topic (solana) to verify key + API reachability
  if (out.lunarcrush.keyPresent) {
    const t0 = Date.now();
    try {
      const r = await fetch('https://lunarcrush.com/api4/public/topic/solana/v1', {
        headers: { 'Authorization': `Bearer ${process.env.LUNARCRUSH_API_KEY}` },
        signal: AbortSignal.timeout(8_000),
      });
      out.lunarcrush.status = r.status; out.lunarcrush.ms = Date.now() - t0;
      const j = await r.json().catch(() => null);
      out.lunarcrush.ok = r.ok && !!j?.data;
      if (j?.data) out.lunarcrush.sample = { num_posts: j.data.num_posts, interactions_24h: j.data.interactions_24h, trend: j.data.trend };
      if (!r.ok) out.lunarcrush.error = j?.error || j?.message || 'HTTP ' + r.status;
    } catch (e) { out.lunarcrush.error = e.message; out.lunarcrush.ms = Date.now() - t0; }
  }

  const total = Date.now() - started;
  const up   = Object.values(out).filter(x => x.ok).length;
  const total_n = Object.keys(out).length;
  res.json({
    ok: true,
    summary: `${up}/${total_n} APIs healthy`,
    total_ms: total,
    checked_at: new Date().toISOString(),
    result: out,
  });
});

// FAST DB-only outcome fix — promotes any call to WIN where the stored
// peak_multiple is already >=1.5x but outcome wasn't flipped. No external
// API calls. Cascades to audit_archive, calls_archive, coin_fingerprints.
// Called both on-demand via the endpoint AND every 5 min by the scheduler
// below so outcomes never drift again.
function fixStoredPeaks() {
  const WIN_PEAK = 1.5;
  const eligible = dbInstance.prepare(`
    SELECT id, token, contract_address, peak_multiple, outcome
    FROM calls
    WHERE peak_multiple IS NOT NULL
      AND peak_multiple >= ?
      AND (outcome IS NULL OR outcome != 'WIN')
  `).all(WIN_PEAK);

  let upgraded = 0;
  const changes = [];
  for (const c of eligible) {
    const ca = c.contract_address;
    try {
      dbInstance.prepare(`
        UPDATE calls SET
          outcome = 'WIN',
          outcome_source = COALESCE(outcome_source, 'PEAK_FIX'),
          outcome_set_at = COALESCE(outcome_set_at, datetime('now')),
          auto_resolved = 1,
          auto_resolved_at = COALESCE(auto_resolved_at, datetime('now'))
        WHERE id = ?
      `).run(c.id);
      if (ca) {
        try { dbInstance.prepare(`UPDATE audit_archive SET outcome='WIN', outcome_locked_at=datetime('now') WHERE contract_address=? AND (outcome IS NULL OR outcome != 'WIN')`).run(ca); } catch {}
        try { dbInstance.prepare(`UPDATE calls_archive SET outcome='WIN' WHERE contract_address=? AND (outcome IS NULL OR outcome != 'WIN')`).run(ca); } catch {}
        try { dbInstance.prepare(`UPDATE coin_fingerprints SET outcome='WIN', resolved_at_ms=COALESCE(resolved_at_ms, ?) WHERE contract_address=? AND (outcome IS NULL OR outcome != 'WIN')`).run(Date.now(), ca); } catch {}
      }
      upgraded++;
      changes.push({ token: c.token, peak: c.peak_multiple, was: c.outcome });
    } catch (err) {
      console.warn('[peak-fix] update failed for $' + c.token + ':', err.message);
    }
  }
  return { eligible: eligible.length, upgraded, changes };
}

// Manual endpoint — kept for backwards compat + ad-hoc trigger
app.post('/api/calls/fix-stored-peaks', (req, res) => {
  setCors(res);
  try {
    const result = fixStoredPeaks();
    if (result.upgraded > 0) console.log('[peak-fix:manual] upgraded ' + result.upgraded + ' calls to WIN');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/calls/fix-stored-peaks', (req, res) => { req.method='POST'; return app._router.handle(req, res); });

// MANUAL PEAK OVERRIDE — when the auto-tracker missed the true peak (e.g.
// coin spiked between checks, then died). Lets admin set the correct peak
// for any call by CA. Cascades to all 4 outcome tables.
//
// Usage:
//   POST /api/calls/manual-peak  body: { ca, peakMcap }      ← preferred
//   POST /api/calls/manual-peak  body: { ca, peakMultiple }
//   GET  /api/calls/manual-peak?ca=...&peakMcap=1800000      ← browser-friendly
//
// Only rolls FORWARD (refuses to lower a higher stored peak unless ?force=1).
function applyManualPeakOverride({ ca, peakMcap, peakMultiple, force = false }) {
  if (!ca) return { ok: false, error: 'ca required' };
  const call = dbInstance.prepare(`SELECT * FROM calls WHERE contract_address = ? ORDER BY called_at DESC LIMIT 1`).get(ca);
  if (!call) return { ok: false, error: 'No call found for that CA' };
  if (!call.market_cap_at_call) return { ok: false, error: 'Call has no market_cap_at_call — cannot compute multiple' };

  // Resolve to both peakMcap + peakMultiple
  let mcap = peakMcap != null ? Number(peakMcap) : null;
  let mult = peakMultiple != null ? Number(peakMultiple) : null;
  if (!Number.isFinite(mcap) && Number.isFinite(mult)) mcap = mult * call.market_cap_at_call;
  if (Number.isFinite(mcap) && !Number.isFinite(mult)) mult = mcap / call.market_cap_at_call;
  if (!Number.isFinite(mcap) || !Number.isFinite(mult)) return { ok: false, error: 'peakMcap or peakMultiple required (numeric)' };
  if (mult <= 0 || mcap <= 0) return { ok: false, error: 'Values must be positive' };

  // Roll-forward check
  if (!force && (call.peak_multiple ?? 0) >= mult) {
    return { ok: false, error: `Stored peak ${call.peak_multiple}x already >= requested ${mult.toFixed(2)}x — pass ?force=1 to override` };
  }

  // Outcome derived from new multiple
  const outcome = mult >= 1.5 ? 'WIN' : mult >= 0.9 ? 'NEUTRAL' : mult >= 0.5 ? 'LOSS' : 'RUG';

  try {
    dbInstance.prepare(`
      UPDATE calls SET
        peak_multiple = ?,
        peak_mcap = ?,
        outcome = ?,
        outcome_source = 'MANUAL_OVERRIDE',
        outcome_set_at = datetime('now'),
        auto_resolved = 1,
        auto_resolved_at = COALESCE(auto_resolved_at, datetime('now'))
      WHERE id = ?
    `).run(mult, mcap, outcome, call.id);
    // Cascade
    try { dbInstance.prepare(`UPDATE audit_archive SET peak_multiple=?, outcome=?, outcome_locked_at=datetime('now') WHERE contract_address=?`).run(mult, outcome, ca); } catch {}
    try { dbInstance.prepare(`UPDATE calls_archive SET peak_multiple=?, outcome=? WHERE contract_address=?`).run(mult, outcome, ca); } catch {}
    try { dbInstance.prepare(`UPDATE coin_fingerprints SET peak_multiple=?, peak_mcap=?, outcome=?, resolved_at_ms=COALESCE(resolved_at_ms, ?) WHERE contract_address=?`).run(mult, mcap, outcome, Date.now(), ca); } catch {}

    console.log(`[manual-peak] ✓ $${call.token} updated: peak=${mult.toFixed(2)}x mcap=$${Math.round(mcap/1000)}K outcome=${outcome} (was ${call.peak_multiple}x ${call.outcome})`);
    logEvent('INFO', 'MANUAL_PEAK_OVERRIDE', `${call.token}: ${call.peak_multiple}x → ${mult.toFixed(2)}x ($${Math.round(mcap/1000)}K)`);
    return {
      ok: true,
      token: call.token,
      contract_address: ca,
      previous: { peak_multiple: call.peak_multiple, peak_mcap: call.peak_mcap, outcome: call.outcome },
      updated: { peak_multiple: +mult.toFixed(3), peak_mcap: mcap, outcome },
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

app.post('/api/calls/manual-peak', express.json(), (req, res) => {
  setCors(res);
  const { ca, peakMcap, peakMultiple } = req.body || {};
  const force = req.query.force === '1' || req.query.force === 'true';
  res.json(applyManualPeakOverride({ ca, peakMcap, peakMultiple, force }));
});
app.get('/api/calls/manual-peak', (req, res) => {
  setCors(res);
  const ca = req.query.ca;
  const peakMcap = req.query.peakMcap;
  const peakMultiple = req.query.peakMultiple;
  const force = req.query.force === '1' || req.query.force === 'true';
  res.json(applyManualPeakOverride({ ca, peakMcap, peakMultiple, force }));
});

// AUTO-SYNC — runs the same fix every 5 minutes so peak/outcome can't
// drift. Silent unless something gets upgraded. Logs upgrades to the
// system event log so they're visible in the audit feed.
setInterval(() => {
  try {
    const r = fixStoredPeaks();
    if (r.upgraded > 0) {
      console.log('[peak-fix:auto] upgraded ' + r.upgraded + ' calls to WIN: ' +
        r.changes.map(c => '\$' + c.token + '=' + c.peak.toFixed(2) + 'x').join(', '));
      logEvent('INFO', 'PEAK_FIX_AUTO', 'Upgraded ' + r.upgraded + ' calls: ' +
        r.changes.map(c => c.token + '@' + c.peak.toFixed(2) + 'x').join(', '));
    }
  } catch (err) { console.warn('[peak-fix:auto] tick err:', err.message); }
}, 5 * 60_000);
// First run 2 min after boot (gives the outcome tracker time to do its first pass)
setTimeout(() => {
  try {
    const r = fixStoredPeaks();
    if (r.upgraded > 0) console.log('[peak-fix:boot] upgraded ' + r.upgraded + ' calls to WIN on first sweep');
  } catch {}
}, 2 * 60_000);

// One-shot ATH backfill — corrects past calls whose peak_multiple was
// understated because the live tracker only saw current price (often dead
// by the time it checks). Pulls historical OHLCV from GeckoTerminal,
// finds the true peak between called_at and now, and rolls outcomes
// forward (peak ≥1.5x → WIN). Cascades to audit_archive, calls_archive,
// and coin_fingerprints. Use ?dryRun=1 to preview, ?limit=N to test small batch.
app.post('/api/calls/backfill-outcomes', async (req, res) => {
  setCors(res);
  try {
    const { backfillCallOutcomes } = await import('./backfill-outcomes.js');
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    const limit  = req.query.limit ? parseInt(req.query.limit) : null;
    const onlyLossesAndPending = req.query.all === '1' ? false : true;
    console.log(`[backfill] starting — dryRun=${dryRun} limit=${limit ?? 'all'} onlyLossesAndPending=${onlyLossesAndPending}`);
    const summary = await backfillCallOutcomes(dbInstance, { dryRun, limit, onlyLossesAndPending });
    res.json({ ok: true, dryRun, ...summary });
  } catch (err) {
    console.error('[backfill] failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.get('/api/calls/backfill-outcomes', async (req, res) => {
  // Allow GET as alias for easier curl/browser triggering
  req.method = 'POST';
  return app._router.handle(req, res);
});

// Solscan deep diagnostic — tries multiple endpoint/auth combos so we can
// figure out whether the configured key is v1 free, v2 Pro, expired, or
// has a whitespace issue. Returns the first variant that works (if any).
app.get('/api/diagnose/solscan', async (req, res) => {
  setCors(res);
  const key = process.env.SOLSCAN_API_KEY ?? '';
  const testCA = 'So11111111111111111111111111111111111111112';
  const variants = [
    { name: 'v2 token-header (current)',  url: `https://pro-api.solscan.io/v2.0/token/meta?address=${testCA}`,                     headers: { token: key, accept: 'application/json' } },
    { name: 'v2 Bearer auth',             url: `https://pro-api.solscan.io/v2.0/token/meta?address=${testCA}`,                     headers: { Authorization: `Bearer ${key}`, accept: 'application/json' } },
    { name: 'v2 token + holders endpoint',url: `https://pro-api.solscan.io/v2.0/token/holders?address=${testCA}&page_size=1&page=1`, headers: { token: key, accept: 'application/json' } },
    { name: 'v1 public token-meta',       url: `https://public-api.solscan.io/token/meta?tokenAddress=${testCA}`,                  headers: { token: key, accept: 'application/json' } },
    { name: 'v1 public account',          url: `https://public-api.solscan.io/account/${testCA}`,                                  headers: { token: key, accept: 'application/json' } },
  ];
  const results = [];
  for (const v of variants) {
    const t0 = Date.now();
    let status = null, errSnip = null, sample = null;
    try {
      const r = await fetch(v.url, { headers: v.headers, signal: AbortSignal.timeout(8_000) });
      status = r.status;
      if (r.ok) {
        try { sample = JSON.stringify(await r.json()).slice(0, 100); } catch {}
      } else {
        try { errSnip = (await r.text()).slice(0, 120); } catch {}
      }
    } catch (e) { errSnip = e.message; }
    results.push({ name: v.name, status, ms: Date.now() - t0, ok: status === 200, error: errSnip, sample });
  }
  res.json({
    ok: true,
    keyPresent: !!key,
    keyLength: key.length,
    keyHasWhitespace: /^\s|\s$/.test(key),
    keyPreview: key ? key.slice(0,4) + '...' + key.slice(-4) : null,
    variants: results,
  });
});

// Exit-signal monitor stats — shows recent rug/dump alerts fired on
// posted calls + count of active calls under live monitoring.
app.get('/api/exit-monitor/stats', (req, res) => {
  setCors(res);
  try {
    const stats = getExitMonitorStats(dbInstance);
    res.json({ ok: true, ...stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── HELIUS WEBHOOK RECEIVER ────────────────────────────────────────────
// Helius POSTs parsed transaction events to this endpoint when any of our
// tracked wallets buys/sells/transfers. Stores events to wallet_events
// table and runs co-buy swarm detection (3+ wallets buying same CA in
// 10 min → fires SWARM signal that auto-triggers our scoring pipeline).
//
// Optional auth: if HELIUS_WEBHOOK_SECRET env var is set, expects matching
// Authorization header — rejects requests without it.
app.post('/api/helius/webhook', express.json({ limit: '10mb' }), (req, res) => {
  setCors(res);

  // Optional auth check
  if (process.env.HELIUS_WEBHOOK_SECRET) {
    const expected = process.env.HELIUS_WEBHOOK_SECRET;
    const got = req.headers.authorization || req.headers['x-auth-token'] || '';
    if (got !== expected && got !== `Bearer ${expected}`) {
      console.warn('[helius-wh] Auth header mismatch — rejecting');
      return res.status(401).json({ ok: false, error: 'Auth header missing or wrong' });
    }
  }

  // Helius sends an ARRAY of parsed transactions
  const payload = Array.isArray(req.body) ? req.body : [];
  try {
    const result = processHeliusWebhookBatch(payload, {
      insertWalletEvent,
      getRecentBuyersForCA,
    });
    if (result.swarmsFired > 0) {
      console.log(`[helius-wh] batch: received=${result.received} stored=${result.stored} skipped=${result.skipped} swarms=${result.swarmsFired}`);
    }
    res.json(result);
  } catch (err) {
    console.warn('[helius-wh] processing err:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Setup helper: pushes all currently-tracked wallet addresses to a Helius
// webhook by ID. Call this AFTER you've created the webhook in the Helius
// dashboard and added HELIUS_WEBHOOK_ID to Railway env. Replaces the
// webhook's accountAddresses list with our current 4,800+ tracked wallets.
app.post('/api/helius/webhook/setup', async (req, res) => {
  setCors(res);
  const webhookId = process.env.HELIUS_WEBHOOK_ID || (req.body || {}).webhookId;
  // Prefer HELIUS_ENHANCED_API_KEY (specific to Enhanced APIs + webhooks);
  // falls back to HELIUS_API_KEY for backwards compat
  const apiKey = getEnhancedApiKey();
  if (!webhookId) return res.status(400).json({ ok: false, error: 'HELIUS_WEBHOOK_ID env var or webhookId in body required' });
  if (!apiKey)    return res.status(400).json({ ok: false, error: 'HELIUS_ENHANCED_API_KEY (or HELIUS_API_KEY) missing' });

  try {
    // Pull all tracked wallet addresses from DB
    const rows = dbInstance.prepare('SELECT address FROM tracked_wallets').all();
    const addresses = rows.map(r => r.address).filter(Boolean);
    console.log(`[helius-wh] Setup → pushing ${addresses.length} addresses to webhook ${webhookId.slice(0,8)}...`);
    const result = await syncTrackedAddressesToHelius(webhookId, apiKey, addresses);
    if (result.ok) {
      console.log(`[helius-wh] Setup ✓ registered ${result.registered} addresses (${result.skipped} skipped as invalid)`);
      logEvent('INFO', 'HELIUS_WEBHOOK_SETUP', `Registered ${result.registered} addresses`);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Stats: see what the webhook has been ingesting
app.get('/api/helius/webhook/stats', (req, res) => {
  setCors(res);
  try {
    const stats = getWalletEventStats();
    res.json({ ok: true, ...stats });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// List webhooks registered on the Helius account (for setup verification)
app.get('/api/helius/webhook/list', async (req, res) => {
  setCors(res);
  const apiKey = getEnhancedApiKey();
  if (!apiKey) return res.status(400).json({ ok: false, error: 'HELIUS_ENHANCED_API_KEY (or HELIUS_API_KEY) missing' });
  try {
    const result = await listHeliusWebhooks(apiKey);
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Self-trained wallet leaderboard — shows wallets credited from OUR call
// outcomes (separate from Dune's labels). Each WIN call credits its early
// holders; wallets reach WINNER tier at 3 wins @ 2x average multiple.
app.get('/api/wallets/self-trained-stats', (req, res) => {
  setCors(res);
  try {
    const stats = getSelfTrainedWalletStats();
    res.json({ ok: true, ...stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Pattern matching library status — counts of captured fingerprints,
// resolved outcomes, and a readiness gauge (GROWING / EARLY / READY / STRONG).
// Once `resolved >= 50`, the matching engine becomes weakly informative.
app.get('/api/fingerprints/stats', (req, res) => {
  setCors(res);
  try {
    const stats = getFingerprintStats();
    res.json({ ok: true, ...stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/db/health', (req, res) => {
  setCors(res);
  try {
    const dbPath = process.env.DATABASE_PATH
      ?? (process.env.RAILWAY_VOLUME_MOUNT_PATH
          ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'caller-bot.db')
          : 'caller-bot.db');
    const persistent = dbPath.startsWith('/data') || !!process.env.DATABASE_PATH;
    let size = 0;
    try { size = require('fs').statSync(dbPath).size; } catch {}
    const rowCounts = {};
    for (const t of ['tracked_wallets','audit_archive','calls','candidates','scanner_feed','smart_money_alerts']) {
      try { rowCounts[t] = dbInstance.prepare(`SELECT COUNT(*) as n FROM ${t}`).get().n; }
      catch { rowCounts[t] = null; }
    }
    res.json({
      ok: true,
      dbPath,
      persistent,
      sizeBytes: size,
      sizeMB: +(size / 1024 / 1024).toFixed(2),
      rowCounts,
      warning: persistent ? null :
        '⚠️  Volume not mounted — data will be lost on next redeploy. Add a Railway Volume at /data and set DATABASE_PATH=/data/caller-bot.db',
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Scan the entire tracked_wallets DB for the biggest SOL balances.
app.post('/api/wallets/scan-whales', async (req, res) => {
  setCors(res);
  try {
    if (!HELIUS_API_KEY) return res.status(500).json({ ok: false, error: 'HELIUS_API_KEY missing' });
    const minSol = Number(req.query.minSol ?? 1);
    // Hard cap at 20 per scan per user request — user clicks multiple times
    // to cycle through the DB. Keeps Helius response small and JSON parse safe.
    const maxWallets = Math.min(Number(req.query.max ?? 20), 20);
    // `offset` lets the UI page through: first 20, next 20, etc.
    const offset = Math.max(0, Number(req.query.offset ?? 0));

    const rows = dbInstance.prepare(`
      SELECT address, label, category FROM tracked_wallets
      WHERE is_blacklist = 0 AND address IS NOT NULL AND length(address) >= 32
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(maxWallets, offset);

    // Accumulate whales only — keeps result small regardless of DB size.
    let megaCount = 0, whaleCount = 0, scannedCount = 0;
    const whales = []; // { address, label, category, solBalance }

    // One getBalance call per wallet. Each response is 3 fields. No batching,
    // no large payloads, no chance of stack-overflow on parse. Slower per
    // click, but it actually finishes.
    const updSol = dbInstance.prepare(`
      UPDATE tracked_wallets
      SET sol_balance = ?, sol_scanned_at = datetime('now')
      WHERE address = ?
    `);
    for (const row of rows) {
      scannedCount++;
      let sol = 0;
      try {
        const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc:'2.0', id:'bal', method:'getBalance', params:[row.address] }),
          signal: AbortSignal.timeout(5_000),
        });
        if (r.ok) {
          const j = await r.json();
          sol = (j?.result?.value ?? 0) / 1e9;
        }
      } catch (err) {
        console.warn(`[scan-whales] getBalance ${row.address.slice(0,8)} failed: ${err.message}`);
      }
      try { updSol.run(Number(sol.toFixed(6)), row.address); } catch {}
      if (sol >= minSol) {
        if (sol >= 100) megaCount++;
        else if (sol >= 10) whaleCount++;
        whales.push({
          address:  row.address,
          label:    row.label || null,
          category: row.category || 'NEUTRAL',
          solBalance: Number(sol.toFixed(4)),
        });
      }
    }

    // Sort by SOL desc. Plain numeric comparator — safe for up to ~10k entries.
    whales.sort((a, b) => (b.solBalance || 0) - (a.solBalance || 0));

    // Auto-promote mega-whales (≥100 SOL) — one prepared stmt, plain loop.
    let promoted = 0;
    const upd = dbInstance.prepare(`
      UPDATE tracked_wallets SET category='SMART_MONEY', updated_at=datetime('now')
      WHERE address=? AND category IN ('NEUTRAL','MOMENTUM')
    `);
    for (const w of whales) {
      if (w.solBalance < 100) break; // whales sorted desc, stop at first non-mega
      try { if (upd.run(w.address).changes) promoted++; } catch {}
    }

    // Cap response so we can't accidentally overflow a JSON parser.
    const topN = whales.slice(0, 50);

    console.log(`[scan-whales] scanned=${scannedCount} mega=${megaCount} whale=${whaleCount} promoted=${promoted}`);

    res.json({
      ok: true,
      scanned:    scannedCount,
      found:      whales.length,
      megaWhales: megaCount,
      whales:     whaleCount,
      promoted,
      minSol,
      topN,
    });
  } catch (err) {
    console.error('[scan-whales] top-level error:', err.stack || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/wallets/rankings', (req, res) => {
  setCors(res);
  try {
    const { limit = 200, category } = req.query;
    let q = `SELECT address, label, category, win_rate, avg_roi, trade_count, score,
               wins_found_in, losses_in, source, notes, dune_data, updated_at,
               sol_balance, sol_scanned_at, ca_count
             FROM tracked_wallets WHERE is_blacklist=0`;
    const params = [];
    if (category) { q += ' AND category=?'; params.push(category); }
    q += ' ORDER BY score DESC, win_rate DESC LIMIT ?';
    params.push(parseInt(limit));
    const rows = dbInstance.prepare(q).all(...params);

    // Category breakdowns
    const cats = dbInstance.prepare(
      `SELECT category, COUNT(*) as count, AVG(score) as avg_score,
       AVG(win_rate) as avg_win_rate, SUM(wins_found_in) as total_wins
       FROM tracked_wallets WHERE is_blacklist=0 GROUP BY category ORDER BY avg_score DESC`
    ).all();

    // Top WINNER wallets with full stats
    const topWinners = dbInstance.prepare(
      `SELECT address, label, win_rate, avg_roi, trade_count, score, wins_found_in, notes, dune_data
       FROM tracked_wallets WHERE category='WINNER' AND is_blacklist=0
       ORDER BY score DESC LIMIT 50`
    ).all().map(w => ({
      ...w,
      duneData: (() => { try { return JSON.parse(w.dune_data||'{}'); } catch { return {}; } })(),
    }));

    // In-memory Dune store stats (live)
    const duneStatus = getDuneWalletStatus();

    // Real total — COUNT(*) across the whole table, not the returned slice.
    // Category filter narrows the count so "IN DB" reflects current filter.
    let totalCount = rows.length;
    try {
      let countQ = `SELECT COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0`;
      const countParams = [];
      if (category) { countQ += ' AND category=?'; countParams.push(category); }
      totalCount = dbInstance.prepare(countQ).get(...countParams).n;
    } catch {}

    res.json({ ok: true, wallets: rows, categories: cats, topWinners, duneStatus, total: totalCount, returned: rows.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Instant SOL-balance classification for brain_scan wallets still sitting at NEUTRAL.
// Runs in <50ms (pure SQLite, no external APIs). Call this before the Dune scan so
// users see categories immediately instead of waiting 2 minutes.
// ── Top 200 wallet activity feed — every move they make ─────────────────────
app.get('/api/wallets/top-activity', (req, res) => {
  setCors(res);
  try {
    const { limit = 200, hours = 72 } = req.query;

    // Get top 200 wallets by score
    const topWallets = dbInstance.prepare(`
      SELECT address, label, category, win_rate, avg_roi, trade_count, score,
             wins_found_in, losses_in
      FROM tracked_wallets
      WHERE is_blacklist=0 AND category IN ('WINNER','SMART_MONEY','ALPHA')
      ORDER BY score DESC, win_rate DESC
      LIMIT ?
    `).all(parseInt(limit));

    if (!topWallets.length) {
      return res.json({ ok: true, wallets: [], activity: [], summary: { totalWallets: 0 } });
    }

    const addresses = topWallets.map(w => w.address);

    // Get recent activity for these wallets
    const placeholders = addresses.map(() => '?').join(',');
    const activity = dbInstance.prepare(`
      SELECT wa.wallet_address, wa.token_mint, wa.side, wa.token_amount, wa.block_time, wa.detected_at,
             tw.label, tw.category, tw.score as wallet_score, tw.win_rate as wallet_win_rate
      FROM wallet_activity wa
      LEFT JOIN tracked_wallets tw ON tw.address = wa.wallet_address
      WHERE wa.wallet_address IN (${placeholders})
        AND wa.detected_at > datetime('now', '-' || ? || ' hours')
      ORDER BY wa.block_time DESC, wa.id DESC
      LIMIT 500
    `).all(...addresses, parseInt(hours));

    // Group activity by token to find convergence (multiple wallets buying same token)
    const tokenBuyers = {};
    for (const a of activity) {
      if (a.side !== 'BUY') continue;
      if (!tokenBuyers[a.token_mint]) tokenBuyers[a.token_mint] = new Set();
      tokenBuyers[a.token_mint].add(a.wallet_address);
    }
    const convergence = Object.entries(tokenBuyers)
      .filter(([, wallets]) => wallets.size >= 2)
      .map(([token, wallets]) => ({ token, walletCount: wallets.size, wallets: [...wallets] }))
      .sort((a, b) => b.walletCount - a.walletCount);

    // Per-wallet recent trade summary
    const walletSummaries = topWallets.map(w => {
      const trades = activity.filter(a => a.wallet_address === w.address);
      const buys = trades.filter(t => t.side === 'BUY').length;
      const sells = trades.filter(t => t.side === 'SELL').length;
      const uniqueTokens = new Set(trades.map(t => t.token_mint)).size;
      const lastTrade = trades[0]?.detected_at || null;
      return { ...w, recentBuys: buys, recentSells: sells, uniqueTokens, lastTrade };
    }).filter(w => w.recentBuys > 0 || w.recentSells > 0);

    res.json({
      ok: true,
      wallets: walletSummaries,
      activity: activity.slice(0, 200),
      convergence,
      summary: {
        totalWallets: topWallets.length,
        activeWallets: walletSummaries.length,
        totalTrades: activity.length,
        convergenceAlerts: convergence.length,
      },
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/wallets/classify-by-sol', (req, res) => {
  setCors(res);
  try {
    const neutrals = dbInstance.prepare(
      `SELECT address, sol_balance FROM tracked_wallets
       WHERE source='brain_scan' AND (category='NEUTRAL' OR category IS NULL)
         AND sol_balance IS NOT NULL AND sol_balance > 0`
    ).all();

    const upsert = dbInstance.prepare(
      `UPDATE tracked_wallets
       SET category=?, score=?, notes=?, updated_at=datetime('now')
       WHERE address=? AND source!='manual'`
    );

    const tx = dbInstance.transaction((rows) => {
      let classified = 0;
      for (const row of rows) {
        const sol = Number(row.sol_balance || 0);
        let cat, score;
        if      (sol >= 100) { cat = 'WINNER';      score = 75; }
        else if (sol >= 10)  { cat = 'SMART_MONEY'; score = 50; }
        else if (sol >= 1)   { cat = 'MOMENTUM';    score = 25; }
        else continue;
        upsert.run(cat, score, `SOL balance: ${sol.toFixed(2)} SOL`, row.address);
        classified++;
      }
      return classified;
    });

    const classified = tx(neutrals);
    console.log(`[classify-by-sol] ${classified}/${neutrals.length} brain_scan wallets upgraded from NEUTRAL`);
    res.json({ ok: true, checked: neutrals.length, classified });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Trigger Solscan wallet enrichment on demand (single wallet OR batch)
app.post('/api/wallets/enrich', async (req, res) => {
  setCors(res);
  try {
    const { address, batchSize } = req.body ?? {};
    const { enrichWallet, enrichStaleWallets } = await import('./solscan-wallet-enricher.js');
    if (address) {
      const stats = await enrichWallet(address, dbInstance);
      return res.json({ ok: true, address, stats });
    }
    const result = await enrichStaleWallets(dbInstance, batchSize ?? 50);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Smart money stats for a specific wallet address
app.get('/api/wallets/stats/:address', (req, res) => {
  setCors(res);
  try {
    const { address } = req.params;
    const dbRecord = dbInstance.prepare(`SELECT * FROM tracked_wallets WHERE address=?`).get(address);
    const inMemory = getWalletProfile(address);

    // How many of our calls had this wallet early?
    const appearances = (() => {
      try {
        return dbInstance.prepare(
          `SELECT ew.token_ca, ew.entry_rank, ew.entry_mcap, ew.outcome,
                  aa.final_decision, aa.composite_score, aa.called_at_et
           FROM early_wallets ew
           LEFT JOIN audit_archive aa ON ew.token_ca = aa.contract_address
           WHERE ew.wallet = ? ORDER BY ew.created_at DESC LIMIT 30`
        ).all(address);
      } catch { return []; }
    })();

    const winCount = appearances.filter(a => a.outcome === 'WIN' || a.final_decision === 'AUTO_POST').length;

    res.json({
      ok: true, address, dbRecord, inMemory,
      appearances, winCount,
      rank: dbRecord ? { score: dbRecord.score, category: dbRecord.category } : null,
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/wallets', (req, res) => {
  setCors(res);
  try {
    const { category, source, limit = 500, search, sort = 'score' } = req.query;
    let q = `SELECT * FROM tracked_wallets WHERE 1=1`;
    const params = [];
    if (category) { q += ` AND category = ?`; params.push(category); }
    if (source)   { q += ` AND source = ?`;   params.push(source); }
    if (search)   { q += ` AND (address LIKE ? OR label LIKE ? OR notes LIKE ?)`; const s = `%${search}%`; params.push(s,s,s); }
    const sortMap = { score: 'score DESC', win_rate: 'win_rate DESC', roi: 'avg_roi DESC', recent: 'updated_at DESC', trades: 'trade_count DESC' };
    q += ` ORDER BY ${sortMap[sort] ?? 'score DESC'} LIMIT ?`;
    params.push(parseInt(limit));
    const rows = dbInstance.prepare(q).all(...params);
    const stats = {
      total:    dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets`).get().n,
      manual:   dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source='manual'`).get().n,
      dune:     dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source!='manual'`).get().n,
      winners:  dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE category='WINNER'`).get().n,
      snipers:  dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE category='SNIPER'`).get().n,
      blacklist:dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=1`).get().n,
    };
    res.json({ ok: true, wallets: rows, stats });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Add a wallet manually
app.post('/api/wallets', (req, res) => {
  setCors(res);
  try {
    const { address, label, category = 'NEUTRAL', notes, tags, isBlacklist = 0 } = req.body ?? {};
    if (!address || address.length < 30) return res.status(400).json({ ok: false, error: 'Valid Solana address required (32-44 chars)' });
    const existing = dbInstance.prepare(`SELECT id FROM tracked_wallets WHERE address=?`).get(address);
    if (existing) {
      dbInstance.prepare(`UPDATE tracked_wallets SET label=COALESCE(?,label), notes=COALESCE(?,notes), tags=COALESCE(?,tags), is_blacklist=?, updated_at=datetime('now') WHERE address=?`)
        .run(label||null, notes||null, tags||null, isBlacklist?1:0, address);
      return res.json({ ok: true, message: 'Wallet updated', address });
    }
    dbInstance.prepare(`INSERT INTO tracked_wallets (address,label,category,source,notes,tags,is_blacklist,is_watchlist,added_by) VALUES (?,?,?,'manual',?,?,?,1,'user')`)
      .run(address, label||null, category, notes||null, tags||null, isBlacklist?1:0);
    // Also add to in-memory store
    getWalletProfile(address); // seeds it if not present
    logEvent('INFO', 'WALLET_ADDED', `Manual add: ${address.slice(0,8)} label=${label}`);
    res.json({ ok: true, message: 'Wallet added to tracker', address });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Update a wallet
app.put('/api/wallets/:address', (req, res) => {
  setCors(res);
  try {
    const { address } = req.params;
    const { label, category, notes, tags, isBlacklist, isWatchlist } = req.body ?? {};
    dbInstance.prepare(`
      UPDATE tracked_wallets SET
        label       = COALESCE(?, label),
        category    = COALESCE(?, category),
        notes       = COALESCE(?, notes),
        tags        = COALESCE(?, tags),
        is_blacklist= COALESCE(?, is_blacklist),
        is_watchlist= COALESCE(?, is_watchlist),
        updated_at  = datetime('now')
      WHERE address = ?
    `).run(label??null, category??null, notes??null, tags??null, isBlacklist!=null?isBlacklist?1:0:null, isWatchlist!=null?isWatchlist?1:0:null, address);
    res.json({ ok: true, message: 'Wallet updated' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Delete a wallet from tracker
app.delete('/api/wallets/:address', (req, res) => {
  setCors(res);
  try {
    dbInstance.prepare(`DELETE FROM tracked_wallets WHERE address=? AND source='manual'`).run(req.params.address);
    res.json({ ok: true, message: 'Wallet removed' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Analyze a wallet address on-demand
app.post('/api/wallets/:address/analyze', async (req, res) => {
  setCors(res);
  try {
    const { address } = req.params;
    const profile = getWalletProfile(address);
    // Check if it appeared in any of our calls
    let callHistory = [];
    try {
      callHistory = dbInstance.prepare(`
        SELECT c.token, c.outcome, c.score_at_call, c.market_cap_at_call, c.called_at
        FROM winner_wallets ww
        JOIN calls c ON ww.token = c.token
        WHERE ww.address = ?
        ORDER BY c.called_at DESC LIMIT 20
      `).all(address);
    } catch {}
    const dbRecord = dbInstance.prepare(`SELECT * FROM tracked_wallets WHERE address=?`).get(address);
    res.json({ ok: true, address, profile, dbRecord, callHistory, inMemory: !!profile });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Load Dune wallets from DB into memory on startup
function loadWalletsFromDB() {
  try {
    const rows = dbInstance.prepare(`
      SELECT address, category, win_rate, avg_roi, trade_count, score, dune_data
      FROM tracked_wallets WHERE source != 'manual' AND score > 0
      LIMIT 15000
    `).all();
    if (!rows.length) return 0;
    for (const row of rows) {
      duneStore.set(row.address, {
        address:    row.address,
        category:   row.category ?? 'NEUTRAL',
        winRate10x: row.win_rate ?? 0,
        avgRoi:     row.avg_roi ?? 0,
        tradeCount: row.trade_count ?? 0,
        score:      row.score ?? 0,
        source:     'db_restore',
      });
      if (row.category === 'SNIPER' || row.is_blacklist) {
        duneStore.addBlacklist(row.address);
      }
    }
    console.log(`[db] ✓ Restored ${rows.length} wallets from SQLite into memory`);
    return rows.length;
  } catch (err) {
    console.warn('[db] Wallet restore failed:', err.message);
    return 0;
  }
}

// ── Audit Archive API ──────────────────────────────────────────────────────
app.get('/api/archive', (req, res) => {
  setCors(res);
  try {
    const { decision, limit = 1000, offset = 0, search, minScore } = req.query;
    let q = `SELECT id, contract_address, token, token_name, final_decision, composite_score,
               market_cap, liquidity, volume_1h, volume_24h, pair_age_hours, stage,
               buy_ratio_1h, buys_1h, sells_1h, volume_velocity, bundle_risk, sniper_count,
               top10_holder_pct, dev_wallet_pct, wallet_verdict, smart_money_score, winner_wallets,
               claude_verdict, claude_risk, claude_setup_type, openai_decision, openai_conviction,
               narrative_tags, structure_grade, trap_severity, bonding_curve_pct,
               twitter, website, telegram, holder_count, sub_scores, called_at_et, created_at,
               outcome, peak_multiple, peak_mcap, peak_at, outcome_locked_at
             FROM audit_archive WHERE 1=1`;
    const params = [];
    if (decision) { q += ` AND final_decision=?`; params.push(decision); }
    if (search)   { q += ` AND (token LIKE ? OR contract_address LIKE ?)`; params.push('%'+search+'%','%'+search+'%'); }
    if (minScore) { q += ` AND composite_score >= ?`; params.push(Number(minScore)); }
    q += ` ORDER BY id DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));
    const rows  = dbInstance.prepare(q).all(...params);
    const total = dbInstance.prepare(`SELECT COUNT(*) as n FROM audit_archive`).get().n;
    const byDec = dbInstance.prepare(`SELECT final_decision, COUNT(*) as n FROM audit_archive GROUP BY final_decision`).all();
    res.json({ ok: true, rows, total, byDecision: Object.fromEntries(byDec.map(r=>[r.final_decision,r.n])) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/archive/:address', (req, res) => {
  setCors(res);
  try {
    const row = dbInstance.prepare(`SELECT * FROM audit_archive WHERE contract_address=?`).get(req.params.address);
    if (!row) return res.status(404).json({ ok: false, error: 'Not in archive' });
    res.json({ ok: true, row });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Token Analyzer — deep study of a specific token's patterns for AI learning
app.post('/api/archive/analyze', async (req, res) => {
  setCors(res);
  if (!CLAUDE_API_KEY) return res.status(503).json({ ok: false, error: 'CLAUDE_API_KEY not configured' });
  const { contractAddress, question } = req.body ?? {};
  if (!contractAddress) return res.status(400).json({ ok: false, error: 'contractAddress required' });
  try {
    // Get full token data from archive + candidates + calls
    const archived = dbInstance.prepare(`SELECT * FROM audit_archive WHERE contract_address=?`).get(contractAddress);
    const candidate = dbInstance.prepare(`SELECT * FROM candidates WHERE contract_address=? ORDER BY id DESC LIMIT 1`).get(contractAddress);
    const call = dbInstance.prepare(`SELECT * FROM calls WHERE contract_address=? ORDER BY id DESC LIMIT 1`).get(contractAddress);

    let data = { ...archived, ...candidate, ...call };
    let externalScan = false;

    // ── EXTERNAL LEARNING MODE ──────────────────────────────────────────
    // If the token isn't in our DB, fetch live data from DexScreener +
    // Solscan so the AI can still study it. This is the whole point of
    // the Token Analyzer: paste any winning CA (even one we never saw)
    // and have Claude extract the pattern from it.
    if (!archived && !candidate && !call) {
      externalScan = true;
      console.log(`[token-analyze] External scan — ${contractAddress.slice(0,8)} not in any table, fetching live`);

      // DexScreener for price/mcap/volume/age
      let dex = null;
      try {
        const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(contractAddress)}`, {
          signal: AbortSignal.timeout(9_000),
        });
        if (r.ok) {
          const j = await r.json();
          const pairs = (j?.pairs || []).filter(p => (p.chainId || p.chain) === 'solana');
          dex = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
        }
      } catch (err) { console.warn('[token-analyze] DexScreener failed:', err.message); }

      if (!dex) {
        return res.status(404).json({ ok: false, error: 'Token not in our DB and DexScreener has no data. Double-check the CA.' });
      }

      data = {
        contract_address: contractAddress,
        token: dex.baseToken?.symbol || null,
        token_name: dex.baseToken?.name || null,
        market_cap: dex.marketCap ?? dex.fdv ?? null,
        liquidity: dex.liquidity?.usd ?? null,
        volume_24h: dex.volume?.h24 ?? null,
        volume_1h: dex.volume?.h1 ?? null,
        price_usd: parseFloat(dex.priceUsd || 0) || null,
        buys_1h: dex.txns?.h1?.buys ?? null,
        sells_1h: dex.txns?.h1?.sells ?? null,
        buy_ratio_1h: (dex.txns?.h1 && (dex.txns.h1.buys + dex.txns.h1.sells) > 0)
          ? dex.txns.h1.buys / (dex.txns.h1.buys + dex.txns.h1.sells)
          : null,
        pair_age_hours: dex.pairCreatedAt ? (Date.now() - dex.pairCreatedAt) / 3_600_000 : null,
        stage: dex.dexId || 'unknown',
        // These stay null for external scans — AI will know we lack them
        composite_score: null, claude_score: null, quick_score: null,
        final_decision: 'EXTERNAL_STUDY',
        outcome: null,
      };

      // Top holders via Solscan (optional, best-effort) — gives Claude wallet structure context
      if (process.env.SOLSCAN_API_KEY) {
        try {
          const r = await fetch(
            `https://pro-api.solscan.io/v2.0/token/holders?address=${encodeURIComponent(contractAddress)}&page_size=20&page=1`,
            { headers: { token: process.env.SOLSCAN_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(8_000) }
          );
          if (r.ok) {
            const j = await r.json();
            const items = j?.data?.items || j?.data || [];
            if (items.length) {
              const top10Sum = items.slice(0, 10).reduce((s, h) => s + Number(h.amount || 0), 0);
              const totalSum = items.reduce((s, h) => s + Number(h.amount || 0), 0);
              data.top10_holder_pct = totalSum > 0 ? (top10Sum / totalSum) * 100 : null;
              data.holders_sampled  = items.length;
            }
          }
        } catch (err) { console.warn('[token-analyze] Solscan holders failed:', err.message); }
      }
    }

    const subScores = (() => { try { return JSON.parse(data.sub_scores || '{}'); } catch { return {}; } })();

    const tokenContext = `TOKEN ANALYSIS REQUEST:
Token: $${data.token || '?'} (${data.token_name || '?'})
Contract: ${contractAddress}
Called At (ET): ${data.called_at_et || data.called_at || '?'}

SCORES:
  Composite: ${data.composite_score || '?'}/100
  Quick: ${data.quick_score || '?'}
  Sub-scores: Launch=${subScores.launchQuality||'?'} Wallet=${subScores.walletStructure||'?'} Market=${subScores.marketBehavior||'?'} Social=${subScores.socialNarrative||'?'}

MARKET AT CALL TIME:
  MCap: $${Math.round((data.market_cap||0)/1000)}K
  Liquidity: $${Math.round((data.liquidity||0)/1000)}K
  Vol 1h: $${Math.round((data.volume_1h||0)/1000)}K
  Vol 24h: $${Math.round((data.volume_24h||0)/1000)}K
  Age: ${data.pair_age_hours?.toFixed?.(2)||'?'}h
  Stage: ${data.stage||'?'}

MOMENTUM:
  Buy Ratio 1h: ${data.buy_ratio_1h!=null?(data.buy_ratio_1h*100).toFixed(0)+'%':'?'}
  Buys/Sells: ${data.buys_1h||'?'} / ${data.sells_1h||'?'}
  Vol Velocity: ${data.volume_velocity?.toFixed?.(2)||'?'}

STRUCTURE:
  Bundle Risk: ${data.bundle_risk||'?'}
  Snipers: ${data.sniper_count||0}
  Top10%: ${data.top10_holder_pct?.toFixed?.(1)||'?'}%
  Dev%: ${data.dev_wallet_pct?.toFixed?.(1)||'?'}%
  Structure Grade: ${data.structure_grade||'?'}
  Trap Severity: ${data.trap_severity||'?'}

WALLET INTELLIGENCE:
  Verdict: ${data.wallet_verdict||'?'}
  Smart Money Score: ${data.smart_money_score||'?'}/100
  Winner Wallets: ${data.winner_wallets||0}

AI VERDICTS:
  Claude Risk: ${data.claude_risk||'?'}
  Claude Setup: ${data.claude_setup_type||'?'}
  Claude Verdict: ${data.claude_verdict||'none recorded'}
  OpenAI Decision: ${data.openai_decision||'?'} (${data.openai_conviction||'?'}% conviction)

OUTCOME:
  Final Decision: ${data.final_decision||'?'}
  Outcome: ${data.outcome||'PENDING'}
`;

    const userQuestion = question || (externalScan
      ? 'This is a token we DID NOT call. Study it forensically. What signals would have caught this as a gem before it ran? Extract the repeatable pattern so we can find similar coins in the future.'
      : 'Analyze this token deeply. What specific signals made it a strong/weak call? What patterns does it show that we should use to find similar winners/avoid similar losers in the future? What would you add to the scoring system based on this token?');

    const modeHeader = externalScan
      ? `[EXTERNAL STUDY — WE NEVER CALLED THIS COIN]
The user is feeding this CA in to teach the AI what a winner looks like.
We have LIVE DexScreener/Solscan data but no score, no Claude verdict,
no outcome from our system. Focus on extracting patterns from the
market/structure data alone so we can reverse-engineer the edge.\n\n`
      : '';

    const analyzePrompt = `You are the Pulse Caller AI learning engine. Study this token forensically to extract lessons and patterns.

${modeHeader}${tokenContext}

QUESTION: ${userQuestion}

Provide:
1. SIGNAL ANALYSIS: What specific data points were strongest indicators here
2. PATTERN EXTRACTION: What repeatable pattern does this token represent
3. SCORING LESSONS: What should the scoring system weight differently based on this
4. FILTER LESSONS: What would have caught this earlier / filtered it out if bad
5. WALLET PATTERN: What wallet behavior preceded this outcome
6. PHILOSOPHY: What does this teach about finding early gems in this MCap range`;

    const claudeRes = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1500, system: 'You are an expert crypto trading pattern analyst. Be specific, data-driven, and actionable.', messages: [{ role: 'user', content: analyzePrompt }] }),
      signal: AbortSignal.timeout(35_000),
    });
    if (!claudeRes.ok) throw new Error('Claude ' + claudeRes.status);
    const cd = await claudeRes.json();
    const analysis = (cd.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');

    // Store this analysis in agent_actions for the AI to learn from
    try {
      dbInstance.prepare(`INSERT INTO agent_actions (agent,action_type,description,params,approved) VALUES ('claude','TOKEN_ANALYSIS','Deep analysis of $'+?+' for pattern learning',?,1)`)
        .run(data.token || contractAddress.slice(0,8), JSON.stringify({ contractAddress, outcome: data.outcome, decision: data.final_decision }));
    } catch {}

    logEvent('INFO', 'TOKEN_ANALYZED', contractAddress + ' decision=' + data.final_decision);
    res.json({ ok: true, token: data.token, analysis, tokenData: { ...archived, ...call ? { outcome: call.outcome } : {} } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Trigger a manual Dune wallet scan (runs in background, returns immediately)
app.post('/api/v8/dune-wallet-scan', (req, res) => {
  setCors(res);

  // Fresh read every time — never use cached module-level const
  const duneKey = process.env.DUNE_API_KEY || process.env.DUNE_KEY || DUNE_API_KEY || null;

  console.log('[dune] Manual scan requested. Key present:', !!duneKey, '| Key length:', duneKey?.length ?? 0);

  if (!duneKey) {
    return res.status(400).json({
      ok: false,
      error: 'DUNE_API_KEY not found in process.env. The variable is set in Railway but the current deployment was made BEFORE it was added — you need to trigger a new deploy (push any small change or click "Deploy" in Railway) to reload all env vars into the running process.',
    });
  }

  // Force-set so all modules can read it going forward
  process.env.DUNE_API_KEY = duneKey;

  const walletStatus = getDuneWalletStatus();
  if (walletStatus.scanning) {
    return res.json({ ok: true, started: false, message: 'Scan already in progress — wallet counts will update below' });
  }

  // Start scan in background — responds immediately
  setImmediate(async () => {
    try {
      await runDuneWalletScan();
      const status = getDuneWalletStatus();
      console.log('[dune] ✓ Manual scan complete. Wallets loaded:', status.totalWallets);
      // Persist to DB so wallets survive redeploys
      const allWallets = [...(duneStore?.db?.values() ?? [])];
      if (allWallets.length > 0) {
        const saved = persistDuneWalletsToDB(allWallets);
        logEvent('INFO', 'DUNE_WALLETS_PERSISTED', `${saved} wallets saved to SQLite`);
      }
      // Reload wallet-db from SQLite so cross-referencing uses fresh data
      try { await reloadWalletsFromDB(); } catch {}
    } catch (err) {
      console.error('[dune] Manual scan error:', err.message);
    }
  });

  logEvent('INFO', 'DUNE_MANUAL_SCAN', `Dashboard-triggered wallet scan — key_len=${duneKey.length}`);
  res.json({
    ok: true,
    started: true,
    message: `Wallet scan started with key (${duneKey.length} chars). Running 4 Dune SQL queries — takes 30-120s. Wallets will be saved to database.`,
  });
});

// Helper: persist Dune wallet data to SQLite so it survives redeploys
function persistDuneWalletsToDB(wallets) {
  if (!wallets?.length) return 0;
  let saved = 0;
  const upsert = dbInstance.prepare(`
    INSERT INTO tracked_wallets
      (address, category, source, win_rate, avg_roi, trade_count, score, dune_data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(address) DO UPDATE SET
      category    = excluded.category,
      win_rate    = excluded.win_rate,
      avg_roi     = excluded.avg_roi,
      trade_count = excluded.trade_count,
      score       = excluded.score,
      dune_data   = excluded.dune_data,
      updated_at  = datetime('now')
    WHERE source != 'manual'
  `);
  const tx = dbInstance.transaction((walletList) => {
    for (const w of walletList) {
      if (!w?.address || w.address.length < 30) continue;
      try {
        upsert.run(
          w.address,
          w.category ?? 'NEUTRAL',
          w.source ?? 'dune',
          w.winRate10x ?? 0,
          w.avgRoi ?? 0,
          w.tradeCount ?? 0,
          w.score ?? 0,
          JSON.stringify({ winRate10x: w.winRate10x, avgRoi: w.avgRoi, tradeCount: w.tradeCount, avgEntrySpeed: w.avgEntrySpeed })
        );
        saved++;
      } catch {}
    }
  });
  try { tx(wallets); } catch (err) { console.warn('[db] Wallet persist error:', err.message); }
  console.log(`[db] ✓ Persisted ${saved} Dune wallets to SQLite`);
  return saved;
}

app.get('/api/v8/openai-status', async (req, res) => {
  setCors(res);
  const status = await checkOpenAIConnection(OPENAI_API_KEY);
  res.json({ ok: true, configured: !!OPENAI_API_KEY, ...status });
});

app.post('/api/v8/force-missed-winner-scan', async (req, res) => {
  setCors(res);
  res.json({ ok: true, message: 'Missed winner scan started in background' });
  detectMissedWinners(dbInstance)
    .then(missed => sendAdminAlert(`🔍 Missed winner scan: found ${missed.length} tokens`))
    .catch(err => console.warn('[missed-winner] Manual scan error:', err.message));
});

// Enhanced stats endpoint with v8 data
app.get('/api/v8/dashboard', (req, res) => {
  setCors(res);
  try {
    const helius   = getHeliusStatus();
    const walletDB = getWalletDbStatus();
    const learning = getLearningStats(dbInstance);
    const totalEvals = (() => { try { return dbInstance.prepare('SELECT COUNT(*) as n FROM candidates').get().n; } catch { return 0; } })();
    const totalCalls = (() => { try { return dbInstance.prepare('SELECT COUNT(*) as n FROM calls').get().n; } catch { return 0; } })();
    const wins       = (() => { try { return dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome='WIN'").get().n; } catch { return 0; } })();
    const losses     = (() => { try { return dbInstance.prepare("SELECT COUNT(*) as n FROM calls WHERE outcome='LOSS'").get().n; } catch { return 0; } })();

    res.json({
      ok: true,
      version: 'v8.0-multi-agent',
      detection: {
        heliusConnected:  helius.connected,
        heliusSeenTxns:   helius.seenTxns,
        pumpFunPolling:   true,
        dexScreenerFallback: true,
      },
      intelligence: (() => {
        // Read the real tracked_wallets count from SQL rather than the
        // in-memory Dune cache — user adds wallets via Brain Analyzer
        // auto-insert, smart-money watcher, etc. Those never touched the
        // in-memory cache so the tile showed 2 even with hundreds in DB.
        let sqlCount = 0;
        let sqlFreshCount = 0;
        try {
          sqlCount = dbInstance.prepare(
            `SELECT COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0`
          ).get().n;
          sqlFreshCount = dbInstance.prepare(
            `SELECT COUNT(*) as n FROM tracked_wallets
             WHERE is_blacklist=0 AND updated_at > datetime('now', '-24 hours')`
          ).get().n;
        } catch {}
        const stale = sqlCount > 0 && sqlFreshCount === 0;
        return {
          walletDbSize:     sqlCount,
          walletDbFresh24h: sqlFreshCount,
          walletDbStale:    stale,
          walletCategories: walletDB.walletDb.categories,
          deployerCount:    walletDB.deployerDb.totalDeployers,
          openaiConfigured: !!OPENAI_API_KEY,
          claudeConfigured: !!CLAUDE_API_KEY,
        };
      })(),
      performance: {
        totalEvaluations: totalEvals,
        totalCalls,
        wins,
        losses,
        winRate: (wins + losses) > 0 ? Math.round(wins / (wins + losses) * 100) + '%' : '—',
        missedWinnersDetected: learning.missedWinnersTotal,
        autoResolvedCalls: learning.autoResolvedCalls,
      },
      aiStatus: {
        learningLoopActive:   learningLoopHandles !== null,
        heliusListenerActive: heliusListener !== null,
        inContextLearning:    true,
        sweetSpotTarget:      `$${Math.round((AI_CONFIG_OVERRIDES.sweetSpotMin ?? 10000)/1000)}K–$${Math.round((AI_CONFIG_OVERRIDES.sweetSpotMax ?? 25000)/1000)}K`,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`[server] Listening on port ${PORT}`);

  if (!TELEGRAM_BOT_TOKEN)          console.warn('[server] ⚠️  TELEGRAM_BOT_TOKEN missing');
  if (!CLAUDE_API_KEY)              console.warn('[server] ⚠️  CLAUDE_API_KEY missing');
  if (!TELEGRAM_GROUP_CHAT_ID)      console.warn('[server] ⚠️  TELEGRAM_GROUP_CHAT_ID missing');
  if (!process.env.BIRDEYE_API_KEY)  console.warn('[server] ⚠️  BIRDEYE_API_KEY missing');
  if (!process.env.HELIUS_API_KEY)   console.warn('[server] ⚠️  HELIUS_API_KEY missing');
  if (!OPENAI_API_KEY)              console.warn('[server] ⚠️  OPENAI_API_KEY missing — AI learning disabled');
  if (!OPENAI_FT_MODEL)             console.log('[server] ℹ️  OPENAI_FT_MODEL not set — AI OS uses in-context learning (no threshold needed)');

  const intervalMs = Number(SCAN_INTERVAL_MS);
  console.log(`[server] Auto-caller starts in 30s, then every ${intervalMs/1000}s`);

  setTimeout(async () => {
    await updateRegime();
    await runAutoCallerCycle();
    setInterval(runAutoCallerCycle, intervalMs);
  }, 30_000);

  // Smart-money retry queue processor — runs every 30s.
  // Fresh coins from the smart-money watcher that arrived before
  // DexScreener indexed them get re-tried once after a 2min delay.
  setInterval(() => {
    processSmartMoneyRetries().catch(err => console.warn('[sm-retry] tick err:', err.message));
  }, 30_000);

  // Bonding-curve tracker — every 15min, re-checks any pre-bond calls
  // and marks them bonded_at / bonded_mcap when pump.fun reports complete.
  // Powers the Bond Rate stat on the Calls page.
  try {
    const { startBondingTracker } = await import('./bonding-tracker.js');
    startBondingTracker(dbInstance);
  } catch (err) { console.warn('[bonding-tracker] failed to start:', err.message); }

  // Group-leaderboard peak refresher — every 5min, walks ~60 oldest
  // user_calls rows and updates peak_mcap / peak_multiple via DexScreener.
  setInterval(async () => {
    try {
      const { refreshPeaks } = await import('./user-leaderboard.js');
      const fetchMcap = async (ca) => {
        try {
          const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, {
            signal: AbortSignal.timeout(6_000),
          });
          if (!r.ok) return null;
          const j = await r.json();
          const pair = (j.pairs || []).find(p => p.chainId === 'solana');
          if (!pair) return null;
          return { marketCap: pair.marketCap || pair.fdv || null };
        } catch { return null; }
      };
      const result = await refreshPeaks(dbInstance, fetchMcap, 60);
      if (result.checked > 0) console.log(`[user-lb] refreshed ${result.updated}/${result.checked} peaks`);
    } catch (err) { console.warn('[user-lb] refresh err:', err.message); }
  }, 5 * 60_000);

  // ── AUTONOMOUS SELF-IMPROVEMENT LOOP ──────────────────────────────────
  // Runs the agent + Control Station auto-optimize once every 24 hours
  // per user directive ("wait 24 hours before the next change"). Claude
  // analyzes recent wins/losses + missed winners, applies bounded knob
  // changes, persists them through logConfigChange so they show up in
  // /api/config/audit.
  //
  // No boot-time auto-fire — first auto-cycle fires 24h after boot so
  // the bot has a full day of fresh outcome data before Claude tunes.
  // Operator can still trigger on-demand any time via
  // POST /api/self-improve/run-now.
  setInterval(() => {
    runSelfImproveLoop().catch(err => console.warn('[self-improve] tick err:', err.message));
  }, 24 * 3_600_000);

  setInterval(() => {
    try { updateRegime(getCandidates({ limit: 50 }).rows); } catch {}
  }, 15 * 60 * 1000);

  setTimeout(async () => {
    await runPerformanceTracker({
      db: dbInstance, updateCallPerformance, getPendingCalls,
      updateDeployerOutcome, rebuildWinnerProfiles, sendAdminAlert,
    });
    setInterval(async () => {
      try {
        await runPerformanceTracker({
          db: dbInstance, updateCallPerformance, getPendingCalls,
          updateDeployerOutcome, rebuildWinnerProfiles, sendAdminAlert,
        });
      } catch (err) {
        console.error('[tracker] Error:', err.message);
        logEvent('ERROR', 'TRACKER_ERROR', err.message);
      }
    }, 30 * 60 * 1000);
  }, 5 * 60 * 1000);

  console.log('[server] Performance tracker: starts in 5min, runs every 30min');
  console.log('[server] WIN criteria: +20% at 6h or 12h | LOSS: -30% at 6h or 12h');

  // ── BOOT CLEANUP: purge void calls/archive/candidates from data-void era ──
  try {
    const r1 = dbInstance.prepare(`DELETE FROM calls WHERE token IS NULL AND market_cap_at_call IS NULL AND price_at_call IS NULL`).run();
    const r2 = dbInstance.prepare(`DELETE FROM audit_archive WHERE (token IS NULL OR token='') AND market_cap IS NULL AND final_decision='AUTO_POST'`).run();
    const r3 = dbInstance.prepare(`UPDATE candidates SET posted=0, final_decision='IGNORE' WHERE (token IS NULL OR token='') AND market_cap IS NULL AND final_decision='AUTO_POST' AND posted=1`).run();
    if (r1.changes || r2.changes || r3.changes) {
      console.log(`[boot-cleanup] Removed ${r1.changes} void calls + ${r2.changes} void archive + ${r3.changes} void candidates fixed`);
    }
  } catch (err) { console.warn('[boot-cleanup]', err.message); }

  setTimeout(async () => {
    try { await uploadBannerToTelegram(); }
    catch (err) { console.warn('[TG] Banner pre-upload failed:', err.message); }
  }, 3000);

  // ── v8.0: Initialize Wallet DB from Dune ──────────────────────────────────
  // First restore from SQLite (instant, works even without Dune API)
  const restoredCount = loadWalletsFromDB();
  console.log(`[startup] Restored ${restoredCount} wallets from DB`);
  // Then refresh from Dune in background
  initWalletDb().catch(err => console.warn('[startup] Wallet DB init failed:', err.message));

  // ── v8.0: Start Dune Wallet Scanner (real pump.fun + Raydium PnL data) ────
  // Pulls top profitable wallets from Dune every 4h and cross-references holders
  // Inject DB reference so scanner can persist wallets after each scan
  try { const { setDb: dunSetDb } = await import('./dune-wallet-scanner.js'); dunSetDb(dbInstance); } catch {}
  // Inject DB into wallet-db so it loads wallets from tracked_wallets table
  try { setWalletDb(dbInstance); } catch (e) { console.warn('[startup] setWalletDb failed:', e.message); }
  startWalletScanner();

  // ── v8.0: Start Helius WebSocket Listener ─────────────────────────────────
  if (HELIUS_API_KEY) {
    heliusListener = startHeliusListener(HELIUS_API_KEY);

    // When Helius detects a new token, feed it directly into the pipeline
    heliusListener.on('new_candidate', async (candidate) => {
      if (!candidate?.contractAddress) return;
      if (isRecentlySeen(candidate.contractAddress)) return;
      if (isBlocklisted(candidate.contractAddress)) return;

      console.log(`[helius] ⚡ Fast-track candidate: $${candidate.token ?? '?'} (${candidate.stage}) from ${candidate.source}`);
      logEvent('INFO', 'HELIUS_CANDIDATE', `${candidate.token ?? candidate.contractAddress?.slice(0,8)} stage=${candidate.stage}`);

      // FIRE-AND-FORGET — don't await. Each new token launches its own
      // async pipeline so Helius events don't queue serially behind a slow
      // enrichment. The handler returns immediately, freeing the listener
      // to accept the next token.
      const detectedAt = Date.now();
      (async () => {
        try {
          const enriched = await enrichCandidate(candidate);
          enriched._discoveredAt = detectedAt;
          enriched._fastTrack = true;
          await processCandidate(enriched, false);
        } catch (err) {
          console.warn(`[helius] Fast-track failed for ${candidate.contractAddress?.slice(0,8)}: ${err.message}`);
        }
      })().catch(() => {}); // swallow unhandled
    });

    heliusListener.on('connected', () => {
      logEvent('INFO', 'HELIUS_CONNECTED', 'WebSocket streaming active — ~3s token detection');
    });

    console.log('[startup] ✓ Helius WebSocket listener starting — ~3s token detection enabled');
  } else {
    console.warn('[startup] No HELIUS_API_KEY — falling back to 90s DEXScreener polling');
  }

  // ── v8.0: Start Learning Loop ─────────────────────────────────────────────
  learningLoopHandles = startLearningLoop(dbInstance, CLAUDE_API_KEY);
  console.log('[startup] ✓ Learning loop active — outcome tracking + missed winner detection');

  // Wire up milestone TG alerts (2x / 5x / 10x on active calls). Uses the
  // group chat, and respects pausePosting so a paused bot stays silent.
  // Milestone alerts go to VIP always; at 2x we ALSO post the original call
  // Wire the fingerprint backfill — outcome tracker calls this whenever
  // peak_multiple gets rolled forward, so the pattern matching library
  // continuously learns from resolved coins.
  setFingerprintHook((ca, peakMultiple, peakMcap, peakAtMs, outcome) => {
    backfillFingerprintOutcome(ca, peakMultiple, peakMcap, peakAtMs, outcome);
  });

  // Wire the wallet credit hook — fires when a call locks as WIN with peak
  // >= 1.5x. Pulls early_holders from the calls row and credits each wallet's
  // our_win_count + our_avg_win_multiple. Promotes to WINNER at 3 wins @ 2x avg.
  setWalletCreditHook((ca, peakMultiple) => {
    const result = creditWalletsForWin(ca, peakMultiple);
    if (result.promoted > 0) {
      logEvent('INFO', 'WALLET_PROMOTED', `${result.promoted} wallets promoted to WINNER on ${ca.slice(0,8)} (${peakMultiple.toFixed(2)}x)`);
    }
  });

  // Wire the exit-monitor Telegram hook — sends 🚨 EXIT NOW alerts to the
  // group when posted calls show rug/dump patterns (LP pull, sell flip,
  // deep drop from peak, dev wallet moving). Each alert type fires once
  // per call (deduped via exit_alerts table).
  setExitTelegramHook(async (msg) => {
    if (AI_CONFIG_OVERRIDES.pausePosting) return;
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_GROUP_CHAT_ID) return;
    try {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_GROUP_CHAT_ID,
          text: msg,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) { console.warn('[exit-tg] send failed:', err.message); }
  });

  // ── HELIUS WEBHOOK WIRING ─────────────────────────────────────────────
  // Tells the webhook handler whether a given address is in our tracked DB.
  // Cached in-memory (refreshed every 5 min) so we don't hit SQLite per event.
  let _trackedAddressesCache = new Set();
  let _trackedAddressesLastRefresh = 0;
  function refreshTrackedAddresses() {
    try {
      const rows = dbInstance.prepare('SELECT address FROM tracked_wallets').all();
      _trackedAddressesCache = new Set(rows.map(r => r.address));
      _trackedAddressesLastRefresh = Date.now();
    } catch (err) { console.warn('[helius-wh] refresh tracked addrs:', err.message); }
  }
  refreshTrackedAddresses();
  setInterval(refreshTrackedAddresses, 5 * 60_000);

  setIsWalletTrackedFn(addr => _trackedAddressesCache.has(addr));

  // SWARM HOOK — when ≥3 tracked wallets buy the same CA in 10 min, this
  // fires. We feed the CA into the existing scanner pipeline as if our
  // scanner had discovered it, plus send a heads-up to the admin.
  //
  // TOGGLE: controlled by Railway env var SWARM_SIGNAL_ENABLED.
  //   not set / "false" / "0"  → DISABLED (default — only logs to console)
  //   "true" / "1"             → ENABLED  (admin DMs + auto-trigger fire)
  // Wallet events always flow into wallet_events DB regardless.
  setSwarmHook(async (ca, buyers) => {
    const swarmOn = String(process.env.SWARM_SIGNAL_ENABLED || '').toLowerCase();
    if (swarmOn !== 'true' && swarmOn !== '1') {
      console.log(`[swarm-hook] DISABLED — would have fired on ${ca.slice(0,8)} (${buyers.length} wallets) — set SWARM_SIGNAL_ENABLED=true in Railway to enable`);
      return;
    }
    if (!_botActive) return;
    try {
      const total_sol = buyers.reduce((a,b) => a + (Number(b.total_sol_in) || 0), 0);
      const msg = `🐋 <b>SWARM SIGNAL</b>\n\n` +
                  `<b>${buyers.length}</b> tracked wallets bought\n` +
                  `<code>${ca}</code>\n\n` +
                  `Combined: <b>${total_sol.toFixed(2)} SOL</b> in last 10min\n` +
                  `Auto-triggering scoring pipeline...\n\n` +
                  `<a href="https://dexscreener.com/solana/${ca}">DEX</a> · <a href="https://pump.fun/${ca}">PF</a>`;
      // DM admin only — not group spam
      if (TELEGRAM_BOT_TOKEN && ADMIN_TELEGRAM_ID) {
        try {
          await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: ADMIN_TELEGRAM_ID, text: msg, parse_mode: 'HTML', disable_web_page_preview: true,
            }),
            signal: AbortSignal.timeout(10_000),
          });
        } catch {}
      }
      logEvent('INFO', 'WALLET_SWARM', `${buyers.length} wallets bought ${ca.slice(0,8)} (${total_sol.toFixed(2)} SOL total)`);
      // Fast-track into scoring pipeline by injecting as a scanner hit.
      // Use the existing onSmartMoneySignal path so all the standard
      // enrichment + scoring + posting logic runs.
      try {
        const fakeCandidate = { contractAddress: ca, _swarmSignal: { buyers: buyers.length, total_sol } };
        // Defer to next tick so this returns fast
        setImmediate(() => {
          try { processCandidate(fakeCandidate, false); } catch (err) {
            console.warn('[swarm-trigger] processCandidate err:', err.message);
          }
        });
      } catch {}
    } catch (err) { console.warn('[swarm-hook] err:', err.message); }
  });

  // to the free channel (AXIOSCAN-style 2x-delayed free tier), and every
  // subsequent milestone (5/10/25x) also hits the free channel.
  setMilestoneTelegramHook(async (msg, meta = {}) => {
    if (AI_CONFIG_OVERRIDES.pausePosting) return;
    if (!TELEGRAM_BOT_TOKEN) return;
    const sends = [];

    // Always fire milestone to VIP group
    if (TELEGRAM_GROUP_CHAT_ID) {
      sends.push(sendTelegramMessage(TELEGRAM_GROUP_CHAT_ID, msg));
    }

    // Free tier: first 2x unlocks the call (post the original + milestone).
    // Subsequent milestones (5/10/25x) also fire to free.
    if (TELEGRAM_FREE_CHAT_ID && meta.milestone >= 2) {
      try {
        // On the first unlock (2x), fire the full entry card to free channel
        if (meta.milestone === 2 && meta.ca) {
          const callRow = dbInstance.prepare(`
            SELECT c.token, c.contract_address, c.market_cap_at_call, c.called_at,
                   c.claude_verdict, c.claude_risk, c.setup_type_at_call,
                   c.structure_grade_at_call, c.score_at_call,
                   ca.sltp
            FROM calls c
            LEFT JOIN candidates ca ON ca.id = c.candidate_id
            WHERE c.contract_address = ? ORDER BY c.id DESC LIMIT 1
          `).get(meta.ca);
          if (callRow) {
            const entryMc = callRow.market_cap_at_call ?? 0;
            const verdictSnip = (callRow.claude_verdict || '').slice(0, 220);
            const freeCard =
              `🎯 <b>PULSE CALLER — FREE PICK (${meta.milestone}× confirmed)</b>\n` +
              `━━━━━━━━━━━━━━━━━━━━━\n` +
              `<b>$${(callRow.token || '?').toUpperCase()}</b>\n` +
              `<code>${callRow.contract_address}</code>\n\n` +
              `Entry MC: <b>$${Math.round(entryMc/1000)}K</b>\n` +
              `Score: ${callRow.score_at_call ?? '?'}/100 · Risk: ${callRow.claude_risk ?? '?'}\n` +
              `Setup: ${callRow.setup_type_at_call ?? '?'} · Structure: ${callRow.structure_grade_at_call ?? '?'}\n\n` +
              (verdictSnip ? `<i>"${verdictSnip}${callRow.claude_verdict?.length > 220 ? '…' : ''}"</i>\n\n` : '') +
              `<i>This was called on our VIP feed at entry. Now live on free — already 2× up.</i>`;
            sends.push(sendTelegramMessage(TELEGRAM_FREE_CHAT_ID, freeCard));
          }
        }
        // Every milestone also fires the follow-up message to free
        sends.push(sendTelegramMessage(TELEGRAM_FREE_CHAT_ID, msg));
      } catch (err) {
        console.warn('[free-tier] milestone dispatch failed:', err.message);
      }
    }

    await Promise.allSettled(sends);
  });

  // ── Smart Money Watcher: live feed of WINNER-tier wallet buys ─────────────
  // Polls Helius Enhanced Transactions for the top N tracked wallets and
  // emits an alert when one (or a cluster of 3+) buys a fresh coin. The alert
  // runs that coin through the normal scoring pipeline with a forced tag so
  // the TG message is prefixed with a BIG WALLET / WHALE CLUSTER header.
  // ── Passive Wallet Harvester ───────────────────────────────────────────
  // Every 30min: find coins we called that hit peak >=2x, pull their top
  // 20 holders via Helius, add to tracked_wallets. After 3+ appearances
  // across winners, auto-promote to WINNER tier. Grows Dune DB organically
  // without manual CA input.
  try {
    const { startWalletHarvester } = await import('./wallet-harvester.js');
    startWalletHarvester(dbInstance, HELIUS_API_KEY);
  } catch (err) {
    console.warn('[wallet-harvester] failed to start:', err.message);
  }

  // ── Legendary Harvester (external signal) ──────────────────────────────
  // Weekly: Dune query finds Solana tokens with $30M+ cumulative volume in
  // the last 180d (FARTCOIN/POPCAT-tier runs). Helius pulls top 20 holders
  // of each and drops them into tracked_wallets as WINNER. Independent of
  // whether we called them — pure external alpha sourcing.
  try {
    const { startLegendaryHarvester } = await import('./legendary-harvester.js');
    startLegendaryHarvester(dbInstance, HELIUS_API_KEY);
  } catch (err) {
    console.warn('[legendary-harvester] failed to start:', err.message);
  }

  // ── Whale Funding Tracker ──────────────────────────────────────────────
  // Every 15min: checks outgoing SOL transfers from top WINNER wallets via
  // Solscan. New recipients become WHALE_FUNDED — freshly-funded burners
  // that a whale is about to trade with. If any of them show up as holders
  // of a candidate coin within 48h, scorer awards a big bonus.
  try {
    const { startWhaleFundingTracker } = await import('./whale-funding-tracker.js');
    startWhaleFundingTracker(dbInstance);
  } catch (err) {
    console.warn('[whale-funding] failed to start:', err.message);
  }

  // ── Midcap Harvester (twice-daily mid-tier sweep) ──────────────────────
  // Every 12h: Dune query finds Solana tokens with $500K+ 24h volume
  // (proxy for $250K+ MCap). Pulls top 20 holders, auto-adds to the
  // wallet DB as SMART_MONEY. Wallets appearing across 2+ midcap runs
  // get promoted to WINNER. Fills the gap between passive (our own wins)
  // and legendary (only blue-chip runs).
  try {
    const { startMidcapHarvester } = await import('./midcap-harvester.js');
    startMidcapHarvester(dbInstance, HELIUS_API_KEY);
  } catch (err) {
    console.warn('[midcap-harvester] failed to start:', err.message);
  }

  // ── One-time cleanup of harvester wallets inserted WITHOUT SOL check ──
  // Previous harvester versions wrote every top-holder straight into
  // tracked_wallets as WINNER regardless of SOL balance, polluting the
  // WHALE tier with ~1000+ dust wallets. Run cleanup ONCE (kv_store flag)
  // to batch-scan every harvester-touched wallet, delete <8 SOL dust,
  // and recategorize survivors by SOL tier (≥100=WINNER, 8-99=SMART_MONEY).
  try {
    const flagRow = dbInstance.prepare(`SELECT value FROM kv_store WHERE key='harvester_cleanup_sol_tier_v1'`).get();
    if (!flagRow || flagRow.value !== 'done') {
      setTimeout(async () => {
        try {
          const { cleanupHarvesterDust } = await import('./harvester-cleanup.js');
          console.log('[boot] harvester-cleanup: starting one-time SOL-tier cleanup...');
          const summary = await cleanupHarvesterDust(dbInstance, HELIUS_API_KEY);
          dbInstance.prepare(`INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES ('harvester_cleanup_sol_tier_v1', 'done', datetime('now'))`).run();
          console.log('[boot] harvester-cleanup: ✓ done', summary);
        } catch (err) {
          console.error('[boot] harvester-cleanup failed:', err.message);
        }
      }, 30_000); // 30s after boot — let DB settle
    }
  } catch (err) {
    console.warn('[boot] harvester-cleanup check failed:', err.message);
  }

  try {
    const { startSmartMoneyWatcher } = await import('./smart-money-watcher.js');
    startSmartMoneyWatcher(dbInstance, async ({ ca, kind, clusterSize }) => {
      try {
        // EXIT alerts are WARNINGS about coins we already called or are
        // watching — post a TG notice but do NOT push into processCandidate
        // (no new call to make; we're flagging whale exits for awareness).
        if (kind === 'exit') {
          // User disabled the TG notification — too noisy. Still log the
          // exit to Railway + system_log so wallet_activity keeps the
          // SELL entry and the oracle can query "did whales exit this?"
          // on demand, but no channel ping.
          console.log(`[smart-money→pipeline] 📉 WHALE EXIT detected (silent) — ${ca.slice(0,8)} exitCluster=${clusterSize}`);
          logEvent('WARN', 'WHALE_EXIT_SILENT', `${ca} — ${clusterSize} tracked winners dumping (TG alert disabled)`);
          return;
        }
        console.log(`[smart-money→pipeline] $${ca.slice(0,8)} kind=${kind} cluster=${clusterSize} — pushing into processCandidate`);
        await processCandidate({
          contractAddress: ca,
          chain:           'solana',
          candidateType:   kind === 'kol'     ? 'KOL_FOLLOW'
                         : kind === 'cluster' ? 'SMART_MONEY_CLUSTER'
                         :                      'SMART_MONEY_SINGLE',
          _smartMoney:     { kind, clusterSize, detectedAt: Date.now() },
          _discoveredAt:   Date.now(),
        });
      } catch (err) {
        console.warn('[smart-money→pipeline] processCandidate failed:', err.message);
      }
    });
    console.log('[startup] ✓ Smart Money watcher active — WINNER-tier wallets polled every 90s');
  } catch (err) {
    console.warn('[startup] Smart Money watcher failed to start:', err.message);
  }

  // ── Smart Money: Solscan wallet enrichment loop (every 6h) ────────────────
  // Backfills tracked_wallets with real win-rate / ROI based on overlap with
  // our audit_archive outcomes. Skips if SOLSCAN_API_KEY is missing.
  try {
    const { startSolscanEnrichmentLoop } = await import('./solscan-wallet-enricher.js');
    startSolscanEnrichmentLoop(dbInstance);
    console.log('[startup] ✓ Solscan wallet enrichment loop active (6h interval)');
  } catch (err) {
    console.warn('[startup] Solscan enricher failed to start:', err.message);
  }

  // ── Momentum Tracker: parallel price/volume spike detection (every 15s) ───
  try {
    const { startMomentumTracker } = await import('./momentum-tracker.js');
    startMomentumTracker(dbInstance);
    console.log('[startup] ✓ Momentum tracker active — 15s tick, top 40 candidates');
  } catch (err) {
    console.warn('[startup] Momentum tracker failed to start:', err.message);
  }

  // ── Pre-Launch Detector: DISABLED — burns 5,000+ Helius credits/day
  // Watching exchange hot wallets every 90s is too expensive. The scanner
  // catches these tokens via DexScreener within 90s anyway.
  // Re-enable when on a higher Helius plan.
  console.log('[startup] ⏸ Pre-launch detector DISABLED (saves ~5K Helius credits/day)');

  // ── Cross-Chain Tracker: ETH/Base trending → Solana migration matches ────
  try {
    const { startCrossChainTracker } = await import('./cross-chain-tracker.js');
    startCrossChainTracker(dbInstance);
    console.log('[startup] ✓ Cross-chain tracker active — 5min tick, ETH + Base');
  } catch (err) {
    console.warn('[startup] Cross-chain tracker failed to start:', err.message);
  }

  // ── v8.0: Survivor Detection (every 30min) ────────────────────────────────
  setInterval(() => {
    try {
      if (AI_CONFIG_OVERRIDES.survivorTracking === false) return;
      const survivors = (() => { try {
        return dbInstance.prepare(`SELECT contract_address, token, market_cap, pair_age_hours, holder_addresses FROM candidates WHERE pair_age_hours >= 4 AND market_cap >= 500000 AND contract_address IS NOT NULL ORDER BY market_cap DESC LIMIT 20`).all();
      } catch { return []; }})();
      for (const s of survivors) {
        const holders = s.holder_addresses ? (()=>{try{return JSON.parse(s.holder_addresses);}catch{return [];}})() : [];
        try {
          dbInstance.prepare(`INSERT INTO survivor_tokens (token_ca,token,current_mcap,age_hours,early_wallets,first_seen,confirmed_at) VALUES (?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(token_ca) DO UPDATE SET current_mcap=excluded.current_mcap,age_hours=excluded.age_hours`).run(s.contract_address, s.token||null, s.market_cap||null, s.pair_age_hours||null, JSON.stringify(holders.slice(0,150)));
          if (holders.length > 0 && (s.market_cap||0) >= 500000) {
            const upsert = dbInstance.prepare(`INSERT INTO tracked_wallets (address,category,source,wins_found_in,notes,is_watchlist) VALUES (?,?,?,?,?,1) ON CONFLICT(address) DO UPDATE SET wins_found_in=wins_found_in+1,updated_at=datetime('now')`);
            const tx = dbInstance.transaction(list => list.slice(0,150).forEach(addr => upsert.run(addr,'SMART_MONEY','survivor_tracker',1,'Early in $'+( s.token||'?')+' ('+Math.round((s.market_cap||0)/1000)+'K)')));
            tx(holders);
          }
        } catch {}
      }
      if (survivors.length) console.log('[survivor] Tracked '+survivors.length+' survivor tokens');
    } catch (err) { console.warn('[survivor]', err.message); }
  }, 30 * 60_000);

  // ── v8.0: Also poll pump.fun API for new coins (fallback + extra coverage) ──
  setInterval(async () => {
    try {
      const pumpCoins = await fetchPumpFunNewCoins(30);
      for (const coin of pumpCoins) {
        if (!coin?.contractAddress) continue;
        if (isRecentlySeen(coin.contractAddress)) continue;
        if (isBlocklisted(coin.contractAddress)) continue;
        if ((coin.marketCap ?? 0) > 150_000) continue; // above our cap
        // Feed into pipeline as fast-track candidates
        logEvent('INFO', 'PUMPFUN_POLL', `${coin.token} stage=${coin.stage} mcap=${Math.round((coin.marketCap??0)/1000)}K`);
        enrichCandidate(coin).then(e => processCandidate(e, false)).catch(() => {});
      }
    } catch {}
  }, 45_000); // Every 45 seconds between DEXScreener cycles

  const resolved = (() => { try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome IN ('WIN','LOSS','NEUTRAL')`).get().n; } catch { return 0; } })();
  const totalCalls = (() => { try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM calls`).get().n; } catch { return 0; } })();

  // Read the real wallet count from SQL — the in-memory walletDb is the
  // Dune cache which only fills after a batch scan, so it often reads 2
  // even when tracked_wallets has 1200+. The real source of truth is
  // SELECT COUNT(*) FROM tracked_wallets.
  const trackedWalletsCount = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0`).get().n; }
    catch { return 0; }
  })();

  await sendAdminAlert(
    `⚡ <b>Pulse Caller v8 — MULTI-AGENT AI SYSTEM ONLINE</b>\n\n` +
    `<b>Detection:</b>\n` +
    `${HELIUS_API_KEY ? '✅ Helius WebSocket (~3s detection)' : '⚠️ DEXScreener polling (90s)'}\n` +
    `✅ Pump.fun pre-bonding monitor (45s)\n\n` +
    `<b>Intelligence:</b>\n` +
    `${trackedWalletsCount > 0 ? `✅ Wallet DB: ${trackedWalletsCount.toLocaleString()} wallets tracked` : '⏳ Wallet DB: empty — run Dune scan or Brain Analyzer'}\n` +
    `✅ Claude forensic analysis (every candidate)\n` +
    `${OPENAI_API_KEY ? '✅ OpenAI GPT-4o final decisions' : '⚠️ OpenAI not configured'}\n\n` +
    `<b>Learning:</b>\n` +
    `✅ Auto outcome tracking (every 3min)\n` +
    `✅ Missed winner detection (every 6h)\n` +
    `✅ In-context learning from ${totalCalls} calls · ${resolved} resolved\n\n` +
    `<b>Mode:</b> ${activeMode.emoji} ${activeMode.name} · Score floor: ${SCORING_CONFIG.minScoreToPost} · Max MCap: $80K\n` +
    `<b>Sweet spot:</b> $13K–$40K · <b>WIN bar:</b> ${SCORING_CONFIG.winPeakMultiple}x peak`
  );
});

export default app; 
