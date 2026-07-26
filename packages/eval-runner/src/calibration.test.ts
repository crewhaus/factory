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
 *
 * HERMETICITY: every `runEval` here pins `cwd` to an `mkdtemp` sandbox, so the
 * calibration path the runner resolves (and NAMES in its log records) can
 * never reference the package checkout — a `judge_calibration.malformed` WARN
 * carrying `.../packages/eval-runner/.crewhaus/judge-calibration.json` reads
 * like a torn artifact leaked into the repo. The two tests that deliberately
 * feed malformed input also CAPTURE stderr and assert the warning, so the
 * expected diagnostic is a pinned assertion instead of noise in the suite
 * output. Nothing here ever writes to disk outside the sandbox roots.
 */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const { runEval, JUDGE_CALIBRATION_RELPATH } = await import("./index");

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

/** The sandbox the runner resolves `.crewhaus/judge-calibration.json` under.
 *  Nothing is ever written there (every test injects `readCalibrationFile`);
 *  it exists so the resolved path — which the runner logs — names a temp dir
 *  rather than the package checkout. */
const SANDBOX_CWD = newTempRoot();

/** Snapshot (at module load, before any test runs) of whether the REAL cwd
 *  carries a calibration file, so the closing test can pin that this suite
 *  neither created nor removed one. */
const CWD_CALIBRATION_PATH = join(process.cwd(), JUDGE_CALIBRATION_RELPATH);
const CWD_CALIBRATION_EXISTED = existsSync(CWD_CALIBRATION_PATH);

/** Capture stderr (the logger's sink) for the duration of `fn`, matching the
 *  pattern in `index.resume-economics.test.ts`. Restored in a `finally`, so a
 *  throwing assertion can never leave the suite's stderr hijacked. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  };
  try {
    return { value: await fn(), stderr: captured };
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
}

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
        cwd: SANDBOX_CWD,
        readCalibrationFile: (path) => {
          readPaths.push(path);
          return CALIBRATION_JSON;
        },
      },
    });

    expect(readPaths).toHaveLength(1);
    expect(readPaths[0]).toBe(join(SANDBOX_CWD, ".crewhaus", "judge-calibration.json"));
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
        cwd: SANDBOX_CWD,
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
      opts: { invoker, outDir, cwd: SANDBOX_CWD, readCalibrationFile: () => CALIBRATION_JSON },
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
      opts: { invoker, outDir, cwd: SANDBOX_CWD, readCalibrationFile: () => undefined },
    });
    // The stubbed loadRubric echoes: no passing_score key was injected.
    expect(boundRubrics[0]?.passing_score).toBeUndefined();
    expect(summary.config.judgeCalibration).toBeUndefined();
  });

  test("a malformed calibration file is a warning, never a crash", async () => {
    const outDir = newTempRoot();
    boundRubrics.length = 0;
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    // The WARN is the CONTRACT here, so capture it rather than let it bleed
    // into the suite's stderr looking like a real leaked artifact.
    const { value: summary, stderr } = await captureStderr(() =>
      runEval({
        ir,
        dataset: { name: "cal5", samples: yieldSamples(SAMPLES) },
        compiledGraders: [judgeGrader("judge_e")],
        opts: { invoker, outDir, cwd: SANDBOX_CWD, readCalibrationFile: () => "{not json" },
      }),
    );
    expect(summary.config.judgeCalibration).toBeUndefined();
    expect(summary.aggregates.passRate).toBe(1);
    expect(stderr).toContain("judge_calibration.malformed");
    // …naming the SANDBOX path, never the package checkout.
    expect(stderr).toContain(join(SANDBOX_CWD, ".crewhaus", "judge-calibration.json"));
  });

  test("an out-of-range minScore entry is rejected as malformed", async () => {
    const outDir = newTempRoot();
    boundRubrics.length = 0;
    const bad = JSON.stringify({
      version: 1,
      calibrations: { "cal-test": { minScore: 7 } },
    });
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { value: summary, stderr } = await captureStderr(() =>
      runEval({
        ir,
        dataset: { name: "cal6", samples: yieldSamples(SAMPLES) },
        compiledGraders: [judgeGrader("judge_f")],
        opts: { invoker, outDir, cwd: SANDBOX_CWD, readCalibrationFile: () => bad },
      }),
    );
    expect(boundRubrics[0]?.passing_score).toBeUndefined();
    expect(summary.config.judgeCalibration).toBeUndefined();
    expect(stderr).toContain("judge_calibration.malformed");
    expect(stderr).toContain("minScore must be a number in [0,1], got 7");
  });

  test("no calibration file is ever created — not in the sandbox, not in cwd", () => {
    // The runner only READS this path; `judge calibrate --apply` is the sole
    // writer (and it is separately pinned atomic in
    // `apps/cli/src/judge-calibrate.atomic.test.ts`). Nothing in this suite —
    // and so nothing in a CI run of this package — may leave one behind, which
    // is what the `judge_calibration.malformed` WARN naming the package tree
    // made a CI reader believe had happened.
    expect(existsSync(join(SANDBOX_CWD, ".crewhaus"))).toBe(false);
    // Invariance, not absence: an operator may legitimately have run `judge
    // calibrate --apply` in their checkout, so pin that THIS suite changed
    // nothing rather than that the file is absent.
    expect(existsSync(CWD_CALIBRATION_PATH)).toBe(CWD_CALIBRATION_EXISTED);
  });
});
