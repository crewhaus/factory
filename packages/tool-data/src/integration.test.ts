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
import { DATA_TOOLS } from "./index";

let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of DATA_TOOLS) catalog.register(tool);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(DATA_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of DATA_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("JsonQuery"),
      { json: '{"a":[1,2]}', path: "$.a[*]" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"count":2');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("JsonQuery"),
      { json: 42, path: "$.a" },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("JsonQuery");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("DataDiff"), { before: "{}" }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("JsonSortKeys"),
      { json: "{}" },
      { toolUseId: "t4", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("JsonSortKeys"),
      { json: "{}" },
      { toolUseId: "t5", allowedPatterns: ["JsonSortKeys"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    const calls: Record<string, unknown> = {
      ColumnsToRecords: { columns: { a: [1, 2] } },
      CsvParse: { text: "a,b\n1,2\n" },
      CsvWrite: { records: [{ a: 1 }] },
      DataConvert: { text: '{"a":1}', from: "json", to: "yaml" },
      DataDiff: { before: '{"a":1}', after: '{"a":2}' },
      DataShape: { json: '[{"a":1}]' },
      DedupeRecords: { records: [1, 1] },
      FlattenObject: { json: '{"a":{"b":1}}' },
      JsonFormat: { json: '{"a":1}' },
      JsonMergePatch: { json: '{"a":1}', patch: '{"a":2}' },
      JsonPatch: { json: '{"a":1}', patch: [{ op: "replace", path: "/a", value: 2 }] },
      JsonQuery: { json: '{"a":1}', path: "$.a" },
      JsonSortKeys: { json: '{"b":1,"a":2}' },
      JsonlParse: { text: "1\n2\n" },
      JsonlWrite: { values: [1, 2] },
      RecordsToColumns: { records: [{ a: 1 }] },
      SampleRecords: { records: [1, 2, 3] },
      SortRecords: { records: [{ a: 2 }, { a: 1 }], keys: [{ field: "a" }] },
      TableAggregate: { records: [{ g: "x", n: 1 }], groupBy: ["g"] },
      TableJoin: { left: [{ id: 1 }], right: [{ id: 1 }], leftKey: "id" },
      TableQuery: { records: [{ a: 1 }] },
      UnflattenObject: { flat: { "a.b": 1 } },
      XmlParse: { text: "<a>hi</a>" },
    };
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(DATA_TOOLS.map((t) => t.name).sort());
    for (const tool of DATA_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("a caller's malformed document is a readable result, not a tool error", async () => {
    for (const [name, args] of [
      ["JsonQuery", { json: "{oops", path: "$.a" }],
      ["CsvParse", { text: 'a\n"unclosed\n' }],
      ["XmlParse", { text: "<a></b>" }],
      ["DataConvert", { text: "a:\n\tb: 1", from: "yaml", to: "json" }],
    ] as const) {
      const result = await executeTool(lookup(name), args, { toolUseId: `bad-${name}` });
      expect({ name, isError: result.isError }).toEqual({ name, isError: false });
      expect(result.content.toLowerCase()).toMatch(/invalid|not valid/);
    }
  });

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    const args = {
      records: [
        { g: "x", n: 1 },
        { g: "y", n: 2 },
      ],
      groupBy: ["g"],
    };
    const a = await executeTool(lookup("TableAggregate"), args, { toolUseId: "d1" });
    const b = await executeTool(lookup("TableAggregate"), args, { toolUseId: "d2" });
    expect(a.content).toBe(b.content);
  });

  test("a chain of tools composes the way a harness would use them", async () => {
    // CSV in, filtered and grouped, then back out as JSON.
    const parsed = await executeTool(
      lookup("CsvParse"),
      { text: "team,cost\nx,10\nx,20\ny,5\n", inferTypes: true },
      { toolUseId: "c1" },
    );
    const records = (JSON.parse(parsed.content) as { records: unknown[] }).records;

    const filtered = await executeTool(
      lookup("TableQuery"),
      { records, where: { all: [{ field: "cost", op: "gte", value: 10 }] } },
      { toolUseId: "c2" },
    );
    const kept = (JSON.parse(filtered.content) as { records: unknown[] }).records;
    expect(kept).toHaveLength(2);

    const grouped = await executeTool(
      lookup("TableAggregate"),
      {
        records: kept,
        groupBy: ["team"],
        aggregations: [{ as: "total", fn: "sum", field: "cost" }],
      },
      { toolUseId: "c3" },
    );
    expect(JSON.parse(grouped.content).groups).toEqual([{ team: "x", count: 2, total: 30 }]);
  });

  test("a document survives a JSON to YAML to TOML to JSON round trip", async () => {
    const original = { name: "demo", n: 3, t: { flag: true, list: [1, 2] } };
    const toYaml = await executeTool(
      lookup("DataConvert"),
      { text: JSON.stringify(original), from: "json", to: "yaml" },
      { toolUseId: "r1" },
    );
    const toToml = await executeTool(
      lookup("DataConvert"),
      { text: toYaml.content, from: "yaml", to: "toml" },
      { toolUseId: "r2" },
    );
    const back = await executeTool(
      lookup("DataConvert"),
      { text: toToml.content, from: "toml", to: "json" },
      { toolUseId: "r3" },
    );
    expect(JSON.parse(back.content)).toEqual(original);
  });
});
