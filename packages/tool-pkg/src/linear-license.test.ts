/**
 * An SPDX expression is split at its operators in one pass.
 *
 * `split(/\s+(?:OR|AND|WITH)\s+/i)` tries every start inside a run of
 * whitespace and, where no operator follows the run, rescans the rest of it
 * from each before giving the start up: quadratic in the run's length. A
 * license field is whatever a package.json holds, so the split is a scan.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { splitAtOperators, splitExpression } from "./lib/license";

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

const OPERATORS = /\s+(?:OR|AND|WITH)\s+/i;

describe("SPDX operators", () => {
  test("splitAtOperators returns what the split returned", () => {
    const inputs = [
      ...allStrings([" ", "o", "R", "a", "x"], 6),
      "MIT OR Apache-2.0",
      "GPL-2.0 WITH Classpath-exception-2.0",
      "a and b",
      "a\tOR\nb",
      "a OR OR b",
      "a OR",
      "OR b",
      " OR b",
      "a \u0131R b",
      "a wi\u017fh b",
      "a \u00a0AND\u3000b",
    ];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`a${ch}OR b`, `a O${ch} b`, `a OR${ch}b`);
    }
    expect(answers(inputs, splitAtOperators)).toEqual(answers(inputs, (s) => s.split(OPERATORS)));
  }, 20_000);

  test("no pattern rescans a run of spaces inside an expression", () => {
    const spaces = " ".repeat(100_000);
    const expression = `(MIT${spaces}x OR Apache-2.0)`;
    // Control: the count sees the old split run over the spaces.
    expect(regexRunsOver(spaces, () => expression.split(OPERATORS)).runs).toEqual([
      `/${OPERATORS.source}/ over ${expression.length} characters`,
    ]);
    // The parenthesis blanking reads each position once, and the operator
    // filter is anchored at the start of each part.
    const split = regexRunsOver(spaces, () => splitExpression(expression), [
      "[()]",
      "^(OR|AND|WITH)$",
    ]);
    expect(split.runs).toEqual([
      `/[()]/ over ${expression.length} characters`,
      `/^(OR|AND|WITH)$/ over ${`MIT${spaces}x`.length} characters`,
    ]);
    expect(split.outcome).toEqual([`MIT${spaces}x`, "Apache-2.0"]);
  });
});
