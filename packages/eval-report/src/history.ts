/**
 * Eval run-history index + per-(spec, dataset) baseline pins.
 *
 * Two small on-disk artifacts under `.crewhaus/evals/` (or an explicit
 * `evalsDir` for tenant-scoped / test callers):
 *
 * - `index.jsonl` — append-only log, one JSON line per completed eval run.
 *   Readers tolerate torn/corrupt lines (skip, never throw) so a crashed
 *   append can't take down every future `history` listing.
 * - `baselines.json` — map of `<specName>::<datasetName>` → the pinned
 *   baseline run for that key. Written atomically as a whole (small file).
 *
 * These helpers are deliberately dependency-free (node:fs + node:crypto)
 * so other features — auto-baseline diff in the CLI, the future dataset
 * drift sentinel — can reuse them without pulling in the renderer.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import { ReportError } from "./errors";

/** Default location of the run index + baselines, relative to the cwd. */
export const DEFAULT_EVALS_DIR = join(".crewhaus", "evals");
export const INDEX_FILENAME = "index.jsonl";
export const BASELINES_FILENAME = "baselines.json";

/** One line of `index.jsonl` — the durable summary of a completed eval run. */
export type RunIndexEntry = {
  readonly runId: string;
  readonly specName: string;
  readonly specHash: string;
  /**
   * Stable spec *identity* — the resolved source path of the spec this run
   * evaluated. Unlike {@link specHash} (which changes on every instruction
   * edit), the source survives edits, so it distinguishes "the same spec,
   * edited" (baseline lineage should continue — that IS the regression gate)
   * from "a different spec that merely shares a `name:`" (a collision worth
   * warning about). Additive — absent on entries written before the field
   * existed, and on runs whose caller didn't supply a source.
   */
  readonly specSource?: string;
  readonly datasetName: string;
  /** sha256 hex of the dataset file bytes (see {@link hashDatasetFile}). */
  readonly datasetHash: string;
  /**
   * sha256 hex of the parsed graders config the run graded with — the same
   * digest the runner records into `run.json`/`results.json` for the drift
   * sentinel. Together with {@link judgeModel} it identifies the *measurement
   * instrument*: a changed rubric or threshold produces a new hash, and
   * scores from different instruments are not comparable. Additive — absent
   * on entries written before the field existed.
   */
  readonly gradersHash?: string;
  /**
   * Judge model the run's `llm_judge` graders were bound to, when the run
   * pinned one explicitly (`--judge-model`). The other half of the
   * measurement-instrument identity (see {@link gradersHash}). Additive —
   * absent on entries written before the field existed, and on runs that
   * used the default judge binding.
   */
  readonly judgeModel?: string;
  readonly passRate: number;
  readonly meanScore: number;
  readonly sampleCount: number;
  /**
   * Samples whose recorded outcome replaced an errored first attempt via
   * the runner's noise auto-retry (`SampleResult.retried`). Additive —
   * absent on entries written before the field existed (read as 0).
   */
  readonly retriedCount?: number;
  /** ISO-8601 completion timestamp. */
  readonly ts: string;
  /** Absolute path to the run's output directory. */
  readonly outDir: string;
};

/** One pinned baseline in `baselines.json`, keyed by (specName, datasetName). */
export type BaselineEntry = {
  readonly specName: string;
  readonly datasetName: string;
  readonly runId: string;
  /**
   * Resolved source path of the spec that pinned this baseline (see
   * {@link RunIndexEntry.specSource}). Lets a later run detect that it is a
   * *different* spec sharing the same `name:` — a lineage collision — and
   * warn. Additive; absent on baselines pinned before the field existed.
   */
  readonly specSource?: string;
  /** Absolute path to the baseline run's output directory. */
  readonly outDir: string;
  /** Dataset content hash at the time the baseline was pinned. */
  readonly datasetHash: string;
  /**
   * Graders-config hash of the pinned run (see
   * {@link RunIndexEntry.gradersHash}). Lets a later run detect that it
   * graded with a *different* measurement instrument and start a new
   * baseline lineage instead of gating scores from one rubric against
   * another's. Additive; absent on baselines pinned before the field existed.
   */
  readonly gradersHash?: string;
  /**
   * Judge model of the pinned run (see {@link RunIndexEntry.judgeModel}).
   * Additive; absent on baselines pinned before the field existed.
   */
  readonly judgeModel?: string;
  /** ISO-8601 timestamp of when the pin was written. */
  readonly ts: string;
};

/** Shape of `baselines.json`: `<specName>::<datasetName>` → pinned run. */
export type BaselinesFile = Record<string, BaselineEntry>;

/** Composite key for the baselines map. */
export function baselineKey(specName: string, datasetName: string): string {
  return `${specName}::${datasetName}`;
}

/** sha256 hex digest of the dataset file bytes (content identity, not path). */
export function hashDatasetFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Append one run to `index.jsonl`, creating the directory/file on first use. */
export function appendRunIndex(entry: RunIndexEntry, evalsDir: string = DEFAULT_EVALS_DIR): void {
  mkdirSync(evalsDir, { recursive: true });
  appendFileSync(join(evalsDir, INDEX_FILENAME), `${JSON.stringify(entry)}\n`);
}

/** Identity a run summary cannot supply on its own — see {@link recordEvalRun}. */
export type RecordEvalRunOptions = {
  /** The evaluated spec's `name:` (the baseline lineage key). */
  readonly specName: string;
  /** Resolved spec source path — see {@link RunIndexEntry.specSource}. */
  readonly specSource?: string;
  /** sha256 hex of the dataset content the run scored. */
  readonly datasetHash: string;
  /** ABSOLUTE path to the run's output directory. */
  readonly outDir: string;
  /** Override `.crewhaus/evals` (tenant scopes, tests, standalone bundles
   *  whose run dir was rebased). */
  readonly evalsDir?: string;
};

/**
 * Project a completed run onto its index entry. The ONE place the summary →
 * `index.jsonl` wire format is derived, so every launcher records the same
 * shape: `crewhaus eval` (via `finishEvalRun`) and the standalone
 * `target: eval` bundle, which used to write its run directory and nothing
 * else — leaving `eval-report history`, `baseline set` and the gate machinery
 * blind to any run that wasn't launched through the CLI.
 *
 * Refuses a 0-sample run: it carries no signal, and a passRate-0 "clean"
 * entry would poison the index and could pin an empty baseline.
 */
export function runIndexEntryFromSummary(
  summary: EvalRunSummary,
  opts: RecordEvalRunOptions,
): RunIndexEntry {
  const datasetName = summary.config.datasetName;
  if (summary.samples.length === 0) {
    throw new ReportError(
      `refusing to record 0-sample eval run ${summary.runId} — dataset "${datasetName}" produced no samples`,
    );
  }
  const gradersHash = summary.config.gradersHash;
  const judgeModel = summary.config.judgeModel;
  return {
    runId: summary.runId,
    specName: opts.specName,
    specHash: summary.config.specHash,
    ...(opts.specSource !== undefined ? { specSource: opts.specSource } : {}),
    datasetName,
    datasetHash: opts.datasetHash,
    ...(gradersHash !== undefined ? { gradersHash } : {}),
    ...(judgeModel !== undefined ? { judgeModel } : {}),
    passRate: summary.aggregates.passRate,
    meanScore: summary.aggregates.meanScore,
    sampleCount: summary.samples.length,
    retriedCount: summary.samples.filter((s) => s.retried === true).length,
    ts: summary.endedAt,
    outDir: opts.outDir,
  };
}

/**
 * Record a completed run in the history index and return the entry that was
 * appended. Build + append in one call so no caller can write a half-shaped
 * line (see {@link runIndexEntryFromSummary}).
 */
export function recordEvalRun(summary: EvalRunSummary, opts: RecordEvalRunOptions): RunIndexEntry {
  const entry = runIndexEntryFromSummary(summary, opts);
  appendRunIndex(entry, opts.evalsDir);
  return entry;
}

/**
 * Read the run index, oldest first. Missing file → empty list. Corrupt or
 * torn lines are skipped rather than thrown — the index is an append-only
 * log and one bad line must not hide every other run.
 */
export function readRunIndex(evalsDir: string = DEFAULT_EVALS_DIR): RunIndexEntry[] {
  const path = join(evalsDir, INDEX_FILENAME);
  if (!existsSync(path)) return [];
  const entries: RunIndexEntry[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      entries.push(JSON.parse(trimmed) as RunIndexEntry);
    } catch {
      // skip corrupt line — see docstring
    }
  }
  return entries;
}

/** Read `baselines.json`. Missing file → `{}`; malformed JSON → ReportError. */
export function readBaselines(evalsDir: string = DEFAULT_EVALS_DIR): BaselinesFile {
  const path = join(evalsDir, BASELINES_FILENAME);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as BaselinesFile;
  } catch (err) {
    throw new ReportError(`failed to parse ${path}: ${(err as Error).message}`);
  }
}

/** The pinned baseline for a (spec, dataset) key, or undefined if none. */
export function getBaseline(
  specName: string,
  datasetName: string,
  evalsDir: string = DEFAULT_EVALS_DIR,
): BaselineEntry | undefined {
  return readBaselines(evalsDir)[baselineKey(specName, datasetName)];
}

/** Pin (or re-pin) the baseline for the entry's (spec, dataset) key. */
export function setBaseline(entry: BaselineEntry, evalsDir: string = DEFAULT_EVALS_DIR): void {
  mkdirSync(evalsDir, { recursive: true });
  const baselines = readBaselines(evalsDir);
  baselines[baselineKey(entry.specName, entry.datasetName)] = entry;
  writeFileSync(join(evalsDir, BASELINES_FILENAME), `${JSON.stringify(baselines, null, 2)}\n`);
}
