/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ALPHA LENNIX — openai-decision.js
 *  OpenAI GPT-4o Final Decision Engine
 *
 *  This is the FINAL AUTHORITY on whether to post a call.
 *  It receives the full enriched candidate + Claude's forensic analysis
 *  and makes a structured decision: POST | PROMOTE | WATCHLIST | RETEST | IGNORE
 *
 *  The key upgrade from the fine-tune approach:
 *  - Uses GPT-4o reasoning with full context (not just a fine-tune template)
 *  - Receives Claude's analysis as input (two-model consensus)
 *  - Can override Claude's recommendation with explanation
 *  - Provides TP/SL targets, time window, and invalidation conditions
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const OPENAI_API_URL = 'https://api.openai.com/v1';
const DECISION_MODEL = 'gpt-4o';
const DECISION_MODEL_FALLBACK = 'gpt-4o-mini';

// ─── Decision Definitions ─────────────────────────────────────────────────────

export const DECISIONS = {
  POST:       'POST',        // High conviction — post to Telegram now
  PROMOTE:    'PROMOTE',     // Strong but not perfect — elevate internally
  WATCHLIST:  'WATCHLIST',   // Monitor, not actionable yet
  RETEST:     'RETEST',      // Re-evaluate in N minutes
  IGNORE:     'IGNORE',      // Reject completely
};

// ─── System Prompt ────────────────────────────────────────────────────────────

const OPENAI_SYSTEM = `You are ALPHA LENNIX FINAL DECISION ENGINE — the last line of reasoning before a Solana meme coin call goes out to Telegram.

You receive:
1. Full on-chain data for a new Solana meme coin (often < 4 hours old)
2. A forensic analysis from Claude (a forensic review agent)
3. The current scoring result from our rules engine
4. Recent call history context (what's been working and failing)

Your decision carries weight. A bad POST means followers lose money. A missed IGNORE means we spam the channel with garbage. A missed POST on a 10x token means we leave money on the table.

TARGET OPPORTUNITY PROFILE (2026-04-30 operator policy):
- Market cap at call time: $8,000–$75,000 (HARD CEILING $75K — never POST above this)
- SWEET SPOT $8K–$25K: best entry for big runners. Lean POST when in band.
- $25K–$75K: allowed but neutral — needs stronger signals to justify POST.
- Pre-bonding-curve (<~$35,706 mcap, pump.fun PRE_BOND stage) is preferred.
- If the coin has just MIGRATED off the bonding curve, wait for buyer floor:
  do NOT POST in the first ~5 minutes post-migration; only POST in the
  5–15 min post-mig window if buyers are clearly defending a floor (5m buy
  ratio ≥ 0.55, 5m pct change ≥ -3%).
- Age: seconds to 4 hours old
- Realistic upside from entry: 5x–100x
- Organic holder growth, not farmed
- Clean deployer history (no serial ruggers)
- Smart/winner wallets entering early is the strongest positive signal

DECISION MEANINGS:
- POST = High conviction call. Post immediately. Only when setup is clean, timing is right, and evidence is compelling.
- PROMOTE = Strong candidate but missing key confirmation. Elevate for internal tracking. Watch for upgrade.
- WATCHLIST = Interesting but too early, too uncertain, or needs one more signal. Monitor passively.
- RETEST = The setup is time-sensitive. Re-evaluate in exactly N minutes. Used when bonding curve is accelerating or wallets are accumulating.
- IGNORE = Not worth any further attention. Structural failure, manipulation, or zero edge.

CONTEXT — FRESH PUMP.FUN REALITY:
Most candidates are $8K-$25K mcap, <2 hours old, still on the bonding curve.
At that stage, "perfect" structure is RARE: the bonding curve itself often
shows as a top holder, LP isn't locked yet, mint may still be active, and
holder count can be under 50. These are NOT automatic disqualifiers. What
matters is: is there real organic demand forming RIGHT NOW, and can we get
in before the run.

Your job is to call the REAL gems early. If you wait for all confirmations,
you miss every 10x. Lean toward POST when momentum + buys dominate and no
single catastrophic red flag exists.

HARD RULES (only these block POST):
✗ Market cap > $75,000 (operator hard ceiling — IGNORE regardless of other signals)
✗ Migrated <5 minutes ago (cooldown — IGNORE / RETEST until 5 min has passed)
✗ Deployer risk score > 85 (confirmed rugger — different from unknown deployer)
✗ Rug wallet count > 3
✗ Bonding curve already > 90% complete (migration imminent, too late to enter)
✗ Top single holder > 40% that is NOT the bonding curve PDA or pump.fun program

QUALITY BAR FOR POST (lenient — calibrated for fresh pump.fun gems):
- Wallet verdict NOT DANGEROUS / RUG
- Deployer NOT flagged as RUGGER
- Positive buy pressure: buy/sell ratio > 0.50 OR buys_1h > 200
- At least 10 unique holders (fresh coins ramp fast)
- No SEVERE bundle risk
- Composite score >= 40 OR quick_score >= 70 (momentum proxy)
- LP locked OR mint revoked is NICE but NOT required on coins < 1h old

Your response MUST be valid JSON with no markdown wrapping.`;

// ─── Main Decision Function ───────────────────────────────────────────────────

/**
 * Run the OpenAI final decision for a candidate.
 *
 * @param {Object} candidate      - Enriched candidate object
 * @param {Object} claudeAnalysis - Claude's forensic review output
 * @param {Object} scoreResult    - Rules engine score result
 * @param {string} recentContext  - Recent call history as string
 * @param {string} apiKey         - OpenAI API key
 * @returns {Object|null}         - Decision object or null on failure
 */
export async function getOpenAIDecision(candidate, claudeAnalysis, scoreResult, recentContext, apiKey) {
  if (!apiKey) return null;

  const prompt = buildDecisionPrompt(candidate, claudeAnalysis, scoreResult, recentContext);

  // Try primary model first
  let result = await callOpenAI(prompt, apiKey, DECISION_MODEL);

  // Fall back to mini on timeout or error
  if (!result) {
    console.warn('[openai-decision] GPT-4o failed — trying GPT-4o-mini fallback');
    result = await callOpenAI(prompt, apiKey, DECISION_MODEL_FALLBACK);
  }

  if (!result) {
    console.error('[openai-decision] Both models failed — returning null');
    return null;
  }

  // Validate and sanitize the decision
  return validateDecision(result, candidate, scoreResult);
}

async function callOpenAI(prompt, apiKey, model) {
  try {
    const res = await fetch(`${OPENAI_API_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        temperature: 0.2, // low temperature for consistency
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: OPENAI_SYSTEM },
          { role: 'user',   content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn(`[openai-decision] API ${res.status}: ${err.slice(0, 150)}`);
      return null;
    }

    const data = await res.json();
    const raw  = data.choices?.[0]?.message?.content ?? '';

    try {
      return JSON.parse(raw);
    } catch {
      // Try to extract JSON if wrapped
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      return null;
    }
  } catch (err) {
    console.warn(`[openai-decision] ${model} error:`, err.message);
    return null;
  }
}

// ─── Prompt Builder ───────────────────────────────────────────────────────────

function buildDecisionPrompt(candidate, claude, score, recentContext) {
  const mcap   = candidate.marketCap ?? 0;
  const levels = {
    sl:  Math.round(mcap * 0.75),
    tp1: Math.round(mcap * 2),
    tp2: Math.round(mcap * 5),
    tp3: Math.round(mcap * 10),
  };

  const fmt = (v, pre='$') => v==null?'UNKNOWN':v>=1e6?`${pre}${(v/1e6).toFixed(2)}M`:v>=1e3?`${pre}${(v/1e3).toFixed(1)}K`:`${pre}${v.toFixed(0)}`;

  return `
CANDIDATE OVERVIEW:
Token:         $${candidate.token ?? 'UNKNOWN'} (${candidate.tokenName ?? ''})
CA:            ${candidate.contractAddress ?? 'UNKNOWN'}
Stage:         ${candidate.stage ?? 'UNKNOWN'}
Age:           ${candidate.pairAgeHours?.toFixed?.(2) ?? 'UNKNOWN'}h (${Math.round((candidate.pairAgeHours ?? 0) * 60)} minutes)
Market Cap:    ${fmt(mcap)}
Liquidity:     ${fmt(candidate.liquidity)}
DEX:           ${candidate.dex ?? 'UNKNOWN'}

PRICE ACTION (last 5m/1h):
5M Change:     ${candidate.priceChange5m != null ? (candidate.priceChange5m > 0 ? '+' : '') + candidate.priceChange5m.toFixed(1) + '%' : 'UNKNOWN'}
1H Change:     ${candidate.priceChange1h != null ? (candidate.priceChange1h > 0 ? '+' : '') + candidate.priceChange1h.toFixed(1) + '%' : 'UNKNOWN'}
Buy Ratio 1H:  ${candidate.buySellRatio1h != null ? (candidate.buySellRatio1h * 100).toFixed(0) + '%' : 'UNKNOWN'}
Volume Vel:    ${candidate.volumeVelocity ?? 'UNKNOWN'}
Buys 1H:       ${candidate.buys1h ?? 'UNKNOWN'}  |  Sells 1H: ${candidate.sells1h ?? 'UNKNOWN'}

BONDING CURVE:
Curve %:       ${candidate.bondingCurvePct?.toFixed?.(1) ?? 'N/A'}%
Curve Accel:   ${candidate.bondingCurveAcceleration ?? 'N/A'}
SOL Raised:    ${candidate.bondingCurveSolRaised?.toFixed?.(1) ?? 'N/A'} SOL
Migration ETA: ${candidate.estimatedTimeToMigration ?? 'N/A'}

HOLDER STRUCTURE:
Holders:       ${candidate.holders ?? 'UNKNOWN'}
Top 10 %:      ${candidate.top10HolderPct?.toFixed?.(1) ?? 'UNKNOWN'}%
Dev Wallet %:  ${candidate.devWalletPct?.toFixed?.(1) ?? 'UNKNOWN'}%
Sniper Count:  ${candidate.sniperWalletCount ?? 'UNKNOWN'}

WALLET INTELLIGENCE:
Verdict:       ${candidate.walletIntel?.walletVerdict ?? candidate.walletVerdict ?? 'UNKNOWN'}
Winner Wallets:${candidate.walletIntel?.knownWinnerWalletCount ?? candidate.walletIntelScore ?? 'UNKNOWN'}
Smart Money:   ${candidate.walletIntel?.smartMoneyWalletCount ?? 'UNKNOWN'}
Sniper Count:  ${candidate.walletIntel?.sniperWalletCount ?? candidate.sniperWalletCount ?? 'UNKNOWN'}
Cluster Risk:  ${candidate.walletIntel?.clusterRiskScore ?? candidate.suspiciousClusterScore ?? 'UNKNOWN'}
Smart Score:   ${candidate.walletIntel?.smartMoneyScore ?? 'UNKNOWN'}/100

CONTRACT SAFETY:
Mint Auth:     ${candidate.mintAuthority === 0 ? 'REVOKED ✓' : candidate.mintAuthority === 1 ? 'ACTIVE ⚠️' : 'UNKNOWN'}
LP Locked:     ${candidate.lpLocked === 1 ? 'YES ✓' : candidate.lpLocked === 0 ? 'NO ⚠️' : 'UNKNOWN'}
Bundle Risk:   ${candidate.bundleRisk ?? 'UNKNOWN'}
BubbleMap:     ${candidate.bubbleMapRisk ?? 'UNKNOWN'}

DEPLOYER PROFILE:
Address:       ${candidate.deployerAddress?.slice?.(0, 10) ?? 'UNKNOWN'}...
Verdict:       ${candidate.deployerVerdict ?? 'UNKNOWN'}
Risk Score:    ${candidate.deployerRiskScore ?? 'UNKNOWN'}/100
History:       ${candidate.deployerHistory ?? 'UNKNOWN'}

LIVESTREAM:
Is Live:       ${candidate.livestream?.isLive ? 'YES' : 'NO'}
Viewers:       ${candidate.livestream?.viewerCount ?? 0}
Engagement:    ${candidate.livestream?.engagementScore ?? 0}/10

SCORING RESULT:
Composite:     ${score.score ?? 'UNKNOWN'}/100
Structure:     ${score.structureGrade ?? 'UNKNOWN'}
Setup Type:    ${score.setupType ?? 'UNKNOWN'}
Stage:         ${score.stage ?? 'UNKNOWN'}
Trap Severity: ${score.trapDetector?.severity ?? 'UNKNOWN'}
Regime Adj:    ${score.regimeAdjustedScore ?? 'UNKNOWN'}/100

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLAUDE FORENSIC ANALYSIS:
Wallet Verdict:    ${claude?.walletVerdict ?? 'N/A'}
Momentum Verdict:  ${claude?.momentumVerdict ?? 'N/A'}
Deployer Verdict:  ${claude?.deployerVerdict ?? 'N/A'}
Curve Verdict:     ${claude?.bondingCurveVerdict ?? 'N/A'}
Livestream:        ${claude?.livestreamVerdict ?? 'N/A'}
Claude Confidence: ${claude?.claudeConfidence ?? 'N/A'}/100
Claude Recommends: ${claude?.recommendedAction ?? 'N/A'}
Missing Data:      ${claude?.missingDataImpact ?? 'N/A'}

Thesis: "${claude?.overallThesis ?? 'N/A'}"
10x Case: "${claude?.tenXCaseFor ?? 'N/A'}"
10x Invalid: "${claude?.tenXInvalidation ?? 'N/A'}"

Bull Signals: ${JSON.stringify(claude?.topBullSignals ?? [])}
Risk Signals: ${JSON.stringify(claude?.topRiskSignals ?? [])}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RECENT CALL PERFORMANCE:
${recentContext || 'No recent call history available.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUGGESTED TRADE LEVELS (based on entry MCap):
Stop Loss:   ${fmt(levels.sl)} MCap (-25%)
TP1 (2×):    ${fmt(levels.tp1)} MCap
TP2 (5×):    ${fmt(levels.tp2)} MCap
TP3 (10×):   ${fmt(levels.tp3)} MCap
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REQUIRED OUTPUT FORMAT (valid JSON, no markdown):
{
  "decision": "POST | PROMOTE | WATCHLIST | RETEST | IGNORE",
  "retestInMinutes": null,
  "conviction": 0-100,
  "agreeWithClaude": true | false,
  "reasonAgreeOrDisagree": "...",
  "whyThisDecision": "...",
  "whyNotHigher": "...",
  "whyNotLower": "...",
  "keyStrengths": ["...", "..."],
  "keyRisks": ["...", "..."],
  "invalidationConditions": ["...", "..."],
  "timeWindowEstimate": "...",
  "entryMcap": ${mcap},
  "stopLossMcap": ${levels.sl},
  "tp1Mcap": ${levels.tp1},
  "tp2Mcap": ${levels.tp2},
  "tp3Mcap": ${levels.tp3},
  "tenXMcap": ${Math.round(mcap * 10)},
  "setupSummary": "one sentence: what this setup is and why it matters",
  "telegramVerdict": "2-3 sentence analyst summary for Telegram posting"
}`.trim();
}

// ─── Decision Validation ──────────────────────────────────────────────────────

function validateDecision(raw, candidate, score) {
  // Ensure decision is valid
  const validDecisions = Object.values(DECISIONS);
  if (!validDecisions.includes(raw.decision)) {
    raw.decision = DECISIONS.IGNORE;
    raw._validationNote = 'Invalid decision field — defaulted to IGNORE';
  }

  // Safety overrides — enforce hard rules even if GPT-4o says POST
  if (raw.decision === DECISIONS.POST) {
    const deployer   = candidate.deployerRiskScore ?? 0;
    const clusterRsk = candidate.walletIntel?.clusterRiskScore ?? 0;
    const topHolder  = candidate.top10HolderPct ?? 0;
    const rugWallets = candidate.walletIntel?.rugWalletCount ?? 0;

    // Relaxed safety overrides — calibrated for fresh pump.fun gems where the
    // bonding curve PDA often appears as a top holder. Only block POST on
    // clearly disqualifying signals.
    if (deployer >= 90) {
      raw.decision = DECISIONS.IGNORE;
      raw._safetyOverride = 'DEPLOYER_RISK_CONFIRMED_RUGGER';
    } else if (clusterRsk >= 85) {
      raw.decision = DECISIONS.WATCHLIST;
      raw._safetyOverride = 'CLUSTER_RISK_EXTREME';
    } else if (topHolder > 45) {
      raw.decision = DECISIONS.WATCHLIST;
      raw._safetyOverride = 'TOP_HOLDER_CONCENTRATION_SEVERE';
    } else if (rugWallets > 3) {
      raw.decision = DECISIONS.IGNORE;
      raw._safetyOverride = 'RUG_WALLETS_PRESENT';
    }

    if (raw._safetyOverride) {
      console.warn(`[openai-decision] Safety override: ${raw._safetyOverride} — POST → ${raw.decision}`);
    }
  }

  // Ensure retestInMinutes is set for RETEST
  if (raw.decision === DECISIONS.RETEST && !raw.retestInMinutes) {
    raw.retestInMinutes = 5; // default 5 min retest
  }

  // Ensure conviction is in range
  raw.conviction = Math.max(0, Math.min(100, Number(raw.conviction) || 50));

  return raw;
}

// ─── OpenAI Status Check ──────────────────────────────────────────────────────

export async function checkOpenAIConnection(apiKey) {
  if (!apiKey) return { ok: false, error: 'No API key' };
  try {
    const res = await fetch(`${OPENAI_API_URL}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    const hasGPT4o = data.data?.some(m => m.id.includes('gpt-4o'));
    return { ok: true, hasGPT4o, modelCount: data.data?.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Format for Telegram ──────────────────────────────────────────────────────

export function formatOpenAIDecisionForTelegram(decision) {
  if (!decision) return '';
  const emoji = {
    POST:      '🤖✅',
    PROMOTE:   '🤖⬆️',
    WATCHLIST: '🤖👁',
    RETEST:    '🤖🔄',
    IGNORE:    '🤖🚫',
  }[decision.decision] ?? '🤖';

  let line = `${emoji} <b>AI FINAL DECISION: ${decision.decision}</b> (${decision.conviction}% conviction)`;
  if (decision.decision === 'RETEST') line += ` — re-check in ${decision.retestInMinutes}min`;
  if (decision.setupSummary) line += `\n<i>${decision.setupSummary}</i>`;
  if (!decision.agreeWithClaude && decision.reasonAgreeOrDisagree) {
    line += `\n⚠️ <i>Disagrees with Claude: ${decision.reasonAgreeOrDisagree}</i>`;
  }
  return line;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export default {
  getOpenAIDecision,
  checkOpenAIConnection,
  formatOpenAIDecisionForTelegram,
  DECISIONS,
};
