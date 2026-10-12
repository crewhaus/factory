/**
 * Python and Cargo manifest lines are read in one pass.
 *
 * `/^(?<name>[A-Za-z0-9._-]+)\s*(?:\[(?<extras>[^\]]*)\])?\s*(?<range>.*)$/`
 * over a requirement and `/^(?<key>[A-Za-z0-9._-]+)\s*=\s*(?<value>.+)$/`
 * over a TOML key line match only when the rest holds no line break. When
 * it does (a stray \r or U+2028 survives splitting on \n), each tried every
 * shorter run of whitespace and rescanned the rest from each: cubic and
 * quadratic in the run's length, in requirements.txt, pyproject.toml and
 * Cargo.toml from the workspace. A probe that puts the break straight after
 * the run hides this, since `\s` takes the break and the match succeeds at
 * once; the shapes here put text between the run and the break.
 *
 * The equivalence tests walk every code unit and many generated inputs.
 * They compare the reads one input at a time, never holding the corpus or
 * its answers as strings, and declare a 60 s budget, as the house does for
 * a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import {
  parseCargoToml,
  parsePyproject,
  parseRequirementsTxt,
  requirementParts,
  tomlKeyValue,
} from "./lib/deps";

/**
 * Every regular expression run over a string holding `run` while `body`
 * runs. Each is recorded once, and one whose source is not in `allowed` is
 * refused on the spot (it throws instead of running), so a pattern that
 * would rescan the run from every position in it fails the test at once
 * instead of being waited out. `String#replace`, `match`, `split`, `search`
 * and `RegExp#test` all go through `exec` once it is replaced. Counted, not
 * timed: the machine's speed decides nothing.
 */
function regexRunsOver<T>(
  run: string,
  body: () => T,
  allowed: ReadonlyArray<string> = [],
): { runs: string[]; outcome: T | Error } {
  const runs: string[] = [];
  const realExec = RegExp.prototype.exec;
  let last: string | undefined;
  let holds = false;
  RegExp.prototype.exec = function (this: RegExp, input: string) {
    if (input !== last) {
      last = input;
      holds = typeof input === "string" && input.includes(run);
    }
    if (holds) {
      const seen = `/${this.source}/`;
      if (!runs.includes(seen)) runs.push(seen);
      if (!allowed.includes(this.source)) throw new Error(`/${this.source}/ ran over the run`);
    }
    return realExec.call(this, input);
  };
  try {
    return { runs, outcome: body() };
  } catch (err) {
    return { runs, outcome: err as Error };
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

/** Every string up to `max` characters long over `alphabet`. */
function* allStrings(alphabet: ReadonlyArray<string>, max: number): Generator<string> {
  let layer = [""];
  yield "";
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => alphabet.map((c) => s + c));
    yield* layer;
  }
}

/** `v` as JSON with every code unit outside printable ASCII escaped, so a failure shows it. */
function shown(v: unknown): string {
  return (JSON.stringify(v) ?? String(v)).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The inputs on which `now` and `then` answer differently, compared one at
 * a time as `inputs` yields them, so the walk costs the reads and little
 * else. Names the first 20 that differ, with both answers, and counts every
 * input, so a corpus that shrank shows up as well. `same` compares the
 * answers' fields with `===`, which tells `undefined` from `null` where
 * their JSON did not.
 */
function disagreements<T>(
  inputs: Iterable<string>,
  now: (s: string) => T,
  then: (s: string) => T,
  same: (a: T, b: T) => boolean,
): { checked: number; differ: string[] } {
  let checked = 0;
  const differ: string[] = [];
  for (const s of inputs) {
    checked++;
    const a = now(s);
    const b = then(s);
    if (!same(a, b) && differ.length < 20) {
      differ.push(`${shown(s)} -> ${shown(a)}, was ${shown(b)}`);
    }
  }
  return { checked, differ };
}

/** Two answers that are both absent, or arrays equal item by item. */
function sameItems(a: ReadonlyArray<unknown> | null, b: ReadonlyArray<unknown> | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

// The patterns as they were.
const REQUIREMENT = /^(?<name>[A-Za-z0-9._-]+)\s*(?:\[(?<extras>[^\]]*)\])?\s*(?<range>.*)$/;
const PEP508 = /^(?<name>[A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(?<range>.*)$/;
const KEY_VALUE = /^(?<key>[A-Za-z0-9._-]+)\s*=\s*(?<value>.+)$/;

/** Every input the requirement comparison walks, generated as it is read. */
function* requirementLines(): Generator<string> {
  yield* allStrings(["a", " ", "[", "]", "\r", "\u2028", "\n", "x", "\u00a0"], 5);
  yield "requests[security,socks] >=2.0, <3";
  yield "requests [a] ==1";
  yield "flask";
  yield "a[b";
  yield "a[]";
  yield "a] x";
  // Every code unit, in each place the pattern reads.
  for (let c = 0; c <= 0xffff; c++) {
    const ch = String.fromCharCode(c);
    yield `a${ch}x`;
    yield `a ${ch}`;
    yield `a[${ch}]x`;
    yield `a [x] ${ch}y`;
    yield `${ch}a`;
    yield `a ${ch} x`;
    // In the range after text, where only `.` reads it: U+2029 was in no
    // other place here that whitespace does not take first.
    yield `a x${ch}`;
  }
}

/** Every input the key = value comparison walks, generated as it is read. */
function* keyValueLines(): Generator<string> {
  yield* allStrings(["a", " ", "=", "\r", "\u2028", "\n", "x", "\t"], 5);
  yield 'serde = "1.0"';
  yield 'serde = { version = "1", features = ["derive"] }';
  yield "a = \t";
  yield "a =\u2028";
  yield "a = \u2028 ";
  // Every code unit, in each place the pattern reads.
  for (let c = 0; c <= 0xffff; c++) {
    const ch = String.fromCharCode(c);
    yield `a${ch}=x`;
    yield `a=${ch}`;
    yield `a= ${ch}`;
    yield `a=${ch}x`;
    yield `a=x${ch}`;
    yield `${ch}=x`;
  }
}

describe("the reads return what the patterns captured", () => {
  test("requirementParts and the requirements.txt and PEP 508 patterns", () => {
    const parts = (s: string) => {
      const p = requirementParts(s);
      return p === null ? null : [p.name, p.extras, p.range];
    };
    const requirement = disagreements(
      requirementLines(),
      parts,
      (s) => {
        const m = REQUIREMENT.exec(s);
        return m === null ? null : [m.groups?.["name"], m.groups?.["extras"], m.groups?.["range"]];
      },
      sameItems,
    );
    expect(requirement.differ).toEqual([]);
    // The PEP 508 pattern differs only in not naming the extras.
    const pep508 = disagreements(
      requirementLines(),
      (s) => requirementParts(s)?.range ?? null,
      (s) => PEP508.exec(s)?.groups?.["range"] ?? null,
      (a, b) => a === b,
    );
    expect(pep508.differ).toEqual([]);
    // Strings up to length 5 over 9 characters, 6 fixed lines, and 7 places
    // for each of the 65 536 code units, in both walks.
    const corpus = 66_430 + 6 + 7 * 65_536;
    expect([requirement.checked, pep508.checked]).toEqual([corpus, corpus]);
  }, 60_000);

  test("tomlKeyValue and the key = value pattern", () => {
    const { checked, differ } = disagreements(
      keyValueLines(),
      (s) => {
        const kv = tomlKeyValue(s);
        return kv === null ? null : [kv.key, kv.value];
      },
      (s) => {
        const m = KEY_VALUE.exec(s);
        return m === null ? null : [m.groups?.["key"], m.groups?.["value"]];
      },
      sameItems,
    );
    expect(differ).toEqual([]);
    // Strings up to length 5 over 8 characters, 5 fixed lines, and 6 places
    // for each of the 65 536 code units.
    expect(checked).toBe(37_449 + 5 + 6 * 65_536);
  }, 60_000);
});

describe("no pattern rescans a run in a manifest the workspace holds", () => {
  const run = " ".repeat(100_000);

  test("the old patterns did", () => {
    // Control: the hook sees each old pattern run over its run.
    for (const [pattern, line] of [
      [REQUIREMENT, `requests${run}x\ry`],
      [PEP508, `requests${run}x\u2028y`],
      [KEY_VALUE, `serde =${run}x\ry`],
    ] as const) {
      const seen = regexRunsOver(run, () => pattern.exec(line));
      expect(seen.runs).toEqual([`/${pattern.source}/`]);
    }
  });

  test("requirements.txt with a run before text and a stray carriage return", () => {
    const text = [
      `requests${run}x\ry`,
      `requests[socks]${run}x\u2028y`,
      `urllib3${run}[a]${run}x\ry`,
      "flask==2.0",
      "",
    ].join("\n");
    const read = regexRunsOver(run, () => parseRequirementsTxt(text), ["\\r$"]);
    expect(read.runs).toEqual(["/\\r$/"]);
    // As before: a requirement whose rest holds a line break is not one.
    expect(read.outcome).toEqual([
      {
        name: "flask",
        range: "==2.0",
        scope: "prod",
        ecosystem: "pypi",
        source: "requirements.txt",
      },
    ]);
  });

  test("pyproject.toml and Cargo.toml with a run before text and a stray line break", () => {
    const pyproject = [
      "[project]",
      'name = "p"',
      "dependencies = [",
      `  "requests${run}x\u2028y",`,
      `  'httpx${run}x\ry',`,
      '  "flask>=2",',
      "]",
      "[tool.poetry.dependencies]",
      `django =${run}x\ry`,
      'click = "^8"',
      "",
    ].join("\n");
    // The line splitter, the section reader and the array readers each read
    // a line once; none is the key or requirement pattern.
    const sectionAndArrays = [
      "\\r$",
      "^\\s*\\[\\[?([^\\]]+)\\]\\]?\\s*$",
      "^[ \\t]*([A-Za-z0-9._-]+)[ \\t]*=[ \\t]*\\[",
      "\"([^\"]*)\"|'([^']*)'",
    ];
    const py = regexRunsOver(run, () => parsePyproject(pyproject), sectionAndArrays);
    expect(py.runs).toEqual(sectionAndArrays.map((p) => `/${p}/`));
    expect(py.outcome).toEqual([
      { name: "click", range: "^8", scope: "prod", ecosystem: "pypi", source: "pyproject.toml" },
      { name: "flask", range: ">=2", scope: "prod", ecosystem: "pypi", source: "pyproject.toml" },
    ]);
    const cargo = [
      "[dependencies]",
      `serde =${run}x\ry`,
      `tokio =${run}{ version = "1" }\u2028y`,
      'anyhow = "1.0"',
      "",
    ].join("\n");
    const rs = regexRunsOver(run, () => parseCargoToml(cargo), sectionAndArrays);
    expect(rs.runs).toEqual(sectionAndArrays.slice(0, 2).map((p) => `/${p}/`));
    expect(rs.outcome).toEqual([
      { name: "anyhow", range: "1.0", scope: "prod", ecosystem: "cargo", source: "Cargo.toml" },
    ]);
  });
});
