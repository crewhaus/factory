/**
 * The pure core. Every function is tested directly, because a bug in the
 * CSV quote handling or the slice arithmetic reads better as a failing unit
 * than as a failing tool call.
 */
import { describe, expect, test } from "bun:test";
import {
  CsvError,
  cellToString,
  escapeCsvField,
  inferScalar,
  normalizeHeader,
  parseCsv,
  rowsToRecords,
  unionKeys,
  writeCsvRows,
} from "./lib/csv";
import { deepDiff } from "./lib/diff";
import {
  canonicalStringify,
  deepClone,
  deepEqual,
  fnv1a64,
  isPlainObject,
  parseJson,
  sortKeysDeep,
  stableHash,
  typeOf,
} from "./lib/json";
import { parseJsonl, writeJsonl } from "./lib/jsonl";
import { PathError, parsePath, queryPath, renderPath, sliceIndices } from "./lib/jsonpath";
import {
  PatchError,
  applyJsonPatch,
  applyMergePatch,
  diffMergePatch,
  escapeToken,
  formatPointer,
  parsePointer,
  resolvePointer,
  unescapeToken,
} from "./lib/patch";
import {
  TYPE_ORDER,
  aggregate,
  columnsToRecords,
  compareValues,
  dedupeRecords,
  flattenObject,
  getPath,
  joinRecords,
  omitFields,
  recordsToColumns,
  sampleRecords,
  selectFields,
  setPath,
  sortRecords,
  testCondition,
  testPredicate,
  totalCompare,
  unflattenObject,
} from "./lib/table";
import { TomlError, parseToml, scalarFromToken, stringifyToml } from "./lib/toml";
import { XmlError, decodeEntities, isElement, parseXml, textContent, toCompact } from "./lib/xml";
import {
  YamlError,
  canWritePlain,
  findKeyColon,
  parseFlow,
  parseYaml,
  plainScalar,
  stringifyYaml,
  stripComment,
} from "./lib/yaml";

const CSV_DEFAULTS = {
  delimiter: ",",
  quote: '"',
  skipEmptyLines: true,
  trim: false,
  maxRows: 1000,
};

describe("json primitives", () => {
  test("isPlainObject separates objects from arrays and null", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });

  test("deepEqual ignores key order but not array order", () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });

  test("deepEqual distinguishes a missing key from an undefined one", () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });

  test("deepClone copies nested structures rather than sharing them", () => {
    const source = { a: { b: [1, 2] } };
    const copy = deepClone(source);
    copy.a.b.push(3);
    expect(source.a.b).toEqual([1, 2]);
  });

  test("canonicalStringify sorts keys at every depth", () => {
    expect(canonicalStringify({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  test("canonicalStringify leaves array order alone, because order is data", () => {
    expect(canonicalStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  test("sortKeysDeep returns a value, not text", () => {
    expect(sortKeysDeep({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 });
  });

  test("stableHash is equal for equal values regardless of key order", () => {
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });

  test("stableHash differs for different values and is 16 hex characters", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
    expect(stableHash("x")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("fnv1a64 matches the published FNV-1a 64-bit vectors", () => {
    // Fowler/Noll/Vo reference values. These are the whole point of naming
    // the algorithm: if the implementation drifts, these stop matching.
    expect(fnv1a64("")).toBe("cbf29ce484222325");
    expect(fnv1a64("a")).toBe("af63dc4c8601ec8c");
    expect(fnv1a64("b")).toBe("af63df4c8601f1a5");
    expect(fnv1a64("foobar")).toBe("85944171f73967e8");
  });

  test("fnv1a64 folds the UTF-8 encoding, not the UTF-16 code units", () => {
    // "é" is U+00E9, which is the two bytes C3 A9 in UTF-8. Hashing the code
    // unit 0x00E9, or its low byte 0xE9, would give something else entirely;
    // both expectations below are the reference algorithm run over the bytes.
    expect(fnv1a64("é")).toBe("0ac21707b7181e01");
    expect(fnv1a64("é")).not.toBe(fnv1a64("\u00a9"));
  });

  test("stableHash is fnv1a64 of the canonical text, whatever the key order", () => {
    expect(stableHash({ b: 2, a: 1 })).toBe("a0ebc03bdc71de7b");
    expect(stableHash({ b: 2, a: 1 })).toBe(fnv1a64('{"a":1,"b":2}'));
  });

  test("parseJson reports the parser's message instead of throwing", () => {
    const bad = parseJson("{oops");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.length).toBeGreaterThan(0);
  });

  test("typeOf names null and array distinctly", () => {
    expect(typeOf(null)).toBe("null");
    expect(typeOf([])).toBe("array");
    expect(typeOf(1)).toBe("number");
  });
});

describe("jsonpath parsing", () => {
  test("a leading $ is optional", () => {
    expect(parsePath("$.a")).toEqual(parsePath("a"));
  });

  test("dotted, bracketed and quoted keys all reach the same node", () => {
    const doc = { a: { "odd key": 1 } };
    for (const expr of ['$.a["odd key"]', "$.a['odd key']", "a['odd key']"]) {
      expect(queryPath(doc, parsePath(expr), 10).matches[0]?.value).toBe(1);
    }
  });

  test("negative indexes count from the end", () => {
    expect(queryPath([1, 2, 3], parsePath("$[-1]"), 10).matches[0]?.value).toBe(3);
  });

  test("slices follow Python semantics, including a negative step", () => {
    expect(sliceIndices(5, null, null, 1)).toEqual([0, 1, 2, 3, 4]);
    expect(sliceIndices(5, 1, 3, 1)).toEqual([1, 2]);
    expect(sliceIndices(5, -2, null, 1)).toEqual([3, 4]);
    expect(sliceIndices(5, null, null, -1)).toEqual([4, 3, 2, 1, 0]);
    expect(sliceIndices(5, null, null, 2)).toEqual([0, 2, 4]);
  });

  test("a wildcard walks arrays and object values alike", () => {
    expect(queryPath([1, 2], parsePath("$[*]"), 10).matches.map((m) => m.value)).toEqual([1, 2]);
    expect(queryPath({ a: 1, b: 2 }, parsePath("$.*"), 10).matches.map((m) => m.value)).toEqual([
      1, 2,
    ]);
  });

  test("recursive descent finds a name at any depth, in document order", () => {
    const doc = { a: { name: "x", b: { name: "y" } }, name: "z" };
    expect(queryPath(doc, parsePath("$..name"), 10).matches.map((m) => m.value)).toEqual([
      "z",
      "x",
      "y",
    ]);
  });

  test("$..* visits every descendant but not the root", () => {
    const out = queryPath({ a: [1] }, parsePath("$..*"), 20).matches;
    expect(out.map((m) => m.path)).toEqual(["$.a", "$.a[0]"]);
  });

  test("a filter compares numbers", () => {
    const doc = [{ n: 1 }, { n: 5 }];
    expect(queryPath(doc, parsePath("$[?(@.n > 2)]"), 10).matches[0]?.value).toEqual({ n: 5 });
  });

  test("a filter compares strings and supports a regex", () => {
    const doc = [{ s: "alpha" }, { s: "beta" }];
    expect(queryPath(doc, parsePath("$[?(@.s == 'beta')]"), 10).matches.length).toBe(1);
    expect(queryPath(doc, parsePath("$[?(@.s =~ '^al')]"), 10).matches.length).toBe(1);
  });

  test("a filter with no operator is an existence test", () => {
    const doc = [{ a: 1 }, { b: 2 }, { a: null }];
    expect(queryPath(doc, parsePath("$[?(@.a)]"), 10).matches.length).toBe(1);
  });

  test("a filter reaches a nested field", () => {
    const doc = [{ u: { age: 40 } }, { u: { age: 10 } }];
    expect(queryPath(doc, parsePath("$[?(@.u.age >= 18)]"), 10).matches.length).toBe(1);
  });

  test("comparing a number against a string never silently succeeds", () => {
    const doc = [{ n: "10" }];
    expect(queryPath(doc, parsePath("$[?(@.n > 9)]"), 10).matches.length).toBe(0);
  });

  test("a missing key yields no match rather than undefined", () => {
    expect(queryPath({ a: 1 }, parsePath("$.b"), 10).matches).toEqual([]);
  });

  test("maxResults truncates and says so", () => {
    const out = queryPath([1, 2, 3, 4], parsePath("$[*]"), 2);
    expect(out.matches.length).toBe(2);
    expect(out.truncated).toBe(true);
  });

  test("an unsupported construct is a parse error, not an empty result", () => {
    expect(() => parsePath("$.a[")).toThrow(PathError);
    expect(() => parsePath("$.")).toThrow(PathError);
    expect(() => parsePath("$.a[1:2:0]")).toThrow(PathError);
    expect(() => parsePath("$[?(@.a &&)]")).toThrow(PathError);
  });

  test("the error names the position, so a long path is debuggable", () => {
    expect(() => parsePath("$.users[?(@.age ~~ 3)]")).toThrow(/position/);
  });

  test("renderPath produces something parsePath accepts back", () => {
    const rendered = renderPath(["a", 0, "odd key"]);
    expect(rendered).toBe('$.a[0]["odd key"]');
    expect(queryPath({ a: [{ "odd key": 7 }] }, parsePath(rendered), 5).matches[0]?.value).toBe(7);
  });

  test("an object key that looks numeric is bracketed as a string, not an index", () => {
    // `$[0]` only ever matches an array, so rendering the object key "0" that
    // way would hand back a path that reaches nothing.
    expect(renderPath(["0", "x"])).toBe('$["0"].x');
    expect(renderPath([0, "x"])).toBe("$[0].x");
  });

  test("every reported path leads back to the value it reported", () => {
    const doc = { "0": { x: 1 }, list: [{ x: 2 }] };
    const found = queryPath(doc, parsePath("$..x"), 10).matches;
    expect(found.map((m) => m.path)).toEqual(['$["0"].x', "$.list[0].x"]);
    for (const m of found) {
      expect(queryPath(doc, parsePath(m.path), 5).matches[0]?.value).toBe(m.value);
    }
  });
});

describe("json pointer", () => {
  test("reference tokens round-trip through escaping", () => {
    expect(escapeToken("a/b~c")).toBe("a~1b~0c");
    expect(unescapeToken("a~1b~0c")).toBe("a/b~c");
  });

  test("the empty pointer is the whole document", () => {
    expect(parsePointer("")).toEqual([]);
    expect(resolvePointer({ a: 1 }, "")).toEqual({ found: true, value: { a: 1 } });
  });

  test("a pointer that does not start with / is rejected", () => {
    expect(resolvePointer({}, "a").found).toBe(false);
  });

  test("formatPointer is the inverse of parsePointer", () => {
    expect(formatPointer(["a", "b/c"])).toBe("/a/b~1c");
    expect(parsePointer("/a/b~1c")).toEqual(["a", "b/c"]);
  });

  test("a miss explains itself instead of throwing", () => {
    const out = resolvePointer({ a: [1] }, "/a/9");
    expect(out.found).toBe(false);
    if (!out.found) expect(out.reason).toContain("past the end");
  });

  test("a non-numeric array token is reported as such", () => {
    const out = resolvePointer({ a: [1] }, "/a/x");
    expect(out.found).toBe(false);
    if (!out.found) expect(out.reason).toContain("not an array index");
  });
});

describe("json patch (RFC 6902)", () => {
  test("add inserts into an object and an array", () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: "add", path: "/b", value: 2 }])).toEqual({ a: 1, b: 2 });
    expect(applyJsonPatch([1, 3], [{ op: "add", path: "/1", value: 2 }])).toEqual([1, 2, 3]);
  });

  test("add with '-' appends", () => {
    expect(applyJsonPatch([1], [{ op: "add", path: "/-", value: 2 }])).toEqual([1, 2]);
  });

  test("remove deletes a member and an element", () => {
    expect(applyJsonPatch({ a: 1, b: 2 }, [{ op: "remove", path: "/a" }])).toEqual({ b: 2 });
    expect(applyJsonPatch([1, 2, 3], [{ op: "remove", path: "/1" }])).toEqual([1, 3]);
  });

  test("replace requires the target to exist", () => {
    expect(() => applyJsonPatch({}, [{ op: "replace", path: "/a", value: 1 }])).toThrow(PatchError);
  });

  test("move relocates and copy duplicates", () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: "move", from: "/a", path: "/b" }])).toEqual({ b: 1 });
    expect(applyJsonPatch({ a: 1 }, [{ op: "copy", from: "/a", path: "/b" }])).toEqual({
      a: 1,
      b: 1,
    });
  });

  test("a move onto itself is a no-op, but only if the source exists", () => {
    // RFC 6902 §4.4 requires "from" to exist for the operation to succeed;
    // the paths being equal does not excuse it.
    expect(applyJsonPatch({ a: 1 }, [{ op: "move", from: "/a", path: "/a" }])).toEqual({ a: 1 });
    expect(() => applyJsonPatch({ a: 1 }, [{ op: "move", from: "/nope", path: "/nope" }])).toThrow(
      PatchError,
    );
  });

  test("moving a node into its own child is refused", () => {
    expect(() =>
      applyJsonPatch({ a: { b: {} } }, [{ op: "move", from: "/a", path: "/a/b/c" }]),
    ).toThrow(/own child/);
  });

  test("test passes on a deep match and fails otherwise", () => {
    expect(applyJsonPatch({ a: [1] }, [{ op: "test", path: "/a", value: [1] }])).toEqual({
      a: [1],
    });
    expect(() => applyJsonPatch({ a: 1 }, [{ op: "test", path: "/a", value: 2 }])).toThrow(
      /test failed/,
    );
  });

  test("a failure names the operation index and leaves the input untouched", () => {
    const doc = { a: 1 };
    try {
      applyJsonPatch(doc, [
        { op: "add", path: "/b", value: 2 },
        { op: "remove", path: "/zzz" },
      ]);
      throw new Error("expected a PatchError");
    } catch (err) {
      expect(err).toBeInstanceOf(PatchError);
      expect((err as PatchError).opIndex).toBe(1);
    }
    expect(doc).toEqual({ a: 1 });
  });

  test("a successful patch does not mutate the input either", () => {
    const doc = { a: { b: 1 } };
    applyJsonPatch(doc, [{ op: "replace", path: "/a/b", value: 9 }]);
    expect(doc).toEqual({ a: { b: 1 } });
  });

  test("the root can be replaced", () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: "replace", path: "", value: [1] }])).toEqual([1]);
  });

  test("a malformed pointer is a PatchError with its op index, not a bare Error", () => {
    // "a" is not a JSON Pointer — it has to be empty or start with "/".
    // Letting parsePointer's own Error out would crash the tool instead of
    // telling the caller which operation was wrong.
    try {
      applyJsonPatch({}, [
        { op: "add", path: "/ok", value: 1 },
        { op: "add", path: "a", value: 1 },
      ]);
      throw new Error("expected a PatchError");
    } catch (err) {
      expect(err).toBeInstanceOf(PatchError);
      expect((err as PatchError).opIndex).toBe(1);
      expect((err as PatchError).message).toContain("JSON Pointer");
    }
  });

  test("an unknown operation is rejected", () => {
    expect(() =>
      applyJsonPatch({}, [{ op: "frobnicate", path: "/a" } as unknown as never]),
    ).toThrow(/unknown operation/);
  });
});

describe("json merge patch (RFC 7386)", () => {
  test("an object merges key by key", () => {
    expect(applyMergePatch({ a: 1, b: 2 }, { b: 3 })).toEqual({ a: 1, b: 3 });
  });

  test("null deletes a key", () => {
    expect(applyMergePatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });

  test("a non-object patch replaces the target outright", () => {
    expect(applyMergePatch({ a: 1 }, "x")).toBe("x");
    expect(applyMergePatch({ a: 1 }, [1, 2])).toEqual([1, 2]);
  });

  test("arrays are replaced whole, as the RFC specifies", () => {
    expect(applyMergePatch({ a: [1, 2, 3] }, { a: [9] })).toEqual({ a: [9] });
  });

  test("merging into a scalar starts from an empty object", () => {
    expect(applyMergePatch(5, { a: 1 })).toEqual({ a: 1 });
  });

  test("the derived patch reproduces the target when applied", () => {
    const from = { a: 1, b: { c: 2, d: 3 }, e: [1] };
    const to = { a: 1, b: { c: 9 }, f: true };
    const patch = diffMergePatch(from, to);
    expect(applyMergePatch(from, patch)).toEqual(to);
  });

  test("the derived patch omits unchanged keys and marks removals with null", () => {
    expect(diffMergePatch({ a: 1, b: 2 }, { a: 1 })).toEqual({ b: null });
  });
});

describe("deep diff", () => {
  const opts = { maxDepth: 32, maxEntries: 100 };

  test("identical values produce no entries", () => {
    expect(deepDiff({ a: 1 }, { a: 1 }, opts).entries).toEqual([]);
  });

  test("an added and a removed key are each reported by path", () => {
    const out = deepDiff({ a: 1 }, { b: 2 }, opts);
    expect(out.counts).toEqual({ added: 1, removed: 1, changed: 0 });
    expect(out.entries.map((e) => e.path).sort()).toEqual(["/a", "/b"]);
  });

  test("a changed leaf carries both values and both types", () => {
    const out = deepDiff({ a: 1 }, { a: "1" }, opts);
    expect(out.entries[0]).toMatchObject({ kind: "changed", from: 1, to: "1", toType: "string" });
  });

  test("nested differences report the deep path, not the top one", () => {
    const out = deepDiff({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }, opts);
    expect(out.entries[0]?.path).toBe("/a/b/c");
  });

  test("arrays compare by position by default", () => {
    const out = deepDiff([1, 2], [1, 3, 4], opts);
    expect(out.counts).toEqual({ added: 1, removed: 0, changed: 1 });
  });

  test("keyArraysBy matches records by a field instead of position", () => {
    const before = [
      { id: "a", v: 1 },
      { id: "b", v: 2 },
    ];
    const after = [
      { id: "b", v: 2 },
      { id: "a", v: 9 },
    ];
    const out = deepDiff(before, after, { ...opts, keyArraysBy: "id" });
    expect(out.counts).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(out.entries[0]?.path).toBe("/1/v");
  });

  test("keyArraysBy falls back to position when the key is not unique", () => {
    const before = [{ id: "a" }, { id: "a" }];
    const after = [{ id: "a" }, { id: "b" }];
    const out = deepDiff(before, after, { ...opts, keyArraysBy: "id" });
    expect(out.entries[0]?.path).toBe("/1/id");
  });

  test("maxDepth collapses deeper differences into one changed entry", () => {
    const out = deepDiff({ a: { b: 1 } }, { a: { b: 2 } }, { ...opts, maxDepth: 1 });
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.path).toBe("/a");
  });

  test("maxEntries truncates and says so", () => {
    const before = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    const out = deepDiff(before, {}, { ...opts, maxEntries: 5 });
    expect(out.entries).toHaveLength(5);
    expect(out.truncated).toBe(true);
  });

  test("a difference dropped for want of budget still sets truncated", () => {
    // Three differences, room for two. The third is found by descending into
    // a nested object rather than by a push at this level, which is the path
    // that used to return quietly and leave truncated false — a diff that
    // under-reports without saying so is worse than one that refuses.
    const out = deepDiff(
      { a: 1, b: 2, c: { d: 3 } },
      { a: 9, b: 8, c: { d: 7 } },
      { ...opts, maxEntries: 2 },
    );
    expect(out.entries).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  test("an exactly-full budget with nothing left to find is not truncated", () => {
    const out = deepDiff({ a: 1, b: 2 }, { a: 9, b: 8 }, { ...opts, maxEntries: 2 });
    expect(out.entries).toHaveLength(2);
    expect(out.truncated).toBe(false);
  });

  test("the root itself can be the changed node", () => {
    const out = deepDiff(1, 2, opts);
    expect(out.entries[0]?.path).toBe("/");
  });
});

describe("csv reading", () => {
  test("a plain file splits into rows and fields", () => {
    expect(parseCsv("a,b\n1,2\n", CSV_DEFAULTS).rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("a quoted field may contain the delimiter", () => {
    expect(parseCsv('a,"x,y"\n', CSV_DEFAULTS).rows).toEqual([["a", "x,y"]]);
  });

  test("a quoted field may contain a newline", () => {
    expect(parseCsv('a,"one\ntwo"\n', CSV_DEFAULTS).rows).toEqual([["a", "one\ntwo"]]);
  });

  test("a doubled quote is one literal quote", () => {
    expect(parseCsv('"he said ""hi"""\n', CSV_DEFAULTS).rows).toEqual([['he said "hi"']]);
  });

  test("CRLF endings are handled", () => {
    expect(parseCsv("a,b\r\n1,2\r\n", CSV_DEFAULTS).rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("a final row without a trailing newline is still read", () => {
    expect(parseCsv("a,b\n1,2", CSV_DEFAULTS).rows).toHaveLength(2);
  });

  test("a trailing newline does not manufacture an empty row", () => {
    expect(parseCsv("a\n", CSV_DEFAULTS).rows).toHaveLength(1);
  });

  test("a byte-order mark is stripped from the first field name", () => {
    expect(parseCsv("\uFEFFa,b\n", CSV_DEFAULTS).rows[0]?.[0]).toBe("a");
  });

  test("a custom delimiter works", () => {
    expect(parseCsv("a\tb\n", { ...CSV_DEFAULTS, delimiter: "\t" }).rows).toEqual([["a", "b"]]);
  });

  test("trim leaves quoted fields alone", () => {
    const out = parseCsv('  a  ,"  b  "\n', { ...CSV_DEFAULTS, trim: true });
    expect(out.rows[0]).toEqual(["a", "  b  "]);
  });

  test("an unterminated quote is an error naming the line", () => {
    try {
      parseCsv('a,"unclosed\nmore\n', CSV_DEFAULTS);
      throw new Error("expected a CsvError");
    } catch (err) {
      expect(err).toBeInstanceOf(CsvError);
      expect((err as CsvError).message).toContain("unterminated");
    }
  });

  test("a delimiter equal to the quote character is refused", () => {
    expect(() => parseCsv("a", { ...CSV_DEFAULTS, delimiter: '"' })).toThrow(CsvError);
  });

  test("maxRows stops the parse and reports truncation", () => {
    const out = parseCsv("1\n2\n3\n", { ...CSV_DEFAULTS, maxRows: 2 });
    expect(out.rows).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  test("empty lines are skipped when asked", () => {
    expect(parseCsv("a\n\nb\n", CSV_DEFAULTS).rows).toEqual([["a"], ["b"]]);
  });

  test("a row that is a single quoted empty field is a row, not a blank line", () => {
    // RFC 4180 distinguishes them: `""` is one field whose value is empty.
    // Treating it as a blank line loses the record entirely.
    expect(parseCsv('""', CSV_DEFAULTS).rows).toEqual([[""]]);
    expect(parseCsv('a\n""\n', CSV_DEFAULTS).rows).toEqual([["a"], [""]]);
    expect(parseCsv('a\n""\nb\n', CSV_DEFAULTS).rows).toEqual([["a"], [""], ["b"]]);
  });

  test("a genuinely blank line is still skipped, quotes elsewhere notwithstanding", () => {
    expect(parseCsv('"a"\n\n"b"\n', CSV_DEFAULTS).rows).toEqual([["a"], ["b"]]);
  });

  test("an unterminated quote names the line the quote opened on", () => {
    // Not the line the file happens to end on — that is the line a reader
    // would look at and find nothing wrong with.
    try {
      parseCsv('a,b\nc,"unclosed\nd\ne\n', CSV_DEFAULTS);
      throw new Error("expected a CsvError");
    } catch (err) {
      expect((err as CsvError).line).toBe(2);
    }
  });
});

describe("csv typing and headers", () => {
  test("integers and decimals become numbers", () => {
    expect(inferScalar("42", [])).toBe(42);
    expect(inferScalar("-1.5", [])).toBe(-1.5);
  });

  test("a leading zero stays a string, because it is probably an identifier", () => {
    expect(inferScalar("007", [])).toBe("007");
    expect(inferScalar("+5", [])).toBe("+5");
  });

  test("booleans are recognized in any case and blanks become null", () => {
    expect(inferScalar("TRUE", [])).toBe(true);
    expect(inferScalar("False", [])).toBe(false);
    expect(inferScalar("   ", [])).toBe(null);
  });

  test("configured null tokens become null", () => {
    expect(inferScalar("NA", ["NA"])).toBe(null);
    expect(inferScalar("NA", [])).toBe("NA");
  });

  test("an unsafe integer stays a string rather than rounding", () => {
    expect(inferScalar("123456789012345678901", [])).toBe("123456789012345678901");
  });

  test("duplicate and blank header names are made unique", () => {
    expect(normalizeHeader(["a", "a", "", "a"])).toEqual(["a", "a_2", "column3", "a_3"]);
  });

  test("a header that already looks like a generated suffix does not collide with one", () => {
    // Naively counting per base name gives ["a", "a_2", "a_2"], and the
    // second "a_2" then overwrites the first when rows become records — one
    // column silently disappears.
    //
    // The rule is that a name is suffixed from its *own* base until it is
    // unused: the third column is called "a_2", it collides, so it becomes
    // "a_2_2". Renaming it "a_3" would suffix it from a base ("a") that is
    // not its name.
    expect(normalizeHeader(["a", "a", "a_2"])).toEqual(["a", "a_2", "a_2_2"]);
    // And the other order: "a_2" is taken first, so the second "a" has to
    // skip past it to "a_3".
    expect(normalizeHeader(["a_2", "a", "a"])).toEqual(["a_2", "a", "a_3"]);
    const header = normalizeHeader(["a", "a", "a_2"]);
    expect(new Set(header).size).toBe(header.length);
    expect(rowsToRecords([["1", "2", "3"]], header, false, []).records).toEqual([
      { a: "1", a_2: "2", a_2_2: "3" },
    ]);
  });

  test("rowsToRecords pads a short row with null and reports it as ragged", () => {
    const out = rowsToRecords([["1"]], ["a", "b"], false, []);
    expect(out.records).toEqual([{ a: "1", b: null }]);
    expect(out.ragged).toEqual([0]);
  });

  test("unionKeys preserves first-seen order across records", () => {
    expect(unionKeys([{ b: 1 }, { a: 2, b: 3 }])).toEqual(["b", "a"]);
  });
});

describe("csv writing", () => {
  const W = {
    delimiter: ",",
    quote: '"',
    newline: "\n",
    quoteAll: false,
    header: null,
  };

  test("a plain field is written bare", () => {
    expect(escapeCsvField("abc", W)).toBe("abc");
  });

  test("a field containing the delimiter, a quote or a newline is quoted", () => {
    expect(escapeCsvField("a,b", W)).toBe('"a,b"');
    expect(escapeCsvField('a"b', W)).toBe('"a""b"');
    expect(escapeCsvField("a\nb", W)).toBe('"a\nb"');
  });

  test("quoteAll quotes even a plain field", () => {
    expect(escapeCsvField("abc", { ...W, quoteAll: true })).toBe('"abc"');
  });

  test("null and undefined become the empty field", () => {
    expect(cellToString(null)).toBe("");
    expect(cellToString(undefined)).toBe("");
  });

  test("a nested value becomes its JSON, not [object Object]", () => {
    expect(cellToString({ a: 1 })).toBe('{"a":1}');
  });

  test("a header row is written when supplied", () => {
    expect(writeCsvRows([[1, 2]], { ...W, header: ["a", "b"] })).toBe("a,b\n1,2");
  });

  test("what the writer produces, the reader reads back unchanged", () => {
    const rows = [["a,b", 'c"d', "e\nf"]];
    const text = writeCsvRows(rows, W);
    expect(parseCsv(text, CSV_DEFAULTS).rows).toEqual([["a,b", 'c"d', "e\nf"]]);
  });
});

describe("jsonl", () => {
  test("one value per line, with the line number kept", () => {
    const out = parseJsonl('{"a":1}\n{"a":2}\n', 100, false);
    expect(out.records).toEqual([
      { line: 1, value: { a: 1 } },
      { line: 2, value: { a: 2 } },
    ]);
  });

  test("blank lines, CRLF and a missing trailing newline are all tolerated", () => {
    const out = parseJsonl("1\r\n\n2", 100, false);
    expect(out.records.map((r) => r.value)).toEqual([1, 2]);
  });

  test("a byte-order mark does not break the first record", () => {
    expect(parseJsonl('\uFEFF{"a":1}', 100, false).failures).toEqual([]);
  });

  test("a bad line is reported with its number, and the rest still parse", () => {
    const out = parseJsonl("1\nnope\n3", 100, false);
    expect(out.records.map((r) => r.value)).toEqual([1, 3]);
    expect(out.failures[0]?.line).toBe(2);
  });

  test("stopOnError halts at the first bad line", () => {
    const out = parseJsonl("1\nnope\n3", 100, true);
    expect(out.records).toHaveLength(1);
    expect(out.failures).toHaveLength(1);
  });

  test("a long bad line is previewed, not returned whole", () => {
    const out = parseJsonl(`{${"x".repeat(500)}`, 100, false);
    expect((out.failures[0]?.preview ?? "").length).toBeLessThan(140);
  });

  test("maxRecords truncates and says so", () => {
    const out = parseJsonl("1\n2\n3\n", 2, false);
    expect(out.records).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  test("writing escapes embedded newlines so the format stays one-per-line", () => {
    const out = writeJsonl([{ a: "x\ny" }], false);
    expect(out.text.split("\n")).toHaveLength(1);
  });

  test("undefined entries are skipped and counted", () => {
    const out = writeJsonl([1, undefined, 2], false);
    expect(out.text).toBe("1\n2");
    expect(out.skipped).toBe(1);
  });

  test("an empty input never produces a lone newline", () => {
    expect(writeJsonl([], true).text).toBe("");
  });

  test("write then parse is a round trip", () => {
    const values = [{ a: 1 }, [1, 2], "x", null];
    const text = writeJsonl(values, true).text;
    expect(parseJsonl(text, 100, true).records.map((r) => r.value)).toEqual(values);
  });
});

describe("yaml reading", () => {
  test("a flat mapping with typed scalars", () => {
    expect(parseYaml("a: 1\nb: true\nc: hello\nd: null")).toEqual({
      a: 1,
      b: true,
      c: "hello",
      d: null,
    });
  });

  test("nesting is by indentation", () => {
    expect(parseYaml("a:\n  b:\n    c: 1")).toEqual({ a: { b: { c: 1 } } });
  });

  test("a block sequence of scalars", () => {
    expect(parseYaml("- a\n- b")).toEqual(["a", "b"]);
  });

  test("a sequence of maps, with the first key on the dash line", () => {
    expect(parseYaml("- name: a\n  n: 1\n- name: b\n  n: 2")).toEqual([
      { name: "a", n: 1 },
      { name: "b", n: 2 },
    ]);
  });

  test("a sequence may sit at its key's own indentation", () => {
    expect(parseYaml("items:\n- a\n- b")).toEqual({ items: ["a", "b"] });
  });

  test("nested sequences work", () => {
    expect(parseYaml("- - a\n  - b")).toEqual([["a", "b"]]);
  });

  test("flow collections parse, nested", () => {
    expect(parseYaml("a: [1, two, {b: 3}]")).toEqual({ a: [1, "two", { b: 3 }] });
    expect(parseYaml("a: {b: [1], c: d}")).toEqual({ a: { b: [1], c: "d" } });
  });

  test("an empty flow collection is empty, not null", () => {
    expect(parseYaml("a: []\nb: {}")).toEqual({ a: [], b: {} });
  });

  test("comments are dropped, including after a value", () => {
    expect(parseYaml("# lead\na: 1 # trailing\n")).toEqual({ a: 1 });
  });

  test("a '#' inside quotes is not a comment", () => {
    expect(parseYaml('a: "x # y"')).toEqual({ a: "x # y" });
  });

  test("a quoted value may contain a colon", () => {
    expect(parseYaml('a: "b: c"')).toEqual({ a: "b: c" });
  });

  test("double-quoted escapes are expanded", () => {
    expect(parseYaml('a: "x\\ny\\u0041"')).toEqual({ a: "x\nyA" });
  });

  test("a single-quoted string doubles its quote to escape it", () => {
    expect(parseYaml("a: 'it''s'")).toEqual({ a: "it's" });
  });

  test("a literal block scalar keeps its newlines", () => {
    expect(parseYaml("a: |\n  one\n  two\n")).toEqual({ a: "one\ntwo\n" });
  });

  test("a folded block scalar joins lines with a space", () => {
    expect(parseYaml("a: >\n  one\n  two\n")).toEqual({ a: "one two\n" });
  });

  test("the strip chomping indicator removes the final newline", () => {
    expect(parseYaml("a: |-\n  one\n")).toEqual({ a: "one" });
  });

  test("a document marker is ignored", () => {
    expect(parseYaml("---\na: 1\n...")).toEqual({ a: 1 });
  });

  test("an empty value is null", () => {
    expect(parseYaml("a:\nb: 1")).toEqual({ a: null, b: 1 });
  });

  test("an empty document is null", () => {
    expect(parseYaml("")).toBe(null);
    expect(parseYaml("# only a comment")).toBe(null);
  });

  test("tabs in indentation are refused rather than guessed at", () => {
    expect(() => parseYaml("a:\n\tb: 1")).toThrow(YamlError);
  });

  test("anchors, aliases, merge keys and tags are refused explicitly", () => {
    expect(() => parseYaml("a: &anchor 1")).toThrow(/anchors/);
    expect(() => parseYaml("a: !!str 1")).toThrow(/tags/);
    expect(() => parseYaml("<<: *base")).toThrow(/merge keys/);
  });

  test("a complex key is refused", () => {
    expect(() => parseYaml("? [a]\n: 1")).toThrow(/complex/);
  });

  test("an error carries the line number", () => {
    try {
      parseYaml("a: 1\nb:\n\tc: 2");
      throw new Error("expected a YamlError");
    } catch (err) {
      expect((err as YamlError).line).toBe(3);
    }
  });

  test("a bare scalar is a valid document", () => {
    expect(parseYaml("just text")).toBe("just text");
  });
});

describe("yaml scalars and helpers", () => {
  test("plainScalar types the core schema", () => {
    expect(plainScalar("null")).toBe(null);
    expect(plainScalar("~")).toBe(null);
    expect(plainScalar("true")).toBe(true);
    expect(plainScalar("12")).toBe(12);
    expect(plainScalar("1.5")).toBe(1.5);
    expect(plainScalar("0x10")).toBe(16);
    expect(plainScalar("1e3")).toBe(1000);
    expect(plainScalar("v1.2")).toBe("v1.2");
  });

  test("findKeyColon ignores colons inside quotes and flow collections", () => {
    expect(findKeyColon('a: "b: c"')).toBe(1);
    expect(findKeyColon("a: {b: c}")).toBe(1);
    expect(findKeyColon("no colon here")).toBe(-1);
  });

  test("stripComment respects quotes", () => {
    expect(stripComment("a # b")).toBe("a");
    expect(stripComment('"a # b"')).toBe('"a # b"');
  });

  test("parseFlow rejects trailing characters", () => {
    expect(() => parseFlow("[1] junk", 1)).toThrow(YamlError);
  });

  test("canWritePlain refuses anything that would read back as another type", () => {
    expect(canWritePlain("hello")).toBe(true);
    expect(canWritePlain("true")).toBe(false);
    expect(canWritePlain("12")).toBe(false);
    expect(canWritePlain("")).toBe(false);
    expect(canWritePlain(" padded ")).toBe(false);
    expect(canWritePlain("a: b")).toBe(false);
  });
});

describe("yaml writing", () => {
  test("a nested mapping indents by two spaces", () => {
    expect(stringifyYaml({ a: { b: 1 } })).toBe("a:\n  b: 1");
  });

  test("a sequence of objects puts the first key on the dash line", () => {
    expect(stringifyYaml([{ a: 1, b: 2 }])).toBe("- a: 1\n  b: 2");
  });

  test("empty collections are written inline", () => {
    expect(stringifyYaml({ a: [], b: {} })).toBe("a: []\nb: {}");
  });

  test("a string that looks like a number is quoted", () => {
    expect(stringifyYaml({ a: "12" })).toBe('a: "12"');
  });

  test("a multi-line string is written double-quoted, not as a block scalar", () => {
    expect(stringifyYaml({ a: "x\ny" })).toBe('a: "x\\ny"');
  });

  test("write then read is a round trip for a realistic document", () => {
    const value = {
      name: "demo",
      count: 3,
      enabled: true,
      missing: null,
      tags: ["a", "b"],
      nested: { deep: { list: [{ id: 1 }, { id: 2 }] } },
      odd: "yes: really # honest",
    };
    expect(parseYaml(stringifyYaml(value))).toEqual(value);
  });
});

describe("toml reading", () => {
  test("top-level pairs and tables", () => {
    expect(parseToml('a = 1\n[t]\nb = "x"\n')).toEqual({ a: 1, t: { b: "x" } });
  });

  test("dotted keys build nested tables", () => {
    expect(parseToml("a.b.c = 1\n")).toEqual({ a: { b: { c: 1 } } });
  });

  test("a dotted table header nests too", () => {
    expect(parseToml("[a.b]\nc = 1\n")).toEqual({ a: { b: { c: 1 } } });
  });

  test("an array of tables accumulates elements", () => {
    expect(parseToml("[[f]]\nn = 1\n[[f]]\nn = 2\n")).toEqual({ f: [{ n: 1 }, { n: 2 }] });
  });

  test("literal and basic strings differ in escape handling", () => {
    expect(parseToml("a = 'c:\\path'\n")).toEqual({ a: "c:\\path" });
    expect(parseToml('a = "line\\nbreak"\n')).toEqual({ a: "line\nbreak" });
  });

  test("a multi-line basic string trims the leading newline", () => {
    expect(parseToml('a = """\nx\ny"""\n')).toEqual({ a: "x\ny" });
  });

  test("a backslash at the end of a line continues it", () => {
    expect(parseToml('a = """x\\\n     y"""\n')).toEqual({ a: "xy" });
  });

  test("numeric forms", () => {
    expect(parseToml("a = 1_000\nb = 0xff\nc = 0o17\nd = 0b101\ne = 1.5e2\n")).toEqual({
      a: 1000,
      b: 255,
      c: 15,
      d: 5,
      e: 150,
    });
  });

  test("a date stays a string, which the module documents", () => {
    expect(parseToml("d = 1979-05-27T07:32:00Z\n")).toEqual({ d: "1979-05-27T07:32:00Z" });
    expect(parseToml("d = 2026-01-01\n")).toEqual({ d: "2026-01-01" });
  });

  test("arrays may be nested and span lines with a trailing comma", () => {
    expect(parseToml("a = [\n  1,\n  [2, 3],\n]\n")).toEqual({ a: [1, [2, 3]] });
  });

  test("an inline table parses", () => {
    expect(parseToml('a = { b = 1, c = "x" }\n')).toEqual({ a: { b: 1, c: "x" } });
  });

  test("comments are dropped, including after a value", () => {
    expect(parseToml("# lead\na = 1 # trailing\n")).toEqual({ a: 1 });
  });

  test("a redefined table is an error", () => {
    expect(() => parseToml("[a]\nb = 1\n[a]\nc = 2\n")).toThrow(/twice/);
  });

  test("a redefined key is an error", () => {
    expect(() => parseToml("a = 1\na = 2\n")).toThrow(/twice/);
  });

  test("a table a dotted key already created cannot be reopened with a header", () => {
    // TOML 1.0: "redefining such tables using a [table] header is not
    // allowed". Merging the two quietly is how a config ends up with a value
    // its author never wrote in one place.
    expect(() => parseToml("a.b = 1\n[a]\nc = 2\n")).toThrow(/dotted key/);
  });

  test("a dotted key cannot reach into a table a header already defined", () => {
    expect(() => parseToml("[a.b]\nc = 1\n[d]\n[a]\nb.e = 2\n")).toThrow(/already a table/);
  });

  test("the rule is about redefinition, not about order — legal nesting still parses", () => {
    expect(parseToml("[a.b]\nc = 1\n[a]\nd = 2\n")).toEqual({ a: { b: { c: 1 }, d: 2 } });
    expect(parseToml("[a]\nb.c = 1\nb.d = 2\n")).toEqual({ a: { b: { c: 1, d: 2 } } });
    expect(parseToml("a = { b.c = 1, b.d = 2 }\n")).toEqual({ a: { b: { c: 1, d: 2 } } });
  });

  test("an unterminated string names the line", () => {
    try {
      parseToml('a = 1\nb = "oops\n');
      throw new Error("expected a TomlError");
    } catch (err) {
      expect(err).toBeInstanceOf(TomlError);
      expect((err as TomlError).line).toBe(2);
    }
  });

  test("an unreadable token is refused rather than guessed", () => {
    expect(() => scalarFromToken("??", 1)).toThrow(TomlError);
  });

  test("an unsafe integer stays a string", () => {
    expect(scalarFromToken("123456789012345678901", 1)).toBe("123456789012345678901");
  });
});

describe("toml writing", () => {
  test("scalars come before table headers", () => {
    expect(stringifyToml({ a: 1, t: { b: 2 } }).text).toBe("a = 1\n\n[t]\nb = 2");
  });

  test("an array of objects becomes an array of tables", () => {
    expect(stringifyToml({ f: [{ n: 1 }, { n: 2 }] }).text).toBe("[[f]]\nn = 1\n\n[[f]]\nn = 2");
  });

  test("nulls are dropped and reported, not written as something else", () => {
    const out = stringifyToml({ a: null, b: 1 });
    expect(out.text).toBe("b = 1");
    expect(out.skipped).toEqual(["a"]);
  });

  test("a non-object document is refused", () => {
    expect(() => stringifyToml([1, 2])).toThrow(TomlError);
  });

  test("a key needing quotes gets them", () => {
    expect(stringifyToml({ "odd key": 1 }).text).toBe('"odd key" = 1');
  });

  test("write then read is a round trip", () => {
    const value = {
      title: "x",
      n: 42,
      flag: true,
      list: [1, 2],
      owner: { name: "Max", nested: { deep: true } },
      items: [{ id: 1 }, { id: 2 }],
    };
    expect(parseToml(stringifyToml(value).text)).toEqual(value);
  });
});

describe("xml", () => {
  const O = { mode: "xml" as const, trimWhitespace: true, maxDepth: 64 };

  test("elements, attributes and text", () => {
    const nodes = parseXml('<a x="1">hi</a>', O);
    const el = nodes[0];
    expect(el && isElement(el) ? el.name : null).toBe("a");
    expect(el && isElement(el) ? el.attributes : null).toEqual({ x: "1" });
    expect(el ? textContent(el) : "").toBe("hi");
  });

  test("a self-closing tag has no children", () => {
    const nodes = parseXml("<a/><b/>", O);
    expect(nodes).toHaveLength(2);
  });

  test("CDATA is taken literally", () => {
    const nodes = parseXml("<a><![CDATA[<raw> & stuff]]></a>", O);
    expect(textContent(nodes[0] as never)).toBe("<raw> & stuff");
  });

  test("comments, processing instructions and doctypes are skipped", () => {
    const nodes = parseXml('<?xml version="1.0"?><!DOCTYPE a><!-- c --><a/>', O);
    expect(nodes).toHaveLength(1);
  });

  test("the five predefined entities and numeric references expand", () => {
    expect(decodeEntities("&amp;&lt;&gt;&quot;&apos;&#65;&#x42;", 1)).toBe("&<>\"'AB");
  });

  test("an unknown entity is an error, since there is no DTD to define it", () => {
    expect(() => decodeEntities("&nbsp;", 1)).toThrow(/unknown entity/);
  });

  test("a character reference outside Unicode is an XmlError, not a RangeError", () => {
    // String.fromCodePoint throws a RangeError for these, which would escape
    // the tool as a crash rather than arriving as a readable result.
    for (const bad of ["&#x110000;", "&#-1;", "&#1114112;"]) {
      expect(() => decodeEntities(bad, 1)).toThrow(XmlError);
    }
    expect(() => decodeEntities("&#xD800;", 1)).toThrow(/surrogate/);
  });

  test("the last code point Unicode has is still accepted", () => {
    expect(decodeEntities("&#x10FFFF;", 1)).toBe("\u{10FFFF}");
    expect(decodeEntities("&#0;", 1)).toBe("\u0000");
  });

  test("a bare ampersand is refused", () => {
    expect(() => decodeEntities("a & b", 1)).toThrow(/&amp;/);
  });

  test("entity declarations are refused outright", () => {
    expect(() => parseXml("<!ENTITY x SYSTEM 'file:///etc/passwd'><a/>", O)).toThrow(/entity/);
  });

  test("a mismatched close tag is an error in xml mode", () => {
    expect(() => parseXml("<a><b></a></b>", O)).toThrow(XmlError);
  });

  test("an unclosed element is an error in xml mode", () => {
    expect(() => parseXml("<a><b/>", O)).toThrow(/never closed/);
  });

  test("an unquoted attribute is an error in xml mode but fine in html mode", () => {
    expect(() => parseXml("<a x=1/>", O)).toThrow(/quoted/);
    const nodes = parseXml("<a x=1></a>", { ...O, mode: "html" });
    expect(
      isElement(nodes[0] as never)
        ? (nodes[0] as never as { attributes: Record<string, string> }).attributes
        : null,
    ).toEqual({ x: "1" });
  });

  test("html mode treats void elements as self-closing", () => {
    const nodes = parseXml("<p>a<br>b</p>", { ...O, mode: "html" });
    expect(nodes).toHaveLength(1);
    expect(textContent(nodes[0] as never)).toBe("ab");
  });

  test("html mode lowercases names and accepts a bare attribute", () => {
    const nodes = parseXml("<INPUT DISABLED>", { ...O, mode: "html" });
    const el = nodes[0];
    expect(el && isElement(el) ? el.name : null).toBe("input");
    expect(el && isElement(el) ? el.attributes : null).toEqual({ disabled: "" });
  });

  test("an error carries the line number", () => {
    try {
      parseXml("<a>\n\n<b></c></a>", O);
      throw new Error("expected an XmlError");
    } catch (err) {
      expect((err as XmlError).line).toBe(3);
    }
  });

  test("maxDepth bounds nesting", () => {
    expect(() => parseXml("<a><b><c/></b></a>", { ...O, maxDepth: 1 })).toThrow(/deeper than/);
  });

  test("the compact shape lifts attributes to @ and text to #text", () => {
    expect(toCompact(parseXml('<a x="1">hi</a>', O))).toEqual({ a: { "@x": "1", "#text": "hi" } });
  });

  test("an element with only text becomes that string", () => {
    expect(toCompact(parseXml("<a>hi</a>", O))).toEqual({ a: "hi" });
  });

  test("repeated siblings become an array", () => {
    expect(toCompact(parseXml("<r><i>1</i><i>2</i></r>", O))).toEqual({ r: { i: ["1", "2"] } });
  });

  test("whitespace-only text is dropped when asked and kept otherwise", () => {
    expect(toCompact(parseXml("<a>\n  <b/>\n</a>", O))).toEqual({ a: { b: "" } });
    const kept = parseXml("<a> </a>", { ...O, trimWhitespace: false });
    expect(textContent(kept[0] as never)).toBe(" ");
  });
});

describe("dotted paths", () => {
  test("getPath walks objects and array indexes", () => {
    expect(getPath({ a: { b: [10, 20] } }, "a.b.1")).toBe(20);
  });

  test("getPath returns undefined on a miss rather than throwing", () => {
    expect(getPath({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(getPath(null, "a")).toBeUndefined();
  });

  test("the empty path is the value itself", () => {
    expect(getPath(5, "")).toBe(5);
  });

  test("setPath creates intermediate objects", () => {
    const target: Record<string, unknown> = {};
    setPath(target, "a.b.c", 1);
    expect(target).toEqual({ a: { b: { c: 1 } } });
  });
});

describe("predicates", () => {
  const rec = { name: "Alpha", n: 5, tags: ["x"], nested: { ok: true }, blank: "" };

  test("eq and ne compare deeply", () => {
    expect(testCondition(rec, { field: "tags", op: "eq", value: ["x"] })).toBe(true);
    expect(testCondition(rec, { field: "tags", op: "ne", value: ["y"] })).toBe(true);
  });

  test("ordered comparisons work on numbers and strings", () => {
    expect(testCondition(rec, { field: "n", op: "gte", value: 5 })).toBe(true);
    expect(testCondition(rec, { field: "name", op: "lt", value: "Beta" })).toBe(true);
  });

  test("a number against a string is simply false, never coerced", () => {
    expect(testCondition(rec, { field: "n", op: "gt", value: "3" })).toBe(false);
  });

  test("contains works on arrays and on strings", () => {
    expect(testCondition(rec, { field: "tags", op: "contains", value: "x" })).toBe(true);
    expect(testCondition(rec, { field: "name", op: "contains", value: "lph" })).toBe(true);
  });

  test("startsWith, endsWith and in", () => {
    expect(testCondition(rec, { field: "name", op: "startsWith", value: "Al" })).toBe(true);
    expect(testCondition(rec, { field: "name", op: "endsWith", value: "ha" })).toBe(true);
    expect(testCondition(rec, { field: "n", op: "in", value: [1, 5] })).toBe(true);
  });

  test("matches applies a regex, and a bad one is reported", () => {
    expect(testCondition(rec, { field: "name", op: "matches", value: "^A.+a$" })).toBe(true);
    expect(() => testCondition(rec, { field: "name", op: "matches", value: "(" })).toThrow(
      /invalid regex/,
    );
  });

  test("exists and empty distinguish absent from blank", () => {
    expect(testCondition(rec, { field: "nested.ok", op: "exists" })).toBe(true);
    expect(testCondition(rec, { field: "nope", op: "exists" })).toBe(false);
    expect(testCondition(rec, { field: "blank", op: "empty" })).toBe(true);
    expect(testCondition(rec, { field: "name", op: "empty" })).toBe(false);
  });

  test("all, any and none combine as named", () => {
    expect(testPredicate(rec, { all: [{ field: "n", op: "eq", value: 5 }] })).toBe(true);
    expect(
      testPredicate(rec, {
        any: [
          { field: "n", op: "eq", value: 1 },
          { field: "n", op: "eq", value: 5 },
        ],
      }),
    ).toBe(true);
    expect(testPredicate(rec, { none: [{ field: "n", op: "eq", value: 5 }] })).toBe(false);
  });

  test("an empty predicate matches everything", () => {
    expect(testPredicate(rec, {})).toBe(true);
  });
});

describe("sorting", () => {
  test("compareValues refuses to order values of different types", () => {
    expect(compareValues(1, 2)).toBe(-1);
    expect(compareValues("a", "a")).toBe(0);
    expect(compareValues(1, "1")).toBe(null);
  });

  test("totalCompare orders by type rank when types differ", () => {
    expect(totalCompare(true, 1)).toBe(-1);
    expect(totalCompare("s", [])).toBe(-1);
  });

  test("the rank order is exactly TYPE_ORDER, null included", () => {
    // The documented order is null < boolean < number < string < array <
    // object. Sorting one representative of each and reading the types back
    // is the only assertion that cannot drift from the docstring.
    const samples: unknown[] = [{}, ["x"], "s", 1, true, null];
    const sorted = [...samples].sort(totalCompare);
    const nameOf = (v: unknown): string =>
      v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    expect(sorted.map(nameOf)).toEqual([...TYPE_ORDER]);
  });

  test("totalCompare puts null before everything, not with the objects", () => {
    expect(totalCompare(null, 1)).toBe(-1);
    expect(totalCompare(null, {})).toBe(-1);
    expect(totalCompare(1, null)).toBe(1);
    expect(totalCompare(null, null)).toBe(0);
  });

  test("two distinct objects of the same rank order by canonical text, not by a hash", () => {
    // Ordering by hash is arbitrary; ordering by canonical text is the order
    // a reader can predict, and cannot call two different values equal.
    expect(totalCompare({ a: 1 }, { a: 2 })).toBe(-1);
    expect(totalCompare({ a: 1 }, { a: 1 })).toBe(0);
    // Equal values, whatever order their keys were written in.
    expect(totalCompare({ b: 1, a: 1 }, { a: 1, b: 1 })).toBe(0);
  });

  test("ordering compounds lexicographically by text, which is not element-wise numeric", () => {
    // "[1,2]" vs "[1,10]": the fourth character is "2" against "1", so
    // [1,2] sorts *after* [1,10]. Worth pinning rather than discovering —
    // it is the price of a total order that never has to compare a number
    // against an object.
    expect(totalCompare([1, 2], [1, 10])).toBe(1);
    expect(totalCompare([1, 10], [1, 2])).toBe(-1);
  });

  test("sorting is stable for equal keys", () => {
    const rows = [
      { k: 1, id: "a" },
      { k: 1, id: "b" },
      { k: 0, id: "c" },
    ];
    expect(sortRecords(rows, [{ field: "k" }]).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  test("descending reverses, and a second key breaks ties", () => {
    const rows = [
      { a: 1, b: 2 },
      { a: 1, b: 1 },
      { a: 2, b: 0 },
    ];
    expect(sortRecords(rows, [{ field: "a", direction: "desc" }])[0]?.a).toBe(2);
    expect(sortRecords(rows, [{ field: "a" }, { field: "b" }])[0]?.b).toBe(1);
  });

  test("nulls go last by default and first when asked", () => {
    const rows = [{ n: null }, { n: 1 }];
    expect(sortRecords(rows, [{ field: "n" }])[0]?.n).toBe(1);
    expect(sortRecords(rows, [{ field: "n", nulls: "first" }])[0]?.n).toBe(null);
  });

  test("caseInsensitive changes the answer, which is how you know it applies", () => {
    // "B" (0x42) sorts before "a" (0x61) by code unit, and after it once
    // folded. A pair that sorts the same either way tests nothing.
    const rows = [{ s: "B" }, { s: "a" }];
    expect(sortRecords(rows, [{ field: "s" }]).map((r) => r.s)).toEqual(["B", "a"]);
    expect(sortRecords(rows, [{ field: "s", caseInsensitive: true }]).map((r) => r.s)).toEqual([
      "a",
      "B",
    ]);
  });

  test("caseInsensitive leaves non-strings alone", () => {
    const rows = [{ n: 10 }, { n: 2 }];
    expect(sortRecords(rows, [{ field: "n", caseInsensitive: true }]).map((r) => r.n)).toEqual([
      2, 10,
    ]);
  });

  test("sorting does not mutate the input array", () => {
    const rows = [{ n: 2 }, { n: 1 }];
    sortRecords(rows, [{ field: "n" }]);
    expect(rows[0]?.n).toBe(2);
  });
});

describe("projection", () => {
  test("selectFields keeps only what is asked for, nested paths included", () => {
    expect(selectFields({ a: 1, b: { c: 2, d: 3 } }, ["a", "b.c"])).toEqual({
      a: 1,
      b: { c: 2 },
    });
  });

  test("selectFields skips a field that is not there", () => {
    expect(selectFields({ a: 1 }, ["a", "zz"])).toEqual({ a: 1 });
  });

  test("omitFields drops a nested field without touching the original", () => {
    const source = { a: 1, b: { c: 2, d: 3 } };
    expect(omitFields(source, ["b.c"])).toEqual({ a: 1, b: { d: 3 } });
    expect(source.b.c).toBe(2);
  });
});

describe("aggregation", () => {
  const rows = [
    { g: "x", n: 1, s: "a" },
    { g: "x", n: 3, s: "b" },
    { g: "y", n: 5, s: "c" },
  ];

  test("count, sum, avg, min, max, first and last", () => {
    const out = aggregate(
      rows,
      ["g"],
      [
        { as: "total", fn: "sum", field: "n" },
        { as: "mean", fn: "avg", field: "n" },
        { as: "lo", fn: "min", field: "n" },
        { as: "hi", fn: "max", field: "n" },
        { as: "f", fn: "first", field: "s" },
        { as: "l", fn: "last", field: "s" },
      ],
    );
    expect(out.groups[0]).toEqual({
      g: "x",
      count: 2,
      total: 4,
      mean: 2,
      lo: 1,
      hi: 3,
      f: "a",
      l: "b",
    });
  });

  test("grouping by nothing aggregates the whole set", () => {
    const out = aggregate(rows, [], [{ as: "total", fn: "sum", field: "n" }]);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]?.["total"]).toBe(9);
  });

  test("a non-numeric value is skipped and counted, never turned into NaN", () => {
    const out = aggregate([{ n: 1 }, { n: "x" }], [], [{ as: "t", fn: "sum", field: "n" }]);
    expect(out.groups[0]?.["t"]).toBe(1);
    expect(out.skipped).toBe(1);
  });

  test("avg over no numbers is null, not NaN", () => {
    const out = aggregate([{ n: "x" }], [], [{ as: "m", fn: "avg", field: "n" }]);
    expect(out.groups[0]?.["m"]).toBe(null);
  });

  test("distinct counts distinct values structurally", () => {
    const out = aggregate(
      [{ v: { a: 1 } }, { v: { a: 1 } }, { v: { a: 2 } }],
      [],
      [{ as: "d", fn: "distinct", field: "v" }],
    );
    expect(out.groups[0]?.["d"]).toBe(2);
  });

  test("grouping by multiple fields keys on the combination", () => {
    const out = aggregate(
      [
        { a: 1, b: 1 },
        { a: 1, b: 2 },
        { a: 1, b: 1 },
      ],
      ["a", "b"],
      [],
    );
    expect(out.groups).toHaveLength(2);
  });

  test("a missing group field becomes null rather than dropping the row", () => {
    const out = aggregate([{ n: 1 }], ["missing"], []);
    expect(out.groups[0]).toEqual({ missing: null, count: 1 });
  });
});

describe("joining", () => {
  const left = [
    { id: 1, a: "A" },
    { id: 2, a: "B" },
  ];
  const right = [
    { id: 1, b: "X" },
    { id: 3, b: "Z" },
  ];
  const base = { leftKey: "id", rightKey: "id", rightPrefix: "right_", maxRows: 100 };

  test("an inner join keeps only matches", () => {
    const out = joinRecords(left, right, { ...base, kind: "inner" });
    expect(out.rows).toHaveLength(1);
    expect(out.unmatchedLeft).toBe(1);
    expect(out.unmatchedRight).toBe(1);
  });

  test("a left join keeps unmatched left rows", () => {
    expect(joinRecords(left, right, { ...base, kind: "left" }).rows).toHaveLength(2);
  });

  test("a right join keeps unmatched right rows", () => {
    expect(joinRecords(left, right, { ...base, kind: "right" }).rows).toHaveLength(2);
  });

  test("a full join keeps both sides", () => {
    expect(joinRecords(left, right, { ...base, kind: "full" }).rows).toHaveLength(3);
  });

  test("a colliding field name is prefixed rather than overwritten", () => {
    const out = joinRecords([{ id: 1, v: "l" }], [{ id: 1, v: "r" }], { ...base, kind: "inner" });
    expect(out.rows[0]).toEqual({ id: 1, v: "l", right_id: 1, right_v: "r" });
  });

  test("one-to-many multiplies rows, as SQL does", () => {
    const out = joinRecords(
      [{ id: 1 }],
      [
        { id: 1, n: 1 },
        { id: 1, n: 2 },
      ],
      {
        ...base,
        kind: "inner",
      },
    );
    expect(out.rows).toHaveLength(2);
  });

  test('1 and "1" are different keys, so a join never silently coerces', () => {
    const out = joinRecords([{ id: 1 }], [{ id: "1" }], { ...base, kind: "inner" });
    expect(out.rows).toHaveLength(0);
  });

  test("a null key never matches", () => {
    const out = joinRecords([{ id: null }], [{ id: null }], { ...base, kind: "inner" });
    expect(out.rows).toHaveLength(0);
  });

  test("maxRows truncates and says so", () => {
    const out = joinRecords([{ id: 1 }], [{ id: 1 }, { id: 1 }], {
      ...base,
      kind: "inner",
      maxRows: 1,
    });
    expect(out.truncated).toBe(true);
  });
});

describe("reshaping", () => {
  test("records to columns fills a missing field with null", () => {
    expect(recordsToColumns([{ a: 1 }, { b: 2 }])).toEqual({ a: [1, null], b: [null, 2] });
  });

  test("columns to records pads short columns and names them", () => {
    const out = columnsToRecords({ a: [1, 2], b: [3] });
    expect(out.records).toEqual([
      { a: 1, b: 3 },
      { a: 2, b: null },
    ]);
    expect(out.ragged).toEqual(["b"]);
  });

  test("the two are inverses for rectangular data", () => {
    const records = [
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ];
    expect(columnsToRecords(recordsToColumns(records)).records).toEqual(records);
  });

  test("flatten produces dotted keys, expanding arrays by index", () => {
    expect(flattenObject({ a: { b: 1 }, c: [7, 8] }, ".", true, 32)).toEqual({
      "a.b": 1,
      "c.0": 7,
      "c.1": 8,
    });
  });

  test("flatten can leave arrays whole", () => {
    expect(flattenObject({ c: [7] }, ".", false, 32)).toEqual({ c: [7] });
  });

  test("an empty object or array survives flattening as itself", () => {
    expect(flattenObject({ a: {}, b: [] }, ".", true, 32)).toEqual({ a: {}, b: [] });
  });

  test("maxDepth stops descending and keeps the subtree whole", () => {
    expect(flattenObject({ a: { b: { c: 1 } } }, ".", true, 1)).toEqual({ a: { b: { c: 1 } } });
  });

  test("a custom separator is honoured both ways", () => {
    const flat = flattenObject({ a: { b: 1 } }, "__", true, 32);
    expect(flat).toEqual({ a__b: 1 });
    expect(unflattenObject(flat, "__", true)).toEqual({ a: { b: 1 } });
  });

  test("unflatten rebuilds an array from a contiguous numeric run", () => {
    expect(unflattenObject({ "a.0": 1, "a.1": 2 }, ".", true)).toEqual({ a: [1, 2] });
  });

  test("a non-contiguous numeric run stays an object rather than inventing nulls", () => {
    expect(unflattenObject({ "a.2": 1 }, ".", true)).toEqual({ a: { "2": 1 } });
  });

  test("array rebuilding can be switched off", () => {
    expect(unflattenObject({ "a.0": 1 }, ".", false)).toEqual({ a: { "0": 1 } });
  });

  test("flatten then unflatten is a round trip", () => {
    const value = { a: { b: [1, { c: 2 }] }, d: "x" };
    expect(unflattenObject(flattenObject(value, ".", true, 32), ".", true)).toEqual(value);
  });
});

describe("dedupe and sample", () => {
  test("whole-value dedupe ignores key order", () => {
    const out = dedupeRecords(
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
      [],
      "first",
    );
    expect(out.records).toHaveLength(1);
    expect(out.removed).toBe(1);
  });

  test("key-field dedupe keeps the first or the last occurrence", () => {
    const rows = [
      { id: 1, v: "a" },
      { id: 1, v: "b" },
    ];
    expect(dedupeRecords(rows, ["id"], "first").records[0]?.v).toBe("a");
    expect(dedupeRecords(rows, ["id"], "last").records[0]?.v).toBe("b");
  });

  test("dedupe preserves the surviving order", () => {
    const out = dedupeRecords([{ id: 2 }, { id: 1 }, { id: 2 }], ["id"], "first");
    expect(out.records.map((r) => r.id)).toEqual([2, 1]);
  });

  test("head, tail and everyNth take what they say", () => {
    const rows = [0, 1, 2, 3, 4, 5];
    expect(sampleRecords(rows, "head", 2, 1)).toEqual([0, 1]);
    expect(sampleRecords(rows, "tail", 2, 1)).toEqual([4, 5]);
    expect(sampleRecords(rows, "everyNth", 10, 2)).toEqual([0, 2, 4]);
  });

  test("evenly spans the whole range, first and last included", () => {
    expect(sampleRecords([0, 1, 2, 3, 4], "evenly", 3, 1)).toEqual([0, 2, 4]);
  });

  test("sampling more than exists returns everything", () => {
    expect(sampleRecords([1, 2], "head", 10, 1)).toEqual([1, 2]);
  });

  test("an empty input samples to nothing", () => {
    expect(sampleRecords([], "evenly", 3, 1)).toEqual([]);
  });

  test("the same call twice gives the same sample — there is no random mode", () => {
    const rows = Array.from({ length: 50 }, (_, i) => i);
    expect(sampleRecords(rows, "evenly", 7, 1)).toEqual(sampleRecords(rows, "evenly", 7, 1));
  });
});
