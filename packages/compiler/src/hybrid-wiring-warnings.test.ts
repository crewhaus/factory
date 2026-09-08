/**
 * 0.6.0 PR 9e/9f — the pool's CLOSURE-shaped keys (`strategy.{guide,shadow,
 * committee}`, `strategy.model_directed`, `policy: classifier` + its
 * `classifier:` block) cannot ride the `JSON.stringify(modelPool)` blob, so
 * they reach a compiled bundle only where the emitter renders
 * `@crewhaus/model-service`'s `wireHybrid`. PR 9e wired six shapes and left
 * four (pipeline, research, batch, browser) warning that the key was inert in
 * the bundle; 9f wires those four, so NOTHING pends any more. The one cell
 * plan §11.3 marks `—` — `pipeline` × the Consult / Escalate pair — is a
 * standing plan decision, not a deferred row, and is reported as
 * `model-plan-ignored-on-shape` with the reason. That message must NOT point
 * at an interpreter: `crewhaus run` refuses a pipeline spec outright, so the
 * key is inert everywhere and a "run it instead" pointer would be the #394
 * defect class all over again. Pinned below, both halves. `directives` / `rules` / `cascade` ride the blob and pend
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

/** A pool-bearing target wired by PR 9f (§11.3 marks every family `E`). */
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

/** The one shape §11.3 marks `—` for a family this PR otherwise wires. */
const pipeline = (strategy: string): string =>
  [
    "name: p",
    "target: pipeline",
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: i",
    "  model_pool:",
    "    candidates:",
    "      - { model: claude-haiku-4-5, tags: [cheap] }",
    "      - { model: claude-opus-4-8, tags: [strong] }",
    `    strategy: ${strategy}`,
    "retrieve:",
    "  embedderModel: mock/det",
    "indexing:",
    "  documents:",
    "    - { id: d1, text: hello }",
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

  test("PR 9f: the last four pool-bearing shapes wire it too — nothing pends", () => {
    const yaml = research("{ guide: { model: claude-opus-4-8 }, model_directed: true }");
    expect(pendingPaths(yaml)).toEqual([]);
    expect(compile(yaml).warnings.filter((w) => w.code === "model-plan-ignored-on-shape")).toEqual(
      [],
    );
    const agent = agentOf(yaml);
    expect(agent).toContain('import { wireHybrid } from "@crewhaus/model-service";');
    expect(agent).toContain("...wireHybrid({");
    expect(agent).toContain('{ sessionName: "r" }),');
  });

  test("the ONE §11.3 `—` cell: pipeline declines Consult / Escalate, precisely", () => {
    const yaml = pipeline("{ guide: { model: claude-opus-4-8 }, model_directed: true }");
    // Not a deferred row — no later PR changes it — so it is not `pending`.
    expect(pendingPaths(yaml)).toEqual([]);
    const ignored = compile(yaml).warnings.filter((w) => w.code === "model-plan-ignored-on-shape");
    expect(ignored.map((w) => w.path)).toEqual(["agent.model_pool.strategy.model_directed"]);
    const message = ignored[0]?.message ?? "";
    expect(message).toContain("nothing constructs the Consult / Escalate pair on a pipeline spec");
    expect(message).toContain('plan §11.3 marks the cell "—"');
    // The REAL reason: a plan decision, not a mechanical limit of the shape.
    expect(message).toContain("has not been sanctioned on this shape");
    expect(message).toContain("plan decision rather than a mechanical limit");
    // And no interpreter reach is claimed — `crewhaus run` refuses this shape.
    expect(message).toContain(
      "crewhaus run / serve do not accept target: pipeline either, so the key is inert everywhere",
    );
    expect(message).not.toContain("is honoured by the crewhaus run");
    expect(message).not.toMatch(/interpreter/);
    expect(message).not.toContain("inert in this compiled target");
    // The guide IS wired, and the declined family travels into the bundle.
    const agent = agentOf(yaml);
    expect(agent).toContain("...wireHybrid({");
    expect(agent).toContain('hybridFamilies: ["classifier","sideCalls"]');
  });

  test("a pipeline pool declaring ONLY model_directed renders no call and no import", () => {
    const yaml = pipeline("{ model_directed: true }");
    expect(
      compile(yaml)
        .warnings.filter((w) => w.code === "model-plan-ignored-on-shape")
        .map((w) => w.path),
    ).toEqual(["agent.model_pool.strategy.model_directed"]);
    const agent = agentOf(yaml);
    expect(agent).toContain('modelPool: {"candidates":');
    expect(agent).not.toContain("wireHybrid");
    expect(agent).not.toContain("@crewhaus/model-service");
  });
});
