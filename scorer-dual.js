// ─────────────────────────────────────────────────────────────────────────────
// scorer-dual.js  v3 — FOUNDATION SIGNALS architecture
//
// 5 FOUNDATION SIGNALS (100% weight) — movement + intent over static structure:
//
//   1. Volume Velocity      (35 pts) — buys/min acceleration, early explosion
//   2. Buy vs Sell Pressure (25 pts) — frequency + size analysis, demand vs manip
//   3. Wallet Quality       (20 pts) — profitable wallets entering, conviction
//   4. Holder Distribution  (12 pts) — dev wallet (8) + top10 holders (4)
//   5. Liquidity Health     ( 8 pts) — liq:mcap ratio, LP lock, stability
//
// Late-pump penalty applies as final deduction.
//
// Key insight: This is about MOVEMENT and INTENT, not static structure.
// Volume Velocity is the foundation. Real sends show acceleration patterns.
// A clean launch with flat velocity is a red flag.
//
// Weights are dynamic — read from TUNING_CONFIG passed at runtime.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── Default weights ─────────────────────────────────────────────────────────
export const DISCOVERY_WEIGHTS = {
  volumeVelocity:      35,
  buyPressure:         25,
  walletQuality:       20,
  holderDistribution:  12,  // dev wallet (8) + top10 (4) inside
  liquidityHealth:      8,
};

export const RUNNER_WEIGHTS = {
  trendStructure:    20,
  holderRetention:   15,
  breakoutSetup:     15,
  volumeConsistency: 15,
  pullbackRecovery:  10,
  whaleAdds:         10,
  sellerAbsorption:  10,
  attentionSignal:    5,
};

// ── Threshold bands ─────────────────────────────────────────────────────────
export const DISCOVERY_THRESHOLDS = { alert: 75, watchlist: 65, monitor: 55 };
export const RUNNER_THRESHOLDS    = { alert: 80, watchlist: 70, monitor: 60 };

// ── Late-pump penalty config (tunable via setLatePumpConfig) ────────────────
// Softened defaults — the old -25/-40 penalty was murdering legitimate early
// runners (pre-bond pump.fun coins doing 300%+ on a $10K → $30K leg still
// have room). New coins under ageExemptHours are exempt entirely: "late" is
// not a meaningful concept for a 15-minute-old token.
// Late-pump penalties DISABLED per user request — all three penalties set
// to 0. The pre-breakout detector + winner-wallet bonus + Claude's prompt
// bias already steer toward early entries; explicit late-pump deduction
// was killing legitimate continuation plays. Tunable knobs preserved so
// we can re-enable later if needed without code changes.
let _latePumpConfig = {
  p1hSevereThreshold: 500, p1hSeverePenalty: 0,
  p1hThreshold:       300, p1hPenalty:       0,
  p24hThreshold:      500, p24hPenalty:      0,
  ageExemptHours:     0.5,   // <30min old = no late-pump penalty applies
};
export function setLatePumpConfig(cfg = {}) {
  _latePumpConfig = { ..._latePumpConfig, ...cfg };
}
export function getLatePumpConfig() { return { ..._latePumpConfig }; }

// Compute penalty using current config, respecting the age exemption.
function applyLatePumpPenalty(p1h, p24h, ageHours) {
  const cfg = _latePumpConfig;
  if (ageHours != null && ageHours < cfg.ageExemptHours) {
    return { penalty: 0, risk: null, exempt: true };
  }
  if (p1h != null && p1h > cfg.p1hSevereThreshold) {
    return { penalty: cfg.p1hSeverePenalty, risk: `Already pumped +${p1h.toFixed(0)}% 1h — late entry risk` };
  }
  if (p1h != null && p1h > cfg.p1hThreshold) {
    return { penalty: cfg.p1hPenalty, risk: `Up +${p1h.toFixed(0)}% 1h — extended` };
  }
  if (p24h != null && p24h > cfg.p24hThreshold) {
    return { penalty: cfg.p24hPenalty, risk: `Up +${p24h.toFixed(0)}% 24h — extended continuation` };
  }
  return { penalty: 0, risk: null };
}

// ── Utility ─────────────────────────────────────────────────────────────────
function clamp(v, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, v)); }
function safeNum(v, fallback = null) {
  if (v == null || Number.isNaN(+v)) return fallback;
  return +v;
}

// ── Public: age + model routing ─────────────────────────────────────────────
export function getCoinAgeMinutes(candidate) {
  const hours = safeNum(candidate?.pairAgeHours);
  if (hours == null) return null;
  return hours * 60;
}

export function selectScoringModel(ageMinutes) {
  if (ageMinutes == null) return 'discovery';
  if (ageMinutes <= 60)   return 'discovery';
  return 'runner';
}

// ── Buy-velocity fallback ───────────────────────────────────────────────────
// MISSED-WINNER FIX: $HENRY (107x), $Trump (5.96x) and others had buy_velocity
// = NULL on first scan (Birdeye/DexScreener hadn't indexed buy txns yet).
// Without this field, the V5 momentum scorer awarded only 7 pts (20% of max)
// even when 200+ holders piled in within 2 minutes — clearly explosive.
//
// Fallback hierarchy (returns first non-null):
//   1. Direct buyVelocity / buy_velocity field (preferred)
//   2. Computed from buys_1h / 60 (true buys-per-minute)
//   3. Computed from total txns × buy_ratio / 60 (mixed-tx fallback)
//   4. Estimated from holders × discount / age_minutes (adoption proxy)
//   5. Estimated from 5m price velocity * sign + buy ratio (last resort)
//
// Estimation paths (4 + 5) include sniper discount and require positive buy
// ratio so we don't reward bot-driven holder spikes with no real demand.
function computeBuyVelocityWithFallback(c) {
  // 1. Direct field
  const direct = safeNum(c.buyVelocity ?? c.buy_velocity);
  if (direct != null && direct > 0) return { value: direct, source: 'direct' };

  // 2. Computed from buys_1h
  const buys1h = safeNum(c.buys1h ?? c.buys_1h);
  if (buys1h != null && buys1h > 0) {
    return { value: +(buys1h / 60).toFixed(2), source: 'buys_1h' };
  }

  // 3. Computed from total txns × buy ratio
  const sells1h = safeNum(c.sells1h ?? c.sells_1h);
  const br = safeNum(c.buySellRatio1h ?? c.buy_sell_ratio_1h);
  if (buys1h != null && sells1h != null && (buys1h + sells1h) > 0 && br != null) {
    const totalTx = buys1h + sells1h;
    return { value: +((totalTx * br) / 60).toFixed(2), source: 'txn_ratio' };
  }

  // 4. Adoption-rate proxy (holders ÷ age)
  const holders = safeNum(c.holders, 0);
  const ageHours = safeNum(c.pairAgeHours ?? c.pair_age_hours);
  const ageMin = ageHours != null ? ageHours * 60 : null;
  if (holders >= 30 && ageMin != null && ageMin > 0.5) {
    // Discount for snipers (they show up as holders but aren't real demand)
    const snipers = safeNum(c.sniperWalletCount ?? c.sniper_wallet_count, 0);
    const sniperRatio = Math.min(0.5, snipers / Math.max(1, holders));
    const realHolders = holders * (1 - sniperRatio);
    // Assume ~60% of real holders made one buy each over the coin's life
    // (conservative — early launch usually sees 1-3 buys per holder)
    const estimatedBuys = realHolders * 0.6;
    const buysPerMin = estimatedBuys / ageMin;
    // Require buy ratio support — if available, must be > 0.45 (no estimation
    // for sell-dominated coins). If buy ratio is null, allow with discount.
    if (br == null || br > 0.45) {
      const discount = br == null ? 0.7 : 1.0;
      return { value: +(buysPerMin * discount).toFixed(2), source: 'holders_per_min' };
    }
  }

  // 5. Price-velocity proxy (last resort)
  const p5 = safeNum(c.priceChange5m ?? c.price_change_5m);
  if (p5 != null && p5 > 5 && (br == null || br > 0.50)) {
    // Big positive 5m move = lots of buy pressure even without tx counts.
    // Map: +20%/5m → ~3 buys/min, +50%/5m → ~6 buys/min, +100%/5m → ~10
    const estimated = Math.min(15, Math.pow(p5 / 5, 0.55));
    return { value: +estimated.toFixed(2), source: 'price_5m' };
  }

  // No fallback possible
  return { value: null, source: 'none' };
}

// ── Shared behavior metrics ─────────────────────────────────────────────────
export function calculateBehaviorMetrics(candidate) {
  const c = candidate || {};
  const bvFallback = computeBuyVelocityWithFallback(c);

  // buys/sells fallback — when raw counts are missing but we have an estimated
  // buy velocity, estimate buys = bv*60 (1h window). Lets V5 momentum
  // sub-signals (mq.uniqueBuyers, mq.spread, etc) fire on first-scan coins
  // that would otherwise have ZERO transaction data. Use the buy ratio to
  // derive sells from the implied total.
  const rawBuys = safeNum(c.buys1h ?? c.buys_1h);
  const rawSells = safeNum(c.sells1h ?? c.sells_1h);
  const br = safeNum(c.buySellRatio1h ?? c.buy_sell_ratio_1h);
  let buys1h = rawBuys, sells1h = rawSells, txnsEstimated = false;
  if ((rawBuys == null || rawBuys === 0) && bvFallback.value != null && bvFallback.value > 0
      && bvFallback.source !== 'direct') {
    // Estimate from velocity (capped to 1h window worth of activity, cap at age)
    const ageHours = safeNum(c.pairAgeHours ?? c.pair_age_hours, 1);
    const windowH  = Math.min(1, Math.max(0.05, ageHours));
    const estTotal = Math.round(bvFallback.value * 60 * windowH);
    if (br != null && br > 0 && br < 1) {
      buys1h  = Math.round(estTotal * br);
      sells1h = estTotal - buys1h;
    } else {
      // Default to br=0.65 if missing (matches typical clean-launch pattern)
      buys1h  = Math.round(estTotal * 0.65);
      sells1h = estTotal - buys1h;
    }
    txnsEstimated = true;
  }

  return {
    ageMinutes:           getCoinAgeMinutes(c),
    buyVelocity:          bvFallback.value,
    buyVelocitySource:    bvFallback.source,  // 'direct'|'buys_1h'|'txn_ratio'|'holders_per_min'|'price_5m'|'none'
    volumeVelocity:       safeNum(c.volumeVelocity ?? c.volume_velocity),
    launchUbr:            safeNum(c.launchUniqueBuyerRatio ?? c.launch_unique_buyer_ratio),
    buySellRatio1h:       safeNum(c.buySellRatio1h ?? c.buy_sell_ratio_1h),
    buys1h:               buys1h ?? 0,
    sells1h:              sells1h ?? 0,
    txnsEstimated:        txnsEstimated,    // flag for ledger transparency
    marketCap:            safeNum(c.marketCap ?? c.market_cap, 0),
    liquidity:            safeNum(c.liquidity, 0),
    volume1h:             safeNum(c.volume1h ?? c.volume_1h, 0),
    volume6h:             safeNum(c.volume6h ?? c.volume_6h, 0),
    volume24h:            safeNum(c.volume24h ?? c.volume_24h, 0),
    devWalletPct:         safeNum(c.devWalletPct ?? c.dev_wallet_pct),
    insiderWalletPct:     safeNum(c.insiderWalletPct ?? c.insider_wallet_pct),
    top10HolderPct:       safeNum(c.top10HolderPct ?? c.top10_holder_pct),
    holders:              safeNum(c.holders, 0),
    holderGrowth24h:      safeNum(c.holderGrowth24h ?? c.holder_growth_24h),
    sniperWalletCount:    safeNum(c.sniperWalletCount ?? c.sniper_wallet_count, 0),
    clusterWalletCount:   safeNum(c.clusterWalletCount ?? (c.walletIntel?.clusterWalletCount), 0),
    knownWinnerCount:     safeNum(c.knownWinnerWalletCount ?? (c.walletIntel?.knownWinnerWalletCount), 0),
    coordinationIntensity: safeNum(c.coordinationIntensity),
    smartMoneyScore:      safeNum(c.smartMoneyScore ?? c.smart_money_score),
    bundleRisk:           c.bundleRisk ?? c.bundle_risk ?? null,
    bubbleMapRisk:        c.bubbleMapRisk ?? c.bubble_map_risk ?? null,
    mintAuthority:        c.mintAuthority ?? c.mint_authority,
    freezeAuthority:      c.freezeAuthority ?? c.freeze_authority,
    lpLocked:             c.lpLocked ?? c.lp_locked,
    priceChange5m:        safeNum(c.priceChange5m ?? c.price_change_5m),
    priceChange1h:        safeNum(c.priceChange1h ?? c.price_change_1h),
    priceChange6h:        safeNum(c.priceChange6h ?? c.price_change_6h),
    priceChange24h:       safeNum(c.priceChange24h ?? c.price_change_24h),
    website:              !!c.website,
    twitter:              !!c.twitter,
    telegram:             !!c.telegram,
    deployerHistoryRisk:  c.deployerHistoryRisk ?? c.deployer_history_risk ?? null,
    liqMcapRatio:         (c.liquidity && c.marketCap) ? c.liquidity / c.marketCap : null,
    // Momentum metrics — rate of change
    priceVelocity5m:      (() => { const p5=safeNum(c.priceChange5m??c.price_change_5m); return p5!=null?p5/5:null; })(), // %/min
    priceVelocity1h:      (() => { const p1=safeNum(c.priceChange1h??c.price_change_1h); return p1!=null?p1/60:null; })(), // %/min
    momentumShift:        (() => { // 5m velocity vs 1h velocity — positive = accelerating
      const p5=safeNum(c.priceChange5m??c.price_change_5m);
      const p1=safeNum(c.priceChange1h??c.price_change_1h);
      if(p5==null||p1==null)return null;
      return (p5/5)-(p1/60); // difference in %/min
    })(),
    volumeAcceleration:   (() => { // volume1h vs volume6h rate — >1 = accelerating
      const v1=safeNum(c.volume1h??c.volume_1h);
      const v6=safeNum(c.volume6h??c.volume_6h);
      if(!v1||!v6)return null;
      return (v1/1)/(v6/6); // normalize to per-hour
    })(),
    holderGrowthRate:     safeNum(c.holderGrowth24h ?? c.holder_growth_24h),
    // DELTAS — change since last snapshot (populated by server.js before scoring)
    deltas:               c._deltas ?? null,
    // LunarCrush social data
    socialScore:          safeNum(c.socialScore ?? c.galaxyScore),
    socialVolume24h:      safeNum(c.socialVolume24h),
    socialSentiment:      safeNum(c.socialSentiment),
    twitterMentions:      safeNum(c.twitterMentions),
    socialSpike:          !!(c.socialSpike),
    lunarCrushOk:         !!(c.lunarCrushOk),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DISCOVERY MODEL v4 — CONTINUOUS SCORING WITH AUDIT LEDGER
//
// Every point added is logged to a ledger as:
//   { key, label, input, formula, points, tone: 'pos'|'neg' }
// so the UI can show the full line-by-line math behind each score.
//
// Scoring is continuous (smooth curves) instead of tiered bands, so tiny
// differences in input produce tiny differences in output. This eliminates
// the clustering at 58/65/72 that happens when every coin falls into the
// same bucket.
// ─────────────────────────────────────────────────────────────────────────────

// ── Continuous-curve primitives ─────────────────────────────────────────────
// Smooth monotonic interpolation. `x` is the input, `x0`/`x1` bound the
// meaningful range, and the result is scaled to [0..max] with a configurable
// exponent (shape < 1 = concave/front-loaded, shape > 1 = convex/back-loaded).
function curve(x, x0, x1, max, shape = 1) {
  if (x == null || Number.isNaN(+x)) return 0;
  const t = Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
  return max * Math.pow(t, shape);
}

// Symmetric sweet-spot curve — max at `center`, falling off on both sides.
function sweetSpot(x, center, halfWidth, max, tailShape = 1.2) {
  if (x == null || Number.isNaN(+x)) return 0;
  const dist = Math.abs(x - center) / halfWidth;
  if (dist >= 1) return max * Math.max(0, Math.pow(1 - (dist - 1) / 2, tailShape));
  return max * (1 - Math.pow(dist, 2) * 0.25); // quadratic plateau near center
}

export function scoreDiscoveryCoin(candidate, metricsIn = null, weights = null) {
  const m = metricsIn || calculateBehaviorMetrics(candidate);
  const w = weights || DISCOVERY_WEIGHTS;
  const reasons = [];
  const risks = [];
  const parts = {};
  const ledger = [];   // full audit trail: [{ key, label, input, formula, points, tone }]
  const veryEarly = (m.ageMinutes ?? 0) < 15;

  // Helper: record a ledger line and return the points added (for accumulating).
  // Uses 1-decimal precision internally then rounds at signal-level aggregate.
  const add = (key, label, input, formula, points, tone = 'pos') => {
    if (!Number.isFinite(points) || points === 0) return 0;
    ledger.push({ key, label, input, formula, points: +points.toFixed(2), tone });
    return points;
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. VOLUME VELOCITY (max: 35) — continuous curve over buys/min
  //    bv=12+ → 35 (explosive), bv=5 → ~25, bv=1 → ~6, bv=0 → 0
  //    Shape 0.6 is front-loaded: small increases at low bv matter more.
  // ═══════════════════════════════════════════════════════════════════════════
  const maxVV = w.volumeVelocity || 35;
  const bv = m.buyVelocity ?? m.volumeVelocity;
  let vvAcc = 0;

  if (bv == null) {
    const est = maxVV * 0.20;
    vvAcc += add('vv.base', 'Velocity base (unknown — very early)', 'bv=null', `=${est.toFixed(1)}`, est, 'neg');
    risks.push('Volume velocity unknown — very early');
  } else {
    const base = curve(bv, 0, 12, maxVV * 0.82, 0.6); // up to ~28.7 from bv alone
    // Surface velocity SOURCE in the ledger so we can audit which fallback fired.
    // 'direct' / 'buys_1h' / 'txn_ratio' = real data. 'holders_per_min' /
    // 'price_5m' = estimated from proxy signals (still valid but flagged).
    const src = m.buyVelocitySource || 'direct';
    const srcLabel = src === 'direct' || src === 'buys_1h' || src === 'txn_ratio'
      ? `bv=${bv.toFixed(2)}/min`
      : `bv=${bv.toFixed(2)}/min ESTIMATED (${src})`;
    vvAcc += add('vv.base', 'Velocity base', srcLabel, `curve(bv,0→12,28.7,s=0.6)=${base.toFixed(1)}`, base);
    if (bv >= 8)        reasons.push(`EXPLOSIVE velocity (${bv.toFixed(1)} buys/min${src !== 'direct' && src !== 'buys_1h' && src !== 'txn_ratio' ? ' est' : ''})`);
    else if (bv >= 4)   reasons.push(`Strong velocity (${bv.toFixed(1)} buys/min${src !== 'direct' && src !== 'buys_1h' && src !== 'txn_ratio' ? ' est' : ''})`);
    else if (bv >= 1.5) reasons.push(`Developing velocity (${bv.toFixed(1)} buys/min)`);
    else if (bv < 0.7)  risks.push(`Weak velocity (${bv.toFixed(1)} buys/min)`);
  }

  // Acceleration bonus — continuous based on 5m vs 1h rate
  if (m.priceChange5m != null && m.priceChange1h != null) {
    const runRate5m = m.priceChange5m;
    const avgRate1h = m.priceChange1h / 12;
    if (avgRate1h > -50 && runRate5m > 0) {
      const ratio = avgRate1h !== 0 ? runRate5m / Math.max(0.01, Math.abs(avgRate1h)) : runRate5m;
      if (ratio > 1.2) {
        const pts = curve(ratio, 1.2, 3.0, maxVV * 0.10, 0.8);
        vvAcc += add('vv.accel5m', '5m accel vs 1h avg', `ratio=${ratio.toFixed(2)}x`, `curve=${pts.toFixed(1)}`, pts);
        reasons.push(`Accelerating — 5m rate ${ratio.toFixed(1)}x of 1h avg`);
      }
    }
  }

  // Momentum shift — continuous
  if (m.momentumShift != null) {
    if (m.momentumShift > 0) {
      const pts = curve(m.momentumShift, 0, 2.0, maxVV * 0.08, 0.7);
      if (pts > 0.1) {
        vvAcc += add('vv.momentum', 'Momentum shift (breakout forming)', `+${m.momentumShift.toFixed(2)}%/min`, `curve=${pts.toFixed(1)}`, pts);
        reasons.push(`Momentum shift +${m.momentumShift.toFixed(2)}%/min`);
      }
    } else if (m.momentumShift < -0.5) {
      const pts = -curve(Math.abs(m.momentumShift), 0.5, 3.0, maxVV * 0.08, 0.8);
      vvAcc += add('vv.momentum.neg', 'Momentum fading', `${m.momentumShift.toFixed(2)}%/min`, `curve=${pts.toFixed(1)}`, pts, 'neg');
      risks.push(`Momentum fading ${m.momentumShift.toFixed(2)}%/min`);
    }
  }

  // Volume acceleration — vol1h vs vol6h hourly rate
  if (m.volumeAcceleration != null && m.volumeAcceleration > 1.2) {
    const pts = curve(m.volumeAcceleration, 1.2, 4.0, maxVV * 0.08, 0.7);
    vvAcc += add('vv.volAccel', 'Volume accelerating vs 6h avg', `${m.volumeAcceleration.toFixed(2)}x`, `curve=${pts.toFixed(1)}`, pts);
    if (m.volumeAcceleration > 2) reasons.push(`Volume accelerating ${m.volumeAcceleration.toFixed(1)}x vs 6h avg`);
  }

  // Sustained pressure
  if ((m.buys1h ?? 0) >= 30 && bv != null && bv >= 0.3) {
    const pts = curve(m.buys1h, 30, 250, maxVV * 0.08, 0.6);
    vvAcc += add('vv.sustained', 'Sustained buy pressure', `${m.buys1h} buys/1h`, `curve=${pts.toFixed(1)}`, pts);
    if (m.buys1h >= 80) reasons.push(`Sustained pressure: ${m.buys1h} buys in 1h`);
  }

  // Social spike
  if (m.socialSpike) {
    const pts = maxVV * 0.08;
    vvAcc += add('vv.socialSpike', 'Social spike detected (Twitter 2x+ baseline)', 'spike=true', `+${pts.toFixed(1)}`, pts);
    reasons.push('Social spike detected');
  } else if ((m.twitterMentions ?? 0) > 20) {
    const pts = curve(m.twitterMentions, 20, 200, maxVV * 0.05, 0.7);
    vvAcc += add('vv.social', 'Active Twitter presence', `${m.twitterMentions} mentions`, `curve=${pts.toFixed(1)}`, pts);
    reasons.push(`Active Twitter presence (${m.twitterMentions} mentions)`);
  }

  parts.volumeVelocity = Math.round(Math.max(0, Math.min(maxVV, vvAcc)));

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. BUY vs SELL PRESSURE (max: 25) — continuous over buy ratio
  // ═══════════════════════════════════════════════════════════════════════════
  const maxBP = w.buyPressure || 25;
  const br = m.buySellRatio1h;
  const totalTxns = (m.buys1h ?? 0) + (m.sells1h ?? 0);
  let bpAcc = 0;

  if (br == null) {
    const est = maxBP * 0.30;
    bpAcc += add('bp.base', 'Buy pressure base (unknown)', 'br=null', `=${est.toFixed(1)}`, est);
  } else {
    // Continuous: 0.35 → 0 pts, 0.50 → ~8 pts, 0.65 → ~16 pts, 0.85+ → 25 pts
    const base = curve(br, 0.35, 0.85, maxBP, 1.4);
    bpAcc += add('bp.base', 'Buy ratio base', `br=${(br*100).toFixed(1)}%`, `curve(br,0.35→0.85,s=1.4)=${base.toFixed(1)}`, base);
    if (br >= 0.85)      reasons.push(`Overwhelming buy dominance (${(br*100).toFixed(0)}%)`);
    else if (br >= 0.65) reasons.push(`Strong buy pressure (${(br*100).toFixed(0)}%)`);
    else if (br >= 0.55) reasons.push(`Healthy buy edge (${(br*100).toFixed(0)}%)`);
    else if (br < 0.40)  risks.push(`Sellers dominating (${(br*100).toFixed(0)}% buys) — EXIT LIQUIDITY RISK`);
    else if (br < 0.50)  risks.push(`Sell pressure building (${(br*100).toFixed(0)}% buys)`);
  }

  // Volume depth — continuous
  if (totalTxns >= 20) {
    const pts = curve(totalTxns, 20, 300, 3.0, 0.6);
    bpAcc += add('bp.depth', 'Transaction depth', `${totalTxns} txns/1h`, `curve=${pts.toFixed(1)}`, pts);
    if (totalTxns >= 150) reasons.push(`Very active: ${totalTxns} transactions/1h`);
  }

  // Exit liquidity trap
  if ((m.buys1h ?? 0) > 50 && (m.sells1h ?? 0) > 0 && m.buys1h / m.sells1h > 10 && br != null && br < 0.60) {
    const pts = -5;
    bpAcc += add('bp.exitLiq', 'Micro buys + large sells (exit liq risk)', `buys/sells=${(m.buys1h/m.sells1h).toFixed(1)}`, `=${pts}`, pts, 'neg');
    risks.push('Micro buys + large sells — possible exit liquidity');
  }

  parts.buyPressure = Math.round(Math.max(0, Math.min(maxBP, bpAcc)));

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. WALLET QUALITY (max: 20) — continuous blend of winners + smart money
  //    + cluster/coord + behavioral defaults. No more hard tiers that cluster
  //    every fresh coin at exactly 9 pts.
  // ═══════════════════════════════════════════════════════════════════════════
  const maxWQ = w.walletQuality || 20;
  const winners  = m.knownWinnerCount ?? 0;
  const clusters = m.clusterWalletCount ?? 0;
  const coord    = m.coordinationIntensity ?? 0;
  const smartMoney = m.smartMoneyScore ?? 0;
  let wqAcc = 0;

  // Winner contribution — continuous, 0 winners = 0, 5 winners = ~22 (cap 20)
  if (winners > 0) {
    const pts = curve(winners, 0, 5, maxWQ + 2, 0.65); // allow slight overshoot that clamps later
    wqAcc += add('wq.winners', 'Known winner wallets (early)', `${winners} winners`, `curve=${pts.toFixed(1)}`, pts);
    if (winners >= 4)      reasons.push(`${winners} winner wallets — EXCEPTIONAL conviction`);
    else if (winners >= 2) reasons.push(`${winners} winner wallets — very strong signal`);
    else                   reasons.push(`${winners} winner wallet — meaningful signal`);
  }

  // Smart money score — continuous, applied alongside winners (not as fallback)
  // Weighted lower when winners are already present to avoid double-counting.
  // Fallback weight (no winners) raised 0.55 → 0.80 so coins without Dune hits
  // can reach 16/20 instead of capping at 11/20. Compensates for thin Dune DB.
  if (smartMoney > 0) {
    const weight = winners >= 2 ? 0.15 : winners >= 1 ? 0.30 : 0.80;
    const pts = curve(smartMoney, 20, 90, maxWQ * weight, 0.8);
    if (pts > 0.1) {
      wqAcc += add('wq.smart', 'Smart money score', `sm=${smartMoney}`, `curve*${weight}=${pts.toFixed(1)}`, pts);
      if (smartMoney >= 60) reasons.push(`Smart money signal (score ${smartMoney})`);
    }
  }

  // Clean wallet fallback — only applies when no strong positive signal yet
  // Awards continuous points based on "cleanliness" (low clusters + low coord)
  // Fallback weight raised 0.45 → 0.80 (per user) — clean-behavior coins can
  // reach 16/20 when no winners are available (Dune DB thin).
  if (winners === 0 && smartMoney < 20) {
    const cleanScore = Math.max(0, 1 - (clusters * 0.15 + coord * 0.6));
    const pts = cleanScore * maxWQ * 0.80;
    wqAcc += add('wq.clean', 'Wallet cleanliness (cold DB fallback)', `clusters=${clusters} coord=${coord.toFixed(2)}`, `clean=${cleanScore.toFixed(2)} → ${pts.toFixed(1)}`, pts);
    if (cleanScore > 0.85) reasons.push('Clean wallet behavior — no coordination');
    else if (cleanScore < 0.4) risks.push(`${clusters} cluster wallets + coord ${coord.toFixed(2)}`);
  }

  // Cluster penalty — continuous (soft, since clusters can be neutral)
  if (clusters > 3) {
    const pts = -curve(clusters, 3, 15, maxWQ * 0.35, 0.9);
    wqAcc += add('wq.clusters', 'Cluster wallet penalty', `${clusters} clusters`, `curve=${pts.toFixed(1)}`, pts, 'neg');
    if (clusters > 6) risks.push(`${clusters} cluster wallets — coordination concern`);
  }

  // Bundle risk — only SEVERE with no winners penalizes (and not very-early)
  if (m.bundleRisk === 'SEVERE' && winners < 1 && !veryEarly) {
    const pts = -maxWQ * 0.30;
    wqAcc += add('wq.bundleSevere', 'Bundle SEVERE + no winners', 'bundle=SEVERE', `=${pts.toFixed(1)}`, pts, 'neg');
    risks.push('Bundle SEVERE + no winners — coordinated dump risk');
  } else if (m.bundleRisk === 'HIGH' && winners < 1 && !veryEarly) {
    risks.push('Bundle HIGH detected — monitoring (no score penalty)');
  }

  // Sniper flag (only penalize at extreme levels)
  const snipers = m.sniperWalletCount ?? 0;
  if (snipers > 30) {
    const pts = -curve(snipers, 30, 80, 4, 0.8);
    wqAcc += add('wq.snipers', 'Sniper overload', `${snipers} snipers`, `curve=${pts.toFixed(1)}`, pts, 'neg');
    risks.push(`${snipers} sniper wallets — watch share, possible dump wave`);
  } else if (snipers > 20) {
    risks.push(`${snipers} snipers — monitor their share`);
  }

  // BubbleMap penalty
  if (m.bubbleMapRisk === 'SEVERE') {
    wqAcc += add('wq.bubbleSev', 'BubbleMap SEVERE', 'bubbleMap=SEVERE', '=-8', -8, 'neg');
    risks.push('BubbleMap SEVERE — coordinated wallet cluster');
  } else if (m.bubbleMapRisk === 'HIGH') {
    wqAcc += add('wq.bubbleHigh', 'BubbleMap HIGH', 'bubbleMap=HIGH', '=-4', -4, 'neg');
    risks.push('BubbleMap HIGH — suspicious wallet patterns');
  }

  parts.walletQuality = Math.round(Math.max(0, Math.min(maxWQ, wqAcc)));

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. HOLDER DISTRIBUTION (max: 12) — continuous dev + top10
  // ═══════════════════════════════════════════════════════════════════════════
  const maxHD = w.holderDistribution || 12;
  const devMax = maxHD * 0.667;   // ~8 of 12
  const top10Max = maxHD - devMax; // ~4 of 12
  const mintRevoked = m.mintAuthority === 0;

  // ── Dev Wallet — continuous, 0% = max, 20%+ = 0 ──
  let devPts = 0;
  const dev = m.devWalletPct;
  if (dev == null) {
    devPts = veryEarly ? devMax * 0.60 : devMax * 0.35;
    add('hd.dev', 'Dev wallet (unknown)', 'dev=null', `=${devPts.toFixed(1)}`, devPts);
  } else {
    // Inverse curve: dev=0 → devMax, dev=20 → 0
    devPts = Math.max(0, devMax * Math.pow(1 - Math.min(1, dev / 20), 1.4));
    add('hd.dev', 'Dev wallet %', `dev=${dev.toFixed(2)}%`, `(1-dev/20)^1.4 * 8 = ${devPts.toFixed(1)}`, devPts);
    if (dev <= 2)       reasons.push(`Clean dev: ${dev.toFixed(1)}%${mintRevoked ? ', mint revoked' : ''}`);
    else if (dev <= 5)  reasons.push(`Low dev allocation (${dev.toFixed(1)}%)`);
    else if (dev <= 10) reasons.push(`Moderate dev allocation (${dev.toFixed(1)}%)`);
    else if (dev <= 15) risks.push(`Dev holds ${dev.toFixed(1)}% — heavy allocation`);
    else                risks.push(`Dev wallet ${dev.toFixed(1)}% — INSTANT DISQUALIFIER`);
  }
  if (m.deployerHistoryRisk === 'SERIAL_RUGGER') {
    add('hd.rugger', 'Serial rugger deployer', 'rugger=true', '= -dev points', -devPts, 'neg');
    devPts = 0;
    risks.push('Serial rugger deployer — AVOID');
  }

  // ── Top 10 Holders — continuous, <25% = max, 85%+ = near-zero ──
  let top10Pts = 0;
  const top10 = m.top10HolderPct;
  if (top10 == null) {
    top10Pts = veryEarly ? top10Max * 0.60 : top10Max * 0.40;
    add('hd.top10', 'Top10 holders (unknown)', 'top10=null', `=${top10Pts.toFixed(1)}`, top10Pts);
  } else {
    // 0-25% = full, 25-85% = decaying
    if (top10 <= 25) {
      top10Pts = top10Max;
      add('hd.top10', 'Top10 holders (healthy)', `top10=${top10.toFixed(1)}%`, `=${top10Pts.toFixed(1)}`, top10Pts);
      reasons.push(`Healthy distribution (top10: ${top10.toFixed(0)}%)`);
    } else {
      const decay = Math.max(0, 1 - (top10 - 25) / 60);
      top10Pts = top10Max * Math.pow(decay, 1.2);
      add('hd.top10', 'Top10 holders', `top10=${top10.toFixed(1)}%`, `decay^1.2 * 4 = ${top10Pts.toFixed(1)}`, top10Pts);
      if (top10 >= 70)      risks.push(`Whale-dominated (top10: ${top10.toFixed(0)}%)`);
      else if (top10 >= 50) risks.push(`Concentrated (top10: ${top10.toFixed(0)}%)`);
    }
  }

  parts.holderDistribution = Math.round(devPts + top10Pts);
  parts._devWallet = Math.round(devPts);
  parts._top10Holders = Math.round(top10Pts);

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. LIQUIDITY HEALTH (max: 8) — sweet-spot curve around 20-30% ratio
  // ═══════════════════════════════════════════════════════════════════════════
  const maxLH = w.liquidityHealth || 8;
  const lr = m.liqMcapRatio;
  let lhAcc = 0;

  if (lr == null) {
    const est = maxLH * 0.30;
    lhAcc += add('lh.base', 'Liquidity ratio (unknown)', 'ratio=null', `=${est.toFixed(1)}`, est);
  } else {
    // Sweet spot at 25% ratio, plateau 10-40%, decay outside
    const pts = sweetSpot(lr, 0.25, 0.20, maxLH, 1.3);
    lhAcc += add('lh.base', 'Liq/MCap ratio', `ratio=${(lr*100).toFixed(1)}%`, `sweetSpot(25±20%)=${pts.toFixed(1)}`, pts);
    if (lr >= 0.15 && lr <= 0.40)      reasons.push(`Optimal liquidity ratio (${(lr*100).toFixed(0)}%)`);
    else if (lr >= 0.10)               reasons.push(`Healthy liquidity (${(lr*100).toFixed(0)}%)`);
    else if (lr >= 0.05)               risks.push(`Below-average liquidity (${(lr*100).toFixed(0)}%)`);
    else if (lr >= 0.02)               risks.push(`Thin liquidity (${(lr*100).toFixed(0)}%) — rug risk`);
    else                               risks.push('Dangerously low liquidity — easy rug');
  }

  // LP locked = safety premium
  if (m.lpLocked === 1) {
    const pts = maxLH * 0.20;
    lhAcc += add('lh.lpLock', 'LP locked', 'lpLocked=1', `+${pts.toFixed(1)}`, pts);
    reasons.push('LP locked');
  }

  // Mint authority — if still active, dev can print tokens (rug vector)
  if (m.mintAuthority === 1) {
    lhAcc += add('lh.mintActive', 'Mint authority ACTIVE (rug vector)', 'mint=1', '=-2', -2, 'neg');
    risks.push('Mint authority ACTIVE — dev can inflate supply');
  } else if (m.mintAuthority === 0) {
    reasons.push('Mint revoked');
  }

  // Freeze authority — dev can freeze your tokens
  if (m.freezeAuthority === 1) {
    lhAcc += add('lh.freezeActive', 'Freeze authority ACTIVE', 'freeze=1', '=-1', -1, 'neg');
    risks.push('Freeze authority ACTIVE — tokens can be frozen');
  }

  parts.liquidityHealth = Math.round(Math.max(0, Math.min(maxLH, lhAcc)));

  // ═══════════════════════════════════════════════════════════════════════════
  // FALLING KNIFE DETECTOR — we don't buy dips, we buy confirmed strength.
  //
  // Philosophy: Strength leads to more strength. Weakness leads to more weakness.
  // We are momentum snipers, not bottom fishers. Most 10x coins come from clean
  // breakouts, not from catching knives.
  //
  // KNIFE CONDITIONS (any 2+ = AUTO IGNORE):
  //   - Price drops >25% in 5 minutes (sharp drawdown)
  //   - Sells dominating 1h (buy ratio < 35%)
  //   - No bounce after dump (5m still negative after big 1h drop)
  //   - Volume UP but price DOWN (distribution signature)
  //
  // RECOVERY CONFIRMATION (bonuses if reclaimed):
  //   - Price dropped AND recovered ≥50% of the drop
  //   - 5m positive after 1h negative (higher low forming)
  // ═══════════════════════════════════════════════════════════════════════════
  const kP5m  = m.priceChange5m;
  const kP1h  = m.priceChange1h;
  const kBr   = m.buySellRatio1h;
  const kV1   = m.volume1h;
  const kV6   = m.volume6h;

  let knifeSignals = 0;
  const knifeRisks = [];

  // Condition 1: Sharp drawdown in 5min
  if (kP5m != null && kP5m < -25) {
    knifeSignals++;
    knifeRisks.push(`Sharp drawdown: ${kP5m.toFixed(0)}% in 5m — falling knife`);
  }

  // Condition 2: Sellers dominating
  if (kBr != null && kBr < 0.35) {
    knifeSignals++;
    knifeRisks.push(`Sellers dominating: only ${(kBr*100).toFixed(0)}% buys`);
  }

  // Condition 3: No bounce — 5m still red after 1h drop
  if (kP1h != null && kP1h < -15 && kP5m != null && kP5m < 0) {
    knifeSignals++;
    knifeRisks.push(`No bounce: 1h ${kP1h.toFixed(0)}% + 5m ${kP5m.toFixed(0)}% still bleeding`);
  }

  // Condition 4: Distribution signature — volume spike + price down
  if (kV1 != null && kV6 != null && kV6 > 0 && kP1h != null) {
    const volAccel = (kV1 / 1) / (kV6 / 6);
    if (volAccel > 1.5 && kP1h < -10) {
      knifeSignals++;
      knifeRisks.push(`Distribution: volume ${volAccel.toFixed(1)}x normal + price ${kP1h.toFixed(0)}% down`);
    }
  }

  let knifePenalty = 0;
  if (knifeSignals >= 3) {
    knifePenalty = 50;
    add('knife.3plus', `FALLING KNIFE (${knifeSignals} conditions)`, knifeRisks.join(' · '), '=-50', -50, 'neg');
    risks.push(`🔪 FALLING KNIFE DETECTED (${knifeSignals} conditions) — ${knifeRisks[0]}`);
  } else if (knifeSignals === 2) {
    knifePenalty = 30;
    add('knife.2', `Weakness warning (${knifeSignals} conditions)`, knifeRisks.join(' · '), '=-30', -30, 'neg');
    risks.push(`⚠️ Weakness warning (${knifeSignals} conditions) — ${knifeRisks[0]}`);
  } else if (knifeSignals === 1) {
    knifePenalty = 15;
    add('knife.1', 'Weakness signal (1 condition)', knifeRisks[0] ?? '', '=-15', -15, 'neg');
    risks.push(`⚠️ Weakness signal: ${knifeRisks[0]}`);
  }

  // RECOVERY BONUS — price dropped but reclaimed, showing strength return
  let recoveryBonus = 0;
  if (knifeSignals === 0 && kP1h != null && kP1h < -10 && kP5m != null && kP5m > 5) {
    recoveryBonus = 8;
    add('recovery.full', 'Recovery confirmed (1h drop + 5m strong bounce)', `1h=${kP1h.toFixed(1)}% 5m=+${kP5m.toFixed(1)}%`, '=+8', 8);
    reasons.push(`✅ Recovery confirmed: 1h ${kP1h.toFixed(0)}% but 5m +${kP5m.toFixed(0)}% — buyers stepping in`);
  } else if (knifeSignals === 0 && kBr != null && kBr > 0.65 && kP5m != null && kP5m > 2) {
    recoveryBonus = 4;
    add('recovery.strength', 'Strength confirmed (high buys + 5m up)', `br=${(kBr*100).toFixed(0)}% 5m=+${kP5m.toFixed(1)}%`, '=+4', 4);
    reasons.push(`✅ Strength confirmed: ${(kBr*100).toFixed(0)}% buys + 5m +${kP5m.toFixed(0)}%`);
  }

  parts.latePumpPenalty = -knifePenalty + recoveryBonus;
  parts._knifePenalty   = knifePenalty;
  parts._recoveryBonus  = recoveryBonus;
  parts._knifeSignals   = knifeSignals;

  // ═══════════════════════════════════════════════════════════════════════════
  // DELTA SIGNALS — see the DIRECTION of change since last rescan
  // Lets the bot detect patterns that only emerge over time.
  // ═══════════════════════════════════════════════════════════════════════════
  let deltaScore = 0;
  if (m.deltas && m.deltas.minutesAgo >= 0.5 && m.deltas.minutesAgo <= 30) {
    const d = m.deltas;

    // MCap delta — continuous
    if (d.mcapDelta != null) {
      if (d.mcapDelta > 0) {
        const pts = curve(d.mcapDelta, 3, 60, 10, 0.7);
        if (pts > 0.3) {
          deltaScore += add('delta.mcap', 'MCap climbing since last scan', `+${d.mcapDelta.toFixed(1)}% in ${d.minutesAgo.toFixed(0)}m`, `curve=${pts.toFixed(1)}`, pts);
          if (d.mcapDelta > 30) reasons.push(`📈 MCap +${d.mcapDelta.toFixed(0)}% since ${d.minutesAgo.toFixed(0)}m ago — pumping now`);
          else if (d.mcapDelta > 10) reasons.push(`MCap +${d.mcapDelta.toFixed(0)}% since last scan — climbing`);
        }
      } else if (d.mcapDelta < -5) {
        const pts = -curve(Math.abs(d.mcapDelta), 5, 50, 12, 0.8);
        deltaScore += add('delta.mcap.neg', 'MCap dropping since last scan', `${d.mcapDelta.toFixed(1)}% in ${d.minutesAgo.toFixed(0)}m`, `curve=${pts.toFixed(1)}`, pts, 'neg');
        if (d.mcapDelta < -20) risks.push(`📉 MCap ${d.mcapDelta.toFixed(0)}% — dumping`);
        else if (d.mcapDelta < -10) risks.push(`MCap ${d.mcapDelta.toFixed(0)}% — weakening`);
      }
    }

    // Holder delta — continuous
    if (d.holderDelta != null) {
      if (d.holderDelta > 5) {
        const pts = curve(d.holderDelta, 5, 100, 7, 0.65);
        deltaScore += add('delta.holders', 'Holder growth acceleration', `+${d.holderDelta.toFixed(1)}%`, `curve=${pts.toFixed(1)}`, pts);
        if (d.holderDelta > 50) reasons.push(`👥 Holders +${d.holderDelta.toFixed(0)}% — explosive adoption`);
        else if (d.holderDelta > 20) reasons.push(`Holders +${d.holderDelta.toFixed(0)}% — growing organically`);
      } else if (d.holderDelta < -3) {
        const pts = -curve(Math.abs(d.holderDelta), 3, 30, 5, 0.8);
        deltaScore += add('delta.holders.neg', 'Holders exiting', `${d.holderDelta.toFixed(1)}%`, `curve=${pts.toFixed(1)}`, pts, 'neg');
        risks.push(`Holders ${d.holderDelta.toFixed(0)}% — exits detected`);
      }
    }

    // Dev wallet delta — only material drops (>2%) matter
    if (d.devPctDelta != null) {
      if (d.devPctDelta < -5) {
        const pts = -20;
        deltaScore += add('delta.devDump', 'DEV DUMPING', `dev% dropped ${Math.abs(d.devPctDelta).toFixed(1)}%`, `=${pts}`, pts, 'neg');
        risks.push(`🚨 DEV DUMPING: dev% dropped ${Math.abs(d.devPctDelta).toFixed(1)}%`);
      } else if (d.devPctDelta < -2) {
        const pts = -curve(Math.abs(d.devPctDelta), 2, 5, 10, 0.9);
        deltaScore += add('delta.devSell', 'DEV SELLING', `dev% dropped ${Math.abs(d.devPctDelta).toFixed(1)}%`, `curve=${pts.toFixed(1)}`, pts, 'neg');
        risks.push(`🚨 DEV SELLING: dev% dropped ${Math.abs(d.devPctDelta).toFixed(1)}%`);
      } else if (d.devPctDelta > 2) {
        const pts = -curve(d.devPctDelta, 2, 10, 5, 0.9);
        deltaScore += add('delta.devAdd', 'Dev adding (suspicious)', `+${d.devPctDelta.toFixed(1)}%`, `curve=${pts.toFixed(1)}`, pts, 'neg');
        risks.push(`Dev adding: +${d.devPctDelta.toFixed(1)}% — suspicious`);
      }
    }

    // Top10 concentration rising
    if (d.top10Delta != null && d.top10Delta > 5) {
      const pts = -curve(d.top10Delta, 5, 30, 6, 0.8);
      deltaScore += add('delta.top10', 'Top10 concentration rising', `+${d.top10Delta.toFixed(1)}%`, `curve=${pts.toFixed(1)}`, pts, 'neg');
      if (d.top10Delta > 10) risks.push(`Top10 concentration +${d.top10Delta.toFixed(0)}% — whale accumulation`);
    }

    // Buy ratio delta — continuous
    if (d.buyRatioDelta != null) {
      if (d.buyRatioDelta > 0.05) {
        const pts = curve(d.buyRatioDelta, 0.05, 0.30, 6, 0.7);
        deltaScore += add('delta.buyRatio', 'Buy pressure strengthening', `+${(d.buyRatioDelta*100).toFixed(1)}pp`, `curve=${pts.toFixed(1)}`, pts);
        if (d.buyRatioDelta > 0.15) reasons.push(`Buy pressure strengthening +${(d.buyRatioDelta*100).toFixed(0)}pp`);
      } else if (d.buyRatioDelta < -0.05) {
        const pts = -curve(Math.abs(d.buyRatioDelta), 0.05, 0.30, 6, 0.8);
        deltaScore += add('delta.buyRatio.neg', 'Buy pressure weakening', `${(d.buyRatioDelta*100).toFixed(1)}pp`, `curve=${pts.toFixed(1)}`, pts, 'neg');
        if (d.buyRatioDelta < -0.15) risks.push(`Buy pressure weakening — sellers taking over`);
      }
    }

    // Velocity delta
    if (d.velocityDelta != null) {
      if (d.velocityDelta > 0.5) {
        const pts = curve(d.velocityDelta, 0.5, 8, 5, 0.7);
        deltaScore += add('delta.velocity', 'Velocity accelerating', `+${d.velocityDelta.toFixed(2)} buys/min`, `curve=${pts.toFixed(1)}`, pts);
        if (d.velocityDelta > 2) reasons.push(`Velocity accelerating +${d.velocityDelta.toFixed(1)} buys/min`);
      } else if (d.velocityDelta < -0.5) {
        const pts = -curve(Math.abs(d.velocityDelta), 0.5, 8, 4, 0.8);
        deltaScore += add('delta.velocity.neg', 'Velocity fading', `${d.velocityDelta.toFixed(2)} buys/min`, `curve=${pts.toFixed(1)}`, pts, 'neg');
        if (d.velocityDelta < -2) risks.push(`Velocity fading ${d.velocityDelta.toFixed(1)} buys/min`);
      }
    }

    // Liquidity delta — warn only
    if (d.liquidityDelta != null && d.liquidityDelta < -25) {
      risks.push(`⚠️ Liquidity dropped ${d.liquidityDelta.toFixed(0)}% — watch closely`);
    }

    // Score trend between rescans
    if (d.prevScore != null) {
      const scoreTrend = (parts.volumeVelocity + parts.buyPressure + parts.walletQuality + parts.holderDistribution + parts.liquidityHealth) - d.prevScore;
      if (scoreTrend > 4) {
        const pts = curve(scoreTrend, 4, 25, 4, 0.7);
        deltaScore += add('delta.trend', 'Score trending up', `+${scoreTrend.toFixed(0)} vs prev`, `curve=${pts.toFixed(1)}`, pts);
        if (scoreTrend > 8) reasons.push(`Score trending up (+${scoreTrend}) — improving fundamentals`);
      } else if (scoreTrend < -4) {
        const pts = -curve(Math.abs(scoreTrend), 4, 25, 4, 0.8);
        deltaScore += add('delta.trend.neg', 'Score trending down', `${scoreTrend.toFixed(0)} vs prev`, `curve=${pts.toFixed(1)}`, pts, 'neg');
        if (scoreTrend < -8) risks.push(`Score trending down (${scoreTrend}) — deteriorating`);
      }
    }
  }
  parts.deltaScore = +deltaScore.toFixed(1);

  // ── DATA CONFIDENCE — how much of this score is based on real data ──────
  // Counts how many key fields have real values vs null/defaults.
  // HIGH = most fields present, score is reliable
  // MEDIUM = some gaps, score is estimated
  // LOW = mostly defaults, score is speculative
  const keyFields = [
    m.buyVelocity, m.buySellRatio1h, m.devWalletPct, m.top10HolderPct,
    m.liqMcapRatio, m.holders, m.sniperWalletCount, m.bundleRisk,
    m.mintAuthority, m.priceChange1h,
  ];
  const knownCount = keyFields.filter(v => v != null).length;
  const dataConfidence = knownCount >= 8 ? 'HIGH' : knownCount >= 5 ? 'MEDIUM' : 'LOW';
  const dataCompleteness = Math.round((knownCount / keyFields.length) * 100);

  if (dataConfidence === 'LOW') {
    risks.push(`Data confidence LOW (${dataCompleteness}% fields available) — score is speculative`);
  } else if (dataConfidence === 'MEDIUM') {
    risks.push(`Data confidence MEDIUM (${dataCompleteness}% fields) — some estimates in score`);
  }

  // ── FINAL SCORE ───────────────────────────────────────────────────────────
  // Sum continuous raw values (not rounded signal buckets) for higher score
  // granularity. This is the single biggest change that breaks up clustering:
  // every coin's final score carries the fractional precision of the ledger.
  const foundationRaw = ledger
    .filter(L => /^(vv|bp|wq|hd|lh)\./.test(L.key))
    .reduce((a, L) => a + L.points, 0);
  const knifeAdjustment = parts.latePumpPenalty;
  const totalRaw = foundationRaw + knifeAdjustment + (parts.deltaScore ?? 0);

  // Stash 1-decimal foundation/total for display so the UI can show
  // "Foundation 68.4/100" rather than just integers that cluster.
  parts._foundationRaw = +foundationRaw.toFixed(1);
  parts._totalRaw      = +totalRaw.toFixed(1);
  // Persist the full ledger inside parts so the dashboard can render the
  // line-by-line breakdown straight from the saved candidate record.
  parts._ledger = ledger.map(L => ({ k: L.key, l: L.label, i: L.input, f: L.formula, p: L.points, t: L.tone }));

  return {
    score: clamp(Math.round(totalRaw)),
    scoreRaw: +totalRaw.toFixed(1),
    parts,
    reasons,
    risks,
    ledger,
    model: 'discovery',
    foundationTotal: Math.round(foundationRaw),
    foundationRaw: +foundationRaw.toFixed(1),
    knifeSignals,
    recoveryBonus,
    knifePenalty,
    dataConfidence,
    dataCompleteness,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER MODEL (60min–4hr) — stricter, confirms continuation
// ─────────────────────────────────────────────────────────────────────────────

export function scoreRunnerCoin(candidate, metricsIn = null) {
  const m = metricsIn || calculateBehaviorMetrics(candidate);
  const reasons = [];
  const risks = [];
  const parts = {};

  // 1. Trend Structure (20)
  let p = 0;
  const p1  = m.priceChange1h   ?? null;
  const p6  = m.priceChange6h   ?? null;
  const p24 = m.priceChange24h  ?? null;
  if (p1 == null || p6 == null) { p = 5; risks.push('Price history incomplete'); }
  else if (p24 >= 50 && p6 >= 20 && p1 >= 5)  { p = 20; reasons.push(`Strong uptrend (+${p24?.toFixed(0)}% 24h)`); }
  else if (p24 >= 30 && p6 >= 10)             { p = 15; reasons.push(`Healthy trend (+${p24?.toFixed(0)}% 24h)`); }
  else if (p24 >= 10 && p6 >= 0)              { p = 10; }
  else if (p24 >= 0)                          { p = 5; }
  else                                        { p = 0; risks.push(`Downtrend (${p24?.toFixed(0)}% 24h)`); }
  parts.trendStructure = p;

  // 2. Holder Retention (15)
  p = 0;
  const hg = m.holderGrowth24h;
  if (hg == null) { p = 5; }
  else if (hg >= 15) { p = 15; reasons.push(`Strong holder growth (+${hg.toFixed(0)}%/24h)`); }
  else if (hg >= 5)  { p = 10; reasons.push(`Growing holders (+${hg.toFixed(0)}%/24h)`); }
  else if (hg >= 0)  { p = 5; }
  else               { p = 0; risks.push(`Holders exiting (${hg.toFixed(0)}%)`); }
  parts.holderRetention = p;

  // 3. Breakout Setup (15)
  p = 0;
  const v24 = m.volume24h;
  if (p1 != null) {
    if (p1 > 10 && v24 >= 50_000)     { p = 15; reasons.push(`Breakout: +${p1.toFixed(0)}% 1h on ${Math.round(v24/1000)}K vol`); }
    else if (p1 > 5 && v24 >= 20_000) { p = 10; reasons.push(`Strength: +${p1.toFixed(0)}% 1h`); }
    else if (p1 > 0) { p = 5; }
    else             { p = 0; risks.push(`No 1h momentum (${p1.toFixed(0)}%)`); }
  }
  parts.breakoutSetup = p;

  // 4. Volume Consistency (15)
  p = 0;
  if (m.volume1h > 0 && m.volume24h > 0) {
    const ratio = m.volume1h / m.volume24h;
    if (ratio >= 0.05 && ratio <= 0.15) { p = 15; reasons.push('Consistent volume across session'); }
    else if (ratio > 0.15 && ratio <= 0.30) { p = 10; }
    else if (ratio > 0.30 && ratio <= 0.50) { p = 5; risks.push('Volume concentrated in last hour'); }
    else if (ratio > 0.50) { p = 3; risks.push('Volume spike — may be single event'); }
    else if (ratio < 0.02) { p = 0; risks.push('Volume dying'); }
    else                   { p = 2; }
  }
  parts.volumeConsistency = p;

  // 5. Pullback Recovery (10)
  p = 0;
  if (m.priceChange5m != null && p1 != null) {
    if (m.priceChange5m > 0 && p1 < m.priceChange5m * 12) { p = 10; reasons.push('Bouncing — 5m strength > 1h avg'); }
    else if (m.priceChange5m > 0) { p = 6; }
    else if (m.priceChange5m < -5) { p = 0; risks.push(`Dumping (${m.priceChange5m.toFixed(0)}% 5m)`); }
    else { p = 2; }
  }
  parts.pullbackRecovery = p;

  // 6. Whale Adds (10)
  p = 0;
  if (m.knownWinnerCount >= 3) { p = 10; reasons.push(`${m.knownWinnerCount} winner wallets holding`); }
  else if (m.knownWinnerCount >= 1) { p = 6; reasons.push(`${m.knownWinnerCount} winner wallet(s) present`); }
  if (m.smartMoneyScore != null && m.smartMoneyScore >= 50) p = Math.min(10, p + 2);
  parts.whaleAdds = p;

  // 7. Seller Absorption (10)
  p = 0;
  if (m.buySellRatio1h != null) {
    if (m.buySellRatio1h >= 0.6 && m.sells1h >= 50) { p = 10; reasons.push(`Absorbing sells (${(m.buySellRatio1h*100).toFixed(0)}% buys on ${m.sells1h} sellers)`); }
    else if (m.buySellRatio1h >= 0.5) { p = 6; }
    else { p = 0; risks.push('Sellers overwhelming buyers'); }
  }
  parts.sellerAbsorption = p;

  // 8. Attention Signal (5)
  p = 0;
  const socials = [m.website, m.twitter, m.telegram].filter(Boolean).length;
  if (socials === 3)      p = 5;
  else if (socials === 2) p = 3;
  else if (socials === 1) p = 1;
  if (p > 0) reasons.push(`${socials} social channel(s) active`);
  parts.attentionSignal = p;

  // Late-pump penalty REMOVED — was blocking quality runners.
  parts.latePumpPenalty = 0;

  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { score: clamp(total), parts, reasons, risks, model: 'runner' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Action mapping
// ─────────────────────────────────────────────────────────────────────────────
export function mapScoreToAction(score, model) {
  const t = model === 'runner' ? RUNNER_THRESHOLDS : DISCOVERY_THRESHOLDS;
  if (score >= t.alert)      return 'alert';
  if (score >= t.watchlist)  return 'watchlist';
  if (score >= t.monitor)    return 'monitor';
  return 'ignore';
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence level
// ─────────────────────────────────────────────────────────────────────────────
export function buildConfidence(candidate, metrics, result) {
  const m = metrics || calculateBehaviorMetrics(candidate);
  let missing = 0;
  const keyFields = [
    m.buyVelocity, m.launchUbr, m.liqMcapRatio, m.devWalletPct,
    m.top10HolderPct, m.buySellRatio1h, m.priceChange1h, m.holderGrowth24h,
  ];
  for (const v of keyFields) if (v == null) missing++;

  const veryEarly = (m.ageMinutes ?? 99) < 5;
  const strongSignalCount = (result?.reasons?.length || 0);
  const riskCount = (result?.risks?.length || 0);

  if (missing >= 4)                return 'low';
  if (veryEarly)                   return 'low';
  if (strongSignalCount >= 4 && missing <= 1) return 'high';
  if (strongSignalCount >= 2 && missing <= 2) return 'medium';
  if (riskCount >= 4)              return 'low';
  return 'medium';
}

// ═════════════════════════════════════════════════════════════════════════════
// V5 PIPELINE — STATE-BASED CLASSIFICATION + 5 INDEPENDENT SCORES
//
// Architecture:
//   1. classifyCoinState  → NEW_BIRTH | FIRST_EXPANSION | FIRST_SHAKEOUT |
//                            SURVIVAL_RECLAIM | MATURE_RUNNER
//   2. computeScannerScore       (0-100, gate at 55) — should we even analyze?
//   3. computeRugRiskScore       (0-100, block at 66+) — danger filter
//   4. computeMomentumQualityScore (0-100) — is demand real?
//   5. computeWalletQualityScore   (0-100) — clean buyers vs danger?
//   6. computeDemandQualityScore   (0-100) — sustained interest?
//   7. Final = MQ*0.30 + DQ*0.25 + WQ*0.25 + SS*0.20 - RR*0.60
//   8. assignLabels + decideAction → POST | WATCHLIST | IGNORE | BLOCK
//
// All sub-score weights live in V5_WEIGHTS so they're tunable in one place.
// Each score returns { score, ledger[] } so the UI can show the math.
// ═════════════════════════════════════════════════════════════════════════════

export const V5_WEIGHTS = {
  scanner: {
    ageFit: 15, mcapFit: 15, txnActivity: 15, liquidity: 15,
    holderGrowth: 15, chartAlive: 15, dataConfidence: 10,
  },
  rugRisk: {
    devSoldEarly: 40, topConcentrated: 25, sniperDom: 20,
    oneWalletVolume: 20, liquidityWeak: 20, priceDownHard: 20,
    sellPressureUp: 15, deadAfterSpike: 15, recycledWallets: 15,
    hugeFirstCandle: 15,
  },
  momentum: {
    uniqueBuyersUp: 20, buyPressureSteady: 15, buysSpread: 15,
    higherLows: 15, pullbackAbsorbed: 15, holdersRising: 10, volumeSteady: 10,
  },
  wallet: {
    knownProfitable: 25, repeatEarly: 20, noWalletDom: 20,
    diversityRising: 15, cleanBundles: 15, postPullbackBuys: 5,
  },
  demand: {
    holderRising: 20, newBuyersAfterPump: 20, sellAbsorbed: 20,
    volumeAlive: 15, mcapHigherLows: 15, social: 10,
  },
  finalCall: { mq: 0.30, dq: 0.25, wq: 0.25, ss: 0.20, rr: 0.60 },
  decision: {
    // POST gates — AUTO-TUNABLE via setV5DecisionConfig() (called by the
    // self-improvement loop / autotune system). Bounded in autotune_params.
    postFinal: 55, postRug: 35, postMomentum: 52, postDemand: 48,
    watchlistFinalLow: 42, watchlistFinalHigh: 54,
    watchlistRugMin: 35, watchlistRugMax: 50,
    blockRug: 66,
    // Micro-cap verification ($15K-$18K)
    microCapMcapCutoff: 18_000,
    microCapMaxRug: 25,
    microCapMinMq:  58,
    microCapMinWq:  55,
    // Clean-structure escape thresholds
    cleanStructDevMax:    3,
    cleanStructTop10Max:  30,
    cleanStructMinFinal:  50,
    cleanStructMinMq:     55,
    cleanStructMaxRug:    20,
    cleanStructMinBuyRatio: 0.60,
    // Explosive-launch override (HENRY-fix)
    explosiveAgeMaxMin:  15,
    explosiveMinHolders: 100,
    explosiveMin5m:      25,
    explosiveMin1h:      100,
    explosiveMinBuyRatio:0.55,
    explosiveMaxRug:     25,
    explosiveDevMax:     6,
  },
};

// ── Runtime override registry for V5 decision gates ────────────────────────
// Lets the autotune system + AI brain adjust V5 thresholds without editing
// source. Only listed keys are mutable; updates are validated and clamped
// upstream in autotune_params bounds. Returns the keys actually changed.
const V5_TUNABLE_KEYS = new Set([
  'postFinal', 'postRug', 'postMomentum', 'postDemand',
  'watchlistFinalLow', 'watchlistFinalHigh',
  'watchlistRugMin', 'watchlistRugMax',
  'blockRug',
  'microCapMcapCutoff', 'microCapMaxRug', 'microCapMinMq', 'microCapMinWq',
  'cleanStructDevMax', 'cleanStructTop10Max', 'cleanStructMinFinal',
  'cleanStructMinMq', 'cleanStructMaxRug', 'cleanStructMinBuyRatio',
  'explosiveAgeMaxMin', 'explosiveMinHolders', 'explosiveMin5m',
  'explosiveMin1h', 'explosiveMinBuyRatio', 'explosiveMaxRug',
  'explosiveDevMax',
]);

export function setV5DecisionConfig(updates = {}) {
  if (!updates || typeof updates !== 'object') return [];
  const applied = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!V5_TUNABLE_KEYS.has(k)) continue;
    const num = Number(v);
    if (!Number.isFinite(num)) continue;
    if (V5_WEIGHTS.decision[k] !== num) {
      V5_WEIGHTS.decision[k] = num;
      applied.push(k);
    }
  }
  return applied;
}

export function getV5DecisionConfig() {
  const out = {};
  for (const k of V5_TUNABLE_KEYS) out[k] = V5_WEIGHTS.decision[k];
  return out;
}

export function listV5TunableKeys() { return [...V5_TUNABLE_KEYS]; }

// ── State classifier ────────────────────────────────────────────────────────
export function classifyCoinState(metricsOrCandidate) {
  const m = metricsOrCandidate.ageMinutes != null
    ? metricsOrCandidate
    : calculateBehaviorMetrics(metricsOrCandidate);
  const age = m.ageMinutes;
  if (age == null) return 'NEW_BIRTH';
  if (age <= 3)    return 'NEW_BIRTH';
  if (age <= 10)   return 'FIRST_EXPANSION';
  if (age <= 25)   return 'FIRST_SHAKEOUT';
  if (age <= 60)   return 'SURVIVAL_RECLAIM';
  return 'MATURE_RUNNER';
}

// Each score uses the same ledger pattern from v4 for line-by-line audit.
function makeLedger() {
  const lines = [];
  return {
    lines,
    add(key, label, input, formula, points, tone = 'pos') {
      if (!Number.isFinite(points) || points === 0) return 0;
      lines.push({ k: key, l: label, i: input, f: formula, p: +points.toFixed(2), t: tone });
      return points;
    },
  };
}
function clampScore(v) { return Math.max(0, Math.min(100, v)); }

// ── 1. SCANNER SCORE (0-100, gate at 55) ────────────────────────────────────
export function computeScannerScore(metrics) {
  const m = metrics;
  const W = V5_WEIGHTS.scanner;
  const lg = makeLedger();
  let s = 0;

  // Age fit — favors 0-60min window for discovery
  if (m.ageMinutes != null) {
    const age = m.ageMinutes;
    let fit;
    if (age <= 60)        fit = 1 - Math.abs(age - 15) / 60; // peak at 15min
    else if (age <= 240)  fit = Math.max(0, 1 - (age - 60) / 240);
    else                  fit = 0.1;
    fit = Math.max(0, Math.min(1, fit));
    s += lg.add('ss.age', 'Age fit', `${age.toFixed(1)}min`, `fit=${fit.toFixed(2)}`, fit * W.ageFit);
  } else {
    s += lg.add('ss.age', 'Age fit (unknown)', 'age=null', '=50%', W.ageFit * 0.5);
  }

  // Mcap fit — sweet spot $8K-$80K
  if (m.marketCap > 0) {
    const mc = m.marketCap;
    let fit;
    if (mc < 5_000)        fit = 0.2;
    else if (mc < 8_000)   fit = 0.4 + (mc - 5_000) / 30_000;
    else if (mc < 60_000)  fit = 1.0;
    else if (mc < 120_000) fit = 1.0 - (mc - 60_000) / 120_000;
    else                   fit = 0.2;
    fit = Math.max(0, Math.min(1, fit));
    s += lg.add('ss.mcap', 'MCap fit', `$${(mc/1000).toFixed(1)}K`, `fit=${fit.toFixed(2)}`, fit * W.mcapFit);
  } else {
    s += lg.add('ss.mcap', 'MCap unknown', 'mcap=0', '=30%', W.mcapFit * 0.3);
  }

  // Transaction activity — total txns 1h
  const txns = (m.buys1h ?? 0) + (m.sells1h ?? 0);
  if (txns > 0) {
    const fit = Math.min(1, Math.pow(txns / 80, 0.6));
    s += lg.add('ss.txns', 'Transaction activity', `${txns} txns/1h`, `pow(t/80,0.6)=${fit.toFixed(2)}`, fit * W.txnActivity);
  }

  // Liquidity present or growing
  if (m.liquidity > 0) {
    const fit = Math.min(1, Math.pow(m.liquidity / 12_000, 0.55));
    s += lg.add('ss.liq', 'Liquidity present', `$${Math.round(m.liquidity).toLocaleString()}`, `pow(L/12K,0.55)=${fit.toFixed(2)}`, fit * W.liquidity);
  }

  // Holder growth (24h preferred, fallback delta)
  const hg = m.holderGrowth24h ?? (m.deltas?.holderDelta ?? null);
  if (hg != null && hg > 0) {
    const fit = Math.min(1, hg / 30);
    s += lg.add('ss.holderGrowth', 'Holder growth', `+${hg.toFixed(1)}%`, `min(hg/30,1)=${fit.toFixed(2)}`, fit * W.holderGrowth);
  } else if ((m.holders ?? 0) > 50) {
    s += lg.add('ss.holderBase', 'Holder base present', `${m.holders} holders`, '=50%', W.holderGrowth * 0.5);
  }

  // Chart not dead — any 5m or 1h price movement
  const p5 = m.priceChange5m, p1h = m.priceChange1h;
  if (p5 != null || p1h != null) {
    const movement = Math.abs(p5 ?? 0) + Math.abs(p1h ?? 0) * 0.5;
    if (movement > 1) {
      const fit = Math.min(1, movement / 30);
      s += lg.add('ss.chart', 'Chart alive', `5m=${p5?.toFixed(1) ?? '?'}% 1h=${p1h?.toFixed(1) ?? '?'}%`, `fit=${fit.toFixed(2)}`, fit * W.chartAlive);
    }
  }

  // Data confidence — fields populated
  const keyFields = [m.buyVelocity, m.buySellRatio1h, m.devWalletPct, m.top10HolderPct, m.liqMcapRatio, m.holders];
  const known = keyFields.filter(v => v != null).length;
  const confidenceFit = known / keyFields.length;
  s += lg.add('ss.confidence', 'Data confidence', `${known}/${keyFields.length} fields`, `fit=${confidenceFit.toFixed(2)}`, confidenceFit * W.dataConfidence);

  return { score: clampScore(Math.round(s)), scoreRaw: +s.toFixed(2), ledger: lg.lines };
}

// ── 2. RUG RISK SCORE (0-100, block at 66+) ─────────────────────────────────
export function computeRugRiskScore(metrics) {
  const m = metrics;
  const W = V5_WEIGHTS.rugRisk;
  const lg = makeLedger();
  let r = 0;

  // Dev sold early — devPctDelta dropping
  const devDrop = m.deltas?.devPctDelta;
  if (devDrop != null && devDrop < -2) {
    const sev = Math.min(1, Math.abs(devDrop) / 8);
    r += lg.add('rr.devSold', 'Dev sold early', `dev% dropped ${Math.abs(devDrop).toFixed(1)}%`, `sev=${sev.toFixed(2)}`, sev * W.devSoldEarly, 'neg');
  }

  // Top holders concentrated
  if (m.top10HolderPct != null && m.top10HolderPct > 50) {
    const sev = Math.min(1, (m.top10HolderPct - 50) / 40);
    r += lg.add('rr.topConc', 'Top holders too concentrated', `top10=${m.top10HolderPct.toFixed(0)}%`, `sev=${sev.toFixed(2)}`, sev * W.topConcentrated, 'neg');
  }

  // Sniper dominance
  const snipers = m.sniperWalletCount ?? 0;
  if (snipers > 20) {
    const sev = Math.min(1, (snipers - 20) / 50);
    r += lg.add('rr.snipers', 'Sniper dominance', `${snipers} snipers`, `sev=${sev.toFixed(2)}`, sev * W.sniperDom, 'neg');
  }

  // One wallet driving volume — proxy: very high buy/sell skew + low txn count
  if (m.buys1h > 0 && m.sells1h >= 0 && (m.buys1h + m.sells1h) < 30 && m.volume1h > 5000) {
    const sev = 0.6;
    r += lg.add('rr.oneWallet', 'Low txn count + high vol = one-wallet driver', `txns=${m.buys1h + m.sells1h} vol=$${Math.round(m.volume1h)}`, `sev=${sev}`, sev * W.oneWalletVolume, 'neg');
  }

  // Liquidity weakness (low ratio or dropping)
  const lr = m.liqMcapRatio;
  if (lr != null && lr < 0.05) {
    const sev = Math.min(1, (0.05 - lr) / 0.05);
    r += lg.add('rr.liqWeak', 'Liquidity dangerously low', `ratio=${(lr*100).toFixed(1)}%`, `sev=${sev.toFixed(2)}`, sev * W.liquidityWeak, 'neg');
  }
  const liqDrop = m.deltas?.liquidityDelta;
  if (liqDrop != null && liqDrop < -25) {
    const sev = Math.min(1, Math.abs(liqDrop + 25) / 40);
    r += lg.add('rr.liqDrop', 'Liquidity dropping fast', `${liqDrop.toFixed(0)}%`, `sev=${sev.toFixed(2)}`, sev * W.liquidityWeak, 'neg');
  }

  // Price down hard — needs peak tracking; use 1h drop as proxy when neg
  if (m.priceChange1h != null && m.priceChange1h < -25) {
    const sev = Math.min(1, Math.abs(m.priceChange1h + 25) / 50);
    r += lg.add('rr.priceDown', 'Price down hard', `1h=${m.priceChange1h.toFixed(0)}%`, `sev=${sev.toFixed(2)}`, sev * W.priceDownHard, 'neg');
  }

  // Sell pressure increasing
  const brDelta = m.deltas?.buyRatioDelta;
  if (brDelta != null && brDelta < -0.1) {
    const sev = Math.min(1, Math.abs(brDelta + 0.1) / 0.3);
    r += lg.add('rr.sellPressUp', 'Sell pressure increasing', `buyRatioΔ=${(brDelta*100).toFixed(1)}pp`, `sev=${sev.toFixed(2)}`, sev * W.sellPressureUp, 'neg');
  }
  if (m.buySellRatio1h != null && m.buySellRatio1h < 0.40) {
    const sev = Math.min(1, (0.40 - m.buySellRatio1h) / 0.20);
    r += lg.add('rr.sellersDom', 'Sellers dominating', `br=${(m.buySellRatio1h*100).toFixed(0)}%`, `sev=${sev.toFixed(2)}`, sev * W.sellPressureUp * 0.7, 'neg');
  }

  // Dead volume after spike — vol1h dropped vs vol6h hourly rate
  if (m.volume1h != null && m.volume6h != null && m.volume6h > 0) {
    const v1Rate = m.volume1h;
    const v6Rate = m.volume6h / 6;
    if (v6Rate > 1000 && v1Rate < v6Rate * 0.4) {
      const sev = Math.min(1, 1 - v1Rate / (v6Rate * 0.4));
      r += lg.add('rr.deadAfter', 'Dead volume after spike', `v1h=${Math.round(v1Rate)} vs v6h-rate=${Math.round(v6Rate)}`, `sev=${sev.toFixed(2)}`, sev * W.deadAfterSpike, 'neg');
    }
  }

  // Recycled wallets — bundle/cluster heavy with low winners
  const winners = m.knownWinnerCount ?? 0;
  if ((m.bundleRisk === 'SEVERE' || m.bundleRisk === 'HIGH') && winners < 1) {
    const sev = m.bundleRisk === 'SEVERE' ? 1 : 0.6;
    r += lg.add('rr.recycled', 'Bundled/recycled wallets', `bundle=${m.bundleRisk}`, `sev=${sev}`, sev * W.recycledWallets, 'neg');
  }
  if (m.bubbleMapRisk === 'SEVERE') {
    r += lg.add('rr.bubble', 'BubbleMap SEVERE — cluster activity', 'bubbleMap=SEVERE', '=15', 15, 'neg');
  }

  // Huge first candle followed by weakness — large 1h gain but weak 5m
  if (m.priceChange1h != null && m.priceChange5m != null) {
    if (m.priceChange1h > 80 && m.priceChange5m < 2) {
      const sev = Math.min(1, (m.priceChange1h - 80) / 200);
      r += lg.add('rr.spikeWeak', 'Huge first candle + weak follow-through', `1h=+${m.priceChange1h.toFixed(0)}% 5m=${m.priceChange5m.toFixed(1)}%`, `sev=${sev.toFixed(2)}`, sev * W.hugeFirstCandle, 'neg');
    }
  }

  // Hard absolute disqualifiers — push score above block threshold
  if (m.devWalletPct != null && m.devWalletPct > 15) {
    r += lg.add('rr.devHuge', 'Dev wallet >15% — instant block', `dev=${m.devWalletPct.toFixed(1)}%`, '+30', 30, 'neg');
  }
  if (m.deployerHistoryRisk === 'SERIAL_RUGGER') {
    r += lg.add('rr.rugger', 'Serial rugger deployer', 'rugger=true', '+50', 50, 'neg');
  }

  return { score: clampScore(Math.round(r)), scoreRaw: +r.toFixed(2), ledger: lg.lines };
}

// ── 3. MOMENTUM QUALITY SCORE (0-100) ───────────────────────────────────────
export function computeMomentumQualityScore(metrics) {
  const m = metrics;
  const W = V5_WEIGHTS.momentum;
  const lg = makeLedger();
  let s = 0;

  // Unique buyers increasing — pick BEST of (a) UBR (b) holder delta
  // (c) single-scan proxy: high buys/holders ratio + low cluster share.
  // Without (a) or (b) we fall back to (c) so first-scan coins can score.
  const ubr = m.launchUbr;
  const holderD = m.deltas?.holderDelta;
  {
    let best = 0, bestKey, bestLabel, bestInput, bestFormula;
    if (ubr != null && ubr > 0.4) {
      const fit = Math.min(1, (ubr - 0.4) / 0.4);
      const pts = fit * W.uniqueBuyersUp;
      if (pts > best) { best = pts; bestKey='mq.uniqueBuyers'; bestLabel='Unique buyer ratio strong'; bestInput=`ubr=${(ubr*100).toFixed(0)}%`; bestFormula=`fit=${fit.toFixed(2)}`; }
    }
    if (holderD != null && holderD > 5) {
      const fit = Math.min(1, holderD / 30);
      const pts = fit * W.uniqueBuyersUp;
      if (pts > best) { best = pts; bestKey='mq.uniqueBuyers'; bestLabel='New holders entering (delta)'; bestInput=`+${holderD.toFixed(1)}%`; bestFormula=`fit=${fit.toFixed(2)}`; }
    }
    // Single-scan fallback: buy diversity proxy. Many buys vs total holders
    // = lots of unique entries; low cluster share = entries are not bots.
    if ((m.buys1h ?? 0) >= 30 && (m.holders ?? 0) > 0) {
      const buyToHolderRatio = m.buys1h / Math.max(20, m.holders);
      const clusterShare = (m.clusterWalletCount ?? 0) / Math.max(1, m.buys1h);
      const proxyFit = Math.min(1, buyToHolderRatio * 1.5) * Math.max(0, 1 - clusterShare * 2);
      const pts = proxyFit * W.uniqueBuyersUp * 0.8; // capped at 80% of full
      if (pts > best) { best = pts; bestKey='mq.uniqueBuyers'; bestLabel='Unique buyer activity (single-scan proxy)'; bestInput=`${m.buys1h} buys / ${m.holders} holders, ${m.clusterWalletCount ?? 0} clusters`; bestFormula=`proxy=${proxyFit.toFixed(2)}`; }
    }
    if (best > 0) s += lg.add(bestKey, bestLabel, bestInput, bestFormula, best);
  }

  // Buy pressure consistent
  if (m.buySellRatio1h != null && m.buySellRatio1h >= 0.55) {
    const fit = Math.min(1, (m.buySellRatio1h - 0.55) / 0.30);
    s += lg.add('mq.buyPress', 'Buy pressure consistent', `br=${(m.buySellRatio1h*100).toFixed(0)}%`, `fit=${fit.toFixed(2)}`, fit * W.buyPressureSteady);
  }

  // Buys spread across wallets — proxy: high buy count + low cluster ratio
  if (m.buys1h > 30) {
    const clusterRatio = (m.clusterWalletCount ?? 0) / Math.max(1, m.buys1h * 0.3);
    const spreadFit = Math.max(0, 1 - clusterRatio);
    if (spreadFit > 0.4) {
      s += lg.add('mq.spread', 'Buys spread across wallets', `${m.buys1h} buys, ${m.clusterWalletCount ?? 0} clusters`, `spread=${spreadFit.toFixed(2)}`, spreadFit * W.buysSpread);
    }
  }

  // Higher lows forming — pick BEST of three valid signals:
  //   (a) momentumShift positive (5m run-rate > 1h average rate) → up to full
  //   (b) Reclaim: 5m positive after 1h dip → full (best signal)
  //   (c) Continuation: 5m + 1h both positive → 85% (no test of resilience)
  {
    let best = 0;
    let bestKey = null, bestLabel = null, bestInput = null, bestFormula = null;
    if (m.momentumShift != null && m.momentumShift > 0) {
      const fit = Math.min(1, m.momentumShift / 1.5);
      const pts = fit * W.higherLows;
      if (pts > best) { best = pts; bestKey='mq.higherLows'; bestLabel='Higher lows / accelerating'; bestInput=`momentumShift=+${m.momentumShift.toFixed(2)}%/min`; bestFormula=`fit=${fit.toFixed(2)}`; }
    }
    if (m.priceChange5m != null && m.priceChange1h != null && m.priceChange5m > 0 && m.priceChange1h < 0) {
      const pts = W.higherLows;
      if (pts > best) { best = pts; bestKey='mq.reclaim'; bestLabel='Reclaim (5m up after 1h dip)'; bestInput=`5m=+${m.priceChange5m.toFixed(1)}% 1h=${m.priceChange1h.toFixed(1)}%`; bestFormula='=full'; }
    }
    if (m.priceChange5m != null && m.priceChange1h != null && m.priceChange5m > 0 && m.priceChange1h > 0) {
      const pts = W.higherLows * 0.85;
      if (pts > best) { best = pts; bestKey='mq.continue'; bestLabel='Continuation (5m + 1h both green)'; bestInput=`5m=+${m.priceChange5m.toFixed(1)}% 1h=+${m.priceChange1h.toFixed(1)}%`; bestFormula='=85%'; }
    }
    if (best > 0) s += lg.add(bestKey, bestLabel, bestInput, bestFormula, best);
  }

  // Pullbacks being absorbed — three valid paths:
  //   (a) Active pullback being absorbed (1h dip + high buy ratio)
  //   (b) No pullback yet but high buy ratio — still healthy demand
  //   (c) No pullback + buy ratio neutral — neutral, no points
  if (m.priceChange1h != null && m.priceChange1h < 0 && m.buySellRatio1h != null && m.buySellRatio1h > 0.55) {
    const fit = Math.min(1, (m.buySellRatio1h - 0.55) / 0.30);
    s += lg.add('mq.absorb', 'Pullback actively absorbed', `1h=${m.priceChange1h.toFixed(1)}% br=${(m.buySellRatio1h*100).toFixed(0)}%`, `fit=${fit.toFixed(2)}`, fit * W.pullbackAbsorbed);
  } else if (m.buySellRatio1h != null && m.buySellRatio1h >= 0.65 && (m.buys1h ?? 0) > 50) {
    const fit = Math.min(1, (m.buySellRatio1h - 0.65) / 0.20);
    s += lg.add('mq.demandHold', 'Demand holding (high buy ratio)', `br=${(m.buySellRatio1h*100).toFixed(0)}% buys=${m.buys1h}`, `fit*0.7=${(fit*0.7).toFixed(2)}`, fit * W.pullbackAbsorbed * 0.7);
  }

  // Holder count rising — best of (a) live delta (b) 24h growth (c) absolute
  // healthy holder count for the coin's age (single-scan fallback)
  {
    let best = 0, bestKey, bestLabel, bestInput, bestFormula;
    if (holderD != null && holderD > 0) {
      const fit = Math.min(1, holderD / 25);
      const pts = fit * W.holdersRising;
      if (pts > best) { best = pts; bestKey='mq.holderUp'; bestLabel='Holder count rising (delta)'; bestInput=`+${holderD.toFixed(1)}%`; bestFormula=`fit=${fit.toFixed(2)}`; }
    }
    if (m.holderGrowth24h != null && m.holderGrowth24h > 0) {
      const fit = Math.min(1, m.holderGrowth24h / 30);
      const pts = fit * W.holdersRising;
      if (pts > best) { best = pts; bestKey='mq.holderUp'; bestLabel='Holder growth (24h)'; bestInput=`+${m.holderGrowth24h.toFixed(1)}%/24h`; bestFormula=`fit=${fit.toFixed(2)}`; }
    }
    // Single-scan fallback: holders/min vs age. Healthy fresh coin sees
    // 1+ holder/min; mature coins should have 100+ holders.
    if ((m.holders ?? 0) > 30 && (m.ageMinutes ?? 0) > 1) {
      const expected = Math.max(20, Math.min(400, m.ageMinutes * 1.5));
      const fit = Math.min(1, m.holders / expected);
      const pts = fit * W.holdersRising * 0.7; // single-scan capped at 70%
      if (pts > best) { best = pts; bestKey='mq.holderUp'; bestLabel='Holder base healthy for age'; bestInput=`${m.holders} holders @ ${m.ageMinutes.toFixed(0)}min`; bestFormula=`vs expected ${Math.round(expected)} = ${fit.toFixed(2)}`; }
    }
    if (best > 0) s += lg.add(bestKey, bestLabel, bestInput, bestFormula, best);
  }

  // Volume steady (not a one-candle spike) — vol1h ≥ 0.5x of vol6h hourly rate
  if (m.volume1h != null && m.volume6h != null && m.volume6h > 0) {
    const ratio = m.volume1h / Math.max(1, m.volume6h / 6);
    if (ratio > 0.5 && ratio < 4) {
      const fit = ratio < 1 ? ratio : Math.max(0, 1 - (ratio - 1) / 3);
      s += lg.add('mq.volSteady', 'Volume steady (not one-spike)', `v1h/v6h-rate=${ratio.toFixed(2)}x`, `fit=${fit.toFixed(2)}`, fit * W.volumeSteady);
    } else if (ratio >= 4) {
      // Spike penalty
      s += lg.add('mq.volSpike', 'Volume one-spike penalty', `ratio=${ratio.toFixed(1)}x`, '=-5', -5, 'neg');
    }
  }

  return { score: clampScore(Math.round(s)), scoreRaw: +s.toFixed(2), ledger: lg.lines };
}

// ── 4. WALLET QUALITY SCORE (0-100) ─────────────────────────────────────────
export function computeWalletQualityScore(metrics) {
  const m = metrics;
  const W = V5_WEIGHTS.wallet;
  const lg = makeLedger();
  let s = 0;

  const winners = m.knownWinnerCount ?? 0;
  const sm = m.smartMoneyScore ?? 0;
  const clusters = m.clusterWalletCount ?? 0;
  const snipers = m.sniperWalletCount ?? 0;

  // Known profitable wallets entering
  if (winners > 0) {
    const fit = Math.min(1, winners / 4);
    s += lg.add('wq.profitable', 'Known profitable wallets entering', `${winners} winners`, `fit=${fit.toFixed(2)}`, fit * W.knownProfitable);
  }

  // Repeat successful early wallets — smartMoneyScore proxy
  if (sm > 30) {
    const fit = Math.min(1, (sm - 30) / 60);
    s += lg.add('wq.repeat', 'Smart money repeat early entries', `sm=${sm}`, `fit=${fit.toFixed(2)}`, fit * W.repeatEarly);
  }

  // No single wallet dominance — top10 not crazy concentrated
  if (m.top10HolderPct != null) {
    const top10 = m.top10HolderPct;
    let fit;
    if (top10 < 30)      fit = 1.0;
    else if (top10 < 60) fit = 1.0 - (top10 - 30) / 60;
    else                 fit = Math.max(0, 0.5 - (top10 - 60) / 80);
    s += lg.add('wq.noDom', 'No single wallet dominance', `top10=${top10.toFixed(0)}%`, `fit=${fit.toFixed(2)}`, fit * W.noWalletDom);
  }

  // Wallet diversity increasing — high txn count + low cluster + low sniper share
  const txns = (m.buys1h ?? 0) + (m.sells1h ?? 0);
  if (txns > 20) {
    const clusterPenalty = clusters / Math.max(1, txns * 0.2);
    const sniperPenalty = snipers / Math.max(1, txns * 0.3);
    const div = Math.max(0, 1 - clusterPenalty - sniperPenalty);
    s += lg.add('wq.diversity', 'Wallet diversity', `${txns} txns, ${clusters} clusters, ${snipers} snipers`, `div=${div.toFixed(2)}`, div * W.diversityRising);
  }

  // No obvious bundle/sniper control
  let bundlePenalty = 0;
  if (m.bundleRisk === 'SEVERE') bundlePenalty = 1.0;
  else if (m.bundleRisk === 'HIGH') bundlePenalty = 0.6;
  else if (m.bundleRisk === 'MEDIUM') bundlePenalty = 0.3;
  const cleanBundle = 1 - bundlePenalty;
  if (cleanBundle > 0.3) {
    s += lg.add('wq.cleanBundle', 'Clean bundles/snipers', `bundle=${m.bundleRisk ?? '?'}`, `clean=${cleanBundle.toFixed(2)}`, cleanBundle * W.cleanBundles);
  }

  // Clean buy behavior after pullback — needs delta context
  if (m.deltas && m.deltas.buyRatioDelta != null && m.priceChange1h != null && m.priceChange1h < -5 && m.deltas.buyRatioDelta > 0.05) {
    const fit = Math.min(1, m.deltas.buyRatioDelta / 0.20);
    s += lg.add('wq.postPullback', 'Clean buys after pullback', `1h=${m.priceChange1h.toFixed(1)}% buyΔ=+${(m.deltas.buyRatioDelta*100).toFixed(0)}pp`, `fit=${fit.toFixed(2)}`, fit * W.postPullbackBuys);
  }

  return { score: clampScore(Math.round(s)), scoreRaw: +s.toFixed(2), ledger: lg.lines };
}

// ── 5. DEMAND QUALITY SCORE (0-100) ─────────────────────────────────────────
export function computeDemandQualityScore(metrics) {
  const m = metrics;
  const W = V5_WEIGHTS.demand;
  const lg = makeLedger();
  let s = 0;

  // Holder count rising — best of (a) live delta (b) 24h growth
  // (c) absolute healthy holders for age (single-scan fallback)
  const holderD = m.deltas?.holderDelta;
  {
    let best = 0, bestKey, bestLabel, bestInput, bestFormula;
    if (holderD != null && holderD > 0) {
      const fit = Math.min(1, holderD / 25);
      const pts = fit * W.holderRising;
      if (pts > best) { best = pts; bestKey='dq.holders'; bestLabel='Holder count rising (delta)'; bestInput=`+${holderD.toFixed(1)}%`; bestFormula=`fit=${fit.toFixed(2)}`; }
    }
    if (m.holderGrowth24h != null && m.holderGrowth24h > 0) {
      const fit = Math.min(1, m.holderGrowth24h / 30);
      const pts = fit * W.holderRising;
      if (pts > best) { best = pts; bestKey='dq.holders24h'; bestLabel='Holder growth (24h)'; bestInput=`+${m.holderGrowth24h.toFixed(1)}%/24h`; bestFormula=`fit=${fit.toFixed(2)}`; }
    }
    if ((m.holders ?? 0) > 30 && (m.ageMinutes ?? 0) > 1) {
      const expected = Math.max(20, Math.min(400, m.ageMinutes * 1.5));
      const fit = Math.min(1, m.holders / expected);
      const pts = fit * W.holderRising * 0.7;
      if (pts > best) { best = pts; bestKey='dq.holdersBase'; bestLabel='Holder base healthy for age'; bestInput=`${m.holders} holders @ ${m.ageMinutes.toFixed(0)}min`; bestFormula=`vs expected ${Math.round(expected)} = ${fit.toFixed(2)}`; }
    }
    if (best > 0) s += lg.add(bestKey, bestLabel, bestInput, bestFormula, best);
  }

  // New buyers still entering after first pump — best of (a) post-pump
  // continued buying (b) holder delta (c) sustained high buy activity
  // (single-scan: many buys + still-positive 5m even without pump context)
  {
    let best = 0, bestKey, bestLabel, bestInput, bestFormula;
    if (m.priceChange1h != null && m.priceChange1h > 30 && m.buys1h > 30) {
      const fit = Math.min(1, m.buys1h / 200);
      const pts = fit * W.newBuyersAfterPump;
      if (pts > best) { best = pts; bestKey='dq.afterPump'; bestLabel='New buyers after first pump'; bestInput=`1h=+${m.priceChange1h.toFixed(0)}% buys1h=${m.buys1h}`; bestFormula=`fit=${fit.toFixed(2)}`; }
    }
    if (holderD != null && holderD > 8) {
      const fit = Math.min(1, holderD / 30);
      const pts = fit * W.newBuyersAfterPump * 0.7;
      if (pts > best) { best = pts; bestKey='dq.afterPump.delta'; bestLabel='Continued buyer entry (delta)'; bestInput=`holderΔ=+${holderD.toFixed(1)}%`; bestFormula=`fit=${fit.toFixed(2)}`; }
    }
    // Single-scan: many active buys + 5m not red = active demand
    if ((m.buys1h ?? 0) >= 50 && (m.priceChange5m ?? 0) >= -3) {
      const buyFit = Math.min(1, m.buys1h / 200);
      const priceFit = Math.min(1, Math.max(0, ((m.priceChange5m ?? 0) + 3) / 10));
      const fit = buyFit * (0.6 + priceFit * 0.4);
      const pts = fit * W.newBuyersAfterPump * 0.65;
      if (pts > best) { best = pts; bestKey='dq.activeBuys'; bestLabel='Active sustained buying'; bestInput=`buys1h=${m.buys1h} 5m=${(m.priceChange5m ?? 0).toFixed(1)}%`; bestFormula=`buyFit×priceFit×0.65=${fit.toFixed(2)}`; }
    }
    if (best > 0) s += lg.add(bestKey, bestLabel, bestInput, bestFormula, best);
  }

  // Sell pressure absorbed
  if (m.buySellRatio1h != null && m.sells1h > 30 && m.buySellRatio1h > 0.55) {
    const fit = Math.min(1, (m.buySellRatio1h - 0.55) / 0.30);
    s += lg.add('dq.absorbed', 'Sell pressure absorbed', `${m.sells1h} sells, br=${(m.buySellRatio1h*100).toFixed(0)}%`, `fit=${fit.toFixed(2)}`, fit * W.sellAbsorbed);
  }

  // Volume alive after spike
  if (m.volume1h != null && m.volume6h != null && m.volume6h > 0) {
    const ratio = m.volume1h / Math.max(1, m.volume6h / 6);
    if (ratio >= 0.5) {
      const fit = Math.min(1, ratio / 1.5);
      s += lg.add('dq.volAlive', 'Volume alive after spike', `v1h/v6h-rate=${ratio.toFixed(2)}x`, `fit=${fit.toFixed(2)}`, fit * W.volumeAlive);
    }
  }

  // Mcap making higher lows — best of (a) live mcap delta + 5m up
  // (b) single-scan: 5m and 1h both green (continuation chart shape)
  // (c) single-scan: 1h up + 5m flat-positive (consolidation at high)
  const mcD = m.deltas?.mcapDelta;
  {
    let best = 0, bestKey, bestLabel, bestInput, bestFormula;
    if (mcD != null && mcD > 0 && (m.priceChange5m ?? 0) > 0) {
      const fit = Math.min(1, mcD / 30);
      const pts = fit * W.mcapHigherLows;
      if (pts > best) { best = pts; bestKey='dq.mcapHL'; bestLabel='MCap making higher lows (delta)'; bestInput=`mcapΔ=+${mcD.toFixed(1)}% 5m=+${m.priceChange5m.toFixed(1)}%`; bestFormula=`fit=${fit.toFixed(2)}`; }
    }
    if ((m.priceChange5m ?? 0) > 1 && (m.priceChange1h ?? 0) > 5) {
      const fit = Math.min(1, m.priceChange1h / 50);
      const pts = fit * W.mcapHigherLows * 0.8;
      if (pts > best) { best = pts; bestKey='dq.continuation'; bestLabel='Continuation (5m + 1h both green)'; bestInput=`5m=+${m.priceChange5m.toFixed(1)}% 1h=+${m.priceChange1h.toFixed(1)}%`; bestFormula=`fit=${fit.toFixed(2)}`; }
    }
    if ((m.priceChange1h ?? 0) > 10 && (m.priceChange5m ?? 0) >= -2) {
      const fit = Math.min(1, m.priceChange1h / 60);
      const pts = fit * W.mcapHigherLows * 0.6;
      if (pts > best) { best = pts; bestKey='dq.consolidate'; bestLabel='Consolidating at high'; bestInput=`1h=+${m.priceChange1h.toFixed(1)}% 5m=${(m.priceChange5m ?? 0).toFixed(1)}%`; bestFormula=`fit=${fit.toFixed(2)}`; }
    }
    if (best > 0) s += lg.add(bestKey, bestLabel, bestInput, bestFormula, best);
  }

  // Social traction
  if (m.socialSpike) {
    s += lg.add('dq.socialSpike', 'Social spike (Twitter 2x baseline)', 'spike=true', `+${W.social}`, W.social);
  } else if ((m.twitterMentions ?? 0) > 30 || (m.socialScore ?? 0) > 40) {
    const a = (m.twitterMentions ?? 0) / 100;
    const b = (m.socialScore ?? 0) / 60;
    const fit = Math.min(1, Math.max(a, b));
    s += lg.add('dq.social', 'Social traction', `mentions=${m.twitterMentions ?? 0} score=${m.socialScore ?? 0}`, `fit=${fit.toFixed(2)}`, fit * W.social);
  }

  return { score: clampScore(Math.round(s)), scoreRaw: +s.toFixed(2), ledger: lg.lines };
}

// ── Labels ──────────────────────────────────────────────────────────────────
export function assignLabels(state, scores, metrics) {
  const m = metrics;
  const labels = [];
  const { scanner, rugRisk, momentum, wallet, demand, finalCall } = scores;

  // Falling knife — price down hard from peak (1h proxy) without reclaim
  const fallingKnife = m.priceChange1h != null && m.priceChange1h < -25
    && (m.priceChange5m == null || m.priceChange5m < 5)
    && (m.deltas?.holderDelta == null || m.deltas.holderDelta < 5);

  if (fallingKnife) labels.push('FALLING_KNIFE');

  if (rugRisk >= V5_WEIGHTS.decision.blockRug) labels.push('BLOCKED_RUG_RISK');

  // Sniper controlled
  const snipers = m.sniperWalletCount ?? 0;
  const txns = (m.buys1h ?? 0) + (m.sells1h ?? 0);
  if (snipers > 25 && (txns < 80 || snipers / Math.max(1, txns) > 0.4)) labels.push('SNIPER_CONTROLLED');

  // Dev exit risk
  const devDrop = m.deltas?.devPctDelta;
  if (devDrop != null && devDrop < -2) labels.push('DEV_EXIT_RISK');

  // Dead after spike
  if (m.volume1h != null && m.volume6h != null && m.volume6h > 0) {
    const ratio = m.volume1h / Math.max(1, m.volume6h / 6);
    if (ratio < 0.4 && m.priceChange1h != null && m.priceChange1h > 50) {
      labels.push('DEAD_AFTER_SPIKE');
    }
  }

  // Slow builder — moderate scores, low rug, mature
  if (state === 'MATURE_RUNNER' && momentum < 70 && demand >= 50 && rugRisk < 35 && (m.priceChange1h ?? 0) > 0 && (m.priceChange1h ?? 0) < 30) {
    labels.push('SLOW_BUILDER');
  }

  // Watch for reclaim — recovery zone
  if ((state === 'FIRST_SHAKEOUT' || state === 'SURVIVAL_RECLAIM') && m.priceChange1h != null && m.priceChange1h < -10
      && m.priceChange5m != null && m.priceChange5m > 0 && rugRisk < 50) {
    labels.push('WATCH_FOR_RECLAIM');
  }

  // Confirmed runner
  if (momentum >= 75 && demand >= 70 && wallet >= 60 && rugRisk < 35 && (m.priceChange1h ?? 0) > 20) {
    labels.push('CONFIRMED_RUNNER');
  }

  // Early clean send
  if ((state === 'NEW_BIRTH' || state === 'FIRST_EXPANSION') && rugRisk < 25 && wallet >= 60 && momentum >= 65) {
    labels.push('EARLY_CLEAN_SEND');
  }

  // Low data confidence
  const dataKnown = [m.buyVelocity, m.buySellRatio1h, m.devWalletPct, m.top10HolderPct, m.liqMcapRatio, m.holders, m.sniperWalletCount, m.bundleRisk]
    .filter(v => v != null).length;
  if (dataKnown < 4) labels.push('LOW_DATA_CONFIDENCE');

  return labels;
}

// ── Decision engine ────────────────────────────────────────────────────────
export function decideAction(scores, state, labels, metrics) {
  const D = V5_WEIGHTS.decision;
  const { rugRisk, momentum, demand, finalCall, wallet } = scores;

  // Hard BLOCK rules — never overridable
  if (rugRisk >= D.blockRug) return 'BLOCK';
  if (labels.includes('BLOCKED_RUG_RISK')) return 'BLOCK';
  if (labels.includes('FALLING_KNIFE')) {
    // Falling knife only postable if hard recovery conditions met (handled by reclaim label)
    if (!labels.includes('WATCH_FOR_RECLAIM')) return 'IGNORE';
  }
  if (labels.includes('DEAD_AFTER_SPIKE')) return 'IGNORE';
  if (metrics.devWalletPct != null && metrics.devWalletPct > 15) return 'BLOCK';
  if (metrics.deployerHistoryRisk === 'SERIAL_RUGGER') return 'BLOCK';

  // Early coins get easier WATCHLIST entry + relaxed POST path with stricter
  // rug filter (per spec: "Early coins should have lower posting thresholds
  // but stronger rug filters").
  const isEarly = state === 'NEW_BIRTH' || state === 'FIRST_EXPANSION';

  // Mature POST gate — strict
  const maturePost = finalCall >= D.postFinal && rugRisk < D.postRug
                  && momentum >= D.postMomentum && demand >= D.postDemand;

  // Early POST gate — relaxed score/momentum/demand, stricter rug
  const earlyPost  = isEarly
                  && finalCall >= 60 && rugRisk < 25
                  && momentum >= 60 && demand >= 55
                  && labels.includes('EARLY_CLEAN_SEND');

  // CLEAN-STRUCTURE override — wallet DB is too thin (~178 curated wallets)
  // for every quality coin to have a tracked winner. Allow POST when the
  // coin has CLEAN structure + decent momentum + clean rug, even if the
  // demand quality score is below the standard gate. Demand often can't
  // hit the gate on first-scan coins because most demand signals need
  // multi-snapshot delta data that doesn't exist yet.
  const dev    = metrics.devWalletPct;
  const top10  = metrics.top10HolderPct;
  const mintOk = metrics.mintAuthority === 0;
  const lpOk   = metrics.lpLocked === 1;
  // All thresholds below now read from D (V5_WEIGHTS.decision) so the
  // autotune system can adjust them via setV5DecisionConfig().
  const cleanStructure = dev != null && dev < D.cleanStructDevMax
                      && top10 != null && top10 < D.cleanStructTop10Max
                      && mintOk && lpOk;
  const cleanStructurePost = cleanStructure
                          && finalCall >= D.cleanStructMinFinal
                          && rugRisk < D.cleanStructMaxRug
                          && momentum >= D.cleanStructMinMq
                          && (metrics.buySellRatio1h ?? 0) >= D.cleanStructMinBuyRatio;

  // EXPLOSIVE_LAUNCH override — HENRY-fix. Catches obvious explosive
  // launches that the buy_velocity NULL bug previously missed. All
  // thresholds tunable via autotune system.
  const ageMin = metrics.ageMinutes ?? 999;
  const p5 = metrics.priceChange5m ?? 0;
  const p1h = metrics.priceChange1h ?? 0;
  const explosiveLaunch =
       ageMin < D.explosiveAgeMaxMin
    && (metrics.holders ?? 0) >= D.explosiveMinHolders
    && p5 >= D.explosiveMin5m
    && p1h >= D.explosiveMin1h
    && (metrics.buySellRatio1h ?? 0) >= D.explosiveMinBuyRatio
    && rugRisk < D.explosiveMaxRug
    && dev != null && dev < D.explosiveDevMax
    && mintOk;

  if (maturePost || earlyPost || cleanStructurePost || explosiveLaunch) {
    // Micro-cap verification — coins under $18K mcap need extra proof
    // because sub-$18K post-quality has historically been worse.
    // FOUR escape paths (any one passes):
    //   (a) known winner wallet present
    //   (b) clean rug + strong momentum + decent wallet score
    //   (c) clean STRUCTURE: low dev, low top10, mint revoked, LP locked
    //       — wallet DB is thin so structure has to be allowed to count
    //   (d) strong momentum signal (velocity ≥4 buys/min + buy ratio ≥65%)
    const mcap = metrics.marketCap ?? 0;
    if (mcap > 0 && mcap < D.microCapMcapCutoff) {
      const winners = metrics.knownWinnerCount ?? 0;
      const microCleanStructure = cleanStructure && rugRisk < 25;
      const strongMomentum = (metrics.buyVelocity ?? 0) >= 4
                          && (metrics.buySellRatio1h ?? 0) >= 0.65;
      const passes  = winners >= 1
        || (rugRisk < D.microCapMaxRug && momentum >= D.microCapMinMq && wallet >= D.microCapMinWq)
        || microCleanStructure
        || strongMomentum;
      if (!passes) return 'WATCHLIST';
    }
    return 'POST';
  }

  // WATCHLIST conditions
  if (finalCall >= D.watchlistFinalLow && finalCall <= D.watchlistFinalHigh) return 'WATCHLIST';
  if (rugRisk >= D.watchlistRugMin && rugRisk <= D.watchlistRugMax) return 'WATCHLIST';
  if (labels.includes('WATCH_FOR_RECLAIM')) return 'WATCHLIST';
  if (labels.includes('CONFIRMED_RUNNER') && finalCall >= 50) return 'WATCHLIST';
  if (labels.includes('EARLY_CLEAN_SEND')) return 'WATCHLIST';
  if (isEarly && finalCall >= 40 && rugRisk < 50) return 'WATCHLIST';

  return 'IGNORE';
}

// ═════════════════════════════════════════════════════════════════════════════
// BUYING CONFIRMATION DETECTOR
//
// Catches "buying is HAPPENING" patterns — both slow accumulation and fast
// surges — so we can post coins that have legitimately confirmed strength
// even when the falling-knife detector might otherwise penalize them.
//
// Three patterns:
//   FAST_BUILD  — one rescan shows multiple strong signals (sudden surge)
//   SLOW_BUILD  — 2+ rescans show consistent positive momentum (gradual climb)
//   RECLAIM     — coin dipped 1h but is now bouncing with confirmed buying
//                 (the post-migration / dip-then-real-buy pattern)
//
// Returns: { score: 0-100, type, signals: [], bullishCount }
//   score >= 85 → strong enough to qualify a new POST path
//   score >= 50 → enough to halve the falling-knife penalty
//   score >= 30 → enough to reduce knife penalty by 25%
//
// SAFETY: requires rugRisk < 35 to register. Pump-and-dumps with active
// dev movement or extreme top10 concentration get filtered out.
// ═════════════════════════════════════════════════════════════════════════════
export function computeBuyingConfirmation(metrics, history = [], rugRisk = 0) {
  const m = metrics;
  const signals = [];
  let bullishCount = 0;
  let pattern = 'NONE';

  // Hard filter — pump-and-dump traps don't count as buying confirmation
  if (rugRisk >= 35) {
    return { score: 0, type: 'BLOCKED_BY_RUG', signals: ['rug risk too high'], bullishCount: 0 };
  }

  const d = m.deltas || {};
  const hasDeltas = d.minutesAgo != null;

  // ── FAST_BUILD signals (single rescan can confirm) ─────────────────────
  // Each is a binary yes/no. 3+ in one rescan = FAST_BUILD detected.
  let fastSignals = 0;
  if (d.volumeDelta != null && d.volumeDelta > 50)        { fastSignals++; signals.push(`Volume +${d.volumeDelta.toFixed(0)}%`); }
  if (d.holderDelta != null && d.holderDelta > 12)        { fastSignals++; signals.push(`Holders +${d.holderDelta.toFixed(0)}%`); }
  if (d.mcapDelta != null && d.mcapDelta > 18)            { fastSignals++; signals.push(`MCap +${d.mcapDelta.toFixed(0)}%`); }
  if (d.buyRatioDelta != null && d.buyRatioDelta > 0.10)  { fastSignals++; signals.push(`Buy ratio +${(d.buyRatioDelta*100).toFixed(0)}pp`); }
  if (d.velocityDelta != null && d.velocityDelta > 3)     { fastSignals++; signals.push(`Velocity +${d.velocityDelta.toFixed(1)} buys/min`); }
  if (m.priceChange5m != null && m.priceChange5m > 8 && m.priceChange1h != null && m.priceChange1h > 0) {
    fastSignals++; signals.push(`5m +${m.priceChange5m.toFixed(0)}% with 1h support`);
  }
  if (m.volumeAcceleration != null && m.volumeAcceleration > 2.5 && (m.buySellRatio1h ?? 0) >= 0.55) {
    fastSignals++; signals.push(`Volume ${m.volumeAcceleration.toFixed(1)}x baseline + buy ratio ${(m.buySellRatio1h*100).toFixed(0)}%`);
  }
  if (fastSignals >= 3) { pattern = 'FAST_BUILD'; bullishCount = fastSignals; }

  // ── SLOW_BUILD signals (need multi-scan history) ───────────────────────
  // Look at last 2-3 snapshots from history. If consistent positive trend,
  // that's slow accumulation — usually higher quality than fast spikes.
  let slowSignals = 0;
  if (Array.isArray(history) && history.length >= 2) {
    const recent = history.slice(0, 3);  // most recent 3 snapshots
    // All snapshots show holder count growing
    const holdersGrowing = recent.every(h => h.holders != null) &&
      recent.every((h, i) => i === 0 || h.holders >= (recent[i-1].holders ?? 0) * 0.98);
    if (holdersGrowing && recent.length >= 2 && (m.holders ?? 0) > (recent[recent.length-1].holders ?? 0)) {
      slowSignals++; signals.push(`Holders growing across ${recent.length+1} scans`);
    }
    // Buy ratio steady or improving
    const brSteady = recent.every(h => h.buySellRatio1h != null && h.buySellRatio1h >= 0.50);
    if (brSteady && (m.buySellRatio1h ?? 0) >= 0.55) {
      slowSignals++; signals.push(`Buy ratio held >50% across rescans`);
    }
    // Mcap not dropping over the window
    if (recent.length >= 2 && recent[0].marketCap != null && recent[recent.length-1].marketCap != null) {
      const oldestMcap = recent[recent.length-1].marketCap;
      const drop = oldestMcap > 0 ? (m.marketCap - oldestMcap) / oldestMcap : 0;
      if (drop >= -0.05) {  // mcap held within -5% over window
        slowSignals++; signals.push(`MCap held over ${recent.length+1} scans`);
      }
    }
    // Volume building (current >= 70% of vol6h-rate)
    if (m.volume1h != null && m.volume6h != null && m.volume6h > 0) {
      const ratio = m.volume1h / Math.max(1, m.volume6h / 6);
      if (ratio >= 0.7) {
        slowSignals++; signals.push(`Volume sustained at ${ratio.toFixed(1)}x baseline`);
      }
    }
    if (slowSignals >= 3 && pattern === 'NONE') {
      pattern = 'SLOW_BUILD';
      bullishCount = Math.max(bullishCount, slowSignals);
    }
  }

  // ── RECLAIM pattern (dipped, now bouncing with buying confirmed) ───────
  // Specific to post-migration / post-dip recovery setups. Different from
  // a pure FAST_BUILD because the coin had a recent NEGATIVE move that's
  // now being absorbed by buyers.
  let reclaimSignals = 0;
  if (m.priceChange1h != null && m.priceChange1h < -10
      && m.priceChange5m != null && m.priceChange5m > 3) {
    reclaimSignals++; signals.push(`5m +${m.priceChange5m.toFixed(0)}% reclaim after 1h ${m.priceChange1h.toFixed(0)}% dip`);
  }
  if (reclaimSignals > 0 && (m.buySellRatio1h ?? 0) >= 0.55) {
    reclaimSignals++; signals.push(`Buy ratio ${(m.buySellRatio1h*100).toFixed(0)}% during reclaim`);
  }
  if (reclaimSignals > 0 && d.holderDelta != null && d.holderDelta > 3) {
    reclaimSignals++; signals.push(`Holders +${d.holderDelta.toFixed(0)}% during reclaim`);
  }
  if (reclaimSignals >= 2 && pattern === 'NONE') {
    pattern = 'RECLAIM';
    bullishCount = reclaimSignals;
  }

  // ── Score calculation ─────────────────────────────────────────────────
  let score = 0;
  if (pattern === 'FAST_BUILD') {
    // 3 sigs = 60, 4 = 75, 5 = 88, 6+ = 95
    score = Math.min(95, 45 + fastSignals * 12);
  } else if (pattern === 'SLOW_BUILD') {
    // Slow builds are more reliable — bump score
    score = Math.min(92, 50 + slowSignals * 14);
  } else if (pattern === 'RECLAIM') {
    score = Math.min(85, 35 + reclaimSignals * 18);
  }

  // Penalty for negative deltas (would-be bullish moves with selling pressure).
  // Dev selling and LP draining are near-rug signals — clamp confirmation score
  // hard so it can't trigger the momentum/demand bumps downstream.
  if (d.devPctDelta != null && d.devPctDelta < -1) {
    score = Math.min(score, 25);
    signals.push(`⚠️ DEV SELLING (${d.devPctDelta.toFixed(1)}pp) — buying confirmation invalidated`);
  }
  if (d.liquidityDelta != null && d.liquidityDelta < -10) {
    score = Math.min(score, 25);
    signals.push(`⚠️ LP DROP (${d.liquidityDelta.toFixed(0)}%) — invalidates buying confirmation`);
  }

  return { score: Math.round(score), type: pattern, signals, bullishCount };
}

// ═════════════════════════════════════════════════════════════════════════════
// POST-SPIKE BEHAVIOR SCORE
//
// Operator framework: "Strong coins don't just pump — they hold structure
// after the first pullback." Grades pullback magnitude as a demand modifier:
//
//   20-40% drop  → +15 (ideal re-entry zone, often 3-10x runners)
//   40-55% drop  → +8  (conditional — only credited if recovery confirms)
//   55-70% drop  → -10 (danger zone, most coins fail here)
//   70%+ drop    → -25 + deadCoin flag (likely dev exit / liquidity drain)
//   <20% or +    → 0   (this isn't a pullback play)
//
// Plus modifiers:
//   +10 recovery bonus — volume holding 1h baseline AND buys winning 5m ≥55%
//   +5  higher-low bonus — prior history snapshot showed deeper drop
//
// Dead-coin flag is set when:
//   - drop ≥70% (any volume condition), OR
//   - drop 60-70% AND volume <30% of 6h baseline AND no recovery
// Server-layer gate forces WATCHLIST when deadCoin=true.
// ═════════════════════════════════════════════════════════════════════════════
export function computePostSpikeBehavior(metrics, history = []) {
  const m = metrics;
  const drop1h = m.priceChange1h ?? 0;

  // Only relevant when there's a meaningful negative move
  if (drop1h >= 0) {
    return { score: 0, dropTier: 'NONE', deadCoin: false, recoveryActive: false, signals: [] };
  }

  const dropPct = Math.abs(drop1h);
  const signals = [];
  let dropTier = 'NONE';
  let baseScore = 0;
  let conditionalNeedsRecovery = false;
  let deadCoin = false;

  if (dropPct >= 70) {
    dropTier = 'AVOID';
    baseScore = -25;
    deadCoin = true;
    signals.push(`1h ${drop1h.toFixed(0)}% — likely dead (dev exit / liquidity drain)`);
  } else if (dropPct >= 55) {
    dropTier = 'DANGER';
    baseScore = -10;
    signals.push(`1h ${drop1h.toFixed(0)}% — danger zone, most coins fail here`);
  } else if (dropPct >= 40) {
    dropTier = 'CAUTION';
    baseScore = 8;
    conditionalNeedsRecovery = true;  // only credited if recovery confirms
    signals.push(`1h ${drop1h.toFixed(0)}% — caution tier, needs recovery confirmation`);
  } else if (dropPct >= 20) {
    dropTier = 'STRONG';
    baseScore = 15;
    signals.push(`1h ${drop1h.toFixed(0)}% — ideal re-entry zone`);
  } else {
    return { score: 0, dropTier: 'SHALLOW', deadCoin: false, recoveryActive: false, signals: [] };
  }

  // ── Recovery detection: volume holding + buys winning last 5m ─────────
  const volBaseline = (m.volume1h != null && m.volume6h != null && m.volume6h > 0)
    ? m.volume1h / Math.max(1, m.volume6h / 6)
    : null;
  const volBuilding = volBaseline != null && volBaseline >= 1.0;  // 1h vol >= avg hourly
  const b5 = Number(m.buys5m  ?? 0);
  const s5 = Number(m.sells5m ?? 0);
  const buyRatio5m = (b5 + s5) > 0 ? b5 / (b5 + s5) : null;
  const buysWinning5m = buyRatio5m != null && buyRatio5m >= 0.55;
  const recoveryActive = volBuilding && buysWinning5m;

  let recoveryBonus = 0;
  if (recoveryActive) {
    recoveryBonus = 10;
    signals.push(`Recovery: vol ${volBaseline.toFixed(1)}x baseline + 5m buys ${b5}/${b5+s5} (${(buyRatio5m*100).toFixed(0)}%)`);
  }

  // (b) logic: 40-55% tier withholds +8 unless recovery confirms
  if (conditionalNeedsRecovery && !recoveryActive) {
    baseScore = 0;
    signals.push(`Caution tier: no recovery yet — withholding +8 credit`);
  }

  // ── Dead-coin refinement ──────────────────────────────────────────────
  // 60-70% drop with volume dead and no recovery = also dead
  if (!deadCoin && dropPct >= 60 && !recoveryActive) {
    if (volBaseline != null && volBaseline < 0.3) {
      deadCoin = true;
      signals.push(`Drop ${drop1h.toFixed(0)}% + volume ${volBaseline.toFixed(1)}x baseline → coin likely done`);
    }
  }
  // 70%+ drop but volume STILL active + recovery = downgrade dead flag (rare narrative reclaim)
  if (deadCoin && dropPct < 80 && recoveryActive && volBaseline != null && volBaseline >= 1.5) {
    deadCoin = false;
    signals.push(`70%+ drop but heavy buyer return — narrative reclaim possible, not auto-dead`);
  }

  // ── Higher-low detection from history ─────────────────────────────────
  // If a previous snapshot showed a deeper drop than current, the coin has
  // recovered some structure — strength signal worth +5.
  let higherLowBonus = 0;
  if (Array.isArray(history) && history.length >= 1) {
    const deepestPrior = history.reduce((min, h) => {
      const hPct = h.priceChange1h ?? h.pct_change_1h ?? 0;
      return hPct < min ? hPct : min;
    }, 0);
    // Current drop is shallower (less negative) than a previous drop = higher low
    if (deepestPrior < drop1h - 5) {  // require ≥5pp improvement to count
      higherLowBonus = 5;
      signals.push(`Higher low: prev drop ${deepestPrior.toFixed(0)}% → current ${drop1h.toFixed(0)}%`);
    }
  }

  const totalScore = baseScore + recoveryBonus + higherLowBonus;

  return {
    score: totalScore,
    dropTier,
    deadCoin,
    recoveryActive,
    baseScore,
    recoveryBonus,
    higherLowBonus,
    signals,
  };
}

// ── Top-level v5 pipeline ──────────────────────────────────────────────────
export function scoreCoinV5(candidate, metricsIn = null) {
  const m = metricsIn || calculateBehaviorMetrics(candidate);
  const state    = classifyCoinState(m);
  const scanner  = computeScannerScore(m);
  const rugRisk  = computeRugRiskScore(m);
  const momentum = computeMomentumQualityScore(m);
  const wallet   = computeWalletQualityScore(m);
  const demand   = computeDemandQualityScore(m);

  // Compute buying confirmation + post-spike behavior BEFORE final call so
  // we can apply their adjustments to the score components.
  const history = candidate?._history || candidate?.history || [];
  const buyingConfirmation = computeBuyingConfirmation(m, history, rugRisk.score);
  const postSpike          = computePostSpikeBehavior(m, history);

  // ── BUYING CONFIRMATION ADJUSTMENTS ─────────────────────────────────
  // When confirmation pattern detected, reduce knife/distribution penalty
  // baked into momentum (post-migration dips that are being bought are
  // NOT falling knives). Also bumps demand quality since real buyers
  // stepping in IS sustained interest.
  let momentumAdj = momentum.score;
  let demandAdj   = demand.score;
  if (buyingConfirmation.score >= 50) {
    // Strong confirmation: cancel any knife penalty, add demand bonus
    const knifeRefund = Math.min(20, momentum.score < 50 ? 50 - momentum.score : 0);
    momentumAdj = Math.min(100, momentum.score + knifeRefund);
    demandAdj   = Math.min(100, demand.score + 10);
  } else if (buyingConfirmation.score >= 30) {
    // Moderate confirmation: smaller bonus
    momentumAdj = Math.min(100, momentum.score + 5);
    demandAdj   = Math.min(100, demand.score + 5);
  }

  // ── POST-SPIKE BEHAVIOR ADJUSTMENT ──────────────────────────────────
  // Operator framework: pullback magnitude is a graded signal, not binary.
  // Adds to demand quality (+15 ideal pullback, -25 likely-dead) so coins
  // holding structure after a drop get credit and dump-traps get penalized.
  if (postSpike.score !== 0) {
    demandAdj = Math.max(0, Math.min(100, demandAdj + postSpike.score));
  }

  const W = V5_WEIGHTS.finalCall;
  const finalCallRaw =
      momentumAdj * W.mq
    + demandAdj   * W.dq
    + wallet.score   * W.wq
    + scanner.score  * W.ss
    - rugRisk.score  * W.rr;
  const finalCall = clampScore(Math.round(finalCallRaw));

  const scoreSet = {
    scanner: scanner.score, rugRisk: rugRisk.score, momentum: momentumAdj,
    wallet: wallet.score,   demand: demandAdj,   finalCall,
    momentumBase: momentum.score, demandBase: demand.score, // for audit
  };
  const labels = assignLabels(state, scoreSet, m);
  const action = decideAction(scoreSet, state, labels, m);

  // Build human-readable explanation
  const explain = buildV5Explanation(state, scoreSet, labels, action, m);

  // ── ACTIVITY + REACTIVATION LAYER ────────────────────────────────────────
  // Classify the token's activity state (different axis from lifecycle state).
  // Lifecycle state = NEW_BIRTH/FIRST_EXPANSION/... based on AGE.
  // Activity  state = NEW/WATCHING/QUIET/REVIVING/HOT/REJECTED based on
  //                   ACTIVITY trajectory (volume/buys/wallets over time).
  const activity = classifyActivityState(m, history, scoreSet, labels);

  // Reactivation only fires when activity says REVIVING — second-leg detection.
  const reactivation = (activity.state === 'REVIVING' || activity.state === 'HOT')
    ? computeReactivationScore(m, history, scoreSet)
    : { score: 0, status: 'NOT_REVIVING', ledger: [] };

  // Translate V5 action + activity into the new decision label set
  // (CALL_NOW / WATCH_FOR_TRIGGER / REVIVING / IGNORE_FOR_NOW / HARD_REJECT).
  const decision = buildDecision(action, activity, reactivation, scoreSet, labels);

  // Triggers — explicit entry/exit conditions in plain English
  const triggers = buildTriggers(scoreSet, labels, m, activity, candidate);

  // Context summary — "what changed"
  const context = buildContextSummary(activity, history, m, scoreSet);

  return {
    state, action, labels,
    scores: scoreSet,
    finalCallRaw: +finalCallRaw.toFixed(2),
    breakdowns: { scanner, rugRisk, momentum, wallet, demand },
    explain,
    // NEW additive outputs
    activity,           // { state, transitions[], confidence, reasons[] }
    reactivation,       // { score, status, ledger[] }
    decision,           // { label, reasoning, phase }
    triggers,           // { call, kill }
    context,            // "Previously quiet, now showing X"
    buyingConfirmation, // { score, type: FAST_BUILD|SLOW_BUILD|RECLAIM|NONE, signals[], bullishCount }
    postSpike,          // { score, dropTier, deadCoin, recoveryActive, signals[] }
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTIVITY STATE CLASSIFIER
// Tracks the token's TRAJECTORY across recent scans:
//   NEW       — first scan, no history
//   WATCHING  — scored before, modest signals, awaiting confirmation
//   QUIET     — activity dropped (vol/txns/holders flat or down for ≥10min)
//   REVIVING  — was QUIET, now showing volume + buys + wallets returning
//   HOT       — strong sustained activity, recent positive deltas
//   REJECTED  — rug-risk hard block triggered (NEVER comes from low score alone)
// ═════════════════════════════════════════════════════════════════════════════
export function classifyActivityState(metrics, history = [], scores = null, labels = []) {
  const m = metrics;
  const reasons = [];
  const transitions = [];

  // REJECTED = HARD criteria only (per spec: "LOW SCORE ≠ DEAD")
  const rugRisk = scores?.rugRisk ?? 0;
  const hardReject =
       rugRisk >= V5_WEIGHTS.decision.blockRug
    || (m.devWalletPct != null && m.devWalletPct > 15)
    || m.deployerHistoryRisk === 'SERIAL_RUGGER'
    || (labels || []).includes('BLOCKED_RUG_RISK')
    || (labels || []).includes('DEV_EXIT_RISK')
    || (m.deltas?.liquidityDelta != null && m.deltas.liquidityDelta < -50);
  if (hardReject) {
    if (rugRisk >= V5_WEIGHTS.decision.blockRug) reasons.push(`Rug risk ${rugRisk} ≥ block threshold`);
    if (m.devWalletPct > 15) reasons.push(`Dev wallet ${m.devWalletPct.toFixed(1)}% — extreme`);
    if (m.deployerHistoryRisk === 'SERIAL_RUGGER') reasons.push('Serial rugger deployer');
    if ((m.deltas?.liquidityDelta ?? 0) < -50) reasons.push('Liquidity removed (>50% drop)');
    return { state: 'REJECTED', transitions: [], confidence: 'HIGH', reasons };
  }

  // Build trajectory signals from current scan + deltas + history
  const buys     = (m.buys1h ?? 0);
  const sells    = (m.sells1h ?? 0);
  const txns     = buys + sells;
  const v1       = m.volume1h ?? 0;
  const v6Rate   = (m.volume6h ?? 0) / 6;
  const volRatio = v6Rate > 0 ? v1 / v6Rate : null;

  const d        = m.deltas || {};
  const mcapUp   = (d.mcapDelta     ?? 0) > 5;
  const mcapDn   = (d.mcapDelta     ?? 0) < -5;
  const volUp    = (d.volumeDelta   ?? 0) > 20;
  const volDn    = (d.volumeDelta   ?? 0) < -25;
  const buyUp    = (d.buyRatioDelta ?? 0) > 0.05;
  const buyDn    = (d.buyRatioDelta ?? 0) < -0.05;
  const holdUp   = (d.holderDelta   ?? 0) > 5;
  const holdDn   = (d.holderDelta   ?? 0) < -3;
  const velUp    = (d.velocityDelta ?? 0) > 0.3;

  // HOT = strong activity + positive deltas + recent (or no) history
  const isHot =
    ((scores?.momentum ?? 0) >= 65 && (scores?.demand ?? 0) >= 60 && rugRisk < 35
      && (mcapUp || holdUp || volUp || velUp || (volRatio != null && volRatio > 1.2)));

  if (isHot) {
    if (mcapUp) reasons.push(`MCap +${d.mcapDelta.toFixed(0)}% since last scan`);
    if (holdUp) reasons.push(`Holders +${d.holderDelta.toFixed(0)}%`);
    if (volUp)  reasons.push(`Volume +${d.volumeDelta.toFixed(0)}%`);
    if (volRatio > 1.2) reasons.push(`Volume ${volRatio.toFixed(1)}x vs 6h baseline`);
    return { state: 'HOT', transitions, confidence: 'HIGH', reasons };
  }

  // First-time observation (no history, no deltas)
  const noHistory = history.length === 0 && (!d || d.minutesAgo == null);
  if (noHistory) {
    reasons.push('First observation — awaiting rescan to build trajectory');
    return { state: 'NEW', transitions, confidence: 'LOW', reasons };
  }

  // Build a quiet-then-revive signal from history if available.
  // Quiet window = at least one prior snapshot 10+ min ago with low activity.
  let wasQuiet = false;
  let prevTxns = null;
  let prevVol  = null;
  if (history.length > 0) {
    const stale = history.find(h => (h.minutesAgo ?? 0) >= 10);
    if (stale) {
      prevTxns = (stale.buys1h ?? 0) + (stale.sells1h ?? 0);
      prevVol  = stale.volume1h ?? 0;
      const wasFlat = prevTxns < 25 && prevVol < 3000;
      const wasFalling = stale.priceChange1h != null && stale.priceChange1h < -5;
      wasQuiet = wasFlat || wasFalling;
    }
  }
  // Fallback: deltas show big drop in vol/buys = was active, now quiet
  if (!wasQuiet && d.volumeDelta != null && d.buyRatioDelta != null) {
    if (d.volumeDelta < -40 && d.buyRatioDelta < -0.1) wasQuiet = true;
  }

  // Current scan shows activity returning?
  const activityReturning =
    (volUp || mcapUp || buyUp || holdUp || velUp)
    && (txns >= 20 || v1 > 2000)
    && (m.buySellRatio1h ?? 0) >= 0.50;

  if (wasQuiet && activityReturning) {
    if (volUp)  reasons.push(`Volume +${d.volumeDelta.toFixed(0)}% after quiet period`);
    if (buyUp)  reasons.push(`Buy pressure +${(d.buyRatioDelta*100).toFixed(0)}pp returning`);
    if (holdUp) reasons.push(`New holders +${d.holderDelta.toFixed(0)}% entering`);
    if (velUp)  reasons.push(`Velocity rising +${d.velocityDelta.toFixed(2)} buys/min`);
    transitions.push('QUIET → REVIVING');
    return { state: 'REVIVING', transitions, confidence: 'MEDIUM', reasons };
  }

  // Quiet — current activity is anemic
  const isQuiet =
       (txns < 25 && v1 < 3000)
    || (volDn && buyDn)
    || (volRatio != null && volRatio < 0.4 && (m.priceChange1h ?? 0) < 5);
  if (isQuiet) {
    if (txns < 25)               reasons.push(`Only ${txns} txns/1h — low activity`);
    if (volDn)                   reasons.push(`Volume ${d.volumeDelta.toFixed(0)}% — fading`);
    if (volRatio != null && volRatio < 0.4) reasons.push(`Volume ${volRatio.toFixed(2)}x vs 6h — drying up`);
    if (history.length > 0)      transitions.push('WATCHING → QUIET');
    return { state: 'QUIET', transitions, confidence: 'MEDIUM', reasons };
  }

  // Default: WATCHING — there is some activity, awaiting confirmation
  if ((scores?.finalCall ?? 0) >= 50)             reasons.push(`Final score ${scores.finalCall} — building`);
  if (m.buySellRatio1h != null && m.buySellRatio1h >= 0.55) reasons.push(`Buy ratio ${(m.buySellRatio1h*100).toFixed(0)}% — modest demand`);
  if (txns >= 25)                                 reasons.push(`${txns} txns/1h — present but unconfirmed`);
  if (!reasons.length)                            reasons.push('Mixed signals — needs confirmation');
  return { state: 'WATCHING', transitions, confidence: 'MEDIUM', reasons };
}

// ═════════════════════════════════════════════════════════════════════════════
// REACTIVATION SCORE — second-leg breakout detector (only runs when REVIVING/HOT)
// ═════════════════════════════════════════════════════════════════════════════
export const REACTIVATION_WEIGHTS = {
  volumeResurgence:   25, // highest — vol returning is the primary trigger
  buyPressureReturn:  15,
  structureShift:     20, // higher low / reclaim of prior breakdown
  smartWalletLate:    25, // VERY high — late smart entry is the strongest signal
  newHolderEntry:     10,
  priorRugSignals:   -15, // deduction if prior history showed rug-like patterns
};

export function computeReactivationScore(metrics, history = [], scores = null) {
  const m = metrics;
  const W = REACTIVATION_WEIGHTS;
  const lg = makeLedger();
  let s = 0;
  const d = m.deltas || {};

  // 1. Volume resurgence — vol1h vs prior snapshot vol1h, and vs 6h baseline
  if (d.volumeDelta != null && d.volumeDelta > 25) {
    const fit = Math.min(1, d.volumeDelta / 200);
    s += lg.add('rx.volume', 'Volume resurgence (delta)', `+${d.volumeDelta.toFixed(0)}%`, `fit=${fit.toFixed(2)}`, fit * W.volumeResurgence);
  } else if (m.volume1h != null && m.volume6h != null && m.volume6h > 0) {
    const ratio = m.volume1h / Math.max(1, m.volume6h / 6);
    if (ratio > 1.3) {
      const fit = Math.min(1, (ratio - 1.3) / 2);
      s += lg.add('rx.volume', 'Volume above 6h baseline', `${ratio.toFixed(2)}x`, `fit=${fit.toFixed(2)}`, fit * W.volumeResurgence * 0.7);
    }
  }

  // 2. Buy pressure return — buy ratio recovering after being weak
  if (d.buyRatioDelta != null && d.buyRatioDelta > 0.10) {
    const fit = Math.min(1, d.buyRatioDelta / 0.40);
    s += lg.add('rx.buyReturn', 'Buy pressure returning', `buyRatioΔ=+${(d.buyRatioDelta*100).toFixed(0)}pp`, `fit=${fit.toFixed(2)}`, fit * W.buyPressureReturn);
  }

  // 3. Structure shift — higher low formation, reclaim of prior breakdown
  // Proxy: 5m positive after prior dip in history OR current 5m positive
  // following a 1h drop with mcap delta now positive.
  let structurePts = 0;
  if (m.priceChange5m != null && m.priceChange1h != null) {
    if (m.priceChange1h < -10 && m.priceChange5m > 3) {
      const fit = Math.min(1, m.priceChange5m / 15);
      structurePts = fit * W.structureShift;
      lg.add('rx.structure', 'Structure shift (5m up after 1h dip)', `1h=${m.priceChange1h.toFixed(0)}% 5m=+${m.priceChange5m.toFixed(1)}%`, `fit=${fit.toFixed(2)}`, structurePts);
    } else if ((d.mcapDelta ?? 0) > 8 && m.priceChange5m > 1) {
      const fit = Math.min(1, d.mcapDelta / 30);
      structurePts = fit * W.structureShift * 0.7;
      lg.add('rx.structure', 'Reclaiming prior level', `mcapΔ=+${d.mcapDelta.toFixed(0)}% 5m=+${m.priceChange5m.toFixed(1)}%`, `fit=${fit.toFixed(2)}`, structurePts);
    }
  }
  s += structurePts;

  // 4. SMART WALLET LATE ENTRY — strongest signal. Detect known winner OR
  // smart money score increase from history baseline.
  const winners = m.knownWinnerCount ?? 0;
  const sm = m.smartMoneyScore ?? 0;
  const ageMin = m.ageMinutes ?? 0;
  if (winners >= 1 && ageMin > 30) {
    // Late entry = winner present AFTER 30min mark (not just an early sniper)
    const fit = Math.min(1, winners / 3);
    s += lg.add('rx.smartLate', 'Smart wallet LATE entry (high signal)', `${winners} winners @ ${ageMin.toFixed(0)}min`, `fit=${fit.toFixed(2)}`, fit * W.smartWalletLate);
  } else if (sm >= 50 && ageMin > 30) {
    const fit = Math.min(1, (sm - 50) / 40);
    s += lg.add('rx.smartLate', 'Smart money signal (late phase)', `sm=${sm} @ ${ageMin.toFixed(0)}min`, `fit=${fit.toFixed(2)}`, fit * W.smartWalletLate * 0.7);
  }

  // 5. New holder entry after lull
  if (d.holderDelta != null && d.holderDelta > 5) {
    const fit = Math.min(1, d.holderDelta / 30);
    s += lg.add('rx.newHolders', 'New holders entering after lull', `+${d.holderDelta.toFixed(1)}%`, `fit=${fit.toFixed(2)}`, fit * W.newHolderEntry);
  }

  // 6. Prior rug signals — deduct if history shows previous rug-like activity
  // (e.g. liquidity dropped a lot before, dev pct moved heavily)
  if (history && history.length > 0) {
    const everLiqDrop = history.some(h => h.liquidityDelta != null && h.liquidityDelta < -25);
    const everDevSell = history.some(h => h.devPctDelta    != null && h.devPctDelta    < -2);
    if (everLiqDrop || everDevSell) {
      const pen = W.priorRugSignals;
      lg.add('rx.priorRug', 'Prior rug-like signals in history', everLiqDrop ? 'liq drop seen' : 'dev sell seen', `=${pen}`, pen, 'neg');
      s += pen;
    }
  }

  const score = clampScore(Math.round(s));
  // Status: REAL re-accumulation requires multiple positive signals + low rug
  const positiveCount = lg.lines.filter(L => L.p > 0).length;
  const rug = scores?.rugRisk ?? 0;
  let status;
  if (score >= 60 && positiveCount >= 3 && rug < 35)      status = 'RE_ACCUMULATION';
  else if (score >= 40 && positiveCount >= 2 && rug < 50) status = 'POSSIBLE_RECLAIM';
  else if (score > 0)                                     status = 'FALSE_REVIVAL';
  else                                                    status = 'NOT_REVIVING';

  return { score, scoreRaw: +s.toFixed(2), status, ledger: lg.lines };
}

// ═════════════════════════════════════════════════════════════════════════════
// DECISION ENGINE — translates V5 action + activity + reactivation into the
// final decision label set the user requested:
//   CALL_NOW · WATCH_FOR_TRIGGER · REVIVING · IGNORE_FOR_NOW · HARD_REJECT
// ═════════════════════════════════════════════════════════════════════════════
export function buildDecision(v5Action, activity, reactivation, scores, labels) {
  // HARD_REJECT — only from rug/dev/honeypot/extreme-concentration. Per spec:
  // "LOW SCORE ≠ DEAD. Only HARD REJECT removes a token."
  if (activity.state === 'REJECTED' || v5Action === 'BLOCK') {
    return {
      label: 'HARD_REJECT',
      reasoning: activity.reasons.join(' · ') || 'Rug-class signals detected — token removed from rotation',
      phase: 'REJECTED',
    };
  }

  // REVIVING — only fires when activity state is literally REVIVING (was
  // QUIET, now returning). HOT runners with strong deltas go to CALL_NOW,
  // not REVIVING — REVIVING is specifically the "second leg" detection.
  if (activity.state === 'REVIVING'
      && reactivation.score >= 40
      && reactivation.status !== 'FALSE_REVIVAL'
      && (scores?.rugRisk ?? 0) < 50) {
    const reasoning = reactivation.status === 'RE_ACCUMULATION'
      ? `Re-accumulation confirmed: ${activity.reasons.slice(0,2).join(' · ')}`
      : `Possible reclaim forming: ${activity.reasons.slice(0,2).join(' · ')}`;
    return { label: 'REVIVING', reasoning, phase: 'REVIVING' };
  }

  // CALL_NOW = V5 said POST and activity isn't quiet/rejected
  if (v5Action === 'POST' && activity.state !== 'QUIET' && activity.state !== 'REJECTED') {
    const r = [];
    if (scores.momentum >= 65) r.push(`Momentum quality ${scores.momentum} confirmed`);
    if (scores.demand   >= 65) r.push(`Demand quality ${scores.demand} sustained`);
    if (scores.rugRisk  < 25)  r.push(`Rug risk ${scores.rugRisk} — clean`);
    if (activity.state === 'HOT') r.unshift('HOT activity state');
    return { label: 'CALL_NOW', reasoning: r.join(' · ') || 'All gates cleared', phase: 'EARLY' };
  }

  // WATCH_FOR_TRIGGER = V5 said WATCHLIST OR activity is HOT but final didn't hit POST
  if (v5Action === 'WATCHLIST' || (activity.state === 'HOT' && v5Action !== 'IGNORE')) {
    const r = [];
    if (scores.momentum < 65 && scores.momentum >= 50) r.push(`Momentum ${scores.momentum} building, awaiting 65+`);
    if (scores.demand   < 65 && scores.demand   >= 50) r.push(`Demand ${scores.demand} forming, awaiting 65+`);
    if (scores.rugRisk >= 25 && scores.rugRisk < 50)   r.push(`Rug risk ${scores.rugRisk} — caution`);
    if (labels.includes('WATCH_FOR_RECLAIM'))           r.push('Reclaim setup forming');
    if (labels.includes('EARLY_CLEAN_SEND'))            r.push('Clean early launch — wallet flow not yet confirmed');
    return { label: 'WATCH_FOR_TRIGGER', reasoning: r.join(' · ') || 'Modest signals, awaiting confirmation', phase: activity.state === 'HOT' ? 'MID' : 'EARLY' };
  }

  // IGNORE_FOR_NOW (NOT permanent — token stays in rotation per spec)
  return {
    label: 'IGNORE_FOR_NOW',
    reasoning: activity.reasons.slice(0,2).join(' · ') || 'Weak signals — keeping in rescan rotation',
    phase: activity.state === 'QUIET' ? 'QUIET' : 'EARLY',
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// CALL TRIGGER + KILL TRIGGER — explicit entry/exit conditions for the user
// ═════════════════════════════════════════════════════════════════════════════
export function buildTriggers(scores, labels, m, activity, candidate) {
  const mcap   = m.marketCap ?? 0;
  const liq    = m.liquidity ?? 0;
  const action = activity.state;
  const fmt$   = v => v >= 1000 ? '$' + (v/1000).toFixed(1) + 'K' : '$' + v.toFixed(0);

  // Call Trigger — what would upgrade this to CALL_NOW
  let call;
  if (action === 'REJECTED') {
    call = 'No entry — token hard-rejected';
  } else if (action === 'HOT' && scores.finalCall >= V5_WEIGHTS.decision.postFinal) {
    call = 'Already qualified — enter on next clean dip <5% from current';
  } else if (action === 'REVIVING') {
    const target = Math.round(mcap * 1.10);
    call = `Breaks ${fmt$(target)} mcap with sustained buy pressure (br ≥60%) and continued holder growth`;
  } else if (scores.momentum < 65 || scores.demand < 65) {
    const need = [];
    if (scores.momentum < 65) need.push(`momentum ≥65 (now ${scores.momentum})`);
    if (scores.demand   < 65) need.push(`demand ≥65 (now ${scores.demand})`);
    if (scores.finalCall < V5_WEIGHTS.decision.postFinal) need.push(`final ≥${V5_WEIGHTS.decision.postFinal} (now ${scores.finalCall})`);
    call = need.length ? `Hits ${need.join(' + ')}` : `Final score reaches ${V5_WEIGHTS.decision.postFinal}`;
  } else if (scores.rugRisk >= 25) {
    call = `Rug risk drops below 25 (currently ${scores.rugRisk})`;
  } else {
    call = 'Continued buy pressure + new holder entry on next rescan';
  }

  // Kill Trigger — what would downgrade or trigger exit
  const killConditions = [];
  if (mcap > 0)              killConditions.push(`Drops below ${fmt$(mcap * 0.75)} (-25% from current)`);
  killConditions.push('Buy ratio flips below 40% with rising sell volume');
  killConditions.push('Dev wallet % drops by ≥2pp (active distribution)');
  if (liq > 0)               killConditions.push(`Liquidity drops by ≥30% (current ${fmt$(liq)})`);
  killConditions.push(`Rug risk climbs above 50 (currently ${scores.rugRisk})`);
  const kill = killConditions.slice(0,3).join(' · ');

  return { call, kill };
}

// ═════════════════════════════════════════════════════════════════════════════
// CONTEXT SUMMARY — "what changed since last observation"
// ═════════════════════════════════════════════════════════════════════════════
export function buildContextSummary(activity, history, m, scores) {
  if (!history || history.length === 0) {
    if (activity.state === 'NEW') return 'First observation — no prior context';
    const d = m.deltas;
    if (d && d.minutesAgo != null) {
      const bits = [];
      if (d.mcapDelta     != null && Math.abs(d.mcapDelta) > 5)   bits.push(`mcap ${d.mcapDelta>=0?'+':''}${d.mcapDelta.toFixed(0)}%`);
      if (d.holderDelta   != null && Math.abs(d.holderDelta) > 3) bits.push(`holders ${d.holderDelta>=0?'+':''}${d.holderDelta.toFixed(0)}%`);
      if (d.volumeDelta   != null && Math.abs(d.volumeDelta) > 15)bits.push(`volume ${d.volumeDelta>=0?'+':''}${d.volumeDelta.toFixed(0)}%`);
      if (d.buyRatioDelta != null && Math.abs(d.buyRatioDelta) > 0.05) bits.push(`buy ratio ${d.buyRatioDelta>=0?'+':''}${(d.buyRatioDelta*100).toFixed(0)}pp`);
      if (bits.length) return `Since ${d.minutesAgo}min ago: ${bits.join(', ')}`;
    }
    return 'No significant change since last scan';
  }

  // We have history — describe trajectory
  if (activity.state === 'REVIVING')  return `Previously quiet for ~${Math.round(history[0]?.minutesAgo ?? 10)}min, now showing ${activity.reasons[0] || 'volume return'}`;
  if (activity.state === 'HOT')       return `Sustained activity — ${activity.reasons.slice(0,2).join(', ')}`;
  if (activity.state === 'QUIET')     return `Activity has dwindled — ${activity.reasons[0] || 'volume drying up'}`;
  if (activity.state === 'WATCHING')  return `Holding pattern — ${activity.reasons[0] || 'modest signals continue'}`;
  if (activity.state === 'REJECTED')  return `Hard-rejected — ${activity.reasons[0] || 'rug-class signal'}`;
  return 'Trajectory neutral';
}

function buildV5Explanation(state, s, labels, action, m) {
  const bullish = [];
  const risk    = [];
  const upgrade = [];
  const downgrade = [];

  if (s.momentum >= 70)  bullish.push(`Momentum quality ${s.momentum} — real demand`);
  if (s.demand >= 70)    bullish.push(`Demand quality ${s.demand} — sustained interest`);
  if (s.wallet >= 65)    bullish.push(`Wallet quality ${s.wallet} — clean buyers`);
  if (s.scanner >= 70)   bullish.push(`Scanner score ${s.scanner} — strong fundamentals`);
  if (m.knownWinnerCount > 0) bullish.push(`${m.knownWinnerCount} known winner wallet${m.knownWinnerCount>1?'s':''} in early`);
  if ((m.deltas?.holderDelta ?? 0) > 10) bullish.push(`Holders +${m.deltas.holderDelta.toFixed(0)}% since last scan`);

  if (s.rugRisk >= 50)              risk.push(`Rug risk ${s.rugRisk} — significant`);
  else if (s.rugRisk >= 35)         risk.push(`Rug risk ${s.rugRisk} — caution`);
  if (labels.includes('FALLING_KNIFE'))     risk.push('Falling knife — no reclaim');
  if (labels.includes('SNIPER_CONTROLLED')) risk.push('Sniper-controlled wallet flow');
  if (labels.includes('DEV_EXIT_RISK'))     risk.push('Dev wallet selling');
  if (labels.includes('DEAD_AFTER_SPIKE'))  risk.push('Dead volume after initial spike');
  if (s.demand < 50)                risk.push(`Demand quality ${s.demand} — weak follow-through`);
  if (s.momentum < 50)              risk.push(`Momentum quality ${s.momentum} — weak`);

  if (action === 'WATCHLIST') {
    if (s.momentum < 70) upgrade.push('Momentum quality reaching 70+');
    if (s.demand < 70)   upgrade.push('Demand quality reaching 70+');
    if (s.rugRisk >= 35) upgrade.push(`Rug risk dropping below 35 (currently ${s.rugRisk})`);
    if (s.finalCall < 75) upgrade.push(`Final score reaching 75 (currently ${s.finalCall})`);
  } else if (action === 'IGNORE') {
    upgrade.push('Wallet diversity + holder growth');
    upgrade.push('Buy ratio above 60% sustained');
  } else if (action === 'POST') {
    downgrade.push(`Rug risk climbing above 35`);
    downgrade.push('Holder count starting to drop');
    downgrade.push('Buy pressure flipping to selling');
  }

  if (s.rugRisk > 0 && s.rugRisk < 35) downgrade.push('Dev wallet selling');
  if (action === 'POST') downgrade.push('Volume dying / one-candle-spike pattern');

  let summary;
  if      (action === 'POST')      summary = `${state} · clean ${labels.includes('CONFIRMED_RUNNER') ? 'runner' : labels.includes('EARLY_CLEAN_SEND') ? 'early send' : 'setup'} — final ${s.finalCall}, rug ${s.rugRisk}`;
  else if (action === 'WATCHLIST') summary = `${state} · watching ${labels.includes('WATCH_FOR_RECLAIM') ? 'for reclaim' : 'for confirmation'} — final ${s.finalCall}, rug ${s.rugRisk}`;
  else if (action === 'BLOCK')     summary = `${state} · BLOCKED — rug risk ${s.rugRisk}${labels.includes('DEV_EXIT_RISK') ? ', dev exit' : ''}${labels.includes('SNIPER_CONTROLLED') ? ', sniper-controlled' : ''}`;
  else                             summary = `${state} · ignored — final ${s.finalCall}, rug ${s.rugRisk}, weak demand/momentum`;

  return { summary, bullish, risk, upgrade, downgrade };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry: runs the dual model
// ─────────────────────────────────────────────────────────────────────────────
export function runDualModel(candidate, discoveryWeights = null) {
  const metrics    = calculateBehaviorMetrics(candidate);
  const ageMinutes = metrics.ageMinutes;
  const modelUsed  = selectScoringModel(ageMinutes);

  const discovery = scoreDiscoveryCoin(candidate, metrics, discoveryWeights);
  const runner    = (ageMinutes == null || ageMinutes > 0)
    ? scoreRunnerCoin(candidate, metrics)
    : { score: 0, parts: {}, reasons: [], risks: [], model: 'runner' };

  const primary    = modelUsed === 'runner' ? runner : discovery;

  // ── V5 PIPELINE — authoritative scoring + decision ───────────────────────
  const v5 = scoreCoinV5(candidate, metrics);

  // Final score = v5.scores.finalCall (replaces old discovery composite)
  const finalScore = v5.scores.finalCall;
  const action     = v5.action; // 'POST' | 'WATCHLIST' | 'IGNORE' | 'BLOCK'
  const confidence = buildConfidence(candidate, metrics, primary);

  // Stuff v5 outputs into parts so they persist via the existing
  // dual_parts JSON column (no DB migration needed). Includes the new
  // activity + reactivation + decision + triggers + context layer so
  // the dashboard's V5 DECISION CARD has data to render.
  const enrichedParts = {
    ...primary.parts,
    _v5: {
      state: v5.state,
      action: v5.action,
      labels: v5.labels,
      scores: v5.scores,
      finalCallRaw: v5.finalCallRaw,
      explain: v5.explain,
      ledgers: {
        scanner:  v5.breakdowns.scanner.ledger,
        rugRisk:  v5.breakdowns.rugRisk.ledger,
        momentum: v5.breakdowns.momentum.ledger,
        wallet:   v5.breakdowns.wallet.ledger,
        demand:   v5.breakdowns.demand.ledger,
      },
      // Activity / reactivation / decision layer
      activity:     v5.activity,
      reactivation: v5.reactivation,
      decision:     v5.decision,
      triggers:     v5.triggers,
      context:      v5.context,
      buyingConfirmation: v5.buyingConfirmation,
      postSpike:          v5.postSpike,
      ageMinutes,
    },
  };

  return {
    finalScore,
    modelUsed,
    confidence,
    action,                 // POST/WATCHLIST/IGNORE/BLOCK from v5
    v5,                     // full v5 result for callers that want it
    reasons:         primary.reasons,
    risks:           primary.risks,
    ageMinutes,
    discoveryScore:  discovery.score,
    runnerScore:     runner.score,
    parts:           enrichedParts,
    thresholds:      modelUsed === 'runner' ? RUNNER_THRESHOLDS : DISCOVERY_THRESHOLDS,
    foundationTotal: discovery.foundationTotal,
    dataConfidence:   discovery.dataConfidence,
    dataCompleteness: discovery.dataCompleteness,
  };
}
