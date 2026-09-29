/**
 * GlCodeSuggest at batch sizes the schema allows (bounds review of C073's
 * fix).
 *
 * 8c1e3bf0 asked every (pattern, line) question of ONE `RegexAnswers`, which
 * answers any question past tool-schema's `MAX_PATTERN_QUESTIONS` as
 * undetermined. 5 000 lines under 201 one-pattern rules asked more, so 25
 * lines went to review uncoded (under 250 rules, 1 000 lines) where 0.7.0
 * coded all of them.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { type Check, MAX_PATTERN_QUESTIONS, RegexAnswers } from "@crewhaus/tool-schema";
import { type CodingRule, codeLines, codeLinesAnsweringPatterns } from "./lib/coding";

type Line = { readonly id: string } & Record<string, unknown>;

/** Record how many questions each `resolve` is asked to answer, calling through. */
function watchResolves(): { readonly pending: number[]; restore(): void } {
  const pending: number[] = [];
  const original = RegexAnswers.prototype.resolve;
  const spy = spyOn(RegexAnswers.prototype, "resolve").mockImplementation(function (
    this: RegexAnswers,
    ...args: Parameters<RegexAnswers["resolve"]>
  ) {
    pending.push(this.pending);
    return original.apply(this, args);
  });
  return { pending, restore: () => spy.mockRestore() };
}

let watch: { restore(): void } | undefined;
afterEach(() => {
  watch?.restore();
  watch = undefined;
});

/** `lines` lines, each named by one of `rules` one-pattern rules, all distinct inputs. */
function batch(lineCount: number, ruleCount: number): { lines: Line[]; rules: CodingRule[] } {
  return {
    lines: Array.from({ length: lineCount }, (_, i) => ({
      id: `L${i}`,
      description: `invoice ${i} for sku${i % ruleCount}`,
    })),
    rules: Array.from({ length: ruleCount }, (_, r) => ({
      id: `r${r}`,
      when: [{ path: "description", op: "matches", expected: `\\bsku${r}$` } as Check],
      account: String(6000 + r),
    })),
  };
}

describe("a batch is asked about in chunks no larger than the question cap", () => {
  test("no resolve is asked more than the cap, and the coding is the unchunked one", async () => {
    const { lines, rules } = batch(40, 5);
    const w = watchResolves();
    watch = w;
    const chunked = await codeLinesAnsweringPatterns(lines, rules, {
      maxQuestions: 50,
      deadlineMs: 60_000,
    });
    // 40 lines x 5 questions = 200, in chunks of at most 50.
    expect(w.pending.length).toBe(4);
    for (const n of w.pending) expect(n).toBeLessThanOrEqual(50);
    expect(w.pending.reduce((a, b) => a + b, 0)).toBe(200);
    // The same rules, run on this thread without a worker, code the same way.
    expect(chunked).toEqual(codeLines(lines, rules));
    expect(chunked.coded).toBe(40);
  });

  test("the real cap: a batch that asks just over it is coded in full", async () => {
    // 980 lines x 16 rules x 64 pattern conditions = 1 003 520 questions,
    // over MAX_PATTERN_QUESTIONS, which 8c1e3bf0 asked of one RegexAnswers.
    const lines: Line[] = Array.from({ length: 980 }, (_, i) => ({ id: `L${i}`, d: `v${i}` }));
    const rules: CodingRule[] = Array.from({ length: 16 }, (_, r) => ({
      id: `r${r}`,
      when: Array.from(
        { length: 64 },
        (_, c) => ({ path: "d", op: "notMatches", expected: `^z${r}_${c}` }) as Check,
      ),
      account: "6000",
    }));
    const w = watchResolves();
    watch = w;
    // A budget no host misses, so this measures the cap and not the clock.
    const out = await codeLinesAnsweringPatterns(lines, rules, { deadlineMs: 600_000 });
    expect(w.pending.length).toBe(2);
    for (const n of w.pending) expect(n).toBeLessThanOrEqual(MAX_PATTERN_QUESTIONS);
    expect(w.pending.reduce((a, b) => a + b, 0)).toBe(980 * 16 * 64);
    expect(out).toMatchObject({ coded: 980, needsReview: 0 });
  }, 120_000);

  test("lines reached after the budget ran out are not asked about, and go to review", async () => {
    const { lines, rules } = batch(12, 3);
    const w = watchResolves();
    watch = w;
    const out = await codeLinesAnsweringPatterns(lines, rules, { maxQuestions: 9, deadlineMs: 0 });
    expect(w.pending).toEqual([]);
    expect(out).toMatchObject({ coded: 0, needsReview: 12 });
    expect(out.lines[0]?.reason).toContain("ran out before this line's could run");
    expect(out.lines[0]?.undetermined).toEqual(["r0", "r1", "r2"]);
  });

  test("a cancelled call asks nothing more", async () => {
    const { lines, rules } = batch(6, 2);
    const w = watchResolves();
    watch = w;
    const out = await codeLinesAnsweringPatterns(lines, rules, {
      run: { signal: AbortSignal.abort() },
      deadlineMs: 60_000,
    });
    expect(w.pending).toEqual([]);
    expect(out.needsReview).toBe(6);
    expect(out.lines[0]?.reason).toContain("cancelled");
  });

  test("a line blocked by many rules names three with reasons, and lists every one", async () => {
    const { lines, rules } = batch(1, 8);
    const out = await codeLinesAnsweringPatterns(lines, rules, { deadlineMs: 0 });
    const line = out.lines[0];
    expect(line?.undetermined).toHaveLength(8);
    expect(line?.reason).toContain('"r0" (');
    expect(line?.reason).toContain('"r2" (');
    expect(line?.reason).not.toContain('"r3" (');
    expect(line?.reason).toContain("and 5 more (see undetermined)");
  });
});
