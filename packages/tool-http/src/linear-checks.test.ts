/**
 * HttpWaitFor's `contains` compared every item of a response array with the
 * predicate's value, and sorted that value's keys again for each item: the
 * items times the model's predicate, on every poll. The predicate's keys are
 * sorted once per check now, and an item with a different number of keys is
 * no match before anything is sorted.
 *
 * Checked against the code it replaced, restated here, on generated inputs.
 * The work is counted, never timed: `keyWork` counts the keys read and
 * sorted and the callbacks run.
 *
 * A test that walks many generated inputs declares a budget, as the house
 * does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { type FieldPredicate, matchesPredicate, readPath } from "./lib/jsonpath";

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

/** What `body` returned, or the name of what it threw. */
function outcome(body: () => unknown): string {
  try {
    return `returned ${JSON.stringify(body())}`;
  } catch (err) {
    return `threw ${(err as Error).name}`;
  }
}

type Method = (this: unknown, ...args: unknown[]) => unknown;
type Methods = Record<string, Method>;

/** Put a method back when the meter is done. */
type Saved = Array<{ target: Methods; name: string; real: Method }>;

function wrap(saved: Saved, target: Methods, name: string, make: (real: Method) => Method): void {
  const real = target[name] as Method;
  saved.push({ target, name, real });
  target[name] = make(real);
}

function restore(saved: Saved): void {
  for (let i = saved.length - 1; i >= 0; i--) {
    const { target, name, real } = saved[i] as Saved[number];
    target[name] = real;
  }
}

/**
 * The keys `body` reads and sorts, and the callbacks it runs: `Object.keys`
 * is charged the keys it returns, `Array#sort` the elements it sorts, and
 * `some` and `every` each element they visit.
 */
function keyWork<T>(body: () => T): { value: T; work: number } {
  const tally = { work: 0 };
  const saved: Saved = [];
  const objects = Object as unknown as Methods;
  const arrays = Array.prototype as unknown as Methods;
  wrap(
    saved,
    objects,
    "keys",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        const out = real.apply(this, args) as string[];
        tally.work += out.length;
        return out;
      },
  );
  wrap(
    saved,
    arrays,
    "sort",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        tally.work += (this as unknown[]).length;
        return real.apply(this, args);
      },
  );
  for (const name of ["some", "every"]) {
    wrap(
      saved,
      arrays,
      name,
      (real) =>
        function (this: unknown, fn: unknown, thisArg?: unknown) {
          return real.call(this, (...args: unknown[]) => {
            tally.work += 1;
            return (fn as Method).apply(thisArg, args);
          });
        },
    );
  }
  try {
    return { value: body(), work: tally.work };
  } finally {
    restore(saved);
  }
}

// ---------------------------------------------------------------------------
// The code as it was.

function oldSameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => oldSameValue(item, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).sort();
  const bk = Object.keys(bo).sort();
  return (
    ak.length === bk.length &&
    ak.every((k, i) => k === bk[i]) &&
    ak.every((k) => oldSameValue(ao[k], bo[k]))
  );
}

function oldMatchesPredicate(body: unknown, predicate: FieldPredicate): boolean {
  const actual = readPath(body, predicate.path);
  switch (predicate.op) {
    case "exists":
      return actual !== undefined;
    case "equals":
      return oldSameValue(actual, predicate.value);
    case "notEquals":
      return !oldSameValue(actual, predicate.value);
    case "contains": {
      if (typeof actual === "string") return actual.includes(String(predicate.value));
      if (Array.isArray(actual)) return actual.some((item) => oldSameValue(item, predicate.value));
      return false;
    }
    case "gte":
      return typeof actual === "number" && typeof predicate.value === "number"
        ? actual >= predicate.value
        : false;
    case "lte":
      return typeof actual === "number" && typeof predicate.value === "number"
        ? actual <= predicate.value
        : false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// HttpWaitFor's predicate.

describe("a predicate's value is compared with each item at the item's own cost", () => {
  test("contains over N empty items with a K-key value, N and K doubling", () => {
    const measured = [2_000, 4_000].map((n) => {
      const body = { items: Array.from({ length: n }, () => ({})) };
      const value = Object.fromEntries(Array.from({ length: n }, (_, k) => [`k${k}`, k]));
      const chars = JSON.stringify(body).length + JSON.stringify(value).length;
      const run = keyWork(() => matchesPredicate(body, { path: "items", op: "contains", value }));
      expect(run.value).toBe(false);
      // The value's keys once, read and sorted, and one call per item.
      expect(run.work).toBeLessThanOrEqual(4 * chars);
      return run.work;
    });
    expect((measured[1] as number) / (measured[0] as number)).toBeLessThan(2.4);
  });

  test("contains over items as wide as the value, one of them equal", () => {
    const measured = [200, 400].map((n) => {
      const keys = Array.from({ length: n }, (_, k) => `k${k}`);
      const items = Array.from({ length: n }, (_, i) =>
        Object.fromEntries(keys.map((key, k) => [key, k === i ? -1 : k])),
      );
      // Equal to the last item, its keys written in the other order.
      const value = Object.fromEntries(
        [...keys].reverse().map((key) => [key, key === `k${n - 1}` ? -1 : Number(key.slice(1))]),
      );
      const body = { items };
      const chars = JSON.stringify(body).length + JSON.stringify(value).length;
      const run = keyWork(() => matchesPredicate(body, { path: "items", op: "contains", value }));
      expect(run.value).toBe(true);
      // Each item's keys are read and sorted, and compared until one differs.
      expect(run.work).toBeLessThanOrEqual(4 * chars);
      return run.work;
    });
    // The response is n × n: doubling n is four times the input.
    expect((measured[1] as number) / (measured[0] as number)).toBeLessThan(4.8);
  });

  test("matchesPredicate answers what it answered, on generated bodies and predicates", () => {
    const next = rng(0x5eed2001);
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(next() * xs.length)] as T;
    const keys = ["a", "b", "c", "1", "10", "2", "__proto__", "constructor", "x.y", ""];
    const scalars: unknown[] = [null, true, false, 0, -0, 1, 1.5, -2, Number.NaN, "", "a", "b"];
    const value = (depth: number): unknown => {
      const r = next();
      if (depth > 2 || r < 0.45) return pick(scalars);
      if (r < 0.7) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1));
      // Through JSON.parse, which makes `__proto__` an own key.
      const members = Array.from({ length: Math.floor(next() * 4) }, () => [
        pick(keys),
        value(depth + 1),
      ]);
      return JSON.parse(
        `{${members.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v) ?? "null"}`).join(",")}}`,
      );
    };
    /** A copy with every object's keys in another order: equal, by these rules. */
    const shuffled = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(shuffled);
      if (v === null || typeof v !== "object") return v;
      const entries = Object.entries(v as Record<string, unknown>).sort(() => next() - 0.5);
      return JSON.parse(
        `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${JSON.stringify(shuffled(x)) ?? "null"}`).join(",")}}`,
      );
    };
    const ops: Array<FieldPredicate["op"]> = [
      "exists",
      "equals",
      "notEquals",
      "contains",
      "contains",
      "contains",
      "gte",
      "lte",
    ];
    const paths = ["items", "items[0]", "items[-1]", "x", "x.a", 'x["x.y"]', "nope"];
    const differ: string[] = [];
    const seen = { true: 0, false: 0, containsTrue: 0 };
    for (let n = 0; n < 20_000; n++) {
      const items = Array.from({ length: Math.floor(next() * 6) }, () => value(1));
      const body = { items, x: value(0) };
      const op = pick(ops);
      const path = pick(paths);
      const found = readPath(body, path);
      const r = next();
      const predicateValue =
        r < 0.35 && items.length > 0
          ? shuffled(pick(items))
          : r < 0.5
            ? shuffled(found)
            : r < 0.55
              ? (found as unknown)
              : value(0);
      const predicate = { path, op, value: predicateValue };
      const was = outcome(() => oldMatchesPredicate(body, predicate));
      if (was === "returned true") seen.true++;
      if (was === "returned false") seen.false++;
      if (was === "returned true" && op === "contains") seen.containsTrue++;
      const now = outcome(() => matchesPredicate(body, predicate));
      if (now !== was) differ.push(`${JSON.stringify({ body, predicate })} ${was} ${now}`);
    }
    expect(differ.slice(0, 3)).toEqual([]);
    expect(Math.min(seen.true, seen.false)).toBeGreaterThan(1_000);
    expect(seen.containsTrue).toBeGreaterThan(300);
  }, 20_000);
});
