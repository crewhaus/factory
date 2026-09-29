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
import {
  CALLER_PATTERN_DEADLINE_MS,
  type Check,
  MAX_PATTERN_QUESTIONS,
  type RegexAnswer,
  RegexAnswers,
  type RegexRunContext,
  askCheckPatterns,
  runChecks,
  testPatternSync,
} from "@crewhaus/tool-schema";

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

/** Blocking rules a review reason names with their reasons; the rest are counted. */
const NAMED_IN_REASON = 3;

/**
 * Validate the rules once, and return the screen's verdict per pattern: a
 * refused pattern is refused whatever it is run on, so each is screened
 * once, on the empty string.
 */
function prepareRules(rules: ReadonlyArray<CodingRule>): (check: Check) => string | undefined {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.when.length === 0) {
      throw new Error(`rule "${rule.id}" has no conditions, so it would code every line`);
    }
    if (seen.has(rule.id)) throw new Error(`two rules share the id "${rule.id}"`);
    seen.add(rule.id);
  }
  const refusals = new Map<string, string | undefined>();
  return (check: Check): string | undefined => {
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
}

type CodeOptions = {
  readonly version?: string;
  readonly defaultAccount?: string;
};

export function codeLines(
  lines: ReadonlyArray<{ readonly id: string } & Record<string, unknown>>,
  rules: ReadonlyArray<CodingRule>,
  options: CodeOptions & {
    /**
     * The rules' `matches` patterns, answered in the regex worker (see
     * tool-schema's `askCheckPatterns`). Without it they run bounded on this
     * thread. {@link codeLinesAnsweringPatterns} asks and answers them.
     */
    readonly regex?: RegexAnswers;
  } = {},
): CodingResult {
  const refused = prepareRules(rules);
  return summarize(
    lines.map((line) => codeLine(line, rules, options.regex, refused, options.defaultAccount)),
    options.version,
  );
}

/** Answers every question as undetermined, for lines reached after the pattern budget ran out. */
class Unanswered extends RegexAnswers {
  constructor(private readonly why: string) {
    super();
  }

  override lookup(): RegexAnswer {
    return { undetermined: this.why };
  }
}

/**
 * Chunks whose patterns get tool-schema's per-call budget each, at most: a
 * batch of benign patterns is answered in full up to the schema's limits,
 * and a runaway pattern costs a worker thirty seconds at worst (0.7.0 ran
 * the same batch on the caller's thread with no bound at all).
 */
const MAX_BUDGETED_CHUNKS = 6;

/**
 * {@link codeLines} with the rules' patterns answered in the regex worker, a
 * chunk of lines at a time.
 *
 * One `RegexAnswers` takes at most tool-schema's `MAX_PATTERN_QUESTIONS`
 * distinct pattern questions and answers any past that as undetermined. A
 * line asks one per pattern condition, so 5 000 lines under 201 one-pattern
 * rules — well inside the schema's 5 000 lines and 1 000 rules — asked more,
 * and every line past the cap went to review uncoded where 0.7.0 coded it
 * (bounds review). So the lines are cut into chunks that cannot ask more
 * than the cap (`maxQuestions`, for tests), each asked, answered and coded
 * in turn.
 *
 * The patterns share one budget, counted only while they run: tool-schema's
 * `CALLER_PATTERN_DEADLINE_MS` per chunk, for at most
 * {@link MAX_BUDGETED_CHUNKS} chunks (`deadlineMs` overrides it). Lines
 * reached after it ran out, or after the call was cancelled, are not asked
 * about: their pattern conditions are undetermined, and they go to review.
 */
export async function codeLinesAnsweringPatterns(
  lines: ReadonlyArray<{ readonly id: string } & Record<string, unknown>>,
  rules: ReadonlyArray<CodingRule>,
  options: CodeOptions & {
    readonly run?: RegexRunContext;
    readonly deadlineMs?: number;
    readonly maxQuestions?: number;
  } = {},
): Promise<CodingResult> {
  const refused = prepareRules(rules);
  let perLine = 0;
  for (const rule of rules) {
    for (const check of rule.when) {
      if (
        (check.op === "matches" || check.op === "notMatches") &&
        typeof check.expected === "string"
      ) {
        perLine += 1;
      }
    }
  }
  const cap = Math.max(1, options.maxQuestions ?? MAX_PATTERN_QUESTIONS);
  const perChunk = perLine === 0 ? lines.length : Math.max(1, Math.floor(cap / perLine));
  const chunks = Math.max(1, Math.ceil(lines.length / Math.max(1, perChunk)));
  const size = Math.max(1, Math.ceil(lines.length / chunks));
  const budgetMs =
    options.deadlineMs ?? CALLER_PATTERN_DEADLINE_MS * Math.min(chunks, MAX_BUDGETED_CHUNKS);
  const run = options.run ?? {};
  let spent = 0;
  const coded: CodedLine[] = [];
  for (let from = 0; from < lines.length; from += size) {
    const chunk = lines.slice(from, from + size);
    const left = Math.floor(budgetMs - spent);
    let regex: RegexAnswers;
    if (perLine > 0 && run.signal?.aborted === true) {
      regex = new Unanswered("the call was cancelled before this line's patterns could run");
    } else if (perLine > 0 && left < 1) {
      regex = new Unanswered(
        `the call's ${budgetMs} ms for running patterns ran out before this line's could run`,
      );
    } else {
      regex = new RegexAnswers();
      if (perLine > 0) {
        for (const line of chunk) {
          for (const rule of rules) askCheckPatterns(line, rule.when as Check[], regex);
        }
        const began = performance.now();
        await regex.resolve(run, { deadlineMs: left });
        spent += performance.now() - began;
      }
    }
    for (const line of chunk) {
      coded.push(codeLine(line, rules, regex, refused, options.defaultAccount));
    }
  }
  return summarize(coded, options.version);
}

function codeLine(
  line: { readonly id: string } & Record<string, unknown>,
  rules: ReadonlyArray<CodingRule>,
  regex: RegexAnswers | undefined,
  refused: (check: Check) => string | undefined,
  defaultAccount: string | undefined,
): CodedLine {
  const verdicts = rules.map((rule) => ({
    rule,
    ...ruleVerdict(line, rule, regex, refused),
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
    // A few named with their reasons; every one is in `undetermined`. A
    // batch whose patterns all went unanswered would otherwise repeat a
    // reason per rule on every line.
    const shown = blocking.slice(0, NAMED_IN_REASON).map((v) => `"${v.rule.id}" (${v.reason})`);
    const more = blocking.length - shown.length;
    const named =
      more > 0 ? `${shown.join(", ")} and ${more} more (see undetermined)` : shown.join(", ");
    return {
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
    };
  }

  if (matches.length === 0) {
    return {
      lineId: line.id,
      account: defaultAccount ?? null,
      costCenter: null,
      taxCode: null,
      matched: [],
      ambiguous: false,
      // A default account is a place to put it, not a coding decision, so
      // the line still goes to review rather than quietly landing in a
      // suspense account nobody looks at.
      needsReview: true,
      reason: "no rule matched",
    };
  }

  const top = matches[0] as CodingRule;
  const topPriority = top.priority ?? 0;
  const tied = matches.filter((r) => (r.priority ?? 0) === topPriority);
  // Two rules at the same priority disagreeing is a rule-set bug. Picking
  // one would hide it, and the wrong account is found in an audit, not in
  // a test.
  const conflicting = tied.some((r) => r.account !== top.account);

  return {
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
  };
}

function summarize(results: ReadonlyArray<CodedLine>, version: string | undefined): CodingResult {
  const tally = new Map<string, number>();
  for (const line of results) {
    if (line.account === null || line.needsReview) continue;
    tally.set(line.account, (tally.get(line.account) ?? 0) + 1);
  }

  return {
    lines: results,
    coded: results.filter((l) => !l.needsReview).length,
    needsReview: results.filter((l) => l.needsReview).length,
    version: version ?? null,
    byAccount: [...tally.entries()]
      .map(([account, count]) => ({ account, lines: count }))
      .sort((a, b) => b.lines - a.lines || (a.account < b.account ? -1 : 1)),
  };
}
