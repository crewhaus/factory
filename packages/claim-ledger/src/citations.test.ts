import { describe, expect, test } from "bun:test";
import {
  citationDefinitions,
  citedClaims,
  definitionRanges,
  lintCitations,
  markersOutsideCode,
  plainClaim,
} from "./citations";
import { codeSpanTest } from "./markdown";

describe("the marker grammar", () => {
  test("numbers, footnotes and named ids; links, definitions and reference links are not markers", () => {
    const text = "A [1], B [^a], C [A1], D [x.y-z]. A [link](./a.md), [ref][1], and [2]: a source.";
    const report = lintCitations(text);
    expect(report.markers.map((m) => m.marker)).toEqual(["1", "a", "A1", "x.y-z", "1"]);
  });

  test("markers inside fenced and inline code are invisible", () => {
    const text = [
      "Real [1].",
      "```",
      "fake [2]",
      "```",
      "Inline `fake [3]` too.",
      "~~~",
      "[4]",
    ].join("\n");
    expect(lintCitations(text).markers.map((m) => m.marker)).toEqual(["1"]);
  });

  test("markersOutsideCode finds the same set lintCitations does", () => {
    const text = "One [1] and `[2]` and [^b].\n```\n[3]\n```";
    const inCode = codeSpanTest(text);
    expect([...markersOutsideCode(text, inCode)]).toEqual([
      { marker: "1", at: 4 },
      { marker: "b", at: 22 },
    ]);
  });

  test("lines are 1-based", () => {
    const report = lintCitations("Line one.\nLine two [1].");
    expect(report.markers).toEqual([{ marker: "1", line: 2 }]);
  });
});

describe("the definition grammar", () => {
  test("the whole rest of the line is the source; first definition wins", () => {
    const text = [
      "[1]: Smith, J. (2024). Refunds.",
      "[^a]: ./notes.md",
      "[1]: ./second.md",
      "   [2]:   https://acme.example  ",
    ].join("\n");
    expect([...citationDefinitions(text)]).toEqual([
      ["1", "Smith, J. (2024). Refunds."],
      ["a", "./notes.md"],
      ["2", "https://acme.example"],
    ]);
  });

  test("the next-line form: the source may sit on the line under the marker", () => {
    expect([...citationDefinitions("[1]:\n  ./report.md")]).toEqual([["1", "./report.md"]]);
  });

  test("a blank line ends a definition: what follows is prose, not a source", () => {
    expect([...citationDefinitions("[1]:\n\nSome prose here.")]).toEqual([]);
  });

  test("a line that opens its own definition is not swallowed by the one above", () => {
    expect([...citationDefinitions("[1]:\n[2]: ./b.md")]).toEqual([["2", "./b.md"]]);
  });

  test("four spaces of indent is code, not a definition; fenced definitions are ignored", () => {
    expect([...citationDefinitions("    [1]: ./a.md")]).toEqual([]);
    expect([...citationDefinitions("```\n[1]: ./a.md\n```")]).toEqual([]);
  });

  test("definitionRanges covers the marker line and the next-line source", () => {
    const text = "Prose.\n[1]:\n  ./a.md\nMore.";
    const ranges = definitionRanges(text, codeSpanTest(text));
    expect(ranges).toHaveLength(1);
    const [from, to] = ranges[0] as [number, number];
    expect(text.slice(from, to)).toBe("[1]:\n  ./a.md");
  });
});

describe("lintCitations", () => {
  test("undefined markers and uncited sources are reported apart", () => {
    const report = lintCitations("Claim [1]. Claim [2].\n\n[1]: ./a.md\n[3]: ./c.md");
    expect(report.ok).toBe(false);
    expect(report.undefinedMarkers).toEqual([{ marker: "2", line: 1 }]);
    expect(report.uncited).toEqual(["3"]);
    expect(report.defined).toEqual(["1", "3"]);
  });

  test("a document with every marker defined is ok", () => {
    expect(lintCitations("Claim [1].\n\n[1]: ./a.md").ok).toBe(true);
  });
});

describe("citedClaims", () => {
  test("one claim per citing sentence, markers in order, each once", () => {
    const claims = citedClaims(
      "Revenue rose [1] sharply [2] in Q2 [1]. Nothing here. Costs fell [^b].\n\n[1]: ./a.md",
    );
    expect(claims).toEqual([
      { text: "Revenue rose sharply in Q2.", line: 1, markers: ["1", "2"] },
      { text: "Costs fell.", line: 1, markers: ["b"] },
    ]);
  });

  test("the claim is the words: link URLs, bullets and emphasis come out", () => {
    expect(plainClaim("- **Revenue** rose per [the report](./r.md) `today` [1].")).toBe(
      "Revenue rose per the report today.",
    );
  });

  test("abbreviations and initials do not split a claim", () => {
    const claims = citedClaims("As J. Smith noted, e.g. in fig. 3, revenue rose [1].");
    expect(claims).toHaveLength(1);
    expect(claims[0]?.text).toBe("As J. Smith noted, e.g. in fig. 3, revenue rose.");
  });
});
