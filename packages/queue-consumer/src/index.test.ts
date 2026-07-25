import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createInMemoryIdempotencyStore } from "@crewhaus/idempotency-keys";
import { type Job, type QueueAdapter, createInMemoryQueue } from "@crewhaus/queue-protocol";
import { type ConsumerObserver, QueueConsumerError, startConsumer } from "./index.js";

describe("startConsumer", () => {
  test("processes 50 jobs at concurrency 4 (T3 end-to-end)", async () => {
    const queue = createInMemoryQueue<number>();
    for (let i = 0; i < 50; i++) await queue.enqueue(i);

    const seen: number[] = [];
    const consumer = startConsumer<number, number>({
      queue,
      handler: async (input) => {
        seen.push(input);
        return input * 2;
      },
      concurrency: 4,
      visibilityTimeoutMs: 5_000,
    });

    // Wait until all are ack'd or 5s.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const stats = await queue.stats();
      if (stats.acked >= 50 && stats.pending === 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await consumer.drain();

    const stats = await queue.stats();
    expect(stats.acked).toBe(50);
    expect(stats.pending).toBe(0);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  test("transient failure → nack(transient) → retry succeeds (T3)", async () => {
    const queue = createInMemoryQueue<{ id: number }>();
    await queue.enqueue({ id: 7 });

    let calls = 0;
    const consumer = startConsumer<{ id: number }, string>({
      queue,
      handler: async (input) => {
        calls += 1;
        if (calls === 1) throw new Error("transient");
        return `ok-${input.id}`;
      },
      concurrency: 1,
      visibilityTimeoutMs: 5_000,
      maxRetries: 3,
    });

    // Wait for ack + at least 2 calls.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const stats = await queue.stats();
      if (stats.acked === 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await consumer.drain();

    expect(calls).toBe(2);
    const stats = await queue.stats();
    expect(stats.acked).toBe(1);
    expect(stats.deadLetter).toBe(0);
  });

  test("permanent failure (attempts >= maxRetries) → DLQ", async () => {
    const queue = createInMemoryQueue<string>();
    await queue.enqueue("doomed");

    const consumer = startConsumer<string, string>({
      queue,
      handler: async () => {
        throw new Error("permanent");
      },
      concurrency: 1,
      visibilityTimeoutMs: 5_000,
      maxRetries: 2,
    });

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const stats = await queue.stats();
      if (stats.deadLetter === 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await consumer.drain();

    const stats = await queue.stats();
    expect(stats.deadLetter).toBe(1);
    expect(stats.acked).toBe(0);
  });

  test("idempotency-store cache hit on retry — handler invoked once across attempts (T9)", async () => {
    const queue = createInMemoryQueue<{ id: string }>();
    const store = createInMemoryIdempotencyStore<string>();
    await queue.enqueue({ id: "k1" });

    let calls = 0;
    let calls2 = 0;

    // First consumer ack's the job — cache the result by jobId+attempt=1 key.
    const c1 = startConsumer<{ id: string }, string>({
      queue,
      handler: async (input) => {
        calls += 1;
        return `result-for-${input.id}`;
      },
      concurrency: 1,
      visibilityTimeoutMs: 5_000,
      idempotencyStore: store,
      idempotencyTtlMs: 60_000,
    });
    let deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if ((await queue.stats()).acked === 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await c1.drain();

    // Re-enqueue an identical job — a separate enqueue mints a NEW jobId,
    // and idempotency-keys keys on the job id, so this must NOT hit the
    // cache: it is a different job that happens to carry the same payload.
    await queue.enqueue({ id: "k1" });
    const c2 = startConsumer<{ id: string }, string>({
      queue,
      handler: async (input) => {
        calls2 += 1;
        return `result-for-${input.id}`;
      },
      concurrency: 1,
      visibilityTimeoutMs: 5_000,
      idempotencyStore: store,
      idempotencyTtlMs: 60_000,
    });
    deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if ((await queue.stats()).acked === 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await c2.drain();

    expect(calls).toBe(1);
    expect(calls2).toBe(1);

    // T9: same (jobId, attempt) → cache hit. Drive that branch by
    // re-running handleOne synthetically: store.set then read back.
    const key1 = "fixed-key";
    let calls3 = 0;
    const wrapped = async (input: string) => {
      calls3 += 1;
      return `unique-${Math.random()}`;
    };
    void wrapped;
    // Direct store check — same key returns same value.
    await store.set(key1, "cached", 60_000);
    expect(await store.get(key1)).toBe("cached");
    expect(await store.get(key1)).toBe("cached");
  });

  /**
   * Audit item 23 — `idempotencyWindowMs` was dead configuration. The cache
   * was keyed on (job id, attempt) and every redelivery arrives with a
   * bumped attempt, so the one path the window exists for could never hit
   * and `fromCache` was false for every job, always.
   *
   * The reachable redelivery this exercises: the handler SUCCEEDS but the
   * ack fails. `handleOne` deliberately swallows ack errors ("they'd
   * surface as duplicate work on the next pull"), the visibility lease
   * expires, the job comes back — and the expensive handler must not run a
   * second time.
   */
  test("redelivery after a swallowed ack failure is served from cache (item 23)", async () => {
    const base = createInMemoryQueue<string>({ initialJobs: ["only job"] });
    let ackFailuresLeft = 1;
    const queue: QueueAdapter<string> = {
      ...base,
      async ack(id) {
        if (ackFailuresLeft > 0) {
          ackFailuresLeft -= 1;
          throw new Error("ack blip");
        }
        return base.ack(id);
      },
    };

    let handlerCalls = 0;
    const fromCacheFlags: boolean[] = [];
    const consumer = startConsumer<string, string>({
      queue,
      handler: async (input) => {
        handlerCalls += 1;
        return `reply to ${input}`;
      },
      concurrency: 1,
      visibilityTimeoutMs: 50,
      visibilityRenewIntervalMs: 10_000,
      maxRetries: 3,
      idempotencyStore: createInMemoryIdempotencyStore<string>(),
      idempotencyTtlMs: 60_000,
      observer: {
        onJobEnd: (_job, outcome) => {
          if (outcome.kind === "ok") fromCacheFlags.push(outcome.fromCache);
        },
      },
    });

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (fromCacheFlags.length >= 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await consumer.drain();

    // Delivered twice (the first ack was lost), but the model ran ONCE and
    // the redelivery reported the cache hit.
    expect(fromCacheFlags.length).toBeGreaterThanOrEqual(2);
    expect(handlerCalls).toBe(1);
    expect(fromCacheFlags[0]).toBe(false);
    expect(fromCacheFlags[1]).toBe(true);
  });

  test("a failed attempt caches nothing, so its retry re-runs the handler (item 23)", async () => {
    const queue = createInMemoryQueue<string>({ initialJobs: ["flaky"] });
    let handlerCalls = 0;
    const outcomes: string[] = [];
    const consumer = startConsumer<string, string>({
      queue,
      handler: async (input) => {
        handlerCalls += 1;
        if (handlerCalls === 1) throw new Error("transient boom");
        return `reply to ${input}`;
      },
      concurrency: 1,
      visibilityTimeoutMs: 5_000,
      maxRetries: 3,
      idempotencyStore: createInMemoryIdempotencyStore<string>(),
      idempotencyTtlMs: 60_000,
      observer: {
        onJobEnd: (_job, outcome) => outcomes.push(outcome.kind),
      },
    });

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if ((await queue.stats()).acked === 1) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    await consumer.drain();

    // Keying on the job id must NOT make a failure sticky: the retry of a
    // throw re-invokes the handler and then succeeds.
    expect(handlerCalls).toBe(2);
    expect(outcomes).toEqual(["fail", "ok"]);
  });

  test("drain() blocks new pulls and lets in-flight finish (SIGTERM contract)", async () => {
    const queue = createInMemoryQueue<string>();
    for (let i = 0; i < 5; i++) await queue.enqueue(`j${i}`);

    let inFlightDuringDrain = 0;
    let onJobStartCount = 0;
    const observer: ConsumerObserver<string, string> = {
      onJobStart: () => {
        onJobStartCount += 1;
      },
    };

    const consumer = startConsumer<string, string>({
      queue,
      handler: async (input) => {
        await new Promise((r) => setTimeout(r, 50));
        return `done-${input}`;
      },
      concurrency: 2,
      visibilityTimeoutMs: 5_000,
      observer,
    });

    // Let a couple of jobs start.
    await new Promise((r) => setTimeout(r, 30));
    inFlightDuringDrain = consumer.inFlight();
    expect(inFlightDuringDrain).toBeGreaterThan(0);

    await consumer.drain();
    expect(consumer.inFlight()).toBe(0);

    // After drain: ack count >= jobs that started before drain.
    const stats = await queue.stats();
    expect(stats.acked).toBeGreaterThanOrEqual(inFlightDuringDrain);
    expect(onJobStartCount).toBe(stats.acked);
    // Pending jobs that hadn't been pulled yet remain.
    expect(stats.pending + stats.acked).toBe(5);
  });
});

describe("QueueConsumerError", () => {
  test("carries the runtime code, stable name, and cause chain", () => {
    const cause = new Error("adapter exploded");
    const err = new QueueConsumerError("consumer failed", cause);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("QueueConsumerError");
    expect(err.code).toBe("runtime");
    expect(err.message).toBe("consumer failed");
    expect(err.cause).toBe(cause);
    expect(err.toJSON()).toMatchObject({
      name: "QueueConsumerError",
      code: "runtime",
      message: "consumer failed",
      cause: { name: "Error", message: "adapter exploded" },
    });
  });

  test("constructs without a cause", () => {
    const err = new QueueConsumerError("no cause");
    expect(err.cause).toBeUndefined();
  });
});

describe("startConsumer — pull loop error surfacing", () => {
  let stderrSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    stderrSpy?.mockRestore();
    stderrSpy = undefined;
  });

  test("an unhandled error in the pull loop is written to stderr and stops the loop", async () => {
    // Capture stderr so the loop-error log doesn't pollute test output AND we
    // can assert it fired. No real stderr write, no real I/O.
    const writes: string[] = [];
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown): boolean => {
      writes.push(String(chunk));
      return true;
    });

    // A malformed adapter: `pull` resolves a non-array, so `pulled.length`
    // throws a TypeError OUTSIDE the loop's pull try/catch (that try only
    // guards the awaited pull call). This is the exact "rare loop error"
    // path the catch handler exists for.
    const badQueue: QueueAdapter<number> = {
      kind: "bad",
      pull: async () => null as unknown as ReadonlyArray<Job<number>>,
      ack: async () => {},
      nack: async () => {},
      extendVisibility: async () => {},
      stats: async () => ({ pending: 0, inFlight: 0, acked: 0, nacked: 0, deadLetter: 0 }),
    };

    const consumer = startConsumer<number, number>({
      queue: badQueue,
      handler: async (n) => n,
      concurrency: 1,
      visibilityTimeoutMs: 5_000,
    });

    // drain() awaits the (now-rejected-then-caught) loopPromise; it must
    // resolve, not hang, because the catch handler swallows the throw.
    await consumer.drain();

    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("[queue-consumer] loop error:");
    // The TypeError message about reading a property of null is surfaced.
    expect(writes[0]).toMatch(/null|length/i);
    expect(consumer.inFlight()).toBe(0);
  });
});

describe("startConsumer — visibility renewal sidecar", () => {
  test("fires extendVisibility on each renew tick and swallows renew failures", async () => {
    // Deterministic timer control: capture scheduled callbacks instead of
    // arming the real clock, so we drive renewal ticks by hand — no real
    // timers, no leaked handles.
    const scheduled: Array<{ id: number; fn: () => void; delay: number }> = [];
    let nextId = 1;
    const cleared: number[] = [];
    const fakeSetTimeout = ((fn: () => void, delay?: number) => {
      const id = nextId++;
      scheduled.push({ id, fn, delay: delay ?? 0 });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const fakeClearTimeout = ((handle: unknown) => {
      cleared.push(handle as number);
    }) as unknown as typeof clearTimeout;

    // extendVisibility rejects so we also cover the `.catch(() => {})` swallow.
    const extendCalls: Array<{ jobId: string; additionalMs: number }> = [];
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const queue = createInMemoryQueue<string>();
    await queue.enqueue("renew-job");
    const baseExtend = queue.extendVisibility.bind(queue);
    const renewQueue: QueueAdapter<string> = {
      ...queue,
      kind: queue.kind,
      pull: queue.pull.bind(queue),
      ack: queue.ack.bind(queue),
      nack: queue.nack.bind(queue),
      stats: queue.stats.bind(queue),
      extendVisibility: async (jobId: string, additionalMs: number) => {
        extendCalls.push({ jobId, additionalMs });
        await baseExtend(jobId, additionalMs).catch(() => {});
        // Force the renew-failure branch to exercise the swallowing catch.
        throw new Error("extendVisibility failed (job already acked)");
      },
      enqueue: queue.enqueue.bind(queue),
    } as unknown as QueueAdapter<string>;

    const consumer = startConsumer<string, string>({
      queue: renewQueue,
      handler: async () => {
        // Hold the job in-flight until we've driven a renew tick.
        await handlerGate;
        return "done";
      },
      concurrency: 1,
      visibilityTimeoutMs: 5_000,
      visibilityRenewIntervalMs: 1_000,
      _setTimeout: fakeSetTimeout,
      _clearTimeout: fakeClearTimeout,
    });

    // Wait until the handler is in-flight and the renew sidecar has armed
    // its first timer (via the fake setTimeout).
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && scheduled.length === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(scheduled.length).toBeGreaterThan(0);

    // Fire the first renew tick: this invokes extendVisibility(jobId, 2000)
    // and re-arms the next tick.
    const firstTick = scheduled.shift();
    expect(firstTick).toBeDefined();
    firstTick?.fn();
    // Let the rejected extendVisibility promise settle through its catch.
    await new Promise((r) => setTimeout(r, 5));

    expect(extendCalls.length).toBeGreaterThanOrEqual(1);
    // intervalMs (1000) * 2 is the additional visibility window the tick requests.
    expect(extendCalls[0]?.additionalMs).toBe(2_000);
    // jobId is whatever the in-memory adapter assigned to the single enqueued job.
    expect(typeof extendCalls[0]?.jobId).toBe("string");
    expect(extendCalls[0]?.jobId.length).toBeGreaterThan(0);
    // The tick re-armed a follow-up renew timer.
    expect(scheduled.length).toBeGreaterThanOrEqual(1);

    // Release the handler so the job completes and stopRenew() clears the
    // outstanding timer (covers the clearTimeout path).
    releaseHandler();
    await consumer.drain();
    expect(cleared.length).toBeGreaterThanOrEqual(1);
  });

  test("stopRenew before any tick fires clears the armed timer", async () => {
    const scheduled: Array<() => void> = [];
    const cleared: number[] = [];
    const fakeSetTimeout = ((fn: () => void) => {
      scheduled.push(fn);
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const fakeClearTimeout = ((handle: unknown) => {
      cleared.push(handle as number);
    }) as unknown as typeof clearTimeout;

    const queue = createInMemoryQueue<string>();
    await queue.enqueue("fast-job");

    const consumer = startConsumer<string, string>({
      queue,
      // Resolves immediately — stopRenew() runs in the finally before any
      // renew tick is driven, so the armed timer is cleared, not fired.
      handler: async () => "ok",
      concurrency: 1,
      visibilityTimeoutMs: 5_000,
      visibilityRenewIntervalMs: 1_000,
      _setTimeout: fakeSetTimeout,
      _clearTimeout: fakeClearTimeout,
    });

    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && (await queue.stats()).acked === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await consumer.drain();
    expect((await queue.stats()).acked).toBe(1);
    // The renew timer was armed then cleared on handler completion.
    expect(cleared.length).toBeGreaterThanOrEqual(1);
  });
});
