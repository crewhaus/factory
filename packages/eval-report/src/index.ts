/**
 * Catalog R-eval `eval-report` — render eval-runner output to HTML + JSON.
 *
 * Diff mode: `diffReports(prev, next)` highlights pass/fail flips and
 * score shifts above ε=0.1. Mismatched dataset shapes are rejected at load
 * time rather than silently aligned by index — sample IDs must match.
 *
 * No HTML templating libraries; pure template strings with inlined CSS+JS.
 *
 * Reference: build-roadmap.md §16.
 */
export { loadRun, type LoadedRun } from "./load";
export { renderReport } from "./render";
export { diffReports, type ReportDiff } from "./diff";
export { ReportError } from "./errors";
