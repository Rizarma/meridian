/**
 * Retry configuration options
 */
export interface RetryConfig {
  maxAttempts?: number; // Default: 3
  baseDelayMs?: number; // Default: 1000 (1 second)
  maxDelayMs?: number; // Default: 10000 (10 seconds)
  retryableStatuses?: number[]; // Default: [408, 429, 500, 502, 503, 504]
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 30% jitter
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

/**
 * Check if error/status is retryable
 */
function isRetryable(_error: unknown, status?: number): boolean {
  // Network errors (no status) are retryable
  if (status === undefined) return true;

  const retryableStatuses = [408, 429, 500, 502, 503, 504];
  return retryableStatuses.includes(status);
}

/**
 * Execute a function with exponential backoff retry
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, maxDelayMs = 10000 } = config;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      const status = (error as { status?: number }).status;
      if (!isRetryable(error, status) || attempt === maxAttempts) {
        throw error;
      }

      // Calculate delay and wait
      const delayMs = calculateDelay(attempt, baseDelayMs, maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

/**
 * Fetch with retry and timeout
 */
export async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30000,
  retryConfig?: RetryConfig
): Promise<Response> {
  return withRetry(async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      // Throw on error status to trigger retry
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        (error as { status?: number }).status = response.status;
        throw error;
      }

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }, retryConfig);
}
