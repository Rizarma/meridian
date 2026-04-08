/**
 * Validation utilities for safe type assertions
 *
 * These helpers provide runtime validation before type assertions,
 * preventing runtime failures from unsafe `as` casts.
 */

/**
 * Validate that a value is a non-null object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate that a value is an array
 */
export function isArray<T>(value: unknown): value is T[] {
  return Array.isArray(value);
}

/**
 * Validate that a value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Validate that a value is a number (and not NaN)
 */
export function isNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

/**
 * Validate that a value is a boolean
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Safe type assertion with validation
 */
export function assertType<T>(
  value: unknown,
  validator: (v: unknown) => v is T,
  errorMessage: string
): T {
  if (!validator(value)) {
    throw new Error(errorMessage);
  }
  return value;
}

/**
 * Validate that a value is a non-empty array
 */
export function isNonEmptyArray<T>(value: unknown): value is T[] {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Validate that a value is a valid position object with required fields
 */
export function isValidPosition(value: unknown): value is { position: string } {
  if (!isObject(value)) return false;
  return isString(value.position);
}

/**
 * Type guard for WalletBalances
 */
export function isWalletBalances(value: unknown): value is {
  wallet: string | null;
  sol: number;
  sol_price: number;
  sol_usd: number;
  usdc: number;
  tokens: Array<{ mint: string; symbol: string; balance: number; usd: number | null }>;
  total_usd: number;
  error?: string;
} {
  if (!isObject(value)) return false;

  // Check required numeric fields
  if (!isNumber(value.sol)) return false;
  if (!isNumber(value.sol_price)) return false;
  if (!isNumber(value.sol_usd)) return false;
  if (!isNumber(value.usdc)) return false;
  if (!isNumber(value.total_usd)) return false;

  // Check tokens array
  if (!isArray(value.tokens)) return false;

  // Check wallet field (can be string or null)
  if (value.wallet !== null && !isString(value.wallet)) return false;

  return true;
}

/**
 * Type guard for SDK pool response
 */
export function isValidPoolResponse(value: unknown): value is {
  lbPair?: {
    tokenXMint?: { toString(): string };
    tokenYMint?: { toString(): string };
    binStep?: number;
    parameters?: { baseFactor?: number };
  };
} {
  if (!isObject(value)) return false;
  return true; // Minimal check - pool objects are complex
}

/**
 * Type guard for position data from SDK
 */
export function isValidPositionData(value: unknown): value is {
  positionData?: {
    lowerBinId?: number;
    upperBinId?: number;
    positionBinData?: Array<unknown>;
  };
} {
  if (!isObject(value)) return false;
  return true; // Minimal check - position data is complex
}
