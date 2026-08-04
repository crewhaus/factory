/**
 * Read-only eval views over `@crewhaus/eval-report`'s on-disk history:
 * `index.jsonl` (latest entry per runId), `baselines.json`, and the per-run
 * output dirs. Every path is built from validated ids under the harness's
 * `.crewhaus/evals` — the index's recorded absolute `outDir` is deliberately
 * NOT followed (it goes stale on relocation and points outside the allowed
 * root); the run dir is re-rooted under the harness instead.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type BaselinesFile,
  type RunIndexEntry,
  readBaselines,
  readRunIndex,
  readRunIndexLatest,
} from "@crewhaus/eval-report";
import { MAX_JSONL_LINES, RUN_ID_RE, SAFE_SEGMENT_RE } from "./constants";
import { MAX_TEXT_BYTES } from "./constants";
import { readJsonlCapped, readTextCapped } from "./jsonl";
import { resolveInside } from "./safety";

export function isRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

const evalsDirOf = (harnessDir: string): string => join(harnessDir, ".crewhaus", "evals");

export type EvalsView = {
  readonly runs: readonly RunIndexEntry[];
  readonly baselines: BaselinesFile;
};

/** Run-history rows + pinned baselines. Unreadable history reads as empty. */
export function evalsView(harnessDir: string): EvalsView {
  const evalsDir = evalsDirOf(harnessDir);
  let runs: RunIndexEntry[] = [];
  let baselines: BaselinesFile = {};
  try {
    runs = readRunIndexLatest(evalsDir);
  } catch {
    runs = [];
  }
  try {
    baselines = readBaselines(evalsDir);
  } catch {
    baselines = {};
  }
  // Newest first for the run-history table.
  runs.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { runs, baselines };
}

export type EvalRunView = {
  readonly runId: string;
  /** Parsed `results.json` (the run summary incl. per-sample rows). */
  readonly summary: unknown;
  /** Sample dirs present under the run dir. */
  readonly sampleIds: readonly string[];
};

/** One run's summary + sample ids. RunId is shape-validated and re-rooted. */
export function evalRunView(harnessDir: string, runId: string): EvalRunView | undefined {
  if (!isRunId(runId)) return undefined;
  const runDir = resolveInside(harnessDir, [".crewhaus", "evals", runId]);
  if (runDir === undefined || !existsSync(runDir)) return undefined;
  const resultsPath = join(runDir, "results.json");
  let summary: unknown = null;
  try {
    summary = JSON.parse(readFileSync(resultsPath, "utf8")) as unknown;
  } catch {
    summary = null; // absent/torn results — the sample list still renders
  }
  const sampleIds: string[] = [];
  try {
    for (const entry of readdirSync(runDir).sort()) {
      if (!SAFE_SEGMENT_RE.test(entry)) continue;
      try {
        if (statSync(join(runDir, entry)).isDirectory()) sampleIds.push(entry);
      } catch {
        // vanished mid-scan
      }
    }
  } catch {
    // unreadable run dir — empty sample list
  }
  return { runId, summary, sampleIds };
}

export type EvalSampleView = {
  readonly runId: string;
  readonly sampleId: string;
  readonly grades: unknown;
  readonly meta: unknown;
  /** Transcript lines, capped + torn-tolerant. */
  readonly transcript: readonly unknown[];
  readonly transcriptTruncated: boolean;
};

/** Per-sample artifacts: grades.json, meta.json, capped transcript lines. */
export function evalSampleView(
  harnessDir: string,
  runId: string,
  sampleId: string,
): EvalSampleView | undefined {
  if (!isRunId(runId) || !SAFE_SEGMENT_RE.test(sampleId)) return undefined;
  const sampleDir = resolveInside(harnessDir, [".crewhaus", "evals", runId, sampleId]);
  if (sampleDir === undefined || !existsSync(sampleDir)) return undefined;
  const readJson = (name: string): unknown => {
    try {
      const { text } = readTextCapped(join(sampleDir, name), MAX_TEXT_BYTES);
      return text === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  };
  const transcript = readJsonlCapped(join(sampleDir, "transcript.jsonl"), MAX_JSONL_LINES);
  return {
    runId,
    sampleId,
    grades: readJson("grades.json"),
    meta: readJson("meta.json"),
    transcript: transcript.objects,
    transcriptTruncated: transcript.truncated,
  };
}

/** Eval-health note for the detail card: does the newest run still meet the
 *  pinned baseline? Baselines record the pinned RUN (not a pass rate), so
 *  the baseline's own figure comes from the run index. */
export function evalHealth(evalsDir: string, specName: string): { healthy: boolean; note: string } {
  try {
    const all = readRunIndex(evalsDir);
    if (all.length === 0) return { healthy: true, note: "no eval runs recorded" };
    let latest = all[0] as RunIndexEntry;
    for (const e of all) {
      if (e.ts > latest.ts) latest = e;
    }
    const baselines = readBaselines(evalsDir);
    const base = baselines[`${specName}::${latest.datasetName}`];
    if (base === undefined) return { healthy: true, note: "no baseline pinned" };
    const baseRun = all.find((e) => e.runId === base.runId);
    if (baseRun === undefined) {
      return { healthy: true, note: "baseline run missing from index" };
    }
    const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;
    if (latest.passRate + 1e-9 >= baseRun.passRate) {
      return {
        healthy: true,
        note: `latest ${pct(latest.passRate)} holds baseline ${pct(baseRun.passRate)}`,
      };
    }
    return {
      healthy: false,
      note: `pass rate ${pct(latest.passRate)} below baseline ${pct(baseRun.passRate)} (${latest.datasetName})`,
    };
  } catch {
    return { healthy: true, note: "eval history unreadable" };
  }
}
