/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  modules/token-risk-filter.js — Pre-Sniper Token Risk Validation
 *
 *  Every potential copy-trade must pass this filter before execution.
 *  Uses cached risk data when fresh (<5 min), otherwise re-fetches from
 *  Birdeye + Helius + BubbleMap.
 *
 *  Returns: { pass: boolean, reason: string, riskLevel: string, data: object }
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import { query, queryOne, logEvent } from '../db/client.js';

const BIRDEYE_BASE   = 'https://public-api.birdeye.so';
const BUBBLEMAP_BASE = 'https://api-legacy.bubblemaps.io';
const CACHE_TTL_MS   = 5 * 60 * 1000;  // 5 minutes

const BUNDLE_ORDER = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'SEVERE'];
function bundleIndex(level) {
  return BUNDLE_ORDER.indexOf(level ?? 'NONE');
}

// ─── Fetch Helpers ────────────────────────────────────────────────────────────

async function safeFetch(url, options = {}, label = '') {
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchTokenData(tokenAddress, birdeyeKey) {
  const headers = {
    'X-API-KEY': birdeyeKey,
    'x-chain':   'solana',
    'Accept':    'application/json',
  };

  const [overview, security, bubble] = await Promise.all([
    safeFetch(`${BIRDEYE_BASE}/defi/token_overview?address=${tokenAddress}`, { headers }, 'overview'),
    safeFetch(`${BIRDEYE_BASE}/defi/token_security?address=${tokenAddress}`, { headers }, 'security'),
    safeFetch(`${BUBBLEMAP_BASE}/map-metadata?token=${tokenAddress}&chain=sol`, {}, 'bubblemap'),
  ]);

  const result = {
    tokenAddress,
    liquidityUsd:      null,
    marketCapUsd:      null,
    volume24h:         null,
    holders:           null,
    top10HolderPct:    null,
    devWalletPct:      null,
    mintAuthority:     null,
    freezeAuthority:   null,
    lpLocked:          null,
    bundleRisk:        null,
    bubbleMapRisk:     null,
    priceUsd:          null,
    birdeyeOk:         false,
    bubblemapOk:       false,
  };

  if (overview?.data) {
    const d = overview.data;
    result.liquidityUsd   = d.liquidity ?? d.realLiquidity ?? null;
    result.marketCapUsd   = d.mc ?? d.fdv ?? null;
    result.volume24h      = d.v24hUSD ?? d.v24h ?? null;
    result.holders        = d.holder ?? null;
    result.priceUsd       = d.price ?? null;
    result.birdeyeOk      = true;
  }

  if (security?.data) {
    const s = security.data;
    result.birdeyeOk      = true;
    if (s.top10HolderPercent != null) result.top10HolderPct = s.top10HolderPercent * 100;
    if (s.creatorPercentage  != null) result.devWalletPct   = s.creatorPercentage  * 100;
    else if (s.ownerPercentage != null) result.devWalletPct = s.ownerPercentage    * 100;
    result.mintAuthority   = s.isMutable        ? 1 : 0;
    result.freezeAuthority = s.freezeAuthority  ? 1 : 0;
    result.lpLocked        = s.lpBurned         ? 1 : 0;
  }

  if (bubble && !bubble.error) {
    result.bubblemapOk = true;
    const score = bubble.decentralizationScore ?? null;
    if (score !== null) {
      result.bubbleMapRisk = score >= 70 ? 'CLEAN'
        : score >= 50 ? 'MODERATE'
        : score >= 30 ? 'CLUSTERED'
        : 'SEVERE';
    }

    if (bubble.clusters?.length) {
      const insiders = bubble.clusters.filter(c => c.isInsider || c.type === 'insider');
      const insiderPct = insiders.reduce((s, c) => s + (c.percentage ?? 0), 0);
      if (insiderPct > 0 && result.top10HolderPct == null) result.top10HolderPct = insiderPct;
    }
  }

  return result;
}

// ─── Risk Scoring ─────────────────────────────────────────────────────────────

function computeRiskScore(data) {
  let risk = 0;
  const reasons = [];

  if ((data.top10HolderPct ?? 0) > 50) { risk += 30; reasons.push(`top10=${data.top10HolderPct?.toFixed(1)}%`); }
  if ((data.devWalletPct ?? 0) > 15)   { risk += 25; reasons.push(`dev=${data.devWalletPct?.toFixed(1)}%`); }
  if (data.mintAuthority === 1)         { risk += 25; reasons.push('mint_active'); }
  if (data.freezeAuthority === 1)       { risk += 20; reasons.push('freeze_active'); }
  if (data.lpLocked === 0)              { risk += 15; reasons.push('lp_unlocked'); }
  if (data.bubbleMapRisk === 'SEVERE')  { risk += 30; reasons.push('bubble_severe'); }
  if (data.bubbleMapRisk === 'CLUSTERED') { risk += 15; reasons.push('bubble_clustered'); }
  if ((data.liquidityUsd ?? 0) < 5000) { risk += 20; reasons.push('low_liq'); }

  const level = risk >= 80 ? 'EXTREME'
    : risk >= 50 ? 'HIGH'
    : risk >= 25 ? 'MEDIUM'
    : 'LOW';

  return { riskScore: Math.min(100, risk), riskLevel: level, riskReasons: reasons };
}

// ─── Cache Layer ──────────────────────────────────────────────────────────────

async function getCachedRisk(tokenAddress) {
  const row = await queryOne(
    `SELECT * FROM token_risk_cache WHERE token_address = $1 AND expires_at > NOW()`,
    [tokenAddress]
  );
  return row;
}

async function persistRiskCache(data, riskScore, riskLevel, passedFilter, failReason) {
  await query(
    `INSERT INTO token_risk_cache
       (token_address, token_symbol, liquidity_usd, market_cap_usd, volume_24h_usd,
        holders, top10_holder_pct, dev_wallet_pct, mint_authority, freeze_authority,
        lp_locked, bundle_risk, bubble_map_risk, risk_score, risk_level,
        passed_filter, filter_fail_reason, price_usd, price_at_check, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,
             NOW() + INTERVAL '5 minutes')
     ON CONFLICT (token_address) DO UPDATE SET
       liquidity_usd      = EXCLUDED.liquidity_usd,
       market_cap_usd     = EXCLUDED.market_cap_usd,
       volume_24h_usd     = EXCLUDED.volume_24h_usd,
       holders            = EXCLUDED.holders,
       top10_holder_pct   = EXCLUDED.top10_holder_pct,
       dev_wallet_pct     = EXCLUDED.dev_wallet_pct,
       mint_authority     = EXCLUDED.mint_authority,
       freeze_authority   = EXCLUDED.freeze_authority,
       lp_locked          = EXCLUDED.lp_locked,
       bundle_risk        = EXCLUDED.bundle_risk,
       bubble_map_risk    = EXCLUDED.bubble_map_risk,
       risk_score         = EXCLUDED.risk_score,
       risk_level         = EXCLUDED.risk_level,
       passed_filter      = EXCLUDED.passed_filter,
       filter_fail_reason = EXCLUDED.filter_fail_reason,
       price_usd          = EXCLUDED.price_usd,
       price_at_check     = EXCLUDED.price_at_check,
       expires_at         = NOW() + INTERVAL '5 minutes',
       checked_at         = NOW()`,
    [
      data.tokenAddress, data.tokenSymbol ?? null,
      data.liquidityUsd, data.marketCapUsd, data.volume24h,
      data.holders, data.top10HolderPct, data.devWalletPct,
      data.mintAuthority, data.freezeAuthority, data.lpLocked,
      data.bundleRisk, data.bubbleMapRisk,
      riskScore, riskLevel, passedFilter, failReason,
      data.priceUsd,
    ]
  );
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Check if a token passes the risk filter before sniper execution.
 *
 * @param {string} tokenAddress
 * @param {object} settings — sniper_settings row
 * @param {string} birdeyeKey
 * @returns {Promise<{ pass: boolean, reason: string|null, riskLevel: string, data: object }>}
 */
export async function checkTokenRisk(tokenAddress, settings, birdeyeKey) {
  // ── Hard blacklist check ────────────────────────────────────────────────────
  const blacklisted = await queryOne(
    'SELECT reason FROM token_blacklist WHERE address = $1',
    [tokenAddress]
  );
  if (blacklisted) {
    return {
      pass: false,
      reason: `Blacklisted: ${blacklisted.reason ?? 'no reason'}`,
      riskLevel: 'EXTREME',
      data: {},
    };
  }

  // ── Cache hit ───────────────────────────────────────────────────────────────
  const cached = await getCachedRisk(tokenAddress);
  if (cached) {
    const pass = applyFilterRules(cached, settings);
    return {
      pass: pass.pass,
      reason: pass.reason,
      riskLevel: cached.risk_level,
      data: cached,
      fromCache: true,
    };
  }

  // ── Fresh fetch ─────────────────────────────────────────────────────────────
  const data = await fetchTokenData(tokenAddress, birdeyeKey);
  const { riskScore, riskLevel, riskReasons } = computeRiskScore(data);
  const pass = applyFilterRules(
    {
      liquidity_usd:    data.liquidityUsd,
      market_cap_usd:   data.marketCapUsd,
      volume_24h_usd:   data.volume24h,
      holders:          data.holders,
      top10_holder_pct: data.top10HolderPct,
      dev_wallet_pct:   data.devWalletPct,
      mint_authority:   data.mintAuthority,
      freeze_authority: data.freezeAuthority,
      lp_locked:        data.lpLocked,
      bundle_risk:      data.bundleRisk,
      bubble_map_risk:  data.bubbleMapRisk,
      risk_level:       riskLevel,
    },
    settings
  );

  await persistRiskCache(data, riskScore, riskLevel, pass.pass, pass.reason);
  await logEvent(
    pass.pass ? 'INFO' : 'WARN',
    pass.pass ? 'RISK_FILTER_PASS' : 'RISK_FILTER_FAIL',
    `${tokenAddress.slice(0,8)}… risk=${riskLevel}${pass.reason ? ` reason=${pass.reason}` : ''}`,
    { tokenAddress, riskScore, riskLevel, riskReasons }
  );

  return { pass: pass.pass, reason: pass.reason, riskLevel, data };
}

/**
 * Apply filter rules from sniper settings to token risk data.
 * @param {object} tokenData — from cache or fresh fetch (snake_case keys)
 * @param {object} settings  — sniper_settings row
 */
function applyFilterRules(tokenData, settings) {
  const liq      = Number(tokenData.liquidity_usd   ?? 0);
  const mcap     = Number(tokenData.market_cap_usd  ?? 0);
  const vol24h   = Number(tokenData.volume_24h_usd  ?? 0);
  const top10    = Number(tokenData.top10_holder_pct ?? 0);
  const devPct   = Number(tokenData.dev_wallet_pct  ?? 0);
  const mint     = tokenData.mint_authority;
  const freeze   = tokenData.freeze_authority;
  const lpLocked = tokenData.lp_locked;
  const bundle   = tokenData.bundle_risk;
  const bubble   = tokenData.bubble_map_risk;

  if (liq < Number(settings.min_liquidity_usd))
    return fail(`Liquidity $${liq.toFixed(0)} < $${settings.min_liquidity_usd}`);

  if (mcap > 0 && mcap < Number(settings.min_market_cap_usd))
    return fail(`Market cap $${mcap.toFixed(0)} < $${settings.min_market_cap_usd}`);

  if (mcap > Number(settings.max_market_cap_usd))
    return fail(`Market cap $${(mcap/1e6).toFixed(1)}M > max $${(settings.max_market_cap_usd/1e6).toFixed(1)}M`);

  if (vol24h < Number(settings.min_volume_24h_usd))
    return fail(`Volume $${vol24h.toFixed(0)} < $${settings.min_volume_24h_usd}`);

  if (top10 > Number(settings.max_top10_holder_pct))
    return fail(`Top10 holders ${top10.toFixed(1)}% > ${settings.max_top10_holder_pct}%`);

  if (devPct > Number(settings.max_dev_wallet_pct))
    return fail(`Dev wallet ${devPct.toFixed(1)}% > ${settings.max_dev_wallet_pct}%`);

  if (settings.require_mint_revoked && mint === 1)
    return fail('Mint authority active — required revoked');

  if (freeze === 1)
    return fail('Freeze authority active');

  if (settings.require_lp_locked && lpLocked === 0)
    return fail('LP not locked — required locked');

  if (bubble === 'SEVERE')
    return fail('BubbleMap SEVERE — extreme insider control');

  if (bundle && settings.block_bundle_risk) {
    if (bundleIndex(bundle) >= bundleIndex(settings.block_bundle_risk))
      return fail(`Bundle risk ${bundle} >= block threshold ${settings.block_bundle_risk}`);
  }

  return { pass: true, reason: null };
}

function fail(reason) {
  return { pass: false, reason };
}

/**
 * Blacklist a token address.
 */
export async function blacklistToken(address, reason, addedBy = 'system') {
  await query(
    `INSERT INTO token_blacklist (address, reason, added_by)
     VALUES ($1, $2, $3) ON CONFLICT (address) DO UPDATE SET reason = $2`,
    [address, reason, addedBy]
  );
  // Invalidate cache
  await query('DELETE FROM token_risk_cache WHERE token_address = $1', [address]);
}

/**
 * Remove token from blacklist.
 */
export async function unblacklistToken(address) {
  await query('DELETE FROM token_blacklist WHERE address = $1', [address]);
}
