/**
 * Trailing runs are stripped in one pass when a workflow is read.
 *
 * `/\n+$/` over a block scalar and `/\.+$/` over an expression's event path
 * try every start inside a run (of blank lines inside the block, of dots in
 * the path) and, when the run is not at the end, rescan the rest of it from
 * each before giving the start up: quadratic in the run's length. A workflow
 * is whatever the repository holds, so both strips are loops.
 */
import { describe, expect, test } from "bun:test";
import { classifyExpression, withoutTrailingDots } from "./lib/workflow";
import { asString, mapGet, parseYamlSubset, withoutTrailingNewlines } from "./lib/yaml";

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

// Patterns the expression reader runs over the text, each in one pass: the
// whitespace fold, three that start only at the literal `github`, two that
// start only at `[`, the anchored leading-dot strip, and the table of known
// attacker-controlled paths (each anchored, with only `[^.]+` repeats, which
// stop at the next dot). Listed so the test says which they are.
const ONE_PASS: ReadonlyArray<string> = [
  "\\s+",
  "github\\s*\\.\\s*head_ref",
  "github\\s*\\[\\s*['\"]event['\"]\\s*\\]",
  "github\\s*\\.\\s*event\\s*((?:\\s*[.[][^\\s)},|&!=]*)*)",
  "\\[\\s*['\"]([^'\"]+)['\"]\\s*\\]",
  "\\[\\s*(\\d+)\\s*\\]",
  "^\\.+",
  ...[
    "^issue\\.(?:title|body)$",
    "^pull_request\\.(?:title|body)$",
    "^pull_request\\.head\\.(?:ref|label)$",
    "^pull_request\\.head\\.repo\\.(?:default_branch|description|homepage|full_name|name)$",
    "^(?:comment|review|review_comment)\\.body$",
    "^discussion\\.(?:title|body)$",
    "^head_commit\\.message$",
    "^head_commit\\.(?:author|committer)\\.(?:name|email)$",
    "^commits\\.[^.]+\\.message$",
    "^commits\\.[^.]+\\.(?:author|committer)\\.(?:name|email)$",
    "^workflow_run\\.head_branch$",
    "^workflow_run\\.head_commit\\.message$",
    "^workflow_run\\.head_commit\\.(?:author|committer)\\.(?:name|email)$",
    "^pages\\.[^.]+\\.page_name$",
    "^release\\.(?:name|body|tag_name)$",
    "^milestone\\.(?:title|description)$",
  ],
];
const unlisted = (runs: ReadonlyArray<string>): string[] =>
  runs.filter((r) => !ONE_PASS.some((p) => r.startsWith(`/${p}/`)));

describe("the strips return what the regex forms returned", () => {
  test("withoutTrailingNewlines and /\\n+$/", () => {
    const inputs = [...allStrings(["\n", "\r", "a"], 6), "é\n", "\u{1F600}\n\n"];
    expect(answers(inputs, withoutTrailingNewlines)).toEqual(
      answers(inputs, (s) => s.replace(/\n+$/, "")),
    );
  });

  test("withoutTrailingDots and /\\.+$/", () => {
    const inputs = [...allStrings([".", "a", "["], 6), "pull_request.title.", "é.", "\u{1F600}.."];
    expect(answers(inputs, withoutTrailingDots)).toEqual(
      answers(inputs, (s) => s.replace(/\.+$/, "")),
    );
  });
});

describe("no pattern rescans a run in a workflow", () => {
  // A workflow file is capped at 50 000 lines, so the run fits under that.
  const blanks = "\n".repeat(40_000);

  for (const chomp of ["|-", "|"] as const) {
    test(`a ${chomp} block scalar with a run of blank lines inside it`, () => {
      const text = `run: ${chomp}\n  a\n${blanks}  b\n`;
      const parsed = regexRunsOver(blanks, () => parseYamlSubset(text), ONE_PASS);
      expect(unlisted(parsed.runs)).toEqual([]);
      const doc = (parsed.outcome as ReturnType<typeof parseYamlSubset>).doc;
      expect(asString(mapGet(doc, "run"))).toBe(`a\n${blanks}b${chomp === "|" ? "\n" : ""}`);
    });
  }

  test("an expression whose event path holds a run of dots", () => {
    const dots = ".".repeat(100_000);
    const expr = `github.event.pull_request${dots}title.`;
    // Control: the count sees a pattern String#replace runs over the run.
    const path = `.pull_request${dots}title.`;
    expect(regexRunsOver(dots, () => path.replace(/\.+$/, "")).runs).toEqual([
      `/\\.+$/ over ${path.length} characters`,
    ]);
    const verdict = regexRunsOver(dots, () => classifyExpression(expr), ONE_PASS);
    expect(unlisted(verdict.runs)).toEqual([]);
    // Not a path known to be safe, so it is read as one an outsider may write.
    expect(verdict.outcome).toMatchObject({ tainted: true, severity: "high" });
  });
});
