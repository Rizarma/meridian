export interface ExportData {
  schemaVersion: SchemaVersionExport[];
  lessons: LessonExport[];
  performance: PerformanceExport[];
  pools: PoolExport[];
  positions: PositionExport[];
  positionSnapshots: PositionSnapshotExport[];
  positionEvents: PositionEventExport[];
  signalWeights: SignalWeightExport[];
  signalWeightHistory: SignalWeightHistoryExport[];
  positionState: PositionStateExport[];
  positionStateEvents: PositionStateEventExport[];
  stateMetadata: StateMetadataExport[];
  strategies: StrategyExport[];
  activeStrategy: ActiveStrategyExport[];
  tokenBlacklist: TokenBlacklistExport[];
  smartWallets: SmartWalletExport[];
  devBlocklist: DevBlocklistExport[];
  cycleState: CycleStateExport[];
  thresholdSuggestions: ThresholdSuggestionExport[];
  thresholdHistory: ThresholdHistoryExport[];
  portfolioHistory: PortfolioHistoryExport[];
  poolDeploys: PoolDeployExport[];
  exportedAt: string;
  source: string;
}

export interface SchemaVersionExport {
  version: number;
  applied_at: string;
}

export interface LessonExport {
  id: number;
  rule: string;
  tags: string;
  outcome: string;
  context: string | null;
  pool: string | null;
  pnl_pct: number | null;
  range_efficiency: number | null;
  created_at: string;
  pinned: number;
  role: string | null;
  data_json: string | null;
}

export interface PerformanceExport {
  id: number;
  position: string;
  pool: string;
  pool_name: string | null;
  strategy: string | null;
  amount_sol: number | null;
  pnl_pct: number | null;
  pnl_usd: number | null;
  fees_earned_usd: number | null;
  initial_value_usd: number | null;
  final_value_usd: number | null;
  minutes_held: number | null;
  minutes_in_range: number | null;
  range_efficiency: number | null;
  close_reason: string | null;
  base_mint: string | null;
  bin_step: number | null;
  volatility: number | null;
  fee_tvl_ratio: number | null;
  organic_score: number | null;
  bin_range: string | null;
  recorded_at: string;
  data_json: string | null;
}

export interface PoolExport {
  address: string;
  name: string | null;
  base_mint: string | null;
  total_deploys: number;
  avg_pnl_pct: number | null;
  win_rate: number | null;
  adjusted_win_rate: number | null;
  cooldown_until: string | null;
  cooldown_reason: string | null;
  base_mint_cooldown_until: string | null;
  base_mint_cooldown_reason: string | null;
  data_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface PositionExport {
  address: string;
  pool: string;
  pool_name: string | null;
  strategy: string;
  deployed_at: string;
  closed_at: string | null;
  closed: number;
  amount_sol: number | null;
  pnl_pct: number | null;
  pnl_usd: number | null;
  fees_earned_usd: number | null;
  initial_value_usd: number | null;
  final_value_usd: number | null;
  minutes_held: number | null;
  close_reason: string | null;
  trailing_state: string | null;
  notes: string | null;
  data_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface PositionSnapshotExport {
  id: number;
  position_address: string;
  ts: string;
  pnl_pct: number | null;
  pnl_usd: number | null;
  in_range: number | null;
  unclaimed_fees_usd: number | null;
  minutes_out_of_range: number | null;
  age_minutes: number | null;
  data_json: string | null;
}

export interface PositionEventExport {
  id: number;
  position_address: string;
  event_type: string;
  ts: string;
  data_json: string | null;
}

export interface SignalWeightExport {
  signal: string;
  weight: number;
  updated_at: string;
}

export interface SignalWeightHistoryExport {
  id: number;
  signal: string;
  weight_from: number | null;
  weight_to: number;
  lift: number | null;
  action: string | null;
  window_size: number | null;
  win_count: number | null;
  loss_count: number | null;
  changed_at: string;
}

export interface PositionStateExport {
  position: string;
  pool: string;
  pool_name: string | null;
  strategy: string;
  strategy_config: string | null;
  bin_range: string | null;
  amount_sol: number | null;
  amount_x: number | null;
  active_bin_at_deploy: number | null;
  bin_step: number | null;
  volatility: number | null;
  fee_tvl_ratio: number | null;
  initial_fee_tvl_24h: number | null;
  organic_score: number | null;
  initial_value_usd: number | null;
  signal_snapshot: string | null;
  deployed_at: string;
  out_of_range_since: string | null;
  last_claim_at: string | null;
  rebalance_count: number | null;
  total_fees_claimed_usd: number | null;
  closed: number | null;
  closed_at: string | null;
  notes: string | null;
  peak_pnl_pct: number | null;
  pending_peak_pnl_pct: number | null;
  pending_peak_started_at: string | null;
  trailing_active: number | null;
  instruction: string | null;
  pending_trailing_current_pnl_pct: number | null;
  pending_trailing_peak_pnl_pct: number | null;
  pending_trailing_drop_pct: number | null;
  pending_trailing_started_at: string | null;
  confirmed_trailing_exit_reason: string | null;
  confirmed_trailing_exit_until: string | null;
  last_updated: string;
}

export interface PositionStateEventExport {
  id: number;
  ts: string;
  action: string;
  position: string | null;
  pool_name: string | null;
  reason: string | null;
}

export interface StateMetadataExport {
  key: string;
  value: string | null;
  updated_at?: string | null;
}

export interface StrategyExport {
  id: string;
  name: string;
  author: string | null;
  lp_strategy: string;
  token_criteria_json: string | null;
  entry_criteria_json: string | null;
  range_criteria_json: string | null;
  exit_criteria_json: string | null;
  best_for: string | null;
  raw: string | null;
  updated_at: string;
  added_at: string;
}

export interface ActiveStrategyExport {
  id: number;
  active_id: string;
}

export interface TokenBlacklistExport {
  mint: string;
  symbol: string | null;
  reason: string | null;
  added_at: string;
  added_by: string | null;
}

export interface SmartWalletExport {
  address: string;
  name: string | null;
  category: string | null;
  type: string | null;
  added_at: string;
}

export interface DevBlocklistExport {
  dev_address: string;
  reason: string | null;
  added_at: string;
  evidence_json: string | null;
}

export interface CycleStateExport {
  id: number;
  phase: string;
  started_at: string;
  last_run_at: string | null;
  data_json: string | null;
}

export interface ThresholdSuggestionExport {
  id: number;
  pool_address?: string | null;
  field?: string | null;
  metric?: string | null;
  current_value: number | null;
  suggested_value: number | null;
  confidence: number | null;
  reasoning?: string | null;
  rationale?: string | null;
  status: string;
  created_at: string;
  decided_at?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  applied_at?: string | null;
  sample_size?: number | null;
  winner_count?: number | null;
  loser_count?: number | null;
  data_json?: string | null;
}

export interface ThresholdHistoryExport {
  id: number;
  pool_address?: string | null;
  field?: string | null;
  metric?: string | null;
  old_value: number | null;
  new_value: number | null;
  reason?: string | null;
  rationale?: string | null;
  confidence?: number | null;
  sample_size?: number | null;
  triggered_by?: string | null;
  applied_at: string;
  performance_snapshot?: string | null;
  data_json?: string | null;
}

export interface PortfolioHistoryExport {
  id: number;
  wallet_address: string;
  pool_address: string;
  pool_name?: string | null;
  token_x_mint?: string | null;
  token_y_mint?: string | null;
  token_x_symbol?: string | null;
  token_y_symbol?: string | null;
  bin_step?: number | null;
  base_fee?: number | null;
  total_deposit_usd?: number | null;
  total_deposit_sol?: number | null;
  total_withdrawal_usd?: number | null;
  total_withdrawal_sol?: number | null;
  total_fee_usd?: number | null;
  total_fee_sol?: number | null;
  pnl_usd?: number | null;
  pnl_sol?: number | null;
  pnl_pct_change?: number | null;
  pnl_sol_pct_change?: number | null;
  token_breakdown_json?: string | null;
  last_closed_at?: number | null;
  total_positions_count?: number | null;
  days_back?: number | null;
  fetched_at: string;
  first_seen_at?: string | null;
  fee_efficiency_annualized?: number | null;
  capital_rotation_ratio?: number | null;
  data_freshness_hours?: number | null;
  our_positions_count?: number | null;
  our_total_pnl_pct?: number | null;
  outperformance_delta?: number | null;
  is_active_pool?: number | null;
  lesson_generated?: number | null;
}

export interface PoolDeployExport {
  id: number;
  pool_address: string;
  position_address: string | null;
  deployed_at: string;
  closed_at: string | null;
  pnl_pct: number | null;
  pnl_usd: number | null;
  range_efficiency: number | null;
  minutes_held: number | null;
  close_reason: string | null;
  strategy: string | null;
  volatility_at_deploy: number | null;
  data_json: string | null;
}
