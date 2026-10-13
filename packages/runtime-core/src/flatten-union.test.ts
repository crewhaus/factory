/**
 * A top-level union is flattened in one pass over its branches.
 *
 * `flattenUnionToObject` runs at every `runChatLoop` setup over each tool
 * whose schema is a top-level union — an MCP server's schema among them, up
 * to 32 KiB. It kept each property's distinct shapes by comparing a new one
 * with every one kept so far as JSON, and intersected the `required` lists
 * by searching each branch's list once per name still in the intersection.
 * At the 32 KiB cap that was 880 000 `JSON.stringify` calls for 939
 * branches of one key, and 4.8 million elements visited for two branches
 * sharing a required list of 2 184 names. Both are set lookups now; the
 * schema is the same, and a shape JSON cannot represent throws at the same
 * point.
 *
 * Counted, never timed: `JSON.stringify` calls, and tool-code's
 * __test__/js-work.ts, which charges a `some` or `filter` callback, an
 * array's `includes` for the whole array, and every element an array
 * iterator hands out.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { type JsonSchemaLike, flattenUnionToObject } from "./flatten-union";

/** The cap tool-mcp puts on an input schema, as JSON. */
const MAX_MCP_SCHEMA_CHARS = 32 * 1024;

/** `body`, with the `JSON.stringify` calls it makes. */
function stringified<T>(body: () => T): { value: T; calls: number } {
  const real = JSON.stringify;
  const count = { calls: 0 };
  // No spread here: js-work would count its iterator.
  JSON.stringify = ((value: unknown, replacer?: never, space?: string | number) => {
    count.calls += 1;
    return real(value, replacer, space);
  }) as typeof JSON.stringify;
  try {
    return { value: body(), ...count };
  } finally {
    JSON.stringify = real;
  }
}

/** The largest `make(n)` that fits under the cap, and its n. */
function atTheCap(make: (n: number) => { anyOf: JsonSchemaLike[] }): {
  n: number;
  branches: JsonSchemaLike[];
} {
  let lo = 1;
  let hi = 100_000;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (JSON.stringify(make(mid)).length <= MAX_MCP_SCHEMA_CHARS) lo = mid;
    else hi = mid - 1;
  }
  return { n: lo, branches: make(lo).anyOf };
}

/** The flattening as it was, for comparison. */
function oldFlatten(branches: JsonSchemaLike[], baseProps: Record<string, unknown> | undefined) {
  const perKey = new Map<string, unknown[]>();
  const requiredSets: string[][] = [];
  for (const b of branches) {
    for (const [k, v] of Object.entries(b.properties ?? {})) {
      const seen = perKey.get(k) ?? [];
      if (!seen.some((e) => JSON.stringify(e) === JSON.stringify(v))) seen.push(v);
      perKey.set(k, seen);
    }
    requiredSets.push(Array.isArray(b.required) ? (b.required as string[]) : []);
  }
  const properties: Record<string, unknown> = { ...(baseProps ?? {}) };
  for (const [k, variants] of perKey) {
    properties[k] = variants.length === 1 ? variants[0] : { anyOf: variants };
  }
  const required =
    requiredSets.length > 0
      ? requiredSets.reduce((acc, r) => acc.filter((x) => r.includes(x)))
      : [];
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

describe("flattenUnionToObject at the MCP schema cap", () => {
  test("hundreds of branches, each one more shape of one property", () => {
    const { n, branches } = atTheCap((m) => ({
      anyOf: Array.from({ length: m }, (_, i) => ({ properties: { a: { const: i } } })),
    }));
    expect(n).toBeGreaterThan(900);
    const run = stringified(() => jsWork(8 * n, () => flattenUnionToObject(branches, undefined)));
    // One JSON form a shape, where each new shape met every kept one.
    expect(run.calls).toBeLessThanOrEqual(n + 1);
    // Elements iterated, about 4 a branch.
    expect(run.value.work).toBeLessThanOrEqual(8 * n);
    expect((run.value.value?.properties["a"] as { anyOf: unknown[] }).anyOf).toHaveLength(n);
  });

  test("two branches sharing a required list of thousands of names", () => {
    const { n, branches } = atTheCap((m) => {
      const names = Array.from({ length: m }, (_, i) => `k${i}`);
      return { anyOf: [{ required: names }, { required: [...names].reverse() }] };
    });
    expect(n).toBeGreaterThan(2_000);
    const run = jsWork(8 * n, () => flattenUnionToObject(branches, undefined));
    expect(run.work).toBeLessThanOrEqual(8 * n);
    expect(run.value?.required).toHaveLength(n);
  });
});

describe("the schema is the one comparing every pair made", () => {
  test("generated unions, with shapes JSON cannot represent", () => {
    const state = { seed: 0xf1a70001 };
    const next = () => {
      state.seed = (state.seed + 0x6d2b79f5) | 0;
      let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const shape = (): unknown =>
      next() < 0.05
        ? pick<unknown>([1n, undefined, () => 1])
        : pick<unknown>([
            { type: "string" },
            { type: "number" },
            { const: pick([1, 2, "a"]) },
            { type: "string", enum: ["x", "y"] },
            { enum: ["y", "x"], type: "string" },
            true,
            null,
          ]);
    const outcome = (f: () => unknown): string => {
      try {
        return JSON.stringify(f(), (_k, v) => (v === undefined ? "<undefined>" : v));
      } catch (err) {
        return `threw ${(err as Error).name}: ${(err as Error).message}`;
      }
    };
    const differ: string[] = [];
    let threw = 0;
    for (let round = 0; round < 20_000; round++) {
      const branches: JsonSchemaLike[] = Array.from({ length: Math.floor(next() * 6) }, () => {
        if (next() < 0.03) return null as unknown as JsonSchemaLike;
        const properties: Record<string, unknown> = {};
        for (let i = Math.floor(next() * 4); i > 0; i--)
          properties[pick(["a", "b", "c"])] = shape();
        const required =
          next() < 0.7
            ? Array.from({ length: Math.floor(next() * 4) }, () => pick(["a", "b", "c", "d"]))
            : "a";
        return { properties, required };
      });
      const base = next() < 0.3 ? { z: { type: "boolean" } } : undefined;
      const expected = outcome(() => oldFlatten(branches, base));
      if (expected.startsWith("threw")) threw++;
      if (outcome(() => flattenUnionToObject(branches, base)) !== expected)
        differ.push(String(round));
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(threw).toBeGreaterThan(500);
  }, 20_000);
});
