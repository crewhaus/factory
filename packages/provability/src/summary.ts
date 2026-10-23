/**
 * The bundle's summary: what the `provability_graded` trace and event-log
 * line and the `provability_evaluated` audit record carry instead of the
 * whole bundle (design §5.3). `bundleHash` ties the summary to the bundle
 * persisted under `.crewhaus/proofs/`.
 */
import type { ProofBundle, ProvabilityGradedSummary } from "./types";

export function summarizeBundle(bundle: ProofBundle): ProvabilityGradedSummary {
  return {
    level: bundle.level,
    verdict: bundle.verdict,
    score: bundle.score,
    threshold: bundle.threshold,
    achieved: bundle.achieved,
    claims: bundle.claimCount,
    met: bundle.met,
    unmet: bundle.unmet,
    assumptions: bundle.assumptions,
    ...(bundle.assumptionsRefused !== undefined
      ? { assumptionsRefused: bundle.assumptionsRefused }
      : {}),
    ...(bundle.hypotheses !== undefined ? { hypotheses: bundle.hypotheses } : {}),
    retryIndex: bundle.retryIndex,
    bundleHash: bundle.bundleHash,
    ...(bundle.judgeModel !== undefined ? { judgeModel: bundle.judgeModel } : {}),
    ...(bundle.spentUsdMicros !== undefined ? { judgeCostUsdMicros: bundle.spentUsdMicros } : {}),
  };
}
