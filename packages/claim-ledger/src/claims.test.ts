import { describe, expect, test } from "bun:test";
import { citationDefinitions, citedClaims, lintCitations } from "./citations";
import { extractClaims } from "./claims";
import { isQuestion } from "./sentences";

const texts = (text: string, minTokens?: number) =>
  extractClaims(text, minTokens === undefined ? {} : { minTokens }).map((c) => c.text);

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

  test("headings are not claims, ATX or setext", () => {
    expect(
      texts(
        "# Quarterly revenue grew 12 percent\n\nQuarterly revenue summary for leadership\n=======",
      ),
    ).toEqual([]);
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
    expect(
      texts("# Results. Revenue grew 12 percent everywhere\nCosts fell in every region [1]."),
    ).toEqual(["Costs fell in every region."]);
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
        "- Item one is here and it says something.\n\nRefunds are accepted within 30 days [1]\n---\n\n[1]: https://acme.example/policy",
      ),
    ).toEqual(["Item one is here and it says something."]);
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
  });

  test("an empty document has no claims", () => {
    expect(extractClaims("")).toEqual([]);
    expect(extractClaims("\n\n   \n")).toEqual([]);
  });
});
