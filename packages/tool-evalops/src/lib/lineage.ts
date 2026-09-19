/**
 * Lineage identity: where a trend line has to be CUT.
 *
 * `@crewhaus/eval-report`'s `buildTrends` groups runs into series by baseline
 * LINEAGE — (spec, dataset) and, since 0.6.0, the arm. That is the right
 * grouping and it is reused verbatim below. It is not, however, an identity:
 * two runs in one series can still have been measured with different
 * instruments, because the graders config, the judge model, the dataset bytes
 * and the arm snapshot are all recorded ON THE RUN and can change between two
 * runs of the same lineage. `crewhaus eval` knows this — when the instrument
 * changes it refuses to gate and starts a new baseline lineage — but nothing
 * carried that knowledge into the fold that draws the line.
 *
 * So a series is segmented here at every instrument change, and each segment
 * gets its own first-to-last delta. A delta that spans a grader rewrite is a
 * number about two different measuring instruments, and the chart someone
 * makes a release decision on must not contain one.
 *
 * WHAT BREAKS A LINE, AND WHAT MERELY CANNOT BE VERIFIED.
 *
 * | field         | both present, differ | present on one side only          |
 * |---------------|----------------------|-----------------------------------|
 * | datasetHash   | BREAK                | unverified, including when absent from both (a current CLI always writes it) |
 * | gradersHash   | BREAK                | unverified (same)                 |
 * | judgeModel    | BREAK                | unverified (absent on BOTH is "no pinned judge", not an unknown) |
 * | armsDigest    | BREAK                | unverified on a ROUTED lineage    |
 * | policyVersion | BREAK                | unverified on a ROUTED lineage    |
 * | specHash      | note only            | note only                         |
 *
 * `specHash` is deliberately NOT a break. A re-run of an edited spec gating
 * against its pre-edit baseline is the entire point of the regression gate —
 * the spec is the thing under measurement, not the instrument. (The per-tool
 * survey sketch listed specHash beside gradersHash as a reason to segment;
 * that is wrong, and segmenting on it would cut the line at exactly the moment
 * the line becomes interesting.)
 *
 * Absence is never treated as agreement. A field present on one side and
 * missing on the other cannot be compared, so the join is marked `unverified`
 * and the segment carries that mark — the class of bug this repository keeps
 * paying for is a threshold that could not be EVALUATED being counted as one
 * that HELD.
 *
 * Comparison is against the LAST KNOWN value in the segment, not against the
 * immediately preceding run. With runs A(gradersHash=x), B(absent), C(=y),
 * a pairwise fold sees two unverified joins and no break, and draws one line
 * straight through a rubric change. Against last-known, C differs from A and
 * the line is cut where it must be.
 */
import { type RunIndexEntry, type TrendSeries, buildTrends } from "@crewhaus/eval-report";
import { keyOf } from "./history";
import { compareStrings } from "./read";

/** The fields that identify the measuring INSTRUMENT, not the thing measured. */
export const INSTRUMENT_FIELDS = [
  "datasetHash",
  "gradersHash",
  "judgeModel",
  "armsDigest",
  "policyVersion",
] as const;

export type InstrumentField = (typeof INSTRUMENT_FIELDS)[number];

/** Fields whose absence on an UNROUTED lineage is expected rather than
 *  unknown: only a routed run ever records them. */
const ROUTED_ONLY: ReadonlySet<InstrumentField> = new Set(["armsDigest", "policyVersion"]);

/**
 * Fields a current CLI records on EVERY run, so their absence from both sides
 * of a join means the rows predate the column — an unknown.
 *
 * `judgeModel` is deliberately not here. It is recorded only when a run PINNED
 * a judge, so absent-on-both says "neither run pinned one", which is a fact
 * about the runs rather than a gap in the record. Treating it as an unknown
 * would mark every ordinary lineage unverified and drown the mark that matters.
 */
const ALWAYS_RECORDED: ReadonlySet<InstrumentField> = new Set(["datasetHash", "gradersHash"]);

export type FieldChange = {
  readonly field: InstrumentField;
  readonly from: string;
  /** The run the `from` value was last seen on — not necessarily the run
   *  immediately before `to`. */
  readonly fromRunId: string;
  readonly to: string;
};

export type FieldUnverified = {
  readonly field: InstrumentField;
  /** Which side lacks the value: the earlier runs of this segment, this run,
   *  or (for a field a current CLI always writes) both. */
  readonly missingOn: "earlier" | "later" | "both";
  readonly reason: string;
};

export type Boundary = {
  readonly fromRunId: string;
  readonly toRunId: string;
  /**
   * `break` cuts the line, `unverified` leaves it joined but marks it as
   * unconfirmed, and `note` is a fact about the join that changes nothing
   * about comparability (a spec edit, a changed sample count).
   */
  readonly kind: "break" | "unverified" | "note";
  readonly changed: ReadonlyArray<FieldChange>;
  readonly unverified: ReadonlyArray<FieldUnverified>;
  readonly notes: ReadonlyArray<string>;
  readonly reason: string;
};

export type SegmentPoint = {
  readonly runId: string;
  readonly ts: string;
  readonly passRate: number;
  readonly meanScore: number;
  readonly sampleCount: number;
  readonly partial?: boolean;
  readonly replayed?: boolean;
  readonly flakyCount?: number;
  readonly costUsd?: number;
  readonly p95LatencyMs?: number;
  readonly pinned?: boolean;
};

export type SegmentTrend = {
  readonly fromRunId: string;
  readonly toRunId: string;
  readonly fromTs: string;
  readonly toTs: string;
  readonly comparableRuns: number;
  readonly passRateStart: number;
  readonly passRateEnd: number;
  /**
   * The move in PERCENTAGE POINTS. 40% to 50% is +10pp; calling it "+25%" is
   * how a trend chart lies, and `eval-report`'s own summary line uses pp for
   * the same reason.
   */
  readonly passRateDeltaPp: number;
  readonly meanScoreStart: number;
  readonly meanScoreEnd: number;
  readonly meanScoreDelta: number;
};

export type Segment = {
  readonly index: number;
  /** The instrument change that cut this segment off from the previous one.
   *  Absent on the first segment of a lineage. */
  readonly startedBy?: ReadonlyArray<FieldChange>;
  readonly runCount: number;
  readonly points: ReadonlyArray<SegmentPoint>;
  /** The instrument every run in this segment shares, as far as it is
   *  recorded. A field absent from every run is omitted rather than guessed. */
  readonly instrument: Readonly<Partial<Record<InstrumentField, string>>>;
  readonly comparability: "verified" | "unverified";
  readonly unverifiedJoins: ReadonlyArray<FieldUnverified>;
  /**
   * The first-to-last move, or `null` with a reason when the segment does not
   * support one: a single run is not a trend, and a budget-aborted run's
   * deflated pass rate is not a measurement to anchor one on.
   */
  readonly trend: SegmentTrend | null;
  readonly trendUnavailable?: string;
  /** Runs kept out of the trend endpoints, and why. They stay in `points`. */
  readonly excluded: ReadonlyArray<{ readonly runId: string; readonly why: string }>;
  readonly cost: {
    readonly totalUsd: number;
    readonly pricedRuns: number;
    /** Runs with no cost recorded. A total presented without this count is an
     *  undercount presented as a total. */
    readonly unpricedRuns: number;
  };
  readonly notes: ReadonlyArray<string>;
};

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

function present(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

function fieldOf(entry: RunIndexEntry, field: InstrumentField): string | undefined {
  const v = entry[field];
  return present(v) ? v : undefined;
}

/** True when the lineage routes — the two routed-only fields are then facts a
 *  run is expected to carry, and their absence is an unknown rather than a
 *  statement that the run did not route. */
function isRoutedLineage(entries: ReadonlyArray<RunIndexEntry>): boolean {
  return entries.some(
    (e) => e.armId !== undefined || (e.routing !== undefined && e.routing !== "static"),
  );
}

function round(n: number, places: number): number {
  return Number(n.toFixed(places));
}

type Walk = {
  readonly segments: Segment[];
  readonly boundaries: Boundary[];
};

/**
 * Cut one lineage's runs into comparable segments.
 *
 * `entries` must be the lineage's runs in the order they should be trended
 * (oldest first) — {@link foldLineages} gets that order from `buildTrends`,
 * which sorts by timestamp with a stable tiebreak.
 */
export function segmentRuns(
  entries: ReadonlyArray<RunIndexEntry>,
  pinned: ReadonlySet<string>,
): Walk {
  const routed = isRoutedLineage(entries);
  const segments: Segment[] = [];
  const boundaries: Boundary[] = [];
  let current: RunIndexEntry[] = [];
  let startedBy: FieldChange[] | undefined;
  let known = new Map<InstrumentField, { value: string; runId: string }>();
  let knownSpecHash: { value: string; runId: string } | undefined;
  let segmentUnverified: FieldUnverified[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    segments.push(
      buildSegment(segments.length, current, startedBy, segmentUnverified, pinned, routed),
    );
    current = [];
    segmentUnverified = [];
  };

  for (const entry of entries) {
    if (current.length === 0) {
      current.push(entry);
      known = new Map();
      for (const field of INSTRUMENT_FIELDS) {
        const v = fieldOf(entry, field);
        if (v !== undefined) known.set(field, { value: v, runId: entry.runId });
      }
      knownSpecHash = present(entry.specHash)
        ? { value: entry.specHash, runId: entry.runId }
        : undefined;
      continue;
    }
    const previous = current[current.length - 1] as RunIndexEntry;
    const changed: FieldChange[] = [];
    const unverified: FieldUnverified[] = [];
    for (const field of INSTRUMENT_FIELDS) {
      const now = fieldOf(entry, field);
      const before = known.get(field);
      if (now !== undefined && before !== undefined) {
        if (now !== before.value) {
          changed.push({ field, from: before.value, fromRunId: before.runId, to: now });
        }
        continue;
      }
      if (now === undefined && before === undefined) {
        // Absent on every run so far AND on this one. For a routed-only field
        // on an unrouted lineage that is a statement ("this lineage does not
        // route"), not an unknown. For the rest it means the rows predate the
        // column, so comparability is genuinely unverifiable.
        if (ALWAYS_RECORDED.has(field)) {
          unverified.push({
            field,
            missingOn: "both",
            reason: `${field} is recorded on neither run — these rows predate the column, so a change in it cannot be ruled out`,
          });
        }
        continue;
      }
      if (ROUTED_ONLY.has(field) && !routed) continue;
      unverified.push(
        now === undefined
          ? {
              field,
              missingOn: "later",
              reason: `${field} was ${before?.value} on ${before?.runId} and is absent on ${entry.runId} — the two cannot be compared`,
            }
          : {
              field,
              missingOn: "earlier",
              reason: `${field} is ${now} on ${entry.runId} and absent on every earlier run of this segment — the two cannot be compared`,
            },
      );
    }

    const notes: string[] = [];
    if (present(entry.specHash)) {
      if (knownSpecHash !== undefined && knownSpecHash.value !== entry.specHash) {
        notes.push(
          `spec edited since ${knownSpecHash.runId} (specHash ${knownSpecHash.value} -> ${entry.specHash}) — the line deliberately continues across a spec edit: the spec is what is being measured, not the instrument`,
        );
      }
      knownSpecHash = { value: entry.specHash, runId: entry.runId };
    }
    if (entry.sampleCount !== previous.sampleCount && changed.length === 0) {
      notes.push(
        `sample count changed ${previous.sampleCount} -> ${entry.sampleCount} with no dataset change recorded — one of these runs measured a subset (a --limit run), so the two rates have different denominators`,
      );
    }

    if (changed.length > 0) {
      boundaries.push({
        fromRunId: previous.runId,
        toRunId: entry.runId,
        kind: "break",
        changed,
        unverified,
        notes,
        reason: `${changed
          .map((c) => `${c.field} ${c.from} -> ${c.to}`)
          .join(
            "; ",
          )} — the measuring instrument changed, so scores either side of this run are not comparable`,
      });
      flush();
      startedBy = changed;
      current.push(entry);
      known = new Map();
      for (const field of INSTRUMENT_FIELDS) {
        const v = fieldOf(entry, field);
        if (v !== undefined) known.set(field, { value: v, runId: entry.runId });
      }
      knownSpecHash = present(entry.specHash)
        ? { value: entry.specHash, runId: entry.runId }
        : undefined;
      continue;
    }

    if (unverified.length > 0 || notes.length > 0) {
      boundaries.push({
        fromRunId: previous.runId,
        toRunId: entry.runId,
        // A join with nothing but notes is NOT a break and must never read as
        // one: a spec edit inside one lineage is the measurement, not a cut.
        kind: unverified.length > 0 ? "unverified" : "note",
        changed: [],
        unverified,
        notes,
        reason:
          unverified.length > 0
            ? `comparability could not be verified: ${unverified.map((u) => u.reason).join("; ")}`
            : notes.join("; "),
      });
    }
    for (const u of unverified) segmentUnverified.push(u);
    current.push(entry);
    for (const field of INSTRUMENT_FIELDS) {
      const v = fieldOf(entry, field);
      if (v !== undefined) known.set(field, { value: v, runId: entry.runId });
    }
  }
  flush();
  return { segments, boundaries };
}

function buildSegment(
  index: number,
  entries: ReadonlyArray<RunIndexEntry>,
  startedBy: ReadonlyArray<FieldChange> | undefined,
  unverifiedJoins: ReadonlyArray<FieldUnverified>,
  pinned: ReadonlySet<string>,
  routed: boolean,
): Segment {
  const points: SegmentPoint[] = entries.map((e) => ({
    runId: e.runId,
    ts: e.ts,
    passRate: e.passRate,
    meanScore: e.meanScore,
    sampleCount: e.sampleCount,
    ...(e.partial === true ? { partial: true } : {}),
    ...(e.replayed === true ? { replayed: true } : {}),
    ...(e.flakyCount !== undefined && e.flakyCount > 0 ? { flakyCount: e.flakyCount } : {}),
    ...(e.costUsd !== undefined ? { costUsd: e.costUsd } : {}),
    ...(e.p95LatencyMs !== undefined ? { p95LatencyMs: e.p95LatencyMs } : {}),
    ...(pinned.has(e.runId) ? { pinned: true } : {}),
  }));

  const instrument: Partial<Record<InstrumentField, string>> = {};
  for (const field of INSTRUMENT_FIELDS) {
    const values = [...new Set(entries.map((e) => fieldOf(e, field)).filter(present))];
    // Exactly one distinct value is the segment's instrument. Two would mean a
    // break was missed, so the value is withheld rather than a guess made.
    if (values.length === 1) instrument[field] = values[0] as string;
  }

  // NEW-HUNT-3 — a budget-aborted run recorded its unexecuted samples as
  // synthetic failures, so its pass rate reads LOW for a reason the agent did
  // not cause. `crewhaus eval` refuses to pin one as a baseline for exactly
  // this reason; anchoring a trend delta on one is the same mistake with a
  // chart instead of a gate.
  const excluded = entries
    .filter((e) => e.partial === true)
    .map((e) => ({
      runId: e.runId,
      why: "budget-aborted (partial) run — its unexecuted samples were recorded as failures, so its pass rate is not a measurement",
    }));
  const comparable = entries.filter((e) => e.partial !== true);

  const first = comparable[0];
  const last = comparable[comparable.length - 1];
  const trend: SegmentTrend | null =
    first !== undefined && last !== undefined && comparable.length >= 2
      ? {
          fromRunId: first.runId,
          toRunId: last.runId,
          fromTs: first.ts,
          toTs: last.ts,
          comparableRuns: comparable.length,
          passRateStart: first.passRate,
          passRateEnd: last.passRate,
          passRateDeltaPp: round((last.passRate - first.passRate) * 100, 4),
          meanScoreStart: first.meanScore,
          meanScoreEnd: last.meanScore,
          meanScoreDelta: round(last.meanScore - first.meanScore, 6),
        }
      : null;

  const priced = entries.filter((e) => e.costUsd !== undefined);
  const notes: string[] = [];
  const replayed = entries.filter((e) => e.replayed === true).map((e) => e.runId);
  if (replayed.length > 0) {
    notes.push(
      `${replayed.length} run(s) replayed tool results from a cassette (${replayed.slice(0, 5).join(", ")}) — a measurement of the agent's reasoning, not of the live system`,
    );
  }
  const flaky = entries.reduce((n, e) => n + (e.flakyCount ?? 0), 0);
  if (flaky > 0) {
    notes.push(
      `${flaky} sample-level flake(s) across this segment — trials disagreed, so part of every delta here is measured instability`,
    );
  }
  if (routed && instrument.armsDigest === undefined) {
    notes.push(
      "routed lineage with no arm snapshot digest recorded on at least one run — which arms served these samples is unknown",
    );
  }
  const sampleCounts = [...new Set(entries.map((e) => e.sampleCount))].sort((a, b) => a - b);
  if (sampleCounts.length > 1) {
    notes.push(
      `sample counts vary within this segment (${sampleCounts.join(", ")}) — the rates do not share a denominator`,
    );
  }

  return {
    index,
    ...(startedBy !== undefined ? { startedBy } : {}),
    runCount: entries.length,
    points,
    instrument,
    comparability: unverifiedJoins.length === 0 ? "verified" : "unverified",
    unverifiedJoins,
    trend,
    ...(trend === null
      ? {
          trendUnavailable:
            comparable.length === 0
              ? "every run in this segment is partial — there is nothing here that measures the spec"
              : `only ${comparable.length} comparable run(s) in this segment — a trend needs two`,
        }
      : {}),
    excluded,
    cost: {
      totalUsd: round(
        priced.reduce((sum, e) => sum + (e.costUsd ?? 0), 0),
        6,
      ),
      pricedRuns: priced.length,
      unpricedRuns: entries.length - priced.length,
    },
    notes,
  };
}

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
    .map((s) => foldOne(s, byId, pinned, duplicated))
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
  pinned: ReadonlySet<string>,
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
  const { segments, boundaries } = segmentRuns(ordered, pinned);
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
