// Shared domain types to prevent circular dependencies

export interface Lesson {
  id: string;
  timestamp: number;
  type: "exit" | "signal" | "threshold";
  outcome: "success" | "failure" | "partial";
  data: Record<string, unknown>;
}

export interface ExitRule {
  condition: string;
  action: "close" | "partial_close" | "alert";
  priority: number;
}

export interface PerformanceMetrics {
  winRate: number;
  avgReturn: number;
  totalTrades: number;
  consecutiveLosses: number;
}

export interface PositionOutcome {
  positionId: string;
  exitPrice: number;
  pnl: number;
  exitReason: string;
  timestamp: number;
}
