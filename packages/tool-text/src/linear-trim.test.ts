/**
 * normalizeText strips trailing blanks in one pass.
 *
 * `/[ \t]+$/` tries every start inside a run of spaces or tabs that is not
 * at the end of its line and rescans the rest of the run from each before
 * giving the start up: quadratic in the run's length, on text up to two
 * million characters. The strip is a loop from the end of each line.
 */
import { describe, expect, test } from "bun:test";
import { normalizeText, withoutTrailingBlanks } from "./lib/normalize";

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

const BLANKS = " \t".repeat(50_000);

describe("trailing blanks", () => {
  test("withoutTrailingBlanks returns what /[ \\t]+$/ returned", () => {
    const inputs = [...allStrings([" ", "\t", "\u00a0", "a"], 5), "\u3000 ", "é\t", "\u{1F600} \t"];
    expect(answers(inputs, withoutTrailingBlanks)).toEqual(
      answers(inputs, (s) => s.replace(/[ \t]+$/, "")),
    );
  });

  test("no pattern rescans a run of blanks inside a line", () => {
    // Control: the count sees a pattern String#replace runs over the run.
    const line = `a${BLANKS}b `;
    expect(regexRunsOver(BLANKS, () => line.replace(/[ \t]+$/, "")).runs).toEqual([
      `/[ \\t]+$/ over ${line.length} characters`,
    ]);
    // The line-ending folds run over the whole text and read each position once.
    const text = `x\r\n${line}\r\ny  `;
    const normalized = regexRunsOver(
      BLANKS,
      () => normalizeText(text, { trimTrailingWhitespace: true }),
      ["\\r\\n", "\\r"],
    );
    expect(normalized.runs).toEqual([
      `/\\r\\n/ over ${text.length} characters`,
      `/\\r/ over ${text.length - 2} characters`,
    ]);
    expect(normalized.outcome).toBe(`x\na${BLANKS}b\ny`);
  });
});
