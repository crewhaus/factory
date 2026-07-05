import { describe, expect, test } from "bun:test";
import { mapWithConcurrency } from "./index";

// Deferred promise so a test can control exactly when each unit of work
// resolves and thereby assert the peak in-flight count.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("mapWithConcurrency", () => {
  test("preserves input order in results", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  test("passes the index to fn", async () => {
    const out = await mapWithConcurrency(["a", "b", "c"], 3, async (item, i) => `${item}${i}`);
    expect(out).toEqual(["a0", "b1", "c2"]);
  });

  test("never runs more than `limit` at once", async () => {
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    let inFlight = 0;
    let peak = 0;
    const run = mapWithConcurrency(gates, 2, async (g) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await g.promise;
      inFlight -= 1;
      return true;
    });
    // Let the pool saturate, then drain one at a time.
    await Promise.resolve();
    expect(inFlight).toBe(2);
    for (const g of gates) {
      g.resolve();
      await Promise.resolve();
    }
    await run;
    expect(peak).toBe(2);
  });

  test("a limit larger than the batch runs everything at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 10, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });

  test("limit <= 0 is clamped to serial (1 at a time)", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });

  test("empty input resolves to an empty array without invoking fn", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async () => {
      calls += 1;
      return calls;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});
