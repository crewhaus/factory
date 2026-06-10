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
const loadedRubrics: unknown[] = [];

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
      opts: { invoker, outDir, judgeModel: "claude-judge-x" },
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
      opts: { invoker, outDir },
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
      opts: { invoker, outDir },
    });

    // model is undefined → createJudgeGrader called with `{}` (no model key).
    expect(boundModels).toEqual([undefined]);
  });
});
