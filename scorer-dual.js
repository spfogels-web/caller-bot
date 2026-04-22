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
let _latePumpConfig = {
  p1hSevereThreshold: 500, p1hSeverePenalty: 15,
  p1hThreshold:       300, p1hPenalty:       10,
  p24hThreshold:      500, p24hPenalty:       8,
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

// ── Shared behavior metrics ─────────────────────────────────────────────────
export function calculateBehaviorMetrics(candidate) {
  const c = candidate || {};
  return {
    ageMinutes:           getCoinAgeMinutes(c),
    buyVelocity:          safeNum(c.buyVelocity ?? c.buy_velocity),
    volumeVelocity:       safeNum(c.volumeVelocity ?? c.volume_velocity),
    launchUbr:            safeNum(c.launchUniqueBuyerRatio ?? c.launch_unique_buyer_ratio),
    buySellRatio1h:       safeNum(c.buySellRatio1h ?? c.buy_sell_ratio_1h),
    buys1h:               safeNum(c.buys1h ?? c.buys_1h, 0),
    sells1h:              safeNum(c.sells1h ?? c.sells_1h, 0),
    marketCap:            safeNum(c.marketCap ?? c.market_cap, 0),
    liquidity:            safeNum(c.liquidity, 0),
    volume1h:             safeNum(c.volume1h ?? c.volume_1h, 0),
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
    vvAcc += add('vv.base', 'Velocity base', `bv=${bv.toFixed(2)}/min`, `curve(bv,0→12,28.7,s=0.6)=${base.toFixed(1)}`, base);
    if (bv >= 8)        reasons.push(`EXPLOSIVE velocity (${bv.toFixed(1)} buys/min)`);
    else if (bv >= 4)   reasons.push(`Strong velocity (${bv.toFixed(1)} buys/min)`);
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
  if (smartMoney > 0) {
    const weight = winners >= 2 ? 0.15 : winners >= 1 ? 0.30 : 0.55;
    const pts = curve(smartMoney, 20, 90, maxWQ * weight, 0.8);
    if (pts > 0.1) {
      wqAcc += add('wq.smart', 'Smart money score', `sm=${smartMoney}`, `curve*${weight}=${pts.toFixed(1)}`, pts);
      if (smartMoney >= 60) reasons.push(`Smart money signal (score ${smartMoney})`);
    }
  }

  // Clean wallet fallback — only applies when no strong positive signal yet
  // Awards continuous points based on "cleanliness" (low clusters + low coord)
  if (winners === 0 && smartMoney < 20) {
    const cleanScore = Math.max(0, 1 - (clusters * 0.15 + coord * 0.6));
    // 4-9 pts based on how clean — not a flat 9 for everyone
    const pts = cleanScore * maxWQ * 0.45;
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
  const finalScore = clamp(primary.score);
  const action     = mapScoreToAction(finalScore, modelUsed);
  const confidence = buildConfidence(candidate, metrics, primary);

  return {
    finalScore,
    modelUsed,
    confidence,
    action,
    reasons:         primary.reasons,
    risks:           primary.risks,
    ageMinutes,
    discoveryScore:  discovery.score,
    runnerScore:     runner.score,
    parts:           primary.parts,
    thresholds:      modelUsed === 'runner' ? RUNNER_THRESHOLDS : DISCOVERY_THRESHOLDS,
    foundationTotal: discovery.foundationTotal,
    dataConfidence:   discovery.dataConfidence,
    dataCompleteness: discovery.dataCompleteness,
  };
}
