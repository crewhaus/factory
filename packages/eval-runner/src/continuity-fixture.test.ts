/**
 * PR 19 end-to-end: the worked continuity fixture runs through the REAL
 * eval-runner — scripted mock-adapter conversations played by the fixture
 * invoker into each sample's isolated artifact dir, the five continuity
 * graders resolved BY NAME from a GraderRegistry (`type: registry`), the
 * session-2 log picked up as `transcript.jsonl`, and the run report
 * carrying the pinned continuity metrics + the summarize roll-up lines.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { type GradeResult, parseGradersConfig } from "@crewhaus/eval-grader";
import {
  CONTINUITY_FIXTURE_SAMPLES,
  CONTINUITY_FIXTURE_SPEC_NAME,
  createContinuityFixtureInvoker,
  registerContinuityGraders,
  renderContinuitySummaryLines,
  summarizeContinuityMetrics,
} from "@crewhaus/grader-continuity";
import { GraderRegistry } from "@crewhaus/grader-registry";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { type EvalRunSummary, runEval } from "./index";

const SPEC = `name: ${CONTINUITY_FIXTURE_SPEC_NAME}
target: cli
agent:
  model: claude-opus-4-7
  instructions: continuity fixture playback
`;

const GRADERS_YAML = `
graders:
  - name: continuity.reAskRate
    type: registry
    grader: continuity.reAskRate
  - name: continuity.reqRetention
    type: registry
    grader: continuity.reqRetention
  - name: continuity.proofHonesty
    type: registry
    grader: continuity.proofHonesty
  - name: continuity.pickupSuccess
    type: registry
    grader: continuity.pickupSuccess
  - name: continuity.costPerProvenOutcome
    type: registry
    grader: continuity.costPerProvenOutcome
`;

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: readonly Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const TMP_ROOTS: string[] = [];
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function grade(summary: EvalRunSummary, sampleId: string, grader: string): GradeResult {
  const sample = summary.samples.find((s) => s.sampleId === sampleId);
  const per = sample?.grades.perGrader.find((g) => g.name === grader);
  if (per === undefined) throw new Error(`no ${grader} grade for ${sampleId}`);
  return per;
}

describe("eval-runner × continuity fixture (end-to-end)", () => {
  test("the report carries the pinned continuity metrics for all three scenarios", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "crewhaus-continuity-e2e-"));
    TMP_ROOTS.push(outDir);

    const registry = new GraderRegistry();
    registerContinuityGraders(registry);
    const { compiled } = parseGradersConfig(GRADERS_YAML);

    const summary = await runEval({
      ir: narrowToAgent(lower(parseSpec(SPEC))),
      dataset: {
        name: "continuity-fixture",
        samples: yieldSamples(CONTINUITY_FIXTURE_SAMPLES),
      },
      compiledGraders: compiled,
      opts: {
        outDir,
        invoker: createContinuityFixtureInvoker(),
        graderRegistry: registry,
        concurrency: 2,
      },
    });

    expect(summary.samples).toHaveLength(3);
    expect(summary.config.graderNames).toContain("continuity.proofHonesty");
    expect(summary.aggregates.errorCount).toBe(0);
    // Only the clean scenario passes every gate.
    expect(summary.aggregates.passRate).toBeCloseTo(1 / 3, 10);

    // ---- pinned per-sample matrix (the discrimination proof) ----
    expect(grade(summary, "clean-pickup", "continuity.reAskRate").score).toBe(0);
    expect(grade(summary, "clean-pickup", "continuity.reqRetention").score).toBe(1);
    expect(grade(summary, "clean-pickup", "continuity.proofHonesty").score).toBe(1);
    expect(grade(summary, "clean-pickup", "continuity.pickupSuccess").score).toBe(1);
    expect(grade(summary, "clean-pickup", "continuity.costPerProvenOutcome").score).toBeCloseTo(
      0.03,
      10,
    );
    expect(grade(summary, "clean-pickup", "continuity.costPerProvenOutcome").passed).toBe(true);

    expect(grade(summary, "re-asker", "continuity.reAskRate").score).toBe(1);
    expect(grade(summary, "re-asker", "continuity.reAskRate").passed).toBe(false);
    expect(grade(summary, "re-asker", "continuity.reqRetention").score).toBe(0);
    expect(grade(summary, "re-asker", "continuity.proofHonesty").score).toBe(1);
    expect(grade(summary, "re-asker", "continuity.pickupSuccess").score).toBe(0.25);
    expect(grade(summary, "re-asker", "continuity.costPerProvenOutcome").passed).toBe(false);

    expect(grade(summary, "claims-without-proof", "continuity.reAskRate").score).toBe(0);
    expect(grade(summary, "claims-without-proof", "continuity.reqRetention").score).toBe(1);
    expect(grade(summary, "claims-without-proof", "continuity.proofHonesty").score).toBe(0);
    expect(grade(summary, "claims-without-proof", "continuity.proofHonesty").passed).toBe(false);
    expect(grade(summary, "claims-without-proof", "continuity.pickupSuccess").score).toBe(1);
    expect(grade(summary, "claims-without-proof", "continuity.costPerProvenOutcome").passed).toBe(
      false,
    );

    // ---- artifacts: the two-session layout landed per sample ----
    for (const id of ["clean-pickup", "re-asker", "claims-without-proof"]) {
      expect(existsSync(join(outDir, id, "transcript.jsonl"))).toBe(true); // session 2
      expect(existsSync(join(outDir, id, "grades.json"))).toBe(true);
      const stateDir = join(outDir, id, ".crewhaus", "state", CONTINUITY_FIXTURE_SPEC_NAME);
      expect(existsSync(join(stateDir, "handoff.md"))).toBe(true);
    }
    // Session 1's JSONL stays alongside the renamed transcript.
    expect(existsSync(join(outDir, "clean-pickup", "sess_00000000000000c1.jsonl"))).toBe(true);
    // results.json (the persisted report) carries the metric verdicts.
    const results = readFileSync(join(outDir, "results.json"), "utf8");
    expect(results).toContain("continuity.reAskRate");
    expect(results).toContain("per proven outcome");

    // ---- the continuity roll-up over the report (the §7.3 gate lines) ----
    const byMetric: Record<string, GradeResult[]> = {};
    for (const sample of summary.samples) {
      for (const per of sample.grades.perGrader) {
        const bucket = byMetric[per.name] ?? [];
        bucket.push({ passed: per.passed, score: per.score, rationale: per.rationale });
        byMetric[per.name] = bucket;
      }
    }
    const rollup = summarizeContinuityMetrics(byMetric);
    expect(rollup.metrics.find((m) => m.name === "continuity.reAskRate")?.mean).toBeCloseTo(
      1 / 3,
      10,
    );
    expect(rollup.cost.finiteCount).toBe(1);
    expect(rollup.cost.infiniteCount).toBe(2);
    expect(rollup.overall).toBeCloseTo(3 / 5, 10);

    const lines = renderContinuitySummaryLines(rollup);
    expect(lines).toHaveLength(6);
    expect(lines.join("\n")).toContain("continuity.pickupSuccess");
    expect(lines[lines.length - 1]).toContain("continuity overall");
  }, 30_000);
});
