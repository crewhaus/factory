/**
 * Unit tests for the post-eval run-history orchestration (index append,
 * auto-baseline diff, gate exit mapping, promote/no-promote). Fabricated
 * `EvalRunSummary` runs are persisted as `results.json` so `loadRun` works;
 * no LLM/credentials needed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBaseline, readRunIndex } from "@crewhaus/eval-report";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { finishEvalRun, gateRuns } from "./eval-history";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-eval-history-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function makeSample(id: string, passed: boolean, score: number): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:00:01Z",
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

function makeSummary(
  runId: string,
  samples: SampleResult[],
  outDir: string,
  p95LatencyMs = 100,
): EvalRunSummary {
  return {
    runId,
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:00:30Z",
    samples,
    aggregates: {
      passRate: samples.filter((s) => s.grades.overall.passed).length / samples.length,
      meanScore: samples.reduce((sum, s) => sum + s.grades.overall.score, 0) / samples.length,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs,
      totalTokens: { input: 10 * samples.length, output: 20 * samples.length },
      errorCount: 0,
    },
    config: {
      specHash: "abc123",
      datasetName: "smoke",
      datasetHash: "d".repeat(64),
      graderNames: ["exact"],
      model: "claude-opus-4-7",
      concurrency: 4,
    },
    outDir,
  };
}

/** Persist a fabricated run so `loadRun(outDir)` succeeds. */
function persistRun(summary: EvalRunSummary): void {
  mkdirSync(summary.outDir, { recursive: true });
  writeFileSync(join(summary.outDir, "results.json"), JSON.stringify(summary, null, 2));
}

type Ctx = {
  root: string;
  evalsDir: string;
  lines: string[];
  write: (line: string) => void;
};

function newCtx(): Ctx {
  const root = newTempRoot();
  const lines: string[] = [];
  return {
    root,
    evalsDir: join(root, ".crewhaus", "evals"),
    lines,
    write: (line) => lines.push(line),
  };
}

function makeRun(ctx: Ctx, runId: string, samples: SampleResult[], p95LatencyMs = 100) {
  const summary = makeSummary(runId, samples, join(ctx.root, runId), p95LatencyMs);
  persistRun(summary);
  return summary;
}

async function finish(
  ctx: Ctx,
  summary: EvalRunSummary,
  opts: { gateRequested?: boolean; promote?: boolean; datasetHash?: string } = {},
) {
  return finishEvalRun({
    summary,
    specName: "concierge",
    datasetHash: opts.datasetHash ?? "d".repeat(64),
    outDir: summary.outDir,
    gateRequested: opts.gateRequested ?? false,
    promote: opts.promote ?? true,
    evalsDir: ctx.evalsDir,
    write: ctx.write,
  });
}

describe("finishEvalRun — index + baseline lifecycle", () => {
  test("first run appends an index entry and pins the baseline", async () => {
    const ctx = newCtx();
    const run = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    const result = await finish(ctx, run);
    expect(result.gateFailed).toBe(false);

    const index = readRunIndex(ctx.evalsDir);
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({
      runId: "run_aaaa1111aaaa1111",
      specName: "concierge",
      specHash: "abc123",
      datasetName: "smoke",
      datasetHash: "d".repeat(64),
      passRate: 1,
      sampleCount: 1,
      ts: "2026-07-01T00:00:30Z",
      outDir: run.outDir,
    });
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
    expect(ctx.lines.join("\n")).toContain("baseline set: run_aaaa1111aaaa1111");
  });

  test("first run with --no-promote records the index but pins nothing", async () => {
    const ctx = newCtx();
    const run = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    const result = await finish(ctx, run, { promote: false });
    expect(result.gateFailed).toBe(false);
    expect(readRunIndex(ctx.evalsDir)).toHaveLength(1);
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)).toBeUndefined();
    expect(ctx.lines.join("\n")).toContain("--no-promote");
  });

  test("gate pass auto-promotes the new run to baseline", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [
      makeSample("a", true, 1),
      makeSample("b", false, 0),
    ]);
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [
      makeSample("a", true, 1),
      makeSample("b", true, 1), // recovery
    ]);
    const result = await finish(ctx, next, { gateRequested: true });
    expect(result.gateFailed).toBe(false);
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_bbbb2222bbbb2222");
    const out = ctx.lines.join("\n");
    expect(out).toContain("vs baseline run_aaaa1111aaaa1111");
    expect(out).toContain("recoveries=1");
    expect(out).toContain("gate: PASS");
    expect(readRunIndex(ctx.evalsDir)).toHaveLength(2);
  });

  test("gate pass with --no-promote keeps the old pin", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)]);
    const result = await finish(ctx, next, { promote: false });
    expect(result.gateFailed).toBe(false);
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
    expect(ctx.lines.join("\n")).toContain("baseline kept: run_aaaa1111aaaa1111 (--no-promote)");
  });

  test("regression fails the gate, never promotes, and maps to exit when --gate", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [
      makeSample("a", true, 1),
      makeSample("b", true, 1),
    ]);
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [
      makeSample("a", true, 1),
      makeSample("b", false, 0), // regression
    ]);
    const result = await finish(ctx, next, { gateRequested: true });
    expect(result.gateFailed).toBe(true);
    expect(result.gateReason).toMatch(/pass-rate dropped/);
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
    const out = ctx.lines.join("\n");
    expect(out).toContain("gate: FAIL");
    expect(out).toContain("regression: b");
  });

  test("regression without --gate still keeps the baseline but exits clean", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", false, 0)]);
    const result = await finish(ctx, next, { gateRequested: false });
    expect(result.gateFailed).toBe(false);
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
    expect(ctx.lines.join("\n")).toContain("gate: FAIL");
  });

  test("sampleId keyset mismatch starts a new baseline lineage (no gate failure)", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [
      makeSample("a", true, 1),
      makeSample("b", true, 1),
    ]);
    await finish(ctx, prev);
    // Dataset changed: sample "b" replaced by "c", and it fails — a naive
    // diff/gate would either throw or flag a regression.
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [
      makeSample("a", true, 1),
      makeSample("c", false, 0),
    ]);
    const result = await finish(ctx, next, { gateRequested: true, datasetHash: "e".repeat(64) });
    expect(result.gateFailed).toBe(false);
    expect(ctx.lines.join("\n")).toContain("dataset changed — starting new baseline lineage");
    const pin = getBaseline("concierge", "smoke", ctx.evalsDir);
    expect(pin?.runId).toBe("run_bbbb2222bbbb2222");
    expect(pin?.datasetHash).toBe("e".repeat(64));
  });

  test("keyset mismatch with --no-promote leaves the old pin untouched", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("z", true, 1)]);
    const result = await finish(ctx, next, { promote: false });
    expect(result.gateFailed).toBe(false);
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
  });

  test("unreadable baseline dir starts a new lineage instead of crashing", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, prev);
    rmSync(prev.outDir, { recursive: true, force: true });
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)]);
    const result = await finish(ctx, next, { gateRequested: true });
    expect(result.gateFailed).toBe(false);
    expect(ctx.lines.join("\n")).toContain("starting new baseline lineage");
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_bbbb2222bbbb2222");
  });
});

describe("gateRuns — strict defaults", () => {
  const out = "/unused";

  test("identical or improved runs pass", () => {
    const prev = makeSummary("run_aaaa1111aaaa1111", [makeSample("a", true, 1)], out);
    const next = makeSummary("run_bbbb2222bbbb2222", [makeSample("a", true, 1)], out);
    expect(gateRuns(prev, next).verdict).toBe("pass");
  });

  test("any pass-rate drop fails (threshold 0)", () => {
    const prev = makeSummary(
      "run_aaaa1111aaaa1111",
      Array.from({ length: 20 }, (_, i) => makeSample(`s${i}`, true, 1)),
      out,
    );
    // One flip out of 20 = a 5% drop — inside regression-runner's default
    // 0.05 threshold, but the strict gate must still fail it.
    const next = makeSummary(
      "run_bbbb2222bbbb2222",
      Array.from({ length: 20 }, (_, i) => makeSample(`s${i}`, i !== 0, i === 0 ? 0 : 1)),
      out,
    );
    const verdict = gateRuns(prev, next);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.reason).toMatch(/pass-rate dropped/);
  });

  test("sample regression hidden by a flat pass rate still fails", () => {
    const prev = makeSummary(
      "run_aaaa1111aaaa1111",
      [makeSample("a", true, 1), makeSample("b", false, 0)],
      out,
    );
    const next = makeSummary(
      "run_bbbb2222bbbb2222",
      [makeSample("a", false, 0), makeSample("b", true, 1)],
      out,
    );
    const verdict = gateRuns(prev, next);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.reason).toContain("a");
    expect(verdict.report.regressions).toHaveLength(1);
    expect(verdict.report.recoveries).toHaveLength(1);
  });

  test("keeps regression-runner's p95 latency default (+5000ms fails)", () => {
    const prev = makeSummary("run_aaaa1111aaaa1111", [makeSample("a", true, 1)], out, 100);
    const next = makeSummary("run_bbbb2222bbbb2222", [makeSample("a", true, 1)], out, 6000);
    const verdict = gateRuns(prev, next);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.reason).toMatch(/latency/);
  });

  test("caller can loosen thresholds", () => {
    const prev = makeSummary("run_aaaa1111aaaa1111", [makeSample("a", true, 1)], out, 100);
    const next = makeSummary("run_bbbb2222bbbb2222", [makeSample("a", true, 1)], out, 6000);
    expect(gateRuns(prev, next, { latencyThreshold: 10_000 }).verdict).toBe("pass");
  });
});
