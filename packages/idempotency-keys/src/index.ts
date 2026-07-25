/**
 * Catalog R7 `idempotency-keys` — Section 23 BATCH.
 *
 * Per-key cached-result store the BATCH consumer wraps the user's
 * handler with, so a job that ALREADY COMPLETED and comes back anyway
 * (a crash or a lost ack between the handler returning and the queue
 * being told, an expired visibility lease) returns the cached value
 * without re-invoking the model.
 *
 * Key shape: `idempotencyKey(jobId)` — the key is the job's IDENTITY and
 * nothing else. It deliberately does NOT include the attempt counter: a
 * redelivery (crash → retry, a swallowed ack, a visibility lease that
 * collided with another consumer) is precisely the case the cache exists
 * to serve, and every queue adapter that tracks attempts hands the
 * redelivery a *higher* attempt number. Folding the attempt into the key
 * therefore guaranteed a miss on exactly the path that matters and made
 * the configured window unreachable.
 *
 * Only SUCCESSFUL results are cached (see `withIdempotency`), so a
 * failed attempt never suppresses its own retry.
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
 * Compose a stable key from a job id. We hash so the key fits the typical
 * kv-store key-length limits regardless of job-id shape.
 *
 * `discriminator` partitions the key space for callers whose dedupe unit is
 * NARROWER than the job id — a graph node that must re-run once per attempt,
 * say. It defaults to `0`, which is what queue redelivery wants and what the
 * content-derived callers (`target-managed`, `target-browser-driver`) already
 * pass explicitly, so their keys are unchanged. Passing a per-delivery
 * counter here defeats redelivery dedupe: don't, unless re-running is the
 * point.
 */
export function idempotencyKey(jobId: string, discriminator = 0): IdempotencyKey {
  return createHash("sha256").update(`${jobId}:${discriminator}`).digest("hex").slice(0, 24);
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
