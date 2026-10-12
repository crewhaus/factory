/**
 * An index's name is cut before its ` (…)` in two scans.
 *
 * `/\s*\(.*$/` tries every start inside a run of whitespace and, where no
 * `(` follows the run, rescans the rest of it from each before giving the
 * start up: quadratic in the run's length. A quoted index name is whatever
 * the database holds, so the cut is two scans.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { beforeParenthesis, usedIndex } from "./lib/plan";

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
      const seen = `/${this.source}/ over ${input.length} characters`;
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

const cut = (s: string): string => s.replace(/\s*\(.*$/, "");

// The node's detail is read by two patterns that each start only at the
// literal `USING`, and scan a run of whitespace once from there.
const ONE_PASS: ReadonlyArray<string> = [
  "USING\\s+AUTOMATIC\\s",
  'USING\\s+(?:COVERING\\s+)?INDEX\\s+("[^"]+"|`[^`]+`|\\[[^\\]]+\\]|\\S+)',
];

describe("an index name's parenthesis", () => {
  test("beforeParenthesis returns what /\\s*\\(.*$/ returned", () => {
    const inputs = [
      ...allStrings([" ", "(", "a", "\n"], 5),
      ...allStrings(["\t", "(", ")", "\r", "\u2029"], 4),
      "idx_a (a=?)",
      '"weird name" (x>?)',
      "é (\u{1F600})",
    ];
    // Every code unit, as the space before a `(` and as the text after it.
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`a${ch}(b`, `a (${ch}`);
    }
    expect(answers(inputs, beforeParenthesis)).toEqual(answers(inputs, cut));
  }, 20_000);

  test("no pattern rescans a run of spaces inside a quoted index name", () => {
    const spaces = " ".repeat(100_000);
    const name = `"a${spaces}b"`;
    // Control: the count sees a pattern String#replace runs over the run.
    expect(regexRunsOver(spaces, () => cut(name)).runs).toEqual([
      `/\\s*\\(.*$/ over ${name.length} characters`,
    ]);
    const detail = `SEARCH t USING INDEX ${name} (x=?)`;
    const read = regexRunsOver(spaces, () => usedIndex(detail), ONE_PASS);
    expect(read.runs.filter((r) => !ONE_PASS.some((p) => r.startsWith(`/${p}/`)))).toEqual([]);
    expect(read.outcome).toBe(`a${spaces}b`);
  });
});
