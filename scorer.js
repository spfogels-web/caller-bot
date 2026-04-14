/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  scorer.js — Multi-dimensional scoring engine v5 (GEM QUALITY UPDATE)
 *
 *  v5 Changes from v4 (targeted upgrades only — backward compatible):
 *
 *  [WEIGHTS]    walletStructure → 0.35 (was 0.30) — now the primary dimension
 *               marketBehavior → 0.20 (was 0.25) — momentum no longer dominates
 *               launchQuality stays 0.30, socialNarrative stays 0.15
 *
 *  [STAGE]      LAUNCH bonus 15→8, EARLY 12→6 — freshness helps, not replaces
 *
 *  [THRESHOLD]  Max discount cap -18→-12 — prevents discount stacking
 *               UNVERIFIED: was -5 discount, now 0 — neutralized, not forgiven
 *               LAUNCH discount -12→-7, EARLY -9→-5, NEW_LAUNCH -7→-4
 *               Absolute floor raised 32→36
 *
 *  [UNVERIFIED] computeDecision() requires +8 margin above threshold for AUTO_POST
 *               Routes to WATCHLIST by default — safer for unknown structure
 *
 *  [SOCIAL]     Stage-aware damping: LAUNCH/EARLY missing social penalties halved
 *               Bonus for having socials unchanged — presence still rewarded
 *
 *  [TRAP]       applyTrapConfidencePenalty() — new pre-decision composite penalty
 *               MEDIUM=-5, HIGH=-12, CRITICAL=-20 (×0.7 for LAUNCH/EARLY)
 *               Suspicious tokens rank lower before the decision layer fires
 *
 *  [STEALTH]    detectStealthAccumulation() — new helper, max +15 bonus
 *               Rewards: constructive buys, quiet holder growth, healthy price
 *               action, clean wallet on young token, pre-social accumulation
 *               Does not override hard red flags
 *
 *  All exports, function names, return shapes preserved.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─── Sub-score Weights ────────────────────────────────────────────────────────
// v5: walletStructure is now the dominant signal.
// A clean wallet structure beats short-term momentum every time.
// marketBehavior reduced — fresh buys without structure should not carry a call.
// socialNarrative weight unchanged but stage-damped for early tokens.

const WEIGHTS = {
  launchQuality:    0.30,
  walletStructure:  0.35,   // UPGRADED from 0.30
  marketBehavior:   0.20,   // REDUCED from 0.25
  socialNarrative:  0.15,
};

// ─── Stage Definitions ────────────────────────────────────────────────────────

export function getStage(pairAgeHours) {
  if (pairAgeHours == null) return 'UNKNOWN';
  if (pairAgeHours < 0.083)  return 'LAUNCH';
  if (pairAgeHours < 0.333)  return 'EARLY';
  if (pairAgeHours < 1)      return 'DEVELOPING';
  if (pairAgeHours < 6)      return 'ESTABLISHED';
  return 'MATURE';
}

// ─── Stage Bonus/Penalty ──────────────────────────────────────────────────────
// v5: Freshness is a bonus, not a substitute for quality.
// LAUNCH: 15→8, EARLY: 12→6, DEVELOPING: 6→4

function getStageAdjustment(stage) {
  return {
    LAUNCH:      8,   // v5: was 15
    EARLY:       6,   // v5: was 12
    DEVELOPING:  4,   // v5: was 6
    ESTABLISHED: 0,
    MATURE:     -15,
    UNKNOWN:     -5,
  }[stage] ?? 0;
}

// ─── Enrichment Coverage Helper ───────────────────────────────────────────────

function getEnrichmentCoverage(candidate) {
  const fields = [
    candidate.mintAuthority, candidate.freezeAuthority, candidate.lpLocked,
    candidate.devWalletPct,  candidate.top10HolderPct,  candidate.bundleRisk,
    candidate.holders,       candidate.holderGrowth24h,
  ];
  const known = fields.filter(f => f !== null && f !== undefined).length;
  return known / fields.length;
}

// ─── Stealth Accumulation Detector ───────────────────────────────────────────
// v5 NEW: Identifies young tokens showing quiet, clean early accumulation.
// Rewards: constructive buy pressure, positive holder growth, healthy price
// action without parabolic extension, clean structure, pre-social accumulation.
// Max bonus: +15. Does not override hard red flags.
// FUTURE HOOK: Add smart-money wallet check here when enriched wallet data
// is available — if knownWinnerWallets.length >= 3, boost bonus further.

function detectStealthAccumulation(candidate, stage, structureGrade) {
  const ageHours    = candidate.pairAgeHours    ?? 99;
  const change1h    = candidate.priceChange1h   ?? 0;
  const change24h   = candidate.priceChange24h  ?? 0;
  const holderGrowth= candidate.holderGrowth24h ?? 0;
  const bundle      = candidate.bundleRisk      ?? 'UNKNOWN';
  const snipers     = candidate.sniperWalletCount ?? 0;
  const devPct      = candidate.devWalletPct    ?? null;
  const volVel      = candidate.volumeVelocity  ?? null;
  const buyRatio    = candidate.buySellRatio1h  ??
    (candidate.buys1h != null && candidate.sells1h != null
      ? candidate.buys1h / Math.max(1, candidate.buys1h + candidate.sells1h)
      : null);

  const signals = [];
  let bonus = 0;

  // Only relevant for early-stage tokens
  if (!['LAUNCH','EARLY','DEVELOPING'].includes(stage)) {
    return { isStealthy: false, bonus: 0, signals: [] };
  }

  // Need at least some data to confirm stealth
  const hasSomeData = devPct !== null || candidate.top10HolderPct !== null || bundle !== 'UNKNOWN';
  if (!hasSomeData && ageHours > 0.5) {
    return { isStealthy: false, bonus: 0, signals: [] };
  }

  // Disqualifiers — not stealthy if already extended, bundled, or dirty
  const notExtended = change1h < 120 && change24h < 400;
  const notBundled  = bundle !== 'HIGH' && bundle !== 'SEVERE';
  const notSniper   = snipers <= 10;
  const notDirty    = structureGrade !== 'DIRTY';
  const notDevHeavy = devPct === null || devPct < 12;

  if (!notExtended || !notBundled || !notSniper || !notDirty || !notDevHeavy) {
    return { isStealthy: false, bonus: 0, signals: [] };
  }

  // Positive signals — additive bonuses
  if (buyRatio !== null && buyRatio > 0.55 && buyRatio < 0.90) {
    bonus += 5;
    signals.push(`Stealth: constructive buy pressure (${(buyRatio * 100).toFixed(0)}%) — pre-breakout range`);
  }

  if (holderGrowth > 5 && holderGrowth < 200) {
    bonus += 4;
    signals.push(`Stealth: holder growth +${holderGrowth.toFixed(0)}% — quiet accumulation`);
  }

  if (change1h > 5 && change1h < 60) {
    bonus += 3;
    signals.push(`Stealth: healthy price action +${change1h.toFixed(0)}% 1h — not overextended`);
  }

  if ((structureGrade === 'ELITE' || structureGrade === 'CLEAN') && ageHours < 1) {
    bonus += 6;
    signals.push('Stealth: ELITE/CLEAN wallet structure under 1h — extremely rare for genuine launches');
  }

  if (volVel !== null && volVel > 0.15 && volVel < 2.0) {
    bonus += 3;
    signals.push(`Stealth: organic volume velocity (${volVel.toFixed(2)}) — no wash signature`);
  }

  // Pre-social accumulation — organic buyers before any marketing
  const hasSocials = !!(candidate.twitter || candidate.telegram || candidate.website);
  if (!hasSocials && ageHours < 0.5 && change1h > 10) {
    bonus += 4;
    signals.push('Stealth: accumulating before socials — organic pre-marketing entry');
  }

  // FUTURE HOOK: Smart money wallet enrichment
  // if (candidate.knownWinnerWallets?.length >= 3 && structureGrade !== 'DIRTY') {
  //   bonus += 6;
  //   signals.push(`Stealth: ${candidate.knownWinnerWallets.length} known winner wallets entering early`);
  // }

  const isStealthy = bonus >= 8; // need at least 2–3 signals to confirm

  return { isStealthy, bonus: Math.min(bonus, 15), signals };
}

// ─── 1. Launch Quality Score (0-100) ─────────────────────────────────────────

export function scoreLaunchQuality(candidate) {
  let score = 50;
  const signals   = [];
  const penalties = [];

  // v5: tightened 2h → 1h — tokens over 1h should have some verifiable data
  const isVeryNew = (candidate.pairAgeHours ?? 99) < 1;

  if (candidate.mintAuthority === 0) {
    score += 20; signals.push('Mint authority revoked');
  } else if (candidate.mintAuthority === 1) {
    score -= 25; penalties.push('Mint authority ACTIVE — dev can inflate supply');
  } else {
    if (!isVeryNew) { score -= 8; penalties.push('Mint authority unknown'); }
    else            { score -= 3; penalties.push('Mint status unverified (very new)'); }
  }

  if (candidate.freezeAuthority === 0) {
    score += 15; signals.push('Freeze authority revoked');
  } else if (candidate.freezeAuthority === 1) {
    score -= 20; penalties.push('Freeze authority ACTIVE');
  }

  if (candidate.lpLocked === 1) {
    score += 20; signals.push('LP locked/burned');
  } else if (candidate.lpLocked === 0) {
    score -= 20; penalties.push('LP NOT locked — rug pull risk');
  } else {
    if (!isVeryNew) { score -= 5; penalties.push('LP lock status unverified'); }
  }

  // v5: Age bonuses modestly reduced — freshness is a signal, not a substitute
  const ageHours = candidate.pairAgeHours ?? null;
  if (ageHours !== null) {
    if      (ageHours < 0.083) { score += 6;  signals.push('Very fresh — under 5 minutes'); }
    else if (ageHours < 0.5)   { score += 10; signals.push(`Fresh pair (${(ageHours * 60).toFixed(0)}min)`); }
    else if (ageHours < 2)     { score += 7;  signals.push(`Young pair (${ageHours.toFixed(1)}h)`); }
    else if (ageHours < 6)     { score += 3;  signals.push(`Established pair (${ageHours.toFixed(1)}h)`); }
    else if (ageHours > 24)    { score -= 15; penalties.push(`Old pair (${ageHours.toFixed(0)}h)`); }
    else if (ageHours > 6)     { score -= 8;  penalties.push(`Mature pair (${ageHours.toFixed(1)}h)`); }
  } else {
    score -= 5; penalties.push('Pair age unknown');
  }

  if (candidate.deployerHistoryRisk === 'CLEAN') {
    score += 10; signals.push('Deployer history clean');
  } else if (candidate.deployerHistoryRisk === 'FLAGGED') {
    score -= 20; penalties.push('Deployer history flagged');
  } else if (candidate.deployerHistoryRisk === 'SERIAL_RUGGER') {
    score -= 40; penalties.push('SERIAL RUGGER deployer');
  } else if (isVeryNew) {
    // First-time dev launches get a neutral-positive baseline instead of being
    // punished for the absence of history. 0 previous launches ≠ bad dev.
    score += 5;
    signals.push('First-time dev launch — no history to penalize');
  }

  const heliusLaunchQ = candidate.launchQualityScore;
  if (heliusLaunchQ != null && candidate.heliusOk) {
    score = Math.round(score * 0.5 + heliusLaunchQ * 0.5);
    signals.push(`Helius launch quality: ${heliusLaunchQ}/100`);
  } else if (!candidate.heliusOk && !isVeryNew) {
    score -= 5; penalties.push('Helius unavailable');
  }

  const ubr = candidate.launchUniqueBuyerRatio;
  const ageHrs = candidate.pairAgeHours ?? 99;
  if (ubr != null) {
    if      (ubr >= 0.75) { score += 12; signals.push(`Excellent buyer diversity: ${(ubr*100).toFixed(0)}% unique`); }
    else if (ubr >= 0.55) { score += 6;  signals.push(`Good buyer diversity: ${(ubr*100).toFixed(0)}% unique`); }
    else if (ubr < 0.35) {
      // Don't punish low unique-buyer ratio on a brand-new pair that hasn't
      // had time to diversify yet (< 15 minutes). Just note it.
      if (ageHrs < 0.25) {
        signals.push(`Early buyer sample — only ${(ubr*100).toFixed(0)}% unique so far (too new to judge)`);
      } else {
        score -= 15; penalties.push(`Low unique buyers: ${(ubr*100).toFixed(0)}%`);
      }
    }
  }

  return { score: clamp(score), signals, penalties };
}

// ─── 2. Wallet Structure Score (0-100) ───────────────────────────────────────
// v5: Now the highest-weighted component (0.35). Wallet quality is the primary
// differentiator between a real early gem and manufactured momentum.

export function scoreWalletStructure(candidate) {
  let score = 50;
  const signals   = [];
  const penalties = [];

  // v5: tightened 2h → 1h
  const isVeryNew = (candidate.pairAgeHours ?? 99) < 1;

  const devPct = candidate.devWalletPct ?? null;
  if (devPct !== null) {
    if      (devPct < 1)  { score += 20; signals.push(`Dev wallet ${devPct.toFixed(2)}% — extremely clean`); }
    else if (devPct < 3)  { score += 15; signals.push(`Dev wallet ${devPct.toFixed(1)}% — healthy`); }
    else if (devPct < 5)  { score += 8;  signals.push(`Dev wallet ${devPct.toFixed(1)}% — acceptable`); }
    else if (devPct < 10) { score -= 10; penalties.push(`Dev wallet ${devPct.toFixed(1)}% — elevated`); }
    else if (devPct < 20) { score -= 25; penalties.push(`Dev wallet ${devPct.toFixed(1)}% — dangerous`); }
    else                  { score -= 40; penalties.push(`Dev wallet ${devPct.toFixed(1)}% — extreme insider risk`); }
  } else {
    // v5: mild penalty even for very new tokens — unknown dev wallet is never neutral
    if (!isVeryNew) { score -= 5; penalties.push('Dev wallet % unknown'); }
    else            { score -= 2; penalties.push('Dev wallet % pending'); }
  }

  const top10 = candidate.top10HolderPct ?? null;
  if (top10 !== null) {
    if      (top10 < 15)  { score += 20; signals.push(`Top10 holders ${top10.toFixed(1)}% — excellent`); }
    else if (top10 < 25)  { score += 12; signals.push(`Top10 holders ${top10.toFixed(1)}% — healthy spread`); }
    else if (top10 < 35)  { score += 5;  signals.push(`Top10 holders ${top10.toFixed(1)}% — moderate`); }
    else if (top10 < 50)  { score -= 10; penalties.push(`Top10 holders ${top10.toFixed(1)}% — concentrated`); }
    else if (top10 < 65)  { score -= 25; penalties.push(`Top10 holders ${top10.toFixed(1)}% — high risk`); }
    else                  { score -= 40; penalties.push(`Top10 holders ${top10.toFixed(1)}% — extreme control`); }
  } else {
    if (!isVeryNew) { score -= 5; penalties.push('Top10 holder % unknown'); }
  }

  const bundle = candidate.bundleRisk ?? null;
  if (bundle && bundle !== 'PENDING') {
    if      (bundle === 'NONE')   { score += 15; signals.push('No bundle activity'); }
    else if (bundle === 'LOW')    { score += 5;  signals.push('Low bundle activity'); }
    else if (bundle === 'MEDIUM') { score -= 15; penalties.push('Medium bundle risk'); }
    else if (bundle === 'HIGH')   { score -= 30; penalties.push('High bundle risk'); }
    else if (bundle === 'SEVERE') { score -= 45; penalties.push('SEVERE bundle risk'); }
  } else if (bundle === 'PENDING') {
    signals.push('Bundle risk: indexing (too new)');
  } else {
    if (!isVeryNew) { score -= 3; penalties.push('Bundle risk unverified'); }
  }

  const snipers = candidate.sniperWalletCount ?? null;
  if (snipers !== null) {
    if      (snipers === 0)  { score += 10; signals.push('No sniper wallets'); }
    else if (snipers <= 3)   { score += 3;  signals.push(`${snipers} sniper(s) — minor`); }
    else if (snipers <= 10)  { score -= 10; penalties.push(`${snipers} sniper wallets`); }
    else if (snipers <= 25)  { score -= 20; penalties.push(`${snipers} sniper wallets — heavy`); }
    else                     { score -= 35; penalties.push(`${snipers} sniper wallets — extreme`); }
  }

  const bubble = candidate.bubbleMapRisk ?? null;
  if (bubble && bubble !== 'PENDING') {
    if      (bubble === 'CLEAN')     { score += 15; signals.push('BubbleMap clean'); }
    else if (bubble === 'MODERATE')  { score += 5;  signals.push('BubbleMap moderate'); }
    else if (bubble === 'CLUSTERED') { score -= 20; penalties.push('BubbleMap clustered'); }
    else if (bubble === 'SEVERE')    { score -= 40; penalties.push('BubbleMap SEVERE'); }
  } else if (bubble === 'PENDING') {
    signals.push('BubbleMap: indexing (too new)');
  }

  const insider = candidate.insiderWalletPct ?? null;
  if (insider !== null) {
    if      (insider < 5)  { score += 8;  signals.push(`Low insider %: ${insider.toFixed(1)}%`); }
    else if (insider < 15) { score -= 10; penalties.push(`Insider: ${insider.toFixed(1)}%`); }
    else if (insider < 30) { score -= 25; penalties.push(`High insider: ${insider.toFixed(1)}%`); }
    else                   { score -= 40; penalties.push(`Extreme insider: ${insider.toFixed(1)}%`); }
  }

  if (candidate.freshWalletInflows === true || candidate.freshWalletInflows === 1) {
    score += 8; signals.push('Fresh wallet inflows detected');
  }

  const structureGrade = getStructureGrade(devPct, top10, bundle, snipers, isVeryNew);
  return { score: clamp(score), signals, penalties, structureGrade };
}

function getStructureGrade(devPct, top10, bundle, snipers, isVeryNew = false) {
  const dev = devPct  ?? 999;
  const top = top10   ?? 999;
  const bnd = bundle  ?? 'UNKNOWN';
  const snp = snipers ?? 999;

  const hasAnyData = devPct !== null || top10 !== null || (bundle !== null && bundle !== 'PENDING');
  if (!hasAnyData && isVeryNew) return 'UNVERIFIED';
  if (!hasAnyData) return 'MIXED';

  if (dev < 2 && top < 20 && (bnd === 'NONE' || bnd === 'LOW') && snp <= 3)  return 'ELITE';
  if (dev < 5 && top < 35 && bnd !== 'HIGH' && bnd !== 'SEVERE' && snp <= 10) return 'CLEAN';
  if (dev < 10 && top < 50 && bnd !== 'SEVERE')                                return 'AVERAGE';
  if (bnd === 'SEVERE' || dev > 20 || top > 65)                                return 'DIRTY';
  return 'MIXED';
}

// ─── 3. Market Behavior Score (0-100) ────────────────────────────────────────
// v5: Weight reduced 0.25→0.20. Logic unchanged — momentum is still scored
// the same way, but contributes less to the composite.

export function scoreMarketBehavior(candidate) {
  let score = 50;
  const signals   = [];
  const penalties = [];

  const buys  = candidate.buys24h  ?? 0;
  const sells = candidate.sells24h ?? 0;
  const total = buys + sells;
  if (total > 0) {
    const buyRatio = buys / total;
    if      (buyRatio > 0.70) { score += 15; signals.push(`Strong buy pressure: ${(buyRatio*100).toFixed(0)}%`); }
    else if (buyRatio > 0.55) { score += 8;  signals.push(`Healthy buy pressure: ${(buyRatio*100).toFixed(0)}%`); }
    else if (buyRatio > 0.45) { /* neutral */ }
    else if (buyRatio > 0.35) { score -= 10; penalties.push(`Sell dominant: ${(buyRatio*100).toFixed(0)}% buys`); }
    else                      { score -= 20; penalties.push(`Heavy selling: ${(buyRatio*100).toFixed(0)}% buys`); }
  }

  const volQ = candidate.volumeQuality ?? null;
  if (volQ) {
    if      (volQ === 'ORGANIC') { score += 15; signals.push('Organic volume'); }
    else if (volQ === 'MIXED')   { score -= 5;  penalties.push('Mixed volume quality'); }
    else if (volQ === 'WASH')    { score -= 25; penalties.push('WASH trading detected'); }
  }

  const holders = candidate.holders ?? null;
  if (holders !== null) {
    if      (holders > 5000) { score += 15; signals.push(`${holders.toLocaleString()} holders`); }
    else if (holders > 2000) { score += 10; signals.push(`${holders.toLocaleString()} holders`); }
    else if (holders > 500)  { score += 5;  signals.push(`${holders.toLocaleString()} holders`); }
    else if (holders > 50)   { score += 2;  signals.push(`${holders.toLocaleString()} holders — growing`); }
  }

  const holderGrowth = candidate.holderGrowth24h ?? null;
  if (holderGrowth !== null) {
    if      (holderGrowth > 50)  { score += 15; signals.push(`Explosive holder growth: +${holderGrowth.toFixed(0)}%`); }
    else if (holderGrowth > 20)  { score += 10; signals.push(`Strong holder growth: +${holderGrowth.toFixed(0)}%`); }
    else if (holderGrowth > 5)   { score += 5;  signals.push(`Positive holder growth: +${holderGrowth.toFixed(0)}%`); }
    else if (holderGrowth < -10) { score -= 15; penalties.push(`Holder exodus: ${holderGrowth.toFixed(0)}%`); }
    else if (holderGrowth < 0)   { score -= 5;  penalties.push('Declining holders'); }
  }

  const liq = candidate.liquidity ?? null;
  if (liq !== null) {
    if      (liq > 500_000) { score += 15; signals.push(`Deep liquidity: ${(liq/1000).toFixed(0)}K`); }
    else if (liq > 100_000) { score += 10; signals.push(`Strong liquidity: ${(liq/1000).toFixed(0)}K`); }
    else if (liq > 50_000)  { score += 5;  signals.push(`Good liquidity: ${(liq/1000).toFixed(0)}K`); }
    else if (liq > 15_000)  { score += 2;  signals.push(`Adequate liquidity: ${(liq/1000).toFixed(0)}K`); }
    else if (liq > 5_000)   { score -= 5;  penalties.push(`Thin liquidity: ${(liq/1000).toFixed(1)}K`); }
    else if (liq > 3_000)   { score -= 8;  penalties.push(`Very thin liquidity: ${(liq/1000).toFixed(1)}K`); }
    else                    { score -= 15; penalties.push('Critical thin liquidity'); }
  }

  const change1h  = candidate.priceChange1h  ?? null;
  const change24h = candidate.priceChange24h ?? null;
  const change5m  = candidate.priceChange5m  ?? null;

  if (change5m !== null) {
    if      (change5m > 20 && change5m < 100) { score += 12; signals.push(`Strong 5m: +${change5m.toFixed(0)}%`); }
    else if (change5m > 8)                    { score += 6;  signals.push(`Positive 5m: +${change5m.toFixed(0)}%`); }
    else if (change5m > 2)                    { score += 2; }
    else if (change5m < -15)                  { score -= 10; penalties.push(`5m dump: ${change5m.toFixed(0)}%`); }
  }

  if (change1h !== null) {
    if      (change1h > 50 && change1h < 300) { score += 10; signals.push(`Strong 1h: +${change1h.toFixed(0)}%`); }
    else if (change1h > 10 && change1h <= 50) { score += 5;  signals.push(`Positive 1h: +${change1h.toFixed(0)}%`); }
    else if (change1h > 300)                  { score -= 8;  penalties.push(`Parabolic 1h (+${change1h.toFixed(0)}%)`); }
    else if (change1h < -20)                  { score -= 10; penalties.push(`1h dump: ${change1h.toFixed(0)}%`); }
  }

  if (change24h !== null) {
    if      (change24h > 1000) { score -= 30; penalties.push(`Massively extended 24h (+${change24h.toFixed(0)}%)`); }
    else if (change24h > 500)  { score -= 20; penalties.push(`Highly extended 24h (+${change24h.toFixed(0)}%)`); }
    else if (change24h > 200)  { score -= 10; penalties.push(`Extended 24h (+${change24h.toFixed(0)}%)`); }
  }

  if (candidate.chartExtended === true || candidate.chartExtended === 1) {
    score -= 15; penalties.push('Chart overextended');
  }

  const buyVel = candidate.buyVelocity ?? candidate.buySellRatio1h ?? null;
  if (buyVel !== null && buyVel > 0.65) {
    score += 8; signals.push('High buy velocity');
  }

  return { score: clamp(score), signals, penalties };
}

// ─── 4. Social/Narrative Score (0-100) ───────────────────────────────────────
// v5: Stage-aware damping. Missing socials on LAUNCH/EARLY tokens
// are penalized at roughly half the rate of older tokens.
// Social presence remains fully rewarded when present.

export function scoreSocialNarrative(candidate) {
  const ageHours    = candidate.pairAgeHours ?? 99;
  const stage       = getStage(ageHours);
  const isVeryNew   = ageHours < 1;                               // v5: 2h→1h
  const isEarlyStage= stage === 'LAUNCH' || stage === 'EARLY';    // v5: stage-aware damping

  let score = isVeryNew ? 50 : 40;
  const signals   = [];
  const penalties = [];

  const hasWebsite  = !!(candidate.website  ?? candidate.socials?.website);
  const hasTwitter  = !!(candidate.twitter  ?? candidate.socials?.twitter);
  const hasTelegram = !!(candidate.telegram ?? candidate.socials?.telegram);

  // Social presence: bonuses unchanged — having them is always good
  if (hasWebsite)  { score += 15; signals.push('Website present'); }
  else if (!isVeryNew) {
    const penalty = isEarlyStage ? -4 : -8; // v5: halved for early stage
    score += penalty;
    if (!isEarlyStage) penalties.push('No website');
  }

  if (hasTwitter)  { score += 20; signals.push('Twitter/X present'); }
  else if (!isVeryNew) {
    const penalty = isEarlyStage ? -5 : -12; // v5: halved for early stage
    score += penalty;
    if (!isEarlyStage) penalties.push('No Twitter/X');
  }

  if (hasTelegram) { score += 15; signals.push('Telegram present'); }
  else if (!isVeryNew) {
    const penalty = isEarlyStage ? -3 : -8; // v5: halved for early stage
    score += penalty;
    if (!isEarlyStage) penalties.push('No Telegram');
  }

  if (hasWebsite && hasTwitter && hasTelegram) { score += 10; signals.push('Full social presence'); }

  const tags = candidate.narrativeTags ?? [];
  const strongNarratives = ['AI', 'RWA', 'DEFI', 'GAMING'];
  const hotNarratives    = ['MEME', 'ANIMAL_MEME', 'ELON_META', 'POLITICAL'];
  const weakNarratives   = ['HYPE', 'BABY_META'];

  if (tags.some(t => strongNarratives.includes(t))) { score += 15; signals.push('Strong narrative'); }
  if (tags.some(t => hotNarratives.includes(t)))    { score += 10; signals.push('Hot narrative'); }
  if (tags.some(t => weakNarratives.includes(t)))   { score -= 5;  penalties.push('Weak narrative'); }
  if (tags.includes('PUMP_FUN'))                    { score -= 3;  penalties.push('Pump.fun origin'); }
  if (!tags.length && !isVeryNew) {
    const penalty = isEarlyStage ? -4 : -8; // v5: halved for early stage
    score += penalty;
    if (!isEarlyStage) penalties.push('No narrative identified');
  }

  const ticker = (candidate.token ?? '').toUpperCase();
  if (ticker.length <= 4 && ticker.length >= 2) { score += 8; signals.push(`Clean ticker: $${ticker}`); }
  else if (ticker.length > 8)                   { score -= 5; penalties.push('Long/complex ticker'); }

  // Scam patterns — always penalize regardless of stage
  const scammyPatterns = /official|real|legit|safe|not.*rug|anti.*rug|v2|clone|fork/i;
  const name = (candidate.tokenName ?? '').toLowerCase();
  if (scammyPatterns.test(name) || scammyPatterns.test(ticker)) {
    score -= 20; penalties.push('Scam-warning language in name/ticker');
  }

  return { score: clamp(score), signals, penalties };
}

// ─── Trap Detector ────────────────────────────────────────────────────────────
// v5: Logic mostly unchanged. Anonymous pump detection tightened: 3h→2h.
// Confidence penalty is applied separately via applyTrapConfidencePenalty().

export function detectTraps(candidate) {
  const traps = [];

  const change1h     = candidate.priceChange1h  ?? 0;
  const change24h    = candidate.priceChange24h ?? 0;
  const holderGrowth = candidate.holderGrowth24h ?? 0;
  const top10        = candidate.top10HolderPct ?? null;
  const vol24h       = candidate.volume24h ?? 0;
  const devPct       = candidate.devWalletPct ?? null;
  const snipers      = candidate.sniperWalletCount ?? 0;
  const bundle       = candidate.bundleRisk ?? null;
  const liq          = candidate.liquidity ?? 0;
  const buys         = candidate.buys24h ?? 0;
  const sells        = candidate.sells24h ?? 0;
  const totalTxns    = buys + sells;

  if (change1h > 100 && holderGrowth < 5) {
    traps.push(`+${change1h.toFixed(0)}% in 1h but only ${holderGrowth.toFixed(1)}% holder growth — manipulation suspected`);
  }

  if (top10 !== null && top10 > 60 && vol24h > 100_000) {
    traps.push(`Top10 holds ${top10.toFixed(1)}% with $${(vol24h/1000).toFixed(0)}K volume — artificial`);
  }

  if (devPct !== null && devPct > 8 && change1h > 30) {
    traps.push(`Dev holds ${devPct.toFixed(1)}% while up ${change1h.toFixed(0)}% — dump risk`);
  }

  if (candidate.volumeQuality === 'WASH') {
    traps.push('Volume flagged as WASH trading');
  }

  const hasTwitter  = !!(candidate.twitter  ?? candidate.socials?.twitter);
  const hasTelegram = !!(candidate.telegram ?? candidate.socials?.telegram);
  const ageHours    = candidate.pairAgeHours ?? 0;
  // v5: tightened from 3h → 2h — anonymous pumps are suspicious sooner
  if (!hasTwitter && !hasTelegram && ageHours > 2 && change1h > 50) {
    traps.push('No social presence but pumping hard — anonymous pump risk');
  }

  if ((bundle === 'HIGH' || bundle === 'SEVERE') && change1h > 50) {
    traps.push(`Bundle risk ${bundle} with +${change1h.toFixed(0)}% — coordinated pump/dump`);
  }

  if (totalTxns > 0) {
    const buyRatio = buys / totalTxns;
    if (buyRatio > 0.47 && buyRatio < 0.53 && vol24h > 200_000) {
      traps.push(`Suspicious 50/50 ratio (${(buyRatio*100).toFixed(0)}%) with high volume — wash`);
    }
  }

  if (snipers > 20 && change1h > 0) {
    traps.push(`${snipers} snipers in position — dump risk`);
  }

  if (change1h > 200 && liq < 30_000) {
    traps.push(`Parabolic +${change1h.toFixed(0)}% on thin $${(liq/1000).toFixed(1)}K liquidity`);
  }

  if (change24h > 500) {
    traps.push(`Already up ${change24h.toFixed(0)}% in 24h — NOT an early gem`);
  }

  const trapped  = traps.length > 0;
  const severity = traps.length === 0 ? 'NONE'
    : traps.length === 1 ? 'LOW'
    : traps.length === 2 ? 'MEDIUM'
    : traps.length <= 4  ? 'HIGH'
    : 'CRITICAL';

  return { trapped, traps, severity };
}

// ─── Trap Confidence Penalty ──────────────────────────────────────────────────
// v5 NEW: Applies pre-decision penalty to composite score based on trap severity.
// Suspicious tokens lose ranking power BEFORE the decision layer.
// LAUNCH/EARLY tokens get 30% reduction — noisy data in very early stages.

function applyTrapConfidencePenalty(composite, trapResult, stage) {
  const { severity } = trapResult;
  if (severity === 'NONE' || severity === 'LOW') return composite;

  const basePenalties = {
    MEDIUM:   5,
    HIGH:    12,
    CRITICAL: 20,
  };

  const penalty      = basePenalties[severity] ?? 0;
  const stageFactor  = (stage === 'LAUNCH' || stage === 'EARLY') ? 0.7 : 1.0;

  return Math.max(0, composite - Math.round(penalty * stageFactor));
}

// ─── Dynamic Threshold Engine ─────────────────────────────────────────────────
// v5: Significantly tightened discount stacking.
// UNVERIFIED: was -5 discount, now neutral (0) — unknown structure is not forgiven.
// Max discount cap: -18 → -12. Absolute floor: 32 → 36.

export function getDynamicThreshold(structureGrade, stage, candidate) {
  const base = Number(process.env.MIN_SCORE_TO_POST ?? 52);
  let adjustment = 0;
  const reasons = [];

  switch (structureGrade) {
    case 'ELITE':
      adjustment -= 10; reasons.push('Elite wallet structure'); break;
    case 'CLEAN':
      adjustment -= 5;  reasons.push('Clean wallet structure'); break;
    case 'AVERAGE':
      /* no adjustment */ break;
    case 'UNVERIFIED':
      // v5: UNVERIFIED gets NO threshold discount. Unknown structure is neutral.
      // Route protection is handled in computeDecision() instead.
      reasons.push('Unverified structure — no discount (routing protected)'); break;
    case 'MIXED':
      adjustment += 5;  reasons.push('Mixed signals'); break;
    case 'DIRTY':
      adjustment += 6;  reasons.push('Dirty structure'); break;
  }

  // v5: Stage discounts significantly reduced — freshness is not a free pass
  if (stage === 'LAUNCH') {
    adjustment -= 7;  // v5: was -12
    reasons.push('Launch stage (reduced discount v5)');
  } else if (stage === 'EARLY') {
    adjustment -= 5;  // v5: was -9
    reasons.push('Early stage (reduced discount v5)');
  } else if (stage === 'DEVELOPING') {
    adjustment -= 3;  // v5: was -4
    reasons.push('Developing stage: slight discount');
  } else if (stage === 'MATURE') {
    adjustment += 15;
    reasons.push('Mature stage: high bar required');
  }

  // v5: Low enrichment discount reduced — incomplete data is not a license to post
  const coverage  = getEnrichmentCoverage(candidate);
  const isVeryNew = (candidate.pairAgeHours ?? 99) < 1; // v5: 2h → 1h
  if (coverage < 0.3 && isVeryNew) {
    adjustment -= 5; // v5: was -10
    reasons.push('Low enrichment on new token (reduced discount v5)');
  }

  // v5: NEW_LAUNCH discount reduced
  if (candidate.candidateType === 'NEW_LAUNCH') {
    adjustment -= 4; // v5: was -7
    reasons.push('NEW_LAUNCH type: modest discount');
  }

  // Hard blocks — unchanged
  if (candidate.bubbleMapRisk === 'SEVERE')  return { threshold: 999, reason: 'BubbleMap SEVERE — hard block' };
  if (candidate.bundleRisk === 'SEVERE')     return { threshold: 999, reason: 'Bundle SEVERE — hard block' };
  if (candidate.mintAuthority === 1 && (candidate.devWalletPct ?? 0) > 10) {
    return { threshold: 999, reason: 'Mint active + high dev wallet — hard block' };
  }

  const setupType = candidate.setupType ?? candidate.claudeSetupType ?? '';
  if (setupType === 'EXTENDED_AVOID') {
    return { threshold: 999, reason: 'EXTENDED_AVOID setup — token already ran' };
  }

  // v5: Max discount cap tightened -18 → -12
  const maxDiscount     = -12;
  const cappedAdjustment = Math.max(adjustment, maxDiscount);

  // v5: Absolute floor raised 32 → 36
  const threshold = clamp(base + cappedAdjustment, 36, 90);
  return { threshold, reason: reasons.length ? reasons.join('; ') : 'Standard threshold' };
}

// ─── Composite Scorer ─────────────────────────────────────────────────────────
// v5: Integrates trap confidence penalty and stealth accumulation.

export function computeFullScore(candidate) {
  const stage = getStage(candidate.pairAgeHours);

  const launchResult = scoreLaunchQuality(candidate);
  const walletResult = scoreWalletStructure(candidate);
  const marketResult = scoreMarketBehavior(candidate);
  const socialResult = scoreSocialNarrative(candidate);

  let composite = Math.round(
    launchResult.score * WEIGHTS.launchQuality   +
    walletResult.score * WEIGHTS.walletStructure  +
    marketResult.score * WEIGHTS.marketBehavior   +
    socialResult.score * WEIGHTS.socialNarrative
  );

  const stageAdj = getStageAdjustment(stage);
  composite = clamp(composite + stageAdj);

  // v5: Detect traps first, apply confidence penalty before routing
  const trapResult = detectTraps(candidate);
  composite = applyTrapConfidencePenalty(composite, trapResult, stage);

  // v5: Detect stealth accumulation — bonus for quiet clean builds
  const stealthResult = detectStealthAccumulation(candidate, stage, walletResult.structureGrade);
  if (stealthResult.isStealthy && stealthResult.bonus > 0) {
    composite = clamp(composite + stealthResult.bonus);
  }

  const thresholdResult = getDynamicThreshold(walletResult.structureGrade, stage, candidate);

  const decision  = computeDecision(composite, thresholdResult.threshold, trapResult, walletResult.structureGrade, candidate);
  let risk = 'HIGH';
  try { risk = computeRisk(composite, walletResult, trapResult, candidate); } catch {}
  const setupType = inferSetupType(candidate, stage, walletResult.structureGrade, stealthResult);

  // Compute trap confidence penalty for reporting
  const trapPenalty = (() => {
    const sev = trapResult.severity;
    if (sev === 'NONE' || sev === 'LOW') return 0;
    const base = sev === 'CRITICAL' ? 20 : sev === 'HIGH' ? 12 : 5;
    const sf   = (stage === 'LAUNCH' || stage === 'EARLY') ? 0.7 : 1.0;
    return Math.round(base * sf);
  })();

  return {
    score:   composite,
    risk,
    decision,
    setupType,
    stage,
    subScores: {
      launchQuality:   launchResult.score,
      walletStructure: walletResult.score,
      marketBehavior:  marketResult.score,
      socialNarrative: socialResult.score,
    },
    signals: {
      launch:  launchResult.signals,
      wallet:  walletResult.signals,
      market:  marketResult.signals,
      social:  socialResult.signals,
      stealth: stealthResult.signals,
    },
    penalties: {
      launch: launchResult.penalties,
      wallet: walletResult.penalties,
      market: marketResult.penalties,
      social: socialResult.penalties,
    },
    structureGrade:  walletResult.structureGrade,
    trapDetector: {
      triggered:        trapResult.trapped,
      severity:         trapResult.severity,
      traps:            trapResult.traps,
      confidencePenalty: trapPenalty,
    },
    threshold:       thresholdResult.threshold,
    thresholdReason: thresholdResult.reason,
    stealthDetected: stealthResult.isStealthy,
    stealthBonus:    stealthResult.bonus,
    bullCase: [
      ...launchResult.signals,
      ...walletResult.signals,
      ...marketResult.signals,
      ...socialResult.signals,
      ...stealthResult.signals,
    ].slice(0, 6),
    redFlags: [
      ...launchResult.penalties,
      ...walletResult.penalties,
      ...marketResult.penalties,
      ...socialResult.penalties,
      ...trapResult.traps,
    ].slice(0, 8),
    stageAdjustment: stageAdj,
  };
}

// ─── Decision Engine ──────────────────────────────────────────────────────────
// v5: UNVERIFIED structure requires +8 margin above threshold for AUTO_POST.
// Fresh tokens with unknown data route to WATCHLIST by default.

function computeDecision(score, threshold, trapResult, structureGrade, candidate) {
  if (threshold >= 999) return 'IGNORE';
  if (candidate.deployerHistoryRisk === 'SERIAL_RUGGER') return 'BLOCKLIST';

  const setupType = candidate.setupType ?? candidate.claudeSetupType ?? '';
  if (setupType === 'EXTENDED_AVOID') return 'IGNORE';

  if (trapResult.severity === 'CRITICAL') return 'IGNORE';
  if (trapResult.severity === 'HIGH' && score < threshold + 10) return 'IGNORE';

  // v5: UNVERIFIED needs clear headroom above threshold to AUTO_POST
  // Unknown structure is not a red flag — but it's also not a green light.
  if (structureGrade === 'UNVERIFIED') {
    const requiredMargin = 8;
    if (score >= threshold + requiredMargin &&
        trapResult.severity !== 'HIGH' &&
        trapResult.severity !== 'CRITICAL') {
      return 'AUTO_POST';
    }
    // Default routing for UNVERIFIED
    if (score >= threshold - 10) return 'WATCHLIST';
    if (score >= threshold - 20) return 'HOLD_FOR_REVIEW';
    return 'IGNORE';
  }

  if (score >= threshold &&
      trapResult.severity !== 'HIGH' &&
      trapResult.severity !== 'CRITICAL') {
    return 'AUTO_POST';
  }

  if (score >= threshold - 10) {
    const ageHours = candidate.pairAgeHours ?? 99;
    if (ageHours < 0.5 && (candidate.holderGrowth24h ?? 0) > 5) return 'RETEST';
    return 'WATCHLIST';
  }

  if (score >= threshold - 20 && structureGrade !== 'DIRTY') return 'HOLD_FOR_REVIEW';
  return 'IGNORE';
}

// ─── Risk Calculator ──────────────────────────────────────────────────────────

function computeRisk(score, walletResult, trapResult, candidate) {
  const grade     = walletResult.structureGrade ?? 'AVERAGE';
  const traps     = trapResult.severity         ?? 'NONE';
  const ageHours  = candidate.pairAgeHours      ?? 99;
  const birdeyeOk = candidate.birdeyeOk         ?? false;

  if (traps === 'CRITICAL') return 'EXTREME';

  if (grade === 'DIRTY') {
    if (birdeyeOk || ageHours > 2) return 'EXTREME';
    return 'HIGH';
  }
  if (traps === 'HIGH' || grade === 'MIXED')                           return 'HIGH';
  if (grade === 'UNVERIFIED')                                          return 'MEDIUM';
  if (score >= 75 && (grade === 'ELITE' || grade === 'CLEAN'))        return 'LOW';
  if (score >= 60)                                                     return 'MEDIUM';
  if (score >= 40)                                                     return 'HIGH';
  return 'EXTREME';
}

// ─── Setup Type Classifier ────────────────────────────────────────────────────
// v5: stealthResult param added. CLEAN_STEALTH_LAUNCH now also triggered by
// stealth detection.
// FUTURE HOOK: smart-money wallet data can create SMART_MONEY_ACCUMULATION type.

function inferSetupType(candidate, stage, structureGrade, stealthResult = null) {
  const change1h  = candidate.priceChange1h  ?? 0;
  const change24h = candidate.priceChange24h ?? 0;
  const change6h  = candidate.priceChange6h  ?? 0;
  const holders   = candidate.holders        ?? 0;
  const bundle    = candidate.bundleRisk     ?? 'UNKNOWN';
  const ageHours  = candidate.pairAgeHours   ?? 99;

  if (ageHours > 2) {
    if (change24h > 500 || change1h > 400) return 'EXTENDED_AVOID';
    if (change24h > 200 && change1h < 20)  return 'EXTENDED_AVOID';
  } else {
    if (change24h > 1000 && ageHours > 1) return 'EXTENDED_AVOID';
  }

  if (stage === 'LAUNCH' || stage === 'EARLY') {
    if (structureGrade === 'ELITE' || structureGrade === 'CLEAN') return 'CLEAN_STEALTH_LAUNCH';
    if (stealthResult?.isStealthy && structureGrade !== 'DIRTY')  return 'CLEAN_STEALTH_LAUNCH';
    if (structureGrade === 'UNVERIFIED' && bundle !== 'HIGH' && bundle !== 'SEVERE') return 'ORGANIC_EARLY';
    if (bundle === 'NONE' && change1h < 50) return 'ORGANIC_EARLY';
    if (change1h > 100) return 'EARLY_MOMENTUM';
    return 'EARLY_LAUNCH';
  }

  // FUTURE HOOK: uncomment when smart-money wallet data is enriched
  // if ((candidate.knownWinnerWallets?.length ?? 0) >= 3 && structureGrade === 'CLEAN') {
  //   return 'SMART_MONEY_ACCUMULATION';
  // }

  if (change1h > 20 && change6h < 0 && holders > 500) return 'BREAKOUT_AFTER_SHAKEOUT';
  if (change24h > 100 && change1h < 10 && change6h < 5) return 'CONSOLIDATION_BREAKOUT';
  if (change1h < -20 && change24h > 50) return 'PULLBACK_OPPORTUNITY';
  if (structureGrade === 'ELITE' && holders > 1000) return 'STRONG_HOLDER_LOW_DEV';
  if (bundle === 'HIGH' || bundle === 'SEVERE') return 'BUNDLED_HIGH_RISK';
  if (holders > 3000 && change24h > 30) return 'WHALE_SUPPORTED_ROTATION';

  return 'STANDARD';
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function formatScoreForClaude(scoreResult) {
  const {
    score, risk, decision, setupType, stage,
    subScores, structureGrade,
    trapDetector, threshold, thresholdReason,
    bullCase, redFlags, stageAdjustment,
    stealthDetected, stealthBonus,
  } = scoreResult;

  const adj = stageAdjustment >= 0 ? '+' + stageAdjustment : String(stageAdjustment);

  return `
PRE-COMPUTED SCORE ANALYSIS (scorer.js v5 — GEM QUALITY):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Composite Score:    ${score}/100 (stage adj: ${adj})
Risk Level:         ${risk}
Decision:           ${decision}
Setup Type:         ${setupType}
Stage:              ${stage}
Structure Grade:    ${structureGrade}
Dynamic Threshold:  ${threshold}/100 (${thresholdReason})
Stealth:            ${stealthDetected ? 'DETECTED (+' + stealthBonus + ' bonus)' : 'not detected'}

Sub-Scores (v5 weights: Launch 30% · Wallet 35% · Market 20% · Social 15%):
  Launch Quality:    ${subScores.launchQuality}/100
  Wallet Structure:  ${subScores.walletStructure}/100  ← PRIMARY — most important
  Market Behavior:   ${subScores.marketBehavior}/100
  Social/Narrative:  ${subScores.socialNarrative}/100  ← secondary for early tokens

Trap Detector:
  Triggered: ${trapDetector.triggered ? 'YES — ' + trapDetector.severity + (trapDetector.confidencePenalty ? ' (confidence penalty: -' + trapDetector.confidencePenalty + ')' : '') : 'NO'}
${trapDetector.traps.length ? trapDetector.traps.map(t => '  ⚠️ ' + t).join('\n') : '  No traps detected'}

Top Positive Signals:
${bullCase.slice(0, 4).map(s => '  ✓ ' + s).join('\n') || '  None'}

Top Red Flags:
${redFlags.slice(0, 5).map(s => '  ✗ ' + s).join('\n') || '  None'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FOCUS: Hunt EARLY GEMS. Wallet quality > momentum. EXTENDED_AVOID = hard reject.
UNVERIFIED structure = data pending, requires +8 margin above threshold for AUTO_POST.
CLEAN_STEALTH_LAUNCH = highest confidence early setup.
`.trim();
}
