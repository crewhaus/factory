/**
 * 0.6.0 PR 9d — the guide / shadow / committee side calls are constructed by
 * `@crewhaus/model-service`'s `wireSideCalls` and consumed by runtime-core:
 * on the single-turn hosts (workflow, graph, crew) the bundle constructs
 * them at boot, so nothing pends; on a compiled cli/channel/managed bundle
 * guide/shadow reach the interpreter only until the emitters' boot-time
 * `wireModels` row, and the warning says exactly that; the cascade still
 * pends on the whole-block path (PR 9c). Byte-identity: a pool without the
 * strategy keys renders no side-call field and no model-service import.
 */
import { describe, expect, test } from "bun:test";
import { parseSpecIssues } from "@crewhaus/spec";
import { compile } from "./index";

const workflow = (strategy: string): string =>
  [
    "name: w",
    "target: workflow",
    "model: m",
    "steps:",
    "  - name: draft",
    "    instructions: write it",
    "    model_pool:",
    "      candidates:",
    "        - { model: claude-haiku-4-5, tags: [cheap] }",
    "        - { model: claude-opus-4-8, tags: [strong] }",
    ...(strategy.length > 0 ? [`      strategy: ${strategy}`] : []),
  ].join("\n");

const cli = (strategy: string): string =>
  [
    "name: c",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: i",
    "  model_pool:",
    "    candidates:",
    "      - { model: claude-haiku-4-5, tags: [cheap] }",
    "      - { model: claude-opus-4-8, tags: [strong] }",
    `    strategy: ${strategy}`,
  ].join("\n");

const pendingPaths = (yaml: string) =>
  compile(yaml)
    .warnings.filter((w) => w.code === "model-plan-pending-runtime")
    .map((w) => w.path);

describe("side-call strategies on single-turn hosts compile through (PR 9d)", () => {
  test("a workflow step committee: no pending warning, the bundle constructs the side call via wireSideCalls", () => {
    const yaml = workflow("{ committee: { members: [cheap, strong], judge: claude-opus-4-8 } }");
    expect(parseSpecIssues(yaml)).toEqual([]);
    const result = compile(yaml);
    expect(pendingPaths(yaml)).toEqual([]);
    const agent = result.files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).toContain('import { wireSideCalls } from "@crewhaus/model-service";');
    expect(agent).toContain("...wireSideCalls({");
    expect(agent).toContain('"committee":{"members":["cheap","strong"],"judge":"claude-opus-4-8"}');
    expect(agent).toContain('"scope":"draft"}, { sessionName: "w" }),');
  });

  test("a workflow step guide + shadow: honoured, no pending warning", () => {
    const yaml = workflow(
      "{ guide: { model: claude-opus-4-8, every: first_turn }, shadow: { candidate: claude-opus-4-8, sample_rate: 0.2 } }",
    );
    expect(pendingPaths(yaml)).toEqual([]);
    expect(compile(yaml).files[0]?.content).toContain("wireSideCalls");
  });

  test("byte-identity: a pool without the strategy keys renders no side-call field and no model-service import", () => {
    const agent = compile(workflow("")).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agent).not.toContain("wireSideCalls");
    expect(agent).not.toContain("@crewhaus/model-service");
  });

  test("a cli committee is a spec error (single-turn hosts only)", () => {
    const yaml = cli("{ committee: { members: [cheap, strong] } }");
    expect(
      parseSpecIssues(yaml)
        .map((i) => i.message)
        .join("\n"),
    ).toMatch(/single-turn hosts only/);
    expect(() => compile(yaml)).toThrow();
  });

  test("a cli guide / shadow warns with the reach-precise message (interpreter honours it; compiled cli bundle pending); no whole-block strategy warning without a cascade", () => {
    const yaml = cli(
      "{ guide: { model: claude-opus-4-8 }, shadow: { candidate: claude-opus-4-8 } }",
    );
    const warnings = compile(yaml).warnings.filter((w) => w.code === "model-plan-pending-runtime");
    expect(warnings.map((w) => w.path).sort()).toEqual([
      "agent.model_pool.strategy.guide",
      "agent.model_pool.strategy.shadow",
    ]);
    for (const w of warnings) {
      expect(w.message).toContain("crewhaus run / serve interpreter");
      expect(w.message).toContain("wireSideCalls");
      expect(w.message).toContain("compiled cli bundle does not construct the side call yet");
      expect(w.message).not.toContain("the runtime does not honour it");
    }
  });

  test("the cascade still pends on the whole-block path (PR 9c) beside a wired guide", () => {
    const yaml = workflow(
      "{ cascade: { draft: cheap, escalate_to: strong }, guide: { model: claude-opus-4-8 } }",
    );
    expect(pendingPaths(yaml)).toEqual(["steps[0].model_pool.strategy"]);
  });
});
