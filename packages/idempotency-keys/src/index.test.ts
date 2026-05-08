import { describe, expect, test } from "bun:test";
import { createInMemoryIdempotencyStore, idempotencyKey, withIdempotency } from "./index.js";

describe("idempotencyKey", () => {
  test("same (jobId, attempt) → same key (T9 invariant)", () => {
    const a = idempotencyKey("job_001", 1);
    const b = idempotencyKey("job_001", 1);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
  });

  test("different attempts produce different keys", () => {
    expect(idempotencyKey("job_001", 1)).not.toBe(idempotencyKey("job_001", 2));
  });

  test("different jobIds produce different keys", () => {
    expect(idempotencyKey("a", 1)).not.toBe(idempotencyKey("b", 1));
  });
});

describe("createInMemoryIdempotencyStore", () => {
  test("get returns undefined for unknown keys", async () => {
    const store = createInMemoryIdempotencyStore();
    expect(await store.get("nope")).toBeUndefined();
  });

  test("set then get within TTL returns the value", async () => {
    const store = createInMemoryIdempotencyStore<string>();
    await store.set("k", "v", 1000);
    expect(await store.get("k")).toBe("v");
  });

  test("entries past TTL are evicted on next access", async () => {
    let t = 1_000;
    const store = createInMemoryIdempotencyStore<string>({ now: () => t });
    await store.set("k", "v", 100);
    expect(await store.get("k")).toBe("v");
    t = 1_200;
    expect(await store.get("k")).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});

describe("withIdempotency", () => {
  test("first call invokes the handler; second call with same key hits cache", async () => {
    const store = createInMemoryIdempotencyStore<string>();
    let invocations = 0;
    const wrapped = withIdempotency<{ x: number }, string>(
      async (input) => {
        invocations += 1;
        return `result-${input.x}-${invocations}`;
      },
      { store, ttlMs: 60_000 },
    );
    const k = idempotencyKey("job_a", 1);
    const first = await wrapped({ x: 7 }, k);
    const second = await wrapped({ x: 7 }, k);
    expect(invocations).toBe(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.value).toBe(first.value);
  });

  test("handler errors do NOT poison the cache (next attempt re-runs)", async () => {
    const store = createInMemoryIdempotencyStore<string>();
    let invocations = 0;
    const wrapped = withIdempotency<unknown, string>(
      async () => {
        invocations += 1;
        if (invocations === 1) throw new Error("transient");
        return "ok";
      },
      { store, ttlMs: 60_000 },
    );
    const k = idempotencyKey("job_x", 1);
    await expect(wrapped(null, k)).rejects.toThrow("transient");
    const retry = await wrapped(null, k);
    expect(retry.value).toBe("ok");
    expect(retry.fromCache).toBe(false);
    expect(invocations).toBe(2);
  });

  test("T9 property: 5 retries with the same key call the handler once and return identical results", async () => {
    const store = createInMemoryIdempotencyStore<string>();
    let invocations = 0;
    const wrapped = withIdempotency<unknown, string>(
      async () => {
        invocations += 1;
        return `unique-${Math.random()}`; // would differ on each call
      },
      { store, ttlMs: 60_000 },
    );
    const key = idempotencyKey("job_p", 1);
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await wrapped(null, key);
      results.push(r.value);
    }
    expect(invocations).toBe(1);
    expect(new Set(results).size).toBe(1); // all identical
  });
});
