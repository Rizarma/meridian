/**
 * Tool Execution Engine
 *
 * Handles parallel tool execution with:
 * - Argument validation for write operations
 * - Lifecycle callbacks (onToolStart, onToolFinish)
 * - Special result formatting (wallet balance)
 * - Error handling with Telegram notifications
 */

import { executeTool } from "../../tools/executor.js";
import { log } from "../infrastructure/logger.js";
import { escapeMarkdownV2 } from "../infrastructure/telegram.js";
import type { AgentType, ToolResult } from "../types/index.js";
import { getErrorMessage } from "../utils/errors.js";
import {
  validateAddLiquidityParams,
  validateClosePositionArgs,
  validateDeployPositionArgs,
  validateSwapTokenArgs,
  validateWithdrawLiquidityParams,
} from "../utils/validation-args.js";
import { safeParseArgs } from "./json-repair.js";
import type { OncePerSessionCheck } from "./once-per-session.js";

/** Tools requiring argument validation before execution */
const WRITE_TOOLS_REQUIRING_VALIDATION = [
  "swap_token",
  "deploy_position",
  "close_position",
  "add_liquidity",
  "withdraw_liquidity",
];

/** Validation result type */
type ValidationResult = { success: true; data: unknown } | { success: false; error: string };

/**
 * Validate tool arguments for write operations.
 *
 * @param functionName - Tool name
 * @param functionArgs - Parsed arguments
 * @returns Validation result
 */
function validateToolArgs(
  functionName: string,
  functionArgs: Record<string, unknown>
): ValidationResult {
  if (!WRITE_TOOLS_REQUIRING_VALIDATION.includes(functionName)) {
    return { success: true, data: functionArgs };
  }

  switch (functionName) {
    case "swap_token":
      return validateSwapTokenArgs(functionArgs);
    case "deploy_position":
      return validateDeployPositionArgs(functionArgs);
    case "close_position":
      return validateClosePositionArgs(functionArgs);
    case "add_liquidity":
      return validateAddLiquidityParams(functionArgs);
    case "withdraw_liquidity":
      return validateWithdrawLiquidityParams(functionArgs);
    default:
      return { success: true, data: functionArgs };
  }
}

/**
 * Format wallet balance result for Telegram output.
 *
 * @param result - Raw tool result
 * @param toolCallId - Tool call ID for response
 * @returns Formatted tool result
 */
async function formatWalletBalanceResult(result: unknown, toolCallId: string): Promise<ToolResult> {
  const { formatWalletBalanceForTelegram } = await import(
    "../infrastructure/telegram-formatters.js"
  );
  const { sendMessageMarkdown } = await import("../infrastructure/telegram.js");

  // Unwrap the result - executeTool wraps results as { success: true, data: {...} }
  const walletData =
    result &&
    typeof result === "object" &&
    "success" in result &&
    result.success &&
    "data" in result
      ? result.data
      : result;

  const formatted = formatWalletBalanceForTelegram(
    walletData as import("../types/wallet.js").WalletBalances
  );

  // Send formatted message directly (don't escape markdown)
  await sendMessageMarkdown(formatted);

  // Return flag indicating output was already sent to user
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify({
      success: true,
      formatted: true,
      output_already_sent: true,
      hint: "Wallet balance displayed above. Acknowledge briefly without repeating data.",
    }),
  };
}

/**
 * Execute a single tool with validation, callbacks, and error handling.
 *
 * @param entry - Pre-checked tool call entry
 * @param agentType - Current agent type
 * @param step - Current ReAct step
 * @param onToolStart - Optional start callback
 * @param onToolFinish - Optional finish callback
 * @returns Tool result for message history
 */
async function executeSingleTool(
  entry: OncePerSessionCheck,
  agentType: AgentType,
  step: number,
  onToolStart?:
    | ((info: { name: string; args: Record<string, unknown>; step: number }) => void)
    | null,
  onToolFinish?:
    | ((info: {
        name: string;
        args: Record<string, unknown>;
        result: unknown;
        success: boolean;
        step: number;
      }) => void)
    | null
): Promise<ToolResult> {
  const { toolCall, functionName } = entry;

  try {
    const functionArgs = safeParseArgs(toolCall.function.arguments, functionName);

    // Validate tool arguments before execution for write operations
    const validation = validateToolArgs(functionName, functionArgs);

    if (!validation.success) {
      log("agent", `Validation failed for ${functionName}: ${validation.error}`);
      const errorResult = {
        error: `Invalid arguments: ${validation.error}`,
        success: false,
        blocked: true,
      };
      await onToolFinish?.({
        name: functionName,
        args: functionArgs,
        result: errorResult,
        success: false,
        step,
      });
      return {
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(errorResult),
      };
    }

    await onToolStart?.({ name: functionName, args: functionArgs, step });
    const result = await executeTool(functionName, functionArgs, agentType);
    await onToolFinish?.({
      name: functionName,
      args: functionArgs,
      result,
      success: result?.success !== false && !result?.error && !result?.blocked,
      step,
    });

    // Special formatting for wallet balance to ensure clean Telegram output
    if (functionName === "get_wallet_balance") {
      return formatWalletBalanceResult(result, toolCall.id);
    }

    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(result),
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    log("error", `Tool ${toolCall.function.name} failed: ${errorMessage}`);

    // Send formatted error to Telegram so LLM doesn't generate its own markdown
    const { sendMessageMarkdown } = await import("../infrastructure/telegram.js");
    const safeToolName = escapeMarkdownV2(toolCall.function.name);
    const safeError = escapeMarkdownV2(errorMessage);
    await sendMessageMarkdown(
      `❌ *Error in ${safeToolName}*\n\n${safeError}\n\n_Using cached state..._`
    );

    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        error: errorMessage,
        success: false,
      }),
    };
  }
}

/**
 * Execute all pre-checked tool calls in parallel.
 *
 * @param preCheckedCalls - Array of pre-checked tool call entries
 * @param agentType - Current agent type
 * @param step - Current ReAct step
 * @param onToolStart - Optional start callback
 * @param onToolFinish - Optional finish callback
 * @returns Array of tool results for message history
 */
export async function executeToolsParallel(
  preCheckedCalls: OncePerSessionCheck[],
  agentType: AgentType,
  step: number,
  onToolStart?:
    | ((info: { name: string; args: Record<string, unknown>; step: number }) => void)
    | null,
  onToolFinish?:
    | ((info: {
        name: string;
        args: Record<string, unknown>;
        result: unknown;
        success: boolean;
        step: number;
      }) => void)
    | null
): Promise<ToolResult[]> {
  return Promise.all(
    preCheckedCalls.map((entry) =>
      executeSingleTool(entry, agentType, step, onToolStart, onToolFinish)
    )
  );
}
