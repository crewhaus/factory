/**
 * Section 27 — `rate-limiter` tests:
 *  - T1 per algorithm (token-bucket vs leaky-bucket) edge cases
 *  - T7 1000-acquirer load test (concurrency-fair + no starvation)
 *  - T8 fail-closed when keys are missing (deny rather than allow)
 */
import { describe, expect, test } from "bun:test";
import {
  type AcquireKey,
  type BucketConfig,
  RateLimitError,
  bucketKeyOf,
  createRateLimiter,
} from "./index";

describe("rate-limiter — T1 token-bucket", () => {
  test("acquire below capacity is immediate", async () => {
    const buckets = new Map<string, BucketConfig>([
      ["tenant:t1", { kind: "token-bucket", capacity: 10, refillPerSec: 1 }],
    ]);
    const rl = createRateLimiter({ buckets });
    const t0 = Date.now();
    await rl.acquire([{ dimension: "tenant", id: "t1" }], 5);
    expect(Date.now() - t0).toBeLessThan(50);
    const inspect = rl.inspect({ dimension: "tenant", id: "t1" });
    expect(inspect?.available).toBeCloseTo(5, 1);
  });

  test("burst tolerance: capacity available immediately at start", async () => {
    const buckets = new Map<string, BucketConfig>([
      ["tenant:t1", { kind: "token-bucket", capacity: 10, refillPerSec: 0.1 }],
    ]);
    const rl = createRateLimiter({ buckets });
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      await rl.acquire([{ dimension: "tenant", id: "t1" }], 1);
    }
    expect(Date.now() - t0).toBeLessThan(100);
  });

  test("blocks until refill when over capacity", async () => {
    const buckets = new Map<string, BucketConfig>([
      ["tenant:t1", { kind: "token-bucket", capacity: 1, refillPerSec: 10 }],
    ]);
    const rl = createRateLimiter({ buckets });
    const t0 = Date.now();
    await rl.acquire([{ dimension: "tenant", id: "t1" }], 1);
    await rl.acquire([{ dimension: "tenant", id: "t1" }], 1);
    const elapsed = Date.now() - t0;
    // Second call needs to wait for ~100ms refill. Generous lower bound for
    // shared-CI scheduling jitter; upper bound large enough to avoid flake.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(2_000);
  });

  test("rejects after maxWaitMs when refill rate too slow", async () => {
    const buckets = new Map<string, BucketConfig>([
      ["tenant:t1", { kind: "token-bucket", capacity: 1, refillPerSec: 0.01 }],
    ]);
    const rl = createRateLimiter({ buckets });
    await rl.acquire([{ dimension: "tenant", id: "t1" }], 1);
    expect(
      rl.acquire([{ dimension: "tenant", id: "t1" }], 1, { maxWaitMs: 100 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("rate-limiter — T1 leaky-bucket", () => {
  test("smoothing: requests release at refill rate", async () => {
    const buckets = new Map<string, BucketConfig>([
      ["tenant:t1", { kind: "leaky-bucket", capacity: 5, refillPerSec: 50 }],
    ]);
    const rl = createRateLimiter({ buckets });
    // 5 fit under capacity; 6th queues for ~20ms. Generous bounds for jitter.
    const promises: Array<Promise<void>> = [];
    const t0 = Date.now();
    for (let i = 0; i < 7; i++) {
      promises.push(rl.acquire([{ dimension: "tenant", id: "t1" }], 1, { maxWaitMs: 30_000 }));
    }
    await Promise.all(promises);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(elapsed).toBeLessThan(5_000);
  });

  test("rejects on maxWait when queue stays full", async () => {
    const buckets = new Map<string, BucketConfig>([
      ["tenant:t1", { kind: "leaky-bucket", capacity: 1, refillPerSec: 0.01 }],
    ]);
    const rl = createRateLimiter({ buckets });
    await rl.acquire([{ dimension: "tenant", id: "t1" }], 1);
    expect(
      rl.acquire([{ dimension: "tenant", id: "t1" }], 1, { maxWaitMs: 50 }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("rate-limiter — T8 fail-closed on missing keys", () => {
  test("acquire on unknown key throws RateLimitError", async () => {
    const rl = createRateLimiter({ buckets: new Map() });
    expect(rl.acquire([{ dimension: "tenant", id: "unknown" }], 1)).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  test("acquire passes for unknown id when * default exists", async () => {
    const buckets = new Map<string, BucketConfig>([
      ["tenant:*", { kind: "token-bucket", capacity: 5, refillPerSec: 1 }],
    ]);
    const rl = createRateLimiter({ buckets });
    await rl.acquire([{ dimension: "tenant", id: "any" }], 1);
  });

  test("partial failure refunds successful acquisitions", async () => {
    const buckets = new Map<string, BucketConfig>([
      ["tenant:t1", { kind: "token-bucket", capacity: 10, refillPerSec: 1 }],
      // provider:p1 missing
    ]);
    const rl = createRateLimiter({ buckets });
    expect(
      rl.acquire(
        [
          { dimension: "tenant", id: "t1" },
          { dimension: "provider", id: "p1" },
        ],
        1,
      ),
    ).rejects.toBeInstanceOf(RateLimitError);
    // tenant bucket should still have full capacity after refund.
    const inspect = rl.inspect({ dimension: "tenant", id: "t1" });
    expect(inspect?.available).toBeCloseTo(10, 1);
  });
});

describe("rate-limiter — multi-dimensional", () => {
  test("acquire sums against tenant + provider + tool buckets", async () => {
    const buckets = new Map<string, BucketConfig>([
      ["tenant:t1", { kind: "token-bucket", capacity: 10, refillPerSec: 1 }],
      ["provider:p1", { kind: "token-bucket", capacity: 10, refillPerSec: 1 }],
      ["tool:Bash", { kind: "token-bucket", capacity: 5, refillPerSec: 1 }],
    ]);
    const rl = createRateLimiter({ buckets });
    await rl.acquire([
      { dimension: "tenant", id: "t1" },
      { dimension: "provider", id: "p1" },
      { dimension: "tool", id: "Bash" },
    ]);
    expect(rl.inspect({ dimension: "tenant", id: "t1" })?.available).toBeCloseTo(9, 1);
    expect(rl.inspect({ dimension: "tool", id: "Bash" })?.available).toBeCloseTo(4, 1);
  });
});

describe("rate-limiter — T7 load: 1000 acquirers, no starvation", () => {
  test("1000 concurrent acquires drain in expected wall-clock time", async () => {
    const buckets = new Map<string, BucketConfig>([
      ["tenant:t1", { kind: "token-bucket", capacity: 100, refillPerSec: 5000 }],
    ]);
    const rl = createRateLimiter({ buckets });
    const t0 = Date.now();
    const promises = Array.from({ length: 1000 }, () =>
      rl.acquire([{ dimension: "tenant", id: "t1" }], 1, { maxWaitMs: 60_000 }),
    );
    await Promise.all(promises);
    const elapsed = Date.now() - t0;
    // (1000 - 100) tokens to refill at 5000/s ≈ 180ms baseline. Allow very
    // generous headroom for parallel-CI jitter.
    expect(elapsed).toBeLessThan(15_000);
  });
});

describe("rate-limiter — bucketKeyOf", () => {
  test("formats dimension + id stably", () => {
    const k: AcquireKey = { dimension: "provider", id: "anthropic" };
    expect(bucketKeyOf(k)).toBe("provider:anthropic");
  });
});
