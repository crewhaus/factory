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
 * Exponential although each repetition is delimited. The screen used to
 * accept the first two: a delimiter fixes where a repetition ENDS, but two
 * varying parts that can trade characters (`\d+\d*`), or two branches that
 * can match the same text, still give each repetition several parses, and
 * the parses multiply. Measured on Bun 1.3.14, `^(?:,\d+\d*)*$` on
 * `",12"` x 25 + `"!"` took 3.4 s, and at x 40 JavaScriptCore gave up.
 */
const DELIMITED_BUT_AMBIGUOUS: ReadonlyArray<{ pattern: string; code: RegexRejectCode }> = [
  { pattern: "^(?:,\\d+\\d*)*$", code: "nested-quantifier" },
  { pattern: "^(?:,\\d+x?\\d*)*$", code: "nested-quantifier" },
  { pattern: "^(?:\\.(?:a|a))*$", code: "overlapping-alternation" },
  { pattern: "^(?:\\.(?:ab|a[bc]))*$", code: "overlapping-alternation" },
  { pattern: "^(?:,(?:a|ab)b?)*$", code: "overlapping-alternation" },
  // A bounded repetition is exempt only while the ways through it stay few:
  // 2^11 is past the limit, and exemptions do not compound.
  { pattern: "^(?:a|a){11}$", code: "overlapping-alternation" },
  { pattern: "^(?:(?:a|a){10}){10}$", code: "overlapping-alternation" },
  // A `v`-mode class that can match a string is varying-length text.
  { pattern: "(?:[\\q{ab}]|a)*", code: "overlapping-alternation" },
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

/**
 * Common validation patterns the screen used to refuse, although each runs
 * in milliseconds on adversarial input: the review found these, and the
 * adoption recipe puts the screen in front of operator rules that use them.
 */
const MUST_ACCEPT: ReadonlyArray<{ label: string; pattern: string; flags?: string }> = [
  {
    label: "IPv4, canonical (a small bounded repetition)",
    pattern:
      "^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$",
  },
  {
    label: "IPv4, short",
    pattern: "^((25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1?\\d?\\d)$",
  },
  {
    label: "semver.org's official regex",
    pattern:
      "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$",
  },
  {
    label: "a cron field",
    pattern:
      "^(\\*|([0-9]|[1-5][0-9])(-([0-9]|[1-5][0-9]))?)(,(\\*|([0-9]|[1-5][0-9])(-([0-9]|[1-5][0-9]))?))*$",
  },
  {
    label: "hyphenated Unicode words",
    pattern: "^[\\p{L}\\p{N}]+(?:-[\\p{L}\\p{N}]+)*$",
    flags: "u",
  },
  { label: "Title Case words", pattern: "^\\p{Lu}[\\p{Ll}]+(?: \\p{Lu}[\\p{Ll}]+)*$", flags: "u" },
  { label: "a personal name", pattern: "^\\p{L}+(?:[ '-]\\p{L}+)*$", flags: "u" },
  { label: "emoji and spaces", pattern: "^(?:\\p{Emoji}|\\s)+$", flags: "u" },
  { label: "a v-mode class", pattern: "^[\\p{L}--[a-z]]+(?:-[\\p{L}--[a-z]]+)*$", flags: "v" },
  { label: "branches that differ at a fixed position", pattern: "^(?:ab|ac){2}$" },
  {
    label: "branches of different fixed lengths",
    pattern: "^(?:[0-9]|[1-9][0-9])(?:\\.(?:[0-9]|[1-9][0-9])){3}$",
  },
  {
    label: "the HTML5 e-mail regex",
    pattern:
      "^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$",
  },
  { label: "a CSV field", pattern: '("([^"]|"")*"|[^,]*)(,|$)', flags: "g" },
  { label: "digits then letters, undelimited", pattern: "^(?:\\d+[a-z]+)*$" },
  {
    label: "a domain",
    pattern: "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$",
    flags: "i",
  },
  { label: "keywords repeated", pattern: "(?:foo|bar|baz)+" },
  {
    label: "a base64 blob",
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
  },
  { label: "a credit-card number", pattern: "\\b(?:\\d[ -]*?){13,16}\\b" },
  { label: "a quoted string with escapes", pattern: '"(?:[^"\\\\]|\\\\.)*"', flags: "g" },
  { label: "a MAC address", pattern: "^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$" },
  { label: "IPv6, simple", pattern: "^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$" },
  { label: "a path", pattern: "^(?:[^/]+/)*[^/]+\\.ts$" },
  { label: "env lines", pattern: "^(?:[A-Z_]+=.*\\n)+" },
  { label: "a comma list", pattern: "^(\\w+)(,\\s*\\w+)*$" },
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

  test("refuses a delimited repetition that can still parse one repetition several ways", () => {
    let refused = 0;
    for (const { pattern, code } of DELIMITED_BUT_AMBIGUOUS) {
      const flags = pattern.includes("\\q{") ? "v" : "";
      const result = screenUserRegex(pattern, flags);
      expect({ pattern, result: result.ok ? "accepted" : result.code }).toEqual({
        pattern,
        result: code,
      });
      refused += result.ok ? 0 : 1;
    }
    expect(refused).toBe(DELIMITED_BUT_AMBIGUOUS.length);
    // The boundary of the bounded exemption: 2^10 ways is still accepted.
    expect(screenUserRegex("^(?:a|a){10}$").ok).toBe(true);
  });

  test("accepts the common validation patterns it used to refuse", () => {
    let accepted = 0;
    for (const { label, pattern, flags } of MUST_ACCEPT) {
      const result = screenUserRegex(pattern, flags ?? "");
      expect({
        label,
        result: result.ok ? "accepted" : `${result.code}: ${result.fragment}`,
      }).toEqual({ label, result: "accepted" });
      accepted += result.ok ? 1 : 0;
    }
    expect(accepted).toBe(MUST_ACCEPT.length);
  });

  test("a property escape is modelled from what the engine matches, so a literal inside it overlaps", () => {
    // `a` is a letter, so these branches overlap; `-` is not, so it delimits.
    expect(screenUserRegex("(?:\\p{L}|a)*", "u")).toMatchObject({
      ok: false,
      code: "overlapping-alternation",
    });
    expect(screenUserRegex("(?:\\p{L}|-)*", "u").ok).toBe(true);
    expect(screenUserRegex("(?:\\P{L}|-)*", "u")).toMatchObject({ ok: false });
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

describe("the screen's own cost", () => {
  test("is bounded by a work budget, and running out refuses the pattern as unanalysable", () => {
    const pattern = "(?:x+,)*".repeat(40);
    expect(screenUserRegex(pattern).ok).toBe(true);
    const starved = screenUserRegex(pattern, "", { maxScreenWork: 50 });
    expect(starved).toMatchObject({ ok: false, code: "unanalysable" });
    if (!starved.ok) expect(starved.reason).toContain("work budget");
  });

  test("property escapes and set operations inside classes are charged before the engine compiles them", () => {
    // Each `--`/`&&` over a property costs the engine 1-3.5 ms to compile.
    const heavy = "[\\p{Any}&&\\p{L}]".repeat(6);
    const refused = screenUserRegex(heavy, "v");
    expect(refused).toMatchObject({ ok: false, code: "unanalysable" });
    if (!refused.ok) expect(refused.reason).toContain("slow to compile");
    expect(screenUserRegex("[\\p{Any}&&\\p{L}]+", "v").ok).toBe(true);
    expect(screenUserRegex("[\\p{L}\\p{N}]+".repeat(20), "u").ok).toBe(true);
  });

  test("stays small for the patterns that made it take seconds under the i flag", () => {
    // Before the fold index these took 0.4-4.4 s each, on the caller's thread.
    let tower = "x";
    let cp = 0x100;
    while (tower.length + 8 < 1000) {
      tower = `(?:${tower})+${String.fromCodePoint(cp)}|${String.fromCodePoint(cp + 1)}`;
      cp += 4;
    }
    const cases: Array<[string, string]> = [
      ["abcdefghij".repeat(100), "i"],
      [Array.from({ length: 250 }, () => "a|b").join("|"), "i"],
      ["[a-z0-9]".repeat(120), "i"],
      [tower, "i"],
    ];
    for (const [pattern, flags] of cases) {
      // A fresh prefix keeps the verdict cache from answering.
      const fresh = `(?:q${Math.random().toString(36).slice(2)})?${pattern}`.slice(0, 1000);
      const started = performance.now();
      screenUserRegex(fresh, flags);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  test("remembers verdicts per pattern, flags and limits", () => {
    const pattern = "(a+)+b";
    const first = screenUserRegex(pattern);
    expect(screenUserRegex(pattern)).toEqual(first);
    // The same text under other limits or flags is screened on its own terms.
    expect(screenUserRegex(pattern, "", { maxPatternChars: 3 })).toMatchObject({
      ok: false,
      code: "pattern-too-long",
    });
    expect(screenUserRegex(pattern, "y", { allowedFlags: "g" })).toMatchObject({
      ok: false,
      code: "flag-not-allowed",
    });
    expect(screenUserRegex(pattern)).toEqual(first);
    // A compiled RegExp is a new object every time, never a shared one.
    const a = compileUserRegex("x", "g");
    const b = compileUserRegex("x", "g");
    expect(a.ok && b.ok && a.regex !== b.regex).toBe(true);
  });
});
