// ─────────────────────────────────────────────────────────────────────────────
// scorer-dual.js
//
// Dual scoring overlay for the Solana caller bot.
//
// Routes coins to one of two models based on age:
//
//   DISCOVERY  (0–60 min)  — softer, surfaces early gems for 10x potential
//   RUNNER     (60 min–4h) — stricter, confirms continuation for 3x–5x
//
// This module exposes pure helpers only. The legacy 4-dimension scorer in
// scorer.js stays in place to populate sub-scores / signals / penalties /
// structureGrade that the rest of the system (UI, Claude prompts, AI reviews)
// depends on. computeFullScore() calls runDualModel() at the end and uses
// the new model's normalized 0-100 as the canonical `score`, while also
// attaching the new fields (modelUsed / confidence / action / reasons /
// risks / ageMinutes / discoveryScore / runnerScore) to the return shape.
//
// Backwards-compatible: every existing field on scoreResult is preserved.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tunable weights ─────────────────────────────────────────────────────────
export const DISCOVERY_WEIGHTS = {
  buyVelocity:       20,
  uniqueBuyerGrowth: 15,
  liquidityHealth:   15,
  devRisk:           15,   // scored inverted (low risk = high points)
  holderConcentration: 10, // inverted + softened very-early
  sellPressure:      10,   // inverted
  walletBehavior:    10,   // inverted (clustering / coordination penalty)
  momentumAccel:      5,
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

// ── Threshold bands (per model) ─────────────────────────────────────────────
export const DISCOVERY_THRESHOLDS = { alert: 75, watchlist: 65, monitor: 55 };
export const RUNNER_THRESHOLDS    = { alert: 80, watchlist: 70, monitor: 60 };

// ── Utility ─────────────────────────────────────────────────────────────────
function clamp(v, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, v)); }
function pct(n, d) { return d > 0 ? n / d : 0; }
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

/**
 * Decide which model to use. Always returns a string — never throws.
 *   <= 60 min  → 'discovery'
 *   > 60 min   → 'runner'
 *   null (missing age) → 'discovery' (with reduced confidence elsewhere)
 */
export function selectScoringModel(ageMinutes) {
  if (ageMinutes == null)          return 'discovery'; // safe default
  if (ageMinutes <= 60)            return 'discovery';
  return 'runner';
}

// ── Public: shared behavior metrics ─────────────────────────────────────────
// Collects the raw numbers each model needs, gracefully degrading on missing
// data. Returns normalized 0-1 where appropriate.
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
// DISCOVERY MODEL (0–60 min) — softer, permissive, optimized for recall
// ─────────────────────────────────────────────────────────────────────────────

export function scoreDiscoveryCoin(candidate, metricsIn = null) {
  const m = metricsIn || calculateBehaviorMetrics(candidate);
  const reasons = [];
  const risks = [];
  const parts = {};

  // 1. Buy Velocity (20)
  const bv = m.buyVelocity ?? m.volumeVelocity;
  let p = 0;
  if (bv == null)              { p = 6; risks.push('Buy velocity unknown (very early)'); }
  else if (bv >= 0.5)          { p = 20; reasons.push(`Strong buy velocity (${bv.toFixed(2)})`); }
  else if (bv >= 0.3)          { p = 15; reasons.push(`Healthy buy velocity (${bv.toFixed(2)})`); }
  else if (bv >= 0.15)         { p = 10; reasons.push(`Modest buy velocity (${bv.toFixed(2)})`); }
  else if (bv >= 0.05)         { p = 5; }
  else                         { p = 0; risks.push('Very weak buy activity'); }
  parts.buyVelocity = p;

  // 2. Unique Buyer Growth (15)
  p = 0;
  const ubr = m.launchUbr;
  const veryEarly = (m.ageMinutes ?? 0) < 15;
  if (ubr == null) { p = 5; }
  else if (ubr >= 0.75) { p = 15; reasons.push(`Excellent buyer diversity (${(ubr*100).toFixed(0)}%)`); }
  else if (ubr >= 0.55) { p = 11; reasons.push(`Good buyer diversity (${(ubr*100).toFixed(0)}%)`); }
  else if (ubr >= 0.40) { p = 7; }
  else if (veryEarly)   { p = 5; } // softened — too early to judge
  else                  { p = 0; risks.push(`Low unique buyer ratio (${(ubr*100).toFixed(0)}%)`); }
  parts.uniqueBuyerGrowth = p;

  // 3. Liquidity Health (15)
  p = 0;
  const lr = m.liqMcapRatio;
  if (lr == null) { p = 5; }
  else if (lr >= 0.15) { p = 15; reasons.push(`Strong liquidity ratio (${(lr*100).toFixed(0)}%)`); }
  else if (lr >= 0.10) { p = 11; reasons.push(`Healthy liq:mcap (${(lr*100).toFixed(0)}%)`); }
  else if (lr >= 0.05) { p = 7; }
  else if (lr >= 0.02) { p = 3; risks.push(`Thin liquidity (${(lr*100).toFixed(0)}%)`); }
  else                 { p = 0; risks.push('Extremely poor liquidity — rug risk'); }
  parts.liquidityHealth = p;

  // 4. Dev Risk (15, inverted: low risk = high points)
  p = 0;
  const dev = m.devWalletPct;
  const mintRevoked = m.mintAuthority === 0;
  if (dev == null) {
    p = veryEarly ? 10 : 6;
  } else if (dev < 3 && mintRevoked)  { p = 15; reasons.push(`Clean dev: ${dev.toFixed(1)}%, mint revoked`); }
  else if (dev < 5 && mintRevoked)    { p = 12; reasons.push(`Low dev allocation ${dev.toFixed(1)}%`); }
  else if (dev < 10)                  { p = 8; }
  else if (dev < 15)                  { p = 3;  risks.push(`Dev holds ${dev.toFixed(1)}% — concerning`); }
  else                                { p = 0;  risks.push(`Dev wallet ${dev.toFixed(1)}% — HIGH RISK`); }
  if (m.lpLocked === 1 && p > 0) p = Math.min(15, p + 2);
  if (m.deployerHistoryRisk === 'SERIAL_RUGGER') { p = 0; risks.push('Serial rugger deployer'); }
  parts.devRisk = p;

  // 5. Holder Concentration (10, inverted, softened very-early)
  p = 0;
  const top10 = m.top10HolderPct;
  if (top10 == null) { p = veryEarly ? 6 : 4; }
  else if (top10 < 30) { p = 10; reasons.push(`Spread holders (top10 ${top10.toFixed(0)}%)`); }
  else if (top10 < 50) { p = 7; }
  else if (top10 < 65) { p = 4; }
  else if (top10 < 80) { p = 1; risks.push(`Concentrated holders (top10 ${top10.toFixed(0)}%)`); }
  else                 { p = 0; risks.push(`Whale dominated (top10 ${top10.toFixed(0)}%)`); }
  if (veryEarly && p < 3) p = 3; // softener floor
  parts.holderConcentration = p;

  // 6. Sell Pressure (10, inverted)
  p = 0;
  const br = m.buySellRatio1h;
  if (br == null) { p = 5; }
  else if (br >= 0.70) { p = 10; reasons.push(`Buys dominate (${(br*100).toFixed(0)}%)`); }
  else if (br >= 0.55) { p = 7; }
  else if (br >= 0.45) { p = 4; }
  else if (br < 0.35)  { p = 0; risks.push(`Heavy early selling (${(br*100).toFixed(0)}% buys)`); }
  else                 { p = 2; }
  parts.sellPressure = p;

  // 7. Wallet Behavior (10, inverted)
  p = 0;
  const clusters = m.clusterWalletCount ?? 0;
  const coord    = m.coordinationIntensity ?? 0;
  if (clusters === 0 && coord < 0.25) { p = 10; reasons.push('Clean wallet behavior — no coordination'); }
  else if (clusters <= 2)             { p = 6; }
  else if (clusters <= 5)             { p = 3; risks.push(`${clusters} cluster wallets detected`); }
  else                                { p = 0; risks.push(`Heavy coordination: ${clusters} cluster wallets`); }
  if (m.knownWinnerCount >= 1) {
    const bonus = Math.min(3, m.knownWinnerCount);
    p = Math.min(10, p + bonus);
    reasons.push(`${m.knownWinnerCount} known winner wallet(s) early`);
  }
  if (m.bundleRisk === 'SEVERE' || m.bundleRisk === 'HIGH') { p = 0; risks.push(`Bundle risk ${m.bundleRisk}`); }
  parts.walletBehavior = p;

  // 8. Momentum Acceleration (5)
  p = 0;
  const accel = (m.priceChange5m != null && m.priceChange1h != null)
    ? (m.priceChange5m > (m.priceChange1h / 12) * 1.5) // 5m run-rate exceeds 1h avg
    : null;
  if (m.volumeVelocity != null && m.volumeVelocity >= 0.4)      { p = 5; reasons.push(`Accelerating volume (${m.volumeVelocity.toFixed(2)})`); }
  else if (accel === true)                                       { p = 5; reasons.push('Accelerating price (5m > 1h trend)'); }
  else if (m.volumeVelocity != null && m.volumeVelocity >= 0.2) { p = 3; }
  else                                                           { p = 0; }
  parts.momentumAccel = p;

  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { score: clamp(total), parts, reasons, risks, model: 'discovery' };
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
    if (p1 > 10 && v24 >= 50_000)  { p = 15; reasons.push(`Breakout: +${p1.toFixed(0)}% 1h on ${Math.round(v24/1000)}K vol`); }
    else if (p1 > 5 && v24 >= 20_000) { p = 10; reasons.push(`Strength: +${p1.toFixed(0)}% 1h`); }
    else if (p1 > 0) { p = 5; }
    else             { p = 0; risks.push(`No 1h momentum (${p1.toFixed(0)}%)`); }
  }
  parts.breakoutSetup = p;

  // 4. Volume Consistency (15) — prefer distributed volume over spikes
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

  // 7. Seller Absorption (10) — buyers still dominate DESPITE sell activity
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

  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { score: clamp(total), parts, reasons, risks, model: 'runner' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Action mapping per model
// ─────────────────────────────────────────────────────────────────────────────
export function mapScoreToAction(score, model) {
  const t = model === 'runner' ? RUNNER_THRESHOLDS : DISCOVERY_THRESHOLDS;
  if (score >= t.alert)      return 'alert';
  if (score >= t.watchlist)  return 'watchlist';
  if (score >= t.monitor)    return 'monitor';
  return 'ignore';
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence level — based on data completeness + signal alignment
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
// Main entry: runs the dual model and returns the overlay shape
// ─────────────────────────────────────────────────────────────────────────────
export function runDualModel(candidate) {
  const metrics    = calculateBehaviorMetrics(candidate);
  const ageMinutes = metrics.ageMinutes;
  const modelUsed  = selectScoringModel(ageMinutes);

  // Always compute BOTH so UI/analysis can see them, but the `finalScore`
  // uses only the routed model
  const discovery = scoreDiscoveryCoin(candidate, metrics);
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
  };
}
