/**
 * SchemaDiff compares by lookup, not by walking subtrees again.
 *
 * Two enums were diffed by testing every value of one against every value of
 * the other with `deepEqual`, and two `required` lists, and the properties
 * added against a `required` list, by searching one list per name: each n²
 * in a schema the model wrote. And every level of nesting began with a
 * `deepEqual` of its whole remaining subtree, so a schema nested n deep cost
 * n². Now every subtree of both schemas is numbered once (lib/shape-index),
 * two subtrees are equal when their numbers are, enums are diffed through a
 * set of keys, and the name lists through sets. The changes reported are
 * unchanged.
 *
 * Two bounds come with it. A schema nested deeper than MAX_SCHEMA_DEPTH is
 * refused before it is read: the recursion's own limit was the stack's,
 * which moves with the platform and with how warm the code is. And the
 * tool lists changes only until their paths reach MAX_LISTED_PATH_CHARS,
 * counting the rest: every change carries its full path, so a long name
 * high in a schema was repeated in every change below it.
 *
 * The work is counted with tool-code's __test__/js-work.ts, which charges a
 * `some`, `every` or `filter` callback, an array's `includes` for the whole
 * array, and an iterator step, one each; and the numbering's own work with
 * the index's `steps`. Never timed.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { MAX_LISTED_PATH_CHARS, schemaDiff } from "./index";
import { MAX_SCHEMA_DEPTH, diffSchemas, nestsDeeperThan } from "./lib/schemadiff";
import { UNINDEXED, indexShapes } from "./lib/shape-index";
import { deepEqual, preview } from "./lib/value";

/** Counted work per character of the two schemas as JSON; under 1 here. */
const WORK_PER_CHARACTER = 4;
/** The numbering's steps per character of the two schemas as JSON; under 1 here. */
const STEPS_PER_CHARACTER = 3;

/** Seeded, so a failure names the same input every run. */
function rng(start: number): () => number {
  const state = { seed: start };
  return () => {
    state.seed = (state.seed + 0x6d2b79f5) | 0;
    let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const chain = (n: number, wrap: (inner: unknown) => unknown, leaf: unknown): unknown => {
  let node: unknown = { type: leaf };
  for (let i = 0; i < n; i++) node = wrap(node);
  return node;
};

/**
 * The schema pairs that cost n² before, each at two sizes, n and 2n. The
 * nested ones stay within MAX_SCHEMA_DEPTH: a level of `properties` is two
 * levels of the document, a level of `items` one.
 */
const SHAPES: ReadonlyArray<{
  label: string;
  sizes: readonly [number, number];
  make: (n: number) => [unknown, unknown];
}> = [
  {
    label: "two enums with no value in common",
    sizes: [2_000, 4_000],
    make: (n) => [
      { enum: Array.from({ length: n }, (_, i) => `a${i}`) },
      { enum: Array.from({ length: n }, (_, i) => `b${i}`) },
    ],
  },
  {
    label: "two enums of objects with no value in common",
    sizes: [2_000, 4_000],
    make: (n) => [
      { enum: Array.from({ length: n }, (_, i) => ({ k: i })) },
      { enum: Array.from({ length: n }, (_, i) => ({ k: -i - 1 })) },
    ],
  },
  {
    label: "two required lists with no name in common",
    sizes: [2_000, 4_000],
    make: (n) => [
      { required: Array.from({ length: n }, (_, i) => `a${i}`) },
      { required: Array.from({ length: n }, (_, i) => `b${i}`) },
    ],
  },
  {
    label: "properties added against a required list",
    sizes: [2_000, 4_000],
    make: (n) => [
      { properties: {} },
      {
        properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, {}])),
        required: Array.from({ length: n }, (_, i) => `r${i}`),
      },
    ],
  },
  {
    label: "properties nested n deep, differing at the bottom",
    sizes: [60, 120],
    make: (n) => [
      chain(n, (inner) => ({ properties: { a: inner } }), "string"),
      chain(n, (inner) => ({ properties: { a: inner } }), "number"),
    ],
  },
  {
    label: "items nested n deep, differing at the bottom",
    sizes: [120, 240],
    make: (n) => [
      chain(n, (inner) => ({ items: inner }), "string"),
      chain(n, (inner) => ({ items: inner }), "number"),
    ],
  },
];

describe("SchemaDiff costs about the size of the two schemas", () => {
  test("the shapes that cost n², at n and 2n", () => {
    for (const { label, sizes, make } of SHAPES) {
      const measured = sizes.map((n) => {
        const [before, after] = make(n);
        const chars = JSON.stringify(before).length + JSON.stringify(after).length;
        const run = jsWork(WORK_PER_CHARACTER * chars, () => diffSchemas(before, after));
        const steps = indexShapes([before, after]).steps;
        return { chars, run, steps };
      });
      for (const { chars, run, steps } of measured) {
        // Labelled, so a failure names the shape.
        expect({ label, within: run.work <= WORK_PER_CHARACTER * chars }).toEqual({
          label,
          within: true,
        });
        expect({ label, within: steps <= STEPS_PER_CHARACTER * chars }).toEqual({
          label,
          within: true,
        });
        expect(run.value?.verdict).toBeDefined();
      }
      const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
      // Twice the input, about twice the work.
      expect({ label, ratio: large.run.work / small.run.work < 2.4 }).toEqual({
        label,
        ratio: true,
      });
      expect({ label, ratio: large.steps / small.steps < 2.4 }).toEqual({ label, ratio: true });
    }
  }, 30_000);

  test("the enum, required and nesting answers at that size", () => {
    const [enumBefore, enumAfter] = (SHAPES[0] as (typeof SHAPES)[0]).make(4_000);
    const enums = diffSchemas(enumBefore, enumAfter);
    expect(enums.changes.map((c) => [c.keyword, c.compat])).toEqual([
      ["enum", "breaking"],
      ["enum", "compatible"],
    ]);
    expect(enums.changes[0]?.detail.startsWith('enum values removed: ["a0","a1"')).toBe(true);
    const [deepBefore, deepAfter] = (SHAPES[4] as (typeof SHAPES)[0]).make(127);
    const deep = diffSchemas(deepBefore, deepAfter);
    expect(deep.changes).toHaveLength(1);
    expect(deep.changes[0]?.path).toBe(`${"/properties/a".repeat(127)}`);
    expect(deep.changes[0]?.keyword).toBe("type");
  }, 30_000);
});

/** `inner` wrapped in `depth - 1` objects: a schema `depth` levels deep, built without recursion. */
function itemsChain(depth: number, leaf: string): unknown {
  let node: unknown = { type: leaf };
  for (let i = 1; i < depth; i++) node = { items: node };
  return node;
}

type ToolOut = {
  counts: { compatible: number; breaking: number; unknown: number };
  changes: Array<{ path: string; keyword: string; detail: string; compat: string }>;
  truncated?: boolean;
  omitted?: number;
  detail?: string;
};

async function runTool(before: unknown, after: unknown): Promise<{ text: string; out: ToolOut }> {
  const input = schemaDiff.inputSchema.parse({ before, after });
  const text = (await schemaDiff.execute(input, {})) as string;
  return { text, out: JSON.parse(text) as ToolOut };
}

describe("a schema nested past MAX_SCHEMA_DEPTH is refused, the same in every process", () => {
  test("at the limit it is diffed; one level past it, refused before it is read", () => {
    const at = diffSchemas(
      itemsChain(MAX_SCHEMA_DEPTH, "string"),
      itemsChain(MAX_SCHEMA_DEPTH, "number"),
    );
    expect(at.changes.map((c) => c.keyword)).toEqual(["type"]);
    const past = itemsChain(MAX_SCHEMA_DEPTH + 1, "string");
    expect(() => diffSchemas(past, { type: "string" })).toThrow(
      `\`before\` nests deeper than ${MAX_SCHEMA_DEPTH} levels, the most SchemaDiff compares — diff the nested part on its own`,
    );
    expect(() => diffSchemas({ type: "string" }, past)).toThrow(
      `\`after\` nests deeper than ${MAX_SCHEMA_DEPTH} levels`,
    );
    // Any object or array counts, an annotation's value included.
    const deepDefault = { type: "array", default: itemsChain(MAX_SCHEMA_DEPTH, "x") };
    expect(() => diffSchemas(deepDefault, {})).toThrow("nests deeper than");
  });

  test("a schema far deeper than the stack is refused, not overflowed", async () => {
    // Around ten thousand levels the recursion overflowed, at a depth that
    // moved with how warm the code was. Refused, at any depth, the same way.
    for (const depth of [10_000, 100_000]) {
      const deep = itemsChain(depth, "string");
      expect(() => diffSchemas(deep, deep)).toThrow("`before` nests deeper than");
      await expect(runTool(deep, { type: "string" })).rejects.toThrow("nests deeper than");
    }
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic["items"] = cyclic;
    expect(() => diffSchemas(cyclic, {})).toThrow("nests deeper than");
  });

  test("depth counts every object and array", () => {
    expect(nestsDeeperThan({}, 1)).toBe(false);
    expect(nestsDeeperThan({}, 0)).toBe(true);
    expect(nestsDeeperThan("text", 0)).toBe(false);
    expect(nestsDeeperThan({ a: [{ b: 1 }] }, 3)).toBe(false);
    expect(nestsDeeperThan({ a: [{ b: 1 }] }, 2)).toBe(true);
    // A value shared by two parents is as deep as its deepest place.
    const shared = { x: { y: {} } };
    expect(nestsDeeperThan({ near: shared, far: { more: shared } }, 5)).toBe(false);
    expect(nestsDeeperThan({ near: shared, far: { more: shared } }, 4)).toBe(true);
    expect(nestsDeeperThan({ far: { more: shared }, near: shared }, 4)).toBe(true);
  });
});

describe("SchemaDiff lists changes until their paths reach MAX_LISTED_PATH_CHARS", () => {
  test("one long name over many changed leaves: the rest are counted, not listed", async () => {
    // Every leaf's path starts with the long name, so listing them all made
    // a result the name's length times the leaves: 200 MB from 300 KB.
    const leaves = 100;
    const name = "k".repeat(50_000);
    const side = (type: string) => ({
      properties: {
        [name]: {
          properties: Object.fromEntries(
            Array.from({ length: leaves }, (_, i) => [`p${i}`, { type }]),
          ),
        },
      },
    });
    const before = side("string");
    const after = side("number");
    const { text, out } = await runTool(before, after);
    const input = JSON.stringify({ before, after }).length;
    // Counted in characters: the cap, plus about the input once.
    expect(text.length).toBeLessThanOrEqual(MAX_LISTED_PATH_CHARS + 2 * input);
    const all = diffSchemas(before, after).changes;
    expect(out.counts.breaking).toBe(leaves);
    expect(out.truncated).toBe(true);
    expect(out.changes.length + (out.omitted ?? 0)).toBe(leaves);
    expect(out.changes.length).toBe(Math.floor(MAX_LISTED_PATH_CHARS / (all[0]?.path.length ?? 1)));
    expect(out.changes).toEqual(all.slice(0, out.changes.length));
    expect(out.detail).toBe(
      `${out.omitted} of the ${leaves} changes are not listed: their paths would pass ${MAX_LISTED_PATH_CHARS} characters. The verdict and counts cover every change; diff a nested part on its own to list the rest`,
    );
  });

  test("a schema differing at every level, to the depth limit, is listed whole as before", async () => {
    const nest = (minimum: number) => {
      let node: Record<string, unknown> = { type: "string" };
      for (let i = 0; i < 127; i++) node = { minimum, type: "object", properties: { p: node } };
      return node;
    };
    const { out } = await runTool(nest(1), nest(2));
    expect(Object.keys(out)).toEqual([
      "identical",
      "verdict",
      "backwardCompatible",
      "counts",
      "changes",
      "note",
    ]);
    expect(out.changes).toHaveLength(127);
    expect(out.changes).toEqual(diffSchemas(nest(1), nest(2)).changes);
  });
});

/** A JSON-ish value, from a small pool so that equal values are common. */
function generator(next: () => number) {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const odd = (): unknown => {
    const sparse: unknown[] = [];
    sparse[1] = 1;
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    return pick<unknown>([
      Number.NaN,
      undefined,
      () => 1,
      new Date(0),
      sparse,
      1n,
      Symbol("s"),
      Object.defineProperty({}, "k", { get: () => 1, enumerable: true }),
      cyclic,
      Object.create(null),
      -0,
      Number.POSITIVE_INFINITY,
    ]);
  };
  const value = (depth: number, oddRate: number): unknown => {
    if (next() < oddRate) return odd();
    if (depth <= 0 || next() < 0.45) {
      return pick<unknown>(["a", "", "1", 0, 1, -1, 1.5, true, false, null, "null", "[]"]);
    }
    if (next() < 0.5) {
      return Array.from({ length: Math.floor(next() * 3) }, () => value(depth - 1, oddRate));
    }
    const out: Record<string, unknown> = {};
    for (let i = Math.floor(next() * 3); i > 0; i--) {
      out[pick(["x", "y", "z", "__proto__"])] = value(depth - 1, oddRate);
    }
    return out;
  };
  return { pick, value };
}

describe("the shape index answers as deepEqual does", () => {
  test("equal and key agree with deepEqual on generated values", () => {
    const next = rng(0x5ba9e001);
    const { value } = generator(next);
    let indexed = 0;
    let equalPairs = 0;
    const differ: string[] = [];
    for (let round = 0; round < 20_000; round++) {
      const oddRate = round % 4 === 0 ? 0.08 : 0;
      const pool = Array.from({ length: 4 }, () => value(3, oddRate));
      const a = pool[Math.floor(next() * 4)];
      const b = next() < 0.3 ? structuredCopy(a) : pool[Math.floor(next() * 4)];
      const index = indexShapes([a, b]);
      const expected = deepEqual(a, b);
      if (expected) equalPairs++;
      if (index.equal(a, b) !== expected) differ.push(`equal ${round}`);
      const keys = [index.key(a), index.key(b)];
      if (keys[0] !== undefined && keys[1] !== undefined) {
        indexed++;
        if ((keys[0] === keys[1]) !== expected) differ.push(`key ${round}`);
      }
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(indexed).toBeGreaterThan(12_000);
    expect(equalPairs).toBeGreaterThan(6_000);
  }, 20_000);

  test("values deepEqual does not compare by JSON shape leave nothing indexed", () => {
    const sparse: unknown[] = [];
    sparse[2] = 1;
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    for (const odd of [
      Number.NaN,
      () => 1,
      Symbol("s"),
      new Date(0),
      sparse,
      cyclic,
      Object.defineProperty({}, "k", { get: () => 1, enumerable: true }),
    ]) {
      expect(indexShapes([{ enum: [1, { x: [odd] }] }])).toBe(UNINDEXED);
    }
    // NaN equals nothing, so it cannot be looked up; -0 equals 0.
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(false);
    const signs = indexShapes([[0], [-0]]);
    expect(signs.key(0)).toBe(signs.key(-0));
  });

  test("enum diffs list the values deepEqual would", () => {
    const next = rng(0x5ba9e002);
    const { value } = generator(next);
    const differ: string[] = [];
    let listed = 0;
    let refused = 0;
    for (let round = 0; round < 5_000; round++) {
      const oddRate = round % 5 === 0 ? 0.05 : 0;
      const pool = Array.from({ length: 6 }, () => value(2, oddRate));
      const draw = () =>
        Array.from({ length: Math.floor(next() * 7) }, () =>
          next() < 0.7
            ? pool[Math.floor(next() * 6)]
            : structuredCopy(pool[Math.floor(next() * 6)]),
        );
      const aEnum = draw();
      const bEnum = draw();
      // A cycle nests without end, so it is refused; only a caller's own
      // value can hold one, never JSON.
      if (
        nestsDeeperThan({ enum: aEnum }, MAX_SCHEMA_DEPTH) ||
        nestsDeeperThan({ enum: bEnum }, MAX_SCHEMA_DEPTH)
      ) {
        refused++;
        expect(() => diffSchemas({ enum: aEnum }, { enum: bEnum })).toThrow("nests deeper than");
        continue;
      }
      const removed = aEnum.filter((v) => !bEnum.some((w) => deepEqual(v, w)));
      const added = bEnum.filter((v) => !aEnum.some((w) => deepEqual(v, w)));
      listed += removed.length + added.length;
      let expected: string[];
      try {
        expected = [
          ...(removed.length > 0 ? [`enum values removed: ${preview(removed, 80)}`] : []),
          ...(added.length > 0 ? [`enum values added: ${preview(added, 80)}`] : []),
        ];
      } catch (err) {
        // A value with no string form, which the report cannot print either.
        expected = [`threw ${(err as Error).name}`];
      }
      let got: string[];
      try {
        got = diffSchemas({ enum: aEnum }, { enum: bEnum })
          .changes.filter((c) => c.keyword === "enum")
          .map((c) => c.detail);
      } catch (err) {
        got = [`threw ${(err as Error).name}`];
      }
      if (JSON.stringify(got) !== JSON.stringify(expected)) differ.push(`round ${round}`);
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(listed).toBeGreaterThan(5_000);
    expect(refused).toBeLessThan(100);
  }, 20_000);
});

/** A copy with the same JSON shape and fresh identities, where one can be made. */
function structuredCopy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.keys(value).length === value.length ? value.map(structuredCopy) : value;
  }
  if (typeof value === "object" && value !== null) {
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (property === undefined || !("value" in property)) return value;
      if (property.value === value) return value;
      out[key] = structuredCopy(property.value);
    }
    return out;
  }
  return value;
}
