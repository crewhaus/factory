/**
 * Isolated test for the `llm_judge` grader-resolution branch in `runEval`.
 *
 * The runner replaces any compiled grader carrying a `judgeSpec` with a real
 * judge grader bound to the run's `judgeModel` (or the per-grader override).
 * We stub `@crewhaus/eval-judge` so no LLM/network is touched: `loadRubric`
 * echoes its input and `createJudgeGrader` returns a deterministic grader that
 * records the model it was bound to. `mock.module` is process-global, so this
 * lives in its own file (Bun gives each test file a fresh module graph).
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

const boundModels: Array<string | undefined> = [];
// A2 — the full option bags createJudgeGrader was called with, so the
// judges-panel threading is assertable alongside the model binding.
const boundOpts: Array<Record<string, unknown>> = [];
const loadedRubrics: unknown[] = [];
// NEW-graders-2 — the rubrics createJudgeGrader was handed, so the
// categorical dispatch (real loadCategoricalRubric → grader factory) is
// assertable alongside the option threading.
const boundRubrics: unknown[] = [];

// Capture the real module so `afterAll` can restore it — `mock.module` is
// process-global and does not auto-restore across test files. The capture is
// a plain-object SNAPSHOT (`{ ...ns }`): an ESM namespace is a live view that
// resolves to the stubs once mock.module patches the module, so restoring
// from the namespace itself would silently reinstall the stubs.
const realEvalJudge = { ...(await import("@crewhaus/eval-judge")) };

mock.module("@crewhaus/eval-judge", () => ({
  ...realEvalJudge,
  loadRubric: (input: unknown) => {
    loadedRubrics.push(input);
    return { criteria: [{ name: "quality", weight: 1, description: "is it good" }] };
  },
  createJudgeGrader: (_rubric: unknown, opts: { model?: string } = {}) => {
    boundModels.push(opts.model);
    boundOpts.push({ ...opts });
    boundRubrics.push(_rubric);
    // Deterministic grader: always passes, no network.
    return async (): Promise<GradeResult> => ({
      passed: true,
      score: 1,
      rationale: `judged with ${opts.model ?? "(default)"}`,
    });
  },
}));

const { runEval } = await import("./index");

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

const SPEC = `name: judge-test
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
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-judge-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
  mock.module("@crewhaus/eval-judge", () => realEvalJudge);
});

// G47 hermeticity — the scalar judge rubrics here declare no
// `passing_score`, so runEval would otherwise consult
// `<process.cwd()>/.crewhaus/judge-calibration.json` for the calibrated
// cut: a stale calibration file sitting in the checkout must never re-gate
// (or WARN inside) these tests. The one test that PINS calibration
// behavior injects its own readCalibrationFile instead.
const noCalibration = { readCalibrationFile: () => undefined } as const;

// A compiled grader with a judgeSpec but no per-grader model → uses opts.judgeModel.
function judgeGraderNoModel(name: string): CompiledGrader {
  return {
    name,
    grader: async () => {
      throw new Error("placeholder must be replaced");
    },
    weight: 1,
    judgeSpec: { rubric: { criteria: [{ name: "q", weight: 1, description: "d" }] } } as never,
  };
}

// A compiled grader whose judgeSpec carries its own model override.
function judgeGraderWithModel(name: string, model: string): CompiledGrader {
  return {
    name,
    grader: async () => {
      throw new Error("placeholder must be replaced");
    },
    weight: 1,
    judgeSpec: {
      rubric: { criteria: [{ name: "q", weight: 1, description: "d" }] },
      model,
    } as never,
  };
}

describe("runEval — llm_judge resolution", () => {
  test("binds judge grader to opts.judgeModel when no per-grader override", async () => {
    const outDir = newTempRoot();
    boundModels.length = 0;
    loadedRubrics.length = 0;
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "hi", expected_output: "y" }];
    const invoker = async () => ({ agentOutput: "anything", events: [] });

    const summary = await runEval({
      ir,
      dataset: { name: "judged", samples: yieldSamples(samples) },
      compiledGraders: [judgeGraderNoModel("rubricA")],
      opts: { invoker, outDir, judgeModel: "claude-judge-x", ...noCalibration },
    });

    expect(loadedRubrics).toHaveLength(1);
    expect(boundModels).toEqual(["claude-judge-x"]);
    expect(summary.config.graderNames).toEqual(["rubricA"]);
    expect(summary.config.judgeModel).toBe("claude-judge-x");
    expect(summary.aggregates.passRate).toBe(1);

    // judgeModel surfaced in the persisted run.json snapshot.
    const runJson = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8"));
    expect(runJson.judgeModel).toBe("claude-judge-x");
    expect(runJson.graderNames).toEqual(["rubricA"]);

    // NEW-HUNT-2 — the reproducibility manifest records the judge sampling
    // params with the DEFAULTS resolved (pinned temperature 0, single
    // call), so the pin is visible even when nothing was declared.
    expect(runJson.judgeSampling).toEqual([{ name: "rubricA", temperature: 0, repeats: 1 }]);
    expect(summary.config.judgeSampling).toEqual([{ name: "rubricA", temperature: 0, repeats: 1 }]);
  });

  test("declared judgeSpec temperature/repeats land verbatim in judgeSampling", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "hi", expected_output: "y" }];
    const invoker = async () => ({ agentOutput: "anything", events: [] });

    const grader = judgeGraderNoModel("rubricT");
    const summary = await runEval({
      ir,
      dataset: { name: "judged-sampling", samples: yieldSamples(samples) },
      compiledGraders: [
        {
          ...grader,
          judgeSpec: { ...(grader.judgeSpec as object), temperature: 0.5, repeats: 3 } as never,
        },
      ],
      opts: { invoker, outDir, ...noCalibration },
    });

    const runJson = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8"));
    expect(runJson.judgeSampling).toEqual([{ name: "rubricT", temperature: 0.5, repeats: 3 }]);
    expect(summary.config.judgeSampling).toEqual([
      { name: "rubricT", temperature: 0.5, repeats: 3 },
    ]);
  });

  test("A2 — a judges panel threads to createJudgeGrader and rides judgeSampling", async () => {
    const outDir = newTempRoot();
    boundOpts.length = 0;
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "hi", expected_output: "y" }];
    const invoker = async () => ({ agentOutput: "anything", events: [] });

    const grader = judgeGraderNoModel("rubricPanel");
    const summary = await runEval({
      ir,
      dataset: { name: "judged-panel", samples: yieldSamples(samples) },
      compiledGraders: [
        {
          ...grader,
          judgeSpec: {
            ...(grader.judgeSpec as object),
            judges: ["claude-sonnet-4-5", "openai/gpt-4o"],
          } as never,
        },
      ],
      opts: { invoker, outDir, ...noCalibration },
    });

    // The panel roster reaches the grader factory …
    expect(boundOpts).toHaveLength(1);
    expect(boundOpts[0]?.judges).toEqual(["claude-sonnet-4-5", "openai/gpt-4o"]);
    // … and the reproducibility manifest, with defaults still resolved.
    const runJson = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8"));
    expect(runJson.judgeSampling).toEqual([
      {
        name: "rubricPanel",
        temperature: 0,
        repeats: 1,
        judges: ["claude-sonnet-4-5", "openai/gpt-4o"],
      },
    ]);
    expect(summary.config.judgeSampling?.[0]?.judges).toEqual([
      "claude-sonnet-4-5",
      "openai/gpt-4o",
    ]);
  });

  test("A2 — single-judge graders record NO judges key (byte-identical entries)", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "hi", expected_output: "y" }];
    const invoker = async () => ({ agentOutput: "anything", events: [] });

    const summary = await runEval({
      ir,
      dataset: { name: "judged-single", samples: yieldSamples(samples) },
      compiledGraders: [judgeGraderNoModel("rubricSingle")],
      opts: { invoker, outDir, ...noCalibration },
    });
    const entry = summary.config.judgeSampling?.[0];
    expect(entry).toEqual({ name: "rubricSingle", temperature: 0, repeats: 1 });
    expect(entry !== undefined && "judges" in entry).toBe(false);
  });

  test("per-grader judgeSpec.model overrides the run judgeModel", async () => {
    const outDir = newTempRoot();
    boundModels.length = 0;
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "hi", expected_output: "y" }];
    const invoker = async () => ({ agentOutput: "anything", events: [] });

    await runEval({
      ir,
      dataset: { name: "judged2", samples: yieldSamples(samples) },
      compiledGraders: [judgeGraderWithModel("rubricB", "claude-override")],
      // No opts.judgeModel → the per-grader override must win.
      opts: { invoker, outDir, ...noCalibration },
    });

    expect(boundModels).toEqual(["claude-override"]);
  });

  test("a judge grader with neither override nor judgeModel binds the default", async () => {
    const outDir = newTempRoot();
    boundModels.length = 0;
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "hi", expected_output: "y" }];
    const invoker = async () => ({ agentOutput: "anything", events: [] });

    await runEval({
      ir,
      dataset: { name: "judged3", samples: yieldSamples(samples) },
      compiledGraders: [judgeGraderNoModel("rubricC")],
      opts: { invoker, outDir, ...noCalibration },
    });

    // model is undefined → createJudgeGrader called with `{}` (no model key).
    expect(boundModels).toEqual([undefined]);
  });
});

// NEW-graders-2/3 — categorical dispatch + judge-target threading.
describe("runEval — categorical rubrics + target (cluster C)", () => {
  const CATEGORICAL_RUBRIC = {
    kind: "categorical",
    labels: [
      { name: "good", score: 1, description: "acceptable" },
      { name: "bad", score: 0, description: "unacceptable" },
    ],
    passing_labels: ["good"],
  };

  function categoricalGrader(name: string): CompiledGrader {
    return {
      name,
      grader: async () => {
        throw new Error("placeholder must be replaced");
      },
      weight: 1,
      judgeSpec: { rubric: CATEGORICAL_RUBRIC } as never,
    };
  }

  test("a categorical judgeSpec resolves through loadCategoricalRubric to the grader factory", async () => {
    const outDir = newTempRoot();
    boundRubrics.length = 0;
    loadedRubrics.length = 0;
    boundOpts.length = 0;
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "hi", expected_output: "y" }];
    const invoker = async () => ({ agentOutput: "anything", events: [] });

    const summary = await runEval({
      ir,
      dataset: { name: "judged-categorical", samples: yieldSamples(samples) },
      compiledGraders: [categoricalGrader("labeler")],
      opts: { invoker, outDir, judgeModel: "claude-judge-x", ...noCalibration },
    });

    // The REAL loadCategoricalRubric validated it (defaults applied) and the
    // grader factory received the categorical shape — never the scalar loader.
    expect(loadedRubrics).toHaveLength(0);
    expect(boundRubrics).toHaveLength(1);
    expect((boundRubrics[0] as { kind?: string }).kind).toBe("categorical");
    expect(boundOpts[0]?.model).toBe("claude-judge-x");
    expect(summary.aggregates.passRate).toBe(1);
    // judgeSampling still records the entry (defaults resolved, no target).
    const runJson = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8"));
    expect(runJson.judgeSampling).toEqual([{ name: "labeler", temperature: 0, repeats: 1 }]);
  });

  test("a malformed categorical rubric dies loudly at resolution", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "hi" }];
    const invoker = async () => ({ agentOutput: "anything", events: [] });

    const bad = categoricalGrader("broken");
    await expect(
      runEval({
        ir,
        dataset: { name: "judged-bad-categorical", samples: yieldSamples(samples) },
        compiledGraders: [
          {
            ...bad,
            judgeSpec: {
              rubric: { ...CATEGORICAL_RUBRIC, passing_labels: ["nope"] },
            } as never,
          },
        ],
        opts: { invoker, outDir, ...noCalibration },
      }),
    ).rejects.toThrow(/not a declared label/);
  });

  test("G47 guard: categorical rubrics never join the calibrated-cut path", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "hi", expected_output: "y" }];
    const invoker = async () => ({ agentOutput: "anything", events: [] });

    const summary = await runEval({
      ir,
      dataset: { name: "judged-categorical-nocal", samples: yieldSamples(samples) },
      compiledGraders: [categoricalGrader("labeler")],
      opts: {
        invoker,
        outDir,
        // A calibration file exists — a scalar cut-less rubric would consume
        // it; the categorical one must NOT (its gate is label membership).
        readCalibrationFile: () => JSON.stringify({ calibrations: { default: { minScore: 0.9 } } }),
      },
    });

    expect(summary.config.judgeCalibration).toBeUndefined();
    const runJson = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8"));
    expect("judgeCalibration" in runJson).toBe(false);
  });

  test("NEW-graders-3 — target threads to the grader factory and rides judgeSampling", async () => {
    const outDir = newTempRoot();
    boundOpts.length = 0;
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "hi", expected_output: "y" }];
    const invoker = async () => ({ agentOutput: "anything", events: [] });

    const grader = judgeGraderNoModel("rubricTraj");
    const summary = await runEval({
      ir,
      dataset: { name: "judged-target", samples: yieldSamples(samples) },
      compiledGraders: [
        {
          ...grader,
          judgeSpec: { ...(grader.judgeSpec as object), target: "transcript" } as never,
        },
      ],
      opts: { invoker, outDir, ...noCalibration },
    });

    expect(boundOpts).toHaveLength(1);
    expect(boundOpts[0]?.target).toBe("transcript");
    const runJson = JSON.parse(readFileSync(join(outDir, "run.json"), "utf-8"));
    expect(runJson.judgeSampling).toEqual([
      { name: "rubricTraj", temperature: 0, repeats: 1, target: "transcript" },
    ]);
    expect(summary.config.judgeSampling?.[0]?.target).toBe("transcript");
  });

  test("NEW-graders-3 — default-target graders record NO target key (byte-identical)", async () => {
    const outDir = newTempRoot();
    boundOpts.length = 0;
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const samples: Sample[] = [{ id: "q1", input: "hi", expected_output: "y" }];
    const invoker = async () => ({ agentOutput: "anything", events: [] });

    const summary = await runEval({
      ir,
      dataset: { name: "judged-no-target", samples: yieldSamples(samples) },
      compiledGraders: [judgeGraderNoModel("rubricPlain")],
      opts: { invoker, outDir, ...noCalibration },
    });

    expect(boundOpts[0] !== undefined && "target" in boundOpts[0]).toBe(false);
    const entry = summary.config.judgeSampling?.[0];
    expect(entry !== undefined && "target" in entry).toBe(false);
  });
});
