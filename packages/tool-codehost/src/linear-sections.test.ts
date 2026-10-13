/**
 * Closing a GitLab section costs only the entries it closes.
 *
 * `excerptLog` handled a `section_end` by searching the open sections for its
 * name, and a name that was never started visited every open entry and
 * closed none: n starts followed by n such ends cost n². A job's own output
 * prints both, and WorkflowRunLogs reads up to 16 MiB of it. A count of each
 * open name now answers "is it open?" at once, and a close walks only the
 * entries it closes.
 *
 * The work is counted, never timed: while `body` runs, the array searches are
 * charged for the elements they visit, which is how the stack was searched.
 * A loop that indexes by hand is not counted, so the stack itself is also
 * checked against the old search over generated operations.
 */
import { describe, expect, test } from "bun:test";
import { OpenSections, excerptLog } from "./lib/logs";

type Method = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Array elements visited while `body` runs: `indexOf` and `lastIndexOf` from
 * where they start to what they find, `includes` the whole array, and the
 * callback searches one per callback.
 */
function arrayVisits<T>(body: () => T): { value: T; visits: number } {
  const arrays = Array.prototype as unknown as Record<string, Method>;
  const saved: Array<{ name: string; real: Method }> = [];
  const meter = { visits: 0 };
  const wrap = (name: string, make: (real: Method) => Method): void => {
    const real = arrays[name] as Method;
    saved.push({ name, real });
    arrays[name] = make(real);
  };
  wrap(
    "indexOf",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        const at = real.apply(this, args) as number;
        meter.visits += at === -1 ? (this as unknown[]).length : at + 1;
        return at;
      },
  );
  wrap(
    "lastIndexOf",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        const at = real.apply(this, args) as number;
        const length = (this as unknown[]).length;
        meter.visits += at === -1 ? length : length - at;
        return at;
      },
  );
  wrap(
    "includes",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        meter.visits += (this as unknown[]).length;
        return real.apply(this, args);
      },
  );
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
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          const [fn, thisArg] = args as [Method, unknown];
          return real.call(this, (...a: unknown[]) => {
            meter.visits++;
            return fn.apply(thisArg, a);
          });
        },
    );
  }
  try {
    return { value: body(), visits: meter.visits };
  } finally {
    for (const { name, real } of saved.reverse()) arrays[name] = real;
  }
}

const range = (k: number) => Array.from({ length: k }, (_, i) => i);

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

describe("excerptLog closes a section in one pass", () => {
  // About 3.3 a line here: the failure rules tried on each plain line.
  const VISITS_PER_LINE = 8;

  test("thousands of open sections, then as many ends for a name never started", () => {
    const rows = [4_000, 8_000].map((n) => {
      const log = [
        ...range(n).flatMap((i) => [`section_start:1:s${i}`, `working on ${i}`]),
        ...range(n).map(() => "section_end:1:never_started"),
        // Closes s<n/2> and everything opened inside it.
        `section_end:1:s${n / 2}`,
        "##[error]boom",
      ].join("\n");
      return { n, run: arrayVisits(() => excerptLog(log)) };
    });
    for (const { n, run } of rows) {
      const lines = 3 * n + 2;
      expect(run.value.totalLines).toBe(lines);
      expect(run.visits).toBeLessThanOrEqual(VISITS_PER_LINE * lines);
      expect(run.value.annotations).toEqual([
        { level: "error", line: lines, text: "boom", step: `s${n / 2 - 1}` },
      ]);
      expect(run.value.failingStep).toBe(`s${n / 2 - 1}`);
    }
    const [small, large] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(large.run.visits / small.run.visits).toBeLessThan(2.4);
  }, 20_000);
});

describe("OpenSections", () => {
  test("closes the innermost entry of a name and what it holds, and ignores a name not open", () => {
    const open = new OpenSections();
    for (const name of ["a", "b", "a", "c"]) open.push(name);
    open.closeTo("a");
    expect(open.list()).toEqual(["a", "b"]);
    open.closeTo("z");
    expect(open.list()).toEqual(["a", "b"]);
    open.pop();
    expect(open.innermost()).toBe("a");
    open.closeTo("a");
    expect(open.list()).toEqual([]);
    open.closeTo("a");
    open.pop();
    expect(open.innermost()).toBeUndefined();
    open.push("");
    open.closeTo("");
    expect(open.list()).toEqual([]);
  });

  test("agrees with searching the stack, over generated pushes, pops and closes", () => {
    const next = rng(0x5ec710e5);
    const names = ["a", "b", "c", ""];
    let closesThatClosed = 0;
    for (let run = 0; run < 2_000; run++) {
      const model: string[] = [];
      const open = new OpenSections();
      for (let step = Math.floor(next() * 60); step > 0; step--) {
        const op = next();
        const name = names[Math.floor(next() * names.length)] as string;
        if (op < 0.45) {
          model.push(name);
          open.push(name);
        } else if (op < 0.6) {
          model.pop();
          open.pop();
        } else {
          // The search this replaced.
          const index = model.lastIndexOf(name);
          if (index !== -1) {
            model.length = index;
            closesThatClosed++;
          }
          open.closeTo(name);
        }
        expect(open.list()).toEqual(model);
        expect(open.innermost()).toBe(model[model.length - 1]);
      }
    }
    expect(closesThatClosed).toBeGreaterThan(1_000);
  }, 20_000);
});
