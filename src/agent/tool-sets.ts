/**
 * Tool Sets for Role-Based Access Control
 *
 * Side-effect-free module containing the source of truth for which tools
 * are available to each agent role. Imported by both agent.ts and tests.
 */

/** Tools available to the MANAGER role (position management) */
export const MANAGER_TOOLS: Set<string> = new Set([
  "close_position",
  "claim_fees",
  "swap_token",
  "get_position_pnl",
  "get_my_positions",
  "get_wallet_balance",
  "add_liquidity",
  "withdraw_liquidity",
]);

/** Tools available to the SCREENER role (pool discovery and deployment) */
export const SCREENER_TOOLS: Set<string> = new Set([
  "deploy_position",
  "get_active_bin",
  "get_top_candidates",
  "check_smart_wallets_on_pool",
  "get_token_holders",
  "get_token_narrative",
  "get_token_info",
  "search_pools",
  "get_pool_memory",
  "get_wallet_balance",
  "get_my_positions",
]);

/**
 * Tools that require specific intent matching in GENERAL role.
 * These are restricted and cannot be called without matching intent patterns.
 */
export const GENERAL_INTENT_ONLY_TOOLS: Set<string> = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);
