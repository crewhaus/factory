/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the
 * runtime cannot actually use, which is why this file exists separately.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { SCHEMA_TOOLS } from "./index";

let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of SCHEMA_TOOLS) catalog.register(tool);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(SCHEMA_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of SCHEMA_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("JsonSchemaValidate"),
      { value: { a: 1 }, schema: { type: "object" } },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"valid":true');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("JsonSchemaValidate"),
      { value: 1, schema: "not a schema" },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("JsonSchemaValidate");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("DeepEqual"), { a: 1 }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("a cross-field refinement is enforced at dispatch", async () => {
    const result = await executeTool(
      lookup("ValidateReferences"),
      { records: [], field: "cid" },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("DeepEqual"),
      { a: 1, b: 1 },
      { toolUseId: "t5", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("DeepEqual"),
      { a: 1, b: 1 },
      { toolUseId: "t6", allowedPatterns: ["DeepEqual"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    const calls: Record<string, unknown> = {
      Assert: { value: { a: 1 }, checks: [{ path: "a", op: "equals", expected: 1 }] },
      CheckRequiredFields: { value: { a: 1 }, paths: ["a"] },
      CompareGolden: { actual: { a: 1 }, expected: { a: 1 } },
      DeepEqual: { a: 1, b: 1 },
      JsonSchemaInfer: { samples: [{ a: 1 }] },
      JsonSchemaValidate: { value: 1, schema: { type: "integer" } },
      MatchSubset: { actual: { a: 1, b: 2 }, expected: { a: 1 } },
      SchemaDiff: { before: { type: "string" }, after: { type: "string" } },
      SchemaSummarize: { schema: { type: "object", properties: { a: { type: "string" } } } },
      ValidateEnum: { values: ["a"], allowed: ["a"] },
      ValidateFormat: { values: ["a@b.com"], format: "email" },
      ValidateRecords: { records: [{ a: 1 }], schema: { type: "object" } },
      ValidateReferences: { records: [{ cid: 1 }], field: "cid", allowed: [1] },
      ValidateUniqueKeys: { records: [{ id: 1 }], keyFields: ["id"] },
    };
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(SCHEMA_TOOLS.map((t) => t.name).sort());
    for (const tool of SCHEMA_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("a pathological input is a readable result, not an exception", async () => {
    const cases: Array<[string, unknown]> = [
      ["JsonSchemaValidate", { value: 1, schema: { type: "nonsense" } }],
      ["Assert", { value: 1, checks: [{ path: "a[[", op: "exists" }] }],
      ["CheckRequiredFields", { value: 1, paths: ["a"], eachRecord: true }],
      ["SchemaSummarize", { schema: { properties: { a: { $ref: "#/$defs/gone" } } } }],
    ];
    for (const [name, input] of cases) {
      const result = await executeTool(lookup(name), input, { toolUseId: `p-${name}` });
      expect({ name, isError: result.isError }).toEqual({ name, isError: false });
      expect(typeof result.content).toBe("string");
    }
  });

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    const args = { samples: [{ b: 1, a: "x@y.com" }, { a: "p@q.io" }] };
    const first = await executeTool(lookup("JsonSchemaInfer"), args, { toolUseId: "d1" });
    const second = await executeTool(lookup("JsonSchemaInfer"), args, { toolUseId: "d2" });
    expect(first.content).toBe(second.content);
  });
});

describe("the tools compose into a model-free gate", () => {
  /**
   * The flow a data step actually runs: infer a contract from known-good
   * rows, validate the incoming batch against it, check the key is unique,
   * then assert on the summary to decide whether to proceed or escalate.
   * None of these four steps needs a model.
   */
  test("infer, validate, de-duplicate, then decide", async () => {
    const known = [
      { id: 1, email: "a@b.com" },
      { id: 2, email: "c@d.com" },
    ];
    const inferred = await executeTool(
      lookup("JsonSchemaInfer"),
      { samples: known },
      {
        toolUseId: "g1",
      },
    );
    const schema = JSON.parse(inferred.content as string);

    const incoming = [
      { id: 3, email: "e@f.com" },
      { id: "four", email: "g@h.com" },
      { id: 3, email: "i@j.com" },
    ];
    const validated = await executeTool(
      lookup("ValidateRecords"),
      { records: incoming, schema, summaryOnly: true },
      { toolUseId: "g2" },
    );
    const report = JSON.parse(validated.content as string);
    expect(report.failed).toBe(1);

    const unique = await executeTool(
      lookup("ValidateUniqueKeys"),
      { records: incoming, keyFields: ["id"] },
      { toolUseId: "g3" },
    );
    const duplicates = JSON.parse(unique.content as string);
    expect(duplicates.duplicates[0].rows).toEqual([0, 2]);

    const decision = await executeTool(
      lookup("Assert"),
      {
        value: { failed: report.failed, duplicateGroups: duplicates.duplicateGroups },
        checks: [
          { path: "failed", op: "equals", expected: 0, message: "rows failed the contract" },
          { path: "duplicateGroups", op: "equals", expected: 0, message: "the key is not unique" },
        ],
        failuresOnly: true,
      },
      { toolUseId: "g4" },
    );
    const verdict = JSON.parse(decision.content as string);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.map((f: { reason: string }) => f.reason)).toEqual([
      "rows failed the contract",
      "the key is not unique",
    ]);
  });

  test("a schema change gate: diff, then assert on the verdict", async () => {
    const diff = await executeTool(
      lookup("SchemaDiff"),
      {
        before: { type: "object", properties: { a: { type: "string" } } },
        after: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
      },
      { toolUseId: "s1" },
    );
    const result = JSON.parse(diff.content as string);
    const decision = await executeTool(
      lookup("Assert"),
      {
        value: result,
        checks: [{ path: "verdict", op: "equals", expected: "compatible" }],
      },
      { toolUseId: "s2" },
    );
    expect(JSON.parse(decision.content as string).ok).toBe(true);
  });
});
