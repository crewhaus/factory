/**
 * Catalog R-eval `eval-report` — render eval-runner output to HTML + JSON.
 *
 * Diff mode: `diffReports(prev, next)` highlights pass/fail flips and
 * score shifts above ε=0.1, plus a paired sign-flip significance test on
 * the per-sample deltas (`significance.ts` — decision support only; the
 * strict gate never consults it). Mismatched dataset shapes are rejected at
 * load time rather than silently aligned by index — sample IDs must match.
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
export {
  renderReport,
  type ReportVerdictRow,
  type ReportVerdicts,
  // Ops item 32 — the incident-bundle renderer reuses the eval-report HTML
  // shell + escaping so incident index.html matches the report look-and-feel.
  shell,
  escapeHtml,
} from "./render";
export {
  diffInstrumentWarnings,
  diffReports,
  formatSliceDeltaLines,
  type ReportDiff,
  type DiffEntry,
  type DiffEntrySide,
  type SliceDelta,
} from "./diff";
// A1 — pairwise-diff bookkeeping (the pure half; the judge calls live in
// @crewhaus/eval-judge and the CLI composes the two behind `--pairwise`).
export {
  extractSampleInput,
  formatPairwiseLines,
  summarizePairwise,
  type PairwiseDiff,
  type PairwiseSampleVerdict,
  type PairwiseWinner,
} from "./pairwise";
// C29 — paired significance on diffs: decision support beside the strict
// gate (which is deliberately untouched by it).
export {
  DEFAULT_SIGNIFICANCE_SEED,
  type DiffSignificance,
  computeDiffSignificance,
  formatSignificanceLine,
  mulberry32,
} from "./significance";
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
