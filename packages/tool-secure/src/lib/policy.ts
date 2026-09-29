/**
 * Operator-declared content rules.
 *
 * Unlike every other module here, this one has no opinions: the rules come
 * from the operator, and the evaluation is mechanical. "Does the disclaimer
 * appear?", "does the word 'guaranteed' appear?", "does anything match this
 * claim pattern?" — all answerable without judgement, which is exactly why
 * they should not cost a model call.
 *
 * What it cannot do is decide whether a document COMPLIES with a policy.
 * A required disclaimer can be present and wrong; a forbidden phrase can be
 * absent while the same claim is made in other words. `review_pattern` is
 * there for that: it is the rule kind that says "a person looks at this".
 *
 * A rule whose regular expression does not compile is reported as `error`
 * for that rule alone, and an `error` outcome fails the check. The
 * alternatives — refusing the whole evaluation, or silently treating the rule
 * as no-match — either block work over a typo or quietly turn a policy off.
 *
 * ## Patterns run in the regex worker, and an unanswered one is an error
 *
 * The rules arrive in the tool's input, so a model (or text it read) writes
 * them. 0.7.0 compiled each `*_pattern` and ran it on this thread over text
 * of up to 2,000,000 characters: `(a+)+!$|guaranteed returns` held the
 * process 0.75 s and then answered "forbidden text is absent" — JavaScriptCore
 * gives up on a runaway match and reports it as no match — so a gate passed
 * text it had not checked (C073). Patterns now run in
 * `@crewhaus/tool-safety`'s regex worker under a deadline. A pattern the
 * screen refuses (a shape that backtracks exponentially) is an `error`, like
 * one that does not compile. A run that cannot finish is an `error` too,
 * "not evaluated", unless the matches it found before stopping already
 * decide the rule (a forbidden pattern that matched has failed); a count
 * from a run that stopped early is a lower bound, and says so.
 */
import {
  type RegexOutcome,
  type RegexSession,
  describeRegexOutcome,
  openRegexSession,
} from "@crewhaus/tool-safety/regex";
import { LiteralSearch } from "./literal";
import { compareStrings } from "./text";
import { lineStarts, locate } from "./text";

export const POLICY_RULE_KINDS = [
  "forbidden_pattern",
  "forbidden_phrase",
  "required_pattern",
  "required_phrase",
  "review_pattern",
] as const;

export type PolicyRuleKind = (typeof POLICY_RULE_KINDS)[number];

export type PolicyRule = {
  readonly id: string;
  readonly kind: PolicyRuleKind;
  /** A literal for `*_phrase` rules; a JavaScript regex source for `*_pattern`. */
  readonly value: string;
  readonly caseSensitive?: boolean;
  readonly description?: string;
};

export type PolicyMatch = {
  readonly line: number;
  readonly column: number;
  readonly excerpt: string;
};

export type PolicyOutcome = {
  readonly id: string;
  readonly kind: PolicyRuleKind;
  readonly status: "pass" | "fail" | "review" | "error";
  readonly message: string;
  readonly matches: ReadonlyArray<PolicyMatch>;
  readonly matchCount: number;
  /**
   * Set when the pattern could not be run to the end of the text, or more
   * matches exist than were counted: `matchCount` is then "at least".
   */
  readonly matchCountIsLowerBound?: true;
};

export type PolicyResult = {
  /**
   * True when no rule produced `fail` AND none produced `error`. A rule that
   * did not compile was not evaluated, so the check cannot claim to have
   * passed. `review` outcomes do not fail; they queue for a person.
   */
  readonly pass: boolean;
  readonly outcomes: ReadonlyArray<PolicyOutcome>;
  readonly counts: Readonly<Record<PolicyOutcome["status"], number>>;
};

/** Bounds the rule set: a policy is a page of rules, not a corpus. */
export const MAX_POLICY_RULES = 200;
/** Locations reported per rule. The count is always exact. */
export const MAX_MATCHES_PER_RULE = 20;
const EXCERPT_CHARS = 120;

export class PolicyError extends Error {
  override readonly name = "PolicyError";
}

/** Wall-clock budget for all of one check's patterns, shared in rule order. */
export const POLICY_PATTERN_DEADLINE_MS = 10_000;
/** The pattern screen's limits for a rule. */
const PATTERN_LIMITS = { maxPatternChars: 10_000 } as const;
/** Matches counted per pattern rule; past it the count is a lower bound. */
const MAX_COUNTED_MATCHES = 10_000;

/** Where a check's patterns run: the call's abort signal, and whose runaway workers they count as. */
export type PolicyRunContext = { readonly signal?: AbortSignal; readonly runawayKey?: string };

type Found = {
  /** The first {@link MAX_MATCHES_PER_RULE} matches, for their locations. */
  readonly matches: ReadonlyArray<{ readonly index: number; readonly match: string }>;
  /** Every match found (exact unless `lowerBound`). */
  readonly count: number;
  /** Why the scan stopped before the end of the text, if it did. */
  readonly stopped?: string;
  /** More matches may exist than were found (a cap, or an early stop). */
  readonly lowerBound: boolean;
};

/**
 * Every match of a `*_pattern` rule's source, run in the regex worker: the
 * matches, or why the pattern could not be run at all (`refused`).
 */
async function findPattern(
  session: RegexSession,
  text: string,
  source: string,
  flags: string,
  deadlineMs: number,
  ctx: PolicyRunContext,
): Promise<Found | { readonly refused: string }> {
  const outcome = await session.run({
    op: "matchAll",
    pattern: source,
    flags,
    input: text,
    maxMatches: MAX_COUNTED_MATCHES,
    deadlineMs,
    maxInputChars: Math.max(1, text.length),
    limits: PATTERN_LIMITS,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    ...(ctx.runawayKey === undefined ? {} : { runawayKey: ctx.runawayKey }),
  });
  if (outcome.status === "rejected") return { refused: describeRegexOutcome(outcome) };
  if (outcome.status === "ok") {
    const all = outcome.result.matches;
    return {
      matches: all.slice(0, MAX_MATCHES_PER_RULE),
      count: all.length,
      lowerBound: outcome.result.truncated,
    };
  }
  const partial =
    outcome.status === "gave-up" || outcome.status === "timeout"
      ? (outcome.partial?.matches ?? [])
      : [];
  return {
    matches: partial.slice(0, MAX_MATCHES_PER_RULE),
    count: partial.length,
    stopped: describeRegexOutcome(outcome as RegexOutcome<unknown>),
    lowerBound: true,
  };
}

/**
 * Evaluate every rule against the text. One pass per rule, no early exit.
 *
 * Phrase rules are literals, matched on this thread by a search that passes
 * each character of the text once, whatever the phrase ({@link LiteralSearch};
 * 0.7.0's case-insensitive regex cost the text's length times the phrase's).
 * Pattern rules run in the regex worker, one after another in one session,
 * sharing {@link POLICY_PATTERN_DEADLINE_MS}.
 */
export async function evaluatePolicy(
  text: string,
  rules: ReadonlyArray<PolicyRule>,
  ctx: PolicyRunContext = {},
  options: { readonly deadlineMs?: number } = {},
): Promise<PolicyResult> {
  if (rules.length > MAX_POLICY_RULES) {
    throw new PolicyError(`${rules.length} rules, over the ${MAX_POLICY_RULES} limit`);
  }
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new PolicyError(`duplicate rule id "${rule.id}" — ids identify a rule in the result`);
    }
    seen.add(rule.id);
  }

  const starts = lineStarts(text);
  const outcomes: PolicyOutcome[] = [];
  const deadlineMs = options.deadlineMs ?? POLICY_PATTERN_DEADLINE_MS;
  const started = performance.now();
  let session: RegexSession | undefined;
  let literals: LiteralSearch | undefined;

  try {
    for (const rule of rules) {
      const isPattern = rule.kind.endsWith("_pattern");
      let found: Found;
      if (isPattern) {
        const left = Math.floor(deadlineMs - (performance.now() - started));
        session ??= openRegexSession();
        const run =
          left < 1
            ? {
                matches: [],
                count: 0,
                stopped: `the check's ${deadlineMs} ms for running patterns ran out before this rule`,
                lowerBound: true,
              }
            : await findPattern(
                session,
                text,
                rule.value,
                rule.caseSensitive === true ? "" : "i",
                left,
                ctx,
              );
        if ("refused" in run) {
          outcomes.push({
            id: rule.id,
            kind: rule.kind,
            status: "error",
            message: `rule not evaluated: invalid regular expression /${rule.value}/ — ${run.refused}`,
            matches: [],
            matchCount: 0,
          });
          continue;
        }
        found = run;
      } else {
        // A literal: linear to search, so it runs here, counted in full and
        // located for the first few.
        literals ??= new LiteralSearch(text);
        const { matches, count } = literals.find(
          rule.value,
          rule.caseSensitive === true,
          MAX_MATCHES_PER_RULE,
        );
        found = { matches, count, lowerBound: false };
      }
      outcomes.push(judge(rule, found, starts));
    }
  } finally {
    session?.close();
  }

  const counts: Record<PolicyOutcome["status"], number> = { pass: 0, fail: 0, review: 0, error: 0 };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  outcomes.sort((a, b) => compareStrings(a.id, b.id));
  return { pass: counts.fail === 0 && counts.error === 0, outcomes, counts };
}

/**
 * One rule's outcome from what its scan found. A scan that stopped early is
 * a verdict only when what it found already decides the rule; otherwise the
 * rule was not evaluated, and says why.
 */
function judge(rule: PolicyRule, found: Found, starts: ReadonlyArray<number>): PolicyOutcome {
  const matches: PolicyMatch[] = [];
  for (const { index, match } of found.matches) {
    const { line, column } = locate(starts, index);
    matches.push({ line, column, excerpt: match.slice(0, EXCERPT_CHARS) });
  }
  const matchCount = found.count;
  const present = matchCount > 0;
  const atLeast = found.lowerBound ? { matchCountIsLowerBound: true as const } : {};
  const describe = rule.description === undefined ? "" : ` (${rule.description})`;
  if (!present && found.stopped !== undefined) {
    return {
      id: rule.id,
      kind: rule.kind,
      status: "error",
      message: `rule not evaluated: ${found.stopped} — nothing had matched before it stopped, which is not the same as nothing matching${describe}`,
      matches: [],
      matchCount: 0,
      ...atLeast,
    };
  }
  const count = found.lowerBound ? `at least ${matchCount}` : `${matchCount}`;
  if (rule.kind === "required_phrase" || rule.kind === "required_pattern") {
    return {
      id: rule.id,
      kind: rule.kind,
      status: present ? "pass" : "fail",
      message: present
        ? `required text found ${count} time(s)${describe}`
        : `required text is absent${describe}`,
      // A required rule that passed needs no locations; one that failed has none.
      matches: [],
      matchCount,
      ...atLeast,
    };
  }
  if (rule.kind === "review_pattern") {
    return {
      id: rule.id,
      kind: rule.kind,
      status: present ? "review" : "pass",
      message: present
        ? `${count} passage(s) need a human decision${describe}`
        : `nothing matched${describe}`,
      matches,
      matchCount,
      ...atLeast,
    };
  }
  return {
    id: rule.id,
    kind: rule.kind,
    status: present ? "fail" : "pass",
    message: present
      ? `forbidden text found ${count} time(s)${describe}`
      : `forbidden text is absent${describe}`,
    matches,
    matchCount,
    ...atLeast,
  };
}
