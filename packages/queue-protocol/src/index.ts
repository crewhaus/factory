/**
 * Catalog R14 `queue-protocol` — Section 23 BATCH.
 *
 * Abstract queue interface used by `queue-consumer` and the BATCH target
 * codegen. The interface is deliberately minimal: every adapter
 * implements the same four methods so swapping SQS for Redis Streams
 * for Postgres advisory-lock is a config flip, not a code change.
 *
 * Visibility-timeout semantics:
 *   - `pull(maxBatch, visibilityTimeoutMs)` returns up to `maxBatch`
 *     pending jobs; each job becomes invisible to other consumers for
 *     `visibilityTimeoutMs`. Returns an empty array on empty-queue.
 *   - `ack(jobId)` marks the job complete. Idempotent; double-ack is a
 *     no-op (post-conditions: job is gone).
 *   - `nack(jobId, reason)` returns the job to the queue with a
 *     reason classifier. `transient` re-enqueues for retry; `permanent`
 *     moves the job to a dead-letter bucket; `timeout` is the
 *     consumer-internal classifier when a job's visibility window
 *     expires before completion.
 *   - `extendVisibility(jobId, ms)` pushes the visibility-expires-at
 *     forward by `ms`. Used by the consumer to keep long-running jobs
 *     from being yanked out from under it.
 *
 * Adapters in this slice:
 *   - `createInMemoryQueue<T>()` — single-process, fast, used by tests
 *     and the example/smoke. Produces deterministic-ish JobIds via a
 *     monotonic counter so the smoke can assert on them.
 *   - SQS / Redis Streams / Postgres advisory-lock — interface-only
 *     stubs (kept here as type declarations); concrete impls land in
 *     follow-up PRs.
 */
import { CrewhausError } from "@crewhaus/errors";

// Section 30 — additional adapter family members
export {
  createSqsAdapter,
  type SqsAdapterOptions,
  type SqsClientLike,
} from "./adapters/sqs";
export {
  createRedisStreamsAdapter,
  type RedisStreamsAdapterOptions,
  type RedisClientLike,
} from "./adapters/redis-streams";
export {
  createPostgresAdapter,
  type PostgresAdapterOptions,
  type PostgresClientLike,
} from "./adapters/postgres";

export class QueueProtocolError extends CrewhausError {
  override readonly name = "QueueProtocolError";
  constructor(message: string, cause?: unknown) {
    super("runtime", message, cause);
  }
}

export type JobId = string;

export type Job<TInput = unknown> = {
  readonly id: JobId;
  /** 1-indexed; bumped each time the job is pulled (so retries see attempt > 1). */
  readonly attempt: number;
  readonly input: TInput;
  readonly enqueuedAt: string;
  /** ISO8601 timestamp when the visibility lease expires. */
  readonly visibilityExpiresAt: string;
};

export type NackReason = "transient" | "permanent" | "timeout";

export type PullOptions = {
  readonly maxBatch: number;
  readonly visibilityTimeoutMs: number;
};

export interface QueueAdapter<TInput = unknown> {
  /** The adapter's identifier ("in-memory" | "sqs" | "redis-streams" | "postgres" | …). */
  readonly kind: string;
  pull(opts: PullOptions): Promise<ReadonlyArray<Job<TInput>>>;
  ack(jobId: JobId): Promise<void>;
  nack(jobId: JobId, reason: NackReason): Promise<void>;
  extendVisibility(jobId: JobId, additionalMs: number): Promise<void>;
  /**
   * Snapshot counts for observability + tests. Stable contract:
   *   pending — visible-and-enqueued
   *   inFlight — leased to a consumer (visibilityExpiresAt > now)
   *   acked / nacked — terminal state counts since adapter creation
   *   deadLetter — permanent-nack count (subset of nacked)
   */
  stats(): Promise<{
    pending: number;
    inFlight: number;
    acked: number;
    nacked: number;
    deadLetter: number;
  }>;
}

/**
 * Adapters that also act as producers (the in-memory tester does;
 * SQS/Redis Streams adapters keep enqueue inside their respective
 * client SDKs and don't need this interface) implement this.
 */
export interface QueueProducer<TInput = unknown> {
  enqueue(input: TInput): Promise<JobId>;
}

// ---------------------------------------------------------------------------
// In-memory adapter — single-process queue for tests + the BATCH smoke.
// ---------------------------------------------------------------------------

type InternalJob<TInput> = {
  id: JobId;
  input: TInput;
  enqueuedAt: number;
  attempts: number;
  /** 0 = not in flight, otherwise the wall-clock ms when the lease expires. */
  visibilityExpiresAt: number;
  /** terminal status, undefined while live. */
  status: "pending" | "in-flight" | "acked" | "nacked" | "dead-letter";
};

export type InMemoryQueueOptions<TInput = unknown> = {
  /**
   * Test-time clock injection. Defaults to `Date.now`. Returning a
   * monotonic count is the cleanest way to drive the visibility-timeout
   * branches deterministically.
   */
  readonly now?: () => number;
  readonly initialJobs?: ReadonlyArray<TInput>;
  /** Test seam: override the JobId generator. */
  readonly newJobId?: (counter: number) => JobId;
};

export interface InMemoryQueueAdapter<TInput = unknown>
  extends QueueAdapter<TInput>,
    QueueProducer<TInput> {
  readonly kind: "in-memory";
  /** Test helper: list the queue's view of jobs. */
  inspect(): ReadonlyArray<{
    readonly id: JobId;
    readonly status: InternalJob<TInput>["status"];
    readonly attempts: number;
  }>;
}

export function createInMemoryQueue<TInput>(
  opts: InMemoryQueueOptions<TInput> = {},
): InMemoryQueueAdapter<TInput> {
  const now = opts.now ?? Date.now;
  const newJobId = opts.newJobId ?? ((c) => `job_${c.toString(16).padStart(8, "0")}`);
  const jobs = new Map<JobId, InternalJob<TInput>>();
  let counter = 0;
  let acked = 0;
  let nacked = 0;
  let deadLetter = 0;

  function makeJob(input: TInput): InternalJob<TInput> {
    counter += 1;
    return {
      id: newJobId(counter),
      input,
      enqueuedAt: now(),
      attempts: 0,
      visibilityExpiresAt: 0,
      status: "pending",
    };
  }

  for (const seed of opts.initialJobs ?? []) {
    const j = makeJob(seed);
    jobs.set(j.id, j);
  }

  function reclaimExpired(): void {
    const t = now();
    for (const j of jobs.values()) {
      if (j.status === "in-flight" && j.visibilityExpiresAt <= t) {
        // Visibility lease expired without ack/nack — return to pending.
        j.status = "pending";
        j.visibilityExpiresAt = 0;
      }
    }
  }

  return {
    kind: "in-memory",

    async enqueue(input) {
      const j = makeJob(input);
      jobs.set(j.id, j);
      return j.id;
    },

    async pull(pullOpts) {
      reclaimExpired();
      const t = now();
      const out: Job<TInput>[] = [];
      // Stable order: insertion (oldest pending first).
      for (const j of jobs.values()) {
        if (out.length >= pullOpts.maxBatch) break;
        if (j.status !== "pending") continue;
        j.attempts += 1;
        j.status = "in-flight";
        j.visibilityExpiresAt = t + pullOpts.visibilityTimeoutMs;
        out.push({
          id: j.id,
          attempt: j.attempts,
          input: j.input,
          enqueuedAt: new Date(j.enqueuedAt).toISOString(),
          visibilityExpiresAt: new Date(j.visibilityExpiresAt).toISOString(),
        });
      }
      return out;
    },

    async ack(jobId) {
      const j = jobs.get(jobId);
      if (j === undefined) return; // idempotent
      if (j.status === "acked") return;
      j.status = "acked";
      acked += 1;
      jobs.delete(jobId);
    },

    async nack(jobId, reason) {
      const j = jobs.get(jobId);
      if (j === undefined) return;
      if (reason === "permanent") {
        j.status = "dead-letter";
        deadLetter += 1;
        nacked += 1;
        // Keep in map so inspect() can see DLQ items; SQS/etc. would
        // move it to a real DLQ.
        return;
      }
      // transient + timeout: return to pending. attempts stays bumped.
      j.status = "pending";
      j.visibilityExpiresAt = 0;
      nacked += 1;
    },

    async extendVisibility(jobId, additionalMs) {
      const j = jobs.get(jobId);
      if (j === undefined) {
        throw new QueueProtocolError(`extendVisibility: unknown jobId "${jobId}"`);
      }
      if (j.status !== "in-flight") {
        throw new QueueProtocolError(
          `extendVisibility: job "${jobId}" is not in flight (status=${j.status})`,
        );
      }
      j.visibilityExpiresAt += additionalMs;
    },

    async stats() {
      reclaimExpired();
      let pending = 0;
      let inFlight = 0;
      for (const j of jobs.values()) {
        if (j.status === "pending") pending += 1;
        if (j.status === "in-flight") inFlight += 1;
      }
      return { pending, inFlight, acked, nacked, deadLetter };
    },

    inspect() {
      return [...jobs.values()].map((j) => ({
        id: j.id,
        status: j.status,
        attempts: j.attempts,
      }));
    },
  };
}
