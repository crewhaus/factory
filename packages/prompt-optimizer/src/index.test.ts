/**
 * Section 29 — `prompt-optimizer` tests:
 *  - T3 against fixture spec + 20-sample dataset (must improve pass-rate
 *    by ≥ 10% on the dev split)
 *  - T9 search-determinism with --seed
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  type FitnessFn,
  type KnobDial,
  type KnobValue,
  type MutationProvider,
  type OptimizerState,
  PromptOptimizerError,
  type ProviderMutation,
  RuleBasedMutationProvider,
  type SampleGrade,
  applyMutation,
  clampKnob,
  formatKnobPath,
  optimize,
  stepKnob,
} from "./index";

/**
 * A mutator that records every `OptimizerState` it is handed, so tests can
 * assert what signal (notably `bestGrades`) the loop threads to it. The
 * rewrite it emits is caller-supplied so tests can force an improving or
 * no-op iteration.
 */
class CapturingMutator implements MutationProvider {
  readonly name = "capturing";
  readonly states: OptimizerState[] = [];
  constructor(private readonly rewrite: (prompt: string, iteration: number) => string) {}
  async next(state: OptimizerState): Promise<ProviderMutation> {
    this.states.push(state);
    return { prompt: this.rewrite(state.best.prompt, state.iteration), mutations: [] };
  }
}

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "prompt-optimizer-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const sample = (id: string, input: string, expected: string): Sample => ({
  id,
  input,
  expected_output: expected,
});

describe("prompt-optimizer — T1 mutations", () => {
  test("rephrase-instruction appends a clarifying sentence", () => {
    const out = applyMutation("answer the question", { kind: "rephrase-instruction" });
    expect(out).toContain("answer the question");
    expect(out).toContain("Be concise");
  });

  test("add-few-shot appends an example block", () => {
    const out = applyMutation("answer", {
      kind: "add-few-shot",
      sample: sample("a", "2+2", "4"),
    });
    expect(out).toContain("Example:");
    expect(out).toContain("2+2");
    expect(out).toContain("4");
  });

  test("swap-example swaps the input/expected when present", () => {
    const orig = "answer\n\nExample:\nInput: 2+2\nExpected output: 4";
    const out = applyMutation(orig, {
      kind: "swap-example",
      oldSample: sample("a", "2+2", "4"),
      newSample: sample("b", "3+3", "6"),
    });
    expect(out).toContain("Input: 3+3");
    expect(out).not.toContain("Input: 2+2");
  });

  test("add-COT-prefix prepends the COT prefix", () => {
    const out = applyMutation("answer", { kind: "add-COT-prefix" });
    expect(out.startsWith("Think step by step")).toBe(true);
  });

  test("add-COT-prefix is idempotent", () => {
    const once = applyMutation("answer", { kind: "add-COT-prefix" });
    const twice = applyMutation(once, { kind: "add-COT-prefix" });
    expect(once).toBe(twice);
  });
});

describe("prompt-optimizer — T3 fitness-driven search", () => {
  test("optimize improves a fitness function that rewards adding 'Be concise'", async () => {
    // Fitness: 0.5 baseline; +0.4 if prompt contains "Be concise"; +0.1 if COT prefix present.
    const fitness = async (prompt: string): Promise<number> => {
      let score = 0.5;
      if (prompt.includes("Be concise")) score += 0.4;
      if (prompt.startsWith("Think step by step")) score += 0.1;
      return score;
    };
    const samples = Array.from({ length: 20 }, (_, i) => sample(`s${i}`, `q${i}`, `a${i}`));
    const result = await optimize("answer", {
      trainSet: samples.slice(0, 15),
      devSet: samples.slice(15),
      fitness,
      iterations: 20,
      seed: 0x1234,
    });
    expect(result.best.score).toBeGreaterThan(0.5);
    expect(result.improvement).toBeGreaterThanOrEqual(0.1);
  });

  test("optimize persists trajectory + best when outDir is set", async () => {
    const fitness = async (prompt: string): Promise<number> =>
      prompt.includes("Be concise") ? 0.9 : 0.5;
    const samples = [sample("a", "q", "a")];
    await optimize("answer", {
      trainSet: samples,
      devSet: samples,
      fitness,
      iterations: 5,
      outDir: tmpRoot,
      runId: "test-run",
    });
    const dir = join(tmpRoot, "test-run");
    const fs = require("node:fs");
    expect(fs.existsSync(join(dir, "trajectory.json"))).toBe(true);
    expect(fs.existsSync(join(dir, "best.json"))).toBe(true);
  });

  test("empty trainSet throws", async () => {
    expect(
      optimize("answer", {
        trainSet: [],
        devSet: [sample("a", "q", "a")],
        fitness: async () => 1,
      }),
    ).rejects.toBeInstanceOf(PromptOptimizerError);
  });

  test("empty devSet throws", async () => {
    expect(
      optimize("answer", {
        trainSet: [sample("a", "q", "a")],
        devSet: [],
        fitness: async () => 1,
      }),
    ).rejects.toBeInstanceOf(PromptOptimizerError);
  });
});

describe("prompt-optimizer — per-sample grades (FitnessResult) threading", () => {
  const grade = (input: string, score: number, rationale?: string): SampleGrade => ({
    input,
    score,
    ...(rationale !== undefined ? { rationale } : {}),
  });

  test("optimize normalizes a FitnessResult and threads base grades to the mutator", async () => {
    const baseGrades = [grade("q0", 0.0, "no citation"), grade("q1", 1.0)];
    const fitness: FitnessFn = async (prompt) =>
      prompt.includes("cite")
        ? { score: 1, grades: [grade("q0", 1), grade("q1", 1)] }
        : { score: 0.25, grades: baseGrades };
    const mutator = new CapturingMutator((p) => `${p} (cite sources)`);
    const samples = [sample("q0", "q0", "a0"), sample("q1", "q1", "a1")];
    const result = await optimize("answer", {
      trainSet: samples,
      devSet: samples,
      fitness,
      mutator,
      iterations: 1,
    });
    // Aggregate score is normalized out of the FitnessResult.
    expect(result.best.score).toBe(1);
    // Iteration 1 saw the BASE prompt's per-sample grades.
    expect(mutator.states[0]?.bestGrades).toEqual(baseGrades);
  });

  test("bestGrades updates to the new best's grades after an improving iteration", async () => {
    const baseGrades = [grade("q0", 0.0, "no citation")];
    const improvedGrades = [grade("q0", 1.0, "cites docs/spec.md")];
    const fitness: FitnessFn = async (prompt) =>
      prompt.includes("cite")
        ? { score: 1, grades: improvedGrades }
        : { score: 0, grades: baseGrades };
    // Only the first iteration improves; the second is a no-op rewrite.
    const mutator = new CapturingMutator((p, i) => (i === 1 ? `${p} (cite)` : p));
    const samples = [sample("q0", "q0", "a0")];
    await optimize("answer", {
      trainSet: samples,
      devSet: samples,
      fitness,
      mutator,
      iterations: 2,
    });
    // Iter 1 saw base grades; iter 2 saw the improved best's grades.
    expect(mutator.states[0]?.bestGrades).toEqual(baseGrades);
    expect(mutator.states[1]?.bestGrades).toEqual(improvedGrades);
  });

  test("a bare-number fitness leaves bestGrades undefined (back-compat)", async () => {
    const mutator = new CapturingMutator((p) => p);
    const samples = [sample("q0", "q0", "a0")];
    await optimize("answer", {
      trainSet: samples,
      devSet: samples,
      fitness: async () => 0.5,
      mutator,
      iterations: 1,
    });
    expect(mutator.states[0]?.bestGrades).toBeUndefined();
  });
});

describe("prompt-optimizer — item 9 FitnessResult.runDir tracking", () => {
  test("optimize surfaces the base and winning best's eval-run dirs", async () => {
    // Each measurement reports a distinct persisted dir; the loop must
    // return candidate-0's dir as baseRunDir and the best's as bestRunDir.
    let call = 0;
    const fitness: FitnessFn = async (prompt) => {
      call += 1;
      return {
        score: prompt.includes("cite") ? 1 : 0.25,
        runDir: `/runs/eval-${call}`,
      };
    };
    // Iteration 1 improves; iteration 2 is a no-op rewrite (worse-or-equal).
    const mutator = new CapturingMutator((p, i) => (i === 1 ? `${p} (cite)` : p));
    const samples = [sample("q0", "q0", "a0")];
    const result = await optimize("answer", {
      trainSet: samples,
      devSet: samples,
      fitness,
      mutator,
      iterations: 2,
    });
    expect(result.baseRunDir).toBe("/runs/eval-1");
    // Call 2 (iteration 1) produced the winner; call 3 didn't beat it.
    expect(result.bestRunDir).toBe("/runs/eval-2");
    expect(result.best.score).toBe(1);
  });

  test("a bare-number fitness leaves both run dirs undefined (back-compat)", async () => {
    const samples = [sample("q0", "q0", "a0")];
    const result = await optimize("answer", {
      trainSet: samples,
      devSet: samples,
      fitness: async (prompt) => prompt.length / 100,
      iterations: 2,
      seed: 0x42,
    });
    expect(result.baseRunDir).toBeUndefined();
    expect(result.bestRunDir).toBeUndefined();
  });

  test("no improving iteration → bestRunDir stays the base measurement's dir", async () => {
    let call = 0;
    const fitness: FitnessFn = async () => {
      call += 1;
      return { score: 0.5, runDir: `/runs/eval-${call}` };
    };
    const mutator = new CapturingMutator((p) => p);
    const samples = [sample("q0", "q0", "a0")];
    const result = await optimize("answer", {
      trainSet: samples,
      devSet: samples,
      fitness,
      mutator,
      iterations: 2,
    });
    expect(result.baseRunDir).toBe("/runs/eval-1");
    expect(result.bestRunDir).toBe("/runs/eval-1");
  });
});

describe("prompt-optimizer — FR-003 ProviderMutation.usage is optional", () => {
  test("RuleBasedMutationProvider.next() leaves usage undefined (no model call)", async () => {
    const provider = new RuleBasedMutationProvider({ seed: 0x42 });
    const result = await provider.next({
      iteration: 1,
      best: { id: "candidate-0", prompt: "answer", mutations: [], score: 0.5 },
      trajectory: [],
      trainSet: [sample("a", "q", "a")],
      devSet: [sample("b", "r", "b")],
    });
    // The seam widening is purely additive — rule-based reports no usage.
    expect(result.usage).toBeUndefined();
  });

  test("optimize() still completes with the rule-based (usage-free) provider", async () => {
    const fitness = async (prompt: string): Promise<number> => prompt.length / 100;
    const samples = [sample("a", "q", "a")];
    const result = await optimize("answer", {
      trainSet: samples,
      devSet: samples,
      fitness,
      iterations: 3,
      seed: 0x42,
    });
    expect(result.trajectory.length).toBe(4); // base + 3
  });
});

describe("prompt-optimizer — T9 search determinism with --seed", () => {
  test("same seed produces same trajectory", async () => {
    const fitness = async (prompt: string): Promise<number> => prompt.length / 100;
    const samples = [sample("a", "q", "a"), sample("b", "r", "b")];
    const r1 = await optimize("answer", {
      trainSet: samples,
      devSet: samples,
      fitness,
      iterations: 10,
      seed: 0x42,
    });
    const r2 = await optimize("answer", {
      trainSet: samples,
      devSet: samples,
      fitness,
      iterations: 10,
      seed: 0x42,
    });
    expect(r1.best.prompt).toBe(r2.best.prompt);
  });

  test("different seeds produce different trajectories", async () => {
    const fitness = async (prompt: string): Promise<number> => prompt.length / 100;
    const samples = [sample("a", "q", "a"), sample("b", "r", "b")];
    const r1 = await optimize("answer", {
      trainSet: samples,
      devSet: samples,
      fitness,
      iterations: 5,
      seed: 0x42,
    });
    const r2 = await optimize("answer", {
      trainSet: samples,
      devSet: samples,
      fitness,
      iterations: 5,
      seed: 0xbeef,
    });
    // At least one of the trajectory items should differ.
    let differs = false;
    for (let i = 0; i < r1.trajectory.length; i++) {
      if (r1.trajectory[i]?.prompt !== r2.trajectory[i]?.prompt) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });
});

// -------- D43: bounded numeric-knob search --------

const THRESHOLD_DIAL: KnobDial = {
  path: ["evaluation", "threshold"],
  value: 0.7,
  min: 0,
  max: 1,
  step: 0.05,
};
const RETRIES_DIAL: KnobDial = {
  path: ["evaluation", "max_retries"],
  value: 1,
  min: 1,
  max: 5,
  step: 1,
  integer: true,
};

describe("prompt-optimizer — D43 knob dials", () => {
  test("clampKnob honours bounds, integrality and float snapping", () => {
    expect(clampKnob(THRESHOLD_DIAL, 1.4)).toBe(1);
    expect(clampKnob(THRESHOLD_DIAL, -3)).toBe(0);
    expect(clampKnob(THRESHOLD_DIAL, 0.7 - 0.05)).toBe(0.65);
    expect(clampKnob(RETRIES_DIAL, 2.4)).toBe(2);
    expect(clampKnob(RETRIES_DIAL, 99)).toBe(5);
  });

  test("stepKnob refuses a no-op step at a rail", () => {
    expect(stepKnob(RETRIES_DIAL, -1, 1)).toBeUndefined();
    expect(stepKnob(RETRIES_DIAL, 1, 5)).toBeUndefined();
    expect(stepKnob(RETRIES_DIAL, 1, 1)?.to).toBe(2);
    expect(stepKnob({ ...RETRIES_DIAL, step: 0 }, 1, 1)).toBeUndefined();
  });

  test("formatKnobPath renders the dotted spec path", () => {
    expect(formatKnobPath(["evaluation", "threshold"])).toBe("evaluation.threshold");
  });

  test("the rule-based mutator proposes only in-bounds knob steps", async () => {
    const provider = new RuleBasedMutationProvider({ seed: 7 });
    const dials = [THRESHOLD_DIAL, RETRIES_DIAL];
    const seen: KnobValue[][] = [];
    for (let i = 0; i < 12; i += 1) {
      const proposal = await provider.next({
        iteration: i * 2,
        best: { id: "c", prompt: "base", mutations: [], score: 0, knobs: [] },
        trajectory: [],
        trainSet: [sample("t1", "in", "out")],
        devSet: [sample("d1", "in", "out")],
        knobs: dials,
      });
      if (proposal.knobs !== undefined) seen.push([...proposal.knobs]);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const knobs of seen) {
      for (const k of knobs) {
        const dial = dials.find((d) => formatKnobPath(d.path) === formatKnobPath(k.path));
        expect(dial).toBeDefined();
        expect(k.value).toBeGreaterThanOrEqual((dial as KnobDial).min);
        expect(k.value).toBeLessThanOrEqual((dial as KnobDial).max);
        if ((dial as KnobDial).integer === true) expect(Number.isInteger(k.value)).toBe(true);
      }
    }
    // Round-robin: both dials get visited across the window.
    const touched = new Set(seen.flatMap((knobs) => knobs.map((k) => formatKnobPath(k.path))));
    expect(touched.size).toBe(2);
  });

  test("a knob-step proposal leaves the prompt untouched", async () => {
    const provider = new RuleBasedMutationProvider({ seed: 3 });
    const proposal = await provider.next({
      iteration: 2,
      best: { id: "c", prompt: "the base prompt", mutations: [], score: 0 },
      trajectory: [],
      trainSet: [sample("t1", "in", "out")],
      devSet: [sample("d1", "in", "out")],
      knobs: [THRESHOLD_DIAL],
    });
    expect(proposal.prompt).toBe("the base prompt");
    expect(proposal.mutations[0]?.kind).toBe("knob-step");
    expect(applyMutation("the base prompt", proposal.mutations[0] as never)).toBe(
      "the base prompt",
    );
  });

  test("declaring no knobs keeps fitness single-argument and the result knob-free", async () => {
    const seenArgs: Array<ReadonlyArray<KnobValue> | undefined> = [];
    const fitness: FitnessFn = async (prompt, knobs) => {
      seenArgs.push(knobs);
      return prompt.length / 100;
    };
    const result = await optimize("base", {
      trainSet: [sample("t1", "in", "out")],
      devSet: [sample("d1", "in", "out")],
      fitness,
      iterations: 3,
      seed: 1,
    });
    expect(seenArgs.every((k) => k === undefined)).toBe(true);
    expect(result.knobs).toBeUndefined();
    expect(result.best.knobs).toBeUndefined();
    expect(result.trajectory.every((c) => c.knobs === undefined)).toBe(true);
  });

  test("the accept loop gates knob proposals exactly like prompt proposals", async () => {
    // Fitness rewards ONLY a lower threshold; every prompt rewrite is neutral.
    const fitness: FitnessFn = async (_prompt, knobs) => {
      const t = knobs?.find((k) => formatKnobPath(k.path) === "evaluation.threshold");
      return t === undefined ? 0.5 : 1 - t.value;
    };
    const result = await optimize("base", {
      trainSet: [sample("t1", "in", "out")],
      devSet: [sample("d1", "in", "out")],
      fitness,
      iterations: 8,
      seed: 11,
      knobs: [THRESHOLD_DIAL],
    });
    const winning = result.knobs?.find((k) => formatKnobPath(k.path) === "evaluation.threshold");
    expect(winning).toBeDefined();
    // Strictly better than the source value, and still inside the bounds.
    expect((winning as KnobValue).value).toBeLessThan(0.7);
    expect((winning as KnobValue).value).toBeGreaterThanOrEqual(0);
    expect(result.improvement).toBeGreaterThan(0);
    // A knob candidate that does NOT improve is never adopted: the best
    // carries the winning value, not the last one tried.
    expect(result.best.knobs).toEqual(result.knobs as ReadonlyArray<KnobValue>);
  });

  test("a knob search that finds nothing returns the source dial values", async () => {
    // Flat fitness: no candidate ever beats the baseline.
    const fitness: FitnessFn = async () => 0.5;
    const result = await optimize("base", {
      trainSet: [sample("t1", "in", "out")],
      devSet: [sample("d1", "in", "out")],
      fitness,
      iterations: 6,
      seed: 5,
      knobs: [THRESHOLD_DIAL, RETRIES_DIAL],
    });
    expect(result.improvement).toBe(0);
    expect(result.knobs).toEqual([
      { path: ["evaluation", "threshold"], value: 0.7 },
      { path: ["evaluation", "max_retries"], value: 1 },
    ]);
  });

  test("knob search stays deterministic under a fixed seed", async () => {
    const fitness: FitnessFn = async (_p, knobs) => {
      const t = knobs?.find((k) => formatKnobPath(k.path) === "evaluation.threshold");
      return t === undefined ? 0 : 1 - Math.abs(t.value - 0.5);
    };
    const run = async () =>
      await optimize("base", {
        trainSet: [sample("t1", "in", "out")],
        devSet: [sample("d1", "in", "out")],
        fitness,
        iterations: 6,
        seed: 42,
        knobs: [THRESHOLD_DIAL],
      });
    const a = await run();
    const b = await run();
    expect(a.knobs).toEqual(b.knobs as ReadonlyArray<KnobValue>);
    expect(a.best.score).toBe(b.best.score);
  });
});
