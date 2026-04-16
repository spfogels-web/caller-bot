/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  performance-tracker.js — Call Outcome Tracker
 *
 *  Checks all PENDING calls and resolves them to WIN / LOSS / NEUTRAL
 *
 *  TIMING STRATEGY (Solana meme coins):
 *    Check 1: 6h after call  — primary outcome window
 *    Check 2: 12h after call — final outcome window (if still PENDING at 6h)
 *
 *  WIN  = price is +20% or more vs entry at check time
 *  LOSS = price is -30% or more vs entry at check time
 *  NEUTRAL = between -30% and +20% (sideways)
 *
 *  After resolving:
 *    - Extracts early buyer wallets from Helius → saves to winner_wallets
 *    - Sends outcome alert to admin Telegram
 *    - Triggers winner profile rebuild
 *    - Marks call for OpenAI fine-tune export
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────

const WIN_THRESHOLD  = Number(process.env.WIN_THRESHOLD_PCT  ?? 20);  // +20% = WIN
const LOSS_THRESHOLD = Number(process.env.LOSS_THRESHOLD_PCT ?? -30); // -30% = LOSS

// Primary check window: 6h after call
const CHECK_1_HOURS = Number(process.env.TRACK_CHECK_1_HOURS ?? 6);
// Final check window: 12h after call
const CHECK_2_HOURS = Number(process.env.TRACK_CHECK_2_HOURS ?? 12);

const BIRDEYE_KEY  = process.env.BIRDEYE_API_KEY ?? '';
const HELIUS_KEY   = process.env.HELIUS_API_KEY  ?? '';
const SOLANA_RPC   = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

// ─── Price Fetching ───────────────────────────────────────────────────────────

/**
 * Fetch current price via Birdeye (preferred — has priceChange fields).
 * Falls back to DexScreener (free, no key) so outcomes still resolve
 * even when BIRDEYE_API_KEY is not configured.
 * Returns { priceUsd, marketCap, priceChange1h, priceChange6h, priceChange24h } or null.
 */
async function fetchCurrentPrice(contractAddress) {
  if (!contractAddress) return null;

  // ── Primary: Birdeye ──────────────────────────────────────────────────────
  if (BIRDEYE_KEY) {
    try {
      const res = await fetch(
        `https://public-api.birdeye.so/defi/token_overview?address=${contractAddress}`,
        {
          headers: { 'X-API-KEY': BIRDEYE_KEY, 'x-chain': 'solana' },
          signal: AbortSignal.timeout(12_000),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const d    = data?.data;
        if (d?.price) {
          return {
            priceUsd:      d.price                ?? null,
            marketCap:     d.mc                   ?? null,
            priceChange1h: d.priceChange1hPercent ?? null,
            priceChange6h: d.priceChange6hPercent ?? null,
            priceChange24h:d.priceChange24hPercent ?? null,
            volume24h:     d.v24hUSD              ?? null,
            holders:       d.holder               ?? null,
            source:        'birdeye',
          };
        }
      }
    } catch (err) {
      console.warn(`[tracker] Birdeye fetch failed for ${contractAddress}: ${err.message}`);
    }
  }

  // ── Fallback: DexScreener (free, no key needed) ───────────────────────────
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(contractAddress)}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    const j    = await res.json();
    const pairs = (j?.pairs || []).filter(p => (p.chainId || p.chain) === 'solana');
    if (!pairs.length) return null;
    // Pick most liquid pair
    const best = pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const price = parseFloat(best.priceUsd || '0');
    if (!price) return null;
    return {
      priceUsd:      price,
      marketCap:     best.marketCap ?? best.fdv ?? null,
      priceChange1h: best.priceChange?.h1  ?? null,
      priceChange6h: best.priceChange?.h6  ?? null,
      priceChange24h:best.priceChange?.h24 ?? null,
      volume24h:     best.volume?.h24      ?? null,
      holders:       null,
      source:        'dexscreener',
    };
  } catch (err) {
    console.warn(`[tracker] DexScreener fetch failed for ${contractAddress}: ${err.message}`);
    return null;
  }
}

/**
 * Extract early buyer wallet addresses from Helius transaction data
 * These are the wallets that bought in the first few minutes of launch
 * Returns array of { address, amountSol, timestamp }
 */
async function extractEarlyBuyers(contractAddress, calledAt) {
  if (!HELIUS_KEY || !contractAddress) return [];

  try {
    // Get transaction signatures for this token around call time
    const callTime   = new Date(calledAt).getTime() / 1000;
    const windowStart = callTime - (5 * 60); // 5 min before call
    const windowEnd   = callTime + (30 * 60); // 30 min after call

    const res = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [
          contractAddress,
          { limit: 100, commitment: 'confirmed' },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const sigs  = data?.result ?? [];

    // Filter to our time window
    const windowSigs = sigs
      .filter(s => s.blockTime >= windowStart && s.blockTime <= windowEnd)
      .map(s => s.signature);

    if (!windowSigs.length) return [];

    // Parse transactions to find buyers
    const txRes = await fetch(
      `https://api.helius.xyz/v0/transactions?api-key=${HELIUS_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: windowSigs.slice(0, 20) }),
        signal: AbortSignal.timeout(20_000),
      }
    );

    if (!txRes.ok) return [];
    const txData = await txRes.json();

    const buyers = [];
    for (const tx of (txData ?? [])) {
      if (tx.type !== 'SWAP') continue;

      // Find the buyer (the signer/fee payer)
      const buyer = tx.feePayer;
      if (!buyer) continue;

      // Find the SOL amount spent
      const nativeTransfers = tx.nativeTransfers ?? [];
      const solSpent = nativeTransfers
        .filter(t => t.fromUserAccount === buyer)
        .reduce((sum, t) => sum + (t.amount / 1e9), 0);

      if (solSpent > 0) {
        buyers.push({
          address:   buyer,
          amountSol: solSpent,
          timestamp: tx.timestamp,
        });
      }
    }

    // Dedupe by address, keep largest buy
    const byAddress = new Map();
    for (const b of buyers) {
      const ex = byAddress.get(b.address);
      if (!ex || b.amountSol > ex.amountSol) {
        byAddress.set(b.address, b);
      }
    }

    return Array.from(byAddress.values())
      .sort((a, b) => b.amountSol - a.amountSol)
      .slice(0, 20); // top 20 early buyers by SOL spent

  } catch (err) {
    console.warn(`[tracker] Early buyer extraction failed: ${err.message}`);
    return [];
  }
}

/**
 * Save winner wallets to DB
 */
function saveWinnerWallets(db, buyers, token, callId, candidateId) {
  if (!buyers?.length) return;
  try {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO winner_wallets (address, token, call_id, candidate_id)
      VALUES (@address, @token, @call_id, @candidate_id)
    `);
    for (const buyer of buyers) {
      stmt.run({
        address:      buyer.address,
        token:        token ?? null,
        call_id:      callId,
        candidate_id: candidateId,
      });
    }
    console.log(`[tracker] Saved ${buyers.length} winner wallets for $${token}`);
  } catch (err) {
    console.warn(`[tracker] saveWinnerWallets failed: ${err.message}`);
  }
}

// ─── Outcome Determination ────────────────────────────────────────────────────

/**
 * Determine WIN/LOSS/NEUTRAL based on price change since entry
 */
function determineOutcome(entryPrice, currentPrice) {
  if (!entryPrice || !currentPrice || entryPrice <= 0) return null;
  const pctChange = ((currentPrice - entryPrice) / entryPrice) * 100;

  let outcome;
  if      (pctChange >= WIN_THRESHOLD)  outcome = 'WIN';
  else if (pctChange <= LOSS_THRESHOLD) outcome = 'LOSS';
  else                                   outcome = 'NEUTRAL';

  return { outcome, pctChange: Math.round(pctChange * 100) / 100 };
}

/**
 * Check if a call is due for its 6h or 12h check
 * Returns: 'CHECK_1' | 'CHECK_2' | 'FINAL' | null
 */
function getCheckWindow(call) {
  const calledAt  = new Date(call.called_at || call.posted_at).getTime();
  const nowMs     = Date.now();
  const hoursAgo  = (nowMs - calledAt) / (1000 * 60 * 60);
  const trackedAt = call.tracked_at ? new Date(call.tracked_at).getTime() : null;

  // Already has a tracked_at = was checked before
  // Check if we need the final 12h check
  if (trackedAt) {
    const trackedHoursAgo = (nowMs - trackedAt) / (1000 * 60 * 60);
    // If it was checked at 6h but not resolved, do 12h check
    if (hoursAgo >= CHECK_2_HOURS && trackedHoursAgo >= 4) {
      return 'FINAL';
    }
    return null; // already checked recently
  }

  // First check: between 6h and 12h after call
  if (hoursAgo >= CHECK_1_HOURS && hoursAgo < CHECK_2_HOURS + 2) {
    return 'CHECK_1';
  }

  // Final check: 12h+ after call with no prior check
  if (hoursAgo >= CHECK_2_HOURS) {
    return 'FINAL';
  }

  return null; // too soon
}

// ─── Main Tracker ─────────────────────────────────────────────────────────────

export async function runPerformanceTracker({
  db,
  updateCallPerformance,
  getPendingCalls,
  updateDeployerOutcome,
  rebuildWinnerProfiles,
  sendAdminAlert,
}) {
  let pendingCalls;
  try {
    pendingCalls = getPendingCalls();
  } catch (err) {
    console.warn('[tracker] getPendingCalls failed:', err.message);
    return;
  }

  if (!pendingCalls?.length) {
    console.log('[tracker] No pending calls to check');
    return;
  }

  console.log(`[tracker] Checking ${pendingCalls.length} pending call(s)…`);

  let resolved  = 0;
  let wins      = 0;
  let losses    = 0;
  let neutrals  = 0;
  const updates = [];

  for (const call of pendingCalls) {
    try {
      const checkWindow = getCheckWindow(call);
      if (!checkWindow) continue; // not due yet

      const hoursAgo = ((Date.now() - new Date(call.called_at || call.posted_at).getTime()) / 3600000).toFixed(1);
      console.log(`[tracker] Checking $${call.token} (${hoursAgo}h ago) — window: ${checkWindow}`);

      // Fetch current price
      const current = await fetchCurrentPrice(call.contract_address);
      if (!current?.priceUsd) {
        console.warn(`[tracker] No price data for ${call.contract_address} — skipping`);

        // If it's been more than 24h and still no price, token is dead → LOSS
        const hoursAgoNum = parseFloat(hoursAgo);
        if (hoursAgoNum > 24 && checkWindow === 'FINAL') {
          updateCallPerformance(call.id, {
            price_1h:       null,
            price_6h:       null,
            price_24h:      current?.priceUsd ?? null,
            pct_change_1h:  null,
            pct_change_6h:  null,
            pct_change_24h: -99,
            outcome:        'LOSS',
          });
          console.log(`[tracker] $${call.token} → LOSS (no price after 24h — likely dead)`);
          losses++;
          resolved++;
        }
        continue;
      }

      const entryPrice = call.price_at_call;
      const result     = entryPrice ? determineOutcome(entryPrice, current.priceUsd) : null;

      // For CHECK_1 (6h): only resolve if clearly WIN or clearly LOSS
      // Give ambiguous tokens a chance to develop until 12h check
      let finalOutcome = null;
      if (checkWindow === 'CHECK_1') {
        if (result?.outcome === 'WIN'  && result.pctChange >= WIN_THRESHOLD)  finalOutcome = 'WIN';
        if (result?.outcome === 'LOSS' && result.pctChange <= LOSS_THRESHOLD) finalOutcome = 'LOSS';
        // NEUTRAL at 6h = wait for 12h
      } else {
        // FINAL check (12h+): resolve everything
        finalOutcome = result?.outcome ?? 'NEUTRAL';
      }

      // Store the price data regardless of whether we resolve yet
      const updateData = {
        price_1h:       checkWindow === 'CHECK_1' ? current.priceUsd : call.price_1h,
        price_6h:       checkWindow === 'CHECK_1' ? current.priceUsd : current.priceUsd,
        price_24h:      checkWindow === 'FINAL'   ? current.priceUsd : call.price_24h,
        pct_change_1h:  current.priceChange1h  ?? null,
        pct_change_6h:  current.priceChange6h  ?? null,
        pct_change_24h: current.priceChange24h ?? null,
        outcome:        finalOutcome ?? 'PENDING',
      };

      updateCallPerformance(call.id, updateData);

      if (finalOutcome) {
        resolved++;
        if      (finalOutcome === 'WIN')     wins++;
        else if (finalOutcome === 'LOSS')    losses++;
        else                                 neutrals++;

        const emoji     = finalOutcome === 'WIN' ? '🏆' : finalOutcome === 'LOSS' ? '💀' : '➖';
        const pctStr    = result ? `${result.pctChange > 0 ? '+' : ''}${result.pctChange}%` : '?';
        const mcapStr   = current.marketCap ? `$${(current.marketCap/1000).toFixed(0)}K` : '?';
        const checkStr  = checkWindow === 'CHECK_1' ? '6h check' : '12h final';

        console.log(`[tracker] ${emoji} $${call.token} → ${finalOutcome} (${pctStr} at ${checkStr})`);

        // ── Extract winner wallets for WIN calls ──────────────────────────
        if (finalOutcome === 'WIN') {
          const buyers = await extractEarlyBuyers(
            call.contract_address,
            call.called_at || call.posted_at
          );
          if (buyers.length) {
            saveWinnerWallets(db, buyers, call.token, call.id, call.candidate_id);
          }
        }

        // ── Send outcome update to Telegram admin ─────────────────────────
        updates.push({
          token:    call.token,
          outcome:  finalOutcome,
          pctStr,
          mcapStr,
          emoji,
          checkStr,
          entryMcap: call.market_cap_at_call,
          score:     call.score_at_call,
        });
      } else {
        console.log(`[tracker] $${call.token} → still PENDING at ${checkWindow} (${result ? result.pctChange.toFixed(1)+'%' : 'no price'}) — will check again at 12h`);
      }

      // Small delay between API calls
      await new Promise(r => setTimeout(r, 800));

    } catch (err) {
      console.error(`[tracker] Error on call ${call.id}:`, err.message);
    }
  }

  // ── Rebuild winner profiles if any resolved ───────────────────────────────
  if (resolved > 0) {
    try {
      rebuildWinnerProfiles();
      console.log('[tracker] Winner profiles rebuilt');
    } catch (err) {
      console.warn('[tracker] Profile rebuild failed:', err.message);
    }

    // ── Send batch outcome update to admin ────────────────────────────────
    if (sendAdminAlert && updates.length) {
      try {
        const lines = updates.map(u =>
          `${u.emoji} <b>$${u.token}</b> → <b>${u.outcome}</b>\n` +
          `   ${u.pctStr} change | Entry: $${u.entryMcap ? (u.entryMcap/1000).toFixed(0)+'K' : '?'} | Score: ${u.score ?? '?'} | ${u.checkStr}`
        ).join('\n\n');

        await sendAdminAlert(
          `📊 <b>Performance Update</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `${lines}\n\n` +
          `🏆 Wins: ${wins}  💀 Losses: ${losses}  ➖ Neutral: ${neutrals}\n` +
          `<i>WIN = +${WIN_THRESHOLD}% | LOSS = ${LOSS_THRESHOLD}%</i>`
        );
      } catch {}
    }
  }

  console.log(`[tracker] Done — checked ${pendingCalls.length}, resolved ${resolved} (${wins}W/${losses}L/${neutrals}N)`);
}

// ─── Fine-Tune Data Export ────────────────────────────────────────────────────

/**
 * Export resolved calls as OpenAI fine-tuning JSONL format
 * Each call becomes a training example: features → WIN/LOSS
 */
export function exportFineTuningData(db) {
  try {
    const resolvedCalls = db.prepare(`
      SELECT c.*, ca.composite_score, ca.structure_grade, ca.setup_type,
             ca.stage, ca.trap_severity, ca.market_regime,
             ca.launch_quality_score, ca.buy_sell_ratio_1h, ca.volume_velocity,
             ca.dev_wallet_pct, ca.top10_holder_pct, ca.bundle_risk,
             ca.bubble_map_risk, ca.mint_authority, ca.holders,
             ss.launch_quality, ss.wallet_structure, ss.market_behavior, ss.social_narrative
      FROM calls c
      LEFT JOIN candidates ca ON c.candidate_id = ca.id
      LEFT JOIN sub_scores ss ON ss.candidate_id = ca.id
      WHERE c.outcome IN ('WIN', 'LOSS', 'NEUTRAL')
      ORDER BY c.posted_at DESC
      LIMIT 1000
    `).all();

    const examples = resolvedCalls.map(call => {
      const features = {
        score:           call.score_at_call,
        structure:       call.structure_grade,
        setup:           call.setup_type,
        stage:           call.stage,
        trap:            call.trap_severity,
        regime:          call.regime_at_call || call.market_regime,
        launchQuality:   call.launch_quality,
        walletStructure: call.wallet_structure,
        marketBehavior:  call.market_behavior,
        socialNarrative: call.social_narrative,
        launchQScore:    call.launch_quality_score,
        buySellRatio1h:  call.buy_sell_ratio_1h,
        volumeVelocity:  call.volume_velocity,
        devWalletPct:    call.dev_wallet_pct,
        top10Pct:        call.top10_holder_pct,
        bundleRisk:      call.bundle_risk,
        bubblemapRisk:   call.bubble_map_risk,
        mintRevoked:     call.mint_authority === 0,
        holders:         call.holders,
      };

      return {
        messages: [
          {
            role: 'system',
            content: 'You are Alpha Lennix, an elite Solana token caller. Based on token metrics, predict if this will be a WIN (+20%) or LOSS (-30%). Respond with JSON: {"decision": "WIN"|"LOSS"|"NEUTRAL", "confidence": 0-100}',
          },
          {
            role: 'user',
            content: `Token metrics: ${JSON.stringify(features)}`,
          },
          {
            role: 'assistant',
            content: JSON.stringify({
              decision:   call.outcome,
              confidence: call.outcome === 'WIN' ? 85 : call.outcome === 'LOSS' ? 85 : 60,
            }),
          },
        ],
      };
    });

    return examples;
  } catch (err) {
    console.error('[tracker] exportFineTuningData failed:', err.message);
    return [];
  }
}
