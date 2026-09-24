import { describe, expect, test } from "bun:test";
import {
  DEFAULT_INLINE_MAX_BYTES,
  type JsonSchema,
  REF_NOT_EXPANDED_NOTE,
  inlineRefs,
  inlineRefsWithReport,
  sanitizeBedrockSchema,
  sanitizeGeminiSchema,
  sanitizeToolSchema,
  toOpenAIStrictSchema,
} from "./index.js";

/** Recursively collect every key name that appears anywhere in a schema. */
function allKeys(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) allKeys(item, into);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      into.add(key);
      allKeys(value, into);
    }
  }
  return into;
}

/**
 * A `$ref`-heavy MCP-style schema that previously 400'd on Gemini and
 * Bedrock: shared shapes factored into `$defs`, referenced by pointer,
 * with `additionalProperties`, a nullable `anyOf` union, an unsupported
 * string `format`, and a `oneOf`.
 */
function refHeavySchema(): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      target: { $ref: "#/$defs/Endpoint" },
      mode: { oneOf: [{ const: "sync" }, { const: "async" }] },
      note: { anyOf: [{ type: "string" }, { type: "null" }] },
      contact: { type: "string", format: "email" },
    },
    required: ["target"],
    $defs: {
      Endpoint: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", format: "uri" },
          port: { type: "integer" },
        },
        required: ["url"],
      },
    },
  };
}

describe("inlineRefs", () => {
  test("resolves $ref against $defs and drops the containers", () => {
    const out = inlineRefs(refHeavySchema());
    const keys = allKeys(out);
    expect(keys.has("$ref")).toBe(false);
    expect(keys.has("$defs")).toBe(false);
    const props = out["properties"] as JsonSchema;
    const target = props["target"] as JsonSchema;
    expect(target["type"]).toBe("object");
    expect((target["properties"] as JsonSchema)["url"]).toBeDefined();
  });

  test("resolves definitions (draft-07 container) too", () => {
    const out = inlineRefs({
      type: "object",
      properties: { a: { $ref: "#/definitions/A" } },
      definitions: { A: { type: "number" } },
    });
    const a = (out["properties"] as JsonSchema)["a"] as JsonSchema;
    expect(a["type"]).toBe("number");
    expect(allKeys(out).has("definitions")).toBe(false);
  });

  test("sibling keywords alongside $ref override the target", () => {
    const out = inlineRefs({
      $defs: { A: { type: "string", description: "from def" } },
      $ref: "#/$defs/A",
      description: "override",
    });
    expect(out["type"]).toBe("string");
    expect(out["description"]).toBe("override");
  });

  test("recursive $ref breaks the cycle into a permissive node", () => {
    const out = inlineRefs({
      $ref: "#/$defs/Node",
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
        },
      },
    });
    // Top expands once; the inner self-reference stops at a permissive {}.
    const next = (out["properties"] as JsonSchema)["next"] as JsonSchema;
    expect(next["type"]).toBeUndefined();
    expect(Object.keys(next).length).toBe(0);
  });

  test("unresolvable $ref is dropped, siblings preserved", () => {
    const out = inlineRefs({ $ref: "#/$defs/Missing", description: "kept" });
    expect(out["description"]).toBe("kept");
    expect(allKeys(out).has("$ref")).toBe(false);
  });

  test("does not descend into literal data (enum/default values)", () => {
    const out = inlineRefs({
      type: "object",
      properties: { a: { type: "string" } },
      default: { $ref: "not-a-real-ref" },
    });
    expect(out["default"]).toEqual({ $ref: "not-a-real-ref" });
  });
});

/**
 * A `$ref` DAG: `d<i>` has two properties that both reference `d<i+1>`, so a
 * naive inline copies `d<depth>` 2^depth times. Every property is required,
 * so the strict-mode tests below are about the budget, not about optional
 * keys.
 */
function dag(depth: number): JsonSchema {
  const defs: JsonSchema = { [`d${depth}`]: { type: "string" } };
  for (let i = 0; i < depth; i++) {
    defs[`d${i}`] = {
      type: "object",
      properties: { a: { $ref: `#/$defs/d${i + 1}` }, b: { $ref: `#/$defs/d${i + 1}` } },
      required: ["a", "b"],
    };
  }
  return {
    type: "object",
    properties: { root: { $ref: "#/$defs/d0" } },
    required: ["root"],
    $defs: defs,
  };
}

/** How many times `needle` occurs in `hay`. */
function occurrences(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

describe("inlineRefs — a $ref DAG cannot grow a schema exponentially (flag-truth-4#6)", () => {
  // A depth-16 DAG inlined naively is 5 MB of JSON (2^16 copies of the leaf);
  // the budget holds it near DEFAULT_INLINE_MAX_BYTES, whatever the depth.
  const bound = 2 * DEFAULT_INLINE_MAX_BYTES;

  test("a deep DAG is cut near the budget, and the cut is labelled", () => {
    for (const depth of [16, 40]) {
      const { schema, truncatedRefs } = inlineRefsWithReport(dag(depth));
      const json = JSON.stringify(schema);
      expect({ depth, size: json.length <= bound }).toEqual({ depth, size: true });
      expect(truncatedRefs).toBeGreaterThan(0);
      // Every unexpanded $ref says so, and nothing else carries the note.
      expect(occurrences(json, REF_NOT_EXPANDED_NOTE)).toBe(truncatedRefs);
      expect(json).not.toContain("$ref");
    }
  });

  test("the provider projections of a deep DAG are bounded too", () => {
    for (const sanitize of [sanitizeGeminiSchema, sanitizeBedrockSchema]) {
      const json = JSON.stringify(sanitize(dag(16)));
      expect(json.length).toBeLessThanOrEqual(bound);
      expect(json).toContain(REF_NOT_EXPANDED_NOTE);
    }
  });

  test("a shallow DAG is still inlined in full, with no note", () => {
    const { schema, truncatedRefs } = inlineRefsWithReport(dag(4));
    const json = JSON.stringify(schema);
    expect(truncatedRefs).toBe(0);
    expect(json).not.toContain(REF_NOT_EXPANDED_NOTE);
    // 2^4 copies of the leaf, all there.
    expect(occurrences(json, '{"type":"string"}')).toBe(16);
  });

  test("one small definition used three times is inlined three times", () => {
    const out = inlineRefs({
      type: "object",
      properties: {
        x: { $ref: "#/$defs/P" },
        y: { $ref: "#/$defs/P" },
        z: { $ref: "#/$defs/P" },
      },
      $defs: { P: { type: "object", properties: { n: { type: "number" } } } },
    });
    for (const key of ["x", "y", "z"]) {
      expect((out["properties"] as JsonSchema)[key]).toEqual({
        type: "object",
        properties: { n: { type: "number" } },
      });
    }
  });

  test("a chain of $refs deeper than the depth cap stops there, once", () => {
    const defs: JsonSchema = { c40: { type: "string" } };
    for (let i = 0; i < 40; i++) {
      defs[`c${i}`] = {
        type: "object",
        properties: { next: { $ref: `#/$defs/c${i + 1}` } },
      };
    }
    const report = inlineRefsWithReport({ $ref: "#/$defs/c0", $defs: defs });
    // No fan-out, so the byte budget never runs out: only the depth cap cuts.
    expect(report.truncatedRefs).toBe(1);
    let node = report.schema;
    let depth = 0;
    while (isObject(node["properties"])) {
      node = (node["properties"] as JsonSchema)["next"] as JsonSchema;
      depth++;
    }
    expect(depth).toBe(32);
    expect(node["description"]).toBe(REF_NOT_EXPANDED_NOTE);
  });

  test("a caller's budget is honoured, and a $ref's own description is kept", () => {
    const report = inlineRefsWithReport(
      {
        type: "object",
        properties: {
          big: { $ref: "#/$defs/Big" },
          later: { $ref: "#/$defs/Big", description: "the second copy" },
        },
        $defs: { Big: { type: "object", properties: { note: { type: "string" } } } },
      },
      { maxBytes: 60 },
    );
    const props = report.schema["properties"] as JsonSchema;
    expect(report.truncatedRefs).toBe(1);
    expect((props["big"] as JsonSchema)["type"]).toBe("object");
    expect(props["later"]).toEqual({ description: `the second copy ${REF_NOT_EXPANDED_NOTE}` });
  });

  test("a pointer resolves only keys the document itself has", () => {
    // A schema object whose prototype carries a definition-shaped value:
    // `#/inherited` names nothing in the document.
    const root = Object.assign(Object.create({ inherited: { type: "string" } }) as JsonSchema, {
      type: "object",
      properties: { x: { $ref: "#/inherited", description: "kept" } },
    });
    const x = (inlineRefs(root)["properties"] as JsonSchema)["x"];
    expect(x).toEqual({ description: "kept" });
  });
});

function isObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("sanitizeGeminiSchema — projects onto the OpenAPI subset", () => {
  test("the ref-heavy schema loses every Gemini-rejected keyword", () => {
    const out = sanitizeGeminiSchema(refHeavySchema());
    const keys = allKeys(out);
    for (const banned of ["$ref", "$defs", "$schema", "additionalProperties", "oneOf", "allOf"]) {
      expect(keys.has(banned)).toBe(false);
    }
  });

  test("refs are inlined into the object graph", () => {
    const out = sanitizeGeminiSchema(refHeavySchema());
    const target = (out["properties"] as JsonSchema)["target"] as JsonSchema;
    expect(target["type"]).toBe("object");
    expect((target["properties"] as JsonSchema)["url"]).toBeDefined();
  });

  test("nullable anyOf union collapses to nullable single branch", () => {
    const out = sanitizeGeminiSchema(refHeavySchema());
    const note = (out["properties"] as JsonSchema)["note"] as JsonSchema;
    expect(note["type"]).toBe("string");
    expect(note["nullable"]).toBe(true);
    expect(note["anyOf"]).toBeUndefined();
  });

  test("oneOf becomes anyOf and const becomes single-value enum", () => {
    const out = sanitizeGeminiSchema(refHeavySchema());
    const mode = (out["properties"] as JsonSchema)["mode"] as JsonSchema;
    // two const branches → anyOf of two single-value enums
    const anyOf = mode["anyOf"] as JsonSchema[];
    expect(Array.isArray(anyOf)).toBe(true);
    expect(anyOf).toHaveLength(2);
    expect(anyOf[0]?.["enum"]).toEqual(["sync"]);
    expect(anyOf[1]?.["enum"]).toEqual(["async"]);
  });

  test("unsupported string format is dropped, numeric format kept", () => {
    const out = sanitizeGeminiSchema({
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        when: { type: "string", format: "date-time" },
        size: { type: "number", format: "double" },
      },
    });
    const props = out["properties"] as JsonSchema;
    expect((props["email"] as JsonSchema)["format"]).toBeUndefined();
    expect((props["when"] as JsonSchema)["format"]).toBe("date-time");
    expect((props["size"] as JsonSchema)["format"]).toBe("double");
  });

  test("allOf members merge into one object schema", () => {
    const out = sanitizeGeminiSchema({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    const props = out["properties"] as JsonSchema;
    expect(props["a"]).toBeDefined();
    expect(props["b"]).toBeDefined();
    expect(new Set(out["required"] as string[])).toEqual(new Set(["a", "b"]));
    expect(allKeys(out).has("allOf")).toBe(false);
  });

  test("type: [T, null] becomes type T + nullable", () => {
    const out = sanitizeGeminiSchema({
      type: "object",
      properties: { x: { type: ["string", "null"] } },
    });
    const x = (out["properties"] as JsonSchema)["x"] as JsonSchema;
    expect(x["type"]).toBe("string");
    expect(x["nullable"]).toBe(true);
  });

  test("multi-type union becomes an anyOf of typed branches", () => {
    const out = sanitizeGeminiSchema({
      type: "object",
      properties: { x: { type: ["string", "number"] } },
    });
    const x = (out["properties"] as JsonSchema)["x"] as JsonSchema;
    const anyOf = x["anyOf"] as JsonSchema[];
    expect(anyOf.map((b) => b["type"]).sort()).toEqual(["number", "string"]);
  });
});

describe("sanitizeBedrockSchema — strips structural metadata, keeps the rest", () => {
  test("the ref-heavy schema loses $ref/$defs/additionalProperties", () => {
    const out = sanitizeBedrockSchema(refHeavySchema());
    const keys = allKeys(out);
    for (const banned of ["$ref", "$defs", "$schema", "additionalProperties", "oneOf", "allOf"]) {
      expect(keys.has(banned)).toBe(false);
    }
  });

  test("refs are inlined and the object graph survives", () => {
    const out = sanitizeBedrockSchema(refHeavySchema());
    const target = (out["properties"] as JsonSchema)["target"] as JsonSchema;
    expect((target["properties"] as JsonSchema)["url"]).toBeDefined();
  });

  test("keeps ordinary constraints Converse accepts (format, anyOf)", () => {
    const out = sanitizeBedrockSchema({
      type: "object",
      properties: {
        contact: { type: "string", format: "email" },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
    const props = out["properties"] as JsonSchema;
    // Converse is permissive: format and anyOf pass through untouched.
    expect((props["contact"] as JsonSchema)["format"]).toBe("email");
    expect(Array.isArray((props["note"] as JsonSchema)["anyOf"])).toBe(true);
  });

  test("oneOf is renamed to anyOf", () => {
    const out = sanitizeBedrockSchema({
      type: "object",
      properties: { m: { oneOf: [{ type: "string" }, { type: "number" }] } },
    });
    const m = (out["properties"] as JsonSchema)["m"] as JsonSchema;
    expect(Array.isArray(m["anyOf"])).toBe(true);
    expect(m["oneOf"]).toBeUndefined();
  });
});

describe("sanitizeToolSchema dispatch", () => {
  test("routes to the requested provider profile", () => {
    const gem = sanitizeToolSchema(refHeavySchema(), "gemini");
    const bed = sanitizeToolSchema(refHeavySchema(), "bedrock");
    // Gemini downcasts email→(no format); Bedrock keeps it.
    const gemContact = (gem["properties"] as JsonSchema)["contact"] as JsonSchema;
    const bedContact = (bed["properties"] as JsonSchema)["contact"] as JsonSchema;
    expect(gemContact["format"]).toBeUndefined();
    expect(bedContact["format"]).toBe("email");
  });
});

describe("toOpenAIStrictSchema — upgrade or bail", () => {
  test("upgrades a supported schema: additionalProperties false + all required", () => {
    const out = toOpenAIStrictSchema({
      type: "object",
      properties: {
        a: { $ref: "#/$defs/S" },
        b: { type: "number" },
      },
      required: ["a", "b"],
      $defs: { S: { type: "string" } },
    });
    expect(out).not.toBeNull();
    const schema = out as JsonSchema;
    expect(schema["additionalProperties"]).toBe(false);
    expect(new Set(schema["required"] as string[])).toEqual(new Set(["a", "b"]));
    // ref inlined
    const a = (schema["properties"] as JsonSchema)["a"] as JsonSchema;
    expect(a["type"]).toBe("string");
    // Nothing was made nullable: the model is never forced to send null.
    expect(JSON.stringify(schema)).not.toContain('"null"');
  });

  // provider-limits#2 — strict made an optional property nullable, so the
  // model had to send `path: null` to leave Grep's path unset, and the tool's
  // validator refused null. A schema with an optional property stays
  // non-strict, where the model can simply leave the key out.
  test("a schema with an optional property stays non-strict", () => {
    expect(
      toOpenAIStrictSchema({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "number" } },
        required: ["a"],
      }),
    ).toBeNull();
    expect(
      toOpenAIStrictSchema({
        type: "object",
        properties: { path: { type: "string" } },
      }),
    ).toBeNull();
  });

  test("an optional property anywhere keeps the schema non-strict", () => {
    const nested = (inner: JsonSchema): JsonSchema => ({
      type: "object",
      properties: { outer: inner },
      required: ["outer"],
    });
    const partial: JsonSchema = {
      type: "object",
      properties: { x: { type: "string" }, y: { type: "string" } },
      required: ["x"],
    };
    expect(toOpenAIStrictSchema(nested(partial))).toBeNull();
    expect(toOpenAIStrictSchema(nested({ type: "array", items: partial }))).toBeNull();
    expect(toOpenAIStrictSchema(nested({ anyOf: [partial, { type: "string" }] }))).toBeNull();
    // The same shapes with every property required still upgrade.
    const full = { ...partial, required: ["x", "y"] };
    expect(toOpenAIStrictSchema(nested(full))).not.toBeNull();
    expect(toOpenAIStrictSchema(nested({ type: "array", items: full }))).not.toBeNull();
  });

  test("a free-form object is not locked to {}", () => {
    // `{ type: "object" }` accepts any keys; strict would allow none.
    expect(
      toOpenAIStrictSchema({
        type: "object",
        properties: { data: { type: "object" } },
        required: ["data"],
      }),
    ).toBeNull();
    expect(toOpenAIStrictSchema({ type: "object" })).toBeNull();
    // An object that already forbids extra keys is fine.
    expect(
      toOpenAIStrictSchema({ type: "object", properties: {}, additionalProperties: false }),
    ).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
  });

  test("a schema whose $refs could not all be inlined stays non-strict", () => {
    // Every property of the DAG is required, so only the budget decides.
    expect(toOpenAIStrictSchema(dag(4))).not.toBeNull();
    expect(toOpenAIStrictSchema(dag(16))).toBeNull();
  });

  test("nested objects also get additionalProperties false", () => {
    const out = toOpenAIStrictSchema({
      type: "object",
      properties: {
        inner: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
      },
      required: ["inner"],
    }) as JsonSchema;
    const inner = (out["properties"] as JsonSchema)["inner"] as JsonSchema;
    expect(inner["additionalProperties"]).toBe(false);
  });

  test("returns null for schemas with unsupported keywords (stay non-strict)", () => {
    expect(
      toOpenAIStrictSchema({
        type: "object",
        properties: { a: { type: "string", pattern: "^x" } },
        required: ["a"],
      }),
    ).toBeNull();
    expect(
      toOpenAIStrictSchema({
        type: "object",
        properties: { a: { type: "string", format: "email" } },
        required: ["a"],
      }),
    ).toBeNull();
  });

  test("returns null for a free-form (additionalProperties:true) object", () => {
    expect(
      toOpenAIStrictSchema({ type: "object", properties: {}, additionalProperties: true }),
    ).toBeNull();
  });

  test("returns null for a non-object root", () => {
    expect(toOpenAIStrictSchema({ type: "string" })).toBeNull();
  });
});
