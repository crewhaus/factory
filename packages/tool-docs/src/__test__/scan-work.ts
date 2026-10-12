/**
 * The work a hand-written scan does, counted.
 *
 * The text extractors' linear passes are loops over the string methods, so
 * while `body` runs each of those is charged the characters it reads:
 *
 *   - a search (`indexOf`, `lastIndexOf`, `includes`) what it really reads,
 *     from where it starts to where it finds, or to the end of the string
 *     when it finds nothing. Not the string's length: a scan that resumes
 *     each search where the last one stopped reads every character about
 *     once, and one that searches again from the same place, as a quadratic
 *     scan does, is charged for every pass;
 *   - a one-character read (`charAt`, `charCodeAt`, `codePointAt`, `at`) one;
 *   - a copy (`slice`, `substring`, `substr`) what it hands back, and a split
 *     on a string the string it splits;
 *   - a string's or an array's iterator every element it hands out, which
 *     is what a `for…of` or a spread visits.
 *
 * Past `limit` the next one throws instead of running, so a scan that
 * rereads its input fails a test at once rather than after the minutes it
 * would take. Every original is put back before this returns.
 *
 * What it cannot see is a property read (`text[i]`), a `Map`, or the work
 * inside a method it does not wrap (`trim`, `join`). A regular expression's
 * backtracking is regex-work.ts's to count.
 */

type Method = (this: unknown, ...args: unknown[]) => unknown;
type Methods = Record<string, Method>;

export type ScanWork<T> = {
  /** What `body` returned; undefined when it was stopped past the limit. */
  readonly value: T | undefined;
  /** Characters read, copied or searched plus elements visited; Infinity past the limit. */
  readonly work: number;
};

type Counter = { work: number; over: boolean; readonly limit: number };

const OVER = Symbol("over the work limit");

/** Where `next` lives for every array iterator, and for every string iterator. */
const ITERATORS = [
  Object.getPrototypeOf([][Symbol.iterator]()),
  Object.getPrototypeOf(""[Symbol.iterator]()),
] as Methods[];

const realIndexOf = String.prototype.indexOf;
const realLastIndexOf = String.prototype.lastIndexOf;

function charge(counter: Counter, n: number): void {
  if (counter.over) throw OVER;
  counter.work += Math.max(1, n);
  if (counter.work > counter.limit) {
    counter.over = true;
    throw OVER;
  }
}

/** A position argument as the string methods read it, clamped to `[0, length]`. */
function position(value: unknown, length: number, missing: number): number {
  if (value === undefined) return missing;
  const n = Math.trunc(Number(value));
  if (Number.isNaN(n)) return missing;
  return Math.min(Math.max(n, 0), length);
}

function install(counter: Counter): () => void {
  const strings = String.prototype as unknown as Methods;
  const saved: Array<{ target: Methods; name: string; real: Method }> = [];
  const wrap = (target: Methods, name: string, make: (real: Method) => Method): void => {
    const real = target[name] as Method;
    saved.push({ target, name, real });
    target[name] = make(real);
  };
  // A forward search reads from its start to the end of what it finds.
  const forward = function (this: unknown, search: unknown, from?: unknown): number {
    const text = String(this);
    const needle = String(search);
    const start = position(from, text.length, 0);
    const found = realIndexOf.call(text, needle, start);
    charge(counter, (found === -1 ? text.length - start : found - start) + needle.length);
    return found;
  };
  wrap(strings, "indexOf", () => forward);
  wrap(
    strings,
    "includes",
    () =>
      function (this: unknown, search: unknown, from?: unknown) {
        return forward.call(this, search, from) !== -1;
      },
  );
  // A backward search reads from its start down to what it finds.
  wrap(
    strings,
    "lastIndexOf",
    () =>
      function (this: unknown, search: unknown, from?: unknown) {
        const text = String(this);
        const needle = String(search);
        const start = position(from, text.length, text.length);
        const found = realLastIndexOf.call(text, needle, start);
        charge(counter, (found === -1 ? start : start - found) + needle.length);
        return found;
      },
  );
  for (const name of ["slice", "substring", "substr"]) {
    wrap(
      strings,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          const out = real.apply(this, args) as string;
          charge(counter, out.length);
          return out;
        },
    );
  }
  wrap(
    strings,
    "split",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        // A pattern separator is the regular expressions' to count.
        if (typeof args[0] === "string") charge(counter, String(this).length);
        return real.apply(this, args);
      },
  );
  for (const name of ["charAt", "charCodeAt", "codePointAt", "at"]) {
    wrap(
      strings,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          charge(counter, 1);
          return real.apply(this, args);
        },
    );
  }
  // The iterators last, and by index from here on: a `for…of` over an array
  // would run through the one it just wrapped, and be counted.
  for (let i = 0; i < ITERATORS.length; i++) {
    wrap(
      ITERATORS[i] as Methods,
      "next",
      (real) =>
        function (this: unknown) {
          const out = real.call(this) as IteratorResult<unknown>;
          if (out.done !== true) charge(counter, 1);
          return out;
        },
    );
  }
  return () => {
    for (let i = saved.length - 1; i >= 0; i--) {
      const { target, name, real } = saved[i] as (typeof saved)[number];
      target[name] = real;
    }
  };
}

function result<T>(counter: Counter, value: T | undefined): ScanWork<T> {
  return counter.over
    ? { value: undefined, work: Number.POSITIVE_INFINITY }
    : { value, work: counter.work };
}

/** Run `body`, counting the characters its string methods read; stop it past `limit`. */
export function scanWork<T>(limit: number, body: () => T): ScanWork<T> {
  const counter: Counter = { work: 0, over: false, limit };
  const restore = install(counter);
  let value: T | undefined;
  try {
    value = body();
  } catch (err) {
    if (err !== OVER) throw err;
  } finally {
    restore();
  }
  return result(counter, value);
}

/** {@link scanWork} for an asynchronous body, counted until it settles. */
export async function scanWorkAsync<T>(
  limit: number,
  body: () => Promise<T>,
): Promise<ScanWork<T>> {
  const counter: Counter = { work: 0, over: false, limit };
  const restore = install(counter);
  let value: T | undefined;
  try {
    value = await body();
  } catch (err) {
    if (err !== OVER) throw err;
  } finally {
    restore();
  }
  return result(counter, value);
}
