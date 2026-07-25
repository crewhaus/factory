import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { ReportError } from "./errors";
import {
  BASELINES_FILENAME,
  type BaselineEntry,
  INDEX_FILENAME,
  type RunIndexEntry,
  appendRunIndex,
  baselineKey,
  getBaseline,
  hashDatasetFile,
  readBaselines,
  readRunIndex,
  recordEvalRun,
  runIndexEntryFromSummary,
  setBaseline,
} from "./history";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-history-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function makeEntry(runId: string, overrides: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return {
    runId,
    specName: "concierge",
    specHash: "abc123",
    datasetName: "smoke",
    datasetHash: "d".repeat(64),
    passRate: 0.8,
    meanScore: 0.75,
    sampleCount: 5,
    ts: "2026-07-01T00:00:00.000Z",
    outDir: `/abs/evals/${runId}`,
    ...overrides,
  };
}

function makePin(runId: string, overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    specName: "concierge",
    datasetName: "smoke",
    runId,
    outDir: `/abs/evals/${runId}`,
    datasetHash: "d".repeat(64),
    ts: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("hashDatasetFile", () => {
  test("sha256 of the file bytes, stable across calls", () => {
    const dir = newTempRoot();
    const path = join(dir, "dataset.jsonl");
    const content = '{"id":"q1","input":"hi"}\n';
    writeFileSync(path, content);
    const expected = createHash("sha256").update(content).digest("hex");
    expect(hashDatasetFile(path)).toBe(expected);
    expect(hashDatasetFile(path)).toBe(expected);
  });

  test("different bytes produce different hashes", () => {
    const dir = newTempRoot();
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, '{"id":"q1"}\n');
    writeFileSync(b, '{"id":"q2"}\n');
    expect(hashDatasetFile(a)).not.toBe(hashDatasetFile(b));
  });
});

describe("run index (index.jsonl)", () => {
  test("append then read round-trips, oldest first", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    appendRunIndex(makeEntry("run_aaaa1111aaaa1111"), evalsDir);
    appendRunIndex(makeEntry("run_bbbb2222bbbb2222", { passRate: 1 }), evalsDir);
    const entries = readRunIndex(evalsDir);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.runId).toBe("run_aaaa1111aaaa1111");
    expect(entries[1]?.runId).toBe("run_bbbb2222bbbb2222");
    expect(entries[1]?.passRate).toBe(1);
    // One JSON object per line on disk.
    const raw = readFileSync(join(evalsDir, INDEX_FILENAME), "utf-8");
    expect(raw.trimEnd().split("\n")).toHaveLength(2);
  });

  test("gradersHash/judgeModel round-trip when present and stay absent when omitted", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    appendRunIndex(
      makeEntry("run_aaaa1111aaaa1111", {
        gradersHash: "g".repeat(64),
        judgeModel: "judge-model-x",
      }),
      evalsDir,
    );
    // A legacy-shaped entry (no instrument fields) in the same index.
    appendRunIndex(makeEntry("run_bbbb2222bbbb2222"), evalsDir);
    const [instrumented, legacy] = readRunIndex(evalsDir);
    expect(instrumented?.gradersHash).toBe("g".repeat(64));
    expect(instrumented?.judgeModel).toBe("judge-model-x");
    expect(legacy?.gradersHash).toBeUndefined();
    expect(legacy?.judgeModel).toBeUndefined();
  });

  test("C30 — p95LatencyMs/costUsd round-trip when present and stay absent when omitted", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    appendRunIndex(
      makeEntry("run_aaaa1111aaaa1111", { p95LatencyMs: 4200, costUsd: 0.0375 }),
      evalsDir,
    );
    // A legacy-shaped entry (no ops fields) in the same index.
    appendRunIndex(makeEntry("run_bbbb2222bbbb2222"), evalsDir);
    const [ops, legacy] = readRunIndex(evalsDir);
    expect(ops?.p95LatencyMs).toBe(4200);
    expect(ops?.costUsd).toBe(0.0375);
    expect(legacy?.p95LatencyMs).toBeUndefined();
    expect(legacy?.costUsd).toBeUndefined();
  });

  test("missing index file reads as empty", () => {
    expect(readRunIndex(join(newTempRoot(), "nope"))).toEqual([]);
  });

  test("corrupt/torn lines are skipped, valid lines survive", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    appendRunIndex(makeEntry("run_aaaa1111aaaa1111"), evalsDir);
    appendFileSync(join(evalsDir, INDEX_FILENAME), '{"runId":"run_torn\n');
    appendRunIndex(makeEntry("run_bbbb2222bbbb2222"), evalsDir);
    const entries = readRunIndex(evalsDir);
    expect(entries.map((e) => e.runId)).toEqual(["run_aaaa1111aaaa1111", "run_bbbb2222bbbb2222"]);
  });
});

function makeSampleResult(id: string, passed: boolean, retried = false): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:00:01.000Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 20 },
    model: "claude-opus-4-7",
    agentOutput: passed ? "correct" : "wrong",
    grades: {
      overall: { passed, score: passed ? 1 : 0, rationale: "" },
      perGrader: [],
    },
    ...(retried ? { retried: true } : {}),
  };
}

function makeSummary(
  samples: SampleResult[],
  config: Partial<EvalRunSummary["config"]> = {},
): EvalRunSummary {
  const scored = samples.length > 0 ? samples : [];
  return {
    runId: "run_cccc3333cccc3333",
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T00:00:30.000Z",
    samples,
    aggregates: {
      passRate:
        scored.length === 0
          ? 0
          : scored.filter((s) => s.grades.overall.passed).length / scored.length,
      meanScore:
        scored.length === 0
          ? 0
          : scored.reduce((n, s) => n + s.grades.overall.score, 0) / scored.length,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 10, output: 20 },
      errorCount: 0,
    },
    config: {
      specHash: "spec-hash-1",
      datasetName: "smoke",
      graderNames: ["exact"],
      model: "claude-opus-4-7",
      concurrency: 4,
      ...config,
    },
    outDir: "/abs/evals/run_cccc3333cccc3333",
  };
}

/**
 * Item 15 — the shared summary → index-entry recorder. `crewhaus eval` and
 * the standalone `target: eval` bundle both go through this, so one eval has
 * ONE history whichever way it was launched.
 */
describe("recordEvalRun / runIndexEntryFromSummary", () => {
  test("projects a summary onto the index entry the CLI records", () => {
    const entry = runIndexEntryFromSummary(
      makeSummary([makeSampleResult("a", true), makeSampleResult("b", false, true)]),
      {
        specName: "hello-eval",
        specSource: "/abs/specs/hello-eval.yaml",
        datasetHash: "d".repeat(64),
        outDir: "/abs/evals/run_cccc3333cccc3333",
      },
    );
    expect(entry).toEqual({
      runId: "run_cccc3333cccc3333",
      specName: "hello-eval",
      specHash: "spec-hash-1",
      specSource: "/abs/specs/hello-eval.yaml",
      datasetName: "smoke",
      datasetHash: "d".repeat(64),
      passRate: 0.5,
      meanScore: 0.5,
      sampleCount: 2,
      // C30's ops columns are derived here too, so the standalone bundle's
      // history entry carries them exactly as the CLI's does.
      p95LatencyMs: 100,
      retriedCount: 1,
      ts: "2026-07-01T00:00:30.000Z",
      outDir: "/abs/evals/run_cccc3333cccc3333",
    });
  });

  test("carries the run's measurement instrument, and omits what the run never pinned", () => {
    const instrumented = runIndexEntryFromSummary(
      makeSummary([makeSampleResult("a", true)], {
        gradersHash: "g".repeat(64),
        judgeModel: "judge-x",
      }),
      { specName: "s", datasetHash: "d".repeat(64), outDir: "/abs/run" },
    );
    expect(instrumented.gradersHash).toBe("g".repeat(64));
    expect(instrumented.judgeModel).toBe("judge-x");
    const bare = runIndexEntryFromSummary(makeSummary([makeSampleResult("a", true)]), {
      specName: "s",
      datasetHash: "d".repeat(64),
      outDir: "/abs/run",
    });
    expect(bare.gradersHash).toBeUndefined();
    expect(bare.judgeModel).toBeUndefined();
    expect(bare.specSource).toBeUndefined();
  });

  test("appends to index.jsonl so readRunIndex (and `eval-report history`) sees the run", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    expect(readRunIndex(evalsDir)).toHaveLength(0);
    const entry = recordEvalRun(makeSummary([makeSampleResult("a", true)]), {
      specName: "hello-eval",
      datasetHash: "d".repeat(64),
      outDir: "/abs/evals/run_cccc3333cccc3333",
      evalsDir,
    });
    const index = readRunIndex(evalsDir);
    expect(index).toHaveLength(1);
    expect(index[0]).toEqual(entry);
    expect(index[0]?.specName).toBe("hello-eval");
  });

  test("refuses a 0-sample run — nothing is written", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    expect(() =>
      recordEvalRun(makeSummary([]), {
        specName: "hello-eval",
        datasetHash: "d".repeat(64),
        outDir: "/abs/evals/run_cccc3333cccc3333",
        evalsDir,
      }),
    ).toThrow(/0-sample/);
    expect(readRunIndex(evalsDir)).toHaveLength(0);
  });
});

describe("baselines (baselines.json)", () => {
  test("getBaseline is undefined before any pin; missing file reads as {}", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    expect(readBaselines(evalsDir)).toEqual({});
    expect(getBaseline("concierge", "smoke", evalsDir)).toBeUndefined();
  });

  test("set then get round-trips, keyed by (spec, dataset)", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    setBaseline(makePin("run_aaaa1111aaaa1111"), evalsDir);
    setBaseline(makePin("run_bbbb2222bbbb2222", { datasetName: "full" }), evalsDir);
    expect(getBaseline("concierge", "smoke", evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
    expect(getBaseline("concierge", "full", evalsDir)?.runId).toBe("run_bbbb2222bbbb2222");
    expect(getBaseline("other-spec", "smoke", evalsDir)).toBeUndefined();
    expect(existsSync(join(evalsDir, BASELINES_FILENAME))).toBe(true);
  });

  test("re-pinning a key overwrites without touching other keys", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    setBaseline(makePin("run_aaaa1111aaaa1111"), evalsDir);
    setBaseline(makePin("run_cccc3333cccc3333", { datasetName: "full" }), evalsDir);
    setBaseline(makePin("run_bbbb2222bbbb2222"), evalsDir);
    expect(getBaseline("concierge", "smoke", evalsDir)?.runId).toBe("run_bbbb2222bbbb2222");
    expect(getBaseline("concierge", "full", evalsDir)?.runId).toBe("run_cccc3333cccc3333");
  });

  test("gradersHash/judgeModel round-trip on pins and stay absent when omitted", () => {
    const evalsDir = join(newTempRoot(), ".crewhaus", "evals");
    setBaseline(
      makePin("run_aaaa1111aaaa1111", { gradersHash: "g".repeat(64), judgeModel: "judge-model-x" }),
      evalsDir,
    );
    setBaseline(makePin("run_bbbb2222bbbb2222", { datasetName: "full" }), evalsDir);
    const instrumented = getBaseline("concierge", "smoke", evalsDir);
    expect(instrumented?.gradersHash).toBe("g".repeat(64));
    expect(instrumented?.judgeModel).toBe("judge-model-x");
    const legacy = getBaseline("concierge", "full", evalsDir);
    expect(legacy?.gradersHash).toBeUndefined();
    expect(legacy?.judgeModel).toBeUndefined();
  });

  test("malformed baselines.json throws ReportError", () => {
    const evalsDir = newTempRoot();
    writeFileSync(join(evalsDir, BASELINES_FILENAME), "{ not json,, }");
    expect(() => readBaselines(evalsDir)).toThrow(ReportError);
    expect(() => readBaselines(evalsDir)).toThrow(/failed to parse/);
  });

  test("baselineKey separates spec and dataset", () => {
    expect(baselineKey("a", "b")).toBe("a::b");
  });
});
