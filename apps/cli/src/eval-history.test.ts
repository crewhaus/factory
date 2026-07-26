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
import {
  abstainedSampleIds,
  costGateReason,
  datasetFilterMatches,
  finishEvalRun,
  gateRuns,
} from "./eval-history";

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
  config: Partial<EvalRunSummary["config"]> = {},
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
      ...config,
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
  warnings: string[];
  warn: (line: string) => void;
};

function newCtx(): Ctx {
  const root = newTempRoot();
  const lines: string[] = [];
  const warnings: string[] = [];
  return {
    root,
    evalsDir: join(root, ".crewhaus", "evals"),
    lines,
    write: (line) => lines.push(line),
    warnings,
    warn: (line) => warnings.push(line),
  };
}

function makeRun(
  ctx: Ctx,
  runId: string,
  samples: SampleResult[],
  config: Partial<EvalRunSummary["config"]> = {},
  p95LatencyMs = 100,
) {
  const summary = makeSummary(runId, samples, join(ctx.root, runId), p95LatencyMs, config);
  persistRun(summary);
  return summary;
}

async function finish(
  ctx: Ctx,
  summary: EvalRunSummary,
  opts: {
    gateRequested?: boolean;
    promote?: boolean;
    datasetHash?: string;
    specSource?: string;
    costUsd?: number;
    agentCostUsd?: number;
    judgeCostUsd?: number;
    maxP95LatencyMs?: number;
    maxCostUsd?: number;
  } = {},
) {
  return finishEvalRun({
    summary,
    specName: "concierge",
    ...(opts.specSource !== undefined ? { specSource: opts.specSource } : {}),
    datasetHash: opts.datasetHash ?? "d".repeat(64),
    outDir: summary.outDir,
    gateRequested: opts.gateRequested ?? false,
    promote: opts.promote ?? true,
    evalsDir: ctx.evalsDir,
    write: ctx.write,
    warn: ctx.warn,
    ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
    ...(opts.agentCostUsd !== undefined ? { agentCostUsd: opts.agentCostUsd } : {}),
    ...(opts.judgeCostUsd !== undefined ? { judgeCostUsd: opts.judgeCostUsd } : {}),
    ...(opts.maxP95LatencyMs !== undefined ? { maxP95LatencyMs: opts.maxP95LatencyMs } : {}),
    ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
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

describe("finishEvalRun — spec-source collision detection", () => {
  test("records specSource on the index entry and baseline pin", async () => {
    const ctx = newCtx();
    const run = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, run, { specSource: "/repo/billing/crewhaus.yaml" });
    expect(readRunIndex(ctx.evalsDir)[0]?.specSource).toBe("/repo/billing/crewhaus.yaml");
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.specSource).toBe(
      "/repo/billing/crewhaus.yaml",
    );
  });

  test("a DIFFERENT spec file sharing the name warns but still gates", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, prev, { specSource: "/repo/billing/crewhaus.yaml" });
    // A different spec file, same `name:` (concierge) and dataset (smoke).
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)]);
    const result = await finish(ctx, next, {
      gateRequested: true,
      specSource: "/repo/support/crewhaus.yaml",
    });
    expect(result.gateFailed).toBe(false);
    const warned = ctx.warnings.join("\n");
    expect(warned).toContain("pinned by a different spec file");
    expect(warned).toContain("/repo/billing/crewhaus.yaml");
    expect(warned).toContain("/repo/support/crewhaus.yaml");
    // The lineage is NOT re-keyed — the gate still ran against the pin.
    expect(ctx.lines.join("\n")).toContain("vs baseline run_aaaa1111aaaa1111");
  });

  test("the SAME spec file, edited (same path), does NOT warn — that IS the gate", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, prev, { specSource: "/repo/billing/crewhaus.yaml" });
    // Same path (an instruction edit changes specHash, not the source path).
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)]);
    await finish(ctx, next, { specSource: "/repo/billing/crewhaus.yaml" });
    expect(ctx.warnings.join("\n")).not.toContain("different spec file");
  });

  test("no warning when the baseline lacks specSource (older CLI pinned it)", async () => {
    const ctx = newCtx();
    // Baseline pinned by an old CLI (no specSource recorded).
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)]);
    await finish(ctx, next, { specSource: "/repo/support/crewhaus.yaml" });
    expect(ctx.warnings.join("\n")).not.toContain("different spec file");
  });

  test("no warning when THIS run lacks specSource but the baseline has one", async () => {
    // The symmetric back-compat direction (guard 1): a caller that doesn't
    // pass specSource must never trip the warning, even against a pin that
    // recorded one.
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, prev, { specSource: "/repo/billing/crewhaus.yaml" });
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)]);
    await finish(ctx, next); // no specSource
    expect(ctx.warnings.join("\n")).not.toContain("different spec file");
  });
});

describe("finishEvalRun — measurement-instrument guard (NEW-HUNT-1)", () => {
  test("records gradersHash/judgeModel on the index entry and baseline pin", async () => {
    const ctx = newCtx();
    const run = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)], {
      gradersHash: "g-hash-1",
      judgeModel: "judge-model-a",
    });
    await finish(ctx, run);
    expect(readRunIndex(ctx.evalsDir)[0]).toMatchObject({
      gradersHash: "g-hash-1",
      judgeModel: "judge-model-a",
    });
    const pin = getBaseline("concierge", "smoke", ctx.evalsDir);
    expect(pin?.gradersHash).toBe("g-hash-1");
    expect(pin?.judgeModel).toBe("judge-model-a");
  });

  test("a gradersHash change vs the pinned baseline warns and starts a new lineage", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)], {
      gradersHash: "g-hash-1",
    });
    await finish(ctx, prev);
    // Same dataset/keyset, but the rubric changed AND the sample now fails —
    // a naive gate would blame the agent for the stricter rubric.
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", false, 0)], {
      gradersHash: "g-hash-2",
    });
    const result = await finish(ctx, next, { gateRequested: true });
    expect(result.gateFailed).toBe(false);
    const warned = ctx.warnings.join("\n");
    expect(warned).toContain("measurement instrument changed");
    expect(warned).toContain("g-hash-1 → g-hash-2");
    expect(ctx.lines.join("\n")).toContain("graders/judge changed — starting new baseline lineage");
    const pin = getBaseline("concierge", "smoke", ctx.evalsDir);
    expect(pin?.runId).toBe("run_bbbb2222bbbb2222");
    expect(pin?.gradersHash).toBe("g-hash-2");
  });

  test("a judgeModel change vs the pinned baseline warns and starts a new lineage", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)], {
      gradersHash: "g-hash-1",
      judgeModel: "judge-model-a",
    });
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", false, 0)], {
      gradersHash: "g-hash-1",
      judgeModel: "judge-model-b",
    });
    const result = await finish(ctx, next, { gateRequested: true });
    expect(result.gateFailed).toBe(false);
    const warned = ctx.warnings.join("\n");
    expect(warned).toContain("judge-model-a → judge-model-b");
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.judgeModel).toBe("judge-model-b");
  });

  test("instrument mismatch with --no-promote warns but keeps the old pin", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)], {
      gradersHash: "g-hash-1",
    });
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)], {
      gradersHash: "g-hash-2",
    });
    const result = await finish(ctx, next, { promote: false });
    expect(result.gateFailed).toBe(false);
    expect(ctx.warnings.join("\n")).toContain("measurement instrument changed");
    expect(ctx.lines.join("\n")).toContain("--no-promote");
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
  });

  test("a hash-less legacy baseline gates exactly as before (no warning)", async () => {
    const ctx = newCtx();
    // Baseline pinned by an old CLI — no instrument fields recorded.
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", false, 0)], {
      gradersHash: "g-hash-2",
      judgeModel: "judge-model-b",
    });
    const result = await finish(ctx, next, { gateRequested: true });
    expect(result.gateFailed).toBe(true);
    expect(ctx.warnings.join("\n")).not.toContain("measurement instrument");
    expect(ctx.lines.join("\n")).toContain("vs baseline run_aaaa1111aaaa1111");
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
  });

  test("a run without hashes never trips the guard against a hash-carrying pin", async () => {
    // The symmetric back-compat direction: a summary recorded without the
    // fields must gate normally even against a pin that carries them.
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)], {
      gradersHash: "g-hash-1",
      judgeModel: "judge-model-a",
    });
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)]);
    const result = await finish(ctx, next);
    expect(result.gateFailed).toBe(false);
    expect(ctx.warnings.join("\n")).not.toContain("measurement instrument");
    expect(ctx.lines.join("\n")).toContain("gate: PASS");
  });

  test("an unchanged instrument gates normally — genuine regressions still fail", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)], {
      gradersHash: "g-hash-1",
      judgeModel: "judge-model-a",
    });
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", false, 0)], {
      gradersHash: "g-hash-1",
      judgeModel: "judge-model-a",
    });
    const result = await finish(ctx, next, { gateRequested: true });
    expect(result.gateFailed).toBe(true);
    expect(ctx.warnings.join("\n")).not.toContain("measurement instrument");
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
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

  test("F7: latency is NOT gated by default — the gate is pass-rate/flip-only, as documented", () => {
    // Pre-fix this inherited regression-runner's +5000ms p95 default and
    // failed runs the --gate help text said would pass.
    const prev = makeSummary("run_aaaa1111aaaa1111", [makeSample("a", true, 1)], out, 100);
    const next = makeSummary("run_bbbb2222bbbb2222", [makeSample("a", true, 1)], out, 60_000);
    expect(gateRuns(prev, next).verdict).toBe("pass");
  });

  test("caller can still opt INTO latency gating with an explicit threshold", () => {
    const prev = makeSummary("run_aaaa1111aaaa1111", [makeSample("a", true, 1)], out, 100);
    const next = makeSummary("run_bbbb2222bbbb2222", [makeSample("a", true, 1)], out, 6000);
    const verdict = gateRuns(prev, next, { latencyThreshold: 5000 });
    expect(verdict.verdict).toBe("fail");
    expect(verdict.reason).toMatch(/latency/);
    expect(gateRuns(prev, next, { latencyThreshold: 10_000 }).verdict).toBe("pass");
  });
});

/** A3 — an abstained sample result: placeholders + the abstained flag. */
function makeAbstained(id: string): SampleResult {
  const base = makeSample(id, false, 0);
  return {
    ...base,
    grades: {
      overall: { passed: false, score: 0, rationale: "judge abstained", abstained: true },
      perGrader: [
        { name: "quality", passed: false, score: 0, rationale: "abstain", abstained: true },
      ],
    },
  };
}

/** Patch a summary's aggregates the way the runner would for abstention:
 *  abstained samples leave the pass-rate denominator + fill needsHuman. */
function withAbstainAggregates(summary: EvalRunSummary): EvalRunSummary {
  const abstained = summary.samples.filter((s) => s.grades.overall.abstained === true);
  const graded = summary.samples.length - abstained.length;
  const passed = summary.samples.filter((s) => s.grades.overall.passed).length;
  return {
    ...summary,
    aggregates: {
      ...summary.aggregates,
      passRate: graded === 0 ? 0 : passed / graded,
      ...(abstained.length > 0
        ? {
            needsHuman: abstained.length,
            needsHumanSampleIds: abstained.map((s) => s.sampleId),
          }
        : {}),
    },
  };
}

describe("gateRuns — abstained samples leave the flip comparison (A3)", () => {
  const out = "/unused";

  test("abstainedSampleIds unions both runs; old records contribute nothing", () => {
    const prev = makeSummary("run_aaaa1111aaaa1111", [makeSample("a", true, 1)], out);
    const next = makeSummary(
      "run_bbbb2222bbbb2222",
      [makeSample("a", true, 1), makeAbstained("b")],
      out,
    );
    expect([...abstainedSampleIds(prev, next)]).toEqual(["b"]);
    expect(abstainedSampleIds(prev, prev).size).toBe(0);
  });

  test("pass → abstained is NOT a regression: the gate passes", () => {
    const prev = makeSummary(
      "run_aaaa1111aaaa1111",
      [makeSample("a", true, 1), makeSample("b", true, 1)],
      out,
    );
    const next = withAbstainAggregates(
      makeSummary("run_bbbb2222bbbb2222", [makeSample("a", true, 1), makeAbstained("b")], out),
    );
    const verdict = gateRuns(prev, next);
    expect(verdict.verdict).toBe("pass");
    expect(verdict.report.regressions).toHaveLength(0);
  });

  test("abstained in the PREV run is excluded the same way", () => {
    const prev = withAbstainAggregates(
      makeSummary("run_aaaa1111aaaa1111", [makeSample("a", true, 1), makeAbstained("b")], out),
    );
    // b now honestly fails — but its baseline verdict was UNKNOWN, so this
    // is not a flip the gate may count.
    const next = withAbstainAggregates(
      makeSummary(
        "run_bbbb2222bbbb2222",
        [makeSample("a", true, 1), makeSample("b", false, 0)],
        out,
      ),
    );
    // Both sides' recorded pass rates are 1/1 vs 1/2 — the pass-RATE
    // criterion still sees the honest drop and fails; the flip list must
    // still exclude b.
    const verdict = gateRuns(prev, next);
    expect(verdict.report.regressions).toHaveLength(0);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.reason).toMatch(/pass-rate dropped/);
  });

  test("a REAL regression beside an abstained sample still fails on the flip", () => {
    const prev = makeSummary(
      "run_aaaa1111aaaa1111",
      [makeSample("a", true, 1), makeSample("b", true, 1), makeSample("c", false, 0)],
      out,
    );
    const next = withAbstainAggregates(
      makeSummary(
        "run_bbbb2222bbbb2222",
        [makeSample("a", false, 0), makeAbstained("b"), makeSample("c", true, 1)],
        out,
      ),
    );
    const verdict = gateRuns(prev, next);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.report.regressions.map((r) => r.sampleId)).toEqual(["a"]);
  });
});

describe("finishEvalRun — abstained exclusion note (A3)", () => {
  test("says which samples were excluded from the flip comparison, then gates", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [
      makeSample("a", true, 1),
      makeSample("b", true, 1),
    ]);
    await finish(ctx, prev);

    const next = withAbstainAggregates(
      makeSummary(
        "run_bbbb2222bbbb2222",
        [makeSample("a", true, 1), makeAbstained("b")],
        join(ctx.root, "run_bbbb2222bbbb2222"),
      ),
    );
    persistRun(next);
    const result = await finish(ctx, next, { gateRequested: true });
    expect(result.gateFailed).toBe(false);
    const output = ctx.lines.join("\n");
    expect(output).toContain("excluding 1 abstained sample(s) from the flip comparison: [b]");
    expect(output).toContain("[eval] gate: PASS");
  });
});

describe("finishEvalRun — retried count + zero-sample belt (F12 / F6)", () => {
  test("F12: the index entry records how many samples were retried", async () => {
    const ctx = newCtx();
    const samples: SampleResult[] = [
      makeSample("a", true, 1),
      { ...makeSample("b", true, 1), retried: true },
      { ...makeSample("c", false, 0), retried: true },
    ];
    const run = makeRun(ctx, "run_aaaa1111aaaa1111", samples);
    await finish(ctx, run);
    const index = readRunIndex(ctx.evalsDir);
    expect(index).toHaveLength(1);
    expect(index[0]?.retriedCount).toBe(2);
  });

  test("F12: no retries → retriedCount 0", async () => {
    const ctx = newCtx();
    const run = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, run);
    expect(readRunIndex(ctx.evalsDir)[0]?.retriedCount).toBe(0);
  });

  test("F6 belt: a 0-sample run throws loudly and records NOTHING (no index entry, no baseline)", async () => {
    const ctx = newCtx();
    const summary = makeSummary("run_zero000000000000", [], join(ctx.root, "run-zero"));
    persistRun(summary);
    await expect(finish(ctx, summary)).rejects.toThrow(/0-sample/);
    expect(readRunIndex(ctx.evalsDir)).toHaveLength(0);
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)).toBeUndefined();
  });
});

describe("finishEvalRun — C30 latency/cost gate thresholds + additive ops fields", () => {
  test("index entry + baseline pin record p95LatencyMs and costUsd (additive)", async () => {
    const ctx = newCtx();
    const run = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)], {}, 350);
    await finish(ctx, run, { costUsd: 1.25 });
    const entry = readRunIndex(ctx.evalsDir)[0];
    expect(entry?.p95LatencyMs).toBe(350);
    expect(entry?.costUsd).toBe(1.25);
    const pin = getBaseline("concierge", "smoke", ctx.evalsDir);
    expect(pin?.p95LatencyMs).toBe(350);
    expect(pin?.costUsd).toBe(1.25);
  });

  test("C35 — the gated cost is the TOTAL, with the halves recorded beside it", async () => {
    // The failure this closes: a judge-heavy run printed `total=$4.10` and
    // still passed `--max-cost-usd 2.00`, because the gate only ever saw the
    // agent half — and history pinned the agent half forever.
    const ctx = newCtx();
    // The cost ceiling is checked on the baseline-comparison path, so pin one.
    const first = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, first);
    const run = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)]);
    const gated = await finish(ctx, run, {
      gateRequested: true,
      costUsd: 4.1,
      agentCostUsd: 1.8,
      judgeCostUsd: 2.3,
      maxCostUsd: 2,
    });
    expect(gated.gateFailed).toBe(true);
    expect(gated.gateReason).toMatch(/\$4\.1000 exceeded --max-cost-usd \$2\.0000/);
    const entry = readRunIndex(ctx.evalsDir).find((e) => e.runId === "run_bbbb2222bbbb2222");
    expect(entry?.costUsd).toBe(4.1);
    expect(entry?.agentCostUsd).toBe(1.8);
    expect(entry?.judgeCostUsd).toBe(2.3);
  });

  test("NEW-HUNT-4 — pinning a cassette-REPLAYED run warns at the pin", async () => {
    const ctx = newCtx();
    const run = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)], {
      toolRecording: { mode: "replay", dir: "/abs/cassette", recordingHash: "h".repeat(64) },
    });
    await finish(ctx, run);
    // Still pinnable (a replayed run is a real, reproducible measurement) —
    // but never silently: later LIVE runs would be gated against frozen
    // tool results, and only run.json used to know.
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
    expect(ctx.warnings.join("\n")).toContain("pinning a REPLAYED run");
    expect(ctx.warnings.join("\n")).toContain("/abs/cassette");
    // …and the index entry says so too, so `eval-report history` can mark it.
    expect(readRunIndex(ctx.evalsDir)[0]?.replayed).toBe(true);
  });

  test("a LIVE run neither warns nor gains the replayed marker", async () => {
    const ctx = newCtx();
    const run = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, run);
    expect(ctx.warnings.join("\n")).not.toContain("REPLAYED");
    const entry = readRunIndex(ctx.evalsDir)[0];
    expect(entry !== undefined && "replayed" in entry).toBe(false);
  });

  test("unknown cost records no costUsd field (tolerant of absence)", async () => {
    const ctx = newCtx();
    const run = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, run);
    const entry = readRunIndex(ctx.evalsDir)[0];
    expect(entry !== undefined && "costUsd" in entry).toBe(false);
    const pin = getBaseline("concierge", "smoke", ctx.evalsDir);
    expect(pin !== undefined && "costUsd" in pin).toBe(false);
  });

  test("--max-p95-latency-ms fails the gate when p95 rose past it — and passes inside it", async () => {
    // Fail side of the line: rise of 400ms > threshold 300ms.
    const ctxA = newCtx();
    const prevA = makeRun(ctxA, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)], {}, 100);
    await finish(ctxA, prevA);
    const nextA = makeRun(ctxA, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)], {}, 500);
    const failed = await finish(ctxA, nextA, { gateRequested: true, maxP95LatencyMs: 300 });
    expect(failed.gateFailed).toBe(true);
    expect(failed.gateReason).toMatch(/latency/);
    // Fail → never promote.
    expect(getBaseline("concierge", "smoke", ctxA.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");

    // Pass side: the same rise under threshold 600ms.
    const ctxB = newCtx();
    const prevB = makeRun(ctxB, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)], {}, 100);
    await finish(ctxB, prevB);
    const nextB = makeRun(ctxB, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)], {}, 500);
    const passed = await finish(ctxB, nextB, { gateRequested: true, maxP95LatencyMs: 600 });
    expect(passed.gateFailed).toBe(false);
    expect(ctxB.lines.join("\n")).toContain("[eval] gate: PASS");
    expect(getBaseline("concierge", "smoke", ctxB.evalsDir)?.runId).toBe("run_bbbb2222bbbb2222");
  });

  test("absent flags keep today's behavior — a huge latency rise still passes", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)], {}, 100);
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)], {}, 60_000);
    const result = await finish(ctx, next, { gateRequested: true });
    expect(result.gateFailed).toBe(false);
    expect(ctx.lines.join("\n")).toContain("[eval] gate: PASS");
  });

  test("--max-cost-usd fails the gate when the run cost exceeds it — and passes at the ceiling", async () => {
    const ctxA = newCtx();
    const prevA = makeRun(ctxA, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctxA, prevA);
    const nextA = makeRun(ctxA, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)]);
    const failed = await finish(ctxA, nextA, {
      gateRequested: true,
      costUsd: 2.5,
      maxCostUsd: 2,
    });
    expect(failed.gateFailed).toBe(true);
    expect(failed.gateReason).toContain("run cost $2.5000 exceeded --max-cost-usd $2.0000");
    expect(getBaseline("concierge", "smoke", ctxA.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");

    // AT the ceiling is within budget — only exceeding it fails.
    const ctxB = newCtx();
    const prevB = makeRun(ctxB, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctxB, prevB);
    const nextB = makeRun(ctxB, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)]);
    const passed = await finish(ctxB, nextB, { gateRequested: true, costUsd: 2, maxCostUsd: 2 });
    expect(passed.gateFailed).toBe(false);
    expect(ctxB.lines.join("\n")).toContain("[eval] gate: PASS");
  });

  test("--max-cost-usd with an unknown run cost warns and does not gate", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", true, 1)]);
    const result = await finish(ctx, next, { gateRequested: true, maxCostUsd: 2 });
    expect(result.gateFailed).toBe(false);
    expect(ctx.warnings.join("\n")).toContain("cost gate not applied");
    expect(ctx.lines.join("\n")).toContain("[eval] gate: PASS");
  });

  test("a regression AND a cost breach compose into one joined FAIL reason", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [
      makeSample("a", true, 1),
      makeSample("b", true, 1),
    ]);
    await finish(ctx, prev);
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [
      makeSample("a", true, 1),
      makeSample("b", false, 0),
    ]);
    const result = await finish(ctx, next, {
      gateRequested: true,
      costUsd: 3,
      maxCostUsd: 1,
    });
    expect(result.gateFailed).toBe(true);
    expect(result.gateReason).toMatch(/pass-rate dropped/);
    expect(result.gateReason).toContain("; run cost $3.0000 exceeded --max-cost-usd $1.0000");
  });

  test("costGateReason: undefined off both sides, reason only past the ceiling", () => {
    expect(costGateReason(undefined, undefined)).toBeUndefined();
    expect(costGateReason(5, undefined)).toBeUndefined();
    expect(costGateReason(undefined, 5)).toBeUndefined();
    expect(costGateReason(4.9999, 5)).toBeUndefined();
    expect(costGateReason(5, 5)).toBeUndefined();
    expect(costGateReason(5.0001, 5)).toContain("exceeded --max-cost-usd");
  });
});

describe("finishEvalRun — partial (budget-exhausted) runs never become baselines (NEW-HUNT-3)", () => {
  /** A budget-aborted run: `completed` samples ran, the rest were recorded
   *  as synthetic errors by the runner before the summary was built. */
  function makePartialRun(
    ctx: Ctx,
    runId: string,
    samples: SampleResult[],
    completedSamples: number,
    config: Partial<EvalRunSummary["config"]> = {},
  ): EvalRunSummary {
    const base = makeSummary(runId, samples, join(ctx.root, runId), 100, config);
    const summary: EvalRunSummary = {
      ...base,
      partial: {
        reason: "budget_exhausted",
        completedSamples,
        totalSamples: samples.length,
        spentUsd: 1.25,
        budgetUsd: 1,
      },
    };
    persistRun(summary);
    return summary;
  }

  test("a partial FIRST run is indexed (marked partial) but pins NO baseline", async () => {
    const ctx = newCtx();
    // Sample "b" never ran — the runner recorded it as an errored fail.
    const run = makePartialRun(
      ctx,
      "run_aaaa1111aaaa1111",
      [makeSample("a", true, 1), makeSample("b", false, 0)],
      1,
    );
    const result = await finish(ctx, run, { gateRequested: true });
    expect(result.gateFailed).toBe(false); // no baseline to gate against
    const index = readRunIndex(ctx.evalsDir);
    expect(index).toHaveLength(1);
    expect(index[0]?.partial).toBe(true);
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)).toBeUndefined();
    expect(ctx.lines.join("\n")).toContain("partial run (budget exhausted) — baseline not pinned");
  });

  test("a full run's index entry carries NO partial field (additive)", async () => {
    const ctx = newCtx();
    await finish(ctx, makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]));
    expect(readRunIndex(ctx.evalsDir)[0]?.partial).toBeUndefined();
  });

  test("a partial run never PROMOTES — even when its aborted samples were already failing in the baseline", async () => {
    const ctx = newCtx();
    // Baseline: a passes, b fails. The partial run aborts b (also a fail):
    // no flip, flat pass rate — pre-fix this read gate-PASS and promoted.
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [
      makeSample("a", true, 1),
      makeSample("b", false, 0),
    ]);
    await finish(ctx, prev);
    const next = makePartialRun(
      ctx,
      "run_bbbb2222bbbb2222",
      [makeSample("a", true, 1), makeSample("b", false, 0)],
      1,
    );
    const result = await finish(ctx, next, { gateRequested: true });
    expect(result.gateFailed).toBe(true);
    expect(result.gateReason).toMatch(/partial \(budget exhausted after 1\/2 samples\)/);
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
    const out = ctx.lines.join("\n");
    expect(out).toContain("gate: FAIL");
    expect(out).toContain("baseline kept: run_aaaa1111aaaa1111");
  });

  test("without --gate a partial run still fails the printed verdict and keeps the baseline", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [
      makeSample("a", true, 1),
      makeSample("b", false, 0),
    ]);
    await finish(ctx, prev);
    const next = makePartialRun(
      ctx,
      "run_bbbb2222bbbb2222",
      [makeSample("a", true, 1), makeSample("b", false, 0)],
      1,
    );
    const result = await finish(ctx, next, { gateRequested: false });
    expect(result.gateFailed).toBe(false); // --gate absent → clean exit, as ever
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
    expect(ctx.lines.join("\n")).toContain("gate: FAIL");
  });

  test("a partial run does not pin the new-lineage paths either (instrument change)", async () => {
    const ctx = newCtx();
    const prev = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)], {
      gradersHash: "g1".repeat(32),
    });
    await finish(ctx, prev);
    // Instrument changed → new lineage would normally pin this run.
    const next = makePartialRun(
      ctx,
      "run_bbbb2222bbbb2222",
      [makeSample("a", true, 1), makeSample("b", false, 0)],
      1,
      { gradersHash: "g2".repeat(32) },
    );
    const result = await finish(ctx, next);
    expect(result.gateFailed).toBe(false);
    // Old pin survives untouched; the partial run pinned nothing.
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
    expect(ctx.lines.join("\n")).toContain(
      "partial run (budget exhausted) — baseline not pinned (new lineage)",
    );
  });
});

describe("finishEvalRun — a resumed run never gates against ITSELF (NEW-HUNT-6)", () => {
  test("the pinned baseline being this very run refuses the comparison, loudly", async () => {
    const ctx = newCtx();
    // First run for the pair: interrupted after one of two samples, but not
    // budget-partial (SIGINT sets no `partial`), so it pins the baseline.
    const interrupted = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, interrupted);
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");

    // Now resume it: same runId, same outDir, results.json rewritten with the
    // union. Both sides of the diff would read THAT file.
    const resumed = makeSummary(
      "run_aaaa1111aaaa1111",
      [makeSample("a", true, 1), makeSample("b", false, 0)],
      interrupted.outDir,
    );
    persistRun(resumed);
    ctx.lines.length = 0;
    ctx.warnings.length = 0;
    const result = await finish(ctx, resumed, { gateRequested: true });

    // No fabricated verdict…
    expect(result.gateFailed).toBe(false);
    const out = ctx.lines.join("\n");
    expect(out).not.toContain("vs baseline");
    expect(out).not.toContain("gate: PASS");
    expect(out).toContain("self-comparison — not gated, not promoted");
    // …and a loud explanation naming the run.
    const warned = ctx.warnings.join("\n");
    expect(warned).toContain("[eval] warning:");
    expect(warned).toContain("IS this run (run_aaaa1111aaaa1111)");
    expect(warned).toContain("start a fresh run");
    // The run is still recorded in history (the superseding entry).
    expect(readRunIndex(ctx.evalsDir)).toHaveLength(2);
  });

  test("a baseline pinned at the SAME directory under another id is caught too", async () => {
    const ctx = newCtx();
    const first = makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]);
    await finish(ctx, first);
    // Same outDir, different runId (a hand-edited pin, or a re-run into the
    // same -o): the diff would still read one file against itself.
    const sameDir = makeSummary("run_cccc3333cccc3333", [makeSample("a", true, 1)], first.outDir);
    persistRun(sameDir);
    ctx.lines.length = 0;
    const result = await finish(ctx, sameDir, { gateRequested: true });
    expect(result.gateFailed).toBe(false);
    expect(ctx.lines.join("\n")).toContain("self-comparison");
    expect(getBaseline("concierge", "smoke", ctx.evalsDir)?.runId).toBe("run_aaaa1111aaaa1111");
  });

  test("an ordinary second run into its OWN directory still gates normally", async () => {
    const ctx = newCtx();
    await finish(ctx, makeRun(ctx, "run_aaaa1111aaaa1111", [makeSample("a", true, 1)]));
    const next = makeRun(ctx, "run_bbbb2222bbbb2222", [makeSample("a", false, 0)]);
    const result = await finish(ctx, next, { gateRequested: true });
    expect(result.gateFailed).toBe(true);
    expect(ctx.lines.join("\n")).toContain("vs baseline run_aaaa1111aaaa1111");
  });
});

describe("datasetFilterMatches (F10 — `eval-report history --dataset`)", () => {
  test("matches exact names and `+` union-suffixed names, not mere prefixes", () => {
    expect(datasetFilterMatches("smoke", "smoke")).toBe(true);
    expect(datasetFilterMatches("smoke", "smoke+regressions@v1")).toBe(true);
    expect(datasetFilterMatches("smoke", "smoke2")).toBe(false);
    expect(datasetFilterMatches("smoke", "smoke2+regressions@v1")).toBe(false);
    expect(datasetFilterMatches("smoke+regressions@v1", "smoke+regressions@v1")).toBe(true);
    expect(datasetFilterMatches("smoke+regressions@v1", "smoke")).toBe(false);
  });
});
