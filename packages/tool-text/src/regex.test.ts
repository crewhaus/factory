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
import { afterEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { REGEX_RUN_DEFAULTS } from "@crewhaus/tool-safety/regex";
import { regexExtract, ruleClassify } from "./index";

type Tool = typeof regexExtract;

/**
 * Polynomial, so the screen lets it through. Over 120 "a"s it backtracks for
 * about 0.3 s here, and the worker reads a no-match that slow as the engine
 * giving up. That raced the machine both ways: an engine three times faster
 * answers a definite "no", and CI took 3.9 to 5.1 s over these tests, against
 * the call's 5 s deadline. So these tests run it over a few characters, and
 * with the worker's give-up threshold at 0 ms: every no-match it reports is
 * then the engine giving up, however fast the machine is. What is under test
 * is what each tool does with that answer, and that the pattern runs in the
 * worker, never here. The call's deadline only stops a hang.
 */
const GIVES_UP = { pattern: "a*a*a*a*b", text: "a".repeat(12) };

/** Taken before any test changes them. */
const GIVE_UP_MS = REGEX_RUN_DEFAULTS.giveUpMs;
const NATIVE_EXEC = RegExp.prototype.exec;

/** Runs of GIVES_UP over its text on the caller's thread, counted for the call that made them. */
const ranHere = new AsyncLocalStorage<{ count: number }>();

/** The {@link callGivingUp} whose settings are in place; undefined when none is. */
let installed: object | undefined;

/** Put back the real give-up threshold and `exec`, whoever changed them. */
function putBack(): void {
  installed = undefined;
  (REGEX_RUN_DEFAULTS as { giveUpMs: number }).giveUpMs = GIVE_UP_MS;
  RegExp.prototype.exec = NATIVE_EXEC;
}

// A body abandoned at its budget never reaches its own finally. Without
// this, its 0 ms threshold would stay for the rest of the process, and
// every definite no-match after it would read as a give-up.
afterEach(putBack);

function refuseGivesUpHere(this: RegExp, text: string): RegExpExecArray | null {
  if (this.source === GIVES_UP.pattern && text === GIVES_UP.text) {
    const mine = ranHere.getStore();
    if (mine !== undefined) mine.count += 1;
    throw new Error(`/${this.source}/ ran over the text on the caller's thread`);
  }
  return NATIVE_EXEC.call(this, text);
}

/**
 * Run a tool with every no-match the regex worker sees reported as the
 * engine giving up. A run of GIVES_UP over its text on this thread, as in
 * 0.7.0, is refused, and counted in `onThisThread`.
 */
async function callGivingUp(
  tool: Tool,
  input: unknown,
  // biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
): Promise<{ result: any; onThisThread: number }> {
  const mine = {};
  const ran = { count: 0 };
  installed = mine;
  (REGEX_RUN_DEFAULTS as { giveUpMs: number }).giveUpMs = 0;
  RegExp.prototype.exec = refuseGivesUpHere;
  try {
    const result = await ranHere.run(ran, () => call(tool, input));
    return { result, onThisThread: ran.count };
  } finally {
    // Only while still the one in place: a call abandoned by an earlier
    // test must not undo a later test's in the middle of its call.
    if (installed === mine) putBack();
  }
}

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
async function call(tool: Tool, input: unknown): Promise<any> {
  const out = await tool.execute(tool.inputSchema.parse(input) as never, {} as never);
  try {
    return JSON.parse(out as string);
  } catch {
    return out;
  }
}

describe("RegexExtract", () => {
  test("the match runs off the caller's thread, and a give-up is not a count of 0", async () => {
    const { result, onThisThread } = await callGivingUp(regexExtract, {
      text: GIVES_UP.text,
      pattern: GIVES_UP.pattern,
    });
    expect(onThisThread).toBe(0);
    expect(result).toMatchObject({ count: 0, truncated: true });
    expect(result.undetermined).toMatch(/could not be run to the end of the text.*\(gave-up\)/);
  });

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
    const { result, onThisThread } = await callGivingUp(ruleClassify as Tool, {
      text: GIVES_UP.text,
      rules: [
        { label: "slow", patterns: [GIVES_UP.pattern], regex: true, weight: 5 },
        { label: "a", patterns: ["aaa"] },
      ],
      defaultLabel: "other",
    });
    expect(onThisThread).toBe(0);
    // 0.7.0: label "a", as if the slow rule had not matched.
    expect(result.label).toBeNull();
    expect(result.undetermined).toEqual([
      { pattern: GIVES_UP.pattern, reason: expect.stringMatching(/gave up/) },
    ]);
  });

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
