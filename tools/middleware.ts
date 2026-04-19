/**
 * Middleware Chain
 *
 * Composable middleware layers for cross-cutting concerns:
 * - Safety checks (for write tools)
 * - Action logging
 * - Telegram notifications
 * - Persistence
 *
 * Pattern: Chain of Responsibility via reduceRight
 * No framework — just functions.
 *
 * Refactored to use Dependency Injection - no direct imports from domain/infrastructure.
 */

import { LIMITS } from "../src/config/constants.js";
import type { DeployResult } from "../src/infrastructure/persistence.js";
import type { Config } from "../src/types/config.js";
import type {
  DeployPositionArgs,
  SafetyCheckResult,
  SwapTokenArgs,
} from "../src/types/executor.js";
import type { AgentType } from "../src/types/index.js";
import type { PositionPerformance } from "../src/types/lessons.js";
import type { LogAction } from "../src/types/logger.js";
import type { ToolRegistration } from "./registry.js";

// Re-export types for convenience
export type { DeployResult } from "../src/infrastructure/persistence.js";

/** Middleware function type */
export type MiddlewareFn = (
  tool: ToolRegistration,
  args: unknown,
  role: AgentType,
  next: () => Promise<unknown>
) => Promise<unknown>;

/**
 * Logger interface - injected dependency
 */
export interface Logger {
  log(category: string, message: string): void;
  logAction(action: LogAction): void;
}

/**
 * Notification service interface - injected dependency
 */
export interface NotificationService {
  notifySwap(
    inputSymbol: string,
    outputSymbol: string,
    amountIn?: number,
    amountOut?: number,
    tx?: string
  ): Promise<void>;
  notifyDeploy(
    pair: string,
    amountSol: number,
    position?: string,
    tx?: string,
    priceRange?: { min: number; max: number },
    binStep?: number,
    baseFee?: number
  ): Promise<void>;
  notifyClose(pair: string, pnlUsd: number, pnlPct: number): Promise<void>;
}

/**
 * Persistence service interface - injected dependency
 */
export interface PersistenceService {
  trackPosition(deployResult: DeployResult): Promise<void>;
  recordClaim(position: string): Promise<void>;
  recordClose(position: string, reason: string): Promise<void>;
  recordPerformance(perf: PositionPerformance): Promise<void>;
}

/**
 * Auto-swap service interface - injected dependency
 */
export interface AutoSwapService {
  handleAutoSwapAfterClose(
    baseMint: string,
    result: Record<string, unknown>,
    poolAddress?: string,
    closeReason?: string
  ): Promise<void>;
  handleAutoSwapAfterClaim(baseMint: string): Promise<void>;
}

/**
 * Safety check service interface - injected dependency
 */
export interface SafetyCheckService {
  runSafetyChecks(name: string, args: unknown): Promise<SafetyCheckResult>;
}

/**
 * Validation helpers interface - injected dependency
 */
export interface ValidationHelpers {
  validateSwapTokenArgs(args: unknown): { success: boolean; data?: SwapTokenArgs; error?: string };
  validateDeployPositionArgs(args: unknown): {
    success: boolean;
    data?: DeployPositionArgs;
    error?: string;
  };
  validateClosePositionArgs(args: unknown): {
    success: boolean;
    data?: {
      position_address?: string;
      reason?: string;
      skip_swap?: boolean;
      pool_address?: string;
    };
    error?: string;
  };
}

/**
 * Middleware context - all dependencies injected
 */
export interface MiddlewareContext {
  config: Config;
  logger: Logger;
  notificationService: NotificationService;
  persistenceService: PersistenceService;
  autoSwapService: AutoSwapService;
  safetyCheckService: SafetyCheckService;
  validation: ValidationHelpers;
}

/**
 * Apply a chain of middleware to a tool execution.
 * Uses reduceRight to compose middleware layers.
 */
export function applyMiddleware(
  tool: ToolRegistration,
  args: unknown,
  role: AgentType,
  chain: MiddlewareFn[],
  handler: (args: unknown) => Promise<unknown>
): Promise<unknown> {
  // Build the middleware chain from inside out
  // Start with the handler execution
  let next: () => Promise<unknown> = async () => handler(args);

  // Wrap with each middleware layer (from last to first)
  for (let i = chain.length - 1; i >= 0; i--) {
    const mw = chain[i];
    const currentNext = next;
    next = () => mw(tool, args, role, currentNext);
  }

  return next();
}

/**
 * Validate that a value is a valid object result with expected shape.
 * Returns the object if valid, or creates a safe error result.
 */
function validateResultObject(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null) {
    return { success: false, error: "Invalid result: not an object" };
  }
  return result as Record<string, unknown>;
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result: unknown): unknown {
  const str = JSON.stringify(result);
  if (str.length > LIMITS.MAX_LOG_LENGTH) {
    return `${str.slice(0, LIMITS.MAX_LOG_LENGTH)}...(truncated)`;
  }
  return result;
}

/**
 * Create safety check middleware factory.
 * Runs pre-execution checks for write tools.
 */
export function createSafetyCheckMiddleware(context: MiddlewareContext): MiddlewareFn {
  const { safetyCheckService, logger } = context;

  return async (tool, args, _role, next) => {
    if (!tool.isWriteTool) {
      return next();
    }

    const check = await safetyCheckService.runSafetyChecks(tool.name, args);
    if (!check.pass) {
      logger.log("safety_block", `${tool.name} blocked: ${check.reason}`);
      return {
        blocked: true,
        reason: check.reason,
      };
    }

    return next();
  };
}

/**
 * Create logging middleware factory.
 * Logs all tool executions to daily JSONL.
 */
export function createLoggingMiddleware(context: MiddlewareContext): MiddlewareFn {
  const { logger } = context;

  return async (tool, args, _role, next) => {
    const startTime = Date.now();

    try {
      const rawResult = await next();
      const result = validateResultObject(rawResult);
      const duration = Date.now() - startTime;
      const success = result?.success !== false && !result?.error && !result?.blocked;

      logger.logAction({
        tool: tool.name,
        args: args as Record<string, unknown>,
        result: summarizeResult(result),
        duration_ms: duration,
        success,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      logger.logAction({
        tool: tool.name,
        args: args as Record<string, unknown>,
        error: errorMsg,
        duration_ms: duration,
        success: false,
      });

      throw error;
    }
  };
}

/**
 * Create notification middleware factory.
 * Sends Telegram alerts for write tools after successful execution.
 */
export function createNotificationMiddleware(context: MiddlewareContext): MiddlewareFn {
  const { notificationService, autoSwapService, validation, logger } = context;

  return async (tool, args, _role, next) => {
    const rawResult = await next();
    const result = validateResultObject(rawResult);

    // Only notify on successful write operations
    if (result?.error || result?.blocked) {
      return result;
    }

    // Handle specific tool notifications
    if (tool.name === "swap_token" && result?.tx) {
      const validationResult = validation.validateSwapTokenArgs(args);
      if (!validationResult.success) {
        logger.log("notify_error", `Invalid swap_token args: ${validationResult.error}`);
        return result;
      }
      const swapArgs = validationResult.data!;
      await notificationService.notifySwap(
        swapArgs.input_mint?.slice(0, 8) || "?",
        swapArgs.output_mint || "?",
        result.amount_in ? parseFloat(String(result.amount_in)) : undefined,
        result.amount_out ? parseFloat(String(result.amount_out)) : undefined,
        (result.tx as string) || undefined
      );
    } else if (tool.name === "deploy_position") {
      const validationResult = validation.validateDeployPositionArgs(args);
      if (!validationResult.success) {
        logger.log("notify_error", `Invalid deploy_position args: ${validationResult.error}`);
        return result;
      }
      const deployArgs = validationResult.data as DeployPositionArgs & { pool_name?: string };
      await notificationService.notifyDeploy(
        (result.pool_name as string) ||
          deployArgs.pool_name ||
          deployArgs.pool_address?.slice(0, 8) ||
          "unknown",
        deployArgs.amount_y ?? deployArgs.amount_sol ?? 0,
        (result.position as string) || undefined,
        ((result.txs as string[])?.[0] ?? (result.tx as string)) || undefined,
        (result.price_range as { min: number; max: number }) || undefined,
        (result.bin_step as number) || undefined,
        (result.base_fee as number) || undefined
      );
    } else if (tool.name === "close_position") {
      const validationResult = validation.validateClosePositionArgs(args);
      if (!validationResult.success) {
        logger.log("notify_error", `Invalid close_position args: ${validationResult.error}`);
        return result;
      }
      const closeArgs = validationResult.data!;
      await notificationService.notifyClose(
        (result.pool_name as string) || closeArgs.position_address?.slice(0, 8) || "unknown",
        (result.pnl_usd as number) ?? 0,
        (result.pnl_pct as number) ?? 0
      );

      // Auto-swap base token back to SOL unless user said to hold
      if (!closeArgs.skip_swap && result.base_mint) {
        await autoSwapService.handleAutoSwapAfterClose(
          result.base_mint as string,
          result,
          (result.pool as string) || closeArgs.pool_address,
          closeArgs.reason
        );
      }
    } else if (tool.name === "claim_fees" && result.base_mint) {
      await autoSwapService.handleAutoSwapAfterClaim(result.base_mint as string);
    }

    return result;
  };
}

/**
 * Create persistence middleware factory.
 * Handles state tracking after successful deploy/close operations.
 */
export function createPersistenceMiddleware(context: MiddlewareContext): MiddlewareFn {
  const { persistenceService, validation, logger } = context;

  return async (tool, args, _role, next) => {
    const rawResult = await next();
    const result = validateResultObject(rawResult);

    // Only persist on successful write operations
    if (result?.error || result?.blocked || !result?.success) {
      return result;
    }

    // After deploy_position: track the new position
    if (tool.name === "deploy_position") {
      const validationResult = validation.validateDeployPositionArgs(args);
      if (!validationResult.success) {
        logger.log(
          "middleware_warn",
          `Invalid deploy_position args for persistence: ${validationResult.error}`
        );
        return result;
      }

      const deployResult: DeployResult = {
        position: result.position as string,
        pool: result.pool as string,
        pool_name: (result.pool_name as string) || undefined,
        strategy: (result.strategy as string) || undefined,
        strategy_config: result.strategy_config as unknown,
        bin_range: result.bin_range as { min: number; max: number; active?: number } | undefined,
        bin_step: (result.bin_step as number) || 80,
        volatility: (result.volatility as number) || 0,
        fee_tvl_ratio: (result.fee_tvl_ratio as number) || 0,
        organic_score: (result.organic_score as number) || 0,
        amount_sol: (result.amount_sol as number) || (result.amount_y as number) || 0,
        amount_x: result.amount_x as number | undefined,
        active_bin: (result.active_bin as number) || 0,
        initial_value_usd: (result.initial_value_usd as number) || 0,
        signal_snapshot: result.signal_snapshot as unknown,
      };

      await persistenceService.trackPosition(deployResult);
    }

    // After claim_fees: record the claim
    if (tool.name === "claim_fees" && result._recordClaim) {
      await persistenceService.recordClaim(result.position as string);
    }

    // After close_position: record close and performance
    if (tool.name === "close_position") {
      if (result._recordClose) {
        await persistenceService.recordClose(
          result.position as string,
          (result.close_reason as string) || "agent decision"
        );
      }
      if (result._recordPerformance && result._perf_data) {
        await persistenceService.recordPerformance(result._perf_data as PositionPerformance);
      }
    }

    return result;
  };
}

/**
 * Create the full middleware chain from context.
 * This is the composition root for middleware.
 */
export function createMiddlewareChain(context: MiddlewareContext): MiddlewareFn[] {
  return [
    createSafetyCheckMiddleware(context),
    createLoggingMiddleware(context),
    createNotificationMiddleware(context),
    createPersistenceMiddleware(context),
  ];
}
