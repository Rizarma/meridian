/**
 * Auto-Swap Service
 *
 * Cross-cutting concern for auto-swapping tokens after close/claim.
 * Decoupled from middleware - can be injected wherever needed.
 */

// Logger interface for dependency injection
export interface Logger {
  log(category: string, message: string): void;
}

// Wallet balance interface
export interface TokenBalance {
  mint: string;
  symbol: string;
  balance: number;
  usd: number | null;
}

export interface WalletBalances {
  tokens?: TokenBalance[];
}

// Wallet service interface
export interface WalletService {
  getWalletBalances(): Promise<WalletBalances | unknown>;
  swapToken(params: {
    input_mint: string;
    output_mint: string;
    amount: number;
  }): Promise<SwapResult | unknown>;
}

export interface SwapResult {
  amount_out?: string | number;
  tx?: string;
}

// Pool memory interface for adding notes
export interface PoolMemory {
  addPoolNote(params: { pool_address: string; note: string }): Promise<unknown>;
}

/**
 * Auto-swap service interface
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
 * Dependencies for creating auto-swap service
 */
export interface AutoSwapServiceDeps {
  walletService: WalletService;
  poolMemory?: PoolMemory;
  logger: Logger;
  autoSwapAfterClaim?: boolean;
}

/** In-flight swap tracking to prevent double-spend on rapid successive calls */
const _inFlightSwaps: Set<string> = new Set();

/**
 * Validate that a value is a valid wallet balances response
 */
function isWalletBalances(value: unknown): value is WalletBalances {
  return (
    typeof value === "object" &&
    value !== null &&
    ("tokens" in value || "sol" in value || "wallet" in value)
  );
}

/**
 * Create auto-swap service instance
 */
export function createAutoSwapService(deps: AutoSwapServiceDeps): AutoSwapService {
  const { walletService, poolMemory, logger, autoSwapAfterClaim } = deps;

  return {
    async handleAutoSwapAfterClose(
      baseMint: string,
      result: Record<string, unknown>,
      poolAddress?: string,
      closeReason?: string
    ): Promise<void> {
      // Add pool note for low-yield closes
      if (closeReason?.toLowerCase().includes("yield") && poolAddress && poolMemory) {
        void poolMemory.addPoolNote({
          pool_address: poolAddress,
          note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0, 10)}`,
        });
      }

      // Idempotency check - prevent double-swap of same mint
      if (_inFlightSwaps.has(baseMint)) {
        logger.log(
          "executor",
          `Auto-swap for ${baseMint.slice(0, 8)} already in progress - skipping`
        );
        return;
      }

      try {
        const balances = await walletService.getWalletBalances();
        if (!isWalletBalances(balances)) {
          logger.log("executor_warn", "Invalid wallet balances response in auto-swap after close");
          return;
        }
        const token = balances.tokens?.find((t: TokenBalance) => t.mint === baseMint);

        // Re-check balance after acquiring lock
        if (!token || (token.usd || 0) < 0.1) {
          return;
        }

        // Mark as in-flight BEFORE swap
        _inFlightSwaps.add(baseMint);

        logger.log(
          "executor",
          `Auto-swapping ${token.symbol || baseMint.slice(0, 8)} ($${(token.usd || 0).toFixed(2)}) back to SOL`
        );
        const swapResult = await walletService.swapToken({
          input_mint: baseMint,
          output_mint: "SOL",
          amount: token.balance || 0,
        });
        if (!swapResult || typeof swapResult !== "object") {
          throw new Error("Invalid swap result");
        }

        // Tell the model the swap already happened so it doesn't call swap_token again
        result.auto_swapped = true;
        result.auto_swap_note = `Base token already auto-swapped back to SOL (${token.symbol || baseMint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
        const amountOut = (swapResult as SwapResult).amount_out;
        if (amountOut) {
          result.sol_received = amountOut;
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        logger.log("executor_warn", `Auto-swap after close failed: ${errorMsg}`);
      } finally {
        // Always remove from in-flight, even on error
        _inFlightSwaps.delete(baseMint);
      }
    },

    async handleAutoSwapAfterClaim(baseMint: string): Promise<void> {
      if (!autoSwapAfterClaim) return;

      // Idempotency check - prevent double-swap of same mint
      if (_inFlightSwaps.has(baseMint)) {
        logger.log(
          "executor",
          `Auto-swap for ${baseMint.slice(0, 8)} already in progress - skipping`
        );
        return;
      }

      try {
        const balances = await walletService.getWalletBalances();
        if (!isWalletBalances(balances)) {
          logger.log("executor_warn", "Invalid wallet balances response in auto-swap after claim");
          return;
        }
        const token = balances.tokens?.find((t: TokenBalance) => t.mint === baseMint);

        // Re-check balance after acquiring lock
        if (!token || (token.usd || 0) < 0.1) {
          return;
        }

        // Mark as in-flight BEFORE swap
        _inFlightSwaps.add(baseMint);

        logger.log(
          "executor",
          `Auto-swapping claimed ${token.symbol || baseMint.slice(0, 8)} ($${(token.usd || 0).toFixed(2)}) back to SOL`
        );
        await walletService.swapToken({
          input_mint: baseMint,
          output_mint: "SOL",
          amount: token.balance || 0,
        });
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        logger.log("executor_warn", `Auto-swap after claim failed: ${errorMsg}`);
      } finally {
        // Always remove from in-flight, even on error
        _inFlightSwaps.delete(baseMint);
      }
    },
  };
}
