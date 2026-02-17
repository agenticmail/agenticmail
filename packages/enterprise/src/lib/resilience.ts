/**
 * Resilience Utilities
 * 
 * Retry logic, circuit breakers, connection health checks,
 * rate limiting, and graceful degradation patterns.
 */

// ─── Retry with Exponential Backoff ──────────────────────

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors?: (err: Error) => boolean;
  onRetry?: (attempt: number, err: Error, delayMs: number) => void;
}

const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const config = { ...DEFAULT_RETRY, ...opts };
  let lastError: Error = new Error('No attempts made');

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      if (attempt === config.maxAttempts) break;
      if (config.retryableErrors && !config.retryableErrors(err)) break;

      // Exponential backoff with jitter
      const delay = Math.min(
        config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1) + Math.random() * 200,
        config.maxDelayMs,
      );

      config.onRetry?.(attempt, err, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}

// ─── Circuit Breaker ─────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold: number;    // Failures before opening
  recoveryTimeMs: number;      // Time before half-open
  successThreshold: number;    // Successes in half-open to close
  timeout?: number;            // Per-call timeout in ms
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  private readonly opts: CircuitBreakerOptions;

  constructor(opts: Partial<CircuitBreakerOptions> = {}) {
    this.opts = {
      failureThreshold: opts.failureThreshold ?? 5,
      recoveryTimeMs: opts.recoveryTimeMs ?? 30_000,
      successThreshold: opts.successThreshold ?? 2,
      timeout: opts.timeout,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime >= this.opts.recoveryTimeMs) {
        this.state = 'half-open';
        this.successes = 0;
      } else {
        throw new CircuitOpenError(
          `Circuit breaker is open. Retry after ${this.opts.recoveryTimeMs}ms`,
        );
      }
    }

    try {
      const result = this.opts.timeout
        ? await withTimeout(fn(), this.opts.timeout)
        : await fn();

      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.opts.successThreshold) {
        this.state = 'closed';
        this.failures = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.opts.failureThreshold) {
      this.state = 'open';
    }
  }

  getState(): CircuitState { return this.state; }
  reset(): void { this.state = 'closed'; this.failures = 0; this.successes = 0; }
}

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

// ─── Rate Limiter (Token Bucket) ─────────────────────────

export interface RateLimiterOptions {
  maxTokens: number;           // Bucket capacity
  refillRate: number;          // Tokens per second
  refillIntervalMs?: number;   // How often to refill (default: 1000)
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly opts: Required<RateLimiterOptions>;

  constructor(opts: RateLimiterOptions) {
    this.opts = {
      maxTokens: opts.maxTokens,
      refillRate: opts.refillRate,
      refillIntervalMs: opts.refillIntervalMs ?? 1000,
    };
    this.tokens = this.opts.maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Try to consume a token. Returns true if allowed, false if rate limited.
   */
  tryConsume(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /**
   * Get time in ms until next token is available.
   */
  getRetryAfterMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const tokensNeeded = 1 - this.tokens;
    return Math.ceil((tokensNeeded / this.opts.refillRate) * 1000);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = (elapsed / 1000) * this.opts.refillRate;
    this.tokens = Math.min(this.opts.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}

// ─── Per-Key Rate Limiter (for API endpoints) ────────────

export class KeyedRateLimiter {
  private limiters = new Map<string, RateLimiter>();
  private readonly opts: RateLimiterOptions;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RateLimiterOptions) {
    this.opts = opts;
    // Cleanup stale entries every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000);
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  tryConsume(key: string, count = 1): boolean {
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = new RateLimiter(this.opts);
      this.limiters.set(key, limiter);
    }
    return limiter.tryConsume(count);
  }

  getRetryAfterMs(key: string): number {
    const limiter = this.limiters.get(key);
    return limiter ? limiter.getRetryAfterMs() : 0;
  }

  private cleanup(): void {
    // Remove limiters that haven't been used (all have full tokens)
    for (const [key, limiter] of this.limiters) {
      if (limiter.getRetryAfterMs() === 0) {
        this.limiters.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.limiters.clear();
  }
}

// ─── Connection Health Monitor ───────────────────────────

export interface HealthCheckOptions {
  intervalMs: number;        // How often to check (default: 30s)
  timeoutMs: number;         // Health check timeout
  unhealthyThreshold: number; // Consecutive failures before unhealthy
  healthyThreshold: number;   // Consecutive successes before healthy
}

export class HealthMonitor {
  private healthy = true;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly check: () => Promise<void>;
  private readonly opts: HealthCheckOptions;
  private listeners: ((healthy: boolean) => void)[] = [];

  constructor(check: () => Promise<void>, opts: Partial<HealthCheckOptions> = {}) {
    this.check = check;
    this.opts = {
      intervalMs: opts.intervalMs ?? 30_000,
      timeoutMs: opts.timeoutMs ?? 5_000,
      unhealthyThreshold: opts.unhealthyThreshold ?? 3,
      healthyThreshold: opts.healthyThreshold ?? 2,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.runCheck(), this.opts.intervalMs);
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  isHealthy(): boolean { return this.healthy; }

  onStatusChange(fn: (healthy: boolean) => void): void {
    this.listeners.push(fn);
  }

  private async runCheck(): Promise<void> {
    try {
      await withTimeout(this.check(), this.opts.timeoutMs);
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses++;
      if (!this.healthy && this.consecutiveSuccesses >= this.opts.healthyThreshold) {
        this.healthy = true;
        this.listeners.forEach(fn => fn(true));
      }
    } catch {
      this.consecutiveSuccesses = 0;
      this.consecutiveFailures++;
      if (this.healthy && this.consecutiveFailures >= this.opts.unhealthyThreshold) {
        this.healthy = false;
        this.listeners.forEach(fn => fn(false));
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
    promise
      .then(v => { clearTimeout(timer); resolve(v); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}

// ─── Request ID Generator ────────────────────────────────

let counter = 0;
const prefix = Math.random().toString(36).substring(2, 8);

export function requestId(): string {
  return `${prefix}-${(++counter).toString(36)}-${Date.now().toString(36)}`;
}
