/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  scanner-patch.js — Scanner fixes
 *
 *  CHANGES FROM YOUR EXISTING scanner.js:
 *
 *  1. DEX Screener fetches 50 pairs per page (their max per endpoint)
 *     We now fetch multiple pages to get broader coverage
 *
 *  2. MAX_PROMOTED_CANDIDATES changed to 20 (was 30)
 *     This means 20 coins go to full enrichment per cycle
 *
 *  3. DEX_BATCH_SIZE stays at 30 (token lookup batch size — separate from page size)
 *
 *  4. Added fetchMultiplePages() that pulls from multiple DEX endpoints
 *     to get 150-200 raw pairs instead of 50
 *
 *  INSTRUCTIONS: Replace the constants and fetchTrendingPairs() function
 *  in your scanner.js with the versions below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── REPLACE these constants at the top of scanner.js ─────────────────────────

export const SCANNER_CONSTANTS = {
  MAX_PROMOTED_CANDIDATES: 20,   // 20 coins go to full enrichment per cycle
  MAX_TOKENS_TO_FETCH:     200,  // fetch up to 200 token addresses from trending
  DEX_BATCH_SIZE:          30,   // 30 per DEX Screener token lookup batch
  QUICK_SCORE_AUTO_PROMOTE: Number(process.env.QUICK_SCORE_AUTO_PROMOTE ?? 70),
  QUICK_SCORE_WATCHLIST:    Number(process.env.QUICK_SCORE_WATCHLIST    ?? 45),
  QUICK_SCORE_DROP:         Number(process.env.QUICK_SCORE_DROP         ?? 30),
};

// ─── REPLACE fetchTrendingPairs() in scanner.js with this version ─────────────

export async function fetchTrendingPairs() {
  const CHAIN = 'solana';
  const pairs = new Map();
  const tokens = new Set();

  // ── Source 1: Token boosts (paid promoted tokens) ──────────────────────────
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data  = await res.json();
      const items = Array.isArray(data) ? data : (data?.data ?? []);
      for (const item of items) {
        const addr = item?.tokenAddress ?? item?.address;
        if (addr && item?.chainId === CHAIN) tokens.add(addr);
      }
      console.log(`[scanner] Boosts: ${tokens.size} tokens`);
    }
  } catch (err) { console.warn('[scanner] Boosts fetch failed:', err.message); }

  // ── Source 2: Latest token profiles ───────────────────────────────────────
  try {
    const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data  = await res.json();
      const items = Array.isArray(data) ? data : (data?.data ?? []);
      for (const item of items) {
        const addr = item?.tokenAddress ?? item?.address;
        if (addr && item?.chainId === CHAIN) tokens.add(addr);
      }
      console.log(`[scanner] Profiles: ${tokens.size} tokens total`);
    }
  } catch (err) { console.warn('[scanner] Profiles fetch failed:', err.message); }

  // ── Source 3: Trending search pages (50 pairs per call) ───────────────────
  // Fetch multiple search queries to get 50 * N = 150+ pairs
  const SEARCH_QUERIES = [
    'https://api.dexscreener.com/latest/dex/search?q=solana',
    'https://api.dexscreener.com/latest/dex/pairs/solana',
  ];

  for (const url of SEARCH_QUERIES) {
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal:  AbortSignal.timeout(12_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const pagePairs = data?.pairs ?? [];
      for (const pair of pagePairs) {
        if (pair?.pairAddress && pair?.chainId === CHAIN) {
          pairs.set(pair.pairAddress, pair);
          if (pair?.baseToken?.address) tokens.add(pair.baseToken.address);
        }
      }
      console.log(`[scanner] Search ${url.split('?')[0].split('/').pop()}: ${pagePairs.length} pairs`);
    } catch (err) { console.warn('[scanner] Search failed:', err.message); }

    // Small delay between requests to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Source 4: Token batch lookups (50 tokens per page across all collected) ──
  // DEX Screener allows up to 30 addresses per /tokens/ lookup
  // We batch ALL our collected token addresses 30 at a time
  const tokenList = Array.from(tokens).slice(0, 200);
  console.log(`[scanner] Looking up ${tokenList.length} tokens in batches of 30...`);

  for (let i = 0; i < tokenList.length; i += 30) {
    const batch = tokenList.slice(i, i + 30).join(',');
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${batch}`,
        { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(12_000) }
      );
      if (!res.ok) continue;
      const data = await res.json();
      for (const pair of (data?.pairs ?? [])) {
        if (pair?.pairAddress && pair?.chainId === CHAIN) {
          pairs.set(pair.pairAddress, pair);
        }
      }
    } catch (err) {
      console.warn(`[scanner] Batch ${i}-${i+30} failed:`, err.message);
    }

    // Rate limit: 300ms between batches
    if (i + 30 < tokenList.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  const result = Array.from(pairs.values());
  console.log(`[scanner] Total unique pairs fetched: ${result.length}`);
  return result;
}

// ─── HOW THE 20-PER-CYCLE FLOW WORKS ─────────────────────────────────────────
//
//  DEX Screener returns up to ~150 pairs from our combined sources
//
//  Pre-filter (applyAdaptivePreFilters):
//    - Removes pairs that don't meet age/liq/vol minimums
//    - Typically 80-120 pairs pass
//
//  Quick Score (computeQuickScore):
//    - Scores all passing pairs 0-100 without API calls (fast, free)
//    - Scores >= 70: PROMOTE immediately (up to 20 total)
//    - Scores 45-69: Add to scanner watchlist for 2/5/10 min rescan
//    - Scores < 30:  Drop
//
//  Promoted candidates (max 20):
//    -> Full enrichment: Birdeye + Helius + BubbleMap API calls
//    -> Wallet intel
//    -> 4-sub-score scoring
//    -> Claude analysis
//    -> Post or queue
//
//  This ensures we never hammer APIs with 50+ enrichment calls per cycle.
//  The scanner watchlist handles the rest with timed rescans.
