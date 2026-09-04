/**
 * Rule-directed routing (§7.2.2): first match, AND semantics, disabled rules,
 * the three `message_matches` guards, and the derived-only signal record.
 */
import { describe, expect, test } from "bun:test";
import { deriveSignalRecord, evaluateRules, validateRuleRegex } from "./rules";
import type { RouteRule, RouteSignals } from "./types";

const BASE: RouteSignals = {
  contextTokens: 1000,
  toolsInPlay: false,
  turnIndex: 3,
  priorTurnToolUseCount: 0,
};

const RULES: RouteRule[] = [
  { id: "images-need-vision", when: { has_images: true }, use: { requires: { vision: true } } },
  {
    id: "code-goes-strong",
    when: { message_matches: "(?i)\\b(refactor|stack ?trace)\\b" },
    use: "strong",
    enabled: true,
  },
  { id: "cheap-when-broke", when: { budget_spent_ratio_gt: 0.8 }, use: "cheap" },
  { id: "off", when: { turn_index_lt: 100 }, use: "$never", enabled: false },
];

describe("evaluateRules", () => {
  test("no signals match → no match, nothing skipped", () => {
    const r = evaluateRules(RULES, { ...BASE, userText: "where is my order" });
    expect(r.match).toBeUndefined();
    expect(r.skipped).toEqual([]);
  });

  test("first match wins in declared order and carries the use target", () => {
    const r = evaluateRules(RULES, {
      ...BASE,
      hasImages: true,
      userText: "please refactor this",
      budgetSpentRatio: 0.9,
    });
    expect(r.match?.ruleId).toBe("images-need-vision");
    expect(r.match?.index).toBe(0);
    expect(r.match?.use).toEqual({ requires: { vision: true } });
  });

  test("message_matches honours a leading (?i) and word boundaries", () => {
    expect(
      evaluateRules(RULES, { ...BASE, userText: "Here is the Stack Trace" }).match?.ruleId,
    ).toBe("code-goes-strong");
    expect(evaluateRules(RULES, { ...BASE, userText: "refactoring" }).match).toBeUndefined();
  });

  test("a disabled rule never matches", () => {
    const r = evaluateRules(RULES, { ...BASE, budgetSpentRatio: 0.81 });
    expect(r.match?.ruleId).toBe("cheap-when-broke");
    expect(evaluateRules([RULES[3] as RouteRule], BASE).match).toBeUndefined();
  });

  test("every condition in one when: must hold (AND)", () => {
    const rule: RouteRule = {
      id: "both",
      when: { tool_in_play: true, context_tokens_gt: 500 },
      use: "strong",
    };
    expect(evaluateRules([rule], { ...BASE, toolsInPlay: true }).match?.ruleId).toBe("both");
    expect(evaluateRules([rule], { ...BASE, toolsInPlay: false }).match).toBeUndefined();
    expect(
      evaluateRules([rule], { ...BASE, toolsInPlay: true, contextTokens: 100 }).match,
    ).toBeUndefined();
  });

  test("channel, user_text_chars_gt and turn_index_lt", () => {
    const rules: RouteRule[] = [
      { id: "slack", when: { channel: "#support" }, use: "cheap" },
      { id: "long", when: { user_text_chars_gt: 10 }, use: "strong" },
      { id: "opening", when: { turn_index_lt: 1 }, use: "strong" },
    ];
    expect(evaluateRules(rules, { ...BASE, channelHint: "#support" }).match?.ruleId).toBe("slack");
    expect(evaluateRules(rules, { ...BASE, userTextChars: 11 }).match?.ruleId).toBe("long");
    expect(evaluateRules(rules, { ...BASE, userText: "x".repeat(11) }).match?.ruleId).toBe("long");
    expect(evaluateRules(rules, { ...BASE, turnIndex: 0 }).match?.ruleId).toBe("opening");
    expect(evaluateRules(rules, BASE).match).toBeUndefined();
  });

  test("guard 1 — an invalid regex is skipped with a reason, not thrown", () => {
    const rules: RouteRule[] = [
      { id: "evil", when: { message_matches: "(a+)+$" }, use: "strong" },
      { id: "broken", when: { message_matches: "(" }, use: "strong" },
      { id: "ok", when: { message_matches: "hello" }, use: "cheap" },
    ];
    const r = evaluateRules(rules, { ...BASE, userText: "hello" });
    expect(r.match?.ruleId).toBe("ok");
    expect(r.skipped).toEqual([
      { ruleId: "evil", reason: "rule_skipped:invalid-regex" },
      { ruleId: "broken", reason: "rule_skipped:invalid-regex" },
    ]);
  });

  test("guard 1 — a polynomial pattern is rejected before it runs; an accepted one completes on 1024 adversarial chars", () => {
    const rules: RouteRule[] = [
      { id: "poly", when: { message_matches: "^.*a.*a.*X$" }, use: "strong" },
      { id: "ok", when: { message_matches: ".*X" }, use: "cheap" },
    ];
    // Assert on the verdict, never on timing: the adversarial text has no X,
    // so the one accepted wildcard must run to a clean miss.
    const miss = evaluateRules(rules, { ...BASE, userText: "a".repeat(1024) });
    expect(miss.match).toBeUndefined();
    expect(miss.skipped).toEqual([{ ruleId: "poly", reason: "rule_skipped:invalid-regex" }]);
    const hit = evaluateRules(rules, { ...BASE, userText: `${"a".repeat(1000)}X` });
    expect(hit.match?.ruleId).toBe("ok");
  });

  test("guard 2 — the text is length-capped before matching (default 1024)", () => {
    const rules: RouteRule[] = [
      { id: "tail", when: { message_matches: "NEEDLE$" }, use: "strong" },
    ];
    const text = `${"x".repeat(100)}NEEDLE`;
    expect(evaluateRules(rules, { ...BASE, userText: text }).match?.ruleId).toBe("tail");
    expect(
      evaluateRules(rules, { ...BASE, userText: text }, { maxTextChars: 50 }).match,
    ).toBeUndefined();
    // The default cap: a needle ending exactly at 1024 is seen, one past it is cut.
    const fits = `${"x".repeat(1024 - "NEEDLE".length)}NEEDLE`;
    expect(evaluateRules(rules, { ...BASE, userText: fits }).match?.ruleId).toBe("tail");
    expect(evaluateRules(rules, { ...BASE, userText: `x${fits}` }).match).toBeUndefined();
  });

  test("guard 3 — once the time budget is spent, later text rules are skipped (injected clock)", () => {
    const rules: RouteRule[] = [
      { id: "first", when: { message_matches: "nomatch" }, use: "strong" },
      { id: "second", when: { message_matches: "hello" }, use: "cheap" },
      { id: "no-text", when: { turn_index_lt: 10 }, use: "strong" },
    ];
    let t = 0;
    // Each `now()` call advances 100 ms, so the first regex alone exceeds a 25 ms budget.
    const now = (): number => {
      t += 100;
      return t;
    };
    const r = evaluateRules(rules, { ...BASE, userText: "hello" }, { now });
    expect(r.skipped).toEqual([{ ruleId: "second", reason: "rule_skipped:time-budget" }]);
    // Rules that do not read the text keep evaluating.
    expect(r.match?.ruleId).toBe("no-text");
  });
});

describe("validateRuleRegex", () => {
  test("accepts ordinary patterns, leading inline flags and non-capturing groups", () => {
    expect(validateRuleRegex("\\b(refactor|stack ?trace)\\b")).toBeUndefined();
    expect(validateRuleRegex("(?i)\\bhello\\b")).toBeUndefined();
    expect(validateRuleRegex("(?:ab)+c")).toBeUndefined();
    expect(validateRuleRegex("(?<word>ab)+")).toBeUndefined();
    expect(validateRuleRegex("(a+)?b")).toBeUndefined();
    expect(validateRuleRegex("[+*]+")).toBeUndefined();
    expect(validateRuleRegex("a\\++")).toBeUndefined();
  });

  test("accepts one unbounded quantifier alongside bounded ones, lazy modifiers and exact counts", () => {
    expect(validateRuleRegex("\\berror\\b.*\\bstack\\b")).toBeUndefined();
    expect(validateRuleRegex("https?://\\S+")).toBeUndefined();
    expect(validateRuleRegex("\\d{3}-\\d{4}")).toBeUndefined();
    expect(validateRuleRegex("a+?b")).toBeUndefined();
    expect(validateRuleRegex("colou?r|flavou?r|neighbou?r")).toBeUndefined();
    // A `{` that is not a well-formed quantifier is a literal, as it is to the engine.
    expect(validateRuleRegex("a{b.*")).toBeUndefined();
    // Exactly the cap: 12 optional groups, and lazy `??` does not count twice.
    expect(validateRuleRegex(`${"(?:a|b)?".repeat(12)}c`)).toBeUndefined();
    expect(validateRuleRegex(`${"(?:a|b)??".repeat(12)}c`)).toBeUndefined();
  });

  test("rejects two or more unbounded quantifiers — the polynomial shape, wildcard or not", () => {
    expect(validateRuleRegex("^.*a.*X$")).toMatch(/2 unbounded quantifiers/);
    expect(validateRuleRegex("^.*a.*a.*a.*X$")).toMatch(/4 unbounded quantifiers/);
    expect(validateRuleRegex("a+a+a+X")).toMatch(/unbounded quantifiers/);
    expect(validateRuleRegex("a+.*X")).toMatch(/unbounded quantifiers/);
    expect(validateRuleRegex("[ab]+b+X")).toMatch(/unbounded quantifiers/);
    expect(validateRuleRegex(".{0,600}.{0,600}X")).toMatch(/unbounded quantifiers/);
    expect(validateRuleRegex("\\w{2,}\\s*")).toMatch(/unbounded quantifiers/);
    // A documented false rejection: disjoint atoms would have been linear,
    // but the validator does not do overlap analysis.
    expect(validateRuleRegex("\\w+\\s+\\w+")).toMatch(/unbounded quantifiers/);
  });

  test("rejects more than 12 quantifiers of any kind — the optional-chain shape", () => {
    expect(validateRuleRegex(`${"(?:a|b)?".repeat(13)}c`)).toMatch(/13 quantifiers — at most 12/);
    expect(validateRuleRegex(`${"a?".repeat(20)}a{20}`)).toMatch(/quantifiers — at most 12/);
  });

  test("rejects nested quantifiers and alternation under a quantifier", () => {
    expect(validateRuleRegex("(a+)+")).toMatch(/nested quantifier/);
    expect(validateRuleRegex("(a*)*")).toMatch(/nested quantifier/);
    expect(validateRuleRegex("(a+)*")).toMatch(/nested quantifier/);
    expect(validateRuleRegex("(a|aa)+")).toMatch(/nested quantifier/);
    expect(validateRuleRegex("((ab)+c)*")).toMatch(/nested quantifier/);
    expect(validateRuleRegex("(a+){2,}")).toMatch(/nested quantifier/);
  });

  test("rejects patterns that do not compile or are too long", () => {
    expect(validateRuleRegex("(")).toMatch(/does not compile/);
    expect(validateRuleRegex("a".repeat(513))).toMatch(/longer than 512/);
  });
});

describe("deriveSignalRecord", () => {
  test("carries derived values only — never the text", () => {
    const rec = deriveSignalRecord({
      ...BASE,
      userText: "my SSN is secret",
      hasImages: false,
      toolNamesLastTurn: ["Read"],
      budgetSpentRatio: 0.2,
      channelHint: "#x",
    });
    expect(JSON.stringify(rec)).not.toContain("secret");
    expect(rec.userTextChars).toBe("my SSN is secret".length);
    expect(rec.userTextHash).toMatch(/^[0-9a-f]{16}$/);
    expect(rec.toolNamesLastTurn).toEqual(["Read"]);
    expect(rec.channelHint).toBe("#x");
    expect(Object.keys(rec)).not.toContain("userText");
  });

  test("absent optional signals stay absent", () => {
    expect(deriveSignalRecord(BASE)).toEqual(BASE);
  });
});
