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
  type MutationProvider,
  type OptimizerState,
  PromptOptimizerError,
  type ProviderMutation,
  RuleBasedMutationProvider,
  type SampleGrade,
  applyMutation,
  optimize,
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
