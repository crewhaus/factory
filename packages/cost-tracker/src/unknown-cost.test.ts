/**
 * Unknown cost is never $0: a call nothing can price is counted as unknown on
 * its run and tenant, and a declared price makes the same call known.
 */
import { describe, expect, test } from "bun:test";
import {
  type CostAccrualEvent,
  type ModelResponseEvent,
  type ProviderId,
  TraceEventBus,
} from "@crewhaus/trace-event-bus";
import {
  DEFAULT_PRICING,
  createCostTracker,
  declaredPricingKey,
  mergeDeclaredPricing,
  resolvePricing,
} from "./index";

const RUN_ID = "run_unknown_0001";

function bus(): TraceEventBus {
  return new TraceEventBus({ runId: RUN_ID, sessionId: "sess_unknown_0001" });
}

function response(
  b: TraceEventBus,
  model: string,
  provider: ProviderId,
  input = 1000,
  output = 100,
): ModelResponseEvent {
  return {
    ...b.envelope(),
    kind: "model_response",
    model,
    provider,
    stopReason: "end_turn",
    usage: { input, output },
    durationMs: 1,
  };
}

function rollUp(b: TraceEventBus, costUsdMicros: number, unpricedCalls?: number): CostAccrualEvent {
  return {
    ...b.envelope(),
    kind: "cost_accrual",
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    inputTokens: 10,
    outputTokens: 10,
    cachedReadTokens: 0,
    costUsdMicros,
    role: "subagent",
    summary: true,
    ...(unpricedCalls !== undefined ? { unpricedCalls } : {}),
  };
}

describe("a call nothing can price is unknown, not $0", () => {
  test("an unpriced response leaves the total unchanged and counts one unknown call", () => {
    const b = bus();
    const tracker = createCostTracker(b, { suppressEvents: true, tenantId: "acme" });
    b.publish(response(b, "claude-opus-4", "anthropic", 1000, 0));
    const before = tracker.getRunCost(RUN_ID).totalUsdMicros;
    b.publish(response(b, "fictional-model-99", "openai", 300, 200));
    const after = tracker.getRunCost(RUN_ID);
    expect(after.totalUsdMicros).toBe(before);
    expect(after.unpricedCalls).toBe(1);
    expect(after.unpricedTokens).toBe(500);
    expect(tracker.getTenantCost("acme").unpricedCalls).toBe(1);
    // An all-unpriced run still says so.
    const only = bus();
    const t2 = createCostTracker(only, { suppressEvents: true });
    only.publish(response(only, "fictional-model-99", "openai"));
    expect(t2.getRunCost(RUN_ID)).toEqual({
      totalUsdMicros: 0,
      byProvider: {},
      byRole: {},
      unpricedCalls: 1,
      unpricedTokens: 1100,
    });
  });

  test("a priced response gives no unpricedCalls key", () => {
    const b = bus();
    const tracker = createCostTracker(b, { suppressEvents: true });
    b.publish(response(b, "claude-opus-4", "anthropic"));
    const summary = tracker.getRunCost(RUN_ID);
    expect("unpricedCalls" in summary).toBe(false);
    expect("unpricedTokens" in summary).toBe(false);
    expect(Object.keys(summary)).toEqual(["totalUsdMicros", "byProvider", "byRole"]);
  });

  test("a role-bearing roll-up carrying unpricedCalls folds its count into the parent", () => {
    const b = bus();
    const tracker = createCostTracker(b, { suppressEvents: true });
    b.publish(rollUp(b, 7_000, 2));
    const summary = tracker.getRunCost(RUN_ID);
    expect(summary.totalUsdMicros).toBe(7_000);
    expect(summary.unpricedCalls).toBe(2);
    // A fully priced roll-up adds no unknown calls.
    const b2 = bus();
    const t2 = createCostTracker(b2, { suppressEvents: true });
    b2.publish(rollUp(b2, 7_000));
    expect("unpricedCalls" in t2.getRunCost(RUN_ID)).toBe(false);
  });

  test("a declared price makes the same call priced", () => {
    const b = bus();
    const pricing = mergeDeclaredPricing(DEFAULT_PRICING, {
      "local/fictional-model-99@http://127.0.0.1:11434/v1": { inputPer1M: 1, outputPer1M: 2 },
    });
    const tracker = createCostTracker(b, { suppressEvents: true, pricing });
    b.publish(response(b, "fictional-model-99", "openai", 1000, 100));
    const summary = tracker.getRunCost(RUN_ID);
    expect(summary.totalUsdMicros).toBe(1000 * 1 + 100 * 2);
    expect("unpricedCalls" in summary).toBe(false);
    expect(tracker.pricingMisses()).toBe(0);
  });

  test("a declared $0 is a known price, not an unknown one", () => {
    const b = bus();
    const pricing = mergeDeclaredPricing(DEFAULT_PRICING, {
      "local/qwen3-coder": { inputPer1M: 0, outputPer1M: 0 },
    });
    const tracker = createCostTracker(b, { suppressEvents: true, pricing });
    b.publish(response(b, "qwen3-coder", "openai"));
    expect(tracker.getRunCost(RUN_ID)).toEqual({
      totalUsdMicros: 0,
      byProvider: { openai: 0 },
      byRole: { primary: 0 },
    });
  });
});

/**
 * The model strings a declared price is keyed by, and the `(provider, wire
 * id)` each prices under. model-router's `parse.test.ts` carries the same
 * vectors against `parseModelString`, so the two parses cannot drift apart.
 */
const DECLARED_PRICING_VECTORS: ReadonlyArray<
  readonly [string, { readonly provider: ProviderId; readonly modelId: string } | undefined]
> = [
  ["claude-opus-4-7", { provider: "anthropic", modelId: "claude-opus-4-7" }],
  ["local/qwen3-coder@http://127.0.0.1:11434/v1", { provider: "openai", modelId: "qwen3-coder" }],
  ["local/llama3.2", { provider: "openai", modelId: "llama3.2" }],
  ["openai/gpt-5", { provider: "openai", modelId: "gpt-5" }],
  ["gemini/gemini-2.5-pro", { provider: "gemini", modelId: "gemini-2.5-pro" }],
  [
    "bedrock/us.anthropic.claude-sonnet-4-5-v1:0",
    { provider: "bedrock", modelId: "anthropic.claude-sonnet-4-5-v1:0" },
  ],
  ["bedrock/meta.llama3-70b", { provider: "bedrock", modelId: "meta.llama3-70b" }],
  ["groq/llama-3.3-70b", { provider: "openai", modelId: "llama-3.3-70b" }],
  ["azure/my-deployment", { provider: "openai", modelId: "my-deployment" }],
  ["vertex/claude-sonnet-4-5", { provider: "anthropic", modelId: "claude-sonnet-4-5" }],
  ["vertex/gemini-2.5-flash", { provider: "gemini", modelId: "gemini-2.5-flash" }],
  ["gpt-5", undefined],
  ["local/", undefined],
  ["local/m@", undefined],
  ["vertex/llama", undefined],
  // A host prefix is the host table's own key, never an inherited name.
  ["constructor/o9-preview", undefined],
  ["__proto__/o9-preview", undefined],
  ["toString/o9-preview", undefined],
  ["hasOwnProperty/o9-preview", undefined],
];

describe("declared prices", () => {
  test("declaredPricingKey splits a model string the way the router does", () => {
    for (const [modelString, expected] of DECLARED_PRICING_VECTORS) {
      expect(declaredPricingKey(modelString)).toEqual(expected);
    }
  });

  test("mergeDeclaredPricing resolves a local/…@url and a bedrock geo id", () => {
    const merged = mergeDeclaredPricing(DEFAULT_PRICING, {
      "local/qwen3-coder@http://127.0.0.1:11434/v1": { inputPer1M: 0, outputPer1M: 0 },
      "bedrock/us.anthropic.claude-sonnet-4-5-v1:0": { inputPer1M: 9, outputPer1M: 99 },
    });
    expect(resolvePricing(merged, "openai", "qwen3-coder")).toEqual({
      inputPer1M: 0,
      outputPer1M: 0,
    });
    // The geo-prefixed wire id and the bare id both find the declared row.
    for (const wire of [
      "us.anthropic.claude-sonnet-4-5-v1:0",
      "anthropic.claude-sonnet-4-5-v1:0",
    ]) {
      expect(resolvePricing(merged, "bedrock", wire)).toEqual({ inputPer1M: 9, outputPer1M: 99 });
    }
    // Pure: the installed table is untouched.
    expect(resolvePricing(DEFAULT_PRICING, "openai", "qwen3-coder")).toBeUndefined();
    expect(mergeDeclaredPricing(DEFAULT_PRICING, undefined)).toBe(DEFAULT_PRICING);
    expect(mergeDeclaredPricing(DEFAULT_PRICING, {})).toBe(DEFAULT_PRICING);
  });

  test("a declared row replaces the table's row for the same model", () => {
    const merged = mergeDeclaredPricing(DEFAULT_PRICING, {
      "claude-opus-4": { inputPer1M: 1, outputPer1M: 1 },
    });
    expect(resolvePricing(merged, "anthropic", "claude-opus-4")).toEqual({
      inputPer1M: 1,
      outputPer1M: 1,
    });
    expect(resolvePricing(DEFAULT_PRICING, "anthropic", "claude-opus-4")?.inputPer1M).toBe(15);
    // It names that model only: a longer id in the family keeps the table's price.
    expect(resolvePricing(merged, "anthropic", "claude-opus-4-1")).toEqual(
      resolvePricing(DEFAULT_PRICING, "anthropic", "claude-opus-4-1"),
    );
  });

  test("a declared price prices only the model it names, never one whose id extends it", () => {
    const merged = mergeDeclaredPricing(DEFAULT_PRICING, {
      "local/qwen3@http://127.0.0.1:11434/v1": { inputPer1M: 0, outputPer1M: 0 },
    });
    expect(resolvePricing(merged, "openai", "qwen3")).toEqual({ inputPer1M: 0, outputPer1M: 0 });
    for (const other of ["qwen3-coder", "qwen3@x", "qwen3-coder@http://127.0.0.1:11434/v1"]) {
      expect(resolvePricing(merged, "openai", other)).toBeUndefined();
    }
    // An inherited name is not a declared model.
    expect(resolvePricing(merged, "openai", "constructor")).toBeUndefined();
  });
});
