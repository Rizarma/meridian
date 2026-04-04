// types/logger.d.ts
// Logging types for Meridian DLMM Agent

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogCategory =
  | "startup"
  | "cron"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "deploy"
  | "close"
  | "claim"
  | "swap"
  | "screen"
  | "manage"
  | "telegram"
  | "hive"
  | string;

export interface LogAction {
  tool: string;
  success: boolean;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  duration_ms?: number;
  error?: string;
}

export interface LogSnapshot {
  total_value_usd: number;
  total_positions: number;
  unclaimed_fees_usd?: number;
  sol_balance?: number;
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  category: LogCategory;
  message: string;
  level: LogLevel;
}
