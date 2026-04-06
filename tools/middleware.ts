/**
 * Middleware Chain
 *
 * Composable middleware layers for cross-cutting concerns:
 * - Safety checks (for write tools)
 * - Action logging
 * - Telegram notifications
 *
 * Pattern: Chain of Responsibility via reduceRight
 * No framework — just functions.
 */

import { config } from "../src/config/config.js";
import { recordPerformance } from "../src/domain/lessons.js";
import { addPoolNote } from "../src/domain/pool-memory.js";
import { log, logAction } from "../src/infrastructure/logger.js";
import { recordClaim, recordClose, trackPosition } from "../src/infrastructure/state.js";
import { notifyClose, notifyDeploy, notifySwap } from "../src/infrastructure/telegram.js";
import type {
  ClosePositionArgs,
  DeployPositionArgs,
  SafetyCheckResult,
  SwapTokenArgs,
} from "../src/types/executor.js";
import type { AgentType } from "../src/types/index.js";
import type { PositionPerformance } from "../src/types/lessons.js";
import type { MyPositionsResult } from "../src/types/position.js";
import type { TokenBalance, WalletBalances } from "../src/types/wallet.js";
import { getMyPositions } from "./dlmm.js";
import type { ToolHandler, ToolRegistration } from "./registry.js";
import { getWalletBalances, swapToken } from "./wallet.js";

/** Middleware function type */
export type MiddlewareFn = (
  tool: ToolRegistration,
  args: unknown,
  role: AgentType,
  next: () => Promise<unknown>
) => Promise<unknown>;

/**
 * Apply a chain of middleware to a tool execution.
 * Uses reduceRight to compose middleware layers.
 */
export function applyMiddleware(
  tool: ToolRegistration,
  args: unknown,
  role: AgentType,
  chain: MiddlewareFn[],
  handler: ToolHandler
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
 * Safety check middleware.
 * Runs pre-execution checks for write tools.
 */
export const safetyCheckMiddleware: MiddlewareFn = async (tool, args, _role, next) => {
  if (!tool.isWriteTool) {
    return next();
  }

  const check = await runSafetyChecks(tool.name, args);
  if (!check.pass) {
    log("safety_block", `${tool.name} blocked: ${check.reason}`);
    return {
      blocked: true,
      reason: check.reason,
    };
  }

  return next();
};

/**
 * Logging middleware.
 * Logs all tool executions to daily JSONL.
 */
export const loggingMiddleware: MiddlewareFn = async (tool, args, _role, next) => {
  const startTime = Date.now();

  try {
    const result = (await next()) as Record<string, unknown>;
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error && !result?.blocked;

    logAction({
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

    logAction({
      tool: tool.name,
      args: args as Record<string, unknown>,
      error: errorMsg,
      duration_ms: duration,
      success: false,
    });

    throw error;
  }
};

/**
 * Notification middleware.
 * Sends Telegram alerts for write tools after successful execution.
 */
export const notificationMiddleware: MiddlewareFn = async (tool, args, _role, next) => {
  const result = (await next()) as Record<string, unknown>;

  // Only notify on successful write operations
  if (result?.error || result?.blocked) {
    return result;
  }

  // Handle specific tool notifications
  if (tool.name === "swap_token" && result?.tx) {
    const swapArgs = args as SwapTokenArgs;
    notifySwap({
      inputSymbol: swapArgs.input_mint?.slice(0, 8),
      outputSymbol:
        swapArgs.output_mint === "So11111111111111111111111111111111111111112" ||
        swapArgs.output_mint === "SOL"
          ? "SOL"
          : swapArgs.output_mint?.slice(0, 8),
      amountIn: result.amount_in ? parseFloat(String(result.amount_in)) : undefined,
      amountOut: result.amount_out ? parseFloat(String(result.amount_out)) : undefined,
      tx: (result.tx as string) || undefined,
    }).catch(() => {});
  } else if (tool.name === "deploy_position") {
    const deployArgs = args as DeployPositionArgs & { pool_name?: string };
    notifyDeploy({
      pair:
        (result.pool_name as string) ||
        deployArgs.pool_name ||
        deployArgs.pool_address?.slice(0, 8) ||
        "unknown",
      amountSol: deployArgs.amount_y ?? deployArgs.amount_sol ?? 0,
      position: (result.position as string) || undefined,
      tx: (result.txs as string[])?.[0] ?? ((result.tx as string) || undefined),
      priceRange: (result.price_range as { min: number; max: number }) || undefined,
      binStep: (result.bin_step as number) || undefined,
      baseFee: (result.base_fee as number) || undefined,
    }).catch(() => {});
  } else if (tool.name === "close_position") {
    const closeArgs = args as ClosePositionArgs;
    notifyClose({
      pair: (result.pool_name as string) || closeArgs.position_address?.slice(0, 8) || "unknown",
      pnlUsd: (result.pnl_usd as number) ?? 0,
      pnlPct: (result.pnl_pct as number) ?? 0,
    }).catch(() => {});

    // Note low-yield closes in pool memory so screener avoids redeploying
    if (closeArgs.reason && closeArgs.reason.toLowerCase().includes("yield")) {
      const poolAddr = (result.pool as string) || closeArgs.pool_address;
      if (poolAddr) {
        void addPoolNote({
          pool_address: poolAddr,
          note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0, 10)}`,
        });
      }
    }

    // Auto-swap base token back to SOL unless user said to hold
    if (!closeArgs.skip_swap && result.base_mint) {
      await handleAutoSwapAfterClose(result.base_mint as string, result);
    }
  } else if (
    tool.name === "claim_fees" &&
    config.management.autoSwapAfterClaim &&
    result.base_mint
  ) {
    await handleAutoSwapAfterClaim(result.base_mint as string);
  }

  return result;
};

/**
 * Persistence middleware.
 * Handles state tracking after successful deploy/close operations.
 * Decouples dlmm.ts from persistence concerns.
 */
export const persistenceMiddleware: MiddlewareFn = async (tool, args, _role, next) => {
  const result = (await next()) as Record<string, unknown>;

  // Only persist on successful write operations
  if (result?.error || result?.blocked || !result?.success) {
    return result;
  }

  // After deploy_position: track the new position
  if (tool.name === "deploy_position") {
    const deployArgs = args as DeployPositionArgs & { pool_name?: string };
    trackPosition({
      position: result.position as string,
      pool: result.pool as string,
      pool_name: (result.pool_name as string) || deployArgs.pool_name || "unknown",
      strategy: (result.strategy as string) || "spot",
      bin_range: result.bin_range as { min: number; max: number; active?: number },
      bin_step: (result.bin_step as number) || 80,
      volatility: (result.volatility as number) || 0,
      fee_tvl_ratio: (result.fee_tvl_ratio as number) || 0,
      organic_score: (result.organic_score as number) || 0,
      amount_sol: (result.amount_sol as number) || (result.amount_y as number) || 0,
      amount_x: result.amount_x as number | undefined,
      active_bin: (result.active_bin as number) || 0,
      initial_value_usd: (result.initial_value_usd as number) || 0,
    });
    log("middleware", `Tracked position ${result.position?.toString().slice(0, 8)}...`);
  }

  // After claim_fees: record the claim
  if (tool.name === "claim_fees" && result._recordClaim) {
    recordClaim(result.position as string, 0); // Fees tracked separately via API
    log("middleware", `Recorded claim for ${result.position?.toString().slice(0, 8)}...`);
  }

  // After close_position: record close and performance
  if (tool.name === "close_position") {
    if (result._recordClose) {
      recordClose(result.position as string, (result.close_reason as string) || "agent decision");
      log("middleware", `Recorded close for ${result.position?.toString().slice(0, 8)}...`);
    }
    if (result._recordPerformance && result._perf_data) {
      await recordPerformance(result._perf_data as PositionPerformance);
      log("middleware", `Recorded performance for ${result.position?.toString().slice(0, 8)}...`);
    }
  }

  return result;
};

/**
 * Handle auto-swap after position close.
 */
async function handleAutoSwapAfterClose(
  baseMint: string,
  result: Record<string, unknown>
): Promise<void> {
  try {
    const balances = (await getWalletBalances()) as WalletBalances;
    const token = balances.tokens?.find((t: TokenBalance) => t.mint === baseMint);
    if (token && (token.usd || 0) >= 0.1) {
      log(
        "executor",
        `Auto-swapping ${token.symbol || baseMint.slice(0, 8)} ($${(token.usd || 0).toFixed(2)}) back to SOL`
      );
      const swapResult = (await swapToken({
        input_mint: baseMint,
        output_mint: "SOL",
        amount: token.balance || 0,
      })) as { amount_out?: string | number };

      // Tell the model the swap already happened so it doesn't call swap_token again
      result.auto_swapped = true;
      result.auto_swap_note = `Base token already auto-swapped back to SOL (${token.symbol || baseMint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
      if (swapResult?.amount_out) {
        result.sol_received = swapResult.amount_out;
      }
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    log("executor_warn", `Auto-swap after close failed: ${errorMsg}`);
  }
}

/**
 * Handle auto-swap after fee claim.
 */
async function handleAutoSwapAfterClaim(baseMint: string): Promise<void> {
  try {
    const balances = (await getWalletBalances()) as WalletBalances;
    const token = balances.tokens?.find((t: TokenBalance) => t.mint === baseMint);
    if (token && (token.usd || 0) >= 0.1) {
      log(
        "executor",
        `Auto-swapping claimed ${token.symbol || baseMint.slice(0, 8)} ($${(token.usd || 0).toFixed(2)}) back to SOL`
      );
      await swapToken({
        input_mint: baseMint,
        output_mint: "SOL",
        amount: token.balance || 0,
      });
    }
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    log("executor_warn", `Auto-swap after claim failed: ${errorMsg}`);
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name: string, args: unknown): Promise<SafetyCheckResult> {
  switch (name) {
    case "deploy_position": {
      const deployArgs = args as DeployPositionArgs;

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (
        deployArgs.bin_step != null &&
        (deployArgs.bin_step < minStep || deployArgs.bin_step > maxStep)
      ) {
        return {
          pass: false,
          reason: `bin_step ${deployArgs.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      // Check position count limit + duplicate pool guard
      const positions = (await getMyPositions({ force: true })) as MyPositionsResult;
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some((p) => p.pool === deployArgs.pool_address);
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${deployArgs.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools
      if (deployArgs.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === deployArgs.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${deployArgs.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = deployArgs.amount_y ?? deployArgs.amount_sol ?? 0;
      if (amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = (await getWalletBalances()) as WalletBalances;
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — handled inside swapToken itself
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason:
            "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason:
            "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result: unknown): unknown {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
