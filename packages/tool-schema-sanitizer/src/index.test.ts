import { describe, expect, test } from "bun:test";
import {
  type JsonSchema,
  inlineRefs,
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

describe("Gemini enums are always string[]", () => {
  /** Every node that carries an enum, anywhere in the sanitised schema. */
  function enumsIn(node: unknown, out: unknown[][] = []): unknown[][] {
    if (Array.isArray(node)) {
      for (const n of node) enumsIn(n, out);
    } else if (node !== null && typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (Array.isArray(record["enum"])) out.push(record["enum"]);
      for (const value of Object.values(record)) enumsIn(value, out);
    }
    return out;
  }

  test("numeric and boolean enums and consts move into the description", () => {
    // The two shapes 0.7.0 shipped: Npv.firstPeriod (`z.union([z.literal(0),
    // z.literal(1)])`) and StateImport.document.version (`z.literal(1)`).
    const out = sanitizeGeminiSchema({
      type: "object",
      properties: {
        firstPeriod: { type: "number", enum: [0, 1], description: "d" },
        version: { type: "number", const: 1 },
        flag: { type: "boolean", const: true },
        mode: { type: ["string", "null"], enum: ["x", null] },
        kind: { type: "string", const: "only" },
      },
      required: ["version"],
    });
    const props = out["properties"] as Record<string, JsonSchema>;
    expect(props["firstPeriod"]).toEqual({
      type: "number",
      description: "d Allowed values: 0, 1.",
    });
    expect(props["version"]).toEqual({ type: "number", description: "Must be 1." });
    expect(props["flag"]).toEqual({ type: "boolean", description: "Must be true." });
    expect(props["mode"]).toEqual({ type: "string", nullable: true, enum: ["x"] });
    expect(props["kind"]).toEqual({ type: "string", enum: ["only"] });
    expect(out["required"]).toEqual(["version"]);
  });

  test("inside unions, arrays and $refs too", () => {
    const out = sanitizeGeminiSchema({
      $defs: { level: { type: "integer", enum: [1, 2, 3] } },
      type: "object",
      properties: {
        a: {
          anyOf: [
            { type: "number", enum: [0, 1] },
            { type: "string", enum: ["auto"] },
          ],
        },
        b: { type: "array", items: { $ref: "#/$defs/level" } },
        c: { oneOf: [{ const: 5 }, { const: "five" }] },
      },
    });
    const enums = enumsIn(out);
    expect(enums.length).toBeGreaterThan(0);
    for (const values of enums) expect(values.every((v) => typeof v === "string")).toBe(true);
    const props = out["properties"] as Record<string, JsonSchema>;
    expect((props["b"] as { items: JsonSchema }).items).toEqual({
      type: "integer",
      description: "Allowed values: 1, 2, 3.",
    });
  });

  test("a string-only enum is unchanged, and an enum of only null becomes nullable", () => {
    expect(sanitizeGeminiSchema({ type: "string", enum: ["a", "b"] })).toEqual({
      type: "string",
      enum: ["a", "b"],
    });
    expect(sanitizeGeminiSchema({ type: "string", const: "x" })).toEqual({
      type: "string",
      enum: ["x"],
    });
    expect(sanitizeGeminiSchema({ enum: [null] })).toEqual({ nullable: true });
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
      required: ["a"],
      $defs: { S: { type: "string" } },
    });
    expect(out).not.toBeNull();
    const schema = out as JsonSchema;
    expect(schema["additionalProperties"]).toBe(false);
    // both properties required under strict
    expect(new Set(schema["required"] as string[])).toEqual(new Set(["a", "b"]));
    // ref inlined
    const a = (schema["properties"] as JsonSchema)["a"] as JsonSchema;
    expect(a["type"]).toBe("string");
  });

  test("a previously optional property is made nullable", () => {
    const out = toOpenAIStrictSchema({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    }) as JsonSchema;
    const b = (out["properties"] as JsonSchema)["b"] as JsonSchema;
    expect(b["type"]).toEqual(["number", "null"]);
    const a = (out["properties"] as JsonSchema)["a"] as JsonSchema;
    expect(a["type"]).toBe("string"); // required stays plain
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
