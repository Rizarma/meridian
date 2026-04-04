// types/pool-memory.d.ts
// Pool memory types for deploy history and snapshots

export interface PoolDeploy {
  deployed_at: string | null;
  closed_at: string;
  pnl_pct: number | null;
  pnl_usd: number | null;
  range_efficiency: number | null;
  minutes_held: number | null;
  close_reason: string | null;
  strategy: string | null;
  volatility_at_deploy: number | null;
}

export interface PoolSnapshot {
  ts: string;
  position: string;
  pnl_pct: number | null;
  pnl_usd: number | null;
  in_range: boolean | null;
  unclaimed_fees_usd: number | null;
  minutes_out_of_range: number | null;
  age_minutes: number | null;
}

export interface PoolNote {
  note: string;
  added_at: string;
}

export interface PoolMemoryEntry {
  name: string;
  base_mint: string | null;
  deploys: PoolDeploy[];
  total_deploys: number;
  avg_pnl_pct: number;
  win_rate: number;
  last_deployed_at: string | null;
  last_outcome: "profit" | "loss" | null;
  notes: PoolNote[];
  snapshots?: PoolSnapshot[];
  cooldown_until?: string;
  cooldown_reason?: string;
  base_mint_cooldown_until?: string;
  base_mint_cooldown_reason?: string;
}

export interface PoolMemoryDB {
  [poolAddress: string]: PoolMemoryEntry;
}

export interface PoolMemoryInput {
  pool_name?: string;
  base_mint?: string;
  deployed_at?: string;
  closed_at?: string;
  pnl_pct?: number;
  pnl_usd?: number;
  range_efficiency?: number;
  minutes_held?: number;
  close_reason?: string;
  strategy?: string;
  volatility?: number;
}

export interface PoolMemoryResult {
  pool_address: string;
  known: boolean;
  name?: string;
  base_mint?: string | null;
  total_deploys?: number;
  avg_pnl_pct?: number;
  win_rate?: number;
  last_deployed_at?: string | null;
  last_outcome?: "profit" | "loss" | null;
  cooldown_until?: string | null;
  cooldown_reason?: string | null;
  base_mint_cooldown_until?: string | null;
  base_mint_cooldown_reason?: string | null;
  notes?: PoolNote[];
  history?: PoolDeploy[];
  message?: string;
  error?: string;
}

export interface PositionSnapshotInput {
  pair?: string;
  position: string;
  pnl_pct?: number | null;
  pnl_usd?: number | null;
  in_range?: boolean | null;
  unclaimed_fees_usd?: number | null;
  minutes_out_of_range?: number | null;
  age_minutes?: number | null;
}

export interface PoolNoteInput {
  pool_address: string;
  note: string;
}

export interface PoolNoteResult {
  saved: boolean;
  pool_address: string;
  note: string;
  error?: string;
}
