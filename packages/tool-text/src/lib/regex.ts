import {
  type RegexOutcome,
  describeRegexOutcome,
  openRegexSession,
  runRegex,
} from "@crewhaus/tool-safety/regex";
import { lineStarts, offsetToLineCol } from "./locate";

/** A single regex hit, located by offset AND by line/column. */
export type RegexMatch = {
  readonly match: string;
  readonly index: number;
  readonly line: number;
  readonly column: number;
  readonly groups: Readonly<Record<string, string>>;
  readonly captures: ReadonlyArray<string | undefined>;
};

/** Where a tool call's patterns run: its abort signal, and whose runaway workers they count as. */
export type RegexRunContext = { readonly signal?: AbortSignal; readonly runawayKey?: string };

/** The ctx fields a tool's `execute` receives that a regex run uses. */
export function regexRunContext(ctx: unknown): RegexRunContext {
  const c = ctx as { signal?: AbortSignal; runContext?: { sessionId?: string } } | undefined;
  return {
    ...(c?.signal === undefined ? {} : { signal: c.signal }),
    ...(typeof c?.runContext?.sessionId === "string" ? { runawayKey: c.runContext.sessionId } : {}),
  };
}

/** Wall-clock budget for one call's caller patterns. */
export const PATTERN_DEADLINE_MS = 5_000;
/** The screen's limits for a caller pattern. */
export const PATTERN_LIMITS = { maxPatternChars: 10_000 } as const;

export type RegexExtractResult =
  | {
      readonly ok: true;
      readonly matches: RegexMatch[];
      /** More matches may exist than were returned. */
      readonly truncated: boolean;
      readonly truncatedBy?: "maxMatches" | "maxOutputChars";
      /**
       * Set when the pattern could not be run to the end of the text (the
       * deadline, the engine giving up): `matches` are the ones found before
       * it stopped, and there may be more. Never read as "no more matches".
       */
      readonly undetermined?: string;
    }
  | { readonly ok: false; readonly invalid: string };

/**
 * Run a caller's regex over text and return located matches.
 *
 * The match runs in `@crewhaus/tool-safety`'s regex worker under a deadline,
 * never on this thread: a synchronous `RegExp` cannot be interrupted, and
 * `a*a*a*a*b` over 400 characters held the whole process for 108 s. The
 * pattern is screened first, so a shape that backtracks exponentially is
 * refused with the reason. `g` is always applied, and a zero-width match
 * advances by one character, so a pattern like `a*` terminates.
 */
export async function regexExtractAll(
  text: string,
  pattern: string,
  flags: string,
  maxMatches: number,
  ctx: RegexRunContext = {},
): Promise<RegexExtractResult> {
  const outcome = await runRegex({
    op: "matchAll",
    pattern,
    flags,
    input: text,
    maxMatches,
    deadlineMs: PATTERN_DEADLINE_MS,
    maxInputChars: text.length,
    limits: PATTERN_LIMITS,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    ...(ctx.runawayKey === undefined ? {} : { runawayKey: ctx.runawayKey }),
  });
  if (outcome.status === "rejected") return { ok: false, invalid: outcome.reason };
  const found =
    outcome.status === "ok"
      ? outcome.result.matches
      : outcome.status === "gave-up"
        ? (outcome.partial?.matches ?? [])
        : [];
  const starts = lineStarts(text);
  const matches = found.map((m): RegexMatch => {
    const { line, column } = offsetToLineCol(starts, m.index);
    const groups: Record<string, string> = {};
    for (const [name, value] of Object.entries(m.groups ?? {})) {
      if (value !== undefined) groups[name] = value;
    }
    return { match: m.match, index: m.index, line, column, groups, captures: m.captures };
  });
  if (outcome.status !== "ok") {
    return {
      ok: true,
      matches,
      truncated: true,
      undetermined: describeRegexOutcome(outcome as RegexOutcome<unknown>),
    };
  }
  return {
    ok: true,
    matches,
    truncated: outcome.result.truncated,
    ...(outcome.result.truncatedBy === undefined
      ? {}
      : { truncatedBy: outcome.result.truncatedBy }),
  };
}

/** One pattern's answer on one text: a verdict, or why there is none. */
export type PatternAnswer = boolean | { readonly undetermined: string };

/**
 * Test every pattern against `text` (case-insensitively, as RuleClassify
 * reads its regex rules) in one worker run, so a classifier can score
 * synchronously from the answers. A pattern the screen refuses is reported
 * as `invalid`, with its reason; one the worker could not finish is
 * undetermined, never `false`.
 */
export async function answerPatterns(
  text: string,
  patterns: ReadonlyArray<string>,
  flags: string,
  ctx: RegexRunContext = {},
): Promise<
  | { readonly ok: true; readonly answers: ReadonlyMap<string, PatternAnswer> }
  | { readonly ok: false; readonly invalid: string }
> {
  const distinct = [...new Set(patterns)];
  const answers = new Map<string, PatternAnswer>();
  if (distinct.length === 0) return { ok: true, answers };
  let total = 0;
  for (const p of distinct) total += p.length;
  const session = openRegexSession();
  try {
    const outcome = await session.run({
      op: "testMatrix",
      patterns: distinct.map((pattern) => ({ pattern, flags })),
      inputs: [text],
      onGiveUp: "skip",
      deadlineMs: PATTERN_DEADLINE_MS,
      maxInputChars: text.length + 1,
      maxItemChars: text.length,
      maxRules: distinct.length,
      maxTotalPatternChars: total,
      limits: PATTERN_LIMITS,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      ...(ctx.runawayKey === undefined ? {} : { runawayKey: ctx.runawayKey }),
    });
    if (outcome.status === "rejected") {
      const which = outcome.ruleIndex === undefined ? "" : `/${distinct[outcome.ruleIndex]}/: `;
      return { ok: false, invalid: `${which}${outcome.reason}` };
    }
    for (const [i, pattern] of distinct.entries()) {
      if (outcome.status !== "ok") {
        answers.set(pattern, { undetermined: describeRegexOutcome(outcome) });
      } else if ((outcome.result.undetermined[i] ?? []).length > 0) {
        answers.set(pattern, {
          undetermined: "the regex engine gave up on the text, which it reports as no match",
        });
      } else {
        answers.set(pattern, (outcome.result.matched[i] ?? []).length > 0);
      }
    }
    return { ok: true, answers };
  } finally {
    session.close();
  }
}
