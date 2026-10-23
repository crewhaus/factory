/**
 * `@crewhaus/grader-provability` — the 0.8.0 provability release's eval layer
 * (design/0.8.0-provability-release.md §9.1): six DETERMINISTIC graders over
 * the proof bundle the eval runner captured for each sample
 * (`RunResult.artifacts.proof`), following the grader-continuity /
 * grader-12-metric-rubric conventions — one installer, per-sample scores,
 * a cross-sample roll-up.
 *
 *   provability.claimCoverage      met / (claims − assumptions) at the floor   ≥ 0.95
 *                                  (+ metadata.provability.expected_sources)
 *   provability.rungAchieved       the highest floor passed, rank/4            ≥ the floor
 *   provability.citationValidity   defined markers / markers                   ≥ 0.99
 *   provability.assumptionRate     declared assumptions / claims (LOWER wins)  ≤ 0.1
 *   provability.replayIntegrity    matched replays / replays                   = 1.0
 *   provability.costPerProvenClaim gate-caused spend per met claim             reported
 *
 * A sample's floor is `metadata.provability.level` when it sets one, else the
 * bundle's (the spec's floor, or `crewhaus eval --provability <level>`). A run
 * with no bundle fails every grader with {@link NO_PROOF_BUNDLE} — see
 * `./graders` for why a missing verdict is never a pass, and for the other
 * pinned "unmeasured" outcomes ({@link isUnmeasured}).
 *
 * Graders read only what the runner hands them; none calls a model, none
 * re-runs the verifier, none touches the harness's live stores (Pillar 2: the
 * eval layer measures end states, offline).
 */
import type { Grader } from "@crewhaus/eval-grader";
import type { GraderRegistry } from "@crewhaus/grader-registry";
import type { GatePricing } from "./cost";
import {
  assumptionRate,
  citationValidity,
  claimCoverage,
  costPerProvenClaim,
  createCostPerProvenClaim,
  replayIntegrity,
  rungAchieved,
} from "./graders";

export {
  FLOOR_ABOVE_BUNDLE,
  INFINITE_COST_PREFIX,
  INVALID_SAMPLE_METADATA,
  NO_PROOF_BUNDLE,
  PROVABILITY_METRIC_THRESHOLDS,
  UNMEASURED_PREFIXES,
  UNPRICED_COST_PREFIX,
  UNVERIFIED_BUNDLE,
  assumptionRate,
  citationValidity,
  claimCoverage,
  costPerProvenClaim,
  createCostPerProvenClaim,
  isUnmeasured,
  replayIntegrity,
  rungAchieved,
} from "./graders";
export { type GatePricing, type GateSpend, gateSpendOf } from "./cost";
export {
  type SampleProvability,
  type SampleProvabilityRead,
  expectedSourceKey,
  sampleProvabilityOf,
} from "./metadata";
export {
  PROVABILITY_METRIC_SPECS,
  type ProvabilityCostSummary,
  type ProvabilityMetricSpec,
  type ProvabilityMetricSummary,
  type ProvabilitySummary,
  renderProvabilitySummaryLines,
  summarizeCostPerProvenClaim,
  summarizeProvabilityMetrics,
} from "./summary";

/** The six graders under their canonical names, in the design's table order. */
export const PROVABILITY_GRADERS: ReadonlyArray<readonly [string, Grader]> = Object.freeze([
  ["provability.claimCoverage", claimCoverage],
  ["provability.rungAchieved", rungAchieved],
  ["provability.citationValidity", citationValidity],
  ["provability.assumptionRate", assumptionRate],
  ["provability.replayIntegrity", replayIntegrity],
  ["provability.costPerProvenClaim", costPerProvenClaim],
] as const);

/**
 * The six graders, with `costPerProvenClaim` pricing re-runs through
 * `pricing` on a run no cost-tracker metered (see `./cost`). The eval runner
 * builds its set here from its own `RunEvalOptions.pricing`; without a seam
 * this is {@link PROVABILITY_GRADERS}.
 */
export function createProvabilityGraders(
  opts: { readonly pricing?: GatePricing } = {},
): ReadonlyArray<readonly [string, Grader]> {
  if (opts.pricing === undefined) return PROVABILITY_GRADERS;
  const cost = createCostPerProvenClaim({ pricing: opts.pricing });
  return Object.freeze(
    PROVABILITY_GRADERS.map(([name, grader]) =>
      Object.freeze([name, name === "provability.costPerProvenClaim" ? cost : grader] as const),
    ),
  );
}

/**
 * The graders that are REPORTED, never a pass/fail bar: their verdict is
 * always a pass when measured, so a combination that let them vote would
 * pass a sample on a dollar figure.
 */
export const PROVABILITY_REPORTED_GRADERS: ReadonlyArray<string> = Object.freeze([
  "provability.costPerProvenClaim",
]);

/** The canonical names, in order. */
export const PROVABILITY_GRADER_NAMES: ReadonlyArray<string> = Object.freeze(
  PROVABILITY_GRADERS.map(([name]) => name),
);

/**
 * How one of the six joins a sample's overall grade (design §9.1), keyed on
 * its canonical name — the one answer for every path that adds it, the
 * `--provability` flag and a graders file's `type: registry` entry alike:
 *   - `"requirement"` — the five with a bar: the sample must pass each on top
 *     of its own `combine:` policy, never as a vote inside it (a vacuous pass
 *     or a lower-is-better rate cannot carry a `combine: any` or skew a
 *     `weighted` score);
 *   - `"report"` — {@link PROVABILITY_REPORTED_GRADERS}: recorded, never part
 *     of the verdict (more gate spend can never turn a fail into a pass).
 * `undefined` for any other name.
 */
export function provabilityGraderRole(name: string): "requirement" | "report" | undefined {
  if (PROVABILITY_REPORTED_GRADERS.includes(name)) return "report";
  return PROVABILITY_GRADER_NAMES.includes(name) ? "requirement" : undefined;
}

/**
 * Register all six graders. Skips names already present (like
 * `registerContinuityGraders`, so a plugin registered first keeps its name)
 * and returns the canonical names.
 */
export function registerProvabilityGraders(registry: GraderRegistry): ReadonlyArray<string> {
  for (const [name, grader] of PROVABILITY_GRADERS) {
    if (!registry.has(name)) registry.register(name, grader);
  }
  return PROVABILITY_GRADER_NAMES;
}
