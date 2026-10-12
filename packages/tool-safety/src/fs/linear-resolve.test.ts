/**
 * The containment walk costs no more than the path and the link texts it
 * meets are long: counted, never timed.
 *
 * Every tool-fs path goes through it (resolveSafe → resolveIn → walk), and
 * so do CopyPath and MovePath, and the path comes from the model. 0.7.1's
 * first walk took each component off the front of its queue, copying the
 * rest, and once a component was missing it joined each further one onto
 * an ever-longer path: Read on a path 8,000 directories below a missing one
 * built 130 million characters.
 *
 * Where a path lands decides containment, so the rewrite is held to the
 * walk it replaced, kept below as the reference, on generated trees.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import {
  type Overlay,
  type PlannedEntry,
  _setPathOpsForTest,
  isWithin,
  physicalFrom,
  physicalPath,
  resolveContained,
} from "./resolve";
import { fixture, posix } from "./test-helpers";

const f = fixture("linear-resolve");
afterAll(() => f.cleanup());
const wsReal = realpathSync(f.ws);
mkdirSync(path.join(wsReal, "real"));

// ---------------------------------------------------------------------------
// the meter
// ---------------------------------------------------------------------------

type Fn = (this: unknown, ...args: unknown[]) => unknown;
type Methods = Record<string, Fn>;

const OVER = Symbol("over the work limit");

const ARRAY_ITERATOR = Object.getPrototypeOf([][Symbol.iterator]()) as Methods;

/**
 * Run `body`, counting the characters the walk's path operations return
 * (through its test seam) and the array work around them: the elements
 * `shift`, `reverse` and `slice` move or copy, the characters `join` and a
 * string `split` produce or read, and each element an array iterator hands
 * out (a spread). Past `limit` the next charge throws, so a quadratic walk
 * stops at once. Every original is put back before this returns.
 */
function walkWork<T>(limit: number, body: () => T): { value: T | undefined; work: number } {
  const counter = { work: 0, over: false };
  const charge = (n: number): void => {
    if (counter.over) throw OVER;
    counter.work += n;
    if (counter.work > limit) {
      counter.over = true;
      throw OVER;
    }
  };
  const saved: Array<{ target: Methods; name: string; real: Fn }> = [];
  const wrap = (target: Methods, name: string, make: (real: Fn) => Fn): void => {
    const real = target[name] as Fn;
    saved.push({ target, name, real });
    target[name] = make(real);
  };
  const arrays = Array.prototype as unknown as Methods;
  for (const name of ["shift", "reverse"]) {
    wrap(
      arrays,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          charge((this as unknown[]).length);
          return real.apply(this, args);
        },
    );
  }
  for (const name of ["slice", "join"]) {
    wrap(
      arrays,
      name,
      (real) =>
        function (this: unknown, ...args: unknown[]) {
          const out = real.apply(this, args) as { length: number };
          charge(out.length);
          return out;
        },
    );
  }
  wrap(
    String.prototype as unknown as Methods,
    "split",
    (real) =>
      function (this: unknown, ...args: unknown[]) {
        charge(String(this).length);
        return real.apply(this, args);
      },
  );
  _setPathOpsForTest({
    join: (...parts: string[]) => {
      const out = path.join(...parts);
      charge(out.length);
      return out;
    },
    dirname: (p: string) => {
      const out = path.dirname(p);
      charge(out.length);
      return out;
    },
  });
  // The iterator last, and everything from here on by index.
  wrap(
    ARRAY_ITERATOR,
    "next",
    (real) =>
      function (this: unknown) {
        const out = real.call(this) as IteratorResult<unknown>;
        if (out.done !== true) charge(1);
        return out;
      },
  );
  let value: T | undefined;
  try {
    value = body();
  } catch (err) {
    if (err !== OVER) throw err;
  } finally {
    for (let i = saved.length - 1; i >= 0; i--) {
      const one = saved[i] as (typeof saved)[number];
      one.target[one.name] = one.real;
    }
    _setPathOpsForTest(undefined);
  }
  return counter.over
    ? { value: undefined, work: Number.POSITIVE_INFINITY }
    : { value, work: counter.work };
}

afterEach(() => _setPathOpsForTest(undefined));

// ---------------------------------------------------------------------------
// counted
// ---------------------------------------------------------------------------

/** At most this much work per character of the path; the rewrite does 3 to 6. */
const PER_CHAR = 12;

describe.if(posix)("the walk is linear in the path", () => {
  const shapes: ReadonlyArray<
    readonly [string, (d: number) => { run: () => unknown; chars: number }]
  > = [
    [
      "a path thousands of directories below a missing one",
      (d) => {
        const abs = path.join(wsReal, "missing", `${"a/".repeat(d)}f`);
        return { run: () => physicalPath(abs), chars: abs.length };
      },
    ],
    [
      "the same path, given relative and contained (every tool-fs path)",
      (d) => {
        const rel = `missing/${"a/".repeat(d)}f`;
        return { run: () => resolveContained(f.ws, rel), chars: wsReal.length + rel.length };
      },
    ],
    [
      "thousands of names below a missing one, then as many '..' back out",
      (d) => {
        const rel = `missing/${"a/".repeat(d)}${"../".repeat(d + 1)}real`;
        return { run: () => physicalFrom(wsReal, rel), chars: wsReal.length + rel.length };
      },
    ],
  ];
  for (const [label, make] of shapes) {
    test(label, () => {
      const counted = [4000, 8000].map((d) => {
        const { run, chars } = make(d);
        const expected = run();
        return { chars, expected, ...walkWork(PER_CHAR * chars, run) };
      });
      for (const { chars, expected, value, work } of counted) {
        expect(value).toEqual(expected);
        expect(work).toBeLessThanOrEqual(PER_CHAR * chars);
        // The path is split and joined at least once: less means the meter
        // no longer sees how the walk reads it.
        expect(work).toBeGreaterThanOrEqual(chars);
      }
      const [small, large] = counted as [(typeof counted)[0], (typeof counted)[0]];
      // Double the depth, double the work, not four times it.
      expect(large.work / small.work).toBeLessThan(2.25);
    }, 20_000);
  }

  test("the landing place is the path as written, however many names are missing", () => {
    // More than 65,535 names below a missing one. Bun's path.join drops
    // arguments past that count without a word, so the tail is joined as
    // one string; spreading it would cut this path short.
    const rel = `missing/${"a/".repeat(70_000)}f`;
    const { value, work } = walkWork(PER_CHAR * (wsReal.length + rel.length), () =>
      physicalFrom(wsReal, rel),
    );
    expect(value).toBe(path.join(wsReal, rel));
    expect(work).toBeLessThanOrEqual(PER_CHAR * (wsReal.length + rel.length));
  }, 20_000);
});

// ---------------------------------------------------------------------------
// old against new
// ---------------------------------------------------------------------------

/** The walk as 0.7.1 first shipped it (052eaf57): the reference every landing place is held to. */
const reference = (() => {
  const SPLIT = path.sep === "/" ? "/" : /[\\/]/;
  const components = (p: string): string[] => p.split(SPLIT).filter((c) => c !== "" && c !== ".");
  const nameExists = (p: string): boolean => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  const walk = (start: string, initial: string[], overlay: Overlay | undefined): string => {
    let cur = start;
    let pending = initial;
    let hops = 0;
    let missing = false;
    while (pending.length > 0) {
      const comp = pending.shift() as string;
      if (comp === "..") {
        cur = path.dirname(cur);
        if (missing) missing = overlay?.has(cur) !== true && !nameExists(cur);
        continue;
      }
      const next = path.join(cur, comp);
      if (missing) {
        cur = next;
        continue;
      }
      let linkText: string | undefined;
      const planned = overlay?.get(next);
      if (planned !== undefined) {
        if (planned.kind === "symlink") linkText = planned.text ?? "";
      } else {
        try {
          if (lstatSync(next).isSymbolicLink()) linkText = readlinkSync(next);
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
          missing = true;
        }
      }
      if (linkText === undefined) {
        cur = next;
        continue;
      }
      hops += 1;
      if (hops > 40)
        throw Object.assign(new Error("more than 40 symbolic links"), { code: "ELOOP" });
      if (path.isAbsolute(linkText)) {
        const root = path.parse(linkText).root;
        cur = root;
        pending = [...components(linkText.slice(root.length)), ...pending];
      } else {
        pending = [...components(linkText), ...pending];
      }
    }
    return cur;
  };
  const physicalPathOld = (
    abs: string,
    options: { overlay?: Overlay; known?: { lexical: string; physical: string } } = {},
  ): string => {
    const known = options.known;
    if (known !== undefined && isWithin(known.lexical, abs)) {
      return walk(known.physical, components(abs.slice(known.lexical.length)), options.overlay);
    }
    const root = path.parse(abs).root;
    return walk(root, components(abs.slice(root.length)), options.overlay);
  };
  const physicalFromOld = (
    dir: string,
    rel: string,
    options: { overlay?: Overlay } = {},
  ): string =>
    path.isAbsolute(rel)
      ? physicalPathOld(rel, options)
      : walk(dir, components(rel), options.overlay);
  return { physicalPath: physicalPathOld, physicalFrom: physicalFromOld };
})();

/** xorshift32: the same cases on every run and every machine. */
function generator(seed: number): () => number {
  const state = { x: seed >>> 0 || 1 };
  return () => {
    state.x ^= state.x << 13;
    state.x >>>= 0;
    state.x ^= state.x >>> 17;
    state.x ^= state.x << 5;
    state.x >>>= 0;
    return state.x / 4294967296;
  };
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The landing place, or the error's code and message: what a caller acts on. */
function outcome(run: () => string): string {
  try {
    return `lands ${run()}`;
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    return `throws ${String(e.code)} ${String(e.message)}`;
  }
}

describe.if(posix)("every landing place is the one the 0.7.1 walk gave", () => {
  test("generated trees: links relative, absolute, dangling and looping, files in the way, '..' and missing names, with and without a plan", () => {
    const random = generator(73);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const NAMES = ["a", "b", "cc", "d.d"];
    const relPath = (depth: number): string =>
      Array.from({ length: 1 + Math.floor(random() * depth) }, () => {
        const roll = random();
        return roll < 0.2
          ? ".."
          : roll < 0.24
            ? "."
            : roll < 0.4
              ? pick(["zz", "nope"])
              : pick(NAMES);
      }).join("/");
    let cases = 0;
    let mismatches = 0;
    let loops = 0;
    let planChanged = 0;
    // Plans asked about a path whose parent does not exist: the one place
    // the rewrite builds a path below a missing name.
    let askedBelowMissing = 0;
    const counted = (plan: Map<string, PlannedEntry>): Overlay =>
      ({
        get: (p: string) => plan.get(p),
        has: (p: string) => {
          const held = plan.has(p);
          if (held && !exists(path.dirname(p))) askedBelowMissing += 1;
          return held;
        },
      }) as unknown as Overlay;
    for (let t = 0; t < 12; t++) {
      const root = path.join(wsReal, `tree${t}`);
      mkdirSync(root);
      const dirs = [""];
      const names = [""];
      for (let i = 0, n = 6 + Math.floor(random() * 26); i < n; i++) {
        const parent = pick(dirs);
        const rel = parent === "" ? pick(NAMES) : `${parent}/${pick(NAMES)}`;
        if (names.includes(rel) || rel.split("/").length > 6) continue;
        const abs = path.join(root, rel);
        const roll = random();
        try {
          if (roll < 0.45) {
            mkdirSync(abs);
            dirs.push(rel);
          } else if (roll < 0.6) {
            writeFileSync(abs, "x");
          } else if (roll < 0.9) {
            symlinkSync(random() < 0.12 ? path.join(root, relPath(4)) : relPath(5), abs);
          } else {
            symlinkSync(path.basename(abs), abs);
          }
          names.push(rel);
        } catch {
          // a name under a link or a file: skipped
        }
      }
      for (let k = 0; k < 250; k++) {
        let overlay: Map<string, PlannedEntry> | undefined;
        const plannedRels: string[] = [];
        if (random() < 0.45) {
          overlay = new Map();
          for (let i = 0, m = 1 + Math.floor(random() * 6); i < m; i++) {
            // Planned below existing names, below missing ones (with no
            // planned parent), and deep.
            const under = random() < 0.5 ? pick(["nope", "zz/nope", pick(names)]) : pick(names);
            const plannedRel = path.join(under, pick(NAMES), random() < 0.5 ? pick(NAMES) : "");
            plannedRels.push(plannedRel);
            const roll = random();
            overlay.set(
              path.join(root, plannedRel),
              roll < 0.55
                ? { kind: "directory" }
                : roll < 0.7
                  ? { kind: "file" }
                  : { kind: "symlink", text: random() < 0.1 ? "" : relPath(4) },
            );
          }
        }
        const options = overlay === undefined ? {} : { overlay };
        // Half the planned cases walk into the plan: down past a planned
        // name, and often back up into it with '..'.
        const rel =
          plannedRels.length > 0 && random() < 0.5
            ? `${pick(plannedRels)}/${pick(NAMES)}/${pick(["..", "../..", "x/../..", ""])}/${relPath(5)}`
            : random() < 0.3
              ? `${pick(["nope", "zz", "nope/x"])}/${relPath(8)}`
              : relPath(9) + (random() < 0.2 ? `/${relPath(9)}` : "");
        const abs = path.join(root, rel);
        const known = { lexical: root, physical: root };
        const pairs: Array<[string, string]> = [
          [
            outcome(() => reference.physicalFrom(root, rel, options)),
            outcome(() =>
              physicalFrom(root, rel, overlay === undefined ? {} : { overlay: counted(overlay) }),
            ),
          ],
          [
            outcome(() => reference.physicalPath(abs, options)),
            outcome(() => physicalPath(abs, options)),
          ],
          [
            outcome(() => reference.physicalPath(abs, { ...options, known })),
            outcome(() => physicalPath(abs, { ...options, known })),
          ],
        ];
        for (const [expected, actual] of pairs) {
          cases += 1;
          if (expected.startsWith("throws ELOOP")) loops += 1;
          if (expected !== actual) mismatches += 1;
        }
        if (
          overlay !== undefined &&
          pairs[0]?.[0] !== outcome(() => reference.physicalFrom(root, rel))
        ) {
          planChanged += 1;
        }
      }
    }
    expect(mismatches).toBe(0);
    expect(cases).toBe(9000);
    // The cases reach link loops and plans that change where a path lands.
    expect(loops).toBeGreaterThan(200);
    expect(planChanged).toBeGreaterThan(40);
    expect(askedBelowMissing).toBeGreaterThan(100);
  }, 60_000);

  test("a '..' below a missing name lands on a directory the plan will create, and follows its planned links", () => {
    // `new` does not exist and is not planned; `new/top` and below are. The
    // walk goes below `new`, comes back up into the plan, and must follow
    // the planned link from there, as the reference does.
    const root = path.join(wsReal, "below");
    mkdirSync(root);
    const overlay: Overlay = new Map<string, PlannedEntry>([
      [path.join(root, "new", "top"), { kind: "directory" }],
      [path.join(root, "new", "top", "out"), { kind: "symlink", text: "../../../.." }],
    ]);
    const rel = "new/top/x/y/../../out/escaped";
    const expected = reference.physicalFrom(root, rel, { overlay });
    expect(expected).toBe(path.join(path.dirname(wsReal), "escaped"));
    expect(physicalFrom(root, rel, { overlay })).toBe(expected);
    // Without the plan the same path stays below the missing name.
    expect(physicalFrom(root, rel)).toBe(path.join(root, "new", "top", "out", "escaped"));
  });
});
