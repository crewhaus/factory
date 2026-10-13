/**
 * Ordered branching over a value.
 *
 * The question "does this value satisfy this condition?" is answered by
 * `runChecks` from `@crewhaus/tool-schema`, which is the same evaluator the
 * `Assert` tool uses. There is deliberately no second condition vocabulary
 * here: an operator who learns `startsWith` from Assert gets the same
 * operator, with the same semantics, in a branch.
 */
import { type Check, type RegexAnswers, checksVerdict, runChecks } from "@crewhaus/tool-schema";

/** Whether every check must hold, or any one of them. */
export type MatchMode = "all" | "any";

/** One arm of the branch. `when` is never empty — see {@link evaluateBranches}. */
export type BranchRule = {
  readonly name: string;
  readonly when: ReadonlyArray<Check>;
  readonly match?: MatchMode;
  /** Handed back verbatim when this arm wins. Any JSON value. */
  readonly result?: unknown;
};

/** Why one arm did or did not match, for the caller that has to debug it. */
export type ArmReport = {
  readonly name: string;
  readonly index: number;
  readonly ok: boolean;
  readonly passed: number;
  readonly failed: number;
  /** The first failing check's reason; empty when the arm matched. */
  readonly reason: string;
  /** Set when the arm could not be decided: a pattern had no answer. */
  readonly undetermined?: true;
};

export type BranchOutcome = {
  readonly matched: boolean;
  /** The winning arm's name, or the fallback's, or null when nothing matched. */
  readonly name: string | null;
  /** Index into the declared arms; null for the fallback and for no match. */
  readonly index: number | null;
  readonly result: unknown;
  /** True when `name` came from `otherwise` rather than from an arm. */
  readonly fallback: boolean;
  /** Every arm evaluated, in order, up to and including the winner. */
  readonly evaluated: ReadonlyArray<ArmReport>;
  /**
   * Why no route was taken, when an arm could not be decided: its pattern
   * had no answer. Later arms and `otherwise` are not tried, because the
   * undecided arm might have been the one that matched.
   */
  readonly undetermined?: string;
};

export type BranchOptions = {
  /** Used when no arm matches. Without it, a miss returns `matched: false`. */
  readonly otherwise?: { readonly name: string; readonly result?: unknown };
  /** Answers for the arms' `matches` patterns, resolved by the caller in the worker. */
  readonly regex?: RegexAnswers;
};

/**
 * Evaluate `rules` against `value` in order and return the first match.
 *
 * Arms after the winner are not evaluated, so a later arm's malformed check
 * cannot affect an earlier arm's decision — and the report says exactly how
 * far evaluation got.
 *
 * Two shapes are rejected rather than accommodated, because both read as
 * working and do not:
 *
 * - **An arm with no checks.** Under `all` an empty check list is vacuously
 *   true, so such an arm swallows everything after it while looking like a
 *   rule. A catch-all is spelled `otherwise`, which cannot be mistaken for a
 *   condition.
 * - **Two arms with one name.** The name is what the caller routes on. If
 *   two arms share one, the route is ambiguous at the point it is used,
 *   which is far from the table that caused it.
 */
export function evaluateBranches(
  value: unknown,
  rules: ReadonlyArray<BranchRule>,
  options: BranchOptions = {},
): BranchOutcome {
  if (rules.length === 0) throw new Error("no branch arms were given");

  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.when.length === 0) {
      throw new Error(
        `branch "${rule.name}" has no checks — an arm with no checks always matches; use "otherwise" for a catch-all`,
      );
    }
    if (seen.has(rule.name)) throw new Error(`two branch arms are both named "${rule.name}"`);
    seen.add(rule.name);
  }

  const evaluated: ArmReport[] = [];
  for (const [index, rule] of rules.entries()) {
    const mode: MatchMode = rule.match ?? "all";
    const report = runChecks(
      value,
      rule.when as Check[],
      options.regex === undefined ? {} : { regex: options.regex },
    );
    const verdict = checksVerdict(report, mode);
    const ok = verdict === "pass";
    const undecided = report.failures.find((f) => f.undetermined === true);
    evaluated.push({
      name: rule.name,
      index,
      ok,
      passed: report.passed,
      failed: report.failed,
      reason: ok
        ? ""
        : ((verdict === "undetermined" ? undecided?.reason : undefined) ??
          report.failures[0]?.reason ??
          ""),
      ...(verdict === "undetermined" ? { undetermined: true as const } : {}),
    });
    if (verdict === "undetermined") {
      // A router that fell through here would take a later arm, or the
      // default, on the strength of an answer it never got.
      return {
        matched: false,
        name: null,
        index: null,
        result: undefined,
        fallback: false,
        evaluated,
        undetermined: `arm "${rule.name}" could not be decided: ${undecided?.reason ?? "a check had no answer"}`,
      };
    }
    if (ok) {
      return {
        matched: true,
        name: rule.name,
        index,
        result: rule.result,
        fallback: false,
        evaluated,
      };
    }
  }

  if (options.otherwise) {
    return {
      matched: true,
      name: options.otherwise.name,
      index: null,
      result: options.otherwise.result,
      fallback: true,
      evaluated,
    };
  }
  return { matched: false, name: null, index: null, result: undefined, fallback: false, evaluated };
}
