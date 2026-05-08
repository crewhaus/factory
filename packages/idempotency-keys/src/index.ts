/**
 * Catalog R7 `idempotency-keys` — Section 23 BATCH.
 *
 * Per-key cached-result store the BATCH consumer wraps the user's
 * handler with so a job that's already been processed (e.g. after a
 * crash → retry, or after a transient nack that produced a partial
 * result) returns the cached value without re-invoking the model.
 *
 * Key shape: `idempotencyKey(jobId, attempt)` — the consumer derives
 * the key from the job's id + attempt counter on the queue. Same job
 * + same attempt → same key, so two consumers grabbing the same job
 * (the "double-pull" race when visibility leases collide) get the
 * same cached result.
 *
 * The default `createInMemoryIdempotencyStore` is a Map with a per-key
 * TTL. Eviction happens lazily on next get/set; tests can override the
 * clock via the `now` injection seam.
 */
import { createHash } from "node:crypto";

export type IdempotencyKey = string;

export interface IdempotencyStore<TValue = unknown> {
  get(key: IdempotencyKey): Promise<TValue | undefined>;
  /** TTL in ms; entries past TTL are evicted on next access. */
  set(key: IdempotencyKey, value: TValue, ttlMs: number): Promise<void>;
  /** Test seam — current entry count after lazy eviction. */
  size(): number;
}

/**
 * Compose a stable key from a job id + attempt number. We hash so the
 * key fits the typical kv-store key-length limits regardless of job-id
 * shape.
 */
export function idempotencyKey(jobId: string, attempt: number): IdempotencyKey {
  return createHash("sha256").update(`${jobId}:${attempt}`).digest("hex").slice(0, 24);
}

export type InMemoryStoreOptions = {
  readonly now?: () => number;
};

export function createInMemoryIdempotencyStore<TValue = unknown>(
  opts: InMemoryStoreOptions = {},
): IdempotencyStore<TValue> {
  const now = opts.now ?? Date.now;
  type Entry = { value: TValue; expiresAt: number };
  const map = new Map<IdempotencyKey, Entry>();

  function evictExpired(): void {
    const t = now();
    for (const [k, v] of map.entries()) {
      if (v.expiresAt <= t) map.delete(k);
    }
  }

  return {
    async get(key) {
      evictExpired();
      const entry = map.get(key);
      if (entry === undefined) return undefined;
      return entry.value;
    },
    async set(key, value, ttlMs) {
      evictExpired();
      map.set(key, { value, expiresAt: now() + ttlMs });
    },
    size() {
      evictExpired();
      return map.size;
    },
  };
}

/**
 * `withIdempotency` wraps a handler so a re-invocation with the same
 * (jobId, attempt) tuple is served from cache. The first call's
 * SUCCESSFUL result is cached; failures (the handler throws) bypass the
 * cache so the next attempt re-runs the handler. This matches the
 * SQS-style "ack on success, nack on failure" contract: the cache is
 * for ack'd work, not for failed attempts.
 */
export function withIdempotency<TInput, TResult>(
  handler: (input: TInput, key: IdempotencyKey) => Promise<TResult>,
  opts: {
    readonly store: IdempotencyStore<TResult>;
    readonly ttlMs: number;
  },
): (input: TInput, key: IdempotencyKey) => Promise<{ value: TResult; fromCache: boolean }> {
  return async (input, key) => {
    const cached = await opts.store.get(key);
    if (cached !== undefined) return { value: cached, fromCache: true };
    const value = await handler(input, key);
    await opts.store.set(key, value, opts.ttlMs);
    return { value, fromCache: false };
  };
}
