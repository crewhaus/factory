/**
 * The console's reading of a run: one join of `results.json`, the index row and
 * the sample directories on disk, done once, so a view never has to guess a
 * shape.
 *
 * `results.json` is read as what it might not be (a torn file, an older run), so
 * everything is checked on the way in. A shape this does not recognise reads as
 * `null` and `unknown`, never as a pass or a zero. Cost comes from the index row
 * alone: the run summary carries none, and absent is `null`, not `$0`.
 */
import {
  type SampleResult,
  sampleAbstained,
  sampleArtifactDirName,
  sampleIsCanary,
  sampleNeedsReview,
} from "@crewhaus/eval-runner";
import type { RunIndexEntry } from "./history";

export type RunStats = {
  readonly passRate: number | null;
  readonly meanScore: number | null;
  readonly sampleCount: number | null;
  readonly errorCount: number | null;
  readonly measuredCount: number | null;
  readonly costUsd: number | null;
  readonly partial: boolean;
  readonly replayed: boolean;
  readonly flakyCount: number;
};

export type SampleVerdict = "pass" | "fail" | "error" | "abstained" | "canary" | "unknown";

export type SampleRow = {
  readonly sampleId: string;
  /** The sample's directory under the run, or `null` when it has none to open. */
  readonly dir: string | null;
  readonly verdict: SampleVerdict;
  /** `null` where the recorded score is only a placeholder for no verdict. */
  readonly score: number | null;
  readonly note: string;
  readonly flaky: boolean;
  readonly needsReview: boolean;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asText = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A record the runner really wrote: an id and an overall grade. */
function isSampleResult(value: unknown): value is SampleResult {
  const sample = asRecord(value);
  if (sample === undefined || typeof sample["sampleId"] !== "string") return false;
  const overall = asRecord(asRecord(sample["grades"])?.["overall"]);
  return overall !== undefined && typeof overall["passed"] === "boolean";
}

const isErrored = (s: SampleResult): boolean =>
  s.error !== undefined || s.graderError !== undefined;

function verdictOf(s: SampleResult): SampleVerdict {
  if (isErrored(s)) return "error";
  if (sampleIsCanary(s)) return "canary";
  if (sampleAbstained(s)) return "abstained";
  return s.grades.overall.passed === true ? "pass" : "fail";
}

/** The summary's real sample records, or `undefined` when it holds none. */
function samplesOf(summary: Record<string, unknown> | undefined): SampleResult[] | undefined {
  const samples = summary?.["samples"];
  if (!Array.isArray(samples)) return undefined;
  const real = samples.filter(isSampleResult);
  return samples.length > 0 && real.length === 0 ? undefined : real;
}

/** A run's headline figures. `row` is the run's index line, when it has one. */
export function runStatsOf(summary: unknown, row?: RunIndexEntry): RunStats {
  const record = asRecord(summary);
  const aggregates = asRecord(record?.["aggregates"]);
  const samples = samplesOf(record);
  const toolRecording = asRecord(asRecord(record?.["config"])?.["toolRecording"]);
  return {
    passRate: asNumber(aggregates?.["passRate"]) ?? asNumber(row?.passRate) ?? null,
    meanScore: asNumber(aggregates?.["meanScore"]) ?? asNumber(row?.meanScore) ?? null,
    sampleCount: samples?.length ?? asNumber(row?.sampleCount) ?? null,
    errorCount: samples?.filter(isErrored).length ?? asNumber(row?.errorCount) ?? null,
    measuredCount:
      samples?.filter((s) => !isErrored(s) && !sampleAbstained(s) && !sampleIsCanary(s)).length ??
      asNumber(row?.measuredCount) ??
      null,
    costUsd: asNumber(row?.costUsd) ?? null,
    // `partial` in results.json is an object saying why, not a boolean.
    partial: record?.["partial"] !== undefined || row?.partial === true,
    replayed: row?.replayed === true || toolRecording?.["mode"] === "replay",
    flakyCount: asNumber(aggregates?.["flaky"]) ?? asNumber(row?.flakyCount) ?? 0,
  };
}

/** A repeat run's extra trial directory (`<sample>.trial2`): not a sample. */
const TRIAL_DIR_RE = /\.trial\d+$/;

/**
 * One row per sample. `dirNames` is what the caller found on disk and has
 * already shape-checked: a row links only to a directory in that list. A
 * directory no summary row claims is still listed, as `unknown`, so a torn
 * results file leaves the samples reachable.
 */
export function sampleRowsOf(summary: unknown, dirNames: readonly string[]): SampleRow[] {
  const onDisk = new Set(dirNames);
  const claimed = new Set<string>();
  const rows: SampleRow[] = [];
  const dirFor = (sampleId: string): string | null => {
    const dir = sampleArtifactDirName(sampleId);
    if (!onDisk.has(dir)) return null;
    claimed.add(dir);
    return dir;
  };
  const samples = asRecord(summary)?.["samples"];
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (isSampleResult(sample)) {
      const verdict = verdictOf(sample);
      const overall = sample.grades.overall;
      const score = verdict === "pass" || verdict === "fail" ? asNumber(overall.score) : undefined;
      rows.push({
        sampleId: sample.sampleId,
        dir: dirFor(sample.sampleId),
        verdict,
        score: score ?? null,
        note: asText(sample.error) ?? asText(sample.graderError) ?? asText(overall.rationale) ?? "",
        flaky: sample.flaky === true,
        needsReview: sampleNeedsReview(sample),
      });
      continue;
    }
    const sampleId = asText(asRecord(sample)?.["sampleId"]);
    if (sampleId !== undefined) rows.push(unknownRow(sampleId, dirFor(sampleId)));
  }
  for (const name of dirNames) {
    if (!claimed.has(name) && !TRIAL_DIR_RE.test(name)) rows.push(unknownRow(name, name));
  }
  return rows;
}

function unknownRow(sampleId: string, dir: string | null): SampleRow {
  return {
    sampleId,
    dir,
    verdict: "unknown",
    score: null,
    note: "",
    flaky: false,
    needsReview: false,
  };
}
