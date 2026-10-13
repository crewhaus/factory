/**
 * SchemaSummarize costs about the size of the schema.
 *
 * It searched an object's `required` list once per property, the properties
 * times the names, and went on doing so after the table was full, since the
 * search was an argument to a walk that then added nothing. And it followed
 * a `$ref` by copying the list of refs already followed and searching it,
 * so a chain of n refs cost n² — a ref adds no depth, so the depth limit
 * never stopped one. Now the names are a set, the walk stops once the table
 * is full, and the refs followed are a set kept in step with the walk. The
 * rows are unchanged: the last test compares them with the walk as it was.
 *
 * The work is counted with tool-code's __test__/js-work.ts, which charges an
 * array's `includes` for the whole array, an iterator step (a spread, a
 * `for…of`) one each, and a string's `split` or `slice` its length. Never
 * timed.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { schemaSummarize } from "./index";
import { type FieldRow, summarizeSchema } from "./lib/summarize";
import { isPlainObject, parsePointer, resolveSegments, typeOf } from "./lib/value";

/** Counted work per character of the schema as JSON; under 2 here. */
const WORK_PER_CHARACTER = 4;

/** The schemas that cost n². */
const SHAPES: ReadonlyArray<{ label: string; make: (n: number) => Record<string, unknown> }> = [
  {
    label: "n properties against n required names, past the last row",
    make: (n) => ({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`p${i}`, { type: "string" }]),
      ),
      required: Array.from({ length: n }, (_, i) => `r${i}`),
    }),
  },
  {
    label: "a chain of n refs",
    make: (n) => {
      const definitions: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) definitions[`d${i}`] = { $ref: `#/definitions/d${i + 1}` };
      definitions[`d${n}`] = { type: "string" };
      return { type: "object", properties: { x: { $ref: "#/definitions/d0" } }, definitions };
    },
  },
];

describe("SchemaSummarize costs about the size of the schema", () => {
  test("the shapes that cost n², at n and 2n", () => {
    for (const { label, make } of SHAPES) {
      const measured = [2_000, 4_000].map((n) => {
        const schema = make(n);
        const chars = JSON.stringify(schema).length;
        const run = jsWork(WORK_PER_CHARACTER * chars, () => summarizeSchema(schema));
        return { chars, run };
      });
      for (const { chars, run } of measured) {
        // Labelled, so a failure names the shape.
        expect({ label, within: run.work <= WORK_PER_CHARACTER * chars }).toEqual({
          label,
          within: true,
        });
        expect(run.value?.rows.length).toBeGreaterThan(0);
      }
      const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
      // Twice the input, about twice the work.
      expect({ label, ratio: large.run.work / small.run.work < 2.4 }).toEqual({
        label,
        ratio: true,
      });
    }
  }, 20_000);

  test("the tool, on a schema whose properties are all required", async () => {
    const n = 4_000;
    const schema = {
      type: "object",
      properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, {}])),
      required: Array.from({ length: n }, (_, i) => `p${n - 1 - i}`),
    };
    const chars = JSON.stringify(schema).length;
    const input = schemaSummarize.inputSchema.parse({ schema, format: "json", maxRows: 2_000 });
    const run = jsWork(WORK_PER_CHARACTER * chars, () => schemaSummarize.execute(input, {}));
    expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * chars);
    const out = JSON.parse((await run.value) as string) as {
      fieldCount: number;
      truncated: boolean;
      fields: FieldRow[];
    };
    expect(out.fieldCount).toBe(2_000);
    expect(out.truncated).toBe(true);
    expect(out.fields.every((row) => row.required)).toBe(true);
  }, 20_000);
});

/** The walk as it was: a list of refs copied per hop, and the names searched per property. */
function walkedAsBefore(
  schema: unknown,
  options: { maxRows?: number; maxDepth?: number } = {},
): FieldRow[] {
  const rows: FieldRow[] = [];
  const maxRows = options.maxRows ?? 300;
  const maxDepth = options.maxDepth ?? 8;
  const state = { truncated: false };
  const push = (row: FieldRow): boolean => {
    if (rows.length >= maxRows) {
      state.truncated = true;
      return false;
    }
    rows.push(row);
    return true;
  };
  const row = (path: string, type: string, required: boolean, constraints: string) => ({
    path,
    type,
    required,
    constraints,
    description: "",
  });
  const walk = (
    node: unknown,
    path: string,
    required: boolean,
    depth: number,
    seen: string[],
  ): void => {
    if (state.truncated) return;
    if (typeof node === "boolean") {
      push(row(path, node ? "any" : "never", required, node ? "" : "accepts no value"));
      return;
    }
    if (!isPlainObject(node)) {
      push(row(path, typeOf(node), required, "not a schema"));
      return;
    }
    const ref = typeof node["$ref"] === "string" ? node["$ref"] : null;
    if (ref !== null) {
      if (seen.includes(ref)) {
        push(row(path, `${ref} (recursive)`, required, ""));
        return;
      }
      let target: Record<string, unknown> | null = null;
      if (ref.startsWith("#")) {
        try {
          const found = resolveSegments(schema, parsePointer(ref));
          target = found.found && isPlainObject(found.value) ? found.value : null;
        } catch {
          target = null;
        }
      }
      if (target === null) {
        push(row(path, ref, required, "unresolved $ref"));
        return;
      }
      walk(target, path, required, depth, [...seen, ref]);
      return;
    }
    // Only the parts these tests vary are compared: path, required, and
    // whether a row was made at all.
    if (path !== "" && !push(row(path, "", required, ""))) return;
    if (depth >= maxDepth) return;
    const properties = node["properties"];
    if (isPlainObject(properties)) {
      const names = Array.isArray(node["required"])
        ? node["required"].filter((k): k is string => typeof k === "string")
        : [];
      for (const key of Object.keys(properties)) {
        walk(
          properties[key],
          path === "" ? key : `${path}.${key}`,
          names.includes(key),
          depth + 1,
          seen,
        );
      }
    }
    const items = node["items"];
    if (Array.isArray(items)) {
      items.forEach((item, index) => {
        walk(item, `${path}[${index}]`, required, depth + 1, seen);
      });
    } else if (items !== undefined) {
      walk(items, `${path}[]`, required, depth + 1, seen);
    }
  };
  walk(schema, "", false, 0, []);
  return rows;
}

describe("the rows are the ones the walk as it was made", () => {
  test("on generated schemas with required lists, refs, recursion and small tables", () => {
    const state = { seed: 0x5ab0001 };
    const next = () => {
      state.seed = (state.seed + 0x6d2b79f5) | 0;
      let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const names = ["a", "b", "c", "__proto__", "x.y", ""];
    const defs = ["A", "B", "C"];
    const node = (depth: number): unknown => {
      const r = next();
      if (depth <= 0 || r < 0.15) {
        return pick<unknown>([
          { type: "string" },
          true,
          false,
          1,
          { $ref: "#/nope" },
          { $ref: `#/$defs/${pick(defs)}` },
        ]);
      }
      if (r < 0.3) return { $ref: `#/$defs/${pick(defs)}` };
      const out: Record<string, unknown> = { type: "object" };
      const properties: Record<string, unknown> = {};
      for (let i = Math.floor(next() * 4); i > 0; i--) properties[pick(names)] = node(depth - 1);
      out["properties"] = properties;
      if (next() < 0.7)
        out["required"] = Array.from({ length: Math.floor(next() * 4) }, () =>
          pick<unknown>([...names, 7]),
        );
      if (next() < 0.3)
        out["items"] = next() < 0.5 ? node(depth - 1) : [node(depth - 1), node(depth - 1)];
      return out;
    };
    const differ: string[] = [];
    let required = 0;
    let recursive = 0;
    for (let round = 0; round < 5_000; round++) {
      const $defs: Record<string, unknown> = {};
      for (const d of defs) if (next() < 0.8) $defs[d] = node(2);
      const schema = { ...(node(3) as object), $defs };
      const options = pick([{}, { maxRows: 1 }, { maxRows: 4 }, { maxDepth: 1 }]);
      const expected = walkedAsBefore(schema, options).map((r) => [
        r.path,
        r.type.endsWith("(recursive)") || r.constraints === "unresolved $ref" ? r.type : "",
        r.required,
      ]);
      const got = summarizeSchema(schema, options).rows.map((r) => [
        r.path,
        r.type.endsWith("(recursive)") || r.constraints === "unresolved $ref" ? r.type : "",
        r.required,
      ]);
      required += expected.filter((r) => r[2] === true).length;
      recursive += expected.filter((r) => String(r[1]).endsWith("(recursive)")).length;
      if (JSON.stringify(got) !== JSON.stringify(expected)) differ.push(JSON.stringify(schema));
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(required).toBeGreaterThan(1_000);
    expect(recursive).toBeGreaterThan(100);
  }, 20_000);
});
