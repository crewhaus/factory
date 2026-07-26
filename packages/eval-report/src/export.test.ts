import { describe, expect, test } from "bun:test";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import {
  EXPORT_COLUMNS,
  type ExportRow,
  buildExportRows,
  csvCell,
  rowsToCsv,
  rowsToJsonl,
} from "./export";

function sample(overrides: Partial<SampleResult> & { sampleId: string }): SampleResult {
  return {
    sessionId: `sess-${overrides.sampleId}`,
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:00:02.000Z",
    latencyMs: 2000,
    turns: 1,
    tokens: { input: 10, output: 5 },
    model: "claude-sonnet-4-5",
    agentOutput: "the answer",
    grades: {
      overall: { passed: true, score: 1, rationale: "ok" },
      perGrader: [{ name: "exact", passed: true, score: 1, rationale: "matched" }],
    },
    ...overrides,
  };
}

function summary(overrides: Partial<EvalRunSummary> = {}): EvalRunSummary {
  return {
    runId: "run_1111111111111111",
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:01:00.000Z",
    samples: [sample({ sampleId: "s1" })],
    aggregates: {
      passRate: 1,
      meanScore: 1,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 2000,
      p95LatencyMs: 2000,
      totalTokens: { input: 10, output: 5 },
      errorCount: 0,
    },
    config: {
      specHash: "spec1",
      datasetName: "smoke",
      graderNames: ["exact"],
      model: "claude-sonnet-4-5",
      concurrency: 4,
    },
    outDir: "/abs/evals/run_1111111111111111",
    ...overrides,
  };
}

describe("buildExportRows (C32)", () => {
  test("emits one row per (run, sample, grader) with run config columns", () => {
    const rows = buildExportRows([
      {
        summary: summary({
          samples: [
            sample({
              sampleId: "s1",
              grades: {
                overall: { passed: false, score: 0.5, rationale: "mixed" },
                perGrader: [
                  { name: "exact", passed: false, score: 0, rationale: "no match" },
                  { name: "judge", passed: true, score: 1, rationale: "judge=5 (need ≥3): good" },
                ],
              },
            }),
          ],
          config: { ...summary().config, judgeModel: "claude-sonnet-4-5", seed: 7 },
        }),
        specName: "concierge",
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      runId: "run_1111111111111111",
      specName: "concierge",
      datasetName: "smoke",
      judgeModel: "claude-sonnet-4-5",
      seed: "7",
      sampleId: "s1",
      samplePassed: false,
      sampleScore: 0.5,
      grader: "exact",
      passed: false,
    });
    expect(rows[1]?.grader).toBe("judge");
    expect(rows[1]?.passed).toBe(true);
    // Sample-level verdict repeats on every grader row so a spreadsheet can
    // group either way without a join.
    expect(rows[1]?.samplePassed).toBe(false);
  });

  test("an ungraded (errored) sample still produces a row", () => {
    const rows = buildExportRows([
      {
        summary: summary({
          samples: [
            sample({
              sampleId: "boom",
              error: "provider timeout",
              grades: {
                overall: { passed: false, score: 0, rationale: "sample failed entirely" },
                perGrader: [],
              },
            }),
          ],
        }),
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sampleId: "boom",
      grader: "",
      sampleError: "provider timeout",
    });
  });

  test("carries trial pass rate, the flaky flag and slice membership", () => {
    const rows = buildExportRows([
      {
        summary: summary({
          slices: { difficulty: { hard: { sampleCount: 1, passRate: 0, meanScore: 0 } } },
          samples: [
            sample({
              sampleId: "s1",
              trialPassRate: 0.5,
              flaky: true,
              metadata: { difficulty: "hard", family: "billing", unrelated: 3 },
            }),
          ],
        }),
      },
    ]);
    expect(rows[0]).toMatchObject({ trialPassRate: "0.5", flaky: true, slices: "difficulty=hard" });
  });

  test("derives flaky from trialPassRate, exactly like aggregate() does", () => {
    // A `--resume`d sample (and every sample written by a pre-C34 CLI)
    // carries trials + trialPassRate but NO `flaky` flag — the run's own
    // aggregates.flakySampleIds, the stdout flake block and the history
    // `flaky` column all call it flaky, so the export must too, or the CSV
    // the flake line points at contradicts the run that emitted it.
    const rows = buildExportRows([
      {
        summary: summary({
          samples: [
            sample({ sampleId: "resumed", trialPassRate: 0.25 }),
            sample({ sampleId: "stable-pass", trialPassRate: 1 }),
            sample({ sampleId: "stable-fail", trialPassRate: 0 }),
            sample({ sampleId: "single-trial" }),
          ],
        }),
      },
    ]);
    const flakyById = new Map(rows.map((r) => [r.sampleId, r.flaky]));
    expect(flakyById.get("resumed")).toBe(true);
    expect(flakyById.get("stable-pass")).toBe(false);
    expect(flakyById.get("stable-fail")).toBe(false);
    expect(flakyById.get("single-trial")).toBe(false);
  });

  test("clips long rationales (the full text stays in grades.json)", () => {
    const rows = buildExportRows(
      [
        {
          summary: summary({
            samples: [
              sample({
                sampleId: "s1",
                grades: {
                  overall: { passed: true, score: 1, rationale: "x".repeat(500) },
                  perGrader: [
                    { name: "judge", passed: true, score: 1, rationale: `${"y".repeat(500)}` },
                  ],
                },
              }),
            ],
          }),
        },
      ],
      { rationaleMaxChars: 20 },
    );
    expect(rows[0]?.rationale).toHaveLength(20);
    expect(rows[0]?.rationale.endsWith("…")).toBe(true);
  });

  test("newlines in a rationale are flattened so a CSV row stays one line", () => {
    const rows = buildExportRows([
      {
        summary: summary({
          samples: [
            sample({
              sampleId: "s1",
              grades: {
                overall: { passed: true, score: 1, rationale: "line one\nline two" },
                perGrader: [
                  { name: "judge", passed: true, score: 1, rationale: "line one\nline two" },
                ],
              },
            }),
          ],
        }),
      },
    ]);
    expect(rows[0]?.rationale).toBe("line one line two");
  });

  test("flattens multiple runs in order", () => {
    const rows = buildExportRows([
      { summary: summary({ runId: "run_a" }) },
      { summary: summary({ runId: "run_b" }) },
    ]);
    expect(rows.map((r) => r.runId)).toEqual(["run_a", "run_b"]);
  });
});

describe("csv + jsonl emitters", () => {
  const rows: ExportRow[] = buildExportRows([{ summary: summary(), specName: "concierge" }]);

  test("csv has the header row and one line per row", () => {
    const csv = rowsToCsv(rows);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(EXPORT_COLUMNS.join(","));
    expect(lines).toHaveLength(2);
    expect(csv.endsWith("\n")).toBe(true);
  });

  test("csv quoting follows RFC4180", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });

  test("a comma-carrying rationale round-trips as one quoted cell", () => {
    const withComma = buildExportRows([
      {
        summary: summary({
          samples: [
            sample({
              sampleId: "s1",
              grades: {
                overall: { passed: true, score: 1, rationale: "ok" },
                perGrader: [
                  { name: "judge", passed: true, score: 1, rationale: "good, but terse" },
                ],
              },
            }),
          ],
        }),
      },
    ]);
    const csv = rowsToCsv(withComma);
    expect(csv).toContain('"good, but terse"');
    expect(csv.trimEnd().split("\n")).toHaveLength(2);
  });

  test("jsonl emits one parseable object per row", () => {
    const jsonl = rowsToJsonl(rows);
    const parsed = jsonl
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as ExportRow);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.sampleId).toBe("s1");
    expect(parsed[0]?.grader).toBe("exact");
  });
});
