/**
 * The cross-sample roll-up of the six provability graders — the
 * `summarizeContinuityMetrics` / `summarize12MetricRubric` shape (`byMetric`
 * in, per-metric means + pass fractions + percentiles out), so a report
 * surface treats the three rubrics alike.
 *
 * Two metrics do not have a fixed numeric bar: `rungAchieved` passes against
 * each sample's own floor (it breaches when any sample fell short), and
 * `costPerProvenClaim` is reported with no threshold (it never breaches; the
 * infinite samples — spend with zero met claims — and the partly unpriced
 * ones — a lower bound, not a price — are counted apart, read off the
 * grader's pinned rationale prefixes).
 *
 * An UNMEASURED result (no bundle, unverified, invalid metadata — the
 * grader's pinned prefixes, `isUnmeasured`) carries a placeholder score of 0.
 * It always counts as a failure in `passFraction`, but it is kept OUT of a
 * lower-is-better mean (`assumptionRate`), where 0 is the best value a sample
 * can have: averaging it in would let unmeasured samples hide a breach. A
 * lower-is-better metric with no measured sample breaches.
 */
import type { GradeResult } from "@crewhaus/eval-grader";
import {
  INFINITE_COST_PREFIX,
  PROVABILITY_METRIC_THRESHOLDS,
  UNPRICED_COST_PREFIX,
  isUnmeasured,
} from "./graders";

export type ProvabilityMetricSpec = {
  readonly name: string;
  /** Absent: the bar is per sample (`rungAchieved`) or there is none (`costPerProvenClaim`). */
  readonly threshold?: number;
  /** True for ≥-threshold metrics; false for ≤ (rate, cost). */
  readonly higherIsBetter: boolean;
};

/** The six graders, in the design's table order. */
export const PROVABILITY_METRIC_SPECS: ReadonlyArray<ProvabilityMetricSpec> = Object.freeze([
  {
    name: "provability.claimCoverage",
    threshold: PROVABILITY_METRIC_THRESHOLDS.claimCoverage,
    higherIsBetter: true,
  },
  { name: "provability.rungAchieved", higherIsBetter: true },
  {
    name: "provability.citationValidity",
    threshold: PROVABILITY_METRIC_THRESHOLDS.citationValidity,
    higherIsBetter: true,
  },
  {
    name: "provability.assumptionRate",
    threshold: PROVABILITY_METRIC_THRESHOLDS.assumptionRate,
    higherIsBetter: false,
  },
  {
    name: "provability.replayIntegrity",
    threshold: PROVABILITY_METRIC_THRESHOLDS.replayIntegrity,
    higherIsBetter: true,
  },
  { name: "provability.costPerProvenClaim", higherIsBetter: false },
]);

export type ProvabilityMetricSummary = {
  readonly name: string;
  readonly threshold?: number;
  readonly higherIsBetter: boolean;
  readonly count: number;
  /** Results that replaced their measurement with a failure (see the module doc). */
  readonly unmeasured: number;
  /** Over every result when higher is better; over the measured ones when lower is. */
  readonly mean: number;
  readonly passFraction: number;
  readonly thresholdBreach: boolean;
  readonly p50: number;
  readonly p95: number;
};

export type ProvabilityCostSummary = {
  readonly name: "provability.costPerProvenClaim";
  readonly count: number;
  /** Samples with an exact finite ratio (≥1 met claim, or no gate spend). */
  readonly finiteCount: number;
  /** Samples that spent with zero met claims (the ∞ ratio). */
  readonly infiniteCount: number;
  /** Samples whose re-runs were partly unpriced: a lower bound, kept out of the means. */
  readonly unpricedCount: number;
  /** Samples whose grade was a failure (no bundle / unverified) — no ratio at all. */
  readonly unmeasured: number;
  readonly meanUsd: number;
  readonly p50Usd: number;
  readonly p95Usd: number;
};

export type ProvabilitySummary = {
  /** The five 0..1 metrics, in spec order. */
  readonly metrics: ReadonlyArray<ProvabilityMetricSummary>;
  readonly cost: ProvabilityCostSummary;
  /** Metrics whose roll-up breached their bar. */
  readonly breaches: number;
  /** Mean pass fraction across the five gated metrics (cost is reported, not gated). */
  readonly overall: number;
};

function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

const mean = (xs: ReadonlyArray<number>): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** The cost metric's roll-up, the ∞ samples counted apart. */
export function summarizeCostPerProvenClaim(
  results: ReadonlyArray<GradeResult>,
): ProvabilityCostSummary {
  const measured = results.filter((r) => r.passed);
  const infinite = measured.filter((r) => r.rationale.startsWith(INFINITE_COST_PREFIX));
  const unpriced = measured.filter((r) => r.rationale.startsWith(UNPRICED_COST_PREFIX));
  const finite = measured.filter(
    (r) =>
      !r.rationale.startsWith(INFINITE_COST_PREFIX) &&
      !r.rationale.startsWith(UNPRICED_COST_PREFIX),
  );
  const usd = finite.map((r) => r.score);
  return {
    name: "provability.costPerProvenClaim",
    count: results.length,
    finiteCount: finite.length,
    infiniteCount: infinite.length,
    unpricedCount: unpriced.length,
    unmeasured: results.length - measured.length,
    meanUsd: mean(usd),
    p50Usd: percentile(usd, 0.5),
    p95Usd: percentile(usd, 0.95),
  };
}

/**
 * Fold per-sample `GradeResult`s keyed by grader name into the provability
 * roll-up. Metrics with no results report count 0 and never breach.
 */
export function summarizeProvabilityMetrics(
  byMetric: Readonly<Record<string, ReadonlyArray<GradeResult>>>,
): ProvabilitySummary {
  const metrics: ProvabilityMetricSummary[] = [];
  for (const spec of PROVABILITY_METRIC_SPECS) {
    if (spec.name === "provability.costPerProvenClaim") continue;
    const results = byMetric[spec.name] ?? [];
    const count = results.length;
    const unmeasured = results.filter(isUnmeasured).length;
    // A placeholder 0 is the WORST value of a higher-is-better metric (kept:
    // conservative) and the BEST of a lower-is-better one (dropped).
    const scored = spec.higherIsBetter ? results : results.filter((r) => !isUnmeasured(r));
    const scores = scored.map((r) => r.score);
    const m = mean(scores);
    const passFraction = count === 0 ? 0 : results.filter((r) => r.passed).length / count;
    const thresholdBreach =
      count > 0 &&
      (spec.threshold === undefined
        ? passFraction < 1
        : spec.higherIsBetter
          ? m < spec.threshold
          : scored.length === 0 || m > spec.threshold);
    metrics.push({
      name: spec.name,
      ...(spec.threshold !== undefined ? { threshold: spec.threshold } : {}),
      higherIsBetter: spec.higherIsBetter,
      count,
      unmeasured,
      mean: m,
      passFraction,
      thresholdBreach,
      p50: percentile(scores, 0.5),
      p95: percentile(scores, 0.95),
    });
  }
  const cost = summarizeCostPerProvenClaim(byMetric["provability.costPerProvenClaim"] ?? []);
  return {
    metrics,
    cost,
    breaches: metrics.filter((m) => m.thresholdBreach).length,
    overall: mean(metrics.map((m) => m.passFraction)),
  };
}

/** One line per metric — the report surface for eval summaries. */
export function renderProvabilitySummaryLines(summary: ProvabilitySummary): string[] {
  const lines: string[] = [];
  for (const m of summary.metrics) {
    const bound =
      m.threshold === undefined
        ? "≥ each sample's floor"
        : m.higherIsBetter
          ? `≥${m.threshold}`
          : `≤${m.threshold}`;
    lines.push(
      `${m.name.padEnd(32)} n=${m.count} · mean ${m.mean.toFixed(3)} · pass ${Math.round(
        m.passFraction * m.count,
      )}/${m.count}${m.unmeasured > 0 ? ` (unmeasured ${m.unmeasured})` : ""} · p50 ${m.p50.toFixed(
        3,
      )} p95 ${m.p95.toFixed(3)} · ${bound}${m.thresholdBreach ? " BREACH" : ""}`,
    );
  }
  const c = summary.cost;
  lines.push(
    `${c.name.padEnd(32)} n=${c.count} · mean $${c.meanUsd.toFixed(4)}/proven claim (finite ${
      c.finiteCount
    }, ∞ ${c.infiniteCount}${c.unpricedCount > 0 ? `, partly unpriced ${c.unpricedCount}` : ""}${
      c.unmeasured > 0 ? `, unmeasured ${c.unmeasured}` : ""
    }) · p50 $${c.p50Usd.toFixed(4)} p95 $${c.p95Usd.toFixed(4)} · reported, no threshold`,
  );
  lines.push(
    `provability overall: ${(summary.overall * 100).toFixed(1)}% pass · ${summary.breaches} breach(es)`,
  );
  return lines;
}
