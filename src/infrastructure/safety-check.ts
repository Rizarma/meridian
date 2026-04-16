/**
 * Safety Check Service
 *
 * Cross-cutting concern for running safety checks before write operations.
 * Decoupled from middleware - can be injected wherever needed.
 */

import type { Config } from "../types/config.js";
import type { DeployPositionArgs, SafetyCheckResult } from "../types/executor.js";
import type { MyPositionsResult } from "../types/position.js";
import type { Strategy } from "../types/strategy.js";

// Logger interface for dependency injection
export interface Logger {
  log(category: string, message: string): void;
}

// Position provider interface
export interface PositionProvider {
  getMyPositions(params: { force: boolean }): Promise<MyPositionsResult | unknown>;
}

// Wallet provider interface
export interface WalletProvider {
  getWalletBalances(): Promise<unknown>;
}

// Strategy provider interface
export interface StrategyProvider {
  getActiveStrategy(): Promise<Strategy | null>;
}

// Validation helpers
export interface ValidationHelpers {
  validateDeployPositionArgs(args: unknown): {
    success: boolean;
    data?: DeployPositionArgs;
    error?: string;
  };
  validateAddLiquidityParams(args: unknown): {
    success: boolean;
    data?: { amount_x?: number; amount_y?: number };
    error?: string;
  };
  validateWithdrawLiquidityParams(args: unknown): {
    success: boolean;
    data?: { bps?: number };
    error?: string;
  };
  isWalletBalances(value: unknown): boolean;
}

/**
 * Safety check service interface
 */
export interface SafetyCheckService {
  runSafetyChecks(name: string, args: unknown): Promise<SafetyCheckResult>;
}

/**
 * Dependencies for creating safety check service
 */
export interface SafetyCheckServiceDeps {
  config: Config;
  positionProvider: PositionProvider;
  walletProvider: WalletProvider;
  strategyProvider: StrategyProvider;
  validation: ValidationHelpers;
  logger: Logger;
}

/**
 * Create safety check service instance
 */
export function createSafetyCheckService(deps: SafetyCheckServiceDeps): SafetyCheckService {
  const { config, positionProvider, walletProvider, strategyProvider, validation } = deps;

  async function validateStrategyCompliance(
    deployArgs: DeployPositionArgs
  ): Promise<SafetyCheckResult> {
    const activeStrategy = await strategyProvider.getActiveStrategy();
    if (!activeStrategy) {
      return { pass: true };
    }

    const strategy = activeStrategy;

    // Normalize values before comparison
    const amountY = Number(deployArgs.amount_y ?? 0);
    const amountX = Number(deployArgs.amount_x ?? 0);

    // Validate 1: single_side constraint
    if (strategy.entry?.single_side) {
      if (strategy.entry.single_side === "token" && amountY !== 0) {
        return {
          pass: false,
          reason: `Strategy '${strategy.name}' requires single_side: "token" with amount_y=0. Received amount_y=${deployArgs.amount_y}`,
        };
      }
      if (strategy.entry.single_side === "sol" && amountX !== 0) {
        return {
          pass: false,
          reason: `Strategy '${strategy.name}' requires single_side: "sol" with amount_x=0. Received amount_x=${deployArgs.amount_x}`,
        };
      }
    }

    // Validate 2: lp_strategy match
    const effectiveStrategy = deployArgs.strategy ?? strategy.lp_strategy;
    if (
      strategy.lp_strategy &&
      strategy.lp_strategy !== "any" &&
      strategy.lp_strategy !== "mixed" &&
      effectiveStrategy !== strategy.lp_strategy
    ) {
      return {
        pass: false,
        reason: `Strategy '${strategy.name}' requires lp_strategy: "${strategy.lp_strategy}", but deploy used: "${effectiveStrategy}"`,
      };
    }

    return { pass: true };
  }

  return {
    async runSafetyChecks(name: string, args: unknown): Promise<SafetyCheckResult> {
      switch (name) {
        case "deploy_position": {
          const validationResult = validation.validateDeployPositionArgs(args);
          if (!validationResult.success) {
            return {
              pass: false,
              reason: `Invalid deploy_position args: ${validationResult.error}`,
            };
          }
          const deployArgs = validationResult.data!;

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
          const positionsResult = await positionProvider.getMyPositions({ force: true });
          if (!positionsResult || typeof positionsResult !== "object") {
            return {
              pass: false,
              reason: "Failed to fetch positions for safety check",
            };
          }
          const positions = positionsResult as MyPositionsResult;
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
          const amountX = deployArgs.amount_x ?? 0;

          // Allow single-sided token entry (amount_y=0) if strategy permits it
          const activeStrategy = await strategyProvider.getActiveStrategy();
          const allowsSingleSidedToken = activeStrategy?.entry?.single_side === "token";
          const isSingleSidedToken = allowsSingleSidedToken && amountY === 0 && amountX > 0;

          if (amountY <= 0 && !isSingleSidedToken) {
            return {
              pass: false,
              reason: `Must provide a positive SOL amount (amount_y), or use a single-sided token strategy.`,
            };
          }

          const minDeploy = Math.max(0.1, config.management.deployAmountSol);
          if (!isSingleSidedToken && amountY < minDeploy) {
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
            const balanceResult = await walletProvider.getWalletBalances();
            if (!validation.isWalletBalances(balanceResult)) {
              return {
                pass: false,
                reason: "Failed to fetch wallet balances for safety check",
              };
            }
            const gasReserve = config.management.gasReserve;
            const minRequired = amountY + gasReserve;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const solBalance = (balanceResult as any).sol ?? 0;
            if (solBalance < minRequired) {
              return {
                pass: false,
                reason: `Insufficient SOL: have ${solBalance} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
              };
            }
          }

          // Strategy compliance check
          const strategyCheck = await validateStrategyCompliance(deployArgs);
          if (!strategyCheck.pass) {
            return strategyCheck;
          }

          return { pass: true };
        }

        case "swap_token": {
          return { pass: true };
        }

        case "add_liquidity": {
          const validationResult = validation.validateAddLiquidityParams(args);
          if (!validationResult.success) {
            return { pass: false, reason: `Invalid add_liquidity args: ${validationResult.error}` };
          }
          const addArgs = validationResult.data!;

          const addAmountY = addArgs.amount_y ?? 0;
          const addAmountX = addArgs.amount_x ?? 0;
          if (addAmountX <= 0 && addAmountY <= 0) {
            return {
              pass: false,
              reason: "At least one amount (amount_x or amount_y) must be > 0",
            };
          }

          // Check SOL balance to cover gas for the add liquidity transaction
          if (process.env.DRY_RUN !== "true") {
            const balanceResult = await walletProvider.getWalletBalances();
            if (!validation.isWalletBalances(balanceResult)) {
              return {
                pass: false,
                reason: "Failed to fetch wallet balances for gas check",
              };
            }
            const gasReserve = config.management.gasReserve ?? 0.01;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const solBalance = (balanceResult as any).sol ?? 0;
            if (solBalance < gasReserve) {
              return {
                pass: false,
                reason: `Insufficient SOL for gas: have ${solBalance} SOL, need at least ${gasReserve} SOL reserve`,
              };
            }
          }

          return { pass: true };
        }

        case "withdraw_liquidity": {
          const validationResult = validation.validateWithdrawLiquidityParams(args);
          if (!validationResult.success) {
            return {
              pass: false,
              reason: `Invalid withdraw_liquidity args: ${validationResult.error}`,
            };
          }
          const withdrawArgs = validationResult.data!;

          const bps = withdrawArgs.bps ?? 10000;
          if (bps < 1 || bps > 10000) {
            return {
              pass: false,
              reason: `Invalid bps: ${bps}. Must be between 1 and 10000`,
            };
          }

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
          // Sanitize argv to prevent command injection
          const dangerousArgs = ["--eval", "-e", "--print", "-p", "-c", "--require"];
          const argvStr = process.argv.slice(1).join(" ");
          if (dangerousArgs.some((arg) => argvStr.includes(arg))) {
            return { pass: false, reason: "self_update blocked: dangerous args detected" };
          }
          return { pass: true };
        }

        default:
          return { pass: true };
      }
    },
  };
}
