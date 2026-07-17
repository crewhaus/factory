/**
 * PR 19 — `type: registry` grader entries resolve against
 * `RunEvalOptions.graderRegistry` (the same placeholder-substitution
 * pattern `llm_judge` uses with eval-judge). Covers: happy-path
 * resolution, the missing-registry loud error, and unknown-name lookup
 * failures surfacing before any sample runs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { type Grader, parseGradersConfig } from "@crewhaus/eval-grader";
import { GraderRegistry } from "@crewhaus/grader-registry";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { type AgentInvoker, runEval } from "./index";

const SPEC = `name: registry-test
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

const REGISTRY_GRADERS = `
graders:
  - name: always
    type: registry
    grader: test.alwaysPass
`;

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-registry-graders-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const SAMPLES: Sample[] = [{ id: "s1", input: "x", expected_output: "y" }];
const invoker: AgentInvoker = async () => ({ agentOutput: "y", transcript: [], events: [] });

describe("runEval — registry grader resolution", () => {
  test("parseGradersConfig compiles a registry entry with registrySpec", () => {
    const { compiled } = parseGradersConfig(REGISTRY_GRADERS);
    expect(compiled).toHaveLength(1);
    expect(compiled[0]?.registrySpec).toEqual({ grader: "test.alwaysPass" });
    // The placeholder refuses to run unresolved.
    expect(
      compiled[0]?.grader(SAMPLES[0] as Sample, {
        agentOutput: "",
        events: [],
        transcript: [],
        toolCalls: [],
        turns: 0,
        latencyMs: 0,
      }),
    ).rejects.toThrow(/graderRegistry/);
  });

  test("resolves by name and grades with the registered grader", async () => {
    const registry = new GraderRegistry();
    const alwaysPass: Grader = async () => ({ passed: true, score: 1, rationale: "registered" });
    registry.register("test.alwaysPass", alwaysPass);
    const { compiled } = parseGradersConfig(REGISTRY_GRADERS);
    const summary = await runEval({
      ir: narrowToAgent(lower(parseSpec(SPEC))),
      dataset: { name: "reg", samples: yieldSamples(SAMPLES) },
      compiledGraders: compiled,
      opts: { invoker, outDir: newTempRoot(), graderRegistry: registry },
    });
    expect(summary.aggregates.passRate).toBe(1);
    const per = summary.samples[0]?.grades.perGrader[0];
    expect(per?.name).toBe("always");
    expect(per?.rationale).toBe("registered");
  });

  test("a registry entry without a graderRegistry falls back to the default registry (G14)", async () => {
    // `test.alwaysPass` is not a pack/plugin name, so the automatic default
    // registry (constructed because no graderRegistry was supplied) fails
    // the lookup loudly at run start — listing the actual vocabulary.
    const { compiled } = parseGradersConfig(REGISTRY_GRADERS);
    await expect(
      runEval({
        ir: narrowToAgent(lower(parseSpec(SPEC))),
        dataset: { name: "reg", samples: yieldSamples(SAMPLES) },
        compiledGraders: compiled,
        opts: { invoker, outDir: newTempRoot(), cwd: newTempRoot() },
      }),
    ).rejects.toThrow(/no grader registered as "test.alwaysPass".*registered graders:/);
  });

  test("an unregistered name fails at run start, not per sample", async () => {
    const registry = new GraderRegistry(); // empty — lookup throws
    const { compiled } = parseGradersConfig(REGISTRY_GRADERS);
    await expect(
      runEval({
        ir: narrowToAgent(lower(parseSpec(SPEC))),
        dataset: { name: "reg", samples: yieldSamples(SAMPLES) },
        compiledGraders: compiled,
        opts: { invoker, outDir: newTempRoot(), graderRegistry: registry },
      }),
    ).rejects.toThrow(/no grader registered as "test.alwaysPass"/);
  });
});
