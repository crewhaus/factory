/**
 * B13 — metadata slice aggregation. A run-level macro pass rate can hold
 * steady while the hard/adversarial slice collapses, so the runner computes
 * per-slice figures over `sample.metadata` and persists them into
 * results.json (`slices`) — computed HERE rather than in the report layer
 * so target-eval bundles and every results.json consumer inherit them.
 *
 * Grouping rule (locked): a slice key applies only to samples whose
 * metadata carries that key as a STRING — non-string values (numbers,
 * arrays, nested objects) are provenance, not slice labels, and samples
 * missing the key simply don't join that key's grouping. A key that groups
 * nothing is omitted; a run that slices nothing omits `slices` entirely,
 * keeping metadata-less results.json byte-identical to pre-B13 output.
 */
import type { SampleResult, SliceStats } from "./types";

/** The default `--slice` keys, applied when present in sample metadata. */
export const DEFAULT_SLICE_KEYS: ReadonlyArray<string> = [
  "family",
  "difficulty",
  "language",
  "source",
];

/**
 * A3 — a sample whose recorded outcome is `abstained`: the judge declined
 * to score and no other grader failed, so the verdict is UNKNOWN (routed to
 * human review), not a fail. Errored samples are never abstained — the
 * invoker crash wins. Old records (no `abstained` field) are never abstained.
 */
export function sampleAbstained(s: SampleResult): boolean {
  return s.error === undefined && s.grades.overall.abstained === true;
}

/**
 * A2 — a sample flagged for HUMAN REVIEW by a high-entropy judge-panel
 * vote split. Unlike {@link sampleAbstained} the verdict is real and still
 * COUNTS (pass-rate denominator unchanged) — the flag only lists the
 * sample in the aggregates' separate needs-review bucket. Abstained
 * samples are never needs-review (they already route to needs-human), and
 * errored samples never carry the flag (the invoker crash wins). Old
 * records (no `needsReview` field) are never needs-review.
 */
export function sampleNeedsReview(s: SampleResult): boolean {
  return (
    s.error === undefined &&
    s.grades.overall.abstained !== true &&
    s.grades.overall.needsReview === true
  );
}

/**
 * Per-slice pass rate + mean score, mirroring the run-level semantics:
 * `passRate` excludes abstained samples from the denominator (errored ones
 * still count as failures), and `meanScore` averages the graded, non-errored
 * samples only. `sampleCount` is the slice's full membership.
 */
function sliceStats(group: ReadonlyArray<SampleResult>): SliceStats {
  const abstained = group.filter(sampleAbstained);
  const graded = group.length - abstained.length;
  const passed = group.filter(
    (s) => s.error === undefined && !sampleAbstained(s) && s.grades.overall.passed,
  ).length;
  const scored = group.filter((s) => s.error === undefined && !sampleAbstained(s));
  return {
    sampleCount: group.length,
    passRate: graded === 0 ? 0 : passed / graded,
    meanScore:
      scored.length === 0
        ? 0
        : scored.reduce((sum, s) => sum + s.grades.overall.score, 0) / scored.length,
  };
}

/**
 * Group the run's samples by each slice key's string metadata values and
 * compute per-group stats. Returns `undefined` when no key groups anything
 * (no metadata, or none of the keys present as strings) so the caller can
 * omit the field entirely.
 */
export function computeSlices(
  samples: ReadonlyArray<SampleResult>,
  keys: ReadonlyArray<string>,
): Record<string, Record<string, SliceStats>> | undefined {
  const slices: Record<string, Record<string, SliceStats>> = {};
  for (const key of keys) {
    const groups = new Map<string, SampleResult[]>();
    for (const s of samples) {
      const value = s.metadata?.[key];
      if (typeof value !== "string") continue;
      const group = groups.get(value);
      if (group !== undefined) group.push(s);
      else groups.set(value, [s]);
    }
    if (groups.size === 0) continue;
    const byValue: Record<string, SliceStats> = {};
    for (const value of [...groups.keys()].sort()) {
      byValue[value] = sliceStats(groups.get(value) as SampleResult[]);
    }
    slices[key] = byValue;
  }
  return Object.keys(slices).length > 0 ? slices : undefined;
}
