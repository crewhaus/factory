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
  computeCacheSavingsMicros,
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
    specModel?: string;
    provider: ProviderId;
    inputTokens: number;
    outputTokens: number;
    cacheRead?: number;
    cacheCreate?: number;
    runId?: string;
  },
): ModelResponseEvent {
  return {
    ...bus.envelope(),
    runId: opts.runId ?? bus.runId,
    kind: "model_response",
    model: opts.model,
    ...(opts.specModel !== undefined ? { specModel: opts.specModel } : {}),
    provider: opts.provider,
    stopReason: "end_turn",
    usage: {
      input: opts.inputTokens,
      output: opts.outputTokens,
      ...(opts.cacheRead !== undefined ? { cacheRead: opts.cacheRead } : {}),
      ...(opts.cacheCreate !== undefined ? { cacheCreate: opts.cacheCreate } : {}),
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

  test("computeCostMicros: cacheWritePer1M defaults to inputPer1M × 1.25", () => {
    const row = { inputPer1M: 10.0, outputPer1M: 30.0 };
    // 1000 cache_creation × ($10 × 1.25)/M = $0.0125 = 12_500 micros
    expect(computeCostMicros(row, 0, 0, 0, 1000)).toBe(12_500);
  });

  test("computeCostMicros: explicit cacheWritePer1M wins over the ×1.25 fallback", () => {
    // gpt-4o encodes OpenAI's zero-premium writes: cacheWritePer1M === inputPer1M.
    const row = resolvePricing(DEFAULT_PRICING, "openai", "gpt-4o");
    if (!row) throw new Error("gpt-4o pricing row missing");
    expect(row.cacheWritePer1M).toBe(2.5);
    // 1000 writes × $2.5/M = 2_500 micros — NOT 1000 × $3.125/M.
    expect(computeCostMicros(row, 0, 0, 0, 1000)).toBe(2_500);
  });

  test("computeCostMicros: 4-argument legacy call equals an explicit 0 cache-write count", () => {
    const row = { inputPer1M: 15.0, outputPer1M: 75.0 };
    expect(computeCostMicros(row, 1000, 500, 200)).toBe(computeCostMicros(row, 1000, 500, 200, 0));
  });

  test("computeCacheSavingsMicros: read discount minus write premium", () => {
    const row = { inputPer1M: 10.0, outputPer1M: 30.0 };
    // reads: 1000 × ($10 − $1)/M = 9_000 micros saved
    // writes: 400 × ($12.5 − $10)/M = 1_000 micros premium
    expect(computeCacheSavingsMicros(row, 1000, 400)).toBe(8_000);
  });

  test("computeCacheSavingsMicros: negative when write premiums outweigh read discounts", () => {
    const row = { inputPer1M: 10.0, outputPer1M: 30.0 };
    // no reads, 1000 writes × $2.5/M premium = −2_500 micros
    expect(computeCacheSavingsMicros(row, 0, 1000)).toBe(-2_500);
  });

  test("computeCacheSavingsMicros: explicit row prices (zero-premium writes) yield pure read savings", () => {
    const row = resolvePricing(DEFAULT_PRICING, "openai", "gpt-4o");
    if (!row) throw new Error("gpt-4o pricing row missing");
    // reads: 1000 × ($2.5 − $1.25)/M = 1_250; writes: 1000 × ($2.5 − $2.5)/M = 0
    expect(computeCacheSavingsMicros(row, 1000, 1000)).toBe(1_250);
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

  test("wire model id prices and specModel passes through to cost_accrual", () => {
    const bus = makeBus();
    const accruals: CostAccrualEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e);
    });
    const tracker = createCostTracker(bus);
    bus.publish(
      modelResponse(bus, {
        // runtime-core publishes the stripped WIRE id; the spec string
        // (provider-prefixed grammar) rides along as specModel.
        model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        specModel: "bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        provider: "bedrock",
        inputTokens: 100,
        outputTokens: 10,
      }),
    );
    expect(tracker.pricingMisses()).toBe(0);
    expect(accruals.length).toBe(1);
    expect(accruals[0]?.modelId).toBe("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
    expect(accruals[0]?.specModel).toBe("bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0");
    // anthropic.claude-sonnet-4 row: 100 × $3/M + 10 × $15/M = 450 micros
    expect(accruals[0]?.costUsdMicros).toBe(450);
  });

  test("usage.cacheCreate threads into cost_accrual.cacheCreationTokens and is priced at the write premium", () => {
    const bus = makeBus();
    const accruals: CostAccrualEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e);
    });
    const tracker = createCostTracker(bus);
    bus.publish(
      modelResponse(bus, {
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        inputTokens: 1000,
        outputTokens: 100,
        cacheRead: 4000,
        cacheCreate: 2000,
      }),
    );
    expect(accruals.length).toBe(1);
    expect(accruals[0]?.cachedReadTokens).toBe(4000);
    expect(accruals[0]?.cacheCreationTokens).toBe(2000);
    // sonnet row ($3 in / $15 out, fallback $0.3 read / $3.75 write):
    // 1000×3 + 100×15 + 4000×0.3 + 2000×3.75 = 3000+1500+1200+7500 = 13_200
    expect(accruals[0]?.costUsdMicros).toBe(13_200);
    expect(tracker.getRunCost(RUN_ID).totalUsdMicros).toBe(13_200);
  });

  test("absent usage.cacheCreate → cacheCreationTokens 0 and the pre-cache-write cost total", () => {
    const bus = makeBus();
    const accruals: CostAccrualEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e);
    });
    createCostTracker(bus);
    bus.publish(
      modelResponse(bus, {
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        inputTokens: 1000,
        outputTokens: 100,
        cacheRead: 4000,
      }),
    );
    expect(accruals[0]?.cacheCreationTokens).toBe(0);
    // Exactly the old 4-field total: 3000 + 1500 + 1200 = 5_700 micros.
    expect(accruals[0]?.costUsdMicros).toBe(5_700);
  });

  test("F1 — pricing MISS now publishes a $0 cost_accrual carrying the real tokens (unpriced)", () => {
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
        // Cache traffic on an unmapped model must not change the contract:
        // miss counter increments, nothing is charged, nothing throws — but
        // (F1) an accrual IS now published so a downstream token tally and the
        // alert-watchdog's pricing-miss detector both see the event.
        cacheRead: 100,
        cacheCreate: 50,
      }),
    );
    // Previously this published nothing; now it publishes exactly one accrual.
    expect(accruals.length).toBe(1);
    const a = accruals[0];
    expect(a?.costUsdMicros).toBe(0);
    expect(a?.unpriced).toBe(true);
    // The REAL usage rides along so the token tile survives the unpriced model.
    expect(a?.inputTokens).toBe(10);
    expect(a?.outputTokens).toBe(10);
    expect(a?.cachedReadTokens).toBe(100);
    expect(a?.cacheCreationTokens).toBe(50);
    expect(a?.modelId).toBe("fictional-model-99");
    // Miss counter still increments; a miss is not a priced "observed" call;
    // and it contributes $0 to the run total.
    expect(tracker.pricingMisses()).toBe(1);
    expect(tracker.observed()).toBe(0);
    expect(tracker.getRunCost(RUN_ID).totalUsdMicros).toBe(0);
    // This is exactly the watchdog's pricing-miss signal.
    expect(a?.costUsdMicros === 0 && (a?.inputTokens ?? 0) + (a?.outputTokens ?? 0) > 0).toBe(true);
  });

  test("F1 — suppressEvents still emits nothing on a miss, but the miss counter increments", () => {
    const bus = makeBus();
    const accruals: CostAccrualEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e);
    });
    const tracker = createCostTracker(bus, { suppressEvents: true });
    bus.publish(
      modelResponse(bus, {
        model: "fictional-model-99",
        provider: "openai",
        inputTokens: 10,
        outputTokens: 10,
      }),
    );
    expect(accruals.length).toBe(0);
    expect(tracker.pricingMisses()).toBe(1);
  });

  test("F2 — current model ids resolve to a priced row (not a miss) and never carry unpriced", () => {
    const bus = makeBus();
    const accruals: CostAccrualEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e);
    });
    const tracker = createCostTracker(bus);
    // The four current families that previously missed or resolved stale.
    const current: ReadonlyArray<{ model: string; input: number; output: number; micros: number }> =
      [
        // opus-4-8 @ $5/$25: 1000×5 + 500×25 = 17_500
        { model: "claude-opus-4-8", input: 1000, output: 500, micros: 17_500 },
        // sonnet-5 @ $3/$15: 1000×3 + 500×15 = 10_500
        { model: "claude-sonnet-5", input: 1000, output: 500, micros: 10_500 },
        // haiku-4-5 @ $1/$5: 1000×1 + 500×5 = 3_500
        { model: "claude-haiku-4-5", input: 1000, output: 500, micros: 3_500 },
        // fable-5 @ $10/$50: 1000×10 + 500×50 = 35_000
        { model: "claude-fable-5", input: 1000, output: 500, micros: 35_000 },
      ];
    for (const c of current) {
      const row = resolvePricing(DEFAULT_PRICING, "anthropic", c.model);
      expect(row).toBeDefined();
      bus.publish(
        modelResponse(bus, {
          model: c.model,
          provider: "anthropic",
          inputTokens: c.input,
          outputTokens: c.output,
        }),
      );
    }
    expect(tracker.pricingMisses()).toBe(0);
    expect(tracker.observed()).toBe(current.length);
    expect(accruals.length).toBe(current.length);
    for (let i = 0; i < current.length; i++) {
      expect(accruals[i]?.costUsdMicros).toBe(current[i]?.micros);
      // Priced accruals never carry the unpriced flag.
      expect(accruals[i]?.unpriced).toBeUndefined();
    }
  });

  test("F2 — bare-family fallbacks catch a hypothetical next-major id at the current rate", () => {
    // No claude-opus-5-x row exists; the `claude-opus` fallback ($5/$25)
    // resolves it instead of missing.
    const row = resolvePricing(DEFAULT_PRICING, "anthropic", "claude-opus-5-0");
    expect(row?.inputPer1M).toBe(5.0);
    expect(row?.outputPer1M).toBe(25.0);
    // Longest-prefix still wins for today's ids: opus-4-8 keeps its own row.
    expect(resolvePricing(DEFAULT_PRICING, "anthropic", "claude-opus-4-8")?.inputPer1M).toBe(5.0);
  });

  test("F1 regression — a stable-priced model still accrues byte-identically (no unpriced key)", () => {
    const bus = makeBus();
    const accruals: CostAccrualEvent[] = [];
    bus.subscribe((e) => {
      if (e.kind === "cost_accrual") accruals.push(e);
    });
    const tracker = createCostTracker(bus);
    // haiku-4-5 price is unchanged by F2 ($1/$5): 1000×1 + 100×5 + cache.
    bus.publish(
      modelResponse(bus, {
        model: "claude-haiku-4-5",
        provider: "anthropic",
        inputTokens: 1000,
        outputTokens: 100,
        cacheRead: 4000,
        cacheCreate: 2000,
      }),
    );
    const a = accruals[0];
    // 1000×1 + 100×5 + 4000×0.1 + 2000×1.25 = 1000+500+400+2500 = 4_400
    expect(a?.costUsdMicros).toBe(4_400);
    expect(a?.cachedReadTokens).toBe(4000);
    expect(a?.cacheCreationTokens).toBe(2000);
    expect(a?.unpriced).toBeUndefined();
    expect("unpriced" in (a ?? {})).toBe(false);
    expect(tracker.observed()).toBe(1);
    expect(tracker.pricingMisses()).toBe(0);
    expect(tracker.getRunCost(RUN_ID).totalUsdMicros).toBe(4_400);
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
