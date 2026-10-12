/**
 * A pdf number and a page range part are read in one pass.
 *
 * `/^[+-]?(\d+\.?\d*|\.\d+)$/` gives every digit of a run back to its
 * fraction in turn, and `/^(\d+)?\s*(-)?\s*(\d+)?$/` every space of a run to
 * its second `\s*`, when the text does not end where it should, rescanning
 * the rest from each: quadratic in the run's length. A pdf is whatever was
 * handed over and a page range is the model's, so both reads are scans.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { PdfLexer, isPdfNumber } from "./lib/pdf";
import { pageRangePart, parsePageRange } from "./lib/pdf-write";

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

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const PART = /^(\d+)?\s*(-)?\s*(\d+)?$/;

describe("the reads answer what the patterns answered", () => {
  test("isPdfNumber and the number pattern", () => {
    const inputs = [...allStrings(["1", ".", "-", "+", "x"], 6), "3.14", "-.5", "\u0661"];
    for (let c = 0; c <= 0xffff; c++) inputs.push(`1${String.fromCharCode(c)}2`);
    expect(answers(inputs, isPdfNumber)).toEqual(answers(inputs, (s) => NUMBER.test(s)));
  });

  test("pageRangePart and the page range pattern", () => {
    const inputs = [...allStrings(["1", "2", " ", "-", "x"], 6), "10-", "-3", "1 - 3", "\u00a01"];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`1${ch}-2`, `1-${ch}2`);
    }
    expect(answers(inputs, pageRangePart)).toEqual(
      answers(inputs, (s) => {
        const m = PART.exec(s);
        return m === null ? null : [m[1], m[2], m[3]];
      }),
    );
  }, 20_000);
});

describe("no pattern rescans a run", () => {
  test("a pdf token of digits before a stray letter", () => {
    const digits = "1".repeat(100_000);
    const token = `${digits}x`;
    // Control: the count sees the old pattern run over the digits.
    expect(regexRunsOver(digits, () => NUMBER.test(token)).runs).toEqual([
      `/${NUMBER.source}/ over ${token.length} characters`,
    ]);
    const lexer = new PdfLexer(new TextEncoder().encode(`${token} `));
    const read = regexRunsOver(digits, () => lexer.parseValue());
    expect(read.runs).toEqual([]);
    expect(String(read.outcome)).toContain("unrecognised pdf token");
  });

  test("a page range part with a run of spaces before a stray character", () => {
    const spaces = " ".repeat(100_000);
    const spec = `1,2${spaces}-${spaces}x`;
    const parsed = regexRunsOver(spaces, () => parsePageRange(spec, 5));
    expect(parsed.runs).toEqual([]);
    expect(String(parsed.outcome)).toContain("is not a page or page range");
    expect(parsePageRange(`1,2${spaces}-${spaces}3`, 5)).toEqual([1, 2, 3]);
  });
});
