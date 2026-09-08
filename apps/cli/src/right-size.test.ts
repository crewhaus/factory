/**
 * Item 25 — right-size candidate enumeration + $/score ranking tests.
 */
import { describe, expect, test } from "bun:test";
import { lower } from "@crewhaus/compiler";
import type { PricingTable } from "@crewhaus/cost-tracker";
import { parseSpec } from "@crewhaus/spec";
import { enumerateModelSlots } from "./model-slots";
import {
  type BaselineEvalOutcome,
  type ModelSlot,
  type SlotEvalOutcome,
  buildRightSizeReport,
  enumerateSlotCandidates,
  patchIrModelSlot,
  projectCostUsd,
  rightSizeSlots,
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

// ---------------------------------------------------------------------------
// 0.6.0 §8.2 / §9.1 — the slot set and the patcher have to AGREE.
//
// `model right-size` reads its slots from `enumerateModelSlots` and evals
// `patchIrModelSlot(ir, slot, candidate)`. When the two drift apart the
// failure is silent and WORSE than a no-op: the candidate run is the
// unchanged baseline, so its pass rate and tokens equal the baseline's — and
// the report prices those baseline tokens at the candidate's cheaper rate, so
// the unmeasured candidate scores "identical quality, large cost drop" and is
// ranked as the recommended downshift that `--write` then applies.
// ---------------------------------------------------------------------------

const SUB_AGENT_SPEC = `
name: patcher
target: cli
agent:
  model: claude-opus-5
  instructions: hi
  sub_agents:
    helper: { description: helps, instructions: help, model: claude-opus-5 }
compaction:
  model: claude-opus-5
evaluation:
  grader: { type: llm_judge, criteria: good?, model: claude-opus-5 }
  threshold: 0.7
`;

function cliIrOf(yaml: string) {
  const ir = lower(parseSpec(yaml));
  if (ir.target !== "cli") throw new Error("expected a cli spec");
  return ir;
}

describe("rightSizeSlots", () => {
  test("searches the serving slots and nothing else", () => {
    const slots = rightSizeSlots(enumerateModelSlots(cliIrOf(SUB_AGENT_SPEC)));
    expect(slots.map((s) => s.label).sort()).toEqual([
      "agent.model",
      "compaction.model",
      "sub_agents.helper.model",
    ]);
  });

  test("the judge is never searched — the objective does not measure it", () => {
    const labels = rightSizeSlots(enumerateModelSlots(cliIrOf(SUB_AGENT_SPEC))).map((s) => s.label);
    expect(labels).not.toContain("evaluation.grader.model");
  });

  test("a sub-agent slot searches, but carries no patch path (the apply is manual)", () => {
    const sub = rightSizeSlots(enumerateModelSlots(cliIrOf(SUB_AGENT_SPEC))).find(
      (s) => s.label === "sub_agents.helper.model",
    );
    expect(sub?.currentModel).toBe("claude-opus-5");
    expect(sub?.path).toBeUndefined();
  });
});

describe("patchIrModelSlot", () => {
  test("the candidate IR DIFFERS from the baseline for every slot right-size enumerates", () => {
    const ir = cliIrOf(SUB_AGENT_SPEC);
    const slots = rightSizeSlots(enumerateModelSlots(ir));
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const patched = patchIrModelSlot(ir, slot, "claude-haiku-4-5");
      expect(JSON.stringify(patched)).not.toBe(JSON.stringify(ir));
      // and the swap landed in THAT slot, not somewhere else.
      const after = enumerateModelSlots(patched).find((s) => s.label === slot.label);
      expect(after?.model).toBe("claude-haiku-4-5");
    }
  });

  test("patches the sub-agent the walk NAMES (`sub_agents.<name>.model`)", () => {
    const ir = cliIrOf(SUB_AGENT_SPEC);
    const patched = patchIrModelSlot(
      ir,
      { label: "sub_agents.helper.model", currentModel: "claude-opus-5" },
      "claude-haiku-4-5",
    );
    expect(patched.subAgents[0]?.model).toBe("claude-haiku-4-5");
    expect(patched.agent.model).toBe("claude-opus-5");
  });

  test("THROWS on a slot it cannot address — an unpatched candidate must never be ranked", () => {
    const ir = cliIrOf(SUB_AGENT_SPEC);
    expect(() =>
      patchIrModelSlot(
        ir,
        {
          label: "evaluation.grader.model",
          currentModel: "claude-opus-5",
          path: ["evaluation", "grader", "model"],
        },
        "claude-haiku-4-5",
      ),
    ).toThrow(/cannot patch slot/);
    expect(() =>
      patchIrModelSlot(
        ir,
        { label: "sub_agents.ghost.model", currentModel: "claude-opus-5" },
        "claude-haiku-4-5",
      ),
    ).toThrow(/cannot patch slot/);
  });
});

describe("enumerateSlotCandidates --candidates (the sunset gate, §9.1 loop 4)", () => {
  const slots: ModelSlot[] = [
    { label: "agent.model", currentModel: "claude-haiku-4", path: ["agent", "model"] },
  ];

  test("a PRICIER replacement is enumerable when the candidate set is fixed", () => {
    // The downshift search alone can never see it: a sunset replacement costs
    // more than the model it retires.
    expect(
      enumerateSlotCandidates(slots, { pricing: PRICING }).map((c) => c.candidateModel),
    ).not.toContain("claude-sonnet-4");
    const fixed = enumerateSlotCandidates(slots, {
      pricing: PRICING,
      fixedCandidates: ["claude-sonnet-4"],
    });
    expect(fixed.map((c) => c.candidateModel)).toEqual(["claude-sonnet-4"]);
  });

  test("the model already in the slot is not a candidate", () => {
    expect(
      enumerateSlotCandidates(slots, {
        pricing: PRICING,
        fixedCandidates: ["claude-haiku-4"],
      }),
    ).toHaveLength(0);
  });
});
