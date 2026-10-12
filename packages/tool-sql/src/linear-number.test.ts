/**
 * A cell is checked for a decimal number in one pass.
 *
 * `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/` gives every digit of a run
 * back to its fraction in turn when the text does not end where it should,
 * rescanning the rest from each: quadratic in the run's length. A cell is
 * whatever the CSV holds, so the check is a scan.
 *
 * A test that walks every code unit declares a 20 s budget, as the house
 * does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { coerceCsvCell, inferTypeFromStrings, isDecimalNumberText } from "./lib/infer";

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

const REAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

describe("a decimal number", () => {
  test("isDecimalNumberText answers what the pattern answered", () => {
    const inputs = [
      ...allStrings(["1", ".", "e", "-", "+", "x"], 5),
      "1.5e-3",
      ".5E+10",
      "1.e5",
      "\u0661",
      "Infinity",
    ];
    for (let c = 0; c <= 0xffff; c++) inputs.push(`1${String.fromCharCode(c)}2`);
    expect(answers(inputs, isDecimalNumberText)).toEqual(answers(inputs, (s) => REAL.test(s)));
  }, 20_000);

  test("no pattern rescans a run of digits in a cell", () => {
    const digits = "1".repeat(100_000);
    const cell = `${digits}x`;
    // Control: the count sees the old pattern run over the digits.
    expect(regexRunsOver(digits, () => REAL.test(cell)).runs).toEqual([
      `/${REAL.source}/ over ${cell.length} characters`,
    ]);
    // The integer check is anchored at the start and fails at the `x`.
    const inferred = regexRunsOver(digits, () => inferTypeFromStrings([cell], true), [
      "^[+-]?[0-9]+$",
    ]);
    expect(inferred.runs).toEqual([`/^[+-]?[0-9]+$/ over ${cell.length} characters`]);
    expect(inferred.outcome).toBe("TEXT");
    const coerced = regexRunsOver(digits, () => coerceCsvCell(cell, "REAL", false));
    expect(coerced.runs).toEqual([]);
    expect(coerced.outcome).toMatchObject({ ok: false });
  });
});
