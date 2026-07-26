/**
 * E51 — offline eval RUN summaries as first-class metrics.
 *
 * A run summary is not a bus event: it exists only once the whole dataset has
 * been graded and aggregated, after the last per-sample event has been
 * published. So instead of inventing an event kind for it, the launcher hands
 * the finished figures straight to the metrics registry through
 * {@link recordEvalRunSummary}, and they leave the process through whichever
 * sink `CREWHAUS_METRICS` selected (stdout JSON / Prometheus textfile /
 * `/metrics` HTTP) exactly like every other instrument.
 *
 * The shape is deliberately a plain structural type rather than
 * `@crewhaus/eval-runner`'s `EvalRunSummary`: metrics-collector must stay a
 * leaf package that the runtime can attach without pulling the eval stack in.
 * The caller projects.
 */
import type { Labels } from "./registry";
import type { Registry } from "./registry";

export type EvalRunMetricsSummary = {
  /** The spec that was evaluated (`ir.name`). */
  readonly specName: string;
  /** The dataset it was evaluated against. */
  readonly datasetName: string;
  readonly passRate: number;
  readonly meanScore: number;
  readonly sampleCount: number;
  readonly errorCount: number;
  /** C34 — samples whose repeat trials disagreed. Absent ⇒ 0 recorded. */
  readonly flakyCount?: number;
  /** A3 — samples routed to human review. Absent ⇒ 0 recorded. */
  readonly needsHumanCount?: number;
  /** C30/C35 — estimated total spend in USD. Absent ⇒ no cost gauge written
   *  (a pricing miss must not publish a confident $0). */
  readonly costUsd?: number;
};

/**
 * Write one run's summary onto the registry. Idempotent per (spec, dataset):
 * the gauges are last-write-wins, so a repeated run overwrites its own
 * previous figures while `crewhaus_eval_runs_total` keeps counting.
 *
 * Non-finite inputs are dropped by `Gauge.set` rather than serialized as
 * `NaN` into a Prometheus exposition a scraper would reject.
 */
export function recordEvalRunSummary(registry: Registry, summary: EvalRunMetricsSummary): void {
  const labels: Labels = { spec: summary.specName, dataset: summary.datasetName };
  registry.evalRunsTotal.inc(labels);
  registry.evalRunPassRate.set(summary.passRate, labels);
  registry.evalRunMeanScore.set(summary.meanScore, labels);
  registry.evalRunSamples.set(summary.sampleCount, labels);
  registry.evalRunErrors.set(summary.errorCount, labels);
  registry.evalRunFlakySamples.set(summary.flakyCount ?? 0, labels);
  registry.evalRunNeedsHuman.set(summary.needsHumanCount ?? 0, labels);
  if (summary.costUsd !== undefined) {
    registry.evalRunCostUsdMicros.set(Math.round(summary.costUsd * 1_000_000), labels);
  }
}
