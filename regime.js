/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  regime.js — Market regime awareness
 *
 *  Detects the current Solana market environment and adjusts scoring weights:
 *    - HOT:     meme/narrative rotation active, velocity rewarded more
 *    - NEUTRAL: balanced scoring, standard weights
 *    - COLD:    risk-off, structural quality required, velocity penalized
 *    - DEAD:    near zero launches passing, threshold raised significantly
 *
 *  Also tracks:
 *    - Time of day performance windows
 *    - Whether recent launches are holding or nuking
 *    - Narrative rotation strength
 *    - Best performing setup types in recent history
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import { logEvent } from './db.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const REGIME_UPDATE_INTERVAL = 15 * 60 * 1000; // Update regime every 15 minutes
const DEXSCREENER_API        = 'https://api.dexscreener.com/latest/dex';
const FETCH_TIMEOUT          = 10_000;

// ─── Regime State ─────────────────────────────────────────────────────────────

let currentRegime = {
  market:         'NEUTRAL',   // HOT | NEUTRAL | COLD | DEAD
  solanaActivity: 'NORMAL',    // HIGH | NORMAL | LOW
  timeWindow:     'STANDARD',  // PRIME | STANDARD | OFF_PEAK | DEAD_HOURS
  narrativeTrend: 'MIXED',     // STRONG | MIXED | WEAK | ROTATING
  recentLaunchHealth: 'MIXED', // STRONG | MIXED | WEAK
  lastUpdated:    0,
  confidence:     'LOW',
  signals:        [],
  scoreAdjustments: {
    velocityBonus:      0,
    structurePenalty:   0,
    narrativeBonus:     0,
    thresholdAdjust:    0,
  },
};

// ─── Safe Fetch ───────────────────────────────────────────────────────────────

async function safeFetch(url, label = 'regime') {
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`[regime:${label}] ${err.message}`);
    return null;
  }
}

// ─── Time Window Detector ─────────────────────────────────────────────────────

/**
 * Determine the current trading time window.
 * Based on UTC hours — Solana meme market patterns.
 *
 * @returns {{ window: string, description: string }}
 */
function detectTimeWindow() {
  const hourUTC = new Date().getUTCHours();

  // Prime time: 13:00-00:00 UTC (US market hours + evening)
  if (hourUTC >= 13 && hourUTC <= 23) {
    return { window: 'PRIME', description: 'US market hours — peak meme activity' };
  }
  // Early US: 12:00-13:00 UTC
  if (hourUTC === 12) {
    return { window: 'OPENING', description: 'US market opening — increasing activity' };
  }
  // Asian session: 00:00-08:00 UTC
  if (hourUTC >= 0 && hourUTC <= 7) {
    return { window: 'ASIAN', description: 'Asian session — moderate activity' };
  }
  // Dead hours: 08:00-12:00 UTC
  return { window: 'OFF_PEAK', description: 'European morning — lower meme activity' };
}

// ─── Solana Activity Detector ─────────────────────────────────────────────────

/**
 * Sample recent Solana pairs from DEX Screener to gauge market activity.
 * Looks at how many new pairs launched recently and their health.
 *
 * @returns {Promise<object>}
 */
async function detectSolanaActivity() {
  const result = {
    newPairsCount:     0,
    avgLiquidity:      0,
    avgVolume:         0,
    healthyPairsPct:   0,
    activityLevel:     'NORMAL',
    signals:           [],
  };

  try {
    // Fetch recent boosted/trending tokens
    const data = await safeFetch(
      'https://api.dexscreener.com/token-boosts/top/v1',
      'activity'
    );

    if (!data) return result;

    const items = Array.isArray(data) ? data : (data?.data ?? []);
    const solanaPairs = items.filter(item => item?.chainId === 'solana');

    result.newPairsCount = solanaPairs.length;

    if (solanaPairs.length === 0) {
      result.activityLevel = 'LOW';
      result.signals.push('No trending Solana pairs detected — market may be quiet');
      return result;
    }

    // Fetch pair data for a sample
    const sampleAddresses = solanaPairs
      .slice(0, 10)
      .map(p => p.tokenAddress)
      .filter(Boolean)
      .join(',');

    if (!sampleAddresses) return result;

    const pairData = await safeFetch(
      `${DEXSCREENER_API}/tokens/${sampleAddresses}`,
      'pairs'
    );

    const pairs = (pairData?.pairs ?? []).filter(p => p.chainId === 'solana');

    if (pairs.length === 0) return result;

    // Calculate health metrics
    const liquidities = pairs.map(p => p.liquidity?.usd ?? 0).filter(l => l > 0);
    const volumes     = pairs.map(p => p.volume?.h24 ?? 0).filter(v => v > 0);

    result.avgLiquidity = liquidities.length
      ? liquidities.reduce((a, b) => a + b, 0) / liquidities.length
      : 0;

    result.avgVolume = volumes.length
      ? volumes.reduce((a, b) => a + b, 0) / volumes.length
      : 0;

    // Health = pairs with positive 1h price change
    const healthyPairs = pairs.filter(p => (p.priceChange?.h1 ?? 0) > 0);
    result.healthyPairsPct = (healthyPairs.length / pairs.length) * 100;

    // Determine activity level
    if (result.avgVolume > 500_000 && result.healthyPairsPct > 60) {
      result.activityLevel = 'HIGH';
      result.signals.push(`High market activity — avg vol $${(result.avgVolume/1000).toFixed(0)}K, ${result.healthyPairsPct.toFixed(0)}% pairs healthy`);
    } else if (result.avgVolume > 100_000 && result.healthyPairsPct > 40) {
      result.activityLevel = 'NORMAL';
      result.signals.push(`Normal market activity — avg vol $${(result.avgVolume/1000).toFixed(0)}K`);
    } else if (result.healthyPairsPct < 25) {
      result.activityLevel = 'LOW';
      result.signals.push(`Weak market — only ${result.healthyPairsPct.toFixed(0)}% of trending pairs holding`);
    } else {
      result.activityLevel = 'NORMAL';
    }

  } catch (err) {
    console.warn(`[regime] Activity detection error: ${err.message}`);
  }

  return result;
}

// ─── Narrative Trend Detector ─────────────────────────────────────────────────

/**
 * Detect which narratives are running hot right now.
 * Looks at trending token names/symbols for category patterns.
 *
 * @param {object[]} recentCandidates — recent candidates from db
 * @returns {object} narrativeAnalysis
 */
export function detectNarrativeTrend(recentCandidates = []) {
  if (!recentCandidates.length) {
    return {
      dominant:    null,
      trending:    [],
      strength:    'WEAK',
      signals:     [],
    };
  }

  // Count narrative tags across recent candidates
  const tagCounts = {};
  for (const candidate of recentCandidates) {
    let tags = [];
    try {
      if (candidate.claude_raw) {
        const parsed = JSON.parse(candidate.claude_raw);
        tags = parsed.narrative_tags ?? [];
      }
    } catch {}

    for (const tag of tags) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
  }

  // Sort by frequency
  const sorted = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (!sorted.length) {
    return { dominant: null, trending: [], strength: 'WEAK', signals: [] };
  }

  const dominant   = sorted[0][0];
  const trending   = sorted.map(([tag, count]) => ({ tag, count }));
  const total      = recentCandidates.length;
  const dominantPct = (sorted[0][1] / total) * 100;

  const strength =
    dominantPct > 50 ? 'STRONG'   :
    dominantPct > 30 ? 'MIXED'    :
    dominantPct > 15 ? 'ROTATING' :
    'WEAK';

  const signals = [];
  if (strength === 'STRONG') {
    signals.push(`Strong ${dominant} narrative — ${dominantPct.toFixed(0)}% of recent tokens`);
  }
  if (trending.length >= 3) {
    signals.push(`Multiple narratives active: ${trending.slice(0,3).map(t => t.tag).join(', ')}`);
  }

  return { dominant, trending, strength, signals };
}

// ─── Regime Classifier ────────────────────────────────────────────────────────

/**
 * Classify the overall market regime from all signals.
 *
 * @param {object} activity   — from detectSolanaActivity()
 * @param {object} timeWindow — from detectTimeWindow()
 * @param {object} narrative  — from detectNarrativeTrend()
 * @returns {{ regime: string, confidence: string, signals: string[] }}
 */
function classifyRegime(activity, timeWindow, narrative) {
  const signals = [
    ...activity.signals,
    timeWindow.description,
    ...narrative.signals,
  ];

  let hotScore  = 0;
  let coldScore = 0;

  // Activity signals
  if (activity.activityLevel === 'HIGH')   hotScore  += 3;
  if (activity.activityLevel === 'NORMAL') hotScore  += 1;
  if (activity.activityLevel === 'LOW')    coldScore += 3;

  // Health signals
  if (activity.healthyPairsPct > 60) hotScore  += 2;
  if (activity.healthyPairsPct < 30) coldScore += 3;

  // Time window signals
  if (timeWindow.window === 'PRIME')    hotScore  += 2;
  if (timeWindow.window === 'OPENING')  hotScore  += 1;
  if (timeWindow.window === 'ASIAN')    hotScore  += 0;
  if (timeWindow.window === 'OFF_PEAK') coldScore += 1;

  // Narrative signals
  if (narrative.strength === 'STRONG')   hotScore  += 2;
  if (narrative.strength === 'MIXED')    hotScore  += 1;
  if (narrative.strength === 'WEAK')     coldScore += 1;

  const regime =
    hotScore >= 6  ? 'HOT'     :
    hotScore >= 3  ? 'NEUTRAL' :
    coldScore >= 5 ? 'DEAD'    :
    coldScore >= 3 ? 'COLD'    :
    'NEUTRAL';

  const confidence =
    Math.abs(hotScore - coldScore) >= 4 ? 'HIGH'   :
    Math.abs(hotScore - coldScore) >= 2 ? 'MEDIUM' :
    'LOW';

  return { regime, confidence, signals };
}

// ─── Score Adjustments ────────────────────────────────────────────────────────

/**
 * Calculate scoring adjustments based on current regime.
 *
 * @param {string} regime
 * @param {string} timeWindow
 * @returns {object} adjustments
 */
function calculateAdjustments(regime, timeWindow) {
  const adjustments = {
    velocityBonus:    0,   // bonus for tokens with strong momentum
    structurePenalty: 0,   // extra penalty for poor structure
    narrativeBonus:   0,   // bonus for narrative-fitting tokens
    thresholdAdjust:  0,   // overall threshold adjustment
  };

  switch (regime) {
    case 'HOT':
      // Hot market: reward velocity, loosen threshold slightly
      adjustments.velocityBonus   = 8;
      adjustments.narrativeBonus  = 5;
      adjustments.thresholdAdjust = -5;
      break;

    case 'NEUTRAL':
      // Neutral: no adjustments
      break;

    case 'COLD':
      // Cold market: punish bundle/structure more, tighten threshold
      adjustments.structurePenalty = 8;
      adjustments.thresholdAdjust  = 8;
      break;

    case 'DEAD':
      // Dead market: slight caution — memecoin pumps still happen in dead broader markets.
      // Softened from +15/+15 (which was killing every call) to +5/+5.
      adjustments.structurePenalty = 5;
      adjustments.thresholdAdjust  = 5;
      break;
  }

  // Time window adjustments
  if (timeWindow === 'OFF_PEAK') {
    adjustments.thresholdAdjust += 3; // slightly harder during off-peak
  }
  if (timeWindow === 'PRIME') {
    adjustments.thresholdAdjust -= 2; // slightly easier during prime
  }

  return adjustments;
}

// ─── Main Regime Update ───────────────────────────────────────────────────────

/**
 * Update the current market regime.
 * Called every REGIME_UPDATE_INTERVAL milliseconds from server.js.
 *
 * @param {object[]} recentCandidates — recent db candidates for narrative detection
 */
export async function updateRegime(recentCandidates = []) {
  console.log('[regime] Updating market regime…');

  try {
    const [activity, timeWindowData, narrative] = await Promise.all([
      detectSolanaActivity(),
      Promise.resolve(detectTimeWindow()),
      Promise.resolve(detectNarrativeTrend(recentCandidates)),
    ]);

    const { regime, confidence, signals } = classifyRegime(
      activity,
      timeWindowData,
      narrative
    );

    const adjustments = calculateAdjustments(regime, timeWindowData.window);

    currentRegime = {
      market:          regime,
      solanaActivity:  activity.activityLevel,
      timeWindow:      timeWindowData.window,
      narrativeTrend:  narrative.strength,
      dominantNarrative: narrative.dominant,
      trendingNarratives: narrative.trending,
      recentLaunchHealth: activity.healthyPairsPct > 50 ? 'STRONG'
        : activity.healthyPairsPct > 25 ? 'MIXED' : 'WEAK',
      lastUpdated:     Date.now(),
      confidence,
      signals,
      scoreAdjustments: adjustments,
      rawData: {
        avgLiquidity:    activity.avgLiquidity,
        avgVolume:       activity.avgVolume,
        healthyPairsPct: activity.healthyPairsPct,
        newPairsCount:   activity.newPairsCount,
      },
    };

    console.log(
      `[regime] Market: ${regime} (${confidence} confidence) | ` +
      `Activity: ${activity.activityLevel} | ` +
      `Time: ${timeWindowData.window} | ` +
      `Narrative: ${narrative.strength} (${narrative.dominant ?? 'none'})`
    );

    logEvent('INFO', 'REGIME_UPDATE', JSON.stringify({
      market:    regime,
      activity:  activity.activityLevel,
      timeWindow: timeWindowData.window,
      narrative: narrative.strength,
      threshold: adjustments.thresholdAdjust,
      confidence,
    }));

  } catch (err) {
    console.error('[regime] Update error:', err.message);
    logEvent('ERROR', 'REGIME_UPDATE_ERROR', err.message);
  }
}

// ─── Regime Exports ───────────────────────────────────────────────────────────

/**
 * Get current regime (read-only snapshot).
 * @returns {object}
 */
export function getRegime() {
  return { ...currentRegime };
}

/**
 * Check if regime needs updating.
 * @returns {boolean}
 */
export function isRegimeStale() {
  return Date.now() - currentRegime.lastUpdated > REGIME_UPDATE_INTERVAL;
}

/**
 * Apply regime adjustments to a final composite score.
 * Called by server.js after computeFullScore().
 *
 * @param {number} baseScore
 * @param {object} candidate
 * @param {object} scoreResult — from computeFullScore()
 * @returns {{ adjustedScore: number, thresholdAdjust: number, regimeNotes: string[] }}
 */
export function applyRegimeAdjustments(baseScore, candidate, scoreResult) {
  const adj   = currentRegime.scoreAdjustments;
  const notes = [];
  let delta   = 0;

  // Velocity bonus — reward strong momentum in hot markets
  if (adj.velocityBonus > 0) {
    const marketGrade = scoreResult.subScores?.marketBehavior ?? 50;
    if (marketGrade >= 65) {
      delta += adj.velocityBonus;
      notes.push(`+${adj.velocityBonus} velocity bonus (${currentRegime.market} market)`);
    }
  }

  // Structure penalty — punish weak structure in cold markets
  if (adj.structurePenalty > 0) {
    const structureGrade = scoreResult.structureGrade ?? 'AVERAGE';
    if (structureGrade === 'DIRTY' || structureGrade === 'MIXED') {
      delta -= adj.structurePenalty;
      notes.push(`-${adj.structurePenalty} structure penalty (${currentRegime.market} market)`);
    }
  }

  // Narrative bonus — reward narrative fit in hot markets
  if (adj.narrativeBonus > 0 && currentRegime.dominantNarrative) {
    const tags = candidate.narrativeTags ?? [];
    if (tags.includes(currentRegime.dominantNarrative)) {
      delta += adj.narrativeBonus;
      notes.push(`+${adj.narrativeBonus} narrative bonus (${currentRegime.dominantNarrative} running)`);
    }
  }

  return {
    adjustedScore:   Math.max(0, Math.min(100, Math.round(baseScore + delta))),
    thresholdAdjust: adj.thresholdAdjust,
    regimeNotes:     notes,
    regime:          currentRegime.market,
  };
}

/**
 * Get regime summary for Claude prompt injection.
 * @returns {string}
 */
export function getRegimeSummaryForClaude() {
  const r = currentRegime;
  if (!r.lastUpdated) return 'Market regime: UNKNOWN (not yet calculated)';

  return `
MARKET REGIME CONTEXT:
  Overall:     ${r.market} (${r.confidence} confidence)
  Activity:    ${r.solanaActivity}
  Time Window: ${r.timeWindow}
  Narratives:  ${r.narrativeTrend} (dominant: ${r.dominantNarrative ?? 'none'})
  Launch Health: ${r.recentLaunchHealth}
  Score Adj:   velocity ${r.scoreAdjustments.velocityBonus >= 0 ? '+' : ''}${r.scoreAdjustments.velocityBonus} | threshold ${r.scoreAdjustments.thresholdAdjust >= 0 ? '+' : ''}${r.scoreAdjustments.thresholdAdjust}
`.trim();
}

/**
 * Get regime data for dashboard API.
 * @returns {object}
 */
export function getRegimeDashboardData() {
  const r = currentRegime;
  return {
    market:             r.market,
    solanaActivity:     r.solanaActivity,
    timeWindow:         r.timeWindow,
    narrativeTrend:     r.narrativeTrend,
    dominantNarrative:  r.dominantNarrative,
    trendingNarratives: r.trendingNarratives,
    recentLaunchHealth: r.recentLaunchHealth,
    confidence:         r.confidence,
    signals:            r.signals,
    scoreAdjustments:   r.scoreAdjustments,
    rawData:            r.rawData,
    lastUpdated:        r.lastUpdated ? new Date(r.lastUpdated).toISOString() : null,
    ageMinutes:         r.lastUpdated
      ? Math.round((Date.now() - r.lastUpdated) / 60_000)
      : null,
  };
}
