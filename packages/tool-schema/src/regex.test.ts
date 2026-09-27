/**
 * Caller patterns never run on the caller's thread, and an unanswered one is
 * never "no match".
 *
 * 0.7.0 ran every `matches`/`notMatches` check and every schema `pattern`
 * with `new RegExp(...).test(...)` on the main thread. A polynomial pattern
 * held the whole process (`a*a*a*a*b` over 400 characters: 108 s), and when
 * JavaScriptCore gave up on an exponential one it returned "no match", so
 * `notMatches` passed a value it should have stopped and `not: {pattern}`
 * called a forbidden value valid (C073, C089).
 */
import { describe, expect, test } from "bun:test";
import { assert, jsonSchemaValidate, validateRecords } from "./index";
import { runChecks } from "./lib/assert";
import { checkSchemaShape, validateValue } from "./lib/jsonschema";
import {
  RegexAnswers,
  SYNC_PATTERN_MAX_INPUT_CHARS,
  testPatternSync,
  withRegexAnswers,
} from "./lib/regex-answers";

type Tool = {
  inputSchema: { parse: (v: unknown) => unknown };
  execute: (input: never, ctx?: unknown) => Promise<unknown>;
};

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
async function call(tool: Tool, input: unknown): Promise<any> {
  const out = await tool.execute(tool.inputSchema.parse(input) as never, {});
  return JSON.parse(out as string);
}

/** How many times a 5 ms timer fired while `body` ran: 0 means the thread was held. */
async function ticksDuring<T>(body: () => Promise<T>): Promise<{ result: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 5);
  try {
    const result = await body();
    return { result, ticks };
  } finally {
    clearInterval(timer);
  }
}

/**
 * ~0.3 s of backtracking locally, polynomial, so the screen lets it through.
 * A no-match that slow is indistinguishable from JavaScriptCore giving up
 * (tool-safety reads one past 100 ms as a give-up), so its answer is
 * undetermined, which is what a gate must see instead of "no match".
 */
const SLOW = { pattern: "a*a*a*a*b", input: "a".repeat(120) };
/** Exponential: the screen refuses it, and JSC would give up and say "no match". */
const CATASTROPHIC = "(a+)+!$|refund";

describe("RegexAnswers", () => {
  test("answers many inputs in one worker session, definitely", async () => {
    const answers = new RegexAnswers();
    for (const input of ["1", "x", "22"])
      expect(answers.lookup("^\\d+$", "", input)).toBeUndefined();
    expect(answers.pending).toBe(3);
    await answers.resolve();
    expect(answers.pending).toBe(0);
    expect(["1", "x", "22"].map((i) => answers.lookup("^\\d+$", "", i))).toEqual([
      true,
      false,
      true,
    ]);
  });

  test("a pattern still running at the deadline is undetermined, and the thread stays free", async () => {
    const answers = new RegexAnswers();
    answers.lookup(SLOW.pattern, "", SLOW.input);
    const { ticks } = await ticksDuring(() => answers.resolve({}, { deadlineMs: 60 }));
    const answer = answers.lookup(SLOW.pattern, "", SLOW.input);
    expect(answer).toEqual({ undetermined: expect.stringMatching(/timeout/) });
    expect(ticks).toBeGreaterThan(0);
  }, 20_000);

  test("a pattern the screen refuses is refused with its reason, not run", async () => {
    const answers = new RegexAnswers();
    answers.lookup(CATASTROPHIC, "", "a".repeat(30));
    await answers.resolve();
    expect(answers.lookup(CATASTROPHIC, "", "a".repeat(30))).toEqual({
      refused: expect.stringMatching(/nested-quantifier/),
      code: "nested-quantifier",
    });
  });

  test("withRegexAnswers stops asking once nothing is pending, and caps its rounds", async () => {
    let rounds = 0;
    const done = await withRegexAnswers((regex) => {
      rounds += 1;
      return regex.lookup("b", "", "abc");
    });
    expect(done).toEqual({ value: true });
    expect(rounds).toBe(2);
    let n = 0;
    const endless = await withRegexAnswers(
      (regex) => regex.lookup("x", "", String(n++)),
      {},
      {
        maxRounds: 3,
      },
    );
    expect(endless).toEqual({ undetermined: expect.stringMatching(/past 3 rounds/) });
  });

  test("the fallback on the caller's thread screens, and runs over no more than its cap", () => {
    expect(testPatternSync("^a+$", "", "aaa")).toBe(true);
    expect(testPatternSync(CATASTROPHIC, "", "x")).toEqual({
      refused: expect.stringMatching(/nested-quantifier/),
      code: "nested-quantifier",
    });
    expect(testPatternSync("a", "", "b".repeat(SYNC_PATTERN_MAX_INPUT_CHARS + 1))).toEqual({
      undetermined: expect.stringMatching(/more than the 65536/),
    });
  });
});

describe("Assert", () => {
  test("notMatches with a pattern that cannot be run to an answer fails closed", async () => {
    // 0.7.0: JSC gave up on the first branch, answered "no match", ok: true.
    const out = await call(assert as Tool, {
      value: `${"a".repeat(30)}! refund`,
      checks: [{ op: "notMatches", expected: CATASTROPHIC }],
    });
    expect(out.ok).toBe(false);
    expect(out.results[0].reason).toMatch(/invalid regex .*nested-quantifier/);
  });

  test("a slow pattern runs off the caller's thread", async () => {
    const { result, ticks } = await ticksDuring(() =>
      call(assert as Tool, {
        value: SLOW.input,
        checks: [{ op: "matches", expected: SLOW.pattern }],
      }),
    );
    // 0.7.0 held the thread for the whole match: no timer fired.
    expect(ticks).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: false, undetermined: 1 });
    expect(result.results[0].reason).toMatch(/could not evaluate \/a\*a\*a\*a\*b\//);
  }, 20_000);

  test("an undetermined check is counted, keeps its own reason, and is not a pass", () => {
    const answers = new RegexAnswers();
    answers.lookup("x", "", "y");
    // Not resolved: the check has no answer yet.
    const report = runChecks(
      "y",
      [
        { op: "notMatches", expected: "x", message: "must not mention x" },
        { op: "equals", expected: "y" },
      ],
      { regex: answers },
    );
    expect(report).toMatchObject({ ok: false, passed: 1, failed: 1, undetermined: 1 });
    expect(report.results[0]).toMatchObject({ undetermined: true });
    expect(report.results[0]?.reason).toMatch(/could not evaluate/);
  });
});

describe("JsonSchemaValidate and ValidateRecords", () => {
  test("a pattern the screen refuses makes the schema malformed, never valid", async () => {
    // 0.7.0: valid: true, because JSC gave up inside `not` and said no match.
    const out = await call(jsonSchemaValidate as Tool, {
      value: `${"a".repeat(30)}! DROP TABLE`,
      schema: { not: { pattern: "(a+)+!$|DROP TABLE" } },
    });
    expect(out.valid).toBeUndefined();
    expect(out.schemaValid).toBe(false);
    expect(out.problems[0]).toMatch(/\/not\/pattern: .*nested-quantifier/);
    expect(checkSchemaShape({ patternProperties: { "(\\w+\\s?)+$": true } })[0]).toMatch(
      /nested-quantifier/,
    );
  });

  test("patterns answered in the worker give the verdicts 0.7.0 gave, through if/then/else", async () => {
    // An object literal with a `then` key reads as a thenable to the linter.
    const schema = JSON.parse(
      '{"if":{"pattern":"^a"},"then":{"maxLength":2},"else":{"minLength":5}}',
    );
    const verdicts: Record<string, boolean | null> = {};
    for (const value of ["ab", "abc", "xyzxyz", "xy"]) {
      verdicts[value] = (await call(jsonSchemaValidate as Tool, { value, schema })).valid;
    }
    expect(verdicts).toEqual({ ab: true, abc: false, xyzxyz: true, xy: false });
    const keyed = {
      type: "object",
      patternProperties: { "^x-": { type: "string" } },
      additionalProperties: false,
    };
    const ok = await call(jsonSchemaValidate as Tool, { value: { "x-a": "s" }, schema: keyed });
    const bad = await call(jsonSchemaValidate as Tool, {
      value: { "x-a": 1, y: true },
      schema: keyed,
    });
    expect(ok.valid).toBe(true);
    expect(bad.errors.map((e: { keyword: string }) => e.keyword).sort()).toEqual([
      "additionalProperties",
      "type",
    ]);
  });

  test("a slow schema pattern runs off the caller's thread", async () => {
    const { result, ticks } = await ticksDuring(() =>
      call(jsonSchemaValidate as Tool, {
        value: SLOW.input,
        schema: { type: "string", pattern: SLOW.pattern },
      }),
    );
    expect(ticks).toBeGreaterThan(0);
    expect(result).toMatchObject({ valid: null, undetermined: true });
    expect(result.reason).toMatch(/pattern \/a\*a\*a\*a\*b\/ at \/pattern could not be run/);
  }, 20_000);

  test("a pattern with no answer leaves the value undetermined, not invalid", () => {
    const answers = new RegexAnswers();
    answers.lookup("^a", "", "abc");
    // Record the question and answer it as undetermined, as a timeout would.
    const refused = validateValue("abc", { pattern: "^a" }, { regex: answers });
    // Not resolved yet: the pass reads it as no match and is thrown away.
    expect(answers.pending).toBe(1);
    expect(refused.valid).toBe(false);
    const withUndetermined = {
      lookup: () => ({ undetermined: "the deadline passed" }),
    } as unknown as RegexAnswers;
    const out = validateValue("abc", { pattern: "^a" }, { regex: withUndetermined });
    expect(out.valid).toBe(false);
    expect(out.undetermined).toMatch(/could not be run to an answer: the deadline passed/);
  });

  test("ValidateRecords answers every row's patterns in the worker", async () => {
    const out = await call(validateRecords as Tool, {
      records: [{ sku: "AB-1" }, { sku: "ab-2" }, { sku: "CD-33" }],
      schema: {
        type: "object",
        properties: { sku: { type: "string", pattern: "^[A-Z]{2}-\\d+$" } },
      },
      summaryOnly: true,
    });
    expect(out).toMatchObject({ ok: false, total: 3, passed: 2, failed: 1 });
  });
});
