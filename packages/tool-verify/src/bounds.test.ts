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
 * The timed tests use inputs 0.7.0 needed seconds for and the new code needs
 * milliseconds for, and allow a second: that holds on a runner twenty times
 * slower. Each carries a budget, because on 0.7.0 they run long.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownOutline } from "@crewhaus/tool-text";
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

function within<T>(ms: number, run: () => T): T {
  const t0 = performance.now();
  const out = run();
  expect(performance.now() - t0).toBeLessThan(ms);
  return out;
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
    const anchors = within(1_000, () => headingAnchors(`# a${" ".repeat(3_000)}b\n`));
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
    // 0.7.0: 6.3 s for the first, and quadratic in the run for the second.
    const text = "ab. ".repeat(30_000).trimEnd();
    expect(within(1_000, () => splitSentences(text))).toHaveLength(30_000);
    within(1_000, () => splitSentences(`${"!".repeat(60_000)}x`));
    within(1_000, () => splitSentences(`${".".repeat(60_000)}x`));
    // The abbreviation and initial rules still hold.
    const parts = splitSentences("See e.g. the list. J. Smith agreed. Done.");
    expect(parts).toHaveLength(3);
  }, 60_000);

  test("many links, many code spans, many markers", () => {
    // 0.7.0: 9.3 s for the links, from a line lookup that rescanned the text.
    const links = within(1_000, () => extractMarkdownLinks("[a](x)\n".repeat(40_000)));
    expect(links).toHaveLength(40_000);
    expect(links.at(-1)?.line).toBe(40_000);
    const spanned = within(1_000, () => extractMarkdownLinks("`c` [a](x)\n".repeat(20_000)));
    expect(spanned).toHaveLength(20_000);
    const claims = within(1_000, () => citedClaims("Claim [1]. ".repeat(20_000)));
    expect(claims).toHaveLength(20_000);
    expect(lintCitations("A [1].\n\n[1]: ./x.md\n").ok).toBe(true);
  }, 60_000);

  test("runs of openers do not make every opener rescan to the end", () => {
    within(1_000, () => extractMarkdownLinks("[".repeat(400_000)));
    within(1_000, () => extractMarkdownLinks("<a".repeat(200_000)));
    within(1_000, () => headingAnchors("<a".repeat(200_000)));
    within(1_000, () => extractMarkdownLinks("[x\n".repeat(100_000)));
    // Link text holding a bracket still yields its link.
    expect(extractMarkdownLinks("[a [b](url)")[0]?.href).toBe("url");
  }, 60_000);

  test("a link opener followed by a long run of spaces, or by more openers", () => {
    // Whitespace before the destination, before the title and before the `)`
    // competed for one run of spaces: 40 000 took 2.2 s on the fix round's
    // pattern, and 100 000 about fourteen.
    expect(within(1_000, () => extractMarkdownLinks(`[](${" ".repeat(100_000)}`))).toEqual([]);
    expect(within(1_000, () => extractMarkdownLinks(`[](${" ".repeat(100_000)}x)`))).toHaveLength(
      1,
    );
    // A destination run that reaches into the next opener, from every opener.
    within(1_000, () => extractMarkdownLinks("[](x".repeat(100_000)));
    within(1_000, () => extractMarkdownLinks(`[](${"x".repeat(100_000)}`));
    within(1_000, () => extractMarkdownLinks('[](x "'.repeat(50_000)));
    // Each claim sentence loses its links by the same reader, not a pattern
    // that let every `[](` read to the end of the line.
    const claims = within(1_000, () => citedClaims(`Claim [^1] ${"[](".repeat(60_000)}\n`));
    expect(claims).toHaveLength(1);
  }, 60_000);

  test("MarkdownLinkCheck and FactCrossCheck over openers and spaces", async () => {
    // 4.8 s on 0.7.0 and 6.7 s on the fix round for this README.
    writeFileSync(join(workspace, "README.md"), `# Title\n\nSee [](${" ".repeat(60_000)}\n`);
    let t0 = performance.now();
    const links = JSON.parse(await raw(markdownLinkCheck, {}));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(links).toMatchObject({ ok: true, documents: 1, linksChecked: 0 });
    // 9 s on the fix round: 180 KB of `[](` in one cited sentence.
    writeFileSync(join(workspace, "src.md"), "Claim\n");
    t0 = performance.now();
    const facts = JSON.parse(
      await raw(factCrossCheck, {
        text: `Claim [^1] ${"[](".repeat(60_000)}\n\n[^1]: src.md\n`,
      }),
    );
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(facts).toMatchObject({ checked: 1, claimsFound: 1 });
  }, 60_000);

  test("trailing whitespace is found without retrying every space", async () => {
    const t0 = performance.now();
    const out = await normalizeOutput(`${" ".repeat(100_000)}x  \nb`, {
      apply: ["trailingWhitespace"],
    });
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(out.text).toBe(`${" ".repeat(100_000)}x\nb`);
  }, 60_000);

  test("MarkdownLinkCheck with anchors over a README with a long heading", async () => {
    writeFileSync(join(workspace, "README.md"), `# x\n\n## a${" ".repeat(2_000)}b\n`);
    writeFileSync(join(workspace, "index.md"), "[r](README.md#x)\n".repeat(50));
    const t0 = performance.now();
    const out = JSON.parse(await raw(markdownLinkCheck, { path: ".", checkAnchors: true }));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(out).toMatchObject({ ok: true, linksChecked: 50 });
  }, 60_000);

  test("MarkdownOutline reads the same headings, linearly", async () => {
    const t0 = performance.now();
    const out = JSON.parse(
      (await markdownOutline.execute({ text: `# a${" ".repeat(3_000)}b` }, ctx)) as string,
    );
    expect(performance.now() - t0).toBeLessThan(1_000);
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
      await raw(acceptanceCheck, {
        checks: [
          { kind: "fileMatches", path: "out.txt", pattern: "^(a+)+$" },
          { kind: "fileMatches", path: "out.txt", pattern: "(a|a)*$" },
          { kind: "fileMatches", path: "out.txt", pattern: "a{40}!" },
          { kind: "fileMatches", path: "out.txt", pattern: "b" },
        ],
      }),
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
    const out = await normalizeOutput("port 8080", {
      apply: [],
      replace: [{ pattern: "\\d+", with: "$1 $& $$" }],
    });
    expect(out.text).toBe("port $1 $& $$");
    expect(out.applied).toEqual({ "replace[0]": 1 });
  });
});
