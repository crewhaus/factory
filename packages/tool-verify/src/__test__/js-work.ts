/**
 * The work a reader does outside its regular expressions, counted.
 *
 * 0.7.0's Markdown readers were quadratic without a pattern to blame: a
 * link's line came from copying the text up to it and splitting the copy,
 * and each hit was tested against every code span with `some` and every
 * sentence with `find`. So while `body` runs:
 *
 *   - the string methods that copy or search count the characters they copy
 *     or search (`slice`, `substring`, `substr`, `split` on a string,
 *     `indexOf`, `lastIndexOf`, `includes`);
 *   - the ones that read one character count one (`charAt`, `charCodeAt`,
 *     `codePointAt`, `at`);
 *   - the array searches count the elements they visit (`indexOf`,
 *     `lastIndexOf`, `includes`, `some`, `every`, `find`, `findIndex`,
 *     `findLast`, `findLastIndex`, `filter`);
 *   - and an array's or a string's iterator counts every element it hands
 *     out, which is what a `for…of`, a spread, `Array.from` or a
 *     destructuring visits.
 *
 * Past `limit` the next one throws instead of running, so a quadratic reader
 * fails a test at once. Every original is put back before this returns.
 *
 * What it cannot see is a property read: a loop that indexes by hand
 * (`text[i]`, `items[i]`) or walks a Map or a Set is not counted. So the
 * bound holds for the ways these readers, and 0.7.0's, read text and lists,
 * not for any loop someone could write.
 *
 * The same file is in tool-code and tool-verify; keep the copies in step.
 */

type Method = (this: unknown, ...args: unknown[]) => unknown;
type Methods = Record<string, Method>;

export type JsWork<T> = {
  /** What `body` returned; undefined when it was stopped past the limit. */
  readonly value: T | undefined;
  /** Characters copied or searched plus elements visited; Infinity past the limit. */
  readonly work: number;
};

type Counter = { work: number; over: boolean; readonly limit: number };

const OVER = Symbol("over the work limit");

function charge(counter: Counter, n: number): void {
  if (counter.over) throw OVER;
  counter.work += n;
  if (counter.work > counter.limit) {
    counter.over = true;
    throw OVER;
  }
}

/** Where `next` lives for every array iterator, and for every string iterator. */
const ITERATORS = [
  Object.getPrototypeOf([][Symbol.iterator]()),
  Object.getPrototypeOf(""[Symbol.iterator]()),
] as Methods[];

function install(counter: Counter): () => void {
  const strings = String.prototype as unknown as Methods;
  const arrays = Array.prototype as unknown as Methods;
  const saved: Array<{ target: Methods; name: string; real: Method }> = [];
  const wrap = (target: Methods, name: string, make: (real: Method) => Method): void => {
    const real = target[name] as Method;
    saved.push({ target, name, real });
    target[name] = make(real);
  };
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
  for (const name of ["indexOf", "lastIndexOf", "includes"]) {
    wrap(
      strings,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          charge(counter, String(this).length);
          return real.apply(this, args);
        },
    );
    wrap(
      arrays,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          charge(counter, (this as unknown[]).length);
          return real.apply(this, args);
        },
    );
  }
  for (const name of [
    "some",
    "every",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "filter",
  ]) {
    wrap(
      arrays,
      name,
      (real) =>
        function (this: unknown, fn: unknown, thisArg?: unknown) {
          const visit = fn as Method;
          return real.call(this, (...args: unknown[]) => {
            charge(counter, 1);
            return visit.apply(thisArg, args);
          });
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

function result<T>(counter: Counter, value: T | undefined): JsWork<T> {
  return counter.over
    ? { value: undefined, work: Number.POSITIVE_INFINITY }
    : { value, work: counter.work };
}

/** Run `body`, counting its string and array work; stop it past `limit`. */
export function jsWork<T>(limit: number, body: () => T): JsWork<T> {
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

/** {@link jsWork} for an asynchronous body, counted until it settles. */
export async function jsWorkAsync<T>(limit: number, body: () => Promise<T>): Promise<JsWork<T>> {
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
