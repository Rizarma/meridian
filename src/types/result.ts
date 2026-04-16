/**
 * Standardized Result Types for Tool Handlers
 *
 * Provides consistent error handling patterns across all tools:
 * - SuccessResult: { success: true, data: T, meta?: Record<string, unknown> }
 * - ErrorResult: { success: false, error: string, code?: string, blocked?: boolean, reason?: string }
 *
 * Helper functions:
 * - success(data, meta?): Create a success result
 * - error(message, options?): Create an error result
 * - blocked(reason, code?): Create a blocked result (special error for safety checks)
 * - isSuccess(result): Type guard for success results
 * - isError(result): Type guard for error results
 */

/**
 * Success result type - operation completed successfully
 */
export interface SuccessResult<T = unknown> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

/**
 * Error result type - operation failed
 * Includes optional code for debugging and blocked flag for safety checks
 */
export interface ErrorResult {
  success: false;
  error: string;
  code?: string;
  blocked?: boolean;
  reason?: string;
}

/**
 * Union type for all tool results
 */
export type ToolResult<T = unknown> = SuccessResult<T> | ErrorResult;

/**
 * Create a success result
 * @param data - The successful result data
 * @param meta - Optional metadata
 * @returns SuccessResult
 */
export function success<T>(data: T, meta?: Record<string, unknown>): SuccessResult<T> {
  return { success: true, data, meta };
}

/**
 * Create an error result
 * @param message - Error message
 * @param options - Optional error details (code, blocked, reason)
 * @returns ErrorResult
 */
export function error(
  message: string,
  options?: { code?: string; blocked?: boolean; reason?: string }
): ErrorResult {
  return {
    success: false,
    error: message,
    ...options,
  };
}

/**
 * Create a blocked result (special error for safety checks)
 * @param reason - Why the operation was blocked
 * @param code - Optional error code
 * @returns ErrorResult with blocked: true
 */
export function blocked(reason: string, code?: string): ErrorResult {
  return {
    success: false,
    error: `Blocked: ${reason}`,
    blocked: true,
    reason,
    code,
  };
}

/**
 * Type guard: Check if result is a success
 * @param result - ToolResult to check
 * @returns true if result is SuccessResult
 */
export function isSuccess<T>(result: ToolResult<T>): result is SuccessResult<T> {
  return result.success === true;
}

/**
 * Type guard: Check if result is an error
 * @param result - ToolResult to check
 * @returns true if result is ErrorResult
 */
export function isError<T>(result: ToolResult<T>): result is ErrorResult {
  return result.success === false;
}

/**
 * Convert legacy result format to standardized ToolResult
 * Handles various legacy patterns:
 * - { success: true, ...data }
 * - { success: false, error: string }
 * - { blocked: true, reason: string }
 * - { error: string } (no success flag)
 * - Plain objects (wrap as success)
 */
export function normalizeResult<T = unknown>(result: unknown): ToolResult<T> {
  // Handle null/undefined
  if (result == null) {
    return error("Null or undefined result", { code: "NULL_RESULT" });
  }

  // Must be an object
  if (typeof result !== "object") {
    return success(result as T);
  }

  const r = result as Record<string, unknown>;

  // Check for blocked pattern first (highest priority)
  if (r.blocked === true && typeof r.reason === "string") {
    return blocked(r.reason, typeof r.code === "string" ? r.code : undefined);
  }

  // Check for explicit success flag
  if (r.success === true) {
    // Extract data from success result
    const { success: _, ...rest } = r;
    // If there's a data property, use it; otherwise wrap the rest
    const data = (r.data as T) ?? (rest as unknown as T);
    const meta =
      typeof r.meta === "object" && r.meta !== null
        ? (r.meta as Record<string, unknown>)
        : undefined;
    return success(data, meta);
  }

  if (r.success === false) {
    const errorMsg = typeof r.error === "string" ? r.error : "Unknown error";
    return error(errorMsg, {
      code: typeof r.code === "string" ? r.code : undefined,
      blocked: r.blocked === true,
      reason: typeof r.reason === "string" ? r.reason : undefined,
    });
  }

  // Check for error without success flag
  if (typeof r.error === "string") {
    return error(r.error, {
      code: typeof r.code === "string" ? r.code : undefined,
      blocked: r.blocked === true,
      reason: typeof r.reason === "string" ? r.reason : undefined,
    });
  }

  // Default: treat as success with the whole object as data
  return success(result as T);
}
