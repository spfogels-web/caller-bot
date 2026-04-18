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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DISCOVERY MODEL v3 — 5 FOUNDATION SIGNALS (100 points)
// Focus on MOVEMENT and INTENT over static structure
// ─────────────────────────────────────────────────────────────────────────────

export function scoreDiscoveryCoin(candidate, metricsIn = null, weights = null) {
  const m = metricsIn || calculateBehaviorMetrics(candidate);
  const w = weights || DISCOVERY_WEIGHTS;
  const reasons = [];
  const risks = [];
  const parts = {};
  const veryEarly = (m.ageMinutes ?? 0) < 15;

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. VOLUME VELOCITY (max: w.volumeVelocity, default 35)
  //    Buys/minute acceleration in first 5-15 min.
  //    Rapid volume increase vs baseline. Consistent buy pressure (not spikes).
  //    THIS IS THE FOUNDATION. Real sends show acceleration patterns.
  // ═══════════════════════════════════════════════════════════════════════════
  let p = 0;
  const maxVV = w.volumeVelocity || 35;
  const bv = m.buyVelocity ?? m.volumeVelocity;

  if (bv == null) {
    p = Math.round(maxVV * 0.20);
    risks.push('Volume velocity unknown — very early');
  } else if (bv >= 1.0)  { p = maxVV;                    reasons.push(`Explosive velocity (${bv.toFixed(2)}/min) — STRONG BUY SIGNAL`); }
  else if (bv >= 0.7)    { p = Math.round(maxVV * 0.90);  reasons.push(`Very strong velocity (${bv.toFixed(2)}/min)`); }
  else if (bv >= 0.5)    { p = Math.round(maxVV * 0.78);  reasons.push(`Strong buy velocity (${bv.toFixed(2)}/min)`); }
  else if (bv >= 0.3)    { p = Math.round(maxVV * 0.60);  reasons.push(`Healthy buy velocity (${bv.toFixed(2)}/min)`); }
  else if (bv >= 0.15)   { p = Math.round(maxVV * 0.40);  reasons.push(`Modest velocity (${bv.toFixed(2)}/min)`); }
  else if (bv >= 0.05)   { p = Math.round(maxVV * 0.20);  risks.push(`Weak velocity (${bv.toFixed(2)}/min)`); }
  else                   { p = 0;                         risks.push('Flat/dead volume — no acceleration'); }

  // Acceleration bonus: 5m run-rate exceeding 1h average = momentum building
  if (m.priceChange5m != null && m.priceChange1h != null) {
    const runRate5m = m.priceChange5m;
    const avgRate1h = m.priceChange1h / 12;
    if (runRate5m > avgRate1h * 1.5 && runRate5m > 0) {
      p = Math.min(maxVV, p + Math.round(maxVV * 0.10));
      reasons.push('Accelerating — 5m run-rate exceeds 1h avg');
    }
  }

  // Consistency check: high buys count = sustained, not just a spike
  if (m.buys1h >= 80 && bv != null && bv >= 0.3) {
    p = Math.min(maxVV, p + Math.round(maxVV * 0.06));
    reasons.push(`Sustained pressure: ${m.buys1h} buys in 1h`);
  }
  parts.volumeVelocity = p;

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. BUY vs SELL PRESSURE (max: w.buyPressure, default 25)
  //    More buys than sells (frequency). Larger buy sizes vs sell sizes (value).
  //    RED FLAG: Micro buys + large sells = exit liquidity setup.
  // ═══════════════════════════════════════════════════════════════════════════
  p = 0;
  const maxBP = w.buyPressure || 25;
  const br = m.buySellRatio1h;
  const totalTxns = m.buys1h + m.sells1h;

  if (br == null) {
    p = Math.round(maxBP * 0.30);
  } else if (br >= 0.85) { p = maxBP;                    reasons.push(`Overwhelming buy dominance (${(br*100).toFixed(0)}% buys)`); }
  else if (br >= 0.75)   { p = Math.round(maxBP * 0.88); reasons.push(`Strong buy pressure (${(br*100).toFixed(0)}% buys)`); }
  else if (br >= 0.65)   { p = Math.round(maxBP * 0.72); reasons.push(`Healthy buy ratio (${(br*100).toFixed(0)}% buys)`); }
  else if (br >= 0.55)   { p = Math.round(maxBP * 0.52); reasons.push(`Slight buy edge (${(br*100).toFixed(0)}% buys)`); }
  else if (br >= 0.45)   { p = Math.round(maxBP * 0.28); }
  else if (br >= 0.35)   { p = Math.round(maxBP * 0.10); risks.push(`Sell pressure building (${(br*100).toFixed(0)}% buys)`); }
  else                   { p = 0;                        risks.push(`Sellers dominating (${(br*100).toFixed(0)}% buys) — EXIT LIQUIDITY RISK`); }

  // Volume depth: high txn count = real activity, not just a few wallets
  if (totalTxns >= 150)     { p = Math.min(maxBP, p + 3); reasons.push(`Very active: ${totalTxns} transactions/1h`); }
  else if (totalTxns >= 80) { p = Math.min(maxBP, p + 2); }
  else if (totalTxns >= 40) { p = Math.min(maxBP, p + 1); }

  // Red flag: lots of micro buys + fewer but larger sells = exit liquidity trap
  if (m.buys1h > 50 && m.sells1h > 0 && m.buys1h / m.sells1h > 10 && br != null && br < 0.60) {
    p = Math.max(0, p - 5);
    risks.push('Micro buys + large sells pattern — possible exit liquidity');
  }
  parts.buyPressure = p;

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. WALLET QUALITY (max: w.walletQuality, default 20)
  //    Known profitable wallets entering early. 2-5 strong wallets buying and
  //    holding (not instant flipping). Smart money behavior patterns.
  //    Measures: Conviction from experienced traders.
  // ═══════════════════════════════════════════════════════════════════════════
  p = 0;
  const maxWQ = w.walletQuality || 20;
  const winners = m.knownWinnerCount ?? 0;
  const clusters = m.clusterWalletCount ?? 0;
  const coord = m.coordinationIntensity ?? 0;

  // Winner wallets are the strongest conviction signal
  if (winners >= 5)       { p = maxWQ;                     reasons.push(`${winners} winner wallets in early — HIGHEST CONVICTION`); }
  else if (winners >= 3)  { p = Math.round(maxWQ * 0.85);  reasons.push(`${winners} winner wallets — strong conviction signal`); }
  else if (winners >= 2)  { p = Math.round(maxWQ * 0.70);  reasons.push(`${winners} winner wallets entering`); }
  else if (winners >= 1)  { p = Math.round(maxWQ * 0.50);  reasons.push(`${winners} winner wallet early`); }
  else {
    // No known winners — fall back to behavioral signals
    if (clusters === 0 && coord < 0.2)      { p = Math.round(maxWQ * 0.35); reasons.push('Clean wallet behavior — no coordination'); }
    else if (clusters <= 2)                  { p = Math.round(maxWQ * 0.25); }
    else if (clusters <= 5)                  { p = Math.round(maxWQ * 0.10); risks.push(`${clusters} cluster wallets — coordination concern`); }
    else                                     { p = 0;                        risks.push(`Heavy coordination: ${clusters} cluster wallets`); }
  }

  // Smart money overlay
  if (m.smartMoneyScore != null && m.smartMoneyScore >= 60) {
    p = Math.min(maxWQ, p + 3);
    reasons.push('Smart money signal detected');
  }

  // Bundle cross-reference: bundles with bad wallet quality = coordinated dump
  if ((m.bundleRisk === 'SEVERE' || m.bundleRisk === 'HIGH') && winners < 2) {
    p = Math.max(0, p - Math.round(maxWQ * 0.40));
    risks.push(`Bundle ${m.bundleRisk} + weak wallets — coordinated dump risk`);
  }

  // Sniper penalty — high sniper count = frontrun, dump incoming
  const snipers = m.sniperWalletCount ?? 0;
  if (snipers > 20)       { p = Math.max(0, p - 6); risks.push(`${snipers} sniper wallets — heavily frontrun`); }
  else if (snipers > 10)  { p = Math.max(0, p - 3); risks.push(`${snipers} snipers detected`); }
  else if (snipers <= 3 && snipers >= 0) { /* clean — no penalty */ }

  // BubbleMap risk — clustered/coordinated wallets
  if (m.bubbleMapRisk === 'SEVERE')      { p = Math.max(0, p - 8); risks.push('BubbleMap SEVERE — coordinated wallet cluster'); }
  else if (m.bubbleMapRisk === 'HIGH')   { p = Math.max(0, p - 4); risks.push('BubbleMap HIGH — suspicious wallet patterns'); }

  parts.walletQuality = p;

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. HOLDER DISTRIBUTION (max: w.holderDistribution, default 12)
  //    Split: Dev Wallet (8 pts) + Top 10 Holders (4 pts)
  // ═══════════════════════════════════════════════════════════════════════════
  const maxHD = w.holderDistribution || 12;
  const devMax = Math.round(maxHD * 0.667);  // ~8 of 12
  const top10Max = maxHD - devMax;            // ~4 of 12

  // ── Dev Wallet (8 pts) ──
  let devPts = 0;
  const dev = m.devWalletPct;
  const mintRevoked = m.mintAuthority === 0;
  if (dev == null) {
    devPts = veryEarly ? Math.round(devMax * 0.60) : Math.round(devMax * 0.35);
  } else if (dev <= 2)  { devPts = devMax;                   reasons.push(`Clean dev: ${dev.toFixed(1)}%${mintRevoked ? ', mint revoked' : ''}`); }
  else if (dev <= 5)    { devPts = Math.round(devMax * 0.75); reasons.push(`Low dev allocation (${dev.toFixed(1)}%)`); }
  else if (dev <= 10)   { devPts = Math.round(devMax * 0.50); }
  else if (dev <= 15)   { devPts = Math.round(devMax * 0.25); risks.push(`Dev holds ${dev.toFixed(1)}% — heavy allocation`); }
  else                  { devPts = 0;                         risks.push(`Dev wallet ${dev.toFixed(1)}% — INSTANT DISQUALIFIER`); }
  if (m.deployerHistoryRisk === 'SERIAL_RUGGER') { devPts = 0; risks.push('Serial rugger deployer — AVOID'); }

  // ── Top 10 Holders (4 pts) ──
  let top10Pts = 0;
  const top10 = m.top10HolderPct;
  if (top10 == null) {
    top10Pts = veryEarly ? Math.round(top10Max * 0.60) : Math.round(top10Max * 0.40);
  } else if (top10 < 30)  { top10Pts = top10Max;                    reasons.push(`Healthy distribution (top10: ${top10.toFixed(0)}%)`); }
  else if (top10 < 50)    { top10Pts = Math.round(top10Max * 0.75); }
  else if (top10 < 70)    { top10Pts = Math.round(top10Max * 0.50); risks.push(`Concentrated (top10: ${top10.toFixed(0)}%)`); }
  else                    { top10Pts = Math.round(top10Max * 0.25); risks.push(`Whale-dominated (top10: ${top10.toFixed(0)}%)`); }

  parts.holderDistribution = devPts + top10Pts;
  parts._devWallet = devPts;
  parts._top10Holders = top10Pts;

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. LIQUIDITY HEALTH (max: w.liquidityHealth, default 8)
  //    Optimal liq = 15-40% of mcap. <10% = easy rug. LP locked = premium.
  // ═══════════════════════════════════════════════════════════════════════════
  p = 0;
  const maxLH = w.liquidityHealth || 8;
  const lr = m.liqMcapRatio;

  if (lr == null) {
    p = Math.round(maxLH * 0.30);
  } else if (lr >= 0.15 && lr <= 0.40) { p = maxLH;                    reasons.push(`Optimal liquidity ratio (${(lr*100).toFixed(0)}%)`); }
  else if (lr >= 0.10)                 { p = Math.round(maxLH * 0.80); reasons.push(`Healthy liquidity (${(lr*100).toFixed(0)}%)`); }
  else if (lr > 0.40)                  { p = Math.round(maxLH * 0.70); reasons.push(`High liquidity ratio (${(lr*100).toFixed(0)}%)`); }
  else if (lr >= 0.05)                 { p = Math.round(maxLH * 0.45); risks.push(`Below-average liquidity (${(lr*100).toFixed(0)}%)`); }
  else if (lr >= 0.02)                 { p = Math.round(maxLH * 0.15); risks.push(`Thin liquidity (${(lr*100).toFixed(0)}%) — rug risk`); }
  else                                 { p = 0;                        risks.push('Dangerously low liquidity — easy rug'); }

  // LP locked = safety premium
  if (m.lpLocked === 1) {
    p = Math.min(maxLH, p + Math.round(maxLH * 0.20));
    reasons.push('LP locked');
  }

  // Mint authority — if still active, dev can print tokens (rug vector)
  if (m.mintAuthority === 1) {
    p = Math.max(0, p - 2);
    risks.push('Mint authority ACTIVE — dev can inflate supply');
  } else if (m.mintAuthority === 0) {
    reasons.push('Mint revoked');
  }

  // Freeze authority — dev can freeze your tokens
  if (m.freezeAuthority === 1) {
    p = Math.max(0, p - 1);
    risks.push('Freeze authority ACTIVE — tokens can be frozen');
  }

  parts.liquidityHealth = p;

  // ═══════════════════════════════════════════════════════════════════════════
  // LATE-PUMP PENALTY — final deduction (unchanged)
  // ═══════════════════════════════════════════════════════════════════════════
  const p1h  = m.priceChange1h;
  const p24h = m.priceChange24h;
  let latePumpPenalty = 0;
  if (p1h != null && p1h > 500)        { latePumpPenalty = 40; risks.push(`Already pumped +${p1h.toFixed(0)}% 1h — missed entry`); }
  else if (p1h != null && p1h > 300)   { latePumpPenalty = 25; risks.push(`Up +${p1h.toFixed(0)}% 1h — late entry risk`); }
  else if (p24h != null && p24h > 500) { latePumpPenalty = 20; risks.push(`Up +${p24h.toFixed(0)}% 24h — extended`); }
  parts.latePumpPenalty = -latePumpPenalty;

  // ── FINAL SCORE ───────────────────────────────────────────────────────────
  const foundationTotal = parts.volumeVelocity + parts.buyPressure +
                          parts.walletQuality + parts.holderDistribution +
                          parts.liquidityHealth;
  const total = foundationTotal - latePumpPenalty;

  return {
    score: clamp(total),
    parts,
    reasons,
    risks,
    model: 'discovery',
    foundationTotal,
    latePumpPenalty,
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

  // 9. Late-pump penalty
  const rp1h  = m.priceChange1h;
  const rp24h = m.priceChange24h;
  let runnerLatePenalty = 0;
  if (rp1h != null && rp1h > 500)       { runnerLatePenalty = 40; risks.push(`Already +${rp1h.toFixed(0)}% 1h — parabolic top risk`); }
  else if (rp1h != null && rp1h > 300)  { runnerLatePenalty = 25; risks.push(`Up +${rp1h.toFixed(0)}% 1h — extended runner`); }
  else if (rp24h != null && rp24h > 500) { runnerLatePenalty = 20; risks.push(`Up +${rp24h.toFixed(0)}% 24h — late continuation`); }
  parts.latePumpPenalty = -runnerLatePenalty;

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
  };
}
