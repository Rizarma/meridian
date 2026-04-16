/**
 * Runtime validation for LLM/tool inputs
 *
 * CRITICAL: This module provides type-safe validation for all LLM-generated arguments
 * to prevent runtime failures from unsafe type assertions in financial operations.
 *
 * All validators return a discriminated union:
 *   { success: true, data: T } | { success: false, error: string }
 */

import { BPS, LIMITS, SOLANA } from "../config/constants.js";
import type { AddLiquidityParams, WithdrawLiquidityParams } from "../types/dlmm.js";
import type { ClosePositionArgs, DeployPositionArgs, SwapTokenArgs } from "../types/executor.js";

// ═══════════════════════════════════════════════════════════════════════════
// Validation Result Types
// ═══════════════════════════════════════════════════════════════════════════

export type ValidationResult<T> = { success: true; data: T } | { success: false; error: string };

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Validate Solana address format (base58, 32-44 characters)
 */
function isSolanaAddress(value: unknown): boolean {
  if (!isString(value)) return false;
  // Base58 regex - Solana addresses are base58 encoded
  const base58Regex = /^[A-HJ-NP-Za-km-z1-9]+$/;
  if (!base58Regex.test(value)) return false;
  // Length check: Solana pubkeys are 32 bytes = ~43-44 chars in base58
  return value.length >= SOLANA.MIN_ADDRESS_LENGTH && value.length <= SOLANA.MAX_ADDRESS_LENGTH;
}

// ═══════════════════════════════════════════════════════════════════════════
// SwapTokenArgs Validation
// ═══════════════════════════════════════════════════════════════════════════

export function validateSwapTokenArgs(args: unknown): ValidationResult<SwapTokenArgs> {
  if (!args || typeof args !== "object") {
    return { success: false, error: "Args must be an object" };
  }

  const a = args as Record<string, unknown>;

  // Validate required fields
  if (!isString(a.input_mint)) {
    return { success: false, error: "input_mint must be a string" };
  }

  if (!isString(a.output_mint)) {
    return { success: false, error: "output_mint must be a string" };
  }

  if (!isNumber(a.amount)) {
    return { success: false, error: "amount must be a number" };
  }

  if (a.amount <= 0) {
    return { success: false, error: "amount must be greater than 0" };
  }

  // Validate optional fields if present
  if ("slippage_bps" in a && a.slippage_bps !== undefined) {
    if (!isNumber(a.slippage_bps)) {
      return { success: false, error: "slippage_bps must be a number" };
    }
    if (a.slippage_bps < LIMITS.MIN_SLIPPAGE_BPS || a.slippage_bps > LIMITS.MAX_SLIPPAGE_BPS) {
      return {
        success: false,
        error: `slippage_bps must be between ${LIMITS.MIN_SLIPPAGE_BPS} and ${LIMITS.MAX_SLIPPAGE_BPS}`,
      };
    }
  }

  return {
    success: true,
    data: {
      input_mint: a.input_mint,
      output_mint: a.output_mint,
      amount: a.amount,
      ...(a.slippage_bps !== undefined && { slippage_bps: a.slippage_bps }),
    } as SwapTokenArgs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DeployPositionArgs Validation
// ═══════════════════════════════════════════════════════════════════════════

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validation inherently requires detailed field checks
export function validateDeployPositionArgs(args: unknown): ValidationResult<DeployPositionArgs> {
  if (!args || typeof args !== "object") {
    return { success: false, error: "Args must be an object" };
  }

  const a = args as Record<string, unknown>;

  // Validate required pool_address
  if (!isString(a.pool_address)) {
    return { success: false, error: "pool_address must be a string" };
  }

  if (!isSolanaAddress(a.pool_address)) {
    return { success: false, error: "pool_address must be a valid Solana address" };
  }

  // Validate optional bin_step
  if ("bin_step" in a && a.bin_step !== undefined) {
    if (!isNumber(a.bin_step)) {
      return { success: false, error: "bin_step must be a number" };
    }
    if (a.bin_step < 1 || a.bin_step > 1000) {
      return { success: false, error: `bin_step must be between 1 and 1000` };
    }
  }

  // Validate optional amount_x
  if ("amount_x" in a && a.amount_x !== undefined) {
    if (!isNumber(a.amount_x)) {
      return { success: false, error: "amount_x must be a number" };
    }
    if (a.amount_x < 0) {
      return { success: false, error: "amount_x must be non-negative" };
    }
  }

  // Validate optional amount_y
  if ("amount_y" in a && a.amount_y !== undefined) {
    if (!isNumber(a.amount_y)) {
      return { success: false, error: "amount_y must be a number" };
    }
    if (a.amount_y < 0) {
      return { success: false, error: "amount_y must be non-negative" };
    }
  }

  // Validate optional amount_sol (alias for amount_y)
  if ("amount_sol" in a && a.amount_sol !== undefined) {
    if (!isNumber(a.amount_sol)) {
      return { success: false, error: "amount_sol must be a number" };
    }
    if (a.amount_sol < 0) {
      return { success: false, error: "amount_sol must be non-negative" };
    }
  }

  // Validate optional base_mint
  if ("base_mint" in a && a.base_mint !== undefined) {
    if (!isString(a.base_mint)) {
      return { success: false, error: "base_mint must be a string" };
    }
    if (!isSolanaAddress(a.base_mint)) {
      return { success: false, error: "base_mint must be a valid Solana address" };
    }
  }

  // Validate optional strategy
  if ("strategy" in a && a.strategy !== undefined) {
    if (!isString(a.strategy)) {
      return { success: false, error: "strategy must be a string" };
    }
    const validStrategies = ["spot", "curve", "bid_ask"];
    if (!validStrategies.includes(a.strategy)) {
      return {
        success: false,
        error: `strategy must be one of: ${validStrategies.join(", ")}`,
      };
    }
  }

  // Validate that at least one amount is provided
  const hasAmountX = isNumber(a.amount_x) && a.amount_x > 0;
  const hasAmountY = isNumber(a.amount_y) && a.amount_y > 0;
  const hasAmountSol = isNumber(a.amount_sol) && a.amount_sol > 0;

  if (!hasAmountX && !hasAmountY && !hasAmountSol) {
    return {
      success: false,
      error: "At least one amount (amount_x, amount_y, or amount_sol) must be provided and > 0",
    };
  }

  return {
    success: true,
    data: args as DeployPositionArgs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ClosePositionArgs Validation
// ═══════════════════════════════════════════════════════════════════════════

export function validateClosePositionArgs(args: unknown): ValidationResult<ClosePositionArgs> {
  if (!args || typeof args !== "object") {
    return { success: false, error: "Args must be an object" };
  }

  const a = args as Record<string, unknown>;

  // Validate required position_address
  if (!isString(a.position_address)) {
    return { success: false, error: "position_address must be a string" };
  }

  if (!isSolanaAddress(a.position_address)) {
    return { success: false, error: "position_address must be a valid Solana address" };
  }

  // Validate optional pool_address
  if ("pool_address" in a && a.pool_address !== undefined) {
    if (!isString(a.pool_address)) {
      return { success: false, error: "pool_address must be a string" };
    }
    if (!isSolanaAddress(a.pool_address)) {
      return { success: false, error: "pool_address must be a valid Solana address" };
    }
  }

  // Validate optional reason
  if ("reason" in a && a.reason !== undefined) {
    if (!isString(a.reason)) {
      return { success: false, error: "reason must be a string" };
    }
    if (a.reason.length > LIMITS.MAX_NOTE_LENGTH) {
      return {
        success: false,
        error: `reason must be ${LIMITS.MAX_NOTE_LENGTH} characters or less`,
      };
    }
  }

  // Validate optional skip_swap
  if ("skip_swap" in a && a.skip_swap !== undefined) {
    if (!isBoolean(a.skip_swap)) {
      return { success: false, error: "skip_swap must be a boolean" };
    }
  }

  return {
    success: true,
    data: args as ClosePositionArgs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// AddLiquidityParams Validation
// ═══════════════════════════════════════════════════════════════════════════

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validation inherently requires detailed field checks
export function validateAddLiquidityParams(args: unknown): ValidationResult<AddLiquidityParams> {
  if (!args || typeof args !== "object") {
    return { success: false, error: "Args must be an object" };
  }

  const a = args as Record<string, unknown>;

  // Validate required position_address
  if (!isString(a.position_address)) {
    return { success: false, error: "position_address must be a string" };
  }

  if (!isSolanaAddress(a.position_address)) {
    return { success: false, error: "position_address must be a valid Solana address" };
  }

  // Validate required pool_address
  if (!isString(a.pool_address)) {
    return { success: false, error: "pool_address must be a string" };
  }

  if (!isSolanaAddress(a.pool_address)) {
    return { success: false, error: "pool_address must be a valid Solana address" };
  }

  // Validate optional amount_x
  if ("amount_x" in a && a.amount_x !== undefined) {
    if (!isNumber(a.amount_x)) {
      return { success: false, error: "amount_x must be a number" };
    }
    if (a.amount_x < 0) {
      return { success: false, error: "amount_x must be non-negative" };
    }
  }

  // Validate optional amount_y
  if ("amount_y" in a && a.amount_y !== undefined) {
    if (!isNumber(a.amount_y)) {
      return { success: false, error: "amount_y must be a number" };
    }
    if (a.amount_y < 0) {
      return { success: false, error: "amount_y must be non-negative" };
    }
  }

  // Validate optional strategy
  if ("strategy" in a && a.strategy !== undefined) {
    if (!isString(a.strategy)) {
      return { success: false, error: "strategy must be a string" };
    }
    const validStrategies = ["spot", "curve", "bid_ask"];
    if (!validStrategies.includes(a.strategy)) {
      return {
        success: false,
        error: `strategy must be one of: ${validStrategies.join(", ")}`,
      };
    }
  }

  // Validate optional single_sided_x
  if ("single_sided_x" in a && a.single_sided_x !== undefined) {
    if (!isBoolean(a.single_sided_x)) {
      return { success: false, error: "single_sided_x must be a boolean" };
    }
  }

  // Validate that at least one amount is provided
  const hasAmountX = isNumber(a.amount_x) && a.amount_x > 0;
  const hasAmountY = isNumber(a.amount_y) && a.amount_y > 0;

  if (!hasAmountX && !hasAmountY) {
    return {
      success: false,
      error: "At least one amount (amount_x or amount_y) must be provided and > 0",
    };
  }

  // Validate single_sided_x constraint
  if (a.single_sided_x === true && !hasAmountX) {
    return {
      success: false,
      error: "single_sided_x requires amount_x > 0",
    };
  }

  return {
    success: true,
    data: args as AddLiquidityParams,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// WithdrawLiquidityParams Validation
// ═══════════════════════════════════════════════════════════════════════════

export function validateWithdrawLiquidityParams(
  args: unknown
): ValidationResult<WithdrawLiquidityParams> {
  if (!args || typeof args !== "object") {
    return { success: false, error: "Args must be an object" };
  }

  const a = args as Record<string, unknown>;

  // Validate required position_address
  if (!isString(a.position_address)) {
    return { success: false, error: "position_address must be a string" };
  }

  if (!isSolanaAddress(a.position_address)) {
    return { success: false, error: "position_address must be a valid Solana address" };
  }

  // Validate required pool_address
  if (!isString(a.pool_address)) {
    return { success: false, error: "pool_address must be a string" };
  }

  if (!isSolanaAddress(a.pool_address)) {
    return { success: false, error: "pool_address must be a valid Solana address" };
  }

  // Validate optional bps (basis points)
  if ("bps" in a && a.bps !== undefined) {
    if (!isNumber(a.bps)) {
      return { success: false, error: "bps must be a number" };
    }
    if (a.bps < BPS.MIN || a.bps > BPS.MAX) {
      return { success: false, error: `bps must be between ${BPS.MIN} and ${BPS.MAX}` };
    }
  }

  // Validate optional claim_fees
  if ("claim_fees" in a && a.claim_fees !== undefined) {
    if (!isBoolean(a.claim_fees)) {
      return { success: false, error: "claim_fees must be a boolean" };
    }
  }

  return {
    success: true,
    data: args as WithdrawLiquidityParams,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Generic Tool Args Validation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validates that args is a valid object with required string fields.
 * Used for simple tools that just need address validation.
 */
export function validateAddressArgs(
  args: unknown,
  requiredFields: string[]
): ValidationResult<Record<string, string>> {
  if (!args || typeof args !== "object") {
    return { success: false, error: "Args must be an object" };
  }

  const a = args as Record<string, unknown>;

  for (const field of requiredFields) {
    if (!(field in a)) {
      return { success: false, error: `Missing required field: ${field}` };
    }

    if (!isString(a[field])) {
      return { success: false, error: `${field} must be a string` };
    }

    if (!isSolanaAddress(a[field])) {
      return { success: false, error: `${field} must be a valid Solana address` };
    }
  }

  return {
    success: true,
    data: a as Record<string, string>,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Type Guards for API Response Validation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Type guard for validating positions API response
 */
export function isValidPositionsResponse(value: unknown): value is {
  total_positions: number;
  positions?: Array<{
    pool: string;
    base_mint?: string;
    [key: string]: unknown;
  }>;
} {
  if (!isObject(value)) return false;

  if (!isNumber(value.total_positions)) return false;
  if (value.total_positions < 0) return false;

  if (value.positions !== undefined) {
    if (!Array.isArray(value.positions)) return false;
  }

  return true;
}

/**
 * Type guard for validating wallet balance response
 */
export function isValidBalanceResponse(value: unknown): value is {
  sol: number;
  [key: string]: unknown;
} {
  if (!isObject(value)) return false;
  return isNumber(value.sol);
}

/**
 * Type guard for validating token info response
 */
export function isValidTokenInfoResponse(value: unknown): value is {
  results?: Array<{
    launchpad?: string;
    audit?: { bot_holders_pct?: number };
    [key: string]: unknown;
  }>;
} | null {
  if (value === null) return true;
  if (!isObject(value)) return false;

  if (value.results !== undefined) {
    if (!Array.isArray(value.results)) return false;
  }

  return true;
}

/**
 * Type guard for validating smart wallet response
 */
export function isValidSmartWalletResponse(value: unknown): value is {
  in_pool?: Array<{ name: string; [key: string]: unknown }>;
  [key: string]: unknown;
} | null {
  if (value === null) return true;
  if (!isObject(value)) return false;

  if (value.in_pool !== undefined) {
    if (!Array.isArray(value.in_pool)) return false;
  }

  return true;
}

/**
 * Type guard for validating narrative response
 */
export function isValidNarrativeResponse(value: unknown): value is {
  narrative?: string;
  quality?: string;
  [key: string]: unknown;
} | null {
  if (value === null) return true;
  if (!isObject(value)) return false;

  if (value.narrative !== undefined && !isString(value.narrative)) return false;
  if (value.quality !== undefined && !isString(value.quality)) return false;

  return true;
}
