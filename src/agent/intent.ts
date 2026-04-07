/**
 * Intent Routing — Unified intent detection and tool mapping.
 *
 * This module consolidates the parallel INTENT_TOOLS and INTENT_PATTERNS
 * structures from agent.ts into a single source of truth.
 *
 * Pattern: Single Responsibility Principle — one edit surface for
 * intent patterns, roles, and required tools.
 */

import type { AgentType } from "../types/index.js";

export interface IntentDefinition {
  /** Intent identifier (e.g., "deploy", "close", "manage") */
  intent: string;
  /** Regex pattern to detect this intent in user input */
  pattern: RegExp;
  /** Agent role associated with this intent */
  role: AgentType;
  /** Tools required for this intent */
  requiredTools: string[];
}

/**
 * Unified intent definitions — pattern + role + tools in one structure.
 *
 * This replaces the parallel INTENT_TOOLS and INTENT_PATTERNS structures
 * that had to be kept in sync manually.
 */
export const INTENTS: IntentDefinition[] = [
  {
    intent: "deploy",
    pattern: /\b(deploy|open|add liquidity|lp into|invest in)\b/i,
    role: "SCREENER",
    requiredTools: [
      "deploy_position",
      "get_top_candidates",
      "get_active_bin",
      "get_pool_memory",
      "check_smart_wallets_on_pool",
      "get_token_holders",
      "get_token_narrative",
      "get_token_info",
      "search_pools",
      "get_wallet_balance",
      "get_my_positions",
      "add_pool_note",
    ],
  },
  {
    intent: "close",
    pattern: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i,
    role: "MANAGER",
    requiredTools: [
      "close_position",
      "get_my_positions",
      "get_position_pnl",
      "get_wallet_balance",
      "swap_token",
    ],
  },
  {
    intent: "claim",
    pattern: /\b(claim|harvest|collect)\b.*\bfee/i,
    role: "MANAGER",
    requiredTools: ["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"],
  },
  {
    intent: "swap",
    pattern: /\b(swap|convert|sell|exchange)\b/i,
    role: "MANAGER",
    requiredTools: ["swap_token", "get_wallet_balance"],
  },
  {
    intent: "selfupdate",
    pattern:
      /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i,
    role: "GENERAL",
    requiredTools: ["self_update"],
  },
  {
    intent: "blocklist",
    pattern:
      /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i,
    role: "GENERAL",
    requiredTools: [
      "add_to_blacklist",
      "remove_from_blacklist",
      "list_blacklist",
      "block_deployer",
      "unblock_deployer",
      "list_blocked_deployers",
    ],
  },
  {
    intent: "config",
    pattern: /\b(config|setting|threshold|update|set |change)\b/i,
    role: "GENERAL",
    requiredTools: ["update_config"],
  },
  {
    intent: "balance",
    pattern: /\b(balance|wallet|sol|how much)\b/i,
    role: "GENERAL",
    requiredTools: ["get_wallet_balance", "get_my_positions", "get_wallet_positions"],
  },
  {
    intent: "positions",
    pattern: /\b(position|portfolio|open|pnl|yield|range)\b/i,
    role: "MANAGER",
    requiredTools: [
      "get_my_positions",
      "get_position_pnl",
      "get_wallet_balance",
      "set_position_note",
      "get_wallet_positions",
    ],
  },
  {
    intent: "strategy",
    pattern: /\b(strategy|strategies)\b/i,
    role: "GENERAL",
    requiredTools: [
      "list_strategies",
      "get_strategy",
      "add_strategy",
      "remove_strategy",
      "set_active_strategy",
    ],
  },
  {
    intent: "screen",
    pattern: /\b(screen|candidate|find pool|search|research|token)\b/i,
    role: "SCREENER",
    requiredTools: [
      "get_top_candidates",
      "get_token_holders",
      "get_token_narrative",
      "get_token_info",
      "search_pools",
      "check_smart_wallets_on_pool",
      "get_pool_detail",
      "get_my_positions",
      "discover_pools",
    ],
  },
  {
    intent: "memory",
    pattern: /\b(memory|pool history|note|remember)\b/i,
    role: "GENERAL",
    requiredTools: [
      "get_pool_memory",
      "add_pool_note",
      "list_blacklist",
      "add_to_blacklist",
      "remove_from_blacklist",
    ],
  },
  {
    intent: "smartwallet",
    pattern:
      /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i,
    role: "GENERAL",
    requiredTools: [
      "add_smart_wallet",
      "remove_smart_wallet",
      "list_smart_wallets",
      "check_smart_wallets_on_pool",
    ],
  },
  {
    intent: "study",
    pattern: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i,
    role: "GENERAL",
    requiredTools: [
      "study_top_lpers",
      "get_top_lpers",
      "get_pool_detail",
      "search_pools",
      "get_token_info",
      "discover_pools",
      "add_smart_wallet",
      "list_smart_wallets",
    ],
  },
  {
    intent: "performance",
    pattern: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i,
    role: "GENERAL",
    requiredTools: ["get_performance_history", "get_my_positions", "get_position_pnl"],
  },
  {
    intent: "lessons",
    pattern: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i,
    role: "GENERAL",
    requiredTools: ["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"],
  },
];

/**
 * Get all unique tools for a matched intent.
 * Used by agent.ts getToolsForRole() for GENERAL agent type.
 */
export function getToolsForIntent(intent: string): string[] {
  const intentDef = INTENTS.find((i) => i.intent === intent);
  return intentDef?.requiredTools ?? [];
}

/**
 * Detect intent from user goal string.
 * Returns the first matching intent or null if no match.
 */
export function detectIntent(goal: string): string | null {
  for (const intent of INTENTS) {
    if (intent.pattern.test(goal)) {
      return intent.intent;
    }
  }
  return null;
}

/**
 * Get ALL intents that match the goal pattern.
 * Used for unioning tools from multiple matching intents (production behavior).
 */
export function detectAllIntents(goal: string): string[] {
  const matched: string[] = [];
  for (const intent of INTENTS) {
    if (intent.pattern.test(goal)) {
      matched.push(intent.intent);
    }
  }
  return matched;
}

/**
 * Get the agent role for a detected intent.
 */
export function getRoleForIntent(intent: string): AgentType | null {
  const intentDef = INTENTS.find((i) => i.intent === intent);
  return intentDef?.role ?? null;
}

/**
 * Legacy compatibility: Intent key type for type-safe lookups.
 * @deprecated Use string intent identifiers directly
 */
export type IntentKey = (typeof INTENTS)[number]["intent"];
