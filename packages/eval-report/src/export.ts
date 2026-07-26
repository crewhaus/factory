/**
 * C32 — the machine-friendly EXPORT: per-sample × per-grader rows, flattened
 * across runs.
 *
 * Per-run data lives only as nested `results.json` (samples → grades →
 * perGrader), and `index.jsonl` is run-level aggregates — so the fourth
 * purpose of an eval stack, failure-mode analysis ACROSS runs, meant
 * hand-walking directories and flattening `grades.perGrader` yourself.
 * Every serious harness exports a flat table; this is ours.
 *
 * One row per (run, sample, grader), carrying enough run config to group by
 * (specHash, model, seed) and enough sample context to join back to the
 * dataset. A sample whose graders never ran (errored invocation) still emits
 * ONE row with an empty grader — the analysis must be able to see it, since
 * silently dropping errors is exactly how a pass rate lies.
 *
 * Pure + offline: a fold over already-loaded summaries. Emitters are CSV
 * (RFC4180 quoting) and JSONL.
 */
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";

/** A run to export, plus the identity the summary itself does not carry. */
export type ExportRunInput = {
  readonly summary: EvalRunSummary;
  /** The spec `name:` from the run-history index, when the caller knows it. */
  readonly specName?: string;
};

/** One flattened (run, sample, grader) row. Field order IS column order. */
export type ExportRow = {
  readonly runId: string;
  readonly runTs: string;
  readonly specName: string;
  readonly specHash: string;
  readonly datasetName: string;
  readonly model: string;
  readonly judgeModel: string;
  readonly seed: string;
  readonly sampleId: string;
  readonly sampleStartedAt: string;
  readonly sampleEndedAt: string;
  readonly latencyMs: number;
  readonly samplePassed: boolean;
  readonly sampleScore: number;
  /** The invoker's error for this sample (empty when it ran). */
  readonly sampleError: string;
  /** G15 — fraction of trials that passed (empty on single-trial runs). */
  readonly trialPassRate: string;
  /** C34 — the sample's trials disagreed. Derived exactly like
   *  {@link aggregate}'s `flakySampleIds` (see {@link isFlakySample}). */
  readonly flaky: boolean;
  /** The grader's name; empty for the synthetic row of an ungraded sample. */
  readonly grader: string;
  readonly passed: boolean;
  readonly score: number;
  readonly abstained: boolean;
  readonly rationale: string;
  /** B13 — `key=value;key=value` over the run's slice keys. */
  readonly slices: string;
};

/** Column order for CSV. Mirrors {@link ExportRow}'s field order. */
export const EXPORT_COLUMNS: ReadonlyArray<keyof ExportRow> = [
  "runId",
  "runTs",
  "specName",
  "specHash",
  "datasetName",
  "model",
  "judgeModel",
  "seed",
  "sampleId",
  "sampleStartedAt",
  "sampleEndedAt",
  "latencyMs",
  "samplePassed",
  "sampleScore",
  "sampleError",
  "trialPassRate",
  "flaky",
  "grader",
  "passed",
  "score",
  "abstained",
  "rationale",
  "slices",
];

/** Default rationale clip. Judge rationales run long; a spreadsheet cell
 *  holding a 4kB essay helps nobody, and the full text is in grades.json. */
export const DEFAULT_RATIONALE_CHARS = 300;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * C34 — is this sample flaky? Derived the SAME way `aggregate()` derives
 * `flakySampleIds` (from `trialPassRate`, not only from the per-sample
 * `flaky` flag), so the export can never disagree with the run's own
 * `aggregates.flakySampleIds`, the stdout flake block, or the history
 * `flaky` column about the same sample. It matters concretely: a `--resume`
 * rebuilds `trials`/`trialPassRate` for reused samples, and a results.json
 * written by a pre-C34 CLI carries no `flaky` flag at all.
 */
export function isFlakySample(sample: SampleResult): boolean {
  return (
    sample.flaky === true ||
    (sample.trialPassRate !== undefined && sample.trialPassRate > 0 && sample.trialPassRate < 1)
  );
}

/** B13 — the sample's membership in the run's declared slices. */
function sliceCell(sample: SampleResult, sliceKeys: ReadonlyArray<string>): string {
  const md = sample.metadata;
  if (md === undefined) return "";
  const parts: string[] = [];
  for (const key of sliceKeys) {
    const value = md[key];
    if (typeof value === "string" && value !== "") parts.push(`${key}=${value}`);
  }
  return parts.join(";");
}

/**
 * Flatten runs into rows, in run order then sample order then grader order
 * (deterministic — two exports of the same runs are byte-identical).
 */
export function buildExportRows(
  runs: ReadonlyArray<ExportRunInput>,
  opts: { readonly rationaleMaxChars?: number } = {},
): ExportRow[] {
  const maxChars = opts.rationaleMaxChars ?? DEFAULT_RATIONALE_CHARS;
  const rows: ExportRow[] = [];
  for (const { summary, specName } of runs) {
    const cfg = summary.config;
    const sliceKeys = Object.keys(summary.slices ?? {});
    for (const sample of summary.samples) {
      const base = {
        runId: summary.runId,
        runTs: summary.endedAt,
        specName: specName ?? "",
        specHash: cfg.specHash,
        datasetName: cfg.datasetName,
        model: cfg.model,
        judgeModel: cfg.judgeModel ?? "",
        seed: cfg.seed !== undefined ? String(cfg.seed) : "",
        sampleId: sample.sampleId,
        sampleStartedAt: sample.startedAt,
        sampleEndedAt: sample.endedAt,
        latencyMs: sample.latencyMs,
        samplePassed: sample.grades.overall.passed,
        sampleScore: sample.grades.overall.score,
        sampleError: sample.error !== undefined ? clip(sample.error, maxChars) : "",
        trialPassRate: sample.trialPassRate !== undefined ? String(sample.trialPassRate) : "",
        flaky: isFlakySample(sample),
        slices: sliceCell(sample, sliceKeys),
      };
      if (sample.grades.perGrader.length === 0) {
        // Ungraded sample (the invoker errored, or an older artifact): keep
        // it in the table rather than dropping the failure on the floor.
        rows.push({
          ...base,
          grader: "",
          passed: sample.grades.overall.passed,
          score: sample.grades.overall.score,
          abstained: sample.grades.overall.abstained === true,
          rationale: clip(sample.grades.overall.rationale, maxChars),
        });
        continue;
      }
      for (const g of sample.grades.perGrader) {
        rows.push({
          ...base,
          grader: g.name,
          passed: g.passed,
          score: g.score,
          abstained: g.abstained === true,
          rationale: clip(g.rationale, maxChars),
        });
      }
    }
  }
  return rows;
}

/** RFC4180 field quoting: quote when the value carries a comma, quote,
 *  CR or LF; double any embedded quote. */
export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV with a header row, `\n`-terminated (one trailing newline). */
export function rowsToCsv(rows: ReadonlyArray<ExportRow>): string {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(EXPORT_COLUMNS.map((c) => csvCell(String(row[c]))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** JSONL — one JSON object per row, keys in {@link EXPORT_COLUMNS} order. */
export function rowsToJsonl(rows: ReadonlyArray<ExportRow>): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}
