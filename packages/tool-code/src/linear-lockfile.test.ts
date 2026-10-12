/**
 * A pnpm lockfile's package fields are read from both ends.
 *
 * `/^ {4}(name|version|resolution):\s*(.+?)\s*$/` tries every end of its lazy
 * value inside a run of whitespace and rescans the rest of the run from each
 * before giving the end up: quadratic in the run's length. A lockfile is the
 * workspace's, so the read is two scans.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { parsePnpmLockDetailed, pnpmField } from "./lib/deps";

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

// Patterns the reader runs over the line or the value, each in one pass: a
// trailing \r, three anchored at the start (the indent, the entry header,
// the opening quote) and the closing quote, one character before the end.
const ONE_PASS: ReadonlyArray<string> = ["\\r$", "^\\s", "^ {2}(\\S.*?):\\s*$", "^['\"]", "['\"]$"];
const FIELD = /^ {4}(name|version|resolution):\s*(.+?)\s*$/;

describe("a pnpm package field", () => {
  test("pnpmField captures what the pattern captured", () => {
    const inputs = [
      ...allStrings([" ", "a", "\r", "\t"], 5).map((s) => `    name:${s}`),
      ...allStrings([" ", "b", "\n", "\u2028"], 4).map((s) => `    version:${s}`),
      "    resolution: {integrity: sha512-x, tarball: https://r.example/a.tgz}",
      "     name: a",
      "   name: a",
      "    names: a",
      "    name:",
      "    name: 'a' ",
    ];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`    name:${ch}a b`, `    name: a ${ch}`);
    }
    expect(answers(inputs, pnpmField)).toEqual(
      answers(inputs, (s) => {
        const m = FIELD.exec(s);
        return m === null ? null : { key: m[1], value: m[2] };
      }),
    );
  }, 20_000);

  test("no pattern rescans a run of spaces inside a version", () => {
    const spaces = " ".repeat(100_000);
    const line = `    version: 1${spaces}x`;
    // Control: the count sees the old pattern run over the spaces.
    expect(regexRunsOver(spaces, () => FIELD.exec(line)).runs).toEqual([
      `/${FIELD.source}/ over ${line.length} characters`,
    ]);
    const text = `lockfileVersion: '9.0'\npackages:\n  /a@1.0.0:\n    name: a\n${line}\n`;
    // The other reads are anchored at the start of the line or the value,
    // and the closing-quote strip looks at each position once.
    const read = regexRunsOver(spaces, () => parsePnpmLockDetailed(text), ONE_PASS);
    expect(read.runs.filter((r) => !ONE_PASS.some((p) => r.startsWith(`/${p}/`)))).toEqual([]);
    expect(read.outcome).toMatchObject([{ name: "a", version: `1${spaces}x` }]);
  });
});
