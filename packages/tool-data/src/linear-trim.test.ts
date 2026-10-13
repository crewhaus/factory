/**
 * The YAML reader strips trailing runs in one pass.
 *
 * `/\n+$/` over a `|-` block scalar tries every start inside a run of blank
 * lines inside the block and rescans the rest of the run from each before
 * giving the start up: quadratic in the run's length. `/\s+$/` over a line's
 * content does the same as a pattern, and was linear only because JSC turns
 * `.replace(/\s+$/, "")` into a trim. The text is the model's or the
 * workspace's, up to millions of characters, so the strips are a loop and
 * `trimEnd`, and no pattern runs over either run.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { parseYaml, withoutTrailingNewlines } from "./lib/yaml";

/**
 * Every regular expression run over a string holding `run` while `body`
 * runs. Each is recorded, and one whose source is not in `allowed` is
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
      runs.push(`/${this.source}/ over ${input.length} characters`);
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

const SPACES = " ".repeat(100_000);
const NEWLINES = "\n".repeat(100_000);
// The reader folds CRLF and CR to LF over the whole text first.
const LINE_ENDINGS = "\\r\\n?";

describe("the strips return what the regex forms returned", () => {
  test("trimEnd drops exactly what /\\s+$/ did, for every code unit", () => {
    const inputs: string[] = [...allStrings([" ", "\t", "\n", "a"], 4)];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`a${ch}${ch}`, `${ch}b${ch}`);
    }
    expect(answers(inputs, (s) => s.trimEnd())).toEqual(
      answers(inputs, (s) => s.replace(/\s+$/, "")),
    );
  }, 20_000);

  test("withoutTrailingNewlines and /\\n+$/", () => {
    const inputs = [...allStrings(["\n", "\r", " ", "a"], 5), "é\n", "\u{1F600}\n\n"];
    expect(answers(inputs, withoutTrailingNewlines)).toEqual(
      answers(inputs, (s) => s.replace(/\n+$/, "")),
    );
  });
});

describe("no pattern rescans a run in a document", () => {
  test("a line with a run of spaces inside it", () => {
    // Control: the count sees a pattern String#replace runs over the run.
    const line = `# a${SPACES}b `;
    expect(regexRunsOver(SPACES, () => line.replace(/\s+$/, "")).runs).toEqual([
      `/\\s+$/ over ${line.length} characters`,
    ]);
    // A comment line reaches the content strip and nothing after it. The
    // line-ending fold reads each position once, and the indent read is
    // anchored at the start of the line.
    const doc = `k: v\n${line}\n`;
    const parsed = regexRunsOver(SPACES, () => parseYaml(doc), [LINE_ENDINGS, "^[ \\t]*"]);
    expect(parsed.runs).toEqual([
      `/${LINE_ENDINGS}/ over ${doc.length} characters`,
      `/^[ \\t]*/ over ${line.length} characters`,
    ]);
    expect(parsed.outcome).toEqual({ k: "v" });
  });

  test("a |- block scalar with a run of blank lines inside it", () => {
    const doc = `k: |-\n  a\n${NEWLINES}  b\n`;
    const parsed = regexRunsOver(NEWLINES, () => parseYaml(doc), [LINE_ENDINGS]);
    expect(parsed.runs).toEqual([`/${LINE_ENDINGS}/ over ${doc.length} characters`]);
    expect(parsed.outcome).toEqual({ k: `a\n${NEWLINES}b` });
  });
});
