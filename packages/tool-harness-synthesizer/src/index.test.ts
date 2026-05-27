import { describe, expect, test } from "bun:test";
import {
  HarnessSynthesizerError,
  type VerifierSample,
  runVerifier,
  synthesizeVerifier,
  thompsonPick,
} from "./index";

const evenSamples: VerifierSample[] = [
  { input: null, output: 0, expected: true },
  { input: null, output: 1, expected: false },
  { input: null, output: 2, expected: true },
  { input: null, output: 3, expected: false },
  { input: null, output: 4, expected: true },
];

describe("runVerifier", () => {
  test("scores a correct verifier at 1.0", () => {
    const r = runVerifier("return typeof output === 'number' && output % 2 === 0", evenSamples);
    expect(r.heuristic).toBe(1);
    expect(r.errors).toBe(0);
    expect(r.verdicts).toEqual([true, false, true, false, true]);
  });

  test("scores a constant-true verifier at the majority class", () => {
    const r = runVerifier("return true", evenSamples);
    // 3 of 5 expected: true → score 0.6
    expect(r.heuristic).toBe(0.6);
  });

  test("captures runtime errors without throwing", () => {
    const r = runVerifier("throw new Error('boom')", evenSamples);
    expect(r.errors).toBe(5);
    expect(r.heuristic).toBe(0.4); // false vs expected: 2 of 5 are expected false
  });

  test("throws on uncompilable code", () => {
    expect(() => runVerifier("not valid javascript {{{", evenSamples)).toThrow(
      HarnessSynthesizerError,
    );
  });
});

describe("thompsonPick", () => {
  test("returns 0 for a single candidate", () => {
    const idx = thompsonPick(
      [
        {
          id: "x",
          code: "return true",
          score: 1,
          heuristic: 1,
          alpha: 10,
          beta: 1,
        },
      ],
      () => 0.5,
    );
    expect(idx).toBe(0);
  });

  test("favors high-heuristic candidates when sampling is biased", () => {
    const nodes = [
      { id: "a", code: "1", score: 0.1, heuristic: 0.1, alpha: 1, beta: 9 },
      { id: "b", code: "1", score: 0.9, heuristic: 0.9, alpha: 9, beta: 1 },
    ];
    // RNG always 0.5 — Marsaglia normal is degenerate; we just verify it
    // doesn't crash and returns a valid index.
    const idx = thompsonPick(nodes, () => 0.5);
    expect([0, 1]).toContain(idx);
  });
});

describe("synthesizeVerifier", () => {
  test("returns immediately when a seed already meets target", async () => {
    const result = await synthesizeVerifier({
      seedCandidates: ["return typeof output === 'number' && output % 2 === 0"],
      samples: evenSamples,
      refiner: async () => "throw new Error('should not be called')",
      target: 1.0,
    });
    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(0);
    expect(result.best.heuristic).toBe(1);
  });

  test("converges via refiner when seed is poor", async () => {
    // Start with a constant-true seed; refiner produces the correct
    // verifier on the first call. This proves the search loop wires
    // refiner → score → pool update correctly.
    const result = await synthesizeVerifier({
      seedCandidates: ["return true"],
      samples: evenSamples,
      refiner: async () => "return typeof output === 'number' && output % 2 === 0",
      target: 1.0,
      maxIterations: 3,
      rng: () => 0.5,
    });
    expect(result.converged).toBe(true);
    expect(result.best.heuristic).toBe(1);
  });

  test("returns best-so-far when iterations exhaust", async () => {
    const result = await synthesizeVerifier({
      seedCandidates: ["return false"], // score 0.4
      samples: evenSamples,
      refiner: async () => "return true", // score 0.6
      target: 1.0,
      maxIterations: 3,
      rng: () => 0.5,
    });
    expect(result.converged).toBe(false);
    expect(result.best.heuristic).toBeGreaterThanOrEqual(0.6);
  });

  test("throws on empty seed candidates", async () => {
    await expect(
      synthesizeVerifier({
        seedCandidates: [],
        samples: evenSamples,
        refiner: async () => "return true",
      }),
    ).rejects.toThrow(HarnessSynthesizerError);
  });

  test("throws on empty sample set", async () => {
    await expect(
      synthesizeVerifier({
        seedCandidates: ["return true"],
        samples: [],
        refiner: async () => "return true",
      }),
    ).rejects.toThrow(HarnessSynthesizerError);
  });
});
