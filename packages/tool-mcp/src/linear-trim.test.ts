/**
 * A suggested server name loses its edge dashes in one pass.
 *
 * `/^[-_]+|[-_]+$/g` tries, through its second branch, every start inside a
 * run of `-` and `_` that is not at the end and rescans the rest of the run
 * from each before giving the start up: quadratic in the run's length. A
 * server name is the spec's, which may come from a template or a pull
 * request, so the trim is a loop from each end.
 */
import { describe, expect, test } from "bun:test";
import { mcpServerNameProblem } from "./index";
import { withoutEdgeDashes } from "./trim";

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

// Each reads a position once: an anchored whole-name check and two global
// replaces whose matches start at the one character they look at.
const ONE_PASS: ReadonlyArray<string> = ["^[A-Za-z0-9_-]+$", "[^A-Za-z0-9_-]+", "_{2,}"];

describe("edge dashes", () => {
  test("withoutEdgeDashes returns what /^[-_]+|[-_]+$/g returned", () => {
    const inputs = [...allStrings(["-", "_", "a", "."], 6), "my-server_", "é-", "-\u{1F600}"];
    expect(answers(inputs, withoutEdgeDashes)).toEqual(
      answers(inputs, (s) => s.replace(/^[-_]+|[-_]+$/g, "")),
    );
  });

  test("no pattern rescans a run of dashes inside a server name", () => {
    const run = "-".repeat(100_000);
    const name = `a${run}b!`;
    // Control: the count sees a pattern String#replace runs over the run.
    expect(regexRunsOver(run, () => name.replace(/^[-_]+|[-_]+$/g, "")).runs).toEqual([
      `/^[-_]+|[-_]+$/ over ${name.length} characters`,
    ]);
    const problem = regexRunsOver(run, () => mcpServerNameProblem(name), ONE_PASS);
    expect(problem.runs.filter((r) => !ONE_PASS.some((p) => r.startsWith(`/${p}/`)))).toEqual([]);
    expect(String(problem.outcome).endsWith(`e.g. "a${run}b".`)).toBe(true);
  });
});
