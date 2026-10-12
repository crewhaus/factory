/**
 * Trailing runs are stripped in one pass where a page or a citation is read.
 *
 * `/\/+$/` over a URL's path, `/[^\p{L}\p{N}]+$/u` over anchor text and
 * `/\s+"[^"]*"\s*$/` over a citation's destination each try every start
 * inside a run (of slashes, of decoration, of whitespace) and, when the run
 * is not at the end, rescan the rest of it from each before giving the start
 * up: quadratic in the run's length. A page and a document hold whatever
 * their authors wrote, so each strip reads from the end instead.
 *
 * A test that walks many generated inputs, or every code unit, declares a
 * 20 s budget, as the house does for a test that is slow by construction.
 */
import { describe, expect, test } from "bun:test";
import { factCrossCheck } from "./index";
import { withoutLinkTitle } from "./lib/markdown";
import {
  canonicalForm,
  isUninformativeAnchor,
  pathForm,
  withoutTrailingDecoration,
  withoutTrailingSlashes,
} from "./lib/seo";

/**
 * Every regular expression run over a string holding `run` while `body`
 * runs. Each is recorded once, and one whose source is not in `allowed` is
 * refused on the spot (it throws instead of running), so a pattern that
 * would rescan the run from every position in it fails the test at once
 * instead of being waited out. `String#replace`, `match`, `split`, `search`
 * and `RegExp#test` all go through `exec` once it is replaced. Counted, not
 * timed: the machine's speed decides nothing.
 */
async function regexRunsOver<T>(
  run: string,
  body: () => T | Promise<T>,
  allowed: ReadonlyArray<string> = [],
): Promise<{ runs: string[]; outcome: T | Error }> {
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
    return { runs, outcome: await body() };
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

// Patterns the citation reader runs over a destination, each in one pass:
// the scheme check, anchored at the start, and a test for one whitespace
// character. Listed so the test says which they are.
const ONE_PASS: ReadonlyArray<string> = ["^[a-z][a-z0-9+.-]*:", "\\s"];
const unlisted = (runs: ReadonlyArray<string>): string[] =>
  runs.filter((r) => !ONE_PASS.some((p) => r.startsWith(`/${p}/`)));

describe("the strips return what the regex forms returned", () => {
  test("withoutTrailingSlashes and /\\/+$/", () => {
    const inputs = [...allStrings(["/", "a", "%"], 6), "/a/b//", "/é/", "/\u{1F600}//"];
    expect(answers(inputs, withoutTrailingSlashes)).toEqual(
      answers(inputs, (s) => s.replace(/\/+$/, "")),
    );
  });

  test("withoutTrailingDecoration and /[^\\p{L}\\p{N}]+$/u", () => {
    const inputs = [
      ...allStrings(["a", "1", " ", "»", ".", "\uD83D", "\uDE00"], 4),
      "read more »",
      "read more →",
      "read more...",
      "café ✓",
      "x\u{1F600}",
      "\u{1D7D8}!",
    ];
    // Every code unit, alone and after a letter; and a spread of astral code points.
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(ch, `a${ch}`);
    }
    for (let cp = 0x10000; cp <= 0x10ffff; cp += 0x101) inputs.push(`a${String.fromCodePoint(cp)}`);
    expect(answers(inputs, withoutTrailingDecoration)).toEqual(
      answers(inputs, (s) => s.replace(/[^\p{L}\p{N}]+$/u, "")),
    );
  }, 20_000);

  test('withoutLinkTitle and /\\s+"[^"]*"\\s*$/', () => {
    const title = (s: string): string => s.replace(/\s+"[^"]*"\s*$/, "");
    const inputs = [
      ...allStrings([" ", '"', "a", "\n"], 6),
      './notes.md "The notes"',
      'a "b" "c"  ',
      'x"y" "z"',
      '"only"',
      'é \u3000"\u{1F600}"\u2029',
    ];
    // Every code unit, as the space before a title and as its text.
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      inputs.push(`a${ch}"t"`, `a "${ch}"`, `a "t"${ch}`);
    }
    expect(answers(inputs, withoutLinkTitle)).toEqual(answers(inputs, title));
  }, 20_000);
});

describe("no pattern rescans a run in what a page or a document wrote", () => {
  test("a URL whose path holds a run of slashes before its last segment", async () => {
    const slashes = "/".repeat(100_000);
    const url = new URL(`https://a.example/p${slashes}x/?q=1`);
    // Control: the count sees a pattern String#replace runs over the run.
    expect((await regexRunsOver(slashes, () => url.pathname.replace(/\/+$/, ""))).runs).toEqual([
      `/\\/+$/ over ${url.pathname.length} characters`,
    ]);
    const canonical = await regexRunsOver(slashes, () => canonicalForm(url));
    expect(canonical.runs).toEqual([]);
    expect(canonical.outcome).toBe(`https://a.example/p${slashes}x?q=1`);
    const path = await regexRunsOver(slashes, () =>
      pathForm({ pathname: `/p${slashes}x/`, search: "" }),
    );
    expect(path.runs).toEqual([]);
    expect(path.outcome).toBe(`/p${slashes}x`);
  });

  test("anchor text with a run of decoration before its last word", async () => {
    const decoration = "»".repeat(100_000);
    const text = `read${decoration}more »`;
    // The whitespace fold reads each position once.
    const read = await regexRunsOver(decoration, () => isUninformativeAnchor(text), ["\\s+"]);
    expect(read.runs).toEqual([`/\\s+/ over ${text.length} characters`]);
    expect(read.outcome).toBe(false);
  });

  test("a cited destination with a run of spaces inside it", async () => {
    const spaces = " ".repeat(100_000);
    const destination = `notes${spaces}x.md`;
    const checked = await regexRunsOver(
      spaces,
      () =>
        factCrossCheck.execute({
          claims: [{ text: "the notes say so", sources: [destination] }],
        }),
      ONE_PASS,
    );
    expect(unlisted(checked.runs)).toEqual([]);
    expect(String(checked.outcome)).toContain("unreadable");
  });
});
