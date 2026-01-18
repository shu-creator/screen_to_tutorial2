/**
 * Rate Limiter using Token Bucket Algorithm
 *
 * Features:
 * - Per-user rate limiting
 * - Configurable rate and burst
 * - Automatic token replenishment
 * - Memory-efficient cleanup for inactive users
 */

export type RateLimitConfig = {
  /** Maximum number of tokens (requests) per window */
  maxTokens: number;
  /** Token refill rate (tokens per second) */
  refillRate: number;
  /** Window duration in milliseconds for cleanup */
  windowMs?: number;
};

type TokenBucket = {
  tokens: number;
  lastRefill: number;
};

const DEFAULT_CONFIG: RateLimitConfig = {
  maxTokens: 60, // 60 requests
  refillRate: 1, // 1 token per second (60/minute)
  windowMs: 60000, // 1 minute window
};

// Per-endpoint rate limit configs
const ENDPOINT_CONFIGS: Record<string, RateLimitConfig> = {
  // Heavy operations - stricter limits
  "project.create": { maxTokens: 5, refillRate: 0.1, windowMs: 60000 }, // 5 per minute, refill slowly
  "project.processVideo": { maxTokens: 3, refillRate: 0.05, windowMs: 60000 }, // 3 per minute
  "step.generate": { maxTokens: 5, refillRate: 0.1, windowMs: 60000 }, // 5 per minute
  "video.generateAudio": { maxTokens: 3, refillRate: 0.05, windowMs: 60000 }, // 3 per minute
  "video.generate": { maxTokens: 3, refillRate: 0.05, windowMs: 60000 }, // 3 per minute
  "slide.generate": { maxTokens: 5, refillRate: 0.1, windowMs: 60000 }, // 5 per minute

  // Moderate operations
  "project.retry": { maxTokens: 10, refillRate: 0.2, windowMs: 60000 }, // 10 per minute
  "project.duplicate": { maxTokens: 10, refillRate: 0.2, windowMs: 60000 }, // 10 per minute

  // Light operations - more lenient
  "project.list": { maxTokens: 120, refillRate: 2, windowMs: 60000 }, // 120 per minute
  "project.getById": { maxTokens: 120, refillRate: 2, windowMs: 60000 },
  "project.getProgress": { maxTokens: 300, refillRate: 5, windowMs: 60000 }, // High limit for polling
  "frame.listByProject": { maxTokens: 120, refillRate: 2, windowMs: 60000 },
  "step.listByProject": { maxTokens: 120, refillRate: 2, windowMs: 60000 },
};

class RateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Cleanup inactive buckets every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);
  }

  /**
   * Check if request is allowed and consume a token
   * @returns true if allowed, false if rate limited
   */
  consume(userId: string, endpoint: string): boolean {
    const key = `${userId}:${endpoint}`;
    const config = ENDPOINT_CONFIGS[endpoint] || DEFAULT_CONFIG;
    const now = Date.now();

    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = {
        tokens: config.maxTokens,
        lastRefill: now,
      };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on time elapsed
    const elapsed = (now - bucket.lastRefill) / 1000; // seconds
    const tokensToAdd = elapsed * config.refillRate;
    bucket.tokens = Math.min(config.maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    // Check if we have tokens available
    if (bucket.tokens < 1) {
      return false;
    }

    // Consume a token
    bucket.tokens -= 1;
    return true;
  }

  /**
   * Get remaining tokens for a user/endpoint combination
   */
  getRemaining(userId: string, endpoint: string): number {
    const key = `${userId}:${endpoint}`;
    const config = ENDPOINT_CONFIGS[endpoint] || DEFAULT_CONFIG;
    const bucket = this.buckets.get(key);

    if (!bucket) {
      return config.maxTokens;
    }

    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = elapsed * config.refillRate;
    return Math.min(config.maxTokens, Math.floor(bucket.tokens + tokensToAdd));
  }

  /**
   * Get time until next token is available (in seconds)
   */
  getRetryAfter(userId: string, endpoint: string): number {
    const key = `${userId}:${endpoint}`;
    const config = ENDPOINT_CONFIGS[endpoint] || DEFAULT_CONFIG;
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.tokens >= 1) {
      return 0;
    }

    // Calculate time needed to get 1 token
    const tokensNeeded = 1 - bucket.tokens;
    return Math.ceil(tokensNeeded / config.refillRate);
  }

  /**
   * Clean up inactive buckets
   */
  private cleanup(): void {
    const now = Date.now();
    const maxInactiveTime = 10 * 60 * 1000; // 10 minutes
    const keysToDelete: string[] = [];

    this.buckets.forEach((bucket, key) => {
      if (now - bucket.lastRefill > maxInactiveTime) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach(key => this.buckets.delete(key));
  }

  /**
   * Get current bucket stats (for debugging/monitoring)
   */
  getStats(): { totalBuckets: number; endpoints: Record<string, number> } {
    const endpoints: Record<string, number> = {};

    this.buckets.forEach((_, key) => {
      const endpoint = key.split(":")[1];
      endpoints[endpoint] = (endpoints[endpoint] || 0) + 1;
    });

    return {
      totalBuckets: this.buckets.size,
      endpoints,
    };
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();

/**
 * Rate limit check result
 */
export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
};

/**
 * Check rate limit for a user and endpoint
 */
export function checkRateLimit(userId: string, endpoint: string): RateLimitResult {
  const allowed = rateLimiter.consume(userId, endpoint);
  const remaining = rateLimiter.getRemaining(userId, endpoint);
  const retryAfter = allowed ? 0 : rateLimiter.getRetryAfter(userId, endpoint);

  return {
    allowed,
    remaining,
    retryAfter,
  };
}
