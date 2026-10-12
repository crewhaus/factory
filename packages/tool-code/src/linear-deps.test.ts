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
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
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
function allStrings(alphabet: ReadonlyArray<string>, max: number): string[] {
  const out = [""];
  let layer = [""];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => alphabet.map((c) => s + c));
    out.push(...layer);
  }
  return out;
}

/** `[input, output]` for each input, as one string, so a failure names the input. */
function answers(inputs: ReadonlyArray<string>, f: (s: string) => unknown): string[] {
  return inputs.map((s) => `${JSON.stringify(s)} -> ${JSON.stringify(f(s))}`);
}

// The patterns as they were.
const REQUIREMENT = /^(?<name>[A-Za-z0-9._-]+)\s*(?:\[(?<extras>[^\]]*)\])?\s*(?<range>.*)$/;
const PEP508 = /^(?<name>[A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(?<range>.*)$/;
const KEY_VALUE = /^(?<key>[A-Za-z0-9._-]+)\s*=\s*(?<value>.+)$/;

describe("the reads return what the patterns captured", () => {
  test("requirementParts and the requirements.txt and PEP 508 patterns", () => {
    const inputs = [
      ...allStrings(["a", " ", "[", "]", "\r", "\u2028", "\n", "x", "\u00a0"], 5),
      "requests[security,socks] >=2.0, <3",
      "requests [a] ==1",
      "flask",
      "a[b",
      "a[]",
      "a] x",
    ];
    // Every code unit, in each place the pattern reads.
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`a${ch}x`, `a ${ch}`, `a[${ch}]x`, `a [x] ${ch}y`, `${ch}a`, `a ${ch} x`);
    }
    const parts = (s: string) => {
      const p = requirementParts(s);
      return p === null ? null : [p.name, p.extras, p.range];
    };
    expect(answers(inputs, parts)).toEqual(
      answers(inputs, (s) => {
        const m = REQUIREMENT.exec(s);
        return m === null ? null : [m.groups?.["name"], m.groups?.["extras"], m.groups?.["range"]];
      }),
    );
    // The PEP 508 pattern differs only in not naming the extras.
    expect(answers(inputs, (s) => requirementParts(s)?.range ?? null)).toEqual(
      answers(inputs, (s) => PEP508.exec(s)?.groups?.["range"] ?? null),
    );
  }, 20_000);

  test("tomlKeyValue and the key = value pattern", () => {
    const inputs = [
      ...allStrings(["a", " ", "=", "\r", "\u2028", "\n", "x", "\t"], 5),
      'serde = "1.0"',
      'serde = { version = "1", features = ["derive"] }',
      "a = \t",
      "a =\u2028",
      "a = \u2028 ",
    ];
    // Every code unit, in each place the pattern reads.
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`a${ch}=x`, `a=${ch}`, `a= ${ch}`, `a=${ch}x`, `a=x${ch}`, `${ch}=x`);
    }
    expect(answers(inputs, tomlKeyValue)).toEqual(
      answers(inputs, (s) => {
        const m = KEY_VALUE.exec(s);
        return m === null
          ? null
          : { key: m.groups?.["key"] as string, value: m.groups?.["value"] as string };
      }),
    );
  }, 20_000);
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
