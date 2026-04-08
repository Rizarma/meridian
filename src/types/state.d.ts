/**
 * Position state tracking types
 */

import type { SignalSnapshot } from "./signals.js";
import type { Strategy } from "./strategy.js";

export interface BinRange {
  min?: number;
  max?: number;
  active?: number;
  bins_below?: number;
  bins_above?: number;
}

export interface TrackedPosition {
  position: string;
  pool: string;
  pool_name: string;
  strategy: string;
  strategy_config?: Strategy | null; // Full strategy object stored at deploy time
  bin_range: BinRange;
  amount_sol: number;
  amount_x: number;
  active_bin_at_deploy: number;
  bin_step: number;
  volatility: number;
  fee_tvl_ratio: number;
  initial_fee_tvl_24h: number;
  organic_score: number;
  initial_value_usd: number;
  signal_snapshot: SignalSnapshot | null;
  deployed_at: string;
  out_of_range_since: string | null;
  last_claim_at: string | null;
  total_fees_claimed_usd: number;
  rebalance_count: number;
  closed: boolean;
  closed_at: string | null;
  notes: string[];
  peak_pnl_pct: number;
  pending_peak_pnl_pct: number | null;
  pending_peak_started_at: string | null;
  trailing_active: boolean;
  instruction?: string | null;
  // Trailing drop confirmation fields
  pending_trailing_current_pnl_pct?: number | null;
  pending_trailing_peak_pnl_pct?: number | null;
  pending_trailing_drop_pct?: number | null;
  pending_trailing_started_at?: string | null;
  confirmed_trailing_exit_reason?: string | null;
  confirmed_trailing_exit_until?: string | null;
}

export interface StateEvent {
  ts: string;
  action: string;
  position?: string;
  pool_name?: string;
  reason?: string;
}

export interface PositionState {
  positions: { [address: string]: TrackedPosition };
  recentEvents: StateEvent[];
  lastUpdated: string | null;
  _lastBriefingDate?: string;
}

export interface PositionData {
  pnl_pct: number | null;
  pnl_pct_suspicious?: boolean;
  in_range: boolean;
  fee_per_tvl_24h?: number | null;
  age_minutes?: number | null;
}

export interface ManagementConfig {
  trailingTakeProfit?: boolean;
  trailingTriggerPct?: number;
  trailingDropPct?: number | null;
  stopLossPct?: number;
  outOfRangeWaitMinutes?: number;
  minFeePerTvl24h?: number;
  minAgeBeforeYieldCheck?: number;
  // Fields needed by evaluateManagementExitRules
  takeProfitFeePct?: number;
  outOfRangeBinsToClose?: number;
  minClaimAmount?: number;
}

export interface ExitAction {
  action: "STOP_LOSS" | "TRAILING_TP" | "OUT_OF_RANGE" | "LOW_YIELD";
  reason: string;
  needs_confirmation?: boolean;
  peak_pnl_pct?: number | null;
  current_pnl_pct?: number | null;
}

export interface PeakConfirmation {
  confirmed: boolean;
  peak?: number;
  rejected?: boolean;
  pendingPeak?: number;
  pending: boolean;
}

export interface TrailingConfirmation {
  confirmed: boolean;
  rejected?: boolean;
  pending: boolean;
}

export interface StateSummary {
  open_positions: number;
  closed_positions: number;
  total_fees_claimed_usd: number;
  positions: Array<{
    position: string;
    pool: string;
    strategy: string;
    deployed_at: string;
    out_of_range_since: string | null;
    minutes_out_of_range: number;
    total_fees_claimed_usd: number;
    initial_fee_tvl_24h: number;
    rebalance_count: number;
    instruction: string | null;
  }>;
  last_updated: string | null;
  recent_events: StateEvent[];
}
