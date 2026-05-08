/**
 * Section 27 — `rate-limiter`. Multi-dimensional gating between callers
 * and downstream services. Three keyed dimensions:
 *  - **per-tenant** (gateway-server pre-handler)
 *  - **per-provider** (model-router pre-call)
 *  - **per-tool** (runtime-core pre-tool-execute, configured in spec under
 *    `tools.<Name>.rateLimit`)
 *
 * Two algorithms; pick per-bucket:
 *  - **token-bucket** — burst-tolerant. `capacity` tokens; refill at
 *    `refillPerSec`. Acquire blocks until enough tokens are available.
 *  - **leaky-bucket** — smoothing. Treat acquires as drops landing in a
 *    bucket that drains at `refillPerSec`. New drops queue when the
 *    bucket is full; the queue serves drops at the drain rate.
 *
 * `acquire(keys, cost)` evaluates each key in order and only proceeds
 * when *every* bucket has the requested cost. The implementation never
 * takes a partial reservation — if any bucket would block, the call
 * either waits for the longest delay or rejects on `maxWaitMs`. This
 * guarantees fail-closed semantics: an unknown key always denies.
 */
import { CrewhausError } from "@crewhaus/errors";

export class RateLimitError extends CrewhausError {
  override readonly name = "RateLimitError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type BucketKind = "token-bucket" | "leaky-bucket";

export type BucketConfig = {
  readonly kind: BucketKind;
  /** Maximum tokens (token-bucket) or queue depth (leaky-bucket). */
  readonly capacity: number;
  /** Refill rate (token-bucket) or drain rate (leaky-bucket), per second. */
  readonly refillPerSec: number;
};

export type AcquireKey = {
  readonly dimension: "tenant" | "provider" | "tool";
  readonly id: string;
};

export type AcquireOptions = {
  /** How long to wait for tokens before rejecting. Defaults to 30s. */
  readonly maxWaitMs?: number;
  /** Override now() for tests. */
  readonly now?: () => number;
};

export type RateLimiterOptions = {
  /**
   * Per-`(dimension, id)` bucket configuration. Lookup is exact-match;
   * unknown keys deny by default (fail-closed). The `*` id is reserved
   * for the per-dimension default — declared explicitly when one is
   * desired.
   */
  readonly buckets: ReadonlyMap<string, BucketConfig>;
  /** Override "now" for tests. */
  readonly now?: () => number;
};

export interface RateLimiter {
  /**
   * Acquire `cost` tokens (default 1) from each key's bucket. Resolves
   * once every bucket has paid out. Rejects with `RateLimitError` if
   * any waited longer than `maxWaitMs`, or if any key is missing.
   */
  acquire(keys: ReadonlyArray<AcquireKey>, cost?: number, opts?: AcquireOptions): Promise<void>;
  /** Diagnostic snapshot of current bucket state. */
  inspect(key: AcquireKey):
    | {
        config: BucketConfig;
        available: number;
        waitingCount: number;
      }
    | undefined;
}

/** Stable string key for a dimension+id pair. */
export function bucketKeyOf(key: AcquireKey): string {
  return `${key.dimension}:${key.id}`;
}

/** Static helper: bucket capacity check (no async waiting). */
export function tokenBucketAvailable(
  state: TokenBucketState,
  cost: number,
  now: number,
  config: BucketConfig,
): boolean {
  refillTokenBucket(state, now, config);
  return state.tokens >= cost;
}

type TokenBucketState = {
  tokens: number;
  lastRefillMs: number;
};

type LeakyBucketState = {
  /** Number of tokens currently in the bucket (queued). */
  level: number;
  lastDrainMs: number;
  /** FIFO queue of pending acquirers awaiting drain. */
  queue: Array<{
    cost: number;
    resolve: () => void;
    reject: (err: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }>;
};

function refillTokenBucket(state: TokenBucketState, now: number, config: BucketConfig): void {
  const elapsedSec = Math.max(0, (now - state.lastRefillMs) / 1000);
  const refilled = elapsedSec * config.refillPerSec;
  state.tokens = Math.min(config.capacity, state.tokens + refilled);
  state.lastRefillMs = now;
}

function drainLeakyBucket(state: LeakyBucketState, now: number, config: BucketConfig): void {
  const elapsedSec = Math.max(0, (now - state.lastDrainMs) / 1000);
  const drained = elapsedSec * config.refillPerSec;
  state.level = Math.max(0, state.level - drained);
  state.lastDrainMs = now;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const buckets = opts.buckets;
  const tokenStates = new Map<string, TokenBucketState>();
  const leakyStates = new Map<string, LeakyBucketState>();

  function getNow(callerNow?: () => number): number {
    return (callerNow ?? opts.now ?? Date.now)();
  }

  function getOrInitTokenState(key: string, config: BucketConfig, now: number): TokenBucketState {
    let s = tokenStates.get(key);
    if (!s) {
      s = { tokens: config.capacity, lastRefillMs: now };
      tokenStates.set(key, s);
    }
    return s;
  }

  function getOrInitLeakyState(key: string, now: number): LeakyBucketState {
    let s = leakyStates.get(key);
    if (!s) {
      s = { level: 0, lastDrainMs: now, queue: [] };
      leakyStates.set(key, s);
    }
    return s;
  }

  /**
   * Wait for a single bucket to allow `cost` tokens. Resolves when ready.
   * `maxWaitMs` enforces the cap; rejects with RateLimitError on timeout.
   */
  function acquireOne(
    key: AcquireKey,
    cost: number,
    config: BucketConfig,
    maxWaitMs: number,
    nowFn: () => number,
  ): Promise<void> {
    const k = bucketKeyOf(key);
    const start = nowFn();

    if (config.kind === "token-bucket") {
      return new Promise<void>((resolve, reject) => {
        const tryAcquire = (): void => {
          const now = nowFn();
          const state = getOrInitTokenState(k, config, now);
          refillTokenBucket(state, now, config);
          if (state.tokens >= cost) {
            state.tokens -= cost;
            resolve();
            return;
          }
          const elapsedMs = now - start;
          const remainingMs = maxWaitMs - elapsedMs;
          if (remainingMs <= 0) {
            reject(
              new RateLimitError(
                `rate limit exceeded for ${k}: ${cost} tokens needed, ${state.tokens.toFixed(2)} available, max wait ${maxWaitMs}ms reached`,
              ),
            );
            return;
          }
          // Time until enough tokens accrue
          const deficit = cost - state.tokens;
          const msToWait = Math.min(
            remainingMs,
            Math.max(10, (deficit / config.refillPerSec) * 1000),
          );
          setTimeout(tryAcquire, msToWait);
        };
        tryAcquire();
      });
    }

    // leaky-bucket
    return new Promise<void>((resolve, reject) => {
      const now = nowFn();
      const state = getOrInitLeakyState(k, now);
      drainLeakyBucket(state, now, config);
      const wouldExceed = state.level + cost > config.capacity;
      if (!wouldExceed && state.queue.length === 0) {
        // Fast-path: no queue, fits in capacity.
        state.level += cost;
        resolve();
        return;
      }
      // Queue and rely on drain timer.
      const entry = {
        cost,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = state.queue.indexOf(entry);
          if (idx >= 0) state.queue.splice(idx, 1);
          reject(
            new RateLimitError(
              `rate limit exceeded for ${k}: leaky bucket full, max wait ${maxWaitMs}ms reached`,
            ),
          );
        }, maxWaitMs),
      };
      state.queue.push(entry);
      // Schedule a drain check.
      const drainEveryMs = Math.max(10, 1000 / config.refillPerSec);
      const tick = (): void => {
        const tickNow = nowFn();
        drainLeakyBucket(state, tickNow, config);
        // Process as many queue entries as fit under capacity.
        while (state.queue.length > 0) {
          const head = state.queue[0];
          if (!head) break;
          if (state.level + head.cost <= config.capacity) {
            state.queue.shift();
            if (head.timer) clearTimeout(head.timer);
            state.level += head.cost;
            head.resolve();
          } else {
            break;
          }
        }
        if (state.queue.length > 0) {
          setTimeout(tick, drainEveryMs);
        }
      };
      setTimeout(tick, drainEveryMs);
    });
  }

  return {
    async acquire(keys, cost = 1, callerOpts = {}): Promise<void> {
      const maxWaitMs = callerOpts.maxWaitMs ?? 30_000;
      const nowFn = (): number => getNow(callerOpts.now);

      // Fail-closed: every key must resolve to a known bucket.
      for (const key of keys) {
        const k = bucketKeyOf(key);
        if (!buckets.has(k)) {
          // Per-dimension default lookup
          const fallback = `${key.dimension}:*`;
          if (!buckets.has(fallback)) {
            throw new RateLimitError(`no bucket configured for ${k} (and no ${fallback} default)`);
          }
        }
      }

      // Acquire each in sequence so we don't double-charge a bucket on
      // partial failure. (Parallel acquisition would require two-phase
      // commit; sequential is simpler and the bucket counts stay correct.)
      const acquired: AcquireKey[] = [];
      try {
        for (const key of keys) {
          const k = bucketKeyOf(key);
          const config = buckets.get(k) ?? buckets.get(`${key.dimension}:*`);
          if (!config) throw new RateLimitError(`no bucket for ${k}`);
          await acquireOne(key, cost, config, maxWaitMs, nowFn);
          acquired.push(key);
        }
      } catch (err) {
        // Refund any successful acquisitions so partial failures don't drain buckets.
        const now = nowFn();
        for (const key of acquired) {
          const k = bucketKeyOf(key);
          const config = buckets.get(k) ?? buckets.get(`${key.dimension}:*`);
          if (!config) continue;
          if (config.kind === "token-bucket") {
            const state = tokenStates.get(k);
            if (state) {
              state.tokens = Math.min(config.capacity, state.tokens + cost);
              state.lastRefillMs = now;
            }
          } else {
            const state = leakyStates.get(k);
            if (state) {
              state.level = Math.max(0, state.level - cost);
              state.lastDrainMs = now;
            }
          }
        }
        throw err;
      }
    },

    inspect(key): { config: BucketConfig; available: number; waitingCount: number } | undefined {
      const k = bucketKeyOf(key);
      const config = buckets.get(k) ?? buckets.get(`${key.dimension}:*`);
      if (!config) return undefined;
      const now = (opts.now ?? Date.now)();
      if (config.kind === "token-bucket") {
        const state = tokenStates.get(k);
        if (!state) {
          return { config, available: config.capacity, waitingCount: 0 };
        }
        refillTokenBucket(state, now, config);
        return { config, available: state.tokens, waitingCount: 0 };
      }
      const state = leakyStates.get(k);
      if (!state) {
        return { config, available: config.capacity, waitingCount: 0 };
      }
      drainLeakyBucket(state, now, config);
      return {
        config,
        available: Math.max(0, config.capacity - state.level),
        waitingCount: state.queue.length,
      };
    },
  };
}
