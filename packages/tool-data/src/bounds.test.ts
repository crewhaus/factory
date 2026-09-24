/**
 * Cost follows the document's size, not its depth, and no result is larger
 * than a tool may return.
 *
 * 0.7.0 capped documents by characters only. A merge that re-cloned the tree
 * at every level, a query that copied its path array for every node it
 * visited, and pretty-printers that write depth x indent on every line made
 * a 48 KB document nested 8,000 deep cost gigabytes, and a record set, a
 * join or a TOML table header could repeat part of the input once per row.
 *
 * These tests count work where they can (property reads through a Proxy)
 * rather than time it, keep every input small enough that the 0.7.0 code
 * fails them in about a second rather than exhausting memory, and hold the
 * rewritten query, merge and YAML writer to the 0.7.0 algorithms, kept here
 * as oracles.
 */
import { describe, expect, test } from "bun:test";
import {
  csvParse,
  csvWrite,
  dataConvert,
  dataDiff,
  dataShape,
  flattenObject,
  jsonFormat,
  jsonMergePatch,
  jsonPatch,
  jsonQuery,
  jsonSortKeys,
  jsonlParse,
  tableJoin,
} from "./index";
import {
  MAX_NESTING_DEPTH,
  canonicalStringify,
  isPlainObject,
  jsonTextLength,
  jsonTextNestsDeeper,
} from "./lib/json";
import { type PathStep, parsePath, queryPath, renderPath, sliceIndices } from "./lib/jsonpath";
import { applyMergePatch } from "./lib/patch";
import { canWritePlain, stringifyYaml } from "./lib/yaml";

// biome-ignore lint/suspicious/noExplicitAny: the tools take their own parsed input.
type AnyTool = { execute: (input: any) => unknown; inputSchema: { parse: (v: unknown) => any } };
async function text(tool: AnyTool, input: unknown): Promise<string> {
  const out = await tool.execute(tool.inputSchema.parse(input));
  if (typeof out !== "string") throw new Error("expected a string result");
  return out;
}

/** A small deterministic PRNG, so a failing seed can be replayed. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const nested = (depth: number): string => `${"[".repeat(depth)}${"]".repeat(depth)}`;
const OUTPUT_REFUSAL =
  /would be more than 16000000 characters, the most one result may be, so nothing was built/;

describe("documents nested past the cap are refused at the door", () => {
  const cap = MAX_NESTING_DEPTH;

  test("every JSON-reading tool refuses one level past the cap and accepts the cap", async () => {
    const deep = nested(cap + 1);
    const ok = nested(cap);
    const calls: Array<[string, AnyTool, (doc: string) => Record<string, unknown>]> = [
      ["JsonQuery", jsonQuery, (doc) => ({ json: doc, path: "$..*", maxResults: 1 })],
      [
        "JsonPatch",
        jsonPatch,
        (doc) => ({ json: doc, patch: [{ op: "test", path: "", value: 1 }] }),
      ],
      ["JsonMergePatch json", jsonMergePatch, (doc) => ({ json: doc, patch: "{}" })],
      ["JsonMergePatch patch", jsonMergePatch, (doc) => ({ json: "{}", patch: doc })],
      ["JsonFormat", jsonFormat, (doc) => ({ json: doc, indent: 0 })],
      ["JsonSortKeys", jsonSortKeys, (doc) => ({ json: doc, indent: 0 })],
      [
        "DataConvert json",
        dataConvert,
        (doc) => ({ text: doc, from: "json", to: "json", indent: 0 }),
      ],
      [
        "DataConvert jsonl",
        dataConvert,
        (doc) => ({ text: doc, from: "jsonl", to: "json", indent: 0 }),
      ],
      ["FlattenObject", flattenObject, (doc) => ({ json: doc })],
      ["DataShape", dataShape, (doc) => ({ json: doc })],
      ["DataDiff", dataDiff, (doc) => ({ before: doc, after: "1" })],
    ];
    let checked = 0;
    for (const [name, tool, input] of calls) {
      // 0.7.0 accepted any depth JSON.parse did (a million levels).
      expect({ name, out: (await text(tool, input(deep))).slice(0, 200) }).toEqual({
        name,
        out: expect.stringMatching(/nests deeper than 256 levels/),
      });
      expect({ name, refused: /nests deeper/.test(await text(tool, input(ok))) }).toEqual({
        name,
        refused: false,
      });
      checked += 1;
    }
    expect(checked).toBe(calls.length);
  });

  test("TOML nested by dotted keys and JSONL lines are held to the same cap", async () => {
    const dotted = (n: number) => `${Array.from({ length: n }, () => "a").join(".")} = 1`;
    expect(await text(dataConvert, { text: dotted(cap + 1), from: "toml", to: "json" })).toMatch(
      /toml nests deeper than 256 levels/,
    );
    expect(
      await text(dataConvert, { text: dotted(cap), from: "toml", to: "json", indent: 0 }),
    ).toMatch(/^\{"a":/);
    const jsonl = await text(jsonlParse, { text: `1\n${nested(cap + 1)}\n2\n` });
    const parsed = JSON.parse(jsonl);
    expect(parsed.records).toEqual([1, 2]);
    expect(parsed.failures).toEqual([
      { line: 2, error: "nests deeper than 256 levels", preview: expect.any(String) },
    ]);
  });

  test("a JsonPatch value nested past the cap is refused", async () => {
    let value: unknown = 1;
    for (let i = 0; i < cap + 1; i++) value = [value];
    expect(await text(jsonPatch, { json: "{}", patch: [{ op: "add", path: "/x", value }] })).toBe(
      "operation 0 (add): its value nests deeper than 256 levels",
    );
  });

  test("brackets inside strings are not nesting, and a million levels is a refusal, not a stack overflow", async () => {
    const inString = JSON.stringify({ s: "[{".repeat(10_000) });
    expect(jsonTextNestsDeeper(inString, cap)).toBe(false);
    expect(jsonTextNestsDeeper('["\\\\", "\\"[[["]', 1)).toBe(false);
    expect(JSON.parse(await text(jsonQuery, { json: inString, path: "$.s" })).count).toBe(1);
    expect(await text(jsonQuery, { json: nested(1_000_000), path: "$" })).toMatch(/nests deeper/);
  }, 20_000);
});

describe("merge patch builds each node once", () => {
  const chain = (depth: number, leaf: unknown): unknown => {
    let v = leaf;
    for (let i = 0; i < depth; i++) v = { a: v };
    return v;
  };

  test("a deep merge clones each node of the target once, not once per level above it", () => {
    // Work is counted as Object.keys calls: the clone and the merge each take
    // an object's keys once per object they build. 0.7.0 deep-cloned the
    // target and then recursed into the clone, re-cloning the rest of the
    // tree at every level: here about depth x leaf = 400,000 calls.
    const depth = 200;
    const leafKeys = 2_000;
    const leaf: Record<string, unknown> = {};
    for (let i = 0; i < leafKeys; i++) leaf[`k${i}`] = {};
    const target = chain(depth, leaf);
    const patch = chain(depth, { k0: { changed: true } });
    const keys = Object.keys;
    let calls = 0;
    Object.keys = ((o: object) => {
      calls += 1;
      return keys(o);
    }) as typeof Object.keys;
    let out: unknown;
    try {
      out = applyMergePatch(target, patch);
    } finally {
      Object.keys = keys;
    }
    expect(calls).toBeLessThanOrEqual(3 * (depth + leafKeys));
    let cur = out as Record<string, unknown>;
    for (let i = 0; i < depth; i++) cur = cur["a"] as Record<string, unknown>;
    expect(keys(cur)).toHaveLength(leafKeys);
    expect(cur["k0"]).toEqual({ changed: true });
  }, 20_000);

  test("RFC 7386 Appendix A, key order, and a result that shares nothing with its inputs", () => {
    const vectors: Array<[unknown, unknown, unknown]> = [
      [{ a: "b" }, { a: "c" }, { a: "c" }],
      [{ a: "b" }, { b: "c" }, { a: "b", b: "c" }],
      [{ a: "b" }, { a: null }, {}],
      [{ a: "b", b: "c" }, { a: null }, { b: "c" }],
      [{ a: ["b"] }, { a: "c" }, { a: "c" }],
      [{ a: "c" }, { a: ["b"] }, { a: ["b"] }],
      [{ a: { b: "c" } }, { a: { b: "d", c: null } }, { a: { b: "d" } }],
      [{ a: [{ b: "c" }] }, { a: [1] }, { a: [1] }],
      [
        ["a", "b"],
        ["c", "d"],
        ["c", "d"],
      ],
      [{ a: "b" }, ["c"], ["c"]],
      [{ a: "foo" }, null, null],
      [{ a: "foo" }, "bar", "bar"],
      [{ e: null }, { a: 1 }, { e: null, a: 1 }],
      [[1, 2], { a: "b", c: null }, { a: "b" }],
      [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
    ];
    for (const [target, patch, want] of vectors) {
      expect({ target, patch, got: applyMergePatch(target, patch) }).toEqual({
        target,
        patch,
        got: want,
      });
    }
    expect(JSON.stringify(applyMergePatch({ x: 1, y: 2, z: 3 }, { y: 9, w: 0, x: null }))).toBe(
      '{"y":9,"z":3,"w":0}',
    );
    const target = { keep: { deep: [1] }, change: { n: 1 } };
    const patch = { change: { n: 2 }, add: { m: [3] } };
    const before = JSON.stringify([target, patch]);
    const out = applyMergePatch(target, patch) as Record<string, Record<string, unknown[]>>;
    (out["keep"]?.["deep"] as unknown[]).push(99);
    (out["add"]?.["m"] as unknown[]).push(99);
    expect(JSON.stringify([target, patch])).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The query walk.

/** The 0.7.0 evaluation, minus its intermediate cut: every node, breadth by step. */
function oracleQuery(root: unknown, steps: ReadonlyArray<PathStep>): Array<[string, unknown]> {
  type N = { path: Array<string | number>; value: unknown };
  const walk = (node: N, visit: (n: N) => void): void => {
    visit(node);
    const v = node.value;
    if (Array.isArray(v)) v.forEach((el, i) => walk({ path: [...node.path, i], value: el }, visit));
    else if (isPlainObject(v))
      for (const k of Object.keys(v)) walk({ path: [...node.path, k], value: v[k] }, visit);
  };
  let nodes: N[] = [{ path: [], value: root }];
  for (const step of steps) {
    const next: N[] = [];
    for (const node of nodes) {
      const v = node.value;
      if (step.kind === "child") {
        if (isPlainObject(v) && Object.hasOwn(v, step.name))
          next.push({ path: [...node.path, step.name], value: v[step.name] });
      } else if (step.kind === "wildcard") {
        if (Array.isArray(v))
          v.forEach((el, i) => next.push({ path: [...node.path, i], value: el }));
        else if (isPlainObject(v))
          for (const k of Object.keys(v)) next.push({ path: [...node.path, k], value: v[k] });
      } else if (step.kind === "descend") {
        const name = step.name;
        walk(node, (n) => {
          if (name === null) {
            if (n.path.length !== node.path.length) next.push(n);
          } else if (isPlainObject(n.value) && Object.hasOwn(n.value, name)) {
            next.push({ path: [...n.path, name], value: n.value[name] });
          }
        });
      } else if (step.kind === "index") {
        if (!Array.isArray(v)) continue;
        const i = step.index < 0 ? v.length + step.index : step.index;
        if (i >= 0 && i < v.length) next.push({ path: [...node.path, i], value: v[i] });
      } else if (step.kind === "slice") {
        if (!Array.isArray(v)) continue;
        for (const i of sliceIndices(v.length, step.start, step.end, step.step))
          next.push({ path: [...node.path, i], value: v[i] });
      }
    }
    nodes = next;
  }
  return nodes.map((n) => [renderPath(n.path), n.value]);
}

function randomDoc(rand: () => number, depth: number): unknown {
  const r = rand();
  if (depth > 3 || r < 0.25) return [1, "x", null, true][Math.floor(rand() * 4)];
  if (r < 0.6)
    return Array.from({ length: Math.floor(rand() * 4) }, () => randomDoc(rand, depth + 1));
  const out: Record<string, unknown> = {};
  for (const k of ["a", "b", "c"].slice(0, 1 + Math.floor(rand() * 3)))
    out[k] = randomDoc(rand, depth + 1);
  return out;
}

describe("the query walks lazily and stops at what it needs", () => {
  test("a match past the first twenty times maxResults is found, not silently dropped", async () => {
    const records = Array.from({ length: 30 }, (_, i) => (i === 29 ? { b: "found" } : { a: i }));
    const out = JSON.parse(
      await text(jsonQuery, { json: JSON.stringify(records), path: "$[*].b", maxResults: 1 }),
    );
    // 0.7.0: count 0, truncated false — the step before cut the list at 20.
    expect(out).toEqual({
      count: 1,
      truncated: false,
      matches: [{ path: "$[29].b", value: "found" }],
    });
  });

  test("$..* with maxResults 1 reads a handful of elements, not the document", () => {
    let reads = 0;
    const big = new Proxy(
      Array.from({ length: 100_000 }, (_, i) => i),
      {
        get(target, key) {
          if (typeof key === "string" && /^\d+$/.test(key)) reads += 1;
          return Reflect.get(target, key);
        },
      },
    );
    const result = queryPath({ big }, parsePath("$..*"), 1);
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
    // 0.7.0 visited (and copied a path for) all 100,000.
    expect(reads).toBeLessThan(10);
  });

  test("a query that would walk the document once per node stops at the visit budget and says so", async () => {
    const doc: unknown[] = [];
    let cur = doc;
    for (let i = 0; i < 60; i++) {
      const next: unknown[] = [];
      cur.push(next, ...Array.from({ length: 20 }, () => 0));
      cur = next;
    }
    const result = queryPath(doc, parsePath("$..*..*..nothing"), 10, 50_000);
    expect({ truncated: result.truncated, stoppedAtVisits: result.stoppedAtVisits }).toEqual({
      truncated: true,
      stoppedAtVisits: 50_000,
    });
    const tool = JSON.parse(
      await text(jsonQuery, { json: JSON.stringify([[1]]), path: "$..*", maxResults: 1 }),
    );
    expect(tool.truncatedBy).toBe("maxResults");
  });

  test("matches, paths and order are the 0.7.0 walk's, on random documents and paths", () => {
    const paths = [
      "$..*",
      "$..a",
      "$.*",
      "$[*]",
      "$..b.*",
      "$.a..c",
      "$[0]",
      "$[-1]",
      "$[1:]",
      "$[::-1]",
      "$.*.*",
      "$..a..b",
      "$..*..c",
      "$.a[*].b",
    ];
    let compared = 0;
    let nonEmpty = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const doc = randomDoc(prng(seed), 0);
      for (const expr of paths) {
        const want = oracleQuery(doc, parsePath(expr));
        const got = queryPath(doc, parsePath(expr), 10_000);
        expect({ seed, expr, got: got.matches.map((m) => [m.path, m.value]) }).toEqual({
          seed,
          expr,
          got: want,
        });
        const capped = queryPath(doc, parsePath(expr), 3);
        expect({
          seed,
          expr,
          got: capped.matches.map((m) => [m.path, m.value]),
          t: capped.truncated,
        }).toEqual({
          seed,
          expr,
          got: want.slice(0, 3),
          t: want.length > 3,
        });
        compared += 1;
        if (want.length > 0) nonEmpty += 1;
      }
    }
    expect(compared).toBe(400 * paths.length);
    expect(nonEmpty).toBeGreaterThan(2_000);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Output ceilings.

describe("a result too large to return is refused before it is built", () => {
  test("pretty-printing many deep chains is refused, and indent 0 still works", async () => {
    // Forty 256-deep chains: 20 KB of input, 21 M characters at indent 8.
    const doc = `[${Array.from({ length: 40 }, () => `${"[".repeat(255)}0${"]".repeat(255)}`).join(",")}]`;
    for (const tool of [jsonFormat, jsonSortKeys] as AnyTool[]) {
      expect(await text(tool, { json: doc, indent: 8 })).toMatch(OUTPUT_REFUSAL);
      expect(await text(tool, { json: doc, indent: 0 })).toBe(doc);
    }
    expect(await text(dataConvert, { text: doc, from: "json", to: "json", indent: 8 })).toMatch(
      OUTPUT_REFUSAL,
    );
  }, 20_000);

  test("CSV column names repeated into every record are measured before the records are serialized", async () => {
    // 200 columns named with 1,000 characters each, and 100 rows of empty
    // cells: 220 KB of CSV, 20 M characters as records.
    const header = Array.from(
      { length: 200 },
      (_, i) => `${String(i).padStart(4, "0")}${"k".repeat(996)}`,
    ).join(",");
    const csv = `${header}\n${`${",".repeat(199)}\n`.repeat(100)}`;
    expect(await text(csvParse, { text: csv })).toMatch(OUTPUT_REFUSAL);
    for (const to of ["json", "jsonl", "yaml"]) {
      expect({
        to,
        out: (await text(dataConvert, { text: csv, from: "csv", to, indent: 0 })).slice(0, 300),
      }).toEqual({
        to,
        out: expect.stringMatching(OUTPUT_REFUSAL),
      });
    }
    // Back out as CSV it is its own size again, and allowed.
    expect((await text(dataConvert, { text: csv, from: "csv", to: "csv" })).length).toBe(
      csv.length - 1,
    );
  }, 20_000);

  test("records with distinct keys are refused as CSV before the rows x columns grid is built", async () => {
    // 4,500 one-key records: 60 KB of JSON, a 20 M-cell grid as CSV.
    const records = Array.from({ length: 4_500 }, (_, i) => ({ [`k${i}`]: 1 }));
    expect(
      await text(dataConvert, { text: JSON.stringify(records), from: "json", to: "csv" }),
    ).toMatch(/^4500 rows of 4500 columns as CSV would be more than 16000000 characters/);
    expect(await text(csvWrite, { records })).toMatch(/^4500 rows of 4500 columns as CSV/);
    // The writer's own count holds without that check: rows arrive lazily.
    const wide = Array.from({ length: 1_000 }, () =>
      Object.fromEntries(Array.from({ length: 50 }, (_, j) => [`c${j}`, "v".repeat(400)])),
    );
    expect(await text(csvWrite, { records: wide })).toMatch(/^the CSV would be more than 16000000/);
  }, 20_000);

  test("YAML and TOML repeat the indentation or the table path per line, and are measured as written", async () => {
    let yamlDoc: unknown = { leaf: Array.from({ length: 130_000 }, () => 0) };
    for (let i = 0; i < 63; i++) yamlDoc = { a: yamlDoc };
    expect(
      await text(dataConvert, { text: JSON.stringify(yamlDoc), from: "json", to: "yaml" }),
    ).toMatch(OUTPUT_REFUSAL);
    let tomlDoc: unknown = { x: Array.from({ length: 50_000 }, () => ({})) };
    for (let i = 0; i < 200; i++) tomlDoc = { aa: tomlDoc };
    expect(
      await text(dataConvert, { text: JSON.stringify(tomlDoc), from: "json", to: "toml" }),
    ).toMatch(OUTPUT_REFUSAL);
  }, 20_000);

  test("flattened keys spell their whole path, and are stopped at the budget before they are all built", async () => {
    // 31 levels over 300,000 leaves: 700 KB of JSON, 20 M characters of keys.
    let doc: unknown = Array.from({ length: 300_000 }, () => 0);
    for (let i = 0; i < 31; i++) doc = { a: doc };
    const out = await text(flattenObject, { json: JSON.stringify(doc) });
    expect(out).toMatch(/^the flattened keys would be more than 16000000 characters/);
    expect(await text(flattenObject, { json: JSON.stringify(doc), expandArrays: false })).toMatch(
      /^\{"a\.a/,
    );
  }, 20_000);

  test("a join that repeats a large matched row per partner is refused", async () => {
    const out = await text(tableJoin, {
      left: Array.from({ length: 200 }, () => ({ id: 1 })),
      right: [{ id: 1, big: "x".repeat(100_000) }],
      leftKey: "id",
    });
    expect(out).toMatch(OUTPUT_REFUSAL);
  }, 20_000);

  test("JsonPatch stops a patch that keeps copying the document into itself", async () => {
    const patch = Array.from({ length: 20 }, (_, i) => ({ op: "copy", from: "", path: `/c${i}` }));
    // 0.7.0 doubled the document twenty times: 13.6 M characters from seven.
    expect(await text(jsonPatch, { json: '{"a":1}', patch })).toMatch(
      /^patch failed at operation 1\d: the patch would add more than 2000000 values/,
    );
  }, 20_000);

  test("JsonQuery returns the matches that fit and says the output limit cut it", async () => {
    // A 1 M-character string twenty levels down: `$..*` returns it once per
    // ancestor, so 1 MB of input asks for 20 M characters of matches.
    const doc = `${"[".repeat(20)}"${"y".repeat(1_000_000)}"${"]".repeat(20)}`;
    const out = JSON.parse(await text(jsonQuery, { json: doc, path: "$..*", valuesOnly: true }));
    expect({ count: out.count, truncated: out.truncated, truncatedBy: out.truncatedBy }).toEqual({
      count: 15,
      truncated: true,
      truncatedBy: "outputChars",
    });
  }, 20_000);
});

describe("the measurers agree with what they measure", () => {
  test("jsonTextLength is JSON.stringify's length, at every indent", () => {
    const rand = prng(99);
    const value = (depth: number): unknown => {
      const r = rand();
      if (depth > 4 || r < 0.3) {
        return [null, true, false, 0, -0, 1.5e21, Number.NaN, "", 'q"\n\u0001é', undefined][
          Math.floor(rand() * 10)
        ];
      }
      if (r < 0.65) return Array.from({ length: Math.floor(rand() * 4) }, () => value(depth + 1));
      const o: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(rand() * 4); i++) o[`k"${i}`] = value(depth + 1);
      return o;
    };
    let compared = 0;
    for (let i = 0; i < 3_000; i++) {
      const v = value(0);
      for (const indent of [0, 1, 2, 8]) {
        expect({ i, indent, n: jsonTextLength(v, indent, 1e12) }).toEqual({
          i,
          indent,
          n: (JSON.stringify(v, null, indent) ?? "").length,
        });
        compared += 1;
      }
    }
    expect(compared).toBe(12_000);
  }, 20_000);

  test("the YAML writer writes 0.7.0's bytes", () => {
    const writeScalar = (v: unknown): string => {
      if (v === null || v === undefined) return "null";
      if (typeof v === "boolean") return String(v);
      if (typeof v === "number") {
        if (!Number.isFinite(v)) return v > 0 ? ".inf" : Number.isNaN(v) ? ".nan" : "-.inf";
        return String(v);
      }
      const s = String(v);
      return canWritePlain(s) ? s : JSON.stringify(s);
    };
    const old = (value: unknown, level = 0): string => {
      const pad = "  ".repeat(level);
      if (Array.isArray(value)) {
        if (value.length === 0) return `${pad}[]`;
        return value
          .map((el) =>
            (isPlainObject(el) && Object.keys(el).length > 0) ||
            (Array.isArray(el) && el.length > 0)
              ? `${pad}-${old(el, level + 1).slice(pad.length + 1)}`
              : `${pad}- ${writeScalar(el)}`,
          )
          .join("\n");
      }
      if (isPlainObject(value)) {
        const keys = Object.keys(value);
        if (keys.length === 0) return `${pad}{}`;
        return keys
          .map((k) => {
            const v = value[k];
            const key = canWritePlain(k) ? k : JSON.stringify(k);
            if (Array.isArray(v))
              return v.length === 0 ? `${pad}${key}: []` : `${pad}${key}:\n${old(v, level + 1)}`;
            if (isPlainObject(v))
              return Object.keys(v).length === 0
                ? `${pad}${key}: {}`
                : `${pad}${key}:\n${old(v, level + 1)}`;
            return `${pad}${key}: ${writeScalar(v)}`;
          })
          .join("\n");
      }
      return `${pad}${writeScalar(value)}`;
    };
    const rand = prng(5);
    const value = (depth: number): unknown => {
      const r = rand();
      if (depth > 5 || r < 0.3)
        return [null, true, 3.5, "a b", "", "x: y", "-1", Number.NaN][Math.floor(rand() * 8)];
      if (r < 0.65) return Array.from({ length: Math.floor(rand() * 4) }, () => value(depth + 1));
      const o: Record<string, unknown> = {};
      for (let i = 0; i < Math.floor(rand() * 4); i++)
        o[["a", "b c", "", "#k", "1"][Math.floor(rand() * 5)] + i] = value(depth + 1);
      return o;
    };
    let compared = 0;
    for (let i = 0; i < 5_000; i++) {
      const v = value(0);
      for (const level of [0, 2]) {
        expect({ i, level, yaml: stringifyYaml(v, level) }).toEqual({
          i,
          level,
          yaml: old(v, level),
        });
        compared += 1;
      }
    }
    expect(compared).toBe(10_000);
  }, 20_000);
});
