/**
 * Once-Per-Session Tool Guard
 *
 * Prevents duplicate execution of destructive tools within a single session.
 * Uses pre-reservation to prevent race conditions when multiple identical
 * tool calls arrive in the same LLM response.
 *
 * Safety-critical: deploy_position, swap_token, close_position
 */

import { log } from "../infrastructure/logger.js";

/** Tools that can only be executed once per session */
export const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);

/** Check if a tool is restricted to once-per-session */
export function isOncePerSessionTool(functionName: string): boolean {
  return ONCE_PER_SESSION.has(functionName);
}

/**
 * Result of checking a tool call against once-per-session rules
 */
export interface OncePerSessionCheck {
  toolCall: {
    id: string;
    function: { name: string; arguments: string };
  };
  functionName: string;
  blocked: boolean;
  reason?: string;
}

/**
 * Pre-check all tool calls for once-per-session violations.
 * Reserves tools BEFORE async execution to prevent race conditions.
 *
 * @param toolCalls - Array of tool calls from LLM response
 * @param firedOnce - Set of tools already executed in this session
 * @returns Array of checked tool calls with block status
 */
export function preCheckOncePerSession(
  toolCalls: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>,
  firedOnce: Set<string>
): OncePerSessionCheck[] {
  const reservedOncePerSession = new Set<string>();

  return toolCalls.map((toolCall) => {
    const functionName = toolCall.function.name.replace(/<.*$/, "").trim();

    // Not a once-per-session tool — always allowed
    if (!ONCE_PER_SESSION.has(functionName)) {
      return { toolCall, functionName, blocked: false };
    }

    // Already fired in a previous step, or already reserved by a sibling call
    if (firedOnce.has(functionName) || reservedOncePerSession.has(functionName)) {
      log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
      return {
        toolCall,
        functionName,
        blocked: true,
        reason: `${functionName} is allowed only once per session`,
      };
    }

    // Reserve this tool — mark BEFORE async execution starts
    reservedOncePerSession.add(functionName);
    firedOnce.add(functionName);
    return { toolCall, functionName, blocked: false };
  });
}

/**
 * Create a blocked tool result for a once-per-session violation.
 *
 * @param functionName - Name of the blocked tool
 * @returns Tool result content string
 */
export function createBlockedResult(functionName: string): string {
  return JSON.stringify({
    blocked: true,
    reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.`,
  });
}
