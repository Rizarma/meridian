export interface ExportData {
  lessons: LessonExport[];
  performance: PerformanceExport[];
  pools: PoolExport[];
  positions: PositionExport[];
  positionSnapshots: PositionSnapshotExport[];
  positionEvents: PositionEventExport[];
  signalWeights: SignalWeightExport[];
  poolDeploys: PoolDeployExport[];
  exportedAt: string;
  source: string;
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
