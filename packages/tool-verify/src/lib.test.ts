/**
 * The pure core: normalization, and the two Markdown checks.
 *
 * Normalization is where a golden-file system earns or loses its keep. A
 * rule that masks too much hides the regression the golden exists to catch,
 * so each one is pinned to what it should and should not touch.
 */
import { describe, expect, test } from "bun:test";
import {
  citationDefinitions,
  citedClaims,
  extractMarkdownLinks,
  hasUriScheme,
  headingAnchors,
  lintCitations,
  splitLinkTarget,
} from "./lib/markdown";
import { firstDifferences, normalizeOutput } from "./lib/normalize";
import {
  bestSpan,
  contentTokens,
  findSequence,
  indexSource,
  lineOf,
  normalizeToken,
  quotedRuns,
  spanExcerpt,
} from "./lib/spans";

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

  test("a destination splits into the file it names and the fragment after it", () => {
    // One rule, one implementation: the link checker and the cross-checker
    // both ask this which file a destination names, so they cannot disagree.
    expect(splitLinkTarget("./a.md#findings")).toEqual({ target: "./a.md", fragment: "findings" });
    expect(splitLinkTarget("./a.md")).toEqual({ target: "./a.md", fragment: undefined });
    expect(splitLinkTarget("#top")).toEqual({ target: "", fragment: "top" });
  });

  test("a scheme is what makes a destination external, not the word http", () => {
    expect(hasUriScheme("https://x.test/a")).toBe(true);
    expect(hasUriScheme("mailto:a@b.test")).toBe(true);
    expect(hasUriScheme("./http-notes.md")).toBe(false);
    expect(hasUriScheme("docs/a.md")).toBe(false);
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

  test("one rule decides where a source is declared, for both citation tools", () => {
    // Two rules for this drifted: the linter accepted a destination on the
    // line under its marker while the definition reader did not, so
    // FactCrossCheck reported "no source behind it" and credited the finding
    // to CitationLint — which was not making it.
    const wrapped = "Claim [1].\n\n[1]:\n./a.md\n";
    expect(citationDefinitions(wrapped).get("1")).toBe("./a.md");
    expect(lintCitations(wrapped).undefinedMarkers).toEqual([]);

    // A blank line ends a definition, so what follows is prose, not a source.
    const orphan = "Claim [1].\n\n[1]:\n\n./a.md\n";
    expect(citationDefinitions(orphan).has("1")).toBe(false);
    expect(lintCitations(orphan).undefinedMarkers.map((m) => m.marker)).toEqual(["1"]);

    // And a continuation that is itself a definition belongs to its own
    // marker: swallowing it would leave the next source unread.
    const two = citationDefinitions("[1]:\n[2]: ./b.md\n");
    expect(two.has("1")).toBe(false);
    expect(two.get("2")).toBe("./b.md");
    expect(lintCitations("Claim [2].\n\n[1]:\n[2]: ./b.md\n").undefinedMarkers).toEqual([]);
  });
});

describe("the words of a claim", () => {
  test("only an unambiguous thousands grouping is collapsed", () => {
    // `1.200` is 1200 in one locale and 1.2 in another. Guessing would report
    // a different figure as the claimed one, so it is left alone and the
    // claim reads as not found instead.
    expect(normalizeToken("1,200,000")).toBe("1200000");
    expect(normalizeToken("1.200")).toBe("1.200");
    expect(normalizeToken("1,20")).toBe("1,20");
  });

  test("a percentage is not the bare number", () => {
    expect(normalizeToken("4.5%")).toBe("4.5%");
    expect(contentTokens("rose 4.5%")).toEqual(["rose", "4.5%"]);
  });

  test("the plural fold is the only word-ending rule, and it is narrow", () => {
    expect(normalizeToken("regions")).toBe("region");
    expect(normalizeToken("class")).toBe("class");
    expect(normalizeToken("gas")).toBe("gas");
    expect(normalizeToken("company's")).toBe("company");
    // No stemming: a different tense is a different word, and the claim is
    // reported as not found rather than quietly supported.
    expect(normalizeToken("completed")).toBe("completed");
  });

  test("stopwords go, negations stay", () => {
    // Dropping the "not" would let a source saying the opposite answer for
    // the claim, which is the one way word-matching lies.
    expect(contentTokens("The budget was not approved by the board")).toEqual([
      "budget",
      "not",
      "approved",
      "board",
    ]);
  });

  test("each word is needed once, in the order the claim wrote it", () => {
    expect(contentTokens("budget budget board")).toEqual(["budget", "board"]);
  });
});

describe("locating a claim in a source", () => {
  const index = indexSource("Alpha beta gamma.\nThe budget was not approved by the board.\n");

  test("every word in one span is a hit, with the span itself", () => {
    const span = bestSpan(index, contentTokens("budget approved board"), 60);
    expect(span.matched).toBe(span.total);
    expect(span.missing).toEqual([]);
    expect(spanExcerpt(index, span.firstToken, span.lastToken, 200)).toBe(
      "budget was not approved by the board",
    );
    expect(lineOf(index, 20)).toBe(2);
  });

  test("a word the source lacks is named, not just counted", () => {
    const span = bestSpan(index, contentTokens("budget doubled board"), 60);
    expect(span.matched).toBe(2);
    expect(span.missing).toEqual(["doubled"]);
  });

  test("the window is a limit on how far apart the words may sit", () => {
    const spread = indexSource(`alpha ${"filler ".repeat(30)}omega`);
    expect(bestSpan(spread, ["alpha", "omega"], 5).matched).toBe(1);
    expect(bestSpan(spread, ["alpha", "omega"], 60).matched).toBe(2);
  });

  test("two equally good spans resolve to the earlier one, always", () => {
    // Which of two identical spans is reported must not depend on the order
    // they happen to be visited in.
    const twice = indexSource("alpha omega\nfiller\nalpha omega\n");
    expect(bestSpan(twice, ["alpha", "omega"], 10).firstToken).toBe(0);
  });

  test("a negation counts only inside the matched span, not anywhere near it", () => {
    // A "not" thirty words away belongs to another sentence. Reporting it
    // would turn every long paragraph into a polarity conflict.
    const far = indexSource(`budget approved board ${"filler ".repeat(10)} not`);
    expect(bestSpan(far, ["budget", "approved", "board"], 60).extraNegations).toEqual([]);
    const near = indexSource("budget was not approved by the board");
    expect(bestSpan(near, ["budget", "approved", "board"], 60).extraNegations).toEqual(["not"]);
  });

  test("nothing in common is reported as nothing, not as an empty span", () => {
    const span = bestSpan(index, ["nowhere"], 60);
    expect(span).toMatchObject({ matched: 0, firstToken: -1, missing: ["nowhere"] });
    expect(spanExcerpt(index, -1, -1, 50)).toBe("");
  });
});

describe("a quotation", () => {
  const index = indexSource('He said "the rollout was slower than we expected" on the call.');

  test("is found only as consecutive words, punctuation aside", () => {
    expect(findSequence(index, ["the", "rollout", "was", "slower"])).toBe(2);
    expect(findSequence(index, ["rollout", "slower"])).toBe(-1);
  });

  test("is taken from double quotes only, and only when it is long enough", () => {
    // An apostrophe is a single quote far more often than a quotation is.
    expect(quotedRuns("the company's own words were plain", 4)).toEqual([]);
    expect(quotedRuns('it said "too short" here', 4)).toEqual([]);
    expect(quotedRuns('it said "four whole words here" once', 4)).toEqual([
      ["four", "whole", "word", "here"],
    ]);
  });
});

describe("claims in a document", () => {
  test("a marker attaches to the sentence it sits in, not the next one", () => {
    const claims = citedClaims("Revenue rose [1]. Costs fell.\n");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ text: "Revenue rose.", line: 1, markers: ["1"] });
  });

  test("two markers in one sentence are one claim with two sources", () => {
    expect(citedClaims("Both agree [1] [2].\n")[0]?.markers).toEqual(["1", "2"]);
  });

  test("an abbreviation does not end a sentence, and a heading does", () => {
    expect(citedClaims("Vendors, e.g. the big ones, agreed [1].\n")[0]?.text).toBe(
      "Vendors, e.g. the big ones, agreed.",
    );
    expect(citedClaims("# Findings\nRevenue rose [1].\n")[0]?.text).toBe("Revenue rose.");
  });

  test("each list item is its own claim", () => {
    const claims = citedClaims("- first thing [1]\n- second thing [2]\n");
    expect(claims.map((c) => c.text)).toEqual(["first thing", "second thing"]);
  });

  test("a marker inside a code block is not a claim", () => {
    expect(citedClaims("```\nnot a claim [1]\n```\n")).toEqual([]);
  });

  test("a definition is the whole rest of its line, and the first one wins", () => {
    // Taking only the first word would turn "Smith, J. (2024)" into a file
    // called "Smith," and report a printed source as a missing one.
    const definitions = citationDefinitions(
      '[1]: ./a.md "Title"\n[2]: Smith, J. (2024). Something.\n[1]: ./b.md\n',
    );
    expect(definitions.get("1")).toBe('./a.md "Title"');
    expect(definitions.get("2")).toBe("Smith, J. (2024). Something.");
  });
});
