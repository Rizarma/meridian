// types/briefing.d.ts
// Daily briefing generation types

export interface BriefingData {
  lines: string[];
  toString(): string;
}

export interface ActivityStats {
  openedLast24h: number;
  closedLast24h: number;
  totalPnLUsd: number;
  totalFeesUsd: number;
  winRate24h: number | null;
  lessonsCount: number;
  openPositions: number;
  allTimePnlUsd: number | null;
  allTimeWinRate: number | null;
}

// State file structures (for type-safe loading)
export interface StateFile {
  positions?: Record<string, StatePosition>;
  recentEvents?: unknown[];
}

export interface StatePosition {
  deployed_at: string;
  closed?: boolean;
  closed_at?: string;
  [key: string]: unknown;
}

export interface LessonsFile {
  lessons?: LessonEntry[];
  performance?: PerformanceEntry[];
}

export interface LessonEntry {
  rule: string;
  created_at: string;
  [key: string]: unknown;
}

export interface PerformanceEntry {
  recorded_at: string;
  pnl_usd?: number;
  fees_earned_usd?: number;
  [key: string]: unknown;
}

export interface PerformanceSummary {
  total_pnl_usd: number;
  win_rate_pct: number;
  [key: string]: unknown;
}
