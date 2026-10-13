/**
 * A search term loses its trailing `)` in one pass.
 *
 * `/\)+$/` tries every start inside a run of `)` that is not at the end of
 * the term and rescans the rest of the run from each before giving the start
 * up: quadratic in the run's length. The query is the model's and is read
 * before anything is sent, so the strip is a loop.
 */
import { describe, expect, test } from "bun:test";
import { githubSearchQuery, withoutTrailingParens } from "./lib/search-scope";

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

// Patterns anchored at the start of the term: each tries one start and
// reads the term at most once from it.
const ANCHORED: ReadonlyArray<string> = [
  "^\\(+",
  "^(repo|org|user):(.+)$",
  '^"(.*)"$',
  "^[A-Za-z0-9._-]{1,100}$",
];

describe("trailing parentheses", () => {
  test("withoutTrailingParens returns what /\\)+$/ returned", () => {
    const inputs = [...allStrings([")", "(", "a"], 6), "repo:a/b)", "é)", "\u{1F600})"];
    expect(answers(inputs, withoutTrailingParens)).toEqual(
      answers(inputs, (s) => s.replace(/\)+$/, "")),
    );
  });

  test("no pattern rescans a run of ) inside a query term", () => {
    const run = ")".repeat(100_000);
    const query = `password repo:acme/w${run}x)`;
    // Control: the count sees a pattern String#replace runs over the run.
    expect(regexRunsOver(run, () => query.replace(/\)+$/, "")).runs).toEqual([
      `/\\)+$/ over ${query.length} characters`,
    ]);
    // What does run over the term is anchored at its start.
    const scoped = regexRunsOver(
      run,
      () => githubSearchQuery("SearchCode", query, "acme", "widget"),
      ANCHORED,
    );
    expect(scoped.runs.filter((r) => !ANCHORED.some((p) => r.startsWith(`/${p}/`)))).toEqual([]);
    expect(JSON.stringify(scoped.outcome)).toContain('"ok":false');
    expect(JSON.stringify(scoped.outcome)).toContain("Nothing was searched");
  });
});
