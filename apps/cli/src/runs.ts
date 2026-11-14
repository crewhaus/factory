/**
 * Loop contract 0.4 (Batch F, item 7, CLI half) — `crewhaus runs resume
 * <session>`. The engine-free helpers: resolving which spec backs a resumed
 * session (the session store persists only name/target/model, not the spec
 * path, so the CLI reconstructs the agent from a spec on disk) and validating
 * the resume target. The runtime half — replaying the transcript and
 * continuing the loop — is `runChatLoop({ resume })` in runtime-core, which the
 * `run --resume` path already drives; `runs resume` is the dedicated verb for
 * re-driving a session (e.g. one a headless run PARKED on a pending approval)
 * after the approval was resolved out of band.
 *
 * A run id resumes too: the harness's run ledger (`.crewhaus/run/control/runs/`)
 * says which session a run, or a root run's newest run, belongs to
 * ({@link resolveRunsResumeTarget}).
 */
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  CANONICAL_RUN_ID_RE,
  type CursorPosition,
  EXECUTION_RUN_ID_RE,
  type Trigger,
  parseResumeScope,
} from "@crewhaus/control-contract";
import {
  type Ledger,
  controlPaths,
  foldStates,
  harnessLedger,
  newestRunRows,
  readPage,
} from "@crewhaus/control-records";

export class RunsError extends Error {
  override readonly name = "RunsError";
}

export const RUNS_SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

/** True for a well-formed `sess_<16 hex>` session id. */
export function isRunsSessionId(value: string): boolean {
  return RUNS_SESSION_ID_REGEX.test(value);
}

/**
 * Resolve the spec backing a `runs resume`: the explicit `--spec` when given,
 * else `crewhaus.yaml` in the cwd (the standalone-harness convention — sessions
 * live under the directory you run from, so its spec is the natural default).
 * Returns an ABSOLUTE path. Throws `RunsError` — naming the candidate(s) it
 * looked for — when the chosen spec does not exist. `exists` is injected so the
 * resolution is unit-testable without touching the filesystem.
 */
export function resolveRunsResumeSpecPath(
  specFlag: string | undefined,
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string {
  if (specFlag !== undefined) {
    const abs = isAbsolute(specFlag) ? specFlag : resolve(cwd, specFlag);
    if (!exists(abs)) {
      throw new RunsError(`--spec not found: ${abs}`);
    }
    return abs;
  }
  const fallback = join(cwd, "crewhaus.yaml");
  if (!exists(fallback)) {
    throw new RunsError(
      `no --spec given and no crewhaus.yaml in ${cwd}. Pass --spec <path>, or run from the harness directory that owns the session's .crewhaus/sessions/.`,
    );
  }
  return fallback;
}

/** True for a canonical run id (`run_` and 26 lowercase letters and digits). */
export function isRunsRunId(value: string): boolean {
  return CANONICAL_RUN_ID_RE.test(value);
}

/** The run ledger's directory, relative to the harness directory: where runtime-core writes. */
export const RUNS_LEDGER_DIR = join(controlPaths(".").controlDir, "runs");

/** The run ledger of the harness at `harnessDir`. */
export function runsLedgerAt(harnessDir: string): Ledger {
  return harnessLedger(harnessDir, { dir: RUNS_LEDGER_DIR }, { machine: "run" });
}

/** The run states a run never leaves. */
const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
  "interrupted",
  "succeeded",
  "failed",
  "cancelled",
]);

/** What a resume re-drives, and the run scope it runs in. */
export type RunsResumeTarget = {
  readonly sessionId: string;
  /** The newest parked run of that session, which the resumed run continues. */
  readonly continues?: string;
  /**
   * The scope that parked run was recorded in, when it has one: the resumed run
   * re-enters it, so a grant asked there (a supervised job's root, a work item,
   * a batch job or a lane) covers the resumed call.
   */
  readonly resumeScope?: string;
};

type RunningRow = {
  readonly id: string;
  readonly session?: string;
  readonly parent?: string;
  readonly resumeScope?: string;
};

/**
 * Every run's `running` row, newest first. Read whole, following every page:
 * this read decides what is resumed, so a gap is refused, never skipped.
 */
function runningRows(ledger: Ledger, dir: string): RunningRow[] {
  const rows: RunningRow[] = [];
  const seen = new Set<string>();
  let before: CursorPosition | undefined;
  for (;;) {
    const page = readPage(ledger, { limit: 1000, ...(before !== undefined ? { before } : {}) });
    const gap = page.gaps[0];
    if (gap !== undefined) {
      throw new RunsError(
        `the run records in ${dir} could not be read whole (segment ${gap.seg}, offset ${gap.off}: ${gap.reason}); nothing was resumed`,
      );
    }
    for (const item of page.items) {
      const row = item.record;
      const id = row["id"];
      if (row["state"] !== "running" || typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      rows.push({
        id,
        ...(typeof row["session"] === "string" ? { session: row["session"] } : {}),
        ...(typeof row["parent"] === "string" ? { parent: row["parent"] } : {}),
        ...(typeof row["resumeScope"] === "string" && parseResumeScope(row["resumeScope"]) !== null
          ? { resumeScope: row["resumeScope"] }
          : {}),
      });
    }
    if (page.next === undefined) return rows;
    before = page.next;
  }
}

/** The newest run of `sessionId` whose current state is `waiting-for-approval`. */
function newestParked(
  ledger: Ledger,
  rows: readonly RunningRow[],
  sessionId: string,
): RunningRow | undefined {
  const fold = foldStates(ledger);
  if (!fold.ok) return undefined;
  return rows.find(
    (row) =>
      row.session === sessionId && fold.objects.get(row.id)?.state === "waiting-for-approval",
  );
}

/**
 * The session's newest run, when a command cancelled it (its `cancelled` row names the
 * command, as a cancel through the control plane writes): that session is not resumed,
 * since what its run waited on was withdrawn.
 */
function cancelledByCommand(
  ledger: Ledger,
  rows: readonly RunningRow[],
  sessionId: string,
): string | undefined {
  const newest = rows.find((row) => row.session === sessionId);
  if (newest === undefined) return undefined;
  const fold = foldStates(ledger);
  const last = fold.ok ? fold.objects.get(newest.id) : undefined;
  return last?.state === "cancelled" && typeof last.record["cmd"] === "string"
    ? newest.id
    : undefined;
}

/** What a resume of `sessionId` continues, and the scope it re-enters. */
function resumeOf(sessionId: string, parked: RunningRow | undefined): RunsResumeTarget {
  return {
    sessionId,
    ...(parked !== undefined ? { continues: parked.id } : {}),
    ...(parked?.resumeScope !== undefined ? { resumeScope: parked.resumeScope } : {}),
  };
}

/**
 * Resolve what `crewhaus runs resume <id>` re-drives, from the run ledger
 * under `harnessDir`. A session id resumes that session. A run id resumes
 * the session its `running` row names; a root run's id (a job its supervisor
 * started) resumes the session of the newest run that names it as `parent`.
 * Either way the resumed run continues the session's newest parked run, when
 * it has one. The `session` and `parent` fields live only on the `running`
 * row, so every retained row is read (a fold keeps each run's last row only),
 * and the current states come from the fold.
 *
 * Throws `RunsError` naming the id when no run record here has it, when the
 * run has ended (a cancelled run is never resumed), when a session's newest
 * run was cancelled by a command, and when the records cannot be read whole.
 */
export function resolveRunsResumeTarget(id: string, harnessDir: string): RunsResumeTarget {
  const ledger = runsLedgerAt(harnessDir);
  const dir = join(harnessDir, RUNS_LEDGER_DIR);
  if (isRunsSessionId(id)) {
    // The run records only label this resume: one that cannot be read leaves the label off.
    let rows: RunningRow[];
    try {
      rows = runningRows(ledger, dir);
    } catch {
      return { sessionId: id };
    }
    const cancelled = cancelledByCommand(ledger, rows, id);
    if (cancelled !== undefined) {
      throw new RunsError(`session ${id}'s run ${cancelled} was cancelled; nothing was resumed`);
    }
    return resumeOf(id, newestParked(ledger, rows, id));
  }
  if (!isRunsRunId(id)) {
    throw new RunsError(`invalid id "${id}": expected a session (sess_<16 hex>) or a run id`);
  }
  // A run that ended is never re-driven: a cancel withdrew what it waited on.
  const fold = foldStates(ledger);
  const ended = fold.ok ? fold.objects.get(id)?.state : undefined;
  if (ended !== undefined && TERMINAL_RUN_STATES.has(ended)) {
    throw new RunsError(`run ${id} was ${ended}; nothing was resumed`);
  }
  const rows = runningRows(ledger, dir);
  const own = rows.find((row) => row.id === id && row.session !== undefined);
  const child = rows.find((row) => row.parent === id && row.session !== undefined);
  const sessionId = own?.session ?? child?.session;
  if (sessionId === undefined) {
    throw new RunsError(
      `no run record in ${dir} has run ${id}. Run from the harness directory the run belongs to.`,
    );
  }
  return resumeOf(sessionId, newestParked(ledger, rows, sessionId));
}

/**
 * The run scope a resumed run runs in: started by a resume, continuing the parked
 * run, in the scope that run was recorded in.
 */
export function runsResumeScope(target: RunsResumeTarget): {
  readonly trigger: Trigger;
  readonly continues?: string;
  readonly resumeScope?: string;
} {
  return {
    trigger: { kind: "resume" },
    ...(target.continues !== undefined ? { continues: target.continues } : {}),
    ...(target.resumeScope !== undefined ? { resumeScope: target.resumeScope } : {}),
  };
}

// ---------------------------------------------------------------------------
// `crewhaus run <spec> --input-file <path>`
// ---------------------------------------------------------------------------

/** The input a run started through the control API reads, and who it serves. */
export type RunInputRecord = {
  readonly run: string;
  readonly input: string;
  readonly subject?: string;
};

const NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;

/** The most bytes an input record holds. */
const INPUT_RECORD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Read the input record `crewhaus run --input-file` runs: a regular file (never a link)
 * that lies, on disk, inside `<cwd>/.crewhaus/run/control/inputs/`, whose `run` is the run
 * this process was started for. That run is `CREWHAUS_RUN_ID`, verified against the run
 * ledger: its newest row is `queued` or `preparing` and names this process's execution
 * (`CREWHAUS_EXECUTION_ID`). Anything else throws `RunsError`, before any model call.
 */
export function readRunInputRecord(
  path: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): RunInputRecord {
  const inputs = join(cwd, controlPaths(cwd).inputsDir);
  const at = isAbsolute(path) ? path : resolve(cwd, path);
  let real: string;
  let realInputs: string;
  try {
    if (lstatSync(at).isSymbolicLink()) throw new RunsError(`--input-file ${path} is a link`);
    real = realpathSync(at);
    realInputs = realpathSync(inputs);
  } catch (err) {
    if (err instanceof RunsError) throw err;
    throw new RunsError(`--input-file ${path} could not be read: ${(err as Error).message}`);
  }
  const rel = relative(realInputs, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new RunsError(`--input-file must lie inside ${inputs}`);
  }
  let fd: number | undefined;
  let body: Partial<Record<string, unknown>>;
  try {
    fd = openSync(real, fsConstants.O_RDONLY | NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > INPUT_RECORD_MAX_BYTES) {
      throw new RunsError(`--input-file ${path} is not an input record`);
    }
    body = JSON.parse(readFileSync(fd, "utf8")) as Partial<Record<string, unknown>>;
  } catch (err) {
    if (err instanceof RunsError) throw err;
    throw new RunsError(`--input-file ${path} is not an input record: ${(err as Error).message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const run = body["run"];
  const input = body["input"];
  const subject = body["subject"];
  if (
    body["v"] !== 1 ||
    typeof run !== "string" ||
    typeof input !== "string" ||
    input.trim() === ""
  ) {
    throw new RunsError(`--input-file ${path} is not an input record`);
  }
  const named = env["CREWHAUS_RUN_ID"];
  const execution = env["CREWHAUS_EXECUTION_ID"];
  if (named === undefined || !CANONICAL_RUN_ID_RE.test(named) || named !== run) {
    throw new RunsError("--input-file names a run this process was not started for");
  }
  const newest = newestRunRows(runsLedgerAt(cwd)).get(run);
  if (
    execution === undefined ||
    !EXECUTION_RUN_ID_RE.test(execution) ||
    newest === undefined ||
    (newest["state"] !== "queued" && newest["state"] !== "preparing") ||
    newest["execution"] !== execution
  ) {
    throw new RunsError("--input-file names a run its records do not hand to this process");
  }
  return { run, input, ...(typeof subject === "string" && subject !== "" ? { subject } : {}) };
}
