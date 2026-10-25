import { describe, expect, test } from "bun:test";
import { messageText } from "./messages";
import {
  MIN_CLAIM_TOKENS,
  claimSentences,
  isQuestion,
  sentences,
  splitSentences,
} from "./sentences";
import { STOPWORDS, contentTokens, coverage } from "./tokens";

describe("contentTokens / coverage — the graders' measure, pinned", () => {
  test("lowercased ASCII alphanumeric runs of three or more, stopwords dropped", () => {
    expect([...contentTokens("The Refund window isn't 30 days for EU customers!")]).toEqual([
      "refund",
      "window",
      "isn",
      "days",
      "customers",
    ]);
    expect(STOPWORDS.has("not")).toBe(true);
    expect(contentTokens("café 1,284.50").has("284")).toBe(true);
  });

  test("coverage is the fraction of the needle in the haystack, 0 for an empty needle", () => {
    const need = contentTokens("refund window days");
    expect(coverage(need, contentTokens("the refund window"))).toBeCloseTo(2 / 3);
    expect(coverage(new Set(), contentTokens("anything"))).toBe(0);
  });
});

describe("the two splitters", () => {
  test("sentences: per line, after terminal punctuation, terminator kept", () => {
    expect(sentences("One. Two? Three!\nFour\n\n  Five.  ")).toEqual([
      "One.",
      "Two?",
      "Three!",
      "Four",
      "Five.",
    ]);
    expect(isQuestion("Is it?  ")).toBe(true);
    expect(isQuestion("It is.")).toBe(false);
  });

  test("splitSentences: offsets that tile the text, Markdown-aware", () => {
    const text = "# Title\nFirst e.g. this. Second J. Smith said!\n- item one\n\nPara.";
    const ranges = splitSentences(text);
    expect(ranges[0]?.start).toBe(0);
    expect(ranges[ranges.length - 1]?.end).toBe(text.length);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]?.start).toBe(ranges[i - 1]?.end);
    }
    // Ranges tile the text, so the whitespace between two sentences is a range too.
    const said = ranges.map(({ start, end }) => text.slice(start, end).trim());
    expect(said.filter((s) => s !== "")).toEqual([
      "# Title",
      "First e.g. this.",
      "Second J. Smith said!",
      "- item one",
      "Para.",
    ]);
  });

  test("claimSentences: the faithfulness extractor", () => {
    expect(MIN_CLAIM_TOKENS).toBe(3);
    expect(
      claimSentences(
        "Done. Revenue rose sharply this quarter. Did costs fall? Margins held up well.",
      ),
    ).toEqual(["Revenue rose sharply this quarter.", "Margins held up well."]);
  });
});

describe("messageText", () => {
  test("string content, text blocks joined, and the nulls", () => {
    expect(messageText({ content: "hello" })).toBe("hello");
    expect(
      messageText({
        content: [
          { type: "text", text: "a" },
          { type: "tool_result", content: "x" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\nb");
    expect(messageText({ content: "hi", synthetic: true })).toBeNull();
    expect(messageText({ content: [{ type: "tool_result", content: "x" }] })).toBeNull();
    expect(messageText({ content: "   " })).toBeNull();
    expect(messageText(null)).toBeNull();
    expect(messageText("text")).toBeNull();
  });
});
