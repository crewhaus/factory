import { describe, expect, test } from "bun:test";
import type { RunIndexEntry } from "./history";
import { breakBoundaries, segmentSeries } from "./segments";
import {
  buildTrends,
  formatTrendBoundaryLines,
  formatTrendSummaryLines,
  renderTrends,
  segmentTrends,
  trendsJson,
} from "./trends";

const row = (runId: string, day: number, extra: Partial<RunIndexEntry> = {}): RunIndexEntry => ({
  runId,
  specName: "shop",
  specHash: "s",
  datasetName: "smoke",
  datasetHash: "d1",
  gradersHash: "g1",
  passRate: 0.5,
  meanScore: 0.5,
  sampleCount: 10,
  ts: `2026-01-0${day}T00:00:00Z`,
  outDir: `/x/${runId}`,
  ...extra,
});

describe("segmentSeries", () => {
  test("cuts on each instrument field and on the dataset, against the last known value", () => {
    for (const field of [
      "datasetHash",
      "gradersHash",
      "judgeModel",
      "calibrationDigest",
      "pluginsDigest",
    ] as const) {
      const rows = [
        row("r1", 1, { [field]: "one" }),
        // Unrecorded in between: the comparison is with r1's value.
        row("r2", 2, { [field]: undefined }),
        row("r3", 3, { [field]: "two" }),
      ];
      const [series] = buildTrends(rows);
      if (series === undefined) throw new Error("no series");
      const { segments, boundaries } = segmentSeries(series, rows);
      const cuts = breakBoundaries(boundaries);
      expect({ field, segments: segments.length }).toEqual({ field, segments: 2 });
      expect(cuts[0]?.changed[0]).toMatchObject({ field, from: "one", to: "two" });
    }
  });

  test("per-segment deltas leave out a partial run and a run that measured nothing", () => {
    const rows = [
      row("r1", 1, { passRate: 0.4 }),
      row("r2", 2, { passRate: 0.5 }),
      row("r3", 3, { passRate: 0, measuredCount: 0 }),
      row("r4", 4, { passRate: 0.1, partial: true }),
    ];
    const [series] = buildTrends(rows);
    if (series === undefined) throw new Error("no series");
    const { segments } = segmentSeries(series, rows);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.trend?.toRunId).toBe("r2");
    expect(segments[0]?.trend?.passRateDeltaPp).toBe(10);
    expect(segments[0]?.excluded.map((e) => e.runId)).toEqual(["r3", "r4"]);
    expect(segments[0]?.points.map((p) => p.runId)).toEqual(["r1", "r2", "r3", "r4"]);
  });

  test("a segment where nothing measured the spec has no trend, and says why", () => {
    const rows = [row("r1", 1, { measuredCount: 0 }), row("r2", 2, { partial: true })];
    const [series] = buildTrends(rows);
    if (series === undefined) throw new Error("no series");
    expect(segmentSeries(series, rows).segments[0]?.trendUnavailable).toContain(
      "no run in this segment measured the spec",
    );
  });
});

describe("trends output, cut where the instrument changed", () => {
  const steady = [row("r1", 1, { passRate: 0.4 }), row("r2", 2, { passRate: 0.6 })];

  test("a history without a cut prints and writes what it always did", () => {
    const series = buildTrends(steady);
    const segmented = segmentTrends(series, steady);
    expect(formatTrendSummaryLines(series, segmented)).toEqual(formatTrendSummaryLines(series));
    expect(formatTrendBoundaryLines(series, segmented)).toEqual([]);
    expect(renderTrends(series, segmented)).toBe(renderTrends(series));
    expect(JSON.stringify(trendsJson(series, segmented))).toBe(JSON.stringify(series));
  });

  test("a cut is printed, the summary is the last segment's, the chart stops at it, and trends.json carries it", () => {
    const rows = [
      row("r1", 1, { passRate: 0.4 }),
      row("r2", 2, { passRate: 0.5 }),
      row("r3", 3, { passRate: 0.9, gradersHash: "g2" }),
      row("r4", 4, { passRate: 0.95, gradersHash: "g2" }),
    ];
    const series = buildTrends(rows);
    const segmented = segmentTrends(series, rows);
    expect(formatTrendBoundaryLines(series, segmented)).toEqual([
      "shop/smoke: instrument changed at r3 (gradersHash: g1 → g2) — deltas are per segment",
    ]);
    const [summary] = formatTrendSummaryLines(series, segmented);
    expect(summary).toContain("4 runs in 2 segments");
    // The last segment's move, never the 0.4 → 0.95 jump across the cut.
    expect(summary).toContain("pass_rate 90.0% → 95.0% (+5.0pp)");
    expect(summary).not.toContain("40.0%");
    const html = renderTrends(series, segmented);
    const passPath = /<path d="([^"]*)" fill="none" stroke="#2f7d32"/.exec(html)?.[1] ?? "";
    expect(passPath.split("M").length - 1).toBe(2);
    expect(renderTrends(series).includes(passPath)).toBe(false);
    const [json] = trendsJson(series, segmented) as Array<Record<string, unknown>>;
    expect((json?.["segments"] as unknown[]).length).toBe(2);
    expect((json?.["boundaries"] as unknown[]).length).toBe(1);
  });
});
