/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ALPHA LENNIX — missed-winner-tracker.js
 *  Outcome Monitoring + Missed Winner Learning Loop
 *
 *  Every 30 minutes:
 *  1. Checks price of all IGNORE/WATCHLIST tokens from last 24h
 *  2. Flags any that achieved 3x+ as MISSED_WINNER
 *  3. Analyzes what signals were present that we ignored
 *  4. Generates concrete improvement recommendations
 *  5. Updates scoring weights based on patterns
 *
 *  Also runs post-call outcome tracking:
 *  - Checks posted calls at T+30min, T+2h, T+6h, T+24h
 *  - Marks WIN/LOSS/PARTIAL automatically where possible
 *  - Builds performance history for the AI learning loop
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const DEXSCREENER_API = 'https://api.dexscreener.com';
const CLAUDE_API_URL  = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL    = 'claude-sonnet-4-20250514';

// ─── Outcome Tracking ─────────────────────────────────────────────────────────

/**
 * Check a posted call's current price vs entry price.
 * Returns outcome analysis including whether SL/TP levels were hit.
 */
export async function checkCallOutcome(call) {
  const { contractAddress, market_cap_at_call, called_at } = call;
  if (!contractAddress || !market_cap_at_call) return null;

  try {
    const currentData = await fetchCurrentMarketCap(contractAddress);
    if (!currentData) return null;

    const entryMcap   = market_cap_at_call;
    const currentMcap = currentData.marketCap;
    const multiple    = currentMcap / entryMcap;
    const pctChange   = ((currentMcap - entryMcap) / entryMcap) * 100;

    // SL/TP levels
    const slMcap  = entryMcap * 0.75;
    const tp1Mcap = entryMcap * 2;
    const tp2Mcap = entryMcap * 5;
    const tp3Mcap = entryMcap * 10;

    const hitSL  = currentMcap <= slMcap;
    const hitTP1 = currentMcap >= tp1Mcap;
    const hitTP2 = currentMcap >= tp2Mcap;
    const hitTP3 = currentMcap >= tp3Mcap;

    // Auto-determine outcome for unresolved calls
    let autoOutcome = null;
    if (hitTP1)           autoOutcome = 'WIN';
    else if (hitSL)       autoOutcome = 'LOSS';
    else if (multiple >= 1.5) autoOutcome = 'PARTIAL'; // 50% up but not 2x

    return {
      contractAddress,
      entryMcap,
      currentMcap,
      multiple:   Math.round(multiple * 100) / 100,
      pctChange:  Math.round(pctChange * 10) / 10,
      hitSL, hitTP1, hitTP2, hitTP3,
      autoOutcome,
      checkTimestamp: Date.now(),
      minutesSinceCall: called_at
        ? Math.round((Date.now() - new Date(called_at).getTime()) / 60_000)
        : null,
    };
  } catch (err) {
    console.warn(`[missed-winner] Outcome check failed for ${contractAddress?.slice(0,8)}: ${err.message}`);
    return null;
  }
}

// ─── Missed Winner Detection ──────────────────────────────────────────────────

/**
 * Scan all ignored/watchlisted candidates from the last 24 hours.
 * Flag any that achieved significant gains as missed winners.
 */
export async function detectMissedWinners(dbInstance) {
  const cutoff = new Date(Date.now() - 24 * 3_600_000).toISOString();

  // Get all non-posted candidates from the last 24h
  let candidates;
  try {
    candidates = dbInstance.prepare(`
      SELECT id, contract_address, token, final_decision,
             composite_score, market_cap, created_at,
             claude_verdict, setup_type, structure_grade,
             bundle_risk, sniper_wallet_count, dev_wallet_pct,
             top10_holder_pct, buy_sell_ratio_1h, volume_velocity,
             pair_age_hours, stage, wallet_intel_score
      FROM candidates
      WHERE final_decision IN ('IGNORE', 'WATCHLIST', 'HOLD_FOR_REVIEW', 'RETEST')
        AND created_at > ?
        AND contract_address IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 200
    `).all(cutoff);
  } catch (err) {
    console.warn('[missed-winner] DB query failed:', err.message);
    return [];
  }

  if (!candidates.length) return [];

  console.log(`[missed-winner] Checking ${candidates.length} ignored candidates for missed winners...`);

  const missedWinners = [];
  const BATCH_SIZE    = 10;

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (c) => {
      try {
        const current = await fetchCurrentMarketCap(c.contract_address);
        if (!current) return;

        const entryMcap   = c.market_cap ?? 0;
        if (entryMcap <= 0) return;

        const multiple = current.marketCap / entryMcap;

        if (multiple >= 3) { // 3x+ = worth analyzing as missed winner
          const winner = {
            ...c,
            entryMcap,
            peakMcapEstimate: current.marketCap,
            currentMultiple: Math.round(multiple * 100) / 100,
            missedWinnerTier: multiple >= 10 ? 'MAJOR' : multiple >= 5 ? 'SIGNIFICANT' : 'MODERATE',
            detectedAt: Date.now(),
          };

          missedWinners.push(winner);

          // Update DB
          try {
            dbInstance.prepare(`
              UPDATE candidates
              SET missed_winner_flag = 1,
                  missed_winner_peak_multiple = ?
              WHERE id = ?
            `).run(multiple, c.id);
          } catch {}

          console.log(`[missed-winner] 🚨 MISSED ${winner.missedWinnerTier}: $${c.token} ${multiple.toFixed(1)}x from $${Math.round(entryMcap/1000)}K → $${Math.round(current.marketCap/1000)}K`);
        }
      } catch {}
    }));

    await sleep(500); // rate limit
  }

  console.log(`[missed-winner] Found ${missedWinners.length} missed winners`);
  return missedWinners;
}

// ─── Learning Analysis ────────────────────────────────────────────────────────

/**
 * Generate improvement recommendations from missed winners.
 * Uses Claude to analyze patterns and suggest scoring changes.
 */
export async function analyzeMissedWinners(missedWinners, postedCalls, claudeApiKey) {
  if (!missedWinners?.length || !claudeApiKey) return null;

  // Also compare against recent posted calls
  const wonCalls  = postedCalls?.filter(c => c.outcome === 'WIN')  ?? [];
  const lostCalls = postedCalls?.filter(c => c.outcome === 'LOSS') ?? [];

  const prompt = buildLearningPrompt(missedWinners, wonCalls, lostCalls);

  try {
    const res = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        system: `You are the learning engine for an elite Solana meme coin caller bot.

Your job is to analyze missed winning opportunities and generate specific, actionable improvements to the bot's scoring and filtering logic.

Be specific. Reference actual numbers from the data. Every recommendation must include:
1. What changed (which rule, weight, or threshold)
2. Why it would have helped
3. Whether it risks increasing false positives
4. Confidence that this is a real pattern vs random noise

Output ONLY valid JSON. No markdown.`,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const raw  = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');

    try {
      const clean = raw.replace(/```json|```/gi, '').trim();
      return JSON.parse(clean);
    } catch {
      console.warn('[missed-winner] Failed to parse Claude recommendations');
      return null;
    }
  } catch (err) {
    console.warn('[missed-winner] Claude analysis failed:', err.message);
    return null;
  }
}

function buildLearningPrompt(missedWinners, wonCalls, lostCalls) {
  const missedSummary = missedWinners.slice(0, 10).map(w => `
MISSED: $${w.token} — ${w.currentMultiple}x (${w.missedWinnerTier})
  Entry MCap: $${Math.round((w.entryMcap ?? 0)/1000)}K
  Decision:   ${w.final_decision} (score: ${w.composite_score}/100)
  Stage:      ${w.stage ?? 'UNKNOWN'} | Age: ${w.pair_age_hours?.toFixed?.(1) ?? '?'}h
  Structure:  ${w.structure_grade ?? 'UNKNOWN'} | Setup: ${w.setup_type ?? 'UNKNOWN'}
  Wallet:     Score ${w.wallet_intel_score ?? '?'} | Snipers: ${w.sniper_wallet_count ?? '?'}
  Safety:     Bundle: ${w.bundle_risk ?? '?'} | Dev%: ${w.dev_wallet_pct?.toFixed?.(1) ?? '?'}% | Top10: ${w.top10_holder_pct?.toFixed?.(1) ?? '?'}%
  Momentum:   BuySellRatio: ${w.buy_sell_ratio_1h ?? '?'} | VolVelocity: ${w.volume_velocity ?? '?'}
  Claude:     "${(w.claude_verdict ?? '').slice(0, 100)}"
`).join('');

  const wonSummary = wonCalls.slice(0, 5).map(w =>
    `WIN: $${w.token} — score:${w.score_at_call} mcap:$${Math.round((w.market_cap_at_call ?? 0)/1000)}K setup:${w.setup_type ?? '?'}`
  ).join('\n  ');

  const lostSummary = lostCalls.slice(0, 5).map(l =>
    `LOSS: $${l.token} — score:${l.score_at_call} mcap:$${Math.round((l.market_cap_at_call ?? 0)/1000)}K setup:${l.setup_type ?? '?'}`
  ).join('\n  ');

  return `
Analyze these ${missedWinners.length} tokens that were IGNORED but later achieved 3x+ gains.

MISSED WINNERS:
${missedSummary}

RECENT WINS (for comparison — what we got right):
  ${wonSummary || 'None recorded'}

RECENT LOSSES (for comparison — what we got wrong in the other direction):
  ${lostSummary || 'None recorded'}

Current scoring context:
- Score floor: 38/100 (tokens below this are ignored)
- Target MCap range: $5K–$150K
- Key signals: wallet intelligence, momentum, deployer quality, holder structure
- Bonding curve stage preferred
- Volume velocity > 0.25 and buy ratio > 0.60 are positive signals

For each missed winner pattern you identify, output a recommendation.

Required output format:
{
  "summary": "...",
  "missedWinnersAnalyzed": ${missedWinners.length},
  "topPattern": "...",
  "recommendations": [
    {
      "id": "REC_001",
      "priority": "HIGH | MEDIUM | LOW",
      "target": "score_weight | threshold | rule | feature | prompt",
      "component": "scorer | rules_filter | claude_prompt | wallet_intel | regime",
      "current": "...",
      "suggested": "...",
      "rationale": "...",
      "expectedImpact": "...",
      "falsePositiveRisk": "LOW | MEDIUM | HIGH",
      "confidence": 0-100,
      "tokensItWouldHaveCaught": ["$TOKEN1", "$TOKEN2"]
    }
  ],
  "keySignalsMissed": ["...", "..."],
  "rulesNeedingAdjustment": ["...", "..."],
  "winnerPatternFound": "...",
  "lossPatternFound": "..."
}`;
}

// ─── Post-Call Outcome Tracking ───────────────────────────────────────────────

/**
 * Check all unresolved posted calls and auto-update outcomes where possible.
 * Run this every 30 minutes via setInterval.
 */
export async function runOutcomeTracker(dbInstance) {
  let unresolvedCalls;
  try {
    unresolvedCalls = dbInstance.prepare(`
      SELECT id, contract_address, token, market_cap_at_call, called_at, score_at_call
      FROM calls
      WHERE (outcome IS NULL OR outcome = 'PENDING')
        AND called_at > datetime('now', '-48 hours')
        AND contract_address IS NOT NULL
      LIMIT 50
    `).all();
  } catch (err) {
    console.warn('[outcome-tracker] DB query failed:', err.message);
    return;
  }

  if (!unresolvedCalls.length) return;

  console.log(`[outcome-tracker] Checking ${unresolvedCalls.length} unresolved calls...`);

  for (const call of unresolvedCalls) {
    try {
      const result = await checkCallOutcome(call);
      if (!result || !result.autoOutcome) continue;

      const minutesSince = result.minutesSinceCall ?? 0;

      // Only auto-resolve if enough time has passed
      if (result.autoOutcome === 'WIN' && minutesSince >= 30) {
        dbInstance.prepare(`
          UPDATE calls SET
            outcome = 'WIN',
            pct_change_1h = ?,
            auto_resolved = 1,
            auto_resolved_at = datetime('now')
          WHERE id = ?
        `).run(result.pctChange, call.id);
        console.log(`[outcome-tracker] ✅ Auto-WIN: $${call.token} ${result.multiple}x`);
      } else if (result.autoOutcome === 'LOSS' && minutesSince >= 60) {
        dbInstance.prepare(`
          UPDATE calls SET
            outcome = 'LOSS',
            pct_change_1h = ?,
            auto_resolved = 1,
            auto_resolved_at = datetime('now')
          WHERE id = ?
        `).run(result.pctChange, call.id);
        console.log(`[outcome-tracker] ❌ Auto-LOSS: $${call.token} (${result.pctChange.toFixed(0)}%)`);
      }

      await sleep(300); // rate limit
    } catch {}
  }
}

// ─── Price Fetcher ────────────────────────────────────────────────────────────

async function fetchCurrentMarketCap(contractAddress) {
  try {
    const res = await fetch(
      `${DEXSCREENER_API}/latest/dex/tokens/${contractAddress}`,
      { signal: AbortSignal.timeout(8_000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs ?? [];
    if (!pairs.length) return null;

    // Get the most liquid pair
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];

    return {
      marketCap:  best.marketCap ?? best.fdv ?? 0,
      liquidity:  best.liquidity?.usd ?? 0,
      price:      parseFloat(best.priceUsd ?? 0),
      volume24h:  best.volume?.h24 ?? 0,
      priceChange5m:  best.priceChange?.m5 ?? 0,
      priceChange1h:  best.priceChange?.h1 ?? 0,
      priceChange24h: best.priceChange?.h24 ?? 0,
    };
  } catch {
    return null;
  }
}

// ─── Learning Scheduler ───────────────────────────────────────────────────────

/**
 * Start the automated learning and outcome tracking loops.
 */
export function startLearningLoop(dbInstance, claudeApiKey) {
  console.log('[learning-loop] Starting automated outcome tracking and missed winner detection...');

  // Outcome tracking: every 30 minutes
  const outcomeInterval = setInterval(() => {
    runOutcomeTracker(dbInstance).catch(err =>
      console.warn('[learning-loop] Outcome tracker error:', err.message)
    );
  }, 30 * 60_000);

  // Missed winner detection + analysis: every 6 hours
  const missedWinnerInterval = setInterval(async () => {
    try {
      console.log('[learning-loop] Running missed winner detection...');

      const missed = await detectMissedWinners(dbInstance);
      if (!missed.length) {
        console.log('[learning-loop] No missed winners detected this cycle');
        return;
      }

      // Get recent posted calls for comparison
      let recentCalls = [];
      try {
        recentCalls = dbInstance.prepare(`
          SELECT * FROM calls WHERE called_at > datetime('now', '-7 days')
          ORDER BY called_at DESC LIMIT 50
        `).all();
      } catch {}

      const analysis = await analyzeMissedWinners(missed, recentCalls, claudeApiKey);
      if (analysis) {
        console.log('[learning-loop] ✓ Improvement recommendations generated:');
        console.log(`  - ${analysis.recommendations?.length ?? 0} recommendations`);
        console.log(`  - Top pattern: ${analysis.topPattern}`);
        console.log(`  - Key signals missed: ${analysis.keySignalsMissed?.join(', ')}`);

        // Store recommendations
        try {
          dbInstance.prepare(`
            INSERT INTO learning_recommendations
              (analysis_json, missed_count, generated_at)
            VALUES (?, ?, datetime('now'))
          `).run(JSON.stringify(analysis), missed.length);
        } catch {
          // Table may not exist yet — handled by db.js initDb
        }

        // Log high-priority recommendations
        for (const rec of (analysis.recommendations ?? []).filter(r => r.priority === 'HIGH')) {
          console.log(`\n  🔴 HIGH PRIORITY: ${rec.target}`);
          console.log(`     Current: ${rec.current}`);
          console.log(`     Suggested: ${rec.suggested}`);
          console.log(`     Confidence: ${rec.confidence}%`);
        }
      }
    } catch (err) {
      console.warn('[learning-loop] Missed winner analysis error:', err.message);
    }
  }, 6 * 3_600_000);

  // Run both immediately on start
  setTimeout(() => runOutcomeTracker(dbInstance).catch(() => {}), 5_000);
  setTimeout(() => detectMissedWinners(dbInstance).catch(() => {}), 30_000);

  return { outcomeInterval, missedWinnerInterval };
}

// ─── Dashboard Data ───────────────────────────────────────────────────────────

export function getLearningStats(dbInstance) {
  try {
    const missedCount = (() => {
      try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM candidates WHERE missed_winner_flag = 1`).get().n; } catch { return 0; }
    })();

    const bigMissed = (() => {
      try {
        return dbInstance.prepare(`
          SELECT token, missed_winner_peak_multiple, final_decision, composite_score, created_at
          FROM candidates
          WHERE missed_winner_flag = 1
          ORDER BY missed_winner_peak_multiple DESC
          LIMIT 10
        `).all();
      } catch { return []; }
    })();

    const latestRecs = (() => {
      try {
        const row = dbInstance.prepare(`
          SELECT analysis_json FROM learning_recommendations
          ORDER BY generated_at DESC LIMIT 1
        `).get();
        return row ? JSON.parse(row.analysis_json) : null;
      } catch { return null; }
    })();

    const autoResolved = (() => {
      try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM calls WHERE auto_resolved = 1`).get().n; } catch { return 0; }
    })();

    return {
      missedWinnersTotal:    missedCount,
      topMissedWinners:      bigMissed,
      latestRecommendations: latestRecs,
      autoResolvedCalls:     autoResolved,
    };
  } catch {
    return { missedWinnersTotal: 0, topMissedWinners: [], latestRecommendations: null, autoResolvedCalls: 0 };
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
