/**
 * Lineage folds: each lineage's runs, cut where the measuring instrument
 * changed.
 *
 * `@crewhaus/eval-report` owns both halves of the rule: `buildTrends` groups
 * runs into series by baseline lineage — (spec, dataset) and, since 0.6.0, the
 * arm — and `segmentSeries` cuts a series at every change of the dataset or the
 * instrument (the graders config, the judge, the judge calibration, the plugin
 * graders, the arm snapshot and the pool policy), with its table of what breaks
 * a line and what is merely unverified. This module folds that result per
 * lineage for the tool: the lineage key, its label, and the notes about rows
 * that could not be joined back.
 */
import {
  type Boundary,
  type FieldChange,
  type FieldUnverified,
  type RunIndexEntry,
  SEGMENT_FIELDS,
  type Segment,
  type SegmentField,
  type SegmentPoint,
  type SegmentTrend,
  type TrendSeries,
  buildTrends,
  segmentRuns,
  segmentSeries,
} from "@crewhaus/eval-report";
import { keyOf } from "./history";
import { compareStrings } from "./read";

export type { Boundary, FieldChange, FieldUnverified, Segment, SegmentPoint, SegmentTrend };
export { segmentRuns };

/**
 * The fields that cut a line: the dataset, then `@crewhaus/eval-report`'s
 * instrument fields. The segmentation itself is eval-report's
 * (`segmentSeries`); this module folds its result per lineage for the tool.
 */
export const INSTRUMENT_FIELDS = SEGMENT_FIELDS;

export type InstrumentField = SegmentField;

export type LineageFold = {
  readonly key: string;
  readonly specName: string;
  readonly datasetName: string;
  readonly armId?: string;
  readonly routing?: string;
  readonly label: string;
  readonly runCount: number;
  readonly segments: ReadonlyArray<Segment>;
  /** Every join that broke or could not be verified, in run order. */
  readonly boundaries: ReadonlyArray<Boundary>;
  readonly notes: ReadonlyArray<string>;
};

/**
 * Fold index rows into per-lineage series and segment each one.
 *
 * Grouping and ordering come from `@crewhaus/eval-report`'s `buildTrends` —
 * the per-arm keying rule lives there and is not re-derived. The rows are
 * joined back onto their series by `runId` (unique after the supersede
 * collapse) because a `TrendPoint` deliberately carries the figures and not
 * the hashes.
 */
export function foldLineages(
  entries: ReadonlyArray<RunIndexEntry>,
  pinned: ReadonlySet<string>,
): LineageFold[] {
  const byId = new Map<string, RunIndexEntry>();
  const duplicated: string[] = [];
  for (const e of entries) {
    if (byId.has(e.runId)) duplicated.push(e.runId);
    byId.set(e.runId, e);
  }
  const series = buildTrends(entries, { pinnedRunIds: pinned });
  return series
    .map((s) => foldOne(s, byId, duplicated))
    .sort(
      (a, b) =>
        compareStrings(a.specName, b.specName) ||
        compareStrings(a.datasetName, b.datasetName) ||
        compareStrings(a.key, b.key),
    );
}

function foldOne(
  series: TrendSeries,
  byId: ReadonlyMap<string, RunIndexEntry>,
  duplicated: ReadonlyArray<string>,
): LineageFold {
  const ordered: RunIndexEntry[] = [];
  const lost: string[] = [];
  for (const point of series.points) {
    const entry = byId.get(point.runId);
    if (entry === undefined) {
      lost.push(point.runId);
      continue;
    }
    ordered.push(entry);
  }
  // `buildTrends` marked the pinned points, which is where the segmentation
  // reads them from.
  const { segments, boundaries } = segmentSeries(series, ordered);
  const notes: string[] = [];
  if (lost.length > 0) {
    notes.push(
      `${lost.length} run(s) in this series could not be joined back to an index row (${lost.slice(0, 5).join(", ")}) — they are not counted in any segment`,
    );
  }
  const dupHere = duplicated.filter((id) => series.points.some((p) => p.runId === id));
  if (dupHere.length > 0) {
    notes.push(
      `${dupHere.length} runId(s) appear more than once after the supersede collapse (${dupHere.slice(0, 5).join(", ")}) — only the last row for each was segmented`,
    );
  }
  if (segments.length > 1) {
    notes.push(
      `this lineage is ${segments.length} segments, not one line — an end-to-end delta across it would compare scores from ${segments.length} different instruments`,
    );
  }
  const label =
    series.armId !== undefined
      ? `${series.specName}/${series.datasetName}#${series.armId}`
      : series.routing !== undefined
        ? `${series.specName}/${series.datasetName}#routed`
        : `${series.specName}/${series.datasetName}`;
  // The lineage KEY is `@crewhaus/eval-report`'s, derived from a row rather
  // than re-spelled here: the V2 prefix, the separator and the `routed`
  // segment are its rules, and a second spelling of them is a key that stops
  // matching the pins the moment either changes.
  const first = ordered[0];
  const key = first !== undefined ? keyOf(first) : label;
  return {
    key,
    specName: series.specName,
    datasetName: series.datasetName,
    ...(series.armId !== undefined ? { armId: series.armId } : {}),
    ...(series.routing !== undefined ? { routing: series.routing } : {}),
    label,
    runCount: ordered.length,
    segments,
    boundaries,
    notes,
  };
}
