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
import { type Check, runChecks } from "@crewhaus/tool-schema";

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
  readonly score: number;
  /** The sum before clamping, which differs from `score` when it was clamped. */
  readonly rawScore: number;
  readonly band: string | null;
  readonly version: string | null;
  readonly contributors: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly points: number;
  }>;
  /** Rules that did not fire, with the first reason they did not. */
  readonly missed: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
};

export function scoreValue(value: unknown, model: ScoreModel): ScoreResult {
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
  let rawScore = 0;

  for (const rule of model.rules) {
    const report = runChecks(value, rule.when as Check[]);
    if (report.ok) {
      rawScore += rule.points;
      contributors.push({ id: rule.id, label: rule.label ?? rule.id, points: rule.points });
    } else {
      missed.push({ id: rule.id, reason: report.failures[0]?.reason ?? "" });
    }
  }

  let score = rawScore;
  if (model.min !== undefined) score = Math.max(model.min, score);
  if (model.max !== undefined) score = Math.min(model.max, score);

  let band: string | null = null;
  if (model.bands && model.bands.length > 0) {
    // Highest qualifying band wins, whatever order they were declared in, so
    // a table written low-to-high and one written high-to-low agree.
    const sorted = [...model.bands].sort((a, b) => b.min - a.min);
    band = sorted.find((b) => score >= b.min)?.name ?? null;
  }

  return { score, rawScore, band, version: model.version ?? null, contributors, missed };
}
