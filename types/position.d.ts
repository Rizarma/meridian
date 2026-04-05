// types/position.d.ts

export interface Position {
  position: string;
  pool: string;
  pair: string;
  lower_bin: number;
  upper_bin: number;
  active_bin: number;
  in_range: boolean;
  minutes_out_of_range?: number;
  age_minutes?: number;
  total_value_usd: number;
  unclaimed_fees_usd: number;
  pnl_usd?: number;
  pnl_pct?: number;
  pnl_pct_suspicious?: boolean;
  fee_per_tvl_24h?: number;
  instruction?: string;
  base_mint?: string; // Token mint for duplicate detection
  // Extended fields from positionData
  recall?: PoolMemory;
}

export interface PositionData extends Position {
  recall: PoolMemory;
}

export interface MyPositionsResult {
  positions: Position[];
  total_positions: number;
  total_value_usd?: number;
}

export interface ClosePositionResult {
  success: boolean;
  pnl_usd?: number;
  pnl_pct?: number;
  close_txs?: string[];
  claim_txs?: string[];
  txs?: string[];
  error?: string;
}

export interface DeployPositionParams {
  pool_address: string;
  active_bin: number;
  bins_below: number;
  bins_above: number;
  amount_x?: number;
  amount_y?: number;
  amount_sol?: number;
  strategy?: string;
}

export interface DeployPositionResult {
  success: boolean;
  position_address?: string;
  tx?: string;
  error?: string;
}

export interface ClaimFeesResult {
  success: boolean;
  claimed_usd?: number;
  txs?: string[];
  error?: string;
}

export interface TrackedPosition {
  pool: string;
  pair: string;
  position_address: string;
  amount_sol: number;
  timestamp: number;
  oor_since?: number;
  oor_triggers?: number;
  notes?: string[];
  instruction?: string;
}

export interface ExitAlert {
  reason: string;
  triggered_at: number;
}
