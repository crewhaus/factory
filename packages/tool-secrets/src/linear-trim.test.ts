/**
 * A value's trailing line breaks are found in one pass.
 *
 * `/[\r\n]+$/` tries every start inside a run of line breaks that is not at
 * the end of the value and rescans the rest of the run from each before
 * giving the start up: quadratic in the run's length. A value can be a
 * secrets file's whole content or a helper's output, so the strip is a loop.
 */
import { describe, expect, test } from "bun:test";
import { describeValue, withoutTrailingLineBreaks } from "./lib/fingerprint";

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

describe("trailing line breaks", () => {
  test("withoutTrailingLineBreaks returns what /[\\r\\n]+$/ returned", () => {
    const inputs = [...allStrings(["\r", "\n", " ", "a"], 5), "v\u2028", "é\r\n", "\u{1F600}\n"];
    expect(answers(inputs, withoutTrailingLineBreaks)).toEqual(
      answers(inputs, (s) => s.replace(/[\r\n]+$/, "")),
    );
  });

  test("no pattern rescans a run of line breaks inside a value", () => {
    const run = "\r\n".repeat(50_000);
    const value = `secret${run}x\n`;
    // Control: the count sees a pattern String#replace runs over the run.
    expect(regexRunsOver(run, () => value.replace(/[\r\n]+$/, "")).runs).toEqual([
      `/[\\r\\n]+$/ over ${value.length} characters`,
    ]);
    const described = regexRunsOver(run, () => describeValue(value));
    expect(described.runs).toEqual([]);
    expect(described.outcome).toMatchObject({
      length: value.length,
      trailingNewline: true,
      leadingOrTrailingSpace: false,
    });
  });
});
