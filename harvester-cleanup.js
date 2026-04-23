/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  harvester-cleanup.js — SOL-tier enforcement for harvested wallets
 *
 *  Rules (per user spec):
 *   - SOL < 8           → DELETE (only if wallet was added by a harvester;
 *                         preserve pre-existing wallets even if they've
 *                         been touched by a harvester — we only demote them)
 *   - SOL 8 – 99        → category = 'SMART_MONEY'
 *   - SOL >= 100        → category = 'WINNER'  (WHALE tier)
 *
 *  Scope: only wallets where
 *     source IN ('wallet-harvester','midcap-harvester','legendary-harvester')
 *  OR where `notes` references a harvester (i.e. a pre-existing wallet
 *  that a harvester promoted). Never touches wallets the user curated
 *  through Dune / manual adds / other sources unless a harvester modified
 *  them — and even then only demote, never delete.
 *
 *  Also exports `batchScanSolBalance` so the 3 harvesters can use the
 *  same SOL-balance check before inserting new wallets.
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const HELIUS_RPC = (key) => `https://mainnet.helius-rpc.com/?api-key=${key}`;

const MIN_KEEP_SOL    = 8;
const WHALE_SOL       = 100;
const BATCH_SIZE      = 100;
const BATCH_DELAY_MS  = 300;
const HARVESTER_SOURCES = ['wallet-harvester', 'midcap-harvester', 'legendary-harvester'];

/**
 * Batch-fetch SOL balances for a list of addresses via Helius.
 * Returns Map<address, SOL number>. Missing addresses (RPC failure)
 * are omitted from the map so callers can distinguish "0 SOL" from
 * "scan failed".
 */
export async function batchScanSolBalance(addresses, heliusKey) {
  const results = new Map();
  if (!addresses || addresses.length === 0 || !heliusKey) return results;

  const unique = Array.from(new Set(addresses));
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE);
    try {
      const res = await fetch(HELIUS_RPC(heliusKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'balances', method: 'getMultipleAccounts',
          params: [chunk, { commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) { console.warn(`[harvester-cleanup] batch HTTP ${res.status}`); continue; }
      const j = await res.json();
      const values = j?.result?.value || [];
      values.forEach((acc, idx) => {
        const lamports = acc?.lamports ?? 0;
        results.set(chunk[idx], lamports / 1e9);
      });
    } catch (err) {
      console.warn(`[harvester-cleanup] batch ${i}-${i+chunk.length} failed: ${err.message}`);
    }
    if (i + BATCH_SIZE < unique.length) await sleep(BATCH_DELAY_MS);
  }
  return results;
}

/**
 * Helper for harvesters: given a list of candidate wallet addresses,
 * return only those that meet MIN_KEEP_SOL (≥ 8 SOL), tagged with their
 * correct category by SOL tier.
 */
export async function filterAndClassifyBySol(addresses, heliusKey) {
  const balances = await batchScanSolBalance(addresses, heliusKey);
  const keepers = [];
  for (const addr of addresses) {
    const sol = balances.get(addr);
    if (sol == null) continue;           // scan failed → skip (don't insert unknown)
    if (sol < MIN_KEEP_SOL) continue;    // dust → skip
    keepers.push({
      address:  addr,
      sol,
      category: sol >= WHALE_SOL ? 'WINNER' : 'SMART_MONEY',
    });
  }
  return keepers;
}

/**
 * Scan every harvester-touched wallet in the DB, apply the SOL-tier rules.
 * Returns a summary object.
 */
export async function cleanupHarvesterDust(dbInstance, heliusKey) {
  if (!heliusKey) throw new Error('No HELIUS_API_KEY');

  // Wallets to check: source matches a harvester, OR notes contain "harvester"
  // (catches pre-existing wallets that a harvester promoted).
  const candidates = dbInstance.prepare(`
    SELECT id, address, source, category, notes
    FROM tracked_wallets
    WHERE source IN (?, ?, ?)
       OR (notes IS NOT NULL AND notes LIKE '%harvester%')
  `).all(...HARVESTER_SOURCES);

  if (candidates.length === 0) {
    console.log('[harvester-cleanup] nothing to clean — no harvester-touched wallets found');
    return { scanned: 0, deleted: 0, upgradedWinner: 0, upgradedSmart: 0, demoted: 0, preserved: 0 };
  }
  console.log(`[harvester-cleanup] scanning ${candidates.length} harvester-touched wallets...`);

  const addresses = candidates.map(c => c.address);
  const balances  = await batchScanSolBalance(addresses, heliusKey);

  let deleted = 0, upgradedWinner = 0, upgradedSmart = 0, demoted = 0, preserved = 0, scanFailed = 0;

  const updateBal       = dbInstance.prepare('UPDATE tracked_wallets SET sol_balance = ?, updated_at = datetime(\'now\') WHERE id = ?');
  const setCategoryWithBal = dbInstance.prepare(`
    UPDATE tracked_wallets
    SET category    = ?,
        sol_balance = ?,
        updated_at  = datetime('now'),
        notes       = COALESCE(notes, '') || ' | cleanup: SOL-tier reclassified ' || datetime('now')
    WHERE id = ?
  `);
  const deleteWallet    = dbInstance.prepare('DELETE FROM tracked_wallets WHERE id = ?');

  const txn = dbInstance.transaction((rows) => {
    for (const w of rows) {
      const sol = balances.get(w.address);
      if (sol == null) { scanFailed++; continue; }  // RPC miss — don't touch

      updateBal.run(sol, w.id);

      if (sol < MIN_KEEP_SOL) {
        if (HARVESTER_SOURCES.includes(w.source)) {
          // Source = harvester, dust SOL → safe to DELETE (we added it)
          deleteWallet.run(w.id);
          deleted++;
        } else {
          // Pre-existing wallet a harvester touched — DEMOTE but don't delete
          setCategoryWithBal.run('NEUTRAL', sol, w.id);
          demoted++;
        }
      } else if (sol >= WHALE_SOL) {
        if (w.category !== 'WINNER') { setCategoryWithBal.run('WINNER', sol, w.id); upgradedWinner++; }
        else preserved++;
      } else {
        // 8 ≤ sol < 100
        if (w.category !== 'SMART_MONEY') { setCategoryWithBal.run('SMART_MONEY', sol, w.id); upgradedSmart++; }
        else preserved++;
      }
    }
  });
  txn(candidates);

  const summary = {
    scanned: candidates.length,
    deleted, upgradedWinner, upgradedSmart, demoted, preserved, scanFailed,
    rules: { minKeepSol: MIN_KEEP_SOL, whaleSol: WHALE_SOL },
  };
  console.log('[harvester-cleanup] done:', summary);
  return summary;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export { MIN_KEEP_SOL, WHALE_SOL, HARVESTER_SOURCES };
