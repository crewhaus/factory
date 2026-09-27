/**
 * RegexExtract and RuleClassify never run a caller's pattern on the caller's
 * thread, and a run that could not finish is never "no match".
 *
 * 0.7.0 ran both with a synchronous `RegExp` (C073): RegexExtract with
 * `a*a*a*a*b` held the whole process 3.5 s over 200 characters and 108 s
 * over 400, and when the engine gave up on a pattern it answered "no
 * match", so RegexExtract reported count 0 and RuleClassify fell back to its
 * default label.
 */
import { describe, expect, test } from "bun:test";
import { regexExtract, ruleClassify } from "./index";

type Tool = typeof regexExtract;

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
async function call(tool: Tool, input: unknown): Promise<any> {
  const out = await tool.execute(tool.inputSchema.parse(input) as never, {} as never);
  try {
    return JSON.parse(out as string);
  } catch {
    return out;
  }
}

/** How many times a 5 ms timer fired while `body` ran: 0 means the thread was held. */
async function ticksDuring<T>(body: () => Promise<T>): Promise<{ result: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 5);
  try {
    return { result: await body(), ticks };
  } finally {
    clearInterval(timer);
  }
}

/** ~0.3 s of backtracking; polynomial, so the screen lets it through. */
const SLOW = { pattern: "a*a*a*a*b", text: "a".repeat(120) };

describe("RegexExtract", () => {
  test("the match runs off the caller's thread, and a give-up is not a count of 0", async () => {
    const { result, ticks } = await ticksDuring(() =>
      call(regexExtract, { text: SLOW.text, pattern: SLOW.pattern }),
    );
    expect(ticks).toBeGreaterThan(0);
    expect(result).toMatchObject({ count: 0, truncated: true });
    expect(result.undetermined).toMatch(/could not be run to the end of the text/);
  }, 20_000);

  test("a pattern that backtracks exponentially is refused with the reason", async () => {
    const out = await call(regexExtract, { text: `${"a".repeat(30)}!x`, pattern: "(a+)+!$|x" });
    expect(out).toMatch(/^invalid regex \/\(a\+\)\+!\$\|x\/: /);
  });

  test("ordinary extraction answers as before, and says what cut it short", async () => {
    const out = await call(regexExtract, {
      text: "id=7\nid=42",
      pattern: "id=(?<n>\\d+)",
      maxMatches: 1,
    });
    expect(out).toEqual({
      count: 1,
      truncated: true,
      truncatedBy: "maxMatches",
      matches: [
        { match: "id=7", index: 0, line: 1, column: 1, groups: { n: "7" }, captures: ["7"] },
      ],
    });
  });
});

describe("RuleClassify", () => {
  test("a regex rule with no answer gives no label, not the default", async () => {
    const { result, ticks } = await ticksDuring(() =>
      call(ruleClassify as Tool, {
        text: SLOW.text,
        rules: [
          { label: "slow", patterns: [SLOW.pattern], regex: true, weight: 5 },
          { label: "a", patterns: ["aaa"] },
        ],
        defaultLabel: "other",
      }),
    );
    expect(ticks).toBeGreaterThan(0);
    // 0.7.0: label "a", as if the slow rule had not matched.
    expect(result.label).toBeNull();
    expect(result.undetermined).toEqual([
      { pattern: SLOW.pattern, reason: expect.stringMatching(/gave up/) },
    ]);
  }, 20_000);

  test("answered regex rules still score, and a refused one is an invalid rule", async () => {
    const out = await call(ruleClassify as Tool, {
      text: "order ORD-42 is late",
      rules: [
        { label: "id", patterns: ["ord-\\d+"], regex: true },
        { label: "late", patterns: ["late"] },
      ],
    });
    expect(out).toMatchObject({ label: "id", score: 1, matched: ["ord-\\d+", "late"] });
    const bad = await call(ruleClassify as Tool, {
      text: "x",
      rules: [{ label: "a", patterns: ["(\\w+\\s?)+$"], regex: true }],
    });
    expect(bad).toMatch(/^invalid rule pattern: \/\(\\w\+\\s\?\)\+\$\/: /);
  });
});
