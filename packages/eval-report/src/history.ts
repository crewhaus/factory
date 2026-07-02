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
  readonly datasetName: string;
  /** sha256 hex of the dataset file bytes (see {@link hashDatasetFile}). */
  readonly datasetHash: string;
  readonly passRate: number;
  readonly meanScore: number;
  readonly sampleCount: number;
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
  /** Absolute path to the baseline run's output directory. */
  readonly outDir: string;
  /** Dataset content hash at the time the baseline was pinned. */
  readonly datasetHash: string;
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
