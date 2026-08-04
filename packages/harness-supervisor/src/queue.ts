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
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

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

export type JobRunner = (job: JobRecord) => Promise<{ exitCode?: number; error?: string }>;

export type JobQueueOptions = {
  readonly store: JobStore;
  readonly run: JobRunner;
  /** Global concurrency across all harnesses. Default 3. */
  readonly concurrency?: number;
  readonly now?: () => number;
  /** Job id minter; injected for deterministic tests. */
  readonly newJobId?: () => string;
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
  cancel(jobId: string): boolean;
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

/**
 * The queue. Ordering is FIFO within the global concurrency limit, with the
 * per-harness mutating mutex layered on top: a mutating job whose harness is
 * busy stays queued and the next eligible job runs instead of the whole
 * queue stalling behind it.
 */
export function createJobQueue(options: JobQueueOptions): JobQueue {
  const concurrency = options.concurrency ?? DEFAULT_JOB_CONCURRENCY;
  const now = options.now ?? Date.now;
  const mintId = options.newJobId ?? defaultJobId;
  const queued: JobRecord[] = [];
  const active = new Map<string, JobRecord>();
  /** Harness dirs currently held by a mutating job. */
  const heldHarnesses = new Set<string>();
  const idleWaiters: Array<() => void> = [];

  const settle = (): void => {
    if (queued.length === 0 && active.size === 0) {
      for (const w of idleWaiters.splice(0)) w();
    }
  };

  const pump = (): void => {
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

  const start = async (job: JobRecord): Promise<void> => {
    const started: JobRecord = {
      ...job,
      state: "running",
      startedAt: new Date(now()).toISOString(),
    };
    active.set(job.jobId, started);
    if (job.mutating) heldHarnesses.add(job.harnessDir);
    options.store.append({
      jobId: job.jobId,
      state: "running",
      startedAt: started.startedAt as string,
    });
    let outcome: { exitCode?: number; error?: string };
    try {
      outcome = await options.run(started);
    } catch (err) {
      outcome = { error: err instanceof Error ? err.message : String(err) };
    }
    active.delete(job.jobId);
    if (job.mutating) heldHarnesses.delete(job.harnessDir);
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
    running: () => [...active.values()],
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
      if (idx === -1) return false;
      queued.splice(idx, 1);
      options.store.append({
        jobId,
        state: "cancelled",
        endedAt: new Date(now()).toISOString(),
      });
      settle();
      return true;
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
