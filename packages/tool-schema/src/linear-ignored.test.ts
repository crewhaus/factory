/**
 * The paths `ignorePaths` matched, and the arrays compared positionally, are
 * listed in one pass.
 *
 * `compareValues` checked each ignored path against every path it had listed
 * so far: quadratic in the ignored paths of one comparison. CompareGolden
 * takes the model's JSON with no size cap, and `/*` over an object of many
 * keys is the ordinary way to ignore them. With `ignoreArrayOrder`, each
 * array too long to match unordered was checked the same way against the
 * ones listed before it. A set now answers "listed already?" for both, and
 * each list comes back in the same order.
 *
 * The work is counted with tool-code's __test__/js-work.ts, which charges an
 * array's `includes` for the whole array, never timed.
 */
import { describe, expect, test } from "bun:test";
import { jsWork } from "../../tool-code/src/__test__/js-work";
import { UNORDERED_ARRAY_LIMIT, compareValues } from "./lib/compare";

/** Elements visited and characters copied per ignored path; about 12 here. */
const WORK_PER_PATH = 32;

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

const keys = (k: number) => Array.from({ length: k }, (_, i) => `k${String(i).padStart(5, "0")}`);

describe("compareValues lists ignored paths in one pass", () => {
  test("thousands of keys, missing on one side and extra on the other, all ignored", () => {
    const measured = [4_000, 8_000].map((k) => {
      const names = keys(k);
      const expected = Object.fromEntries(names.map((n) => [n, 1]));
      const actual = Object.fromEntries(names.map((n) => [`${n}x`, 1]));
      const run = jsWork(WORK_PER_PATH * 2 * k, () =>
        compareValues(actual, expected, { ignorePaths: ["/*"] }),
      );
      return { names, run };
    });
    for (const { names, run } of measured) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_PATH * 2 * names.length);
      expect(run.value?.equal).toBe(true);
      expect(run.value?.ignored).toEqual([
        ...names.map((n) => `/${n}`),
        ...names.map((n) => `/${n}x`),
      ]);
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("each matched path listed once, in the order the walk met it", () => {
    const next = rng(0x5eed0601);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const value = (depth: number): unknown => {
      const r = Math.floor(next() * (depth <= 0 ? 3 : 5));
      if (r === 0) return Math.floor(next() * 3);
      if (r === 1) return pick(["a", "b"]);
      if (r === 2) return null;
      if (r === 3) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth - 1));
      const o: Record<string, unknown> = {};
      for (let i = Math.floor(next() * 5); i > 0; i--)
        o[pick(["id", "a", "b", "ts"])] = value(depth - 1);
      return o;
    };
    let listed = 0;
    for (let n = 0; n < 4_000; n++) {
      const expected = value(3);
      const actual = next() < 0.5 ? value(3) : expected;
      const ignorePaths = [
        pick(["/id", "/*/id", "/**/ts", "/a/*", "/*", "/b/**", "/*/*", "/**/id"]),
      ];
      const options = { ignorePaths, ignoreArrayOrder: next() < 0.3, subset: next() < 0.3 };
      const { ignored } = compareValues(actual, expected, options);
      listed += ignored.length;
      expect(new Set(ignored).size).toBe(ignored.length);
    }
    expect(listed).toBeGreaterThan(1_000);
  }, 20_000);
});

describe("compareValues lists ordered fallbacks in one pass", () => {
  // About 8 an array here.
  const WORK_PER_ARRAY = 24;

  test("thousands of arrays too long to match unordered", () => {
    const measured = [2_000, 4_000].map((m) => {
      const actual = Array.from({ length: m }, () =>
        new Array<number>(UNORDERED_ARRAY_LIMIT + 1).fill(0),
      );
      const expected = Array.from({ length: m }, () => []);
      const run = jsWork(WORK_PER_ARRAY * m, () =>
        compareValues(actual, expected, { ignoreArrayOrder: true, maxDifferences: 1 }),
      );
      return { m, run };
    });
    for (const { m, run } of measured) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_ARRAY * m);
      // The outer array is too long as well, and listed first.
      expect(run.value?.orderedFallbacks).toEqual([
        "",
        ...Array.from({ length: m }, (_, i) => `/${i}`),
      ]);
    }
    const [small, large] = measured as [(typeof measured)[0], (typeof measured)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);
});
