/**
 * Concurrency control: the per-harness mutating mutex and the global job
 * queue.
 *
 * Three rules, each protecting something concrete:
 *
 *   1. **Daemons are singleton per harness** — enforced by the runfile, not
 *      here (a live runfile is the lock). Starting a running daemon is a
 *      no-op, never a second process.
 *   2. **One MUTATING job per harness.** eval, optimize, flywheel, dream,
 *      compile, and one-shot runs all write into the same `.crewhaus/`
 *      tree; two of them at once corrupt each other's outputs. Read-only
 *      jobs (`doctor`, `audit verify`, `security digest`) bypass the mutex
 *      entirely — making an operator wait to READ state would be absurd.
 *   3. **A global queue with bounded concurrency** (default 3), whose
 *      PENDING entries are persisted, so queued work survives a manager
 *      restart instead of evaporating.
 *
 * The persisted ledger is append-only and folded by `jobId` on read — the
 * same shape as the run ledger, for the same reason: a manager killed
 * mid-write leaves an open record, never a corrupt file. A job that was
 * RUNNING when the manager died is reopened as `interrupted`, never
 * silently re-run: re-running a mutating job behind the operator's back is
 * exactly the surprise this layer exists to prevent.
 *
 * **Reaching a running child.** The queue does not spawn — it awaits a
 * {@link JobRunner} — so it can only signal a child the runner HANDS it
 * ({@link JobRunContext.register}). Without that handle `cancel()` could
 * drop a queued job and nothing else, and manager shutdown could not stop a
 * job at all: the two halves of the orphaned-`crewhaus dev` bug. A runner
 * that registers gets the same SIGTERM → grace → SIGKILL ladder the
 * supervisor's `stop()` uses, with `forced: true` recorded in the ledger.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Clock, systemClock } from "./types";

/** Job kinds that only read. Everything else takes the harness mutex. */
export const READ_ONLY_JOB_KINDS: ReadonlySet<string> = new Set([
  "doctor",
  "audit verify",
  "security digest",
  "inspect",
  "preflight",
]);

/** True when a job kind may run alongside another job on the same harness. */
export function isReadOnlyJob(kind: string): boolean {
  return READ_ONLY_JOB_KINDS.has(kind);
}

export type JobState = "pending" | "running" | "done" | "failed" | "cancelled" | "interrupted";

export type JobRecord = {
  readonly jobId: string;
  /** Absolute harness dir the job runs against. */
  readonly harnessDir: string;
  /** Registry id, when the caller has one (pointer only — the record of
   *  record stays in the harness). */
  readonly harnessId?: string;
  /** `eval`, `compile`, `dream`, `optimize`, `doctor`, … */
  readonly kind: string;
  readonly argv: readonly string[];
  readonly mutating: boolean;
  readonly state: JobState;
  readonly enqueuedAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  readonly error?: string;
  /** True when the cancel escalated past the grace period to SIGKILL —
   *  the same flag the run ledger records for a forced daemon stop. */
  readonly forced?: boolean;
};

export type JobStore = {
  /** Append a full record or a patch (folded by `jobId`). */
  append(record: Partial<JobRecord> & { readonly jobId: string }): void;
  /** Every job, folded, in first-appearance order. */
  read(): JobRecord[];
};

/** File-backed job store — `<hangarRoot>/jobs.jsonl` in production. */
export function createFileJobStore(path: string): JobStore {
  return {
    append: (record) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    },
    read: () => {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return [];
      }
      const byId = new Map<string, JobRecord>();
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // torn line — skip, keep reading
        }
        if (typeof obj !== "object" || obj === null) continue;
        const rec = obj as Record<string, unknown>;
        const jobId = rec["jobId"];
        if (typeof jobId !== "string" || jobId === "") continue;
        const prior = byId.get(jobId);
        byId.set(jobId, {
          ...(prior ?? ({ jobId } as JobRecord)),
          ...(rec as object),
        } as JobRecord);
      }
      return [...byId.values()];
    },
  };
}

/** In-memory store for tests and for managers that do not persist. */
export function createMemoryJobStore(): JobStore {
  const lines: Array<Partial<JobRecord> & { jobId: string }> = [];
  return {
    append: (record) => {
      lines.push(record);
    },
    read: () => {
      const byId = new Map<string, JobRecord>();
      for (const rec of lines) {
        const prior = byId.get(rec.jobId);
        byId.set(rec.jobId, { ...(prior ?? ({ jobId: rec.jobId } as JobRecord)), ...rec });
      }
      return [...byId.values()];
    },
  };
}

/**
 * The bare minimum the queue needs to stop a job's child. A `SpawnedProcess`
 * plus a `ProcessOps` makes one (see {@link processOpsChild}); a test makes
 * one out of two closures.
 */
export type CancellableChild = {
  readonly pid?: number;
  /** Graceful stop — SIGTERM to the process group on POSIX. */
  terminate(): void;
  /** The escalation after the grace period — SIGKILL. */
  forceKill(): void;
};

/**
 * The second argument every {@link JobRunner} receives. Optional to use —
 * `async (job) => …` still type-checks — but a runner that spawns anything
 * and does NOT register it cannot be cancelled and cannot be stopped at
 * shutdown, so its child outlives the manager.
 */
export type JobRunContext = {
  /** Hand the queue the spawned child. A child registered after shutdown
   *  has already swept the queue is signalled immediately, so a job that
   *  spawns during that window is stopped rather than orphaned. */
  register(child: CancellableChild): void;
  /** True once this job has been signalled by `cancel()` or by shutdown —
   *  for a runner that wants to stop polling and return early. */
  isCancelled(): boolean;
};

export type JobRunner = (
  job: JobRecord,
  ctx: JobRunContext,
) => Promise<{ exitCode?: number; error?: string }>;

/** Build a {@link CancellableChild} from a pid and the process-ops adapter —
 *  the shape a spawning runner registers. Kept here so a runner does not
 *  have to know that terminate/forceKill signal the process GROUP. */
export function processOpsChild(
  ops: { terminate(pid: number): void; forceKill(pid: number): void },
  pid: number | undefined,
): CancellableChild {
  return {
    ...(pid !== undefined ? { pid } : {}),
    terminate: () => {
      if (pid !== undefined) ops.terminate(pid);
    },
    forceKill: () => {
      if (pid !== undefined) ops.forceKill(pid);
    },
  };
}

export type JobQueueOptions = {
  readonly store: JobStore;
  readonly run: JobRunner;
  /** Global concurrency across all harnesses. Default 3. */
  readonly concurrency?: number;
  readonly now?: () => number;
  /** Job id minter; injected for deterministic tests. */
  readonly newJobId?: () => string;
  /** Timer seam for the cancel/shutdown grace period; injected so the
   *  SIGKILL escalation runs instantly under test. Defaults to the system
   *  clock (and to `clock.now` when `now` is omitted). */
  readonly clock?: Clock;
  /** SIGTERM → SIGKILL grace for a cancelled job. Default
   *  {@link DEFAULT_JOB_STOP_GRACE_MS}. */
  readonly stopGraceMs?: number;
};

export type SubmitInput = {
  readonly harnessDir: string;
  readonly harnessId?: string;
  readonly kind: string;
  readonly argv: readonly string[];
  /** Defaults to `!isReadOnlyJob(kind)`. */
  readonly mutating?: boolean;
};

export type JobQueue = {
  /** Enqueue a job. Returns the persisted record (state `pending`). */
  submit(input: SubmitInput): JobRecord;
  /** Re-enqueue persisted pending work after a manager restart. Returns
   *  the requeued jobs; jobs left `running` are closed as `interrupted`. */
  restore(): {
    readonly requeued: readonly JobRecord[];
    readonly interrupted: readonly JobRecord[];
  };
  pending(): readonly JobRecord[];
  running(): readonly JobRecord[];
  /**
   * Recently FINISHED jobs (`done`/`failed`/`cancelled`/`interrupted`),
   * newest first, folded from the persisted ledger.
   *
   * Without this a terminal state is invisible: a job vanishes from the
   * queue view the instant it finishes, and `interrupted` — the whole point
   * of `restore()` reopening work a dead manager abandoned — could never be
   * shown to the operator it exists to inform.
   */
  recent(limit?: number): readonly JobRecord[];
  /** Resolves when nothing is pending or running. */
  idle(): Promise<void>;
  /**
   * Cancel a job. A PENDING job is dropped and recorded `cancelled`. A
   * RUNNING job's child is signalled through the SIGTERM → grace → SIGKILL
   * ladder and recorded `cancelled` (with `forced: true` when the grace
   * expired) once the runner returns.
   *
   * False means nothing was done — an unknown id, or a running job whose
   * runner never registered a child. Reporting `true` there would claim a
   * cancellation that never reached anything.
   */
  cancel(jobId: string): boolean;
  /**
   * Manager shutdown: signal every running job's child and wait for the
   * runners to return, bounded by `deadlineMs`.
   *
   * Every row that was running at the call is deliberately left OPEN — no
   * `done`, no `failed`, no `cancelled`. That is the contract with
   * `restore()`: the next manager reopens a still-`running` row as
   * `interrupted`, which is both the honest state (nobody watched it finish,
   * and a runner that returns inside the shutdown window cannot be told
   * apart from one our own signal ended) and the one state that is never
   * silently re-run. Returns those rows, for the shutdown notice.
   *
   * The queue is latched shut afterwards: nothing queued starts, so pending
   * work waits for the next manager's `restore()` instead of being spawned
   * into a process that is on its way out.
   */
  terminateRunning(options?: {
    readonly graceMs?: number;
    readonly deadlineMs?: number;
  }): Promise<readonly JobRecord[]>;
};

/** Job states that mean the job will not run again. */
export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>([
  "done",
  "failed",
  "cancelled",
  "interrupted",
]);

export const DEFAULT_RECENT_JOBS = 20;

export const DEFAULT_JOB_CONCURRENCY = 3;

/** SIGTERM → SIGKILL grace for a cancelled or shut-down job. */
export const DEFAULT_JOB_STOP_GRACE_MS = 5_000;

/** Hard cap on waiting for the runners during `terminateRunning()`. Past
 *  this the manager exits anyway — a stuck signal must not make it hang. */
export const DEFAULT_JOB_SHUTDOWN_DEADLINE_MS = 15_000;

/** One job in flight, with the handle (if any) the runner gave us. */
type ActiveJob = {
  readonly record: JobRecord;
  child?: CancellableChild;
  /** An operator cancel — the row closes as `cancelled`. */
  cancelled: boolean;
  /** Signalled by shutdown — the row is left OPEN for `restore()`. */
  abandoned: boolean;
  /** The grace expired and the child was SIGKILLed. */
  forced: boolean;
  graceHandle?: unknown;
  /** Resolves when the runner returns. */
  readonly settled: Promise<void>;
  markSettled: () => void;
};

/**
 * The queue. Ordering is FIFO within the global concurrency limit, with the
 * per-harness mutating mutex layered on top: a mutating job whose harness is
 * busy stays queued and the next eligible job runs instead of the whole
 * queue stalling behind it.
 */
export function createJobQueue(options: JobQueueOptions): JobQueue {
  const concurrency = options.concurrency ?? DEFAULT_JOB_CONCURRENCY;
  const clock = options.clock ?? systemClock;
  const now = options.now ?? clock.now;
  const stopGraceMs = options.stopGraceMs ?? DEFAULT_JOB_STOP_GRACE_MS;
  const mintId = options.newJobId ?? defaultJobId;
  const queued: JobRecord[] = [];
  const active = new Map<string, ActiveJob>();
  /** Harness dirs currently held by a mutating job. */
  const heldHarnesses = new Set<string>();
  const idleWaiters: Array<() => void> = [];
  /** Latched by `terminateRunning()`: nothing new starts after that. */
  let shuttingDown = false;

  const settle = (): void => {
    if (queued.length === 0 && active.size === 0) {
      for (const w of idleWaiters.splice(0)) w();
    }
  };

  const pump = (): void => {
    if (shuttingDown) {
      settle();
      return;
    }
    for (let i = 0; i < queued.length && active.size < concurrency; ) {
      const job = queued[i] as JobRecord;
      if (job.mutating && heldHarnesses.has(job.harnessDir)) {
        i += 1; // harness busy — try the next job rather than stall the queue
        continue;
      }
      queued.splice(i, 1);
      void start(job);
    }
    settle();
  };

  /**
   * The stop ladder, once per job: SIGTERM now, SIGKILL after the grace.
   * Idempotent — a second cancel (or a cancel followed by shutdown) must not
   * re-arm the timer or double-signal.
   */
  const signalChild = (entry: ActiveJob, graceMs: number): void => {
    const child = entry.child;
    if (child === undefined || entry.graceHandle !== undefined) return;
    child.terminate();
    entry.graceHandle = clock.setTimeout(() => {
      entry.graceHandle = undefined;
      // The runner already returned — nothing left to escalate against.
      if (!active.has(entry.record.jobId)) return;
      entry.forced = true;
      child.forceKill();
    }, graceMs);
  };

  const clearGrace = (entry: ActiveJob): void => {
    if (entry.graceHandle === undefined) return;
    clock.clearTimeout(entry.graceHandle);
    entry.graceHandle = undefined;
  };

  const start = async (job: JobRecord): Promise<void> => {
    const started: JobRecord = {
      ...job,
      state: "running",
      startedAt: new Date(now()).toISOString(),
    };
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const entry: ActiveJob = {
      record: started,
      cancelled: false,
      abandoned: false,
      forced: false,
      settled,
      markSettled,
    };
    active.set(job.jobId, entry);
    if (job.mutating) heldHarnesses.add(job.harnessDir);
    options.store.append({
      jobId: job.jobId,
      state: "running",
      startedAt: started.startedAt as string,
    });
    let outcome: { exitCode?: number; error?: string };
    try {
      outcome = await options.run(started, {
        register: (child) => {
          entry.child = child;
          // A cancel that landed before the spawn is not lost: it fires the
          // ladder the moment there is something to fire it at.
          if (entry.cancelled || entry.abandoned) signalChild(entry, stopGraceMs);
        },
        isCancelled: () => entry.cancelled || entry.abandoned,
      });
    } catch (err) {
      outcome = { error: err instanceof Error ? err.message : String(err) };
    }
    active.delete(job.jobId);
    if (job.mutating) heldHarnesses.delete(job.harnessDir);
    clearGrace(entry);
    entry.markSettled();
    if (entry.abandoned) {
      // Deliberately no terminal append. The row stays `running`, and the
      // next manager's `restore()` reopens it as `interrupted` — never
      // re-runs it. See `terminateRunning()`.
      settle();
      return;
    }
    if (entry.cancelled) {
      options.store.append({
        jobId: job.jobId,
        state: "cancelled",
        endedAt: new Date(now()).toISOString(),
        ...(entry.forced ? { forced: true } : {}),
        ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      });
      pump();
      return;
    }
    const failed = outcome.error !== undefined || (outcome.exitCode ?? 0) !== 0;
    options.store.append({
      jobId: job.jobId,
      state: failed ? "failed" : "done",
      endedAt: new Date(now()).toISOString(),
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    });
    pump();
  };

  return {
    submit: (input) => {
      const mutating = input.mutating ?? !isReadOnlyJob(input.kind);
      const record: JobRecord = {
        jobId: mintId(),
        harnessDir: input.harnessDir,
        ...(input.harnessId !== undefined ? { harnessId: input.harnessId } : {}),
        kind: input.kind,
        argv: [...input.argv],
        mutating,
        state: "pending",
        enqueuedAt: new Date(now()).toISOString(),
      };
      options.store.append(record);
      queued.push(record);
      pump();
      return record;
    },
    restore: () => {
      const requeued: JobRecord[] = [];
      const interrupted: JobRecord[] = [];
      for (const job of options.store.read()) {
        if (job.state === "pending") {
          queued.push(job);
          requeued.push(job);
        } else if (job.state === "running") {
          // Its process died with the previous manager. Close it honestly;
          // never re-run a mutating job behind the operator's back.
          const closed: JobRecord = { ...job, state: "interrupted" };
          options.store.append({
            jobId: job.jobId,
            state: "interrupted",
            endedAt: new Date(now()).toISOString(),
          });
          interrupted.push(closed);
        }
      }
      pump();
      return { requeued, interrupted };
    },
    pending: () => [...queued],
    running: () => [...active.values()].map((entry) => entry.record),
    recent: (limit = DEFAULT_RECENT_JOBS) => {
      // Folded from the ledger, not from memory: after a manager restart the
      // in-memory maps are empty but the operator most needs to see what the
      // previous manager left behind (especially `interrupted`).
      const finished = options.store.read().filter((j) => TERMINAL_JOB_STATES.has(j.state));
      const at = (j: JobRecord): number =>
        Date.parse(j.endedAt ?? j.startedAt ?? j.enqueuedAt) || 0;
      finished.sort((a, b) => at(b) - at(a));
      return finished.slice(0, Math.max(0, limit));
    },
    idle: () =>
      new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
        settle();
      }),
    cancel: (jobId) => {
      const idx = queued.findIndex((j) => j.jobId === jobId);
      if (idx !== -1) {
        queued.splice(idx, 1);
        options.store.append({
          jobId,
          state: "cancelled",
          endedAt: new Date(now()).toISOString(),
        });
        settle();
        return true;
      }
      const entry = active.get(jobId);
      // A running job whose runner never handed us a child cannot be
      // reached. Saying so is the honest answer; `true` here is how "cancel"
      // came to mean "removed a row from a list" while the process ran on.
      if (entry === undefined || entry.child === undefined) return false;
      entry.cancelled = true;
      signalChild(entry, stopGraceMs);
      return true;
    },
    terminateRunning: async (stopOptions = {}) => {
      shuttingDown = true;
      const graceMs = stopOptions.graceMs ?? stopGraceMs;
      const deadlineMs = stopOptions.deadlineMs ?? DEFAULT_JOB_SHUTDOWN_DEADLINE_MS;
      const entries = [...active.values()];
      const abandoned: JobRecord[] = [];
      for (const entry of entries) {
        // Marked FIRST: a job whose runner returns before we get to signal
        // it must still leave its row open rather than claim it finished.
        entry.abandoned = true;
        abandoned.push(entry.record);
        signalChild(entry, graceMs);
      }
      if (abandoned.length === 0) return abandoned;
      let handle: unknown;
      const deadline = new Promise<void>((resolve) => {
        handle = clock.setTimeout(resolve, deadlineMs);
      });
      try {
        await Promise.race([Promise.all(entries.map((e) => e.settled)), deadline]);
      } finally {
        clock.clearTimeout(handle);
      }
      return abandoned;
    },
  };
}

function defaultJobId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `job_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// The per-harness mutating mutex (standalone, for callers not using the queue)
// ---------------------------------------------------------------------------

export type HarnessMutex = {
  /** Take the lock, or undefined when it is held. The returned function
   *  releases it (idempotent). */
  tryAcquire(harnessDir: string): (() => void) | undefined;
  isHeld(harnessDir: string): boolean;
};

export function createHarnessMutex(): HarnessMutex {
  const held = new Set<string>();
  return {
    tryAcquire: (harnessDir) => {
      if (held.has(harnessDir)) return undefined;
      held.add(harnessDir);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.delete(harnessDir);
      };
    },
    isHeld: (harnessDir) => held.has(harnessDir),
  };
}
