/**
 * The pure core: normalization, and the two Markdown checks.
 *
 * Normalization is where a golden-file system earns or loses its keep. A
 * rule that masks too much hides the regression the golden exists to catch,
 * so each one is pinned to what it should and should not touch.
 */
import { describe, expect, test } from "bun:test";
import { extractMarkdownLinks, headingAnchors, lintCitations } from "./lib/markdown";
import { firstDifferences, normalizeOutput } from "./lib/normalize";

const norm = (text: string, apply: string[], root?: string) =>
  normalizeOutput(text, { apply: apply as never, root });

describe("normalization", () => {
  test("nothing is masked unless it is asked for", () => {
    const text = "at 2026-01-02T03:04:05Z";
    expect(norm(text, []).text).toBe(text);
    expect(norm(text, []).applied).toEqual({});
  });

  test("each rule masks its own shape and reports a count", () => {
    expect(norm("at 2026-01-02T03:04:05.123Z done", ["timestamps"])).toEqual({
      text: "at <timestamp> done",
      applied: { timestamps: 1 },
    });
    expect(norm("took 1.5s and 240ms", ["durations"]).text).toBe("took <duration> and <duration>");
    expect(norm("id 7f3e4d2a-1b9c-4e5f-8a7b-6c5d4e3f2a1b", ["uuids"]).text).toBe("id <uuid>");
    expect(norm(`sha ${"a".repeat(40)}`, ["hashes"]).text).toBe("sha <hash>");
    expect(norm("http://localhost:3000/x", ["ports"]).text).toBe("http://localhost:<port>/x");
  });

  test("a mask never eats the text beside it", () => {
    // A rule that took more than its shape would hide a regression inside
    // the mask, which is worse than a golden that fails too often.
    expect(norm("before 2026-01-02T03:04:05Z after", ["timestamps"]).text).toBe(
      "before <timestamp> after",
    );
    expect(norm("v1.2.3 released", ["durations"]).text).toBe("v1.2.3 released");
    expect(norm("the word deadbeef here", ["hashes"]).text).toBe("the word deadbeef here");
  });

  test("absolute paths are replaced before the rules that would mangle them", () => {
    // A temp directory carries digits a later rule would mask, leaving the
    // path unrecognisable.
    const result = norm(
      "/tmp/run-12345/out.txt failed",
      ["absolutePaths", "ports"],
      "/tmp/run-12345",
    );
    expect(result.text).toBe("<root>/out.txt failed");
    expect(result.applied["absolutePaths"]).toBe(1);
  });

  test("ANSI escapes are stripped without touching the text", () => {
    const esc = String.fromCharCode(27);
    expect(norm(`${esc}[31mred${esc}[0m text`, ["ansi"]).text).toBe("red text");
  });

  test("whitespace rules are separate, so one can be applied without the others", () => {
    expect(norm("a  \nb", ["trailingWhitespace"]).text).toBe("a\nb");
    expect(norm("a\r\nb", ["crlf"]).text).toBe("a\nb");
    expect(norm("a\n\n\n\n\nb", ["blankLines"]).text).toBe("a\n\nb");
  });

  test("caller rules run after the builtins and are counted separately", () => {
    const result = normalizeOutput("build 42 in 3s", {
      apply: ["durations"],
      replace: [{ pattern: "\\d+", with: "<n>" }],
    });
    expect(result.text).toBe("build <n> in <duration>");
    expect(result.applied).toEqual({ durations: 1, "replace[0]": 1 });
  });

  test("an invalid caller pattern names which rule it was", () => {
    expect(() =>
      normalizeOutput("x", { apply: [], replace: [{ pattern: "([a-", with: "" }] }),
    ).toThrow(/replace rule 0/);
  });
});

describe("first differences", () => {
  test("reports the differing lines and stops at the limit", () => {
    expect(firstDifferences("a\nb\nc", "a\nB\nC", 10)).toEqual([
      { line: 2, expected: "b", actual: "B" },
      { line: 3, expected: "c", actual: "C" },
    ]);
    expect(firstDifferences("a\nb\nc", "A\nB\nC", 1)).toHaveLength(1);
  });

  test("a line present on one side only is reported as null on the other", () => {
    expect(firstDifferences("a", "a\nb", 5)).toEqual([{ line: 2, expected: null, actual: "b" }]);
  });

  test("identical text has no differences", () => {
    expect(firstDifferences("same", "same", 5)).toEqual([]);
  });
});

describe("Markdown links", () => {
  const doc = `# Title

[inline](./a.md) and ![img](./i.png) and [ref][r] and <a href="./h.md">html</a>

[r]: ./b.md

\`\`\`
[incode](./never.md)
\`\`\`

\`[inline-code](./nope.md)\`
`;

  test("inline, image, reference and raw HTML links are all found", () => {
    const kinds = extractMarkdownLinks(doc).map((l) => `${l.kind}:${l.href}`);
    expect(kinds).toContain("inline:./a.md");
    expect(kinds).toContain("image:./i.png");
    expect(kinds).toContain("reference:./b.md");
    expect(kinds).toContain("html:./h.md");
  });

  test("links inside code are ignored, because a path in an example is not a promise", () => {
    const hrefs = extractMarkdownLinks(doc).map((l) => l.href);
    expect(hrefs).not.toContain("./never.md");
    expect(hrefs).not.toContain("./nope.md");
  });

  test("an unclosed fence swallows the rest, as a renderer does", () => {
    expect(extractMarkdownLinks("```\n[x](./y.md)\n")).toEqual([]);
  });

  test("line numbers point at the link", () => {
    expect(extractMarkdownLinks("a\n\n[x](./y.md)")[0]?.line).toBe(3);
  });

  test("a reference with no definition is not reported as a link", () => {
    expect(extractMarkdownLinks("[x][missing]")).toEqual([]);
  });

  test("heading anchors follow the usual slug rules, including duplicates", () => {
    const anchors = headingAnchors("# Hello, World!\n## Hello, World!\n### Ünïcode Ok\n");
    expect(anchors.has("hello-world")).toBe(true);
    expect(anchors.has("hello-world-1")).toBe(true);
    expect(anchors.has("ünïcode-ok")).toBe(true);
  });

  test("an explicit anchor element counts as an anchor", () => {
    expect(headingAnchors('<a name="manual"></a>').has("manual")).toBe(true);
  });
});

describe("citations", () => {
  test("a marker with no source and a source nobody cited are kept apart", () => {
    // The first is a claim with nothing behind it; the second is untidy.
    const report = lintCitations(
      "Claim [1] and [2].\n\n[1]: https://a.test\n[3]: https://c.test\n",
    );
    expect(report.undefinedMarkers.map((m) => m.marker)).toEqual(["2"]);
    expect(report.uncited).toEqual(["3"]);
    expect(report.ok).toBe(false);
  });

  test("a document where every marker resolves is ok even with an uncited source", () => {
    const report = lintCitations("Claim [1].\n\n[1]: https://a.test\n[2]: https://b.test\n");
    expect(report.ok).toBe(true);
    expect(report.uncited).toEqual(["2"]);
  });

  test("footnote syntax is recognised too", () => {
    const report = lintCitations("Claim [^a].\n\n[^a]: source\n");
    expect(report.ok).toBe(true);
    expect(report.markers.map((m) => m.marker)).toEqual(["a"]);
  });

  test("a link is not a citation marker", () => {
    // `[text](url)` and `[id]: url` must not be counted as citations.
    const report = lintCitations("See [the docs](https://x.test) and [1].\n\n[1]: s\n");
    expect(report.markers.map((m) => m.marker)).toEqual(["1"]);
  });

  test("markers inside code are ignored", () => {
    expect(lintCitations("```\n[1]\n```\n").markers).toEqual([]);
  });

  test("a document with no citations at all passes", () => {
    expect(lintCitations("Just prose.").ok).toBe(true);
  });
});
