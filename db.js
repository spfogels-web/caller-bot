/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  db.js — SQLite persistence layer v4
 *
 *  v4 additions:
 *    - RAILWAY_VOLUME_MOUNT_PATH already supported — just add the Volume in Railway
 *    - DATABASE_PATH env var also supported as fallback override
 *    - isRecentlySeen reads SEEN_TOKEN_COOLDOWN_HOURS env var (default 1h)
 *    - getDecisionBreakdown returns object (dashboard compatibility)
 *    - called_at column added to calls table
 *    - narrative_tags column added to candidates table
 *    - winner_wallets table added (for smart money tracking)
 *    - All v4 migrations run safely on existing databases
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Persistent DB Path ───────────────────────────────────────────────────────
// Priority order:
//   1. DATABASE_PATH env var (manual override)
//   2. RAILWAY_VOLUME_MOUNT_PATH (auto-set when you add a Railway Volume)
//   3. Local fallback (loses data on redeploy)
//
// TO PERSIST DATA: In Railway dashboard → your service → Volumes tab
//   → New Volume → Mount Path: /data
//   Railway auto-sets RAILWAY_VOLUME_MOUNT_PATH=/data
//   DB will save to /data/caller-bot.db and survive all deploys forever.

const DB_PATH = process.env.DATABASE_PATH
  ?? (process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'caller-bot.db')
      : path.join(__dirname, 'caller-bot.db'));

const IS_PERSISTENT = DB_PATH.startsWith('/data') || !!process.env.DATABASE_PATH;

console.log(`[DB] Path: ${DB_PATH}`);
console.log(`[DB] Persistent: ${IS_PERSISTENT
  ? '✓ YES — Railway Volume active'
  : '⚠️  NO — data lost on redeploy! Add a Railway Volume at /data'
}`);

// Ensure the directory exists before SQLite tries to open the file
// This is required when using Railway Volumes — the /data dir may not
// be created automatically on first deploy
const DB_DIR = path.dirname(DB_PATH);
try {
  mkdirSync(DB_DIR, { recursive: true });
  console.log(`[DB] Directory ready: ${DB_DIR}`);
} catch (err) {
  if (err.code !== 'EEXIST') {
    console.error(`[DB] Failed to create directory ${DB_DIR}:`, err.message);
  }
}

let db;

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initDb() {
  db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- ── candidates ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS candidates (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      evaluated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      token                 TEXT,
      contract_address      TEXT    NOT NULL,
      chain                 TEXT    NOT NULL DEFAULT 'solana',

      -- Market data
      market_cap            REAL,
      liquidity             REAL,
      volume_24h            REAL,
      price_usd             REAL,
      pair_age_hours        REAL,
      price_change_5m       REAL,
      price_change_1h       REAL,
      price_change_6h       REAL,
      price_change_24h      REAL,
      volume_quality        TEXT,
      chart_extended        INTEGER DEFAULT 0,
      social_score          INTEGER DEFAULT 0,
      website               TEXT,
      twitter               TEXT,
      telegram              TEXT,

      -- Holder data
      holders               INTEGER,
      top10_holder_pct      REAL,
      holder_growth_24h     REAL,
      insider_wallet_pct    REAL,
      sniper_wallet_count   INTEGER,

      -- Risk data
      dev_wallet_pct        REAL,
      bundle_risk           TEXT,
      bubble_map_risk       TEXT,
      deployer_risk         TEXT,
      wallet_cluster_risk   TEXT,
      rugcheck_score        INTEGER,
      mint_authority        INTEGER,
      freeze_authority      INTEGER,
      lp_locked             INTEGER,

      -- Wallet intel
      wallet_intel_score    INTEGER,
      cluster_risk          TEXT,
      coordination_intensity TEXT,
      momentum_grade        TEXT,
      linked_wallet_count   INTEGER,
      buy_velocity          REAL,
      unique_buyers_5min    INTEGER,
      survival_score        INTEGER,

      -- Scorer results
      composite_score       INTEGER,
      structure_grade       TEXT,
      setup_type            TEXT,
      stage                 TEXT,
      trap_triggered        INTEGER DEFAULT 0,
      trap_severity         TEXT,
      dynamic_threshold     INTEGER,

      -- Regime context
      market_regime         TEXT,
      regime_adjusted_score INTEGER,

      -- Enrichment quality
      birdeye_ok            INTEGER DEFAULT 0,
      helius_ok             INTEGER DEFAULT 0,
      rugcheck_ok           INTEGER DEFAULT 0,
      bubblemap_ok          INTEGER DEFAULT 0,

      -- Claude verdict
      claude_score          INTEGER,
      claude_risk           TEXT,
      claude_decision       TEXT,
      claude_setup_type     TEXT,
      claude_verdict        TEXT,
      claude_raw            TEXT,

      -- Final system decision
      final_decision        TEXT,
      posted                INTEGER DEFAULT 0,
      post_reason           TEXT,
      ignore_reason         TEXT,
      retest_count          INTEGER DEFAULT 0,

      -- v3: Launch intelligence
      launch_quality_score        REAL,
      launch_unique_buyer_ratio   REAL,
      launch_top_buyer_share      REAL,
      launch_top3_buyer_share     REAL,
      launch_tx_count             INTEGER,
      launch_unique_buyers        INTEGER,
      buy_sell_ratio_1h           REAL,
      buy_sell_ratio_6h           REAL,
      volume_velocity             REAL,
      breakout_score              REAL,
      recovery_score              REAL,
      holder_dist_score           REAL,
      fresh_wallet_inflows        INTEGER,
      bundle_risk_helius          TEXT,

      -- v3: Multi-bot tracking
      bot_source            TEXT,
      sltp                  TEXT,

      -- v4: Narrative tags + candidate metadata
      narrative_tags        TEXT,
      candidate_type        TEXT,
      quick_score           INTEGER,
      pair_address          TEXT
    );

    -- ── sub_scores ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sub_scores (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id          INTEGER NOT NULL REFERENCES candidates(id),
      evaluated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      contract_address      TEXT    NOT NULL,
      launch_quality        INTEGER,
      wallet_structure      INTEGER,
      market_behavior       INTEGER,
      social_narrative      INTEGER,
      launch_signals        TEXT,
      wallet_signals        TEXT,
      market_signals        TEXT,
      social_signals        TEXT,
      launch_penalties      TEXT,
      wallet_penalties      TEXT,
      market_penalties      TEXT,
      social_penalties      TEXT,
      trap_traps            TEXT,
      trap_severity         TEXT,
      threshold_value       INTEGER,
      threshold_reason      TEXT,
      structure_grade       TEXT
    );

    -- ── calls ───────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS calls (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id          INTEGER NOT NULL REFERENCES candidates(id),
      posted_at             TEXT    NOT NULL DEFAULT (datetime('now')),
      called_at             TEXT,
      token                 TEXT,
      contract_address      TEXT    NOT NULL,
      chain                 TEXT    NOT NULL DEFAULT 'solana',
      score_at_call         INTEGER,
      sub_scores_at_call    TEXT,
      risk_at_call          TEXT,
      setup_type_at_call    TEXT,
      structure_grade_at_call TEXT,
      price_at_call         REAL,
      market_cap_at_call    REAL,
      liquidity_at_call     REAL,
      regime_at_call        TEXT,
      price_1h              REAL,
      price_6h              REAL,
      price_24h             REAL,
      pct_change_1h         REAL,
      pct_change_6h         REAL,
      pct_change_24h        REAL,
      outcome               TEXT    DEFAULT 'PENDING',
      tracked_at            TEXT,
      winner_similarity     INTEGER,
      rug_similarity        INTEGER,
      bot_source            TEXT,
      sltp                  TEXT
    );

    -- ── deployer_reputation ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS deployer_reputation (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      deployer_address      TEXT    NOT NULL UNIQUE,
      first_seen_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      total_launches        INTEGER DEFAULT 1,
      successful_launches   INTEGER DEFAULT 0,
      rugged_launches       INTEGER DEFAULT 0,
      pending_launches      INTEGER DEFAULT 1,
      avg_score             REAL,
      reputation_grade      TEXT    DEFAULT 'UNKNOWN',
      risk_level            TEXT    DEFAULT 'UNKNOWN',
      flags                 TEXT,
      notes                 TEXT,
      updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- ── wallet_clusters ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS wallet_clusters (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      cluster_id            TEXT    NOT NULL UNIQUE,
      first_seen_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      wallet_count          INTEGER DEFAULT 0,
      wallet_addresses      TEXT,
      times_appeared        INTEGER DEFAULT 1,
      wins                  INTEGER DEFAULT 0,
      rugs                  INTEGER DEFAULT 0,
      avg_peak_gain         REAL,
      cluster_grade         TEXT    DEFAULT 'UNKNOWN',
      coordination_intensity TEXT,
      notes                 TEXT
    );

    -- ── winner_profiles ─────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS winner_profiles (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
      profile_type          TEXT    NOT NULL,
      sample_size           INTEGER DEFAULT 0,
      avg_composite_score   REAL,
      avg_launch_quality    REAL,
      avg_wallet_structure  REAL,
      avg_market_behavior   REAL,
      avg_social_narrative  REAL,
      avg_dev_wallet_pct    REAL,
      avg_top10_pct         REAL,
      avg_liquidity         REAL,
      avg_pair_age_hours    REAL,
      avg_holders           REAL,
      avg_holder_growth     REAL,
      avg_buy_velocity      REAL,
      common_structure_grades TEXT,
      common_setup_types      TEXT,
      common_bundle_risks     TEXT,
      common_narratives       TEXT,
      avg_threshold         REAL,
      min_score_seen        INTEGER,
      max_score_seen        INTEGER
    );

    -- ── winner_wallets ─────────────────────────────────────────────────────
    -- v4: Smart money wallet tracking
    CREATE TABLE IF NOT EXISTS winner_wallets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      address       TEXT    NOT NULL,
      token         TEXT,
      evaluated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      call_id       INTEGER REFERENCES calls(id),
      candidate_id  INTEGER REFERENCES candidates(id)
    );

    -- ── scanner_feed ─────────────────────────────────────────────────────────
    -- Every token the scanner sees, regardless of whether it passed filters
    -- This gives full visibility into what the bot is looking at
    CREATE TABLE IF NOT EXISTS scanner_feed (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      scanned_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      token             TEXT,
      contract_address  TEXT    NOT NULL,
      pair_address      TEXT,
      dex               TEXT,
      market_cap        REAL,
      liquidity         REAL,
      volume_24h        REAL,
      volume_1h         REAL,
      price_usd         REAL,
      pair_age_hours    REAL,
      stage             TEXT,
      price_change_5m   REAL,
      price_change_1h   REAL,
      price_change_24h  REAL,
      buys_1h           INTEGER,
      sells_1h          INTEGER,
      buy_ratio_1h      REAL,
      volume_velocity   REAL,
      quick_score       INTEGER,
      candidate_type    TEXT,
      filter_action     TEXT,    -- PROMOTE, WATCHLIST, SKIP, DEDUPED
      filter_reason     TEXT,
      website           TEXT,
      twitter           TEXT,
      telegram          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scanner_feed_ca      ON scanner_feed(contract_address);
    CREATE INDEX IF NOT EXISTS idx_scanner_feed_scanned ON scanner_feed(scanned_at);
    CREATE INDEX IF NOT EXISTS idx_scanner_feed_action  ON scanner_feed(filter_action);

    -- ── seen_tokens ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS seen_tokens (
      contract_address      TEXT    PRIMARY KEY,
      first_seen_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      last_seen_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      times_seen            INTEGER NOT NULL DEFAULT 1,
      was_posted            INTEGER NOT NULL DEFAULT 0
    );

    -- ── system_log ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS system_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      logged_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      level       TEXT    NOT NULL DEFAULT 'INFO',
      event       TEXT    NOT NULL,
      detail      TEXT
    );

    -- ── Indexes ─────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_candidates_ca        ON candidates(contract_address);
    CREATE INDEX IF NOT EXISTS idx_candidates_score     ON candidates(claude_score);
    CREATE INDEX IF NOT EXISTS idx_candidates_decision  ON candidates(final_decision);
    CREATE INDEX IF NOT EXISTS idx_candidates_stage     ON candidates(stage);
    CREATE INDEX IF NOT EXISTS idx_candidates_bot       ON candidates(bot_source);
    CREATE INDEX IF NOT EXISTS idx_sub_scores_ca        ON sub_scores(contract_address);
    CREATE INDEX IF NOT EXISTS idx_calls_ca             ON calls(contract_address);
    CREATE INDEX IF NOT EXISTS idx_calls_posted_at      ON calls(posted_at);
    CREATE INDEX IF NOT EXISTS idx_calls_outcome        ON calls(outcome);
    CREATE INDEX IF NOT EXISTS idx_calls_bot            ON calls(bot_source);
    CREATE INDEX IF NOT EXISTS idx_deployer_address     ON deployer_reputation(deployer_address);
    CREATE INDEX IF NOT EXISTS idx_winner_wallets_addr  ON winner_wallets(address);
    CREATE INDEX IF NOT EXISTS idx_system_log_level     ON system_log(level);
    CREATE INDEX IF NOT EXISTS idx_system_log_event     ON system_log(event);
  `);

  runMigrations();

  console.log(`[db] v4 Initialized — ${DB_PATH}`);
  return db;
}

// ─── Migration Runner ─────────────────────────────────────────────────────────
// Safe — ignores "duplicate column name" errors for already-migrated DBs

function runMigrations() {
  const migrations = [
    // v2 migrations
    `ALTER TABLE candidates ADD COLUMN wallet_intel_score INTEGER`,
    `ALTER TABLE candidates ADD COLUMN cluster_risk TEXT`,
    `ALTER TABLE candidates ADD COLUMN coordination_intensity TEXT`,
    `ALTER TABLE candidates ADD COLUMN momentum_grade TEXT`,
    `ALTER TABLE candidates ADD COLUMN linked_wallet_count INTEGER`,
    `ALTER TABLE candidates ADD COLUMN buy_velocity REAL`,
    `ALTER TABLE candidates ADD COLUMN unique_buyers_5min INTEGER`,
    `ALTER TABLE candidates ADD COLUMN survival_score INTEGER`,
    `ALTER TABLE candidates ADD COLUMN composite_score INTEGER`,
    `ALTER TABLE candidates ADD COLUMN structure_grade TEXT`,
    `ALTER TABLE candidates ADD COLUMN setup_type TEXT`,
    `ALTER TABLE candidates ADD COLUMN stage TEXT`,
    `ALTER TABLE candidates ADD COLUMN trap_triggered INTEGER DEFAULT 0`,
    `ALTER TABLE candidates ADD COLUMN trap_severity TEXT`,
    `ALTER TABLE candidates ADD COLUMN dynamic_threshold INTEGER`,
    `ALTER TABLE candidates ADD COLUMN market_regime TEXT`,
    `ALTER TABLE candidates ADD COLUMN regime_adjusted_score INTEGER`,
    `ALTER TABLE candidates ADD COLUMN retest_count INTEGER DEFAULT 0`,
    `ALTER TABLE calls ADD COLUMN sub_scores_at_call TEXT`,
    `ALTER TABLE calls ADD COLUMN setup_type_at_call TEXT`,
    `ALTER TABLE calls ADD COLUMN structure_grade_at_call TEXT`,
    `ALTER TABLE calls ADD COLUMN regime_at_call TEXT`,
    `ALTER TABLE calls ADD COLUMN winner_similarity INTEGER`,
    `ALTER TABLE calls ADD COLUMN rug_similarity INTEGER`,
    // v3 migrations
    `ALTER TABLE candidates ADD COLUMN launch_quality_score REAL`,
    `ALTER TABLE candidates ADD COLUMN launch_unique_buyer_ratio REAL`,
    `ALTER TABLE candidates ADD COLUMN launch_top_buyer_share REAL`,
    `ALTER TABLE candidates ADD COLUMN launch_top3_buyer_share REAL`,
    `ALTER TABLE candidates ADD COLUMN launch_tx_count INTEGER`,
    `ALTER TABLE candidates ADD COLUMN launch_unique_buyers INTEGER`,
    `ALTER TABLE candidates ADD COLUMN buy_sell_ratio_1h REAL`,
    `ALTER TABLE candidates ADD COLUMN buy_sell_ratio_6h REAL`,
    `ALTER TABLE candidates ADD COLUMN volume_velocity REAL`,
    `ALTER TABLE candidates ADD COLUMN breakout_score REAL`,
    `ALTER TABLE candidates ADD COLUMN recovery_score REAL`,
    `ALTER TABLE candidates ADD COLUMN holder_dist_score REAL`,
    `ALTER TABLE candidates ADD COLUMN fresh_wallet_inflows INTEGER`,
    `ALTER TABLE candidates ADD COLUMN bundle_risk_helius TEXT`,
    `ALTER TABLE candidates ADD COLUMN bot_source TEXT`,
    `ALTER TABLE candidates ADD COLUMN sltp TEXT`,
    `ALTER TABLE calls ADD COLUMN bot_source TEXT`,
    `ALTER TABLE calls ADD COLUMN sltp TEXT`,
    // v4 migrations — new columns needed by server.js v6
    `ALTER TABLE candidates ADD COLUMN narrative_tags TEXT`,
    `ALTER TABLE candidates ADD COLUMN candidate_type TEXT`,
    `ALTER TABLE candidates ADD COLUMN quick_score INTEGER`,
    `ALTER TABLE candidates ADD COLUMN pair_address TEXT`,
    `ALTER TABLE calls ADD COLUMN called_at TEXT`,
    // winner_wallets table (created in schema above, index here)
    `CREATE INDEX IF NOT EXISTS idx_winner_wallets_addr ON winner_wallets(address)`,
    // v4: scanner_feed table
    `CREATE TABLE IF NOT EXISTS scanner_feed (id INTEGER PRIMARY KEY AUTOINCREMENT, scanned_at TEXT NOT NULL DEFAULT (datetime('now')), token TEXT, contract_address TEXT NOT NULL, pair_address TEXT, dex TEXT, market_cap REAL, liquidity REAL, volume_24h REAL, volume_1h REAL, price_usd REAL, pair_age_hours REAL, stage TEXT, price_change_5m REAL, price_change_1h REAL, price_change_24h REAL, buys_1h INTEGER, sells_1h INTEGER, buy_ratio_1h REAL, volume_velocity REAL, quick_score INTEGER, candidate_type TEXT, filter_action TEXT, filter_reason TEXT, website TEXT, twitter TEXT, telegram TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_scanner_feed_ca ON scanner_feed(contract_address)`,
    `CREATE INDEX IF NOT EXISTS idx_scanner_feed_scanned ON scanner_feed(scanned_at)`,
    `CREATE INDEX IF NOT EXISTS idx_scanner_feed_action ON scanner_feed(filter_action)`,
    // Clean old scanner_feed rows older than 2 hours to prevent bloat
    `DELETE FROM scanner_feed WHERE scanned_at < datetime('now', '-2 hours')`,
    // ── High-resolution detection timestamps (ms precision) for latency tracking ──
    `ALTER TABLE candidates ADD COLUMN detected_at_ms INTEGER`,
    `ALTER TABLE candidates ADD COLUMN enriched_at_ms INTEGER`,
    `ALTER TABLE candidates ADD COLUMN scored_at_ms INTEGER`,
    `ALTER TABLE candidates ADD COLUMN posted_at_ms INTEGER`,
    `ALTER TABLE scanner_feed ADD COLUMN detected_at_ms INTEGER`,
    // ── Momentum tracker: track rapid price/volume spikes on active candidates ──
    `CREATE TABLE IF NOT EXISTS momentum_snapshots (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_address TEXT    NOT NULL,
      snapshot_at_ms   INTEGER NOT NULL,
      market_cap       REAL,
      liquidity        REAL,
      price_usd        REAL,
      volume_5m        REAL,
      buys_5m          INTEGER,
      sells_5m         INTEGER,
      delta_mcap_pct   REAL,
      spike_flag       TEXT,     -- PRICE_SPIKE | VOLUME_SPIKE | BREAKOUT | null
      created_at       TEXT    DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_momentum_ca   ON momentum_snapshots(contract_address)`,
    `CREATE INDEX IF NOT EXISTS idx_momentum_time ON momentum_snapshots(snapshot_at_ms DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_momentum_spike ON momentum_snapshots(spike_flag)`,
    // Keep momentum history bounded — drop older than 6h
    `DELETE FROM momentum_snapshots WHERE created_at < datetime('now', '-6 hours')`,
    // ── Dev behavioral fingerprints ──
    `CREATE TABLE IF NOT EXISTS dev_fingerprints (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      deployer_address    TEXT    NOT NULL UNIQUE,
      total_launches      INTEGER DEFAULT 0,
      wins                INTEGER DEFAULT 0,
      losses              INTEGER DEFAULT 0,
      pending             INTEGER DEFAULT 0,
      avg_peak_multiple   REAL,
      best_peak_multiple  REAL,
      worst_loss_multiple REAL,
      avg_composite_score REAL,
      win_rate            REAL,
      fingerprint_score   INTEGER,     -- 0-100 trust score
      grade               TEXT,        -- ELITE | PROVEN | NEUTRAL | SUSPECT | RUGGER
      first_seen_at       TEXT,
      last_launch_at      TEXT,
      tags                TEXT,        -- JSON: patterns spotted
      refreshed_at        TEXT    DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_devfp_addr  ON dev_fingerprints(deployer_address)`,
    `CREATE INDEX IF NOT EXISTS idx_devfp_grade ON dev_fingerprints(grade)`,
    `CREATE INDEX IF NOT EXISTS idx_devfp_score ON dev_fingerprints(fingerprint_score DESC)`,
    // ── Pre-launch suspect wallets (funded by exchanges, could be new devs) ──
    `CREATE TABLE IF NOT EXISTS prelaunch_suspects (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet          TEXT    NOT NULL,
      funded_at       TEXT    NOT NULL,
      funded_amount   REAL,
      source_exchange TEXT,
      expires_at      TEXT    NOT NULL,   -- 6h after funded_at
      consumed        INTEGER DEFAULT 0,  -- 1 if we've seen them launch a token
      launched_ca     TEXT,
      created_at      TEXT    DEFAULT (datetime('now'))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_prelaunch_wallet ON prelaunch_suspects(wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_prelaunch_expires     ON prelaunch_suspects(expires_at)`,
    `CREATE INDEX IF NOT EXISTS idx_prelaunch_consumed    ON prelaunch_suspects(consumed)`,
    `DELETE FROM prelaunch_suspects WHERE expires_at < datetime('now')`,
    // ── Cross-chain migration matches (ETH/Base → Solana) ──
    `CREATE TABLE IF NOT EXISTS crosschain_matches (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      sol_contract        TEXT    NOT NULL,
      source_chain        TEXT    NOT NULL,   -- 'ethereum' | 'base'
      source_contract     TEXT,
      match_type          TEXT    NOT NULL,   -- 'symbol' | 'name' | 'exact'
      match_confidence    REAL,
      source_symbol       TEXT,
      source_price_change REAL,
      detected_at         TEXT    DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_crosschain_sol ON crosschain_matches(sol_contract)`,
    `DELETE FROM crosschain_matches WHERE detected_at < datetime('now', '-7 days')`,
    // ── OpenAI final-authority decision columns ──
    `ALTER TABLE candidates ADD COLUMN openai_decision TEXT`,
    `ALTER TABLE candidates ADD COLUMN openai_conviction INTEGER`,
    `ALTER TABLE candidates ADD COLUMN openai_verdict TEXT`,
    `ALTER TABLE candidates ADD COLUMN openai_agrees_with_claude INTEGER`,
    `ALTER TABLE candidates ADD COLUMN openai_raw TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_candidates_openai ON candidates(openai_decision)`,
    // ── Outcome tracking upgrade: snapshots, peaks, time-to-peak, manual override ──
    `ALTER TABLE calls ADD COLUMN peak_mcap REAL`,
    `ALTER TABLE calls ADD COLUMN peak_multiple REAL`,
    `ALTER TABLE calls ADD COLUMN peak_at TEXT`,
    `ALTER TABLE calls ADD COLUMN peak_mcap_1h REAL`,
    `ALTER TABLE calls ADD COLUMN peak_mcap_3h REAL`,
    `ALTER TABLE calls ADD COLUMN peak_mcap_6h REAL`,
    `ALTER TABLE calls ADD COLUMN time_to_peak_minutes INTEGER`,
    `ALTER TABLE calls ADD COLUMN outcome_source TEXT`,
    `ALTER TABLE calls ADD COLUMN outcome_set_at TEXT`,
    `ALTER TABLE calls ADD COLUMN last_snapshot_at TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_calls_outcome_source ON calls(outcome_source)`,
    // ── SOL balance cache on tracked_wallets ──
    `ALTER TABLE tracked_wallets ADD COLUMN sol_balance REAL`,
    `ALTER TABLE tracked_wallets ADD COLUMN sol_scanned_at TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_tw_sol_balance ON tracked_wallets(sol_balance DESC)`,
    // ── Cross-CA overlap tracking ──
    `ALTER TABLE tracked_wallets ADD COLUMN ca_count INTEGER DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS wallet_appearances (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       address    TEXT NOT NULL,
       ca         TEXT NOT NULL,
       scanned_at TEXT DEFAULT (datetime('now')),
       UNIQUE(address, ca)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_wa_address ON wallet_appearances(address)`,
    // ── Wallet activity log — every buy detected by the smart-money watcher ──
    // Populated in real-time as the top-200 tracked wallets swap. Lets the
    // oracle answer "show me every token wallet X bought this week" or
    // "which wallets are accumulating $MEME right now".
    `CREATE TABLE IF NOT EXISTS wallet_activity (
       id              INTEGER PRIMARY KEY AUTOINCREMENT,
       wallet_address  TEXT    NOT NULL,
       token_mint      TEXT    NOT NULL,
       tx_signature    TEXT    NOT NULL,
       side            TEXT    NOT NULL DEFAULT 'BUY',
       token_amount    REAL,
       block_time      INTEGER,
       detected_at     TEXT    DEFAULT (datetime('now')),
       UNIQUE(tx_signature, wallet_address)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_wact_wallet      ON wallet_activity(wallet_address, block_time DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_wact_token       ON wallet_activity(token_mint, block_time DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_wact_detected_at ON wallet_activity(detected_at DESC)`,
    // Keep history bounded — 30 days is plenty for cluster analysis
    `DELETE FROM wallet_activity WHERE detected_at < datetime('now', '-30 days')`,
    // Highest milestone we've already pinged for a given call so we don't
    // re-alert on every tick — only when a bigger tier (2x/5x/10x) is hit.
    `ALTER TABLE calls ADD COLUMN milestone_alerted REAL DEFAULT 0`,
    // Deep bundle-detector cache — stores funder-trace results per CA so
    // we don't re-hit Helius every time we see the coin. 24h TTL via the
    // checked_at timestamp.
    `CREATE TABLE IF NOT EXISTS bundle_checks (
       contract_address TEXT PRIMARY KEY,
       is_bundled       INTEGER NOT NULL DEFAULT 0,
       buyer_count      INTEGER,
       funder_overlap   INTEGER,
       top_funder       TEXT,
       signals          TEXT,
       checked_at       TEXT DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS idx_bundle_checks_at ON bundle_checks(checked_at DESC)`,
    `DELETE FROM bundle_checks WHERE checked_at < datetime('now', '-7 days')`,
    // v9: Foundation Signals scoring data
    `ALTER TABLE candidates ADD COLUMN dual_parts TEXT`,
    `ALTER TABLE candidates ADD COLUMN discovery_score INTEGER`,
    `ALTER TABLE candidates ADD COLUMN model_used TEXT`,
    // v9: Outcome tracker columns
    `ALTER TABLE calls ADD COLUMN auto_resolved INTEGER DEFAULT 0`,
    `ALTER TABLE calls ADD COLUMN auto_resolved_at TEXT`,
    `ALTER TABLE calls ADD COLUMN outcome_source TEXT`,
    `ALTER TABLE calls ADD COLUMN outcome_set_at TEXT`,
    `ALTER TABLE calls ADD COLUMN peak_at TEXT`,
    `ALTER TABLE calls ADD COLUMN time_to_peak_minutes INTEGER`,
    `ALTER TABLE calls ADD COLUMN peak_mcap_1h REAL`,
    `ALTER TABLE calls ADD COLUMN peak_mcap_3h REAL`,
    `ALTER TABLE calls ADD COLUMN peak_mcap_6h REAL`,
    `ALTER TABLE calls ADD COLUMN last_snapshot_at TEXT`,
    `ALTER TABLE calls ADD COLUMN peak_mcap REAL`,
  ];

  let added = 0;
  for (const sql of migrations) {
    try {
      db.exec(sql);
      added++;
    } catch (err) {
      // Silently skip duplicate column / already-exists errors
      if (!err.message.includes('duplicate column name') &&
          !err.message.includes('already exists')) {
        console.warn(`[db] Migration note: ${err.message}`);
      }
    }
  }

  console.log(`[db] Migrations complete (${added} statements processed)`);
}

// ─── Candidate Operations ─────────────────────────────────────────────────────

export function insertCandidate(data) {
  const stmt = db.prepare(`
    INSERT INTO candidates (
      token, contract_address, chain,
      market_cap, liquidity, volume_24h, price_usd, pair_age_hours,
      price_change_5m, price_change_1h, price_change_6h, price_change_24h,
      volume_quality, chart_extended, social_score,
      website, twitter, telegram,
      holders, top10_holder_pct, holder_growth_24h,
      insider_wallet_pct, sniper_wallet_count,
      dev_wallet_pct, bundle_risk, bubble_map_risk, deployer_risk,
      wallet_cluster_risk, rugcheck_score, mint_authority, freeze_authority, lp_locked,
      wallet_intel_score, cluster_risk, coordination_intensity, momentum_grade,
      linked_wallet_count, buy_velocity, unique_buyers_5min, survival_score,
      composite_score, structure_grade, setup_type, stage,
      trap_triggered, trap_severity, dynamic_threshold,
      market_regime, regime_adjusted_score,
      birdeye_ok, helius_ok, rugcheck_ok, bubblemap_ok,
      claude_score, claude_risk, claude_decision, claude_setup_type,
      claude_verdict, claude_raw,
      final_decision, posted, post_reason, ignore_reason, retest_count,
      launch_quality_score, launch_unique_buyer_ratio,
      launch_top_buyer_share, launch_top3_buyer_share,
      launch_tx_count, launch_unique_buyers,
      buy_sell_ratio_1h, buy_sell_ratio_6h, volume_velocity,
      breakout_score, recovery_score, holder_dist_score,
      fresh_wallet_inflows, bundle_risk_helius,
      bot_source, sltp,
      narrative_tags, candidate_type, quick_score, pair_address,
      openai_decision, openai_conviction, openai_verdict, openai_agrees_with_claude, openai_raw
    ) VALUES (
      @token, @contract_address, @chain,
      @market_cap, @liquidity, @volume_24h, @price_usd, @pair_age_hours,
      @price_change_5m, @price_change_1h, @price_change_6h, @price_change_24h,
      @volume_quality, @chart_extended, @social_score,
      @website, @twitter, @telegram,
      @holders, @top10_holder_pct, @holder_growth_24h,
      @insider_wallet_pct, @sniper_wallet_count,
      @dev_wallet_pct, @bundle_risk, @bubble_map_risk, @deployer_risk,
      @wallet_cluster_risk, @rugcheck_score, @mint_authority, @freeze_authority, @lp_locked,
      @wallet_intel_score, @cluster_risk, @coordination_intensity, @momentum_grade,
      @linked_wallet_count, @buy_velocity, @unique_buyers_5min, @survival_score,
      @composite_score, @structure_grade, @setup_type, @stage,
      @trap_triggered, @trap_severity, @dynamic_threshold,
      @market_regime, @regime_adjusted_score,
      @birdeye_ok, @helius_ok, @rugcheck_ok, @bubblemap_ok,
      @claude_score, @claude_risk, @claude_decision, @claude_setup_type,
      @claude_verdict, @claude_raw,
      @final_decision, @posted, @post_reason, @ignore_reason, @retest_count,
      @launch_quality_score, @launch_unique_buyer_ratio,
      @launch_top_buyer_share, @launch_top3_buyer_share,
      @launch_tx_count, @launch_unique_buyers,
      @buy_sell_ratio_1h, @buy_sell_ratio_6h, @volume_velocity,
      @breakout_score, @recovery_score, @holder_dist_score,
      @fresh_wallet_inflows, @bundle_risk_helius,
      @bot_source, @sltp,
      @narrative_tags, @candidate_type, @quick_score, @pair_address,
      @openai_decision, @openai_conviction, @openai_verdict, @openai_agrees_with_claude, @openai_raw
    )
  `);

  const sltpStr = data.sltp
    ? (typeof data.sltp === 'string' ? data.sltp : JSON.stringify(data.sltp))
    : null;

  const narrativeTagsStr = (() => {
    if (!data.narrativeTags) return null;
    if (typeof data.narrativeTags === 'string') return data.narrativeTags;
    return data.narrativeTags.join(',');
  })();

  const result = stmt.run({
    token:                  data.token                     ?? null,
    contract_address:       data.contractAddress           ?? '',
    chain:                  data.chain                     ?? 'solana',
    market_cap:             data.marketCap                 ?? null,
    liquidity:              data.liquidity                 ?? null,
    volume_24h:             data.volume24h                 ?? null,
    price_usd:              data.priceUsd                  ?? null,
    pair_age_hours:         data.pairAgeHours              ?? null,
    price_change_5m:        data.priceChange5m             ?? null,
    price_change_1h:        data.priceChange1h             ?? null,
    price_change_6h:        data.priceChange6h             ?? null,
    price_change_24h:       data.priceChange24h            ?? null,
    volume_quality:         data.volumeQuality             ?? null,
    chart_extended:         data.chartExtended             ? 1 : 0,
    social_score:           data.socialScore               ?? 0,
    website:                data.website ?? data.socials?.website   ?? null,
    twitter:                data.twitter ?? data.socials?.twitter   ?? null,
    telegram:               data.telegram ?? data.socials?.telegram ?? null,
    holders:                data.holders                   ?? null,
    top10_holder_pct:       data.top10HolderPct            ?? null,
    holder_growth_24h:      data.holderGrowth24h           ?? null,
    insider_wallet_pct:     data.insiderWalletPct          ?? null,
    sniper_wallet_count:    data.sniperWalletCount         ?? null,
    dev_wallet_pct:         data.devWalletPct              ?? null,
    bundle_risk:            data.bundleRisk                ?? null,
    bubble_map_risk:        data.bubbleMapRisk             ?? null,
    deployer_risk:          data.deployerHistoryRisk       ?? null,
    wallet_cluster_risk:    data.walletClusterRisk         ?? null,
    rugcheck_score:         data.rugcheckScore             ?? null,
    mint_authority:         data.mintAuthority             ?? null,
    freeze_authority:       data.freezeAuthority           ?? null,
    lp_locked:              data.lpLocked                  ?? null,
    wallet_intel_score:     data.walletIntelScore          ?? null,
    cluster_risk:           data.clusterRisk               ?? null,
    coordination_intensity: data.coordinationIntensity     ?? null,
    momentum_grade:         data.momentumGrade             ?? null,
    linked_wallet_count:    data.linkedWalletCount         ?? null,
    buy_velocity:           data.buyVelocity               ?? null,
    unique_buyers_5min:     data.uniqueBuyers5min          ?? null,
    survival_score:         data.survivalScore             ?? null,
    composite_score:        data.compositeScore            ?? null,
    structure_grade:        data.structureGrade            ?? null,
    setup_type:             data.setupType                 ?? null,
    stage:                  data.stage                     ?? null,
    trap_triggered:         data.trapTriggered             ? 1 : 0,
    trap_severity:          data.trapSeverity              ?? null,
    dynamic_threshold:      data.dynamicThreshold          ?? null,
    market_regime:          data.marketRegime              ?? null,
    regime_adjusted_score:  data.regimeAdjustedScore       ?? null,
    birdeye_ok:             data.birdeyeOk                 ? 1 : 0,
    helius_ok:              data.heliusOk                  ? 1 : 0,
    rugcheck_ok:            data.rugcheckOk                ? 1 : 0,
    bubblemap_ok:           data.bubblemapOk               ? 1 : 0,
    claude_score:           data.claudeScore               ?? null,
    claude_risk:            data.claudeRisk                ?? null,
    claude_decision:        data.claudeDecision            ?? null,
    claude_setup_type:      data.claudeSetupType           ?? null,
    claude_verdict:         data.claudeVerdict             ?? null,
    claude_raw:             data.claudeRaw                 ?? null,
    final_decision:         data.finalDecision             ?? 'IGNORE',
    posted:                 data.posted                    ? 1 : 0,
    post_reason:            data.postReason                ?? null,
    ignore_reason:          data.ignoreReason              ?? null,
    retest_count:           data.retestCount               ?? 0,
    launch_quality_score:       data.launchQualityScore        ?? null,
    launch_unique_buyer_ratio:  data.launchUniqueBuyerRatio    ?? null,
    launch_top_buyer_share:     data.launchTopBuyerShare       ?? null,
    launch_top3_buyer_share:    data.launchTop3BuyerShare      ?? null,
    launch_tx_count:            data.launchTxCount             ?? null,
    launch_unique_buyers:       data.launchUniqueBuyerCount    ?? null,
    buy_sell_ratio_1h:          data.buySellRatio1h            ?? null,
    buy_sell_ratio_6h:          data.buySellRatio6h            ?? null,
    volume_velocity:            data.volumeVelocity            ?? null,
    breakout_score:             data.breakoutContinuationScore ?? null,
    recovery_score:             data.firstDumpRecoveryScore    ?? null,
    holder_dist_score:          data.holderDistributionScore   ?? null,
    fresh_wallet_inflows:       data.freshWalletInflows        ? 1 : 0,
    bundle_risk_helius:         data.bundleRisk_helius         ?? null,
    bot_source:                 data.botSource                 ?? null,
    sltp:                       sltpStr,
    narrative_tags:             narrativeTagsStr,
    candidate_type:             data.candidateType             ?? null,
    quick_score:                data.quickScore                ?? null,
    pair_address:               data.pairAddress               ?? null,
    openai_decision:            data.openaiDecision            ?? null,
    openai_conviction:          data.openaiConviction          ?? null,
    openai_verdict:             data.openaiVerdict             ?? null,
    openai_agrees_with_claude:  data.openaiAgreesWithClaude === true  ? 1
                              : data.openaiAgreesWithClaude === false ? 0
                              : null,
    openai_raw:                 data.openaiRaw                 ?? null,
  });

  return result.lastInsertRowid;
}

export function markCandidatePosted(candidateId) {
  db.prepare(`UPDATE candidates SET posted = 1 WHERE id = ?`).run(candidateId);
}

// ─── Sub-Score Operations ─────────────────────────────────────────────────────

export function insertSubScores(candidateId, contractAddress, scoreResult) {
  const stmt = db.prepare(`
    INSERT INTO sub_scores (
      candidate_id, contract_address,
      launch_quality, wallet_structure, market_behavior, social_narrative,
      launch_signals, wallet_signals, market_signals, social_signals,
      launch_penalties, wallet_penalties, market_penalties, social_penalties,
      trap_traps, trap_severity,
      threshold_value, threshold_reason, structure_grade
    ) VALUES (
      @candidate_id, @contract_address,
      @launch_quality, @wallet_structure, @market_behavior, @social_narrative,
      @launch_signals, @wallet_signals, @market_signals, @social_signals,
      @launch_penalties, @wallet_penalties, @market_penalties, @social_penalties,
      @trap_traps, @trap_severity,
      @threshold_value, @threshold_reason, @structure_grade
    )
  `);

  stmt.run({
    candidate_id:      candidateId,
    contract_address:  contractAddress,
    launch_quality:    scoreResult.subScores?.launchQuality   ?? null,
    wallet_structure:  scoreResult.subScores?.walletStructure ?? null,
    market_behavior:   scoreResult.subScores?.marketBehavior  ?? null,
    social_narrative:  scoreResult.subScores?.socialNarrative ?? null,
    launch_signals:    JSON.stringify(scoreResult.signals?.launch   ?? []),
    wallet_signals:    JSON.stringify(scoreResult.signals?.wallet   ?? []),
    market_signals:    JSON.stringify(scoreResult.signals?.market   ?? []),
    social_signals:    JSON.stringify(scoreResult.signals?.social   ?? []),
    launch_penalties:  JSON.stringify(scoreResult.penalties?.launch  ?? []),
    wallet_penalties:  JSON.stringify(scoreResult.penalties?.wallet  ?? []),
    market_penalties:  JSON.stringify(scoreResult.penalties?.market  ?? []),
    social_penalties:  JSON.stringify(scoreResult.penalties?.social  ?? []),
    trap_traps:        JSON.stringify(scoreResult.trapDetector?.traps ?? []),
    trap_severity:     scoreResult.trapDetector?.severity ?? null,
    threshold_value:   scoreResult.threshold              ?? null,
    threshold_reason:  scoreResult.thresholdReason        ?? null,
    structure_grade:   scoreResult.structureGrade         ?? null,
  });
}

export function getSubScores(candidateId) {
  const row = db.prepare(`SELECT * FROM sub_scores WHERE candidate_id = ?`).get(candidateId);
  if (!row) return null;
  for (const field of ['launch_signals','wallet_signals','market_signals','social_signals',
                       'launch_penalties','wallet_penalties','market_penalties','social_penalties',
                       'trap_traps']) {
    try { row[field] = JSON.parse(row[field] ?? '[]'); } catch { row[field] = []; }
  }
  return row;
}

// ─── Call Operations ──────────────────────────────────────────────────────────

export function insertCall(data) {
  const sltpStr = data.sltp
    ? (typeof data.sltp === 'string' ? data.sltp : JSON.stringify(data.sltp))
    : null;

  const stmt = db.prepare(`
    INSERT INTO calls (
      candidate_id, token, contract_address, chain,
      score_at_call, sub_scores_at_call, risk_at_call,
      setup_type_at_call, structure_grade_at_call,
      price_at_call, market_cap_at_call, liquidity_at_call,
      regime_at_call, outcome,
      bot_source, sltp, called_at
    ) VALUES (
      @candidate_id, @token, @contract_address, @chain,
      @score_at_call, @sub_scores_at_call, @risk_at_call,
      @setup_type_at_call, @structure_grade_at_call,
      @price_at_call, @market_cap_at_call, @liquidity_at_call,
      @regime_at_call, 'PENDING',
      @bot_source, @sltp, @called_at
    )
  `);

  const result = stmt.run({
    candidate_id:            data.candidateId              ?? null,
    token:                   data.token                    ?? null,
    contract_address:        data.contractAddress          ?? '',
    chain:                   data.chain                    ?? 'solana',
    score_at_call:           data.score                    ?? null,
    sub_scores_at_call:      data.subScores ? JSON.stringify(data.subScores) : null,
    risk_at_call:            data.risk                     ?? null,
    setup_type_at_call:      data.setupType                ?? null,
    structure_grade_at_call: data.structureGrade           ?? null,
    price_at_call:           data.priceUsd                 ?? null,
    market_cap_at_call:      data.marketCap                ?? null,
    liquidity_at_call:       data.liquidity                ?? null,
    regime_at_call:          data.marketRegime             ?? null,
    bot_source:              data.botSource                ?? null,
    sltp:                    sltpStr,
    called_at:               data.called_at                ?? new Date().toISOString(),
  });

  return result.lastInsertRowid;
}

export function updateCallPerformance(callId, data) {
  db.prepare(`
    UPDATE calls SET
      price_1h       = @price_1h,
      price_6h       = @price_6h,
      price_24h      = @price_24h,
      pct_change_1h  = @pct_change_1h,
      pct_change_6h  = @pct_change_6h,
      pct_change_24h = @pct_change_24h,
      outcome        = @outcome,
      tracked_at     = datetime('now')
    WHERE id = @id
  `).run({ id: callId, ...data });
}

// ─── Deployer Reputation ──────────────────────────────────────────────────────

export function upsertDeployerReputation(deployerAddress, data) {
  if (!deployerAddress) return;
  const existing = db.prepare(
    `SELECT * FROM deployer_reputation WHERE deployer_address = ?`
  ).get(deployerAddress);

  if (existing) {
    db.prepare(`
      UPDATE deployer_reputation SET
        last_seen_at    = datetime('now'),
        total_launches  = total_launches + 1,
        pending_launches = pending_launches + 1,
        risk_level      = @risk_level,
        flags           = @flags,
        notes           = @notes,
        updated_at      = datetime('now')
      WHERE deployer_address = @deployer_address
    `).run({
      deployer_address: deployerAddress,
      risk_level:       data.riskLevel ?? existing.risk_level,
      flags:            JSON.stringify(data.flags ?? []),
      notes:            data.notes ?? existing.notes,
    });
  } else {
    db.prepare(`
      INSERT INTO deployer_reputation (
        deployer_address, risk_level, reputation_grade, flags, notes
      ) VALUES (
        @deployer_address, @risk_level, @reputation_grade, @flags, @notes
      )
    `).run({
      deployer_address:  deployerAddress,
      risk_level:        data.riskLevel        ?? 'UNKNOWN',
      reputation_grade:  data.reputationGrade  ?? 'UNKNOWN',
      flags:             JSON.stringify(data.flags ?? []),
      notes:             data.notes            ?? null,
    });
  }
}

export function updateDeployerOutcome(deployerAddress, outcome) {
  if (!deployerAddress) return;
  const field = outcome === 'WIN' ? 'successful_launches'
    : outcome === 'LOSS'          ? 'rugged_launches'
    : null;
  if (!field) return;

  db.prepare(`
    UPDATE deployer_reputation SET
      ${field} = ${field} + 1,
      pending_launches = MAX(0, pending_launches - 1),
      reputation_grade = CASE
        WHEN rugged_launches >= 3 THEN 'SERIAL_RUGGER'
        WHEN rugged_launches >= 1 THEN 'FLAGGED'
        WHEN successful_launches >= 3 THEN 'ELITE'
        WHEN successful_launches >= 1 THEN 'CLEAN'
        ELSE 'NEUTRAL'
      END,
      updated_at = datetime('now')
    WHERE deployer_address = ?
  `).run(deployerAddress);
}

export function getDeployerReputation(deployerAddress) {
  if (!deployerAddress) return null;
  return db.prepare(
    `SELECT * FROM deployer_reputation WHERE deployer_address = ?`
  ).get(deployerAddress);
}

// ─── Winner Profile Operations ────────────────────────────────────────────────

export function rebuildWinnerProfiles() {
  const outcomes = ['WINNER', 'RUGGER', 'NEUTRAL'];

  for (const profileType of outcomes) {
    const outcomeFilter = profileType === 'WINNER' ? 'WIN'
      : profileType === 'RUGGER' ? 'LOSS'
      : 'NEUTRAL';

    const rows = db.prepare(`
      SELECT c.*, ss.*
      FROM calls cl
      JOIN candidates c ON cl.candidate_id = c.id
      LEFT JOIN sub_scores ss ON ss.candidate_id = c.id
      WHERE cl.outcome = ?
    `).all(outcomeFilter);

    if (rows.length < 3) continue;

    const avg = (arr, key) => {
      const vals = arr.map(r => r[key]).filter(v => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const freqMap = (arr, key) => {
      const counts = {};
      for (const r of arr) { const val = r[key]; if (val) counts[val] = (counts[val] ?? 0) + 1; }
      return JSON.stringify(counts);
    };

    db.prepare(`DELETE FROM winner_profiles WHERE profile_type = ?`).run(profileType);
    db.prepare(`
      INSERT INTO winner_profiles (
        profile_type, sample_size,
        avg_composite_score, avg_launch_quality, avg_wallet_structure,
        avg_market_behavior, avg_social_narrative,
        avg_dev_wallet_pct, avg_top10_pct,
        avg_liquidity, avg_pair_age_hours, avg_holders, avg_holder_growth,
        common_structure_grades, common_setup_types, common_bundle_risks,
        min_score_seen, max_score_seen
      ) VALUES (
        @profile_type, @sample_size,
        @avg_composite_score, @avg_launch_quality, @avg_wallet_structure,
        @avg_market_behavior, @avg_social_narrative,
        @avg_dev_wallet_pct, @avg_top10_pct,
        @avg_liquidity, @avg_pair_age_hours, @avg_holders, @avg_holder_growth,
        @common_structure_grades, @common_setup_types, @common_bundle_risks,
        @min_score_seen, @max_score_seen
      )
    `).run({
      profile_type:            profileType,
      sample_size:             rows.length,
      avg_composite_score:     avg(rows, 'composite_score'),
      avg_launch_quality:      avg(rows, 'launch_quality'),
      avg_wallet_structure:    avg(rows, 'wallet_structure'),
      avg_market_behavior:     avg(rows, 'market_behavior'),
      avg_social_narrative:    avg(rows, 'social_narrative'),
      avg_dev_wallet_pct:      avg(rows, 'dev_wallet_pct'),
      avg_top10_pct:           avg(rows, 'top10_holder_pct'),
      avg_liquidity:           avg(rows, 'liquidity'),
      avg_pair_age_hours:      avg(rows, 'pair_age_hours'),
      avg_holders:             avg(rows, 'holders'),
      avg_holder_growth:       avg(rows, 'holder_growth_24h'),
      common_structure_grades: freqMap(rows, 'structure_grade'),
      common_setup_types:      freqMap(rows, 'setup_type'),
      common_bundle_risks:     freqMap(rows, 'bundle_risk'),
      min_score_seen:          Math.min(...rows.map(r => r.composite_score).filter(Boolean)),
      max_score_seen:          Math.max(...rows.map(r => r.composite_score).filter(Boolean)),
    });
  }
}

export function computeSimilarityScores(scoreResult) {
  try {
    const winnerProfile = db.prepare(
      `SELECT * FROM winner_profiles WHERE profile_type = 'WINNER' ORDER BY updated_at DESC LIMIT 1`
    ).get();
    const rugProfile = db.prepare(
      `SELECT * FROM winner_profiles WHERE profile_type = 'RUGGER' ORDER BY updated_at DESC LIMIT 1`
    ).get();

    if (!winnerProfile && !rugProfile) return { winnerSimilarity: null, rugSimilarity: null };

    const computeSim = (profile, sr) => {
      if (!profile) return null;
      const diffs = [];
      const sub   = sr.subScores ?? {};
      const fields = [
        ['avg_composite_score',  sr.score],
        ['avg_launch_quality',   sub.launchQuality],
        ['avg_wallet_structure', sub.walletStructure],
        ['avg_market_behavior',  sub.marketBehavior],
        ['avg_social_narrative', sub.socialNarrative],
      ];
      for (const [pf, cv] of fields) {
        if (profile[pf] != null && cv != null) {
          diffs.push(Math.abs(profile[pf] - cv) / 100);
        }
      }
      if (!diffs.length) return null;
      return Math.round((1 - diffs.reduce((a, b) => a + b, 0) / diffs.length) * 100);
    };

    return {
      winnerSimilarity: computeSim(winnerProfile, scoreResult),
      rugSimilarity:    computeSim(rugProfile, scoreResult),
    };
  } catch {
    return { winnerSimilarity: null, rugSimilarity: null };
  }
}

// ─── Seen Token Deduplication ─────────────────────────────────────────────────

export function isRecentlySeen(contractAddress) {
  // Read cooldown from env — defaults to 1 hour for new gem hunting
  // Set SEEN_TOKEN_COOLDOWN_HOURS in Railway to control this
  const cooldownHours = Number(process.env.SEEN_TOKEN_COOLDOWN_HOURS ?? 1);

  const row = db.prepare(
    `SELECT last_seen_at, was_posted FROM seen_tokens WHERE contract_address = ?`
  ).get(contractAddress);

  if (!row) return false;

  // Posted tokens are PERMANENTLY blocked — never repost
  if (row.was_posted) return true;

  // Non-posted tokens blocked for cooldownHours
  const lastSeen = new Date(row.last_seen_at).getTime();
  const cutoff   = Date.now() - cooldownHours * 60 * 60 * 1000;
  return lastSeen > cutoff;
}

export function recordSeen(contractAddress, wasPosted = false) {
  db.prepare(`
    INSERT INTO seen_tokens (contract_address, was_posted)
    VALUES (?, ?)
    ON CONFLICT(contract_address) DO UPDATE SET
      last_seen_at = datetime('now'),
      times_seen   = times_seen + 1,
      was_posted   = MAX(was_posted, excluded.was_posted)
  `).run(contractAddress, wasPosted ? 1 : 0);
}

// ─── Stats & Analytics ────────────────────────────────────────────────────────

export function getStats() {
  const totalEvaluated = db.prepare(`SELECT COUNT(*) as n FROM candidates`).get().n;
  const totalPosted    = db.prepare(`SELECT COUNT(*) as n FROM calls`).get().n;
  const last24h        = db.prepare(`SELECT COUNT(*) as n FROM candidates WHERE evaluated_at >= datetime('now', '-24 hours')`).get().n;
  const last24hPosted  = db.prepare(`SELECT COUNT(*) as n FROM calls WHERE posted_at >= datetime('now', '-24 hours')`).get().n;
  const pendingCalls   = db.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome = 'PENDING'`).get().n;
  const winCount       = db.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome = 'WIN'`).get().n;
  const lossCount      = db.prepare(`SELECT COUNT(*) as n FROM calls WHERE outcome = 'LOSS'`).get().n;

  const ncToday = db.prepare(`SELECT COUNT(*) as n FROM calls WHERE bot_source = 'NEW_COINS'  AND posted_at >= datetime('now', 'start of day')`).get().n;
  const trToday = db.prepare(`SELECT COUNT(*) as n FROM calls WHERE bot_source = 'TRENDING'   AND posted_at >= datetime('now', 'start of day')`).get().n;
  const wbToday = db.prepare(`SELECT COUNT(*) as n FROM calls WHERE bot_source = 'WALLET_BOT' AND posted_at >= datetime('now', 'start of day')`).get().n;

  return {
    totalEvaluated, totalPosted,
    last24hEvaluated: last24h, last24hPosted,
    pendingCalls, winCount, lossCount,
    winRate: totalPosted > 0
      ? ((winCount / (winCount + lossCount || 1)) * 100).toFixed(1) + '%'
      : '—',
    newCoinsPosted:  ncToday,
    trendingPosted:  trToday,
    walletBotPosted: wbToday,
  };
}

export function getRecentCalls(limit = 5) {
  return db.prepare(`
    SELECT token, contract_address, score_at_call, risk_at_call,
           setup_type_at_call, structure_grade_at_call,
           price_at_call, market_cap_at_call, outcome,
           posted_at, called_at,
           pct_change_1h, pct_change_6h, pct_change_24h,
           bot_source, sltp
    FROM calls ORDER BY posted_at DESC LIMIT ?
  `).all(limit);
}

export function getCandidates({ limit = 50, offset = 0, decision = null, risk = null, minScore = null, botSource = null } = {}) {
  let where = 'WHERE 1=1';
  const params = [];
  if (decision)  { where += ' AND final_decision = ?'; params.push(decision); }
  if (risk)      { where += ' AND claude_risk = ?';    params.push(risk); }
  if (minScore)  { where += ' AND claude_score >= ?';  params.push(minScore); }
  if (botSource) { where += ' AND bot_source = ?';     params.push(botSource); }

  const rows  = db.prepare(`SELECT * FROM candidates ${where} ORDER BY evaluated_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as n FROM candidates ${where}`).get(...params).n;
  return { rows, total };
}

export function getCandidateById(id) {
  const row = db.prepare(`SELECT * FROM candidates WHERE id = ?`).get(id);
  if (!row) return null;

  // Parse claude_raw into verdict object
  if (row.claude_raw) { try { row.claude_verdict_full = JSON.parse(row.claude_raw); } catch {} }

  // Attach sub-scores from the sub_scores table
  const ss = db.prepare(`SELECT * FROM sub_scores WHERE candidate_id = ? ORDER BY id DESC LIMIT 1`).get(id);
  if (ss) {
    // Attach individual sub-score values directly on the row
    row.launch_quality   = ss.launch_quality;
    row.wallet_structure = ss.wallet_structure;
    row.market_behavior  = ss.market_behavior;
    row.social_narrative = ss.social_narrative;
    row.threshold_value  = ss.threshold_value;
    row.threshold_reason = ss.threshold_reason;

    // Parse JSON signal arrays
    for (const field of ['launch_signals','wallet_signals','market_signals','social_signals',
                         'launch_penalties','wallet_penalties','market_penalties','social_penalties',
                         'trap_traps']) {
      try { ss[field] = JSON.parse(ss[field] ?? '[]'); } catch { ss[field] = []; }
    }
    row.sub_scores = ss;

    // Also expose signals and penalties for the modal detail view
    row.signals   = { launch: ss.launch_signals, wallet: ss.wallet_signals, market: ss.market_signals, social: ss.social_signals };
    row.penalties = { launch: ss.launch_penalties, wallet: ss.wallet_penalties, market: ss.market_penalties, social: ss.social_penalties };
    row.trap_traps = ss.trap_traps;
  }

  // Parse narrative_tags from comma-separated string to array
  if (row.narrative_tags && typeof row.narrative_tags === 'string') {
    row.narrative_tags = row.narrative_tags.split(',').map(t => t.trim()).filter(Boolean);
  }

  return row;
}

export function getAllCalls({ limit = 50, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT c.*, ca.market_cap, ca.liquidity, ca.volume_24h,
           ca.holders, ca.top10_holder_pct, ca.dev_wallet_pct,
           ca.bundle_risk, ca.bubble_map_risk,
           ca.mint_authority, ca.freeze_authority, ca.lp_locked,
           ca.birdeye_ok, ca.helius_ok, ca.bubblemap_ok,
           ca.wallet_intel_score, ca.cluster_risk, ca.momentum_grade,
           ca.composite_score, ca.structure_grade, ca.narrative_tags,
           ca.launch_quality_score, ca.buy_sell_ratio_1h, ca.volume_velocity,
           ca.sniper_wallet_count, ca.bot_source AS candidate_bot_source,
           ca.claude_verdict, ca.claude_risk, ca.claude_setup_type, ca.claude_score,
           ca.openai_decision, ca.openai_conviction, ca.openai_verdict,
           ca.openai_agrees_with_claude, ca.token AS candidate_token,
           ca.posted_at_ms, ca.evaluated_at AS candidate_evaluated_at
    FROM calls c
    LEFT JOIN candidates ca ON c.candidate_id = ca.id
    ORDER BY c.posted_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as n FROM calls`).get().n;
  return { rows, total };
}

export function getTopIgnored({ limit = 10 } = {}) {
  return db.prepare(`SELECT * FROM candidates WHERE final_decision = 'IGNORE' AND claude_score IS NOT NULL ORDER BY claude_score DESC LIMIT ?`).all(limit);
}

export function getTopIgnoredFull({ limit = 10 } = {}) {
  return db.prepare(`SELECT * FROM candidates WHERE final_decision IN ('IGNORE', 'HOLD_FOR_REVIEW') AND claude_score IS NOT NULL ORDER BY claude_score DESC LIMIT ?`).all(limit);
}

export function getPendingCalls() {
  return db.prepare(`SELECT * FROM calls WHERE outcome = 'PENDING' ORDER BY posted_at ASC`).all();
}

export function getSystemLog({ limit = 100, level = null } = {}) {
  const where  = level ? 'WHERE level = ?' : '';
  const params = level ? [level, limit] : [limit];
  return db.prepare(`SELECT * FROM system_log ${where} ORDER BY logged_at DESC LIMIT ?`).all(...params);
}

export function getScoreDistribution() {
  return db.prepare(`
    SELECT CASE
      WHEN claude_score >= 80 THEN '80-100'
      WHEN claude_score >= 60 THEN '60-79'
      WHEN claude_score >= 40 THEN '40-59'
      ELSE '0-39'
    END as bucket,
    COUNT(*) as count
    FROM candidates WHERE claude_score IS NOT NULL
    GROUP BY bucket ORDER BY bucket DESC
  `).all();
}

// Returns object keyed by decision for dashboard compatibility
export function getDecisionBreakdown() {
  const rows = db.prepare(
    `SELECT final_decision, COUNT(*) as count FROM candidates GROUP BY final_decision ORDER BY count DESC`
  ).all();
  // Return as object { AUTO_POST: 5, WATCHLIST: 12, IGNORE: 88, ... }
  const obj = {};
  for (const row of rows) {
    if (row.final_decision) obj[row.final_decision] = row.count;
  }
  return obj;
}

export function getWinRateByScoreBand() {
  return db.prepare(`
    SELECT
      CASE
        WHEN score_at_call >= 69 THEN '69+'
        WHEN score_at_call >= 61 THEN '61-68'
        WHEN score_at_call >= 53 THEN '53-60'
        ELSE 'Under 52'
      END as band,
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
      ROUND(100.0 * SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate,
      ROUND(AVG(CASE WHEN peak_multiple IS NOT NULL THEN peak_multiple END), 2) as avg_peak_x,
      ROUND(MAX(CASE WHEN peak_multiple IS NOT NULL THEN peak_multiple END), 2) as best_x
    FROM calls WHERE outcome IN ('WIN','LOSS','NEUTRAL')
    GROUP BY band ORDER BY
      CASE band WHEN '69+' THEN 1 WHEN '61-68' THEN 2 WHEN '53-60' THEN 3 ELSE 4 END
  `).all();
}

export function getWinRateBySetupType() {
  return db.prepare(`
    SELECT setup_type_at_call as setup_type, COUNT(*) as total,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN outcome = 'NEUTRAL' THEN 1 ELSE 0 END) as neutrals,
      ROUND(100.0 * SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate,
      ROUND(AVG(CASE WHEN peak_multiple IS NOT NULL THEN peak_multiple END), 2) as avg_peak_x,
      ROUND(MAX(CASE WHEN peak_multiple IS NOT NULL THEN peak_multiple END), 2) as best_x
    FROM calls WHERE outcome IN ('WIN','LOSS','NEUTRAL') AND setup_type_at_call IS NOT NULL
    GROUP BY setup_type_at_call ORDER BY win_rate DESC
  `).all();
}

export function getWinRateByMcapBand() {
  return db.prepare(`
    SELECT
      CASE
        WHEN market_cap_at_call >= 40000 THEN '$40K-$85K'
        WHEN market_cap_at_call >= 20000 THEN '$20K-$40K'
        WHEN market_cap_at_call >= 8000  THEN '$8K-$20K'
        ELSE 'Under $8K'
      END as band,
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome = 'LOSS' THEN 1 ELSE 0 END) as losses,
      ROUND(100.0 * SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate,
      ROUND(AVG(CASE WHEN peak_multiple IS NOT NULL THEN peak_multiple END), 2) as avg_peak_x,
      ROUND(MAX(CASE WHEN peak_multiple IS NOT NULL THEN peak_multiple END), 2) as best_x
    FROM calls WHERE outcome IN ('WIN','LOSS','NEUTRAL') AND market_cap_at_call IS NOT NULL
    GROUP BY band ORDER BY
      CASE band WHEN '$8K-$20K' THEN 1 WHEN '$20K-$40K' THEN 2 WHEN '$40K-$85K' THEN 3 ELSE 4 END
  `).all();
}

export function getMissedWinners() {
  return db.prepare(`
    SELECT c.token, c.contract_address, c.claude_score, c.final_decision,
           c.composite_score, c.structure_grade, c.setup_type, c.evaluated_at,
           c.market_cap, c.pair_age_hours, c.claude_risk, c.claude_verdict,
           aa.peak_multiple, aa.peak_mcap, aa.outcome
    FROM candidates c
    LEFT JOIN audit_archive aa ON aa.contract_address = c.contract_address
    WHERE c.final_decision = 'IGNORE' AND c.claude_score >= 55
    ORDER BY c.claude_score DESC LIMIT 20
  `).all();
}

export function getDeployerLeaderboard() {
  return db.prepare(`
    SELECT deployer_address, reputation_grade, risk_level, total_launches,
           successful_launches, rugged_launches, pending_launches, updated_at
    FROM deployer_reputation
    ORDER BY CASE reputation_grade
      WHEN 'ELITE'         THEN 1
      WHEN 'CLEAN'         THEN 2
      WHEN 'NEUTRAL'       THEN 3
      WHEN 'FLAGGED'       THEN 4
      WHEN 'SERIAL_RUGGER' THEN 5
      ELSE 6
    END, total_launches DESC
    LIMIT 50
  `).all();
}

export function getWinnerProfiles() {
  return db.prepare(`SELECT * FROM winner_profiles ORDER BY profile_type`).all();
}

// ─── Scanner Feed Operations ─────────────────────────────────────────────────

export function insertScannerFeed(data) {
  try {
    db.prepare(`
      INSERT INTO scanner_feed (
        token, contract_address, pair_address, dex,
        market_cap, liquidity, volume_24h, volume_1h,
        price_usd, pair_age_hours, stage,
        price_change_5m, price_change_1h, price_change_24h,
        buys_1h, sells_1h, buy_ratio_1h, volume_velocity,
        quick_score, candidate_type, filter_action, filter_reason,
        website, twitter, telegram
      ) VALUES (
        @token, @contract_address, @pair_address, @dex,
        @market_cap, @liquidity, @volume_24h, @volume_1h,
        @price_usd, @pair_age_hours, @stage,
        @price_change_5m, @price_change_1h, @price_change_24h,
        @buys_1h, @sells_1h, @buy_ratio_1h, @volume_velocity,
        @quick_score, @candidate_type, @filter_action, @filter_reason,
        @website, @twitter, @telegram
      )
    `).run({
      token:             data.token             ?? null,
      contract_address:  data.contractAddress   ?? '',
      pair_address:      data.pairAddress       ?? null,
      dex:               data.dex               ?? null,
      market_cap:        data.marketCap         ?? null,
      liquidity:         data.liquidity         ?? null,
      volume_24h:        data.volume24h         ?? null,
      volume_1h:         data.volume1h          ?? null,
      price_usd:         data.priceUsd          ?? null,
      pair_age_hours:    data.pairAgeHours      ?? null,
      stage:             data.stage             ?? null,
      price_change_5m:   data.priceChange5m     ?? null,
      price_change_1h:   data.priceChange1h     ?? null,
      price_change_24h:  data.priceChange24h    ?? null,
      buys_1h:           data.buys1h            ?? null,
      sells_1h:          data.sells1h           ?? null,
      buy_ratio_1h:      data.buySellRatio1h    ?? null,
      volume_velocity:   data.volumeVelocity    ?? null,
      quick_score:       data.quickScore        ?? null,
      candidate_type:    data.candidateType     ?? null,
      filter_action:     data.filterAction      ?? 'SKIP',
      filter_reason:     data.filterReason      ?? null,
      website:           data.website           ?? null,
      twitter:           data.twitter           ?? null,
      telegram:          data.telegram          ?? null,
    });
  } catch (err) {
    // Non-critical — don't crash if feed insert fails
    console.warn('[db] insertScannerFeed failed:', err.message);
  }
}

export function getScannerFeed({ limit = 200, action = null, minAge = null, maxAge = null } = {}) {
  // Dedupe by contract_address — show only the LATEST scan per token
  // This prevents the same token appearing multiple times across cycles
  let actionFilter = action ? `AND filter_action = '${action.replace(/'/g,"''")}'` : '';
  let ageFilter    = '';
  if (minAge != null) ageFilter += ` AND pair_age_hours >= ${minAge}`;
  if (maxAge != null) ageFilter += ` AND pair_age_hours <= ${maxAge}`;

  const rows = db.prepare(`
    SELECT * FROM scanner_feed
    WHERE id IN (
      SELECT MAX(id) FROM scanner_feed
      WHERE 1=1 ${actionFilter} ${ageFilter}
      GROUP BY contract_address
    )
    ${actionFilter} ${ageFilter}
    ORDER BY scanned_at DESC
    LIMIT ?
  `).all(limit);

  const total = db.prepare(`
    SELECT COUNT(DISTINCT contract_address) as n FROM scanner_feed
    WHERE 1=1 ${actionFilter} ${ageFilter}
  `).get().n;

  const actionCounts = db.prepare(`
    SELECT filter_action, COUNT(DISTINCT contract_address) as n
    FROM scanner_feed
    WHERE scanned_at >= datetime('now', '-1 hour')
    GROUP BY filter_action
  `).all();

  return { rows, total, actionCounts };
}

export function logEvent(level = 'INFO', event, detail = null) {
  try {
    db.prepare(
      `INSERT INTO system_log (level, event, detail) VALUES (?, ?, ?)`
    ).run(level, event, detail);
  } catch (err) {
    console.error('[db] logEvent failed:', err.message);
  }
}

export { db };
