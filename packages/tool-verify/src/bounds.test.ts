/**
 * The Markdown readers are linear, and caller patterns never run on the
 * harness thread.
 *
 * MarkdownLinkCheck, CitationLint and FactCrossCheck read workspace Markdown
 * anyone can put in a checkout, synchronously. In 0.7.0 the heading regex was
 * cubic (a 2 KB README with a long heading took about two seconds, 10 KB
 * minutes), the sentence splitter copied the text up to every full stop, and
 * the line and code-span lookups rescanned per hit. AcceptanceCheck and the
 * Golden tools ran the caller's own regex with a plain `RegExp`.
 *
 * The linear tests count the readers' work instead of timing it: every
 * pattern's backtracking steps (__test__/regex-work.ts), and the characters
 * the string methods copy or search and the elements the array searches
 * visit (__test__/js-work.ts). The readers take at most 45 steps, and under
 * 3 of the rest, a character of input. 0.7.0's work per character grew with
 * the input, so most inputs here are a tenth of the size it needed seconds
 * for, which still leaves each of its defects more than ten times over the
 * bound. A count past its bound stops the reader there and reads as
 * Infinity, so a quadratic reader fails at once rather than in minutes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REGEX_RUN_DEFAULTS } from "@crewhaus/tool-safety/regex";
import { markdownOutline } from "@crewhaus/tool-text";
import { type JsWork, jsWork, jsWorkAsync } from "./__test__/js-work";
import { type RegexWork, regexWork, regexWorkAsync } from "./__test__/regex-work";
import {
  type VERIFY_TOOLS,
  acceptanceCheck,
  factCrossCheck,
  goldenCompare,
  goldenUpdate,
  markdownLinkCheck,
} from "./index";
import {
  citedClaims,
  extractMarkdownLinks,
  headingAnchors,
  lintCitations,
  splitSentences,
} from "./lib/markdown";
import { normalizeOutput } from "./lib/normalize";

const originalCwd = process.cwd();
let workspace: string;

// biome-ignore lint/suspicious/noExplicitAny: the tools read no context.
const ctx = {} as any;

async function raw(tool: (typeof VERIFY_TOOLS)[number], input: unknown): Promise<string> {
  return (await tool.execute(tool.inputSchema.parse(input), ctx)) as string;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-verify-bounds-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

/** Backtracking steps a reader may take per character of input; 45 at most here. */
const STEPS_PER_CHARACTER = 128;
/** Characters copied or searched, and elements visited, per character; under 3 here. */
const WORK_PER_CHARACTER = 8;

/** What `run` returns, once its work on `size` characters of input is shown linear. */
function linear<T>(size: number, run: () => T): T {
  return linearIn(
    size,
    regexWork(STEPS_PER_CHARACTER * size, () => jsWork(WORK_PER_CHARACTER * size, run)),
  );
}

async function linearAsync<T>(size: number, run: () => Promise<T>): Promise<T> {
  return linearIn(
    size,
    await regexWorkAsync(STEPS_PER_CHARACTER * size, () =>
      jsWorkAsync(WORK_PER_CHARACTER * size, run),
    ),
  );
}

function linearIn<T>(size: number, counted: RegexWork<JsWork<T>>): T {
  expect(counted.unmodelled).toEqual([]);
  expect(counted.steps).toBeLessThanOrEqual(STEPS_PER_CHARACTER * size);
  expect(counted.value?.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * size);
  return counted.value?.value as T;
}

/**
 * Run `body` with the regex worker's give-up threshold out of any runner's
 * reach. The worker reports a failing `exec` that took 100 ms as the engine
 * giving up, never as "no match", so a worker thread a loaded runner stalls
 * that long inside one turns "does not match" into "could not verify". The
 * 5 s deadline still stops a pattern that hangs.
 */
async function withoutGiveUp<T>(body: () => Promise<T>): Promise<T> {
  const defaults = REGEX_RUN_DEFAULTS as { giveUpMs: number };
  const giveUpMs = defaults.giveUpMs;
  defaults.giveUpMs = 60_000;
  try {
    return await body();
  } finally {
    defaults.giveUpMs = giveUpMs;
  }
}

/** 0.7.0's heading reader, as the parity oracle. */
function oldAnchors(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)) {
    const slug = (m[2] as string)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    if (slug !== "") out.push(slug);
  }
  return out;
}

describe("the Markdown readers do linear work", () => {
  test("a heading with a long run of spaces", () => {
    // 0.7.0: 6.7 s for this one line.
    const line = `# a${" ".repeat(3_000)}b\n`;
    const anchors = linear(line.length, () => headingAnchors(line));
    expect(anchors.has("a-b")).toBe(true);
  }, 60_000);

  test("heading anchors are the ones 0.7.0 gave, except where it misread CommonMark", () => {
    const cases = [
      "# Title",
      "## Title ##",
      "# C#",
      "# Foo#bar",
      "###   spaced   out   ###  ",
      "# Émile Zola",
      "#NoSpace",
      "####### seven",
      "# a - b",
      "#\tTabbed #",
      "## Trailing\r",
    ];
    for (const line of cases) {
      expect({ line, anchors: [...headingAnchors(line)] }).toEqual({
        line,
        anchors: oldAnchors(line),
      });
    }
    // `\s+` let a lone `#` swallow the next line as its title; CommonMark
    // needs a space or a tab on the same line.
    expect(oldAnchors("#\nfoo")).toEqual(["foo"]);
    expect([...headingAnchors("#\nfoo")]).toEqual([]);
  });

  test("splitting sentences, and a run of punctuation", () => {
    // 0.7.0: 6.3 s for ten times as many sentences, and quadratic in the run.
    const text = "ab. ".repeat(3_000).trimEnd();
    expect(linear(text.length, () => splitSentences(text))).toHaveLength(3_000);
    for (const run of [`${"!".repeat(6_000)}x`, `${".".repeat(6_000)}x`]) {
      expect(linear(run.length, () => splitSentences(run))).toEqual([
        { start: 0, end: run.length },
      ]);
    }
    // The abbreviation and initial rules still hold.
    const parts = splitSentences("See e.g. the list. J. Smith agreed. Done.");
    expect(parts).toHaveLength(3);
  }, 60_000);

  test("many links, many code spans, many markers", () => {
    // 0.7.0: 9.3 s for ten times as many links, from a line lookup that
    // rescanned the text; each hit was also tested against every code span.
    const many = "[a](x)\n".repeat(4_000);
    const links = linear(many.length, () => extractMarkdownLinks(many));
    expect(links).toHaveLength(4_000);
    expect(links.at(-1)?.line).toBe(4_000);
    const coded = "`c` [a](x)\n".repeat(2_000);
    const spanned = linear(coded.length, () => extractMarkdownLinks(coded));
    expect(spanned).toHaveLength(2_000);
    const cited = "Claim [1]. ".repeat(2_000);
    const claims = linear(cited.length, () => citedClaims(cited));
    expect(claims).toHaveLength(2_000);
    expect(lintCitations("A [1].\n\n[1]: ./x.md\n").ok).toBe(true);
  }, 60_000);

  test("runs of openers do not make every opener rescan to the end", () => {
    for (const text of ["[".repeat(40_000), "<a".repeat(20_000), "[x\n".repeat(10_000)]) {
      expect(linear(text.length, () => extractMarkdownLinks(text))).toEqual([]);
    }
    const openers = "<a".repeat(20_000);
    expect(linear(openers.length, () => headingAnchors(openers)).size).toBe(0);
    // Link text holding a bracket still yields its link.
    expect(extractMarkdownLinks("[a [b](url)")[0]?.href).toBe("url");
  }, 60_000);

  test("a link opener followed by a long run of spaces, or by more openers", () => {
    // Whitespace before the destination, before the title and before the `)`
    // competed for one run of spaces: 40 000 took 2.2 s on the fix round's
    // pattern, and 100 000 (ten times the run here) about fourteen.
    const unclosed = `[](${" ".repeat(10_000)}`;
    expect(linear(unclosed.length, () => extractMarkdownLinks(unclosed))).toEqual([]);
    const closed = `[](${" ".repeat(10_000)}x)`;
    expect(linear(closed.length, () => extractMarkdownLinks(closed))).toHaveLength(1);
    // A destination run that reaches into the next opener, from every opener.
    for (const text of [
      "[](x".repeat(10_000),
      `[](${"x".repeat(10_000)}`,
      '[](x "'.repeat(5_000),
    ]) {
      expect(linear(text.length, () => extractMarkdownLinks(text))).toEqual([]);
    }
    // Each claim sentence loses its links by the same reader, not a pattern
    // that let every `[](` read to the end of the line.
    const sentence = `Claim [^1] ${"[](".repeat(6_000)}\n`;
    const claims = linear(sentence.length, () => citedClaims(sentence));
    expect(claims).toHaveLength(1);
  }, 60_000);

  test("MarkdownLinkCheck and FactCrossCheck over openers and spaces", async () => {
    // 4.8 s on 0.7.0 and 6.7 s on the fix round for this README with ten
    // times the spaces.
    const readme = `# Title\n\nSee [](${" ".repeat(6_000)}\n`;
    writeFileSync(join(workspace, "README.md"), readme);
    const links = JSON.parse(await linearAsync(readme.length, () => raw(markdownLinkCheck, {})));
    expect(links).toMatchObject({ ok: true, documents: 1, linksChecked: 0 });
    // 9 s on the fix round: 180 KB of `[](` in one cited sentence (18 KB here).
    writeFileSync(join(workspace, "src.md"), "Claim\n");
    const text = `Claim [^1] ${"[](".repeat(6_000)}\n\n[^1]: src.md\n`;
    const facts = JSON.parse(await linearAsync(text.length, () => raw(factCrossCheck, { text })));
    expect(facts).toMatchObject({ checked: 1, claimsFound: 1 });
  }, 60_000);

  test("trailing whitespace is found without retrying every space", async () => {
    const text = `${" ".repeat(100_000)}x  \nb`;
    const out = await linearAsync(text.length, () =>
      normalizeOutput(text, { apply: ["trailingWhitespace"] }),
    );
    expect(out.text).toBe(`${" ".repeat(100_000)}x\nb`);
  }, 60_000);

  test("MarkdownLinkCheck with anchors over a README with a long heading", async () => {
    const readme = `# x\n\n## a${" ".repeat(2_000)}b\n`;
    const index = "[r](README.md#x)\n".repeat(50);
    writeFileSync(join(workspace, "README.md"), readme);
    writeFileSync(join(workspace, "index.md"), index);
    const out = JSON.parse(
      await linearAsync(readme.length + index.length, () =>
        raw(markdownLinkCheck, { path: ".", checkAnchors: true }),
      ),
    );
    expect(out).toMatchObject({ ok: true, linksChecked: 50 });
  }, 60_000);

  test("MarkdownOutline reads the same headings, linearly", async () => {
    const text = `# a${" ".repeat(3_000)}b`;
    const out = JSON.parse(
      (await linearAsync(text.length, () => markdownOutline.execute({ text }, ctx))) as string,
    );
    expect(out.headings[0].title).toMatch(/^a +b$/);
    const titles = JSON.parse(
      (await markdownOutline.execute(
        { text: "## Title ##\n# C#\n#\nnot a heading\n# Crlf #\r\n" },
        ctx,
      )) as string,
    ).headings.map((h: { title: string }) => h.title);
    expect(titles).toEqual(["Title", "C#", "Crlf"]);
  }, 60_000);
});

describe("a caller's pattern runs in a worker, and an unanswerable check fails closed", () => {
  test("AcceptanceCheck refuses an exponential pattern, naming why", async () => {
    writeFileSync(join(workspace, "out.txt"), `${"a".repeat(40)}!`);
    const out = JSON.parse(
      await withoutGiveUp(() =>
        raw(acceptanceCheck, {
          checks: [
            { kind: "fileMatches", path: "out.txt", pattern: "^(a+)+$" },
            { kind: "fileMatches", path: "out.txt", pattern: "(a|a)*$" },
            { kind: "fileMatches", path: "out.txt", pattern: "a{40}!" },
            { kind: "fileMatches", path: "out.txt", pattern: "b" },
          ],
        }),
      ),
    );
    expect(out.results.map((r: { ok: boolean }) => r.ok)).toEqual([false, false, true, false]);
    expect(out.results[0].detail).toMatch(/^invalid pattern: .*exponential/);
    expect(out.results[1].detail).toMatch(/^invalid pattern: .*exponential/);
    expect(out.results[3].detail).toBe("the pattern does not match");
  });

  test("a polynomial pattern that outlives its deadline is undetermined, not 'does not match'", async () => {
    // `a*a*a*b` passes every shape screen and is cubic: 0.7.0 held the
    // thread for minutes on this, then answered "does not match".
    writeFileSync(join(workspace, "big.txt"), "a".repeat(20_000));
    const out = JSON.parse(
      await raw(acceptanceCheck, {
        checks: [{ kind: "fileMatches", path: "big.txt", pattern: "a*a*a*b" }],
      }),
    );
    expect(out.ok).toBe(false);
    expect(out.results[0]).toMatchObject({ ok: false, undetermined: true });
    expect(out.results[0].detail).toMatch(/^could not verify: undetermined \((timeout|gave-up)\)/);
  }, 60_000);

  test("a Golden replace rule is screened, and a refusal is not a verdict", async () => {
    await expect(
      normalizeOutput(`${"a".repeat(40)}!`, {
        apply: [],
        replace: [{ pattern: "^(a+)+$", with: "" }],
      }),
    ).rejects.toThrow(/replace rule 0 has an invalid pattern/);
    writeFileSync(join(workspace, "g.txt"), "x\n");
    const compared = await raw(goldenCompare, {
      actual: "x\n",
      golden: "g.txt",
      replace: [{ pattern: "(a|a)*$", with: "" }],
    });
    expect(compared).toMatch(/^GoldenCompare could not compare, so this is not a verdict: /);
    const updated = await raw(goldenUpdate, {
      actual: "y\n",
      golden: "g.txt",
      replace: [{ pattern: "(a|a)*$", with: "" }],
    });
    expect(updated).toMatch(/^GoldenUpdate wrote nothing: replace rule 0/);
  });

  test("a replace rule's `with` is literal text, as before", async () => {
    const out = await withoutGiveUp(() =>
      normalizeOutput("port 8080", {
        apply: [],
        replace: [{ pattern: "\\d+", with: "$1 $& $$" }],
      }),
    );
    expect(out.text).toBe("port $1 $& $$");
    expect(out.applied).toEqual({ "replace[0]": 1 });
  });
});
