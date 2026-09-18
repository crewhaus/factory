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
import { type Check, runChecks } from "@crewhaus/tool-schema";

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
};

export type CodingResult = {
  readonly lines: ReadonlyArray<CodedLine>;
  readonly coded: number;
  readonly needsReview: number;
  readonly version: string | null;
  readonly byAccount: ReadonlyArray<{ readonly account: string; readonly lines: number }>;
};

export function codeLines(
  lines: ReadonlyArray<{ readonly id: string } & Record<string, unknown>>,
  rules: ReadonlyArray<CodingRule>,
  options: { readonly version?: string; readonly defaultAccount?: string } = {},
): CodingResult {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.when.length === 0) {
      throw new Error(`rule "${rule.id}" has no conditions, so it would code every line`);
    }
    if (seen.has(rule.id)) throw new Error(`two rules share the id "${rule.id}"`);
    seen.add(rule.id);
  }

  const results: CodedLine[] = [];
  for (const line of lines) {
    const matches = rules
      .filter((rule) => runChecks(line, rule.when as Check[]).ok)
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

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
