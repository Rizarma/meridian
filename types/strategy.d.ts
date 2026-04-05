/**
 * Strategy library types
 */

export type LPStrategyType = "bid_ask" | "spot" | "curve" | "any" | "mixed";

export interface TokenCriteria {
  min_mcap?: number;
  min_age_days?: number;
  requires_kol?: boolean;
  notes?: string;
}

export interface EntryCriteria {
  condition?: string;
  price_change_threshold_pct?: number;
  single_side?: "token" | "sol" | null;
  notes?: string;
  example_patterns?: Record<string, string>;
}

export interface RangeCriteria {
  type?: "custom" | "default";
  bins_below_pct?: number;
  notes?: string;
}

export interface ExitCriteria {
  take_profit_pct?: number;
  notes?: string;
}

export interface Strategy {
  id: string;
  name: string;
  author: string;
  lp_strategy: LPStrategyType;
  token_criteria: TokenCriteria;
  entry: EntryCriteria;
  range: RangeCriteria;
  exit: ExitCriteria;
  best_for: string;
  raw?: string;
  added_at?: string;
  updated_at?: string;
}

export interface StrategyDB {
  active: string | null;
  strategies: { [id: string]: Strategy };
}
