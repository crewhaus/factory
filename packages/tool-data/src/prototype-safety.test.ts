/**
 * Keys named like Object.prototype members are data.
 *
 * Before 0.7.1 the path walkers here descended with `cur[seg]` and wrote with
 * `cur[seg] = …`. A `__proto__` segment therefore reached Object.prototype
 * itself and wrote into it: one read-only call on a hostile TOML file, or a
 * JSON document put through Flatten→Unflatten, gave every object in the
 * process a new inherited field. zod reads an absent optional argument
 * through the prototype chain, so the next tool call's parsed input picked
 * that field up (an `overwrite: true` the model never sent). The same reads
 * dropped or garbled ordinary documents: an XML `<constructor>` element came
 * back as `[null, "ACME Ltd"]`, a CSV `__proto__` column vanished, and a
 * JSON Patch `add /__proto__` reported success and changed nothing.
 *
 * Each case goes through the tool's own schema and `execute`, and afterwards
 * Object.prototype must have exactly the members it had before.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  csvParse,
  dataConvert,
  flattenObject,
  jsonMergePatch,
  jsonPatch,
  jsonQuery,
  recordsToColumns,
  tableAggregate,
  tableQuery,
  unflattenObject,
  xmlParse,
} from "./index";
import { getOwn, setOwn } from "./lib/json";

type Tool = {
  inputSchema: { parse: (v: unknown) => unknown };
  execute: (input: never) => Promise<unknown>;
};

async function call(tool: Tool, input: unknown): Promise<string> {
  const out = await tool.execute(tool.inputSchema.parse(input) as never);
  if (typeof out !== "string") throw new Error("expected a string result");
  return out;
}

const PROTO = Object.prototype as unknown as Record<string, unknown>;
let before: string[];

beforeEach(() => {
  before = Object.getOwnPropertyNames(Object.prototype).sort();
});

afterEach(() => {
  // Clean up whatever a regression left behind, so one failure cannot make
  // every later test in the process fail with it.
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    if (!before.includes(name)) delete PROTO[name];
  }
});

/** Object.prototype gained nothing, and a fresh object inherits nothing new. */
function expectPrototypeUntouched(): void {
  expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(({} as Record<string, unknown>).overwrite).toBeUndefined();
  expect(typeof Object.prototype.hasOwnProperty).toBe("function");
}

describe("no tool writes into Object.prototype", () => {
  test("UnflattenObject with a __proto__ segment stores it as a field", async () => {
    const out = await call(unflattenObject, { flat: { "__proto__.polluted": "yes" } });
    expectPrototypeUntouched();
    expect(out).toBe('{"__proto__":{"polluted":"yes"}}');
  });

  test("UnflattenObject with nested and constructor.prototype segments", async () => {
    await call(unflattenObject, { flat: { "a.__proto__.polluted": 1 } });
    await call(unflattenObject, { flat: { "constructor.prototype.polluted": 1 } });
    expectPrototypeUntouched();
    const out = JSON.parse(
      await call(unflattenObject, { flat: { "constructor.prototype.polluted": 1 } }),
    );
    expect(out.constructor).toEqual({ prototype: { polluted: 1 } });
  });

  test("the documented Flatten -> Unflatten round trip of a __proto__ key", async () => {
    const doc = JSON.parse('{"__proto__":{"polluted":"yes"},"b":1}');
    const flat = JSON.parse(await call(flattenObject, { json: JSON.stringify(doc) }));
    expect(Object.hasOwn(flat, "__proto__.polluted")).toBe(true);
    const back = await call(unflattenObject, { flat });
    expectPrototypeUntouched();
    expect(back).toBe('{"__proto__":{"polluted":"yes"},"b":1}');
  });

  test.each([
    ["a [__proto__] table", '[__proto__]\npolluted = "yes"\n'],
    ["a dotted key", 'a.__proto__.polluted = "yes"\n'],
    ["a quoted table name", '["__proto__"]\npolluted = "yes"\n'],
    ["a nested table", '[a.__proto__]\npolluted = "yes"\n'],
    ["an array of tables", '[[__proto__]]\npolluted = "yes"\n'],
    ["a top-level dotted key", '__proto__.polluted = "yes"\n'],
    ["an inline table", 'x = { __proto__ = { polluted = "yes" } }\n'],
  ])("DataConvert from TOML with %s", async (_label, toml) => {
    const out = await call(dataConvert, { text: toml, from: "toml", to: "json", indent: 0 });
    expectPrototypeUntouched();
    expect(out).toContain('"__proto__"');
    expect(out).toContain('"polluted":"yes"');
  });

  test("TableQuery select through a __proto__ field", async () => {
    const records = JSON.parse('[{"w":{"__proto__":{"polluted":"yes"}}}]');
    const out = JSON.parse(await call(tableQuery, { records, select: ["w.__proto__.polluted"] }));
    expectPrototypeUntouched();
    expect(Object.hasOwn(out.records[0].w, "__proto__")).toBe(true);
    expect(out.records[0].w.__proto__).toEqual({ polluted: "yes" });
  });

  test("TableQuery select of a field the record lacks creates nothing", async () => {
    const out = JSON.parse(
      await call(tableQuery, { records: [{ a: 1 }], select: ["__proto__.polluted"] }),
    );
    expectPrototypeUntouched();
    expect(out.records).toEqual([{}]);
  });

  test("TableQuery omit cannot delete an Object.prototype member", async () => {
    await call(tableQuery, { records: [{ a: 1 }], omit: ["__proto__.hasOwnProperty"] });
    await call(tableQuery, { records: [{ a: 1 }], omit: ["constructor.prototype.toString"] });
    expectPrototypeUntouched();
    expect(typeof Object.prototype.toString).toBe("function");
  });

  test("JsonPatch add /__proto__/polluted on a document without that member", async () => {
    const out = await call(jsonPatch, {
      json: '{"a":1}',
      patch: [{ op: "add", path: "/__proto__/polluted", value: "yes" }],
    });
    expectPrototypeUntouched();
    // The parent does not exist as data, so this is refused, not applied to
    // Object.prototype.
    expect(out).toMatch(/does not exist|no member/);
  });

  test("a later tool's optional argument is not supplied by a polluted prototype", async () => {
    // The cross-tool effect: a destructive tool's schema reads an absent
    // optional field through the prototype chain.
    await call(dataConvert, {
      text: "[__proto__]\noverwrite = true\n",
      from: "toml",
      to: "json",
    });
    const moveLike = z.object({ source: z.string(), overwrite: z.boolean().optional() });
    expect(moveLike.parse({ source: "a" }).overwrite).toBeUndefined();
    expectPrototypeUntouched();
  });
});

describe("keys named like prototype members round-trip as data", () => {
  test("XmlParse keeps a <constructor> element", async () => {
    const out = await call(xmlParse, {
      text: "<order><constructor>ACME Ltd</constructor></order>",
    });
    expect(out).toBe('{"order":{"constructor":"ACME Ltd"}}');
  });

  test("XmlParse keeps a <__proto__> element and a __proto__ attribute", async () => {
    const out = JSON.parse(
      await call(xmlParse, { text: '<o __proto__="a"><__proto__>x</__proto__><k>1</k></o>' }),
    );
    expectPrototypeUntouched();
    expect(Object.hasOwn(out.o, "__proto__")).toBe(true);
    expect(out.o.__proto__).toBe("x");
    expect(out.o["@__proto__"]).toBe("a");
    expect(out.o.k).toBe("1");
  });

  test("a TOML [constructor] table is a table, not 'already a value'", async () => {
    const out = JSON.parse(
      await call(dataConvert, { text: "[constructor]\nx = 1\n", from: "toml", to: "json" }),
    );
    expect(Object.hasOwn(out, "constructor")).toBe(true);
    expect(out.constructor).toEqual({ x: 1 });
  });

  test("CsvParse keeps a __proto__ column", async () => {
    const out = JSON.parse(await call(csvParse, { text: "__proto__,b\n1,2\n" }));
    expectPrototypeUntouched();
    expect(Object.hasOwn(out.records[0], "__proto__")).toBe(true);
    expect(out.records[0].__proto__).toBe("1");
    expect(out.records[0].b).toBe("2");
  });

  test("DataConvert YAML keeps a __proto__ key, block and flow", async () => {
    const block = JSON.parse(
      await call(dataConvert, { text: "__proto__:\n  polluted: yes\n", from: "yaml", to: "json" }),
    );
    const flow = JSON.parse(
      await call(dataConvert, { text: "a: {__proto__: 1}\n", from: "yaml", to: "json" }),
    );
    expectPrototypeUntouched();
    expect(Object.hasOwn(block, "__proto__")).toBe(true);
    expect(Object.hasOwn(flow.a, "__proto__")).toBe(true);
  });

  test("TableQuery 'exists constructor' does not match records without that field", async () => {
    const out = JSON.parse(
      await call(tableQuery, {
        records: [{ a: 1 }, { b: 2 }, { constructor: "set" }],
        where: { all: [{ field: "constructor", op: "exists" }] },
      }),
    );
    expect(out.matched).toBe(1);
  });

  test("JsonPatch add /__proto__ yields an own member, never a silent no-op", async () => {
    const out = await call(jsonPatch, {
      json: '{"a":1}',
      patch: [{ op: "add", path: "/__proto__", value: { x: 1 } }],
    });
    expectPrototypeUntouched();
    const doc = JSON.parse(out);
    expect(Object.hasOwn(doc, "__proto__")).toBe(true);
    expect(doc.__proto__).toEqual({ x: 1 });
  });

  test("JsonMergePatch keeps a __proto__ key", async () => {
    const out = await call(jsonMergePatch, { json: '{"a":1}', patch: '{"__proto__":{"x":1}}' });
    expectPrototypeUntouched();
    const doc = JSON.parse(out);
    expect(Object.hasOwn(doc, "__proto__")).toBe(true);
  });

  test("RecordsToColumns and TableAggregate keep a column or output named constructor", async () => {
    const cols = JSON.parse(
      await call(recordsToColumns, { records: [{ a: 1 }], columns: ["constructor", "a"] }),
    );
    expect(cols.columns.constructor).toEqual([null]);
    const agg = JSON.parse(
      await call(tableAggregate, {
        records: [{ g: "x", n: 1 }],
        groupBy: ["g"],
        aggregations: [{ as: "__proto__", fn: "sum", field: "n" }],
      }),
    );
    expectPrototypeUntouched();
    expect(Object.hasOwn(agg.groups[0], "__proto__")).toBe(true);
  });
});

describe("inherited members are misses, not matches", () => {
  test("a JsonQuery filter on @.constructor matches only records that have one", async () => {
    const out = JSON.parse(
      await call(jsonQuery, {
        json: JSON.stringify([{ a: 1 }, { constructor: "x" }]),
        path: "$[?(@.constructor)]",
      }),
    );
    expect(out.count).toBe(1);
  });
});

describe("getOwn / setOwn", () => {
  test("getOwn never returns an inherited member", () => {
    const o: Record<string, unknown> = { a: 1 };
    expect(getOwn(o, "a")).toBe(1);
    expect(getOwn(o, "constructor")).toBeUndefined();
    expect(getOwn(o, "__proto__")).toBeUndefined();
    expect(getOwn(o, "toString")).toBeUndefined();
  });

  test("setOwn stores __proto__ as an enumerable own field and leaves the prototype alone", () => {
    const o: Record<string, unknown> = {};
    setOwn(o, "__proto__", { polluted: 1 });
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect(Object.keys(o)).toEqual(["__proto__"]);
    expect(JSON.stringify(o)).toBe('{"__proto__":{"polluted":1}}');
    expect({ ...o }.__proto__).toEqual({ polluted: 1 });
    expectPrototypeUntouched();
  });
});
