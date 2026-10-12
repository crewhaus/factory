/**
 * A command's directory and PATH entries lose their trailing separators in
 * one pass.
 *
 * `/[\\/]+$/` tries every start inside a run of separators that is not at the
 * end and rescans the rest of the run from each before giving the start up:
 * quadratic in the run's length. The directory a command runs in and the
 * PATH it sets are whatever the call wrote, so the strip is a loop.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { operativeValuesFor, withoutTrailingSeparators } from "./permission-subject";

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

// Patterns the reading runs over every value, each in one pass: a test for
// one separator, the split at runs of `\s:=;` (each run is taken whole from
// its start), and a drive-letter check anchored at the start. Listed so the
// test says which they are.
const ONE_PASS: ReadonlyArray<string> = ["[\\\\/]", "[\\s:=;]+", "^[A-Za-z]:[\\\\/]"];

/** The spellings a deny reads for the one command value. */
function spellingsOf(values: unknown): ReadonlyArray<string> {
  return (values as ReadonlyArray<{ spellings?: ReadonlyArray<string> }>)[0]?.spellings ?? [];
}

const run = buildTool({
  name: "Run",
  description: "d",
  inputSchema: z.object({
    argv: z.array(z.string()),
    cwd: z.string().optional(),
    envSet: z.record(z.string()).optional(),
  }),
  operativeArgs: [{ field: "argv", kind: "command", within: "cwd", env: "envSet" }],
  execute: async () => "ok",
});

describe("trailing separators", () => {
  test("withoutTrailingSeparators returns what /[\\\\/]+$/ returned", () => {
    const inputs = [...allStrings(["/", "\\", "a", "."], 5), "C:\\", "é/", "\u{1F600}\\/"];
    expect(answers(inputs, withoutTrailingSeparators)).toEqual(
      answers(inputs, (s) => s.replace(/[\\/]+$/, "")),
    );
  });

  test("no pattern rescans a run of separators in the directory a command runs in", () => {
    const slashes = "/\\".repeat(50_000);
    const cwd = `sub${slashes}x/`;
    // Control: the count sees a pattern String#replace runs over the run.
    expect(regexRunsOver(slashes, () => cwd.replace(/[\\/]+$/, "")).runs).toEqual([
      `/[\\\\/]+$/ over ${cwd.length} characters`,
    ]);
    const read = regexRunsOver(
      slashes,
      () => operativeValuesFor(run, { argv: ["sh", "x"], cwd }),
      ONE_PASS,
    );
    expect(read.runs.filter((r) => !ONE_PASS.some((p) => r.startsWith(`/${p}/`)))).toEqual([]);
    expect(spellingsOf(read.outcome)).toContain(`sub${slashes}x/x`);
  }, 20_000);

  test("no pattern rescans a run of separators in a PATH entry the call sets", () => {
    // A value past 8192 characters is not read at all, so the run fits under it.
    const slashes = "/".repeat(8_000);
    const path = `bin${slashes}x/`;
    const read = regexRunsOver(
      slashes,
      () => operativeValuesFor(run, { argv: ["tool"], envSet: { PATH: path } }),
      ONE_PASS,
    );
    expect(read.runs.filter((r) => !ONE_PASS.some((p) => r.startsWith(`/${p}/`)))).toEqual([]);
    expect(spellingsOf(read.outcome)).toContain(`bin${slashes}x/tool`);
  });
});
