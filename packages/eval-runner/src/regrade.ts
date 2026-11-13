/**
 * Regrade: grade the answers a recorded run already holds with the graders as
 * they are now, without running the agent again.
 *
 * {@link createRegrade} reads a source run directory and returns what
 * `runEval` needs for it (`RunEvalOptions.regrade`): an invoker that hands
 * each case's recorded answer, transcript, trace events and proof bundle back
 * instead of calling the agent, and the rules for each case and grader:
 *
 * - A case cannot be regraded when the source run holds no answer for it, its
 *   answer errored, its files are missing or lie outside the source run's
 *   directory, or the case changed since (its digest differs from the source
 *   run's `cases.json`, or the dataset changed and the source recorded no
 *   digests). Every grader then records it as not measured
 *   (`not_regradable`), and nothing is called.
 * - A grader whose inputs a recorded run does not keep (`regradable` false on
 *   its entry, as for a `.crewhaus/graders` plugin) records the case as not
 *   measured (`not_regradable`) without being called.
 * - A grader whose spec digest equals the one the source run recorded for it
 *   (`config.criteria`) takes its recorded grade instead of grading again, so
 *   moving a criterion between observing and enforcing makes no judge call.
 *   A recorded skip is graded again, because it holds no verdict; so is every
 *   grader when the run-level judge model differs, and a judge whose cut came
 *   from a calibration, which may have moved since.
 *
 * A source run with more than one trial per case is refused: a regrade grades
 * one answer per case.
 *
 * Every file is read by its real path, contained in the source run's real
 * directory with `relative()`.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Sample } from "@crewhaus/eval-dataset";
import type { GradeResult } from "@crewhaus/eval-grader";
import type { Event as TranscriptEvent } from "@crewhaus/event-log";
import type { ProofBundle } from "@crewhaus/provability";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { CASES_FILENAME, CASES_VERSION, caseDigestOf } from "./cases";
import { RunnerError } from "./errors";
import { PROOF_FILENAME } from "./provability";
import { sampleArtifactDirName } from "./resume";
import type { AgentInvoker, EvalRunSummary, SampleResult } from "./types";

/** Most bytes read from a source run's `results.json`. */
const RESULTS_MAX_BYTES = 256 * 1024 * 1024;
/** Most bytes read from one recorded file of a case. */
const FILE_MAX_BYTES = 64 * 1024 * 1024;

/** Why a run is graded again: a regrade the user asked for, or a preview of an edit. */
export type RegradePurpose = "regrade" | "preview";

/** What `runEval` reads for a regrade (`RunEvalOptions.regrade`). */
export type RegradePlan = {
  /** The source run's id, recorded as `config.regradeOf`. */
  readonly of: string;
  readonly purpose: RegradePurpose;
  /** Hands back each case's recorded answer; never calls the agent. */
  readonly invoker: AgentInvoker;
  /** Why a case cannot be regraded, or `undefined` when it can. */
  readonly caseRefusal: (sampleId: string) => string | undefined;
  /** The recorded grade a grader takes for a case instead of grading again. */
  readonly reuse: (sampleId: string, graderName: string) => GradeResult | undefined;
};

/** One criterion's record as a run keeps it (`config.criteria`). */
export type RecordedCriterion = {
  readonly id: string;
  readonly graders: ReadonlyArray<{ readonly name: string; readonly digest: string }>;
};

export type CreateRegradeArgs = {
  /** The source run directory. */
  readonly sourceDir: string;
  readonly purpose: RegradePurpose;
  /** The dataset's cases, as this regrade will run them. */
  readonly samples: ReadonlyArray<Sample>;
  /** The dataset's content hash, compared with the source run's when it kept no digests. */
  readonly datasetHash?: string;
  /** The criteria the regrade measures with (`RunEvalOptions.criteria`), for reuse. */
  readonly criteria?: ReadonlyArray<RecordedCriterion>;
  /** The judge model the regrade binds (`RunEvalOptions.judgeModel`), for reuse. */
  readonly judgeModel?: string;
};

/** The real path of `path` when it lies inside `root`, else `undefined`. Missing: `null`. */
function contained(root: string, path: string): string | undefined | null {
  if (!existsSync(path)) return null;
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return null;
  }
  const rel = relative(root, real);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? real : undefined;
}

/** A file's text, read by its contained real path. Throws when it lies outside. */
function readContained(root: string, path: string, maxBytes: number): string | undefined {
  const real = contained(root, path);
  if (real === null) return undefined;
  if (real === undefined) {
    throw new RunnerError(`regrade: ${path} lies outside the source run directory ${root}`);
  }
  const stat = statSync(real);
  if (!stat.isFile()) return undefined;
  if (stat.size > maxBytes) {
    throw new RunnerError(`regrade: ${path} is larger than ${maxBytes} bytes`);
  }
  return readFileSync(real, "utf-8");
}

/** JSON lines, skipping a line that does not parse as an object. */
function jsonLines<T>(text: string | undefined): T[] {
  if (text === undefined) return [];
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        out.push(parsed as T);
      }
    } catch {
      // a torn line is left out
    }
  }
  return out;
}

/** A recorded run, read for regrading. */
export type RecordedRun = {
  /** The source run directory's real path. */
  readonly dir: string;
  readonly summary: EvalRunSummary;
  /** `cases.json`'s digests, when the run kept them. */
  readonly cases?: Readonly<Record<string, string>>;
};

/** Read a run directory's `results.json` and `cases.json`. Throws {@link RunnerError}. */
export function readRecordedRun(sourceDir: string): RecordedRun {
  let dir: string;
  try {
    dir = realpathSync(sourceDir);
  } catch {
    throw new RunnerError(`regrade: no run directory at ${sourceDir}`);
  }
  const text = readContained(dir, join(dir, "results.json"), RESULTS_MAX_BYTES);
  if (text === undefined) {
    throw new RunnerError(
      `regrade: ${sourceDir} holds no results.json — only a finished run can be regraded`,
    );
  }
  let summary: EvalRunSummary;
  try {
    summary = JSON.parse(text) as EvalRunSummary;
  } catch (err) {
    throw new RunnerError(
      `regrade: ${sourceDir}/results.json does not parse: ${(err as Error).message}`,
    );
  }
  if (typeof summary !== "object" || summary === null || !Array.isArray(summary.samples)) {
    throw new RunnerError(`regrade: ${sourceDir}/results.json is not a run summary`);
  }
  let cases: Record<string, string> | undefined;
  const casesText = readContained(dir, join(dir, CASES_FILENAME), FILE_MAX_BYTES);
  if (casesText !== undefined) {
    try {
      const parsed = JSON.parse(casesText) as { version?: unknown; digests?: unknown };
      if (
        parsed.version === CASES_VERSION &&
        typeof parsed.digests === "object" &&
        parsed.digests !== null
      ) {
        cases = {};
        for (const [id, d] of Object.entries(parsed.digests as Record<string, unknown>)) {
          if (typeof d === "string") cases[id] = d;
        }
      }
    } catch {
      cases = undefined;
    }
  }
  return { dir, summary, ...(cases !== undefined ? { cases } : {}) };
}

/**
 * An invoker that returns each case's recorded answer, transcript, trace
 * events and proof bundle from `<sourceDir>/<case dir>`. It never calls the
 * agent. A case the run holds no answer for gets an empty answer; the plan's
 * {@link RegradePlan.caseRefusal} keeps every grader off it.
 */
export function createRecordedInvoker(args: {
  readonly sourceDir: string;
  readonly cases: ReadonlyMap<string, SampleResult>;
}): AgentInvoker {
  const root = realpathSync(args.sourceDir);
  return async ({ sample }) => {
    const recorded = args.cases.get(sample.id);
    if (recorded === undefined) return { agentOutput: "" };
    const dir = join(root, sampleArtifactDirName(sample.id));
    const transcript = jsonLines<TranscriptEvent>(
      readContained(root, join(dir, "transcript.jsonl"), FILE_MAX_BYTES),
    );
    const events = jsonLines<TraceEvent>(
      readContained(root, join(dir, "events.jsonl"), FILE_MAX_BYTES),
    );
    const proofText = readContained(root, join(dir, PROOF_FILENAME), FILE_MAX_BYTES);
    let proof: ProofBundle | undefined;
    if (proofText !== undefined) {
      try {
        proof = JSON.parse(proofText) as ProofBundle;
      } catch {
        proof = undefined;
      }
    }
    return {
      agentOutput: recorded.agentOutput,
      transcript,
      events,
      ...(proof !== undefined ? { proof } : {}),
    };
  };
}

/** The not-measured grade a regrade records where it cannot grade. */
export function notRegradable(reason: string): GradeResult {
  return {
    passed: false,
    score: 0,
    rationale: `not regradable: ${reason}`,
    status: "not_measured",
    statusReason: "not_regradable",
  };
}

/** Build the plan for regrading `sourceDir`. Throws {@link RunnerError}. */
export function createRegrade(
  args: CreateRegradeArgs,
): RegradePlan & { readonly source: RecordedRun } {
  const source = readRecordedRun(args.sourceDir);
  const { summary } = source;
  if ((summary.config?.repeats ?? 1) > 1) {
    throw new RunnerError(
      `regrade: run ${summary.runId} ran ${summary.config.repeats} trials per case — a regrade grades one recorded answer per case, so it takes a run with --repeats 1`,
    );
  }
  const bySample = new Map(summary.samples.map((s) => [s.sampleId, s]));
  const datasetMoved =
    args.datasetHash !== undefined &&
    summary.config?.datasetHash !== undefined &&
    summary.config.datasetHash !== args.datasetHash;
  const datasetUnknown =
    args.datasetHash === undefined || summary.config?.datasetHash === undefined;
  const refusals = new Map<string, string>();
  for (const sample of args.samples) {
    const reason = caseRefusalFor(sample);
    if (reason !== undefined) refusals.set(sample.id, reason);
  }

  function caseRefusalFor(sample: Sample): string | undefined {
    const recorded = bySample.get(sample.id);
    if (recorded === undefined) return `run ${summary.runId} holds no answer for this case`;
    if (recorded.error !== undefined) return `the recorded answer errored (${recorded.error})`;
    if (typeof recorded.agentOutput !== "string")
      return `run ${summary.runId} kept no answer for this case`;
    const dir = join(source.dir, sampleArtifactDirName(sample.id));
    const where = contained(source.dir, dir);
    if (where === null) return `run ${summary.runId} kept no files for this case`;
    if (where === undefined)
      return "the case's recorded files lie outside the source run directory";
    for (const file of ["transcript.jsonl", "events.jsonl", PROOF_FILENAME]) {
      if (contained(source.dir, join(dir, file)) === undefined) {
        return "the case's recorded files lie outside the source run directory";
      }
    }
    const recordedDigest = source.cases?.[sample.id];
    if (recordedDigest !== undefined) {
      if (recordedDigest !== caseDigestOf(sample)) return "the case changed since the source run";
    } else if (datasetMoved || datasetUnknown) {
      return "the source run recorded no digest for this case and the dataset may have changed since";
    }
    return undefined;
  }

  // Reuse: a grader whose spec digest is the one the source recorded for it.
  const recordedDigest = new Map<string, string>();
  for (const c of (summary.config as { criteria?: ReadonlyArray<RecordedCriterion> }).criteria ??
    []) {
    for (const g of c.graders ?? []) recordedDigest.set(g.name, g.digest);
  }
  const currentDigest = new Map<string, string>();
  for (const c of args.criteria ?? [])
    for (const g of c.graders) currentDigest.set(g.name, g.digest);
  const sameJudge = summary.config?.judgeModel === args.judgeModel;
  const calibrated = new Set(
    (summary.config?.judgeCalibration?.applied ?? []).map((applied) => applied.grader),
  );
  const reusable = new Set(
    [...currentDigest]
      .filter(([name, d]) => sameJudge && !calibrated.has(name) && recordedDigest.get(name) === d)
      .map(([name]) => name),
  );

  return {
    of: summary.runId,
    purpose: args.purpose,
    source,
    // A case it cannot regrade gets an empty answer and nothing read for it.
    invoker: createRecordedInvoker({
      sourceDir: source.dir,
      cases: new Map([...bySample].filter(([id]) => !refusals.has(id))),
    }),
    caseRefusal: (sampleId) => refusals.get(sampleId),
    reuse: (sampleId, graderName) => {
      if (!reusable.has(graderName)) return undefined;
      const recorded = bySample.get(sampleId)?.grades.perGrader.find((g) => g.name === graderName);
      if (recorded === undefined || recorded.status === "skipped") return undefined;
      const { name: _name, ...grade } = recorded;
      if (grade.status === "not_measured") return grade;
      const { status: _status, statusReason: _reason, ...verdict } = grade;
      return verdict;
    },
  };
}
