/**
 * Loop contract 0.4 (Batch B, G03) — `specJsonSchema()`: the whole Spec
 * union as a JSON-Schema document with per-target definitions + key
 * descriptions.
 *
 * Snapshot posture: rather than pinning the (huge) document bytes, these
 * tests pin its STRUCTURE against the parseSpec fixtures — one valid spec
 * per target, each checked against its target's definition with a light
 * structural validator (top-level property coverage + required-key
 * subset + target const + strictness). No ajv: the workspace has no JSON
 * Schema validator and this test must not add one.
 */
import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { parseSpec, specJsonSchema } from "./index";

/** One valid fixture per target — every one must satisfy parseSpec. */
const FIXTURES: Record<string, string> = {
  cli: [
    "name: c",
    "target: cli",
    "agent: {model: m, instructions: i}",
    "tools: [read]",
    "evaluation:",
    "  grader: {type: llm_judge, criteria: helpful}",
    "limits: {max_tool_iterations: 10}",
  ].join("\n"),
  workflow: [
    "name: w",
    "target: workflow",
    "model: m",
    "steps:",
    "  - {name: draft, instructions: write}",
    "  - name: gate",
    "    kind: judge",
    "    judge: {criteria: has a title}",
  ].join("\n"),
  channel: [
    "name: ch",
    "target: channel",
    "agent: {model: m, instructions: i}",
    "channels:",
    "  slack: {botToken: $SLACK_BOT_TOKEN, signingSecret: $SLACK_SIGNING_SECRET}",
    "routing: {sessionKey: thread}",
    "evaluation:",
    "  grader: {type: contains, value: ok}",
  ].join("\n"),
  graph: [
    "name: g",
    "target: graph",
    "model: m",
    "entry: a",
    "nodes:",
    "  a: {instructions: x}",
    "  gate:",
    "    kind: judge",
    "    judge: {criteria: grounded}",
    "edges:",
    "  - {from: a, to: gate}",
  ].join("\n"),
  managed: [
    "name: mg",
    "target: managed",
    "agent: {model: m, instructions: i}",
    "tenants:",
    "  - {id: t1, budget: {maxInputTokens: 10, maxOutputTokens: 10}}",
    "evaluation:",
    "  grader: {type: llm_judge, criteria: on brand}",
  ].join("\n"),
  pipeline: [
    "name: p",
    "target: pipeline",
    "agent: {model: m, instructions: i}",
    "retrieve: {embedderModel: e}",
    "indexing:",
    "  documents:",
    "    - {id: d1, text: hello}",
  ].join("\n"),
  crew: [
    "name: cr",
    "target: crew",
    "model: m",
    "entry: writer",
    "roles:",
    "  writer: {instructions: w}",
  ].join("\n"),
  research: [
    "name: r",
    "target: research",
    "agent: {model: m, instructions: i}",
    "goal: learn",
  ].join("\n"),
  batch: [
    "name: b",
    "target: batch",
    "agent: {model: m, instructions: i}",
    "queue: {adapter: in-memory}",
  ].join("\n"),
  voice: [
    "name: v",
    "target: voice",
    "agent: {model: m, instructions: i}",
    "voice: {provider: openai}",
  ].join("\n"),
  browser: ["name: br", "target: browser", "agent: {model: m, instructions: i}"].join("\n"),
  eval: [
    "name: e",
    "target: eval",
    "agent: {model: m, instructions: i}",
    "dataset: {name: d, version: '1'}",
    "graders:",
    "  - {name: exact}",
  ].join("\n"),
  onchain: [
    "name: oc",
    "target: onchain",
    "agent: {model: m, instructions: i}",
    "chains:",
    "  - {id: base, kind: evm, rpcUrls: [$BASE_RPC_URL], finality: {kind: finalized}}",
    "triggers:",
    "  - {kind: block, chainId: base, scanIntervalMs: 5000}",
  ].join("\n"),
  "onchain-game": [
    "name: og",
    "target: onchain-game",
    "agent: {model: m, instructions: i}",
    "chain: {id: base, kind: evm, rpcUrls: [$BASE_RPC_URL], finality: {kind: finalized}}",
    "wallet: {id: w1, chainId: base, custody: local, keyRef: $WALLET_KEY}",
    "game:",
    "  contract: {id: game, chainId: base, address: '0x1', abiRef: 'abi://erc20'}",
    "  stateReader: getState",
  ].join("\n"),
};

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("expected object");
  return v as Rec;
};

const schema = specJsonSchema();
const definitions = asRec(schema["definitions"]);

describe("specJsonSchema — document structure", () => {
  test("root is a $ref to the CrewhausSpec union definition", () => {
    expect(schema["$ref"]).toBe("#/definitions/CrewhausSpec");
    expect(typeof schema["$schema"]).toBe("string");
  });

  test("every target has its own definition and a union arm", () => {
    const targets = Object.keys(FIXTURES);
    for (const target of targets) {
      expect(definitions[target]).toBeDefined();
    }
    const union = asRec(definitions["CrewhausSpec"]);
    const arms = union["anyOf"];
    if (!Array.isArray(arms)) throw new Error("expected CrewhausSpec.anyOf");
    const refs = arms.map((a) => asRec(a)["$ref"]);
    for (const target of targets) {
      expect(refs).toContain(`#/definitions/${target}`);
    }
    expect(arms.length).toBe(targets.length);
  });

  test("definitions are strict objects with a pinned target const", () => {
    for (const target of Object.keys(FIXTURES)) {
      const def = asRec(definitions[target]);
      expect(def["type"]).toBe("object");
      expect(def["additionalProperties"]).toBe(false);
      const props = asRec(def["properties"]);
      const targetProp = asRec(props["target"]);
      expect(targetProp["const"] ?? asRec(targetProp)["enum"]).toBeDefined();
    }
  });

  test("0.6.0: models is a property of EVERY target definition, and the profile value is a strict object", () => {
    // zod-to-json-schema emits the SAME zod object once and `$ref`s it from
    // every later site (`#/definitions/cli/properties/models` on the other 13
    // targets), so resolve a local ref before inspecting the node.
    const deref = (node: Rec): Rec => {
      const ref = node["$ref"];
      if (typeof ref !== "string") return node;
      expect(ref.startsWith("#/")).toBe(true);
      let cursor: unknown = schema;
      for (const segment of ref.slice(2).split("/")) cursor = asRec(cursor)[segment];
      return asRec(cursor);
    };
    for (const target of Object.keys(FIXTURES)) {
      const props = asRec(asRec(definitions[target])["properties"]);
      const models = deref(asRec(props["models"]));
      expect(String(models["description"] ?? "")).toContain("model-profile registry");
      // A zod record renders as an object with `additionalProperties` = the
      // value schema (and `propertyNames` carrying the key pattern).
      expect(models["type"]).toBe("object");
      const profile = asRec(models["additionalProperties"]);
      expect(profile["type"]).toBe("object");
      expect(profile["additionalProperties"]).toBe(false);
      const profileProps = asRec(profile["properties"]);
      for (const key of [
        "model",
        "tags",
        "max_tokens",
        "thinking",
        "temperature",
        "instructions",
        "tools",
        "tool_config",
        "permissions",
        "rate_limits",
        "limits",
        "caching",
        "cost",
        "requires",
        "capabilities",
        "fallbacks",
        "circuit_breaker",
      ]) {
        expect(profileProps[key]).toBeDefined();
      }
      expect(profile["required"]).toEqual(["model"]);
      const keyPattern = asRec(models["propertyNames"])["pattern"];
      expect(keyPattern).toBe("^[a-z][a-z0-9_-]{0,63}$");
    }
  });

  test("0.6.0: the cli agent's model_pool exposes the hybrid siblings and the widened policy enum", () => {
    const cli = asRec(definitions["cli"]);
    const agent = asRec(asRec(asRec(cli["properties"])["agent"])["properties"]);
    const pool = asRec(asRec(agent["model_pool"])["properties"]);
    for (const key of [
      "candidates",
      "policy",
      "directives",
      "rules",
      "classifier",
      "strategy",
      "reward",
      "scope",
    ]) {
      expect(pool[key]).toBeDefined();
    }
    expect(asRec(pool["policy"])["enum"]).toEqual(["static", "heuristic", "learned", "classifier"]);
    const evaluation = asRec(asRec(asRec(cli["properties"])["evaluation"])["properties"]);
    expect(asRec(evaluation["on_fail"])["enum"]).toEqual(["retry", "halt", "note", "escalate"]);
    expect(evaluation["allow_self_judge"]).toBeDefined();
  });

  test("key descriptions surface (Batch B blocks carry them)", () => {
    const cli = asRec(definitions["cli"]);
    const props = asRec(cli["properties"]);
    const evaluation = asRec(props["evaluation"]);
    expect(String(evaluation["description"] ?? "")).toContain("in-loop output evaluation");
    // The workflow judge-step arm describes itself + its judge block.
    const workflow = asRec(definitions["workflow"]);
    const steps = asRec(asRec(asRec(workflow["properties"])["steps"])["items"]);
    const arms = steps["anyOf"];
    if (!Array.isArray(arms) || arms.length !== 2) throw new Error("expected 2 step arms");
    const judgeArm = asRec(arms[1]);
    expect(String(judgeArm["description"] ?? "")).toContain("judge gate step");
    const judgeProps = asRec(judgeArm["properties"]);
    expect(String(asRec(judgeProps["judge"])["description"] ?? "")).toContain("judge gate config");
  });
});

describe("specJsonSchema — every parseSpec fixture is valid under its definition", () => {
  for (const [target, yaml] of Object.entries(FIXTURES)) {
    test(`${target} fixture parses AND structurally matches #/definitions/${target}`, () => {
      // 1. parseSpec accepts it (the fixture is genuinely valid).
      const parsed = parseSpec(yaml);
      expect(parsed.target).toBe(target as typeof parsed.target);

      // 2. Light structural validation against the target's definition:
      //    every top-level key the fixture uses exists in `properties`
      //    (strict schema ⇒ unknown keys would be invalid), and every
      //    `required` property is present in the fixture.
      const def = asRec(definitions[target]);
      const props = asRec(def["properties"]);
      const doc = asRec(parseYaml(yaml));
      for (const key of Object.keys(doc)) {
        expect(props[key]).toBeDefined();
      }
      const required = def["required"];
      if (Array.isArray(required)) {
        for (const key of required) {
          expect(doc[String(key)]).toBeDefined();
        }
      }
    });
  }

  test("the schema document is deterministic and JSON-serializable", () => {
    const a = JSON.stringify(specJsonSchema());
    const b = JSON.stringify(specJsonSchema());
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(10_000);
  });
});
