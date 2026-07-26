/**
 * NEW-HUNT-6 — resume an interrupted eval run.
 *
 * A run persists per-sample artifacts INCREMENTALLY (`<runDir>/<sampleId>/
 * {transcript.jsonl, events.jsonl, grades.json, meta.json}`) and writes its
 * config snapshot (`run.json`) up front, so a run killed by ctrl-C, a crash
 * or a budget stop leaves everything already paid for on disk — and, before
 * this, re-running re-invoked the agent AND the judge for every one of those
 * samples again.
 *
 * `crewhaus eval --resume <runDir>` re-opens the directory, refuses loudly
 * when the run's identity moved (vs the recorded `run.json` — resuming into a
 * run graded by a different instrument would silently splice two measurements
 * together), reloads every sample that already has `grades.json`, runs only
 * the missing ones, and re-aggregates the UNION.
 *
 * "Identity" is every recorded field the MEASUREMENT depends on, not just the
 * three hashes: `specHash` / `datasetHash` / `gradersHash`, plus `repeats`
 * (a pass@k measurement is not a single-trial one), `seed` (trial seeds move
 * with it) and `toolRecording` (a cassette-replayed sample and a live-tool
 * sample are different runs). The last three are NORMALIZED rather than
 * skipped-when-absent: `run.json` omits `repeats` only when it was 1, omits
 * `seed` only when there was none, and omits `toolRecording` only when tools
 * ran live — so an absent field is a KNOWN value, and dropping `--repeats 3`
 * on the resume is caught the same way editing the rubric is.
 *
 * The reload is deliberately built from the artifacts a completed sample
 * ALREADY writes — no new per-sample file, so an interrupted run recorded by
 * any prior CLI resumes fine and an un-resumed run stays byte-identical.
 * Two fields are therefore reconstructed rather than read back:
 *   - `agentOutput` — recovered from the sample's `transcript.jsonl` (the last
 *     `assistant_message`'s text blocks); "" when the transcript is absent.
 *   - `metadata` — taken from the sample as the CURRENT dataset carries it
 *     (the hash check above already proved the dataset did not move).
 * `retried` is not recoverable (meta.json never carried it), so a reloaded
 * sample never claims a retry it cannot prove.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import type { GradeResult } from "@crewhaus/eval-grader";
import { RunnerError } from "./errors";
import type { EvalToolRecordingConfig, SampleMetrics, SampleResult, TrialResult } from "./types";

/** The run-level config snapshot every run writes before its first sample. */
export const RUN_MANIFEST_FILENAME = "run.json";

/**
 * Per-sample artifact directory name. Sample ids are sanitized so the on-disk
 * layout stays flat; resume must address the exact same directory `runSample`
 * wrote, so both sides share this one function.
 */
export function sampleArtifactDirName(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * The identity fields `--resume` checks, read back from `run.json`. Every
 * hash is optional because the runner records each only when the caller
 * supplied it (`datasetHash`/`gradersHash` are CLI-threaded); an absent
 * recorded hash cannot be compared and therefore never blocks a resume.
 */
export type ResumeManifest = {
  readonly runId: string;
  readonly startedAt?: string;
  readonly specHash?: string;
  readonly datasetHash?: string;
  readonly gradersHash?: string;
  /**
   * The judge model the recorded run's `llm_judge` graders were bound to
   * (`--judge-model`). Part of the identity set for the same reason
   * `gradersHash` is: `judgeModel` is a RUN-LEVEL override that lives in
   * neither the spec nor graders.yaml, so without it a resume could grade
   * the remaining samples with a DIFFERENT judge than the reused ones and
   * report the union as one measurement.
   */
  readonly judgeModel?: string;
  /** G15 trials per sample. Recorded only when > 1; absent reads as 1. */
  readonly repeats?: number;
  /** The recorded run's `--seed`, when it pinned one. */
  readonly seed?: number;
  /**
   * NEW-HUNT-4 — how the recorded run treated tools. Absent means every tool
   * ran LIVE, so absence is a known value, not an unknown one.
   */
  readonly toolRecording?: ResumeToolRecording;
  /**
   * Every attempt that re-opened this directory, oldest first (the run's own
   * first pass is not an attempt). Tolerates the legacy scalar form.
   */
  readonly resumedAt?: readonly string[];
  /**
   * NEW-HUNT-3 — dollars this run's EARLIER attempts already metered against
   * `budgetUsd`, amended onto `run.json` at the end of every metered attempt.
   * NOT an identity field (it never refuses a resume): the budget meter
   * restarts at zero on every attempt, so this is what lets the runner SAY
   * that a `--budget-usd` cap is being re-armed rather than silently
   * authorising another full cap's worth of spend. Absent on runs that never
   * metered (no budget, or no pricing row for the model).
   */
  readonly spentUsd?: number;
};

/** The identity-relevant half of `run.json`'s `toolRecording` block. */
export type ResumeToolRecording = {
  readonly mode: "record" | "replay";
  /** Replay only — sha256 of the cassette, so a DIFFERENT cassette is caught. */
  readonly recordingHash?: string;
};

/** Read `<runDir>/run.json`. Missing/malformed/id-less is a loud refusal. */
export function readRunManifest(
  runDir: string,
  read?: (path: string) => string | undefined,
): ResumeManifest {
  const path = join(runDir, RUN_MANIFEST_FILENAME);
  const readFile = read ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf-8") : undefined));
  const text = readFile(path);
  if (text === undefined) {
    throw new RunnerError(
      `cannot resume ${runDir} — no ${RUN_MANIFEST_FILENAME} there (every eval run writes one before its first sample; is this a run directory?)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RunnerError(
      `cannot resume ${runDir} — ${RUN_MANIFEST_FILENAME} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const obj = parsed as Partial<ResumeManifest> | null;
  if (obj === null || typeof obj !== "object" || typeof obj.runId !== "string") {
    throw new RunnerError(
      `cannot resume ${runDir} — ${RUN_MANIFEST_FILENAME} has no runId (not an eval run directory)`,
    );
  }
  const resumedAt = normalizeResumedAt((obj as { resumedAt?: unknown }).resumedAt);
  const toolRecording = normalizeToolRecording((obj as { toolRecording?: unknown }).toolRecording);
  return {
    runId: obj.runId,
    ...(typeof obj.startedAt === "string" ? { startedAt: obj.startedAt } : {}),
    ...(typeof obj.specHash === "string" ? { specHash: obj.specHash } : {}),
    ...(typeof obj.datasetHash === "string" ? { datasetHash: obj.datasetHash } : {}),
    ...(typeof obj.gradersHash === "string" ? { gradersHash: obj.gradersHash } : {}),
    ...(typeof obj.judgeModel === "string" ? { judgeModel: obj.judgeModel } : {}),
    ...(typeof obj.repeats === "number" ? { repeats: obj.repeats } : {}),
    ...(typeof obj.seed === "number" ? { seed: obj.seed } : {}),
    ...(toolRecording !== undefined ? { toolRecording } : {}),
    ...(resumedAt.length > 0 ? { resumedAt } : {}),
    ...(typeof obj.spentUsd === "number" && Number.isFinite(obj.spentUsd) && obj.spentUsd > 0
      ? { spentUsd: obj.spentUsd }
      : {}),
  };
}

/** Read back `run.json`'s `toolRecording` block, ignoring anything malformed. */
function normalizeToolRecording(value: unknown): ResumeToolRecording | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const mode = (value as { mode?: unknown }).mode;
  if (mode !== "record" && mode !== "replay") return undefined;
  const hash = (value as { recordingHash?: unknown }).recordingHash;
  return { mode, ...(typeof hash === "string" ? { recordingHash: hash } : {}) };
}

/**
 * Read back `run.json`'s resume ledger. The field is an append-only ARRAY
 * (one ISO stamp per attempt) so a second resume does not erase the first;
 * a bare string is accepted as the one-attempt legacy form.
 */
function normalizeResumedAt(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** The identity of the run being STARTED, to compare against the manifest. */
export type ResumeIdentity = {
  readonly specHash: string;
  readonly datasetHash?: string;
  readonly gradersHash?: string;
  /** `--judge-model` for THIS attempt (see {@link ResumeManifest.judgeModel}). */
  readonly judgeModel?: string;
  /** `--repeats` for THIS attempt; absent reads as 1. */
  readonly repeats?: number;
  /** `--seed` for THIS attempt. */
  readonly seed?: number;
  /** How THIS attempt treats tools; absent = live (see the manifest field). */
  readonly toolRecording?: EvalToolRecordingConfig;
};

/**
 * The comparable form of a tool-execution mode: `live` when tools ran against
 * the world, `record` while a cassette was being written, `replay:<hash>` for
 * a specific cassette. Absent ⇒ `live`, never "unknown".
 */
function toolRecordingLabel(
  value: ResumeToolRecording | EvalToolRecordingConfig | undefined,
): string {
  if (value === undefined) return "live";
  if (value.mode === "replay") return `replay:${value.recordingHash ?? "(unhashed)"}`;
  return "record";
}

/**
 * Every identity field that moved since the run was recorded, as
 * human-readable lines. A field the manifest never recorded is skipped (it
 * cannot be compared); a field the CURRENT run does not carry while the
 * manifest does IS a mismatch — dropping `--graders` between attempts changes
 * the measurement just as surely as editing the rubric.
 *
 * The set covers the whole measurement INSTRUMENT, not just the hashes:
 * `judgeModel` and `seed` are run-level CLI overrides that appear in neither
 * the spec nor graders.yaml (so neither hash moves when they do), `repeats`
 * decides whether a sample carries a pass@k at all, and `toolRecording` says
 * whether the samples faced the world or a cassette. Resuming across any of
 * them would splice two different measurements into one run.
 *
 * `repeats`, `seed` and `toolRecording` are NORMALIZED rather than
 * skipped-when-absent: run.json omits them only for the known defaults (1, no
 * seed, live tools), so an absent value is a KNOWN value — and ADDING
 * `--seed 7` or dropping `--repeats 3` on the resume is caught just like
 * editing the rubric is.
 */
export function resumeMismatches(manifest: ResumeManifest, current: ResumeIdentity): string[] {
  const out: string[] = [];
  const check = (label: string, was: string | undefined, now: string | undefined): void => {
    if (was === undefined) return;
    if (now === was) return;
    out.push(`${label}: ${was} (recorded) → ${now ?? "(none)"} (this run)`);
  };
  check("specHash", manifest.specHash, current.specHash);
  check("datasetHash", manifest.datasetHash, current.datasetHash);
  check("gradersHash", manifest.gradersHash, current.gradersHash);
  check("judgeModel", manifest.judgeModel, current.judgeModel);
  // `seed` is recorded only when the run pinned one, so an absent value means
  // "unseeded" — comparable in BOTH directions (adding a seed to a resume
  // would seed only the samples that had not been paid for yet).
  const wasSeed = manifest.seed !== undefined ? String(manifest.seed) : "(none)";
  const nowSeed = current.seed !== undefined ? String(current.seed) : "(none)";
  if (wasSeed !== nowSeed) {
    out.push(`seed: ${wasSeed} (recorded) → ${nowSeed} (this run)`);
  }
  // `repeats` is recorded only when > 1, so an ABSENT value is not "unknown"
  // — it means 1. Normalize both sides and always compare.
  const wasRepeats = manifest.repeats ?? 1;
  const nowRepeats = current.repeats ?? 1;
  if (wasRepeats !== nowRepeats) {
    out.push(`repeats: ${wasRepeats} (recorded) → ${nowRepeats} (this run)`);
  }
  // NEW-HUNT-4 × NEW-HUNT-6 — same normalization: an absent block means the
  // tools ran live, so switching a run onto (or off) a cassette mid-resume is
  // a mismatch, and so is replaying a DIFFERENT cassette.
  const wasTools = toolRecordingLabel(manifest.toolRecording);
  const nowTools = toolRecordingLabel(current.toolRecording);
  if (wasTools !== nowTools) {
    out.push(`toolRecording: ${wasTools} (recorded) → ${nowTools} (this run)`);
  }
  return out;
}

/** Refuse the resume — loudly, listing every field that moved. */
export function assertResumeCompatible(
  runDir: string,
  manifest: ResumeManifest,
  current: ResumeIdentity,
): void {
  const mismatches = resumeMismatches(manifest, current);
  if (mismatches.length === 0) return;
  throw new RunnerError(
    `cannot resume ${runDir} (run ${manifest.runId}) — its identity moved:\n  - ${mismatches.join(
      "\n  - ",
    )}\nresuming would splice two different measurements into one run; start a fresh run instead`,
  );
}

export type LoadCompletedSampleArgs = {
  /** The run directory being resumed. */
  readonly runDir: string;
  /** The sample as the CURRENT dataset carries it (source of `metadata`). */
  readonly sample: Sample;
  /** `ir.agent.model` — meta.json records it too; the arg is the fallback. */
  readonly model: string;
  /** G15 trials per sample; > 1 requires EVERY trial dir to be complete. */
  readonly repeats?: number;
};

/**
 * Reload a sample that already completed in the run directory, or
 * `undefined` when it did not (so the caller runs it). "Completed" means
 * `grades.json` AND `meta.json` are present and parseable for the canonical
 * trial — and, under `repeats > 1`, for EVERY trial directory: a sample
 * interrupted between trial 2 and trial 3 has no honest `trialPassRate`, so it
 * re-runs whole rather than reporting a truncated pass@k.
 */
export function loadCompletedSample(args: LoadCompletedSampleArgs): SampleResult | undefined {
  const repeats = args.repeats ?? 1;
  const base = join(args.runDir, sampleArtifactDirName(args.sample.id));
  const trials: Array<{ grades: SampleGrades; meta: SampleMeta; dir: string }> = [];
  for (let trial = 1; trial <= repeats; trial++) {
    const dir = trial > 1 ? `${base}.trial${trial}` : base;
    const grades = readJson<SampleGrades>(join(dir, "grades.json"));
    const meta = readJson<SampleMeta>(join(dir, "meta.json"));
    if (grades === undefined || meta === undefined) return undefined;
    if (typeof grades.overall?.passed !== "boolean" || typeof meta.sessionId !== "string") {
      return undefined;
    }
    trials.push({ grades, meta, dir });
  }
  const first = trials[0];
  if (first === undefined) return undefined;

  const canonical: SampleResult = {
    sampleId: args.sample.id,
    sessionId: first.meta.sessionId,
    startedAt: first.meta.startedAt ?? "",
    endedAt: first.meta.endedAt ?? "",
    latencyMs: first.meta.latencyMs ?? 0,
    turns: first.meta.turns ?? 0,
    tokens: first.meta.tokens ?? { input: 0, output: 0 },
    model: first.meta.model ?? args.model,
    agentOutput: readAgentOutput(join(first.dir, "transcript.jsonl")),
    ...(args.sample.metadata !== undefined ? { metadata: args.sample.metadata } : {}),
    grades: { overall: first.grades.overall, perGrader: first.grades.perGrader ?? [] },
    ...(first.meta.metrics !== undefined ? { metrics: first.meta.metrics } : {}),
    ...(first.meta.error !== undefined ? { error: first.meta.error } : {}),
    ...(first.meta.graderError !== undefined ? { graderError: first.meta.graderError } : {}),
  };
  if (repeats === 1) return canonical;

  const trialResults: TrialResult[] = trials.map((t, i) => ({
    trial: i + 1,
    sessionId: t.meta.sessionId,
    // The seed the trial ACTUALLY ran with, read back from its meta.json —
    // never re-derived from this attempt's `--seed`, which would let a
    // resume stamp reused trials with seeds they were never run under.
    // Absent in the artifact ⇒ absent here.
    ...(typeof t.meta.seed === "number" ? { seed: t.meta.seed } : {}),
    passed: t.grades.overall.passed,
    score: t.grades.overall.score,
    rationale: t.grades.overall.rationale,
    ...(t.grades.overall.abstained === true ? { abstained: true } : {}),
    latencyMs: t.meta.latencyMs ?? 0,
    tokens: t.meta.tokens ?? { input: 0, output: 0 },
    ...(t.meta.error !== undefined ? { error: t.meta.error } : {}),
    ...(t.meta.graderError !== undefined ? { graderError: t.meta.graderError } : {}),
  }));
  const passCount = trialResults.filter((t) => t.passed).length;
  const trialPassRate = passCount / trialResults.length;
  return {
    ...canonical,
    trials: trialResults,
    trialPassRate,
    // C34 — a reloaded sample is flagged by the SAME rule the freshly-run
    // path applies (see runEval). Without this a resumed results.json holds
    // two classes of flaky sample that disagree: `aggregates.flakySampleIds`
    // (derived from trialPassRate) would list a sample whose own `flaky`
    // field is absent — and `eval-report export`, the very CSV the flake
    // line tells the user to triage with, emits `flaky=false` for it.
    ...(trialPassRate > 0 && trialPassRate < 1 ? { flaky: true } : {}),
  };
}

type SampleGrades = {
  overall: GradeResult;
  perGrader?: Array<{ name: string } & GradeResult>;
};

type SampleMeta = {
  sessionId: string;
  startedAt?: string;
  endedAt?: string;
  latencyMs?: number;
  turns?: number;
  tokens?: { input: number; output: number };
  model?: string;
  metrics?: SampleMetrics;
  error?: string;
  graderError?: string;
  /** The seed this trial ran with (`runSample` records it when pinned). */
  seed?: number;
};

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Recover the sample's final assistant text from its event-log transcript.
 * Best-effort by design: a stub-invoker run (or one killed mid-write) simply
 * yields "" and the reloaded sample keeps its real grades — the grade, not the
 * echoed output, is what the aggregates and the gate read.
 */
function readAgentOutput(transcriptPath: string): string {
  if (!existsSync(transcriptPath)) return "";
  let text: string;
  try {
    text = readFileSync(transcriptPath, "utf-8");
  } catch {
    return "";
  }
  let out = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let ev: { kind?: unknown; payload?: unknown };
    try {
      ev = JSON.parse(trimmed) as { kind?: unknown; payload?: unknown };
    } catch {
      continue;
    }
    if (ev.kind !== "assistant_message") continue;
    const content = (ev.payload as { content?: unknown } | null)?.content;
    if (typeof content === "string") {
      out = content;
    } else if (Array.isArray(content)) {
      out = content
        .filter(
          (b): b is { type: "text"; text: string } =>
            (b as { type?: unknown })?.type === "text" &&
            typeof (b as { text?: unknown }).text === "string",
        )
        .map((b) => b.text)
        .join("");
    }
  }
  return out;
}
