/**
 * Trailing runs are stripped in one pass.
 *
 * `/=+$/` over base64 text and `/\/+$/` over a URL's path each try every
 * start inside a run (of `=`, of slashes) and, when the run is not at the
 * end, rescan the rest of it from each before giving the start up: quadratic
 * in the run's length, on input up to two million characters. Both strips
 * are loops from the end.
 */
import { describe, expect, test } from "bun:test";
import { base64ToBytes, withoutTrailingPadding } from "./lib/bytes";
import { normalizeUrl, withoutTrailingSlashes } from "./lib/url";

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

describe("the strips return what the regex forms returned", () => {
  test("withoutTrailingPadding and /=+$/", () => {
    const inputs = [...allStrings(["=", "A", " "], 6), "QQ==", "é=", "\u{1F600}=="];
    expect(answers(inputs, withoutTrailingPadding)).toEqual(
      answers(inputs, (s) => s.replace(/=+$/, "")),
    );
  });

  test("withoutTrailingSlashes and /\\/+$/", () => {
    const inputs = [...allStrings(["/", "a", "%"], 6), "/a/b//", "/é/", "/\u{1F600}//"];
    expect(answers(inputs, withoutTrailingSlashes)).toEqual(
      answers(inputs, (s) => s.replace(/\/+$/, "")),
    );
  });
});

describe("no pattern rescans a run", () => {
  test("base64 with a run of = that is not at the end", () => {
    const run = "=".repeat(100_000);
    const text = `${run}QQ==`;
    // Control: the count sees a pattern String#replace runs over the run.
    expect(regexRunsOver(run, () => text.replace(/=+$/, "")).runs).toEqual([
      `/=+$/ over ${text.length} characters`,
    ]);
    // The whitespace removal reads each position once.
    const decoded = regexRunsOver(run, () => base64ToBytes(text), ["[\\s\\r\\n]"]);
    expect(decoded.runs).toEqual([`/[\\s\\r\\n]/ over ${text.length} characters`]);
    expect(String(decoded.outcome)).toBe('Error: "=" at position 0 is not a base64 character');
  });

  test("a URL whose path holds a run of slashes before its last segment", () => {
    const run = "/".repeat(100_000);
    const normalized = regexRunsOver(run, () =>
      normalizeUrl(`https://example.com/a${run}b/`, { stripTrailingSlash: true }),
    );
    expect(normalized.runs).toEqual([]);
    expect(normalized.outcome).toBe(`https://example.com/a${run}b`);
  });
});
