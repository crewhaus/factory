/**
 * C29 — paired significance on run diffs: exact sign-flip permutation math
 * on tiny known cases, Monte Carlo + bootstrap determinism under a fixed
 * seed, the additive `significance` block in diff.json/HTML, abstained-pair
 * exclusion, and the plain-language formatting the CLI tail prints. The
 * strict classification (regressions/recoveries/shifts) must be untouched
 * by any of it.
 */
import { describe, expect, test } from "bun:test";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { diffReports, formatSliceDeltaLines } from "./diff";
import type { LoadedRun } from "./load";
import {
  DEFAULT_SIGNIFICANCE_SEED,
  computeDiffSignificance,
  formatSignificanceLine,
  mulberry32,
} from "./significance";

function baseSample(id: string, passed: boolean, score: number): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 20 },
    model: "claude-opus-4-7",
    agentOutput: passed ? "correct" : "wrong",
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "wrong answer" },
      perGrader: [{ name: "exact", passed, score, rationale: "" }],
    },
  };
}

function abstainedSample(id: string): SampleResult {
  const s = baseSample(id, false, 0);
  return {
    ...s,
    grades: {
      overall: { passed: false, score: 0, rationale: "judge abstained", abstained: true },
      perGrader: [
        { name: "quality", passed: false, score: 0, rationale: "abstain", abstained: true },
      ],
    },
  };
}

function baseSummary(samples: SampleResult[], extra: Partial<EvalRunSummary> = {}): EvalRunSummary {
  return {
    runId: "run_aaaa1111aaaa1111",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:30Z",
    samples,
    aggregates: {
      passRate:
        samples.length === 0
          ? 0
          : samples.filter((s) => s.grades.overall.passed).length / samples.length,
      meanScore: 0.5,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 10, output: 20 },
      errorCount: 0,
    },
    config: {
      specHash: "abc123",
      datasetName: "fixture",
      graderNames: ["exact"],
      model: "claude-opus-4-7",
      concurrency: 4,
    },
    outDir: "<tmp>",
    ...extra,
  };
}

function loaded(summary: EvalRunSummary): LoadedRun {
  return { summary, perSample: {} };
}

describe("mulberry32", () => {
  test("deterministic per seed, uniform-ish in [0, 1)", () => {
    const a = mulberry32(29);
    const b = mulberry32(29);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    // A different seed diverges immediately.
    expect(mulberry32(30)()).not.toBe(seqA[0]);
  });
});

describe("computeDiffSignificance — exact enumeration (paired-n ≤ 20)", () => {
  test("no pairs → undefined (an interval on nothing is fabrication)", () => {
    expect(computeDiffSignificance([])).toBeUndefined();
  });

  test("two same-direction flips: p = 2/4 exactly", () => {
    const sig = computeDiffSignificance([1, 1]);
    expect(sig?.method).toBe("exact");
    expect(sig?.pairedN).toBe(2);
    expect(sig?.permutations).toBe(4);
    // |±1 ± 1| ≥ 2 for exactly {++, --} of the 4 assignments.
    expect(sig?.pValue).toBe(0.5);
    expect(sig?.passRateDelta).toBe(1);
    expect(sig?.significant).toBe(false);
  });

  test("five same-direction flips: p = 2/32 = 0.0625 — just misses 0.05", () => {
    const sig = computeDiffSignificance([1, 1, 1, 1, 1]);
    expect(sig?.pValue).toBe(0.0625);
    expect(sig?.significant).toBe(false);
  });

  test("six same-direction flips: p = 2/64 = 0.03125 — significant", () => {
    const sig = computeDiffSignificance([-1, -1, -1, -1, -1, -1]);
    expect(sig?.pValue).toBe(0.03125);
    expect(sig?.significant).toBe(true);
    expect(sig?.passRateDelta).toBe(-1);
  });

  test("zero deltas are sign-invariant: [1,1,0,0] ranks exactly as [1,1]", () => {
    const sig = computeDiffSignificance([1, 1, 0, 0]);
    expect(sig?.pValue).toBe(0.5);
    // pairedN counts every pair; the enumeration covers only the 2 nonzero.
    expect(sig?.pairedN).toBe(4);
    expect(sig?.permutations).toBe(4);
  });

  test("all-zero deltas: p = 1, delta 0, zero-width CI", () => {
    const sig = computeDiffSignificance([0, 0, 0]);
    expect(sig?.pValue).toBe(1);
    expect(sig?.passRateDelta).toBe(0);
    expect(sig?.permutations).toBe(1);
    expect(sig?.passRateDeltaCI95).toEqual([0, 0]);
    expect(sig?.significant).toBe(false);
  });

  test("cancelling flips: observed sum 0 → every assignment ties → p = 1", () => {
    const sig = computeDiffSignificance([1, -1]);
    expect(sig?.pValue).toBe(1);
    expect(sig?.passRateDelta).toBe(0);
  });

  test("fractional trial-rate deltas participate (G15 repeats)", () => {
    // 0.75→0.5 twice plus a full flip: exact over 3 nonzero deltas.
    const sig = computeDiffSignificance([-0.25, -0.25, -1]);
    expect(sig?.method).toBe("exact");
    expect(sig?.permutations).toBe(8);
    // |sum| = 1.5 is achieved only by the identity and its mirror.
    expect(sig?.pValue).toBe(0.25);
  });
});

describe("computeDiffSignificance — Monte Carlo (paired-n > 20)", () => {
  const deltas = Array.from({ length: 30 }, (_, i) => (i < 8 ? -1 : 0));

  test("fixed default seed → identical output across calls", () => {
    const a = computeDiffSignificance(deltas);
    const b = computeDiffSignificance(deltas);
    expect(a?.method).toBe("monte-carlo");
    expect(a?.permutations).toBe(10_000);
    expect(a?.seed).toBe(DEFAULT_SIGNIFICANCE_SEED);
    expect(a).toEqual(b as NonNullable<typeof b>);
  });

  test("seed override is honored and deterministic too", () => {
    const a = computeDiffSignificance(deltas, { seed: 7 });
    const b = computeDiffSignificance(deltas, { seed: 7 });
    expect(a?.seed).toBe(7);
    expect(a).toEqual(b as NonNullable<typeof b>);
  });

  test("a lopsided delta set is detected as significant", () => {
    // 25 same-direction flips: true sign-flip p = 2/2^25 ≈ 6e-8; the
    // add-one Monte Carlo floor is 1/10001 ≈ 1e-4 — decisively < 0.05.
    const sig = computeDiffSignificance(Array.from({ length: 25 }, () => 1));
    expect(sig?.method).toBe("monte-carlo");
    expect(sig?.pValue).toBeLessThan(0.01);
    expect(sig?.pValue).toBeGreaterThan(0);
    expect(sig?.significant).toBe(true);
  });

  test("bootstrap CI brackets the mean delta within the deltas' range", () => {
    const sig = computeDiffSignificance(deltas);
    const [lo, hi] = sig?.passRateDeltaCI95 as readonly [number, number];
    expect(lo).toBeLessThanOrEqual(sig?.passRateDelta as number);
    expect(hi).toBeGreaterThanOrEqual(sig?.passRateDelta as number);
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(0);
  });
});

describe("diffReports — C29 significance block", () => {
  test("diff.json carries the additive significance fields; HTML prints the verdict line", () => {
    const ids = ["s1", "s2", "s3", "s4"];
    const prev = baseSummary(ids.map((id) => baseSample(id, true, 1)));
    const next = baseSummary(ids.map((id, i) => baseSample(id, i > 0, i > 0 ? 1 : 0)));
    const { diff, json, html } = diffReports(loaded(prev), loaded(next));
    expect(diff.significance?.pairedN).toBe(4);
    expect(diff.significance?.method).toBe("exact");
    // One flip among four: |±1| ≥ 1 always → p = 1.
    expect(diff.significance?.pValue).toBe(1);
    expect(diff.significance?.significant).toBe(false);
    const parsed = JSON.parse(json) as { significance?: { pValue: number; pairedN: number } };
    expect(parsed.significance?.pValue).toBe(1);
    expect(parsed.significance?.pairedN).toBe(4);
    expect(html).toContain("Paired significance:");
    expect(html).toContain("not significant at 0.05");
    // The strict classification is untouched by significance.
    expect(diff.regressions).toHaveLength(1);
    expect(diff.unchanged).toBe(3);
  });

  test("abstained-on-either-side pairs are excluded from the paired set", () => {
    const prev = baseSummary([baseSample("s1", true, 1), baseSample("s2", true, 1)]);
    const next = baseSummary([baseSample("s1", true, 1), abstainedSample("s2")]);
    const { diff } = diffReports(loaded(prev), loaded(next));
    expect(diff.significance?.pairedN).toBe(1);
    expect(diff.significance?.passRateDelta).toBe(0);
  });

  test("every shared sample abstained → no significance block at all", () => {
    const prev = baseSummary([abstainedSample("s1")]);
    const next = baseSummary([abstainedSample("s1")]);
    const { diff, json, html } = diffReports(loaded(prev), loaded(next));
    expect("significance" in diff).toBe(false);
    expect(json).not.toContain("significance");
    expect(html).not.toContain("Paired significance:");
  });

  test("opts.seed threads through to the recorded seed", () => {
    const prev = baseSummary([baseSample("s1", true, 1)]);
    const next = baseSummary([baseSample("s1", false, 0)]);
    const { diff } = diffReports(loaded(prev), loaded(next), { seed: 1234 });
    expect(diff.significance?.seed).toBe(1234);
    // Unseeded → the fixed default, never Math.random.
    const { diff: unseeded } = diffReports(loaded(prev), loaded(next));
    expect(unseeded.significance?.seed).toBe(DEFAULT_SIGNIFICANCE_SEED);
  });
});

describe("formatting — the CLI tail lines", () => {
  test("formatSignificanceLine spells out delta, CI, p, n, and the verdict", () => {
    const line = formatSignificanceLine({
      pairedN: 16,
      passRateDelta: -0.125,
      passRateDeltaCI95: [-0.25, -0.0625],
      pValue: 0.031,
      method: "exact",
      permutations: 64,
      seed: DEFAULT_SIGNIFICANCE_SEED,
      significant: true,
    });
    expect(line).toBe(
      "pass-rate delta -12.5% (95% CI [-25.0%, -6.3%]) p=0.031 (exact, n=16 pairs) — significant at 0.05",
    );
  });

  test("tiny p-values render as p<0.001", () => {
    const line = formatSignificanceLine({
      pairedN: 40,
      passRateDelta: 0.5,
      passRateDeltaCI95: [0.35, 0.65],
      pValue: 0.0001,
      method: "monte-carlo",
      permutations: 10_000,
      seed: 29,
      significant: true,
    });
    expect(line).toContain("p<0.001");
    expect(line).toContain("+50.0%");
    expect(line).toContain("monte-carlo");
  });

  test("formatSliceDeltaLines groups shared slices one line per key", () => {
    const lines = formatSliceDeltaLines([
      {
        key: "difficulty",
        value: "easy",
        prev: { passRate: 1, meanScore: 0.9, sampleCount: 4 },
        next: { passRate: 1, meanScore: 0.9, sampleCount: 4 },
      },
      {
        key: "difficulty",
        value: "hard",
        prev: { passRate: 0.75, meanScore: 0.6, sampleCount: 4 },
        next: { passRate: 0.5, meanScore: 0.4, sampleCount: 4 },
      },
      {
        key: "language",
        value: "de",
        prev: { passRate: 0.5, meanScore: 0.5, sampleCount: 2 },
        next: { passRate: 1, meanScore: 0.9, sampleCount: 2 },
      },
    ]);
    expect(lines).toEqual([
      "slice difficulty: easy +0.0% (100.0%→100.0%, n=4) · hard -25.0% (75.0%→50.0%, n=4)",
      "slice language: de +50.0% (50.0%→100.0%, n=2)",
    ]);
  });

  test("no shared slices → no lines", () => {
    expect(formatSliceDeltaLines([])).toEqual([]);
  });
});
