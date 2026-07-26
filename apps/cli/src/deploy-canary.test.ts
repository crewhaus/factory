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
import {
  type ExperimentAssignment,
  createCanaryController,
  makeRegressionGate,
} from "@crewhaus/canary-controller";
import { createDeploymentController } from "@crewhaus/deployment-controller";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";
import {
  CanaryRampError,
  driveCanaryRamp,
  experimentOutcomesFromEvalRun,
  makeCanaryEvalGate,
  makeTrafficSplitRecorder,
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

describe("driveCanaryRamp — model_pool policy changes are canary-eligible", () => {
  // Adaptive model routing's promotion path: a `model_pool` policy change is
  // an ordinary spec delta between two pinned versions, so the EXISTING
  // spec-version canary ramps it with a regression gate and auto-rollback —
  // no routing-specific canary machinery. This test pins that contract (a
  // future "no model changes via canary" guard would break it loudly).
  const POOL_V1 = [
    "name: pooled",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-5",
    "  instructions: help",
    "  model_pool:",
    "    candidates:",
    "      - { model: claude-haiku-4-5, tags: [cheap] }",
    "      - { model: claude-opus-4-1, tags: [strong] }",
  ].join("\n");
  // v2 differs ONLY in the (advise-proposed) policy flip to `learned`.
  const POOL_V2 = `${POOL_V1}\n    policy: learned`;

  test("a policy-only delta promotes on pass and rolls back on regression", async () => {
    for (const regresses of [false, true]) {
      const root = join(tmpRoot, regresses ? "rb" : "ok");
      const reg = createFileBackedRegistry({ rootDir: join(root, "specs") });
      await reg.put("pooled", "v1", POOL_V1);
      await reg.put("pooled", "v2", POOL_V2);
      await reg.pin("pooled", "prod", "v1");
      const deploy = createDeploymentController({ registry: reg });
      const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
      const gate = makeRegressionGate(
        makeCanaryEvalGate({
          evalVersion: async (v) =>
            regresses && v === "v2"
              ? summary([sample("a", false, 0), sample("b", false, 0)])
              : summary([sample("a", true, 1), sample("b", true, 1)]),
        }),
      );
      const result = await driveCanaryRamp({
        steps: [25, 100],
        evaluateStep: (trafficPercent) =>
          ctrl.evaluate(
            { name: "pooled", fromVersion: "v1", toVersion: "v2", trafficPercent },
            { intervalMs: 0, gate },
          ),
      });
      if (regresses) {
        expect(result.promoted).toBe(false);
        expect(await reg.aliasFor("pooled", "prod")).toBe("v1"); // rolled back
      } else {
        expect(result.promoted).toBe(true);
        expect(await reg.aliasFor("pooled", "prod")).toBe("v2"); // learned policy live
        // The promoted content really is the learned-policy spec.
        expect(await reg.get("pooled", "v2")).toContain("policy: learned");
      }
    }
  });
});

// E50 — `--traffic-split` per-version outcome accounting. The ledger append
// itself is canary-controller's (tested there); this pins the PROJECTION the
// CLI feeds it, so an accounting drift shows up as a unit failure rather than
// a silently wrong experiment report.
describe("experimentOutcomesFromEvalRun (E50)", () => {
  test("abstained (A3) and canary (B18) samples never become observations", () => {
    // eval-runner's own aggregator drops both from the pass-rate denominator
    // (`aggregate()`'s `scored` filter). Projecting an abstention as a
    // `failure` would report this version BELOW the pass rate of the very run
    // the records came from — counting a judge's explicit "I don't know" as a
    // verdict, which is exactly what A3 exists to forbid.
    const abstained: SampleResult = {
      ...sample("abstained", false, 0),
      grades: {
        overall: { passed: false, score: 0, abstained: true, rationale: "insufficient evidence" },
        perGrader: [],
      },
    };
    const canary: SampleResult = {
      ...sample("tripwire", false, 0),
      metadata: { source: "canary" },
    };
    const records = experimentOutcomesFromEvalRun({
      experiment: "checkout",
      version: "v2",
      summary: summary([sample("graded", true, 1), abstained, canary]),
      ts: "t",
    });
    expect(records.map((r) => r.requestKey)).toEqual(["graded"]);
    expect(records[0]?.outcome).toBe("success");
  });

  test("one record per graded sample, attributed to the version", () => {
    const records = experimentOutcomesFromEvalRun({
      experiment: "checkout",
      version: "v2",
      summary: summary([sample("a", true, 1), sample("b", false, 0.25)]),
      ts: "2026-07-26T00:00:00.000Z",
    });
    expect(records).toEqual([
      {
        ts: "2026-07-26T00:00:00.000Z",
        experiment: "checkout",
        version: "v2",
        outcome: "success",
        requestKey: "a",
        score: 1,
        source: "eval",
      },
      {
        ts: "2026-07-26T00:00:00.000Z",
        experiment: "checkout",
        version: "v2",
        outcome: "failure",
        requestKey: "b",
        score: 0.25,
        source: "eval",
      },
    ]);
  });

  test("an errored sample counts as a failure (the version did not answer)", () => {
    const errored: SampleResult = {
      ...sample("boom", false, 0),
      error: "provider timeout",
    };
    const records = experimentOutcomesFromEvalRun({
      experiment: "checkout",
      version: "v1",
      summary: summary([errored]),
      ts: "t",
    });
    expect(records[0]?.outcome).toBe("failure");
    expect(records[0]?.requestKey).toBe("boom");
  });

  test("an empty run contributes nothing (never a phantom observation)", () => {
    expect(
      experimentOutcomesFromEvalRun({
        experiment: "e",
        version: "v1",
        summary: summary([]),
        ts: "t",
      }),
    ).toEqual([]);
  });
});

describe("makeTrafficSplitRecorder (E50)", () => {
  function recorder(over: Partial<Parameters<typeof makeTrafficSplitRecorder>[0]> = {}) {
    const appended: Array<{ records: unknown; dir: string }> = [];
    const assignments: Array<{ assignment: ExperimentAssignment; dir: string }> = [];
    const removed: Array<{ name: string; dir: string }> = [];
    const lines: string[] = [];
    const rec = makeTrafficSplitRecorder({
      experiment: "checkout",
      dir: "/ledger",
      baselineVersion: "v1",
      candidateVersion: "v2",
      env: "prod",
      append: (records, dir) => appended.push({ records, dir }),
      writeAssignment: (assignment, dir) => assignments.push({ assignment, dir }),
      removeAssignment: (name, dir) => {
        removed.push({ name, dir });
        return true;
      },
      write: (l) => lines.push(l),
      now: () => "2026-07-26T00:00:00.000Z",
      ...over,
    });
    return { rec, appended, assignments, removed, lines };
  }

  test("a ramp step writes the split assignment with the step's weights", () => {
    const { rec, assignments } = recorder();
    rec.writeStepAssignment(25);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.dir).toBe("/ledger");
    expect(assignments[0]?.assignment.variants).toEqual([
      { version: "v1", weight: 75 },
      { version: "v2", weight: 25 },
    ]);
    expect(assignments[0]?.assignment.env).toBe("prod");
    // The file states its own boundary, so one found on disk months later
    // cannot be mistaken for something CrewHaus routes on.
    expect(assignments[0]?.assignment.note).toContain("no CrewHaus serving surface consults");
  });

  test("the 100% step writes NO assignment — that step is the promotion", () => {
    const { rec, assignments } = recorder();
    rec.writeStepAssignment(100);
    expect(assignments).toHaveLength(0);
  });

  test("a tenant scope becomes the bucket salt", () => {
    const { rec, assignments } = recorder({ salt: "tenant-7" });
    rec.writeStepAssignment(50);
    expect(assignments[0]?.assignment.salt).toBe("tenant-7");
  });

  test("a version's eval run becomes one ledger observation per sample", () => {
    const { rec, appended } = recorder();
    rec.recordVersionRun("v2", summary([sample("a", true, 1), sample("b", false, 0)]));
    // Buffered until the ramp concludes — see the repeat-measurement test.
    expect(appended).toHaveLength(0);
    rec.finish("promoted");
    expect(appended).toHaveLength(1);
    expect(appended[0]?.records).toEqual([
      {
        ts: "2026-07-26T00:00:00.000Z",
        experiment: "checkout",
        version: "v2",
        outcome: "success",
        requestKey: "a",
        score: 1,
        source: "eval",
      },
      {
        ts: "2026-07-26T00:00:00.000Z",
        experiment: "checkout",
        version: "v2",
        outcome: "failure",
        requestKey: "b",
        score: 0,
        source: "eval",
      },
    ]);
  });

  test("a ramp contributes ONE batch per version — its final measurement", () => {
    // The independence bug this guards: `canary.evaluate` runs the gate once
    // per step and the gate evals BOTH versions, so a default 5,25,50,100
    // ramp would otherwise write 4 copies of every dataset sample per version
    // and let `experiment status` treat re-measurements of one fixed sample
    // as independent observations.
    const { rec, appended } = recorder();
    for (const step of [5, 25, 50, 100]) {
      rec.recordVersionRun("v1", summary([sample("a", true, 1), sample("b", true, 1)]));
      rec.recordVersionRun("v2", summary([sample("a", true, 1), sample("b", step >= 50, 1)]));
      rec.writeStepAssignment(step);
    }
    expect(appended).toHaveLength(0);
    rec.finish("promoted");
    // One append per version, two samples each — not 4 steps × 2 versions × 2.
    expect(appended).toHaveLength(2);
    const flat = appended.flatMap((a) => a.records as ReadonlyArray<{ version: string }>);
    expect(flat).toHaveLength(4);
    expect(flat.filter((r) => r.version === "v1")).toHaveLength(2);
    // The LAST measurement wins (sample b passed only from the 50% step on).
    const v2 = appended[1]?.records as ReadonlyArray<{ requestKey: string; outcome: string }>;
    expect(v2.find((r) => r.requestKey === "b")?.outcome).toBe("success");
  });

  test("a concluded ramp retires the assignment and says why", () => {
    for (const outcome of ["promoted", "rolled-back"] as const) {
      const { rec, removed, lines } = recorder();
      rec.writeStepAssignment(50);
      rec.finish(outcome);
      // Both end states pin a SINGLE version, so a surviving 50/50 file would
      // keep a compliant integration routing half its keys at a version
      // nobody is running. There is no representable "100% baseline"
      // assignment (weights need ≥2 variants summing to 100), so it goes.
      expect(removed).toEqual([{ name: "checkout", dir: "/ledger" }]);
      expect(lines.join("\n")).toContain("variant assignment retired");
      expect(lines.join("\n")).toContain(
        outcome === "promoted" ? "promoted the candidate" : "rolled back to the baseline",
      );
    }
  });

  test("retiring an assignment that was never written is silent", () => {
    const { rec, lines } = recorder({ removeAssignment: () => false });
    rec.finish("rolled-back");
    expect(lines.join("\n")).not.toContain("variant assignment retired");
  });

  test("a failing ledger/assignment write warns but never aborts the ramp", () => {
    const { rec, lines } = recorder({
      append: () => {
        throw new Error("disk full");
      },
      writeAssignment: () => {
        throw new Error("read-only fs");
      },
      removeAssignment: () => {
        throw new Error("permission denied");
      },
    });
    expect(() => rec.recordVersionRun("v1", summary([sample("a", true, 1)]))).not.toThrow();
    expect(() => rec.writeStepAssignment(25)).not.toThrow();
    expect(() => rec.finish("promoted")).not.toThrow();
    expect(lines.join("\n")).toContain("experiment ledger write failed — disk full");
    expect(lines.join("\n")).toContain("experiment assignment write failed — read-only fs");
    expect(lines.join("\n")).toContain("experiment assignment retire failed — permission denied");
  });
});

// The ORDER of the assignment write against the gate is the whole point: a
// split written before a step's verdict outlives a rollback and misroutes.
describe("driveCanaryRamp — traffic-split assignment lifecycle (E50)", () => {
  function spyRecorder() {
    const calls: string[] = [];
    return {
      calls,
      recorder: {
        recordVersionRun: () => calls.push("record"),
        writeStepAssignment: (pct: number) => calls.push(`assign:${pct}`),
        finish: (outcome: string) => calls.push(`finish:${outcome}`),
      },
    };
  }

  test("each step's split is written only AFTER its gate passes", async () => {
    const { calls, recorder } = spyRecorder();
    const result = await driveCanaryRamp({
      steps: [5, 25, 100],
      recorder,
      evaluateStep: (pct) => {
        calls.push(`gate:${pct}`);
        return Promise.resolve({ verdict: "pass" as const, action: "promote" as const });
      },
    });
    expect(result.promoted).toBe(true);
    // Gate → assign, never assign → gate. The 100% step writes no assignment
    // (it is the promotion), and `finish` retires whatever the 25% step left.
    expect(calls).toEqual([
      "gate:5",
      "assign:5",
      "gate:25",
      "assign:25",
      "gate:100",
      "assign:100",
      "finish:promoted",
    ]);
  });

  test("a failing step writes NO split for itself and retires the previous one", async () => {
    const { calls, recorder } = spyRecorder();
    const result = await driveCanaryRamp({
      steps: [5, 25, 50, 100],
      recorder,
      evaluateStep: (pct) => {
        calls.push(`gate:${pct}`);
        return Promise.resolve(
          pct >= 50
            ? { verdict: "fail" as const, reason: "pass-rate dropped", action: "rollback" as const }
            : { verdict: "pass" as const, action: "promote" as const },
        );
      },
    });
    expect(result.promoted).toBe(false);
    expect(result.failedAt).toBe(50);
    // No `assign:50`, and the terminal hook runs on the rollback path too —
    // the env pin is back at the baseline, so the 25/75 file must not survive.
    expect(calls).toEqual([
      "gate:5",
      "assign:5",
      "gate:25",
      "assign:25",
      "gate:50",
      "finish:rolled-back",
    ]);
  });

  test("without --traffic-split the ramp is unchanged (no recorder, no calls)", async () => {
    const seen: number[] = [];
    const result = await driveCanaryRamp({
      steps: [50, 100],
      evaluateStep: (pct) => {
        seen.push(pct);
        return Promise.resolve({ verdict: "pass" as const });
      },
    });
    expect(result.promoted).toBe(true);
    expect(seen).toEqual([50, 100]);
  });
});
