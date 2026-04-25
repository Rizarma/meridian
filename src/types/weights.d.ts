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
  confidence?: number; // 0-1 confidence score (optional for backward compat)
}

export interface WeightConfig {
  windowDays?: number;
  minSamples?: number;
  minWins?: number; // NEW: minimum wins for meaningful class comparison
  minLosses?: number; // NEW: minimum losses for meaningful class comparison
  boostFactor?: number;
  decayFactor?: number;
  weightFloor?: number;
  weightCeiling?: number;
  // Confidence-aware update (Phase 1.1)
  learningRate?: number;
  deadband?: number;
  minConfidence?: number;
  useProportional?: boolean;
  maxMultiplierPerCycle?: number;
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
    // Confidence-aware update (Phase 1.1)
    learningRate?: number;
    deadband?: number;
    minConfidence?: number;
    useProportional?: boolean;
    maxMultiplierPerCycle?: number;
  };
}

export interface RecalculateResult {
  changes: WeightChange[];
  weights: Record<string, number>;
  persisted: boolean;
}
