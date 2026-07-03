/**
 * Item 29 — `crewhaus deploy canary` orchestration tests. Injects seeded
 * `EvalRunSummary` results plus the REAL `regression-runner.gate()` and a
 * REAL file-backed spec-registry + audit log, so the ramp promote/rollback
 * path is exercised end-to-end without a live model.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditRecord, openAuditLog } from "@crewhaus/audit-log";
import { createCanaryController, makeRegressionGate } from "@crewhaus/canary-controller";
import { createDeploymentController } from "@crewhaus/deployment-controller";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";
import {
  CanaryRampError,
  driveCanaryRamp,
  makeCanaryEvalGate,
  parseTrafficSteps,
} from "./deploy-canary";

let tmpRoot = "";
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "deploy-canary-test-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function sample(id: string, passed: boolean, score: number, latencyMs = 100): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess-${id}`,
    startedAt: "2026-07-02T00:00:00Z",
    endedAt: "2026-07-02T00:00:01Z",
    latencyMs,
    turns: 1,
    tokens: { input: 10, output: 10 },
    model: "claude-sonnet-4-5",
    agentOutput: `out ${id}`,
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "no" },
      perGrader: [{ name: "g1", passed, score, rationale: passed ? "ok" : "no" }],
    },
  };
}

function summary(samples: SampleResult[], latencyMs = 100): EvalRunSummary {
  const passed = samples.filter((s) => s.grades.overall.passed).length;
  return {
    runId: `run_${Math.random().toString(16).slice(2)}`,
    startedAt: "2026-07-02T00:00:00Z",
    endedAt: "2026-07-02T00:00:01Z",
    samples,
    aggregates: {
      passRate: samples.length === 0 ? 0 : passed / samples.length,
      meanScore:
        samples.length === 0
          ? 0
          : samples.reduce((a, s) => a + s.grades.overall.score, 0) / samples.length,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: latencyMs,
      p95LatencyMs: latencyMs,
      totalTokens: { input: 0, output: 0 },
      errorCount: 0,
    },
    config: {
      specHash: "hash",
      datasetName: "ds",
      graderNames: ["g1"],
      model: "claude-sonnet-4-5",
      concurrency: 1,
    },
    outDir: "/tmp/x",
  };
}

async function readAudit(rootDir: string): Promise<AuditRecord[]> {
  const log = await openAuditLog({ rootDir });
  const out: AuditRecord[] = [];
  for await (const r of log.read()) out.push(r);
  return out;
}

describe("parseTrafficSteps", () => {
  test("parses and orders a valid list", () => {
    expect(parseTrafficSteps("5,25,50,100")).toEqual([5, 25, 50, 100]);
  });
  test("trims whitespace", () => {
    expect(parseTrafficSteps(" 10 , 100 ")).toEqual([10, 100]);
  });
  test("rejects an empty list", () => {
    expect(() => parseTrafficSteps("")).toThrow(CanaryRampError);
  });
  test("rejects non-integer / out-of-range steps", () => {
    expect(() => parseTrafficSteps("5,x,100")).toThrow(CanaryRampError);
    expect(() => parseTrafficSteps("0,50")).toThrow(CanaryRampError);
    expect(() => parseTrafficSteps("50,150")).toThrow(CanaryRampError);
    expect(() => parseTrafficSteps("2.5,50")).toThrow(CanaryRampError);
  });
  test("rejects non-increasing steps", () => {
    expect(() => parseTrafficSteps("50,25")).toThrow(CanaryRampError);
    expect(() => parseTrafficSteps("50,50")).toThrow(CanaryRampError);
  });
});

describe("makeCanaryEvalGate (real regression-runner gate)", () => {
  test("flat pass rate + flat latency ⇒ pass", async () => {
    const evalVersion = async (v: string): Promise<EvalRunSummary> =>
      summary([sample("a", true, 1), sample("b", true, 1)]);
    const g = makeCanaryEvalGate({ evalVersion });
    const verdict = await g({ fromVersion: "v1", toVersion: "v2" });
    expect(verdict.verdict).toBe("pass");
  });

  test("candidate drops pass rate ⇒ fail with reason", async () => {
    const evalVersion = async (v: string): Promise<EvalRunSummary> =>
      v === "v1"
        ? summary([sample("a", true, 1), sample("b", true, 1)])
        : summary([sample("a", false, 0), sample("b", false, 0)]);
    const g = makeCanaryEvalGate({ evalVersion });
    const verdict = await g({ fromVersion: "v1", toVersion: "v2" });
    expect(verdict.verdict).toBe("fail");
    expect(verdict.reason).toContain("pass-rate dropped");
  });

  test("candidate blows p95 latency past the threshold ⇒ fail", async () => {
    const evalVersion = async (v: string): Promise<EvalRunSummary> =>
      v === "v1"
        ? summary([sample("a", true, 1)], 100)
        : summary([sample("a", true, 1)], 100 + 6000);
    const g = makeCanaryEvalGate({ evalVersion });
    const verdict = await g({ fromVersion: "v1", toVersion: "v2" });
    expect(verdict.verdict).toBe("fail");
    expect(verdict.reason).toContain("p95 latency");
  });

  test("latency threshold override is honored", async () => {
    const evalVersion = async (v: string): Promise<EvalRunSummary> =>
      v === "v1" ? summary([sample("a", true, 1)], 100) : summary([sample("a", true, 1)], 300);
    // With a tight +100ms threshold the +200ms candidate fails.
    const g = makeCanaryEvalGate({ evalVersion, thresholds: { latencyThreshold: 100 } });
    const verdict = await g({ fromVersion: "v1", toVersion: "v2" });
    expect(verdict.verdict).toBe("fail");
  });
});

describe("driveCanaryRamp — promote on all-pass", () => {
  test("all steps pass ⇒ candidate promoted, env re-pinned, audit logged", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "spec-v1");
    await reg.put("hello", "v2", "spec-v2");
    await reg.pin("hello", "prod", "v1");
    const audit = await openAuditLog({ rootDir: join(tmpRoot, "audit") });
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({
      registry: reg,
      deploymentController: deploy,
      auditLog: audit,
    });
    // Both versions eval identically → gate passes at every step.
    const gate = makeRegressionGate(
      makeCanaryEvalGate({
        evalVersion: async () => summary([sample("a", true, 1), sample("b", true, 1)]),
      }),
    );
    const steps = [5, 25, 50, 100];
    const result = await driveCanaryRamp({
      steps,
      evaluateStep: (trafficPercent) =>
        ctrl.evaluate(
          { name: "hello", fromVersion: "v1", toVersion: "v2", trafficPercent },
          { intervalMs: 0, gate },
        ),
    });
    expect(result.promoted).toBe(true);
    expect(result.steps.length).toBe(4);
    expect(result.steps.every((s) => s.verdict === "pass")).toBe(true);
    expect(await reg.aliasFor("hello", "prod")).toBe("v2");
    const records = await readAudit(join(tmpRoot, "audit"));
    // One promote per step (each pass re-pins to the candidate).
    expect(records.length).toBe(4);
    expect((records.at(-1)?.payload as { action: string }).action).toBe("promote");
  });
});

describe("driveCanaryRamp — rollback on regression", () => {
  test("a mid-ramp regression rolls back to baseline and aborts", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "spec-v1");
    await reg.put("hello", "v2", "spec-v2");
    await reg.pin("hello", "prod", "v1");
    const audit = await openAuditLog({ rootDir: join(tmpRoot, "audit") });
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({
      registry: reg,
      deploymentController: deploy,
      auditLog: audit,
    });
    // Fail from the first step: candidate regresses pass rate.
    const gate = makeRegressionGate(
      makeCanaryEvalGate({
        evalVersion: async (v) =>
          v === "v1"
            ? summary([sample("a", true, 1), sample("b", true, 1)])
            : summary([sample("a", false, 0), sample("b", false, 0)]),
      }),
    );
    const result = await driveCanaryRamp({
      steps: [5, 25, 50, 100],
      evaluateStep: (trafficPercent) =>
        ctrl.evaluate(
          { name: "hello", fromVersion: "v1", toVersion: "v2", trafficPercent },
          { intervalMs: 0, gate },
        ),
    });
    expect(result.promoted).toBe(false);
    expect(result.failedAt).toBe(5);
    expect(result.steps.length).toBe(1);
    expect(result.steps[0]?.action).toBe("rollback");
    // env pin held at the baseline (the pass at step 5 never happened).
    expect(await reg.aliasFor("hello", "prod")).toBe("v1");
    const records = await readAudit(join(tmpRoot, "audit"));
    expect((records.at(-1)?.payload as { action: string }).action).toBe("rollback");
    expect((records.at(-1)?.payload as { reason: string }).reason).toContain("pass-rate dropped");
  });

  test("passes several steps then regresses ⇒ rolls back at the failing step", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "spec-v1");
    await reg.put("hello", "v2", "spec-v2");
    await reg.pin("hello", "prod", "v1");
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
    let call = 0;
    // Pass the 5% and 25% steps (2 evals each), then regress on the 50% step.
    const gate = makeRegressionGate(
      makeCanaryEvalGate({
        evalVersion: async () => {
          call += 1;
          // Steps 1 & 2 (calls 1-4) pass; step 3's candidate (call 6) fails.
          const failing = call === 6;
          return failing
            ? summary([sample("a", false, 0), sample("b", false, 0)])
            : summary([sample("a", true, 1), sample("b", true, 1)]);
        },
      }),
    );
    const result = await driveCanaryRamp({
      steps: [5, 25, 50, 100],
      evaluateStep: (trafficPercent) =>
        ctrl.evaluate(
          { name: "hello", fromVersion: "v1", toVersion: "v2", trafficPercent },
          { intervalMs: 0, gate },
        ),
    });
    expect(result.promoted).toBe(false);
    expect(result.failedAt).toBe(50);
    expect(result.steps.map((s) => s.verdict)).toEqual(["pass", "pass", "fail"]);
    expect(await reg.aliasFor("hello", "prod")).toBe("v1");
  });
});
