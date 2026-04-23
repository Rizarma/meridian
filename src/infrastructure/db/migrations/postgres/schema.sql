-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Positions table
CREATE TABLE IF NOT EXISTS positions (
  address TEXT PRIMARY KEY,
  pool TEXT NOT NULL,
  pool_name TEXT,
  strategy TEXT NOT NULL,
  deployed_at TIMESTAMP NOT NULL,
  closed_at TIMESTAMP,
  closed INTEGER NOT NULL DEFAULT 0,
  amount_sol REAL,
  pnl_pct REAL,
  pnl_usd REAL,
  fees_earned_usd REAL,
  initial_value_usd REAL,
  final_value_usd REAL,
  minutes_held INTEGER,
  close_reason TEXT,
  trailing_state TEXT,
  notes TEXT,
  data_json TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Position snapshots
CREATE TABLE IF NOT EXISTS position_snapshots (
  id SERIAL PRIMARY KEY,
  position_address TEXT NOT NULL,
  ts TIMESTAMP NOT NULL,
  pnl_pct REAL,
  pnl_usd REAL,
  in_range INTEGER,
  unclaimed_fees_usd REAL,
  minutes_out_of_range INTEGER,
  age_minutes INTEGER,
  data_json TEXT
);

-- Position events
CREATE TABLE IF NOT EXISTS position_events (
  id SERIAL PRIMARY KEY,
  position_address TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ts TIMESTAMP NOT NULL DEFAULT NOW(),
  data_json TEXT
);

-- Pools table
CREATE TABLE IF NOT EXISTS pools (
  address TEXT PRIMARY KEY,
  name TEXT,
  base_mint TEXT,
  total_deploys INTEGER NOT NULL DEFAULT 0,
  avg_pnl_pct REAL,
  win_rate REAL,
  adjusted_win_rate REAL,
  cooldown_until TIMESTAMP,
  cooldown_reason TEXT,
  base_mint_cooldown_until TIMESTAMP,
  base_mint_cooldown_reason TEXT,
  data_json TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Pool deploys
CREATE TABLE IF NOT EXISTS pool_deploys (
  id SERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL REFERENCES pools(address) ON DELETE CASCADE,
  position_address TEXT,
  deployed_at TIMESTAMP NOT NULL,
  closed_at TIMESTAMP,
  pnl_pct REAL,
  pnl_usd REAL,
  range_efficiency REAL,
  minutes_held INTEGER,
  close_reason TEXT,
  strategy TEXT,
  volatility_at_deploy REAL,
  data_json TEXT
);

-- Lessons table
CREATE TABLE IF NOT EXISTS lessons (
  id BIGINT PRIMARY KEY,
  rule TEXT NOT NULL,
  tags TEXT,
  outcome TEXT,
  context TEXT,
  pool TEXT,
  pnl_pct REAL,
  range_efficiency REAL,
  created_at TIMESTAMP NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  data_json TEXT
);

-- Performance table
CREATE TABLE IF NOT EXISTS performance (
  id SERIAL PRIMARY KEY,
  position TEXT NOT NULL,
  pool TEXT NOT NULL,
  pool_name TEXT,
  strategy TEXT,
  amount_sol REAL,
  pnl_pct REAL,
  pnl_usd REAL,
  fees_earned_usd REAL,
  initial_value_usd REAL,
  final_value_usd REAL,
  minutes_held INTEGER,
  minutes_in_range INTEGER,
  range_efficiency REAL,
  close_reason TEXT,
  base_mint TEXT,
  bin_step INTEGER,
  volatility REAL,
  fee_tvl_ratio REAL,
  organic_score INTEGER,
  bin_range TEXT,
  recorded_at TIMESTAMP NOT NULL,
  data_json TEXT
);

-- Signal weights
CREATE TABLE IF NOT EXISTS signal_weights (
  signal TEXT PRIMARY KEY,
  weight REAL NOT NULL DEFAULT 1.0,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Signal weight history
CREATE TABLE IF NOT EXISTS signal_weight_history (
  id SERIAL PRIMARY KEY,
  signal TEXT NOT NULL,
  weight_from REAL,
  weight_to REAL NOT NULL,
  lift REAL,
  action TEXT,
  window_size INTEGER,
  win_count INTEGER,
  loss_count INTEGER,
  changed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Position state (runtime)
CREATE TABLE IF NOT EXISTS position_state (
  position TEXT PRIMARY KEY,
  pool TEXT NOT NULL,
  pool_name TEXT,
  strategy TEXT NOT NULL,
  bin_range TEXT,
  amount_sol REAL,
  amount_x REAL,
  active_bin INTEGER,
  bin_step INTEGER,
  volatility REAL,
  fee_tvl_ratio REAL,
  organic_score INTEGER,
  initial_value_usd REAL,
  deployed_at TIMESTAMP NOT NULL,
  first_oor_at TIMESTAMP,
  last_claim_at TIMESTAMP,
  last_rebalance_at TIMESTAMP,
  rebalance_count INTEGER DEFAULT 0,
  claim_count INTEGER DEFAULT 0,
  notes TEXT,
  instructions TEXT,
  signal_snapshot TEXT,
  strategy_config TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Position state events
CREATE TABLE IF NOT EXISTS position_state_events (
  id SERIAL PRIMARY KEY,
  position TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ts TIMESTAMP NOT NULL DEFAULT NOW(),
  data_json TEXT
);

-- State metadata
CREATE TABLE IF NOT EXISTS state_metadata (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Strategies
CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  author TEXT,
  lp_strategy TEXT NOT NULL,
  token_criteria_json TEXT,
  entry_criteria_json TEXT,
  exit_criteria_json TEXT,
  position_params_json TEXT,
  risk_params_json TEXT,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  added_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Active strategy
CREATE TABLE IF NOT EXISTS active_strategy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_id TEXT NOT NULL REFERENCES strategies(id)
);

-- Token blacklist
CREATE TABLE IF NOT EXISTS token_blacklist (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  reason TEXT,
  added_at TIMESTAMP NOT NULL DEFAULT NOW(),
  added_by TEXT
);

-- Smart wallets
CREATE TABLE IF NOT EXISTS smart_wallets (
  address TEXT PRIMARY KEY,
  name TEXT,
  category TEXT,
  type TEXT,
  added_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Dev blocklist
CREATE TABLE IF NOT EXISTS dev_blocklist (
  dev_address TEXT PRIMARY KEY,
  reason TEXT,
  added_at TIMESTAMP NOT NULL DEFAULT NOW(),
  evidence_json TEXT
);

-- Cycle state
CREATE TABLE IF NOT EXISTS cycle_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL,
  started_at TIMESTAMP NOT NULL,
  last_run_at TIMESTAMP,
  data_json TEXT
);

-- Threshold suggestions (V2)
CREATE TABLE IF NOT EXISTS threshold_suggestions (
  id SERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL,
  metric TEXT NOT NULL,
  current_value REAL,
  suggested_value REAL,
  confidence REAL,
  reasoning TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMP,
  data_json TEXT
);

-- Threshold history
CREATE TABLE IF NOT EXISTS threshold_history (
  id SERIAL PRIMARY KEY,
  pool_address TEXT NOT NULL,
  metric TEXT NOT NULL,
  old_value REAL,
  new_value REAL,
  reason TEXT,
  applied_at TIMESTAMP NOT NULL DEFAULT NOW(),
  data_json TEXT
);

-- Portfolio history (for sync)
CREATE TABLE IF NOT EXISTS portfolio_history (
  id SERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  first_seen_at TIMESTAMP NOT NULL,
  last_seen_at TIMESTAMP NOT NULL,
  total_positions INTEGER NOT NULL DEFAULT 0,
  avg_pnl_pct REAL,
  data_json TEXT,
  lesson_generated INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_positions_pool ON positions(pool);
CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions(closed);
CREATE INDEX IF NOT EXISTS idx_position_snapshots_position ON position_snapshots(position_address);
CREATE INDEX IF NOT EXISTS idx_position_events_position ON position_events(position_address);
CREATE INDEX IF NOT EXISTS idx_pool_deploys_pool ON pool_deploys(pool_address);
CREATE INDEX IF NOT EXISTS idx_performance_pool ON performance(pool);
CREATE INDEX IF NOT EXISTS idx_performance_recorded_at ON performance(recorded_at);
CREATE INDEX IF NOT EXISTS idx_lessons_pool ON lessons(pool);
CREATE INDEX IF NOT EXISTS idx_lessons_created_at ON lessons(created_at);
CREATE INDEX IF NOT EXISTS idx_signal_weight_history_signal ON signal_weight_history(signal);
CREATE INDEX IF NOT EXISTS idx_position_state_pool ON position_state(pool);
CREATE INDEX IF NOT EXISTS idx_portfolio_history_wallet ON portfolio_history(wallet_address);
CREATE INDEX IF NOT EXISTS idx_portfolio_history_pool ON portfolio_history(pool_address);
