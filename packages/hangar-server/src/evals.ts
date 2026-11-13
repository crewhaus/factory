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
  BASELINES_FILENAME,
  type BaselinesFile,
  INDEX_FILENAME,
  type MeasurementProblem,
  type PinRefusal,
  type RunIndexEntry,
  type RunStats,
  type SampleRow,
  type SampleVerdict,
  lineageOfEntry,
  measurementProblem,
  pinRefusal,
  readBaselines,
  readRunIndexLatest,
  resolveBaseline,
  runStatsOf,
  sampleRowsOf,
} from "@crewhaus/eval-report";
import { MAX_JSONL_LINES, OPT_RUN_ID_RE, RUN_ID_RE, SAFE_SEGMENT_RE } from "./constants";
import { MAX_TEXT_BYTES } from "./constants";
import { type LaunchOffer, launchOffers } from "./eval-inputs";
import { readJsonlCapped, readTextCapped } from "./jsonl";
import { resolveInside } from "./safety";

export function isRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

/** Optimizer run ids are `opt_<hex clock>`; nothing writes `run_` there. */
export function isOptRunId(id: string): boolean {
  return OPT_RUN_ID_RE.test(id);
}

const evalsDirOf = (harnessDir: string): string => join(harnessDir, ".crewhaus", "evals");

/** Names the history file and nothing else: no parser text, no absolute path. */
const unreadableNote = (file: string): string =>
  `Couldn't read the eval history: .crewhaus/evals/${file} is not readable.`;

/** An index row, plus why it cannot be a baseline when it cannot. */
export type EvalsViewRun = RunIndexEntry & { readonly pinRefusal?: string };

/**
 * What the console says about a run that cannot be a baseline. `pinRefusal`'s own
 * sentence is written for tools and the CLI, which keep it; this is the same
 * refusal for someone reading a table, in a row that already names the run.
 */
const PIN_REFUSAL_COPY: Readonly<Record<PinRefusal["code"], string>> = {
  partial: "Stopped at its budget, so it can't be a baseline.",
  all_errored: "Every case errored, so it can't be a baseline.",
  nothing_measured: "No case got a verdict, so it can't be a baseline.",
  lineage_mismatch: "It measured something else, so it can't be this baseline.",
  regrade: "It graded another run's answers again, so it can't be a baseline.",
  protected: "It changes a protected check, so only the owner can make it the baseline.",
  receipt: "Its record could not be written, so the baseline was kept.",
  reanchor: "It was measured differently, so moving the baseline onto it is a person's call.",
};

export type EvalsView = {
  readonly runs: readonly EvalsViewRun[];
  readonly baselines: BaselinesFile;
  /** Why the history could not be read. A read failure is not "no evals". */
  readonly unreadable: string | null;
  /** Whether an eval can start here, and what to say when it cannot. */
  readonly launch: LaunchOffer;
};

/** Run-history rows + pinned baselines, and an honest word when unreadable. */
export function evalsView(harnessDir: string): EvalsView {
  const evalsDir = evalsDirOf(harnessDir);
  let runs: RunIndexEntry[] = [];
  let baselines: BaselinesFile = {};
  let unreadable: string | null = null;
  try {
    runs = readRunIndexLatest(evalsDir);
  } catch {
    unreadable = unreadableNote(INDEX_FILENAME);
  }
  try {
    baselines = readBaselines(evalsDir);
  } catch {
    unreadable ??= unreadableNote(BASELINES_FILENAME);
  }
  // Newest first for the run-history table.
  runs.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return {
    runs: runs.map((run) => {
      const refusal = pinRefusal(run);
      return refusal === undefined ? run : { ...run, pinRefusal: PIN_REFUSAL_COPY[refusal.code] };
    }),
    baselines,
    unreadable,
    launch: launchOffers(harnessDir).eval,
  };
}

export type EvalRunView = {
  readonly runId: string;
  /** Parsed `results.json` (the run summary incl. per-sample rows). */
  readonly summary: unknown;
  /** Sample dirs present under the run dir. */
  readonly sampleIds: readonly string[];
  /** The run's figures, read from the real records. */
  readonly stats: RunStats;
  /** One row per sample, joined to its directory once, here. */
  readonly rows: readonly SampleRow[];
};

/** A run's parsed `results.json`, or `null` when it is absent or torn. */
function readRunSummary(runDir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(runDir, "results.json"), "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** One run's summary + sample ids. RunId is shape-validated and re-rooted. */
export function evalRunView(harnessDir: string, runId: string): EvalRunView | undefined {
  if (!isRunId(runId)) return undefined;
  const runDir = resolveInside(harnessDir, [".crewhaus", "evals", runId]);
  if (runDir === undefined || !existsSync(runDir)) return undefined;
  // Absent or torn results still leave the sample list to render.
  const summary = readRunSummary(runDir);
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
  // The run's own index line (a resumed run's newest one), for what results.json
  // does not carry. Its recorded `outDir` is never followed.
  let row: RunIndexEntry | undefined;
  try {
    row = readRunIndexLatest(evalsDirOf(harnessDir)).find((e) => e.runId === runId);
  } catch {
    row = undefined;
  }
  return {
    runId,
    summary,
    sampleIds,
    stats: runStatsOf(summary, row),
    rows: sampleRowsOf(summary, sampleIds),
  };
}

export type EvalSampleView = {
  readonly runId: string;
  readonly sampleId: string;
  /** What the run page says about this sample: the same join, so the two agree.
   *  `null` when the run recorded nothing about it. */
  readonly verdict: SampleVerdict | null;
  /** Why, in the run's own words. An errored sample's error lands here. */
  readonly note: string;
  readonly grades: unknown;
  readonly meta: unknown;
  /** Transcript lines, capped + torn-tolerant. */
  readonly transcript: readonly unknown[];
  readonly transcriptTruncated: boolean;
};

const textField = (record: unknown, key: string): string | undefined => {
  const value =
    typeof record === "object" && record !== null
      ? (record as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string" ? value : undefined;
};

/**
 * This directory's row from the run's own join. A sample its run has no word on
 * (a torn results file, a repeat run's extra trial) falls back to what its own
 * `meta.json` recorded, so a crash never reads as a graded failure.
 */
function sampleVerdictOf(
  runDir: string,
  sampleId: string,
  grades: unknown,
  meta: unknown,
): Pick<EvalSampleView, "verdict" | "note"> {
  const row = sampleRowsOf(readRunSummary(runDir), [sampleId]).find((r) => r.dir === sampleId);
  if (row !== undefined && row.verdict !== "unknown") {
    return { verdict: row.verdict, note: row.note };
  }
  const failure = textField(meta, "error") ?? textField(meta, "graderError");
  if (failure !== undefined) return { verdict: "error", note: failure };
  const overall =
    typeof grades === "object" && grades !== null
      ? (grades as Record<string, unknown>)["overall"]
      : undefined;
  return { verdict: null, note: textField(overall, "rationale") ?? "" };
}

/** Per-sample artifacts: grades.json, meta.json, capped transcript lines. */
export function evalSampleView(
  harnessDir: string,
  runId: string,
  sampleId: string,
): EvalSampleView | undefined {
  if (!isRunId(runId) || !SAFE_SEGMENT_RE.test(sampleId)) return undefined;
  const runDir = resolveInside(harnessDir, [".crewhaus", "evals", runId]);
  const sampleDir = resolveInside(harnessDir, [".crewhaus", "evals", runId, sampleId]);
  if (runDir === undefined || sampleDir === undefined || !existsSync(sampleDir)) return undefined;
  const readJson = (name: string): unknown => {
    try {
      const { text } = readTextCapped(join(sampleDir, name), MAX_TEXT_BYTES);
      return text === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  };
  const transcript = readJsonlCapped(join(sampleDir, "transcript.jsonl"), MAX_JSONL_LINES);
  const grades = readJson("grades.json");
  const meta = readJson("meta.json");
  return {
    runId,
    sampleId,
    ...sampleVerdictOf(runDir, sampleId, grades, meta),
    grades,
    meta,
    transcript: transcript.objects,
    transcriptTruncated: transcript.truncated,
  };
}

export type EvalHealthState = "healthy" | "regressed" | "not_measured";

export type EvalHealth = { readonly state: EvalHealthState; readonly note: string };

const PROBLEM_NOTE: Readonly<Record<MeasurementProblem, string>> = {
  partial: "the latest run stopped at its budget",
  all_errored: "every case in the latest run errored",
  nothing_measured: "the latest run measured nothing",
};

/**
 * Does the newest run still meet the pinned baseline? Baselines record the
 * pinned RUN (not a pass rate), so the baseline's own figure comes from the run
 * index. Both are read with resumed runs collapsed, so a resumed baseline's
 * newest figure is the one that counts. No runs, no baseline or an unreadable
 * history is `not_measured`: nothing says the harness is healthy.
 */
export function evalHealth(evalsDir: string, specName: string): EvalHealth {
  const notMeasured = (note: string): EvalHealth => ({ state: "not_measured", note });
  let rows: RunIndexEntry[];
  try {
    rows = readRunIndexLatest(evalsDir);
  } catch {
    return notMeasured(unreadableNote(INDEX_FILENAME));
  }
  if (rows.length === 0) return notMeasured("no eval runs recorded");
  let latest = rows[0] as RunIndexEntry;
  for (const e of rows) {
    if (e.ts > latest.ts) latest = e;
  }
  // 0.6.0 §6.1 — resolve through the SHARED lineage reader: a routed or
  // arm-pinned run keys `spec::dataset::<arm|routed>`, and hand-rolling the
  // legacy two-segment key here would report "no baseline pinned" for every
  // routed harness.
  let base: ReturnType<typeof resolveBaseline>["entry"];
  try {
    base = resolveBaseline({ ...lineageOfEntry(latest), specName }, evalsDir).entry;
  } catch {
    return notMeasured(unreadableNote(BASELINES_FILENAME));
  }
  if (base === undefined) return notMeasured("no baseline pinned");
  const baseRunId = base.runId;
  const baseRun = rows.find((e) => e.runId === baseRunId);
  if (baseRun === undefined) return notMeasured("baseline run missing from index");
  const problem = measurementProblem(latest);
  if (problem !== undefined) return notMeasured(PROBLEM_NOTE[problem]);
  const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;
  if (latest.passRate + 1e-9 >= baseRun.passRate) {
    return {
      state: "healthy",
      note: `latest ${pct(latest.passRate)} holds baseline ${pct(baseRun.passRate)}`,
    };
  }
  return {
    state: "regressed",
    note: `pass rate ${pct(latest.passRate)} below baseline ${pct(baseRun.passRate)} (${latest.datasetName})`,
  };
}

/** The fleet row's flag: `null` is "unknown", which no surface reads as a pass. */
export function evalHealthyFlag(health: EvalHealth): boolean | null {
  if (health.state === "not_measured") return null;
  return health.state === "healthy";
}
