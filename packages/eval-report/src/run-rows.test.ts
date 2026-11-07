import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { type CompiledGrader, parseGradersConfig } from "@crewhaus/eval-grader";
import { type AgentInvoker, type EvalRunSummary, runEval } from "@crewhaus/eval-runner";
import { parseSpec } from "@crewhaus/spec";
import type { RunIndexEntry } from "./history";
import { runStatsOf, sampleRowsOf } from "./run-rows";

const TMP_ROOTS: string[] = [];
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function* yieldSamples(samples: readonly Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

/** A summary out of the real runner: fails, throws and abstains by sample id. */
async function realSummary(ids: readonly string[], repeats?: number): Promise<EvalRunSummary> {
  const outDir = mkdtempSync(join(tmpdir(), "crewhaus-run-rows-"));
  TMP_ROOTS.push(outDir);
  const ir = lower(
    parseSpec("name: rows\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: t\n"),
  );
  if (ir.target !== "cli") throw new Error("expected a cli spec");
  const calls = new Map<string, number>();
  const invoker: AgentInvoker = async ({ sample }) => {
    const n = calls.get(sample.id) ?? 0;
    calls.set(sample.id, n + 1);
    if (sample.id.startsWith("boom")) throw new Error("it broke");
    const wrong = sample.id.startsWith("no") || (sample.id.startsWith("flaky") && n % 2 === 1);
    return { agentOutput: wrong ? "wrong" : "yes", events: [] };
  };
  const { compiled } = parseGradersConfig("graders:\n  - name: exact\n    type: exact_match\n");
  const judge: CompiledGrader = {
    name: "judge",
    weight: 1,
    grader: async (sample) =>
      sample.id.startsWith("unsure")
        ? { passed: false, score: 0, rationale: "not enough to go on", abstained: true }
        : { passed: true, score: 1, rationale: "fine" },
  };
  return runEval({
    ir,
    dataset: {
      name: "rows",
      samples: yieldSamples(
        ids.map((id) => ({
          id,
          input: "q",
          expected_output: "yes",
          ...(id.startsWith("canary") ? { metadata: { source: "canary" } } : {}),
        })),
      ),
    },
    compiledGraders: [...compiled, judge],
    opts: {
      outDir,
      invoker,
      concurrency: 1,
      retryErrors: false,
      ...(repeats !== undefined ? { repeats } : {}),
    },
  });
}

const row = (overrides: Partial<RunIndexEntry> = {}): RunIndexEntry => ({
  runId: "run_a",
  specName: "rows",
  specHash: "h",
  datasetName: "rows",
  datasetHash: "d",
  passRate: 0.25,
  meanScore: 0.5,
  sampleCount: 4,
  ts: "2026-11-01T00:00:00.000Z",
  outDir: "/gone",
  ...overrides,
});

describe("a real summary", () => {
  test("every verdict, with its note and a score only where one means something", async () => {
    const ids = ["yes1", "no1", "boom1", "unsure1", "canary1"];
    const summary = await realSummary(ids);
    const rows = sampleRowsOf(summary, ids);
    expect(rows.map((r) => [r.sampleId, r.verdict])).toEqual([
      ["yes1", "pass"],
      ["no1", "fail"],
      ["boom1", "error"],
      ["unsure1", "abstained"],
      ["canary1", "canary"],
    ]);
    expect(rows.find((r) => r.verdict === "pass")?.score).toBe(1);
    expect(rows.find((r) => r.verdict === "fail")?.score).toBe(0.5);
    for (const verdict of ["error", "abstained", "canary"]) {
      expect(rows.find((r) => r.verdict === verdict)?.score).toBeNull();
    }
    expect(rows.find((r) => r.verdict === "error")?.note).toContain("it broke");
  }, 20_000); // loads the whole eval runner

  test("the figures come from aggregates and the counts from the samples", async () => {
    const summary = await realSummary(["yes1", "boom1", "unsure1", "canary1"]);
    expect(runStatsOf(summary)).toEqual({
      passRate: summary.aggregates.passRate,
      meanScore: summary.aggregates.meanScore,
      sampleCount: 4,
      errorCount: 1,
      measuredCount: 1,
      costUsd: null,
      partial: false,
      replayed: false,
      flakyCount: 0,
    });
  }, 20_000);

  test("cost comes from the index row alone, and absent is null, never zero", async () => {
    const summary = await realSummary(["yes1"]);
    expect(runStatsOf(summary, row()).costUsd).toBeNull();
    expect(runStatsOf(summary, row({ costUsd: 0.25 })).costUsd).toBe(0.25);
  }, 20_000);

  test("a flaky sample is marked, and its extra trial directory is not a row", async () => {
    const summary = await realSummary(["flaky1"], 2);
    expect(runStatsOf(summary).flakyCount).toBe(1);
    const rows = sampleRowsOf(summary, ["flaky1", "flaky1.trial2"]);
    expect(rows.map((r) => r.sampleId)).toEqual(["flaky1"]);
    expect(rows[0]?.flaky).toBe(true);
  }, 20_000);

  test("a sanitized id joins to the directory the runner really wrote", async () => {
    const summary = await realSummary(["yes/1"]);
    expect(sampleRowsOf(summary, ["yes_1"])).toEqual([
      expect.objectContaining({ sampleId: "yes/1", dir: "yes_1", verdict: "pass" }),
    ]);
  }, 20_000);

  test("a sample whose directory is not on the list gets no link", async () => {
    const summary = await realSummary(["yes1"]);
    expect(sampleRowsOf(summary, [])[0]?.dir).toBeNull();
  }, 20_000);

  test("a directory no record claims is still listed, with no result", async () => {
    const summary = await realSummary(["yes1"]);
    const rows = sampleRowsOf(summary, ["orphan", "yes1"]);
    expect(rows.map((r) => [r.sampleId, r.verdict])).toEqual([
      ["yes1", "pass"],
      ["orphan", "unknown"],
    ]);
  }, 20_000);
});

describe("partial and replayed", () => {
  test("partial is an object in results.json and a boolean on the row", () => {
    expect(runStatsOf({ partial: { reason: "budget_exhausted" } }).partial).toBe(true);
    expect(runStatsOf({}, row({ partial: true })).partial).toBe(true);
    expect(runStatsOf({}).partial).toBe(false);
  });

  test("replayed comes from the row or the recording mode, and only replay counts", () => {
    expect(runStatsOf({}, row({ replayed: true })).replayed).toBe(true);
    expect(runStatsOf({ config: { toolRecording: { mode: "replay" } } }).replayed).toBe(true);
    expect(runStatsOf({ config: { toolRecording: { mode: "record" } } }).replayed).toBe(false);
  });
});

describe("a shape no writer emits", () => {
  const fictional = {
    passRate: 0.9,
    meanScore: 0.9,
    sampleCount: 10,
    costUsd: 3,
    results: [{ sampleId: "a", pass: true, score: 1 }],
    samples: [{ sampleId: "a", pass: true, score: 1 }],
  };

  test("reads as nulls, not as a score", () => {
    expect(runStatsOf(fictional)).toEqual({
      passRate: null,
      meanScore: null,
      sampleCount: null,
      errorCount: null,
      measuredCount: null,
      costUsd: null,
      partial: false,
      replayed: false,
      flakyCount: 0,
    });
  });

  test("reads as no result, not as a pass", () => {
    expect(sampleRowsOf(fictional, ["a"])).toEqual([
      {
        sampleId: "a",
        dir: "a",
        verdict: "unknown",
        score: null,
        note: "",
        flaky: false,
        needsReview: false,
      },
    ]);
  });

  test("junk and a torn file leave the directories reachable, trials aside", () => {
    expect(runStatsOf(null).passRate).toBeNull();
    expect(sampleRowsOf(null, ["s1", "s1.trial2"]).map((r) => r.sampleId)).toEqual(["s1"]);
    expect(sampleRowsOf("junk", []).length).toBe(0);
  });

  test("an unreadable results file falls back to what the index row recorded", () => {
    const stats = runStatsOf(null, row({ errorCount: 1, measuredCount: 3, costUsd: 1 }));
    expect(stats).toMatchObject({
      passRate: 0.25,
      meanScore: 0.5,
      sampleCount: 4,
      errorCount: 1,
      measuredCount: 3,
      costUsd: 1,
    });
  });
});
