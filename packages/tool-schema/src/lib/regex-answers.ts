/**
 * Caller-supplied patterns, answered off this thread.
 *
 * A `matches` check, a JSON Schema `pattern` and a JSONPath `=~` filter all
 * run a regex someone else wrote over text someone else chose, and the
 * evaluators that ask are synchronous. A synchronous `RegExp` cannot be
 * interrupted: `a*a*a*a*b` over 200 characters held the whole process for
 * 3.5 s, over 400 for 108 s. And when JavaScriptCore gives up on a
 * backtracking match it returns "no match", so a gate read a real match as a
 * miss.
 *
 * So the evaluator does not run the pattern. It asks {@link RegexAnswers},
 * which answers from what the worker in `@crewhaus/tool-safety/regex` has
 * already settled and records anything else as pending. A caller runs the
 * evaluator once to learn what it will ask, {@link RegexAnswers.resolve}s the
 * pending questions in one worker session under one deadline, and runs it
 * again with the answers ({@link withRegexAnswers} does the loop). Every
 * answer is tri-state: a pattern that could not be run to an answer is
 * `undetermined`, never `false`, and one the screen refuses (bad syntax, or
 * a shape that backtracks exponentially) is `refused`, with the reason.
 *
 * {@link testPatternSync} is the fallback for a synchronous caller that has
 * no answers to hand (a library call from another package): the same screen,
 * a cap on the input it will run over on this thread, and JavaScriptCore's
 * give-up read as undetermined. It bounds the exponential shapes and the
 * false verdict, not a polynomial pattern's time; a tool reaches for
 * {@link RegexAnswers} instead.
 */
import {
  type RegexOutcome,
  type RegexRejectCode,
  type TestEachResult,
  compileUserRegex,
  describeRegexOutcome,
  openRegexSession,
} from "@crewhaus/tool-safety/regex";

/** What a caller's pattern says about one input. */
export type RegexAnswer =
  | boolean
  /** Refused before it ran: invalid syntax, bad flags, or a catastrophic shape. */
  | { readonly refused: string; readonly code: RegexRejectCode }
  /** Could not be run to an answer: the deadline, the engine giving up, a cap. */
  | { readonly undetermined: string };

/** Where a tool call's patterns run: its abort signal, and whose runaway workers they count as. */
export type RegexRunContext = {
  readonly signal?: AbortSignal;
  readonly runawayKey?: string;
};

/** The pattern screen's limits for caller patterns: long schema patterns (a URI, a language tag) pass. */
export const CALLER_PATTERN_LIMITS = { maxPatternChars: 10_000 } as const;
/** Wall-clock budget for all of one call's pattern questions. */
export const CALLER_PATTERN_DEADLINE_MS = 5_000;
/** The longest single input a pattern is run over in the worker. */
export const CALLER_PATTERN_MAX_ITEM_CHARS = 1_048_576;
/** The most distinct (pattern, input) questions one call may ask. */
export const MAX_PATTERN_QUESTIONS = 1_000_000;
/** The longest input {@link testPatternSync} runs a pattern over on the caller's thread. */
export const SYNC_PATTERN_MAX_INPUT_CHARS = 65_536;
/**
 * A no-match that took this long is JavaScriptCore abandoning the match,
 * not a real no-match (the tool-safety README measured give-ups at 0.4-3 s,
 * genuine no-matches in microseconds to milliseconds).
 */
const GIVE_UP_MS = 100;

/** The ctx fields a tool's `execute` receives that a regex run uses. */
export function regexRunContext(ctx: unknown): RegexRunContext {
  const c = ctx as { signal?: AbortSignal; runContext?: { sessionId?: string } } | undefined;
  return {
    ...(c?.signal === undefined ? {} : { signal: c.signal }),
    ...(typeof c?.runContext?.sessionId === "string" ? { runawayKey: c.runContext.sessionId } : {}),
  };
}

type Group = { readonly pattern: string; readonly flags: string; readonly inputs: Set<string> };

const keyOf = (pattern: string, flags: string): string => `${flags}\u0000${pattern}`;

/**
 * The answers a synchronous evaluator reads, and the questions it has asked
 * that are not answered yet.
 */
export class RegexAnswers {
  readonly #known = new Map<string, Map<string, RegexAnswer>>();
  readonly #pending = new Map<string, Group>();
  #asked = 0;

  /**
   * The answer for `pattern` (with `flags`) on `input`, or undefined when it
   * is not known yet; the question is then recorded, for {@link resolve}.
   * The evaluator decides what to assume meanwhile. Past
   * {@link MAX_PATTERN_QUESTIONS} distinct questions in one call, a new one
   * is answered undetermined rather than recorded.
   */
  lookup(pattern: string, flags: string, input: string): RegexAnswer | undefined {
    const key = keyOf(pattern, flags);
    const known = this.#known.get(key)?.get(input);
    if (known !== undefined) return known;
    let group = this.#pending.get(key);
    if (group?.inputs.has(input) === true) return undefined;
    if (this.#asked >= MAX_PATTERN_QUESTIONS) {
      return {
        undetermined: `the call asked more than ${MAX_PATTERN_QUESTIONS} distinct pattern questions`,
      };
    }
    if (group === undefined) {
      group = { pattern, flags, inputs: new Set() };
      this.#pending.set(key, group);
    }
    group.inputs.add(input);
    this.#asked += 1;
    return undefined;
  }

  /** How many questions wait for {@link resolve}. */
  get pending(): number {
    let n = 0;
    for (const group of this.#pending.values()) n += group.inputs.size;
    return n;
  }

  /**
   * Forget the pending questions: for an evaluator whose answer no pattern
   * can change (it ran out of its own work budget), so a caller running it
   * in rounds stops instead of answering them.
   */
  discardPending(): void {
    this.#pending.clear();
  }

  #settle(group: Group, input: string, answer: RegexAnswer): void {
    const key = keyOf(group.pattern, group.flags);
    let answers = this.#known.get(key);
    if (answers === undefined) {
      answers = new Map();
      this.#known.set(key, answers);
    }
    answers.set(input, answer);
  }

  /**
   * Answer every pending question in one worker session: one `testEach` per
   * pattern over the inputs it was asked about, all of them within
   * `deadlineMs`. What the worker cannot answer is recorded as undetermined
   * (or refused), so after this nothing is pending.
   */
  async resolve(
    ctx: RegexRunContext = {},
    options: { readonly deadlineMs?: number } = {},
  ): Promise<void> {
    const deadlineMs = options.deadlineMs ?? CALLER_PATTERN_DEADLINE_MS;
    const groups = [...this.#pending.values()];
    this.#pending.clear();
    if (groups.length === 0) return;
    const started = performance.now();
    const session = openRegexSession();
    try {
      for (const group of groups) {
        const inputs = [...group.inputs];
        const left = Math.floor(deadlineMs - (performance.now() - started));
        if (left < 1) {
          for (const input of inputs) {
            this.#settle(group, input, {
              undetermined: `the call's ${deadlineMs} ms for running patterns ran out before this one could run`,
            });
          }
          continue;
        }
        let total = inputs.length;
        for (const input of inputs) total += input.length;
        const outcome = await session.run({
          op: "testEach",
          pattern: group.pattern,
          flags: group.flags,
          inputs,
          maxMatches: inputs.length,
          onGiveUp: "skip",
          deadlineMs: left,
          maxInputChars: total,
          maxItemChars: CALLER_PATTERN_MAX_ITEM_CHARS,
          limits: CALLER_PATTERN_LIMITS,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          ...(ctx.runawayKey === undefined ? {} : { runawayKey: ctx.runawayKey }),
        });
        this.#record(group, inputs, outcome);
      }
    } finally {
      session.close();
    }
  }

  #record(group: Group, inputs: string[], outcome: RegexOutcome<TestEachResult>): void {
    if (outcome.status === "rejected") {
      const refused = { refused: describeRegexOutcome(outcome), code: outcome.code };
      for (const input of inputs) this.#settle(group, input, refused);
      return;
    }
    // A full answer, or the part of one a timeout or give-up left behind.
    const result =
      outcome.status === "ok"
        ? outcome.result
        : outcome.status === "timeout" || outcome.status === "gave-up"
          ? outcome.partial
          : undefined;
    const why =
      outcome.status === "ok"
        ? `the regex engine gave up on this input, or it is longer than the ${CALLER_PATTERN_MAX_ITEM_CHARS} characters a pattern is run over`
        : describeRegexOutcome(outcome);
    const matched = new Set(result?.matched ?? []);
    const skipped = new Set(result?.undetermined ?? []);
    const scanned = result?.scanned ?? 0;
    for (const [i, input] of inputs.entries()) {
      if (i >= scanned || skipped.has(i)) {
        this.#settle(group, input, { undetermined: why });
      } else {
        this.#settle(group, input, matched.has(i));
      }
    }
  }
}

/**
 * Run a synchronous evaluator that reads {@link RegexAnswers}, resolving
 * what it asked and running it again, until a run asks nothing new. An
 * evaluator whose later questions depend on earlier answers (a JSON Schema
 * `if`, the next filter in a path) settles in a few rounds; past
 * `maxRounds` the result is undetermined rather than a guess. All rounds
 * share one deadline.
 */
export async function withRegexAnswers<T>(
  evaluate: (answers: RegexAnswers) => T,
  ctx: RegexRunContext = {},
  options: { readonly maxRounds?: number; readonly deadlineMs?: number } = {},
): Promise<{ readonly value: T } | { readonly undetermined: string }> {
  const maxRounds = options.maxRounds ?? 8;
  const deadlineMs = options.deadlineMs ?? CALLER_PATTERN_DEADLINE_MS;
  const started = performance.now();
  const answers = new RegexAnswers();
  for (let round = 0; round < maxRounds; round++) {
    const value = evaluate(answers);
    if (answers.pending === 0) return { value };
    const left = Math.max(1, Math.floor(deadlineMs - (performance.now() - started)));
    await answers.resolve(ctx, { deadlineMs: left });
  }
  return {
    undetermined: `the patterns' answers kept changing which patterns were asked for, past ${maxRounds} rounds`,
  };
}

/** A screened, compiled caller pattern, or why it was refused. */
export type ScreenedPattern =
  | { readonly ok: true; readonly regex: RegExp }
  | { readonly ok: false; readonly answer: { refused: string; code: RegexRejectCode } };

/** Recently screened patterns, least recent first: a loop over rows compiles each once. */
const screened = new Map<string, ScreenedPattern>();
const SCREENED_ENTRIES = 512;

/** Screen and compile a caller pattern for {@link runPatternSync}; remembered per pattern. */
export function screenCallerPattern(pattern: string, flags: string): ScreenedPattern {
  const key = keyOf(pattern, flags);
  const known = screened.get(key);
  if (known !== undefined) {
    screened.delete(key);
    screened.set(key, known);
    return known;
  }
  const compiled = compileUserRegex(pattern, flags, CALLER_PATTERN_LIMITS);
  const out: ScreenedPattern = compiled.ok
    ? { ok: true, regex: compiled.regex }
    : {
        ok: false,
        answer: {
          refused: `pattern refused (${compiled.code}): ${compiled.reason}`,
          code: compiled.code,
        },
      };
  if (screened.size >= SCREENED_ENTRIES) screened.delete(screened.keys().next().value as string);
  screened.set(key, out);
  return out;
}

/**
 * Run a screened pattern on this thread: an input longer than
 * {@link SYNC_PATTERN_MAX_INPUT_CHARS} is not run, and a no-match that took
 * as long as JavaScriptCore's give-up is undetermined.
 */
export function runPatternSync(regex: RegExp, input: string): RegexAnswer {
  if (input.length > SYNC_PATTERN_MAX_INPUT_CHARS) {
    return {
      undetermined: `the input is ${input.length} characters, more than the ${SYNC_PATTERN_MAX_INPUT_CHARS} a pattern is run over on the caller's thread`,
    };
  }
  regex.lastIndex = 0;
  const started = performance.now();
  const hit = regex.test(input);
  const ms = performance.now() - started;
  if (!hit && ms >= GIVE_UP_MS) {
    return {
      undetermined: `the regex engine gave up after ${Math.round(ms)} ms, which it reports as no match, so whether it matches is unknown`,
    };
  }
  return hit;
}

/**
 * Run a caller's pattern on this thread, for a synchronous caller with no
 * {@link RegexAnswers} to hand. The pattern is screened (a refused one is
 * `refused`), an input longer than {@link SYNC_PATTERN_MAX_INPUT_CHARS} is
 * not run, and a no-match that took as long as JavaScriptCore's give-up is
 * undetermined. That bounds the exponential shapes and the false verdict;
 * a polynomial pattern's time is bounded only by the input cap.
 */
export function testPatternSync(pattern: string, flags: string, input: string): RegexAnswer {
  const s = screenCallerPattern(pattern, flags);
  return s.ok ? runPatternSync(s.regex, input) : s.answer;
}
