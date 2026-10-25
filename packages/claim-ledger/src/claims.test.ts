import { describe, expect, test } from "bun:test";
import { citationDefinitions, citedClaims, lintCitations } from "./citations";
import { extractClaims } from "./claims";
import { isQuestion } from "./sentences";

const texts = (text: string, minTokens?: number) =>
  extractClaims(text, minTokens === undefined ? {} : { minTokens }).map((c) => c.text);

/**
 * "linear" when one read of `make(16 * n)` takes under four times as long as
 * sixteen reads of `make(n)` back to back, plus 100 ms for a busy runner to
 * hold a run up once: the same work when the reading is linear, sixteen
 * times as much when it is quadratic. Equal work on both sides, because a
 * loaded runner stretches a run by the time it waits for a core: a short
 * run can finish between two waits that a run four times as long sits
 * through, so a short run against a long one fails where nothing is wrong.
 * The same shape at both sizes, never a different one, whose cost need not
 * scale alike on another machine; the least of three of each, interleaved,
 * from a collected heap, so load and garbage only ever add to a run.
 * Otherwise the two times, for the failure to show.
 */
const readsLinearly = (make: (n: number) => string, n: number): string => {
  const small = make(n);
  const large = make(16 * n);
  let sixteen = Number.POSITIVE_INFINITY;
  let once = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    Bun.gc(true);
    let start = performance.now();
    for (let k = 0; k < 16; k++) extractClaims(small);
    sixteen = Math.min(sixteen, performance.now() - start);
    Bun.gc(true);
    start = performance.now();
    extractClaims(large);
    once = Math.min(once, performance.now() - start);
  }
  return once < sixteen * 4 + 100
    ? "linear"
    : `${sixteen.toFixed(1)} ms for 16 at n, ${once.toFixed(1)} ms for 1 at 16n`;
};

describe("extractClaims — what is a claim", () => {
  test("cited and uncited claims, in order, with their markers", () => {
    const claims = extractClaims(
      "The refund window is 14 days [1]. Shipping is free within the EU. Returns need a receipt [2][^a].",
    );
    expect(claims.map(({ text, markers, index }) => ({ index, text, markers }))).toEqual([
      { index: 0, text: "The refund window is 14 days.", markers: ["1"] },
      { index: 1, text: "Shipping is free within the EU.", markers: [] },
      { index: 2, text: "Returns need a receipt.", markers: ["a"] },
    ]);
  });

  test("raw keeps the markers and the Markdown; text is the words", () => {
    const [claim] = extractClaims("- **Revenue** rose per [the report](./r.md) [1].");
    expect(claim?.raw).toBe("- **Revenue** rose per [the report](./r.md) [1].");
    expect(claim?.text).toBe("Revenue rose per the report.");
    expect(claim?.markers).toEqual(["1"]);
  });

  test("marker ids are normalized the way citationDefinitions keys them, each once", () => {
    const [claim] = extractClaims("Fiscal year starts in April [A1] [^note] [A1] [3].");
    expect(claim?.markers).toEqual(["A1", "note", "3"]);
  });

  test("questions are not claims, cited or not", () => {
    expect(texts("Is the refund window 14 days? Which customers qualify for refunds [1]?")).toEqual(
      [],
    );
  });

  test("a number word makes a claim however short, as a numeral does (design §2)", () => {
    expect(texts("Seats: twelve.")).toEqual(["Seats: twelve."]);
    expect(texts("Seats: 12.")).toEqual(["Seats: 12."]);
    expect(texts("It holds a dozen.")).toEqual(["It holds a dozen."]);
    expect(texts("Uptime: half.")).toEqual(["Uptime: half."]);
    expect(texts("Acme ranked third.")).toEqual(["Acme ranked third."]);
    // "one" is a pronoun before it is a count, and a list-counting "First,"
    // states no rank: neither makes a short sentence a claim.
    expect(texts("Pick one. One moment.")).toEqual([]);
    expect(texts("First, thanks.")).toEqual([]);
  });

  test("filler too short to verify is skipped", () => {
    expect(texts("Sure thing. Done. I hope this helps!")).toEqual([]);
  });

  test("minTokens sets the bar for uncited, number-free sentences", () => {
    expect(texts("Shipping is free.", 3)).toEqual([]);
    expect(texts("Shipping is free.", 2)).toEqual(["Shipping is free."]);
    // refunds, take, several, business, days, process: six content words.
    expect(texts("Refunds take several business days to process.", 6)).toHaveLength(1);
    expect(texts("Refunds take several business days to process.", 7)).toEqual([]);
  });

  test("a malformed minTokens falls back to the default", () => {
    expect(texts("Shipping is free within the EU.", Number.NaN)).toEqual([
      "Shipping is free within the EU.",
    ]);
  });

  test("a marker or a number makes a claim however short", () => {
    expect(texts("The total is 1,284.50.")).toEqual(["The total is 1,284.50."]);
    expect(texts("Revenue rose 12% [1].")).toEqual(["Revenue rose 12%."]);
    expect(texts("Yes [1].")).toEqual(["Yes."]);
  });

  test("sentences in other scripts are claims, cited or not", () => {
    expect(texts("Выручка выросла на 12 процентов [1].")).toEqual([
      "Выручка выросла на 12 процентов.",
    ]);
    expect(extractClaims("売上は12%増加した[1]。")[0]?.markers).toEqual(["1"]);
    expect(texts("Возврат возможен в течение двух недель.")).toHaveLength(1);
    // No spaces between words: each letter counts toward the bar.
    expect(texts("これは重要な情報です。")).toHaveLength(1);
    expect(texts("はい。")).toEqual([]);
  });

  test("for ASCII text the word count is the graders' contentTokens", () => {
    // "the", "and", "not" are grader stopwords; "it", "is", "of" are under three letters.
    expect(texts("It is not the end of it.")).toEqual([]);
    expect(texts("Payments settle overnight.")).toEqual(["Payments settle overnight."]);
  });
});

describe("extractClaims — what is never a claim", () => {
  test("fenced code: inside a block, and a block cut out of the sentence it falls in", () => {
    const text = [
      "Here is the config:",
      "```yaml",
      "retries: 3",
      "timeout: 30 seconds per request",
      "```",
      "The service restarts nightly [1].",
      "",
      "[1]: ./ops.md",
    ].join("\n");
    const claims = extractClaims(text);
    expect(claims.map((c) => c.text)).toEqual(["The service restarts nightly."]);
    expect(claims[0]?.line).toBe(6);
  });

  test("a marker inside code is not a marker", () => {
    const [claim] = extractClaims("Run `grep [1] notes.md` to list every cited line here.");
    expect(claim?.markers).toEqual([]);
    // plainClaim takes every bracketed id out of the words, code or not, as
    // it does for citedClaims; what matters is that [1] is not a marker.
    expect(claim?.text).toBe("Run grep notes.md to list every cited line here.");
  });

  test("headings are titles, not claims, ATX or setext", () => {
    expect(
      texts(
        "# Quarterly revenue for the 12 regions\n\nQuarterly revenue summary for leadership\n=======\n\nRevenue grew in every region [1].",
      ),
    ).toEqual(["Revenue grew in every region."]);
    expect(texts("## Results [1]\nRevenue grew in every region [1].")).toEqual([
      "Revenue grew in every region.",
    ]);
  });

  test("definition lines are not claims, with or without a blank line before them", () => {
    expect(
      texts(
        [
          "Revenue rose 12% [1]",
          "[1]: https://acme.example/reports/2024/quarterly-revenue",
          "[A1]: assume: the fiscal year starts in April each year",
          "[2]:",
          "  ./docs/a/very/long/path/to/the/source/document.md",
        ].join("\n"),
      ),
    ).toEqual(["Revenue rose 12%"]);
  });

  test("a list item that is only a definition is not a claim", () => {
    expect(
      texts(
        "Revenue rose 12% [1].\n\n- [1]: https://acme.example/reports/2024/quarterly\n- Costs fell three percent overall [2].",
      ),
    ).toEqual(["Revenue rose 12%.", "Costs fell three percent overall."]);
    // Every evidence kind is a reference, whatever the bullet.
    expect(
      texts(
        "- [2]: tool:toolu_01\n1. [3]: ./docs/q3.md#revenue\n* [A1]: assume: the fiscal year starts in April 2024\n+ [4]: doi:10.1000/xyz123",
      ),
    ).toEqual([]);
  });

  test("a bullet that only looks like a definition, with prose behind it, is a claim", () => {
    // citationDefinitions never reads a bulleted definition, so nothing else
    // would account for these sentences: dropping them was a vacuous pass.
    const doc =
      "Here is what I found.\n\n- [1]: The refund window is 30 days for every order.\n- [2]: Refunds are paid back within 5 business days.";
    expect(extractClaims(doc).map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "The refund window is 30 days for every order.", markers: [] },
      { text: "Refunds are paid back within 5 business days.", markers: [] },
    ]);
    expect(citationDefinitions(doc).size).toBe(0);
  });

  test("a definition line the grammar does not keep, showing text past what it names, is read as prose", () => {
    // A bullet holds no definition for citationDefinitions, and a second
    // `[1]:` line is not the one it keeps: nothing else would read the
    // sentence a reader sees on either.
    for (const line of [
      "- [2]: https://acme.example/x Payments clear within 5 days.",
      "* [2]: https://acme.example/x Payments clear within 5 days.",
      "1. [2]: https://acme.example/x Payments clear within 5 days.",
      "[1]: https://acme.example/x Payments clear within 5 days.",
    ]) {
      const doc = `Revenue rose 12% [1].\n\n[1]: https://acme.example/r\n${line}`;
      expect([line, texts(doc)]).toEqual([
        line,
        ["Revenue rose 12%.", "https://acme.example/x Payments clear within 5 days."],
      ]);
      expect(extractClaims(doc)[1]?.markers).toEqual([]);
    }
    // One that shows nothing past what it names renders as nothing.
    for (const line of [
      "- [2]: https://acme.example/x",
      "[1]: https://acme.example/x",
      '[1]: https://acme.example/x "Acme refund policy"',
      "* [A2]: assume: costs are stable for the whole year",
      "[A1]: assume: costs are stable for the whole year",
    ]) {
      const doc = `Revenue rose 12% [1].\n\n[1]: https://acme.example/r\n[A1]: assume: the year starts in April\n${line}`;
      expect([line, texts(doc)]).toEqual([line, ["Revenue rose 12%."]]);
    }
  });

  test("the definition citationDefinitions keeps is left out whatever it shows; the gate reads it", () => {
    const doc =
      "Revenue rose 12% [1].\n\n[1]: https://acme.example/r Payments clear within 5 days.";
    expect(texts(doc)).toEqual(["Revenue rose 12%."]);
    expect(citationDefinitions(doc).get("1")).toBe(
      "https://acme.example/r Payments clear within 5 days.",
    );
  });

  test("bibliographic: a free-text duplicate is a reference, not prose", () => {
    const doc =
      "Revenue rose 12% [1].\n\n[1]: Smith, J. (2024). Annual report.\n[1]: Jones, K. (2023). Interim report.";
    expect(texts(doc)).toEqual(["Revenue rose 12%.", "Jones, K. (2023)."]);
    expect(extractClaims(doc, { bibliographic: true }).map((c) => c.text)).toEqual([
      "Revenue rose 12%.",
    ]);
  });

  test("a definition-shaped bullet in the middle of a line is text", () => {
    expect(
      texts("Done. - [1]: https://acme.example/policy says refunds take 30 days."),
    ).toHaveLength(1);
    expect(texts("Done. - [1]: Refunds are accepted within 30 days of purchase.")).toEqual([
      "Refunds are accepted within 30 days of purchase.",
    ]);
  });

  test("a definition is never a claim, cited or not; the gate reads the uncited ones from the lint", () => {
    const doc =
      "[9]:\nRefunds are accepted within 30 days of delivery.\n\n[8]: https://acme.example/policy Payments are processed within 5 days.";
    expect(extractClaims(doc)).toEqual([]);
    expect(lintCitations(doc).uncited).toEqual(["8", "9"]);
  });

  test("a line holding nothing but inline code is a literal, not a claim", () => {
    expect(extractClaims("`bun test packages/claim-ledger/src`")).toEqual([]);
    expect(extractClaims("Run this:\n\n`bun install --frozen-lockfile`")).toEqual([]);
    // Code inside a sentence is part of what it asserts.
    expect(texts("`packages/gate` holds the verifier for 4 rungs.")).toEqual([
      "packages/gate holds the verifier for 4 rungs.",
    ]);
  });

  test("…unless it cites something or states a figure, which make any sentence a claim", () => {
    // citedClaims reports the cited one, so dropping it was a vacuous pass.
    const doc = "The default is set as follows.\n\n`max_retries = 30` [1].\n\n[1]: ./config.md";
    expect(extractClaims(doc).map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "The default is set as follows.", markers: [] },
      { text: "maxretries = 30.", markers: ["1"] },
    ]);
    expect(citedClaims(doc).map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "maxretries = 30.", markers: ["1"] },
    ]);
    expect(extractClaims("- `retries: 3` [1]").map((c) => c.markers)).toEqual([["1"]]);
    expect(texts("`retries: 3`")).toEqual(["retries: 3"]);
    expect(extractClaims("`git log` [2]").map((c) => c.markers)).toEqual([["2"]]);
  });
});

describe("extractClaims — numbered lists", () => {
  test("an ordered list's markers are bullets, not claims", () => {
    const doc =
      "Here is what changed:\n\n1. Revenue rose 12% [1].\n2. Costs fell 3% [2].\n\n[1]: ./a.md\n[2]: ./b.md";
    const claims = extractClaims(doc);
    expect(claims.map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Revenue rose 12%.", markers: ["1"] },
      { text: "Costs fell 3%.", markers: ["2"] },
    ]);
    expect(claims.map((c) => c.raw)).toEqual(["1. Revenue rose 12% [1].", "2. Costs fell 3% [2]."]);
    expect(claims.map((c) => c.line)).toEqual([3, 4]);
    // The same text citedClaims gives FactCrossCheck.
    expect(citedClaims(doc).map((c) => c.text)).toEqual(claims.map((c) => c.text));
  });

  test("a numbered list with no markers yields no stray numbers", () => {
    expect(texts("Steps:\n1. Install the package\n2. Run the tests\n10. Ship it")).toEqual([]);
    expect(texts("Steps:\n1. Install the package and verify every checksum\n2.\n")).toEqual([
      "Install the package and verify every checksum",
    ]);
  });

  test("an empty item cannot interrupt a paragraph: a bare 1. under a line is its figure", () => {
    expect(texts("Approval for refunds usually takes\n1.\n\nThat is the policy.")).toEqual([
      "Approval for refunds usually takes 1.",
    ]);
    // With content it may (CommonMark), and is a list item.
    expect(texts("Approval takes several days:\n1. Review the refund request [1].")).toEqual([
      "Approval takes several days:",
      "Review the refund request.",
    ]);
  });

  test("parenthesis markers and nested items", () => {
    expect(texts("1) Revenue rose 12% [1].\n2) Costs fell 3% [2].")).toEqual([
      "Revenue rose 12%.",
      "Costs fell 3%.",
    ]);
    const nested = extractClaims("- Setup steps:\n    1. Install the package [1]\n\n[1]: ./a.md");
    expect(nested.map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Install the package", markers: ["1"] },
    ]);
  });

  test("a number under a paragraph line is the paragraph going on, and is still read", () => {
    // CommonMark: only "1." may interrupt a paragraph, so this renders as
    // "The total count was 12. Then it rose." — the 12 belongs to the line above.
    expect(texts("The total count was\n12. Then it rose.")).toEqual(["The total count was 12."]);
    // Under a list item it continues the list.
    expect(texts("1. Revenue rose sharply [1].\n   Costs fell too.\n2. Margins held [2].")).toEqual(
      ["Revenue rose sharply.", "Margins held."],
    );
  });

  test("inside a list item the same rule holds: an indented 1. or 14. is the item's text", () => {
    // Indented to the item's content, the line reaches the item's paragraph,
    // and an empty item or one not numbered 1 cannot interrupt it — what a
    // renderer shows is "…takes 1." and "…cut to 14. Customers…".
    expect(texts("- Approval for refunds usually takes\n  1.\n\nThat is the policy.")).toEqual([
      "Approval for refunds usually takes 1.",
    ]);
    expect(texts("1. The refund window was cut to\n   14. Customers were told by email.")).toEqual([
      "The refund window was cut to 14.",
      "Customers were told by email.",
    ]);
    const cited = extractClaims(
      "- Refunds are processed within\n  5. Source: the policy page [1].\n\n[1]: https://acme.example/one",
    );
    expect(cited.map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Refunds are processed within 5.", markers: [] },
      { text: "Source: the policy page.", markers: ["1"] },
    ]);
    // Read as a new empty item, "14." put the lazy line under it at the top
    // level, and the fence after that at column 0, where nothing closed it:
    // both items after it were hidden as code.
    const fenced = extractClaims(
      "- Refunds over 500 dollars need a manager.\n   14.\nMost are approved the same day.\n  ```\n- Refunds take 30 days to clear.\n- Chargebacks cost 15 dollars each [1].\n\n[1]: https://acme.example/fees",
    );
    expect(fenced.map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Refunds over 500 dollars need a manager. 14.", markers: [] },
      { text: "Most are approved the same day.", markers: [] },
      { text: "Refunds take 30 days to clear.", markers: [] },
      { text: "Chargebacks cost 15 dollars each.", markers: ["1"] },
    ]);
  });

  test("a marker indented less than the item's content leaves the item, whatever its number", () => {
    // It starts a sibling or an outer item, which any marker may (CommonMark).
    expect(
      texts("- Setup steps for the service:\n  - Install the package [1]\n2. Run the tests [2]"),
    ).toEqual(["Setup steps for the service:", "Install the package", "Run the tests"]);
    expect(texts("1. Refunds take 30 days [1].\n   - Approval is manual [2].\n2.\n")).toEqual([
      "Refunds take 30 days.",
      "Approval is manual.",
    ]);
  });
});

describe("extractClaims — headings are lines", () => {
  test("a # in the middle of a line is text, and the claim after it is read", () => {
    const doc =
      "Revenue was flat this quarter. # of refunds rose to 30 [1] within the window.\n\n[1]: https://acme.example/policy";
    expect(extractClaims(doc).map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Revenue was flat this quarter.", markers: [] },
      { text: "of refunds rose to 30 within the window.", markers: ["1"] },
    ]);
    expect(
      texts(
        "Ok. # Refunds are accepted within 30 days. # Payment is processed in 5 business days.",
      ),
    ).toEqual(["Refunds are accepted within 30 days.", "Payment is processed in 5 business days."]);
  });

  test("a heading line is a heading after a full stop inside it too", () => {
    expect(texts("# Results. Revenue for the 12 regions\nCosts fell in every region [1].")).toEqual(
      ["Costs fell in every region."],
    );
    // A sentence stating a figure there is the heading's claim, read as one.
    expect(
      extractClaims(
        "# Results. Revenue grew 12 percent everywhere\nCosts fell in every region [1].",
      ).map(({ text, markers, line }) => [text, markers, line]),
    ).toEqual([
      ["Revenue grew 12 percent everywhere", [], 1],
      ["Costs fell in every region.", ["1"], 2],
    ]);
  });

  test("under a list item or a quote, --- is a thematic break and the line above a claim", () => {
    for (const doc of [
      "- Refunds are accepted within 30 days [1]\n---\n\n[1]: https://acme.example/policy",
      "> Refunds are accepted within 30 days [1]\n---\n\n[1]: https://acme.example/policy",
      "- Every refund is reviewed.\nRefunds are accepted within 30 days [1]\n---\n\n[1]: https://acme.example/policy",
    ]) {
      const claims = extractClaims(doc).filter((c) => c.markers.length > 0);
      expect(claims.map(({ text, markers }) => ({ text, markers }))).toEqual([
        { text: "Refunds are accepted within 30 days", markers: ["1"] },
      ]);
    }
  });

  test("an indented heading, or one inside a list item, ends at its own line", () => {
    // CommonMark allows three spaces before `#`; the splitter breaks only at
    // column 0, so the heading ran into the claim under it and both went.
    const indented =
      "  # Summary\nThe refund window is 30 days [1].\n\n[1]: https://acme.example/policy";
    expect(
      extractClaims(indented).map(({ text, markers, line }) => ({ text, markers, line })),
    ).toEqual([{ text: "The refund window is 30 days.", markers: ["1"], line: 2 }]);
    // citedClaims, whose output is pinned, keeps the heading in the claim.
    expect(citedClaims(indented)[0]?.text).toBe("Summary The refund window is 30 days.");
    const inItem =
      "- Item one is here and it says something.\n\n  ## Details\n  Refunds are accepted within 30 days [1].";
    expect(extractClaims(inItem).map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Item one is here and it says something.", markers: [] },
      { text: "Refunds are accepted within 30 days.", markers: ["1"] },
    ]);
    // Four spaces in, under "10. ", is a heading inside the item, not code.
    expect(
      texts(
        "10. Item one is here and it says something.\n\n    ## Details\n    Refunds are accepted within 30 days [1].",
      ),
    ).toEqual(["Item one is here and it says something.", "Refunds are accepted within 30 days."]);
    // A heading under a paragraph line interrupts it: neither side is joined.
    expect(texts("Revenue rose 12% this year\n   ## Costs\nCosts fell 3% [2].")).toEqual([
      "Revenue rose 12% this year",
      "Costs fell 3%.",
    ]);
  });

  test("a list item's paragraph after a blank line is in the item: --- under it is a break", () => {
    const doc =
      "- Item one is here and it says something.\n\n  Refunds are accepted within 30 days [1]\n---\n\n[1]: https://acme.example/policy";
    expect(extractClaims(doc).map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Item one is here and it says something.", markers: [] },
      { text: "Refunds are accepted within 30 days", markers: ["1"] },
    ]);
    // Not indented into the item, the paragraph is the document's: a heading.
    expect(
      texts(
        "- Item one is here and it says something.\n\nRefunds are accepted for unused items\n---\n\nShipping is free within the EU.",
      ),
    ).toEqual(["Item one is here and it says something.", "Shipping is free within the EU."]);
  });

  test("a setext heading ends at its underline; the paragraph under it is a claim", () => {
    expect(texts("Quarterly revenue summary for leadership\n---\nRevenue rose 12%.")).toEqual([
      "Revenue rose 12%.",
    ]);
  });

  test("U+2028 is not a line break: a # after it is text", () => {
    expect(
      extractClaims("Hello there friend. # Refunds are accepted within 30 days [1].").map(
        (c) => c.markers,
      ),
    ).toEqual([["1"]]);
  });
});

describe("extractClaims — code is what a renderer calls code", () => {
  test("an indented closing fence closes the block", () => {
    expect(texts("```\ncode\n  ```\nRefunds are accepted within 30 days.\n")).toEqual([
      "Refunds are accepted within 30 days.",
    ]);
  });

  test("a backtick fence with a backtick in its info string is not a fence", () => {
    expect(
      texts("Intro sentence here.\n```x`\nRefunds are accepted within 30 days.\n```\n"),
    ).toHaveLength(1);
  });

  test("a fence after U+2028 is not a fence", () => {
    const claims = extractClaims(
      "Hello there friend. ```\nRefunds are accepted within 30 days [1].\n\n[1]: https://acme.example/policy",
    );
    expect(claims.map((c) => c.markers)).toEqual([["1"]]);
  });

  test("a fence closes only on its own character, at least as long", () => {
    const doc = "````md\n```\nnot closed yet\n~~~~\n````\nRefunds are accepted within 30 days.";
    expect(texts(doc)).toEqual(["Refunds are accepted within 30 days."]);
  });

  test("a fence on a list item's marker line is code, and so is nothing after its closer", () => {
    // The bullet hid the opener and the indented closer opened a fence that
    // ran to the end: every claim after it vanished, and the gate passed the
    // answer unread while the lint saw its markers.
    const ordered =
      "1. ```bash\n   ls\n   ```\n\nThe refund window is 30 days [1].\nRevenue rose 12% last year.\n\n[1]: https://acme.example/policy";
    expect(
      extractClaims(ordered).map(({ text, markers, line }) => ({ text, markers, line })),
    ).toEqual([
      { text: "The refund window is 30 days.", markers: ["1"], line: 5 },
      { text: "Revenue rose 12% last year.", markers: [], line: 6 },
    ]);
    expect(
      extractClaims(
        "- ```js\n  const x = 1;\n  ```\n\nRefunds are accepted within 30 days [1].",
      ).map(({ text, markers }) => ({ text, markers })),
    ).toEqual([{ text: "Refunds are accepted within 30 days.", markers: ["1"] }]);
  });

  test("a fence left open in a list item ends with the item", () => {
    const doc =
      "- Item one is here and it says something.\n\n  ```\n  code here\n\nRefunds are accepted within 30 days [1].";
    expect(extractClaims(doc).map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Item one is here and it says something.", markers: [] },
      { text: "Refunds are accepted within 30 days.", markers: ["1"] },
    ]);
  });
});

describe("extractClaims — markers and lines", () => {
  test("a marker after the full stop belongs to the sentence before it", () => {
    const claims = extractClaims("Revenue rose 12%. [1] Costs fell 3% [2].\nMargins held. [3]");
    expect(claims.map(({ text, raw, markers }) => ({ text, raw, markers }))).toEqual([
      { text: "Revenue rose 12%.", raw: "Revenue rose 12%. [1]", markers: ["1"] },
      { text: "Costs fell 3%.", raw: "Costs fell 3% [2].", markers: ["2"] },
      { text: "Margins held.", raw: "Margins held. [3]", markers: ["3"] },
    ]);
  });

  test("a marker after a paragraph break does not reach back", () => {
    const claims = extractClaims(
      "Revenue rose sharply this quarter.\n\n[1] Costs fell everywhere.",
    );
    expect(claims.map((c) => c.markers)).toEqual([[], ["1"]]);
  });

  test("a marker on the next line, alone, still belongs to the sentence above", () => {
    expect(extractClaims("Revenue rose sharply this quarter.\n[1]")[0]?.markers).toEqual(["1"]);
  });

  test("a question run into a claim drops only the question (design §0, tests A and B)", () => {
    const read = (doc: string) =>
      extractClaims(doc).map(({ text, markers, line }) => ({ text, markers, line }));
    // A: a cited figure with no full stop, then a question on the next line.
    expect(
      read(
        "The refund window is 30 days [1]\nAnything else I can help with?\n\n[1]: https://acme.example/p",
      ),
    ).toEqual([{ text: "The refund window is 30 days", markers: ["1"], line: 1 }]);
    // B: an uncited total, then a question — lowercase too, and over CRLF.
    expect(read("The invoice total is 1,284.50\nShall I email it to the customer?")).toEqual([
      { text: "The invoice total is 1,284.50", markers: [], line: 1 },
    ]);
    expect(read("The invoice total is 1,284.50\nwant me to email it?")).toHaveLength(1);
    expect(read("The refund window is 30 days [1]\r\nAnything else?")).toEqual([
      { text: "The refund window is 30 days", markers: ["1"], line: 1 },
    ]);
    expect(read("**Total:** $1,284.50\nWould you like a PDF copy?")).toEqual([
      { text: "Total: $1,284.50", markers: [], line: 1 },
    ]);
    // An uncited sentence of words is a claim the cited floor refuses, as it
    // would be with a blank line before the question.
    expect(read("Our team reviewed the refund policy\nAnything else?")).toHaveLength(1);
  });

  test("a terminator glued to a capital ends the sentence before a question", () => {
    expect(texts("The refund window is 30 days.Anything else?")).toEqual([
      "The refund window is 30 days.",
    ]);
    // The marker stays bound to the claim it follows.
    expect(
      extractClaims("Paris is the capital of France [1].Right?").map((c) => [c.text, c.markers]),
    ).toEqual([["Paris is the capital of France.", ["1"]]]);
    // Each question is left out; the claim before them is read.
    expect(texts("The total is 1,284.50.Is it right?Anything else?")).toEqual([
      "The total is 1,284.50.",
    ]);
    // No capital, an abbreviation or an initialism: no sentence ends.
    expect(texts("Is acme.example up, and is Node.js 1.2 out?")).toEqual([]);
    expect(texts("Did the U.S.Army or Acme Inc.Labs publish 3 reports?")).toEqual([]);
    // A dotted name or a URL path ends no sentence at a capital inside it: a
    // clarifying question has nothing to prove (design §2).
    expect(texts("Do you want me to migrate the serializer to System.Text.Json instead?")).toEqual(
      [],
    );
    expect(
      texts("Should I replace the loop with a call to Console.WriteLine in the handler?"),
    ).toEqual([]);
    expect(
      texts("Did you already read https://acme.example/Docs/Guide.Html about refunds?"),
    ).toEqual([]);
    // A sentence still ends after a figure, a marker or a year.
    expect(texts("It was 2024.Right?")).toEqual(["It was 2024."]);
    expect(texts("The total came to $1.5M.Anything else?")).toEqual(["The total came to $1.5M."]);
  });

  test("a long token of glued capitals is read in linear time", () => {
    // Each full stop asks whether the token before it is a dotted name: read
    // again from the token's start, that is quadratic in the token.
    expect(readsLinearly((n) => `Is ${".Ab".repeat(n)} fine?`, 400)).toBe("linear");
    expect(readsLinearly((n) => `Is x/${"y.Ab".repeat(n)} fine?`, 400)).toBe("linear");
  }, 60_000);

  test("a table or a list before a question stays what it is without the question", () => {
    const table =
      "| Plan | Price |\n|---|---|\n| Pro | $10 [1] |\n| Team | $25 |\nWant the annual prices too?";
    const alone = extractClaims(table.slice(0, table.lastIndexOf("\n")));
    expect(extractClaims(table)).toEqual(alone);
    expect(alone.map((c) => c.markers)).toEqual([["1"]]);
    // The last item's lazy line is the question; every item is still a claim.
    expect(
      extractClaims("- Subtotal: 1,000 [1]\n- Total: 1,284.50 [2]\nWant me to send it?").map(
        (c) => [c.text, c.markers],
      ),
    ).toEqual([
      ["Subtotal: 1,000", ["1"]],
      ["Total: 1,284.50", ["2"]],
    ]);
  });

  test("a question wrapped over lines is still one question", () => {
    // The line after the break opens lowercase and the line before states
    // nothing a claim needs: one sentence, hard-wrapped.
    expect(
      texts("Should I send the corrected invoice to the billing contact\nbefore Friday?"),
    ).toEqual([]);
    expect(texts("Is the refund window 14 days [1]?")).toEqual([]);
  });

  test("a marker after a question stays with the question, which is not a claim", () => {
    // Without the reattachment [1] would open the next sentence and be its marker.
    const claims = extractClaims(
      "Did revenue rise this quarter? [1] Costs fell sharply everywhere.",
    );
    expect(claims.map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Costs fell sharply everywhere.", markers: [] },
    ]);
  });

  test("markers glued to the full stop end the sentence and belong to it", () => {
    const doc =
      "Revenue rose 12% in 2024.[1] Costs fell 3% in every region.[2]\n\n[1]: ./a.md\n[2]: ./b.md";
    expect(extractClaims(doc).map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Revenue rose 12% in 2024.", markers: ["1"] },
      { text: "Costs fell 3% in every region.", markers: ["2"] },
    ]);
    // citedClaims keeps the splitter's one sentence (FactCrossCheck's output is pinned).
    expect(citedClaims(doc).map((c) => c.markers)).toEqual([["1", "2"]]);
    // A closing quote between, a line break after, a spaced marker after
    // that: all the same rule. ("[1][^a]" would be a reference link, so the
    // grammar reads only [^a] there — not a run of two.)
    expect(
      extractClaims('He said "refunds are fine."[1] [^a]\nThen he left the building quickly.').map(
        ({ text, markers }) => ({ text, markers }),
      ),
    ).toEqual([
      { text: 'He said "refunds are fine."', markers: ["1", "a"] },
      { text: "Then he left the building quickly.", markers: [] },
    ]);
  });

  test("a run [1][2] after the full stop ends the sentence there; the grammar's marker is [2]", () => {
    // `[1][2]` is a reference link to [2] (CommonMark), the one marker every
    // reader sees; [1] is reported uncited by the lint, as by the gate.
    const defs = "\n\n[1]: ./a.md\n[2]: ./b.md\n[3]: ./c.md";
    const glued = `Revenue rose 12% in 2024.[1][2] Costs fell 3% in every region.[3]${defs}`;
    expect(extractClaims(glued).map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Revenue rose 12% in 2024.", markers: ["2"] },
      { text: "Costs fell 3% in every region.", markers: ["3"] },
    ]);
    expect(lintCitations(glued).uncited).toEqual(["1"]);
    expect(
      extractClaims("Revenue rose 12% in 2024.[^1][^2] Costs fell 3% in every region.[^3]").map(
        (c) => c.markers,
      ),
    ).toEqual([["2"], ["3"]]);
    // Spaced, the run still belongs to the sentence before it.
    const spaced = extractClaims("Revenue rose 12% in 2024. [1][2] Costs fell 3% in every region.");
    expect(spaced.map(({ text, raw, markers }) => ({ text, raw, markers }))).toEqual([
      {
        text: "Revenue rose 12% in 2024.",
        raw: "Revenue rose 12% in 2024. [1][2]",
        markers: ["2"],
      },
      {
        text: "Costs fell 3% in every region.",
        raw: "Costs fell 3% in every region.",
        markers: [],
      },
    ]);
    // After an abbreviation the run ends nothing, as a single marker does not.
    expect(texts("Smith et al.[1][2] found that refunds take 14 days.")).toHaveLength(1);
  });

  test("only citation ids make a run: a one-word link opening a sentence keeps its marker", () => {
    // `[Stripe][2]` is a link whose text is the sentence's subject. Read as
    // a run like [1][2], its [2] moved onto the uncited sentence before it,
    // and the sentence that cites [2] was flagged uncited.
    const defs = "\n\n[1]: https://acme.example/one\n[2]: https://acme.example/two";
    for (const join of [" ", "\n"]) {
      const text = `Revenue rose last year in every region we track.${join}[Stripe][2] charges 2.9% per card transaction.${defs}`;
      const claims = extractClaims(text).map(({ text: t, markers }) => ({ text: t, markers }));
      expect(claims).toEqual([
        { text: "Revenue rose last year in every region we track.", markers: [] },
        { text: "charges 2.9% per card transaction.", markers: ["2"] },
      ]);
      // The same sentence and marker citedClaims gives FactCrossCheck.
      expect(claims.filter((c) => c.markers.length > 0)).toEqual(
        citedClaims(text).map(({ text: t, markers }) => ({ text: t, markers })),
      );
    }
    // Glued to the full stop, no full stop sits before the run, so nothing
    // ends there: one sentence citing [2], as citedClaims reads it.
    const glued = `Revenue rose last year in every region we track.[Stripe][2] charges 2.9% per card transaction.${defs}`;
    expect(extractClaims(glued).map(({ text, markers }) => ({ text, markers }))).toEqual(
      citedClaims(glued).map(({ text, markers }) => ({ text, markers })),
    );
    expect(extractClaims(glued)).toHaveLength(1);
    // An id the document defines, an assumption and a footnote still make a run.
    for (const label of ["smith2020", "A1", "^a"]) {
      const text = `Revenue rose 12% in 2024. [${label}][2] Costs fell 3% in every region.\n\n[smith2020]: ./smith.md\n[2]: ./b.md`;
      expect(extractClaims(text).map((c) => c.markers)).toEqual([["2"], []]);
    }
  });

  test("a piece that is nothing but brackets cites the sentence before it, whatever the labels", () => {
    // Left as a piece of its own it has no words, and its marker would
    // belong to no claim at all.
    const claims = extractClaims("Revenue rose in every region we track. [x][A5]");
    expect(claims.map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Revenue rose in every region we track.", markers: ["A5"] },
    ]);
    expect(
      extractClaims("Revenue rose in every region we track. [Stripe][2]\n- Costs fell 3%.").map(
        (c) => c.markers,
      ),
    ).toEqual([["2"], []]);
  });

  test("a block quote under a paragraph line is a block of its own", () => {
    // CommonMark lets `>` interrupt a paragraph; the splitter does not break
    // there, so the two ran into one claim citing both.
    const claims = extractClaims(
      "Revenue rose in every region we track [2]\n> Costs fell 3% in every region [1].",
    );
    expect(claims.map(({ text, markers }) => ({ text, markers }))).toEqual([
      { text: "Revenue rose in every region we track", markers: ["2"] },
      { text: "Costs fell 3% in every region.", markers: ["1"] },
    ]);
    // `---` under the quote is a thematic break, not a setext underline for
    // the paragraph the piece began in: both claims were excluded as a heading.
    expect(
      extractClaims(
        "Revenue rose in every region we track\n> costs fell 3% in every region [1]\n---\n",
      ).map(({ text, markers }) => ({ text, markers })),
    ).toEqual([
      { text: "Revenue rose in every region we track", markers: [] },
      { text: "costs fell 3% in every region", markers: ["1"] },
    ]);
    // A lazy line after the quote is still the quote's paragraph.
    expect(
      texts("> Revenue rose in every region we track\nand costs fell 3% in every region [1]."),
    ).toEqual(["Revenue rose in every region we track and costs fell 3% in every region."]);
  });

  test("a glued marker after an abbreviation or an initial ends nothing", () => {
    expect(texts("Smith et al.[1] found that refunds take 14 days.")).toEqual([
      "Smith et al. found that refunds take 14 days.",
    ]);
    expect(texts("As J.[2] Smith wrote, refunds take 14 days.")).toHaveLength(1);
    // Followed by a word, not space: not a sentence end either.
    expect(extractClaims("Revenue rose.[1]x and costs fell sharply.")).toHaveLength(1);
  });

  test("CRLF and CR line breaks split sentences and paragraphs as LF does", () => {
    const lf =
      "Revenue rose 12% in the quarter.\nCosts fell in every region [1].\n\nMargins held steady all year.";
    for (const text of [lf, lf.replace(/\n/g, "\r\n"), lf.replace(/\n/g, "\r")]) {
      expect(
        extractClaims(text).map(({ text: t, markers, line }) => ({ t, markers, line })),
      ).toEqual([
        { t: "Revenue rose 12% in the quarter.", markers: [], line: 1 },
        { t: "Costs fell in every region.", markers: ["1"], line: text.includes("\n") ? 2 : 1 },
        { t: "Margins held steady all year.", markers: [], line: text.includes("\n") ? 4 : 1 },
      ]);
    }
  });

  test("line is the line of the claim's first character", () => {
    const claims = extractClaims(
      "Intro sentence with enough words.\nSecond sentence cites a source [1].\n\n\nFourth para has words too.",
    );
    expect(claims.map((c) => c.line)).toEqual([1, 2, 5]);
  });
});

describe("extractClaims — a claim joined to a question is read (design §0, §2)", () => {
  // Spelled by code point, so what the test means is visible.
  const NBSP = String.fromCharCode(0xa0);
  const NARROW = String.fromCharCode(0x202f);
  const IDEOGRAPHIC = String.fromCharCode(0x3000);
  const LINE_SEPARATOR = String.fromCharCode(0x2028);
  const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
  const NEL = String.fromCharCode(0x85);
  const ZWSP = String.fromCharCode(0x200b);
  const read = (doc: string) => extractClaims(doc).map(({ text, markers }) => [text, markers]);
  const A = "The refund window is 30 days [1]";

  test("every place a reader sees a sentence end, the splitter does not, ends one", () => {
    // The review's I1: each of these was one piece ending in "?", dropped
    // whole, and the gate passed the cited figure as "no claims to prove".
    for (const doc of [
      `${A}.anything else?`,
      `${A}.${NBSP}Anything else?`,
      `${A}.${NARROW}Anything else?`,
      `${A}.${IDEOGRAPHIC}Anything else?`,
      `${A}.\fAnything else?`,
      `${A}.${LINE_SEPARATOR}Anything else?`,
      `${A}${LINE_SEPARATOR}Anything else?`,
      `${A}${PARAGRAPH_SEPARATOR}Anything else?`,
      `${A}.${NEL}Anything else?`,
      `${A}.<br>Anything else?`,
      `${A}<br/>Anything else?`,
      `${A}.${ZWSP}Anything else?`,
      `${A}…Should I email it?`,
      `${A}… Should I email it?`,
      `${A}.” Anything else?`,
      `${A}.—anything else?`,
      `${A}.¿Algo más?`,
      `${A}.1) Anything else?`,
    ]) {
      // The claim, its closing punctuation aside, and its marker.
      const claims = extractClaims(doc).map(
        (c) => `${c.text.replace(/[\s.\u2026\u201d]+$/u, "")} [${c.markers.join(",")}]`,
      );
      expect(`${JSON.stringify(doc)} → ${claims.join(" | ")}`).toBe(
        `${JSON.stringify(doc)} → The refund window is 30 days [1]`,
      );
    }
    expect(read("The invoice total is 1,284.50.want me to email it?")).toEqual([
      ["The invoice total is 1,284.50.", []],
    ]);
  });

  test("a claim and a question in one sentence are cut apart at the clause", () => {
    for (const [doc, claim, markers] of [
      [`${A} — anything else I can help with?`, "The refund window is 30 days", ["1"]],
      [`${A}—anything else?`, "The refund window is 30 days", ["1"]],
      [`${A} - anything else?`, "The refund window is 30 days", ["1"]],
      [`${A} – anything else?`, "The refund window is 30 days", ["1"]],
      [`${A}, right?`, "The refund window is 30 days", ["1"]],
      [`${A}, isn't it?`, "The refund window is 30 days", ["1"]],
      ["The refund window is 30 days: anything else?", "The refund window is 30 days", []],
      [
        "The invoice total is 1,284.60; want me to send the PDF?",
        "The invoice total is 1,284.60",
        [],
      ],
      ["| Refund window | 30 days | Any questions? |", "Refund window 30 days", []],
      ["Refund window: 30 days \u{1f44d} Anything else?", "Refund window: 30 days", []],
      ["Your total is $45, would you like a receipt?", "Your total is $45", []],
      ["You have 3 seats left [1], right?", "You have 3 seats left", ["1"]],
      [`${A} \u2014 do you want it, or the 14-day one?`, "The refund window is 30 days", ["1"]],
      ["In 2024, revenue rose 12% [1], right?", "In 2024, revenue rose 12%", ["1"]],
      [
        "Refunds take 30 days from purchase, and shipping is always free, does that help?",
        "Refunds take 30 days from purchase",
        [],
      ],
    ] as const) {
      expect(read(doc)).toEqual([[claim, [...markers]]]);
    }
    // Every clause holding a marker is read, the question after them is not.
    expect(read(`${A}, and the restocking fee is 15% [2] — anything else?`)).toEqual([
      ["The refund window is 30 days, and the restocking fee is 15%", ["1", "2"]],
    ]);
  });

  test("a claim whose last word is a dotted name or a path still ends before the question", () => {
    // `dottedBefore` kept these whole, and dropped them: a marker or a
    // figure before the full stop says a sentence ended there.
    for (const doc of [
      "Acme accepts refund requests within 30 days of purchase [1], see the policy.md.Anything else?",
      `${A} per acme.example/policy.Anything else?`,
      `${A} per status.acme.io.Is that ok?`,
      `${A} according to Node.js.Anything else?`,
    ]) {
      const claims = extractClaims(doc);
      expect(`${doc} → ${claims.length}`).toBe(`${doc} → 1`);
      expect(claims[0]?.markers).toEqual(["1"]);
    }
  });

  test("a full stop inside a domain or file name ends no sentence, marker or not", () => {
    // The cut was taken at the first `.` of the name: "…per acme." uncited
    // and "example/refunds" citing [1] failed an honest answer at `cited`.
    const D = "\n\n[1]: https://acme.example/refunds";
    for (const [doc, claim] of [
      [
        "The refund window is 30 days per acme.example/refunds [1] — anything else?",
        "The refund window is 30 days per acme.example/refunds",
      ],
      [
        "The refund window is 30 days (see acme.example/refunds [1]) — want the link?",
        "The refund window is 30 days (see acme.example/refunds )",
      ],
      [
        "The refund window is 30 days per acme.example/refunds [1]; want the full policy?",
        "The refund window is 30 days per acme.example/refunds",
      ],
      [
        "Node 20 is the current LTS per nodejs.org [1] — want upgrade steps?",
        "Node 20 is the current LTS per nodejs.org",
      ],
      [
        "The refund window is 30 days [1] per acme.example — anything else?",
        "The refund window is 30 days per acme.example",
      ],
      [
        "The fix ships in v2.json and docs/refunds.md [1] — want the diff?",
        "The fix ships in v2.json and docs/refunds.md",
      ],
    ] as const) {
      expect(read(`${doc}${D}`)).toEqual([[claim, ["1"]]]);
    }
    // A full stop glued to a follow-up or a question still ends the sentence.
    expect(read("The refund window is 30 days.anything else?")).toEqual([
      ["The refund window is 30 days.", []],
    ]);
    expect(read("The total is 1,284.60 USD.want me to email it?")).toEqual([
      ["The total is 1,284.60 USD.", []],
    ]);
  });

  test("a question with a figure before a capital-glued name is one question (I31)", () => {
    for (const doc of [
      "Should I set the timeout to 30 seconds in Startup.Configure for production?",
      "Should I raise MaxRetries to 5 in Polly.Retry for the payment client?",
      "Do you want me to cap the pool at 10 connections in Program.Main as well?",
      "Would you like me to bump the limit to 100 in Settings.Default before deploying?",
      "Should I use the 2024 rates with Array.Sort?",
    ]) {
      expect(`${doc} → ${JSON.stringify(read(doc))}`).toBe(`${doc} → []`);
    }
    // A sentence that does not open as a question still ends there.
    expect(read("It was 2024.Right?")).toEqual([["It was 2024.", []]]);
  });

  test("an acknowledgement or a set-up before a question says the request back (no claim)", () => {
    for (const doc of [
      "Got it — 2 seats, correct?",
      "Just to confirm: 2 adults and 1 child, departing June 3?",
      "Thanks for the 3 files, should I merge them?",
      "Okay, 12 months then, or did you want 24?",
      "Before I book: 2 rooms for 3 nights, is that right?",
      "Quick question about the 2024 report: should I include Q4?",
      "Two quick questions: do you want the PDF, and should I CC finance?",
      "Re: invoice #1042 — should I resend it?",
      "Sure — for the 3 invoices you mentioned, want me to combine them?",
      "Happy to help with the 5 tickets — which one first?",
      "Sounds good, 30 minutes it is — want a reminder?",
    ]) {
      expect(`${doc} → ${JSON.stringify(read(doc))}`).toBe(`${doc} → []`);
    }
    // A restatement is figures and the nouns they count, whatever the noun.
    for (const doc of [
      "Got it — 2 king-size beds, right?",
      "Just to confirm: 3 nights at the Grand Hotel, correct?",
      "Got it — June 3 for 2 people, right?",
      "Got it — the meeting at 3pm, right?",
      "Got it — 2 seats for you and 1 for Sam, right?",
      "Got it — 2 checked bags, right?",
      "Got it — one adult and two children, right?",
      "Thanks for the 3 files you sent, should I merge them?",
    ]) {
      expect(`${doc} → ${JSON.stringify(read(doc))}`).toBe(`${doc} → []`);
    }
    // What such a sentence asserts, and what it cites, is still a claim.
    expect(read("Got it — the invoice total is 1,284.60, right?")).toEqual([
      ["Got it — the invoice total is 1,284.60", []],
    ]);
    expect(read("Thanks — the refund window is 30 days [1], anything else?")).toEqual([
      ["Thanks — the refund window is 30 days", ["1"]],
    ]);
    // Scenario B's tag question is cut as before.
    expect(read("The invoice total is 1,284.60, right?")).toEqual([
      ["The invoice total is 1,284.60", []],
    ]);
  });

  test("an acknowledgement before an assertion hides no claim, whatever its verb (design §0)", () => {
    // Only a closed list of verbs made the clause after "Sure —" a claim, so
    // "Sure — refunds close after 30 days, anything else?" had none and
    // passed 0/0 at grounded, checked and proven.
    const asserted = [
      ["refunds close after 30 days", "anything else?"],
      ["your refund window ends after 30 days", "want the link?"],
      ["you'll get 30 days to return it", "anything else?"],
      ["the meeting moved to 3pm", "want me to update the invite?"],
      ["no two of the six meetings overlap", "want me to send the invites?"],
      ["your order ships in 3 days", "anything else?"],
      ["that'll be $45", "shall I proceed?"],
      ["you owe $45", "want the invoice?"],
      ["I found 3 matching orders", "which one?"],
      ["I've booked 2 seats for June 3", "anything else?"],
      ["all 12 tests pass", "want me to open the PR?"],
      ["you can return it within 30 days", "anything else?"],
      ["the API returns 404 for that endpoint", "want an example?"],
      ["the deploy finished in 4 minutes", "anything else?"],
      ["3 tests failed", "want the log?"],
      ["1 test fails", "want me to fix it?"],
      ["total $45", "want the invoice?"],
      // A demonstrative or a quantifier as the subject (HEAD read these
      // through the verbs a stated amount is given with; the restatement
      // test read "that" as an article and served them 0/0).
      ["that comes to $1,386.26", "want me to send the invoice?"],
      ["that totals $1,386.26", "shall I charge the card?"],
      ["that costs $45", "want me to order it?"],
      ["this takes about 3 days", "anything else?"],
      ["that came to $45.80", "want the receipt?"],
      ["each costs $12", "how many do you want?"],
      ["that equals 1,386.26", "want the PDF?"],
      ["that runs $49 a month", "want to upgrade?"],
      ["both ship in 2 days", "want tracking?"],
      ["all 6 fit in the week", "want the invites?"],
    ] as const;
    for (const opener of ["Sure — ", "Got it — ", "Thanks, ", "Okay, ", "Great — ", "Noted — "]) {
      for (const [claim, question] of asserted) {
        const doc = `${opener}${claim}, ${question}`;
        expect(`${doc} → ${JSON.stringify(read(doc))}`).toBe(
          `${doc} → ${JSON.stringify([[`${opener}${claim}`.replace(/,? $/, ""), []]])}`,
        );
      }
    }
  });

  test("a question the answer answers itself is a claim", () => {
    expect(read("Is the refund window 30 days? Yes.")).toEqual([
      ["Is the refund window 30 days? Yes.", []],
    ]);
    expect(read("Is the refund window 30 days [1]? No, it isn't.")).toEqual([
      ["Is the refund window 30 days? No, it isn't.", ["1"]],
    ]);
    // An answer that says more is a sentence of its own.
    expect(read("Want the PDF? Yes, I can send it today.")).toEqual([]);
  });

  test("a question stays a question: clarifying questions have nothing to prove", () => {
    for (const doc of [
      "Is it 30 days, or 14?",
      "Would you like a refund of $45, or store credit?",
      "Did you mean the 30-dollar order, or the 45-dollar one?",
      "If you want the 12-month plan, should I upgrade you?",
      "For the 2024 rates, should I use the new table?",
      "Want the 2024 report, or the 2023 one?",
      "Do you want the 12-month or 24-month plan?",
      "Thanks, should I send it now?",
      "Okay — should I use the 2024 rates?",
      "Got it; should I send the PDF now?",
      "Is the refund window 14 days [1]?",
      "Is the 30-day window listed at acme.example/policy?",
      "Is the 30-day window at Acme.Com?",
      // A clause that asks, or says back what the reader wants, is the question's.
      "Before I change anything \u2014 do you want me to update all 3 environments, or just staging?",
      "Just to confirm, you want the 12-month plan at $96, right?",
      "So, to recap: you want 2 seats, billed annually \u2014 correct?",
      "First, which device are you using \u2014 iOS or Android?",
      // A step's number is its place in a list, not a value.
      "**Step 6 \u2014 Shipping to a chat channel** (Slack, Discord, Telegram)?",
    ]) {
      expect(`${doc} → ${JSON.stringify(read(doc))}`).toBe(`${doc} → []`);
    }
  });

  test("a two-part dotted name in a clarifying question ends no sentence (the review's I31)", () => {
    for (const doc of [
      "Should I replace the manual loop with a call to Array.Sort?",
      "Should I register the client with Microsoft.Extensions?",
      "Should I wrap the call in a Polly.Retry policy before shipping?",
      "Should I log every failure with Logger.Error in the handler?",
      "Should I read the value from Settings.Default in the service?",
      "Should I move the layout into Home.Razor for the dashboard?",
      "Should I put the connection string into appsettings.Production?",
      "Maybe switch the client over to Microsoft.Extensions?",
    ]) {
      expect(`${doc} → ${JSON.stringify(read(doc))}`).toBe(`${doc} → []`);
    }
    // The claim before such a question is read, the question after it is not.
    expect(read("Revenue rose 12% [1].Should I switch to Microsoft.Extensions?")).toEqual([
      ["Revenue rose 12%.", ["1"]],
    ]);
  });

  test("a heading that cites a figure, or states a value, is a claim (design §0: A, B)", () => {
    expect(read(`## ${A}\n\n[1]: https://acme.example/policy`)).toEqual([
      ["The refund window is 30 days", ["1"]],
    ]);
    expect(read(`${A}\n---\n\n[1]: https://acme.example/policy`)).toEqual([
      ["The refund window is 30 days", ["1"]],
    ]);
    expect(read("## Invoice total: 1,284.50\n\nThe subtotal is 1,000 [1].")).toEqual([
      ["Invoice total: 1,284.50", []],
      ["The subtotal is 1,000.", ["1"]],
    ]);
    // Titles stay titles beside the answer's claims.
    expect(
      read(
        "## Results [1]\n### Step 2: Gather data\n## Top 5 providers by 2024 revenue\n# What changed in 2024?\n## Detection: energy and zero-crossings\n## Gates: FR-006 and FR-002\n\nRevenue grew in every region [1].",
      ),
    ).toEqual([["Revenue grew in every region.", ["1"]]]);
  });

  test("a heading that states a figure as a sentence is a claim, whatever else the answer asks", () => {
    // Design §0, A, B and C: a question after the heading hid it from the
    // rule for an answer of nothing but headings, and each passed 0/0.
    for (const [doc, claim] of [
      [
        "### No two of the six meetings overlap\n\nWant me to send the invites?",
        "No two of the six meetings overlap",
      ],
      ["## The invoice total is 1,284.60\n\nShould I email it?", "The invoice total is 1,284.60"],
      ["## The refund window is 30 days\n\nAnything else?", "The refund window is 30 days"],
      ["The refund window is 30 days\n---\n\nAnything else?", "The refund window is 30 days"],
      ["## Refund window: 30 days\n\nAnything else?", "Refund window: 30 days"],
      [
        "## Step 2: The refund window is 30 days\n\nAnything else?",
        "Step 2: The refund window is 30 days",
      ],
      ["## Refunds close after 30 days\n\nAnything else?", "Refunds close after 30 days"],
    ] as const) {
      expect(read(doc)).toEqual([[claim, []]]);
    }
    // Beside another claim, a headline figure is read too — with any finite
    // verb, not only a form of "be": "## Refunds close after 30 days" over a
    // cited 14-day body was served grounded ✓ 1/1.
    for (const heading of [
      "## The total with tax is 1,386.26",
      "## Total with tax 1,386.26",
      "## Total with tax: $1,386.26",
      "## The invoice comes to 1,386.26",
      "## Refunds close after 30 days",
      "## AWS revenue rose 25% in 2024",
      "## Revenue grew 18.5% year over year",
      "## Key finding: revenue grew 19%",
      "## The refund window lasts 30 days",
      "## The refund takes 30 days",
      "## The meeting moved to 3pm",
      "## Prices start at $10",
      "## Q3 revenue hit $52B",
      "### The 6 meetings do not overlap",
      "### The six meetings never overlap",
      "### All 6 meetings fit without overlap",
      "# Quarterly revenue grew 12 percent",
      // A verb's value behind a preposition, a verb no list holds, a name
      // that ends in a figure (I5: each passed grounded ✓ over a body that
      // said otherwise).
      "## Refund window extended to 30 days",
      "## Operating margin improved to 37%",
      "## AWS accounted for 17% of revenue",
      "## Wait times dropped from 12 to 4 minutes",
      "## Uptime held at 99.99%",
      "## Refunds settle within 30 days",
      "## iPhone 15 costs $799",
      "## Tier 2 costs $49 a month",
      "## GPT-5 scores 90% on MMLU",
      "## Windows 11 requires 4 GB of RAM",
      "## Plan 2 includes 5 seats",
      "## AWS made $150B in 2024",
      "## Cloud drove 60% of operating income",
      "## Netflix adds 9M subscribers",
      "## The company employs 1,500 people",
    ]) {
      expect(
        read(`${heading}\n\nThe subtotal is 1,284.50 [1].\n\n[1]: tool:toolu_money1`).map(
          ([text]) => text,
        ),
      ).toEqual([heading.replace(/^#+ /, ""), "The subtotal is 1,284.50."]);
    }
    // The setext form too.
    expect(
      read("AWS revenue rose 25% in 2024\n---\n\nAWS revenue was $107.6B in 2024 [1].").map(
        ([text]) => text,
      ),
    ).toEqual(["AWS revenue rose 25% in 2024", "AWS revenue was $107.6B in 2024."]);
    // A declarative heading with no figure is read when the answer only asks
    // in its body.
    expect(read("## Refunds are accepted for every unused item\n\nAnything else?")).toEqual([
      ["Refunds are accepted for every unused item", []],
    ]);
    // Over a question alone too.
    for (const heading of ["Refund window extended to 30 days", "Refunds settle within 30 days"]) {
      expect(read(`## ${heading}\n\nAnything else I can help with?`)).toEqual([[heading, []]]);
    }
  });

  test("a title with a count or a list's label is no claim (design §2, §18)", () => {
    const body = "\n\nAWS revenue was $107.6B in 2024 [1].\n\n[1]: https://a.example/x";
    for (const title of [
      "## Summary: 3 key takeaways",
      "## Part 2: 5 tips",
      "### Day 1: 3 hikes",
      "## Option A: 2 servers",
      "## Phase 1: 2 weeks",
      "## Step 3: 10 minutes",
      "# Research: 5 best CRMs",
      "## Chapter 3: 10 Rules",
      "# Compare: 3 cloud providers",
      "## Monday: 5k run",
      "## Price list for 2024",
      "## Top 5 providers by 2024 revenue",
      "## How the 3 plans differ",
      // A noun phrase, a participle's title or an imperative has no verb of
      // its own, whatever verb's form it holds.
      "## Shipping costs for 2024",
      "## Price increases for 2025",
      "## Tickets closed in 2024",
      "## Lessons learned in 2024",
      "## Getting started in 5 minutes",
      "## 5 ways to cut costs",
      "## Cut costs by 30%",
      "# Compare the 2024 revenue of the top 3 providers",
      "## The 3 plans compared",
      "## Year 1 costs",
      "## Odds and ends for 2024",
      // A participle's title over a period, a bare singular subject too.
      "## Revenue earned in 2024",
      "## Money saved in 2024",
      "## Capital raised in 2024",
      "## Decisions made in 2024",
      "## Mistakes made by startups",
      // A count behind a preposition is what the noun is about.
      "## Changes to 2 policies",
      "## Price changes for 3 plans",
      "## Features added for 3 plans",
      "## Updates to 3 plans",
      "## Top 5 costs to cut",
      "## Cut 3 costs by 30%",
      "## 5 ways revenue grew in 2024",
      "## The 3 reasons churn rose in 2024",
      "## Sales teams across 30 countries",
      "## Top stories at 5pm",
      "## Key metrics for Q3",
    ]) {
      expect(`${title} → ${JSON.stringify(read(`${title}${body}`).map(([text]) => text))}`).toBe(
        `${title} → ["AWS revenue was $107.6B in 2024."]`,
      );
    }
    // A plan of nothing but day headings states nothing.
    expect(read("# Weekly plan\n\n## Monday: 5k run\n\n## Tuesday: rest")).toEqual([]);
    // A report-writer goal over its question sections.
    expect(
      read(
        "# Compare: 3 cloud providers\n\n## What was AWS revenue in 2024?\n\nAWS revenue was $107.6B in 2024 [1].\n\n[1]: https://a.example/x",
      ).map(([text]) => text),
    ).toEqual(["AWS revenue was $107.6B in 2024."]);
    // A measured value after a quantity's name is still read.
    expect(read("## Invoice total: 1,284.50\n\nThe subtotal is 1,000 [1].")).toEqual([
      ["Invoice total: 1,284.50", []],
      ["The subtotal is 1,000.", ["1"]],
    ]);
  });

  test("an answer that is nothing but headings is read as its headings", () => {
    // Design §0 C: a claim written as a heading has no sentence to hide behind.
    expect(read("### No two of the six meetings overlap")).toEqual([
      ["No two of the six meetings overlap", []],
    ]);
    expect(read("The refund window is 30 days\n---")).toEqual([
      ["The refund window is 30 days", []],
    ]);
    // An answer that asks is the clarifying question a vacuous pass is for.
    expect(read("## Refund options for 2024\n\nWhich option do you want?")).toEqual([]);
    expect(read("## Overview")).toEqual([]);
  });

  test("a question piece is read in linear time whatever its clauses and ends", () => {
    // Each shape at a size where reading its every clause or end again from
    // the piece's start would cost far more than reading it once.
    const shapes: Array<[string, (n: number) => string, number]> = [
      ["clauses", (n) => `${"words, here ".repeat(n)}done?`, 90],
      ["initialisms", (n) => `${"Is x.y ".repeat(n)}done?`, 500],
      ["names", (n) => `${"is it.it ".repeat(n)}done?`, 100],
      ["figures", (n) => `${"a 3 — ".repeat(n)}done?`, 90],
      ["marker lines", (n) => `${"[1]\n".repeat(n)}done?`, 500],
      ["glued capitals", (n) => `Is ${"x.Y".repeat(n)} fine?`, 250],
    ];
    for (const [shape, make, n] of shapes) {
      expect(`${shape}: ${readsLinearly(make, n)}`).toBe(`${shape}: linear`);
    }
  }, 60_000);
});

describe("extractClaims agrees with citedClaims", () => {
  test("on every cited sentence of plain prose: same text, same markers", () => {
    const doc = [
      "# Report",
      "",
      "Revenue rose 12% in the second quarter [1]. Costs fell [2] while margins held [1].",
      "- Headcount grew by four engineers [3].",
      "- As J. Smith noted, e.g. in fig. 3, churn fell [^a].",
      "",
      "Nothing here cites anything, but it is still a claim worth checking.",
      "",
      "[1]: ./q2.md",
      "[2]: https://acme.example/costs",
      "[3]: tool:toolu_01",
      "[a]: Smith, J. (2024)",
    ].join("\n");
    const cited = citedClaims(doc).map(({ text, markers }) => ({ text, markers }));
    const extracted = extractClaims(doc)
      .filter((c) => c.markers.length > 0)
      .map(({ text, markers }) => ({ text, markers }));
    expect(extracted).toEqual(cited);
    expect(extractClaims(doc)).toHaveLength(5);
  });

  test("they differ where citedClaims carries code or a source into a claim (pinned)", () => {
    const doc =
      "Here is the config:\n```yaml\nretries: 3\n```\nThe service restarts nightly [1].\n\n[1]: ./ops.md";
    expect(citedClaims(doc)[0]?.text).toBe(
      "Here is the config: yaml retries: 3 The service restarts nightly.",
    );
    expect(extractClaims(doc).map((c) => c.text)).toEqual(["The service restarts nightly."]);
  });

  test("every marker citedClaims gives a declarative sentence is a marker of a claim here", () => {
    // A seeded generator of the shapes models write: prose, glued and spaced
    // markers, bullets, numbered items, quotes, headings, questions, code.
    // Three hundred documents take 0.1 to 0.3 s here, so a runner twenty
    // times slower can run past the default five seconds.
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(rnd() * xs.length)] as T;
    const WORDS = ["revenue", "rose", "costs", "fell", "12%", "30", "days", "refund", "window"];
    // Every marker id is used once, so the check is per marker written.
    let id = 0;
    const sentence = (): string => {
      const words = Array.from({ length: 3 + Math.floor(rnd() * 6) }, () => pick(WORDS)).join(" ");
      id += 1;
      const marker = rnd() < 0.6 ? `[${pick(["", "^f", "A"])}${id}]` : "";
      return pick([
        `${words} ${marker}.`,
        `${words}.${marker}`,
        `${words}. ${marker}`,
        `${words} ${marker}?`,
        `${words} ${marker}`,
        `# ${words} ${marker}.`,
        // A reference-link run: the grammar's marker is the last bracket.
        `${words}.[x${id}]${marker}`,
        `${words}. [x${id}]${marker}`,
        // Nothing but inline code, cited.
        `\`${words}\` ${marker}.`,
        // A one-word link opening the sentence: its marker is the
        // sentence's, and after a question it was lost with the question.
        marker === "" ? `${words}.` : `[Stripe]${marker} ${words}.`,
      ]);
    };
    for (let doc = 0; doc < 300; doc++) {
      const lines: string[] = [];
      for (let i = 0; i < 6; i++) {
        const open = pick(["", "", "- ", `${1 + i}. `, "> ", "## ", "  ", "   "]);
        lines.push(`${open}${sentence()} ${rnd() < 0.5 ? sentence() : ""}`.trimEnd());
        // Under a list item or a quote `---` is a thematic break; under a
        // paragraph it would make a setext heading, which is no claim.
        if ((open === "- " || open === "> ") && rnd() < 0.3) lines.push("---");
        if (rnd() < 0.3) lines.push("");
        if (rnd() < 0.1) lines.push("```", "code [0] here", "```");
        // The shapes a column-0 reading of blocks got wrong. Each ends on a
        // line at column 0, so no shape after it starts inside its item.
        const shape = rnd();
        if (shape < 0.06) lines.push("", "- ```js", "  const x = 1;", "  ```", sentence());
        else if (shape < 0.12) lines.push("", "1. ```bash", "   ls", "   ```", "", sentence());
        else if (shape < 0.18)
          lines.push("", "- item text here", "", "  ```", "  ls", "", sentence());
        else if (shape < 0.24)
          lines.push("", "- item text here", "", "  ## Details", `  ${sentence()}`);
        else if (shape < 0.3) lines.push("", `${pick(["  ", "   ", " "])}# Summary`, sentence());
        else if (shape < 0.36) lines.push("", "- item text here", "", `  ${sentence()}`, "---", "");
        else if (shape < 0.42) lines.push("", "refund window days", "1.", "");
        // The same inside a list item: an indented 1. or 14. that cannot
        // interrupt the item's paragraph, and a fence after one, which a
        // reader that took "14." for an item put at column 0 and never closed.
        else if (shape < 0.48) lines.push("", "- refund window days", "  1.", "", sentence());
        else if (shape < 0.54)
          lines.push("", "1. refund window was cut to", `   14. ${sentence()}`, "", sentence());
        else if (shape < 0.6)
          lines.push(
            "",
            "- refunds need a manager.",
            "   14.",
            "most are approved.",
            "  ```",
            sentence(),
          );
      }
      const text = lines.join("\n");
      const all = text.split("\n");
      const seen = new Set(extractClaims(text).flatMap((c) => c.markers));
      for (const claim of citedClaims(text)) {
        if (isQuestion(claim.text)) continue;
        for (const marker of claim.markers) {
          // A heading is never a claim: a marker on a heading line is not
          // looked for. citedClaims runs an indented heading into the line
          // under it, so this is asked of the marker's line, not the claim's.
          const at = all.find((l) => l.includes(`[${marker}]`) || l.includes(`[^${marker}]`));
          if (/^[ \t]{0,3}#{1,6}[ \t]/.test(at ?? "")) continue;
          expect(`${marker} in ${JSON.stringify(text)}`).toBe(
            `${seen.has(marker) ? marker : "MISSING"} in ${JSON.stringify(text)}`,
          );
        }
      }
    }
  }, 20_000);

  test("every marker on a line before a question is a marker of a claim", () => {
    // The shapes a question runs into: a figure line with no full stop, a
    // bold total, a table row, a lazy list line, a glued full stop.
    let seed = 11;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(xs: ReadonlyArray<T>): T => xs[Math.floor(rnd() * xs.length)] as T;
    const WORDS = ["revenue", "rose", "costs", "fell", "12%", "30", "days", "refund", "window"];
    const QUESTIONS = ["Anything else?", "want a chart?", "Shall I send it?", "**Want more?**"];
    let id = 0;
    for (let doc = 0; doc < 300; doc++) {
      const written: string[] = [];
      const lines: string[] = [];
      for (let i = 0; i < 1 + Math.floor(rnd() * 4); i++) {
        const words = Array.from({ length: 2 + Math.floor(rnd() * 5) }, () => pick(WORDS)).join(
          " ",
        );
        id += 1;
        written.push(String(id));
        lines.push(
          pick([
            `${words} [${id}]`,
            `**${words}** [${id}]`,
            `| ${words} | [${id}] |`,
            `- ${words} [${id}]`,
            `${words} [${id}] ${words}`,
            `${words} [${id}].`,
          ]),
        );
      }
      const question = pick(QUESTIONS);
      const text =
        rnd() < 0.3
          ? `${lines.join("\n")}.${question.replace(/^\W*\w/, (c) => c.toUpperCase())}`
          : `${lines.join(pick(["\n", "\r\n"]))}${pick(["\n", "\r\n"])}${question}`;
      const seen = new Set(extractClaims(text).flatMap((c) => c.markers));
      for (const marker of written) {
        expect(`${marker} in ${JSON.stringify(text)}`).toBe(
          `${seen.has(marker) ? marker : "MISSING"} in ${JSON.stringify(text)}`,
        );
      }
    }
  });

  test("an empty document has no claims", () => {
    expect(extractClaims("")).toEqual([]);
    expect(extractClaims("\n\n   \n")).toEqual([]);
  });
});

describe("extractClaims — linear in the document", () => {
  test("bullets nested deep, then many lazy lines under them", () => {
    // The gate reads model answers through this, synchronously. The shape
    // took 1.3 s at 195 KB (readBlocks scanned the open items per lazy
    // line).
    expect(readsLinearly((n) => `${"- ".repeat(n)}x\n${"y\n".repeat(n)}`, 3_000)).toBe("linear");
  }, 60_000);

  test("a question run into many lines, markers and glued questions", () => {
    // A question piece is cut from its end, each cut and marker read once.
    const glued = (n: number): string => `Total is 5.${"Is it?".repeat(n)}`;
    expect(extractClaims(glued(10_000)).map((c) => c.text)).toEqual(["Total is 5."]);
    const wrapped = (n: number): string =>
      `${"words here [1] ".repeat(n)}\n${"more\n".repeat(n)}more?`;
    expect(readsLinearly(wrapped, 125)).toBe("linear");
    expect(readsLinearly(glued, 500)).toBe("linear");
  }, 60_000);
});
