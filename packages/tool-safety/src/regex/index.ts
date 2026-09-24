/**
 * `@crewhaus/tool-safety/regex` — caller-supplied regular expressions.
 *
 * - {@link compileUserRegex} / {@link screenUserRegex}: synchronous length,
 *   flag, syntax and catastrophic-shape checks with named reasons, bounded
 *   by a work budget and cached per pattern.
 * - {@link runRegex} / {@link openRegexSession}: the match itself, in a
 *   worker that is terminated at the deadline, with a tri-state answer.
 */
export {
  REGEX_LIMIT_DEFAULTS,
  type RegexLimits,
  type RegexRejectCode,
  type RegexRejection,
  compileUserRegex,
  screenUserRegex,
} from "./screen";
export {
  type FirstMatchingRuleRequest,
  type FirstMatchingRuleResult,
  type MatchAllRequest,
  type MatchAllResult,
  type OnGiveUp,
  REGEX_RUN_DEFAULTS,
  type RegexErrorCode,
  type RegexMatch,
  type RegexOp,
  type RegexOutcome,
  type RegexRequest,
  type RegexRule,
  type RegexSession,
  type RegexVerdict,
  type ReplaceEachRequest,
  type ReplaceEachResult,
  type ReplaceRequest,
  type ReplaceResult,
  type ResultOf,
  type SplitRequest,
  type SplitResult,
  type TestEachRequest,
  type TestEachResult,
  type TestMatrixRequest,
  type TestMatrixResult,
  type TestRequest,
  type TestResult,
  describeRegexOutcome,
  openRegexSession,
  regexVerdict,
  regexWorkerCounts,
  runRegex,
} from "./run";
