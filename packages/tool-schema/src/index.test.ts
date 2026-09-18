/**
 * Every tool this package registers, exercised through its own `execute`.
 *
 * Two things are checked for all of them, because they are the contract the
 * runtime relies on: the safety flags are what the tool contract expects for
 * a pure-compute tool, and the declared schema actually rejects bad input.
 * After that, each tool gets the behaviour tests that matter for it — a happy
 * path, the edge that would bite, and a rejection.
 */
import { describe, expect, test } from "bun:test";
import {
  assert,
  SCHEMA_TOOLS,
  checkRequiredFields,
  compareGolden,
  deepEqual,
  jsonSchemaInfer,
  jsonSchemaValidate,
  matchSubset,
  schemaDiff,
  schemaSummarize,
  validateEnum,
  validateFormat,
  validateRecords,
  validateReferences,
  validateUniqueKeys,
} from "./index";

/** Tools return compact JSON; parse it so assertions read as data. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: (typeof SCHEMA_TOOLS)[number], input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

const userSchema = {
  type: "object",
  properties: {
    id: { type: "integer", minimum: 1 },
    email: { type: "string", format: "email" },
    role: { enum: ["admin", "user"] },
  },
  required: ["id", "email"],
  additionalProperties: false,
};

describe("package-wide contract", () => {
  test("every tool is exported in SCHEMA_TOOLS", () => {
    expect(SCHEMA_TOOLS.length).toBe(14);
  });

  test("names are unique", () => {
    const names = SCHEMA_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every tool is PascalCase", () => {
    for (const t of SCHEMA_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only, non-destructive and internal — this package touches nothing", () => {
    for (const t of SCHEMA_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly }).toEqual({ name: t.name, readOnly: true });
      expect({ name: t.name, destructive: t.destructive }).toEqual({
        name: t.name,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
      expect({ name: t.name, sandbox: t.requiresSandbox }).toEqual({
        name: t.name,
        sandbox: false,
      });
    }
  });

  test("no tool declares an io capability, because none crosses a boundary", () => {
    for (const t of SCHEMA_TOOLS) {
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });

  test("every tool is concurrency-safe, since all are pure", () => {
    for (const t of SCHEMA_TOOLS) {
      expect({ name: t.name, safe: t.concurrencySafe }).toEqual({ name: t.name, safe: true });
    }
  });

  test("every description says what it is for, not just what it is", () => {
    for (const t of SCHEMA_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).toContain("Use ");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of SCHEMA_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });

  test("every tool returns a string", async () => {
    const out = await jsonSchemaValidate.execute({ value: 1, schema: true });
    expect(typeof out).toBe("string");
  });
});

describe("JsonSchemaValidate", () => {
  test("a conforming value passes with no errors", async () => {
    const out = await run(jsonSchemaValidate, {
      value: { id: 1, email: "a@b.com" },
      schema: userSchema,
    });
    expect(out.valid).toBe(true);
    expect(out.errorCount).toBe(0);
  });

  test("every failure carries a pointer, a keyword and a message", async () => {
    const out = await run(jsonSchemaValidate, {
      value: { id: 0, role: "root", extra: true },
      schema: userSchema,
    });
    expect(out.valid).toBe(false);
    const byPath = Object.fromEntries(
      out.errors.map((e: { path: string; keyword: string }) => [e.path, e.keyword]),
    );
    expect(byPath["/id"]).toBe("minimum");
    expect(byPath["/role"]).toBe("enum");
    expect(byPath["/extra"]).toBe("additionalProperties");
    expect(byPath[""]).toBe("required");
  });

  test("format is only enforced when asked", async () => {
    const lenient = await run(jsonSchemaValidate, {
      value: { id: 1, email: "nope" },
      schema: userSchema,
    });
    expect(lenient.valid).toBe(true);
    const strict = await run(jsonSchemaValidate, {
      value: { id: 1, email: "nope" },
      schema: userSchema,
      assertFormat: true,
    });
    expect(strict.valid).toBe(false);
  });

  test("a keyword it does not enforce is named rather than passed over", async () => {
    const out = await run(jsonSchemaValidate, {
      value: { a: 1 },
      schema: { type: "object", dependencies: { a: ["b"] } },
    });
    expect(out.unsupportedKeywords).toEqual(["dependencies"]);
    expect(out.note).toContain("not enforced");
  });

  test("a malformed schema is refused instead of failing every value", async () => {
    const out = await run(jsonSchemaValidate, { value: 1, schema: { type: "sting" } });
    expect(out.schemaValid).toBe(false);
    expect(out.problems[0]).toContain("not a JSON Schema type");
  });

  test("the schema rejects a non-schema schema field", () => {
    expect(jsonSchemaValidate.inputSchema.safeParse({ value: 1, schema: "object" }).success).toBe(
      false,
    );
  });
});

describe("JsonSchemaInfer", () => {
  test("infers types, structure and required from samples", async () => {
    const out = await run(jsonSchemaInfer, {
      samples: [
        { id: 1, tags: ["a"] },
        { id: 2, tags: [] },
      ],
    });
    expect(out.type).toBe("object");
    expect(out.required).toEqual(["id", "tags"]);
    expect(out.properties.tags.type).toBe("array");
  });

  test("the inferred schema validates its own samples", async () => {
    const samples = [
      { a: "x", b: null },
      { a: "y", b: 2 },
    ];
    const schema = await run(jsonSchemaInfer, { samples });
    for (const sample of samples) {
      const out = await run(jsonSchemaValidate, { value: sample, schema });
      expect(out.valid).toBe(true);
    }
  });

  test("enum detection is off by default and on when asked", async () => {
    const off = await run(jsonSchemaInfer, { samples: [{ s: "a" }, { s: "b" }] });
    expect(off.properties.s.enum).toBeUndefined();
    const on = await run(jsonSchemaInfer, { samples: [{ s: "a" }, { s: "b" }], detectEnums: true });
    expect(on.properties.s.enum).toEqual(["a", "b"]);
  });

  test("the schema requires at least one sample", () => {
    expect(jsonSchemaInfer.inputSchema.safeParse({ samples: [] }).success).toBe(false);
  });
});

describe("ValidateRecords", () => {
  test("a clean batch reports ok with counts", async () => {
    const out = await run(validateRecords, {
      records: [
        { id: 1, email: "a@b.com" },
        { id: 2, email: "c@d.com" },
      ],
      schema: userSchema,
    });
    expect(out.ok).toBe(true);
    expect(out.passed).toBe(2);
  });

  test("failures are listed by row and grouped by cause", async () => {
    const out = await run(validateRecords, {
      records: [{ id: 1, email: "a@b.com" }, { id: "x", email: "c@d.com" }, {}],
      schema: userSchema,
    });
    expect(out.failed).toBe(2);
    expect(out.failures[0].row).toBe(1);
    expect(out.topIssues.length).toBeGreaterThan(0);
  });

  test("summaryOnly leaves the rows out", async () => {
    const out = await run(validateRecords, {
      records: [{}],
      schema: userSchema,
      summaryOnly: true,
    });
    expect(out.failed).toBe(1);
    expect(out.failures).toBeUndefined();
  });

  test("a malformed schema is refused here too", async () => {
    const out = await run(validateRecords, { records: [{}], schema: { required: "id" } });
    expect(out.schemaValid).toBe(false);
  });

  test("the schema requires records to be an array", () => {
    expect(validateRecords.inputSchema.safeParse({ records: {}, schema: true }).success).toBe(
      false,
    );
  });
});

describe("Assert", () => {
  const value = { status: "done", count: 5, items: [1, 2, 3] };

  test("all checks passing gives ok with the counts", async () => {
    const out = await run(assert, {
      value,
      checks: [
        { path: "status", op: "equals", expected: "done" },
        { path: "count", op: "greaterThan", expected: 1 },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.passed).toBe(2);
  });

  test("a failure reports actual against expected", async () => {
    const out = await run(assert, {
      value,
      checks: [{ path: "count", op: "lessThan", expected: 3 }],
    });
    expect(out.ok).toBe(false);
    expect(out.results[0].actual).toBe("5");
    expect(out.results[0].expected).toBe("3");
    expect(out.results[0].reason).toContain("not <");
  });

  test("failuresOnly drops the passes", async () => {
    const out = await run(assert, {
      value,
      checks: [
        { path: "status", op: "exists" },
        { path: "nope", op: "exists" },
      ],
      failuresOnly: true,
    });
    expect(out.failures.length).toBe(1);
    expect(out.results).toBeUndefined();
  });

  test("a bad regex fails its own check without taking down the gate", async () => {
    const out = await run(assert, {
      value,
      checks: [
        { path: "status", op: "matches", expected: "(" },
        { path: "count", op: "equals", expected: 5 },
      ],
    });
    expect(out.passed).toBe(1);
    expect(out.results[0].reason).toContain("invalid regex");
  });

  test("the schema rejects an unknown op and an empty check list", () => {
    expect(
      assert.inputSchema.safeParse({ value: 1, checks: [{ op: "isPrime", expected: 1 }] }).success,
    ).toBe(false);
    expect(assert.inputSchema.safeParse({ value: 1, checks: [] }).success).toBe(false);
  });
});

describe("CompareGolden", () => {
  test("identical values are equal", async () => {
    const out = await run(compareGolden, { actual: { a: [1, 2] }, expected: { a: [1, 2] } });
    expect(out.equal).toBe(true);
    expect(out.differenceCount).toBe(0);
  });

  test("the three tolerances together let a snapshot survive what should move", async () => {
    const out = await run(compareGolden, {
      actual: { id: "generated-1", total: 10.0001, rows: [{ n: 2 }, { n: 1 }] },
      expected: { id: "generated-0", total: 10, rows: [{ n: 1 }, { n: 2 }] },
      ignorePaths: ["/id"],
      ignoreArrayOrder: true,
      epsilon: 0.001,
    });
    expect(out.equal).toBe(true);
    expect(out.ignored).toEqual(["/id"]);
  });

  test("a real difference still comes through with its path", async () => {
    const out = await run(compareGolden, {
      actual: { user: { name: "b" } },
      expected: { user: { name: "a" } },
    });
    expect(out.equal).toBe(false);
    expect(out.differences[0].path).toBe("/user/name");
  });

  test("a star pattern ignores one field across every item", async () => {
    const out = await run(compareGolden, {
      actual: {
        items: [
          { id: 1, v: "x" },
          { id: 2, v: "y" },
        ],
      },
      expected: {
        items: [
          { id: 9, v: "x" },
          { id: 8, v: "y" },
        ],
      },
      ignorePaths: ["/items/*/id"],
    });
    expect(out.equal).toBe(true);
  });

  test("the schema rejects a negative epsilon", () => {
    expect(
      compareGolden.inputSchema.safeParse({ actual: 1, expected: 1, epsilon: -1 }).success,
    ).toBe(false);
  });
});

describe("DeepEqual", () => {
  test("equal values report equal and nothing else", async () => {
    const out = await run(deepEqual, { a: { x: 1, y: 2 }, b: { y: 2, x: 1 } });
    expect(out).toEqual({ equal: true });
  });

  test("the first difference is returned with a readable path", async () => {
    const out = await run(deepEqual, { a: { x: [1, { y: 2 }] }, b: { x: [1, { y: 3 }] } });
    expect(out.equal).toBe(false);
    expect(out.difference.path).toBe("/x/1/y");
    expect(out.difference.kind).toBe("value");
  });

  test("a type change is named as a type change", async () => {
    const out = await run(deepEqual, { a: "1", b: 1 });
    expect(out.difference.kind).toBe("type");
  });

  test("the schema takes any two JSON values, including null", () => {
    expect(deepEqual.inputSchema.safeParse({ a: null, b: null }).success).toBe(true);
    expect(deepEqual.inputSchema.safeParse("nope").success).toBe(false);
  });
});

describe("MatchSubset", () => {
  test("extra properties are allowed", async () => {
    const out = await run(matchSubset, {
      actual: { id: 1, name: "x", extra: true },
      expected: { id: 1 },
    });
    expect(out.matches).toBe(true);
  });

  test("a wrong value inside the subset still fails", async () => {
    const out = await run(matchSubset, { actual: { id: 2, name: "x" }, expected: { id: 1 } });
    expect(out.matches).toBe(false);
    expect(out.differences[0].path).toBe("/id");
  });

  test("a missing expected property is reported", async () => {
    const out = await run(matchSubset, { actual: { name: "x" }, expected: { id: 1 } });
    expect(out.differences[0].kind).toBe("missing");
  });

  test("the schema rejects a non-array ignorePaths", () => {
    expect(
      matchSubset.inputSchema.safeParse({ actual: 1, expected: 1, ignorePaths: "/a" }).success,
    ).toBe(false);
  });
});

describe("CheckRequiredFields", () => {
  test("present and non-empty passes", async () => {
    const out = await run(checkRequiredFields, {
      value: { id: 1, customer: { email: "a@b.com" } },
      paths: ["id", "customer.email"],
    });
    expect(out.ok).toBe(true);
    expect(out.presentCount).toBe(2);
  });

  test("empty counts as missing unless allowEmpty is set", async () => {
    const strict = await run(checkRequiredFields, { value: { a: "" }, paths: ["a"] });
    expect(strict.ok).toBe(false);
    expect(strict.missing[0].reason).toContain("empty");
    const lenient = await run(checkRequiredFields, {
      value: { a: "" },
      paths: ["a"],
      allowEmpty: true,
    });
    expect(lenient.ok).toBe(true);
  });

  test("eachRecord checks every row and counts the failures", async () => {
    const out = await run(checkRequiredFields, {
      value: [{ id: 1 }, {}, { id: 3 }],
      paths: ["id"],
      eachRecord: true,
    });
    expect(out.failed).toBe(1);
    expect(out.failures[0].row).toBe(1);
  });

  test("eachRecord against a non-array explains itself instead of throwing", async () => {
    const out = await checkRequiredFields.execute({
      value: { a: 1 },
      paths: ["a"],
      eachRecord: true,
    });
    expect(String(out)).toContain("not an array");
  });

  test("the schema requires at least one path", () => {
    expect(checkRequiredFields.inputSchema.safeParse({ value: {}, paths: [] }).success).toBe(false);
  });
});

describe("ValidateEnum", () => {
  test("members pass", async () => {
    const out = await run(validateEnum, { values: ["a", "b"], allowed: ["a", "b", "c"] });
    expect(out.ok).toBe(true);
    expect(out.valid).toBe(2);
  });

  test("a near miss comes back with a suggestion", async () => {
    const out = await run(validateEnum, {
      values: ["completd", "unrelated"],
      allowed: ["completed", "failed"],
    });
    expect(out.invalidCount).toBe(2);
    expect(out.invalid[0].suggestion).toBe("completed");
    expect(out.invalid[1].suggestion).toBeUndefined();
  });

  test("caseInsensitive folds only strings", async () => {
    expect((await run(validateEnum, { values: ["A"], allowed: ["a"] })).ok).toBe(false);
    expect(
      (await run(validateEnum, { values: ["A"], allowed: ["a"], caseInsensitive: true })).ok,
    ).toBe(true);
  });

  test("non-string values are compared structurally", async () => {
    const out = await run(validateEnum, { values: [{ a: 1 }], allowed: [{ a: 1 }] });
    expect(out.ok).toBe(true);
  });

  test("the schema requires a non-empty allowed set", () => {
    expect(validateEnum.inputSchema.safeParse({ values: ["a"], allowed: [] }).success).toBe(false);
  });
});

describe("ValidateFormat", () => {
  test("valid values pass", async () => {
    const out = await run(validateFormat, { values: ["a@b.com", "c@d.org"], format: "email" });
    expect(out.ok).toBe(true);
  });

  test("a failure explains why it failed", async () => {
    const out = await run(validateFormat, { values: ["a@b.com", "nope"], format: "email" });
    expect(out.invalidCount).toBe(1);
    expect(out.invalid[0].index).toBe(1);
    expect(out.invalid[0].reason).toContain("@");
  });

  test("suggestFormats says what the value does look like", async () => {
    const out = await run(validateFormat, {
      values: ["2024-01-02"],
      format: "date-time",
      suggestFormats: true,
    });
    expect(out.invalid[0].matches).toContain("date");
  });

  test("the schema rejects a format this package does not implement", () => {
    expect(
      validateFormat.inputSchema.safeParse({ values: ["x"], format: "idn-email" }).success,
    ).toBe(false);
  });
});

describe("ValidateUniqueKeys", () => {
  test("a unique key passes", async () => {
    const out = await run(validateUniqueKeys, {
      records: [{ id: 1 }, { id: 2 }],
      keyFields: ["id"],
    });
    expect(out.ok).toBe(true);
    expect(out.distinctKeys).toBe(2);
  });

  test("a collision is grouped with its rows", async () => {
    const out = await run(validateUniqueKeys, {
      records: [{ id: 1 }, { id: 2 }, { id: 1 }],
      keyFields: ["id"],
    });
    expect(out.ok).toBe(false);
    expect(out.duplicates[0].rows).toEqual([0, 2]);
  });

  test("a composite key only collides when every field matches", async () => {
    const records = [
      { a: 1, b: 1 },
      { a: 1, b: 2 },
    ];
    expect((await run(validateUniqueKeys, { records, keyFields: ["a", "b"] })).ok).toBe(true);
    expect((await run(validateUniqueKeys, { records, keyFields: ["a"] })).ok).toBe(false);
  });

  test("a row that cannot be keyed is surfaced", async () => {
    const out = await run(validateUniqueKeys, {
      records: [{ id: 1 }, { other: 2 }],
      keyFields: ["id"],
    });
    expect(out.unkeyed[0].row).toBe(1);
  });

  test("the schema requires at least one key field", () => {
    expect(validateUniqueKeys.inputSchema.safeParse({ records: [], keyFields: [] }).success).toBe(
      false,
    );
  });
});

describe("ValidateReferences", () => {
  test("every reference resolving is a pass", async () => {
    const out = await run(validateReferences, {
      records: [{ cid: 1 }, { cid: 2 }],
      field: "cid",
      allowed: [1, 2],
    });
    expect(out.ok).toBe(true);
    expect(out.checked).toBe(2);
  });

  test("a dangling reference is reported with its row and value", async () => {
    const out = await run(validateReferences, {
      records: [{ cid: 1 }, { cid: 9 }],
      field: "cid",
      allowed: [1],
    });
    expect(out.ok).toBe(false);
    expect(out.dangling[0].row).toBe(1);
    expect(out.dangling[0].value).toBe("9");
  });

  test("the allowed set can be drawn from a parent table", async () => {
    const out = await run(validateReferences, {
      records: [{ cid: 1 }],
      field: "cid",
      parentRecords: [{ id: 1 }, { id: 2 }],
      parentField: "id",
      reportUnreferenced: true,
    });
    expect(out.ok).toBe(true);
    expect(out.unreferenced).toEqual(["2"]);
  });

  test("a missing reference fails unless allowMissing is set", async () => {
    const records = [{}];
    expect((await run(validateReferences, { records, field: "cid", allowed: [1] })).ok).toBe(false);
    expect(
      (await run(validateReferences, { records, field: "cid", allowed: [1], allowMissing: true }))
        .ok,
    ).toBe(true);
  });

  test("the schema insists on a source for the allowed set", () => {
    expect(validateReferences.inputSchema.safeParse({ records: [], field: "a" }).success).toBe(
      false,
    );
    expect(
      validateReferences.inputSchema.safeParse({ records: [], field: "a", parentRecords: [] })
        .success,
    ).toBe(false);
    expect(
      validateReferences.inputSchema.safeParse({ records: [], field: "a", allowed: [] }).success,
    ).toBe(true);
  });
});

describe("SchemaDiff", () => {
  test("no change is compatible and identical", async () => {
    const out = await run(schemaDiff, { before: userSchema, after: userSchema });
    expect(out.identical).toBe(true);
    expect(out.verdict).toBe("compatible");
  });

  test("a newly required property is breaking", async () => {
    const out = await run(schemaDiff, {
      before: { type: "object", properties: { a: {} } },
      after: { type: "object", properties: { a: {}, b: {} }, required: ["b"] },
    });
    expect(out.backwardCompatible).toBe(false);
    expect(out.counts.breaking).toBeGreaterThan(0);
  });

  test("a widened type is compatible", async () => {
    const out = await run(schemaDiff, {
      before: { type: "string" },
      after: { type: ["string", "null"] },
    });
    expect(out.verdict).toBe("compatible");
    expect(out.changes[0].compat).toBe("compatible");
  });

  test("an undecidable change is reported as unknown, not as safe", async () => {
    const out = await run(schemaDiff, { before: { pattern: "^a" }, after: { pattern: "^b" } });
    expect(out.verdict).toBe("unknown");
    expect(out.backwardCompatible).toBe(false);
  });

  test("breakingOnly drops the compatible changes", async () => {
    const out = await run(schemaDiff, {
      before: { type: "object", properties: { a: { type: "string" } } },
      after: { type: "object", properties: { a: { type: "number" }, b: {} } },
      breakingOnly: true,
    });
    expect(out.changes.every((c: { compat: string }) => c.compat !== "compatible")).toBe(true);
  });

  test("the schema rejects a non-schema operand", () => {
    expect(schemaDiff.inputSchema.safeParse({ before: "x", after: {} }).success).toBe(false);
  });
});

describe("SchemaSummarize", () => {
  test("the default is a markdown table with one row per field", async () => {
    const out = await schemaSummarize.execute({ schema: userSchema });
    const text = String(out);
    expect(text).toContain("| Field");
    expect(text).toContain("email");
    expect(text.split("\n").length).toBeGreaterThan(4);
  });

  test("json gives the rows as data", async () => {
    const out = await run(schemaSummarize, { schema: userSchema, format: "json" });
    expect(out.rootType).toBe("object");
    expect(out.fields.map((f: { path: string }) => f.path)).toEqual(["id", "email", "role"]);
    expect(out.fields[0].required).toBe(true);
  });

  test("requiredOnly narrows the list", async () => {
    const out = await run(schemaSummarize, {
      schema: userSchema,
      format: "json",
      requiredOnly: true,
    });
    expect(out.fields.map((f: { path: string }) => f.path)).toEqual(["id", "email"]);
  });

  test("a schema with no fields says so instead of rendering an empty table", async () => {
    const out = await schemaSummarize.execute({ schema: { type: "string" } });
    expect(String(out)).toContain("no described fields");
  });

  test("the schema rejects an unknown output format", () => {
    expect(schemaSummarize.inputSchema.safeParse({ schema: {}, format: "yaml" }).success).toBe(
      false,
    );
  });
});
