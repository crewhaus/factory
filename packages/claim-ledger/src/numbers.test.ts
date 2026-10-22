import { describe, expect, test } from "bun:test";
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
    expect(extractNumbers("2024-01-15")).toEqual(["2024", "1", "15"]);
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
