/**
 * The work a hand-written scan does, counted.
 *
 * A count test that refuses every regular expression over a run proves no
 * pattern rescans it. It does not prove the scan that replaced the pattern
 * reads the run a bounded number of times: a search that resumes one
 * character on, or a `lastIndexOf` with no lower bound, rescans it just as
 * well. So while `body` runs, the string methods a scan reads with are each
 * charged for what they read:
 *
 *   - `indexOf` and `includes`: from where the search starts to the end of
 *     what it finds, or to the end of the text;
 *   - `lastIndexOf`: from where the search starts back to what it finds, or
 *     to the start of the text;
 *   - `startsWith` and `endsWith`: the characters they compare;
 *   - `slice`, `substring` and `substr`: the characters they copy;
 *   - `split` on a string, `trim`, `trimStart` and `trimEnd`: the text;
 *   - `charAt`, `charCodeAt`, `codePointAt` and `at`: one.
 *
 * Past `limit` the next call throws instead of returning, so a scan that has
 * gone quadratic fails a test at once rather than after the minutes it would
 * take. Every original is put back before this returns.
 *
 * What it cannot see is a property read: a loop that indexes by hand
 * (`text[i]`) is not counted. So a test also checks that the count reaches
 * the length of the run, which a scan that reads the run some other way
 * would not.
 *
 * The same file is in every package whose linear scans a count test holds
 * to it; keep the copies in step.
 */

type Method = (this: unknown, ...args: unknown[]) => unknown;

export type ScanWork<T> = {
  /** What `body` returned; undefined when it was stopped past the limit. */
  readonly value: T | undefined;
  /** Characters read; Infinity past the limit. */
  readonly work: number;
};

const OVER = Symbol("over the work limit");

/* Captured before any wrapper is installed, so the charges read with them. */
const realIndexOf = String.prototype.indexOf;

/** A search position as the search methods read it, clamped to the text. */
function position(value: unknown, fallback: number, length: number): number {
  if (value === undefined) return fallback;
  const n = Math.trunc(Number(value));
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, 0), length);
}

type Cost = (text: string, args: readonly unknown[], out: unknown) => number;

const forward: Cost = (text, args, out) => {
  const from = position(args[1], 0, text.length);
  const found =
    typeof out === "number" ? out : (realIndexOf.call(text, String(args[0]), from) as number);
  return Math.max(1, (found === -1 ? text.length : found + String(args[0]).length) - from);
};

const backward: Cost = (text, args, out) => {
  const from = position(args[1], text.length, text.length);
  const found = out as number;
  return Math.max(
    1,
    Math.min(text.length, from + String(args[0]).length) - (found === -1 ? 0 : found),
  );
};

const COSTS: ReadonlyArray<readonly [string, Cost]> = [
  ["indexOf", forward],
  ["includes", forward],
  ["lastIndexOf", backward],
  ["startsWith", (_text, args) => Math.max(1, String(args[0]).length)],
  ["endsWith", (_text, args) => Math.max(1, String(args[0]).length)],
  ["slice", (_text, _args, out) => (out as string).length],
  ["substring", (_text, _args, out) => (out as string).length],
  ["substr", (_text, _args, out) => (out as string).length],
  // A pattern separator is a regular expression's work, not the scan's.
  ["split", (text, args) => (typeof args[0] === "string" ? text.length : 0)],
  ["trim", (text) => text.length],
  ["trimStart", (text) => text.length],
  ["trimEnd", (text) => text.length],
  ["charAt", () => 1],
  ["charCodeAt", () => 1],
  ["codePointAt", () => 1],
  ["at", () => 1],
];

/** Run `body`, counting the characters its string methods read; stop it past `limit`. */
export function scanWork<T>(limit: number, body: () => T): ScanWork<T> {
  let work = 0;
  let over = false;
  const strings = String.prototype as unknown as Record<string, Method>;
  const saved: Array<readonly [string, Method]> = [];
  for (let i = 0; i < COSTS.length; i++) {
    const [name, cost] = COSTS[i] as (typeof COSTS)[number];
    const real = strings[name] as Method;
    saved.push([name, real]);
    strings[name] = function (this: unknown, ...args: unknown[]) {
      if (over) throw OVER;
      const out = real.apply(this, args);
      work += cost(String(this), args, out);
      if (work > limit) {
        over = true;
        throw OVER;
      }
      return out;
    };
  }
  let value: T | undefined;
  try {
    value = body();
  } catch (err) {
    if (err !== OVER) throw err;
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) {
      const [name, real] = saved[i] as (typeof saved)[number];
      strings[name] = real;
    }
  }
  return over ? { value: undefined, work: Number.POSITIVE_INFINITY } : { value, work };
}
