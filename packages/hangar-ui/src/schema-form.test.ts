/**
 * The structured editor's model, on hand-written schemas: which control each
 * node gets, which go to the JSON pane and why, how a control's value becomes
 * one edit, what a hidden value may never become, and where an issue lands.
 */
import { describe, expect, test } from "bun:test";
import {
  CLEAR,
  carriesMasked,
  fieldEdit,
  flatten,
  formModel,
  issuesByField,
  labelOf,
  maskedMarkerOf,
  nodeKey,
  resolvePointer,
  // @ts-expect-error — hand-written browser JS, typed as text for the embed map
} from "../assets/js/ui/schema-form.js";

type Node = {
  segments: string[];
  key: string;
  kind: string;
  label: string;
  why?: string;
  seed?: unknown;
  source: string | null;
  tier: string | null;
  security: boolean;
  writeOnly: boolean;
  nullable: boolean;
  options?: unknown[];
  itemKind?: string;
  children?: Node[];
};

/** A document shaped like the one the server answers: a root `$ref` into `definitions`. */
const doc = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  $ref: "#/definitions/t",
  definitions: { t: { type: "object", properties, additionalProperties: false }, ...extra },
});

const nodesOf = (schema: unknown, effective: unknown[] = [], trust: unknown[] = []) => {
  const model = formModel(schema, effective, trust);
  const all = flatten(model.groups) as Node[];
  const at = (path: string) => all.find((n) => n.segments.join(".") === path) as Node;
  return { model, all, at };
};

describe("formModel", () => {
  test("a reference to itself is a json node that says so", () => {
    const { at, model } = nodesOf(
      doc(
        { tree: { $ref: "#/definitions/node" } },
        {
          node: {
            type: "object",
            properties: { label: { type: "string" }, child: { $ref: "#/definitions/node" } },
          },
        },
      ),
    );
    expect(at("tree").kind).toBe("group");
    expect(at("tree.label").kind).toBe("text");
    expect(at("tree.child").kind).toBe("json");
    expect(String(at("tree.child").why)).toContain("refers to itself");
    expect(model.counts.visited).toBe(model.counts.classified);
  });

  test("a union of literals is a choice; a string-or-null is text with a Clear", () => {
    const { at } = nodesOf(
      doc({
        mode: {
          anyOf: [
            { type: "string", const: "a" },
            { type: "string", const: "b" },
          ],
        },
        label: { anyOf: [{ type: "string" }, { type: "null" }] },
        level: { type: "string", enum: ["low", "high"] },
      }),
    );
    expect(at("mode").kind).toBe("select");
    expect(at("mode").options).toEqual(["a", "b"]);
    expect(at("label").kind).toBe("text");
    expect(at("label").nullable).toBe(true);
    expect(at("level").options).toEqual(["low", "high"]);
  });

  test("a list of strings is a list; a list of objects goes to the JSON pane", () => {
    const { at } = nodesOf(
      doc({
        tags: { type: "array", items: { type: "string" } },
        rules: { type: "array", items: { type: "object", properties: { x: { type: "string" } } } },
        named: { type: "object", additionalProperties: { type: "string" } },
        either: { anyOf: [{ type: "string" }, { type: "object", properties: {} }] },
      }),
    );
    expect(at("tags").kind).toBe("list");
    expect(at("tags").itemKind).toBe("text");
    expect(at("rules").kind).toBe("json");
    expect(String(at("rules").why)).toContain("list of entries");
    expect(at("named").kind).toBe("json");
    expect(String(at("named").why)).toContain("entries you name");
    expect(at("either").kind).toBe("json");
    expect(String(at("either").why)).toContain("more than one form");
  });

  test("a pointer deep into another definition resolves, ~1 and ~0 decoded", () => {
    const schema = doc(
      { pick: { $ref: "#/definitions/other/properties/a~1b/properties/c~0d" } },
      {
        other: {
          type: "object",
          properties: { "a/b": { type: "object", properties: { "c~d": { type: "integer" } } } },
        },
      },
    );
    expect(resolvePointer(schema, "#/definitions/other/properties/a~1b/properties/c~0d")).toEqual({
      type: "integer",
    });
    const { at } = nodesOf(schema);
    expect(at("pick").kind).toBe("integer");
  });

  test("an unresolvable or masked reference, and a masked shape, are json, never a throw", () => {
    const { at } = nodesOf(
      doc({
        lost: { $ref: "#/definitions/nowhere" },
        hidden: { $ref: "[redacted]" },
        api_key: { type: "[redacted]", minLength: 1 },
      }),
    );
    expect(String(at("lost").why)).toContain("could not be read");
    expect(String(at("hidden").why)).toContain("secret");
    expect(String(at("api_key").why)).toContain("secret");
  });

  test("past the depth cap is json", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 20; i++) deep = { type: "object", properties: { n: deep } };
    const { all } = nodesOf(doc({ top: deep }));
    const capped = all.filter((n) => n.kind === "json");
    expect(capped).toHaveLength(1);
    expect(String(capped[0]?.why)).toContain("nested too deeply");
  });

  test("seeds, sources and tiers come from the rows given, matched by segments", () => {
    const { at } = nodesOf(
      doc({
        agent: {
          type: "object",
          properties: { max_tokens: { type: "integer" }, model: { type: "string" } },
        },
      }),
      [
        {
          path: "agent.max_tokens",
          segments: ["agent", "max_tokens"],
          value: 4096,
          source: "declared",
        },
        { path: "agent.model", segments: ["agent", "model"], value: "m", source: "default" },
      ],
      [{ segments: ["agent", "max_tokens"], tier: "auto-tunable", securitySurface: false }],
    );
    expect(at("agent.max_tokens").seed).toBe(4096);
    expect(at("agent.max_tokens").tier).toBe("auto-tunable");
    expect(at("agent.model").source).toBe("default");
    // No trust row: no tier is guessed.
    expect(at("agent.model").tier).toBeNull();
    expect(at("agent").source).toBe("declared");
  });

  test("a root that is not a block of settings says why", () => {
    const model = formModel({ anyOf: [{ type: "string" }] }, [], []);
    expect(model.groups).toEqual([]);
    expect(String(model.why)).toContain("cannot be shown as a form");
  });
});

describe("fieldEdit", () => {
  const node = (kind: string, seed: unknown, extra: Record<string, unknown> = {}) => ({
    segments: ["agent", "x"],
    kind,
    seed,
    source: seed === undefined ? null : "declared",
    writeOnly: carriesMasked(seed),
    ...extra,
  });

  test("coerces by kind, not by the seed's type", () => {
    expect(fieldEdit(node("integer", "4"), "3")).toEqual({ path: ["agent", "x"], value: 3 });
    expect(fieldEdit(node("boolean", true), "false")).toEqual({
      path: ["agent", "x"],
      value: false,
    });
    // Not a number: sent as typed, so the schema says why beside the field.
    expect(fieldEdit(node("integer", 4), "many")).toEqual({ path: ["agent", "x"], value: "many" });
    expect(fieldEdit(node("list", ["1"], { itemKind: "integer" }), ["1", "2"])).toEqual({
      path: ["agent", "x"],
      value: [1, 2],
    });
  });

  test("an unchanged control sends nothing", () => {
    expect(fieldEdit(node("integer", 4), "4")).toBeNull();
    expect(fieldEdit(node("text", "a"), "a")).toBeNull();
    expect(fieldEdit(node("select", "low"), "low")).toBeNull();
    expect(fieldEdit(node("list", ["a"], { itemKind: "text" }), ["a"])).toBeNull();
    expect(fieldEdit(node("text", undefined), "")).toBeNull();
  });

  test("a hidden value's empty control sends nothing, and the placeholder is never sent", () => {
    expect(fieldEdit(node("text", "[redacted]"), "")).toBeNull();
    expect(fieldEdit(node("text", "[redacted]"), "[redacted]")).toBeNull();
    expect(fieldEdit(node("text", "[redacted]"), "new")).toEqual({
      path: ["agent", "x"],
      value: "new",
    });
  });

  test("Clear removes a declared setting, and is nothing for one the file does not hold", () => {
    expect(fieldEdit(node("text", "a"), CLEAR)).toEqual({ path: ["agent", "x"] });
    expect(fieldEdit(node("text", undefined), CLEAR)).toBeNull();
  });
});

describe("carriesMasked", () => {
  test("finds the placeholder at any depth, and nothing else", () => {
    expect(carriesMasked({ a: { b: [{ c: "[redacted]" }] } })).toBe(true);
    expect(carriesMasked({ a: { b: [{ c: "redacted" }] } })).toBe(false);
    expect(carriesMasked("[redacted]")).toBe(true);
    expect(carriesMasked(null)).toBe(false);
  });

  test("finds every masker's placeholder inside a string: [redacted], *** and «NAME»", () => {
    expect(carriesMasked("token is [redacted] here")).toBe(true);
    expect(carriesMasked("Use *** for calls")).toBe(true);
    expect(carriesMasked("«X»")).toBe(true);
    expect(carriesMasked({ channel: "«SLACK_CHANNEL»" })).toBe(true);
    expect(carriesMasked(["ok", { deep: ["model «FIXTURE_MODEL» here"] }])).toBe(true);
    // Look-alikes that no masker writes.
    expect(carriesMasked("a ** b")).toBe(false);
    expect(carriesMasked("« not a name »")).toBe(false);
    expect(carriesMasked("«1X»")).toBe(false);
    expect(maskedMarkerOf({ a: "Use *** for calls" })).toBe("***");
    expect(maskedMarkerOf({ a: "«FIXTURE_MODEL»" })).toBe("«FIXTURE_MODEL»");
    expect(maskedMarkerOf({ a: "plain" })).toBeNull();
  });
});

describe("a value masked mid-string is write-only", () => {
  const schema = doc({
    agent: {
      type: "object",
      properties: {
        model: { type: "string" },
        instructions: { type: "string" },
        max_tokens: { type: "integer" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  });
  const rows = (model: string, instructions: string) => [
    { segments: ["agent", "model"], value: model, source: "declared" },
    { segments: ["agent", "instructions"], value: instructions, source: "declared" },
    { segments: ["agent", "max_tokens"], value: 1000, source: "declared" },
    { segments: ["agent", "tags"], value: ["a", "«TAG_VALUE»"], source: "declared" },
  ];
  type Pane = Node & { paneSeed?: unknown; hidden: string[] };

  test("a «NAME» seed: no edit from it, write-only, and its block's pane never starts from it", () => {
    const { at } = nodesOf(schema, rows("«FIXTURE_MODEL»", "Answer briefly."));
    const model = at("agent.model") as Pane;
    expect(model.writeOnly).toBe(true);
    expect(model.paneSeed).toBeUndefined();
    expect(fieldEdit(model, "«FIXTURE_MODEL»")).toBeNull();
    expect(fieldEdit(model, "")).toBeNull();
    expect(fieldEdit(model, "anthropic/claude-opus-5")).toEqual({
      path: ["agent", "model"],
      value: "anthropic/claude-opus-5",
    });
    const agent = at("agent") as Pane;
    expect(agent.writeOnly).toBe(true);
    expect(agent.paneSeed).toBeUndefined();
    expect(agent.hidden).toEqual(["agent.model", "agent.tags"]);
    // A setting beside it that holds nothing masked is still an ordinary control.
    const max = at("agent.max_tokens") as Pane;
    expect(max.writeOnly).toBe(false);
    expect(fieldEdit(max, "2000")).toEqual({ path: ["agent", "max_tokens"], value: 2000 });
  });

  test("a *** seed: no edit from it, write-only, and no pane seed", () => {
    const { at } = nodesOf(schema, rows("anthropic/claude-opus-5", "Use *** for calls"));
    const instructions = at("agent.instructions") as Pane;
    expect(instructions.writeOnly).toBe(true);
    expect(instructions.paneSeed).toBeUndefined();
    expect(fieldEdit(instructions, "Use *** for calls")).toBeNull();
    expect(fieldEdit(instructions, "Use *** for calls, now briefly")).toBeNull();
    expect((at("agent") as Pane).paneSeed).toBeUndefined();
  });

  test("a list holding a masked item starts empty, and an empty one sends nothing", () => {
    const { at } = nodesOf(schema, rows("anthropic/claude-opus-5", "Answer briefly."));
    const tags = at("agent.tags") as Pane;
    expect(tags.kind).toBe("list");
    expect(tags.writeOnly).toBe(true);
    expect(fieldEdit(tags, [])).toBeNull();
    expect(fieldEdit(tags, ["a", "«TAG_VALUE»"])).toBeNull();
    expect(fieldEdit(tags, ["a", "b"])).toEqual({ path: ["agent", "tags"], value: ["a", "b"] });
  });

  test("a choice whose literal was masked is never offered", () => {
    const { at } = nodesOf(doc({ mode: { type: "string", enum: ["plain", "«MODE_VALUE»"] } }), []);
    expect(at("mode").kind).toBe("json");
  });
});

describe("issuesByField", () => {
  const { model } = nodesOf(
    doc({
      agent: {
        type: "object",
        properties: { thinking: { type: "object", properties: { budget: { type: "integer" } } } },
      },
    }),
  );

  test("a nested issue lands on the deepest node; an unknown key on its parent's group; a root issue stays unplaced", () => {
    const deep = {
      path: ["agent", "thinking", "budget"],
      code: "invalid_type",
      message: "Expected number",
    };
    const unknown = {
      path: ["agent"],
      code: "unrecognized_keys",
      message: "Unrecognized key(s) in object: 'zz_new'",
    };
    const root = { path: [], code: "custom", message: "the spec is wrong" };
    const { byPath, unplaced } = issuesByField(model.groups, [deep, unknown, root]);
    expect(byPath.get(nodeKey(["agent", "thinking", "budget"]))).toEqual([deep]);
    expect(byPath.get(nodeKey(["agent"]))).toEqual([unknown]);
    expect(unplaced).toEqual([root]);
  });

  test("an unknown key at the root has no node to sit on", () => {
    const top = {
      path: [],
      code: "unrecognized_keys",
      message: "Unrecognized key(s) in object: 'zz_block'",
    };
    expect(issuesByField(model.groups, [top]).unplaced).toEqual([top]);
  });
});

describe("labels", () => {
  test("a key reads as words", () => {
    expect(labelOf("max_tokens")).toBe("Max tokens");
    expect(labelOf("botToken")).toBe("Bot token");
  });
});

describe("the JSON pane's starting value", () => {
  test("is what the file declares under a block, or the defaults when it declares nothing", () => {
    const { at } = nodesOf(
      doc({
        agent: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } } },
        memory: { type: "object", properties: { on: { type: "boolean" } } },
      }),
      [
        { segments: ["agent", "a"], value: 1, source: "declared" },
        { segments: ["agent", "b"], value: 2, source: "default" },
        { segments: ["memory", "on"], value: false, source: "default" },
      ],
    );
    const pane = (path: string) => (at(path) as unknown as { paneSeed: unknown }).paneSeed;
    expect(pane("agent")).toEqual({ a: 1 });
    expect(at("agent").seed).toEqual({ a: 1, b: 2 });
    expect(pane("memory")).toEqual({ on: false });
  });
});
