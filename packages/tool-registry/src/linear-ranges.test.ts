/**
 * A PEP 440 or Poetry clause's operator is read in one pass.
 *
 * `/^(===|==|!=|<=|>=|~=|<|>)\s*(.+)$/` and Poetry's
 * `/^(\^|~=|~|>=|<=|==|=|!=|<|>)\s*(.+)$/` match only when what follows the
 * operator's whitespace holds no line break. When it does (a raw U+2028 in a
 * pyproject.toml string, or a raw \r in a literal one, survives into the
 * spec), each tried every shorter run of whitespace and rescanned the rest
 * from each: quadratic in the run's length, in a manifest the workspace
 * supplies. A probe that puts the break straight after the run hides this,
 * since `\s` takes the break and the match succeeds at once; the shapes here
 * put text between the run and the break.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { collectSites } from "./lib/manifest";
import { PEP440_OPERATORS, POETRY_OPERATORS, operatorAndRest, toNpmRangeIn } from "./lib/ranges";

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
const PEP440_CLAUSE = /^(===|==|!=|<=|>=|~=|<|>)\s*(.+)$/;
const POETRY_OPERATOR = /^(\^|~=|~|>=|<=|==|=|!=|<|>)\s*(.+)$/;

describe("operatorAndRest captures what the patterns captured", () => {
  const inputs = [
    ...allStrings(["=", "<", "~", "^", "!", " ", "\r", "\u2028", "x"], 5),
    ">=2.31, <3",
    "~=1.4.2",
    "===1.0",
    "^ 2.31",
    "== \t",
  ];
  // Every code unit, in each place the patterns read.
  for (let c = 0; c <= 0xffff; c++) {
    const ch = String.fromCharCode(c);
    inputs.push(`==${ch}`, `== ${ch}`, `==${ch}x`, `==x${ch}`, `^${ch}1`, `~ ${ch}`, ch);
  }
  for (const [label, operators, pattern] of [
    ["PEP 440", PEP440_OPERATORS, PEP440_CLAUSE],
    ["Poetry", POETRY_OPERATORS, POETRY_OPERATOR],
  ] as const) {
    test(label, () => {
      expect(answers(inputs, (s) => operatorAndRest(s, operators))).toEqual(
        answers(inputs, (s) => {
          const m = pattern.exec(s);
          return m === null ? null : { op: m[1], rest: m[2] };
        }),
      );
    }, 20_000);
  }
});

describe("no pattern rescans a run in a pyproject.toml spec", () => {
  const run = " ".repeat(100_000);

  test("the old patterns did", () => {
    // Control: the hook sees each old pattern run over its run.
    for (const [pattern, part] of [
      [PEP440_CLAUSE, `>=${run}2.0\u2028x`],
      [POETRY_OPERATOR, `^${run}2.0\rx`],
    ] as const) {
      expect(regexRunsOver(run, () => pattern.exec(part)).runs).toEqual([`/${pattern.source}/`]);
    }
  });

  test("each site's spec is translated, or refused as before", () => {
    const text = [
      "[project]",
      'name = "x"',
      "dependencies = [",
      `  "requests>=${run}2.0\u2028x",`,
      `  'httpx==${run}1.0\rx',`,
      '  "flask>=2.0",',
      "]",
      "[tool.poetry.dependencies]",
      `django = "^${run}4.0\u2028x"`,
      'click = "^8.1"',
      "",
    ].join("\n");
    // The requirement head, the location and wildcard checks, the version
    // shape and the dialect hint each read a spec once.
    const headAndChecks = [
      "^\\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\\s*\\[[^\\]]*\\])?",
      "^(workspace|catalog|file|link|path|git|git\\+[a-z]+|npm|jsr|https?|portal|patch):",
      "^v?(\\d+(?:\\.\\d+)?)\\.\\*$",
      "^v?\\d+(\\.\\d+){0,2}(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$",
      "^[\\^~]\\s*\\d",
      "^v?\\d",
    ];
    const translated = regexRunsOver(
      run,
      () => {
        const collected = collectSites("pyproject.toml", text);
        if (!collected.ok) throw new Error("the manifest did not read");
        return collected.sites.map((site) => {
          const t = toNpmRangeIn(site.dialect, site.spec);
          return [site.name, t.ok ? t.range : t.reason.replace(run, "<run>")];
        });
      },
      headAndChecks,
    );
    expect(translated.runs.sort()).toEqual(headAndChecks.map((p) => `/${p}/`).sort());
    // As before: a spec whose version is followed by a line break is no
    // operator and version, and is refused with the same sentence.
    expect(translated.outcome).toEqual([
      ["django", '"^<run>4.0\u2028x" is not a version this package can order'],
      ["click", ">=8.1.0 <9.0.0"],
      ["requests", '">=<run>2.0\u2028x" is not a PEP 440 version specifier'],
      ["httpx", '"==<run>1.0\rx" is not a PEP 440 version specifier'],
      ["flask", ">=2.0.0"],
    ]);
  });
});
