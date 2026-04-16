// ─────────────────────────────────────────────────────────────────────────────
// momentum-tracker.js
//
// Parallel momentum-tracking lane. Runs alongside the main scanner so we
// detect rapid price/volume spikes on candidates we've already discovered
// BEFORE they fully run — sub-minute reaction.
//
// Strategy
//   - Every 15s, grab the top ~40 scored candidates from the last 2h
//   - Hit DexScreener in batches (public, free) to pull current mcap/vol/price
//   - Compare against the most recent snapshot in momentum_snapshots
//   - Flag rapid deltas:
//       PRICE_SPIKE  — mcap up ≥25% since last snapshot
//       VOLUME_SPIKE — volume_5m up ≥2× since last snapshot
//       BREAKOUT     — both conditions
//   - Write a new snapshot row with ms-precision timestamp
//   - Emit event on EventEmitter so server.js can promote / alert
//
// This is the "Node.js async lane" equivalent of the parallel thread
// suggested by OpenAI's plan. Single-process but non-blocking via Promise
// parallelism inside each tick.
// ─────────────────────────────────────────────────────────────────────────────

import { EventEmitter } from 'events';

const BATCH_SIZE        = 30;   // DexScreener accepts comma-joined CAs
const TICK_MS           = 15_000;
const MAX_CANDIDATES    = 40;
const PRICE_SPIKE_PCT   = 25;   // mcap up 25% = PRICE_SPIKE
const VOLUME_SPIKE_MULT = 2.0;  // volume 2x = VOLUME_SPIKE
const REQUEST_TIMEOUT   = 8_000;

export const momentumEmitter = new EventEmitter();

let _intervalHandle = null;
let _running = false;
let _ticksCompleted = 0;
let _spikesSeen = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── DexScreener batch fetch (max 30 CAs per call, comma-separated) ──────────
async function fetchMarketBatch(contractAddresses) {
  if (!contractAddresses.length) return {};
  const joined = contractAddresses.join(',');
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${joined}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!r.ok) return {};
    const j = await r.json();
    const pairs = j?.pairs || [];
    const byCa = {};
    for (const p of pairs) {
      const ca = p.baseToken?.address;
      if (!ca) continue;
      // Keep only the most liquid pair per CA
      if (!byCa[ca] || (p.liquidity?.usd ?? 0) > (byCa[ca].liquidity?.usd ?? 0)) {
        byCa[ca] = p;
      }
    }
    return byCa;
  } catch (err) {
    console.warn('[momentum] fetch batch failed:', err.message);
    return {};
  }
}

// ── One tick: pull candidates, snapshot, detect spikes ──────────────────────
async function runTick(dbInstance) {
  if (_running) return; // skip if prior tick still going
  _running = true;
  const tickStart = Date.now();

  try {
    // 1. Top candidates from last 2h, sorted by score desc
    //    (candidates table uses `evaluated_at`, not created_at — was a
    //    column-name bug causing 'no such column: created_at' errors)
    const candidates = dbInstance.prepare(`
      SELECT contract_address FROM candidates
      WHERE composite_score IS NOT NULL
        AND composite_score >= 30
        AND contract_address IS NOT NULL
        AND evaluated_at > datetime('now', '-2 hours')
      ORDER BY composite_score DESC
      LIMIT ?
    `).all(MAX_CANDIDATES);

    if (!candidates.length) { _running = false; return; }

    const cas = candidates.map(r => r.contract_address).filter(Boolean);

    // 2. Batch fetch current market data
    const batches = [];
    for (let i = 0; i < cas.length; i += BATCH_SIZE) batches.push(cas.slice(i, i + BATCH_SIZE));
    const marketMaps = await Promise.all(batches.map(fetchMarketBatch));
    const market = Object.assign({}, ...marketMaps);

    // 3. Detect spikes + record snapshots
    const insertSnap = dbInstance.prepare(`
      INSERT INTO momentum_snapshots
        (contract_address, snapshot_at_ms, market_cap, liquidity, price_usd,
         volume_5m, buys_5m, sells_5m, delta_mcap_pct, spike_flag)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const getPrev = dbInstance.prepare(`
      SELECT market_cap, volume_5m, snapshot_at_ms FROM momentum_snapshots
      WHERE contract_address = ? ORDER BY id DESC LIMIT 1
    `);

    const spikes = [];
    for (const ca of cas) {
      const p = market[ca];
      if (!p) continue;
      const mcap    = p.marketCap ?? p.fdv ?? null;
      const liq     = p.liquidity?.usd ?? null;
      const price   = parseFloat(p.priceUsd || 0) || null;
      const vol5m   = p.volume?.m5 ?? 0;
      const buys5m  = p.txns?.m5?.buys ?? 0;
      const sells5m = p.txns?.m5?.sells ?? 0;

      const prev = getPrev.get(ca);
      let deltaPct = null;
      let spikeFlag = null;
      if (prev && prev.market_cap && mcap) {
        deltaPct = ((mcap - prev.market_cap) / prev.market_cap) * 100;
        const volMult = prev.volume_5m ? vol5m / prev.volume_5m : null;
        const priceSpike  = deltaPct >= PRICE_SPIKE_PCT;
        const volumeSpike = volMult != null && volMult >= VOLUME_SPIKE_MULT;
        if (priceSpike && volumeSpike) spikeFlag = 'BREAKOUT';
        else if (priceSpike)           spikeFlag = 'PRICE_SPIKE';
        else if (volumeSpike)          spikeFlag = 'VOLUME_SPIKE';
      }
      insertSnap.run(ca, Date.now(), mcap, liq, price, vol5m, buys5m, sells5m, deltaPct, spikeFlag);
      if (spikeFlag) {
        spikes.push({ ca, spikeFlag, deltaPct, mcap, symbol: p.baseToken?.symbol });
        _spikesSeen++;
      }
    }

    _ticksCompleted++;
    if (spikes.length) {
      console.log(`[momentum] tick ${_ticksCompleted} — ${spikes.length} spike(s) in ${Date.now() - tickStart}ms:`,
                  spikes.map(s => `$${s.symbol||s.ca.slice(0,6)}:${s.spikeFlag}(+${s.deltaPct?.toFixed(0)}%)`).join(' '));
      momentumEmitter.emit('spikes', spikes);
    }
  } catch (err) {
    console.warn('[momentum] tick error:', err.message);
  } finally {
    _running = false;
  }
}

/**
 * Start the momentum tracker loop. Call once from server.js startup.
 */
export function startMomentumTracker(dbInstance, intervalMs = TICK_MS) {
  if (_intervalHandle) return _intervalHandle;
  console.log(`[momentum] starting parallel tracker (every ${intervalMs/1000}s, top ${MAX_CANDIDATES} candidates)`);
  // First tick after 30s (let the scanner populate first)
  setTimeout(() => runTick(dbInstance).catch(() => {}), 30_000);
  _intervalHandle = setInterval(() => runTick(dbInstance).catch(() => {}), intervalMs);
  return _intervalHandle;
}

export function stopMomentumTracker() {
  if (_intervalHandle) { clearInterval(_intervalHandle); _intervalHandle = null; }
}

export function getMomentumStats() {
  return { ticksCompleted: _ticksCompleted, spikesSeen: _spikesSeen };
}
