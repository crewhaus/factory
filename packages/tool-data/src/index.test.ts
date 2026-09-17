/**
 * Every tool this package registers, exercised through its own `execute`.
 *
 * Two things are checked for all of them, because they are the contract the
 * runtime relies on: the safety flags are what the tool contract expects for
 * a pure-compute tool, and the declared schema actually rejects bad input.
 * After that, each tool gets the behaviour tests that matter for it — a
 * happy path, an edge, and a schema rejection at minimum.
 */
import { describe, expect, test } from "bun:test";
import {
  DATA_TOOLS,
  columnsToRecords,
  csvParse,
  csvWrite,
  dataConvert,
  dataDiff,
  dataShape,
  dedupeRecords,
  flattenObject,
  jsonFormat,
  jsonMergePatch,
  jsonPatch,
  jsonQuery,
  jsonSortKeys,
  jsonlParse,
  jsonlWrite,
  recordsToColumns,
  sampleRecords,
  sortRecords,
  tableAggregate,
  tableJoin,
  tableQuery,
  unflattenObject,
  xmlParse,
} from "./index";

/** Tools return compact JSON; parse it so assertions read as data. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: (typeof DATA_TOOLS)[number], input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

/** The raw string result, for tools that return a document rather than JSON. */
async function text(tool: (typeof DATA_TOOLS)[number], input: unknown): Promise<string> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  return out;
}

describe("package-wide contract", () => {
  test("every tool is exported in DATA_TOOLS", () => {
    expect(DATA_TOOLS.length).toBe(23);
  });

  test("the array is frozen, so a consumer cannot mutate the catalog", () => {
    expect(Object.isFrozen(DATA_TOOLS)).toBe(true);
  });

  test("names are unique", () => {
    const names = DATA_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every tool is PascalCase", () => {
    for (const t of DATA_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only, non-destructive and internal — this package touches nothing", () => {
    for (const t of DATA_TOOLS) {
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
    for (const t of DATA_TOOLS) {
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });

  test("every tool is concurrency-safe, since all are pure", () => {
    for (const t of DATA_TOOLS) {
      expect({ name: t.name, safe: t.concurrencySafe }).toEqual({ name: t.name, safe: true });
    }
  });

  test("every description says what it is for, not just what it is", () => {
    for (const t of DATA_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).toContain("Use ");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of DATA_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });
});

describe("JsonQuery", () => {
  const doc = JSON.stringify({
    users: [
      { name: "ada", age: 36, email: "a@x.com" },
      { name: "bob", age: 20 },
    ],
    meta: { name: "report" },
  });

  test("selects values with their paths", async () => {
    const out = await run(jsonQuery, { json: doc, path: "$.users[*].name" });
    expect(out.count).toBe(2);
    expect(out.matches[0]).toEqual({ path: "$.users[0].name", value: "ada" });
  });

  test("valuesOnly drops the paths", async () => {
    const out = await run(jsonQuery, { json: doc, path: "$.users[*].name", valuesOnly: true });
    expect(out.values).toEqual(["ada", "bob"]);
    expect(out.matches).toBeUndefined();
  });

  test("a filter narrows to matching elements", async () => {
    const out = await run(jsonQuery, { json: doc, path: "$.users[?(@.age > 30)].name" });
    expect(out.count).toBe(1);
  });

  test("recursive descent crosses levels", async () => {
    const out = await run(jsonQuery, { json: doc, path: "$..name", valuesOnly: true });
    expect(out.values).toEqual(["ada", "bob", "report"]);
  });

  test("a path that matches nothing returns a count of zero, not an error", async () => {
    const out = await run(jsonQuery, { json: doc, path: "$.nope" });
    expect(out.count).toBe(0);
  });

  test("maxResults truncates and says so", async () => {
    const out = await run(jsonQuery, { json: doc, path: "$..*", maxResults: 2 });
    expect(out.truncated).toBe(true);
  });

  test("a malformed path is reported, not thrown", async () => {
    expect(await text(jsonQuery, { json: doc, path: "$.a[" })).toContain("invalid path");
  });

  test("malformed JSON is reported, not thrown", async () => {
    expect(await text(jsonQuery, { json: "{oops", path: "$.a" })).toContain("not valid JSON");
  });

  test("the schema requires a non-empty path", () => {
    expect(jsonQuery.inputSchema.safeParse({ json: "{}", path: "" }).success).toBe(false);
  });
});

describe("JsonPatch", () => {
  test("applies a sequence of operations", async () => {
    const out = await run(jsonPatch, {
      json: '{"a":1}',
      patch: [
        { op: "add", path: "/b", value: 2 },
        { op: "remove", path: "/a" },
      ],
    });
    expect(out).toEqual({ b: 2 });
  });

  test("a failing test operation aborts the whole patch", async () => {
    const out = await text(jsonPatch, {
      json: '{"a":1}',
      patch: [
        { op: "test", path: "/a", value: 99 },
        { op: "add", path: "/b", value: 2 },
      ],
    });
    expect(out).toContain("operation 0");
    expect(out).toContain("unchanged");
  });

  test("a move without a from is refused before anything is applied", async () => {
    const out = await text(jsonPatch, { json: "{}", patch: [{ op: "move", path: "/b" }] });
    expect(out).toContain('needs a "from"');
  });

  test("a malformed pointer is a message naming the operation, not a crash", async () => {
    const out = await text(jsonPatch, {
      json: '{"a":1}',
      patch: [{ op: "add", path: "b", value: 2 }],
    });
    expect(out).toContain("patch failed at operation 0");
    expect(out).toContain("the document is unchanged");
  });

  test("an add without a value is refused", async () => {
    const out = await text(jsonPatch, { json: "{}", patch: [{ op: "add", path: "/b" }] });
    expect(out).toContain('needs a "value"');
  });

  test("indent controls the output formatting", async () => {
    const out = await text(jsonPatch, {
      json: '{"a":1}',
      patch: [{ op: "replace", path: "/a", value: 2 }],
      indent: 2,
    });
    expect(out).toBe('{\n  "a": 2\n}');
  });

  test("the schema rejects an unknown operation name", () => {
    expect(
      jsonPatch.inputSchema.safeParse({ json: "{}", patch: [{ op: "explode", path: "/a" }] })
        .success,
    ).toBe(false);
  });

  test("the schema requires at least one operation", () => {
    expect(jsonPatch.inputSchema.safeParse({ json: "{}", patch: [] }).success).toBe(false);
  });
});

describe("JsonMergePatch", () => {
  test("applies a patch, with null deleting a key", async () => {
    const out = await run(jsonMergePatch, { json: '{"a":1,"b":2}', patch: '{"b":null,"c":3}' });
    expect(out).toEqual({ a: 1, c: 3 });
  });

  test("derives the patch between two documents", async () => {
    const out = await run(jsonMergePatch, { json: '{"a":1,"b":2}', against: '{"a":1}' });
    expect(out).toEqual({ b: null });
  });

  test("the derived patch, applied, reproduces the target", async () => {
    const from = '{"a":{"b":1,"c":2}}';
    const to = '{"a":{"b":9}}';
    const patch = await text(jsonMergePatch, { json: from, against: to });
    const applied = await run(jsonMergePatch, { json: from, patch });
    expect(applied).toEqual(JSON.parse(to));
  });

  test("neither patch nor against is a readable message, not a crash", async () => {
    expect(await text(jsonMergePatch, { json: "{}" })).toContain("supply either");
  });

  test("a malformed patch is reported", async () => {
    expect(await text(jsonMergePatch, { json: "{}", patch: "{" })).toContain("not valid JSON");
  });

  test("the schema requires the document", () => {
    expect(jsonMergePatch.inputSchema.safeParse({ patch: "{}" }).success).toBe(false);
  });
});

describe("JsonFormat", () => {
  test("pretty-prints by default", async () => {
    expect(await text(jsonFormat, { json: '{"a":1}' })).toBe('{\n  "a": 1\n}');
  });

  test("indent 0 minifies", async () => {
    expect(await text(jsonFormat, { json: '{\n "a": 1\n}', indent: 0 })).toBe('{"a":1}');
  });

  test("sortKeys makes two differently-ordered documents byte-identical", async () => {
    const a = await text(jsonFormat, { json: '{"b":1,"a":2}', sortKeys: true, indent: 0 });
    const b = await text(jsonFormat, { json: '{"a":2,"b":1}', sortKeys: true, indent: 0 });
    expect(a).toBe(b);
  });

  test("a pointer narrows to one subtree", async () => {
    expect(await text(jsonFormat, { json: '{"a":{"b":1}}', pointer: "/a", indent: 0 })).toBe(
      '{"b":1}',
    );
  });

  test("a pointer that misses is reported", async () => {
    expect(await text(jsonFormat, { json: "{}", pointer: "/nope" })).toContain("does not resolve");
  });

  test("withHash returns a stable fingerprint alongside the text", async () => {
    const a = await run(jsonFormat, { json: '{"b":1,"a":2}', sortKeys: true, withHash: true });
    const b = await run(jsonFormat, { json: '{"a":2,"b":1}', sortKeys: true, withHash: true });
    expect(a.hash).toBe(b.hash);
    expect(a.bytes).toBeGreaterThan(0);
  });

  test("the schema bounds the indent", () => {
    expect(jsonFormat.inputSchema.safeParse({ json: "{}", indent: 99 }).success).toBe(false);
  });
});

describe("DataDiff", () => {
  test("identical documents report identical with no entries", async () => {
    const out = await run(dataDiff, { before: '{"a":1}', after: '{"a":1}' });
    expect(out.identical).toBe(true);
    expect(out.entries).toBeUndefined();
  });

  test("added, removed and changed are each counted and located", async () => {
    const out = await run(dataDiff, { before: '{"a":1,"b":2}', after: '{"a":9,"c":3}' });
    expect(out).toMatchObject({ added: 1, removed: 1, changed: 1 });
    expect(out.entries.map((e: { path: string }) => e.path).sort()).toEqual(["/a", "/b", "/c"]);
  });

  test("keyArraysBy matches records by id instead of position", async () => {
    const before = JSON.stringify([
      { id: "a", v: 1 },
      { id: "b", v: 2 },
    ]);
    const after = JSON.stringify([
      { id: "b", v: 2 },
      { id: "a", v: 1 },
    ]);
    const positional = await run(dataDiff, { before, after });
    const keyed = await run(dataDiff, { before, after, keyArraysBy: "id" });
    expect(positional.identical).toBe(false);
    expect(keyed.identical).toBe(true);
  });

  test("countsOnly omits the entry list", async () => {
    const out = await run(dataDiff, { before: '{"a":1}', after: '{"a":2}', countsOnly: true });
    expect(out.changed).toBe(1);
    expect(out.entries).toBeUndefined();
  });

  test("maxEntries truncates and says so", async () => {
    const before = JSON.stringify(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, i])));
    const out = await run(dataDiff, { before, after: "{}", maxEntries: 3 });
    expect(out.truncated).toBe(true);
  });

  test("malformed input on either side is reported", async () => {
    expect(await text(dataDiff, { before: "{", after: "{}" })).toContain("before");
    expect(await text(dataDiff, { before: "{}", after: "{" })).toContain("after");
  });

  test("the schema requires both sides", () => {
    expect(dataDiff.inputSchema.safeParse({ before: "{}" }).success).toBe(false);
  });
});

describe("DataConvert", () => {
  test("JSON to YAML and back", async () => {
    const yaml = await text(dataConvert, { text: '{"a":1,"b":["x"]}', from: "json", to: "yaml" });
    expect(yaml).toBe("a: 1\nb:\n  - x");
    const back = await text(dataConvert, { text: yaml, from: "yaml", to: "json", indent: 0 });
    expect(back).toBe('{"a":1,"b":["x"]}');
  });

  test("JSON to TOML and back", async () => {
    const toml = await text(dataConvert, {
      text: '{"a":1,"t":{"b":"x"}}',
      from: "json",
      to: "toml",
    });
    expect(toml).toContain("[t]");
    const back = await text(dataConvert, { text: toml, from: "toml", to: "json", indent: 0 });
    expect(JSON.parse(back)).toEqual({ a: 1, t: { b: "x" } });
  });

  test("CSV to JSON infers scalar types", async () => {
    const out = await text(dataConvert, {
      text: "a,b\n1,true\n",
      from: "csv",
      to: "json",
      indent: 0,
    });
    expect(JSON.parse(out)).toEqual([{ a: 1, b: true }]);
  });

  test("JSON records to CSV", async () => {
    const out = await text(dataConvert, {
      text: '[{"a":1,"b":"x,y"}]',
      from: "json",
      to: "csv",
    });
    expect(out).toBe('a,b\n1,"x,y"');
  });

  test("JSONL to JSON", async () => {
    const out = await text(dataConvert, { text: "1\n2\n", from: "jsonl", to: "json", indent: 0 });
    expect(out).toBe("[1,2]");
  });

  test("a value TOML cannot hold is reported rather than dropped in silence", async () => {
    const out = await text(dataConvert, { text: '{"a":null,"b":1}', from: "json", to: "toml" });
    expect(out).toContain("dropped");
  });

  test("converting a non-object to TOML is refused with a reason", async () => {
    const out = await text(dataConvert, { text: "[1,2]", from: "json", to: "toml" });
    expect(out).toContain("must be an object");
  });

  test("converting a non-array to CSV is refused with a reason", async () => {
    const out = await text(dataConvert, { text: '{"a":1}', from: "json", to: "csv" });
    expect(out).toContain("not an array");
  });

  test("a malformed source reports its format and line", async () => {
    expect(await text(dataConvert, { text: "a:\n\tb: 1", from: "yaml", to: "json" })).toContain(
      "invalid YAML on line",
    );
  });

  test("the schema rejects an unknown format", () => {
    expect(dataConvert.inputSchema.safeParse({ text: "", from: "xml", to: "json" }).success).toBe(
      false,
    );
  });
});

describe("CsvParse", () => {
  test("reads a header and quoted fields into records", async () => {
    const out = await run(csvParse, { text: 'a,b\n1,"x,y"\n' });
    expect(out.columns).toEqual(["a", "b"]);
    expect(out.records).toEqual([{ a: "1", b: "x,y" }]);
  });

  test("inferTypes reads numbers, booleans and blanks", async () => {
    const out = await run(csvParse, { text: "n,f,e\n42,true,\n", inferTypes: true });
    expect(out.records[0]).toEqual({ n: 42, f: true, e: null });
  });

  test("header false returns raw rows", async () => {
    const out = await run(csvParse, { text: "1,2\n3,4\n", header: false });
    expect(out.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("a custom delimiter reads a TSV", async () => {
    const out = await run(csvParse, { text: "a\tb\n1\t2\n", delimiter: "\t" });
    expect(out.records[0]).toEqual({ a: "1", b: "2" });
  });

  test("ragged rows are flagged rather than silently padded", async () => {
    const out = await run(csvParse, { text: "a,b\n1\n" });
    expect(out.raggedRows).toEqual([0]);
    expect(out.records[0]).toEqual({ a: "1", b: null });
  });

  test("nullTokens turn sentinel cells into null", async () => {
    const out = await run(csvParse, { text: "a\nNA\n", inferTypes: true, nullTokens: ["NA"] });
    expect(out.records[0]).toEqual({ a: null });
  });

  test("an unterminated quote is reported with its line", async () => {
    expect(await text(csvParse, { text: 'a\n"oops\n' })).toContain("invalid CSV on line");
  });

  test("a row that is one quoted empty field is kept, not read as a blank line", async () => {
    // RFC 4180: `""` is a field whose value is the empty string. Dropping
    // the row loses a record, and the row count would not even say so.
    const out = await run(csvParse, { text: 'name\n""\nb\n' });
    expect(out.rowCount).toBe(2);
    expect(out.records).toEqual([{ name: "" }, { name: "b" }]);
  });

  test("a duplicated header never collapses two columns into one", async () => {
    const out = await run(csvParse, { text: "a,a,a_2\n1,2,3\n" });
    expect(new Set(out.columns).size).toBe(3);
    expect(Object.keys(out.records[0])).toHaveLength(3);
    expect(Object.values(out.records[0])).toEqual(["1", "2", "3"]);
  });

  test("an empty document is an empty result, not an error", async () => {
    const out = await run(csvParse, { text: "" });
    expect(out.rowCount).toBe(0);
  });

  test("the schema rejects a multi-character delimiter", () => {
    expect(csvParse.inputSchema.safeParse({ text: "", delimiter: "||" }).success).toBe(false);
  });
});

describe("CsvWrite", () => {
  test("records become a header plus rows", async () => {
    expect(await text(csvWrite, { records: [{ a: 1, b: 2 }] })).toBe("a,b\n1,2");
  });

  test("a field containing the delimiter is quoted", async () => {
    expect(await text(csvWrite, { records: [{ a: "x,y" }] })).toBe('a\n"x,y"');
  });

  test("columns fix the order and the set", async () => {
    expect(await text(csvWrite, { records: [{ a: 1, b: 2 }], columns: ["b"] })).toBe("b\n2");
  });

  test("header false omits the header row", async () => {
    expect(await text(csvWrite, { records: [{ a: 1 }], header: false })).toBe("1");
  });

  test("arrays are written as raw rows", async () => {
    expect(await text(csvWrite, { records: [[1, 2]] })).toBe("1,2");
  });

  test("crlf uses the line ending RFC 4180 specifies", async () => {
    expect(await text(csvWrite, { records: [{ a: 1 }], crlf: true })).toBe("a\r\n1");
  });

  test("a mix of records and rows is refused with a reason", async () => {
    expect(await text(csvWrite, { records: [{ a: 1 }, [2]] })).toContain("mix of records and rows");
  });

  test("an empty input produces an empty document", async () => {
    expect(await text(csvWrite, { records: [] })).toBe("");
  });

  test("the schema requires the records field", () => {
    expect(csvWrite.inputSchema.safeParse({}).success).toBe(false);
  });
});

describe("TableQuery", () => {
  const records = [
    { id: 1, name: "ada", team: { id: "x" }, score: 10 },
    { id: 2, name: "bob", team: { id: "y" }, score: 30 },
    { id: 3, name: "cy", team: { id: "x" }, score: 20 },
  ];

  test("a filter narrows the set and reports how many matched", async () => {
    const out = await run(tableQuery, {
      records,
      where: { all: [{ field: "team.id", op: "eq", value: "x" }] },
    });
    expect(out.matched).toBe(2);
    expect(out.records.map((r: { id: number }) => r.id)).toEqual([1, 3]);
  });

  test("select keeps only the named fields", async () => {
    const out = await run(tableQuery, { records, select: ["name"] });
    expect(out.records[0]).toEqual({ name: "ada" });
  });

  test("omit drops a nested field", async () => {
    const out = await run(tableQuery, { records, omit: ["team.id"] });
    expect(out.records[0].team).toEqual({});
  });

  test("sort and limit page the result", async () => {
    const out = await run(tableQuery, {
      records,
      sort: [{ field: "score", direction: "desc" }],
      limit: 1,
    });
    expect(out.records[0].id).toBe(2);
  });

  test("offset skips from the front", async () => {
    const out = await run(tableQuery, { records, sort: [{ field: "id" }], offset: 2 });
    expect(out.records[0].id).toBe(3);
  });

  test("countOnly returns the count without the rows", async () => {
    const out = await run(tableQuery, { records, countOnly: true });
    expect(out.matched).toBe(3);
    expect(out.records).toBeUndefined();
  });

  test("an invalid regex in a filter is reported, not thrown", async () => {
    const out = await text(tableQuery, {
      records,
      where: { all: [{ field: "name", op: "matches", value: "(" }] },
    });
    expect(out).toContain("invalid filter");
  });

  test("the schema rejects an unknown operator", () => {
    expect(
      tableQuery.inputSchema.safeParse({
        records: [],
        where: { all: [{ field: "a", op: "approximately" }] },
      }).success,
    ).toBe(false);
  });
});

describe("TableAggregate", () => {
  const records = [
    { team: "x", cost: 10 },
    { team: "x", cost: 20 },
    { team: "y", cost: 5 },
  ];

  test("groups and reduces", async () => {
    const out = await run(tableAggregate, {
      records,
      groupBy: ["team"],
      aggregations: [{ as: "total", fn: "sum", field: "cost" }],
    });
    expect(out.groupCount).toBe(2);
    expect(out.groups[0]).toEqual({ team: "x", count: 2, total: 30 });
  });

  test("an empty groupBy aggregates the whole set", async () => {
    const out = await run(tableAggregate, {
      records,
      groupBy: [],
      aggregations: [{ as: "avg", fn: "avg", field: "cost" }],
    });
    expect(out.groups[0].count).toBe(3);
  });

  test("groups can be sorted", async () => {
    const out = await run(tableAggregate, {
      records,
      groupBy: ["team"],
      aggregations: [{ as: "total", fn: "sum", field: "cost" }],
      sort: [{ field: "total", direction: "desc" }],
    });
    expect(out.groups[0].team).toBe("x");
  });

  test("non-numeric values are skipped and the count is reported", async () => {
    const out = await run(tableAggregate, {
      records: [{ n: 1 }, { n: "oops" }],
      groupBy: [],
      aggregations: [{ as: "t", fn: "sum", field: "n" }],
    });
    expect(out.groups[0].t).toBe(1);
    expect(out.nonNumericSkipped).toBe(1);
  });

  test("with no aggregations it is a group-and-count", async () => {
    const out = await run(tableAggregate, { records, groupBy: ["team"] });
    expect(out.groups[0]).toEqual({ team: "x", count: 2 });
  });

  test("the schema rejects an unknown aggregate function", () => {
    expect(
      tableAggregate.inputSchema.safeParse({
        records: [],
        groupBy: [],
        aggregations: [{ as: "x", fn: "median" }],
      }).success,
    ).toBe(false);
  });
});

describe("TableJoin", () => {
  const left = [
    { id: 1, a: "A" },
    { id: 2, a: "B" },
  ];
  const right = [{ id: 1, b: "X" }];

  test("an inner join keeps matches and counts the misses", async () => {
    const out = await run(tableJoin, { left, right, leftKey: "id" });
    expect(out.rowCount).toBe(1);
    expect(out.unmatchedLeft).toBe(1);
  });

  test("a left join keeps unmatched left rows", async () => {
    const out = await run(tableJoin, { left, right, leftKey: "id", kind: "left" });
    expect(out.rowCount).toBe(2);
  });

  test("the right key can differ from the left one", async () => {
    const out = await run(tableJoin, {
      left,
      right: [{ userId: 1, b: "X" }],
      leftKey: "id",
      rightKey: "userId",
    });
    expect(out.rowCount).toBe(1);
  });

  test("a colliding field is prefixed rather than overwritten", async () => {
    const out = await run(tableJoin, {
      left: [{ id: 1, v: "l" }],
      right: [{ id: 1, v: "r" }],
      leftKey: "id",
    });
    expect(out.rows[0]).toEqual({ id: 1, v: "l", right_id: 1, right_v: "r" });
  });

  test("maxRows truncates and says so", async () => {
    const out = await run(tableJoin, {
      left: [{ id: 1 }],
      right: [
        { id: 1, n: 1 },
        { id: 1, n: 2 },
      ],
      leftKey: "id",
      maxRows: 1,
    });
    expect(out.truncated).toBe(true);
  });

  test("the schema requires a non-empty left key", () => {
    expect(tableJoin.inputSchema.safeParse({ left: [], right: [], leftKey: "" }).success).toBe(
      false,
    );
  });
});

describe("RecordsToColumns and ColumnsToRecords", () => {
  test("records become columns, missing values as null", async () => {
    const out = await run(recordsToColumns, { records: [{ a: 1 }, { b: 2 }] });
    expect(out.columns).toEqual({ a: [1, null], b: [null, 2] });
    expect(out.rowCount).toBe(2);
  });

  test("columns can be restricted and ordered", async () => {
    const out = await run(recordsToColumns, { records: [{ a: 1, b: 2 }], columns: ["b"] });
    expect(Object.keys(out.columns)).toEqual(["b"]);
  });

  test("columns become records, short ones padded and named", async () => {
    const out = await run(columnsToRecords, { columns: { a: [1, 2], b: [3] } });
    expect(out.records).toEqual([
      { a: 1, b: 3 },
      { a: 2, b: null },
    ]);
    expect(out.paddedColumns).toEqual(["b"]);
  });

  test("the two are inverses for rectangular data", async () => {
    const records = [
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ];
    const cols = await run(recordsToColumns, { records });
    const back = await run(columnsToRecords, { columns: cols.columns });
    expect(back.records).toEqual(records);
  });

  test("the schema rejects a column that is not an array", () => {
    expect(columnsToRecords.inputSchema.safeParse({ columns: { a: 1 } }).success).toBe(false);
  });

  test("the schema rejects records that are not objects", () => {
    expect(recordsToColumns.inputSchema.safeParse({ records: [1] }).success).toBe(false);
  });
});

describe("FlattenObject and UnflattenObject", () => {
  test("nesting becomes dotted keys, arrays indexed", async () => {
    const out = await run(flattenObject, { json: '{"a":{"b":1},"c":[7]}' });
    expect(out).toEqual({ "a.b": 1, "c.0": 7 });
  });

  test("arrays can be left whole", async () => {
    const out = await run(flattenObject, { json: '{"c":[7]}', expandArrays: false });
    expect(out).toEqual({ c: [7] });
  });

  test("a custom separator is honoured", async () => {
    const out = await run(flattenObject, { json: '{"a":{"b":1}}', separator: "__" });
    expect(out).toEqual({ a__b: 1 });
  });

  test("unflatten rebuilds nesting and contiguous arrays", async () => {
    const out = await run(unflattenObject, { flat: { "a.b": 1, "c.0": 7, "c.1": 8 } });
    expect(out).toEqual({ a: { b: 1 }, c: [7, 8] });
  });

  test("a sparse numeric run stays an object rather than inventing nulls", async () => {
    const out = await run(unflattenObject, { flat: { "a.2": 1 } });
    expect(out).toEqual({ a: { "2": 1 } });
  });

  test("flatten then unflatten is a round trip", async () => {
    const value = { a: { b: [1, { c: 2 }] }, d: "x" };
    const flat = await run(flattenObject, { json: JSON.stringify(value) });
    const back = await run(unflattenObject, { flat });
    expect(back).toEqual(value);
  });

  test("malformed JSON is reported", async () => {
    expect(await text(flattenObject, { json: "{" })).toContain("not valid JSON");
  });

  test("the schema rejects an empty separator", () => {
    expect(flattenObject.inputSchema.safeParse({ json: "{}", separator: "" }).success).toBe(false);
  });
});

describe("JsonlParse and JsonlWrite", () => {
  test("values come back in order", async () => {
    const out = await run(jsonlParse, { text: '{"a":1}\n{"a":2}\n' });
    expect(out.records).toEqual([{ a: 1 }, { a: 2 }]);
    expect(out.count).toBe(2);
  });

  test("a bad line is reported with its number and the rest survive", async () => {
    const out = await run(jsonlParse, { text: "1\nnope\n3" });
    expect(out.records).toEqual([1, 3]);
    expect(out.failures[0].line).toBe(2);
  });

  test("stopOnError halts at the first bad line", async () => {
    const out = await run(jsonlParse, { text: "1\nnope\n3", stopOnError: true });
    expect(out.count).toBe(1);
  });

  test("withLineNumbers keeps the line each record came from", async () => {
    const out = await run(jsonlParse, { text: "\n1\n", withLineNumbers: true });
    expect(out.records).toEqual([{ line: 2, value: 1 }]);
  });

  test("writing produces one compact line per value", async () => {
    expect(await text(jsonlWrite, { values: [{ a: 1 }, 2] })).toBe('{"a":1}\n2\n');
  });

  test("the trailing newline can be suppressed", async () => {
    expect(await text(jsonlWrite, { values: [1], trailingNewline: false })).toBe("1");
  });

  test("write then parse is a round trip", async () => {
    const values = [{ a: "x\ny" }, [1], null];
    const doc = await text(jsonlWrite, { values });
    const out = await run(jsonlParse, { text: doc });
    expect(out.records).toEqual(values);
  });

  test("the schema requires the values array", () => {
    expect(jsonlWrite.inputSchema.safeParse({}).success).toBe(false);
  });
});

describe("XmlParse", () => {
  test("the compact shape lifts attributes and text", async () => {
    const out = await run(xmlParse, { text: '<a x="1">hi</a>' });
    expect(out).toEqual({ a: { "@x": "1", "#text": "hi" } });
  });

  test("repeated siblings become an array", async () => {
    const out = await run(xmlParse, { text: "<r><i>1</i><i>2</i></r>" });
    expect(out).toEqual({ r: { i: ["1", "2"] } });
  });

  test("the tree shape keeps element order explicitly", async () => {
    const out = await run(xmlParse, { text: "<a><b/></a>", shape: "tree" });
    expect(out[0].name).toBe("a");
    expect(out[0].children[0].name).toBe("b");
  });

  test("CDATA comes through literally", async () => {
    const out = await run(xmlParse, { text: "<a><![CDATA[<raw>]]></a>" });
    expect(out).toEqual({ a: "<raw>" });
  });

  test("html mode handles void elements and bare attributes", async () => {
    const out = await run(xmlParse, { text: "<p>a<br>b</p><input disabled>", mode: "html" });
    expect(out.input).toEqual({ "@disabled": "" });
  });

  test("a mismatched tag is reported with its line, not thrown", async () => {
    const out = await text(xmlParse, { text: "<a>\n<b></c>\n</a>" });
    expect(out).toContain("invalid markup on line 2");
  });

  test("an unknown entity is refused, because there is no DTD to define it", async () => {
    expect(await text(xmlParse, { text: "<a>&nbsp;</a>" })).toContain("unknown entity");
  });

  test("a character reference outside Unicode comes back as a message, not a crash", async () => {
    // String.fromCodePoint raises a RangeError for these. The package's
    // contract is that a caller's malformed document is a result.
    for (const bad of ["<a>&#x110000;</a>", "<a>&#-1;</a>", '<a b="&#xD800;"/>']) {
      const out = await text(xmlParse, { text: bad });
      expect({ bad, ok: out.startsWith("invalid markup") }).toEqual({ bad, ok: true });
    }
  });

  test("the schema rejects an unknown mode", () => {
    expect(xmlParse.inputSchema.safeParse({ text: "<a/>", mode: "sgml" }).success).toBe(false);
  });
});

describe("SortRecords", () => {
  test("sorts by a dotted path", async () => {
    const out = await run(sortRecords, {
      records: [{ t: { n: 2 } }, { t: { n: 1 } }],
      keys: [{ field: "t.n" }],
    });
    expect(out[0].t.n).toBe(1);
  });

  test("descending and a tie-breaking second key", async () => {
    const out = await run(sortRecords, {
      records: [
        { a: 1, b: 2 },
        { a: 1, b: 1 },
        { a: 2, b: 0 },
      ],
      keys: [{ field: "a", direction: "desc" }, { field: "b" }],
    });
    expect(out[0].a).toBe(2);
    expect(out[1].b).toBe(1);
  });

  test("nulls go last by default", async () => {
    const out = await run(sortRecords, {
      records: [{ n: null }, { n: 1 }],
      keys: [{ field: "n" }],
    });
    expect(out[0].n).toBe(1);
  });

  test("scalars sort by the empty field path", async () => {
    const out = await run(sortRecords, { records: [3, 1, 2], keys: [{ field: "" }] });
    expect(out).toEqual([1, 2, 3]);
  });

  test("the schema requires at least one key", () => {
    expect(sortRecords.inputSchema.safeParse({ records: [], keys: [] }).success).toBe(false);
  });
});

describe("DedupeRecords", () => {
  test("whole-value dedupe ignores key order", async () => {
    const out = await run(dedupeRecords, {
      records: [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
    });
    expect(out.kept).toBe(1);
    expect(out.removed).toBe(1);
  });

  test("key fields define the identity", async () => {
    const out = await run(dedupeRecords, {
      records: [
        { id: 1, v: "a" },
        { id: 1, v: "b" },
      ],
      keyFields: ["id"],
    });
    expect(out.records[0].v).toBe("a");
  });

  test("keep last takes the later occurrence", async () => {
    const out = await run(dedupeRecords, {
      records: [
        { id: 1, v: "a" },
        { id: 1, v: "b" },
      ],
      keyFields: ["id"],
      keep: "last",
    });
    expect(out.records[0].v).toBe("b");
  });

  test("countOnly omits the records", async () => {
    const out = await run(dedupeRecords, { records: [1, 1], countOnly: true });
    expect(out.kept).toBe(1);
    expect(out.records).toBeUndefined();
  });

  test("the schema rejects an unknown keep mode", () => {
    expect(dedupeRecords.inputSchema.safeParse({ records: [], keep: "both" }).success).toBe(false);
  });
});

describe("SampleRecords", () => {
  const records = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  test("head is the default", async () => {
    const out = await run(sampleRecords, { records, count: 3 });
    expect(out.records).toEqual([0, 1, 2]);
    expect(out.total).toBe(10);
  });

  test("tail takes from the end", async () => {
    const out = await run(sampleRecords, { records, mode: "tail", count: 2 });
    expect(out.records).toEqual([8, 9]);
  });

  test("everyNth steps through", async () => {
    const out = await run(sampleRecords, { records, mode: "everyNth", step: 4, count: 10 });
    expect(out.records).toEqual([0, 4, 8]);
  });

  test("evenly spans the whole range", async () => {
    const out = await run(sampleRecords, { records, mode: "evenly", count: 3 });
    expect(out.records).toEqual([0, 5, 9]);
  });

  test("the same call twice gives the same sample", async () => {
    const a = await text(sampleRecords, { records, mode: "evenly", count: 4 });
    const b = await text(sampleRecords, { records, mode: "evenly", count: 4 });
    expect(a).toBe(b);
  });

  test("the schema rejects a zero count", () => {
    expect(sampleRecords.inputSchema.safeParse({ records: [], count: 0 }).success).toBe(false);
  });
});

describe("DataShape", () => {
  test("describes an array of records field by field", async () => {
    const out = await run(dataShape, {
      json: JSON.stringify([{ a: 1, b: "x" }, { a: 2 }]),
    });
    expect(out.rootType).toBe("array");
    expect(out.rowCount).toBe(2);
    const a = out.fields.find((f: { path: string }) => f.path === "a");
    expect(a.present).toBe(2);
    expect(a.types).toEqual(["number"]);
  });

  test("a field with mixed types lists them all", async () => {
    const out = await run(dataShape, { json: '[{"a":1},{"a":"x"},{"a":null}]' });
    const a = out.fields[0];
    expect(a.types).toEqual(["null", "number", "string"]);
    expect(a.nonNull).toBe(2);
  });

  test("nested fields are reported by dotted path", async () => {
    const out = await run(dataShape, { json: '[{"u":{"n":1}}]' });
    expect(out.fields[0].path).toBe("u.n");
  });

  test("a single object is described as one row", async () => {
    const out = await run(dataShape, { json: '{"a":1}' });
    expect(out.rowCount).toBe(1);
    expect(out.rootType).toBe("object");
  });

  test("examples can be switched off", async () => {
    const out = await run(dataShape, { json: '[{"a":1}]', examples: 0 });
    expect(out.fields[0].examples).toBeUndefined();
  });

  test("malformed JSON is reported", async () => {
    expect(await text(dataShape, { json: "{" })).toContain("not valid JSON");
  });

  test("the schema bounds the example count", () => {
    expect(dataShape.inputSchema.safeParse({ json: "{}", examples: 99 }).success).toBe(false);
  });
});

describe("JsonSortKeys", () => {
  test("sorts keys at every depth", async () => {
    const out = await text(jsonSortKeys, { json: '{"b":{"d":1,"c":2},"a":3}', indent: 0 });
    expect(out).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  test("array order is untouched, because order is data", async () => {
    expect(await text(jsonSortKeys, { json: "[3,1,2]", indent: 0 })).toBe("[3,1,2]");
  });

  test("running it twice changes nothing the second time", async () => {
    const once = await text(jsonSortKeys, { json: '{"b":1,"a":2}' });
    expect(await text(jsonSortKeys, { json: once })).toBe(once);
  });

  test("malformed JSON is reported", async () => {
    expect(await text(jsonSortKeys, { json: "{" })).toContain("not valid JSON");
  });

  test("the schema requires the document", () => {
    expect(jsonSortKeys.inputSchema.safeParse({}).success).toBe(false);
  });
});
