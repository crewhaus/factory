/**
 * D36 (Evals Wave 5, cluster O) — per-stage prompt enumeration + the
 * `promptPath` seam on `optimizeSpec`.
 *
 * The two invariants this file pins:
 *   1. Every path `listOptimizableStages` emits is already inside spec-patch's
 *      `OPTIMIZABLE_PATHS` (D36 must not WIDEN the optimizer surface — it only
 *      makes the whitelisted surface reachable).
 *   2. `promptPath` is purely additive: a run without it behaves exactly as
 *      before (patch at `agent.instructions`, no `promptPath` key in
 *      report.json), and a run with it patches only the named stage.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpec } from "@crewhaus/spec";
import { OptimizeSpecError, optimizeSpec } from "./index";
import {
  findStage,
  formatStageNames,
  listOptimizableStages,
  stagePathIsWhitelisted,
} from "./stages";

const WORKFLOW_YAML = `name: mini-flow
target: workflow
model: claude-sonnet-4-6
steps:
  - name: draft
    instructions: Draft a one-line answer.
  - name: polish
    instructions: Polish the draft.
`;

const WORKFLOW_WITH_JUDGE_YAML = `name: judged-flow
target: workflow
model: claude-sonnet-4-6
steps:
  - name: draft
    instructions: Draft a one-line answer.
  - name: gate
    kind: judge
    judge:
      criteria: The draft answers the request.
      threshold: 0.7
  - name: polish
    instructions: Polish the draft.
`;

const GRAPH_YAML = `name: mini-graph
target: graph
model: claude-sonnet-4-6
entry: plan
nodes:
  plan:
    instructions: Plan the answer.
  answer:
    instructions: Write the final answer from the plan.
edges:
  - from: plan
    to: answer
`;

const CREW_YAML = `name: mini-crew
target: crew
model: claude-sonnet-4-6
entry: solo
roles:
  solo:
    instructions: Answer the request in one line.
`;

const CLI_YAML = `name: hello-cli
target: cli
agent:
  model: claude-sonnet-4-5
  instructions: You are a helpful assistant.
tools:
  - Read
`;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function newTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "opt-stages-"));
  tempDirs.push(dir);
  return dir;
}

describe("listOptimizableStages", () => {
  test("workflow steps enumerate in declaration order with indexed paths", () => {
    const stages = listOptimizableStages(parseSpec(WORKFLOW_YAML));
    expect(stages.map((s) => s.name)).toEqual(["draft", "polish"]);
    expect(stages.map((s) => s.kind)).toEqual(["step", "step"]);
    expect(stages[0]?.path).toEqual(["steps", "0", "instructions"]);
    expect(stages[1]?.path).toEqual(["steps", "1", "instructions"]);
    expect(stages[0]?.instructions).toBe("Draft a one-line answer.");
  });

  test("`kind: judge` steps are NOT stages, and the surviving indices stay TRUE spec indices", () => {
    const stages = listOptimizableStages(parseSpec(WORKFLOW_WITH_JUDGE_YAML));
    expect(stages.map((s) => s.name)).toEqual(["draft", "polish"]);
    // `polish` is steps[2] in the spec even though it is the 2nd STAGE — an
    // off-by-one here would rewrite the judge gate's config.
    expect(stages[1]?.path).toEqual(["steps", "2", "instructions"]);
  });

  test("graph nodes and crew roles key by NAME", () => {
    const graph = listOptimizableStages(parseSpec(GRAPH_YAML));
    expect(graph.map((s) => s.name)).toEqual(["plan", "answer"]);
    expect(graph[0]?.kind).toBe("node");
    expect(graph[0]?.path).toEqual(["nodes", "plan", "instructions"]);

    const crew = listOptimizableStages(parseSpec(CREW_YAML));
    expect(crew.map((s) => s.name)).toEqual(["solo"]);
    expect(crew[0]?.kind).toBe("role");
    expect(crew[0]?.path).toEqual(["roles", "solo", "instructions"]);
  });

  test("single-agent shapes return exactly one `agent` stage", () => {
    const stages = listOptimizableStages(parseSpec(CLI_YAML));
    expect(stages).toHaveLength(1);
    expect(stages[0]?.kind).toBe("agent");
    expect(stages[0]?.path).toEqual(["agent", "instructions"]);
  });

  test("every emitted path is already whitelisted in OPTIMIZABLE_PATHS", () => {
    for (const yaml of [WORKFLOW_YAML, GRAPH_YAML, CREW_YAML, CLI_YAML]) {
      const spec = parseSpec(yaml);
      for (const stage of listOptimizableStages(spec)) {
        expect(stagePathIsWhitelisted(spec.target, stage.path)).toBe(true);
      }
    }
  });
});

describe("findStage / formatStageNames", () => {
  test("resolves by name and reports the vocabulary on a miss", () => {
    const stages = listOptimizableStages(parseSpec(WORKFLOW_YAML));
    expect(findStage(stages, "polish")?.path).toEqual(["steps", "1", "instructions"]);
    expect(findStage(stages, "nope")).toBeUndefined();
    expect(formatStageNames(stages)).toBe("draft, polish");
  });
});

describe("extractCurrentPrompt on multi-prompt shapes", () => {
  test("refuses and names the stages instead of a phantom flag", async () => {
    const dir = newTmp();
    const specPath = join(dir, "crewhaus.yaml");
    writeFileSync(specPath, WORKFLOW_YAML);
    let message = "";
    try {
      await optimizeSpec({
        specPath,
        fitness: async () => 1,
        trainSet: [{ id: "t1", input: "x" }],
        devSet: [{ id: "d1", input: "x" }],
        iterations: 1,
        outDir: join(dir, "out"),
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("--stage");
    expect(message).toContain("draft, polish");
    // The retired misdirection must not come back.
    expect(message).not.toContain("--path");
  });
});

describe("optimizeSpec({ promptPath })", () => {
  test("patches ONLY the named workflow step and leaves its sibling byte-identical", async () => {
    const dir = newTmp();
    const specPath = join(dir, "crewhaus.yaml");
    writeFileSync(specPath, WORKFLOW_YAML);
    const result = await optimizeSpec({
      specPath,
      promptPath: ["steps", "1", "instructions"],
      // Longer prompt = better, so the rule-based mutator always wins.
      fitness: async (prompt: string) => prompt.length / 100,
      trainSet: [{ id: "t1", input: "x", expected_output: "y" }],
      devSet: [{ id: "d1", input: "x", expected_output: "y" }],
      iterations: 3,
      seed: 42,
      outDir: join(dir, "out"),
    });
    expect(result.applied).toBe(true);
    expect(result.patch.path).toEqual(["steps", "1", "instructions"]);
    expect(result.patch.target).toBe("workflow");
    expect(result.patch.rationale).toContain("stage steps.1.instructions");

    const patched = parseSpec(result.patchedYaml);
    if (patched.target !== "workflow") throw new Error("expected workflow");
    const [draft, polish] = patched.steps;
    if (draft === undefined || polish === undefined) throw new Error("missing steps");
    if (!("instructions" in draft) || !("instructions" in polish)) {
      throw new Error("expected agent steps");
    }
    // Untouched sibling.
    expect(draft.instructions).toBe("Draft a one-line answer.");
    // Rewritten stage.
    expect(polish.instructions).not.toBe("Polish the draft.");
    expect(polish.instructions).toBe(String(result.patch.value));
    // The base prompt came from the stage, not from a phantom agent block.
    expect(result.trajectory[0]?.prompt).toBe("Polish the draft.");

    // Comments/key order survive the CST round-trip, and the file itself is
    // untouched without --write-back.
    expect(readFileSync(specPath, "utf-8")).toBe(WORKFLOW_YAML);

    const report = JSON.parse(readFileSync(join(dir, "out", "report.json"), "utf-8")) as {
      promptPath?: unknown;
    };
    expect(report.promptPath).toEqual(["steps", "1", "instructions"]);
  });

  test("a graph node path patches by node NAME", async () => {
    const dir = newTmp();
    const specPath = join(dir, "crewhaus.yaml");
    writeFileSync(specPath, GRAPH_YAML);
    const result = await optimizeSpec({
      specPath,
      promptPath: ["nodes", "answer", "instructions"],
      fitness: async (prompt: string) => prompt.length / 100,
      trainSet: [{ id: "t1", input: "x" }],
      devSet: [{ id: "d1", input: "x" }],
      iterations: 2,
      seed: 7,
      outDir: join(dir, "out"),
    });
    expect(result.applied).toBe(true);
    const patched = parseSpec(result.patchedYaml);
    if (patched.target !== "graph") throw new Error("expected graph");
    const plan = patched.nodes["plan"];
    if (plan === undefined || !("instructions" in plan)) throw new Error("missing plan node");
    expect(plan.instructions).toBe("Plan the answer.");
  });

  test("a promptPath that is not a string instructions block is refused before any spend", async () => {
    const dir = newTmp();
    const specPath = join(dir, "crewhaus.yaml");
    writeFileSync(specPath, WORKFLOW_YAML);
    let calls = 0;
    await expect(
      optimizeSpec({
        specPath,
        promptPath: ["steps", "9", "instructions"],
        fitness: async () => {
          calls += 1;
          return 1;
        },
        trainSet: [{ id: "t1", input: "x" }],
        devSet: [{ id: "d1", input: "x" }],
        iterations: 1,
        outDir: join(dir, "out"),
      }),
    ).rejects.toThrow(OptimizeSpecError);
    expect(calls).toBe(0);
  });

  test("omitting promptPath keeps the historical single-agent behaviour byte-for-byte", async () => {
    const dir = newTmp();
    const specPath = join(dir, "crewhaus.yaml");
    writeFileSync(specPath, CLI_YAML);
    const result = await optimizeSpec({
      specPath,
      fitness: async (prompt: string) => prompt.length / 100,
      trainSet: [{ id: "t1", input: "x" }],
      devSet: [{ id: "d1", input: "x" }],
      iterations: 2,
      seed: 42,
      outDir: join(dir, "out"),
    });
    expect(result.patch.path).toEqual(["agent", "instructions"]);
    expect(result.patch.rationale).not.toContain("stage ");
    const report = JSON.parse(readFileSync(join(dir, "out", "report.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect("promptPath" in report).toBe(false);
  });
});
