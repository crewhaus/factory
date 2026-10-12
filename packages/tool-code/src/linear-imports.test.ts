/**
 * The import and export scanners try each pattern once per stretch.
 *
 * `import … from "…"` reads a lazy clause up to `from`, and `export {…}` a
 * brace list up to `}`. As global searches, a failed try moved one character
 * right and read the same stretch again from the next `import` or `export`
 * inside it, and the clause tried `\s*from` at every space of a run inside
 * it: quadratic in the stretch's length, on source files from the workspace.
 * Now each is tried only where an `import` or `export` starts, a failed try
 * rules out the starts it would decide the same way, and the clause tries
 * `from` only after a non-blank character; the matches are the old patterns',
 * start for start, checked on generated sources. `/\{([^}]*)\}/` in a clause
 * is two searches.
 *
 * Counted, not timed: while a scan runs, every regular expression run over a
 * string holding a long run is counted by name (source and flags); a name in
 * the refused list, or one called more than MAX_CALLS times, throws. A split
 * calls its pattern once per position it tries, so a split's own pattern is
 * listed as uncapped where the run reaches one.
 */
import { describe, expect, test } from "bun:test";
import {
  EXPORT_FROM_RE,
  EXPORT_LIST_RE,
  STATIC_IMPORT_RE,
  exportFromMatches,
  exportListMatches,
  firstBraced,
  scanExports,
  scanImports,
  staticImportMatches,
} from "./lib/scan";

const MAX_CALLS = 100;
function regexCallsOver<T>(
  run: string,
  body: () => T,
  refused: ReadonlyArray<string>,
  uncapped: ReadonlyArray<string> = [],
): { calls: Map<string, number>; outcome: T | Error } {
  const calls = new Map<string, number>();
  const realExec = RegExp.prototype.exec;
  let last: string | undefined;
  let holds = false;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (input !== last) {
      last = input;
      holds = typeof input === "string" && input.includes(run);
    }
    if (holds) {
      const name = `/${this.source}/${this.flags}`;
      const count = (calls.get(name) ?? 0) + 1;
      calls.set(name, count);
      if (refused.includes(name) || (count > MAX_CALLS && !uncapped.includes(name))) {
        throw new Error(`${name} ran over the run (call ${count})`);
      }
    }
    return realExec.call(this, input);
  };
  try {
    return { calls, outcome: body() };
  } catch (err) {
    return { calls, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

/** Every sequence of up to `max` pieces. */
function allJoins(pieces: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => pieces.map((p) => s + p));
    out.push(...layer);
  }
  return out;
}

// The patterns as they were.
const OLD_IMPORT =
  /\bimport\s+(?<type>type\s+)?(?<clause>[^;'"]*?)\s*from\s*(?<q>['"])(?<spec>[^'"\n]*)\k<q>/g;
const OLD_EXPORT_FROM =
  /\bexport\s+(?<type>type\s+)?(?<clause>\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(?<q>['"])(?<spec>[^'"\n]*)\k<q>/g;
const OLD_EXPORT_LIST =
  /\bexport\s+(?<type>type\s+)?\{(?<body>[^}]*)\}(?<tail>\s*from\s*['"][^'"\n]*['"])?/g;

const shape = (ms: Iterable<RegExpExecArray | RegExpMatchArray>): string =>
  JSON.stringify([...ms].map((m) => [m.index, [...m], m.groups]));

function sameMatches(
  inputs: ReadonlyArray<string>,
  ours: (s: string) => Iterable<RegExpExecArray>,
  old: RegExp,
): void {
  expect(inputs.map((s) => `${JSON.stringify(s)} -> ${shape(ours(s))}`)).toEqual(
    inputs.map((s) => `${JSON.stringify(s)} -> ${shape(s.matchAll(old))}`),
  );
}

const PIECES = [
  "import ",
  "export ",
  "type ",
  "{",
  "}",
  "a",
  " ",
  ",",
  "* as b",
  "from",
  '"x"',
  ";",
  "\n",
];

describe("the matches are the old patterns'", () => {
  const inputs = [
    ...allJoins(PIECES, 4),
    'import a, { b as c, type d } from "./m";',
    'import type { A } from "t"; export { a, b as c } from "./x"; export * as ns from "y";',
    'export { a, export * from "x" }',
    'import import { a } from "x"',
    "export { a } export { b } from 'c'",
  ];

  // Some 30 000 generated sources per pattern: budgeted, as the house does for
  // a test that is slow by construction.
  test("import … from", () => sameMatches(inputs, staticImportMatches, OLD_IMPORT), 20_000);
  test("export … from", () => sameMatches(inputs, exportFromMatches, OLD_EXPORT_FROM), 20_000);
  test("export { … }", () => sameMatches(inputs, exportListMatches, OLD_EXPORT_LIST), 20_000);

  test("firstBraced and /\\{([^}]*)\\}/", () => {
    const braces = [...allJoins(["{", "}", "a", " ", ","], 6), "a, { b, c }", "{{ a }}"];
    expect(braces.map((s) => `${JSON.stringify(s)} -> ${JSON.stringify(firstBraced(s))}`)).toEqual(
      braces.map((s) => {
        const m = /\{([^}]*)\}/.exec(s);
        const found = m === null ? null : { index: m.index, body: m[1] };
        return `${JSON.stringify(s)} -> ${JSON.stringify(found)}`;
      }),
    );
  });
});

describe("a long stretch is tried once", () => {
  const sticky = (re: RegExp): string => `/${re.source}/y`;
  const old = [OLD_IMPORT, OLD_EXPORT_FROM, OLD_EXPORT_LIST].map((re) => `/${re.source}/g`);

  test("a run of spaces inside an import clause", () => {
    const run = " ".repeat(100_000);
    const src = `import { a${run}b, c as d } from "x";\n`;
    const scanned = regexCallsOver(run, () => scanImports(src), old);
    expect(scanned.calls.get(sticky(STATIC_IMPORT_RE))).toBe(1);
    expect(scanned.outcome).toEqual([
      { specifier: "x", line: 1, kind: "import", typeOnly: false, names: ["a", "d"] },
    ]);
  });

  test("a run of imports with no from", () => {
    const run = "import ".repeat(2_000);
    const scanned = regexCallsOver(run, () => scanImports(`${run}x`), old);
    expect(scanned.calls.get(sticky(STATIC_IMPORT_RE))).toBe(1);
    expect(scanned.outcome).toEqual([]);
  });

  test("a run of export lists with no closing brace", () => {
    const run = "export {".repeat(2_000);
    const imported = regexCallsOver(run, () => scanImports(run), old);
    expect(imported.calls.get(sticky(EXPORT_FROM_RE))).toBe(1);
    expect(imported.outcome).toEqual([]);
    const exported = regexCallsOver(run, () => scanExports(run), old);
    expect(exported.calls.get(sticky(EXPORT_LIST_RE))).toBe(1);
    expect(exported.outcome).toEqual([]);
  });

  test("a run of braces in an import clause", () => {
    const run = "{".repeat(2_000);
    // With no `}`, the clause's text before its brace is the whole run, and
    // it is split at whitespace: one call per position, each a single step.
    const scanned = regexCallsOver(
      run,
      () => scanImports(`import ${run} from "x";`),
      [...old, "/\\{([^}]*)\\}/"],
      ["/\\s+/y"],
    );
    expect(scanned.calls.get(sticky(STATIC_IMPORT_RE))).toBe(1);
    expect(scanned.outcome).toMatchObject([{ specifier: "x", names: [] }]);
  });
});
