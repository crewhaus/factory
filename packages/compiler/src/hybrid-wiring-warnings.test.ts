/**
 * 0.6.0 PR 9e — the pool's CLOSURE-shaped keys (`strategy.{guide,shadow,
 * committee}`, `strategy.model_directed`, `policy: classifier` + its
 * `classifier:` block) cannot ride the `JSON.stringify(modelPool)` blob, so
 * they reach a compiled bundle only where the emitter renders
 * `@crewhaus/model-service`'s `wireHybrid`. Since 9e that is cli, channel,
 * managed, workflow, graph and crew — nothing pends there, and the bundle
 * carries the import plus the spread. On any OTHER pool-bearing target the
 * key is still inert in the bundle and the warning says so with the reach
 * named precisely. `directives` / `rules` / `cascade` ride the blob and pend
 * nowhere. Byte-identity: a pool without a closure-shaped key renders no
 * call and no `@crewhaus/model-service` import at all.
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

/** A pool-bearing target whose emitter does NOT render `wireHybrid` yet. */
const research = (strategy: string): string =>
  [
    "name: r",
    "target: research",
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: i",
    "  model_pool:",
    "    candidates:",
    "      - { model: claude-haiku-4-5, tags: [cheap] }",
    "      - { model: claude-opus-4-8, tags: [strong] }",
    `    strategy: ${strategy}`,
    "goal: find out",
  ].join("\n");

const pendingPaths = (yaml: string) =>
  compile(yaml)
    .warnings.filter((w) => w.code === "model-plan-pending-runtime")
    .map((w) => w.path);

const agentOf = (yaml: string) =>
  compile(yaml).files.find((f) => f.path === "agent.ts")?.content ?? "";

describe("the closure-shaped pool keys reach the wired targets' bundles (PR 9e)", () => {
  test("a workflow step committee: no pending warning, the bundle constructs it via wireHybrid", () => {
    const yaml = workflow("{ committee: { members: [cheap, strong], judge: claude-opus-4-8 } }");
    expect(parseSpecIssues(yaml)).toEqual([]);
    expect(pendingPaths(yaml)).toEqual([]);
    const agent = agentOf(yaml);
    expect(agent).toContain('import { wireHybrid } from "@crewhaus/model-service";');
    expect(agent).toContain("...wireHybrid({");
    expect(agent).toContain('"committee":{"members":["cheap","strong"],"judge":"claude-opus-4-8"}');
    expect(agent).toContain('"scope":"draft"}, { sessionName: "w" }),');
  });

  test("a workflow step guide + shadow: honoured, no pending warning", () => {
    const yaml = workflow(
      "{ guide: { model: claude-opus-4-8, every: first_turn }, shadow: { candidate: claude-opus-4-8, sample_rate: 0.2 } }",
    );
    expect(pendingPaths(yaml)).toEqual([]);
    expect(agentOf(yaml)).toContain("wireHybrid");
  });

  test("byte-identity: a pool without a closure-shaped key renders no call and no import", () => {
    const agent = agentOf(workflow(""));
    expect(agent).not.toContain("wireHybrid");
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

  test("a cli guide / shadow / model_directed: nothing pends, and the bundle wires all three", () => {
    const yaml = cli(
      "{ guide: { model: claude-opus-4-8 }, shadow: { candidate: claude-opus-4-8 }, model_directed: true }",
    );
    expect(pendingPaths(yaml)).toEqual([]);
    const agent = agentOf(yaml);
    expect(agent).toContain('import { wireHybrid } from "@crewhaus/model-service";');
    expect(agent).toContain("...wireHybrid({");
  });

  test("the cascade (PR 9c) compiles through beside a wired guide — nothing pends", () => {
    const yaml = workflow(
      "{ cascade: { draft: cheap, escalate_to: strong }, guide: { model: claude-opus-4-8 } }",
    );
    expect(pendingPaths(yaml)).toEqual([]);
  });

  test("an UNWIRED pool-bearing target still warns, with the reach named precisely", () => {
    const yaml = research("{ guide: { model: claude-opus-4-8 }, model_directed: true }");
    const warnings = compile(yaml).warnings.filter((w) => w.code === "model-plan-pending-runtime");
    expect(warnings.map((w) => w.path).sort()).toEqual([
      "agent.model_pool.strategy.guide",
      "agent.model_pool.strategy.model_directed",
    ]);
    for (const w of warnings) {
      expect(w.message).toContain("crewhaus run / serve interpreter");
      expect(w.message).toContain("wireHybrid");
      expect(w.message).toContain("compiled research bundle does not construct");
      expect(w.message).not.toContain("the runtime does not honour it");
    }
    expect(agentOf(yaml)).not.toContain("wireHybrid");
  });
});
