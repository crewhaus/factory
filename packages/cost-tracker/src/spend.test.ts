/**
 * The spend meter: reservations before dispatch, settles on response, a
 * release only for a call that reached no provider, child meters that spend
 * from their parent live, and an injected period ledger. No timers:
 * concurrency is promise order.
 */
import { describe, expect, test } from "bun:test";
import type { PricingTable } from "./pricing";
import {
  type SpendAdmission,
  type SpendLedgerPort,
  type StreamReport,
  type UsageStreamEvent,
  actualCallMicros,
  createSpendMeter,
  estimateCallMicros,
  failedCallSpend,
  notingUsage,
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

describe("a call made inside another call's tool", () => {
  test("never waits on the enclosing call's reservation: the answer is final at the first ask", async () => {
    const meter = createSpendMeter({ capMicros: 100, pricing: FLAT });
    expect(await meter.reserve("P", 100)).toEqual({ admit: true });
    // Without the view the same reserve waits on P, which settles only after the tool returns.
    const plain = await meter.reserve("c0", 10);
    expect(plain.admit === false && plain.on).toBe("others");
    expect(await meter.within("P").reserve("c", 10)).toEqual({
      admit: false,
      on: "spent",
      scope: "run",
      inFlight: true,
    });
    expect(meter.snapshot().activeReservations).toBe(1);
  });

  test("a child of a view, and a view of a view, keep the ancestor; a view made before is fixed", async () => {
    const meter = createSpendMeter({ capMicros: 100, pricing: FLAT });
    // Made while no call is in progress: it names no ancestor, and never adopts a later one.
    const early = meter.within(undefined);
    await meter.reserve("P", 100);
    const child = meter.within("P").child({ capMicros: 1_000 });
    expect(await child.reserve("k", 10)).toEqual({
      admit: false,
      on: "spent",
      scope: "run",
      inFlight: true,
    });
    const nested = meter.within("P").within("Q");
    expect(await nested.reserve("n", 10)).toEqual({
      admit: false,
      on: "spent",
      scope: "run",
      inFlight: true,
    });
    const late = await early.reserve("e", 10);
    expect(late.admit === false && late.on).toBe("others");
  });

  test("a sibling still in progress is waited for, and the wait ends when the sibling settles", async () => {
    const meter = createSpendMeter({ capMicros: 100, seedMicros: 10, pricing: FLAT });
    await meter.reserve("P", 40);
    await meter.reserve("S", 60);
    const answer = await meter.within("P").reserve("c", 5);
    if (answer.admit || answer.on !== "others") throw new Error("expected a wait on the sibling");
    let ended = false;
    void answer.settled.then(() => {
      ended = true;
    });
    await Promise.resolve();
    expect(ended).toBe(false);
    await meter.settle("S", costing(1));
    // P never settles: the wait ended on S alone.
    await answer.settled;
    expect(ended).toBe(true);
    expect(await meter.within("P").reserve("c", 5)).toEqual({ admit: true });
  });

  test("the ancestor's id goes to the period ledger only when it was reserved there", async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const ledger: SpendLedgerPort = {
      reserve: async ({ ancestors }) => {
        seen.push(ancestors);
        return { admit: false, on: "spent", inFlight: true };
      },
      settle: async () => {},
      release: async () => {},
    };
    const meter = createSpendMeter({ capMicros: 1_000, ledger, pricing: FLAT });
    // A period refusal that counts an ancestor is final too.
    expect(await meter.within("never-reserved").reserve("c", 10)).toEqual({
      admit: false,
      on: "spent",
      scope: "period",
      inFlight: true,
    });
    expect(seen).toEqual([undefined]);
    const lines: string[] = [];
    const recording: SpendLedgerPort = {
      reserve: async ({ id, ancestors }) => {
        lines.push(`reserve ${id} ${(ancestors ?? []).join(",")}`);
        return { admit: true };
      },
      settle: async () => {},
      release: async () => {},
    };
    const tree = createSpendMeter({ capMicros: 1_000, ledger: recording, pricing: FLAT });
    await tree.reserve("P", 10);
    await tree.within("P").child().reserve("k", 10);
    expect(lines).toEqual(["reserve P ", "reserve k P"]);
  });
});

describe("a call that was sent and reported no usage", () => {
  function recordingLedger(): SpendLedgerPort & { lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      reserve: async ({ id, usdMicros }) => {
        lines.push(`reserve ${id} ${usdMicros}`);
        return { admit: true };
      },
      settle: async ({ id, usdMicros }) => {
        lines.push(`settle ${id} ${usdMicros}`);
      },
      release: async (id) => {
        lines.push(`release ${id}`);
      },
    };
  }

  test("counts its reserved worst case as spent, on the meter and the period", async () => {
    const ledger = recordingLedger();
    const meter = createSpendMeter({ capMicros: 1_000, ledger, pricing: FLAT });
    await meter.reserve("a", 70);
    expect(await meter.settleUnreported("a")).toEqual({ usdMicros: 70 });
    expect(meter.snapshot()).toMatchObject({
      spentMicros: 70,
      assumedMicros: 70,
      activeReservations: 0,
    });
    expect(ledger.lines).toEqual(["reserve a 70", "settle a 70"]);
  });

  test("an assumed worst case is told apart from priced spend, in every scope", async () => {
    const meter = createSpendMeter({ capMicros: 1_000, pricing: FLAT });
    const child = meter.child({ capMicros: 500 });
    await child.reserve("a", 40);
    await child.settleUnreported("a");
    await meter.reserve("b", 10);
    await meter.settle("b", costing(7));
    expect(child.snapshot()).toMatchObject({ spentMicros: 40, assumedMicros: 40 });
    expect(meter.snapshot()).toMatchObject({ spentMicros: 47, assumedMicros: 40 });
  });

  test("an unpriced call counts one unknown call and settles the period with null", async () => {
    const ledger = recordingLedger();
    const meter = createSpendMeter({ capMicros: 1_000, ledger, pricing: FLAT });
    await meter.reserve("u", undefined);
    expect(await meter.settleUnreported("u")).toEqual({ usdMicros: undefined });
    expect(meter.snapshot()).toMatchObject({ spentMicros: 0, unknownCalls: 1 });
    expect(ledger.lines).toEqual(["settle u null"]);
  });

  test("an id reserved through a view settles on the period through the base", async () => {
    const ledger = recordingLedger();
    const meter = createSpendMeter({ capMicros: 1_000, ledger, pricing: FLAT });
    await meter.reserve("P", 10);
    await meter.within("P").reserve("v", 20);
    await meter.release("v");
    await meter.within("P").reserve("w", 30);
    await meter.settle("w", costing(5));
    expect(ledger.lines).toEqual([
      "reserve P 10",
      "reserve v 20",
      "release v",
      "reserve w 30",
      "settle w 5",
    ]);
  });
});

describe("a call's stream, as the meter reads it", () => {
  async function drain(events: UsageStreamEvent[], throwAfter?: number): Promise<StreamReport> {
    const report: StreamReport = {};
    async function* source(): AsyncGenerator<UsageStreamEvent> {
      let n = 0;
      for (const ev of events) {
        if (throwAfter !== undefined && n === throwAfter) throw new Error("reset");
        n += 1;
        yield ev;
      }
    }
    try {
      for await (const _ of notingUsage(source(), report)) {
        // consumed
      }
    } catch {
      // the report is what the caller reads
    }
    return report;
  }

  test("final counts are noted once the closing delta arrives", async () => {
    const report = await drain([
      { kind: "message_start", usage: { input: 12, output: 1 } },
      { kind: "message_delta", stopReason: "end_turn", usage: { input: 0, output: 30 } },
      { kind: "message_stop" },
    ]);
    expect(report).toEqual({ started: true, usage: { input: 12, output: 30 } });
  });

  test("a stream that ends before its counts, or reports none, leaves usage unknown", async () => {
    // An abort that ends a stream silently: content, then nothing.
    expect(
      await drain([{ kind: "message_start", usage: { input: 12, output: 1 } }, { kind: "x" }]),
    ).toEqual({ started: true });
    // A server that reports no usage at all.
    expect(
      await drain([{ kind: "message_delta", stopReason: "end_turn" }, { kind: "message_stop" }]),
    ).toEqual({ started: true });
    expect(await drain([{ kind: "message_start" }], 0)).toEqual({});
  });
});

describe("what a failed call counts as", () => {
  const status = (n: number) => Object.assign(new Error(`HTTP ${n}`), { status: n });
  const code = (c: string) => Object.assign(new Error(c), { code: c });
  const named = (n: string) => Object.assign(new Error(n), { name: n });
  const wrapped = (cause: unknown) =>
    Object.assign(new Error("Connection error."), { name: "APIConnectionError", cause });

  test("a request that reached no provider is released", () => {
    for (const err of [
      code("ECONNREFUSED"),
      wrapped(code("ConnectionRefused")),
      wrapped(code("ENOTFOUND")),
      wrapped(code("DEPTH_ZERO_SELF_SIGNED_CERT")),
      named("ProviderAuthError"),
      named("CircuitBreakerOpenError"),
      named("FailoverExhaustedError"),
    ]) {
      expect(failedCallSpend(err, false)).toBe("release");
    }
  });

  test("a provider's outright refusal counts $0", () => {
    for (const n of [400, 401, 403, 404, 413, 429, 529]) {
      expect(failedCallSpend(status(n), false)).toBe("zero");
      expect(failedCallSpend(wrapped(status(n)), false)).toBe("zero");
    }
  });

  test("anything else, and any failure after an event arrived, counts its worst case", () => {
    for (const err of [
      status(500),
      code("ECONNRESET"),
      named("AbortError"),
      named("APIConnectionTimeoutError"),
      new Error("stream broke"),
      "a string",
    ]) {
      expect(failedCallSpend(err, false)).toBe("worst");
    }
    expect(failedCallSpend(code("ECONNREFUSED"), true)).toBe("worst");
    expect(failedCallSpend(status(429), true)).toBe("worst");
  });
});
