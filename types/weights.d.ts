/**
 * Signal weights types for Darwinian weighting system
 */

export interface SignalWeights {
  weights: { [signal: string]: number };
  last_recalc: string | null;
  recalc_count: number;
  history: WeightHistoryEntry[];
}

export interface WeightHistoryEntry {
  timestamp: string;
  changes: WeightChange[];
  window_size: number;
  win_count: number;
  loss_count: number;
}

export interface WeightChange {
  signal: string;
  from: number;
  to: number;
  lift: number;
  action: "boosted" | "decayed";
}

export interface WeightConfig {
  windowDays?: number;
  minSamples?: number;
  boostFactor?: number;
  decayFactor?: number;
  weightFloor?: number;
  weightCeiling?: number;
}

export interface LiftResult {
  signal: string;
  lift: number;
}

export interface PerformanceRecord {
  pnl_usd?: number;
  recorded_at?: string;
  closed_at?: string;
  deployed_at?: string;
  signal_snapshot?: Record<string, unknown>;
}

export interface RecalculateConfig {
  darwin?: {
    windowDays?: number;
    minSamples?: number;
    boostFactor?: number;
    decayFactor?: number;
    weightFloor?: number;
    weightCeiling?: number;
  };
}

export interface RecalculateResult {
  changes: WeightChange[];
  weights: Record<string, number>;
}
