/**
 * Additive rule scoring with an attributable breakdown.
 *
 * Any "score this thing and decide which band it lands in" job — lead
 * qualification, risk, triage priority — is a table lookup plus addition.
 * The reason to do it here rather than in a model is not only cost: a score
 * a model produced cannot be explained to the person it affects, and cannot
 * be re-run identically next quarter. This returns the contributors, and the
 * version of the rules that produced them.
 */
import { decimalKernel } from "@crewhaus/tool-math";
import { type Check, type RegexAnswers, checksVerdict, runChecks } from "@crewhaus/tool-schema";

type Decimal = decimalKernel.Decimal;
const { align, decimalAdd, decimalToNumber, parseDecimal } = decimalKernel;

/**
 * `a` compared with `b`, exactly: -1, 0 or 1. A bound of -Infinity or
 * Infinity (a library caller's, since JSON cannot spell one) compares as
 * what it is rather than failing the parse.
 */
function compareExact(a: Decimal, b: number): number {
  if (b === Number.NEGATIVE_INFINITY) return 1;
  if (b === Number.POSITIVE_INFINITY) return -1;
  const aligned = align(a, parseDecimal(b));
  return aligned.a < aligned.b ? -1 : aligned.a > aligned.b ? 1 : 0;
}

export type ScoreRule = {
  readonly id: string;
  /** All of these must hold for the points to be awarded. */
  readonly when: ReadonlyArray<Check>;
  readonly points: number;
  /** Human-readable reason, for the note that goes on the record. */
  readonly label?: string;
};

export type ScoreBand = {
  readonly name: string;
  /** Inclusive lower bound. The highest band whose min is met wins. */
  readonly min: number;
};

export type ScoreModel = {
  readonly version?: string;
  readonly rules: ReadonlyArray<ScoreRule>;
  readonly bands?: ReadonlyArray<ScoreBand>;
  /** Clamp the total into this range after summing. */
  readonly min?: number;
  readonly max?: number;
};

export type ScoreResult = {
  /** Null when a rule could not be decided: its points may or may not count. */
  readonly score: number | null;
  /** The sum before clamping, which differs from `score` when it was clamped. */
  readonly rawScore: number | null;
  readonly band: string | null;
  readonly version: string | null;
  readonly contributors: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly points: number;
  }>;
  /** Rules that did not fire, with the first reason they did not. */
  readonly missed: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  /**
   * Rules that could not be decided (a pattern had no answer), with why. When
   * any is listed, `score`, `rawScore` and `band` are null: a total that left
   * their points out would be a guess.
   */
  readonly undetermined?: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
};

export function scoreValue(
  value: unknown,
  model: ScoreModel,
  options: { readonly regex?: RegexAnswers } = {},
): ScoreResult {
  if (model.rules.length === 0) throw new Error("the scoring model has no rules");

  const seen = new Set<string>();
  for (const rule of model.rules) {
    if (rule.when.length === 0) {
      throw new Error(`rule "${rule.id}" has no checks, so it would always award its points`);
    }
    if (seen.has(rule.id)) throw new Error(`two rules share the id "${rule.id}"`);
    seen.add(rule.id);
    if (!Number.isFinite(rule.points)) {
      throw new Error(`rule "${rule.id}" has non-finite points`);
    }
  }
  if (model.min !== undefined && model.max !== undefined && model.min > model.max) {
    throw new Error(`min (${model.min}) is above max (${model.max})`);
  }

  const contributors: Array<{ id: string; label: string; points: number }> = [];
  const missed: Array<{ id: string; reason: string }> = [];
  // Summed as exact decimals, not doubles. Points are decimal literals, and
  // String(number) gives that literal back, so the sum is the one a person
  // adds up by hand: 0.7 + 0.1 is 0.8 and lands in a band at 0.8, where the
  // float sum 0.7999999999999999 missed it. Exact addition is also
  // associative, so the band no longer depends on the order the rules were
  // declared in (0.1 + 0.1 + 0.6 and 0.6 + 0.1 + 0.1 used to band apart).
  let exact: Decimal = { unscaled: 0n, scale: 0 };

  const undecided: Array<{ id: string; reason: string }> = [];
  for (const rule of model.rules) {
    const report = runChecks(
      value,
      rule.when as Check[],
      options.regex === undefined ? {} : { regex: options.regex },
    );
    const verdict = checksVerdict(report, "all");
    if (verdict === "pass") {
      exact = decimalAdd(exact, parseDecimal(rule.points));
      contributors.push({ id: rule.id, label: rule.label ?? rule.id, points: rule.points });
    } else if (verdict === "undetermined") {
      const why = report.failures.find((f) => f.undetermined === true)?.reason ?? "";
      undecided.push({ id: rule.id, reason: why });
    } else {
      missed.push({ id: rule.id, reason: report.failures[0]?.reason ?? "" });
    }
  }
  if (undecided.length > 0) {
    return {
      score: null,
      rawScore: null,
      band: null,
      version: model.version ?? null,
      contributors,
      missed,
      undetermined: undecided,
    };
  }

  const rawScore = decimalToNumber(exact);
  let score = rawScore;
  let clamped: Decimal = exact;
  if (model.min !== undefined && compareExact(clamped, model.min) < 0) {
    score = model.min;
    clamped = parseDecimal(model.min);
  }
  if (model.max !== undefined && compareExact(clamped, model.max) > 0) {
    score = model.max;
    clamped = parseDecimal(model.max);
  }

  let band: string | null = null;
  if (model.bands && model.bands.length > 0) {
    // Highest qualifying band wins, whatever order they were declared in, so
    // a table written low-to-high and one written high-to-low agree.
    const sorted = [...model.bands].sort((a, b) => b.min - a.min);
    band = sorted.find((b) => compareExact(clamped, b.min) >= 0)?.name ?? null;
  }

  return { score, rawScore, band, version: model.version ?? null, contributors, missed };
}
