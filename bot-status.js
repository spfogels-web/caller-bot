/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  bot-status.js — Real-time bot status tracker
 *
 *  Tracks running / idle / error state for all 3 bots.
 *  Exposed via GET /api/bot-status endpoint.
 *  Dashboard polls this every 5 seconds for live updates.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─── State store ──────────────────────────────────────────────────────────────

const _status = {
  NEW_COINS: {
    id:            'NEW_COINS',
    name:          '🚀 New Coins Bot',
    color:         '#10b981',
    state:         'IDLE',       // IDLE | RUNNING | ERROR | DISABLED
    lastCycleAt:   null,
    lastCycleMs:   null,         // how long the last cycle took
    nextCycleAt:   null,
    lastError:     null,
    lastPosted:    null,         // token symbol of last post
    lastPostedAt:  null,
    postsToday:    0,
    scannedToday:  0,
    cycleCount:    0,
    candidatesLastCycle: 0,
    intervalMs:    2 * 60 * 1000,
  },
  TRENDING: {
    id:            'TRENDING',
    name:          '📈 Trending Bot',
    color:         '#f59e0b',
    state:         'IDLE',
    lastCycleAt:   null,
    lastCycleMs:   null,
    nextCycleAt:   null,
    lastError:     null,
    lastPosted:    null,
    lastPostedAt:  null,
    postsToday:    0,
    scannedToday:  0,
    cycleCount:    0,
    candidatesLastCycle: 0,
    intervalMs:    3 * 60 * 1000,
  },
  WALLET_BOT: {
    id:            'WALLET_BOT',
    name:          '👁 Wallet Bot',
    color:         '#a855f7',
    state:         'IDLE',
    lastCycleAt:   null,
    lastCycleMs:   null,
    nextCycleAt:   null,
    lastError:     null,
    lastPosted:    null,
    lastPostedAt:  null,
    postsToday:    0,
    trackedWallets: 0,
    lastSignalAt:  null,
    lastSignalToken: null,
    cycleCount:    0,
    candidatesLastCycle: 0,
    intervalMs:    0,            // event-driven, no fixed interval
  },
};

// Reset daily counts at midnight
function resetDailyCounters() {
  const now = new Date();
  const msUntilMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) - now;
  setTimeout(() => {
    for (const bot of Object.values(_status)) {
      bot.postsToday   = 0;
      bot.scannedToday = 0;
    }
    console.log('[bot-status] Daily counters reset');
    resetDailyCounters(); // schedule next reset
  }, msUntilMidnight);
}
resetDailyCounters();

// ─── Status update API ────────────────────────────────────────────────────────

export function botStartCycle(botId) {
  const s = _status[botId];
  if (!s) return;
  s.state        = 'RUNNING';
  s.lastCycleAt  = new Date().toISOString();
  s._cycleStart  = Date.now();
  s.cycleCount++;
}

export function botEndCycle(botId, { candidatesFound = 0, error = null } = {}) {
  const s = _status[botId];
  if (!s) return;
  s.state                  = error ? 'ERROR' : 'IDLE';
  s.lastCycleMs            = Date.now() - (s._cycleStart ?? Date.now());
  s.candidatesLastCycle    = candidatesFound;
  s.scannedToday          += candidatesFound;
  s.lastError              = error ?? null;
  if (s.intervalMs > 0) {
    s.nextCycleAt = new Date(Date.now() + s.intervalMs).toISOString();
  }
}

export function botPosted(botId, token) {
  const s = _status[botId];
  if (!s) return;
  s.lastPosted   = token;
  s.lastPostedAt = new Date().toISOString();
  s.postsToday++;
}

export function botSetWallets(count) {
  if (_status.WALLET_BOT) {
    _status.WALLET_BOT.trackedWallets = count;
    _status.WALLET_BOT.state          = count > 0 ? 'IDLE' : 'DISABLED';
  }
}

export function botWalletSignal(token) {
  if (_status.WALLET_BOT) {
    _status.WALLET_BOT.lastSignalAt    = new Date().toISOString();
    _status.WALLET_BOT.lastSignalToken = token;
    _status.WALLET_BOT.state           = 'RUNNING';
    setTimeout(() => {
      if (_status.WALLET_BOT.state === 'RUNNING') {
        _status.WALLET_BOT.state = 'IDLE';
      }
    }, 30_000);
  }
}

export function botError(botId, error) {
  const s = _status[botId];
  if (!s) return;
  s.state     = 'ERROR';
  s.lastError = typeof error === 'string' ? error : error?.message ?? String(error);
}

export function getBotStatus() {
  return Object.values(_status).map(s => ({
    ...s,
    _cycleStart: undefined, // don't expose internal timestamp
    uptimeSec: s.lastCycleAt ? Math.round((Date.now() - new Date(s.lastCycleAt)) / 1000) : null,
    nextCycleInSec: s.nextCycleAt
      ? Math.max(0, Math.round((new Date(s.nextCycleAt) - Date.now()) / 1000))
      : null,
  }));
}

export function getAllBotStatus() {
  return {
    bots: getBotStatus(),
    summary: {
      totalPostsToday: Object.values(_status).reduce((s, b) => s + b.postsToday, 0),
      totalScannedToday: Object.values(_status).reduce((s, b) => s + (b.scannedToday ?? 0), 0),
      anyRunning: Object.values(_status).some(b => b.state === 'RUNNING'),
      anyError:   Object.values(_status).some(b => b.state === 'ERROR'),
    },
  };
}
