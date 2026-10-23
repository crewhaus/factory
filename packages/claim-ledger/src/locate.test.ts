import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WINDOW_TOKENS,
  MAX_EXCERPT_CHARS,
  bestSpan,
  breaksClause,
  claimFigureKeys,
  claimFigures,
  claimQuery,
  claimWords,
  clauseNumbers,
  figureKey,
  findSequence,
  governingNegation,
  indexSource,
  isWaivableMiss,
  locateClaim,
  locateQuote,
  locateQuotes,
  locateWords,
  normalizeToken,
  quotations,
  quotedRuns,
  scanMeter,
  tightestWindows,
} from "./locate";

const POLICY = "The refund window for orders placed by EU customers is 14 days from delivery.";

describe("claimWords", () => {
  test("drops stopwords, keeps negations, numbers with their signs, in first-seen order", () => {
    expect(claimWords("Revenue did not rise by 4.5% in the second quarter")).toEqual([
      "revenue",
      "not",
      "rise",
      "4.5%",
      "second",
      "quarter",
    ]);
  });

  test("collapses grouped thousands and folds a long plural, nothing cleverer", () => {
    expect(normalizeToken("1,284.50")).toBe("1284.50");
    expect(normalizeToken("1.200")).toBe("1.200");
    expect(normalizeToken("customers")).toBe("customer");
    expect(normalizeToken("days")).toBe("days");
    expect(normalizeToken("class")).toBe("class");
    expect(normalizeToken("company's")).toBe("company");
  });

  test("distinct words only", () => {
    expect(claimWords("growth growth GROWTH")).toEqual(["growth"]);
  });
});

describe("claimQuery", () => {
  test("a quotation of four or more words makes it a quote-mode claim", () => {
    const q = claimQuery('Acme says "the refund window is 14 days" for EU orders');
    expect(q.mode).toBe("quote");
    expect(q.quotes).toEqual([["the", "refund", "window", "is", "14", "days"]]);
  });

  test("a quotation shorter than four words is a phrase, checked as words", () => {
    const q = claimQuery('the "refund window" is 14 days');
    expect(q.mode).toBe("paraphrase");
    expect(q.quotes).toEqual([]);
  });

  test("the same span quoted twice is one span; curly quotes count, apostrophes do not", () => {
    const q = claimQuery(
      "“one two three four” and \"one two three four\" but the company's 'five six seven eight'",
    );
    expect(q.quotes).toEqual([["one", "two", "three", "four"]]);
  });

  test("quotedRuns keeps duplicates and the shared reader gives each quotation's text", () => {
    expect(quotedRuns('"a b c d" "a b c d" "x y"', 4)).toHaveLength(2);
    expect([...quotations('say "hello there" now')]).toEqual([
      { text: "hello there", words: ["hello", "there"] },
    ]);
  });
});

describe("locateClaim — paraphrase mode", () => {
  test("every word in one window is supported, with line and excerpt", () => {
    const source = `Preamble.\n${POLICY}\nUnrelated text.`;
    const found = locateClaim("EU customers have a refund window of 14 days", source);
    expect(found).toMatchObject({
      status: "supported",
      mode: "paraphrase",
      cause: "words",
      coverage: 1,
      line: 2,
    });
    expect(found.excerpt).toBe("refund window for orders placed by EU customers is 14 days");
    expect(found.missing).toBeUndefined();
  });

  test("a footnote mark after the claim is no word or figure of it", () => {
    const source = "Refunds are accepted within 30 days of purchase for unused items.";
    const one = String.fromCharCode(0x00b9);
    for (const claim of [
      `Refunds are accepted within 30 days of purchase.${one}`,
      `Refunds are accepted within 30 days of purchase ${one}`,
      `Refunds are accepted within 30 days of purchase${one}`,
    ]) {
      expect(`${claim} → ${locateClaim(claim, source, { coverage: 0.8 }).status}`).toBe(
        `${claim} → supported`,
      );
    }
    // A superscript standing as a number is that number, and is compared.
    const thirty = String.fromCharCode(0x00b3, 0x2070);
    expect(locateClaim(`Refunds are accepted within ${thirty} days`, source).status).toBe(
      "supported",
    );
    expect(
      locateClaim(`Refunds are accepted within ${thirty} days`, source.replace("30", "14")).status,
    ).toBe("notFound");
  });

  test("defaults are FactCrossCheck's: every word, a 60-token window", () => {
    expect(DEFAULT_WINDOW_TOKENS).toBe(60);
    const strict = locateClaim("EU customers get a refund window of 14 days by mail", POLICY);
    expect(strict.status).toBe("notFound");
    expect(strict.cause).toBe("coverage");
    expect(strict.missing).toEqual(["get", "mail"]);
  });

  test("coverage 0.8 accepts a paraphrase missing a fifth of its words; 1.0 does not", () => {
    // Eight words ("have" and "a" carry none); the source says "days", not "day".
    const claim = "Orders placed by EU customers have a 14 day refund window";
    const at08 = locateClaim(claim, POLICY, { coverage: 0.8 });
    expect(at08.status).toBe("supported");
    expect(at08.coverage).toBe(0.88);
    expect(at08.missing).toEqual(["day"]);
    const at1 = locateClaim(claim, POLICY, { coverage: 1 });
    expect(at1.status).toBe("notFound");
    expect(at1.cause).toBe("coverage");
  });

  test("the bar is compared unrounded: 0.795 does not clear 0.8", () => {
    // 31 of 39 words = 0.7948…, reported as 0.79; 32 of 40 = 0.8 exactly clears.
    const words = Array.from({ length: 39 }, (_, i) => `w${i}`);
    const source = words.slice(0, 31).join(" ");
    const miss = locateClaim(words.join(" "), source, { coverage: 0.8, windowTokens: 100 });
    expect(miss.status).toBe("notFound");
    expect(miss.coverage).toBe(0.79);
    const forty = Array.from({ length: 40 }, (_, i) => `w${i}`);
    const hit = locateClaim(forty.join(" "), forty.slice(0, 32).join(" "), {
      coverage: 0.8,
      windowTokens: 100,
    });
    expect(hit.status).toBe("supported");
  });

  test("design test A: a wrong number is never covered by the other words", () => {
    for (const claim of [
      "The refund window for orders placed by EU customers is 30 days",
      "The refund window for EU customers is 30 days",
    ]) {
      const found = locateClaim(claim, POLICY, { coverage: 0.8 });
      expect(found.status).toBe("notFound");
      expect(found.cause).toBe("value");
      expect(found.missing).toContain("30");
      expect(found.coverage).toBeGreaterThanOrEqual(0.8);
    }
  });

  test("a claim's negation the source lacks is a polarity conflict below full coverage", () => {
    const found = locateClaim(
      "The refund window is not 30 days.",
      "Our policy: the refund window is 30 days from delivery.",
      { coverage: 0.8 },
    );
    expect(found.status).toBe("polarityConflict");
    expect(found.cause).toBe("negation");
    expect(found.differing).toEqual(["not"]);
  });

  test("a negation in the source the claim lacks is a polarity conflict at any bar", () => {
    const source = "Revenue did not rise in the second quarter.";
    for (const coverage of [1, 0.8]) {
      const found = locateClaim("Revenue did rise in the second quarter", source, { coverage });
      expect(found.status).toBe("polarityConflict");
      expect(found.cause).toBe("polarity");
      expect(found.differing).toEqual(["not"]);
    }
  });

  test("a negation outside the matched span is not this claim's", () => {
    const source = `Nothing here is not true. ${"filler ".repeat(30)}Revenue rose in the second quarter.`;
    const found = locateClaim("Revenue rose in the second quarter", source);
    expect(found.status).toBe("supported");
  });

  test("below full coverage the window that carries the number wins over a wordier one", () => {
    const source = [
      "The refund window for orders placed by EU customers is described in the terms.",
      "filler ".repeat(70),
      "EU customers: the refund window for orders is 14 days.",
    ].join("\n");
    const found = locateClaim(
      "The refund window for orders placed by EU customers is 14 days",
      source,
      { coverage: 0.8 },
    );
    expect(found.status).toBe("supported");
    expect(found.line).toBe(3);
  });

  test("the window bounds how far apart the words may sit, widened to the claim's length", () => {
    const source = `revenue ${"x ".repeat(20)}rose`;
    expect(locateClaim("revenue rose", source, { windowTokens: 10 }).status).toBe("notFound");
    expect(locateClaim("revenue rose", source, { windowTokens: 30 }).status).toBe("supported");
    // A window narrower than the claim could never hold it, so it is widened.
    expect(
      locateClaim("alpha beta gamma delta", "alpha beta gamma delta", { windowTokens: 2 }).status,
    ).toBe("supported");
  });

  test("words that are nowhere are notFound with no line or excerpt", () => {
    const found = locateClaim("zebras migrate", POLICY);
    expect(found).toEqual({
      status: "notFound",
      mode: "paraphrase",
      cause: "coverage",
      matched: 0,
      total: 2,
      coverage: 0,
      missing: ["zebra", "migrate"],
    });
  });

  test("an empty claim is never found, at any bar", () => {
    for (const claim of ["", "the of and", "   "]) {
      for (const coverage of [1, 0.5, 0]) {
        const found = locateClaim(claim, POLICY, { coverage });
        expect(found.status).toBe("notFound");
        expect(found.cause).toBe("empty");
      }
    }
  });

  test("coverage 0 still needs a matched word", () => {
    expect(locateClaim("zebras", POLICY, { coverage: 0 }).status).toBe("notFound");
    expect(locateClaim("zebras refund", POLICY, { coverage: 0 }).status).toBe("supported");
  });

  test("a malformed option is read strictly, never loosely", () => {
    const claim = "Orders placed by EU customers have a 14 day refund window"; // 7 of 8 words
    expect(locateClaim(claim, POLICY, { coverage: Number.NaN }).status).toBe("notFound");
    expect(locateClaim(claim, POLICY, { coverage: 2 }).status).toBe("notFound");
  });

  test("a malformed window is the narrowest one, the claim's own length", () => {
    // "revenue" and "rose" sit 21 tokens apart: any window wider than that finds them.
    const far = `revenue ${Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ")} rose`;
    expect(locateClaim("revenue rose", far, { windowTokens: 30 }).status).toBe("supported");
    for (const windowTokens of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(locateClaim("revenue rose", far, { windowTokens }).status).toBe("notFound");
    }
    // A fractional window is floored, not widened.
    expect(locateClaim("revenue rose", far, { windowTokens: 21.9 }).status).toBe("notFound");
    expect(locateClaim("revenue rose", far, { windowTokens: 22 }).status).toBe("supported");
    // Adjacent words are found at any reading.
    expect(locateClaim("refund window", POLICY, { windowTokens: Number.NaN }).status).toBe(
      "supported",
    );
  });

  test("an empty source finds nothing", () => {
    expect(locateClaim("refund window", "").status).toBe("notFound");
  });
});

describe("locateClaim — the figure rule (below full coverage)", () => {
  const SHORT = "Customers may request a refund within 14 days of delivery.";

  test("a missing figure is a value miss even when the other words fall short too", () => {
    for (const [claim, source] of [
      ["The refund window is 30 days.", SHORT],
      [
        "The refund window for annual plans is 30 days.",
        "Annual plans have a refund period of 14 days from the date of purchase.",
      ],
    ] as const) {
      const found = locateClaim(claim, source, { coverage: 0.8 });
      expect(found.status).toBe("notFound");
      expect(found.cause).toBe("value");
      expect(found.coverage).toBeLessThan(0.8);
      expect(found.missing).toContain("30");
      expect(isWaivableMiss(found)).toBe(false);
    }
  });

  test("a missing negation is a negation miss below the bar, a polarity conflict above it", () => {
    const below = locateClaim(
      "The refund window for annual plans is not 30 days.",
      "The refund policy for annual plans: 30 days.",
      { coverage: 0.8 },
    );
    expect(below).toMatchObject({ status: "notFound", cause: "negation", differing: ["not"] });
    expect(below.coverage).toBeLessThan(0.8);
    expect(isWaivableMiss(below)).toBe(false);
    const above = locateClaim(
      "The refund window is not 30 days.",
      "Our policy: the refund window is 30 days from delivery.",
      { coverage: 0.8 },
    );
    expect(above).toMatchObject({ status: "polarityConflict", cause: "negation" });
  });

  test("numerals are compared by value, the percent sign kept", () => {
    const total = locateClaim(
      "The invoice total was $1,284.50 for March.",
      "The invoice total for March was 1284.5 dollars.",
      { coverage: 0.8 },
    );
    expect(total).toMatchObject({ status: "supported", coverage: 1 });
    expect(
      locateClaim(
        "Growth was 12.0% in March for the region.",
        "Growth was 12% in March for the region.",
        {
          coverage: 0.8,
        },
      ).status,
    ).toBe("supported");
    // 12% is not 12.
    const percent = locateClaim(
      "Growth was 12% in March for the region.",
      "Growth was 12 in March for the region.",
      { coverage: 0.8 },
    );
    expect(percent).toMatchObject({ status: "notFound", cause: "value", missing: ["12%"] });
  });

  test("a number word is a figure: wrong when the source says another, found when it says the same", () => {
    const thirty = locateClaim("The refund window for EU customers is thirty days", POLICY, {
      coverage: 0.8,
    });
    expect(thirty).toMatchObject({ status: "notFound", cause: "value", missing: ["thirty"] });
    expect(
      locateClaim("The refund window for EU customers is fourteen days", POLICY, { coverage: 0.8 })
        .status,
    ).toBe("supported");
    expect(
      locateClaim(
        "The refund window for orders placed by EU customers is 14 days",
        "The refund window for orders placed by EU customers is fourteen days.",
        { coverage: 0.8 },
      ).status,
    ).toBe("supported");
  });

  test("an ordinal is a figure, except one counting the points of a list", () => {
    const ranked = locateClaim(
      "Acme ranked first among all European payment processors in 2024",
      "Acme ranked fifth among all European payment processors in 2024",
      { coverage: 0.8 },
    );
    expect(ranked).toMatchObject({ status: "notFound", cause: "value", missing: ["first"] });
    const listed = locateClaim("First, the refund window for EU customers is 14 days.", POLICY, {
      coverage: 0.8,
    });
    expect(listed).toMatchObject({ status: "supported", missing: ["first"] });
    expect(claimFigures("First, Acme ranked first in 2024.")).toEqual(["first", "2024"]);
    expect(claimFigures("First, the window is 14 days.")).toEqual(["14"]);
  });

  test("a figure's sign is part of it: 500 is not -500, either way round", () => {
    // Acceptance A's class (design §6.2): the number layer reads -500, so
    // the checked rung already refused this; grounded let it through.
    const claim = "The account balance is 500 dollars.";
    for (const source of [
      "The account balance is -500 dollars.",
      "The account balance is −500 dollars.",
      "The account balance is -$500 dollars.",
    ]) {
      for (const options of [{ coverage: 0.8 }, { coverage: 1, strictFigures: true }]) {
        expect(locateClaim(claim, source, options)).toMatchObject({
          status: "notFound",
          cause: "value",
          missing: ["500"],
        });
      }
    }
    expect(
      locateClaim("The account balance is -500 dollars.", "The account balance is 500 dollars.", {
        coverage: 0.8,
      }),
    ).toMatchObject({ status: "notFound", cause: "value", missing: ["-500"] });
    const growth = "Growth was 3% year over year in the region.";
    expect(
      locateClaim(growth, "Growth was -3% year over year in the region.", { coverage: 0.8 }),
    ).toMatchObject({ status: "notFound", cause: "value", missing: ["3%"] });
    // The same sign, however written, is the same figure.
    expect(
      locateClaim("The account balance is −500 dollars.", "The account balance is -500 dollars.", {
        coverage: 0.8,
      }).status,
    ).toBe("supported");
    // A hyphen after a word or a digit signs nothing, and neither do
    // accounting parentheses, which the number layer does not read as one.
    for (const text of [
      "The event ran from 2024-01-15 to 2024-01-20 in Berlin.",
      "The refund window is 10-20 days for COVID-19 orders.",
    ]) {
      expect(locateClaim(text, text, { coverage: 0.8 }).status).toBe("supported");
    }
    expect(
      locateClaim("Acme's headcount was 1,200 in 2024.", "Acme's headcount (1,200) grew in 2024.", {
        coverage: 0.8,
      }).status,
    ).toBe("supported");
  });

  test("a quotation's numerals keep their sign, and so do its framing's", () => {
    const source = "Statement for March. The account balance is -500 dollars.";
    expect(
      locateClaim('Acme says "the account balance is 500 dollars" today.', source, {
        coverage: 0.8,
      }),
    ).toMatchObject({ status: "misquoted", mode: "quote", missing: ["500"], differing: ["-500"] });
    expect(
      locateClaim('Acme says "the account balance is -500 dollars" today.', source, {
        coverage: 0.8,
      }).status,
    ).toBe("supported");
    // Off the figure rule a quotation is FactCrossCheck's, unchanged.
    expect(
      locateClaim('Acme says "the account balance is 500 dollars" today.', source).status,
    ).toBe("supported");
    const shown = "As the statement for March shows, the account balance is -500 dollars.";
    expect(
      locateClaim('The balance is 500 dollars, as "the statement for March shows".', shown, {
        coverage: 0.8,
      }),
    ).toMatchObject({ status: "notFound", mode: "quote", cause: "value", missing: ["500"] });
    expect(
      locateClaim('The balance is -500 dollars, as "the statement for March shows".', shown, {
        coverage: 0.8,
      }).status,
    ).toBe("supported");
  });

  test("a magnitude glued to a numeral is a figure: $5M is not $5B", () => {
    for (const [claim, source, missing] of [
      ["Acme revenue reached $5M in March 2024.", "Acme revenue reached $5B in March 2024.", "m"],
      [
        "Acme posted revenue of $1.2M in fiscal 2024.",
        "Acme posted revenue of $1.2 billion in fiscal 2024.",
        "m",
      ],
      ["Acme has 30k active customers worldwide.", "Acme has 30 active customers worldwide.", "k"],
      [
        "The model has 7B parameters and runs locally.",
        "The model has 7M parameters and runs locally.",
        "b",
      ],
      // Short of the bar too: still a value miss, never one the judge may waive.
      ["Acme raised $5M.", "Acme raised $5B.", "m"],
    ] as const) {
      const found = locateClaim(claim, source, { coverage: 0.8 });
      expect(found).toMatchObject({ status: "notFound", cause: "value" });
      expect(found.missing).toContain(missing);
      expect(isWaivableMiss(found)).toBe(false);
    }
    // A suffix is the value its word names, either way round.
    for (const [claim, source] of [
      [
        "Acme posted revenue of $1.2B in fiscal 2024.",
        "Acme posted revenue of $1.2 billion in fiscal 2024.",
      ],
      [
        "Acme posted revenue of $5 million in fiscal 2024.",
        "Acme posted revenue of $5M in fiscal 2024.",
      ],
      [
        "Acme posted revenue of $1.2bn in fiscal 2024.",
        "Acme posted revenue of $1.2B in fiscal 2024.",
      ],
    ] as const) {
      expect(locateClaim(claim, source, { coverage: 0.8 }).status).toBe("supported");
    }
    // Glued to no numeral, a letter is a word.
    const plan = "Plan B costs $10 per month for every team.";
    expect(locateClaim(plan, plan, { coverage: 0.8 }).status).toBe("supported");
    expect(claimFigures(plan)).toEqual(["10"]);
    expect(claimFigures("Acme raised $5M at a 30k valuation")).toEqual(["5", "m", "30", "k"]);
  });

  test("a date or a time is a figure whole, not only its parts", () => {
    const swapped = locateClaim(
      "The annual plan renewal is due on 2025-03-04.",
      "The annual plan renewal is due on 2025-04-03 for every customer.",
      { coverage: 0.8 },
    );
    expect(swapped).toMatchObject({ status: "notFound", cause: "value" });
    expect(swapped.missing).toContain("2025-03-04");
    expect(isWaivableMiss(swapped)).toBe(false);
    const pieced = locateClaim(
      "The Berlin office opens at 10:30 on weekdays.",
      "The Berlin office opens at 10:00 on weekdays and closes at 18:30.",
      { coverage: 0.8 },
    );
    expect(pieced).toMatchObject({ status: "notFound", cause: "value" });
    expect(pieced.missing).toContain("10:30");
    // The same value, however its time is spelled, is found.
    for (const source of [
      "The Berlin office opens at 10:30 on weekdays.",
      "The Berlin office opens at 10:30am on weekdays.",
      "The Berlin office opens at 10:30:00 on weekdays.",
    ]) {
      expect(
        locateClaim("The Berlin office opens at 10:30 on weekdays.", source, { coverage: 0.8 })
          .status,
      ).toBe("supported");
    }
    // In a quotation's framing too.
    expect(
      locateClaim(
        'It is due 2025-03-04, since "the annual plan renews automatically".',
        "The annual plan renews automatically. It is due 2025-04-03.",
        { coverage: 0.8 },
      ),
    ).toMatchObject({ status: "notFound", mode: "quote", cause: "value", missing: ["2025-03-04"] });
    expect(claimQuery("Due 2025-03-04 at 09:05 and 2025-03-04.").compounds).toEqual([
      "2025-03-04",
      "9:05",
    ]);
  });

  test("a range's second end is a figure the source states (the review's I14)", () => {
    const options = { coverage: 0.8 };
    expect(
      locateClaim("Meeting 2 ends at 11:30.", "Meeting 2: 10:00-11:30, room B.", options).status,
    ).toBe("supported");
    expect(
      locateClaim(
        "The store closes at 17:00 on weekdays.",
        "The store is open on weekdays 9:00-17:00.",
        options,
      ).status,
    ).toBe("supported");
    expect(
      locateClaim(
        "The promotion ends on 2025-04-30.",
        "The promotion runs 2025-04-01/2025-04-30.",
        options,
      ).status,
    ).toBe("supported");
    // A wrong end is still a value miss.
    expect(
      locateClaim("Meeting 2 ends at 11:45.", "Meeting 2: 10:00-11:30, room B.", options),
    ).toMatchObject({ status: "notFound", cause: "value" });
  });

  test("a figure in any script is a figure, and a wrong one is a value miss (design §6.2, A)", () => {
    const at = (...points: number[]): string => String.fromCodePoint(...points);
    const options = { coverage: 0.8 };
    for (const thirty of [
      at(0xff13, 0xff10),
      at(0x0663, 0x0660),
      at(0x0969, 0x0966),
      at(0x1d7d1, 0x1d7ce),
    ]) {
      const claim = `The refund window is ${thirty} days from the date of purchase.`;
      expect(locateClaim(claim, POLICY, options)).toMatchObject({
        status: "notFound",
        cause: "value",
      });
      expect(
        locateClaim(claim, "The refund window is 30 days from the date of purchase.", options)
          .status,
      ).toBe("supported");
    }
    // A Persian page and a Persian answer: 14 on the page, 30 in the answer.
    const page = `${at(0x0645, 0x062f, 0x062a)} ${at(0x06f1, 0x06f4)} ${at(0x0631, 0x0648, 0x0632)}`;
    const answer = `${at(0x0645, 0x062f, 0x062a)} ${at(0x06f3, 0x06f0)} ${at(0x0631, 0x0648, 0x0632)}`;
    expect(locateClaim(answer, page, options)).toMatchObject({
      status: "notFound",
      cause: "value",
    });
    // A numeral no fold reads as digits is a figure compared as written.
    expect(figureKey(at(0x325a))).toBe(at(0x325a));
    expect(
      locateClaim(
        `The refund window is ${at(0x325a)} days from the date of purchase.`,
        POLICY,
        options,
      ),
    ).toMatchObject({ status: "notFound", cause: "value" });
  });

  test("a negation hidden by an invisible character or a lookalike letter is still one", () => {
    const at = (...points: number[]): string => String.fromCodePoint(...points);
    const source = "Refunds are accepted within 14 days of purchase for unused items.";
    for (const not of [
      `n${at(0x200b)}ot`,
      `n${at(0x200d)}ot`,
      `n${at(0x2060)}ot`,
      `n${at(0x00ad)}ot`,
      `n${at(0x043e)}t`,
      at(0xff4e, 0xff4f, 0xff54),
      at(0x1d5fb, 0x1d5fc, 0x1d601),
    ]) {
      const claim = `Refunds are ${not} accepted within 14 days of purchase for unused items.`;
      expect(`${JSON.stringify(not)} ${locateClaim(claim, source, { coverage: 0.8 }).status}`).toBe(
        `${JSON.stringify(not)} polarityConflict`,
      );
    }
  });

  test("claimFigureKeys: each figure word with what it is compared as", () => {
    expect(claimFigureKeys("from -5 to 5, then $5M and −3%")).toEqual(
      new Map([
        ["5", ["-5", "5"]],
        ["m", ["1000000"]],
        ["3%", ["-3%"]],
      ]),
    );
    expect(claimFigureKeys("First, thirty days.")).toEqual(new Map([["thirty", ["30"]]]));
  });

  test("figureKey: numerals by value, cardinals by value, ordinals as spelled", () => {
    expect(figureKey("1284.50")).toBe("1284.5");
    expect(figureKey("12.0%")).toBe("12%");
    expect(figureKey("1,5")).toBe("1,5");
    expect(figureKey("thirty")).toBe("30");
    expect(figureKey("million")).toBe("1000000");
    expect(figureKey("third")).toBe("third");
    expect(figureKey("second")).toBeNull();
    expect(figureKey("refund")).toBeNull();
    // A signed figure, as a miss reports one; a magnitude suffix alone is a word.
    expect(figureKey("-500")).toBe("-500");
    expect(figureKey("−12.0%")).toBe("-12%");
    expect(figureKey("-0")).toBe("0");
    expect(figureKey("m")).toBeNull();
  });

  test("off at full coverage by default, which is FactCrossCheck's rule unchanged", () => {
    const claim = "The invoice total was $1,284.50 for March.";
    const source = "The invoice total for March was 1284.5 dollars.";
    expect(locateClaim(claim, source).status).toBe("notFound");
    expect(locateClaim(claim, source, { coverage: 1, strictFigures: true }).status).toBe(
      "supported",
    );
    // Off below full coverage, a figure is an ordinary word.
    expect(
      locateClaim("The refund window for orders placed by EU customers is 30 days", POLICY, {
        coverage: 0.8,
        strictFigures: false,
      }).status,
    ).toBe("supported");
  });

  test("a quote-mode claim's framing figures and negations must sit near the quotation", () => {
    const source = "Acme refund policy. Customers may request a refund within 14 days of delivery.";
    const wrong = locateClaim(
      'The refund window is 30 days, since "customers may request a refund".',
      source,
      { coverage: 0.8 },
    );
    expect(wrong).toMatchObject({
      status: "notFound",
      mode: "quote",
      cause: "value",
      missing: ["30"],
    });
    for (const figure of ["14", "fourteen"]) {
      expect(
        locateClaim(
          `The refund window is ${figure} days, since "customers may request a refund".`,
          source,
          { coverage: 0.8 },
        ).status,
      ).toBe("supported");
    }
    const negated = locateClaim('It is not true that "customers may request a refund".', source, {
      coverage: 0.8,
    });
    expect(negated).toMatchObject({
      status: "polarityConflict",
      mode: "quote",
      cause: "negation",
      differing: ["not"],
    });
    // Too far from the quotation is not near it.
    const far = `Customers may request a refund. ${"filler ".repeat(30)}Within 30 days.`;
    expect(
      locateClaim('Within 30 days, "customers may request a refund".', far, {
        coverage: 0.8,
        windowTokens: 10,
      }).cause,
    ).toBe("value");
    // FactCrossCheck's quote rule, unchanged: the quotation alone.
    expect(
      locateClaim('The refund window is 30 days, since "customers may request a refund".', source)
        .status,
    ).toBe("supported");
  });
});

describe("isWaivableMiss", () => {
  test("only a paraphrase partly found, missing only ordinary words", () => {
    const partial = locateClaim("EU customers get a refund window of 14 days by mail", POLICY, {
      coverage: 0.95,
    });
    expect(partial).toMatchObject({ status: "notFound", cause: "coverage" });
    expect(isWaivableMiss(partial)).toBe(true);
    expect(isWaivableMiss(locateClaim("zebras migrate", POLICY, { coverage: 0.8 }))).toBe(false);
    expect(
      isWaivableMiss(locateClaim("The refund window is 30 days", POLICY, { coverage: 0.8 })),
    ).toBe(false);
    expect(isWaivableMiss(locateClaim('Acme says "zebras migrate north often"', POLICY))).toBe(
      false,
    );
    expect(isWaivableMiss(locateClaim("refund window", POLICY, { coverage: 0.8 }))).toBe(false);
    expect(isWaivableMiss(locateClaim("", POLICY, { coverage: 0.8 }))).toBe(false);
  });

  test("at coverage 1, where the figure rule is off, a wrong number or a lost negation is never waivable", () => {
    const at1 = { coverage: 1 } as const;
    const wrong = locateClaim(
      "The refund window is 30 days.",
      "The refund window is 14 days.",
      at1,
    );
    // FactCrossCheck's status and detail, unchanged; the cause names the figure.
    expect(wrong).toMatchObject({ status: "notFound", cause: "value", missing: ["30"] });
    expect(isWaivableMiss(wrong)).toBe(false);
    const spelled = locateClaim(
      "The refund window is thirty days.",
      "The refund window is 14 days.",
      at1,
    );
    expect(spelled).toMatchObject({ status: "notFound", cause: "value", missing: ["thirty"] });
    expect(isWaivableMiss(spelled)).toBe(false);
    const negated = locateClaim(
      "Refunds are not paid within 3 days.",
      "Refunds are paid within 3 days.",
      at1,
    );
    expect(negated).toMatchObject({ status: "notFound", cause: "negation", missing: ["not"] });
    expect(negated.differing).toBeUndefined();
    expect(isWaivableMiss(negated)).toBe(false);
    // A figure wins over a negation, as under the rule.
    expect(
      locateClaim("Refunds are not paid within 5 days.", "Refunds are paid within 3 days.", at1)
        .cause,
    ).toBe("value");
    // Missing only ordinary words is still a coverage miss, and waivable.
    const wording = locateClaim("EU customers get a refund window of 14 days by mail", POLICY, at1);
    expect(wording.cause).toBe("coverage");
    expect(isWaivableMiss(wording)).toBe(true);
    // Explicitly off below full coverage, the same.
    expect(
      locateClaim("The refund window is 30 days by mail.", "The refund window is 14 days.", {
        coverage: 0.9,
        strictFigures: false,
      }).cause,
    ).toBe("value");
  });
});

describe("locateClaim — quote mode", () => {
  test("a verbatim quotation is supported; punctuation and case are not compared", () => {
    const found = locateClaim('Acme: "THE refund window, for orders placed" applies', POLICY);
    expect(found).toMatchObject({
      status: "supported",
      mode: "quote",
      cause: "quote",
      coverage: 1,
    });
    expect(found.excerpt).toBe("The refund window for orders placed");
  });

  test("the quotation is what is verified, not the framing around it", () => {
    const found = locateClaim('Zebras say "the refund window for orders placed"', POLICY);
    expect(found.status).toBe("supported");
  });

  test("a near-identical span is a misquote, showing what the source wrote", () => {
    const found = locateClaim('Acme says "the refund window for orders made"', POLICY);
    expect(found.status).toBe("misquoted");
    expect(found.missing).toEqual(["made"]);
    expect(found.excerpt).toBe("The refund window for orders");
  });

  test("a quotation barely in the source is notFound, not a misquote", () => {
    const found = locateClaim('"zebras migrate north every refund"', POLICY);
    expect(found.status).toBe("notFound");
    expect(found.mode).toBe("quote");
    expect(found.line).toBeUndefined();
  });

  test("coverage does not loosen a quotation", () => {
    const found = locateClaim('Acme says "the refund window for orders made"', POLICY, {
      coverage: 0.5,
    });
    expect(found.status).toBe("misquoted");
  });

  test("several quotations: the worst decides, and notFound stops the reading", () => {
    const index = indexSource(POLICY);
    const runs = [
      ["refund", "window", "for", "order"],
      ["zebras", "migrate", "north", "now"],
      ["placed", "by", "eu", "customer"],
    ];
    const asked: number[] = [];
    const found = locateQuotes(index, runs, (run, position) => {
      asked.push(position);
      return locateQuote(index, run);
    });
    expect(found.status).toBe("notFound");
    expect(asked).toEqual([0, 1]);
  });

  test("quotes with no runs are never found", () => {
    expect(locateQuotes(indexSource(POLICY), []).status).toBe("notFound");
  });
});

describe("negation scope", () => {
  /** The governing negation of the word `word` in `text`, as written, or null. */
  const governor = (text: string, word: string): string | null => {
    const index = indexSource(text);
    const at = index.tokens.findIndex((token) => token.raw === word);
    expect(at).toBeGreaterThanOrEqual(0);
    const negation = governingNegation(index, at);
    return negation === -1 ? null : (index.tokens[negation]?.raw ?? null);
  };

  test("a negation right before a word, at most two words off, in the same clause, governs it", () => {
    expect(governor("The total is not 1,284.50 EUR.", "1,284.50")).toBe("not");
    expect(governor("The total isn't 1,284.50.", "1,284.50")).toBe("isn't");
    expect(governor("The total was never 1,284.50.", "1,284.50")).toBe("never");
    expect(governor("The total is not equal to 1,284.50.", "1,284.50")).toBe("not");
    expect(governor("Revenue did not exceed 40.", "40")).toBe("not");
    expect(governor("Never has the company reported a loss.", "company")).toBe("Never");
    expect(governor("No two of the six meetings overlap.", "two")).toBe("No");
  });

  test("…and nothing past a clause break, a copula, its reach, or a determiner's noun", () => {
    // A clause break: the negation is about the discount.
    expect(governor("No discount was applied, so the total is 1,284.50.", "1,284.50")).toBeNull();
    // A copula: the negation sits in the subject's own phrase.
    expect(governor("The total without VAT is 1,284.50.", "1,284.50")).toBeNull();
    expect(governor("The lines that did not ship is 1,284.50.", "1,284.50")).toBeNull();
    // Three words off.
    expect(governor("It did not reach a total of 1,284.50.", "1,284.50")).toBeNull();
    // A conjunction starts another conjunct.
    expect(governor("The total is not 1284.05 but 1284.50.", "1284.50")).toBeNull();
    expect(governor("The total is not 5 or 6.", "6")).toBeNull();
    expect(governor("It is neither 5 nor 6.", "6")).toBe("nor");
    // "No" denies the word right after it, nothing past it.
    expect(governor("There is no doubt the window is 14 days.", "window")).toBeNull();
    expect(governor("No more than 5 vendors are approved.", "5")).toBeNull();
    expect(governor("There is no 5 dollar fee.", "5")).toBe("no");
    // A compound modifier, and "not only", deny nothing.
    expect(governor("No-fee refunds are paid within 14 days.", "refunds")).toBeNull();
    expect(governor("It is not only 5 but 6.", "5")).toBeNull();
    // JSON: every field is a clause of its own.
    expect(governor('{"discount":"none","total":"1284.50"}', "1284.50")).toBeNull();
    // The first token has nothing before it, and a position off the end is nothing.
    const index = indexSource("not 5");
    expect(governingNegation(index, 0)).toBe(-1);
    expect(governingNegation(index, 9)).toBe(-1);
  });

  test("breaksClause and clauseNumbers: punctuation, quotes, brackets, line breaks and a spaced dash", () => {
    for (const gap of [
      ", ",
      "; ",
      ": ",
      ". ",
      '":"',
      "\n",
      "\r\n",
      "(",
      ") ",
      " | ",
      " — ",
      " - ",
    ]) {
      expect([gap, breaksClause(gap)]).toEqual([gap, true]);
    }
    for (const gap of [" ", "-", " -", "  ", "'", " $"]) {
      expect([gap, breaksClause(gap)]).toEqual([gap, false]);
    }
    expect([...clauseNumbers(indexSource("91 is not prime: 91 = 7 * 13"))]).toEqual([
      0, 0, 0, 0, 1, 1, 1,
    ]);
    expect([...clauseNumbers(indexSource('{"amount":"1284.50","note":"no rounding"}'))]).toEqual([
      0, 1, 2, 3, 3,
    ]);
    expect(clauseNumbers(indexSource(""))).toHaveLength(0);
  });

  test("under the figure rule a negation opening the source's statement is a polarity conflict", () => {
    const found = locateClaim(
      "Two of the six meetings overlap.",
      "No two of the six meetings overlap.",
      { coverage: 0.8 },
    );
    expect(found).toMatchObject({ status: "polarityConflict", cause: "polarity" });
    expect(found.differing).toEqual(["no"]);
    // The claim's own negation is no conflict.
    expect(
      locateClaim("No two of the six meetings overlap.", "No two of the six meetings overlap.", {
        coverage: 0.8,
      }).status,
    ).toBe("supported");
    // At coverage 1 with the rule asked for, too.
    expect(
      locateClaim("Not one vendor is approved", "Not one vendor is approved.", { coverage: 1 })
        .status,
    ).toBe("supported");
    expect(
      locateClaim("One vendor is approved", "Not one vendor is approved.", {
        coverage: 1,
        strictFigures: true,
      }).status,
    ).toBe("polarityConflict");
  });

  test("the opener is read before the claim at its tightest, not before a stray earlier word", () => {
    const found = locateClaim(
      "Members pay 5 dollars",
      "Customers who are not members pay 10 dollars; members pay 5 dollars.",
      { coverage: 0.8 },
    );
    expect(found.status).toBe("supported");
    expect(
      locateClaim("Refunds take 14 days", "Never do refunds take 14 days.", { coverage: 0.8 })
        .status,
    ).toBe("polarityConflict");
  });

  test("tightestWindows: every shortest window holding each needed key present", () => {
    const keys = ["x", "member", "pay", "10", "member", "pay", "5"];
    expect(tightestWindows(keys, new Set(["member", "pay", "5"]))).toEqual([[4, 6]]);
    // Ties are all returned; a key that is nowhere is not asked for.
    expect(tightestWindows(["a", "b", "a", "b"], new Set(["a", "b", "zz"]))).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(tightestWindows(["a"], new Set(["zz"]))).toEqual([]);
  });

  test("without the figure rule the span is FactCrossCheck's, unchanged: the opener is not read", () => {
    expect(
      locateClaim("Two of the six meetings overlap.", "No two of the six meetings overlap.").status,
    ).toBe("supported");
  });
});

describe("the kernel pieces", () => {
  test("an index can be reused across claims, and excerpts are capped", () => {
    const long = `${"word ".repeat(300)}`;
    const index = indexSource(`alpha ${long}omega`);
    const found = locateClaim("alpha omega", index, { windowTokens: 400 });
    expect(found.status).toBe("supported");
    expect((found.excerpt as string).length).toBe(MAX_EXCERPT_CHARS);
    expect(found.excerpt?.endsWith("…")).toBe(true);
    expect(locateClaim("alpha", index).status).toBe("supported");
  });

  test("findSequence finds a run of words; bestSpan ties go to the earliest window", () => {
    const index = indexSource("a b c a b c");
    expect(findSequence(index, ["b", "c"])).toBe(1);
    expect(findSequence(index, ["c", "b"])).toBe(-1);
    const span = bestSpan(indexSource("x revenue y revenue"), ["revenue"], 1);
    expect(span.firstToken).toBe(1);
  });

  test("bestSpan without a preference is the unconstrained pass", () => {
    const index = indexSource(`alpha beta gamma ${"x ".repeat(40)}alpha 14`);
    const need = ["alpha", "beta", "gamma", "14"];
    const plain = bestSpan(index, need, 10);
    expect(plain.missing).toEqual(["14"]);
    // A preference the best holding window cannot meet changes nothing.
    expect(bestSpan(index, need, 10, { required: new Set(["14"]), atLeast: 3 })).toEqual(plain);
    // One it can meet picks that window.
    expect(bestSpan(index, need, 10, { required: new Set(["14"]), atLeast: 2 }).missing).toEqual([
      "beta",
      "gamma",
    ]);
  });

  test("locateWords counts one pass over the source in the shared meter", () => {
    const index = indexSource("one two three four five");
    const before = scanMeter.tokens;
    locateWords(index, ["three"], {});
    expect(scanMeter.tokens - before).toBe(5);
  });
});
