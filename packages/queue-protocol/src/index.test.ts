import { describe, expect, test } from "bun:test";
import { QueueProtocolError, createInMemoryQueue } from "./index.js";

describe("createInMemoryQueue", () => {
  test("enqueue + pull returns jobs in FIFO order with attempt=1", async () => {
    const q = createInMemoryQueue<string>();
    await q.enqueue("a");
    await q.enqueue("b");
    await q.enqueue("c");
    const got = await q.pull({ maxBatch: 10, visibilityTimeoutMs: 1000 });
    expect(got.map((j) => j.input)).toEqual(["a", "b", "c"]);
    expect(got.map((j) => j.attempt)).toEqual([1, 1, 1]);
  });

  test("pull respects maxBatch", async () => {
    const q = createInMemoryQueue<number>();
    for (let i = 0; i < 5; i++) await q.enqueue(i);
    const first = await q.pull({ maxBatch: 2, visibilityTimeoutMs: 1000 });
    expect(first.map((j) => j.input)).toEqual([0, 1]);
  });

  test("pulled jobs are invisible to subsequent pulls until visibility expires", async () => {
    let t = 1_000;
    const q = createInMemoryQueue<string>({ now: () => t });
    await q.enqueue("a");
    const first = await q.pull({ maxBatch: 10, visibilityTimeoutMs: 100 });
    expect(first).toHaveLength(1);
    // Within visibility window — invisible.
    t = 1_050;
    const second = await q.pull({ maxBatch: 10, visibilityTimeoutMs: 100 });
    expect(second).toHaveLength(0);
    // Past visibility window — reclaimed back to pending.
    t = 1_200;
    const third = await q.pull({ maxBatch: 10, visibilityTimeoutMs: 100 });
    expect(third).toHaveLength(1);
    expect(third[0]?.attempt).toBe(2);
  });

  test("ack removes the job; double-ack is a no-op", async () => {
    const q = createInMemoryQueue<string>();
    await q.enqueue("a");
    const [j] = await q.pull({ maxBatch: 1, visibilityTimeoutMs: 1000 });
    if (!j) throw new Error("no job");
    await q.ack(j.id);
    await q.ack(j.id); // idempotent
    const stats = await q.stats();
    expect(stats.acked).toBe(1);
    expect(stats.pending).toBe(0);
    expect(stats.inFlight).toBe(0);
  });

  test("nack transient returns the job to pending; nack permanent moves to DLQ", async () => {
    const q = createInMemoryQueue<string>();
    await q.enqueue("a");
    await q.enqueue("b");
    const pulled = await q.pull({ maxBatch: 10, visibilityTimeoutMs: 1000 });
    if (pulled.length !== 2) throw new Error("expected 2");
    await q.nack(pulled[0]?.id, "transient");
    await q.nack(pulled[1]?.id, "permanent");

    const stats = await q.stats();
    expect(stats.deadLetter).toBe(1);
    expect(stats.pending).toBe(1);

    const again = await q.pull({ maxBatch: 10, visibilityTimeoutMs: 1000 });
    expect(again).toHaveLength(1);
    expect(again[0]?.attempt).toBe(2);
  });

  test("extendVisibility pushes the lease forward and silences a timeout reclaim", async () => {
    let t = 1_000;
    const q = createInMemoryQueue<string>({ now: () => t });
    await q.enqueue("a");
    const [j] = await q.pull({ maxBatch: 1, visibilityTimeoutMs: 100 });
    if (!j) throw new Error("no job");
    await q.extendVisibility(j.id, 1_000);
    t = 1_500;
    const second = await q.pull({ maxBatch: 10, visibilityTimeoutMs: 100 });
    expect(second).toHaveLength(0);
  });

  test("extendVisibility throws on unknown jobId", async () => {
    const q = createInMemoryQueue<string>();
    await expect(q.extendVisibility("nonexistent", 100)).rejects.toThrow(QueueProtocolError);
  });

  test("inspect returns jobs with attempt counts (T9 invariant for retry counting)", async () => {
    const q = createInMemoryQueue<string>();
    await q.enqueue("x");
    const [j1] = await q.pull({ maxBatch: 1, visibilityTimeoutMs: 100 });
    if (!j1) throw new Error("no job");
    await q.nack(j1.id, "transient");
    const [j2] = await q.pull({ maxBatch: 1, visibilityTimeoutMs: 100 });
    if (!j2) throw new Error("no job");
    expect(j2.attempt).toBe(2);
    const insp = q.inspect();
    expect(insp[0]?.attempts).toBe(2);
  });
});
