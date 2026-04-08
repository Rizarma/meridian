/**
 * Error handling utilities for safe error message extraction.
 * Replaces unsafe (error as Error).message patterns throughout the codebase.
 */

/**
 * Safely extract error message from unknown error type.
 * Handles Error objects, strings, and other types gracefully.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * Type guard for API errors with status codes.
 */
export function isApiError(error: unknown): error is { status?: number; message?: string } {
  return typeof error === "object" && error !== null && ("status" in error || "message" in error);
}

/**
 * Safely extract error message with fallback.
 */
export function getErrorMessageOrFallback(error: unknown, fallback: string): string {
  try {
    return getErrorMessage(error);
  } catch {
    return fallback;
  }
}
