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
import { PromptOptimizerError, RuleBasedMutationProvider, applyMutation, optimize } from "./index";

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
