// ─────────────────────────────────────────────────────────────────────────────
// pre-launch-detector.js
//
// Watches known Solana exchange hot wallets for small SOL outflows (1-10 SOL)
// to fresh wallets. Those recipients go on a 6h suspect list — if they deploy
// a token within that window, the scanner flags it as PRE_LAUNCH_PREDICTED.
//
// Approach:
//   - Every 90s, call Helius `getSignaturesForAddress` on each hot wallet
//   - For each tx, inspect the transfers via `getTransaction`
//   - If a 1-10 SOL outflow to a fresh wallet (no prior tx history), upsert
//     into prelaunch_suspects with expires_at = now + 6h
//   - Auto-expires; consumed when the wallet shows up as a token deployer
//
// Exchange wallets (hot deposit addresses, public knowledge):
//   These are the well-known Solana exchange hot wallets as of 2025. Add more
//   as you identify them.
// ─────────────────────────────────────────────────────────────────────────────

const EXCHANGE_WALLETS = {
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS': 'Coinbase 1',
  '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9': 'Binance',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM': 'MEXC',
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5': 'Kraken',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S': 'Jupiter Aggregator',
  // Add more as you identify them
};

const TICK_MS         = 90_000;        // 90s between sweeps
const SUSPECT_TTL_MS  = 6 * 60 * 60_000; // 6h window
const MIN_SOL_OUTFLOW = 1;
const MAX_SOL_OUTFLOW = 10;
const REQUEST_TIMEOUT = 9_000;

let _handle = null;
let _running = false;
let _ticks   = 0;
let _suspectsAdded = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function helius(method, params) {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY missing');
  const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'plsd', method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!r.ok) throw new Error(`Helius ${method}: ${r.status}`);
  const j = await r.json();
  return j.result;
}

async function sweepExchange(address, name, dbInstance) {
  try {
    // Pull last 10 signatures — tight window so we don't re-scan too much
    const sigs = await helius('getSignaturesForAddress', [address, { limit: 10 }]);
    if (!Array.isArray(sigs) || !sigs.length) return 0;

    let added = 0;
    for (const sigRow of sigs) {
      const sig = sigRow.signature;
      if (!sig) continue;
      let tx;
      try {
        tx = await helius('getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
      } catch { continue; }
      if (!tx?.meta || tx.meta.err) continue;

      // Look at SOL balance deltas in this tx
      const accountKeys = tx.transaction?.message?.accountKeys || [];
      const preBalances  = tx.meta.preBalances  || [];
      const postBalances = tx.meta.postBalances || [];

      // Find the exchange wallet's index — it should have a negative delta
      const exchIdx = accountKeys.findIndex(k => (k.pubkey || k) === address);
      if (exchIdx < 0) continue;
      const exchDelta = (postBalances[exchIdx] - preBalances[exchIdx]) / 1e9;
      if (exchDelta > -MIN_SOL_OUTFLOW) continue;  // outflow too small (or deposit)

      // Find the recipient — positive delta matching our range
      for (let i = 0; i < accountKeys.length; i++) {
        if (i === exchIdx) continue;
        const key = accountKeys[i]?.pubkey || accountKeys[i];
        if (!key || EXCHANGE_WALLETS[key]) continue; // skip inter-exchange
        const delta = (postBalances[i] - preBalances[i]) / 1e9;
        if (delta >= MIN_SOL_OUTFLOW && delta <= MAX_SOL_OUTFLOW) {
          try {
            const expiresAt = new Date(Date.now() + SUSPECT_TTL_MS).toISOString();
            dbInstance.prepare(`
              INSERT INTO prelaunch_suspects
                (wallet, funded_at, funded_amount, source_exchange, expires_at)
              VALUES (?, datetime('now'), ?, ?, ?)
              ON CONFLICT(wallet) DO UPDATE SET
                funded_at       = excluded.funded_at,
                funded_amount   = excluded.funded_amount,
                source_exchange = excluded.source_exchange,
                expires_at      = excluded.expires_at,
                consumed        = 0
            `).run(key, delta, name, expiresAt);
            added++;
            _suspectsAdded++;
          } catch {}
        }
      }
      await sleep(120); // tiny gap to avoid Helius rate limits
    }
    return added;
  } catch (err) {
    console.warn(`[prelaunch] sweep ${name} failed:`, err.message);
    return 0;
  }
}

async function runTick(dbInstance) {
  if (_running) return;
  _running = true;
  try {
    let total = 0;
    for (const [addr, name] of Object.entries(EXCHANGE_WALLETS)) {
      total += await sweepExchange(addr, name, dbInstance);
      await sleep(200); // rate-limit kindness between exchanges
    }
    _ticks++;
    // Prune expired
    try { dbInstance.prepare(`DELETE FROM prelaunch_suspects WHERE expires_at < datetime('now')`).run(); } catch {}
    if (total > 0) console.log(`[prelaunch] tick ${_ticks} — added ${total} suspect wallet(s)`);
  } finally { _running = false; }
}

/**
 * Check if a given wallet is on the active suspect list. Called by the scanner
 * when a new token is detected so it can flag PRE_LAUNCH_PREDICTED.
 */
export function isPreLaunchSuspect(wallet, dbInstance) {
  if (!wallet || !dbInstance) return null;
  try {
    const row = dbInstance.prepare(
      `SELECT wallet, funded_amount, source_exchange, funded_at, expires_at
       FROM prelaunch_suspects
       WHERE wallet = ? AND expires_at > datetime('now') AND consumed = 0`
    ).get(wallet);
    return row || null;
  } catch { return null; }
}

/**
 * Mark a suspect as consumed (they deployed a token).
 */
export function markSuspectConsumed(wallet, launchedCa, dbInstance) {
  if (!wallet) return;
  try {
    dbInstance.prepare(
      `UPDATE prelaunch_suspects SET consumed=1, launched_ca=? WHERE wallet=?`
    ).run(launchedCa, wallet);
  } catch {}
}

export function startPreLaunchDetector(dbInstance, intervalMs = TICK_MS) {
  if (_handle) return _handle;
  if (!process.env.HELIUS_API_KEY) {
    console.warn('[prelaunch] not starting — HELIUS_API_KEY missing');
    return null;
  }
  console.log(`[prelaunch] starting detector — ${Object.keys(EXCHANGE_WALLETS).length} exchanges watched, tick ${intervalMs/1000}s`);
  setTimeout(() => runTick(dbInstance).catch(() => {}), 45_000); // 45s startup delay
  _handle = setInterval(() => runTick(dbInstance).catch(() => {}), intervalMs);
  return _handle;
}

export function getPreLaunchStats() {
  return { ticks: _ticks, suspectsAdded: _suspectsAdded };
}
