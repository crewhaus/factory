import { describe, expect, test } from "bun:test";
import { locateClaim } from "./locate";
import { containsValue, extractNumbers, figureWord, normalizeNumber } from "./numbers";
import { containsQuote, quotedSpans } from "./quotes";

describe("extractNumbers", () => {
  test("design test B: a total with grouping and trailing zeros is one decimal", () => {
    expect(extractNumbers("The total is 1,284.50.")).toEqual(["1284.5"]);
  });

  test("thousands separators only in the unambiguous shape", () => {
    expect(extractNumbers("12,345,678.9 and 1,284")).toEqual(["12345678.9", "1284"]);
    // A list, a European decimal, a locale's figure: not read as the wrong one.
    expect(extractNumbers("1,5 and 1.284,50 and 1,2345")).toEqual([]);
  });

  test("decimals lose trailing zeros and leading zeros, never precision", () => {
    expect(extractNumbers("0.50 007 00.5 3.14159 10.0 0.0")).toEqual([
      "0.5",
      "7",
      "3.14159",
      "10",
      "0",
    ]);
  });

  test("percent and currency are dropped", () => {
    expect(extractNumbers("up 12% to $4.20, €3 and ¥1,000")).toEqual(["12", "4.2", "3", "1000"]);
  });

  test("negatives where a word cannot end, and not otherwise", () => {
    expect(extractNumbers("-3 and (−7) and -$4.20 and $-5")).toEqual(["-3", "-7", "-4.2", "-5"]);
    expect(extractNumbers("COVID-19")).toEqual(["19"]);
    // A date's parts, then the date whole; none of them negative.
    expect(extractNumbers("2024-01-15")).toEqual(["2024", "1", "15", "2024-01-15"]);
    expect(extractNumbers("-0 and -0.00")).toEqual(["0"]);
  });

  test("a space never groups", () => {
    expect(extractNumbers("1 284")).toEqual(["1", "284"]);
  });

  test("years are numbers", () => {
    expect(extractNumbers("in 2024, up from 1999")).toEqual(["2024", "1999"]);
  });

  test("versions, addresses and identifiers are not numbers", () => {
    expect(extractNumbers("v1.2.3, 1.2.3, 10.0.0.1, A1, sha256, h264, 0x1F, 4K60, .5")).toEqual([]);
  });

  test("a unit behind a number is fine", () => {
    expect(extractNumbers("5km, 10x, 3rd, 250ms")).toEqual(["5", "10", "3", "250"]);
  });

  test("exponents are applied exactly, and huge values stay the size they are written", () => {
    expect(extractNumbers("1.5e3 1e-7 2E+2 6.02e23")).toEqual([
      "1500",
      "0.0000001",
      "200",
      "602000000000000000000000",
    ]);
    expect(extractNumbers("1e300")).toEqual(["1e300"]);
    expect(normalizeNumber(`1${"0".repeat(300)}`)).toBe("1e300");
    expect(extractNumbers("1e6x")).toEqual([]);
  });

  test("a sentence's own full stop is not a decimal point; values are distinct", () => {
    expect(extractNumbers("It was 12. Then 12 again.")).toEqual(["12"]);
  });

  test("text without numbers yields none", () => {
    expect(extractNumbers("twelve apples")).toEqual([]);
  });
});

describe("extractNumbers — dates and times are values whole (design §6.3)", () => {
  test("an ISO date and a time of day are read whole, besides their parts", () => {
    expect(extractNumbers("due on 2025-03-04")).toEqual(["2025", "3", "4", "2025-03-04"]);
    expect(extractNumbers("starts at 10:30")).toEqual(["10", "30", "10:30"]);
    // An hour's leading zero and zero seconds are spelling, not value.
    expect(extractNumbers("at 09:05:00")).toEqual(["9", "5", "0", "9:05"]);
    expect(normalizeNumber("09:05")).toBe("9:05");
    expect(normalizeNumber(" 2025-04-03 ")).toBe("2025-04-03");
    // The day glued to an ISO datetime's T is still stated, by the date.
    expect(extractNumbers("2025-04-03T10:30:00.000Z")).toEqual([
      "2025",
      "4",
      "30",
      "0",
      "3",
      "2025-04-03",
      "10",
      "10:30",
    ]);
  });

  test("a swapped date or a time put together from two others is not contained", () => {
    const due = new Set(extractNumbers('{"renewal_due":"2025-04-03"}'));
    expect(containsValue(due, "2025-03-04")).toBe(false);
    expect(containsValue(due, "2025-04-03")).toBe(true);
    // Every part is there; the value is not.
    for (const value of extractNumbers("due on 2025-03-04")) {
      expect(containsValue(due, value)).toBe(value !== "2025-03-04");
    }
    expect(containsValue('{"start":"10:00","end":"11:30"}', "10:30")).toBe(false);
    expect(containsValue('{"start":"10:30:00"}', "10:30")).toBe(true);
    // A date written as prose states its parts only, and they are found.
    expect(extractNumbers("April 3, 2025").every((v) => containsValue(due, v))).toBe(true);
    expect(containsValue("2025-04-03T10:30:00Z", "3")).toBe(true);
  });

  test("only the shapes that need no guess: no slash date, ratio, range or impossible date", () => {
    for (const text of [
      "05/03/2024",
      "a 3:1 ratio",
      "10-20 days",
      "2025-13-40",
      "25:61",
      "v2024-01-15",
    ]) {
      expect(extractNumbers(text).some((v) => /[-:]\d/.test(v.slice(1)))).toBe(false);
    }
  });
});

describe("extractNumbers — a range or an interval states both its ends (the review's I14)", () => {
  test("the second end of a time range is a time of day, whole", () => {
    // "10:00-11:30" read only its first end, and a claim that the meeting
    // ends at 11:30 was not contained in the result that says so.
    expect(extractNumbers("Meeting 2: 10:00-11:30, room B")).toEqual([
      "2",
      "10",
      "0",
      "11",
      "30",
      "10:00",
      "11:30",
    ]);
    for (const range of ["9:00-17:00", "9:00/17:00", '{"hours":"9:00-17:00"}']) {
      expect(containsValue(range, "17:00")).toBe(true);
      expect(containsValue(range, "9:00")).toBe(true);
      expect(containsValue(range, "17:30")).toBe(false);
    }
    expect(containsValue('{"slot":"10:00-11:30"}', "11:30")).toBe(true);
    // Still not a time put together from two others' pieces.
    expect(containsValue("10:00-11:30", "10:30")).toBe(false);
  });

  test("both dates of an ISO interval are dates", () => {
    const interval = '{"window":"2025-04-01/2025-04-30"}';
    expect(containsValue(interval, "2025-04-01")).toBe(true);
    expect(containsValue(interval, "2025-04-30")).toBe(true);
    expect(containsValue(interval, "2025-04-03")).toBe(false);
    expect(containsValue("2025-04-01-2025-04-30", "2025-04-30")).toBe(true);
    // A date running on into a longer run is still no date.
    expect(extractNumbers("2025-04-03-1").includes("2025-04-03")).toBe(false);
    expect(extractNumbers("2025-04-012").includes("2025-04-01")).toBe(false);
  });

  test("a UTC offset is not a time of day", () => {
    for (const stamp of [
      "2025-04-03T09:00:00-05:00",
      "2025-04-03T09:00-05:00",
      "2025-04-03 09:00:00-05:00",
      "2025-04-03T09:00:00+05:30",
    ]) {
      expect(`${stamp} ${containsValue(stamp, "9:00")}`).toBe(`${stamp} true`);
      expect(`${stamp} ${containsValue(stamp, stamp.endsWith("30") ? "5:30" : "5:00")}`).toBe(
        `${stamp} false`,
      );
    }
    // A day's range after a date, no seconds, reads both ends.
    expect(containsValue("2025-04-03 10:00-11:30", "11:30")).toBe(true);
  });
});

describe("extractNumbers — a digit of any script is read (design §6.3, §0-B)", () => {
  const at = (...points: number[]): string => String.fromCodePoint(...points);
  test("fullwidth, Arabic-Indic, Devanagari and mathematical digits are values", () => {
    expect(
      extractNumbers(
        `The amount is ${at(0xff11)},${at(0xff12, 0xff18, 0xff14)}.${at(0xff16, 0xff10)} USD`,
      ),
    ).toEqual(["1284.6"]);
    expect(extractNumbers(at(0x0669, 0x0669, 0x0669, 0x066b, 0x0669, 0x0669))).toEqual(["999.99"]);
    expect(extractNumbers(`${at(0x0969, 0x0966)} days`)).toEqual(["30"]);
    expect(extractNumbers(`${at(0x1d7d1, 0x1d7ce)} days`)).toEqual(["30"]);
    // A misquoted total in another script is not contained in the result.
    expect(
      containsValue("1284.50", `${at(0xff11)},${at(0xff12, 0xff18, 0xff14)}.${at(0xff16, 0xff10)}`),
    ).toBe(false);
    expect(containsValue(`${at(0x0661, 0x0662, 0x0668, 0x0664, 0x066b, 0x0665)}`, "1,284.50")).toBe(
      true,
    );
    expect(normalizeNumber(at(0x0663, 0x0660))).toBe("30");
  });
});

describe("extractNumbers — linear in the text", () => {
  // A fetched page and a tool result reach the number layer on every gated
  // turn (design §10). The least of three runs, each timed against a text of
  // the same size whose numeral has no zeros, so a slow machine slows both.
  const fastest = (run: () => unknown): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      run();
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  const n = 200_000;
  const zeros = `Ref 1${"0".repeat(n)}7 is on file.`;
  const plain = `Ref 1${"2".repeat(n)}7 is on file.`;

  test("a run of zeros inside a numeral is read once", () => {
    // Trimming the trailing zeros with /0+$/ retried from every zero of the
    // run: "1" + 80,000 zeros + "1" took seconds, 200,000 would take minutes.
    expect(extractNumbers(zeros)).toEqual([`1.${"0".repeat(n)}7e${n + 1}`]);
    const base = fastest(() => extractNumbers(plain));
    expect(fastest(() => extractNumbers(zeros))).toBeLessThan(base * 20 + 100);
    expect(fastest(() => containsValue(zeros, "7"))).toBeLessThan(base * 20 + 100);
  }, 20_000);

  test("…and so is the figure rule, which keys every numeral of a source", () => {
    const claim = "The ref is on file.";
    const base = fastest(() => locateClaim(claim, plain, { coverage: 0.8 }));
    expect(locateClaim(claim, zeros, { coverage: 0.8 }).status).toBe("supported");
    expect(fastest(() => locateClaim(claim, zeros, { coverage: 0.8 }))).toBeLessThan(
      base * 20 + 100,
    );
  }, 20_000);
});

describe("normalizeNumber", () => {
  test("exactly one number, or null", () => {
    expect(normalizeNumber(" 1,284.50 ")).toBe("1284.5");
    expect(normalizeNumber("12%")).toBe("12");
    expect(normalizeNumber("v1.2.3")).toBeNull();
    expect(normalizeNumber("1 284")).toBeNull();
    expect(normalizeNumber("twelve")).toBeNull();
  });
});

describe("containsValue", () => {
  test("compares normalized decimals", () => {
    expect(containsValue("total: 1284.50", "1,284.5")).toBe(true);
    expect(containsValue("total: 1,284.50 USD", "1284.5")).toBe(true);
    expect(containsValue("total: 1284.05", "1284.5")).toBe(false);
    expect(containsValue("rate 12", "12%")).toBe(true);
    expect(containsValue("-3", "3")).toBe(false);
  });

  test("a value that is not one number is contained nowhere", () => {
    expect(containsValue("v1.2.3", "v1.2.3")).toBe(false);
    expect(containsValue("1 284", "1 284")).toBe(false);
  });

  test("a precomputed set answers the same", () => {
    const set = new Set(extractNumbers('{"total": 1284.5, "tax": 1e-7}'));
    expect(containsValue(set, "1,284.50")).toBe(true);
    expect(containsValue(set, "0.0000001")).toBe(true);
    expect(containsValue(set, "1284.05")).toBe(false);
  });
});

describe("figureWord", () => {
  test("cardinals name their value; ordinals and half are compared as spelled", () => {
    expect(figureWord("thirty")).toEqual({ key: "30", ordinal: false });
    expect(figureWord("dozen")).toEqual({ key: "12", ordinal: false });
    expect(figureWord("million")).toEqual({ key: "1000000", ordinal: false });
    expect(figureWord("third")).toEqual({ key: "third", ordinal: true });
    expect(figureWord("first")).toEqual({ key: "first", ordinal: true });
    expect(figureWord("half")).toEqual({ key: "half", ordinal: false });
  });

  test("not a figure: other words, a time unit, and anything not lowercase", () => {
    for (const word of ["refund", "second", "quarter", "Thirty", "thirtyfive", ""]) {
      expect(figureWord(word)).toBeNull();
    }
  });

  test("the checked rung's value layer reads digits only", () => {
    expect(extractNumbers("thirty days")).toEqual([]);
    expect(normalizeNumber("twelve")).toBeNull();
  });
});

describe("quotedSpans / containsQuote", () => {
  test("quotations of four or more words, each once, with their text", () => {
    expect(
      quotedSpans('He said "the refund window is 14 days" twice: “the refund window is 14 days”'),
    ).toEqual([
      {
        text: "the refund window is 14 days",
        tokens: ["the", "refund", "window", "is", "14", "days"],
      },
    ]);
    expect(quotedSpans('"too short"')).toEqual([]);
    expect(quotedSpans('"too short"', 2)).toHaveLength(1);
  });

  test("a quotation is contained word for word; punctuation does not matter", () => {
    const [span] = quotedSpans('"the refund window is 14 days"');
    expect(containsQuote("Policy: The refund-window is, 14 days.", span as never)).toBe(true);
    expect(containsQuote("The refund window is 30 days.", span as never)).toBe(false);
    expect(containsQuote("anything", [])).toBe(false);
    expect(containsQuote("one two three", ["two", "three"])).toBe(true);
  });
});
