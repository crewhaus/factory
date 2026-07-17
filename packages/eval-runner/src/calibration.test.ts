/**
 * Loop contract 0.4 (Batch B, G47) — `llm_judge` grader resolution consults
 * `.crewhaus/judge-calibration.json` for the default min-score when the
 * rubric declares no `passing_score`, via the injectable
 * `RunEvalOptions.readCalibrationFile` seam, and logs the application into
 * the run summary (`config.judgeCalibration`).
 *
 * `@crewhaus/eval-judge` is stubbed so no LLM/network is touched; the stub
 * records the rubric each judge grader was bound to. `mock.module` is
 * process-global, so this lives in its own file.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import type { CompiledGrader, GradeResult } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";

const boundRubrics: Array<{ passing_score?: number }> = [];

// Snapshot-capture the real module for restoration (mock.module is
// process-global; an ESM namespace is a live view, hence the `{ ...ns }`).
const realEvalJudge = { ...(await import("@crewhaus/eval-judge")) };

mock.module("@crewhaus/eval-judge", () => ({
  ...realEvalJudge,
  // Echo the rubric through untouched so the runner's calibration overlay is
  // observable on what createJudgeGrader receives.
  loadRubric: (input: unknown) => input,
  createJudgeGrader: (rubric: { passing_score?: number }) => {
    boundRubrics.push(rubric);
    return async (): Promise<GradeResult> => ({ passed: true, score: 1, rationale: "stub" });
  },
}));

const { runEval } = await import("./index");

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

const SPEC = `name: cal-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: hi
`;

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cal-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
  mock.module("@crewhaus/eval-judge", () => realEvalJudge);
});

const RUBRIC = {
  criteria: [
    {
      name: "q",
      description: "d",
      anchors: { "1": "a", "2": "b", "3": "c", "4": "d", "5": "e" },
    },
  ],
};

function judgeGrader(name: string, passingScore?: number): CompiledGrader {
  return {
    name,
    grader: async () => {
      throw new Error("placeholder must be replaced");
    },
    weight: 1,
    judgeSpec: {
      rubric: {
        ...RUBRIC,
        ...(passingScore !== undefined ? { passing_score: passingScore } : {}),
      },
    },
  };
}

const CALIBRATION_JSON = JSON.stringify({
  version: 1,
  calibrations: {
    "cal-test": {
      minScore: 0.62,
      model: "claude-sonnet-4-5",
      correlation: 0.8,
      bias: 0.05,
      pairCount: 24,
      updatedAt: "2026-07-01T00:00:00Z",
    },
    default: {
      minScore: 0.5,
      correlation: 0.7,
      bias: 0,
      pairCount: 10,
      updatedAt: "2026-07-01T00:00:00Z",
    },
  },
});

const SAMPLES: Sample[] = [{ id: "q1", input: "hi", expected_output: "y" }];
const invoker = async () => ({ agentOutput: "anything", events: [] });

describe("runEval — judge calibration consumption (G47)", () => {
  test("an unspecified passing_score gates on the spec's calibrated cut", async () => {
    const outDir = newTempRoot();
    boundRubrics.length = 0;
    const readPaths: string[] = [];
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: { name: "cal", samples: yieldSamples(SAMPLES) },
      compiledGraders: [judgeGrader("judge_a")],
      opts: {
        invoker,
        outDir,
        readCalibrationFile: (path) => {
          readPaths.push(path);
          return CALIBRATION_JSON;
        },
      },
    });

    expect(readPaths).toHaveLength(1);
    expect(readPaths[0]).toMatch(/\.crewhaus[/\\]judge-calibration\.json$/);
    // minScore 0.62 on the [0,1] cut → 1 + 0.62·4 = 3.48 on the 1–5 gate.
    expect(boundRubrics).toHaveLength(1);
    expect(boundRubrics[0]?.passing_score).toBeCloseTo(3.48);

    // The application is logged into the run summary (and run.json).
    const applied = summary.config.judgeCalibration;
    expect(applied?.applied).toEqual([
      { grader: "judge_a", specKey: "cal-test", minScore: 0.62, passingScore: 3.48 },
    ]);
    const runJson = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8"));
    expect(runJson.judgeCalibration.applied[0].grader).toBe("judge_a");
  });

  test("a rubric-declared passing_score is never overridden", async () => {
    const outDir = newTempRoot();
    boundRubrics.length = 0;
    let reads = 0;
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: { name: "cal2", samples: yieldSamples(SAMPLES) },
      compiledGraders: [judgeGrader("judge_b", 4)],
      opts: {
        invoker,
        outDir,
        readCalibrationFile: () => {
          reads += 1;
          return CALIBRATION_JSON;
        },
      },
    });
    // Nothing needed calibrating, so the file is never even read.
    expect(reads).toBe(0);
    expect(boundRubrics[0]?.passing_score).toBe(4);
    expect(summary.config.judgeCalibration).toBeUndefined();
  });

  test("a spec without its own entry falls back to the `default` key", async () => {
    const outDir = newTempRoot();
    boundRubrics.length = 0;
    const other =
      "name: some-other-spec\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n";
    const ir = narrowToAgent(lower(parseSpec(other)));
    const summary = await runEval({
      ir,
      dataset: { name: "cal3", samples: yieldSamples(SAMPLES) },
      compiledGraders: [judgeGrader("judge_c")],
      opts: { invoker, outDir, readCalibrationFile: () => CALIBRATION_JSON },
    });
    expect(boundRubrics[0]?.passing_score).toBeCloseTo(3.0);
    expect(summary.config.judgeCalibration?.applied[0]?.specKey).toBe("default");
  });

  test("no calibration file: the rubric default stands, nothing recorded", async () => {
    const outDir = newTempRoot();
    boundRubrics.length = 0;
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: { name: "cal4", samples: yieldSamples(SAMPLES) },
      compiledGraders: [judgeGrader("judge_d")],
      opts: { invoker, outDir, readCalibrationFile: () => undefined },
    });
    // The stubbed loadRubric echoes: no passing_score key was injected.
    expect(boundRubrics[0]?.passing_score).toBeUndefined();
    expect(summary.config.judgeCalibration).toBeUndefined();
  });

  test("a malformed calibration file is a warning, never a crash", async () => {
    const outDir = newTempRoot();
    boundRubrics.length = 0;
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: { name: "cal5", samples: yieldSamples(SAMPLES) },
      compiledGraders: [judgeGrader("judge_e")],
      opts: { invoker, outDir, readCalibrationFile: () => "{not json" },
    });
    expect(summary.config.judgeCalibration).toBeUndefined();
    expect(summary.aggregates.passRate).toBe(1);
  });

  test("an out-of-range minScore entry is rejected as malformed", async () => {
    const outDir = newTempRoot();
    boundRubrics.length = 0;
    const bad = JSON.stringify({
      version: 1,
      calibrations: { "cal-test": { minScore: 7 } },
    });
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const summary = await runEval({
      ir,
      dataset: { name: "cal6", samples: yieldSamples(SAMPLES) },
      compiledGraders: [judgeGrader("judge_f")],
      opts: { invoker, outDir, readCalibrationFile: () => bad },
    });
    expect(boundRubrics[0]?.passing_score).toBeUndefined();
    expect(summary.config.judgeCalibration).toBeUndefined();
  });
});
