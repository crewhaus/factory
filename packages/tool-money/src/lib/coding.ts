/**
 * Code invoice lines to a GL account and cost centre from operator rules.
 *
 * Most lines on most invoices are routine and code the same way every month.
 * Spending a model turn on each one costs tokens and, worse, produces a
 * coding nobody can reproduce at year end. Rules code the routine ones
 * identically forever and leave the genuinely unclear ones in a review
 * queue, which is the only part a person should see.
 *
 * Conditions are `@crewhaus/tool-schema`'s check grammar, the same one
 * `Assert` and `Branch` use.
 */
import { type Check, type RegexAnswers, runChecks, testPatternSync } from "@crewhaus/tool-schema";

export type CodingRule = {
  readonly id: string;
  readonly when: ReadonlyArray<Check>;
  readonly account: string;
  readonly costCenter?: string;
  readonly taxCode?: string;
  /** Higher wins when several rules match. Defaults to 0. */
  readonly priority?: number;
};

export type CodedLine = {
  readonly lineId: string;
  readonly account: string | null;
  readonly costCenter: string | null;
  readonly taxCode: string | null;
  /** Rule ids that matched, highest priority first. */
  readonly matched: ReadonlyArray<string>;
  /** True when more than one rule matched at the winning priority. */
  readonly ambiguous: boolean;
  readonly needsReview: boolean;
  readonly reason: string;
  /**
   * Rules whose conditions could not be evaluated on this line (a pattern
   * that could not be run to an answer, or one refused as invalid), when
   * any could have decided it. The line then goes to review uncoded: a
   * rule that might have matched is not a rule that did not.
   */
  readonly undetermined?: ReadonlyArray<string>;
};

export type CodingResult = {
  readonly lines: ReadonlyArray<CodedLine>;
  readonly coded: number;
  readonly needsReview: number;
  readonly version: string | null;
  readonly byAccount: ReadonlyArray<{ readonly account: string; readonly lines: number }>;
};

type RuleVerdict =
  | { readonly verdict: "pass" | "fail" }
  | { readonly verdict: "undetermined"; readonly reason: string };

/**
 * Whether `rule` holds for `line`, three ways. A condition whose pattern
 * could not be run to an answer is undetermined, and so is one whose
 * pattern the screen refused: the rule is malformed, and reading it as "did
 * not match" let a lower-priority rule code the line (C073). A condition
 * that definitely failed still decides the rule.
 */
function ruleVerdict(
  line: Record<string, unknown>,
  rule: CodingRule,
  regex: RegexAnswers | undefined,
  refused: (check: Check) => string | undefined,
): RuleVerdict {
  const report = runChecks(line, rule.when as Check[], regex === undefined ? {} : { regex });
  if (report.ok) return { verdict: "pass" };
  const open: string[] = [];
  for (const failure of report.failures) {
    const check = rule.when[failure.index] as Check;
    const refusal = refused(check);
    if (refusal !== undefined) open.push(refusal);
    else if (failure.undetermined === true) open.push(failure.reason);
    else return { verdict: "fail" };
  }
  return { verdict: "undetermined", reason: open.join("; ") };
}

export function codeLines(
  lines: ReadonlyArray<{ readonly id: string } & Record<string, unknown>>,
  rules: ReadonlyArray<CodingRule>,
  options: {
    readonly version?: string;
    readonly defaultAccount?: string;
    /**
     * The rules' `matches` patterns, answered in the regex worker (see
     * tool-schema's `askCheckPatterns`). Without it they run bounded on this
     * thread.
     */
    readonly regex?: RegexAnswers;
  } = {},
): CodingResult {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.when.length === 0) {
      throw new Error(`rule "${rule.id}" has no conditions, so it would code every line`);
    }
    if (seen.has(rule.id)) throw new Error(`two rules share the id "${rule.id}"`);
    seen.add(rule.id);
  }

  // A refused pattern is refused whatever it is run on, so it is screened
  // once per pattern, on the empty string.
  const refusals = new Map<string, string | undefined>();
  const refused = (check: Check): string | undefined => {
    if (check.op !== "matches" && check.op !== "notMatches") return undefined;
    if (typeof check.expected !== "string") return undefined;
    const flags = check.flags ?? "";
    const key = `${flags}\u0000${check.expected}`;
    if (!refusals.has(key)) {
      const answer = testPatternSync(check.expected, flags, "");
      refusals.set(
        key,
        typeof answer === "object" && "refused" in answer
          ? `invalid regex /${check.expected}/${flags}: ${answer.refused}`
          : undefined,
      );
    }
    return refusals.get(key);
  };

  const results: CodedLine[] = [];
  for (const line of lines) {
    const verdicts = rules.map((rule) => ({
      rule,
      ...ruleVerdict(line, rule, options.regex, refused),
    }));
    const matches = verdicts
      .filter((v) => v.verdict === "pass")
      .map((v) => v.rule)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    // A rule that could not be evaluated decides nothing, but it could have:
    // when it would outrank (or tie) whatever did match, or when nothing
    // did, the line is not coded.
    const bar = matches.length === 0 ? Number.NEGATIVE_INFINITY : (matches[0]?.priority ?? 0);
    const blocking = verdicts.filter(
      (v): v is typeof v & { verdict: "undetermined"; reason: string } =>
        v.verdict === "undetermined" && (v.rule.priority ?? 0) >= bar,
    );
    if (blocking.length > 0) {
      const named = blocking.map((v) => `"${v.rule.id}" (${v.reason})`).join(", ");
      results.push({
        lineId: line.id,
        account: null,
        costCenter: null,
        taxCode: null,
        matched: matches.map((r) => r.id),
        ambiguous: false,
        needsReview: true,
        reason:
          matches.length === 0
            ? `no rule definitely matched, and these could not be evaluated: ${named}`
            : `rule "${(matches[0] as CodingRule).id}" matched, but these could not be evaluated and would outrank or tie it: ${named}`,
        undetermined: blocking.map((v) => v.rule.id),
      });
      continue;
    }

    if (matches.length === 0) {
      results.push({
        lineId: line.id,
        account: options.defaultAccount ?? null,
        costCenter: null,
        taxCode: null,
        matched: [],
        ambiguous: false,
        // A default account is a place to put it, not a coding decision, so
        // the line still goes to review rather than quietly landing in a
        // suspense account nobody looks at.
        needsReview: true,
        reason: "no rule matched",
      });
      continue;
    }

    const top = matches[0] as CodingRule;
    const topPriority = top.priority ?? 0;
    const tied = matches.filter((r) => (r.priority ?? 0) === topPriority);
    // Two rules at the same priority disagreeing is a rule-set bug. Picking
    // one would hide it, and the wrong account is found in an audit, not in
    // a test.
    const conflicting = tied.some((r) => r.account !== top.account);

    results.push({
      lineId: line.id,
      account: conflicting ? null : top.account,
      costCenter: conflicting ? null : (top.costCenter ?? null),
      taxCode: conflicting ? null : (top.taxCode ?? null),
      matched: matches.map((r) => r.id),
      ambiguous: conflicting,
      needsReview: conflicting,
      reason: conflicting
        ? `rules ${tied.map((r) => `"${r.id}"`).join(", ")} match at the same priority and disagree on the account`
        : "",
    });
  }

  const tally = new Map<string, number>();
  for (const line of results) {
    if (line.account === null || line.needsReview) continue;
    tally.set(line.account, (tally.get(line.account) ?? 0) + 1);
  }

  return {
    lines: results,
    coded: results.filter((l) => !l.needsReview).length,
    needsReview: results.filter((l) => l.needsReview).length,
    version: options.version ?? null,
    byAccount: [...tally.entries()]
      .map(([account, count]) => ({ account, lines: count }))
      .sort((a, b) => b.lines - a.lines || (a.account < b.account ? -1 : 1)),
  };
}
