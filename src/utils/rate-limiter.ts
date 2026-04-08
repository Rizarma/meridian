/**
 * Token bucket rate limiter
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per millisecond

  constructor(maxRequests: number, windowMs: number) {
    this.maxTokens = maxRequests;
    this.tokens = maxRequests;
    this.refillRate = maxRequests / windowMs;
    this.lastRefill = Date.now();
  }

  /**
   * Try to acquire a token. Returns true if acquired, false if rate limited.
   */
  tryAcquire(): boolean {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Acquire a token, waiting if necessary
   */
  async acquire(): Promise<void> {
    while (!this.tryAcquire()) {
      const waitMs = Math.ceil(1 / this.refillRate);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /**
   * Get time until next token available (ms)
   */
  getTimeUntilNextToken(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillRate);
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    const tokensToAdd = elapsedMs * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}

/**
 * API-specific rate limiters
 */
export const rateLimiters = {
  // Jupiter: 600 RPM = 10 per second
  jupiter: new RateLimiter(10, 1000),

  // Helius: 10 RPM (conservative) = 1 per 6 seconds
  helius: new RateLimiter(1, 6000),

  // Datapi: Unknown, use conservative 30 RPM = 1 per 2 seconds
  datapi: new RateLimiter(1, 2000),

  // OpenRouter: Varies by model, use 60 RPM = 1 per second
  openrouter: new RateLimiter(1, 1000),

  // OKX: 20 RPM for most endpoints = 1 per 3 seconds
  okx: new RateLimiter(1, 3000),

  // Meteora DLMM API: Conservative 30 RPM
  meteora: new RateLimiter(1, 2000),
};

/**
 * Execute operation with rate limiting
 */
export async function withRateLimit<T>(
  limiter: RateLimiter,
  operation: () => Promise<T>
): Promise<T> {
  await limiter.acquire();
  return operation();
}
