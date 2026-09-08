/**
 * 0.6.0 PR 9e (plan §2 stance 4, §4.4 "interpreter parity") — `crewhaus run`
 * and a COMPILED bundle must build the same `runChatLoop` option set from the
 * same spec.
 *
 * Until this PR they did not: the interpreter spread `wireModels`, which
 * constructs `hybridTools` / `escalation` (Consult + Escalate),
 * `routeClassifier` and `sideCalls`, while every emitter rendered only the
 * four LITERAL routing fields. A hybrid spec therefore behaved differently
 * depending on whether it was run or compiled — the pool blob was identical
 * and the behaviour was not.
 *
 * The test drives both halves for real:
 *   - the interpreter half is `modelRoutingRunOptions(ir.agent, …)`, the exact
 *     call `crewhaus run` makes (`apps/cli/src/index.ts`);
 *   - the bundle half is the emitted `agent.ts`'s own field text, EVALUATED
 *     with the same `wireHybrid` the bundle imports — not re-derived from the
 *     IR, so a rendering bug cannot hide.
 * Key sets and the pool blob must match, on every shape whose emitter renders
 * the call, and both must be empty for a pool that declares no closure.
 */
import { describe, expect, test } from "bun:test";
import { compile, lower } from "@crewhaus/compiler";
import type { IrV0 } from "@crewhaus/ir";
import { wireHybrid } from "@crewhaus/model-service";
import { parseSpec } from "@crewhaus/spec";
import { collectCrewhausDeps } from "./bundle-manifest";
import { modelRoutingRunOptions } from "./loop-contract";

/** The flagship hybrid pool — a cascade, the model-directed pair, a route
 *  classifier and a guide — at any block indent. */
const hybridPool = (pad: string): readonly string[] =>
  [
    "model_pool:",
    "  policy: classifier",
    "  candidates:",
    "    - { model: claude-haiku-4-5, tags: [cheap] }",
    "    - { model: claude-opus-4-8, tags: [strong] }",
    "  classifier: { model: claude-haiku-4-5, labels: { cheap: simple, strong: hard } }",
    "  strategy:",
    "    cascade: { draft: cheap, escalate_to: strong }",
    "    guide: { model: claude-opus-4-8, every: first_turn }",
    "    model_directed: true",
  ].map((l) => `${pad}${l}`);

const plainPool = (pad: string): readonly string[] =>
  [
    "model_pool:",
    "  candidates:",
    "    - { model: claude-haiku-4-5, tags: [cheap] }",
    "    - { model: claude-opus-4-8, tags: [strong] }",
  ].map((l) => `${pad}${l}`);

const HYBRID_POOL = hybridPool("  ");
const PLAIN_POOL = plainPool("  ");

const cliSpec = (pool: readonly string[]): string =>
  [
    "name: hybrid",
    "target: cli",
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: i",
    ...pool,
  ].join("\n");

/**
 * The routing + hybrid fields the emitted cli bundle actually renders, pulled
 * out of `agent.ts` by text and evaluated as the bundle would evaluate them.
 * `modelPool:` and `...wireHybrid(` are the only two field forms involved, and
 * both are plain data / one call, so a `new Function` over them is exactly
 * what the generated module does at boot.
 */
function bundleRoutingOptions(agentTs: string): Record<string, unknown> {
  const fields = agentTs
    .split("\n")
    .filter((l) =>
      /^\s*(modelPool|modelTiers|modelFallbacks|circuitBreaker): |^\s*\.\.\.wireHybrid\(/.test(l),
    )
    .join("\n");
  return new Function("wireHybrid", `return {\n${fields}\n};`)(wireHybrid) as Record<
    string,
    unknown
  >;
}

function cliIr(yaml: string): IrV0 {
  const ir = lower(parseSpec(yaml));
  if (ir.target !== "cli") throw new Error("expected a cli IR");
  return ir;
}

describe("crewhaus run and the compiled bundle build the same option set (PR 9e)", () => {
  test("a hybrid cli spec: same keys, same pool blob, Consult advertised on both", () => {
    const yaml = cliSpec(HYBRID_POOL);
    const ir = cliIr(yaml);
    const interpreter = modelRoutingRunOptions(ir.agent, undefined, { sessionName: ir.name });
    const agentTs = compile(yaml).files.find((f) => f.path === "agent.ts")?.content ?? "";
    const bundle = bundleRoutingOptions(agentTs);

    expect(Object.keys(bundle)).toEqual(Object.keys(interpreter));
    expect(bundle["modelPool"]).toEqual(interpreter.modelPool);
    // Every closure family reached BOTH surfaces.
    const tools = (name: string, o: Record<string, unknown>) =>
      (o["hybridTools"] as ReadonlyArray<{ name: string }> | undefined)?.some(
        (t) => t.name === name,
      ) === true;
    for (const o of [bundle, interpreter as unknown as Record<string, unknown>]) {
      expect(tools("Consult", o)).toBe(true);
      expect(tools("Escalate", o)).toBe(true);
      expect(o["escalation"]).toBeDefined();
      expect(typeof o["routeClassifier"]).toBe("function");
      expect((o["sideCalls"] as { guide?: unknown } | undefined)?.guide).toBeDefined();
    }
  });

  test("a plain pool: both surfaces carry the blob and construct nothing", () => {
    const yaml = cliSpec(PLAIN_POOL);
    const ir = cliIr(yaml);
    const interpreter = modelRoutingRunOptions(ir.agent, undefined, { sessionName: ir.name });
    const agentTs = compile(yaml).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).not.toContain("wireHybrid");
    expect(Object.keys(bundleRoutingOptions(agentTs))).toEqual(["modelPool"]);
    expect(Object.keys(interpreter)).toEqual(["modelPool"]);
  });

  test("the emitted dependency manifest lists @crewhaus/model-service — and only when wired", () => {
    const hybrid = compile(cliSpec(HYBRID_POOL)).files;
    expect(collectCrewhausDeps(hybrid)).toContain("@crewhaus/model-service");
    const plain = compile(cliSpec(PLAIN_POOL)).files;
    expect(collectCrewhausDeps(plain)).not.toContain("@crewhaus/model-service");
  });
});

describe("every emitter the plan wires renders the call for its own pooled block", () => {
  const specs: ReadonlyArray<[string, string]> = [
    ["cli", cliSpec(HYBRID_POOL)],
    [
      "channel",
      [
        "name: hybrid",
        "target: channel",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        ...HYBRID_POOL,
        "channels:",
        "  slack: {botToken: $SLACK_BOT_TOKEN, signingSecret: $SLACK_SIGNING_SECRET}",
        "routing: {sessionKey: thread}",
      ].join("\n"),
    ],
    [
      "managed",
      [
        "name: hybrid",
        "target: managed",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        ...HYBRID_POOL,
        "tenants: [{ id: t1, budget: { maxInputTokens: 1, maxOutputTokens: 1 } }]",
      ].join("\n"),
    ],
    [
      "workflow",
      [
        "name: hybrid",
        "target: workflow",
        "model: claude-sonnet-4-6",
        "steps:",
        "  - name: draft",
        "    instructions: write it",
        ...hybridPool("    "),
      ].join("\n"),
    ],
    [
      "graph",
      [
        "name: hybrid",
        "target: graph",
        "model: claude-sonnet-4-6",
        "entry: a",
        "nodes:",
        "  a:",
        "    instructions: x",
        ...hybridPool("    "),
      ].join("\n"),
    ],
  ];

  for (const [label, yaml] of specs) {
    test(`${label}: the bundle imports the composition root and spreads wireHybrid`, () => {
      const files = compile(yaml).files;
      const agentTs = files.find((f) => f.path === "agent.ts")?.content ?? "";
      expect(agentTs).toContain('import { wireHybrid } from "@crewhaus/model-service";');
      expect(agentTs).toContain("...wireHybrid({");
      expect(collectCrewhausDeps(files)).toContain("@crewhaus/model-service");
    });
  }
});
