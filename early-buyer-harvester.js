/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  early-buyer-harvester.js — daily early-buyer sweep on $250K+ winners
 *
 *  Where midcap-harvester pulls TOP HOLDERS (current snapshot — often dev,
 *  LP, snipers, bag-holders), this harvester pulls EARLY BUYERS (the first
 *  ~100 wallets that swapped the coin). Those are the wallets that found
 *  the alpha before the run, which is what we actually want to track.
 *
 *  Source data: midcap_harvest_log (populated twice-daily by midcap-harvester
 *  with every $250K+ 24h-volume Solana coin). We process each new entry
 *  exactly once via the early_buyer_log gate.
 *
 *  Flow (every 24h after a 15-min boot delay):
 *   1. Pull mints added to midcap_harvest_log in the last 7 days that don't
 *      yet have a row in early_buyer_log.
 *   2. For each mint, hit Helius Enhanced /v0/addresses/{MINT}/transactions
 *      with ?type=SWAP and walk the `before` cursor BACKWARDS (latest →
 *      earliest) until we hit the coin's birth (a batch <100) or a page cap.
 *   3. The LAST batch contains the earliest swaps. Extract buyer addresses
 *      from tokenTransfers (mint matches, tokenAmount > 0, toUserAccount).
 *   4. Drop the first 3 buyers (dev + immediate sniper bots).
 *   5. SOL-tier filter (≥1 SOL via classifyAllBySol) → upsert into
 *      tracked_wallets as source='early-buyer-harvester'.
 *   6. Stamp early_buyer_log so we never re-process the same coin.
 *
 *  Budget: 50 coins/day max per tick, ~10-30 Helius Enhanced calls per coin
 *  (depends on coin age). Slow-paced — twice the inter-coin delay of midcap
 *  to stay friendly with Helius rate limits.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const HELIUS_ENHANCED = (mint, key, before, type = 'SWAP', limit = 100) => {
  const params = new URLSearchParams({ 'api-key': key, type, limit: String(limit) });
  if (before) params.set('before', before);
  return `https://api.helius.xyz/v0/addresses/${mint}/transactions?${params.toString()}`;
};

const TICK_MS               = 12 * 60 * 60 * 1000;   // every 12h — matches midcap-harvester cadence
const BOOT_DELAY_MS         = 15 * 60 * 1000;        // 15 min after boot
const MAX_COINS_PER_TICK    = 150;                   // 150 × 2 ticks/day = 300 coin scans/day
const MAX_PAGES_PER_COIN    = 25;                    // cap on `before` walk (≈ 2500 swaps deep)
const EARLY_BATCHES_TO_KEEP = 2;                     // keep last 2 pages → ~200 earliest swaps per coin
const INTER_COIN_DELAY_MS   = 800;                   // courtesy delay between coins
const INTER_PAGE_DELAY_MS   = 220;                   // courtesy delay between pagination pages
const DROP_FIRST_BUYERS     = 3;                     // skip dev + sniper-bot slots
const MIN_SOL_TIER          = 1;                     // accept ≥1 SOL (classifyAllBySol still tiers)

let _tickTimer = null;
let _stats = {
  runsCompleted:     0,
  coinsProcessed:    0,
  swapsParsed:       0,
  buyersExtracted:   0,
  walletsAdded:      0,
  walletsPromoted:   0,
  pagesWalked:       0,
  helius429s:        0,
  lastRunAt:         null,
  lastError:         null,
};

function ensureLogTable(dbInstance) {
  try {
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS early_buyer_log (
        contract_address    TEXT PRIMARY KEY,
        processed_at        TEXT DEFAULT (datetime('now')),
        earliest_swaps      INTEGER,
        unique_buyers       INTEGER,
        wallets_added       INTEGER,
        pages_walked        INTEGER,
        hit_creation        INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ebl_at ON early_buyer_log(processed_at DESC);
    `);
  } catch (err) { console.warn('[early-buyer-harvester] table setup:', err.message); }
}

async function fetchEarliestSwaps(mint, heliusKey) {
  // Walk backwards via `before` cursor. We keep a ring buffer of the last
  // EARLY_BATCHES_TO_KEEP pages we saw — the last N pages we walked through
  // contain the earliest swaps. Returns { earliest (concat of last N batches,
  // oldest first within each batch), pages, hitCreation }.
  let before = null;
  const ringBuffer = [];   // last N batches, [oldest_seen, …, newest_seen]
  let pages = 0;
  let hitCreation = false;

  for (let i = 0; i < MAX_PAGES_PER_COIN; i++) {
    pages++;
    try {
      const res = await fetch(HELIUS_ENHANCED(mint, heliusKey, before), {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429) {
        _stats.helius429s++;
        await sleep(2_000);  // back off
        continue;
      }
      if (!res.ok) break;
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) {
        // No more transactions older than `before` → we hit creation.
        hitCreation = true;
        break;
      }
      // Push to ring buffer, drop oldest beyond capacity.
      ringBuffer.push(batch);
      while (ringBuffer.length > EARLY_BATCHES_TO_KEEP) ringBuffer.shift();

      if (batch.length < 100) {
        // Partial page = end of history.
        hitCreation = true;
        break;
      }
      before = batch[batch.length - 1]?.signature;
      if (!before) break;
      await sleep(INTER_PAGE_DELAY_MS);
    } catch (err) {
      // Soft fail — return what we got.
      break;
    }
  }
  _stats.pagesWalked += pages;

  // Helius returns each page newest-first. We want the final array sorted
  // strictly oldest → newest so iteration in extractBuyersFromSwaps walks
  // launch order and DROP_FIRST_BUYERS reliably skips dev + sniper-bot slots.
  //   1) Reverse the ring buffer order so the deepest page (earliest) is first.
  //   2) Reverse each page's items so the very first swap is at index 0.
  const earliest = ringBuffer
    .slice()
    .reverse()
    .flatMap(page => page.slice().reverse());
  return { earliest, pages, hitCreation };
}

function extractBuyersFromSwaps(swaps, mint) {
  // `swaps` is already oldest-first (see fetchEarliestSwaps). For each swap,
  // grab toUserAccount from tokenTransfers when the mint matches and the
  // amount is positive. Insertion order is preserved so DROP_FIRST_BUYERS
  // reliably skips dev + sniper-bot slots downstream.
  const ordered = [];
  const seen = new Set();
  for (const tx of swaps) {
    const transfers = tx?.tokenTransfers ?? [];
    for (const t of transfers) {
      if (t?.mint !== mint) continue;
      const buyer = t?.toUserAccount;
      const amt   = t?.tokenAmount ?? 0;
      if (!buyer || amt <= 0) continue;
      if (seen.has(buyer)) continue;
      seen.add(buyer);
      ordered.push(buyer);
    }
  }
  return ordered;
}

function upsertEarlyBuyer(dbInstance, candidate, mint) {
  const { address, sol, category: newCategory } = candidate;
  try {
    const existing = dbInstance.prepare(
      `SELECT id, category, source, our_win_count FROM tracked_wallets WHERE address = ?`
    ).get(address);

    if (!existing) {
      dbInstance.prepare(`
        INSERT INTO tracked_wallets (address, category, source, sol_balance, wins_found_in, last_seen, added_by, updated_at, notes)
        VALUES (?, ?, 'early-buyer-harvester', ?, 1, datetime('now'), 'auto', datetime('now'), ?)
      `).run(address, newCategory, sol, `early-buyer of ${mint.slice(0,8)}…`);
      _stats.walletsAdded++;
      return { added: true, promoted: false };
    }

    if (existing.category === 'KOL' || existing.category === 'RUG_ASSOCIATED') {
      return { added: false, promoted: false };
    }

    dbInstance.prepare(`
      UPDATE tracked_wallets
      SET sol_balance   = ?,
          wins_found_in = COALESCE(wins_found_in, 0) + 1,
          last_seen     = datetime('now'),
          updated_at    = datetime('now')
      WHERE id = ?
    `).run(sol, existing.id);

    // Promote dust/MOMENTUM/HARVESTED_TRADER to SMART_MONEY/WINNER if SOL tier
    // earned it. Never downgrade WINNER (curated tier).
    if (newCategory === 'WINNER' && existing.category !== 'WINNER') {
      dbInstance.prepare(`UPDATE tracked_wallets SET category='WINNER', updated_at=datetime('now') WHERE id = ?`).run(existing.id);
      _stats.walletsPromoted++;
      return { added: false, promoted: true };
    }
    if (newCategory === 'SMART_MONEY' && (existing.category === 'MOMENTUM' || existing.category === 'HARVESTED_TRADER' || existing.category === 'NEUTRAL')) {
      dbInstance.prepare(`UPDATE tracked_wallets SET category='SMART_MONEY', updated_at=datetime('now') WHERE id = ?`).run(existing.id);
      _stats.walletsPromoted++;
      return { added: false, promoted: true };
    }
    return { added: false, promoted: false };
  } catch (err) {
    console.warn(`[early-buyer-harvester] upsert ${address.slice(0,8)}: ${err.message}`);
    return { added: false, promoted: false };
  }
}

async function processCoin(dbInstance, mint, heliusKey) {
  const { classifyAllBySol } = await import('./harvester-cleanup.js');
  const { earliest, pages, hitCreation } = await fetchEarliestSwaps(mint, heliusKey);
  _stats.swapsParsed += earliest.length;

  if (earliest.length === 0) {
    try {
      dbInstance.prepare(`
        INSERT OR REPLACE INTO early_buyer_log
          (contract_address, processed_at, earliest_swaps, unique_buyers, wallets_added, pages_walked, hit_creation)
        VALUES (?, datetime('now'), 0, 0, 0, ?, ?)
      `).run(mint, pages, hitCreation ? 1 : 0);
    } catch {}
    return { added: 0, promoted: 0, buyers: 0 };
  }

  let buyers = extractBuyersFromSwaps(earliest, mint);
  _stats.buyersExtracted += buyers.length;

  // Drop dev + sniper-bot slots. If hitCreation is false (we didn't walk all
  // the way back), the "earliest" batch isn't truly the launch buyers, so
  // skip the drop — they're already several hundred swaps in.
  if (hitCreation && buyers.length > DROP_FIRST_BUYERS) {
    buyers = buyers.slice(DROP_FIRST_BUYERS);
  }

  if (buyers.length === 0) {
    try {
      dbInstance.prepare(`
        INSERT OR REPLACE INTO early_buyer_log
          (contract_address, processed_at, earliest_swaps, unique_buyers, wallets_added, pages_walked, hit_creation)
        VALUES (?, datetime('now'), ?, 0, 0, ?, ?)
      `).run(mint, earliest.length, pages, hitCreation ? 1 : 0);
    } catch {}
    return { added: 0, promoted: 0, buyers: 0 };
  }

  const classified = await classifyAllBySol(buyers, heliusKey);
  // classifyAllBySol returns categories: WINNER / SMART_MONEY / MOMENTUM /
  // HARVESTED_TRADER. We only insert ≥1 SOL; the floor is enforced inline.
  const qualified = classified.filter(c => c.sol >= MIN_SOL_TIER);

  let added = 0, promoted = 0;
  for (const cand of qualified) {
    const r = upsertEarlyBuyer(dbInstance, cand, mint);
    if (r.added) added++;
    if (r.promoted) promoted++;
  }

  try {
    dbInstance.prepare(`
      INSERT OR REPLACE INTO early_buyer_log
        (contract_address, processed_at, earliest_swaps, unique_buyers, wallets_added, pages_walked, hit_creation)
      VALUES (?, datetime('now'), ?, ?, ?, ?, ?)
    `).run(mint, earliest.length, buyers.length, added, pages, hitCreation ? 1 : 0);
  } catch {}

  return { added, promoted, buyers: buyers.length };
}

async function runEarlyBuyerTick(dbInstance, heliusKey) {
  try {
    ensureLogTable(dbInstance);
    if (!heliusKey) { _stats.lastError = 'No HELIUS_API_KEY'; return; }

    // Source: midcap winners we haven't early-buyer-processed yet.
    // Prefer fresh (last 7d) coins, but if the fresh window doesn't have
    // enough, backfill with any unprocessed midcap regardless of age.
    // `harvested_at IS NOT NULL` keeps the index-friendly sort stable.
    const candidates = dbInstance.prepare(`
      SELECT m.contract_address, m.harvested_at, m.volume_24h_usd
      FROM midcap_harvest_log m
      LEFT JOIN early_buyer_log eb ON eb.contract_address = m.contract_address
      WHERE eb.contract_address IS NULL
      ORDER BY
        CASE WHEN m.harvested_at > datetime('now', '-7 days') THEN 0 ELSE 1 END,
        m.volume_24h_usd DESC
      LIMIT ?
    `).all(MAX_COINS_PER_TICK);

    if (candidates.length === 0) {
      console.log('[early-buyer-harvester] no fresh midcap coins to process');
      _stats.runsCompleted++;
      _stats.lastRunAt = new Date().toISOString();
      _stats.lastError = null;
      return;
    }

    console.log(`[early-buyer-harvester] processing ${candidates.length} fresh midcap coins...`);

    let totalAdded = 0, totalPromoted = 0, totalBuyers = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      try {
        const r = await processCoin(dbInstance, c.contract_address, heliusKey);
        totalAdded    += r.added;
        totalPromoted += r.promoted;
        totalBuyers   += r.buyers;
        if ((i + 1) % 10 === 0) {
          console.log(`[early-buyer-harvester]   [${i+1}/${candidates.length}] +${totalAdded} new wallets, ${totalPromoted} promoted, ${totalBuyers} unique buyers seen so far`);
        }
      } catch (err) {
        console.warn(`[early-buyer-harvester] coin ${c.contract_address.slice(0,8)}: ${err.message}`);
      }
      _stats.coinsProcessed++;
      await sleep(INTER_COIN_DELAY_MS);
    }

    _stats.runsCompleted++;
    _stats.lastRunAt = new Date().toISOString();
    _stats.lastError = null;
    console.log(`[early-buyer-harvester] tick complete — ${candidates.length} coins, +${totalAdded} new wallets, ${totalPromoted} promoted, ${totalBuyers} unique buyers extracted`);
  } catch (err) {
    console.error('[early-buyer-harvester] tick error:', err.message);
    _stats.lastError = err.message;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function startEarlyBuyerHarvester(dbInstance, heliusKey) {
  if (_tickTimer) return;
  if (!heliusKey) {
    console.warn('[early-buyer-harvester] HELIUS_API_KEY missing — harvester disabled');
    return;
  }
  console.log(`[early-buyer-harvester] starting — daily, ${MAX_COINS_PER_TICK} coins/tick, ${MAX_PAGES_PER_COIN} pages max per coin`);
  setTimeout(() => { runEarlyBuyerTick(dbInstance, heliusKey).catch(() => {}); }, BOOT_DELAY_MS);
  _tickTimer = setInterval(() => {
    runEarlyBuyerTick(dbInstance, heliusKey).catch(() => {});
  }, TICK_MS);
}

export function stopEarlyBuyerHarvester() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

export function getEarlyBuyerStats(dbInstance) {
  const totalProcessed = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM early_buyer_log`).get().n; }
    catch { return 0; }
  })();
  const totalWallets = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source='early-buyer-harvester'`).get().n; }
    catch { return 0; }
  })();
  const winnerWallets = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source='early-buyer-harvester' AND category='WINNER'`).get().n; }
    catch { return 0; }
  })();
  const smartWallets = (() => {
    try { return dbInstance.prepare(`SELECT COUNT(*) as n FROM tracked_wallets WHERE source='early-buyer-harvester' AND category='SMART_MONEY'`).get().n; }
    catch { return 0; }
  })();
  return { ..._stats, totalProcessed, totalWallets, winnerWallets, smartWallets };
}

export async function triggerEarlyBuyerHarvest(dbInstance, heliusKey) {
  return runEarlyBuyerTick(dbInstance, heliusKey);
}
