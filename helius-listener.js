/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  ALPHA LENNIX — helius-listener.js
 *  Real-time Solana event listener via Helius WebSocket
 *
 *  Replaces 90s DEXScreener polling with ~3s detection of:
 *  - New pump.fun bonding curve creations (pre-migration)
 *  - New Raydium pool creations (post-migration)
 *  - Bonding curve progress updates (momentum tracking)
 *  - Smart money wallet transactions
 *
 *  Usage: import { startHeliusListener, stopHeliusListener } from './helius-listener.js'
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

import { EventEmitter } from 'events';

// ─── WebSocket — works on Node 18 (Railway) AND Node 22+ ─────────────────────
// Node 22+ has globalThis.WebSocket built-in.
// Node 18 (current Railway default) needs the 'ws' npm package.
// We try native first, then fall back to ws package at module load time.
let _WS = null;
try {
  // Try native WebSocket (Node 22+)
  if (typeof globalThis.WebSocket !== 'undefined') {
    _WS = globalThis.WebSocket;
    console.log('[helius] Using native WebSocket (Node 22+)');
  }
} catch {}

if (!_WS) {
  try {
    // Dynamic import at module evaluation — works fine here (top-level await not needed)
    const { default: WS } = await import('ws');
    _WS = WS;
    console.log('[helius] Using ws package (Node 18 compatible)');
  } catch (e) {
    console.warn('[helius] No WebSocket available. Install ws: npm i ws. Error:', e.message);
  }
}

const WebSocketImpl = _WS;

// ─── Constants ────────────────────────────────────────────────────────────────

const HELIUS_WS_URL = (apiKey) => `wss://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const HELIUS_RPC    = (apiKey) => `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
const SOLANA_PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

// Pump.fun bonding-curve graduation threshold (USD MCap). SOL-denominated
// upstream so this floats — was ~$69K originally, ~$44K as of 2026-04. Set
// PUMP_FUN_GRADUATION_MCAP_USD in Railway env to override without a deploy.
export function getPumpFunGraduationMcapUsd() {
  return Number(process.env.PUMP_FUN_GRADUATION_MCAP_USD) || 44_000;
}

// Program IDs we care about
const PUMP_FUN_PROGRAM    = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_FUN_MIGRATION  = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg'; // pumpswap migration
const RAYDIUM_AMM_V4      = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CLMM        = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const METEORA_DLMM        = 'LBUZKhRxPF3XUpBCjp4YzTKgLLjgSXsQ1T7MQhsDFD';

// Bonding curve state layout (Pump.fun)
const BONDING_CURVE_DISCRIMINATOR = 'e445a52e51cb9a1d'; // first 8 bytes of account discriminator

// ─── Helius Listener Class ────────────────────────────────────────────────────

export class HeliusListener extends EventEmitter {
  constructor(apiKey) {
    super();
    this.apiKey      = apiKey;
    this.ws          = null;
    this.reconnectMs = 3_000;
    this.maxReconnMs = 30_000;
    this.pingInterval= null;
    this.subIds      = {};
    this.connected   = false;
    this.stopping    = false;
    this.seenTxns    = new Set(); // dedup recent txns
    this.seenLimit   = 2000;
  }

  // ── Connection Management ──────────────────────────────────────────────────

  start() {
    this.stopping = false;
    this._connect();
  }

  stop() {
    this.stopping = true;
    clearInterval(this.pingInterval);
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    console.log('[helius] Listener stopped');
  }

  _connect() {
    if (this.stopping) return;
    const url = HELIUS_WS_URL(this.apiKey);
    console.log('[helius] Connecting to WebSocket...');

    try {
      if (!WebSocketImpl) {
        console.error('[helius] No WebSocket implementation available. Install ws package: npm i ws');
        this._scheduleReconnect();
        return;
      }
      this.ws = new WebSocketImpl(url);
    } catch (err) {
      console.error('[helius] Failed to create WebSocket:', err.message);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[helius] ✓ WebSocket connected');
      this.connected = true;
      this.reconnectMs = 3_000; // reset backoff
      this._subscribeAll();
      this._startPing();
      this.emit('connected');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleMessage(msg);
      } catch {}
    };

    this.ws.onerror = (err) => {
      const msg = err?.message || err?.error?.message || 'unknown';
      console.error('[helius] WebSocket error:', msg, err?.error?.code || '');
    };

    this.ws.onclose = (code) => {
      this.connected = false;
      clearInterval(this.pingInterval);
      console.warn(`[helius] WebSocket closed (${code?.code ?? code})`);
      if (!this.stopping) this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(this.reconnectMs * 1.5, this.maxReconnMs);
    console.log(`[helius] Reconnecting in ${Math.round(delay/1000)}s...`);
    setTimeout(() => this._connect(), delay);
  }

  _startPing() {
    clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      if (this.connected && this.ws?.readyState === 1) {
        this._send({ jsonrpc: '2.0', method: 'ping', id: 0 });
      }
    }, 20_000);
  }

  _send(obj) {
    try {
      if (this.ws?.readyState === 1) {
        this.ws.send(JSON.stringify(obj));
      }
    } catch {}
  }

  // ── Subscription Management ────────────────────────────────────────────────

  _subscribeAll() {
    // 1. Subscribe to pump.fun program logs — catches new token creation
    this._subscribeProgramLogs(PUMP_FUN_PROGRAM, 'pumpfun_create');

    // 2. Subscribe to pump.fun migration program — catches PumpSwap migrations
    this._subscribeProgramLogs(PUMP_FUN_MIGRATION, 'pumpfun_migrate');

    // 3. Subscribe to Raydium AMM V4 — catches new pool creation
    this._subscribeProgramLogs(RAYDIUM_AMM_V4, 'raydium_v4');

    // 4. Subscribe to Raydium CLMM — concentrated liquidity pools
    this._subscribeProgramLogs(RAYDIUM_CLMM, 'raydium_clmm');

    // 5. Subscribe to Meteora DLMM
    this._subscribeProgramLogs(METEORA_DLMM, 'meteora');

    console.log('[helius] ✓ Subscribed to 5 program streams');
  }

  _subscribeProgramLogs(programId, tag) {
    const id = Date.now() + Math.random();
    this._send({
      jsonrpc: '2.0',
      id,
      method: 'logsSubscribe',
      params: [
        { mentions: [programId] },
        { commitment: 'confirmed' },
      ],
    });
    this.subIds[id] = tag;
  }

  // ── Message Handler ────────────────────────────────────────────────────────

  _handleMessage(msg) {
    // Subscription confirmation
    if (msg.result && typeof msg.result === 'number') {
      console.log(`[helius] Subscription confirmed: ${msg.result}`);
      return;
    }

    // Real-time notification
    if (msg.method !== 'logsNotification') return;

    const logs  = msg.params?.result?.value;
    const txSig = logs?.signature;
    const txLogs = logs?.logs ?? [];
    const err   = logs?.err;

    if (!txSig || err) return; // skip failed txns
    if (this.seenTxns.has(txSig)) return; // dedup

    // Manage seen set size
    this.seenTxns.add(txSig);
    if (this.seenTxns.size > this.seenLimit) {
      const first = this.seenTxns.values().next().value;
      this.seenTxns.delete(first);
    }

    // Classify the transaction
    this._classifyTransaction(txSig, txLogs);
  }

  _classifyTransaction(txSig, logs) {
    const logStr = logs.join(' ').toLowerCase();

    // ── Pump.fun new token creation ──────────────────────────────────────────
    if (this._isPumpCreate(logs)) {
      console.log(`[helius] 🟢 New pump.fun token detected: ${txSig.slice(0,8)}...`);
      this.emit('pumpfun_new_token', { txSig, logs, detectedAt: Date.now() });
      // Fetch full tx data asynchronously
      this._fetchAndEmitToken(txSig, 'PUMP_PRE_BOND').catch(() => {});
      return;
    }

    // ── Pump.fun → PumpSwap migration ────────────────────────────────────────
    if (this._isPumpMigration(logs)) {
      console.log(`[helius] 🔄 PumpSwap migration detected: ${txSig.slice(0,8)}...`);
      this.emit('pumpfun_migration', { txSig, logs, detectedAt: Date.now() });
      this._fetchAndEmitToken(txSig, 'PUMP_MIGRATED').catch(() => {});
      return;
    }

    // ── Raydium new pool ─────────────────────────────────────────────────────
    if (this._isRaydiumNewPool(logs)) {
      console.log(`[helius] 🟡 New Raydium pool detected: ${txSig.slice(0,8)}...`);
      this.emit('raydium_new_pool', { txSig, logs, detectedAt: Date.now() });
      this._fetchAndEmitToken(txSig, 'RAYDIUM').catch(() => {});
      return;
    }

    // ── Meteora new pool ─────────────────────────────────────────────────────
    if (this._isMeteoraNewPool(logs)) {
      console.log(`[helius] 🔵 New Meteora pool detected: ${txSig.slice(0,8)}...`);
      this.emit('meteora_new_pool', { txSig, logs, detectedAt: Date.now() });
      this._fetchAndEmitToken(txSig, 'METEORA').catch(() => {});
    }
  }

  // ── Transaction Classifiers ────────────────────────────────────────────────

  _isPumpCreate(logs) {
    return logs.some(l =>
      l.includes('Program log: Instruction: Create') ||
      l.includes('Program log: Instruction: Initialize') ||
      l.includes('CreateEvent')
    ) && logs.some(l => l.includes(PUMP_FUN_PROGRAM));
  }

  _isPumpMigration(logs) {
    return logs.some(l =>
      l.includes('MigrateEvent') ||
      l.includes('Instruction: Migrate') ||
      (l.includes('bonding_curve') && l.includes('complete'))
    );
  }

  _isRaydiumNewPool(logs) {
    return logs.some(l =>
      l.includes('Instruction: Initialize2') ||
      l.includes('Instruction: Initialize') ||
      l.includes('InitializeInstruction2')
    ) && logs.some(l => l.includes(RAYDIUM_AMM_V4) || l.includes(RAYDIUM_CLMM));
  }

  _isMeteoraNewPool(logs) {
    return logs.some(l =>
      l.includes('Instruction: InitializeLbPair') ||
      l.includes('InitializeLbPair')
    );
  }

  // ── Full Transaction Fetch & Parse ─────────────────────────────────────────

  async _fetchAndEmitToken(txSig, source) {
    await sleep(1500); // brief delay for RPC to index tx

    try {
      const txData = await this._fetchTransaction(txSig);
      if (!txData) return;

      const parsed = this._parseTokenFromTx(txData, source);
      if (!parsed) return;

      console.log(`[helius] ✓ Token parsed: $${parsed.token} (${source}) CA: ${parsed.contractAddress?.slice(0,8)}...`);
      this.emit('new_candidate', { ...parsed, source, txSig, detectedAt: Date.now() });

    } catch (err) {
      console.warn(`[helius] Failed to parse tx ${txSig.slice(0,8)}: ${err.message}`);
    }
  }

  async _fetchTransaction(sig) {
    const res = await fetch(HELIUS_RPC(this.apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json();
    return data.result ?? null;
  }

  _parseTokenFromTx(tx, source) {
    try {
      const accountKeys = tx.transaction?.message?.accountKeys ?? [];
      const postBalances = tx.meta?.postTokenBalances ?? [];
      const preBalances  = tx.meta?.preTokenBalances  ?? [];

      // Find the new mint address — it's in postTokenBalances but not preTokenBalances
      const preMints = new Set(preBalances.map(b => b.mint));
      const newMints = postBalances.filter(b => !preMints.has(b.mint));

      const mint = newMints[0]?.mint ?? postBalances[0]?.mint;
      if (!mint) return null;

      // Deployer is typically the fee payer (first account)
      const deployer = accountKeys[0]?.pubkey ?? null;

      // Token symbol from parsed data if available
      const tokenInfo = postBalances.find(b => b.mint === mint);

      return {
        contractAddress:    mint,
        token:              tokenInfo?.uiTokenAmount?.uiAmountString?.slice(0,8) ?? 'UNKNOWN',
        tokenName:          null, // will be filled by enricher
        deployerAddress:    deployer,
        chain:              'solana',
        dex:                source === 'PUMP_PRE_BOND' ? 'pump.fun' : source === 'RAYDIUM' ? 'raydium' : 'meteora',
        stage:              source === 'PUMP_PRE_BOND' ? 'PRE_BOND' : source === 'PUMP_MIGRATED' ? 'MIGRATED' : 'BONDING',
        pairAgeHours:       0,
        pairAgeMinutes:     0,
        marketCap:          null, // filled by enricher
        liquidity:          null,
        narrativeTags:      [],
        notes:              [],
        birdeyeOk:          false,
        heliusOk:           false,
        bubblemapOk:        false,
        detectionSource:    'helius_websocket',
      };
    } catch {
      return null;
    }
  }

  // ── Wallet Monitoring ──────────────────────────────────────────────────────

  /**
   * Subscribe to transactions from specific high-value wallets.
   * Call this after the wallet DB is loaded to track smart money.
   */
  subscribeToWallets(walletAddresses) {
    if (!walletAddresses?.length) return;
    const chunk = walletAddresses.slice(0, 100); // Helius limits per subscription
    const id = Date.now();
    this._send({
      jsonrpc: '2.0',
      id,
      method: 'logsSubscribe',
      params: [
        { mentions: chunk },
        { commitment: 'confirmed' },
      ],
    });
    console.log(`[helius] Subscribed to ${chunk.length} smart money wallets`);
  }

  /**
   * Fetch current holders of a token for wallet cross-reference.
   */
  async fetchTokenHolders(mint, limit = 100) {
    try {
      const res = await fetch(HELIUS_RPC(this.apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTokenLargestAccounts',
          params: [mint, { commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(5_000),
      });
      const data = await res.json();
      return data.result?.value?.slice(0, limit) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Fetch account info for bonding curve progress tracking.
   */
  async fetchBondingCurveState(curveAddress) {
    try {
      const res = await fetch(HELIUS_RPC(this.apiKey), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getAccountInfo',
          params: [curveAddress, { encoding: 'base64', commitment: 'confirmed' }],
        }),
        signal: AbortSignal.timeout(5_000),
      });
      const data = await res.json();
      const rawData = data.result?.value?.data?.[0];
      if (!rawData) return null;
      return parseBondingCurveData(Buffer.from(rawData, 'base64'));
    } catch {
      return null;
    }
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  getStatus() {
    return {
      connected:     this.connected,
      subscriptions: Object.keys(this.subIds).length,
      seenTxns:      this.seenTxns.size,
      reconnectMs:   this.reconnectMs,
    };
  }
}

// ─── Bonding Curve Parser ─────────────────────────────────────────────────────

/**
 * Parse pump.fun bonding curve account data.
 * Layout (after 8-byte discriminator):
 *   virtualTokenReserves: u64 (8 bytes)
 *   virtualSolReserves:   u64 (8 bytes)
 *   realTokenReserves:    u64 (8 bytes)
 *   realSolReserves:      u64 (8 bytes)
 *   tokenTotalSupply:     u64 (8 bytes)
 *   complete:             bool (1 byte)
 */
function parseBondingCurveData(buffer) {
  try {
    if (buffer.length < 49) return null;
    const offset = 8; // skip discriminator
    const virtualTokenReserves = buffer.readBigUInt64LE(offset);
    const virtualSolReserves   = buffer.readBigUInt64LE(offset + 8);
    const realTokenReserves    = buffer.readBigUInt64LE(offset + 16);
    const realSolReserves      = buffer.readBigUInt64LE(offset + 24);
    const tokenTotalSupply     = buffer.readBigUInt64LE(offset + 32);
    const complete             = buffer[offset + 40] === 1;

    // Calculate bonding curve progress
    // Pump.fun uses virtual reserves for pricing
    // 793,100,000 tokens at launch, migration at ~85% sold
    const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000_000_000n;
    const INITIAL_REAL_TOKEN_RESERVES    = 793_100_000_000_000n;
    const tokensSold = INITIAL_REAL_TOKEN_RESERVES - realTokenReserves;
    const bondingPct = Number(tokensSold * 10000n / INITIAL_REAL_TOKEN_RESERVES) / 100;

    // SOL raised
    const solRaised = Number(realSolReserves) / 1e9;

    // Market cap estimate (in USD, assuming ~$150/SOL — will be updated by enricher)
    const priceInSol = Number(virtualSolReserves) / Number(virtualTokenReserves);
    const mcapSOL    = priceInSol * 1_000_000_000; // 1B total supply

    return {
      virtualTokenReserves: Number(virtualTokenReserves),
      virtualSolReserves:   Number(virtualSolReserves),
      realTokenReserves:    Number(realTokenReserves),
      realSolReserves:      Number(realSolReserves),
      tokenTotalSupply:     Number(tokenTotalSupply),
      complete,
      bondingCurvePct:      Math.min(bondingPct, 100),
      solRaised,
      mcapSOL,
      priceInSol,
    };
  } catch {
    return null;
  }
}

// ─── Pump.fun API Helpers ─────────────────────────────────────────────────────

// Pump.fun migrated their public API to v3 sometime in 2026 — the old
// frontend-api.pump.fun host now returns Cloudflare error 1016 (DNS-unresolved).
// All pump.fun integrations in this codebase route through this constant so
// the next move is a one-line change here.
const PUMPFUN_API = 'https://frontend-api-v3.pump.fun';

export async function fetchPumpFunCoin(mint) {
  try {
    const res = await fetch(`${PUMPFUN_API}/coins/${mint}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return normalizePumpCoin(data);
  } catch {
    return null;
  }
}

export async function fetchPumpFunNewCoins(limit = 20) {
  try {
    const res = await fetch(
      `${PUMPFUN_API}/coins?limit=${limit}&sort=created_timestamp&order=DESC&includeNsfw=false`,
      {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data.map(normalizePumpCoin).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function checkPumpFunLivestream(devWalletAddress, mintAddress) {
  // Primary: check if dev wallet is currently live
  try {
    const res = await fetch(
      `${PUMPFUN_API}/users/${devWalletAddress}/currently-live`,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          ...(process.env.PUMPFUN_JWT ? { 'Authorization': `Bearer ${process.env.PUMPFUN_JWT}` } : {}),
        },
        signal: AbortSignal.timeout(4_000),
      }
    );
    if (res.ok) {
      const data = await res.json();
      return {
        isLive:         data.is_live ?? data.stream_live ?? false,
        viewerCount:    data.viewer_count ?? data.viewers ?? 0,
        source:         'pumpfun_api',
        engagementScore: calcLivestreamEngagement(data.viewer_count ?? 0),
      };
    }
  } catch {}

  // Fallback: check if coin page has livestream indicator via coin data
  try {
    const coinData = await fetchPumpFunCoin(mintAddress);
    if (coinData?.livestreamUrl) {
      return {
        isLive:         true,
        viewerCount:    0,
        source:         'pumpfun_coin_data',
        engagementScore: 2,
      };
    }
  } catch {}

  return { isLive: false, viewerCount: 0, source: 'unavailable', engagementScore: 0 };
}

function normalizePumpCoin(raw) {
  if (!raw?.mint) return null;
  const createdAt = raw.created_timestamp ? new Date(raw.created_timestamp * 1000) : new Date();
  const ageMs     = Date.now() - createdAt.getTime();
  const ageHours  = ageMs / 3_600_000;

  // Bonding curve progress from market cap (uses module-level helper so the
  // threshold stays consistent across files via the env var).
  const PUMP_GRAD_MCAP = getPumpFunGraduationMcapUsd();
  const bondingPct = raw.usd_market_cap
    ? Math.min((raw.usd_market_cap / PUMP_GRAD_MCAP) * 100, 100)
    : null;

  return {
    contractAddress:   raw.mint,
    token:             raw.symbol ?? 'UNKNOWN',
    tokenName:         raw.name ?? '',
    deployerAddress:   raw.creator ?? null,
    chain:             'solana',
    dex:               'pump.fun',
    stage:             raw.complete ? 'MIGRATED' : 'PRE_BOND',
    pairAgeHours:      ageHours,
    pairAgeMinutes:    ageMs / 60_000,
    marketCap:         raw.usd_market_cap ?? null,
    liquidity:         raw.virtual_sol_reserves ? raw.virtual_sol_reserves / 1e9 * 150 : null, // approx
    website:           raw.website ?? null,
    twitter:           raw.twitter ?? null,
    telegram:          raw.telegram ?? null,
    description:       raw.description ?? null,
    bondingCurvePct:   bondingPct,
    bondingCurveComplete: raw.complete ?? false,
    replyCount:        raw.reply_count ?? 0,
    livestreamUrl:     raw.video_url ?? null,
    pumpRank:          raw.king_of_the_hill_timestamp ? 'KOTH' : null,
    imageUrl:          raw.image_uri ?? raw.image ?? null,   // for TG/UI banners
    detectionSource:   'pumpfun_api',
    narrativeTags:     extractNarrativeTags(raw.name, raw.description, raw.symbol),
    notes:             [],
    birdeyeOk:         false,
    heliusOk:          false,
    bubblemapOk:       false,
  };
}

function calcLivestreamEngagement(viewers) {
  if (viewers <= 0)  return 0;
  if (viewers < 50)  return 2;
  if (viewers < 200) return 4;
  if (viewers < 500) return 6;
  return 8;
}

function extractNarrativeTags(name, desc, symbol) {
  const text = `${name} ${desc} ${symbol}`.toLowerCase();
  const tags = [];
  const patterns = {
    AI:       ['ai','gpt','neural','claude','openai','agent','llm'],
    DOG:      ['dog','doge','shib','woof','puppy','bark'],
    CAT:      ['cat','kitty','nyan','meow','feline'],
    PEPE:     ['pepe','frog','pepecoin'],
    ELON:     ['elon','musk','tesla','spacex'],
    TRUMP:    ['trump','maga','america','president'],
    MILITARY: ['sol','soldier','war','army'],
    MEME:     ['meme','moon','wen','based','gigachad'],
    GAMING:   ['game','gamer','pixel','arcade','nft'],
    DEFI:     ['defi','yield','farm','swap','lp'],
  };
  for (const [tag, keywords] of Object.entries(patterns)) {
    if (keywords.some(k => text.includes(k))) tags.push(tag);
  }
  return tags;
}

// ─── Singleton Management ─────────────────────────────────────────────────────

let _listenerInstance = null;

export function startHeliusListener(apiKey) {
  if (!apiKey) {
    console.warn('[helius] No HELIUS_API_KEY — listener not started');
    return null;
  }
  if (_listenerInstance) {
    console.warn('[helius] Listener already running');
    return _listenerInstance;
  }
  _listenerInstance = new HeliusListener(apiKey);
  _listenerInstance.start();
  return _listenerInstance;
}

export function stopHeliusListener() {
  _listenerInstance?.stop();
  _listenerInstance = null;
}

export function getHeliusListener() {
  return _listenerInstance;
}

export function getHeliusStatus() {
  return _listenerInstance?.getStatus() ?? { connected: false, subscriptions: 0 };
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Helius Enhanced API ──────────────────────────────────────────────────────

/**
 * Get parsed transaction details using Helius Enhanced Transactions API.
 * Much richer than raw getTransaction — includes token transfers, swap data, etc.
 */
export async function getHeliusEnhancedTransaction(txSig, apiKey) {
  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/transactions?api-key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: [txSig] }),
        signal: AbortSignal.timeout(8_000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Get token metadata using Helius DAS API.
 */
export async function getTokenMetadata(mint, apiKey) {
  try {
    const res = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getAsset',
          params: { id: mint },
        }),
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Get top token holders using Helius.
 */
export async function getTopHolders(mint, apiKey, limit = 20) {
  let holders = [];

  // 1. getTokenLargestAccounts via Helius (was public RPC — 20% error rate
  //    there was corrupting holder data on ~150 tokens/day). Helius charges
  //    ~1 credit per call, trivial vs. the budget impact.
  const rpcUrl = apiKey ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}` : SOLANA_PUBLIC_RPC;
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenLargestAccounts', params: [mint] }),
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const data = await res.json();
      holders = data.result?.value ?? [];
    }
  } catch {}

  // 2. If we need more than 20 AND have Helius key, use DAS getTokenAccounts (costs 1 credit)
  if (limit > 20 && apiKey && holders.length >= 19) {
    try {
      const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTokenAccounts',
          params: { mint, limit: Math.min(limit, 100), options: { showZeroBalance: false } },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = await res.json();
        const dasHolders = (data.result?.token_accounts ?? []).map(a => ({
          address: a.address,
          amount: a.amount,
          owner: a.owner,
        }));
        if (dasHolders.length > holders.length) {
          console.log(`[helius] DAS getTokenAccounts: ${dasHolders.length} holders (upgraded from ${holders.length})`);
          holders = dasHolders;
        }
      }
    } catch {}
  }

  return holders.slice(0, limit);
}
