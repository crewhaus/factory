/**
 * `checkSpec` answers every problem a draft has in one result: every issue at
 * once, the settings the schema does not know, the credentials every model
 * slot needs, and never a throw for anything a spec can contain.
 */
import { describe, expect, test } from "bun:test";
import { collectSpecModels } from "@crewhaus/preflight";
import { parseSpec } from "@crewhaus/spec";
import { specSchemaIdentity } from "@crewhaus/spec/identity";
import { checkSpec, unknownKeysOf } from "./check-spec";
import { INFORMATIONAL_COMPILE_WARNING_CODES } from "./compile-warnings";

const CLI = "name: t\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n";

describe("every issue at once", () => {
  test("three cross-field issues come back together, where parseSpec throws only the first", () => {
    const yaml = [
      CLI,
      "models:",
      "  a: { model: cheapest, price: { input_per_1m: 1, output_per_1m: 2 } }",
      "  b: { model: strongest, price: { input_per_1m: 1, output_per_1m: 2 } }",
      "  c: { model: local/q@http://127.0.0.1:1/v1, price: { input_per_1m: 1, output_per_1m: 2 } }",
      "  d: { model: local/q@http://127.0.0.1:2/v1, price: { input_per_1m: 3, output_per_1m: 2 } }",
      "",
    ].join("\n");
    const result = checkSpec(yaml);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBe(3);
    expect(result.issues.map((i) => i.path.join("."))).toEqual([
      "models.a.price",
      "models.b.price",
      "models.d.price",
    ]);
    let thrown = "";
    try {
      parseSpec(yaml);
    } catch (err) {
      thrown = (err as Error).message;
    }
    expect(thrown).toBe(result.issues[0]?.message as string);
    expect(thrown).not.toContain("models.b");
  });

  test("a spec that fails the schema lists every schema issue", () => {
    const result = checkSpec("name: t\ntarget: cli\nagent:\n  model: 5\n");
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => [i.path.join("."), i.code])).toEqual([
      ["agent.model", "invalid_type"],
      ["agent.instructions", "invalid_type"],
    ]);
    expect(result.schema).toEqual(specSchemaIdentity());
  });
});

describe("settings the schema does not know, and a newer spec", () => {
  test("a planted forward key, at the root and under agent, is an unknown key and makes the spec read-only", () => {
    const yaml = `${CLI.replace("instructions: hi", "instructions: hi\n  brand_new: 1")}future_block: {}\n`;
    const result = checkSpec(yaml);
    expect(result.ok).toBe(false);
    expect(result.unknownKeys).toContainEqual(["future_block"]);
    expect(result.unknownKeys).toContainEqual(["agent", "brand_new"]);
    expect(result.unknownKeys.length).toBe(2);
    expect([...(result.readOnly?.keys ?? [])].sort()).toEqual(["agent.brand_new", "future_block"]);
    expect(result.readOnly?.reason).toContain("future_block");
  });

  test("a spec newer than this schema is read-only, naming its version", () => {
    const result = checkSpec(`${CLI}version: 3\n`);
    expect(result.ok).toBe(true);
    expect(result.readOnly?.keys).toEqual(["version"]);
    expect(result.readOnly?.reason).toContain("version 3");
  });

  test("a clean spec is not read-only", () => {
    const result = checkSpec(CLI);
    expect(result.ok).toBe(true);
    expect(result.readOnly).toBeUndefined();
    expect(checkSpec(`${CLI}version: 2\n`).readOnly).toBeUndefined();
  });

  test("an unrecognized-keys row names the parent plus each quoted key, or the parent alone", () => {
    expect(
      unknownKeysOf([
        {
          path: ["agent"],
          code: "unrecognized_keys",
          message: "Unrecognized key(s) in object: 'a', 'b'",
        },
        { path: ["x"], code: "unrecognized_keys", message: "Unrecognized key(s)" },
        { path: ["y"], code: "invalid_type", message: "'not' a key" },
      ]),
    ).toEqual([["agent", "a"], ["agent", "b"], ["x"]]);
  });
});

describe("credentials: every model slot, by name and presence", () => {
  const YAML = [
    CLI,
    "compaction:",
    "  model: openai/gpt-4o-mini",
    "security:",
    "  justification: { judge: claude, model: gemini/gemini-2.5-flash }",
    "",
  ].join("\n");

  test("the compaction and judge slots are listed with their env names, which preflight's spec walk misses", () => {
    const result = checkSpec(YAML);
    expect(result.credentials).toEqual([
      {
        slot: "agent.model",
        provider: "anthropic",
        envNames: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"],
      },
      {
        slot: "compaction.model",
        provider: "openai",
        envNames: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
      },
      {
        slot: "security.justification.model",
        provider: "gemini",
        envNames: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      },
    ]);
    const walked = collectSpecModels(Bun.YAML.parse(YAML)).map((m) => m.model);
    expect(walked).toContain("claude-opus-4-7");
    expect(walked).not.toContain("openai/gpt-4o-mini");
    expect(walked).not.toContain("gemini/gemini-2.5-flash");
  });

  test("presence is read from names only when an env is given, and never carries a value", () => {
    const value = "x";
    const result = checkSpec(YAML, { env: { OPENAI_API_KEY: value } });
    const present = Object.fromEntries(result.credentials.map((c) => [c.slot, c.present]));
    expect(present).toEqual({
      "agent.model": false,
      "compaction.model": true,
      "security.justification.model": false,
    });
    expect(JSON.stringify(result)).not.toContain(`"${value}"`);
    for (const c of checkSpec(YAML).credentials) expect("present" in c).toBe(false);
  });

  test("a federated sub-agent's peer is no credential row", () => {
    const yaml = `${CLI}  sub_agents:\n    peer:\n      description: remote\n      instructions: go\n      federation:\n        url: https://peer.example.com\n`;
    const result = checkSpec(yaml);
    expect(result.ok).toBe(true);
    expect(result.credentials.map((c) => c.slot)).toEqual(["agent.model"]);
  });
});

describe("never a throw for anything a spec can contain", () => {
  test("an empty text, a non-mapping root and a YAML error each come back as issues", () => {
    for (const [yaml, code] of [
      ["", "invalid_type"],
      ["[]", "invalid_type"],
      ["42", "invalid_type"],
      ["- a\n- b\n", "invalid_type"],
      ["a: [", "yaml_syntax"],
    ] as const) {
      const result = checkSpec(yaml);
      expect(result.ok, JSON.stringify(yaml)).toBe(false);
      expect(
        result.issues.map((i) => i.code),
        JSON.stringify(yaml),
      ).toEqual([code]);
      expect(result.features).toEqual([]);
      expect(result.credentials).toEqual([]);
    }
  });

  test("a lowering refusal is a `lower` error", () => {
    const result = checkSpec(
      `${CLI}mcp_servers:\n  docs:\n    transport: stdio\n    command: docs-mcp\n    env:\n      DOCS_TOKEN: $not-a-name\n`,
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.errors.map((e) => [e.code, e.path])).toEqual([["lower", "<lower>"]]);
    expect(result.errors[0]?.message).toContain("is not a valid one");
  });

  test("with emitAs cf-worker, a justify escalation is the edge's refusal; built locally it is fine", () => {
    const yaml = `${CLI}limits:\n  loop_detection:\n    escalation: justify\n`;
    expect(checkSpec(yaml).ok).toBe(true);
    const edge = checkSpec(yaml, { emitAs: "cf-worker" });
    expect(edge.ok).toBe(false);
    expect(edge.errors.map((e) => e.code)).toEqual(["cf-worker"]);
    expect(edge.errors[0]?.message).toContain("justify needs the intent gate");
  });

  test("today pins the sunset check both ways", () => {
    const yaml = `${CLI}models:\n  old: { model: claude-3-5-haiku-20241022 }\ncompaction:\n  model: $old\n`;
    const before = checkSpec(yaml, { today: "2026-09-01" });
    expect(before.ok).toBe(true);
    expect(before.warnings.map((w) => [w.code, w.informational])).toEqual([["model-sunset", true]]);
    expect(before.warnings[0]?.message).toContain("is scheduled for retirement on 2026-10-01");
    const after = checkSpec(yaml, { today: "2026-10-02" });
    expect(after.ok).toBe(false);
    expect(after.errors.map((e) => e.code)).toEqual(["lower"]);
    expect(after.errors[0]?.message).toContain("was retired on 2026-10-01");
  });

  test("features read what this release does with each declared setting", () => {
    const result = checkSpec(`${CLI}compaction:\n  curate: true\n`);
    expect(result.features).toEqual([
      { feature: "compaction.curate", path: "compaction.curate", status: "wired" },
    ]);
    // A default the schema fills in is not a declared setting.
    expect(checkSpec(CLI).features).toEqual([]);
  });
});

describe("warnings say which never fail --strict", () => {
  test("informational is true exactly for the informational codes and the budget-period note", () => {
    const yaml = [
      CLI,
      "mcp_servers:",
      "  bad__name: { transport: stdio, command: other-mcp }",
      "provability: { level: off, threshold: 0.9 }",
      "budget: {usd: 5, period: {every: month, usd: 2}}",
      "",
    ].join("\n");
    const result = checkSpec(yaml);
    expect(result.ok).toBe(true);
    const kinds = new Map(result.warnings.map((w) => [w.code, w.informational]));
    // One of each kind is planted.
    expect(kinds.get("mcp-server-name")).toBe(true);
    expect(kinds.get("provability-inert-block")).toBe(false);
    expect(kinds.get("budget-period-below-run-cap")).toBe(true);
    for (const w of result.warnings) {
      expect(w.informational, w.code).toBe(
        INFORMATIONAL_COMPILE_WARNING_CODES.includes(w.code) ||
          w.code === "budget-period-below-run-cap",
      );
    }
  });
});
