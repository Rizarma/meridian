/**
 * Signal tracking types for Darwinian weighting system
 */

export interface SignalSnapshot {
  organic_score?: number;
  fee_tvl_ratio?: number;
  volume?: number;
  mcap?: number;
  holder_count?: number;
  smart_wallets_present?: boolean;
  narrative_quality?: string;

  hive_consensus?: number;
  volatility?: number;
}

export interface StagedSignals extends SignalSnapshot {
  staged_at: number;
}
