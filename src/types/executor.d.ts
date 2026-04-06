// types/executor.d.ts
// Tool executor types for the central dispatcher

import type { Config } from "./config.js";

// Tool names
export type ToolName =
  | "discover_pools"
  | "get_top_candidates"
  | "get_pool_detail"
  | "get_position_pnl"
  | "get_active_bin"
  | "deploy_position"
  | "get_my_positions"
  | "get_wallet_positions"
  | "search_pools"
  | "get_token_info"
  | "get_token_holders"
  | "get_token_narrative"
  | "add_smart_wallet"
  | "remove_smart_wallet"
  | "list_smart_wallets"
  | "check_smart_wallets_on_pool"
  | "claim_fees"
  | "close_position"
  | "get_wallet_balance"
  | "swap_token"
  | "get_top_lpers"
  | "study_top_lpers"
  | "set_position_note"
  | "self_update"
  | "get_performance_history"
  | "add_strategy"
  | "list_strategies"
  | "get_strategy"
  | "set_active_strategy"
  | "remove_strategy"
  | "get_pool_memory"
  | "add_pool_note"
  | "add_to_blacklist"
  | "remove_from_blacklist"
  | "list_blacklist"
  | "block_deployer"
  | "unblock_deployer"
  | "list_blocked_deployers"
  | "add_lesson"
  | "pin_lesson"
  | "unpin_lesson"
  | "list_lessons"
  | "clear_lessons"
  | "update_config";

export type WriteTool = "deploy_position" | "claim_fees" | "close_position" | "swap_token";
export type ProtectedTool = WriteTool | "self_update";

// Tool function type - handlers can have any parameter type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolFunction = (args: any) => Promise<unknown> | unknown;

export interface ToolMap {
  [key: string]: ToolFunction;
}

// Safety checks
export interface SafetyCheckResult {
  pass: boolean;
  reason?: string;
}

// Tool execution
export interface ToolExecutionResult {
  error?: string;
  blocked?: boolean;
  reason?: string;
  success?: boolean;
  [key: string]: unknown;
}

// Config update
export interface ConfigChangeMap {
  [key: string]: [string, string]; // [section, field]
}

export interface UpdateConfigInput {
  changes: Record<string, string | number | boolean>;
  reason?: string;
}

export interface UpdateConfigResult {
  success: boolean;
  applied?: Record<string, string | number | boolean>;
  unknown?: string[];
  reason?: string;
  error?: string;
}

// Cron
export type CronRestarter = () => void;

// Action logging
export interface ActionLog {
  tool: string;
  args: unknown;
  result?: unknown;
  error?: string;
  duration_ms: number;
  success: boolean;
}

// Tool-specific argument types
export interface DeployPositionArgs {
  pool_address: string;
  bin_step?: number;
  amount_y?: number;
  amount_sol?: number;
  base_mint?: string;
  [key: string]: unknown;
}

export interface SwapTokenArgs {
  input_mint: string;
  output_mint: string;
  amount: number;
  [key: string]: unknown;
}

export interface ClosePositionArgs {
  position_address: string;
  pool_address?: string;
  reason?: string;
  skip_swap?: boolean;
  [key: string]: unknown;
}

export interface SetPositionNoteArgs {
  position_address: string;
  instruction?: string;
}

export interface ClearLessonsArgs {
  mode: "all" | "performance" | "keyword";
  keyword?: string;
}

export interface AddLessonArgs {
  rule: string;
  tags?: string[];
  pinned?: boolean;
  role?: string;
}

export interface LessonIdArgs {
  id: string;
}

export interface ListLessonsArgs {
  role?: string;
  pinned?: boolean;
  tag?: string;
  limit?: number;
}
