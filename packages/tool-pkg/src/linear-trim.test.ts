import { describe, expect, test } from "bun:test";
import { clean, entryPoints, preflight, wouldInclude } from "./lib/preflight";

/**
 * Every regular expression run over a string that holds `run`, while `body`
 * runs. Each one is refused on the spot (it throws instead of running) and
 * recorded, so a pattern that would rescan the run from every position in it
 * fails the test at once instead of being waited out. `String#replace`,
 * `match`, `split`, `search` and `RegExp#test` all go through `exec` once it
 * is replaced. Counted, not timed: the machine's speed decides nothing.
 */
function regexRunsOver<T>(run: string, body: () => T): { runs: string[]; outcome: T | Error } {
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
      runs.push(`/${this.source}/ over ${input.length} characters`);
      throw new Error(`/${this.source}/ ran over the run`);
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

// What clean() was: `/\/+$/` tries every start inside a run of slashes and
// rescans the rest of the run from each, quadratic in its length (10k, 20k
// and 40k slashes took 57, 225 and 920 ms).
const regexClean = (p: string): string => p.replace(/^\.\//, "").replace(/\/+$/, "");

describe("clean", () => {
  test("returns what the regex form returned", () => {
    const inputs = [
      ...allStrings([".", "/", "a"], 5),
      "./dist/",
      "dist///",
      "./",
      ".//",
      "../a/",
      "a/b/c//",
      "/abs/",
      "é/ü//",
      "\u{1F600}/",
      " /",
      "a/\n/",
    ];
    for (const p of inputs) {
      expect(`${JSON.stringify(p)} -> ${JSON.stringify(clean(p))}`).toBe(
        `${JSON.stringify(p)} -> ${JSON.stringify(regexClean(p))}`,
      );
    }
  });

  // A package.json is the repository's, which may be a template or a pull
  // request. No pattern runs over a value's slashes, so a long run of them
  // that is not at the end costs one pass.
  test("no pattern runs over a run of slashes in a files entry or an entry point", () => {
    const slashes = "/".repeat(100_000);
    // Control: the count sees a pattern String#replace runs over the slashes.
    expect(regexRunsOver(slashes, () => `dist${slashes}x/`.replace(/\/+$/, "")).runs).toEqual([
      `/\\/+$/ over ${slashes.length + 6} characters`,
    ]);

    const value = `./dist${slashes}x/`;
    const included = regexRunsOver(slashes, () => wouldInclude([value], `dist${slashes}x/y.js`));
    expect(included.runs).toEqual([]);
    expect(included.outcome).toBe(true);

    const entries = regexRunsOver(slashes, () =>
      entryPoints({ main: value, exports: { ".": value } }),
    );
    expect(entries.runs).toEqual([]);
    expect(entries.outcome).toEqual([`dist${slashes}x`]);

    const looked: string[] = [];
    const report = regexRunsOver(slashes, () =>
      preflight(
        { name: "p", version: "1.0.0", license: "MIT", main: value, files: [value] },
        {
          exists: (rel) => {
            looked.push(rel);
            return false;
          },
          isDirectory: () => false,
        },
      ),
    );
    expect(report.runs).toEqual([]);
    expect(looked).toContain(`dist${slashes}x`);
  });
});
