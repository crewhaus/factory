/**
 * Catalog R-eval `eval-report` — render eval-runner output to HTML + JSON.
 *
 * Diff mode: `diffReports(prev, next)` highlights pass/fail flips and
 * score shifts above ε=0.1. Mismatched dataset shapes are rejected at load
 * time rather than silently aligned by index — sample IDs must match.
 *
 * No HTML templating libraries; pure template strings with inlined CSS+JS.
 *
 * History mode: `history.ts` maintains the append-only run index
 * (`.crewhaus/evals/index.jsonl`) and the per-(spec, dataset) baseline pins
 * (`.crewhaus/evals/baselines.json`) behind `crewhaus eval`'s auto-baseline
 * diff and `crewhaus eval-report history|baseline`.
 *
 * Reference: build-roadmap.md §16.
 */
export { loadRun, type LoadedRun } from "./load";
export { renderReport } from "./render";
export { diffReports, type ReportDiff, type DiffEntry } from "./diff";
// Matrix mode (item 11): fold per-model cells from `crewhaus eval --models`
// into matrix.json + a best-per-metric-highlighted HTML table. Pricing is
// injected via `MatrixPricingFn` to keep this package dependency-free.
export {
  type BuildMatrixOptions,
  type MatrixBest,
  type MatrixCell,
  type MatrixPricingFn,
  type MatrixRow,
  type ModelMatrix,
  buildMatrix,
  formatUsd,
  renderMatrix,
} from "./matrix";
export { ReportError } from "./errors";
export {
  BASELINES_FILENAME,
  type BaselineEntry,
  type BaselinesFile,
  DEFAULT_EVALS_DIR,
  INDEX_FILENAME,
  type RunIndexEntry,
  appendRunIndex,
  baselineKey,
  getBaseline,
  hashDatasetFile,
  readBaselines,
  readRunIndex,
  setBaseline,
} from "./history";
