/**
 * Manager shutdown — what happens to supervised children when the console
 * goes down, and the guarantee that the console actually goes down.
 *
 * ## The bug this exists to close
 *
 * Stopping the HTTP server releases the socket, the timers and the
 * subscriptions; it does NOT terminate supervised children, and an ATTACHED
 * child's stdio pipes hold the manager's event loop open. Observed twice:
 * a manager that printed "shutting down…", released its lock and freed its
 * port — a second manager promptly bound it — was still alive minutes later
 * with a job child running under it; a second orphan from an earlier session
 * survived most of a day and ignored SIGTERM until it was SIGKILLed. So
 * shutdown must reach the children, and it must be BOUNDED so the exit
 * happens even when a child refuses to die.
 *
 * ## The policy: a run survives iff the next manager can find it again
 *
 * The dividing line is not "detached" and it is not "the operator asked for
 * it" — it is RE-ADOPTABILITY.
 *
 *   - **Daemon-kind runs DETACH.** A daemon is singleton per harness, holds
 *     `<harness>/.crewhaus/run/daemon.json`, and writes its log with its own
 *     fd. The next `crewhaus hangar` adopts it by pid + OS start time + argv
 *     fingerprint and resumes the log from the persisted cursor, so nothing
 *     is lost and nothing is duplicated. Killing the fleet because a console
 *     restarted would be the worse failure: channel daemons stop answering,
 *     schedules stop firing.
 *   - **Everything else is STOPPED.** An interactive run is attached (its
 *     pipes are ours, and they die with us into a half-written log); an
 *     mcp-server projection and a manager-spawned one-shot are detached but
 *     write NO runfile, so no later manager can enumerate, adopt, stop or
 *     even name them. That is the definition of an orphan.
 *
 * A daemon-kind run whose runfile has gone missing is therefore stopped too:
 * without the claim it is not re-adoptable, whatever it started life as.
 *
 * ## What the operator is told
 *
 * Silently orphaning work is the other half of the same dishonesty, so the
 * report names every child, which side of the line it fell on, and what the
 * next manager will do with it — with the CLI twin for each surviving
 * daemon. See {@link shutdownReportLines}.
 *
 * Every seam is injected (clock, supervisors, job queue), so the whole
 * sequence is exercised without spawning anything.
 */
import type { JobRecord } from "./queue";
import { shellQuote } from "./spawn-contracts";
import type { StopResult } from "./supervisor";
import { type Clock, type RunKind, type SupervisionState, systemClock } from "./types";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** One live supervised child, described in the terms shutdown reasons about.
 *  Produced by `HarnessSupervisor.liveChild()`; a pure read. */
export type SupervisedChild = {
  readonly harnessDir: string;
  /** The spec target this run was launched for (`channel`, `cli`, …). */
  readonly target: string;
  readonly state: SupervisionState;
  readonly kind: RunKind;
  readonly runId?: string;
  readonly pid: number;
  /** True when this manager adopted the run rather than spawning it. */
  readonly adopted: boolean;
  /** Spawned into its own process group with its own log fd — it does not
   *  die with the manager. */
  readonly detached: boolean;
  /** A runfile claims this run, so a later manager can find and adopt it.
   *  The whole policy turns on this flag. */
  readonly reAdoptable: boolean;
};

/** What shutdown does with one child. */
export type ChildFate = "detach" | "stop";

/**
 * The policy, in one line: leave behind exactly what the next manager can
 * pick up again, and stop everything else rather than orphan it.
 */
export function shutdownFate(child: SupervisedChild): ChildFate {
  return child.detached && child.reAdoptable ? "detach" : "stop";
}

/** A stopped child, with how the stop went. */
export type StoppedChild = SupervisedChild & {
  /** The grace expired and the child was SIGKILLed (`forced: true` is also
   *  recorded in the harness's run ledger). */
  readonly forced: boolean;
  /** The stop did not confirm within the deadline. The manager exits anyway
   *  — that is the point — but it says so rather than implying a clean
   *  stop it never observed. */
  readonly timedOut: boolean;
};

/**
 * The supervisor surface shutdown needs. `HarnessSupervisor` satisfies it
 * structurally; a test can satisfy it with three functions.
 */
export type ShutdownSupervisor = {
  liveChild(): SupervisedChild | undefined;
  stop(options?: { readonly graceMs?: number }): Promise<StopResult>;
  /** Release timers and listeners WITHOUT touching the child — the detach
   *  half of the policy, and the last thing done to a stopped one. */
  close(): void;
};

/** The job-queue surface shutdown needs. `JobQueue` satisfies it. */
export type ShutdownJobs = {
  running(): readonly JobRecord[];
  terminateRunning(options?: {
    readonly graceMs?: number;
    readonly deadlineMs?: number;
  }): Promise<readonly JobRecord[]>;
};

export type ShutdownOptions = {
  /** Every supervisor this manager holds — including idle ones, whose
   *  timers and listeners still need releasing. */
  readonly supervisors: readonly ShutdownSupervisor[];
  readonly jobs?: ShutdownJobs;
  /** SIGTERM → SIGKILL grace per child. Default {@link SHUTDOWN_GRACE_MS}. */
  readonly graceMs?: number;
  /** Hard cap on waiting for any one child. Default
   *  {@link SHUTDOWN_DEADLINE_MS}. */
  readonly deadlineMs?: number;
  readonly clock?: Clock;
};

export type ShutdownReport = {
  /** Daemons deliberately left running, for the next manager to adopt. */
  readonly survived: readonly SupervisedChild[];
  readonly stopped: readonly StoppedChild[];
  /** Running jobs whose children were signalled and whose ledger rows were
   *  deliberately left OPEN, so the next manager's `jobQueue.restore()`
   *  reopens them as `interrupted` rather than re-running them. */
  readonly abandonedJobs: readonly JobRecord[];
};

/**
 * Shutdown's SIGTERM→SIGKILL grace. Deliberately shorter than the
 * interactive stop grace (`STOP_GRACE_MS`, 15 s): an operator who pressed
 * Ctrl-C is waiting at a prompt, and a run that ignores SIGTERM for five
 * seconds is not going to honour it at fifteen.
 */
export const SHUTDOWN_GRACE_MS = 5_000;

/** Hard cap on waiting for one child to confirm its exit — the escalation
 *  ladder is only two steps, so anything past this is a stuck signal, and
 *  waiting longer is how a manager fails to exit at all. */
export const SHUTDOWN_DEADLINE_MS = 15_000;

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const TIMED_OUT = Symbol("shutdown-timed-out");

/** Race a promise against an injected-clock deadline. Never rejects. */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  clock: Clock,
): Promise<T | typeof TIMED_OUT> {
  let handle: unknown;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    handle = clock.setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clock.clearTimeout(handle);
  }
}

/** Read a supervisor's live child without letting one broken handle abort
 *  the shutdown of every other harness. */
function safeLiveChild(supervisor: ShutdownSupervisor): SupervisedChild | undefined {
  try {
    return supervisor.liveChild();
  } catch {
    return undefined;
  }
}

/**
 * Stop or detach every supervised child per {@link shutdownFate}, terminate
 * the running jobs, release every supervisor, and report.
 *
 * Bounded by construction: each stop is raced against `deadlineMs`, and the
 * children and the jobs are handled concurrently, so the whole sequence
 * costs one deadline rather than one per child. It never throws — a manager
 * that cannot shut down cleanly must still shut down.
 *
 * Call this BEFORE releasing the HTTP socket and the `hangar.lock`. Freeing
 * the port first is what let a second manager bind while the first was still
 * holding children; and a supervisor whose pump has already been closed
 * cannot observe an adopted run's exit, so its stop would only ever time
 * out.
 */
export async function runManagerShutdown(options: ShutdownOptions): Promise<ShutdownReport> {
  const clock = options.clock ?? systemClock;
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;

  const live = options.supervisors
    .map((supervisor) => ({ supervisor, child: safeLiveChild(supervisor) }))
    .filter(
      (pair): pair is { supervisor: ShutdownSupervisor; child: SupervisedChild } =>
        pair.child !== undefined,
    );

  const survived = live.filter((p) => shutdownFate(p.child) === "detach").map((p) => p.child);
  const toStop = live.filter((p) => shutdownFate(p.child) === "stop");

  const stopOne = async (pair: {
    supervisor: ShutdownSupervisor;
    child: SupervisedChild;
  }): Promise<StoppedChild> => {
    const outcome = await withDeadline(
      pair.supervisor.stop({ graceMs }).then(
        (result: StopResult) => result,
        // A stop that throws is a stop we did not perform; say so rather
        // than take the whole shutdown down with it.
        () => undefined,
      ),
      deadlineMs,
      clock,
    );
    if (outcome === TIMED_OUT || outcome === undefined) {
      return { ...pair.child, forced: false, timedOut: true };
    }
    return { ...pair.child, forced: outcome.forced, timedOut: false };
  };

  const [stopped, abandonedJobs] = await Promise.all([
    Promise.all(toStop.map(stopOne)),
    options.jobs === undefined
      ? Promise.resolve([] as readonly JobRecord[])
      : options.jobs
          .terminateRunning({ graceMs, deadlineMs })
          .catch(() => [] as readonly JobRecord[]),
  ]);

  // Release EVERY supervisor — including the daemons we are deliberately
  // leaving up, and the idle ones that never had a child. Their pump timers
  // and restart timers are ours, not the daemon's, and a live restart timer
  // is a spawn scheduled to land after we are gone.
  for (const supervisor of options.supervisors) {
    try {
      supervisor.close();
    } catch {
      // Closing is bookkeeping; nothing here may block the exit.
    }
  }

  return { survived, stopped, abandonedJobs };
}

// ---------------------------------------------------------------------------
// The operator-facing notice
// ---------------------------------------------------------------------------

const describeChild = (child: SupervisedChild): string =>
  `${child.target} ${child.harnessDir} (pid ${child.pid}${
    child.runId !== undefined ? `, ${child.runId}` : ""
  })`;

/**
 * The shutdown notice: what was stopped, what was left running, and what the
 * next manager will do with it. Every surviving daemon carries its CLI twin
 * so an operator who wanted it down has the command in front of them —
 * unconditionally quoted, like every other twin, because a harness directory
 * is a name someone else may have chosen.
 */
export function shutdownReportLines(report: ShutdownReport): string[] {
  const lines: string[] = [];

  if (report.stopped.length > 0) {
    lines.push(`hangar: stopped ${report.stopped.length} supervised run(s):`);
    for (const child of report.stopped) {
      const how = child.timedOut
        ? " — did NOT confirm its exit; it may still be running"
        : child.forced
          ? " — forced (SIGKILL after the grace period)"
          : "";
      lines.push(`  · ${describeChild(child)}${how}`);
    }
  }

  if (report.survived.length > 0) {
    lines.push(
      `hangar: left ${report.survived.length} daemon(s) running — they are runfile-tracked,`,
      "        and the next `crewhaus hangar` adopts them with their logs intact:",
    );
    for (const child of report.survived) {
      lines.push(
        `  · ${describeChild(child)} — stop it with \`crewhaus daemon stop ${shellQuote(
          child.harnessDir,
        )}\``,
      );
    }
  }

  if (report.abandonedJobs.length > 0) {
    const kinds = [...new Set(report.abandonedJobs.map((job) => job.kind))].sort().join(", ");
    lines.push(
      `hangar: signalled ${report.abandonedJobs.length} running job(s) (${kinds}); their ledger rows`,
      "        stay open, so the next manager reopens them as `interrupted` — never re-runs them.",
    );
  }

  return lines;
}
