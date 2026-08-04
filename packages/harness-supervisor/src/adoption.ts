/**
 * Liveness verification and adoption.
 *
 * A manager restart must not orphan a running daemon, must not lose a byte
 * of its output, and must not be fooled by a recycled pid. Three independent
 * facts have to agree before a runfile is believed:
 *
 *   1. the pid exists;
 *   2. the OS process start time matches the one recorded at spawn (within
 *      the tolerance the coarsest platform probe forces on us);
 *   3. the OS command line still contains the recorded argv, in order.
 *
 * Any one of them failing makes the runfile STALE — and a stale runfile is
 * harmless: it is cleared, its run is closed in the ledger as interrupted,
 * and the last log tail is attached so the operator sees why the daemon is
 * gone rather than an empty panel. A runfile restored from a `state backup`
 * fails (2) by construction, which is exactly the intended behaviour.
 *
 * When the runfile IS live, adoption hands back a pump positioned at the
 * recorded cursor and reconciled against the durable events file, so the
 * resumed tail is byte-exact: nothing between the cursor and EOF is skipped,
 * and nothing already persisted is emitted twice.
 */
import { existsSync } from "node:fs";
import { type ProcessOps, argvMatchesCommandLine, startTimesMatch } from "./process-ops";
import {
  clearRunfile,
  patchRunLedger,
  readRunLedger,
  readRunfile,
  runCursorPath,
  runEventsPath,
  runLogPath,
} from "./runfiles";
import { type Scrubber, noopScrubber } from "./scrub";
import { type LogPump, createLogPump, readLogTail } from "./trace-pump";
import { type DaemonRunfile, START_TIME_TOLERANCE_MS } from "./types";

export type LivenessFailure =
  | "no-runfile"
  | "pid-dead"
  | "start-time-mismatch"
  | "argv-mismatch"
  | "plan-mismatch";

export type LivenessVerdict = {
  readonly live: boolean;
  readonly reason?: LivenessFailure;
  /** The start time the OS reports now, when it could be read. */
  readonly observedStartTimeMs?: number;
  /** The command line the OS reports now, when it could be read. */
  readonly observedCommandLine?: string;
  /** False when a check could not be performed (no start-time or command-line
   *  probe on this platform). The verdict then errs toward LIVE: refusing to
   *  start a second daemon is safer than running two. */
  readonly verified: boolean;
};

export type VerifyOptions = {
  readonly toleranceMs?: number;
  /** The fingerprint of the plan the caller would spawn. When given, a
   *  runfile for a DIFFERENT command reads as stale — that is how a manager
   *  notices the running daemon is not the one the current spec produces. */
  readonly expectedFingerprint?: string;
  /** The argv the runfile's fingerprint was built from, when the caller has
   *  it; enables the command-line check against the live process. */
  readonly expectedArgv?: readonly string[];
};

/** Verify one runfile against the running system. Pure with respect to the
 *  filesystem — everything comes from the injected {@link ProcessOps}. */
export function verifyRunfile(
  runfile: DaemonRunfile | undefined,
  ops: ProcessOps,
  options: VerifyOptions = {},
): LivenessVerdict {
  if (runfile === undefined) return { live: false, reason: "no-runfile", verified: true };
  if (
    options.expectedFingerprint !== undefined &&
    options.expectedFingerprint !== runfile.argvFingerprint
  ) {
    return { live: false, reason: "plan-mismatch", verified: true };
  }
  if (!ops.isAlive(runfile.pid)) {
    return { live: false, reason: "pid-dead", verified: true };
  }
  let verified = true;
  const observedStart = ops.startTimeMs(runfile.pid);
  if (observedStart === undefined) {
    // The platform would not say. The pid exists, so we must not declare it
    // dead — but we say so, and the caller can surface "unverified".
    verified = false;
  } else if (
    !startTimesMatch(
      observedStart,
      runfile.pidStartTimeMs,
      options.toleranceMs ?? START_TIME_TOLERANCE_MS,
    )
  ) {
    return {
      live: false,
      reason: "start-time-mismatch",
      observedStartTimeMs: observedStart,
      verified: true,
    };
  }
  const commandLine = ops.commandLine(runfile.pid);
  if (options.expectedArgv !== undefined) {
    if (commandLine === undefined) {
      verified = false;
    } else if (!argvMatchesCommandLine(commandLine, options.expectedArgv)) {
      return {
        live: false,
        reason: "argv-mismatch",
        ...(observedStart !== undefined ? { observedStartTimeMs: observedStart } : {}),
        observedCommandLine: commandLine,
        verified: true,
      };
    }
  }
  return {
    live: true,
    ...(observedStart !== undefined ? { observedStartTimeMs: observedStart } : {}),
    ...(commandLine !== undefined ? { observedCommandLine: commandLine } : {}),
    verified,
  };
}

export type AdoptionResult =
  | { readonly status: "none" }
  | {
      readonly status: "adopted";
      readonly runfile: DaemonRunfile;
      readonly verdict: LivenessVerdict;
      /** Positioned at the recorded cursor and reconciled. */
      readonly pump: LogPump;
      readonly logFile: string;
    }
  | {
      readonly status: "lost";
      readonly runfile: DaemonRunfile;
      readonly reason: LivenessFailure;
      /** Last lines of the dead run's log, scrubbed — the forensics an
       *  operator opens the manager to find. */
      readonly tail: readonly string[];
      readonly logFile: string;
    };

export type AdoptOptions = {
  readonly ops: ProcessOps;
  /** Applied to everything the pump and the tail emit. */
  readonly scrub?: Scrubber;
  readonly now?: () => number;
  readonly toleranceMs?: number;
  readonly expectedFingerprint?: string;
  readonly expectedArgv?: readonly string[];
  /** Remove the runfile and close the ledger entry when the runfile is
   *  stale. Default true: leaving it behind would block the next start. */
  readonly clearStale?: boolean;
};

/**
 * Reconcile `<harness>/.crewhaus/run/daemon.json` against reality.
 *
 * On success the returned pump resumes the log tail from the recorded byte
 * offset. `reconcile()` has already run, so the durable events file is
 * trimmed back to what the cursor accounts for — events written by the
 * previous manager after its last cursor write are re-derived from the log
 * instead of being duplicated.
 */
export function adoptRunning(harnessDir: string, options: AdoptOptions): AdoptionResult {
  const runfile = readRunfile(harnessDir);
  if (runfile === undefined) return { status: "none" };
  const scrub = options.scrub ?? noopScrubber;
  // The runfile stores a fingerprint, not the argv — but the ledger entry
  // for the same runId stores the argv verbatim, so the command-line check
  // against the live process needs no cooperation from the caller.
  const ledgerArgv =
    options.expectedArgv ?? readRunLedger(harnessDir).find((e) => e.runId === runfile.runId)?.argv;
  const verdict = verifyRunfile(runfile, options.ops, {
    ...(options.toleranceMs !== undefined ? { toleranceMs: options.toleranceMs } : {}),
    ...(options.expectedFingerprint !== undefined
      ? { expectedFingerprint: options.expectedFingerprint }
      : {}),
    ...(ledgerArgv !== undefined ? { expectedArgv: ledgerArgv } : {}),
  });
  const logFile = runLogPath(harnessDir, runfile.runId);

  if (!verdict.live) {
    const reason = verdict.reason ?? "pid-dead";
    const tail = existsSync(logFile) ? readLogTail(logFile, scrub) : [];
    if (options.clearStale !== false) {
      clearRunfile(harnessDir);
      patchRunLedger(harnessDir, {
        runId: runfile.runId,
        endedAt: new Date((options.now ?? Date.now)()).toISOString(),
        failureClass: "interrupted",
      });
    }
    return { status: "lost", runfile, reason, tail, logFile };
  }

  const pump = createLogPump({
    logFile,
    eventsFile: runEventsPath(harnessDir, runfile.runId),
    cursorFile: runCursorPath(harnessDir, runfile.runId),
    scrub,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  pump.reconcile();
  return { status: "adopted", runfile, verdict, pump, logFile };
}
