/**
 * Evals Wave 1 — eval-report renders the measurement-literacy surfaces:
 * B13 slice table + per-slice diff deltas, C27 CI cards + CI-annotated
 * matrix cells, A12 per-criterion table + drill breakdown, A3 ABSTAINED
 * statuses + the needs-human section — all guarded so a results.json
 * written by an older CLI renders exactly as before.
 */
import { describe, expect, test } from "bun:test";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { diffReports } from "./diff";
import type { LoadedRun } from "./load";
import { buildMatrix, renderMatrix } from "./matrix";
import { renderReport } from "./render";

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
      passRate: samples.filter((s) => s.grades.overall.passed).length / samples.length,
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

describe("renderReport — Wave 1 sections", () => {
  test("legacy summaries render none of the new sections", () => {
    const { html } = renderReport(loaded(baseSummary([baseSample("s1", true, 1)])));
    expect(html).not.toContain('id="slices"');
    expect(html).not.toContain('id="criteria"');
    expect(html).not.toContain('id="needs-human"');
    expect(html).not.toContain("95% CI");
    expect(html).not.toContain("ABSTAINED");
  });

  test("B13: the slice table renders one row per (key, value)", () => {
    const summary = baseSummary([baseSample("s1", true, 1)], {
      slices: {
        difficulty: {
          easy: { sampleCount: 4, passRate: 1, meanScore: 0.9 },
          hard: { sampleCount: 5, passRate: 0.4, meanScore: 0.35 },
        },
      },
    });
    const { html } = renderReport(loaded(summary));
    expect(html).toContain('id="slices"');
    expect(html).toContain("<td>difficulty</td>");
    expect(html).toContain("<td>hard</td>");
    expect(html).toContain("40.0%");
  });

  test("C27: CI cards render when the aggregates carry the fields", () => {
    const summary = baseSummary([baseSample("s1", true, 1)]);
    const withCI = {
      ...summary,
      aggregates: {
        ...summary.aggregates,
        passRateCI95: [0.4902, 0.9433] as const,
        meanScoreCI95: [0.61, 0.79] as const,
      },
    };
    const { html } = renderReport(loaded(withCI));
    expect(html).toContain("Pass rate 95% CI");
    expect(html).toContain("[49.0%, 94.3%]");
    expect(html).toContain("Mean score 95% CI");
    expect(html).toContain("[0.610, 0.790]");
  });

  test("A12: criterion table + per-grade breakdown in the drill", () => {
    const graded = baseSample("s1", true, 0.75);
    const withDetail: SampleResult = {
      ...graded,
      grades: {
        overall: graded.grades.overall,
        perGrader: [
          {
            name: "quality",
            passed: true,
            score: 0.75,
            rationale: "solid",
            detail: { correctness: 4, tone: 5 },
          },
        ],
      },
    };
    const summary = baseSummary([withDetail]);
    const withMeans = {
      ...summary,
      aggregates: {
        ...summary.aggregates,
        criterionMeans: { quality: { correctness: 4, tone: 4.5 } },
      },
    };
    const { html } = renderReport(loaded(withMeans));
    expect(html).toContain('id="criteria"');
    expect(html).toContain("<td>correctness</td>");
    expect(html).toContain("4.50");
    // Drill: the per-grade breakdown rides beside the rationale.
    expect(html).toContain("correctness=4 · tone=5");
  });

  test("A3: ABSTAINED status, needs-human section, and the aggregate card", () => {
    const summary = baseSummary([baseSample("s1", true, 1), abstainedSample("s2")]);
    const withBucket = {
      ...summary,
      aggregates: {
        ...summary.aggregates,
        needsHuman: 1,
        needsHumanSampleIds: ["s2"],
      },
    };
    const { html } = renderReport(loaded(withBucket));
    expect(html).toContain("ABSTAINED");
    expect(html).toContain('id="needs-human"');
    expect(html).toContain("Needs human");
    expect(html).toContain("crewhaus rate");
  });

  test("A2: needs-review section + card render when the aggregates carry the bucket", () => {
    const summary = baseSummary([baseSample("s1", true, 1), baseSample("s2", true, 0.75)]);
    const withBucket = {
      ...summary,
      aggregates: {
        ...summary.aggregates,
        needsReview: 1,
        needsReviewSampleIds: ["s2"],
      },
    };
    const { html } = renderReport(loaded(withBucket));
    expect(html).toContain('id="needs-review"');
    expect(html).toContain("Needs review (1)");
    expect(html).toContain("vote entropy");
    // Bucket-free summaries render neither section nor card.
    const { html: plain } = renderReport(loaded(summary));
    expect(plain).not.toContain('id="needs-review"');
    expect(plain).not.toContain("Needs review");
  });

  test("B18: canary section + card explain the excluded-from-pass-rate denominator", () => {
    const summary = baseSummary([baseSample("s1", true, 1), baseSample("canary-1", true, 1)]);
    const withBucket = {
      ...summary,
      aggregates: {
        ...summary.aggregates,
        canary: 1,
        canarySampleIds: ["canary-1"],
      },
    };
    const { html } = renderReport(loaded(withBucket));
    expect(html).toContain('id="canary"');
    expect(html).toContain("Canary (1)");
    expect(html).toContain("excluded from the pass rate");
    expect(html).toContain("canary-1");
    // Canary-free summaries render neither section nor card.
    const { html: plain } = renderReport(loaded(summary));
    expect(plain).not.toContain('id="canary"');
    expect(plain).not.toContain("Canary (");
  });
});

describe("diffReports — Wave 1 (B13 slice deltas, A3 abstained sides)", () => {
  test("slice deltas cover only the (key, value) pairs both runs share", () => {
    const prev = baseSummary([baseSample("s1", true, 1)], {
      slices: {
        difficulty: {
          easy: { sampleCount: 4, passRate: 1, meanScore: 0.9 },
          hard: { sampleCount: 4, passRate: 0.75, meanScore: 0.6 },
          "prev-only": { sampleCount: 1, passRate: 1, meanScore: 1 },
        },
        "prev-only-key": { x: { sampleCount: 1, passRate: 1, meanScore: 1 } },
      },
    });
    const next = baseSummary([baseSample("s1", true, 1)], {
      slices: {
        difficulty: {
          easy: { sampleCount: 4, passRate: 1, meanScore: 0.9 },
          hard: { sampleCount: 4, passRate: 0.5, meanScore: 0.4 },
        },
      },
    });
    const { diff, html } = diffReports(loaded(prev), loaded(next));
    expect(diff.sliceDeltas).toEqual([
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
    ]);
    expect(html).toContain("Slice deltas (2)");
    expect(html).toContain("-25.0%");
  });

  test("no slices on either side → no sliceDeltas field (pre-B13 diff.json)", () => {
    const prev = baseSummary([baseSample("s1", true, 1)]);
    const next = baseSummary([baseSample("s1", true, 1)]);
    const { diff, json } = diffReports(loaded(prev), loaded(next));
    expect("sliceDeltas" in diff).toBe(false);
    expect(json).not.toContain("sliceDeltas");
  });

  test("an abstained side is flagged on the entry and rendered ABSTAINED", () => {
    const prev = baseSummary([baseSample("s1", true, 1)]);
    const next = baseSummary([abstainedSample("s1")]);
    const { diff, html } = diffReports(loaded(prev), loaded(next));
    // pass → abstained-placeholder-fail classifies as a regression entry…
    expect(diff.regressions).toHaveLength(1);
    // …but the side carries the abstained flag and the HTML says so.
    expect(diff.regressions[0]?.next.abstained).toBe(true);
    expect(diff.regressions[0]?.prev.abstained).toBeUndefined();
    expect(html).toContain("ABSTAINED");
  });
});

describe("matrix — C27 CI inheritance", () => {
  test("cells copy passRateCI95/meanScoreCI95 from their aggregates into rows + HTML", () => {
    const summary = baseSummary([baseSample("s1", true, 1)]);
    const withCI = {
      ...summary,
      aggregates: {
        ...summary.aggregates,
        passRateCI95: [0.4902, 0.9433] as const,
        meanScoreCI95: [0.3, 0.7] as const,
      },
    };
    const matrix = buildMatrix([
      { model: "m-a", slug: "m-a", outDir: "/tmp/m-a", summary: withCI },
      { model: "m-b", slug: "m-b", outDir: "/tmp/m-b", summary },
    ]);
    const rowA = matrix.rows.find((r) => r.model === "m-a");
    const rowB = matrix.rows.find((r) => r.model === "m-b");
    expect(rowA?.passRateCI95).toEqual([0.4902, 0.9433]);
    expect(rowA?.meanScoreCI95).toEqual([0.3, 0.7]);
    // A cell from an older CLI simply lacks the fields.
    expect(rowB?.passRateCI95).toBeUndefined();
    const { html, json } = renderMatrix(matrix);
    expect(html).toContain("[49.0–94.3%]");
    expect(html).toContain("[0.300–0.700]");
    expect(json).toContain("passRateCI95");
  });
});

// Evals Wave 2 (cluster C) — A9 calibration + A10 paraphrase-consistency cards.
describe("renderReport — cluster C aggregate cards (A9/A10)", () => {
  test("calibration and paraphrase-consistency aggregates render as guarded cards", () => {
    const summary = baseSummary([baseSample("s1", true, 1)]);
    const { html } = renderReport(
      loaded({
        ...summary,
        aggregates: {
          ...summary.aggregates,
          calibration: {
            classifiedSamples: 4,
            answerRate: 0.75,
            abstentionRate: 0.25,
            accuracyWhenAnswered: 2 / 3,
          },
          paraphraseConsistency: {
            groupCount: 3,
            consistencyByGroup: { g1: 1, g2: 0.5, g3: 1 },
            meanConsistency: 5 / 6,
          },
        },
      }),
    );
    expect(html).toContain("Answer rate");
    expect(html).toContain("75.0%");
    expect(html).toContain("Abstention rate");
    expect(html).toContain("25.0%");
    expect(html).toContain("Accuracy when answered");
    expect(html).toContain("66.7%");
    expect(html).toContain("Paraphrase consistency");
    expect(html).toContain("83.3% (3 groups)");
  });

  test("accuracy-when-answered card is omitted when the field is absent", () => {
    const summary = baseSummary([baseSample("s1", true, 1)]);
    const { html } = renderReport(
      loaded({
        ...summary,
        aggregates: {
          ...summary.aggregates,
          calibration: { classifiedSamples: 2, answerRate: 0, abstentionRate: 1 },
        },
      }),
    );
    expect(html).toContain("Answer rate");
    expect(html).not.toContain("Accuracy when answered");
  });

  test("legacy summaries render neither cluster-C card", () => {
    const { html } = renderReport(loaded(baseSummary([baseSample("s1", true, 1)])));
    expect(html).not.toContain("Answer rate");
    expect(html).not.toContain("Paraphrase consistency");
  });
});
