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
 * ## The regex is the operator's, and it runs untimed
 *
 * `*_pattern` rules compile caller-supplied regex sources and run them over
 * text up to the package's 2,000,000-character cap. JavaScript's engine
 * backtracks, so a pattern like `(a+)+$` can take time exponential in the
 * length of the text it fails on. There is no timeout here, because there is
 * no way to interrupt a regex mid-match in this runtime. The rules are
 * operator-written, not attacker-written, which is what makes this
 * acceptable — but an operator who pastes a pattern from untrusted content
 * has handed that content a stall. Write anchored patterns with no nested
 * unbounded quantifier.
 */
import { compareStrings, matchAll } from "./text";
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

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Evaluate every rule against the text. One pass per rule, no early exit. */
export function evaluatePolicy(text: string, rules: ReadonlyArray<PolicyRule>): PolicyResult {
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

  for (const rule of rules) {
    const flags = rule.caseSensitive === true ? "g" : "gi";
    const isPattern = rule.kind.endsWith("_pattern");
    let re: RegExp;
    try {
      re = new RegExp(isPattern ? rule.value : escapeRegex(rule.value), flags);
    } catch (err) {
      outcomes.push({
        id: rule.id,
        kind: rule.kind,
        status: "error",
        message: `rule not evaluated: invalid regular expression /${rule.value}/ — ${(err as Error).message}`,
        matches: [],
        matchCount: 0,
      });
      continue;
    }

    const matches: PolicyMatch[] = [];
    let matchCount = 0;
    for (const { index, match } of matchAll(text, re)) {
      matchCount += 1;
      if (matches.length < MAX_MATCHES_PER_RULE) {
        const { line, column } = locate(starts, index);
        matches.push({ line, column, excerpt: match[0].slice(0, EXCERPT_CHARS) });
      }
    }

    const present = matchCount > 0;
    const describe = rule.description === undefined ? "" : ` (${rule.description})`;
    if (rule.kind === "required_phrase" || rule.kind === "required_pattern") {
      outcomes.push({
        id: rule.id,
        kind: rule.kind,
        status: present ? "pass" : "fail",
        message: present
          ? `required text found ${matchCount} time(s)${describe}`
          : `required text is absent${describe}`,
        // A required rule that passed needs no locations; one that failed has none.
        matches: [],
        matchCount,
      });
      continue;
    }
    if (rule.kind === "review_pattern") {
      outcomes.push({
        id: rule.id,
        kind: rule.kind,
        status: present ? "review" : "pass",
        message: present
          ? `${matchCount} passage(s) need a human decision${describe}`
          : `nothing matched${describe}`,
        matches,
        matchCount,
      });
      continue;
    }
    outcomes.push({
      id: rule.id,
      kind: rule.kind,
      status: present ? "fail" : "pass",
      message: present
        ? `forbidden text found ${matchCount} time(s)${describe}`
        : `forbidden text is absent${describe}`,
      matches,
      matchCount,
    });
  }

  const counts: Record<PolicyOutcome["status"], number> = { pass: 0, fail: 0, review: 0, error: 0 };
  for (const outcome of outcomes) counts[outcome.status] += 1;
  outcomes.sort((a, b) => compareStrings(a.id, b.id));
  return { pass: counts.fail === 0 && counts.error === 0, outcomes, counts };
}
