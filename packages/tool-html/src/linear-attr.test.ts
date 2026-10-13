/**
 * An attribute selector is read left to right.
 *
 * `/^\s*([\w:-]+)\s*(?:([~^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]*))\s*(i)?)?\s*$/`
 * shares a run of whitespace between up to three `\s*` and tries every split
 * of it before giving up: a run of spaces before a stray character cost the
 * cube of its length (4 096 spaces took about 15 s, and the 8 192-character
 * selector cap allowed twice that). The selector is the model's, so the read
 * is a scan.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { attrSelectorParts, parseSelectorGroup } from "./lib/select";

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

const ATTR = /^\s*([\w:-]+)\s*(?:([~^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]*))\s*(i)?)?\s*$/;
const groups = (m: ArrayLike<string | undefined> | null): (string | undefined)[] | null =>
  m === null ? null : [1, 2, 3, 4, 5, 6].map((k) => m[k]);

// Patterns the selector reader runs over the whole compound, each in one
// pass: the anchored compound shape, whose parts each start with their own
// character, and the part scanner, whose bracket part ends at the first `]`.
const ONE_PASS: ReadonlyArray<string> = [
  "^(\\*|[a-zA-Z][\\w-]*)?((?:#[\\w-]+|\\.[\\w-]+|\\[[^\\]]*\\]|:[a-zA-Z-]+(?:\\([^)]*\\))?)*)$",
  "#([\\w-]+)|\\.([\\w-]+)|\\[([^\\]]*)\\]|:([a-zA-Z-]+)(?:\\(([^)]*)\\))?",
];

describe("an attribute selector", () => {
  test("attrSelectorParts captures what the pattern captured", () => {
    const inputs = [
      ...allStrings(["a", "=", '"', "'", " ", "i", "~", "x"], 4),
      'data-x="1" i',
      "href^='https:' ",
      "lang|=en",
      "a=b]",
      'a="b"c',
    ];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      // Before the operator (the name and the whitespace set), after a bare
      // value (its class, the whitespace set again, the flag), and as the
      // flag itself after a bare and a quoted value: only `i` is one, not `I`.
      inputs.push(`a${ch}=b`, `a=b${ch}i`, `a=b ${ch}`, `a="b"${ch}`);
    }
    expect(answers(inputs, (s) => groups(attrSelectorParts(s)))).toEqual(
      answers(inputs, (s) => groups(ATTR.exec(s))),
    );
  }, 20_000);

  test("no pattern rescans a run of spaces inside an attribute selector", () => {
    const spaces = " ".repeat(8_000);
    const selector = `div[a=${spaces}x y]`;
    // Control: the count sees the old pattern run over the spaces (refused,
    // not run: it would take seconds).
    const body = selector.slice(4, -1);
    expect(regexRunsOver(spaces, () => ATTR.exec(body)).runs).toEqual([
      `/${ATTR.source}/ over ${body.length} characters`,
    ]);
    const parsed = regexRunsOver(spaces, () => parseSelectorGroup(selector), ONE_PASS);
    expect(parsed.runs.filter((r) => !ONE_PASS.some((p) => r.startsWith(`/${p}/`)))).toEqual([]);
    expect(String(parsed.outcome)).toContain("is not an attribute selector this understands");
    const half = " ".repeat(4_000);
    expect(parseSelectorGroup(`div[a=${half}x${half}i]`)).toMatchObject([
      [{ simple: { attrs: [{ name: "a", op: "=", value: "x", insensitive: true }] } }],
    ]);
  });
});
