/**
 * Item 11 — model benchmark matrix renderer for `crewhaus eval --models`.
 *
 * Consumes one cell per model (the per-model `EvalRunSummary` written to
 * `<out>/<model-slug>/results.json`, or the error that kept the cell from
 * running) and emits `matrix.json` (machine-readable rows + best-per-metric
 * map) and a dependency-free `index.html` (same shell/style as the
 * single-run report; best value per metric column highlighted).
 *
 * Pricing is injected as a function parameter rather than imported: eval
 * artifacts carry no `cost_accrual` events, so cost is projected from token
 * aggregates — but mapping a model string to a `(provider, modelId)` pricing
 * row needs both `@crewhaus/cost-tracker` and the `@crewhaus/model-router`
 * grammar. Keeping those out of this package's dependency graph preserves
 * eval-report as a pure renderer (its only deps stay `errors` +
 * `eval-runner` types); the CLI wires the real lookup in
 * `apps/cli/src/eval-matrix.ts`. A pricing miss returns `undefined` and
 * renders as "n/a" — an unmapped model must never crash the matrix.
 */
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { escapeHtml, shell } from "./render";

/**
 * Project a run's cost from its token aggregates, in USD micro-dollars.
 * Return `undefined` when the model's pricing is unknown ("n/a" in output).
 */
export type MatrixPricingFn = (
  model: string,
  tokens: { readonly input: number; readonly output: number },
) => number | undefined;

/** One matrix cell as produced by the CLI loop: a completed run, or the
 *  error that prevented it (`error` wins when both are somehow present). */
export type MatrixCell = {
  readonly model: string;
  /** Filesystem-safe directory name of the cell under the matrix root. */
  readonly slug: string;
  /** Absolute path to the cell's run directory. */
  readonly outDir: string;
  readonly summary?: EvalRunSummary;
  /** Why the cell failed to run (bad credentials, 404 model, …). */
  readonly error?: string;
};

export type MatrixRow = {
  readonly model: string;
  readonly slug: string;
  readonly outDir: string;
  /** "ok" = the cell ran (even with failing samples); "error" = it crashed. */
  readonly status: "ok" | "error";
  readonly error?: string;
  readonly runId?: string;
  readonly sampleCount?: number;
  readonly passRate?: number;
  readonly meanScore?: number;
  readonly errorCount?: number;
  readonly p50LatencyMs?: number;
  readonly p95LatencyMs?: number;
  readonly totalTokens?: { readonly input: number; readonly output: number };
  /** Projected run cost in USD micro-dollars; absent = pricing unknown. */
  readonly costMicros?: number;
  /** Projected $ per 1000 samples; absent = pricing unknown or 0 samples. */
  readonly costPer1kSamplesUsd?: number;
};

/** metric → every model sharing the best value (ties all listed; error
 *  cells and rows without the metric never win; empty = no candidate). */
export type MatrixBest = {
  readonly passRate: ReadonlyArray<string>;
  readonly meanScore: ReadonlyArray<string>;
  readonly p95LatencyMs: ReadonlyArray<string>;
  readonly costPer1kSamplesUsd: ReadonlyArray<string>;
};

export type ModelMatrix = {
  readonly generatedAt: string;
  /** Dataset shared by every cell (from the first completed summary). */
  readonly datasetName?: string;
  readonly rows: ReadonlyArray<MatrixRow>;
  readonly best: MatrixBest;
};

export type BuildMatrixOptions = {
  readonly pricing?: MatrixPricingFn;
  /** Clock override for deterministic tests. */
  readonly now?: () => Date;
};

function toRow(cell: MatrixCell, pricing?: MatrixPricingFn): MatrixRow {
  const base = { model: cell.model, slug: cell.slug, outDir: cell.outDir };
  if (cell.error !== undefined || cell.summary === undefined) {
    return { ...base, status: "error", error: cell.error ?? "cell produced no summary" };
  }
  const s = cell.summary;
  const a = s.aggregates;
  const sampleCount = s.samples.length;
  const costMicros = pricing?.(cell.model, a.totalTokens);
  // costMicros is the whole run in micro-USD; per-1k-samples in plain USD is
  // 1000 × (costMicros / 1e6 / sampleCount) = costMicros / (1000 × samples).
  const costPer1kSamplesUsd =
    costMicros !== undefined && sampleCount > 0 ? costMicros / (1000 * sampleCount) : undefined;
  return {
    ...base,
    status: "ok",
    runId: s.runId,
    sampleCount,
    passRate: a.passRate,
    meanScore: a.meanScore,
    errorCount: a.errorCount,
    p50LatencyMs: a.p50LatencyMs,
    p95LatencyMs: a.p95LatencyMs,
    totalTokens: a.totalTokens,
    ...(costMicros !== undefined ? { costMicros } : {}),
    ...(costPer1kSamplesUsd !== undefined ? { costPer1kSamplesUsd } : {}),
  };
}

function bestModels(
  rows: ReadonlyArray<MatrixRow>,
  select: (row: MatrixRow) => number | undefined,
  direction: "max" | "min",
): string[] {
  const candidates = rows.filter((r) => r.status === "ok" && select(r) !== undefined);
  if (candidates.length === 0) return [];
  const values = candidates.map((r) => select(r) as number);
  const best = direction === "max" ? Math.max(...values) : Math.min(...values);
  return candidates.filter((r) => select(r) === best).map((r) => r.model);
}

/** Fold per-cell outcomes into the matrix: metric rows + best-per-metric. */
export function buildMatrix(
  cells: ReadonlyArray<MatrixCell>,
  opts: BuildMatrixOptions = {},
): ModelMatrix {
  const rows = cells.map((c) => toRow(c, opts.pricing));
  const datasetName = cells.find((c) => c.summary !== undefined)?.summary?.config.datasetName;
  return {
    generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    ...(datasetName !== undefined ? { datasetName } : {}),
    rows,
    best: {
      passRate: bestModels(rows, (r) => r.passRate, "max"),
      meanScore: bestModels(rows, (r) => r.meanScore, "max"),
      p95LatencyMs: bestModels(rows, (r) => r.p95LatencyMs, "min"),
      costPer1kSamplesUsd: bestModels(rows, (r) => r.costPer1kSamplesUsd, "min"),
    },
  };
}

/** `$12`, `$1.23`, `$0.0042` — precision scaled so small per-1k projections
 *  stay legible without drowning big ones in fractional digits. */
export function formatUsd(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

const NA = '<span class="na">n/a</span>';

function metricCell(
  row: MatrixRow,
  best: ReadonlyArray<string>,
  value: number | undefined,
  text: string,
): string {
  if (value === undefined) return `<td class="na" data-sort="">${text}</td>`;
  const cls = best.includes(row.model) ? ' class="best"' : "";
  return `<td${cls} data-sort="${value}">${escapeHtml(text)}</td>`;
}

function matrixRowHtml(row: MatrixRow, best: MatrixBest): string {
  const statusCell =
    row.status === "ok"
      ? '<td class="pass" data-sort="1">OK</td>'
      : `<td class="fail" data-sort="0" title="${escapeHtml(row.error ?? "")}">ERROR</td>`;
  const tokens =
    row.totalTokens !== undefined ? `${row.totalTokens.input}/${row.totalTokens.output}` : "n/a";
  const report =
    row.status === "ok" ? `<a href="${escapeHtml(row.slug)}/index.html">report</a>` : "";
  return `
<tr>
  <td>${escapeHtml(row.model)}</td>
  ${statusCell}
  ${metricCell(row, best.passRate, row.passRate, row.passRate !== undefined ? `${(row.passRate * 100).toFixed(1)}%` : "n/a")}
  ${metricCell(row, best.meanScore, row.meanScore, row.meanScore !== undefined ? row.meanScore.toFixed(3) : "n/a")}
  ${metricCell(row, [], row.p50LatencyMs, row.p50LatencyMs !== undefined ? `${Math.round(row.p50LatencyMs)}ms` : "n/a")}
  ${metricCell(row, best.p95LatencyMs, row.p95LatencyMs, row.p95LatencyMs !== undefined ? `${Math.round(row.p95LatencyMs)}ms` : "n/a")}
  <td data-sort="${row.totalTokens !== undefined ? row.totalTokens.input + row.totalTokens.output : ""}">${escapeHtml(tokens)}</td>
  <td data-sort="${row.errorCount ?? ""}">${row.errorCount ?? "n/a"}</td>
  ${metricCell(row, best.costPer1kSamplesUsd, row.costPer1kSamplesUsd, row.costPer1kSamplesUsd !== undefined ? formatUsd(row.costPer1kSamplesUsd) : "n/a")}
  <td>${report}</td>
</tr>`;
}

/**
 * Render the matrix to the same dependency-free HTML shell as the
 * single-run report (one table; best value per metric column highlighted)
 * plus the pretty-printed `matrix.json` payload.
 */
export function renderMatrix(matrix: ModelMatrix): { html: string; json: string } {
  const okCount = matrix.rows.filter((r) => r.status === "ok").length;
  const failed = matrix.rows.filter((r) => r.status === "error");
  const errorsSection =
    failed.length === 0
      ? ""
      : `
<section class="diff-section">
  <h2>Failed cells (${failed.length})</h2>
  ${failed
    .map(
      (r) =>
        `<p class="meta"><span class="fail">${escapeHtml(r.model)}</span> — ${escapeHtml(r.error ?? "unknown error")}</p>`,
    )
    .join("")}
</section>`;

  const body = `
<h1>Model matrix</h1>
<p class="meta">Generated ${escapeHtml(matrix.generatedAt)}${matrix.datasetName !== undefined ? ` · dataset ${escapeHtml(matrix.datasetName)}` : ""} · ${matrix.rows.length} models (${okCount} ran) · best value per column highlighted · cost projected from token totals</p>
<table data-sortable>
  <thead><tr>
    <th>Model</th><th>Status</th><th>Pass rate</th><th>Mean score</th><th>p50 latency</th><th>p95 latency</th><th>Tokens (in/out)</th><th>Sample errors</th><th>Est. $/1k samples</th><th>Report</th>
  </tr></thead>
  <tbody>
    ${matrix.rows.map((r) => matrixRowHtml(r, matrix.best)).join("")}
  </tbody>
</table>
${errorsSection}`;
  return {
    html: shell("Model matrix", body),
    json: JSON.stringify(matrix, null, 2),
  };
}
