// types/tools.d.ts
// Tool definition types for OpenAI-compatible function calling

export interface ToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: {
    type: string;
  };
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolFunction {
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ToolDefinition {
  type: "function";
  function: ToolFunction;
}

export type ToolName =
  | "discover_pools"
  | "get_top_candidates"
  | "get_pool_detail"
  | "get_active_bin"
  | "deploy_position"
  | "get_position_pnl"
  | "get_my_positions"
  | "claim_fees"
  | "close_position"
  | "get_wallet_positions"
  | "get_wallet_balance"
  | "swap_token"
  | "update_config"
  | "self_update"
  | "add_smart_wallet"
  | "remove_smart_wallet"
  | "list_smart_wallets"
  | "check_smart_wallets_on_pool"
  | "get_token_info"
  | "get_token_holders"
  | "get_token_narrative"
  | "search_pools"
  | "get_top_lpers"
  | "study_top_lpers"
  | "clear_lessons"
  | "set_position_note"
  | "add_lesson"
  | "add_strategy"
  | "list_strategies"
  | "get_strategy"
  | "set_active_strategy"
  | "remove_strategy"
  | "list_lessons"
  | "pin_lesson"
  | "unpin_lesson"
  | "get_performance_history"
  | "get_pool_memory"
  | "add_pool_note"
  | "add_to_blacklist"
  | "remove_from_blacklist"
  | "list_blacklist"
  | "block_deployer"
  | "unblock_deployer"
  | "list_blocked_deployers";
