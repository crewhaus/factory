/**
 * The spend meter: reservations before dispatch, settles on response,
 * releases on failure, child meters that spend from their parent live, and an
 * injected period ledger. No timers: concurrency is promise order.
 */
import { describe, expect, test } from "bun:test";
import type { PricingTable } from "./pricing";
import {
  type SpendAdmission,
  type SpendLedgerPort,
  actualCallMicros,
  createSpendMeter,
  estimateCallMicros,
} from "./spend";

/** $1 per million tokens on both axes: one token is one micro. */
const FLAT: PricingTable = {
  version: "test",
  providers: { anthropic: { "claude-test": { inputPer1M: 1, outputPer1M: 1 } } },
};

/** A usage that costs exactly `micros` on {@link FLAT}. */
const costing = (micros: number) =>
  ({ provider: "anthropic", modelId: "claude-test", input: micros, output: 0 }) as const;

/** A tiny deterministic generator, so the property test is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("admission", () => {
  test("spent + others < cap admits; equality refuses", async () => {
    const meter = createSpendMeter({ capMicros: 100, pricing: FLAT });
    expect(await meter.reserve("a", 10)).toEqual({ admit: true });
    await meter.settle("a", costing(99));
    expect(await meter.reserve("b", 10)).toEqual({ admit: true });
    await meter.settle("b", costing(1));
    // spent == cap: refused on spend alone.
    expect(await meter.reserve("c", 10)).toEqual({ admit: false, on: "spent", scope: "run" });
  });

  test("a call's own estimate is not added: one call at a time decides as a spent-so-far check does", async () => {
    // Property: over random cost sequences, a one-call-at-a-time run's
    // decisions equal `spent >= cap → stop` (the per-call cap check).
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed);
      const cap = 1 + Math.floor(next() * 500);
      const meter = createSpendMeter({ capMicros: cap, pricing: FLAT });
      let spent = 0;
      let decisions = 0;
      for (let i = 0; i < 40; i++) {
        const estimate = Math.floor(next() * 300);
        const expected = spent < cap;
        const got = await meter.reserve(`c${i}`, estimate);
        expect(got.admit).toBe(expected);
        decisions += 1;
        if (!got.admit) break;
        const cost = Math.floor(next() * 120);
        await meter.settle(`c${i}`, costing(cost));
        spent += cost;
      }
      expect(decisions).toBeGreaterThan(0);
    }
  });

  test("an unknown estimate reserves nothing and always admits; an unknown settle counts, spends nothing", async () => {
    const meter = createSpendMeter({ capMicros: 10, pricing: FLAT });
    await meter.reserve("a", 5);
    await meter.settle("a", costing(10));
    expect(await meter.reserve("b", undefined)).toEqual({ admit: true });
    expect(meter.snapshot().reservedMicros).toBe(0);
    const settled = await meter.settle("b", {
      provider: "openai",
      modelId: "no-price",
      input: 9,
      output: 9,
    });
    expect(settled).toEqual({ usdMicros: undefined });
    expect(meter.snapshot()).toMatchObject({ spentMicros: 10, unknownCalls: 1 });
  });

  test("release drops the reservation and spends nothing", async () => {
    const meter = createSpendMeter({ capMicros: 100, pricing: FLAT });
    await meter.reserve("a", 100);
    expect(meter.snapshot()).toMatchObject({ reservedMicros: 100, activeReservations: 1 });
    await meter.release("a");
    expect(meter.snapshot()).toMatchObject({
      reservedMicros: 0,
      activeReservations: 0,
      spentMicros: 0,
    });
  });

  test("a seeded meter starts from the resumed spend", async () => {
    const meter = createSpendMeter({ capMicros: 100, seedMicros: 100, pricing: FLAT });
    expect(await meter.reserve("a", 1)).toEqual({ admit: false, on: "spent", scope: "run" });
  });
});

describe("concurrency", () => {
  test("two concurrent reservations a cap fits one of: one admitted, the other after the first settles", async () => {
    const meter = createSpendMeter({ capMicros: 100, pricing: FLAT });
    const first = await meter.reserve("a", 100);
    const second = await meter.reserve("b", 100);
    expect(first).toEqual({ admit: true });
    expect(second.admit).toBe(false);
    if (second.admit || second.on !== "others") throw new Error("expected a wait on others");
    const order: string[] = [];
    const woke = second.settled.then(() => order.push("woke"));
    order.push("settling");
    await meter.settle("a", costing(30));
    await woke;
    expect(order).toEqual(["settling", "woke"]);
    expect(await meter.reserve("b", 100)).toEqual({ admit: true });
  });

  test("N concurrent reservations never end above the cap plus the largest single call", async () => {
    for (let seed = 1; seed <= 100; seed++) {
      const next = rng(seed);
      const cap = 50 + Math.floor(next() * 400);
      const meter = createSpendMeter({ capMicros: cap, pricing: FLAT });
      const costs = Array.from({ length: 12 }, () => 1 + Math.floor(next() * 100));
      let largest = 0;
      const pending = new Map<string, number>();
      // Every call reserves its true cost as its worst case, all before any settles.
      for (const [i, cost] of costs.entries()) {
        const answer = await meter.reserve(`c${i}`, cost);
        if (answer.admit) pending.set(`c${i}`, cost);
      }
      for (const [id, cost] of pending) {
        largest = Math.max(largest, cost);
        await meter.settle(id, costing(cost));
      }
      expect(meter.snapshot().spentMicros).toBeLessThanOrEqual(cap + largest);
      expect(pending.size).toBeGreaterThan(0);
    }
  });
});

describe("sub-agents spend from the parent's meter", () => {
  test("a child's settle is on the parent before the child returns", async () => {
    const parent = createSpendMeter({ capMicros: 1000, pricing: FLAT });
    const child = parent.child();
    await child.reserve("k1", 50);
    // The child's reservation counts against the parent's cap at once.
    expect(parent.snapshot().reservedMicros).toBe(50);
    await child.settle("k1", costing(40));
    expect(parent.snapshot()).toMatchObject({ spentMicros: 40, reservedMicros: 0 });
    expect(child.snapshot().spentMicros).toBe(40);
  });

  test("a nested share cap refuses inside the parent's headroom", async () => {
    const parent = createSpendMeter({ capMicros: 1000, pricing: FLAT });
    const child = parent.child({ capMicros: 100 });
    await child.reserve("k1", 10);
    await child.settle("k1", costing(100));
    expect(await child.reserve("k2", 10)).toEqual({ admit: false, on: "spent", scope: "share" });
    // The parent still has headroom, and its own calls go on.
    expect(await parent.reserve("p1", 10)).toEqual({ admit: true });
    // A parent at its cap refuses the child too.
    const tight = createSpendMeter({ capMicros: 50, pricing: FLAT });
    const kid = tight.child({ capMicros: 500 });
    await tight.reserve("p", 50);
    await tight.settle("p", costing(50));
    expect(await kid.reserve("k", 1)).toEqual({ admit: false, on: "spent", scope: "run" });
  });
});

describe("the period ledger port", () => {
  function fakeLedger(answer: () => SpendAdmission): SpendLedgerPort & { lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      reserve: async ({ id, usdMicros }) => {
        lines.push(`reserve ${id} ${usdMicros}`);
        return answer();
      },
      settle: async ({ id, usdMicros }) => {
        lines.push(`settle ${id} ${usdMicros}`);
      },
      release: async (id) => {
        lines.push(`release ${id}`);
      },
    };
  }

  test("admitted calls reserve, settle and release on the ledger; unknown cost settles as null", async () => {
    const ledger = fakeLedger(() => ({ admit: true }));
    const meter = createSpendMeter({ capMicros: 1000, ledger, pricing: FLAT });
    await meter.reserve("a", 20);
    await meter.settle("a", costing(15));
    await meter.reserve("b", 20);
    await meter.release("b");
    await meter.reserve("c", undefined);
    await meter.settle("c", { provider: "openai", modelId: "no-price", input: 1, output: 1 });
    expect(ledger.lines).toEqual([
      "reserve a 20",
      "settle a 15",
      "reserve b 20",
      "release b",
      "settle c null",
    ]);
  });

  test("a period refusal is the meter's answer, and holds nothing in-process", async () => {
    const ledger = fakeLedger(() => ({ admit: false, on: "spent" }));
    const meter = createSpendMeter({ capMicros: 1000, ledger, pricing: FLAT });
    expect(await meter.reserve("a", 20)).toEqual({ admit: false, on: "spent", scope: "period" });
    expect(meter.snapshot().activeReservations).toBe(0);
    // A release after a refusal writes nothing.
    await meter.release("a");
    expect(ledger.lines).toEqual(["reserve a 20"]);
  });
});

describe("worst-case estimates", () => {
  test("input chars ÷ 4 at the input rate plus max_tokens at the output rate; undefined when unpriced", () => {
    expect(estimateCallMicros(396, 4, 50, "anthropic", "claude-test", FLAT)).toBe(100 + 50);
    expect(estimateCallMicros(400, 0, 50, "openai", "no-price", FLAT)).toBeUndefined();
    expect(actualCallMicros({ input: 3, output: 4 }, "anthropic", "claude-test", FLAT)).toBe(7);
    expect(actualCallMicros({ input: 3, output: 4 }, "openai", "no-price", FLAT)).toBeUndefined();
  });
});
