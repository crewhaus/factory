/**
 * C31 — cross-run TRENDS over the eval run-history index.
 *
 * `eval-report history` answers "what did each run score"; nothing answered
 * "where is this suite HEADING". A three-week slide of 2 points per run is
 * invisible in a text table and obvious in a line — and benchmark
 * maintenance is a continuous process, so the run-over-run view is the
 * primary artifact of the loop.
 *
 * Everything here is a pure fold over `RunIndexEntry[]` (the append-only
 * `.crewhaus/evals/index.jsonl`) plus the pinned-baseline ids: fully
 * offline, no run directories opened, no network. The HTML is
 * SELF-CONTAINED — inline CSS and a hand-built inline `<svg>` chart, zero
 * external assets — so a trends page survives being emailed, committed to a
 * CI artifact bucket, or opened from a file:// URL on a plane.
 */
import type { RunIndexEntry } from "./history";
import { escapeHtml, shell } from "./render";

/** One run on a trend line. */
export type TrendPoint = {
  readonly runId: string;
  readonly ts: string;
  readonly passRate: number;
  readonly meanScore: number;
  readonly sampleCount: number;
  /** C30 — estimated agent-model cost, when the run's model had a pricing row. */
  readonly costUsd?: number;
  readonly p95LatencyMs?: number;
  /** C34 — samples whose repeat trials disagreed in this run. */
  readonly flakyCount?: number;
  /** NEW-HUNT-3 — budget-aborted run: its pass rate reads deflated. */
  readonly partial?: boolean;
  /** This run is the CURRENTLY pinned baseline for its (spec, dataset) key. */
  readonly pinned?: boolean;
};

/** One (spec, dataset) lineage's runs, oldest first. */
export type TrendSeries = {
  readonly specName: string;
  readonly datasetName: string;
  readonly points: ReadonlyArray<TrendPoint>;
};

/**
 * Group index entries into per-(spec, dataset) series, oldest run first.
 * Entries with an unparseable `ts` keep their index order (the log is
 * append-only, so file order is chronological anyway); the sort is stable so
 * equal timestamps never reshuffle.
 */
export function buildTrends(
  entries: ReadonlyArray<RunIndexEntry>,
  opts: { readonly pinnedRunIds?: ReadonlySet<string> } = {},
): TrendSeries[] {
  const bySeries = new Map<string, { specName: string; datasetName: string; points: TrendPoint[] }>(
    [],
  );
  for (const e of entries) {
    const key = `${e.specName}::${e.datasetName}`;
    const series = bySeries.get(key) ?? {
      specName: e.specName,
      datasetName: e.datasetName,
      points: [],
    };
    series.points.push({
      runId: e.runId,
      ts: e.ts,
      passRate: e.passRate,
      meanScore: e.meanScore,
      sampleCount: e.sampleCount,
      ...(e.costUsd !== undefined ? { costUsd: e.costUsd } : {}),
      ...(e.p95LatencyMs !== undefined ? { p95LatencyMs: e.p95LatencyMs } : {}),
      ...(e.flakyCount !== undefined && e.flakyCount > 0 ? { flakyCount: e.flakyCount } : {}),
      ...(e.partial === true ? { partial: true } : {}),
      ...(opts.pinnedRunIds?.has(e.runId) === true ? { pinned: true } : {}),
    });
    bySeries.set(key, series);
  }
  return [...bySeries.values()].map((s) => ({
    specName: s.specName,
    datasetName: s.datasetName,
    points: stableSortByTs(s.points),
  }));
}

function tsOf(p: TrendPoint): number {
  const t = Date.parse(p.ts);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

function stableSortByTs(points: ReadonlyArray<TrendPoint>): TrendPoint[] {
  return points
    .map((p, i) => ({ p, i }))
    .sort((a, b) => tsOf(a.p) - tsOf(b.p) || a.i - b.i)
    .map(({ p }) => p);
}

/** The text table: one row per run, columns shared with `history` where they
 *  overlap so the two read alike. */
export function trendTable(series: ReadonlyArray<TrendSeries>): {
  header: string[];
  rows: string[][];
} {
  const header = [
    "spec",
    "dataset",
    "ts",
    "runId",
    "pass_rate",
    "mean_score",
    "samples",
    "p95_ms",
    "cost_usd",
    "flaky",
    "base",
  ];
  const rows: string[][] = [];
  for (const s of series) {
    for (const p of s.points) {
      rows.push([
        s.specName,
        s.datasetName,
        p.ts,
        p.runId,
        `${(p.passRate * 100).toFixed(1)}%${p.partial === true ? "*" : ""}`,
        p.meanScore.toFixed(3),
        String(p.sampleCount),
        p.p95LatencyMs !== undefined ? String(Math.round(p.p95LatencyMs)) : "n/a",
        p.costUsd !== undefined ? `$${p.costUsd.toFixed(4)}` : "n/a",
        p.flakyCount !== undefined ? String(p.flakyCount) : "",
        p.pinned === true ? "*" : "",
      ]);
    }
  }
  return { header, rows };
}

/**
 * The plain-language movement line per series: where the suite started,
 * where it is now, and the delta in percentage POINTS (not percent — a
 * 40%→50% move is +10pp, and calling it "+25%" is how trend charts lie).
 * A single-run series says so instead of inventing a trend.
 */
export function formatTrendSummaryLines(series: ReadonlyArray<TrendSeries>): string[] {
  return series.map((s) => {
    const head = `trends ${s.specName}/${s.datasetName}:`;
    const first = s.points[0];
    const last = s.points[s.points.length - 1];
    if (first === undefined || last === undefined) return `${head} no runs`;
    if (s.points.length === 1) {
      return `${head} 1 run (${first.ts}) pass_rate=${pct(first.passRate)} — no trend yet`;
    }
    const deltaPp = (last.passRate - first.passRate) * 100;
    const scoreDelta = last.meanScore - first.meanScore;
    const costs = s.points.flatMap((p) => (p.costUsd !== undefined ? [p.costUsd] : []));
    const cost =
      costs.length > 0
        ? ` cost $${(costs.reduce((a, b) => a + b, 0)).toFixed(4)} over ${costs.length} priced run(s)`
        : "";
    const flakes = s.points.reduce((n, p) => n + (p.flakyCount ?? 0), 0);
    const flaky = flakes > 0 ? ` flaky_samples=${flakes}` : "";
    return (
      `${head} ${s.points.length} runs ${first.ts} → ${last.ts} · ` +
      `pass_rate ${pct(first.passRate)} → ${pct(last.passRate)} (${signed(deltaPp)}pp) · ` +
      `mean_score ${first.meanScore.toFixed(3)} → ${last.meanScore.toFixed(3)} (${signed(scoreDelta, 3)})` +
      `${cost}${flaky}`
    );
  });
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function signed(value: number, digits = 1): string {
  const s = value.toFixed(digits);
  return value > 0 ? `+${s}` : s;
}

// -------- inline SVG chart --------

const CHART_W = 760;
const CHART_H = 220;
const PAD_L = 48;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 34;

type ChartSeries = {
  readonly label: string;
  readonly color: string;
  /** y values in the chart's own units; `undefined` = no datum (gap). */
  readonly values: ReadonlyArray<number | undefined>;
};

/**
 * One inline `<svg>` line chart. `max` fixes the y scale (rates use 1;
 * cost/latency use the observed maximum) so a flat line at the top means
 * "perfect", never "auto-scaled to look dramatic".
 */
function svgChart(opts: {
  readonly xLabels: ReadonlyArray<string>;
  readonly series: ReadonlyArray<ChartSeries>;
  readonly max: number;
  readonly yFormat: (v: number) => string;
}): string {
  const n = opts.xLabels.length;
  const innerW = CHART_W - PAD_L - PAD_R;
  const innerH = CHART_H - PAD_T - PAD_B;
  const max = opts.max > 0 ? opts.max : 1;
  const x = (i: number): number => (n <= 1 ? PAD_L + innerW / 2 : PAD_L + (i / (n - 1)) * innerW);
  const y = (v: number): number => PAD_T + innerH - Math.min(1, Math.max(0, v / max)) * innerH;

  const gridlines = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const gy = PAD_T + innerH - f * innerH;
      return (
        `<line class="grid" x1="${PAD_L}" y1="${gy.toFixed(1)}" x2="${(CHART_W - PAD_R).toFixed(1)}" y2="${gy.toFixed(1)}" />` +
        `<text class="axis" x="${PAD_L - 6}" y="${(gy + 3.5).toFixed(1)}" text-anchor="end">${escapeHtml(opts.yFormat(f * max))}</text>`
      );
    })
    .join("");

  // x labels: first, middle and last only — a 40-run series must not smear
  // its axis into an unreadable band.
  const labelIdx = n <= 1 ? [0] : n === 2 ? [0, n - 1] : [0, Math.floor((n - 1) / 2), n - 1];
  const xLabels = labelIdx
    .map((i) => {
      const label = opts.xLabels[i] ?? "";
      const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      return `<text class="axis" x="${x(i).toFixed(1)}" y="${(CHART_H - PAD_B + 16).toFixed(1)}" text-anchor="${anchor}">${escapeHtml(label)}</text>`;
    })
    .join("");

  const paths = opts.series
    .map((s) => {
      let d = "";
      let open = false;
      s.values.forEach((v, i) => {
        if (v === undefined) {
          open = false;
          return;
        }
        d += `${open ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
        open = true;
      });
      const dots = s.values
        .map((v, i) =>
          v === undefined
            ? ""
            : `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${s.color}"><title>${escapeHtml(`${s.label} ${opts.yFormat(v)} @ ${opts.xLabels[i] ?? ""}`)}</title></circle>`,
        )
        .join("");
      return `<path d="${d.trim()}" fill="none" stroke="${s.color}" stroke-width="2" />${dots}`;
    })
    .join("");

  const legend = opts.series
    .map(
      (s, i) =>
        `<g transform="translate(${(PAD_L + i * 150).toFixed(1)}, ${(PAD_T - 4).toFixed(1)})">` +
        `<rect width="10" height="10" y="-9" fill="${s.color}" rx="2" />` +
        `<text class="axis" x="14">${escapeHtml(s.label)}</text></g>`,
    )
    .join("");

  return (
    `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" preserveAspectRatio="xMidYMid meet">` +
    `${gridlines}${xLabels}${paths}${legend}</svg>`
  );
}

/**
 * The trends page's own palette. It is injected as BODY content into
 * {@link shell}, whose head stylesheet already paints a DARK theme
 * (`body { background: #0f1115; color: #e6e6e6 }`, `table { background:
 * #1a1d23 }`, `th { background: #14171c }`). Same specificity, later in
 * document order — so every rule below that sets a FOREGROUND must set the
 * matching BACKGROUND too, or dark-theme paint survives under near-black
 * ink (#222 on #1a1d23 is ~1.02:1: invisible). The charts already declare
 * `background: #fff`; the page around them now matches them instead of
 * fighting the shell.
 */
const STYLE = `
.trend { margin: 0 0 2.5rem 0; }
.trend h2 { margin: 0 0 .25rem 0; font-size: 1.05rem; }
.trend .meta { color: #555; font-size: .85rem; margin: 0 0 .75rem 0; }
.trend svg { width: 100%; max-width: ${CHART_W}px; height: auto; background: #fff;
  border: 1px solid #e3e3e3; border-radius: 6px; }
.trend .grid { stroke: #eee; stroke-width: 1; }
.trend .axis { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #666; }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; background: #fff; color: #222;
  font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
th, td { border-bottom: 1px solid #eee; padding: 4px 10px 4px 0; text-align: left;
  white-space: nowrap; background: #fff; color: #222; }
th { border-bottom: 2px solid #ddd; background: #f7f7f7; color: #222; cursor: default; }
th:hover { color: #222; }
body { font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem;
  background: #fff; color: #222; }
h1 { font-size: 1.3rem; color: #222; }
.empty { color: #777; }
`;

const PASS_COLOR = "#2f7d32";
const SCORE_COLOR = "#1565c0";
const COST_COLOR = "#b26a00";

/**
 * Render the whole trends page: one section per (spec, dataset) with a
 * quality chart (pass rate + mean score, both 0..1 so they share an axis
 * honestly), an optional cost chart when any run in the series was priced,
 * and the run table underneath. Self-contained — no external assets.
 */
export function renderTrends(series: ReadonlyArray<TrendSeries>): string {
  if (series.length === 0) {
    return shell(
      "crewhaus eval trends",
      `<h1>eval trends</h1><p class="empty">No recorded runs match.</p><style>${STYLE}</style>`,
    );
  }
  const sections = series
    .map((s) => {
      const xLabels = s.points.map((p) => p.ts.slice(0, 16).replace("T", " "));
      const quality = svgChart({
        xLabels,
        max: 1,
        yFormat: (v) => `${(v * 100).toFixed(0)}%`,
        series: [
          { label: "pass rate", color: PASS_COLOR, values: s.points.map((p) => p.passRate) },
          { label: "mean score", color: SCORE_COLOR, values: s.points.map((p) => p.meanScore) },
        ],
      });
      const costs = s.points.map((p) => p.costUsd);
      const maxCost = Math.max(0, ...costs.flatMap((c) => (c === undefined ? [] : [c])));
      const costChart =
        maxCost > 0
          ? `<h3>cost per run</h3>${svgChart({
              xLabels,
              max: maxCost,
              yFormat: (v) => `$${v.toFixed(4)}`,
              series: [{ label: "est. cost (agent)", color: COST_COLOR, values: costs }],
            })}`
          : "";
      const { header, rows } = trendTable([s]);
      const table =
        `<div class="wrap"><table><thead><tr>${header
          .map((h) => `<th>${escapeHtml(h)}</th>`)
          .join("")}</tr></thead><tbody>` +
        `${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
      const summary = formatTrendSummaryLines([s])[0] ?? "";
      return (
        `<section class="trend"><h2>${escapeHtml(`${s.specName} / ${s.datasetName}`)}</h2>` +
        `<p class="meta">${escapeHtml(summary)}</p>${quality}${costChart}${table}</section>`
      );
    })
    .join("\n");
  return shell("crewhaus eval trends", `<style>${STYLE}</style><h1>eval trends</h1>\n${sections}`);
}
