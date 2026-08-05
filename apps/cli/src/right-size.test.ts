/**
 * Item 25 — right-size candidate enumeration + $/score ranking tests.
 */
import { describe, expect, test } from "bun:test";
import type { PricingTable } from "@crewhaus/cost-tracker";
import {
  type BaselineEvalOutcome,
  type ModelSlot,
  type SlotEvalOutcome,
  buildRightSizeReport,
  enumerateSlotCandidates,
  projectCostUsd,
} from "./right-size";

const PRICING: PricingTable = {
  version: "test",
  providers: {
    anthropic: {
      "claude-opus-4": { inputPer1M: 15, outputPer1M: 75 },
      "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15 },
      "claude-haiku-4": { inputPer1M: 1, outputPer1M: 5 },
    },
    openai: {
      "gpt-5": { inputPer1M: 1.25, outputPer1M: 10 },
      "gpt-5-mini": { inputPer1M: 0.25, outputPer1M: 2 },
    },
  },
};

describe("enumerateSlotCandidates", () => {
  test("yields cheaper same-provider downshifts per slot, current excluded", () => {
    const slots: ModelSlot[] = [
      { label: "agent.model", currentModel: "claude-opus-4-7", path: ["agent", "model"] },
    ];
    const cands = enumerateSlotCandidates(slots, { pricing: PRICING });
    // Cheaper anthropic siblings of opus: haiku, sonnet (cheapest-first).
    expect(cands.map((c) => c.candidateModel)).toEqual(["claude-haiku-4", "claude-sonnet-4"]);
    expect(cands.every((c) => c.slot.label === "agent.model")).toBe(true);
  });

  test("never upshifts (a pricier sibling is excluded)", () => {
    const slots: ModelSlot[] = [
      { label: "agent.model", currentModel: "claude-haiku-4-5", path: ["agent", "model"] },
    ];
    // haiku is already cheapest anthropic — no cheaper downshift exists.
    expect(enumerateSlotCandidates(slots, { pricing: PRICING })).toEqual([]);
  });

  test("respects perSlotLimit", () => {
    const slots: ModelSlot[] = [
      { label: "agent.model", currentModel: "claude-opus-4-7", path: ["agent", "model"] },
    ];
    const cands = enumerateSlotCandidates(slots, { pricing: PRICING, perSlotLimit: 1 });
    expect(cands).toHaveLength(1);
    expect(cands[0]?.candidateModel).toBe("claude-haiku-4");
  });

  test("enumerates across multiple slots (agent + compaction)", () => {
    const slots: ModelSlot[] = [
      { label: "agent.model", currentModel: "claude-opus-4-7", path: ["agent", "model"] },
      { label: "compaction.model", currentModel: "openai/gpt-5", path: ["compaction", "model"] },
    ];
    const cands = enumerateSlotCandidates(slots, { pricing: PRICING });
    expect(
      cands.some(
        (c) => c.slot.label === "compaction.model" && c.candidateModel === "openai/gpt-5-mini",
      ),
    ).toBe(true);
  });

  test("skips a slot whose model isn't table-backed", () => {
    const slots: ModelSlot[] = [
      { label: "agent.model", currentModel: "local/llama@http://x/v1", path: ["agent", "model"] },
    ];
    expect(enumerateSlotCandidates(slots, { pricing: PRICING })).toEqual([]);
  });
});

describe("projectCostUsd", () => {
  test("projects USD from token aggregates via resolvePricing", () => {
    // opus: 1M input * 15 + 1M output * 75 = 90 USD.
    const usd = projectCostUsd("claude-opus-4-7", { input: 1_000_000, output: 1_000_000 }, PRICING);
    expect(usd).toBeCloseTo(90, 6);
  });
  test("undefined on a pricing miss", () => {
    expect(projectCostUsd("local/x@http://y/v1", { input: 1, output: 1 }, PRICING)).toBeUndefined();
  });
});

describe("buildRightSizeReport", () => {
  const baseline: BaselineEvalOutcome = {
    passRate: 0.9,
    // This block resolves against DEFAULT_PRICING (no pricing seam is passed),
    // so it needs a model whose rate is stable. `claude-opus-4` is the legacy
    // base and genuinely costs $15/$75; the current Opus line is $5/$25.
    model: "claude-opus-4",
    tokens: { input: 100_000, output: 100_000 }, // 15*0.1 + 75*0.1 = 9 USD
  };

  test("recommends a cheaper slot swap that holds pass rate", () => {
    const outcomes: SlotEvalOutcome[] = [
      {
        candidate: {
          slot: { label: "agent.model", currentModel: "claude-opus-4-7", path: ["agent", "model"] },
          candidateModel: "claude-sonnet-4",
        },
        passRate: 0.9,
        tokens: { input: 100_000, output: 100_000 }, // 3*0.1 + 15*0.1 = 1.8 USD
      },
    ];
    const report = buildRightSizeReport(baseline, outcomes, { minCostDropRatio: 0.2 });
    expect(report.baseline.costUsd).toBeCloseTo(9, 6);
    expect(report.ranked[0]?.recommended).toBe(true);
    expect(report.best?.modelString).toBe("claude-sonnet-4");
    expect(report.best?.slotPath).toEqual(["agent", "model"]);
    // ~80% cheaper.
    expect(report.best?.costDropRatio).toBeCloseTo(0.8, 2);
  });

  test("does not recommend a swap that regresses pass rate", () => {
    const outcomes: SlotEvalOutcome[] = [
      {
        candidate: {
          slot: { label: "agent.model", currentModel: "claude-opus-4-7", path: ["agent", "model"] },
          candidateModel: "claude-haiku-4",
        },
        passRate: 0.6, // dropped
        tokens: { input: 100_000, output: 100_000 },
      },
    ];
    const report = buildRightSizeReport(baseline, outcomes, {
      minCostDropRatio: 0.2,
      passRateTolerance: 0.05,
    });
    expect(report.best).toBeUndefined();
    expect(report.ranked[0]?.recommended).toBe(false);
  });

  test("ranks the biggest safe saving first", () => {
    const slot = {
      label: "agent.model",
      currentModel: "claude-opus-4-7",
      path: ["agent", "model"] as string[],
    };
    const outcomes: SlotEvalOutcome[] = [
      {
        candidate: { slot, candidateModel: "claude-sonnet-4" },
        passRate: 0.9,
        tokens: { input: 100_000, output: 100_000 },
      }, // 1.8 USD
      {
        candidate: { slot, candidateModel: "claude-haiku-4" },
        passRate: 0.9,
        tokens: { input: 100_000, output: 100_000 },
      }, // 0.6 USD
    ];
    const report = buildRightSizeReport(baseline, outcomes, { minCostDropRatio: 0.2 });
    // haiku saves more → ranked first.
    expect(report.ranked[0]?.modelString).toBe("claude-haiku-4");
    expect(report.best?.modelString).toBe("claude-haiku-4");
  });

  test("a crashed / pricing-miss candidate is dropped, not ranked", () => {
    const slot = {
      label: "agent.model",
      currentModel: "claude-opus-4-7",
      path: ["agent", "model"] as string[],
    };
    const outcomes: SlotEvalOutcome[] = [
      {
        candidate: { slot, candidateModel: "claude-sonnet-4" },
        passRate: 0,
        tokens: { input: 0, output: 0 },
        error: "all samples errored",
      },
    ];
    const report = buildRightSizeReport(baseline, outcomes, { minCostDropRatio: 0.2 });
    expect(report.ranked).toHaveLength(0);
  });
});
