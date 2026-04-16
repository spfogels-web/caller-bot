-- ─────────────────────────────────────────────────────────────────────────────
--  schema.sql — Wallet Tracking & Copy-Trading System
--  PostgreSQL schema for wallets, trades, sniper settings, and portfolio data
-- ─────────────────────────────────────────────────────────────────────────────

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Wallets ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallets (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  address               TEXT NOT NULL UNIQUE,
  label                 TEXT,                         -- human-friendly name
  source                TEXT DEFAULT 'manual',        -- 'manual' | 'birdeye_smart_money' | 'auto_discovered'
  tier                  SMALLINT DEFAULT 3,           -- 1 (top) / 2 / 3
  trust_score           NUMERIC(5,2) DEFAULT 0,       -- 0-100
  is_followable         BOOLEAN DEFAULT FALSE,
  is_active             BOOLEAN DEFAULT TRUE,
  follow_mode           TEXT DEFAULT 'manual',        -- 'auto' | 'manual' | 'disabled'
  allocation_usd        NUMERIC(12,2) DEFAULT 0,      -- per-trade allocation in USD

  -- Performance stats
  realized_pnl_usd      NUMERIC(18,4) DEFAULT 0,
  unrealized_pnl_usd    NUMERIC(18,4) DEFAULT 0,
  total_trades          INTEGER DEFAULT 0,
  winning_trades        INTEGER DEFAULT 0,
  losing_trades         INTEGER DEFAULT 0,
  win_rate              NUMERIC(5,2) DEFAULT 0,       -- percent
  avg_roi               NUMERIC(8,4) DEFAULT 0,       -- percent per trade
  avg_hold_time_sec     INTEGER DEFAULT 0,
  rug_exposure_count    INTEGER DEFAULT 0,
  rug_exposure_rate     NUMERIC(5,2) DEFAULT 0,       -- percent

  -- 7d / 30d windows
  pnl_7d                NUMERIC(18,4) DEFAULT 0,
  pnl_30d               NUMERIC(18,4) DEFAULT 0,
  trades_7d             INTEGER DEFAULT 0,
  trades_30d            INTEGER DEFAULT 0,
  win_rate_7d           NUMERIC(5,2) DEFAULT 0,
  win_rate_30d          NUMERIC(5,2) DEFAULT 0,

  -- Metadata
  first_seen_at         TIMESTAMPTZ DEFAULT NOW(),
  last_active_at        TIMESTAMPTZ,
  last_scored_at        TIMESTAMPTZ,
  stats_updated_at      TIMESTAMPTZ,
  notes                 TEXT,
  tags                  TEXT[] DEFAULT '{}',

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallets_trust_score  ON wallets(trust_score DESC);
CREATE INDEX IF NOT EXISTS idx_wallets_followable   ON wallets(is_followable) WHERE is_followable = TRUE;
CREATE INDEX IF NOT EXISTS idx_wallets_address      ON wallets(address);
CREATE INDEX IF NOT EXISTS idx_wallets_tier         ON wallets(tier);

-- ─── Wallet Transactions (raw ingested events) ────────────────────────────────

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id             UUID REFERENCES wallets(id) ON DELETE CASCADE,
  wallet_address        TEXT NOT NULL,
  signature             TEXT NOT NULL UNIQUE,
  tx_type               TEXT NOT NULL,               -- 'BUY' | 'SELL' | 'SWAP' | 'UNKNOWN'
  token_address         TEXT,
  token_symbol          TEXT,
  token_name            TEXT,

  -- Amounts
  sol_amount            NUMERIC(18,9),
  token_amount          NUMERIC(28,9),
  price_usd             NUMERIC(18,8),
  value_usd             NUMERIC(18,4),

  -- Market context at time of tx
  market_cap_at_tx      NUMERIC(18,2),
  liquidity_at_tx       NUMERIC(18,2),
  holders_at_tx         INTEGER,

  -- Derived
  is_entry              BOOLEAN DEFAULT FALSE,
  is_exit               BOOLEAN DEFAULT FALSE,
  pnl_usd               NUMERIC(18,4),               -- only on sells
  roi_pct               NUMERIC(8,4),                 -- only on sells
  hold_time_sec         INTEGER,                      -- only on sells

  slot                  BIGINT,
  block_time            TIMESTAMPTZ,
  raw_data              JSONB,

  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wt_wallet_id     ON wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wt_token         ON wallet_transactions(token_address);
CREATE INDEX IF NOT EXISTS idx_wt_block_time    ON wallet_transactions(block_time DESC);
CREATE INDEX IF NOT EXISTS idx_wt_type          ON wallet_transactions(tx_type);
CREATE INDEX IF NOT EXISTS idx_wt_wallet_addr   ON wallet_transactions(wallet_address);

-- ─── Token Risk Cache ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS token_risk_cache (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_address         TEXT NOT NULL UNIQUE,
  token_symbol          TEXT,
  token_name            TEXT,

  -- Risk fields
  liquidity_usd         NUMERIC(18,2),
  market_cap_usd        NUMERIC(18,2),
  volume_24h_usd        NUMERIC(18,2),
  holders               INTEGER,
  top10_holder_pct      NUMERIC(6,3),
  dev_wallet_pct        NUMERIC(6,3),
  bundle_risk           TEXT,
  bubble_map_risk       TEXT,
  mint_authority        SMALLINT,
  freeze_authority      SMALLINT,
  lp_locked             SMALLINT,

  -- Computed
  risk_score            NUMERIC(5,2),                -- 0=safe, 100=extreme
  risk_level            TEXT,                        -- 'LOW'|'MEDIUM'|'HIGH'|'EXTREME'
  is_blacklisted        BOOLEAN DEFAULT FALSE,
  blacklist_reason      TEXT,
  passed_filter         BOOLEAN,
  filter_fail_reason    TEXT,

  price_usd             NUMERIC(18,8),
  price_at_check        NUMERIC(18,8),

  expires_at            TIMESTAMPTZ,
  checked_at            TIMESTAMPTZ DEFAULT NOW(),
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trc_address      ON token_risk_cache(token_address);
CREATE INDEX IF NOT EXISTS idx_trc_risk         ON token_risk_cache(risk_level);
CREATE INDEX IF NOT EXISTS idx_trc_blacklisted  ON token_risk_cache(is_blacklisted) WHERE is_blacklisted = TRUE;

-- ─── Copied Trades ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS copied_trades (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id             UUID REFERENCES wallets(id) ON DELETE SET NULL,
  wallet_address        TEXT NOT NULL,
  trigger_tx_sig        TEXT,                        -- original wallet tx that triggered copy
  token_address         TEXT NOT NULL,
  token_symbol          TEXT,

  -- Entry
  entry_price_usd       NUMERIC(18,8),
  entry_sol             NUMERIC(18,9),
  entry_usd             NUMERIC(18,4),
  entry_time            TIMESTAMPTZ,
  entry_tx_sig          TEXT,
  entry_market_cap      NUMERIC(18,2),
  entry_liquidity       NUMERIC(18,2),

  -- Exit
  exit_price_usd        NUMERIC(18,8),
  exit_sol              NUMERIC(18,9),
  exit_usd              NUMERIC(18,4),
  exit_time             TIMESTAMPTZ,
  exit_tx_sig           TEXT,
  exit_reason           TEXT,                        -- 'take_profit'|'stop_loss'|'trailing_stop'|'max_hold_timer'|'manual'|'wallet_sold'

  -- Result
  pnl_usd               NUMERIC(18,4),
  pnl_sol               NUMERIC(18,9),
  roi_pct               NUMERIC(8,4),
  hold_time_sec         INTEGER,

  -- Config at time of trade
  take_profit_pct       NUMERIC(8,4),
  stop_loss_pct         NUMERIC(8,4),
  trailing_stop_pct     NUMERIC(8,4),
  max_hold_sec          INTEGER,
  slippage_bps          INTEGER,

  -- State
  status                TEXT DEFAULT 'OPEN',         -- 'OPEN'|'CLOSED'|'FAILED'|'CANCELLED'
  skip_reason           TEXT,
  wallet_trust_score    NUMERIC(5,2),

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ct_wallet_id     ON copied_trades(wallet_id);
CREATE INDEX IF NOT EXISTS idx_ct_token         ON copied_trades(token_address);
CREATE INDEX IF NOT EXISTS idx_ct_status        ON copied_trades(status);
CREATE INDEX IF NOT EXISTS idx_ct_entry_time    ON copied_trades(entry_time DESC);

-- ─── Sniper Settings ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sniper_settings (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                  TEXT NOT NULL DEFAULT 'default',
  is_active             BOOLEAN DEFAULT TRUE,
  is_global_default     BOOLEAN DEFAULT FALSE,

  -- Execution
  allocation_usd        NUMERIC(12,2) DEFAULT 50,
  max_position_usd      NUMERIC(12,2) DEFAULT 500,
  slippage_bps          INTEGER DEFAULT 300,          -- 3%
  priority_fee_lamports BIGINT DEFAULT 100000,

  -- Exit conditions
  take_profit_pct       NUMERIC(8,4) DEFAULT 100,    -- +100%
  stop_loss_pct         NUMERIC(8,4) DEFAULT 20,     -- -20%
  trailing_stop_pct     NUMERIC(8,4) DEFAULT 15,     -- 15% from peak
  max_hold_sec          INTEGER DEFAULT 3600,         -- 1 hour

  -- Token risk gates
  min_liquidity_usd     NUMERIC(12,2) DEFAULT 20000,
  min_market_cap_usd    NUMERIC(12,2) DEFAULT 10000,
  max_market_cap_usd    NUMERIC(12,2) DEFAULT 10000000,
  min_volume_24h_usd    NUMERIC(12,2) DEFAULT 10000,
  max_top10_holder_pct  NUMERIC(5,2) DEFAULT 50,
  max_dev_wallet_pct    NUMERIC(5,2) DEFAULT 10,
  require_lp_locked     BOOLEAN DEFAULT FALSE,
  require_mint_revoked  BOOLEAN DEFAULT TRUE,
  block_bundle_risk     TEXT DEFAULT 'SEVERE',        -- minimum risk level to block
  max_price_impact_pct  NUMERIC(5,2) DEFAULT 10,

  -- Wallet gates
  min_trust_score       NUMERIC(5,2) DEFAULT 60,
  min_wallet_trades     INTEGER DEFAULT 10,
  min_win_rate          NUMERIC(5,2) DEFAULT 50,

  -- Portfolio gates
  max_open_positions    INTEGER DEFAULT 10,
  max_portfolio_usd     NUMERIC(12,2) DEFAULT 2000,
  max_per_token_usd     NUMERIC(12,2) DEFAULT 200,
  cooldown_sec          INTEGER DEFAULT 60,           -- min seconds between buys
  max_daily_loss_usd    NUMERIC(12,2) DEFAULT 500,

  -- Extension price guard
  max_extension_pct     NUMERIC(8,4) DEFAULT 20,     -- don't buy if token up >X% since wallet entry

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default settings
INSERT INTO sniper_settings (name, is_global_default)
VALUES ('default', TRUE)
ON CONFLICT DO NOTHING;

-- ─── Portfolio ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS portfolio_positions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  copied_trade_id       UUID REFERENCES copied_trades(id) ON DELETE SET NULL,
  wallet_address        TEXT NOT NULL,
  token_address         TEXT NOT NULL,
  token_symbol          TEXT,

  entry_price_usd       NUMERIC(18,8),
  current_price_usd     NUMERIC(18,8),
  quantity_tokens       NUMERIC(28,9),
  cost_basis_usd        NUMERIC(18,4),
  current_value_usd     NUMERIC(18,4),
  unrealized_pnl_usd    NUMERIC(18,4),
  unrealized_roi_pct    NUMERIC(8,4),
  peak_price_usd        NUMERIC(18,8),               -- for trailing stop

  opened_at             TIMESTAMPTZ DEFAULT NOW(),
  last_updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pp_wallet     ON portfolio_positions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_pp_token      ON portfolio_positions(token_address);

-- ─── Blacklist / Whitelist ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS token_blacklist (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  address               TEXT NOT NULL UNIQUE,
  symbol                TEXT,
  reason                TEXT,
  added_by              TEXT DEFAULT 'system',
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_blacklist (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  address               TEXT NOT NULL UNIQUE,
  label                 TEXT,
  reason                TEXT,
  added_by              TEXT DEFAULT 'system',
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ─── System Events Log ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tracker_events (
  id                    BIGSERIAL PRIMARY KEY,
  level                 TEXT DEFAULT 'INFO',         -- 'INFO'|'WARN'|'ERROR'
  event_type            TEXT NOT NULL,
  message               TEXT,
  data                  JSONB,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_te_type       ON tracker_events(event_type);
CREATE INDEX IF NOT EXISTS idx_te_created    ON tracker_events(created_at DESC);

-- ─── Helius Webhook State ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS helius_subscriptions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_address        TEXT NOT NULL UNIQUE,
  webhook_id            TEXT,
  is_active             BOOLEAN DEFAULT TRUE,
  last_event_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);
