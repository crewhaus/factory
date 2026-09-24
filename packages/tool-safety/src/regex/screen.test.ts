import { describe, expect, test } from "bun:test";
import { type RegexRejectCode, compileUserRegex, screenUserRegex } from "./screen";

/**
 * Every catastrophic pattern an audit finding reproduced, with the finding
 * that reproduced it. The screen must refuse each with the named reason —
 * these are the patterns that froze the event loop, and the ones on which
 * JavaScriptCore silently answered "no match".
 */
const FROM_FINDINGS: ReadonlyArray<{
  readonly finding: string;
  readonly pattern: string;
  readonly flags?: string;
  readonly code: RegexRejectCode;
}> = [
  { finding: "flag-truth-1#5", pattern: "^(a+)+$", code: "nested-quantifier" },
  { finding: "security-1#2", pattern: "(a+)+!$|x", code: "nested-quantifier" },
  { finding: "security-2#1", pattern: "(a+)+$", code: "nested-quantifier" },
  { finding: "security-6#6", pattern: "(=|=)*x|TARGET", code: "overlapping-alternation" },
  { finding: "security-6#6", pattern: "(\\w|\\d)*!|NEEDLE", code: "overlapping-alternation" },
  { finding: "security-6#6", pattern: "(\\w|\\d)*!|sk_live_\\w+", code: "overlapping-alternation" },
  { finding: "security-8#9", pattern: "(\\w{1,})*$", code: "nested-quantifier" },
  { finding: "security-8#9", pattern: "(a{1,})+$", code: "nested-quantifier" },
  { finding: "security-8#12", pattern: "^(\\w+\\s?)*$", code: "nested-quantifier" },
  { finding: "security-9#7", pattern: "^(a|a){1,99}$", code: "overlapping-alternation" },
  { finding: "security-9#7", pattern: "^(\\w|[a-zA-Z]){1,64}Z$", code: "overlapping-alternation" },
  { finding: "security-12#1", pattern: "^(a*)*b$|^a+!$", code: "nested-quantifier" },
  { finding: "security-12#1", pattern: "^(\\w+\\s?)*$", code: "nested-quantifier" },
  { finding: "flag-truth-2#6", pattern: "^(a|a)*$", code: "overlapping-alternation" },
  { finding: "security-5#20", pattern: "^(\\w+\\s?)+$", code: "nested-quantifier" },
];

/** Classic shapes beyond the findings' own reproductions. */
const CLASSIC: ReadonlyArray<{ pattern: string; flags?: string; code: RegexRejectCode }> = [
  { pattern: "(a*)*", code: "nested-quantifier" },
  { pattern: "(.*a){12}", code: "nested-quantifier" },
  { pattern: "(a?){30}a{30}", code: "nested-quantifier" },
  { pattern: "(x+x+)+y", code: "nested-quantifier" },
  { pattern: "((a+)+)+", code: "nested-quantifier" },
  { pattern: "(\\d+(,\\d+)*)*", code: "nested-quantifier" },
  { pattern: "(\\s+|\\w+)*", code: "nested-quantifier" },
  { pattern: "(?:a+)+", code: "nested-quantifier" },
  { pattern: "(a\\1)*", code: "nested-quantifier" },
  { pattern: "(a|b|ab)*c", code: "overlapping-alternation" },
  { pattern: "((a|a)b)*", code: "overlapping-alternation" },
  { pattern: "(a|)*", code: "overlapping-alternation" },
  { pattern: "(A|a)*", flags: "i", code: "overlapping-alternation" },
  // `ſ` folds to `s` only through upper-casing; the fold closure must see it.
  { pattern: "(\u017f|s)*", flags: "iu", code: "overlapping-alternation" },
  { pattern: "(k|\u212a)+", flags: "iu", code: "overlapping-alternation" },
  // An incomplete hex escape is the literal letter: `\x1` is "x1", so both
  // branches start with "x".
  { pattern: "(\\x1|x)*", code: "overlapping-alternation" },
  { pattern: "(\\u12|u)*", code: "overlapping-alternation" },
];

/**
 * Patterns a caller actually writes, including nested repetition that is
 * safe because something fixes where each repetition ends. Refusing these
 * would make the tools useless.
 */
const ACCEPTED: ReadonlyArray<{ pattern: string; flags?: string }> = [
  { pattern: "(\\w+\\.)+\\w+" },
  { pattern: "(\\d{1,3}\\.){3}\\d{1,3}" },
  { pattern: "(?:\\r?\\n)+" },
  { pattern: "(<[^>]*>)*" },
  { pattern: "(\\s*,\\s*\\w+)*" },
  { pattern: '("[^"]*",?)*' },
  { pattern: "(a|b)*" },
  { pattern: "(foo|bar)+" },
  { pattern: "(A|a)*" },
  { pattern: "^[a-z]+$" },
  { pattern: "\\s+$" },
  { pattern: "Listening on (\\d+)" },
  { pattern: "(ready|listening)" },
  { pattern: "^get[A-Z]\\w*" },
  { pattern: "^::([a-z]+)(?:\\s+[^:]*)?::(.*)$" },
  { pattern: "(?<year>\\d{4})-(?<month>\\d\\d)" },
  { pattern: "\\p{L}+", flags: "u" },
  { pattern: "[\\p{L}--[a-z]]+", flags: "v" },
  { pattern: "(ab){1000}" },
  { pattern: "[]" },
  { pattern: "[^]" },
  { pattern: "\\u{1F600}+", flags: "u" },
  { pattern: "[\\d-z]+" },
  { pattern: "\\k<n>(?<n>a)" },
  { pattern: "x{" },
  { pattern: "\\cJ" },
  { pattern: "(?=(a+))" },
  { pattern: "(?<=\\$)\\d+(\\.\\d\\d)?" },
];

describe("the shape screen", () => {
  test("refuses every catastrophic pattern the audit reproduced, with the named reason", () => {
    const refused: string[] = [];
    for (const { finding, pattern, flags, code } of FROM_FINDINGS) {
      const result = screenUserRegex(pattern, flags ?? "");
      expect({ finding, pattern, result: result.ok ? "accepted" : result.code }).toEqual({
        finding,
        pattern,
        result: code,
      });
      if (!result.ok) refused.push(finding);
    }
    // The guard's hit count: every row was looked at and refused, and the
    // rows cover the findings they claim to.
    expect(refused.length).toBe(FROM_FINDINGS.length);
    expect(new Set(refused)).toEqual(
      new Set([
        "flag-truth-1#5",
        "security-1#2",
        "security-2#1",
        "security-6#6",
        "security-8#9",
        "security-8#12",
        "security-9#7",
        "security-12#1",
        "flag-truth-2#6",
        "security-5#20",
      ]),
    );
  });

  test("refuses the classic shapes, including ones that only overlap under case folding", () => {
    let refused = 0;
    for (const { pattern, flags, code } of CLASSIC) {
      const result = screenUserRegex(pattern, flags ?? "");
      expect({ pattern, flags, result: result.ok ? "accepted" : result.code }).toEqual({
        pattern,
        flags,
        result: code,
      });
      refused += result.ok ? 0 : 1;
    }
    expect(refused).toBe(CLASSIC.length);
  });

  test("accepts the patterns callers write, including safely delimited nesting", () => {
    let accepted = 0;
    for (const { pattern, flags } of ACCEPTED) {
      const result = screenUserRegex(pattern, flags ?? "");
      expect({
        pattern,
        result: result.ok ? "accepted" : `${result.code}: ${result.reason}`,
      }).toEqual({ pattern, result: "accepted" });
      accepted += result.ok ? 1 : 0;
    }
    expect(accepted).toBe(ACCEPTED.length);
  });

  test("names the offending group and says how to rewrite it", () => {
    const result = screenUserRegex("^start (\\w+\\s?)+ end$");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fragment).toBe("(\\w+\\s?)+");
    expect(result.reason).toContain("(\\w+\\s?)+");
    expect(result.reason).toContain("exponential");
  });

  test("an inline case-insensitive group folds the whole pattern, which only refuses more", () => {
    let modifiersSupported = true;
    try {
      /(?i:a)/;
    } catch {
      modifiersSupported = false;
    }
    if (!modifiersSupported) return;
    expect(screenUserRegex("(A|a)*(?i:x)").ok).toBe(false);
    expect(screenUserRegex("(A|a)*x").ok).toBe(true);
  });
});

describe("compileUserRegex and screenUserRegex", () => {
  test("a long pattern is refused before it is compiled", () => {
    const result = compileUserRegex("a".repeat(1001));
    expect(result.ok ? "ok" : result.code).toBe("pattern-too-long");
    expect(compileUserRegex("a".repeat(20), "", { maxPatternChars: 10 }).ok).toBe(false);
    expect(compileUserRegex("a".repeat(10), "", { maxPatternChars: 10 }).ok).toBe(true);
  });

  test("flags: unknown and repeated are invalid; a real flag outside the policy is not allowed", () => {
    const code = (flags: string, allowedFlags?: string): string => {
      const r = compileUserRegex("a", flags, allowedFlags === undefined ? {} : { allowedFlags });
      return r.ok ? "ok" : r.code;
    };
    expect(code("q")).toBe("invalid-flags");
    expect(code("gg")).toBe("invalid-flags");
    expect(code("y", "gim")).toBe("flag-not-allowed");
    expect(code("gi", "gim")).toBe("ok");
    expect(code("dgimsuy")).toBe("ok");
  });

  test("a pattern the engine rejects is invalid-syntax with the engine's message", () => {
    const result = compileUserRegex("(unclosed");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("invalid-syntax");
    expect(result.reason.length).toBeGreaterThan("the pattern is not a valid".length);
  });

  test("a non-string is refused, not thrown", () => {
    expect(compileUserRegex(42 as unknown as string).ok).toBe(false);
    expect(compileUserRegex("a", 7 as unknown as string).ok).toBe(false);
  });

  test("an accepted pattern compiles to the RegExp the caller asked for", () => {
    const result = compileUserRegex("b(\\d)", "gi");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.regex.source).toBe("b(\\d)");
    expect(result.regex.flags).toBe("gi");
    expect("aB1b2".match(result.regex)).toEqual(["B1", "b2"]);
  });

  test("screenUserRegex answers with the same codes and reasons as compileUserRegex", () => {
    const all = [...FROM_FINDINGS, ...CLASSIC, ...ACCEPTED, { pattern: "(", flags: "" }];
    for (const { pattern, flags } of all) {
      const compiled = compileUserRegex(pattern, flags ?? "");
      const screened = screenUserRegex(pattern, flags ?? "");
      expect(screened.ok).toBe(compiled.ok);
      if (!compiled.ok && !screened.ok) {
        expect(screened.code).toBe(compiled.code);
        expect(screened.reason).toBe(compiled.reason);
      }
    }
  });
});
