/**
 * Rule-directed routing (§7.2.2) — pure, first-match, replayable.
 *
 * Rules are evaluated in `preRoute` before the policy, over `RouteSignals`.
 * Every present condition in a rule's `when:` must hold; the first enabled
 * rule that matches wins and its `id` is persisted on the `model_route` line.
 *
 * Three guards on `when.message_matches`, because on a channel shape that
 * regex runs against attacker-controlled text:
 *   1. compile-time validation (`validateRuleRegex`) rejecting nested
 *      quantifiers — the shape that goes catastrophic;
 *   2. an input length cap (`maxTextChars`) — the text is truncated before
 *      the match;
 *   3. a per-evaluation time budget (`timeBudgetMs`) after which the REST of
 *      the rules that read the text are skipped and a `rule_skipped` reason
 *      is recorded. A synchronous regex cannot be interrupted, so 1 and 2
 *      prevent the blow-up and 3 bounds the damage of a pattern the
 *      validator did not catch.
 *
 * `deriveSignalRecord` is the persistable projection — derived values only,
 * never the user's text.
 */
import { fnv1a64 } from "./fingerprint.js";
import type { RouteRule, RouteRuleUse, RouteSignalRecord, RouteSignals } from "./types.js";

export type RuleSkip = {
  readonly ruleId: string;
  readonly reason: "rule_skipped:invalid-regex" | "rule_skipped:time-budget";
};

export type RuleMatch = {
  readonly ruleId: string;
  /** 0-based index into the rules array (first match wins). */
  readonly index: number;
  readonly use: RouteRuleUse;
};

export type EvaluateRulesResult = {
  readonly match?: RuleMatch;
  /** Rules that were disabled, or skipped by a guard, in evaluation order. */
  readonly skipped: readonly RuleSkip[];
};

export type EvaluateRulesOptions = {
  /** Cap on the user text length matched by `message_matches`. Default 8192. */
  readonly maxTextChars?: number;
  /** Wall-clock budget for all `message_matches` evaluations in one turn. Default 25 ms. */
  readonly timeBudgetMs?: number;
  /** Clock, injected for tests. Default `performance.now`. */
  readonly now?: () => number;
};

const DEFAULT_MAX_TEXT_CHARS = 8192;
const DEFAULT_TIME_BUDGET_MS = 25;

export function evaluateRules(
  rules: readonly RouteRule[],
  signals: RouteSignals,
  opts: EvaluateRulesOptions = {},
): EvaluateRulesResult {
  const maxChars = opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const budgetMs = opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const now = opts.now ?? ((): number => performance.now());
  const text = (signals.userText ?? "").slice(0, maxChars);
  const textChars = signals.userTextChars ?? signals.userText?.length ?? 0;
  const skipped: RuleSkip[] = [];
  let spentMs = 0;
  let textBudgetExhausted = false;

  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index] as RouteRule;
    if (rule.enabled === false) continue;
    const w = rule.when;
    let matched = true;

    if (w.has_images !== undefined && (signals.hasImages ?? false) !== w.has_images)
      matched = false;
    if (matched && w.user_text_chars_gt !== undefined && !(textChars > w.user_text_chars_gt)) {
      matched = false;
    }
    if (
      matched &&
      w.context_tokens_gt !== undefined &&
      !(signals.contextTokens > w.context_tokens_gt)
    ) {
      matched = false;
    }
    if (matched && w.tool_in_play !== undefined && signals.toolsInPlay !== w.tool_in_play) {
      matched = false;
    }
    if (matched && w.channel !== undefined && signals.channelHint !== w.channel) matched = false;
    if (
      matched &&
      w.budget_spent_ratio_gt !== undefined &&
      !((signals.budgetSpentRatio ?? 0) > w.budget_spent_ratio_gt)
    ) {
      matched = false;
    }
    if (matched && w.turn_index_lt !== undefined && !(signals.turnIndex < w.turn_index_lt)) {
      matched = false;
    }

    if (matched && w.message_matches !== undefined) {
      if (textBudgetExhausted) {
        skipped.push({ ruleId: rule.id, reason: "rule_skipped:time-budget" });
        continue;
      }
      const re = compileRuleRegex(w.message_matches);
      if (re === undefined) {
        skipped.push({ ruleId: rule.id, reason: "rule_skipped:invalid-regex" });
        continue;
      }
      const t0 = now();
      const hit = re.test(text);
      spentMs += now() - t0;
      if (spentMs > budgetMs) {
        // This rule's verdict stands (the match already ran); every later
        // text-reading rule is skipped for the turn.
        textBudgetExhausted = true;
      }
      if (!hit) matched = false;
    }

    if (matched) {
      return { match: { ruleId: rule.id, index, use: rule.use }, skipped };
    }
  }
  return { skipped };
}

/**
 * Compile-time validation of a `message_matches` pattern. Rejects a pattern
 * that fails to compile, one longer than 512 characters, and the nested-
 * quantifier shape (`(a+)+`, `(a*)*`, `(a+)*`, `(a|aa)+`-style alternation
 * under a quantifier) that makes backtracking exponential. Returns the
 * reason, or `undefined` when acceptable. Deliberately conservative: a rule
 * regex is a routing heuristic, so a false rejection costs a rewrite while a
 * false acceptance costs the hot path.
 */
export function validateRuleRegex(pattern: string): string | undefined {
  if (pattern.length > 512) return "pattern longer than 512 characters";
  const { source, flags } = splitInlineFlags(pattern);
  try {
    new RegExp(source, flags);
  } catch (err) {
    return `pattern does not compile: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (hasNestedQuantifier(source)) {
    return "nested quantifier (a quantified group containing a quantifier or alternation) is rejected — it backtracks exponentially on adversarial input";
  }
  return undefined;
}

/** `validateRuleRegex` + compile, with a small per-process cache. `undefined` when invalid. */
function compileRuleRegex(pattern: string): RegExp | undefined {
  const cached = REGEX_CACHE.get(pattern);
  if (cached !== undefined) return cached === null ? undefined : cached;
  const problem = validateRuleRegex(pattern);
  if (problem !== undefined) {
    REGEX_CACHE.set(pattern, null);
    return undefined;
  }
  const { source, flags } = splitInlineFlags(pattern);
  const re = new RegExp(source, flags);
  REGEX_CACHE.set(pattern, re);
  return re;
}

/**
 * JS regexes have no inline `(?i)` modifier, but rule authors coming from
 * PCRE / Python write it (the plan's own example does). A LEADING `(?i)`,
 * `(?s)`, `(?m)` or a combination is lifted to the equivalent flag; anywhere
 * else it fails to compile and the validator rejects it.
 */
function splitInlineFlags(pattern: string): { readonly source: string; readonly flags: string } {
  const m = /^\(\?([ims]+)\)/.exec(pattern);
  if (m === null) return { source: pattern, flags: "" };
  const flags = [...new Set((m[1] as string).split(""))].join("");
  return { source: pattern.slice(m[0].length), flags };
}

const REGEX_CACHE = new Map<string, RegExp | null>();

/**
 * Walk the pattern tracking group depth. A quantifier (`+`, `*`, `{n,}`, or
 * `?` after a group close) applied to a group that itself contained a
 * quantifier or an alternation is the rejected shape. Escapes and character
 * classes are skipped so `[+*]` and `\+` never count.
 */
function hasNestedQuantifier(pattern: string): boolean {
  // Per open group: did it contain a quantifier or a `|`?
  const stack: Array<{ risky: boolean }> = [];
  let lastClosedRisky = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "\\") {
      i++;
      lastClosedRisky = false;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      lastClosedRisky = false;
      continue;
    }
    if (ch === "(") {
      stack.push({ risky: false });
      lastClosedRisky = false;
      // Skip a group-kind prefix — `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`,
      // `(?<name>` — so its `?` is never read as a quantifier.
      if (pattern[i + 1] === "?") {
        i += 2;
        if (pattern[i] === "<" && pattern[i + 1] !== "=" && pattern[i + 1] !== "!") {
          const close = pattern.indexOf(">", i);
          i = close === -1 ? pattern.length : close;
        }
      }
      continue;
    }
    if (ch === ")") {
      const closed = stack.pop();
      lastClosedRisky = closed?.risky ?? false;
      continue;
    }
    const isQuantifier = ch === "+" || ch === "*" || ch === "{" || ch === "?";
    if (isQuantifier) {
      // `(a+)?` is bounded (0 or 1) and NOT the exponential shape, so `?`
      // after a risky group is allowed; `+`, `*` and `{n,}` are not.
      if (lastClosedRisky && ch !== "?") return true;
      for (const g of stack) g.risky = true;
      lastClosedRisky = false;
      continue;
    }
    if (ch === "|") {
      for (const g of stack) g.risky = true;
    }
    lastClosedRisky = false;
  }
  return false;
}

/** The persisted, derived-only projection of a turn's signals — never the text. */
export function deriveSignalRecord(signals: RouteSignals): RouteSignalRecord {
  const chars = signals.userTextChars ?? signals.userText?.length;
  return {
    contextTokens: signals.contextTokens,
    toolsInPlay: signals.toolsInPlay,
    turnIndex: signals.turnIndex,
    priorTurnToolUseCount: signals.priorTurnToolUseCount,
    ...(chars !== undefined ? { userTextChars: chars } : {}),
    ...(signals.userText !== undefined ? { userTextHash: fnv1a64(signals.userText) } : {}),
    ...(signals.hasImages !== undefined ? { hasImages: signals.hasImages } : {}),
    ...(signals.toolNamesLastTurn !== undefined
      ? { toolNamesLastTurn: [...signals.toolNamesLastTurn] }
      : {}),
    ...(signals.budgetSpentRatio !== undefined
      ? { budgetSpentRatio: signals.budgetSpentRatio }
      : {}),
    ...(signals.channelHint !== undefined ? { channelHint: signals.channelHint } : {}),
  };
}
