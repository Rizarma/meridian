// types/lessons.d.ts
// Performance learning and lesson types

// ─── Performance Record Types ────────────────────────────────────

export interface PositionPerformance {
  position: string;
  pool: string;
  pool_name: string;
  strategy: string;
  bin_range: number | { min?: number; max?: number; bins_below?: number; bins_above?: number };
  bin_step?: number;
  volatility?: number;
  fee_tvl_ratio?: number;
  organic_score?: number;
  amount_sol: number;
  fees_earned_usd: number;
  final_value_usd: number;
  initial_value_usd: number;
  minutes_in_range: number;
  minutes_held: number;
  close_reason: string;
  base_mint?: string;
  deployed_at?: string;
}

export interface PerformanceRecord extends PositionPerformance {
  pnl_usd: number;
  pnl_pct: number;
  range_efficiency: number;
  recorded_at: string;
}

// ─── Lesson Types ────────────────────────────────────────────────

export type LessonOutcome =
  | "good"
  | "neutral"
  | "poor"
  | "bad"
  | "manual"
  | "evolution"
  | "worked"
  | "failed"
  | "efficient";

export interface LessonEntry {
  id: number;
  rule: string;
  tags: string[];
  outcome: LessonOutcome;
  context?: string;
  pnl_pct?: number;
  range_efficiency?: number;
  pool?: string;
  created_at: string;
  pinned?: boolean;
  role?: "SCREENER" | "MANAGER" | "GENERAL" | null;
}

export interface LessonContext {
  agentType?: "SCREENER" | "MANAGER" | "GENERAL";
  maxLessons?: number;
}

// ─── Threshold Evolution Types ─────────────────────────────────────

export interface ThresholdEvolution {
  maxVolatility?: number;
  minFeeTvlRatio?: number;
  minOrganic?: number;
  [key: string]: number | undefined;
}

export interface EvolutionResult {
  changes: ThresholdEvolution;
  rationale: Record<string, string>;
}

export interface WeightAdjustment {
  signal: string;
  oldWeight: number;
  newWeight: number;
  reason: string;
}

// ─── Performance Metrics ─────────────────────────────────────────

export interface PerformanceMetrics {
  total_positions_closed: number;
  total_pnl_usd: number;
  avg_pnl_pct: number;
  avg_range_efficiency_pct: number;
  win_rate_pct: number;
  total_lessons: number;
  [key: string]: unknown;
}

export interface PerformanceHistoryEntry {
  pool_name: string;
  pool: string;
  strategy: string;
  pnl_usd: number;
  pnl_pct: number;
  fees_earned_usd: number;
  range_efficiency: number;
  minutes_held: number;
  close_reason: string;
  closed_at: string;
}

export interface PerformanceHistoryResult {
  hours: number;
  count: number;
  total_pnl_usd: number;
  win_rate_pct: number | null;
  positions: PerformanceHistoryEntry[];
}

// ─── Lessons Data Structure ────────────────────────────────────────

export interface LessonsData {
  lessons: LessonEntry[];
  performance: PerformanceRecord[];
}

// ─── Role Tags ────────────────────────────────────────────────────

export interface RoleTags {
  SCREENER: string[];
  MANAGER: string[];
  GENERAL: string[];
}

// ─── Lesson List Options ──────────────────────────────────────────

export interface ListLessonsOptions {
  role?: "SCREENER" | "MANAGER" | "GENERAL" | null;
  pinned?: boolean | null;
  tag?: string | null;
  limit?: number;
}

export interface ListedLesson {
  id: number;
  rule: string;
  tags: string[];
  outcome: LessonOutcome;
  pinned: boolean;
  role: "SCREENER" | "MANAGER" | "GENERAL" | "all";
  created_at: string;
}

export interface ListLessonsResult {
  total: number;
  lessons: ListedLesson[];
}
