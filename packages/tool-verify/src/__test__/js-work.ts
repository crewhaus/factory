/**
 * The work a reader does outside its regular expressions, counted.
 *
 * 0.7.0's Markdown readers were quadratic without a pattern to blame: a
 * link's line came from copying the text up to it and splitting the copy,
 * and each hit was tested against every code span with `some` and every
 * sentence with `find`. So while `body` runs, the string methods count the
 * characters they copy or search (`slice`, `substring`, `substr`, `split` on
 * a string, `indexOf`, `lastIndexOf`, `includes`), and the array methods
 * count the elements they visit (`indexOf`, `lastIndexOf`, `includes`,
 * `some`, `every`, `find`, `findIndex`, `findLast`, `findLastIndex`,
 * `filter`). Past `limit` the next one throws instead of running, so a
 * quadratic reader fails a test at once. Every original is put back before
 * this returns, and a loop written by hand is not seen: this counts the
 * spellings 0.7.0 used and their near neighbours.
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

function install(counter: Counter): () => void {
  const strings = String.prototype as unknown as Methods;
  const arrays = Array.prototype as unknown as Methods;
  const saved: Array<[Methods, string, Method]> = [];
  const wrap = (target: Methods, name: string, make: (real: Method) => Method): void => {
    const real = target[name] as Method;
    saved.push([target, name, real]);
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
  return () => {
    for (const [target, name, real] of saved.reverse()) target[name] = real;
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
