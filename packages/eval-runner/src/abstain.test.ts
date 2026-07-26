/**
 * A3 (runner half) + A12 — abstained-sample semantics end-to-end with a
 * MOCK judge (mock.module on @crewhaus/eval-judge, own file for the fresh
 * module graph, mirroring index.judge.test.ts):
 *
 *   - an abstained judge verdict makes the sample outcome `abstained`
 *     UNLESS another grader failed (deterministic fail wins);
 *   - abstained samples leave the pass-rate denominator and meanScore, and
 *     land in the needsHuman bucket with their ids;
 *   - per-trial abstention is surfaced on TrialResult;
 *   - the judge's `detail` criterion breakdown persists into grades.json
 *     and aggregates into `criterionMeans`.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { CompiledGrader, GradeResult } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";

// See index.judge.test.ts — snapshot the real module (`{ ...ns }`) so the
// afterAll restore reinstalls the genuine implementations, not the stubs.
const realEvalJudge = { ...(await import("@crewhaus/eval-judge")) };

// The mock judge abstains on any sample whose id starts with "abstain",
// and otherwise passes with a fixed per-criterion breakdown.
mock.module("@crewhaus/eval-judge", () => ({
  ...realEvalJudge,
  loadRubric: (input: unknown) => input,
  createJudgeGrader: () => {
    return async (sample: Sample): Promise<GradeResult> =>
      sample.id.startsWith("abstain")
        ? {
            passed: false,
            score: 0,
            rationale: "judge abstained (need ≥3): evidence insufficient",
            abstained: true,
            confidence: 0.2,
          }
        : {
            passed: true,
            score: 0.75,
            rationale: "judge=4 (need ≥3): solid",
            confidence: 0.9,
            detail: { correctness: 4, tone: 5 },
          };
  },
}));

const { runEval, sampleAbstained } = await import("./index");

const SPEC = `name: abstain-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: test
`;

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-abstain-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
  mock.module("@crewhaus/eval-judge", () => realEvalJudge);
});

function judgeGrader(name: string): CompiledGrader {
  return {
    name,
    grader: async () => {
      throw new Error("placeholder must be replaced");
    },
    weight: 1,
    judgeSpec: { rubric: { criteria: [{ name: "q", weight: 1, description: "d" }] } } as never,
  };
}

/** exact_match + the mocked judge — the deterministic/judge interplay set. */
function graders(): CompiledGrader[] {
  const { compiled } = parseGradersConfig("graders:\n  - name: exact\n    type: exact_match\n");
  return [...compiled, judgeGrader("quality")];
}

// The invoker echoes expected_output unless the sample asks it to be wrong.
const invoker = async ({ sample }: { sample: Sample }) => ({
  agentOutput: sample.metadata?.["wrong"] === true ? "WRONG" : (sample.expected_output ?? ""),
  events: [],
});

// G47 hermeticity — the judge rubrics here declare no `passing_score`, so
// runEval would otherwise consult `<process.cwd()>/.crewhaus/
// judge-calibration.json` for the calibrated cut: a stale calibration file
// sitting in the checkout must never re-gate (or WARN inside) these tests.
const noCalibration = { readCalibrationFile: () => undefined } as const;

describe("runEval — abstained sample semantics (A3)", () => {
  test("judge abstains + everything else passes → outcome abstained, out of the denominator", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: {
        name: "abstained",
        samples: yieldSamples([
          { id: "ok-1", input: "a", expected_output: "a" },
          { id: "abstain-1", input: "b", expected_output: "b" },
        ]),
      },
      compiledGraders: graders(),
      opts: { invoker, outDir, ...noCalibration },
    });

    const abstained = summary.samples.find((s) => s.sampleId === "abstain-1");
    expect(abstained?.grades.overall.abstained).toBe(true);
    expect(abstained?.grades.overall.passed).toBe(false);
    expect(abstained?.grades.overall.score).toBe(0);
    expect(sampleAbstained(abstained as never)).toBe(true);

    // Pass rate: 1 pass / 1 graded (abstain-1 left the denominator).
    expect(summary.aggregates.passRate).toBe(1);
    // meanScore averages the graded sample only: (1 + 0.75) / 2 graders.
    expect(summary.aggregates.meanScore).toBeCloseTo(0.875);
    expect(summary.aggregates.needsHuman).toBe(1);
    expect(summary.aggregates.needsHumanSampleIds).toEqual(["abstain-1"]);

    // The abstaining judge entry persists abstained + confidence into
    // grades.json (perGrader), for `crewhaus rate` follow-up tooling.
    const grades = JSON.parse(readFileSync(join(outDir, "abstain-1", "grades.json"), "utf-8"));
    const judgeEntry = grades.perGrader.find((g: { name: string }) => g.name === "quality");
    expect(judgeEntry.abstained).toBe(true);
    expect(judgeEntry.confidence).toBe(0.2);
    expect(grades.overall.abstained).toBe(true);
  });

  test("deterministic fail wins: judge abstains + exact_match fails → FAIL, not abstained", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: {
        name: "fail-wins",
        samples: yieldSamples([
          {
            id: "abstain-2",
            input: "a",
            expected_output: "a",
            metadata: { wrong: true },
          },
        ]),
      },
      compiledGraders: graders(),
      opts: { invoker, outDir, sliceKeys: ["family"], ...noCalibration },
    });

    const s = summary.samples[0];
    expect(s?.grades.overall.passed).toBe(false);
    expect(s?.grades.overall.abstained).toBeUndefined();
    // A real fail stays in the denominator: 0/1.
    expect(summary.aggregates.passRate).toBe(0);
    expect(summary.aggregates.needsHuman).toBeUndefined();
    expect(summary.aggregates.needsHumanSampleIds).toBeUndefined();
  });

  test("abstention-free runs carry no needsHuman fields (pre-A3 shape)", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: {
        name: "clean",
        samples: yieldSamples([{ id: "ok-1", input: "a", expected_output: "a" }]),
      },
      compiledGraders: graders(),
      opts: { invoker, outDir, ...noCalibration },
    });
    expect("needsHuman" in summary.aggregates).toBe(false);
    expect("needsHumanSampleIds" in summary.aggregates).toBe(false);
    // C27 rides along on every new run: Wilson CI present at n=1.
    expect(summary.aggregates.passRateCI95).toBeDefined();
  });

  test("repeats: per-trial abstention is surfaced on TrialResult", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: {
        name: "abstain-trials",
        samples: yieldSamples([{ id: "abstain-3", input: "a", expected_output: "a" }]),
      },
      compiledGraders: graders(),
      opts: { invoker, outDir, repeats: 2, ...noCalibration },
    });
    const s = summary.samples[0];
    expect(s?.trials).toHaveLength(2);
    expect(s?.trials?.every((t) => t.abstained === true)).toBe(true);
    // Conservative: an abstained trial is not a passed trial.
    expect(s?.trialPassRate).toBe(0);
  });
});

describe("runEval — judge criterion detail (A12)", () => {
  test("detail persists per grade and aggregates into criterionMeans", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: {
        name: "criteria",
        samples: yieldSamples([
          { id: "ok-1", input: "a", expected_output: "a" },
          { id: "ok-2", input: "b", expected_output: "b" },
        ]),
      },
      compiledGraders: graders(),
      opts: { invoker, outDir, ...noCalibration },
    });

    // Per-sample: the judge grade carries the breakdown into grades.json.
    const grades = JSON.parse(readFileSync(join(outDir, "ok-1", "grades.json"), "utf-8"));
    const judgeEntry = grades.perGrader.find((g: { name: string }) => g.name === "quality");
    expect(judgeEntry.detail).toEqual({ correctness: 4, tone: 5 });

    // Aggregates: per-criterion means per judge grader, raw 1–5 scale.
    expect(summary.aggregates.criterionMeans).toEqual({
      quality: { correctness: 4, tone: 5 },
    });
  });

  test("abstained verdicts contribute no criterion detail", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: {
        name: "criteria-abstain",
        samples: yieldSamples([{ id: "abstain-4", input: "a", expected_output: "a" }]),
      },
      compiledGraders: graders(),
      opts: { invoker, outDir, ...noCalibration },
    });
    expect("criterionMeans" in summary.aggregates).toBe(false);
  });
});
