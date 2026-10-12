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
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { assert, jsonSchemaValidate, validateRecords } from "./index";
import { runChecks } from "./lib/assert";
import { checkSchemaShape, validateValue } from "./lib/jsonschema";
import {
  RegexAnswers,
  SYNC_PATTERN_MAX_INPUT_CHARS,
  _setRegexAnswersSessionForTest,
  testPatternSync,
  withRegexAnswers,
} from "./lib/regex-answers";

type Tool = {
  inputSchema: { parse: (v: unknown) => unknown };
  execute: (input: never, ctx?: unknown) => Promise<unknown>;
};

type RegexSession = ReturnType<NonNullable<Parameters<typeof _setRegexAnswersSessionForTest>[0]>>;
type Asked = { readonly op: string; readonly pattern?: string; readonly inputs?: unknown };

/**
 * Polynomial, so the screen lets it through, and about 0.3 s of backtracking
 * over this input here. The worker reads a no-match that slow as
 * JavaScriptCore giving up (anything past 100 ms), so its answer is
 * undetermined, which is what a gate must see instead of "no match". But
 * that raced the machine: on an engine three times faster the run ends as a
 * definite "no", and on a loaded runner it can outlast the call's deadline
 * instead. So the worker sessions opened in this file answer SLOW over this
 * input as the worker answers an input the engine gave up on, without running
 * it, and send every other question to the real worker with the give-up
 * threshold out of reach (at the real 100 ms, a worker thread stalled that
 * long inside a definite no-match reads as giving up too). No clock decides
 * an answer here; each call's 5 s deadline only stops a hang.
 */
const SLOW = { pattern: "a*a*a*a*b", input: "a".repeat(120) };
/** Exponential: the screen refuses it, and JSC would give up and say "no match". */
const CATASTROPHIC = "(a+)+!$|refund";

/** Worker sessions opened, and the testEach questions put to them, in order. */
let sessions = 0;
let asked: Array<{ pattern: string; inputs: string[] }> = [];
/** SLOW runs over its input on the caller's thread, where nothing can stop them. */
let onThisThread = 0;

function givesUpOnSlow(real: RegexSession): RegexSession {
  sessions += 1;
  return {
    run: (request) => {
      const r = request as Asked;
      if (r.op === "testEach") {
        asked.push({ pattern: String(r.pattern), inputs: [...(r.inputs as string[])] });
      }
      if (r.op !== "testEach" || r.pattern !== SLOW.pattern) {
        return real.run({ ...request, giveUpMs: 60_000 });
      }
      const inputs = r.inputs as ReadonlyArray<string>;
      if (inputs.some((input) => input !== SLOW.input)) {
        throw new Error("SLOW was asked about an input this script does not answer");
      }
      // A testEach run with onGiveUp "skip" lists an input the engine gave
      // up on as undetermined, and goes on.
      return Promise.resolve({
        status: "ok",
        result: {
          matched: [],
          scanned: inputs.length,
          truncated: false,
          undetermined: inputs.map((_, i) => i),
        },
      } as never);
    },
    close: () => real.close(),
  };
}

beforeEach(() => {
  sessions = 0;
  asked = [];
  onThisThread = 0;
  _setRegexAnswersSessionForTest(givesUpOnSlow);
});

afterEach(() => {
  _setRegexAnswersSessionForTest(undefined);
});

/** Run `body`. A run of SLOW over its input on this thread, as in 0.7.0, is counted and refused. */
async function offThisThread<T>(body: () => Promise<T>): Promise<T> {
  const realExec = RegExp.prototype.exec;
  RegExp.prototype.exec = function (this: RegExp, text: string) {
    if (this.source === SLOW.pattern && text === SLOW.input) {
      onThisThread += 1;
      throw new Error(`/${this.source}/ ran over the input on the caller's thread`);
    }
    return realExec.call(this, text);
  };
  try {
    return await body();
  } finally {
    RegExp.prototype.exec = realExec;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
async function call(tool: Tool, input: unknown): Promise<any> {
  const out = await offThisThread(() => tool.execute(tool.inputSchema.parse(input) as never, {}));
  return JSON.parse(out as string);
}

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
    expect(sessions).toBe(1);
    expect(asked).toEqual([{ pattern: "^\\d+$", inputs: ["1", "x", "22"] }]);
  });

  test("a pattern still running at the deadline is undetermined, and the thread stays free", async () => {
    // A real 60 ms deadline raced SLOW: an engine fast enough finished first
    // and answered "no". So this session answers as a worker the deadline
    // stopped before its first input does, without running SLOW. What is
    // under test is what RegexAnswers does with that, and that it hands the
    // run its deadline. The caller's clock stands still while resolve reads
    // it, so all 60 ms reach the run, never "ran out before this one could
    // run".
    const deadlines: number[] = [];
    _setRegexAnswersSessionForTest((real) => ({
      run: (request) => {
        const r = request as Asked & { deadlineMs: number };
        if (r.op !== "testEach" || r.pattern !== SLOW.pattern) {
          throw new Error("this script answers SLOW only");
        }
        asked.push({ pattern: r.pattern, inputs: [...(r.inputs as string[])] });
        deadlines.push(r.deadlineMs);
        return Promise.resolve({
          status: "timeout",
          reason: "the deadline passed",
          deadlineMs: r.deadlineMs,
          completed: 0,
          partial: { matched: [], scanned: 0, truncated: false, undetermined: [] },
        } as never);
      },
      close: () => real.close(),
    }));
    const answers = new RegexAnswers();
    await offThisThread(() => {
      answers.lookup(SLOW.pattern, "", SLOW.input);
      // resolve reads the clock and hands the run what is left before its
      // first await, so the clock is back before anything is awaited.
      const clock = spyOn(performance, "now").mockReturnValue(0);
      try {
        return answers.resolve({}, { deadlineMs: 60 });
      } finally {
        clock.mockRestore();
      }
    });
    const answer = answers.lookup(SLOW.pattern, "", SLOW.input);
    expect(answer).toEqual({ undetermined: expect.stringMatching(/timeout/) });
    // Asked of the worker with the whole deadline, and never run here.
    expect(asked).toEqual([{ pattern: SLOW.pattern, inputs: [SLOW.input] }]);
    expect(deadlines).toEqual([60]);
    expect(onThisThread).toBe(0);
  });

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
    const result = await call(assert as Tool, {
      value: SLOW.input,
      checks: [{ op: "matches", expected: SLOW.pattern }],
    });
    // Asked of the worker, and never run here: 0.7.0 held the thread for the
    // whole match.
    expect(asked).toEqual([{ pattern: SLOW.pattern, inputs: [SLOW.input] }]);
    expect(onThisThread).toBe(0);
    expect(result).toMatchObject({ ok: false, undetermined: 1 });
    expect(result.results[0].reason).toMatch(/could not evaluate \/a\*a\*a\*a\*b\//);
  });

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
    const result = await call(jsonSchemaValidate as Tool, {
      value: SLOW.input,
      schema: { type: "string", pattern: SLOW.pattern },
    });
    expect(asked).toEqual([{ pattern: SLOW.pattern, inputs: [SLOW.input] }]);
    expect(onThisThread).toBe(0);
    expect(result).toMatchObject({ valid: null, undetermined: true });
    expect(result.reason).toMatch(/pattern \/a\*a\*a\*a\*b\/ at \/pattern could not be run/);
  });

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
    expect(asked).toEqual([{ pattern: "^[A-Z]{2}-\\d+$", inputs: ["AB-1", "ab-2", "CD-33"] }]);
  });
});
