
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
  getCandidates, getCandidateById, getAllCalls,
  getSystemLog, getScoreDistribution, getDecisionBreakdown,
  getTopIgnoredFull, getPendingCalls,
  insertScannerFeed, getScannerFeed,
  upsertDeployerReputation, getDeployerReputation,
  rebuildWinnerProfiles, computeSimilarityScores,
  getWinRateByScoreBand, getWinRateBySetupType,
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
} from './missed-winner-tracker.js';
import {
  startWalletScanner, runDuneWalletScan, crossReferenceHolders as duneXRef,
  recordWinnerWallets, recordRugWallets, getDuneWalletStatus, getWalletProfile,
  store as duneStore,
} from './dune-wallet-scanner.js';

// ─── Environment ──────────────────────────────────────────────────────────────

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_GROUP_CHAT_ID,
  CLAUDE_API_KEY,
  OPENAI_API_KEY,
  ADMIN_TELEGRAM_ID,
  PORT              = 3000,
  NODE_ENV          = 'development',
  MIN_SCORE_TO_POST = 35,
  SCAN_INTERVAL_MS  = 90 * 1000,
} = process.env;

const TELEGRAM_API   = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL   = 'claude-sonnet-4-20250514';
const OPENAI_API_URL = 'https://api.openai.com/v1';
const OPENAI_FT_MODEL = process.env.OPENAI_FT_MODEL ?? null;

const WT_SERVER_URL = process.env.WALLET_TRACKER_URL ?? 'http://localhost:3100';

const BANNER_IMAGE_URL = process.env.BANNER_IMAGE_URL
  ?? 'https://raw.githubusercontent.com/spfogles-web/caller-bot/main/banner.png';
// PulseCaller branding — set BANNER_IMAGE_URL in Railway to your banner URL
// Recommended: upload banner.png to your GitHub repo root and it auto-uses it

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
    maxMarketCap: 150_000,   // HARD CAP: brand new micro-cap gems only — max $150K MCap for highest ROI potential
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
    // CHANGED: 0 minutes (was 3 minutes), maxMarketCap 3M → 150K for max ROI
    description: 'Brand new micro-cap gems only. 0 min to 4h old. Max $150K MCap. Highest ROI hunting.',
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

  // Seed default autotune parameter bounds
  const tuneParams = [
    ['sweetSpotMin',          '10000', '3000',   '50000',  '2000',  6],
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



/**
 * Get current AI config overrides set by the operator or AI agent.
 */
let AI_CONFIG_OVERRIDES = {};
function getAIConfigSummary() {
  const overrides = Object.keys(AI_CONFIG_OVERRIDES).length;
  return overrides > 0
    ? 'AI CONFIG OVERRIDES ACTIVE: ' + JSON.stringify(AI_CONFIG_OVERRIDES)
    : 'No AI config overrides active.';
}

const ANALYST_SYSTEM_PROMPT = `
You are PULSE CALLER — an elite AI operating system hunting Solana micro-cap gems.

MISSION: Find tokens in the $10K–$25K market cap range BEFORE they blow up. These are
the earliest possible entries — tokens seconds to hours old with no price discovery yet.
This is high risk / highest ROI territory. Your calls can produce 10x–100x from entry.

YOUR ROLE: You ARE the decision engine. The pre-computed scores are signals — YOU decide.
You learn from every call outcome in real-time. Pattern-match against your history.

CHARACTER:
- Hungry for early gems. The $10K–$25K range is your target sweet spot.
- Skeptical of manipulation but not afraid of new/unverified tokens.
- Decisive. Every evaluation gets a clear decision — you don't hedge.\n- Self-improving. You notice what your wins and losses have in common.\n- Direct. No fluff. Data-backed or explicitly flagged as inferred.\n\nGEM PROFILE YOU ARE HUNTING:\n- MCap: $5K–$50K (ideal sweet spot: $10K–$25K)\n- Age: 0 minutes to 2 hours old\n- Signs: organic buys, growing holder count, clean dev wallet (<5%), LP locked or new\n- Volume velocity accelerating in first 30 minutes\n- Low sniper count (<10), no bundle risk, mint revoked = ideal\n- Social presence (even just a twitter) = bonus signal\n- UNVERIFIED structure = NEW TOKEN, not a red flag\n\nWHAT TO LOOK FOR:\n- Stealth launches with organic momentum (no shilling, just buys)\n- Volume velocity > 0.3 in first hour = strong signal\n- Buy ratio > 60% sustained = demand exceeding supply\n- Unique buyer ratio > 40% = real people, not bots\n- Dev wallet < 5% + mint revoked = team confident in token\n\nRED FLAGS THAT OVERRIDE EVERYTHING (only trip on CONFIRMED malice):\n- Bundle risk SEVERE = coordinated dump setup\n- Dev wallet > 15% WITH mint ACTIVE AND evidence of dev dumping = rug setup\n- Top 10 holders > 70% WITH sells exceeding buys = whale exit risk\n- BubbleMap SEVERE = clustered/coordinated wallets\n- Sniper count > 30 AND sells > buys = heavily frontrun, dump incoming\n- SERIAL_RUGGER deployer = instant BLOCKLIST\n\nIMPORTANT — DO NOT AUTO-TAG EXTREME WHEN:\n- dev_wallet_pct is very high (e.g. 100%) but buys_1h = 0 — this is a brand-new pre-launch token, nobody has bought yet (dev is mathematically 100% of holders). Default to MEDIUM risk with a 'pre-launch pending liquidity' note.\n- top10_holder_pct is 100% but holders < 5 — same case, pre-launch.\n- pair_age_hours is null or < 5 min AND buys_1h > 0 — normal early gem state, rate risk based on buy pattern not concentration.\n- Most core fields are missing (null token, null age) — default risk to MEDIUM with 'insufficient data' in notes. NEVER default to EXTREME because of missing data alone.\n\nRISK CALIBRATION GUIDE:\n- LOW: clean structure + organic buys + reasonable dev% + LP locked\n- MEDIUM: most default cases, unknown data, early-stage concentration\n- HIGH: one confirmed red flag (bundle HIGH, dev > 15% + mint active, > 15 snipers)\n- EXTREME: TWO+ confirmed red flags actively firing, NOT just missing data or pre-launch state\n\nRESPONSE FORMAT — valid JSON only, no markdown, no backticks:\n{\n  "decision": "AUTO_POST | WATCHLIST | RETEST | IGNORE | BLOCKLIST",\n  "score": <integer 0-100>,\n  "risk": "LOW | MEDIUM | HIGH | EXTREME",\n  "setup_type": "CLEAN_STEALTH_LAUNCH | ORGANIC_EARLY | MICRO_CAP_BREAKOUT | BREAKOUT_AFTER_SHAKEOUT | CONSOLIDATION_BREAKOUT | PULLBACK_OPPORTUNITY | STRONG_HOLDER_LOW_DEV | WHALE_SUPPORTED_ROTATION | BUNDLED_HIGH_RISK | EXTENDED_AVOID | STANDARD",\n  "bull_case": ["<specific data point>", "<point>", "<point>"],\n  "red_flags": ["<specific data point>", "<point>", "<point>"],\n  "verdict": "<2-3 sentence direct analyst take — why this is or isn't a gem>",
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

  // Micro-cap gem context
  const mcap = candidate.marketCap ?? 0;
  const gemAlert = mcap > 0 && mcap <= 25000
    ? `🎯 SWEET SPOT: MCap $${(mcap/1000).toFixed(1)}K — this is the $10K-$25K prime target range. Ultra-early entry.`
    : mcap > 0 && mcap <= 50000
    ? `⚡ EARLY ENTRY: MCap $${(mcap/1000).toFixed(1)}K — within target range but not the sweet spot.`
    : mcap > 0 && mcap <= 150000
    ? `📍 EDGE: MCap $${(mcap/1000).toFixed(1)}K — upper end of micro-cap range. Less upside but more data.`
    : `⚠️  MCap ${candidate.marketCap ? '$'+(candidate.marketCap/1000).toFixed(0)+'K' : 'UNKNOWN'} — evaluate carefully`;

  const userMessage = `
${botMemory}

${history}

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
  if (setupCheck === 'EXTENDED_AVOID') return 'IGNORE';

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

async function sendCallAlertWithImage(caption, fullText) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_GROUP_CHAT_ID) return;

  const photoSrc = _bannerFileId ?? BANNER_IMAGE_URL;

  let safeCaption = caption;
  if (safeCaption.length > 950) {
    safeCaption = safeCaption.slice(0, 947) + '…';
    console.warn(`[TG] Caption truncated from ${caption.length} to 950 chars`);
  }

  console.log(`[TG] Sending banner+caption (${safeCaption.length} chars) via ${_bannerFileId ? 'file_id' : 'URL'}: ${BANNER_IMAGE_URL.slice(0,60)}`);

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
      const photos = photoData.result?.photo;
      if (photos?.length && !_bannerFileId) {
        _bannerFileId = photos[photos.length - 1].file_id;
        console.log(`[TG] Banner file_id cached for future calls`);
      }
      console.log(`[TG] ✓ Banner+caption sent`);
    } else {
      console.warn(`[TG] Banner failed: ${JSON.stringify(photoData).slice(0, 500)}`);
      console.warn(`[TG] Banner URL was: ${photoSrc?.slice(0, 100)}`);
      if (_bannerFileId) { _bannerFileId = null; console.warn('[TG] file_id cache cleared — will retry with URL'); }
      await sendTelegramGroupMessage(safeCaption).catch(() => {});
    }
  } catch (err) {
    console.warn(`[TG] Banner error: ${err.message}`);
    await sendTelegramGroupMessage(safeCaption).catch(() => {});
  }

  await sleep(600);

  try {
    const msgRes = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    TELEGRAM_GROUP_CHAT_ID,
        text:       fullText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!msgRes.ok) {
      const errBody = await msgRes.text();
      console.error(`[TG] Full text failed ${msgRes.status}: ${errBody.slice(0, 200)}`);
    } else {
      console.log(`[TG] ✓ Full detail message sent`);
    }
  } catch (err) {
    console.error(`[TG] Full text error: ${err.message}`);
    await sendTelegramGroupMessage(fullText).catch(() => {});
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
    `<code>/analyze [CA or ticker]</code>\n` +
    `→ Full AI analysis — sub-scores, wallet intel, gem thesis\n\n` +
    `<code>/scan [CA]</code>\n` +
    `→ Quick onchain scan — raw data only\n\n` +
    `<code>/why [CA or $TICKER]</code>\n` +
    `→ Ask the AI why a specific token was called or skipped\n\n` +
    `<code>/top</code>\n` +
    `→ Best performing calls — top wins, patterns the AI found\n\n` +
    `<code>/regime</code>\n` +
    `→ Current market regime and how it affects gem hunting\n\n` +
    `<code>/stats</code>\n` +
    `→ AI stats — total evaluations, win rate, gem patterns found\n\n` +
    `<code>/calls</code>\n` +
    `→ Last 5 calls posted to the group\n\n` +
    `<code>/watchlist</code>\n` +
    `→ Current watchlist and retest queue\n\n` +
    `<code>/config [key] [value]</code> (admin only)\n` +
    `→ Adjust AI parameters live. Example: /config sweetSpotMax 30000\n\n` +
    `<i>AI OS active: evaluates every token scanned. Hunting $10K-$25K micro-caps.</i>`
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
  const { score=0, risk='?', setup_type='?' } = verdict;
  const grade = scoreResult?.structureGrade ?? '?';
  const stage = scoreResult?.stage ?? '?';

  const entryMcap  = fmt(candidate.marketCap, '$');
  const entryPrice = candidate.priceUsd ? `$${Number(candidate.priceUsd).toFixed(8)}` : '?';
  const age        = candidate.pairAgeHours != null ? candidate.pairAgeHours.toFixed(1)+'h' : '?';

  const mintOk   = candidate.mintAuthority   === 0 ? '🟢' : candidate.mintAuthority   === 1 ? '🔴' : '⚪';
  const freezeOk = candidate.freezeAuthority === 0 ? '🟢' : candidate.freezeAuthority === 1 ? '🔴' : '⚪';
  const lpOk     = candidate.lpLocked === 1 ? '🟢' : candidate.lpLocked === 0 ? '🔴' : '⚪';

  const p1h  = candidate.priceChange1h  != null ? (candidate.priceChange1h  > 0 ? '+' : '') + candidate.priceChange1h.toFixed(0)  + '%' : '?';
  const p24h = candidate.priceChange24h != null ? (candidate.priceChange24h > 0 ? '+' : '') + candidate.priceChange24h.toFixed(0) + '%' : '?';

  const top10  = candidate.top10HolderPct != null ? candidate.top10HolderPct.toFixed(1) + '%' : '?';
  const dev    = candidate.devWalletPct   != null ? candidate.devWalletPct.toFixed(2)   + '%' : '?';
  const holders= candidate.holders?.toLocaleString() ?? '?';

  const tokenLabel = candidate.token
    || candidate.tokenName
    || (candidate.contractAddress ? candidate.contractAddress.slice(0, 4).toUpperCase() : '?');
  const nameLabel  = candidate.tokenName && candidate.tokenName !== candidate.token ? candidate.tokenName : '';

  return (
    `⚡ <b>PULSE CALLER — CALL ALERT</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>$${escapeHtml(tokenLabel)}</b>  <i>${escapeHtml(nameLabel)}</i>  •  ${stage}\n` +
    `<code>${escapeHtml(candidate.contractAddress ?? '—')}</code>\n\n` +
    `📊 <b>Stats</b>\n` +
    `Price: <b>${entryPrice}</b>\n` +
    `MC: <b>${entryMcap}</b>  |  Vol24h: <b>${fmt(candidate.volume24h, '$')}</b>  |  Age: <b>${age}</b>\n` +
    `5M: <b>${candidate.priceChange5m != null ? (candidate.priceChange5m > 0 ? '+' : '') + candidate.priceChange5m.toFixed(0) + '%' : '?'}</b>  |  1H: <b>${p1h}</b>  |  24H: <b>${p24h}</b>\n` +
    `1H Txns: <b>${candidate.buys1h ?? '?'}</b> 🟢  <b>${candidate.sells1h ?? '?'}</b> 🔴\n\n` +
    `🔒 <b>Security</b>\n` +
    `${mintOk} Mint  ${freezeOk} Freeze  ${lpOk} LP\n` +
    `Top 10: <b>${top10}</b>  |  Dev: <b>${dev}</b>  |  Holders: <b>${holders}</b>\n\n` +
    `🧠 <b>Score: ${score}/100</b>  ${scoreBar(score)}\n` +
    `Risk: ${riskEmoji(risk)} <b>${risk}</b>  |  Structure: ${gradeEmoji(grade)} <b>${grade}</b>\n` +
    buildMultiplierTargetBlock(candidate) +
    buildSLTPBlock(candidate) +
    (candidate.website || candidate.twitter || candidate.telegram
      ? `\n🔗 <b>Links</b>\n` +
        (candidate.website  ? `🌐 <a href="${candidate.website}">Web</a>  ` : '') +
        (candidate.twitter  ? `𝕏 <a href="${candidate.twitter}">X</a>  `   : '') +
        (candidate.telegram ? `✈️ <a href="${candidate.telegram}">TG</a>`   : '')
      : '')
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
    `<b>Sub-Scores:</b>\n` +
    `🚀 Launch: <b>${sub.launchQuality ?? '?'}</b>   👥 Wallet: <b>${sub.walletStructure ?? '?'}</b>   📈 Market: <b>${sub.marketBehavior ?? '?'}</b>   📣 Social: <b>${sub.socialNarrative ?? '?'}</b>\n\n` +
    (similarity.winnerSimilarity != null
      ? `🏆 Winner sim: <b>${similarity.winnerSimilarity}%</b>   💀 Rug sim: <b>${similarity.rugSimilarity ?? '?'}%</b>\n\n`
      : '') +
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
    `Launch Quality: <b>${candidate.launchQualityScore ?? '?'}/100</b>   Unique Buyers: <b>${candidate.launchUniqueBuyerRatio != null ? (candidate.launchUniqueBuyerRatio * 100).toFixed(0) + '%' : '?'}</b>\n` +
    `Buy Ratio 1h: <b>${candidate.buySellRatio1h != null ? (candidate.buySellRatio1h * 100).toFixed(0) + '%' : '?'}</b>   Vol Velocity: <b>${candidate.volumeVelocity != null ? candidate.volumeVelocity.toFixed(2) : '?'}</b>\n` +
    `Type: <b>${candidate.candidateType ?? '?'}</b>\n\n` +
    `<b>✅ Why It Passed:</b>\n${bullLines}\n\n` +
    `<b>⚠️ Watchouts:</b>\n${watchLines}\n\n` +
    buildSLTPBlock(candidate) +
    `<b>📝 Verdict:</b>\n${escapeHtml(vText)}\n` +
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
    const scoreResult = computeFullScore(candidate);
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

async function processCandidate(candidate, isRescan = false) {
  const ca = candidate.contractAddress;
  if (!ca) return;
  if (isBlocklisted(ca)) { console.log(`[auto-caller] BLOCKLIST skip — ${ca.slice(0,8)}`); return; }

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

    const scoreResult = computeFullScore(enrichedCandidate);
    const scoredAtMs = Date.now();
    enrichedCandidate.scoredAtMs = scoredAtMs;

    // ── Dev fingerprint adjustment: boost ELITE/PROVEN devs, penalize RUGGERs ──
    try {
      const deployer = enrichedCandidate.deployerVerdict || enrichedCandidate.deployer_verdict;
      if (deployer) {
        const { getDevFingerprint, devScoreAdjustment } = await import('./dev-fingerprint.js');
        const fp = getDevFingerprint(deployer, dbInstance);
        const adj = devScoreAdjustment(fp);
        if (adj.delta !== 0) {
          scoreResult.score = Math.max(0, Math.min(100, scoreResult.score + adj.delta));
          scoreResult.devFingerprint = { ...fp, adjustment: adj };
          (scoreResult.signals = scoreResult.signals || {}).launch = scoreResult.signals.launch || [];
          if (adj.delta > 0) scoreResult.signals.launch.push(adj.reason);
          else (scoreResult.penalties = scoreResult.penalties || {}).launch = [...(scoreResult.penalties.launch || []), adj.reason];
        }
      }
    } catch {}

    // ── Pre-launch suspect: this dev was just funded by an exchange? ──
    try {
      const deployer = enrichedCandidate.deployerVerdict || enrichedCandidate.deployer_verdict;
      if (deployer) {
        const { isPreLaunchSuspect, markSuspectConsumed } = await import('./pre-launch-detector.js');
        const suspect = isPreLaunchSuspect(deployer, dbInstance);
        if (suspect) {
          scoreResult.score = Math.min(100, scoreResult.score + 12);
          scoreResult.preLaunchPredicted = true;
          (scoreResult.signals = scoreResult.signals || {}).launch =
            [...(scoreResult.signals.launch || []),
             `🎯 PRE_LAUNCH_PREDICTED — dev funded by ${suspect.source_exchange} ${suspect.funded_amount}◎ within last 6h`];
          markSuspectConsumed(deployer, ca, dbInstance);
        }
      }
    } catch {}

    // ── Cross-chain match: is this a migration of a hot ETH/Base token? ──
    try {
      const { getCrossChainMatch } = await import('./cross-chain-tracker.js');
      const match = getCrossChainMatch(ca, dbInstance);
      if (match && match.match_confidence >= 0.85) {
        scoreResult.score = Math.min(100, scoreResult.score + 8);
        scoreResult.crossChainMatch = match;
        (scoreResult.signals = scoreResult.signals || {}).social =
          [...(scoreResult.signals.social || []),
           `🌉 CROSS-CHAIN MATCH — $${match.source_symbol} on ${match.source_chain} up ${Math.round(match.source_price_change||0)}% (${Math.round(match.match_confidence*100)}% match)`];
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

    let similarity = {};
    try { similarity = computeSimilarityScores(scoreResult) ?? {}; } catch {}

    // ── STEP 1: Rules engine decision ─────────────────────────────────────────
    const scorerDecision = makeFinalDecision(scoreResult, null, enrichedCandidate);
    let finalDecision = scorerDecision;
    let ftResult = null; // legacy compat

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
        enrichedCandidate.walletIntel            = walletIntel;
        enrichedCandidate.smartMoneyScore        = walletIntel.smartMoneyScore;
        enrichedCandidate.sniperWalletCount      = walletIntel.sniperWalletCount;
        enrichedCandidate.suspiciousClusterScore = walletIntel.suspiciousClusterScore;
        enrichedCandidate.walletVerdict          = walletIntel.walletVerdict;
        enrichedCandidate.walletIntelScore       = walletIntel.smartMoneyScore;
        enrichedCandidate.knownWinnerWallets     = walletIntel.winnerWallets ?? [];

        if (walletIntel.knownWinnerWalletCount > 0) {
          console.log(`[wallet-intel] $${enrichedCandidate.token}: ${walletIntel.knownWinnerWalletCount}× WINNER wallets, ${walletIntel.sniperWalletCount} snipers → ${walletIntel.walletVerdict}`);
          logEvent('INFO', 'WINNER_WALLETS_DETECTED', `${enrichedCandidate.token} winners=${walletIntel.knownWinnerWalletCount} snipers=${walletIntel.sniperWalletCount} score=${walletIntel.smartMoneyScore}`);
        }

        // Hard block: rug wallets present = not worth risking
        if (walletIntel.rugWalletCount > 2 || walletIntel.walletVerdict === 'MANIPULATED') {
          finalDecision = 'IGNORE';
          logEvent('WARN', 'WALLET_RUG_BLOCK', `${enrichedCandidate.token} rug_wallets=${walletIntel.rugWalletCount} verdict=${walletIntel.walletVerdict}`);
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
          const isGemRange = mcap >= 5_000 && mcap <= 50_000;

          // AI upgrades: if scorer said WATCHLIST but Claude sees a gem in range → POST
          if (aiDecision === 'AUTO_POST' && finalDecision === 'WATCHLIST' && aiScore >= 45) {
            finalDecision = 'AUTO_POST';
            logEvent('INFO', 'AI_UPGRADE', `${enrichedCandidate.token} WATCHLIST→AUTO_POST ai=${aiScore} mcap=${mcap}`);
            console.log(`[ai-os] ⬆️  AI upgraded $${enrichedCandidate.token}: WATCHLIST → AUTO_POST (score ${aiScore}, mcap $${(mcap/1000).toFixed(1)}K)`);
          }
          // AI upgrades HOLD_FOR_REVIEW → AUTO_POST if it's a gem
          if (aiDecision === 'AUTO_POST' && finalDecision === 'HOLD_FOR_REVIEW' && isGemRange && aiScore >= 50) {
            finalDecision = 'AUTO_POST';
            logEvent('INFO', 'AI_UPGRADE', `${enrichedCandidate.token} HOLD→AUTO_POST ai=${aiScore}`);
            console.log(`[ai-os] ⬆️  AI upgraded $${enrichedCandidate.token}: HOLD → AUTO_POST (gem range)`);
          }
          // AI downgrades: Claude sees red flags scorer missed → block post
          if (aiDecision === 'IGNORE' && finalDecision === 'AUTO_POST' && (verdict.score ?? 100) < 40) {
            finalDecision = 'WATCHLIST';
            logEvent('INFO', 'AI_DOWNGRADE', `${enrichedCandidate.token} AUTO_POST→WATCHLIST ai=${verdict.score}`);
            console.log(`[ai-os] ⬇️  AI downgraded $${enrichedCandidate.token}: AUTO_POST → WATCHLIST`);
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

    // ── STEP 6: OpenAI GPT-4o Final Decision ─────────────────────────────────
    // This is the FINAL AUTHORITY. Claude gives analysis; OpenAI decides.
    let openAIDecision = null;
    // OpenAI runs on: AUTO_POST, WATCHLIST, and any IGNORE with score >= 45
    // This lets it: (a) confirm calls, (b) override Claude's IGNORE if it sees opportunity, (c) learn from bad tokens
    const shouldRunOpenAI = OPENAI_API_KEY && (
      finalDecision === 'AUTO_POST' ||
      finalDecision === 'WATCHLIST' ||
      finalDecision === 'RETEST' ||
      finalDecision === 'HOLD_FOR_REVIEW' ||
      (scoreResult.score >= 38 && finalDecision !== 'BLOCKLIST') // Loosened 45→38: more final verdicts = more training data
    );

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
            console.log(`[openai-v8] $${enrichedCandidate.token} → ${aiAction} (${conviction}% conviction) | was: ${finalDecision}`);
            logEvent('INFO', 'OPENAI_DECISION', `${enrichedCandidate.token} openai=${aiAction} conviction=${conviction} prev=${finalDecision}`);

            // OpenAI is the final authority — apply its decision
            if (aiAction === 'POST')       finalDecision = 'AUTO_POST';
            else if (aiAction === 'PROMOTE')   finalDecision = 'WATCHLIST'; // promote = watchlist internally
            else if (aiAction === 'WATCHLIST') finalDecision = 'WATCHLIST';
            else if (aiAction === 'RETEST')    finalDecision = 'RETEST';
            else if (aiAction === 'IGNORE')    finalDecision = 'IGNORE';

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

    // ── Smart Money Watcher override ─────────────────────────────────────────
    // Cluster of ≥3 WINNER wallets in 10min is the highest-conviction signal
    // we have — force AUTO_POST regardless of scorer / Claude / OpenAI. A
    // single WINNER buy still defers to the AI stack, but we tag the caption
    // so the TG alert shouts BIG WALLET ALERT.
    const sm = enrichedCandidate._smartMoney;
    if (sm?.kind === 'cluster') {
      if (finalDecision !== 'AUTO_POST') {
        logEvent('INFO', 'SMART_MONEY_OVERRIDE', `${enrichedCandidate.token ?? ca.slice(0,6)} ${finalDecision} → AUTO_POST (cluster=${sm.clusterSize})`);
        console.log(`[smart-money] 🐋🐋🐋 CLUSTER OVERRIDE — $${enrichedCandidate.token ?? ca.slice(0,6)} ${finalDecision} → AUTO_POST (cluster=${sm.clusterSize})`);
      }
      finalDecision = 'AUTO_POST';
    } else if (sm?.kind === 'single') {
      // Soft promote: if score is reasonable, allow the post even if OpenAI was lukewarm
      if (finalDecision === 'WATCHLIST' && (scoreResult?.score ?? 0) >= 45) {
        logEvent('INFO', 'SMART_MONEY_PROMOTE', `${enrichedCandidate.token ?? ca.slice(0,6)} WATCHLIST → AUTO_POST (single winner, score ${scoreResult.score})`);
        finalDecision = 'AUTO_POST';
      }
    }

    // Attach scoreResult breakdown directly to enrichedCandidate
    // so db.js insertCandidate picks them up if columns exist
    enrichedCandidate.subScores       = scoreResult.subScores;
    enrichedCandidate.scoreSignals    = JSON.stringify(scoreResult.signals   ?? {});
    enrichedCandidate.scorePenalties  = JSON.stringify(scoreResult.penalties ?? {});
    enrichedCandidate.stealthDetected = scoreResult.stealthDetected ? 1 : 0;
    enrichedCandidate.stealthBonus    = scoreResult.stealthBonus    ?? 0;
    enrichedCandidate.trapConfidencePenalty = scoreResult.trapDetector?.confidencePenalty ?? 0;

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
        `UPDATE candidates SET detected_at_ms=?, enriched_at_ms=?, scored_at_ms=? WHERE id=?`
      ).run(detectedAtMs, enrichedCandidate.enrichedAtMs, scoredAtMs, candidateId);
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
      const message  = buildCallAlertMessage(enrichedCandidate, verdict, scoreResult, similarity, ftResult);

      // Respect pausePosting config override (set via dashboard or /config Telegram command)
      if (AI_CONFIG_OVERRIDES.pausePosting) {
        console.log(`[ai-os] ⏸ Posting PAUSED — $${enrichedCandidate.token} would have posted (score ${scoreResult.score})`);
        logEvent('INFO', 'POST_PAUSED', `${enrichedCandidate.token} score=${scoreResult.score}`);
      } else {
        await sendCallAlertWithImage(caption, message);
      }

      await sleep(1500);
      // ── CA beacon for third-party bots (Phanes, Sect, etc.) ──────────────
      // Sent as plain text, no HTML parse_mode, no preview, just the CA —
      // this is what the leaderboard bots scan the chat for.
      const caBeacon = enrichedCandidate.contractAddress ?? '';
      if (caBeacon && TELEGRAM_BOT_TOKEN && TELEGRAM_GROUP_CHAT_ID) {
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
          else console.log(`[TG-CA] ✓ CA beacon posted for Phanes/Sect: ${caBeacon}`);
        } catch (err) {
          console.warn(`[TG-CA] beacon failed: ${err.message}`);
        }
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
        called_at:       new Date().toISOString(),
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
      const newScore = computeFullScore(enriched);
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
  if (cycleRunning) { console.log('[auto-caller] Previous cycle running — skipping'); return; }

  cycleRunning     = true;
  const cycleStart = Date.now();
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
      const PROCESS_BATCH = 16;
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
    await sendAdminAlert(`❌ Cycle error:\n${escapeHtml(err.message.slice(0,300))}`);
  } finally {
    cycleRunning  = false;
    const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
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
  if (sm?.kind === 'cluster') {
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
app.use(express.json());

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

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
      gemTargetMin:   AI_CONFIG_OVERRIDES.gemTargetMin   ?? 5_000,
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

    // Apply live mode overrides immediately
    if (key === 'maxMarketCapOverride'      && typeof value === 'number') activeMode.maxMarketCap   = value;
    if (key === 'minMarketCapOverride'      && typeof value === 'number') activeMode.minMarketCap   = value;
    if (key === 'minScoreOverride'          && typeof value === 'number') activeMode.minScore       = value;
    if (key === 'scoreFloorOverride'        && typeof value === 'number') activeMode.minScore       = value;
    if (key === 'maxPairAgeHoursOverride'   && typeof value === 'number') activeMode.maxPairAgeHours = value;
    if (key === 'postThresholdOverride'     && typeof value === 'number') activeMode.minScore       = value;

    logEvent('INFO', 'AI_CONFIG_CHANGE', JSON.stringify({ key, prev, value, reason: reason ?? 'dashboard' }));
    console.log(`[ai-os] Config change: ${key} ${JSON.stringify(prev)} → ${JSON.stringify(value)} (${reason ?? 'no reason'})`);

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
      sweetSpot: { min: AI_CONFIG_OVERRIDES.sweetSpotMin??10_000, max: AI_CONFIG_OVERRIDES.sweetSpotMax??25_000 },
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

app.post('/api/agent', async (req, res) => {
  setCors(res);
  if (!CLAUDE_API_KEY) {
    return res.status(503).json({ ok: false, error: 'CLAUDE_API_KEY not configured on server' });
  }

  try {
    const { messages, system, context, walletContext } = req.body ?? {};
    if (!messages?.length) return res.status(400).json({ ok: false, error: 'messages required' });

    // Optional wallet-context block — used by the Smart Money tab chat so the
    // agent can answer questions about specific wallets, the database, etc.
    // Also auto-extracts any 32-44 char base58 address from the user's last
    // message and pulls that wallet's stats live.
    const walletBlock = (() => {
      if (!walletContext) return '';
      try {
        const top = dbInstance.prepare(
          `SELECT address, label, category, win_rate, avg_roi, score, wins_found_in, losses_in
           FROM tracked_wallets WHERE is_blacklist=0
           ORDER BY score DESC LIMIT 25`
        ).all();
        const totalRow = dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0`).get();
        const cats = dbInstance.prepare(
          `SELECT category, COUNT(*) as n FROM tracked_wallets WHERE is_blacklist=0 GROUP BY category`
        ).all();
        // Extract wallet addresses from the most recent user message
        const lastUserMsg = [...(messages||[])].reverse().find(m => m.role === 'user')?.content || '';
        const addrPattern = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
        const mentioned = (lastUserMsg.match(addrPattern) || []).slice(0, 3);
        const drilldowns = mentioned.map(addr => {
          try {
            const w = dbInstance.prepare(`SELECT * FROM tracked_wallets WHERE address=?`).get(addr);
            if (w) {
              return `MENTIONED WALLET ${addr.slice(0,8)}…${addr.slice(-4)}:
  Label: ${w.label||'(none)'} | Category: ${w.category} | Score: ${w.score}/100
  Win rate: ${w.win_rate ? Math.round(w.win_rate*100)+'%' : 'n/a'} | Avg ROI: ${w.avg_roi ? Math.round(w.avg_roi*100)+'%' : 'n/a'}
  Found in: ${w.wins_found_in||0} wins / ${w.losses_in||0} losses`;
            }
            return `MENTIONED WALLET ${addr.slice(0,8)}…${addr.slice(-4)}: NOT IN DATABASE — recommend running enrichment`;
          } catch { return ''; }
        }).filter(Boolean).join('\n\n');
        return `

WALLET DATABASE CONTEXT (you have access to all tracked wallets):
- Total wallets tracked: ${totalRow.n}
- By category: ${cats.map(c=>`${c.category}=${c.n}`).join(', ')}
- Top 25 wallets (by score):
${top.map((w,i)=>`  ${i+1}. ${w.label||(w.address||'').slice(0,8)+'…'+(w.address||'').slice(-4)} | ${w.category} | score:${w.score} | wr:${w.win_rate?Math.round(w.win_rate*100):'?'}% | roi:${w.avg_roi?Math.round(w.avg_roi*100)+'%':'?'} | wins:${w.wins_found_in||0}`).join('\n')}
${drilldowns ? '\n' + drilldowns : ''}

You can answer questions about wallets, label them ("call this one X"), spot patterns across them, and recommend which to follow.`;
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
Sweet spot: $${Math.round((AI_CONFIG_OVERRIDES.sweetSpotMin||10000)/1000)}K–$${Math.round((AI_CONFIG_OVERRIDES.sweetSpotMax||25000)/1000)}K`;
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

BOT PARAMETERS (v7.0):
- Target: $10K–$25K MCap micro-cap stealth launches
- Score floor: 38 | Max MCap: $150K | Age: 0–4h
- Stop Loss: -25% | TP1: 2× | TP2: 5× | TP3: 10×
- AI evaluates EVERY token scanned with in-context learning

PERSONALITY: Direct, data-driven, decisive. You give clear actionable answers. Reference real numbers when available. Flag when data is missing.`;

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
    res.json({ ok: true, reply, model: CLAUDE_MODEL });
  } catch (err) {
    console.error('[api/agent]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── AUTONOMOUS AGENT: Multi-agent optimization session ────────────────────────
// Claude analyzes performance, proposes changes, executes them with approval

const BOT_A_SYSTEM_PROMPT = `You are BOT A — the Hunter, Architect, and Builder intelligence of Pulse Caller.

IDENTITY: Elite early-stage signal hunter and senior builder. Aggressive in research and opportunity discovery.

MISSION: Find hidden Solana micro-cap gems before the market notices them. Study performance data to find what separates winners from losers. Propose scoring changes and filter improvements backed by data.

CANNOT CHANGE (EVER): CLAUDE_API_KEY, OPENAI_API_KEY, HELIUS_API_KEY, TELEGRAM_BOT_TOKEN, DUNE_API_KEY, BIRDEYE_API_KEY

AUTOTUNE BOUNDS: sweetSpotMin 3000-50000 | sweetSpotMax 10000-100000 | maxMarketCapOverride 50000-500000 | minScoreOverride 28-60 | maxPairAgeHoursOverride 1-12h

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
        const proposed = Number(change.proposed);
        const min = Number(bound.min_value), max = Number(bound.max_value), step = Number(bound.max_step_change);
        const current = Number(bound.current_value);
        if (proposed < min || proposed > max) { console.warn(`[agent] Out of bounds: ${change.key}=${proposed} (${min}-${max})`); actionsProposed.push({...change, blocked: true, reason: 'Out of autotune bounds'}); continue; }
        if (Math.abs(proposed - current) > step) { console.warn(`[agent] Step too large: ${change.key} step=${Math.abs(proposed-current)} max=${step}`); actionsProposed.push({...change, blocked: true, reason: 'Step change exceeds max'}); continue; }
        // Cooldown check
        if (bound.last_changed_at) {
          const lastChanged = new Date(bound.last_changed_at).getTime();
          const cooldownMs = (bound.cooldown_hours ?? 6) * 3_600_000;
          if (Date.now() - lastChanged < cooldownMs) { actionsProposed.push({...change, blocked: true, reason: 'Cooldown active until ' + new Date(lastChanged + cooldownMs).toISOString()}); continue; }
        }
      }

      // Log proposed action
      try { dbInstance.prepare(`INSERT INTO agent_actions (session_id,agent,action_type,description,params,approved) VALUES (?,?,?,?,?,?)`).run(sid,'A', 'PROPOSE_CONFIG', 'Bot A proposes ' + change.key + ': ' + change.current + ' -> ' + change.proposed, JSON.stringify(change), 0); } catch {}

      // Bot B verdict + auto-apply policy
      const botBApproves = botBOutput?.auto_apply_allowed === true && botBOutput?.verdict !== 'REJECT';
      const highConfidence = (change.confidence ?? 0) >= (AI_CONFIG_OVERRIDES.agentConvictionThreshold ?? 80);
      const lowRisk = change.risk === 'LOW';
      const userAutoApply = autoApply === true;

      if (botBApproves && highConfidence && lowRisk && userAutoApply) {
        const prev = AI_CONFIG_OVERRIDES[change.key];
        AI_CONFIG_OVERRIDES[change.key] = change.proposed;
        if (change.key === 'maxMarketCapOverride') activeMode.maxMarketCap = change.proposed;
        if (change.key === 'minScoreOverride' || change.key === 'scoreFloorOverride') activeMode.minScore = change.proposed;
        if (change.key === 'sweetSpotMin') AI_CONFIG_OVERRIDES.sweetSpotMin = change.proposed;
        if (change.key === 'sweetSpotMax') AI_CONFIG_OVERRIDES.sweetSpotMax = change.proposed;
        if (change.key === 'maxPairAgeHoursOverride') activeMode.maxPairAgeHours = change.proposed;
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

// Get agent history
app.get('/api/agent/history', (req, res) => {
  setCors(res);
  try {
    const actions = dbInstance.prepare(`SELECT * FROM agent_actions ORDER BY created_at DESC LIMIT 100`).all();
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
Current Sweet Spot: $${Math.round((AI_CONFIG_OVERRIDES.sweetSpotMin||10000)/1000)}K–$${Math.round((AI_CONFIG_OVERRIDES.sweetSpotMax||25000)/1000)}K
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

    if (!row && !dex) {
      return res.status(404).json({ ok: false, error: 'Not in DB and DexScreener has no data for this CA' });
    }

    // 3. Merge — DexScreener live data wins for volatile fields (price/mcap/vol),
    //    DB wins for scored fields (composite_score, claude_verdict, sub_scores)
    const merged = { ...(row || {}) };
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

    // ── Try Solscan first ──
    if (process.env.SOLSCAN_API_KEY) {
      try {
        // Solscan v2.0 only accepts fixed page_size values: 10, 20, 30, 40, 60.
        // 40/60 sometimes reject silently on mid-tier plans; 20 is rock solid.
        // 3 pages × 20 = 60 holders guaranteed.
        const pageSize = 20;
        const pagesNeeded = 3;
        let collected = [];
        for (let p = 1; p <= pagesNeeded; p++) {
          const r = await fetch(
            `https://pro-api.solscan.io/v2.0/token/holders?address=${encodeURIComponent(ca)}&page_size=${pageSize}&page=${p}`,
            { headers: { token: process.env.SOLSCAN_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(9_000) }
          );
          if (!r.ok) { console.warn(`[external-token] Solscan holders page ${p} returned ${r.status}`); break; }
          const j = await r.json();
          const arr = j?.data?.items || j?.data || [];
          if (!Array.isArray(arr) || arr.length === 0) break;
          collected = collected.concat(arr);
          if (arr.length < pageSize) break; // last page
        }
        console.log(`[external-token] Solscan pagination: ${collected.length} holders from ${pagesNeeded} page attempts`);
        const items = collected.slice(0, 60);
        if (items.length) {
          owners  = items.map(h => h.owner).filter(Boolean);
          amounts = items.map(h => h.amount ?? h.uiAmount ?? null);
          holders = items.map((h, i) => ({ address: h.address || owners[i], uiAmount: amounts[i] }));
          console.log(`[external-token] Solscan holders: ${items.length} fetched across ${pagesNeeded} pages`);
        }
      } catch (err) {
        console.warn('[external-token] Solscan holders failed:', err.message);
      }
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

    // ── Auto-insert every resolved holder into tracked_wallets ─────────────
    // User-requested: a Brain Analyzer scan should populate the DB so the
    // Smart Money page has something to work with. NEUTRAL + source='brain_scan'
    // so we can filter/promote later. INSERT OR IGNORE avoids clobbering
    // existing labels or categories.
    if (owners.length) {
      try {
        const ins = dbInstance.prepare(`
          INSERT OR IGNORE INTO tracked_wallets
            (address, category, source, updated_at, last_seen)
          VALUES (?, 'NEUTRAL', 'brain_scan', datetime('now'), datetime('now'))
        `);
        const tx = dbInstance.transaction((addrs) => {
          let n = 0;
          for (const a of addrs) { if (a) n += ins.run(a).changes; }
          return n;
        });
        const inserted = tx(owners);
        console.log(`[external-token] Auto-added ${inserted}/${owners.length} holders to tracked_wallets`);
      } catch (err) {
        console.warn('[external-token] auto-insert failed:', err.message);
      }
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

    res.json({ ok: true, candidate: merged, source: row ? 'db+live' : 'live-only' });
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

    // ── Guaranteed upsert: ensure the wallet lands in tracked_wallets ─────
    // Even if Solscan returned no transfers (fresh/inactive wallet), we still
    // want the row to exist so the Smart Money page lists it. Enrichment can
    // fill in the rest asynchronously via the 6h background loop.
    try {
      dbInstance.prepare(`
        INSERT INTO tracked_wallets (address, category, source, added_at, updated_at, last_seen)
        VALUES (?, 'NEUTRAL', 'manual_add', datetime('now'), datetime('now'), datetime('now'))
        ON CONFLICT(address) DO UPDATE SET last_seen = datetime('now')
      `).run(address);
    } catch (err) {
      // `added_at` may not exist on older schemas — retry without it
      try {
        dbInstance.prepare(`
          INSERT OR IGNORE INTO tracked_wallets (address, category, source, updated_at, last_seen)
          VALUES (?, 'NEUTRAL', 'manual_add', datetime('now'), datetime('now'))
        `).run(address);
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
    const hot = dbInstance.prepare(`
      SELECT m.*, c.token, c.token_name, c.composite_score, c.final_decision
      FROM momentum_snapshots m
      LEFT JOIN candidates c ON c.contract_address = m.contract_address
      WHERE m.spike_flag IS NOT NULL
        AND m.created_at > datetime('now', '-30 minutes')
      ORDER BY m.snapshot_at_ms DESC
      LIMIT 30
    `).all();
    res.json({ ok: true, spikes: hot, count: hot.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
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
      try { return dbInstance.prepare(sql).get(...params).n; } catch { return 0; }
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
    let q = `SELECT id, contract_address, token, token_name,
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
          holders = await getTopHolders(ca, 100) ?? [];
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

        console.log(`[seed] ✓ Seeded ${walletSet.size} wallets for ${ca} — ALPHA:${counters.ALPHA} SMART:${counters.SMART_MONEY} MOMENTUM:${counters.MOMENTUM}`);

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
    res.json({ ok: true, candidate: cand, source: 'candidates' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
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
        const result = computeFullScore(c);
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
    const allowed = ['WIN', 'LOSS', 'PENDING'];
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
    logEvent('INFO', 'MANUAL_OUTCOME', `call=${id} outcome=${outcome}`);
    res.json({ ok: true, id, outcome, source: outcome === 'PENDING' ? null : 'MANUAL' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// On-demand snapshot refresh for a single call — user clicks "refresh peak"
// without waiting for the 15-min loop. Fetches DexScreener live and rolls peaks.
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
    res.json({
      ok:                  true,
      winRateByScore:      getWinRateByScoreBand(),
      winRateBySetup:      getWinRateBySetupType(),
      missedWinners:       getMissedWinners(),
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

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const message = req.body?.message;
  if (!message?.text) return;
  const chatId    = message.chat?.id;
  const fromId    = message.from?.id;
  if (!chatId) return;
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
      default: break;
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

app.get('/api/v8/learning-stats', (req, res) => {
  setCors(res);
  res.json({ ok: true, ...getLearningStats(dbInstance) });
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

    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      try {
        const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 'whales', method: 'getMultipleAccounts',
            // dataSlice length 0 means we only get lamports back — no data blob.
            // Keeps the response small and JSON-parse-safe.
            params: [chunk.map(w => w.address), {
              commitment: 'confirmed',
              encoding: 'base64',
              dataSlice: { offset: 0, length: 0 },
            }],
          }),
          signal: AbortSignal.timeout(12_000),
        });
        if (!r.ok) { console.warn(`[scan-whales] chunk ${i} HTTP ${r.status}`); continue; }
        const j = await r.json();
        const values = j?.result?.value || [];
        // Persist SOL balance to every scanned row so the Wallet Database
        // tiles can show it without re-querying Helius.
        const updSol = dbInstance.prepare(`
          UPDATE tracked_wallets
          SET sol_balance = ?, sol_scanned_at = datetime('now')
          WHERE address = ?
        `);
        for (let idx = 0; idx < values.length; idx++) {
          scannedCount++;
          const sol = (values[idx]?.lamports ?? 0) / 1e9;
          try { updSol.run(Number(sol.toFixed(6)), chunk[idx].address); } catch {}
          if (sol >= minSol) {
            if (sol >= 100) megaCount++;
            else if (sol >= 10) whaleCount++;
            whales.push({
              address:  chunk[idx].address,
              label:    chunk[idx].label || null,
              category: chunk[idx].category || 'NEUTRAL',
              solBalance: Number(sol.toFixed(4)),
            });
          }
        }
      } catch (err) {
        console.warn(`[scan-whales] chunk ${i} failed:`, err.message);
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
               sol_balance, sol_scanned_at
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

    res.json({ ok: true, wallets: rows, categories: cats, topWinners, duneStatus, total: rows.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
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
    if (!archived && !candidate && !call) return res.status(404).json({ ok: false, error: 'Token not found in any table' });

    const data = { ...archived, ...candidate, ...call };
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

    const userQuestion = question || 'Analyze this token deeply. What specific signals made it a strong/weak call? What patterns does it show that we should use to find similar winners/avoid similar losers in the future? What would you add to the scoring system based on this token?';

    const analyzePrompt = `You are the Pulse Caller AI learning engine. Study this token forensically to extract lessons and patterns.

${tokenContext}

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
      intelligence: {
        walletDbSize:     walletDB.walletDb.totalWallets,
        walletDbStale:    walletDB.walletDb.isStale,
        walletCategories: walletDB.walletDb.categories,
        deployerCount:    walletDB.deployerDb.totalDeployers,
        openaiConfigured: !!OPENAI_API_KEY,
        claudeConfigured: !!CLAUDE_API_KEY,
      },
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

  // ── Smart Money Watcher: live feed of WINNER-tier wallet buys ─────────────
  // Polls Helius Enhanced Transactions for the top N tracked wallets and
  // emits an alert when one (or a cluster of 3+) buys a fresh coin. The alert
  // runs that coin through the normal scoring pipeline with a forced tag so
  // the TG message is prefixed with a BIG WALLET / WHALE CLUSTER header.
  try {
    const { startSmartMoneyWatcher } = await import('./smart-money-watcher.js');
    startSmartMoneyWatcher(dbInstance, async ({ ca, kind, clusterSize }) => {
      try {
        console.log(`[smart-money→pipeline] $${ca.slice(0,8)} kind=${kind} cluster=${clusterSize} — pushing into processCandidate`);
        await processCandidate({
          contractAddress: ca,
          chain:           'solana',
          candidateType:   kind === 'cluster' ? 'SMART_MONEY_CLUSTER' : 'SMART_MONEY_SINGLE',
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

  // ── Pre-Launch Detector: watch exchange wallets for fresh dev funding ────
  try {
    const { startPreLaunchDetector } = await import('./pre-launch-detector.js');
    startPreLaunchDetector(dbInstance);
    console.log('[startup] ✓ Pre-launch detector active — 90s tick, watching exchange hot wallets');
  } catch (err) {
    console.warn('[startup] Pre-launch detector failed to start:', err.message);
  }

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

  await sendAdminAlert(
    `🐺 <b>Alpha Lennix v8.0 — MULTI-AGENT AI SYSTEM ONLINE</b>\n\n` +
    `<b>Detection:</b>\n` +
    `${HELIUS_API_KEY ? '✅ Helius WebSocket (~3s detection)' : '⚠️ DEXScreener polling (90s)'}\n` +
    `✅ Pump.fun pre-bonding monitor (45s)\n\n` +
    `<b>Intelligence:</b>\n` +
    `${walletDb.size() > 0 ? `✅ Wallet DB: ${walletDb.size()} wallets loaded` : '⏳ Wallet DB: loading from Dune...'}\n` +
    `✅ Claude forensic analysis (every candidate)\n` +
    `${OPENAI_API_KEY ? '✅ OpenAI GPT-4o final decisions' : '⚠️ OpenAI not configured'}\n\n` +
    `<b>Learning:</b>\n` +
    `✅ Auto outcome tracking (every 30min)\n` +
    `✅ Missed winner detection (every 6h)\n` +
    `✅ In-context learning from ${totalCalls} calls · ${resolved} resolved\n\n` +
    `<b>Mode:</b> ${activeMode.emoji} ${activeMode.name} · Score floor: 38 · Max MCap: $150K\n` +
    `<b>Target:</b> $10K–$25K pre-bonding gems · 10x+ upside`
  );
});

export default app; 
