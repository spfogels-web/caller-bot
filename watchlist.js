/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  watchlist.js — Post-enrichment state manager v2
 *
 *  Manages tokens AFTER they have been fully enriched and scored.
 *  The scanner's internal queue handles pre-enrichment quick-score rescans.
 *  This module handles what happens after full scoring:
 *
 *  States:
 *    WATCHLIST  — enriched + scored, close but not enough, re-enrich in 10min
 *    RETEST     — enriched + scored, showing momentum signals, re-enrich in 3min
 *    BLOCKLIST  — permanent ban (serial rugger / extreme danger)
 *
 *  Persistence:
 *    All state written to SQLite — survives Railway restarts.
 *    In-memory Maps are rebuilt from DB on startup.
 *
 *  Relationship with scanner.js:
 *    scanner.js  → pre-enrichment quick-score rescans (2/5/10 min internal queue)
 *    watchlist.js → post-enrichment full re-enrichment rescans (3/10 min)
 *    No overlap. scanner promotes → enricher → scorer → watchlist routes.
 *
 *  Flow:
 *    scorer routes RETEST  → addToRetest()   → re-enrich in 3min
 *    scorer routes WATCHLIST → addToWatchlist() → re-enrich in 10min
 *    server.js cycle calls getDueEntries() → re-enriches → re-scores → posts or drops
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import { logEvent } from './db.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const RETEST_DELAY_MS       = 3  * 60 * 1000;  // 3 min — quick re-check
const WATCHLIST_DELAY_MS    = 10 * 60 * 1000;  // 10 min — next full cycle
const MAX_RESCANS           = 6;               // bumped 3→6 — coins get more chances to upgrade
const MAX_WATCHLIST_SIZE    = 300;             // bumped 150→300 so borderline coins stay visible longer
const MAX_RETEST_SIZE       = 100;             // bumped 50→100
const STALE_WATCHLIST_MS    = 4  * 60 * 60 * 1000; // bumped 2h→4h — coins stay on list longer before dropping
const STALE_RETEST_MS       = 30 * 60 * 1000;      // drop after 30min

// ─── In-Memory State (rebuilt from DB on startup) ─────────────────────────────

// Map<contractAddress, WatchlistEntry>
const retestQueue = new Map();
const watchlistMap = new Map();
// Set<contractAddress>
const blocklistSet = new Set();

/**
 * @typedef {object} WatchlistEntry
 * @property {string}   contractAddress
 * @property {string}   token
 * @property {string}   state             — 'RETEST' | 'WATCHLIST'
 * @property {number}   addedAt           — ms timestamp
 * @property {number}   rescanAt          — ms timestamp when due
 * @property {number}   scanCount         — how many times re-enriched
 * @property {number}   firstScore        — composite score from first evaluation
 * @property {string}   firstRisk
 * @property {string}   structureGrade
 * @property {string}   stage
 * @property {string}   candidateType     — from scanner quick scoring
 * @property {number}   quickScore        — scanner's pre-enrichment score
 * @property {string}   reason            — why it was added
 * @property {object}   snapshot          — last enriched candidate snapshot
 */

// ─── DB Persistence ───────────────────────────────────────────────────────────

let _db = null;

/**
 * Initialize watchlist with DB reference.
 * Rebuilds in-memory state from persisted rows.
 * Call once at startup after initDb().
 *
 * @param {object} db — better-sqlite3 instance
 */
export function initWatchlist(db) {
  _db = db;

  // Create watchlist table if it doesn't exist
  _db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist_queue (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_address TEXT    NOT NULL UNIQUE,
      token            TEXT,
      state            TEXT    NOT NULL DEFAULT 'WATCHLIST',
      added_at         TEXT    NOT NULL DEFAULT (datetime('now')),
      rescan_at        TEXT    NOT NULL,
      scan_count       INTEGER NOT NULL DEFAULT 0,
      first_score      INTEGER,
      first_risk       TEXT,
      structure_grade  TEXT,
      stage            TEXT,
      candidate_type   TEXT,
      quick_score      INTEGER,
      reason           TEXT,
      snapshot         TEXT,
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocklist_permanent (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_address TEXT    NOT NULL UNIQUE,
      reason           TEXT,
      added_at         TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wq_state     ON watchlist_queue(state);
    CREATE INDEX IF NOT EXISTS idx_wq_rescan_at ON watchlist_queue(rescan_at);
    CREATE INDEX IF NOT EXISTS idx_wq_ca        ON watchlist_queue(contract_address);
  `);

  // Rebuild in-memory state from DB
  _rebuildFromDb();

  console.log(
    `[watchlist] Initialized — ` +
    `retest:${retestQueue.size} watchlist:${watchlistMap.size} blocklist:${blocklistSet.size}`
  );
  logEvent('INFO', 'WATCHLIST_INIT', JSON.stringify({
    retest:    retestQueue.size,
    watchlist: watchlistMap.size,
    blocklist: blocklistSet.size,
  }));
}

function _rebuildFromDb() {
  if (!_db) return;

  try {
    // Blocklist
    const blockRows = _db.prepare(`SELECT contract_address FROM blocklist_permanent`).all();
    for (const row of blockRows) blocklistSet.add(row.contract_address);

    // Active queue entries — skip expired ones
    const now = new Date().toISOString();
    const queueRows = _db.prepare(`
      SELECT * FROM watchlist_queue
      WHERE state IN ('RETEST','WATCHLIST')
      AND added_at >= datetime('now', '-2 hours')
    `).all();

    for (const row of queueRows) {
      const entry = _rowToEntry(row);
      if (row.state === 'RETEST') {
        retestQueue.set(row.contract_address, entry);
      } else {
        watchlistMap.set(row.contract_address, entry);
      }
    }
  } catch (err) {
    console.warn('[watchlist] DB rebuild error:', err.message);
  }
}

function _rowToEntry(row) {
  let snapshot = null;
  try { snapshot = row.snapshot ? JSON.parse(row.snapshot) : null; } catch {}

  return {
    contractAddress: row.contract_address,
    token:           row.token           ?? null,
    state:           row.state           ?? 'WATCHLIST',
    addedAt:         new Date(row.added_at).getTime(),
    rescanAt:        new Date(row.rescan_at).getTime(),
    scanCount:       row.scan_count      ?? 0,
    firstScore:      row.first_score     ?? null,
    firstRisk:       row.first_risk      ?? null,
    structureGrade:  row.structure_grade ?? null,
    stage:           row.stage           ?? null,
    candidateType:   row.candidate_type  ?? null,
    quickScore:      row.quick_score     ?? null,
    reason:          row.reason          ?? null,
    snapshot,
  };
}

function _persistEntry(entry) {
  if (!_db) return;
  try {
    _db.prepare(`
      INSERT INTO watchlist_queue (
        contract_address, token, state, rescan_at, scan_count,
        first_score, first_risk, structure_grade, stage,
        candidate_type, quick_score, reason, snapshot, updated_at
      ) VALUES (
        @contract_address, @token, @state, @rescan_at, @scan_count,
        @first_score, @first_risk, @structure_grade, @stage,
        @candidate_type, @quick_score, @reason, @snapshot, datetime('now')
      )
      ON CONFLICT(contract_address) DO UPDATE SET
        state           = @state,
        rescan_at       = @rescan_at,
        scan_count      = @scan_count,
        first_score     = @first_score,
        first_risk      = @first_risk,
        structure_grade = @structure_grade,
        stage           = @stage,
        candidate_type  = @candidate_type,
        quick_score     = @quick_score,
        reason          = @reason,
        snapshot        = @snapshot,
        updated_at      = datetime('now')
    `).run({
      contract_address: entry.contractAddress,
      token:            entry.token           ?? null,
      state:            entry.state,
      rescan_at:        new Date(entry.rescanAt).toISOString(),
      scan_count:       entry.scanCount,
      first_score:      entry.firstScore      ?? null,
      first_risk:       entry.firstRisk       ?? null,
      structure_grade:  entry.structureGrade  ?? null,
      stage:            entry.stage           ?? null,
      candidate_type:   entry.candidateType   ?? null,
      quick_score:      entry.quickScore      ?? null,
      reason:           entry.reason          ?? null,
      snapshot:         entry.snapshot
        ? JSON.stringify(entry.snapshot).slice(0, 10_000)
        : null,
    });
  } catch (err) {
    console.warn('[watchlist] Persist error:', err.message);
  }
}

function _removeFromDb(contractAddress) {
  if (!_db) return;
  try {
    _db.prepare(`DELETE FROM watchlist_queue WHERE contract_address = ?`)
      .run(contractAddress);
  } catch (err) {
    console.warn('[watchlist] DB remove error:', err.message);
  }
}

// ─── Blocklist ─────────────────────────────────────────────────────────────────

/**
 * Permanently ban a contract address.
 * Removes from all queues and writes to DB.
 *
 * @param {string} contractAddress
 * @param {string} reason
 */
export function addToBlocklist(contractAddress, reason = '') {
  if (!contractAddress) return;

  blocklistSet.add(contractAddress);
  retestQueue.delete(contractAddress);
  watchlistMap.delete(contractAddress);
  _removeFromDb(contractAddress);

  if (_db) {
    try {
      _db.prepare(`
        INSERT INTO blocklist_permanent (contract_address, reason)
        VALUES (?, ?)
        ON CONFLICT(contract_address) DO NOTHING
      `).run(contractAddress, reason);
    } catch (err) {
      console.warn('[watchlist] Blocklist DB error:', err.message);
    }
  }

  console.log(`[watchlist] BLOCKLIST +${contractAddress.slice(0,8)}… — ${reason}`);
  logEvent('INFO', 'BLOCKLIST_ADD', `${contractAddress} — ${reason}`);
}

/** @param {string} contractAddress @returns {boolean} */
export function isBlocklisted(contractAddress) {
  return blocklistSet.has(contractAddress);
}

/** @returns {string[]} */
export function getBlocklist() {
  return Array.from(blocklistSet);
}

// ─── RETEST Queue ─────────────────────────────────────────────────────────────

/**
 * Add a fully-enriched, scored candidate to the RETEST queue.
 * Re-enrichment happens in 3 minutes.
 *
 * @param {object} candidate   — enriched candidate
 * @param {object} scoreResult — from computeFullScore()
 * @param {string} reason
 */
export function addToRetest(candidate, scoreResult, reason = '') {
  const ca = candidate?.contractAddress;
  if (!ca || isBlocklisted(ca)) return;

  const existing  = retestQueue.get(ca) ?? watchlistMap.get(ca);
  const scanCount = (existing?.scanCount ?? 0) + 1;

  if (scanCount > MAX_RESCANS) {
    console.log(`[watchlist] RETEST max rescans for $${candidate.token ?? ca} — dropping`);
    retestQueue.delete(ca);
    watchlistMap.delete(ca);
    _removeFromDb(ca);
    return;
  }

  if (retestQueue.size >= MAX_RETEST_SIZE) {
    // Evict lowest-scored entry to make room
    const lowest = [...retestQueue.entries()]
      .sort((a, b) => (a[1].firstScore ?? 0) - (b[1].firstScore ?? 0))[0];
    if (lowest && (lowest[1].firstScore ?? 0) < (scoreResult.score ?? 0)) {
      retestQueue.delete(lowest[0]);
      _removeFromDb(lowest[0]);
    } else {
      return; // Don't evict a better entry
    }
  }

  const entry = {
    contractAddress: ca,
    token:           candidate.token          ?? null,
    state:           'RETEST',
    addedAt:         Date.now(),
    rescanAt:        Date.now() + RETEST_DELAY_MS,
    scanCount,
    firstScore:      scoreResult.score        ?? null,
    firstRisk:       scoreResult.risk         ?? null,
    structureGrade:  scoreResult.structureGrade ?? null,
    stage:           scoreResult.stage        ?? candidate.stage ?? null,
    candidateType:   candidate.candidateType  ?? null,
    quickScore:      candidate.quickScore     ?? null,
    reason,
    snapshot:        _snapshotCandidate(candidate),
  };

  retestQueue.set(ca, entry);
  watchlistMap.delete(ca); // remove from watchlist if it was there
  _persistEntry(entry);

  console.log(
    `[watchlist] RETEST +$${candidate.token ?? ca} ` +
    `(scan ${scanCount}/${MAX_RESCANS}) score:${scoreResult.score} ` +
    `rescan in 3min — ${reason}`
  );
  logEvent('INFO', 'RETEST_ADD', `${candidate.token} ${ca} score=${scoreResult.score} reason=${reason}`);
}

// ─── Watchlist ─────────────────────────────────────────────────────────────────

/**
 * Add a fully-enriched, scored candidate to the WATCHLIST.
 * Re-enrichment happens in 10 minutes.
 *
 * @param {object} candidate
 * @param {object} scoreResult
 * @param {string} reason
 */
export function addToWatchlist(candidate, scoreResult, reason = '') {
  const ca = candidate?.contractAddress;
  if (!ca || isBlocklisted(ca)) return;

  // If it's already in RETEST, don't downgrade
  if (retestQueue.has(ca)) return;

  const existing  = watchlistMap.get(ca);
  const scanCount = (existing?.scanCount ?? 0) + 1;

  if (scanCount > MAX_RESCANS) {
    console.log(`[watchlist] WATCHLIST max rescans for $${candidate.token ?? ca} — dropping`);
    watchlistMap.delete(ca);
    _removeFromDb(ca);
    return;
  }

  if (watchlistMap.size >= MAX_WATCHLIST_SIZE) {
    const oldest = [...watchlistMap.entries()]
      .sort((a, b) => a[1].addedAt - b[1].addedAt)[0];
    if (oldest) {
      watchlistMap.delete(oldest[0]);
      _removeFromDb(oldest[0]);
    }
  }

  const entry = {
    contractAddress: ca,
    token:           candidate.token          ?? null,
    state:           'WATCHLIST',
    addedAt:         Date.now(),
    rescanAt:        Date.now() + WATCHLIST_DELAY_MS,
    scanCount,
    firstScore:      scoreResult.score        ?? null,
    firstRisk:       scoreResult.risk         ?? null,
    structureGrade:  scoreResult.structureGrade ?? null,
    stage:           scoreResult.stage        ?? candidate.stage ?? null,
    candidateType:   candidate.candidateType  ?? null,
    quickScore:      candidate.quickScore     ?? null,
    reason,
    snapshot:        _snapshotCandidate(candidate),
  };

  watchlistMap.set(ca, entry);
  _persistEntry(entry);

  console.log(
    `[watchlist] WATCHLIST +$${candidate.token ?? ca} ` +
    `(scan ${scanCount}/${MAX_RESCANS}) score:${scoreResult.score} ` +
    `rescan in 10min — ${reason}`
  );
  logEvent('INFO', 'WATCHLIST_ADD', `${candidate.token} ${ca} score=${scoreResult.score} reason=${reason}`);
}

// ─── Due Entry Retrieval ──────────────────────────────────────────────────────

/**
 * Get all RETEST and WATCHLIST entries due for re-enrichment right now.
 * Called every cycle from server.js.
 *
 * @returns {WatchlistEntry[]}
 */
export function getDueEntries() {
  const now = Date.now();
  const due = [];

  for (const entry of retestQueue.values()) {
    if (entry.rescanAt <= now) due.push(entry);
  }
  for (const entry of watchlistMap.values()) {
    if (entry.rescanAt <= now) due.push(entry);
  }

  // Sort by score descending — process best candidates first
  return due.sort((a, b) => (b.firstScore ?? 0) - (a.firstScore ?? 0));
}

/** @returns {WatchlistEntry[]} all RETEST entries due now */
export function getDueRetests() {
  const now = Date.now();
  return [...retestQueue.values()].filter(e => e.rescanAt <= now);
}

/** @returns {WatchlistEntry[]} all WATCHLIST entries due now */
export function getDueWatchlist() {
  const now = Date.now();
  return [...watchlistMap.values()].filter(e => e.rescanAt <= now);
}

// ─── Completion / Removal ──────────────────────────────────────────────────────

/**
 * Remove a RETEST entry — call after processing it.
 * @param {string} contractAddress
 */
export function clearRetest(contractAddress) {
  retestQueue.delete(contractAddress);
  _removeFromDb(contractAddress);
}

/**
 * Remove a WATCHLIST entry — call after processing it.
 * @param {string} contractAddress
 */
export function clearWatchlist(contractAddress) {
  watchlistMap.delete(contractAddress);
  _removeFromDb(contractAddress);
}

/**
 * Remove from either queue.
 * @param {string} contractAddress
 */
export function clearEntry(contractAddress) {
  retestQueue.delete(contractAddress);
  watchlistMap.delete(contractAddress);
  _removeFromDb(contractAddress);
}

// ─── Rescan Result Handler ─────────────────────────────────────────────────────

/**
 * After re-enriching and re-scoring a watchlist/retest entry,
 * decide what to do next.
 *
 * @param {WatchlistEntry} entry     — original entry
 * @param {object}         newScore  — new computeFullScore() result
 * @param {object}         candidate — freshly enriched candidate
 * @returns {'AUTO_POST'|'WATCHLIST'|'RETEST'|'IGNORE'|'BLOCKLIST'}
 */
export function handleRescanResult(entry, newScore, candidate) {
  const ca         = entry.contractAddress;
  const scoreDelta = (newScore.score ?? 0) - (entry.firstScore ?? 0);
  const improved   = scoreDelta > 5;
  const degraded   = scoreDelta < -10;

  console.log(
    `[watchlist] RESCAN $${entry.token ?? ca} — ` +
    `first:${entry.firstScore} now:${newScore.score} delta:${scoreDelta > 0 ? '+' : ''}${scoreDelta} ` +
    `scan:${entry.scanCount}/${MAX_RESCANS} decision:${newScore.decision}`
  );

  // Hard block on rescan
  if (candidate.deployerHistoryRisk === 'SERIAL_RUGGER') {
    addToBlocklist(ca, 'Serial rugger detected on rescan');
    return 'BLOCKLIST';
  }

  // If full scoring now says AUTO_POST — promote it
  if (newScore.decision === 'AUTO_POST') {
    logEvent('INFO', 'RESCAN_PROMOTED', `${entry.token} score=${newScore.score} delta=${scoreDelta}`);
    return 'AUTO_POST';
  }

  // Score improved and scans remaining — keep watching
  if (improved && entry.scanCount < MAX_RESCANS) {
    logEvent('INFO', 'RESCAN_REWATCH', `${entry.token} score=${newScore.score} improved=${scoreDelta}`);
    // Upgrade to RETEST if improving fast
    if (scoreDelta > 15) return 'RETEST';
    return 'WATCHLIST';
  }

  // Score degraded — drop it
  if (degraded) {
    logEvent('INFO', 'RESCAN_DEGRADED', `${entry.token} score=${newScore.score} delta=${scoreDelta}`);
    return 'IGNORE';
  }

  // Max rescans reached — final decision
  if (entry.scanCount >= MAX_RESCANS) {
    logEvent('INFO', 'RESCAN_EXPIRED', `${entry.token} score=${newScore.score}`);
    return 'IGNORE';
  }

  // Flat — keep watching if scans remaining
  return entry.scanCount < MAX_RESCANS ? 'WATCHLIST' : 'IGNORE';
}

// ─── State Inspection ─────────────────────────────────────────────────────────

/** @param {string} contractAddress @returns {'RETEST'|'WATCHLIST'|'BLOCKLIST'|null} */
export function getTokenState(contractAddress) {
  if (isBlocklisted(contractAddress))  return 'BLOCKLIST';
  if (retestQueue.has(contractAddress)) return 'RETEST';
  if (watchlistMap.has(contractAddress)) return 'WATCHLIST';
  return null;
}

/** @param {string} contractAddress @returns {boolean} */
export function isInQueue(contractAddress) {
  return retestQueue.has(contractAddress) || watchlistMap.has(contractAddress);
}

// ─── Stats & Dashboard Data ───────────────────────────────────────────────────

/** @returns {object} queue stats for dashboard */
export function getQueueStats() {
  const now = Date.now();
  return {
    retest: {
      total:   retestQueue.size,
      due:     [...retestQueue.values()].filter(e => e.rescanAt <= now).length,
      pending: [...retestQueue.values()].filter(e => e.rescanAt > now).length,
    },
    watchlist: {
      total: watchlistMap.size,
      due:   [...watchlistMap.values()].filter(e => e.rescanAt <= now).length,
    },
    blocklist: {
      total: blocklistSet.size,
    },
  };
}

/** @returns {object[]} retest queue contents for dashboard */
export function getRetestContents() {
  const now = Date.now();
  return [...retestQueue.values()].map(e => ({
    token:            e.token,
    ca:               e.contractAddress,
    state:            'RETEST',
    firstScore:       e.firstScore,
    firstRisk:        e.firstRisk,
    structureGrade:   e.structureGrade,
    stage:            e.stage,
    candidateType:    e.candidateType,
    quickScore:       e.quickScore,
    scanCount:        e.scanCount,
    reason:           e.reason,
    addedAt:          new Date(e.addedAt).toISOString(),
    rescanAt:         new Date(e.rescanAt).toISOString(),
    minsUntilRescan:  Math.max(0, Math.round((e.rescanAt - now) / 60_000)),
    overdue:          e.rescanAt <= now,
  }));
}

/** @returns {object[]} watchlist contents for dashboard */
export function getWatchlistContents() {
  const now = Date.now();
  return [...watchlistMap.values()].map(e => ({
    token:            e.token,
    ca:               e.contractAddress,
    state:            'WATCHLIST',
    firstScore:       e.firstScore,
    firstRisk:        e.firstRisk,
    structureGrade:   e.structureGrade,
    stage:            e.stage,
    candidateType:    e.candidateType,
    quickScore:       e.quickScore,
    scanCount:        e.scanCount,
    reason:           e.reason,
    addedAt:          new Date(e.addedAt).toISOString(),
    rescanAt:         new Date(e.rescanAt).toISOString(),
    minsUntilRescan:  Math.max(0, Math.round((e.rescanAt - now) / 60_000)),
    overdue:          e.rescanAt <= now,
  }));
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Remove stale entries that have been sitting too long.
 * RETEST: 30 min max, WATCHLIST: 2 hr max.
 * Call periodically from server.js.
 */
export function cleanupStaleEntries() {
  const now = Date.now();
  let cleaned = 0;

  for (const [ca, entry] of retestQueue.entries()) {
    if (now - entry.addedAt > STALE_RETEST_MS) {
      retestQueue.delete(ca);
      _removeFromDb(ca);
      cleaned++;
    }
  }

  for (const [ca, entry] of watchlistMap.entries()) {
    if (now - entry.addedAt > STALE_WATCHLIST_MS) {
      watchlistMap.delete(ca);
      _removeFromDb(ca);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[watchlist] Cleanup — removed ${cleaned} stale entries`);
    logEvent('INFO', 'WATCHLIST_CLEANUP', `removed=${cleaned}`);
  }

  // Also clean up old DB rows (older than 3 hours)
  if (_db) {
    try {
      _db.prepare(`
        DELETE FROM watchlist_queue
        WHERE added_at < datetime('now', '-3 hours')
      `).run();
    } catch {}
  }
}

// ─── Candidate Snapshot ───────────────────────────────────────────────────────

/**
 * Create a minimal snapshot of an enriched candidate for storage.
 * Only store what's needed for re-enrichment context.
 * Full re-enrichment will be done fresh anyway.
 */
function _snapshotCandidate(candidate) {
  return {
    token:            candidate.token            ?? null,
    tokenName:        candidate.tokenName        ?? null,
    contractAddress:  candidate.contractAddress  ?? null,
    pairAddress:      candidate.pairAddress      ?? null,
    chain:            candidate.chain            ?? 'solana',
    dex:              candidate.dex              ?? null,
    stage:            candidate.stage            ?? null,
    candidateType:    candidate.candidateType    ?? null,
    quickScore:       candidate.quickScore       ?? null,
    // Keep last known market data as context for scoring trend
    marketCap:        candidate.marketCap        ?? null,
    liquidity:        candidate.liquidity        ?? null,
    volume24h:        candidate.volume24h        ?? null,
    priceChange1h:    candidate.priceChange1h    ?? null,
    priceChange24h:   candidate.priceChange24h   ?? null,
    holders:          candidate.holders          ?? null,
    narrativeTags:    candidate.narrativeTags    ?? [],
    notes:            [],
    // Enrichment flags reset so fresh enrichment runs fully
    birdeyeOk:        false,
    heliusOk:         false,
    bubblemapOk:      false,
  };
}
