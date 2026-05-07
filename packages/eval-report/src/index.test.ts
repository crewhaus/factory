import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { ReportError, diffReports, loadRun, renderReport } from "./index";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-report-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function makeSampleResult(id: string, passed: boolean, score: number): SampleResult {
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

function makeRunSummary(runId: string, samples: SampleResult[]): EvalRunSummary {
  return {
    runId,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:30Z",
    samples,
    aggregates: {
      passRate: samples.filter((s) => s.grades.overall.passed).length / samples.length,
      meanScore: samples.reduce((s, x) => s + x.grades.overall.score, 0) / samples.length,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 100,
      totalTokens: { input: 10 * samples.length, output: 20 * samples.length },
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
  };
}

function persistRun(dir: string, summary: EvalRunSummary): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "results.json"), JSON.stringify(summary, null, 2));
  for (const s of summary.samples) {
    const sd = join(dir, s.sampleId);
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, "transcript.jsonl"), "");
    writeFileSync(join(sd, "events.jsonl"), "");
    writeFileSync(join(sd, "grades.json"), JSON.stringify(s.grades));
    writeFileSync(join(sd, "meta.json"), JSON.stringify({ sampleId: s.sampleId }));
  }
}

describe("loadRun (T1)", () => {
  test("loads from filesystem path", async () => {
    const dir = newTempRoot();
    const summary = makeRunSummary("run_aaaa1111aaaa1111", [
      makeSampleResult("s1", true, 1),
      makeSampleResult("s2", false, 0),
    ]);
    persistRun(dir, summary);
    const loaded = await loadRun(dir);
    expect(loaded.summary.samples).toHaveLength(2);
    expect(loaded.perSample["s1"]?.grades).toContain("passed");
  });

  test("rejects missing results.json", async () => {
    const dir = newTempRoot();
    await expect(loadRun(dir)).rejects.toThrow(ReportError);
  });
});

describe("renderReport (T1)", () => {
  test("renders sample table + drill-down", async () => {
    const dir = newTempRoot();
    const summary = makeRunSummary("run_aaaa1111aaaa1111", [
      makeSampleResult("s1", true, 1),
      makeSampleResult("s2", false, 0.3),
    ]);
    persistRun(dir, summary);
    const loaded = await loadRun(dir);
    const out = renderReport(loaded);
    expect(out.html).toContain("Eval run");
    expect(out.html).toContain("run_aaaa1111aaaa1111");
    expect(out.html).toContain("s1");
    expect(out.html).toContain("s2");
    expect(out.html).toContain("PASS");
    expect(out.html).toContain("FAIL");
    expect(out.html).toContain("Pass rate");
    expect(out.html).toMatch(/data-sortable/);
    expect(out.json).toContain('"runId"');
  });

  test("escapes HTML in agent output", async () => {
    const dir = newTempRoot();
    const malicious = makeSampleResult("xss", true, 1);
    const evil = { ...malicious, agentOutput: "<script>alert('pwn')</script>" };
    const summary = makeRunSummary("run_aaaa1111aaaa1111", [evil]);
    persistRun(dir, summary);
    const loaded = await loadRun(dir);
    const out = renderReport(loaded);
    expect(out.html).not.toContain("<script>alert('pwn')");
    expect(out.html).toContain("&lt;script&gt;");
  });
});

describe("diffReports (T1)", () => {
  test("highlights pass→fail and fail→pass flips", async () => {
    const prevDir = newTempRoot();
    const nextDir = newTempRoot();
    const prev = makeRunSummary("run_aaaa1111aaaa1111", [
      makeSampleResult("a", true, 1),
      makeSampleResult("b", false, 0),
      makeSampleResult("c", true, 1),
    ]);
    const next = makeRunSummary("run_bbbb2222bbbb2222", [
      makeSampleResult("a", false, 0), // regression
      makeSampleResult("b", true, 1), // recovery
      makeSampleResult("c", true, 1), // unchanged
    ]);
    persistRun(prevDir, prev);
    persistRun(nextDir, next);
    const prevLoaded = await loadRun(prevDir);
    const nextLoaded = await loadRun(nextDir);
    const result = diffReports(prevLoaded, nextLoaded);
    expect(result.diff.regressions).toHaveLength(1);
    expect(result.diff.regressions[0]?.sampleId).toBe("a");
    expect(result.diff.recoveries).toHaveLength(1);
    expect(result.diff.recoveries[0]?.sampleId).toBe("b");
    expect(result.diff.unchanged).toBe(1);
    expect(result.html).toContain("Regressions");
    expect(result.html).toContain("Recoveries");
  });

  test("rejects mismatched sample sets", async () => {
    const prevDir = newTempRoot();
    const nextDir = newTempRoot();
    const prev = makeRunSummary("run_aaaa1111aaaa1111", [
      makeSampleResult("a", true, 1),
      makeSampleResult("b", false, 0),
    ]);
    const next = makeRunSummary("run_bbbb2222bbbb2222", [
      makeSampleResult("a", true, 1),
      makeSampleResult("c", true, 1),
    ]);
    persistRun(prevDir, prev);
    persistRun(nextDir, next);
    const prevLoaded = await loadRun(prevDir);
    const nextLoaded = await loadRun(nextDir);
    expect(() => diffReports(prevLoaded, nextLoaded)).toThrow(/dataset shape mismatch/);
  });

  test("score shifts above ε are flagged", async () => {
    const prevDir = newTempRoot();
    const nextDir = newTempRoot();
    const prev = makeRunSummary("run_aaaa1111aaaa1111", [makeSampleResult("a", true, 0.4)]);
    const next = makeRunSummary("run_bbbb2222bbbb2222", [makeSampleResult("a", true, 0.7)]);
    persistRun(prevDir, prev);
    persistRun(nextDir, next);
    const prevLoaded = await loadRun(prevDir);
    const nextLoaded = await loadRun(nextDir);
    const result = diffReports(prevLoaded, nextLoaded);
    expect(result.diff.scoreShifts).toHaveLength(1);
  });
});
