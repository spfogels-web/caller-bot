/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  x-api.js — X (Twitter) API v2 integration
 *
 *  Lets us:
 *   1. Look up a coin's Twitter handle profile (followers / age / verified)
 *   2. Search recent tweets mentioning a CA or ticker
 *   3. Get tweet-volume counts over the last 7 days for a query
 *
 *  Usage budget controls:
 *   - X_DAILY_REQUEST_LIMIT env var (default 200) — hard cap, when hit
 *     the module starts refusing requests for the rest of the day
 *   - Per-resource caches: profile=30min, search=15min, counts=15min
 *   - Stats counter so the dashboard can show today's burn rate
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const X_API_BASE = 'https://api.x.com/2';

// Per-resource cache TTLs
const PROFILE_CACHE_MS = 30 * 60 * 1000;
const SEARCH_CACHE_MS  = 15 * 60 * 1000;
const COUNTS_CACHE_MS  = 15 * 60 * 1000;

const _profileCache = new Map();   // username → { at, data }
const _searchCache  = new Map();   // query    → { at, data }
const _countsCache  = new Map();   // query    → { at, data }

let _stats = {
  requestsTotal:  0,
  requestsToday:  0,
  lastDayKey:     null,
  hits:           { profile: 0, search: 0, counts: 0 },
  cacheHits:      { profile: 0, search: 0, counts: 0 },
  errors:         0,
  rateLimited:    0,
  budgetBlocked:  0,
  lastError:      null,
};

function _todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function _bumpRequestCounter() {
  const k = _todayKey();
  if (_stats.lastDayKey !== k) {
    _stats.requestsToday = 0;
    _stats.lastDayKey = k;
  }
  _stats.requestsToday++;
  _stats.requestsTotal++;
}
function _budget() {
  return Number(process.env.X_DAILY_REQUEST_LIMIT) || 200;
}
function _withinBudget() {
  const k = _todayKey();
  if (_stats.lastDayKey !== k) {
    _stats.requestsToday = 0;
    _stats.lastDayKey = k;
  }
  return _stats.requestsToday < _budget();
}
function _bearer() {
  return process.env.X_BEARER_TOKEN || null;
}

async function _xFetch(path, params = {}, timeoutMs = 8_000) {
  const token = _bearer();
  if (!token) {
    _stats.lastError = 'X_BEARER_TOKEN not set';
    return { ok: false, error: 'no_token' };
  }
  if (!_withinBudget()) {
    _stats.budgetBlocked++;
    return { ok: false, error: 'daily_budget_exhausted' };
  }
  const url = new URL(`${X_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  try {
    const res = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'pulse-caller/1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    _bumpRequestCounter();
    if (res.status === 429) {
      _stats.rateLimited++;
      _stats.lastError = 'rate_limited';
      return { ok: false, error: 'rate_limited', status: 429 };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      _stats.errors++;
      _stats.lastError = `${res.status}: ${body.slice(0, 200)}`;
      return { ok: false, error: 'http_error', status: res.status, body: body.slice(0, 400) };
    }
    const json = await res.json();
    return { ok: true, data: json };
  } catch (err) {
    _stats.errors++;
    _stats.lastError = err.message;
    return { ok: false, error: err.message };
  }
}

// ─── Profile lookup by username ───────────────────────────────────────────────
//   Returns null on failure (caller treats absence as "no Twitter info").
//   Cache: 30min per username.
export async function getUserByUsername(handle) {
  if (!handle) return null;
  const u = String(handle).replace(/^@/, '').trim();
  if (!u || u.length > 32) return null;
  const now = Date.now();
  const cached = _profileCache.get(u);
  if (cached && now - cached.at < PROFILE_CACHE_MS) {
    _stats.cacheHits.profile++;
    return cached.data;
  }
  const result = await _xFetch(`/users/by/username/${encodeURIComponent(u)}`, {
    'user.fields': 'public_metrics,verified,verified_type,created_at,description,profile_image_url',
  });
  _stats.hits.profile++;
  if (!result.ok) return null;
  const user = result.data?.data ?? null;
  if (!user) return null;
  const profile = {
    id:          user.id,
    username:    user.username,
    name:        user.name,
    description: user.description ?? '',
    verified:    user.verified === true,
    verifiedType: user.verified_type ?? null,  // 'blue' | 'business' | 'government'
    createdAt:   user.created_at ?? null,
    followers:   user.public_metrics?.followers_count ?? 0,
    following:   user.public_metrics?.following_count ?? 0,
    tweetCount:  user.public_metrics?.tweet_count ?? 0,
    listedCount: user.public_metrics?.listed_count ?? 0,
    profileImageUrl: user.profile_image_url ?? null,
  };
  _profileCache.set(u, { at: now, data: profile });
  return profile;
}

// ─── Tweet volume counts (last 7d) for a query ───────────────────────────────
//   Useful for "narrative heat" signal: how many tweets/day mention this CA?
//   Cache: 15min.
export async function getTweetVolumeRecent(query) {
  if (!query) return null;
  const q = String(query).trim();
  if (!q) return null;
  const now = Date.now();
  const cached = _countsCache.get(q);
  if (cached && now - cached.at < COUNTS_CACHE_MS) {
    _stats.cacheHits.counts++;
    return cached.data;
  }
  const result = await _xFetch('/tweets/counts/recent', {
    query: q,
    granularity: 'day',
  });
  _stats.hits.counts++;
  if (!result.ok) return null;
  const buckets = result.data?.data ?? [];
  const total   = result.data?.meta?.total_tweet_count ?? 0;
  const summary = {
    total7d: total,
    days:    buckets.map(b => ({ start: b.start, end: b.end, count: b.tweet_count ?? 0 })),
    avgDay:  buckets.length ? Math.round(total / buckets.length) : 0,
    peakDay: buckets.reduce((m, b) => Math.max(m, b.tweet_count ?? 0), 0),
  };
  _countsCache.set(q, { at: now, data: summary });
  return summary;
}

// ─── Recent tweet search ──────────────────────────────────────────────────────
//   Returns up to `max` recent tweets matching the query. Cache: 15min.
export async function searchTweets(query, max = 10) {
  if (!query) return [];
  const q = String(query).trim();
  const cacheKey = `${q}|${max}`;
  const now = Date.now();
  const cached = _searchCache.get(cacheKey);
  if (cached && now - cached.at < SEARCH_CACHE_MS) {
    _stats.cacheHits.search++;
    return cached.data;
  }
  const result = await _xFetch('/tweets/search/recent', {
    query: q,
    max_results: Math.min(100, Math.max(10, max)),
    'tweet.fields': 'created_at,public_metrics,author_id,lang',
    'expansions':   'author_id',
    'user.fields':  'username,name,public_metrics,verified',
  });
  _stats.hits.search++;
  if (!result.ok) return [];
  const tweets = result.data?.data ?? [];
  const users  = new Map((result.data?.includes?.users ?? []).map(u => [u.id, u]));
  const out = tweets.map(t => ({
    id:        t.id,
    text:      t.text,
    createdAt: t.created_at,
    metrics:   t.public_metrics ?? {},
    author:    users.get(t.author_id) ?? null,
  }));
  _searchCache.set(cacheKey, { at: now, data: out });
  return out;
}

// Helper: formatted age in days/years from ISO string
export function fmtAccountAge(createdAt) {
  if (!createdAt) return '?';
  const ms = Date.now() - new Date(createdAt).getTime();
  const days = ms / 86_400_000;
  if (days < 30)  return Math.floor(days) + 'd';
  if (days < 365) return Math.floor(days / 30) + 'mo';
  const years = days / 365;
  return years.toFixed(1) + 'y';
}

export function getXApiStats() {
  return {
    ..._stats,
    dailyBudget:  _budget(),
    requestsLeft: Math.max(0, _budget() - _stats.requestsToday),
    bearerSet:    !!_bearer(),
  };
}
