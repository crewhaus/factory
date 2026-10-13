/**
 * A decimal amount is checked in one pass.
 *
 * `/^-?\d*\.?\d*$/` gives every digit of a run back to its second `\d*` in
 * turn when the text does not end where it should, rescanning the rest from
 * each: quadratic in the run's length. The amount is the model's, with no
 * length limit, so the check is a scan.
 *
 * A test that walks every code unit declares a 20 s budget, as the house
 * does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { isDecimalText, parseUnits } from "./lib/address";

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

const DECIMAL = /^-?\d*\.?\d*$/;

describe("a decimal amount", () => {
  test("isDecimalText answers what /^-?\\d*\\.?\\d*$/ answered", () => {
    const inputs = [...allStrings(["1", "0", ".", "-", "x", " "], 5), "\u0661\u0662", "1e5", "+1"];
    for (let c = 0; c <= 0xffff; c++) inputs.push(`1${String.fromCharCode(c)}2`);
    expect(answers(inputs, isDecimalText)).toEqual(answers(inputs, (s) => DECIMAL.test(s)));
  }, 20_000);

  test("no pattern rescans a run of digits before a stray character", () => {
    const digits = "1".repeat(100_000);
    const amount = `${digits}x`;
    // Control: the count sees the old pattern run over the digits.
    expect(regexRunsOver(digits, () => DECIMAL.test(amount)).runs).toEqual([
      `/${DECIMAL.source}/ over ${amount.length} characters`,
    ]);
    const parsed = regexRunsOver(digits, () => parseUnits(amount, 18));
    expect(parsed.runs).toEqual([]);
    expect(String(parsed.outcome)).toContain("is not a decimal amount");
    expect(parseUnits("-1.5", 6)).toBe(-1_500_000n);
  });
});
