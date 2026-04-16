/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  multi-bot.js — 3-Bot Simultaneous Scanner Orchestrator
 *
 *  BOT 1: NEW COINS  — fresh launches 0-30min, micro-cap gems
 *  BOT 2: TRENDING   — high-volume breakouts 30min-72h
 *  BOT 3: WALLET BOT — follows smart wallets, posts when they buy
 *
 *  Each bot runs on its own interval, has its own mode config,
 *  and posts to Telegram independently. All share the same enricher,
 *  scorer, and risk filter. Deduplication prevents cross-bot double-posts.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import { runScanner, fetchPairByAddress, normalizePair } from './scanner.js';
import { enrichCandidate, enrichCandidates }             from './enricher.js';
import { computeFullScore, formatScoreForClaude, getStage } from './scorer.js';
import { applyRegimeAdjustments, getRegime, updateRegime }  from './regime.js';
import { initDb, isRecentlySeen, recordSeen, logEvent,
         insertCandidate, insertCall, markCandidatePosted,
         insertSubScores, computeSimilarityScores }         from './db.js';
import { runWalletIntel }                                   from './wallet-intel.js';
import { tracker as walletTracker }                         from './wallet-tracker/modules/wallet-tracker.js';
import { checkTokenRisk }                                   from './wallet-tracker/modules/token-risk-filter.js';
import { queryAll }                                         from './wallet-tracker/db/client.js';
import { computeSLTP }                                      from './sl-tp-engine.js';

// ─── Env ─────────────────────────────────────────────────────────────────────

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_GROUP_CHAT_ID,
  CLAUDE_API_KEY,
  BIRDEYE_API_KEY,
  ADMIN_TELEGRAM_ID,
} = process.env;

const TELEGRAM_API   = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL   = 'claude-sonnet-4-20250514';

// ─── Bot Configs ──────────────────────────────────────────────────────────────

export const BOT_CONFIGS = {
  NEW_COINS: {
    id:              'NEW_COINS',
    name:            'New Coins Bot',
    emoji:           '🚀',
    intervalMs:      2 * 60 * 1000,     // scan every 2 min
    minScore:        48,
    minMarketCap:    1_000,
    maxMarketCap:    800_000,
    minLiquidity:    3_000,
    minVolume24h:    2_000,
    minPairAgeHours: 0,
    maxPairAgeHours: 0.5,               // 30 minutes max
    minTxns24h:      10,
    minBuys24h:      5,
    trapTolerance:   'MEDIUM',
    bundleBlock:     'SEVERE',
    thresholdAdjust: -12,
    color:           '#00ff88',
    description:     'Fresh launches — 0 to 30 min old',
  },

  TRENDING: {
    id:              'TRENDING',
    name:            'Trending Bot',
    emoji:           '📈',
    intervalMs:      3 * 60 * 1000,     // scan every 3 min
    minScore:        68,
    minMarketCap:    30_000,
    maxMarketCap:    15_000_000,
    minLiquidity:    15_000,
    minVolume24h:    80_000,
    minPairAgeHours: 0.5,
    maxPairAgeHours: 72,
    minTxns24h:      400,
    minBuys24h:      200,
    minHolders:      300,
    trapTolerance:   'LOW',
    bundleBlock:     'HIGH',
    thresholdAdjust: 5,
    color:           '#ffd700',
    description:     'High-volume breakouts — proven momentum',
  },

  WALLET_BOT: {
    id:              'WALLET_BOT',
    name:            'Wallet Bot',
    emoji:           '👁',
    intervalMs:      0,                 // event-driven, not interval
    minScore:        45,
    minMarketCap:    500,
    maxMarketCap:    10_000_000,
    minLiquidity:    2_000,
    minVolume24h:    1_000,
    minPairAgeHours: 0,
    maxPairAgeHours: 168,
    trapTolerance:   'HIGH',
    bundleBlock:     'SEVERE',
    thresholdAdjust: -8,
    color:           '#9945ff',
    description:     'Smart wallet signal — tracked wallets buying',
  },
};

// ─── Dedup across bots ────────────────────────────────────────────────────────

const MULTI_BOT_SEEN = new Map(); // ca → timestamp
const MULTI_BOT_TTL  = 30 * 60 * 1000; // 30 min cross-bot dedup

function isSeenByAnyBot(ca) {
  const t = MULTI_BOT_SEEN.get(ca);
  if (!t) return false;
  if (Date.now() - t > MULTI_BOT_TTL) { MULTI_BOT_SEEN.delete(ca); return false; }
  return true;
}

function markSeenByBot(ca) {
  MULTI_BOT_SEEN.set(ca, Date.now());
}

// ─── Telegram ────────────────────────────────────────────────────────────────

async function tgSend(chatId, text, options = {}) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML',
                                disable_web_page_preview: true, ...options }),
      signal:  AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error('[tg]', res.status);
    return res.ok;
  } catch (err) { console.error('[tg]', err.message); }
}

const tgGroup = (text, opts) => tgSend(TELEGRAM_GROUP_CHAT_ID, text, opts);
const tgAdmin = (text)       => ADMIN_TELEGRAM_ID ? tgSend(ADMIN_TELEGRAM_ID, `🔧 ${text}`) : null;

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmt(v, pre = '$') {
  if (v == null) return 'N/A';
  const n = Number(v);
  if (!isFinite(n)) return 'N/A';
  if (n >= 1e6) return `${pre}${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${pre}${(n/1e3).toFixed(1)}K`;
  return `${pre}${n.toFixed(2)}`;
}

function pct(v) {
  if (v == null) return 'N/A';
  const n = Number(v);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function scoreBar(s) {
  const n = Math.max(0, Math.min(100, Number(s) || 0));
  const f = Math.round((n/100)*10);
  return '█'.repeat(f) + '░'.repeat(10-f);
}

function riskEmoji(r) {
  return { LOW:'🟢', MEDIUM:'🟡', HIGH:'🔴', EXTREME:'💀' }[r] ?? '⚪';
}

// ─── SL/TP Formatter ─────────────────────────────────────────────────────────

function formatSLTPSection(candidate, sltp) {
  if (!sltp) return '';
  const entry = candidate.priceUsd;
  const fmtPrice = (p) => p != null && entry ? `$${p.toFixed(8)}` : '—';

  return `\n📊 <b>Entry / SL / TP:</b>\n` +
    `Entry:  <code>${fmtPrice(entry)}</code>\n` +
    `🛡 SL:   <code>${fmtPrice(sltp.stopLoss1)}</code> (${sltp.slPct1}%) · <code>${fmtPrice(sltp.stopLoss2)}</code> (${sltp.slPct2}%)\n` +
    `🎯 TP1:  <code>${fmtPrice(sltp.tp1)}</code> (+${sltp.tp1Pct}%)\n` +
    `🎯 TP2:  <code>${fmtPrice(sltp.tp2)}</code> (+${sltp.tp2Pct}%)\n` +
    `🎯 TP3:  <code>${fmtPrice(sltp.tp3)}</code> (+${sltp.tp3Pct}%)\n` +
    `⏱ Max hold: <b>${sltp.maxHoldLabel}</b>`;
}

// ─── Smart Wallet Signal Formatter ───────────────────────────────────────────

async function getSmartWalletSignal(tokenAddress) {
  try {
    // Check if any tracked wallet recently bought this token
    const rows = await queryAll(
      `SELECT w.address, w.label, w.trust_score, w.tier, wt.block_time, wt.sol_amount
       FROM wallet_transactions wt
       JOIN wallets w ON w.address = wt.wallet_address
       WHERE wt.token_address = $1
         AND wt.tx_type = 'BUY'
         AND wt.block_time > NOW() - INTERVAL '6 hours'
         AND w.is_followable = TRUE
       ORDER BY w.trust_score DESC
       LIMIT 5`,
      [tokenAddress]
    );
    if (!rows.length) return null;

    const lines = rows.map(r => {
      const label = r.label ?? `${r.address.slice(0,6)}…${r.address.slice(-4)}`;
      const tierStr = r.tier === 1 ? '★' : r.tier === 2 ? '▲' : '·';
      return `  ${tierStr} <b>${esc(label)}</b> (score: ${r.trust_score}) — ${r.sol_amount ? `${Number(r.sol_amount).toFixed(2)} SOL` : '?'}`;
    });

    return `\n👁 <b>Smart Wallet Signal:</b>\n${lines.join('\n')}`;
  } catch {
    return null;
  }
}

// ─── Call Alert Builder ───────────────────────────────────────────────────────

async function buildCallAlert(candidate, verdict, scoreResult, botConfig, sltp) {
  const {
    score = 0, risk = '?', setup_type = '?',
    bull_case = [], red_flags = [],
    verdict: vText = '', missing_data = [],
  } = verdict;

  const sub   = scoreResult?.subScores ?? {};
  const trap  = scoreResult?.trapDetector ?? {};
  const grade = scoreResult?.structureGrade ?? '?';
  const regime = getRegime();

  const bullLines  = bull_case.slice(0,4).map(p => `• ${esc(p)}`).join('\n') || '• —';
  const watchLines = red_flags.slice(0,3).map(p => `• ${esc(p)}`).join('\n') || '• —';
  const preliminary = missing_data.length > 3
    ? `\n⚠️ <i>Partial data — ${missing_data.length} fields unconfirmed</i>\n` : '\n';

  const mintFlag   = candidate.mintAuthority   === 0 ? '✓' : candidate.mintAuthority   === 1 ? '⚠️ ACTIVE' : '?';
  const freezeFlag = candidate.freezeAuthority === 0 ? '✓' : candidate.freezeAuthority === 1 ? '⚠️ ACTIVE' : '?';
  const lpFlag     = candidate.lpLocked        === 1 ? '✓ locked' : candidate.lpLocked === 0 ? '⚠️ UNLOCKED' : '?';

  const sltpSection = formatSLTPSection(candidate, sltp);
  const walletSignal = await getSmartWalletSignal(candidate.contractAddress).catch(() => null);

  return (
    `<b>${botConfig.emoji} CALL ALERT — ${botConfig.name.toUpperCase()}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n` +
    `Token: <b>$${esc(candidate.token ?? 'UNKNOWN')}</b>\n` +
    `CA: <code>${esc(candidate.contractAddress ?? '—')}</code>\n\n` +

    `<b>Score: ${score}/100</b>  ${scoreBar(score)}\n` +
    `Risk: <b>${riskEmoji(risk)} ${risk}</b>   Setup: <b>${setup_type}</b>\n` +
    `Structure: <b>${grade}</b>  Stage: <b>${scoreResult?.stage ?? '?'}</b>\n\n` +

    `<b>Sub-Scores:</b>\n` +
    `🚀 Launch: ${sub.launchQuality ?? '?'}  ` +
    `👥 Wallet: ${sub.walletStructure ?? '?'}  ` +
    `📈 Market: ${sub.marketBehavior ?? '?'}  ` +
    `📣 Social: ${sub.socialNarrative ?? '?'}\n\n` +

    `<b>📊 Market Data:</b>\n` +
    `MCap: <b>${fmt(candidate.marketCap)}</b>  Liq: <b>${fmt(candidate.liquidity)}</b>\n` +
    `Vol24h: <b>${fmt(candidate.volume24h)}</b>  Age: <b>${candidate.pairAgeHours?.toFixed(1) ?? '?'}h</b>\n` +
    `1h: <b>${pct(candidate.priceChange1h)}</b>  6h: <b>${pct(candidate.priceChange6h)}</b>  24h: <b>${pct(candidate.priceChange24h)}</b>\n\n` +

    `<b>👥 Holders:</b>\n` +
    `Count: <b>${candidate.holders?.toLocaleString() ?? '?'}</b>  Top10: <b>${candidate.top10HolderPct?.toFixed(1) ?? '?'}%</b>  Dev: <b>${candidate.devWalletPct?.toFixed(1) ?? '?'}%</b>\n\n` +

    `<b>🛡 Safety:</b>\n` +
    `Bundle: <b>${candidate.bundleRisk ?? '?'}</b>  BubbleMap: <b>${candidate.bubbleMapRisk ?? '?'}</b>  Snipers: <b>${candidate.sniperWalletCount ?? '?'}</b>\n` +
    `Mint: ${mintFlag}  Freeze: ${freezeFlag}  LP: ${lpFlag}\n` +
    `Market: <b>${regime.market ?? '?'}</b>  Mode: <b>${botConfig.emoji} ${botConfig.name}</b>\n\n` +

    (walletSignal ? walletSignal + '\n\n' : '') +
    (sltpSection ? sltpSection + '\n\n' : '') +

    `<b>✅ Why It Passed:</b>\n${bullLines}\n\n` +
    `<b>⚠️ Watch:</b>\n${watchLines}\n\n` +

    `<b>Verdict:</b>\n${esc(vText)}\n` +
    preliminary +
    `<i>AI + onchain assisted. Manage your risk. NFA.</i>`
  );
}

// ─── Claude Analysis ──────────────────────────────────────────────────────────

const ANALYST_SYSTEM_PROMPT = `
You are an elite crypto intelligence analyst embedded inside an automated Solana caller bot.
Review the pre-computed analysis and write a final verdict.
The system has already run 4 sub-scorers, a trap detector, and wallet cluster analysis.

RESPONSE FORMAT — valid JSON only, no markdown, no backticks:
{
  "decision": "AUTO_POST | HOLD_FOR_REVIEW | IGNORE",
  "score": <integer 0-100>,
  "risk": "LOW | MEDIUM | HIGH | EXTREME",
  "setup_type": "CLEAN_STEALTH_LAUNCH | ORGANIC_EARLY | BREAKOUT_AFTER_SHAKEOUT | CONSOLIDATION_BREAKOUT | PULLBACK_OPPORTUNITY | STRONG_HOLDER_LOW_DEV | WHALE_SUPPORTED_ROTATION | BUNDLED_HIGH_RISK | EXTENDED_AVOID | STANDARD",
  "bull_case": ["<point>", "<point>", "<point>"],
  "red_flags": ["<point>", "<point>", "<point>"],
  "verdict": "<2-3 sentence analyst summary>",
  "notes": "<caveats, data gaps>",
  "confidence_reason": "<why this score>",
  "missing_data": ["<field>"],
  "key_metrics": {
    "holder_risk": "LOW | MEDIUM | HIGH | EXTREME",
    "contract_risk": "LOW | MEDIUM | HIGH | EXTREME",
    "wallet_risk": "LOW | MEDIUM | HIGH | EXTREME",
    "social_risk": "LOW | MEDIUM | HIGH | EXTREME",
    "entry_risk": "LOW | MEDIUM | HIGH | EXTREME"
  }
}
`.trim();

async function callClaude(candidate, scoreResult) {
  if (!CLAUDE_API_KEY) throw new Error('No CLAUDE_API_KEY');
  const scoreBrief = formatScoreForClaude(scoreResult);

  const msg = `${scoreBrief}\n\nToken: $${candidate.token}\nCA: ${candidate.contractAddress}\nMCap: ${fmt(candidate.marketCap)}\nLiq: ${fmt(candidate.liquidity)}\nVol24h: ${fmt(candidate.volume24h)}\nAge: ${candidate.pairAgeHours?.toFixed(1)}h\nHolders: ${candidate.holders}\nTop10: ${candidate.top10HolderPct?.toFixed(1)}%\nDev: ${candidate.devWalletPct?.toFixed(1)}%\nBundle: ${candidate.bundleRisk}\nBubbleMap: ${candidate.bubbleMapRisk}\nMint: ${candidate.mintAuthority === 0 ? 'REVOKED' : 'ACTIVE'}\nLP: ${candidate.lpLocked === 1 ? 'LOCKED' : 'UNLOCKED'}\n1h: ${pct(candidate.priceChange1h)}  6h: ${pct(candidate.priceChange6h)}  24h: ${pct(candidate.priceChange24h)}\n\nReturn only valid JSON.`;

  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1200, system: ANALYST_SYSTEM_PROMPT, messages: [{ role: 'user', content: msg }] }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const data  = await res.json();
  const raw   = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = raw.replace(/```json|```/gi, '').trim();
  return JSON.parse(clean);
}

// ─── Process One Candidate ────────────────────────────────────────────────────

async function processCandidate(candidate, botConfig) {
  const ca  = candidate.contractAddress;
  const tag = `[${botConfig.emoji}${botConfig.id}]`;
  if (!ca) return;

  try {
    // Full enrichment
    const enriched = candidate.birdeyeOk ? candidate : await enrichCandidate(candidate);

    // Wallet intel
    const intel = await runWalletIntel(enriched).catch(() => null);
    const withIntel = intel ? { ...enriched, ...flattenIntel(intel) } : enriched;

    // Score
    const scoreResult = computeFullScore(withIntel);
    const regimeAdj   = applyRegimeAdjustments(scoreResult.score, withIntel, scoreResult);
    scoreResult.regimeAdjustedScore = regimeAdj.adjustedScore;

    const finalScore = regimeAdj.adjustedScore;
    const threshold  = scoreResult.threshold + regimeAdj.thresholdAdjust + botConfig.thresholdAdjust;

    console.log(`${tag} $${withIntel.token ?? ca} — score:${scoreResult.score} regime:${finalScore} threshold:${threshold}`);

    if (finalScore < threshold) {
      recordSeen(ca, false);
      return;
    }

    if (scoreResult.trapDetector.severity === 'CRITICAL') {
      recordSeen(ca, false);
      return;
    }

    // Claude verdict
    const verdict = await callClaude(withIntel, scoreResult).catch(err => {
      console.warn(`${tag} Claude error:`, err.message);
      return null;
    });

    if (!verdict || verdict.decision === 'IGNORE') {
      recordSeen(ca, false);
      return;
    }

    // Compute SL/TP
    const sltp = computeSLTP(withIntel, scoreResult, botConfig);

    // Build and send call alert
    const callMsg = await buildCallAlert(withIntel, verdict, scoreResult, botConfig, sltp);
    await tgGroup(callMsg);

    // Send CA by itself (for planes/sect bots leaderboard tracking)
    await new Promise(r => setTimeout(r, 1500));
    await tgGroup(`<code>${esc(ca)}</code>`);

    // Mark seen cross-bot
    markSeenByBot(ca);
    recordSeen(ca, true);

    // Persist
    const candidateId = insertCandidate({
      ...withIntel,
      compositeScore:      scoreResult.score,
      structureGrade:      scoreResult.structureGrade,
      setupType:           verdict.setup_type ?? scoreResult.setupType,
      stage:               scoreResult.stage,
      trapTriggered:       scoreResult.trapDetector.triggered,
      trapSeverity:        scoreResult.trapDetector.severity,
      dynamicThreshold:    scoreResult.threshold,
      marketRegime:        getRegime().market,
      regimeAdjustedScore: finalScore,
      claudeScore:         verdict.score ?? scoreResult.score,
      claudeRisk:          verdict.risk ?? scoreResult.risk,
      claudeDecision:      verdict.decision,
      claudeSetupType:     verdict.setup_type,
      claudeVerdict:       verdict.verdict,
      claudeRaw:           JSON.stringify(verdict),
      finalDecision:       'AUTO_POST',
      posted:              true,
      botSource:           botConfig.id,
      sltp:                sltp ? JSON.stringify(sltp) : null,
    });

    insertSubScores(candidateId, ca, scoreResult);
    markCandidatePosted(candidateId);
    insertCall({
      candidateId, token: withIntel.token, contractAddress: ca,
      chain: 'solana', score: verdict.score ?? scoreResult.score,
      subScores: scoreResult.subScores, risk: verdict.risk ?? scoreResult.risk,
      setupType: verdict.setup_type ?? scoreResult.setupType,
      structureGrade: scoreResult.structureGrade,
      priceUsd: withIntel.priceUsd, marketCap: withIntel.marketCap,
      liquidity: withIntel.liquidity, marketRegime: getRegime().market,
      botSource: botConfig.id,
      sltp: sltp ? JSON.stringify(sltp) : null,
    });

    logEvent('INFO', `${botConfig.id}_POSTED`, `$${withIntel.token} score=${scoreResult.score}`);
    await tgAdmin(`${botConfig.emoji} ${botConfig.name} posted: <b>$${esc(withIntel.token ?? ca)}</b>\nScore: ${scoreResult.score}  Risk: ${verdict.risk}\n<code>${esc(ca)}</code>`);

    console.log(`${tag} ✅ POSTED — $${withIntel.token} score=${scoreResult.score}`);

  } catch (err) {
    console.error(`${tag} Error on ${ca}:`, err.message);
    logEvent('ERROR', `${botConfig.id}_ERROR`, `${ca}: ${err.message}`);
  }
}

function flattenIntel(intel) {
  if (!intel) return {};
  return {
    walletIntelScore:      intel.walletIntelScore ?? null,
    clusterRisk:           intel.clusterRisk ?? null,
    coordinationIntensity: intel.coordination?.intensity ?? null,
    momentumGrade:         intel.momentum?.momentumGrade ?? null,
    uniqueBuyers5min:      intel.momentum?.uniqueBuyers5min ?? null,
    buyVelocity:           intel.momentum?.buyVelocity ?? null,
    survivalScore:         intel.momentum?.survivalScore ?? null,
    deployerHistoryRisk:   intel.deployerProfile?.riskLevel === 'HIGH' ? 'FLAGGED'
      : intel.deployerProfile?.riskLevel === 'LOW' ? 'CLEAN' : null,
  };
}

// ─── Bot 1: New Coins ─────────────────────────────────────────────────────────

let newCoinsCycleRunning = false;

export async function runNewCoinsCycle() {
  if (newCoinsCycleRunning) return;
  newCoinsCycleRunning = true;
  const cfg = BOT_CONFIGS.NEW_COINS;
  console.log(`[${cfg.emoji}NEW_COINS] Cycle start`);

  try {
    const candidates = await runScanner(
      (ca) => isRecentlySeen(ca) || isSeenByAnyBot(ca),
      cfg
    );
    if (!candidates.length) { console.log(`[${cfg.emoji}NEW_COINS] No candidates`); return; }
    const enriched = await enrichCandidates(candidates, 1000);
    for (const c of enriched) await processCandidate(c, cfg);
  } catch (err) {
    console.error(`[${cfg.emoji}NEW_COINS] Cycle error:`, err.message);
  } finally {
    newCoinsCycleRunning = false;
  }
}

// ─── Bot 2: Trending ──────────────────────────────────────────────────────────

let trendingCycleRunning = false;

export async function runTrendingCycle() {
  if (trendingCycleRunning) return;
  trendingCycleRunning = true;
  const cfg = BOT_CONFIGS.TRENDING;
  console.log(`[${cfg.emoji}TRENDING] Cycle start`);

  try {
    const candidates = await runScanner(
      (ca) => isRecentlySeen(ca) || isSeenByAnyBot(ca),
      cfg
    );
    if (!candidates.length) { console.log(`[${cfg.emoji}TRENDING] No candidates`); return; }
    const enriched = await enrichCandidates(candidates, 1200);
    for (const c of enriched) await processCandidate(c, cfg);
  } catch (err) {
    console.error(`[${cfg.emoji}TRENDING] Cycle error:`, err.message);
  } finally {
    trendingCycleRunning = false;
  }
}

// ─── Bot 3: Wallet Bot ────────────────────────────────────────────────────────

export async function startWalletBot() {
  const cfg = BOT_CONFIGS.WALLET_BOT;
  console.log(`[${cfg.emoji}WALLET_BOT] Starting event-driven tracker`);

  walletTracker.on('wallet:buy', async (event) => {
    const { walletAddress, tokenAddress, tokenSymbol } = event;
    if (isSeenByAnyBot(tokenAddress) || isRecentlySeen(tokenAddress)) return;

    console.log(`[${cfg.emoji}WALLET_BOT] Smart wallet buy: ${walletAddress.slice(0,8)} → ${tokenSymbol ?? tokenAddress.slice(0,8)}`);

    try {
      // Fetch pair data for this token
      const pair = await fetchPairByAddress(tokenAddress);
      if (!pair) return;
      const base = normalizePair(pair);

      // Check token risk filter first
      const riskCheck = await checkTokenRisk(tokenAddress, {
        min_liquidity_usd:    cfg.minLiquidity,
        min_market_cap_usd:   cfg.minMarketCap,
        max_market_cap_usd:   cfg.maxMarketCap,
        min_volume_24h_usd:   cfg.minVolume24h,
        max_top10_holder_pct: 70,
        max_dev_wallet_pct:   20,
        require_mint_revoked: false,
        require_lp_locked:    false,
        block_bundle_risk:    'SEVERE',
      }, BIRDEYE_API_KEY).catch(() => null);

      if (riskCheck && !riskCheck.pass) {
        console.log(`[${cfg.emoji}WALLET_BOT] Risk filter failed: ${riskCheck.reason}`);
        return;
      }

      // Get smart wallet info for signal
      const wallet = await import('./wallet-tracker/db/client.js')
        .then(m => m.queryOne('SELECT label, trust_score, tier FROM wallets WHERE address = $1', [walletAddress]))
        .catch(() => null);

      const enriched = await enrichCandidate({
        ...base,
        walletSignalAddress:  walletAddress,
        walletSignalLabel:    wallet?.label ?? null,
        walletSignalScore:    wallet?.trust_score ?? null,
        walletSignalTier:     wallet?.tier ?? null,
        candidateType:        'WALLET_SIGNAL',
        notes:                [`Smart wallet ${walletAddress.slice(0,8)}… bought this`],
      });

      await processCandidate(enriched, cfg);

    } catch (err) {
      console.error(`[${cfg.emoji}WALLET_BOT] Error:`, err.message);
    }
  });
}

// ─── Orchestrator Init ────────────────────────────────────────────────────────

export async function startMultiBot() {
  console.log('═══════════════════════════════════════════');
  console.log('  MULTI-BOT v5 — 3 Simultaneous Scanners');
  console.log('  🚀 New Coins  📈 Trending  👁 Wallet Bot');
  console.log('═══════════════════════════════════════════');

  // Start interval-based bots with staggered starts
  setTimeout(() => {
    runNewCoinsCycle();
    setInterval(runNewCoinsCycle, BOT_CONFIGS.NEW_COINS.intervalMs);
  }, 5_000);

  setTimeout(() => {
    runTrendingCycle();
    setInterval(runTrendingCycle, BOT_CONFIGS.TRENDING.intervalMs);
  }, 30_000);

  // Start wallet bot (event-driven)
  setTimeout(startWalletBot, 15_000);

  await tgAdmin(
    '🤖 <b>Multi-Bot v5 Online</b>\n' +
    '🚀 New Coins (2min)\n' +
    '📈 Trending (3min)\n' +
    '👁 Wallet Bot (real-time)\n' +
    'All 3 active and posting.'
  );

  logEvent('INFO', 'MULTI_BOT_START', '3 bots initialized');
}
