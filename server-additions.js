/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  server-additions.js
 *
 *  Exact code snippets to ADD to your existing server.js.
 *  These are not a full replacement — just the additions.
 * ─────────────────────────────────────────────────────────────────────────────
 */


// ════════════════════════════════════════════════════════════════════
//  STEP 1: Add this import near the top of server.js
// ════════════════════════════════════════════════════════════════════

import {
  getBotStatus, getAllBotStatus,
  botStartCycle, botEndCycle, botPosted, botError,
  botSetWallets, botWalletSignal,
} from './bot-status.js';

import { runMigrations } from './db-patch.js';


// ════════════════════════════════════════════════════════════════════
//  STEP 2: In initDb() — after your existing table creation, add:
// ════════════════════════════════════════════════════════════════════

// Inside your initDb() function, after all CREATE TABLE statements:
runMigrations(db);  // safe — skips columns that already exist


// ════════════════════════════════════════════════════════════════════
//  STEP 3: Add this API endpoint to server.js (before app.listen)
// ════════════════════════════════════════════════════════════════════

app.get('/api/bot-status', (req, res) => {
  setCors(res);
  try {
    res.json({ ok: true, ...getAllBotStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


// ════════════════════════════════════════════════════════════════════
//  STEP 4: In your runAutoCallerCycle() function (or multi-bot.js)
//  Wrap the cycle with status updates:
// ════════════════════════════════════════════════════════════════════

// BEFORE your existing cycle code, add:
async function runAutoCallerCycleWithStatus(botId = 'NEW_COINS') {
  botStartCycle(botId);
  const cycleStart = Date.now();
  let candidatesFound = 0;

  try {
    // ... your existing runAutoCallerCycle() code here ...
    // After you get enriched candidates, set:
    // candidatesFound = enriched.length;

    // When a candidate gets posted, call:
    // botPosted(botId, enrichedCandidate.token);

    botEndCycle(botId, { candidatesFound });
  } catch (err) {
    botError(botId, err);
    botEndCycle(botId, { candidatesFound, error: err.message });
    throw err;
  }
}


// ════════════════════════════════════════════════════════════════════
//  STEP 5: Wallet bot status update (in wallet-tracker.js or multi-bot.js)
// ════════════════════════════════════════════════════════════════════

// After tracker.init() completes:
botSetWallets(tracker.getTrackedCount());

// Inside the wallet:buy event handler, when a signal fires:
botWalletSignal(event.tokenSymbol ?? event.tokenAddress?.slice(0, 8));


// ════════════════════════════════════════════════════════════════════
//  STEP 6: Update /api/stats to include bot status
// ════════════════════════════════════════════════════════════════════

// In your existing /api/stats handler, add botStatus to the response:
app.get('/api/stats', (req, res) => {
  setCors(res);
  try {
    const stats      = getStats();
    const decisions  = getDecisionBreakdown();
    const scores     = getScoreDistribution();
    const queueStats = getQueueStats();
    const regime     = getRegimeDashboardData();
    const botStatus  = getAllBotStatus();  // ← ADD THIS

    res.json({
      ok: true,
      stats,
      decisions,
      scores,
      queueStats,
      regime,
      botStatus,           // ← ADD THIS
      scannerWatchlist: getScannerWatchlistSnapshot(),
      mode: { /* your existing mode data */ },
      config: { /* your existing config data */ },
      cycleRunning,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
