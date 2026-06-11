/**
 * Section 27 — `cost-tracker` tests:
 *  - T1: pricing-table format + accumulation math
 *  - T9: associative-aggregation property test (10k events)
 *  - T3: integration with TraceEventBus — 3-turn conversation emits 3 cost_accrual events
 */
import { describe, expect, test } from "bun:test";
import {
  type CostAccrualEvent,
  type ModelResponseEvent,
  type ProviderId,
  type TraceEvent,
  TraceEventBus,
} from "@crewhaus/trace-event-bus";
import {
  DEFAULT_PRICING,
  computeCostMicros,
  createCostTracker,
  formatUsdMicros,
  resolvePricing,
} from "./index";

const RUN_ID = "run_test_0001";
const SESSION_ID = "sess_test_0001";

function makeBus() {
  return new TraceEventBus({ runId: RUN_ID, sessionId: SESSION_ID });
}

function modelResponse(
  bus: TraceEventBus,
  opts: {
    model: string;
    provider: ProviderId;
    inputTokens: number;
    outputTokens: number;
    cacheRead?: number;
    runId?: string;
  },
): ModelResponseEvent {
  return {
    ...bus.envelope(),
    runId: opts.runId ?? bus.runId,
    kind: "model_response",
    model: opts.model,
    provider: opts.provider,
    stopReason: "end_turn",
    usage: {
      input: opts.inputTokens,
      output: opts.outputTokens,
      ...(opts.cacheRead !== undefined ? { cacheRead: opts.cacheRead } : {}),
    },
    durationMs: 100,
  };
}

describe("cost-tracker — T1 pricing table", () => {
  test("resolvePricing matches family-base prefix for versioned model id", () => {
    const row = resolvePricing(DEFAULT_PRICING, "anthropic", "claude-opus-4-7");
    expect(row?.inputPer1M).toBe(15.0);
    expect(row?.outputPer1M).toBe(75.0);
  });

  test("resolvePricing uses longest matching prefix for nested model families", () => {
    const opus = resolvePricing(DEFAULT_PRICING, "anthropic", "claude-opus-4-7-extended");
    expect(opus?.inputPer1M).toBe(15.0);
    const sonnet = resolvePricing(DEFAULT_PRICING, "anthropic", "claude-sonnet-4-5");
    expect(sonnet?.inputPer1M).toBe(3.0);
  });

  test("resolvePricing returns undefined for unknown provider", () => {
    expect(resolvePricing(DEFAULT_PRICING, "openai", "gpt-not-a-real-model")).toBeUndefined();
  });

  test("resolvePricing strips Bedrock cross-region inference-profile prefixes", () => {
    // us.anthropic.* profiles route to the same model as anthropic.* —
    // pricing rows are keyed on the bare id.
    const us = resolvePricing(
      DEFAULT_PRICING,
      "bedrock",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
    expect(us?.inputPer1M).toBe(3.0);
    const eu = resolvePricing(DEFAULT_PRICING, "bedrock", "eu.meta.llama3-1-8b-instruct-v1:0");
    expect(eu?.inputPer1M).toBe(0.22);
    // The strip is bedrock-only: an openai id starting with "us." stays put.
    expect(resolvePricing(DEFAULT_PRICING, "openai", "us.gpt-4o")).toBeUndefined();
  });

  test("resolvePricing returns undefined (does not throw) for a known provider with an unmapped model id", () => {
    // Contract: a known provider but no matching model prefix is a pricing
    // *miss* (returns undefined), never a throw — an unmapped model id must
    // not crash an in-flight run. Locks the doc comment to actual behavior.
    let result: ReturnType<typeof resolvePricing> | "threw";
    try {
      result = resolvePricing(DEFAULT_PRICING, "anthropic", "totally-unmapped-model-xyz");
    } catch {
      result = "threw";
    }
    expect(result).toBeUndefined();
  });

  test("computeCostMicros: integer-rounded sum of input + output costs", () => {
    const row = { inputPer1M: 15.0, outputPer1M: 75.0 };
    // 1000 input × $15/M = $0.015 = 15_000 micros
    // 500 output × $75/M = $0.0375 = 37_500 micros
    // total = 52_500 micros
    expect(computeCostMicros(row, 1000, 500, 0)).toBe(52_500);
  });

  test("computeCostMicros: cachedReadPer1M defaults to inputPer1M × 0.1", () => {
    const row = { inputPer1M: 10.0, outputPer1M: 30.0 };
    // 1000 cache_read × ($10 × 0.1)/M = $0.001 = 1_000 micros
    expect(computeCostMicros(row, 0, 0, 1000)).toBe(1_000);
  });

  test("formatUsdMicros: 4-decimal USD string", () => {
    expect(formatUsdMicros(52_500)).toBe("$0.0525");
    expect(formatUsdMicros(1_234_567)).toBe("$1.2346");
    expect(formatUsdMicros(0)).toBe("$0.0000");
  });
});

describe("cost-tracker — T3 trace bus integration", () => {
  test("subscribes to model_response and emits cost_accrual; getRunCost aggregates", () => {
    const bus = makeBus();
    const accruals: CostAccrualEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e);
    });
    const tracker = createCostTracker(bus);
    bus.publish(
      modelResponse(bus, {
        model: "claude-opus-4-7",
        provider: "anthropic",
        inputTokens: 1000,
        outputTokens: 500,
      }),
    );
    bus.publish(
      modelResponse(bus, {
        model: "claude-opus-4-7",
        provider: "anthropic",
        inputTokens: 200,
        outputTokens: 100,
      }),
    );
    bus.publish(
      modelResponse(bus, {
        model: "claude-opus-4-7",
        provider: "anthropic",
        inputTokens: 50,
        outputTokens: 25,
      }),
    );
    expect(accruals.length).toBe(3);
    expect(tracker.observed()).toBe(3);
    const summary = tracker.getRunCost(RUN_ID);
    // sums to (1250 input × 15 + 625 output × 75) = 18_750 + 46_875 = 65_625
    expect(summary.totalUsdMicros).toBe(65_625);
    expect(summary.byProvider.anthropic).toBe(65_625);
  });

  test("missing pricing → no accrual event, pricingMisses counter increments", () => {
    const bus = makeBus();
    const accruals: CostAccrualEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e);
    });
    const tracker = createCostTracker(bus);
    bus.publish(
      modelResponse(bus, {
        model: "fictional-model-99",
        provider: "openai",
        inputTokens: 10,
        outputTokens: 10,
      }),
    );
    expect(accruals.length).toBe(0);
    expect(tracker.observed()).toBe(0);
    expect(tracker.pricingMisses()).toBe(1);
  });

  test("tenantId stamps cost_accrual events and per-tenant aggregation", () => {
    const bus = makeBus();
    const tracker = createCostTracker(bus, { tenantId: "tenant-alpha" });
    bus.publish(
      modelResponse(bus, {
        model: "claude-opus-4-7",
        provider: "anthropic",
        inputTokens: 1000,
        outputTokens: 1000,
      }),
    );
    expect(tracker.getTenantCost("tenant-alpha").totalUsdMicros).toBe(15_000 + 75_000);
    expect(tracker.getTenantCost("tenant-beta").totalUsdMicros).toBe(0);
  });

  test("provider defaults to anthropic when missing on the event", () => {
    const bus = makeBus();
    const tracker = createCostTracker(bus);
    const evt: ModelResponseEvent = {
      ...bus.envelope(),
      runId: bus.runId,
      kind: "model_response",
      model: "claude-opus-4-7",
      stopReason: "end_turn",
      usage: { input: 100, output: 100 },
      durationMs: 50,
    };
    bus.publish(evt);
    const summary = tracker.getRunCost(RUN_ID);
    expect(summary.byProvider.anthropic).toBe(1500 + 7500);
  });

  test("unsubscribe stops further accrual", () => {
    const bus = makeBus();
    const tracker = createCostTracker(bus);
    bus.publish(
      modelResponse(bus, {
        model: "claude-opus-4-7",
        provider: "anthropic",
        inputTokens: 100,
        outputTokens: 100,
      }),
    );
    expect(tracker.observed()).toBe(1);
    tracker.unsubscribe();
    bus.publish(
      modelResponse(bus, {
        model: "claude-opus-4-7",
        provider: "anthropic",
        inputTokens: 100,
        outputTokens: 100,
      }),
    );
    expect(tracker.observed()).toBe(1);
  });

  test("suppressEvents: aggregation continues but no cost_accrual published", () => {
    const bus = makeBus();
    const accruals: TraceEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e);
    });
    const tracker = createCostTracker(bus, { suppressEvents: true });
    bus.publish(
      modelResponse(bus, {
        model: "claude-opus-4-7",
        provider: "anthropic",
        inputTokens: 100,
        outputTokens: 100,
      }),
    );
    expect(tracker.observed()).toBe(1);
    expect(accruals.length).toBe(0);
    expect(tracker.getRunCost(RUN_ID).totalUsdMicros).toBeGreaterThan(0);
  });
});

describe("cost-tracker — T9 associative aggregation property", () => {
  test("10k random model_response events yield identical total regardless of subscriber order", () => {
    // Two trackers wired to the same bus must produce identical sums.
    const bus = makeBus();
    const trackerA = createCostTracker(bus, { suppressEvents: true });
    const trackerB = createCostTracker(bus, { suppressEvents: true });

    const providers: ReadonlyArray<ProviderId> = ["anthropic", "openai", "gemini", "bedrock"];
    const models: ReadonlyArray<{ provider: ProviderId; modelId: string }> = [
      { provider: "anthropic", modelId: "claude-opus-4-7" },
      { provider: "anthropic", modelId: "claude-sonnet-4-6" },
      { provider: "openai", modelId: "gpt-4o" },
      { provider: "openai", modelId: "gpt-4.1-mini" },
      { provider: "gemini", modelId: "gemini-2.5-flash" },
      { provider: "bedrock", modelId: "meta.llama3-1-70b" },
    ];

    let rngState = 0x12345678;
    const rand = (): number => {
      // xorshift32 → deterministic across runs
      rngState ^= rngState << 13;
      rngState ^= rngState >>> 17;
      rngState ^= rngState << 5;
      return Math.abs(rngState) / 0x7fffffff;
    };

    let expected = 0;
    for (let i = 0; i < 10_000; i++) {
      const m = models[Math.floor(rand() * models.length)];
      if (!m) throw new Error("unreachable");
      const inputTokens = Math.floor(rand() * 5000);
      const outputTokens = Math.floor(rand() * 2000);
      const cacheRead = Math.floor(rand() * 500);
      const row = resolvePricing(DEFAULT_PRICING, m.provider, m.modelId);
      if (!row) throw new Error(`unexpected pricing miss for ${m.provider}/${m.modelId}`);
      expected += computeCostMicros(row, inputTokens, outputTokens, cacheRead);
      bus.publish(
        modelResponse(bus, {
          model: m.modelId,
          provider: m.provider,
          inputTokens,
          outputTokens,
          cacheRead,
        }),
      );
      // sanity: providers list reachable
      void providers;
    }

    const a = trackerA.getRunCost(RUN_ID);
    const b = trackerB.getRunCost(RUN_ID);
    expect(a.totalUsdMicros).toBe(expected);
    expect(b.totalUsdMicros).toBe(expected);
    // associativity: sum-of-providers === total
    const sumA = Object.values(a.byProvider).reduce((acc, v) => acc + (v ?? 0), 0);
    expect(sumA).toBe(a.totalUsdMicros);
  });
});
