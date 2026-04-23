/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  meta-signals.js — the 4 "new signals" built on top of existing enrichment
 *
 *   #1 Pump.fun graduation   — pumpFunMigrated field (added in enricher.js)
 *   #2 Volume acceleration   — uses existing volumeVelocity + volume1hShareOf24h
 *   #3 Narrative/meta match  — self-learned from our own 3x+ WIN calls (7d)
 *   #5 Liquidity trajectory  — new liquidity_snapshots table, delta over time
 *
 *  All bonuses go through the existing `addBonusCapped` budget (default 10).
 *  Penalties are applied directly (bypass cap) per the existing convention.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

// ── Schema setup ─────────────────────────────────────────────────────────────

export function ensureMetaSignalsSchema(dbInstance) {
  try {
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS liquidity_snapshots (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_address TEXT NOT NULL,
        snapshot_at      TEXT NOT NULL DEFAULT (datetime('now')),
        liquidity_usd    REAL,
        market_cap       REAL,
        volume1h         REAL
      );
      CREATE INDEX IF NOT EXISTS idx_ls_ca_time
        ON liquidity_snapshots(contract_address, snapshot_at DESC);
    `);
  } catch (err) { console.warn('[meta-signals] schema:', err.message); }
}

// ── #3 Narrative / meta — self-learned from our own 3x+ WINs in last 7d ──────

let _metaCache = { at: 0, keywords: new Map() };
const META_CACHE_MS = 30 * 60 * 1000;  // 30min
const META_LOOKBACK_DAYS = 7;
const META_MIN_PEAK = 3.0;
const STOPWORDS = new Set([
  'the','and','coin','token','sol','solana','meme','memes','dog','cat',
  'inu','of','on','for','by','io','fun','app','official','new','hot',
  // neutral meme suffixes that show up everywhere
  'guy','girl','boy','world','day','night','time','man','fan','king','queen',
]);

function tokenize(s) {
  if (!s) return [];
  return String(s)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && w.length <= 12 && !STOPWORDS.has(w.toLowerCase()));
}

export function getCurrentMetaKeywords(dbInstance) {
  if (Date.now() - _metaCache.at < META_CACHE_MS) return _metaCache.keywords;
  const keywords = new Map();
  try {
    const rows = dbInstance.prepare(`
      SELECT token FROM calls
      WHERE peak_multiple IS NOT NULL
        AND peak_multiple >= ?
        AND called_at > datetime('now', '-${META_LOOKBACK_DAYS} days')
    `).all(META_MIN_PEAK);
    for (const r of rows) {
      for (const w of tokenize(r.token)) {
        keywords.set(w, (keywords.get(w) ?? 0) + 1);
      }
    }
    // Drop single-occurrence keywords — need at least 2 recent winners with the word
    for (const [k, v] of keywords) if (v < 2) keywords.delete(k);
  } catch (err) {
    console.warn('[meta-signals] meta query failed:', err.message);
  }
  _metaCache = { at: Date.now(), keywords };
  return keywords;
}

export function scoreNarrativeMatch(candidate, metaKeywords) {
  if (!metaKeywords || metaKeywords.size === 0) return { bonus: 0, matched: [] };
  const words = new Set([
    ...tokenize(candidate.token),
    ...tokenize(candidate.tokenName),
  ]);
  const matched = [];
  for (const w of words) {
    if (metaKeywords.has(w)) matched.push({ word: w, wins: metaKeywords.get(w) });
  }
  // +2 per match, cap +4 (so max 2 matched keywords count)
  const bonus = Math.min(4, matched.length * 2);
  return { bonus, matched };
}

// ── #5 Liquidity trajectory ──────────────────────────────────────────────────

const LIQ_MIN_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // one snapshot per 5min max

export function recordLiquiditySnapshot(dbInstance, ca, liqUsd, mcap, vol1h) {
  if (!ca || liqUsd == null) return;
  try {
    const recent = dbInstance.prepare(`
      SELECT snapshot_at FROM liquidity_snapshots
      WHERE contract_address = ?
      ORDER BY snapshot_at DESC LIMIT 1
    `).get(ca);
    if (recent) {
      const lastMs = new Date(recent.snapshot_at.includes('Z') ? recent.snapshot_at : recent.snapshot_at + 'Z').getTime();
      if (Date.now() - lastMs < LIQ_MIN_SNAPSHOT_INTERVAL_MS) return;
    }
    dbInstance.prepare(`
      INSERT INTO liquidity_snapshots (contract_address, liquidity_usd, market_cap, volume1h)
      VALUES (?, ?, ?, ?)
    `).run(ca, liqUsd, mcap ?? null, vol1h ?? null);
  } catch (err) { console.warn('[meta-signals] liq snapshot:', err.message); }
}

export function getLiquidityTrajectory(dbInstance, ca) {
  try {
    const snaps = dbInstance.prepare(`
      SELECT snapshot_at, liquidity_usd FROM liquidity_snapshots
      WHERE contract_address = ?
      ORDER BY snapshot_at DESC LIMIT 10
    `).all(ca);
    if (snaps.length < 2) return null;
    const latest = snaps[0];
    const prior  = snaps[snaps.length - 1];  // oldest of the recent 10
    if (!latest.liquidity_usd || !prior.liquidity_usd) return null;
    const deltaPct  = ((latest.liquidity_usd - prior.liquidity_usd) / prior.liquidity_usd) * 100;
    const priorMs   = new Date(prior.snapshot_at.includes('Z') ? prior.snapshot_at : prior.snapshot_at + 'Z').getTime();
    const spanMins  = Math.max(1, (Date.now() - priorMs) / 60_000);
    const ratePctMin = deltaPct / spanMins;
    let trend = 'FLAT';
    if (deltaPct > 15)  trend = 'GROWING';
    else if (deltaPct < -10) trend = 'SHRINKING';
    return {
      snapshots: snaps.length,
      current:   latest.liquidity_usd,
      prior:     prior.liquidity_usd,
      deltaPct:  +deltaPct.toFixed(1),
      spanMins:  +spanMins.toFixed(1),
      ratePctMin: +ratePctMin.toFixed(2),
      trend,
    };
  } catch (err) {
    console.warn('[meta-signals] liq trajectory:', err.message);
    return null;
  }
}

export function scoreLiquidityTrajectory(traj) {
  if (!traj) return { delta: 0, tag: null };
  if (traj.trend === 'GROWING' && traj.deltaPct >= 30) {
    return { delta: 3, tag: `LIQ_GROWING +${traj.deltaPct.toFixed(0)}% over ${traj.spanMins.toFixed(0)}min (dev committing)` };
  }
  if (traj.trend === 'GROWING') {
    return { delta: 2, tag: `LIQ_GROWING +${traj.deltaPct.toFixed(0)}% over ${traj.spanMins.toFixed(0)}min` };
  }
  if (traj.trend === 'SHRINKING' && traj.deltaPct <= -25) {
    return { delta: -6, tag: `LIQ_DRAINING ${traj.deltaPct.toFixed(0)}% over ${traj.spanMins.toFixed(0)}min — dev pulling LP` };
  }
  if (traj.trend === 'SHRINKING') {
    return { delta: -3, tag: `LIQ_SHRINKING ${traj.deltaPct.toFixed(0)}% over ${traj.spanMins.toFixed(0)}min` };
  }
  return { delta: 0, tag: null };
}

// ── #1 Pump.fun graduation — score based on enricher-set fields ──────────────

export function scorePumpFunGraduation(candidate) {
  if (!candidate.pumpFunMigrated) return { bonus: 0, tag: null };
  // +5 base for completing the bonding curve. +1 if KOTH-tagged. Capped at +6.
  let bonus = 5;
  const notes = [`+5 PUMP_GRADUATED (completed bonding curve)`];
  if (candidate.pumpFunKOTH) { bonus += 1; notes.push(`+1 KOTH`); }
  return { bonus, tag: notes.join(' · ') };
}

// ── #2 Volume acceleration — uses enricher's volumeVelocity (volume1h/volume6h)

export function scoreVolumeAcceleration(candidate) {
  const vv = Number(candidate.volumeVelocity ?? 0);
  const share1h = Number(candidate.volume1hShareOf24h ?? 0);
  // vv = volume1h / volume6h. Steady-state vv = 1/6 ≈ 0.167.
  //   0.25+ → last hour = 1.5x normal pace    → +2
  //   0.40+ → last hour = 2.4x normal pace    → +3
  // share1h = volume1h / volume24h. Steady-state ≈ 1/24 ≈ 0.042.
  //   0.15+ → last hour did 15% of 24h volume → +1 extra
  let bonus = 0;
  const notes = [];
  if (vv >= 0.40)      { bonus += 3; notes.push(`vol_velocity=${vv.toFixed(2)} (≥2.4x normal)`); }
  else if (vv >= 0.25) { bonus += 2; notes.push(`vol_velocity=${vv.toFixed(2)} (≥1.5x normal)`); }
  if (share1h >= 0.15) { bonus += 1; notes.push(`1h=${(share1h*100).toFixed(0)}% of 24h vol`); }
  return { bonus: Math.min(bonus, 4), tag: notes.length ? `VOLUME_ACCEL ${notes.join(' · ')}` : null };
}
