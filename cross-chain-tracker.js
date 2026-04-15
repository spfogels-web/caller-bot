// ─────────────────────────────────────────────────────────────────────────────
// cross-chain-tracker.js
//
// Watches trending tokens on Ethereum + Base via DexScreener's public token
// profile feed and matches them (by symbol + fuzzy name) against recent Solana
// candidates. When a Solana token's symbol/name closely matches a trending
// ETH/Base token, we flag the match in crosschain_matches — the Solana token
// may be a memecoin migrating to Solana (historically a strong pattern).
//
// No image matching in v1 (OpenCV is out of scope for Node; would use sharp +
// perceptual hashing if we add it later). Name/symbol fuzzy match alone has
// proven predictive on major migrations like PEPE, WIF, POPCAT, BONK copies.
// ─────────────────────────────────────────────────────────────────────────────

const TICK_MS          = 5 * 60_000;  // 5 min — DexScreener trending shifts slowly
const SOLANA_WINDOW_H  = 4;           // match against Solana tokens seen in last 4h
const MATCH_MIN_LEN    = 3;           // ignore tokens with symbol < 3 chars
const REQUEST_TIMEOUT  = 9_000;

let _handle = null;
let _ticks  = 0;
let _matches = 0;

// Simple Levenshtein-based similarity (0-1). Good enough for ticker/name matching.
function similarity(a, b) {
  if (!a || !b) return 0;
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(a, b);
  return 1 - (dist / maxLen);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}

async function fetchTrending(chain) {
  // DexScreener's public profile feed covers all chains
  try {
    const r = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!r.ok) return [];
    const profiles = await r.json();
    if (!Array.isArray(profiles)) return [];
    // Filter to the requested chain
    return profiles.filter(p => (p.chainId || '').toLowerCase() === chain);
  } catch (err) {
    console.warn(`[crosschain] fetch trending ${chain} failed:`, err.message);
    return [];
  }
}

async function enrichWithPrices(profiles) {
  // Pull current prices via token lookup (batched 30 at a time)
  const out = [];
  for (let i = 0; i < profiles.length; i += 30) {
    const batch = profiles.slice(i, i + 30);
    const cas = batch.map(p => p.tokenAddress).filter(Boolean).join(',');
    if (!cas) continue;
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${cas}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (!r.ok) continue;
      const j = await r.json();
      for (const p of (j?.pairs || [])) {
        const change24h = p.priceChange?.h24;
        if (change24h > 0) out.push({
          tokenAddress: p.baseToken?.address,
          symbol:       p.baseToken?.symbol,
          name:         p.baseToken?.name,
          priceChange24h: change24h,
          chainId:      p.chainId,
        });
      }
    } catch {}
  }
  return out;
}

async function runTick(dbInstance) {
  try {
    const [ethProfiles, baseProfiles] = await Promise.all([
      fetchTrending('ethereum'),
      fetchTrending('base'),
    ]);
    const allProfiles = [...ethProfiles, ...baseProfiles].slice(0, 100);
    if (!allProfiles.length) return;

    const trending = await enrichWithPrices(allProfiles);
    // Only consider ones up at least 30% in 24h (trending up)
    const hot = trending.filter(t => (t.priceChange24h || 0) >= 30 && (t.symbol || '').length >= MATCH_MIN_LEN);
    if (!hot.length) { _ticks++; return; }

    // Recent Solana candidates to match against.
    // `candidates` has `token` (symbol) but not `token_name` — that column
    // lives on scanner_feed. Pull from both so we can match on either field.
    const solRows = dbInstance.prepare(`
      SELECT c.contract_address,
             c.token,
             sf.token      AS scanner_token,
             sf.contract_address AS sf_ca
      FROM candidates c
      LEFT JOIN scanner_feed sf ON sf.contract_address = c.contract_address
      WHERE c.contract_address IS NOT NULL
        AND c.evaluated_at > datetime('now', ?)
    `).all(`-${SOLANA_WINDOW_H} hours`).map(r => ({
      contract_address: r.contract_address,
      token:      r.token,
      token_name: r.scanner_token || r.token, // fallback to symbol if no name
    }));

    let found = 0;
    for (const sol of solRows) {
      for (const eth of hot) {
        const symSim  = similarity(sol.token, eth.symbol);
        const nameSim = similarity(sol.token_name || '', eth.name || '');
        const best    = Math.max(symSim, nameSim);
        if (best < 0.82) continue; // strict threshold — avoid noise
        const matchType = symSim >= 0.95 ? 'exact' : (symSim >= nameSim ? 'symbol' : 'name');
        try {
          // Upsert-ish (unique constraint would need schema change; we just
          // dedupe by checking existence first)
          const exists = dbInstance.prepare(
            `SELECT id FROM crosschain_matches WHERE sol_contract=? AND source_contract=?`
          ).get(sol.contract_address, eth.tokenAddress);
          if (exists) continue;
          dbInstance.prepare(`
            INSERT INTO crosschain_matches
              (sol_contract, source_chain, source_contract, match_type,
               match_confidence, source_symbol, source_price_change)
            VALUES (?,?,?,?,?,?,?)
          `).run(
            sol.contract_address, eth.chainId, eth.tokenAddress,
            matchType, best, eth.symbol, eth.priceChange24h,
          );
          found++;
          _matches++;
        } catch {}
      }
    }
    _ticks++;
    if (found) console.log(`[crosschain] tick ${_ticks} — ${found} new migration match(es)`);
  } catch (err) {
    console.warn('[crosschain] tick error:', err.message);
  }
}

export function startCrossChainTracker(dbInstance, intervalMs = TICK_MS) {
  if (_handle) return _handle;
  console.log(`[crosschain] starting — tick ${intervalMs/60000} min, ETH + Base`);
  setTimeout(() => runTick(dbInstance).catch(() => {}), 60_000);
  _handle = setInterval(() => runTick(dbInstance).catch(() => {}), intervalMs);
  return _handle;
}

export function getCrossChainMatch(solContract, dbInstance) {
  if (!solContract || !dbInstance) return null;
  try {
    return dbInstance.prepare(
      `SELECT * FROM crosschain_matches WHERE sol_contract=? ORDER BY match_confidence DESC LIMIT 1`
    ).get(solContract) || null;
  } catch { return null; }
}

export function getCrossChainStats() { return { ticks: _ticks, matches: _matches }; }
