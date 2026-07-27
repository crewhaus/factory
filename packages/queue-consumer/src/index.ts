/**
 * Catalog R14 `queue-consumer` — Section 23 BATCH.
 *
 * Long-running consumer loop. Pulls jobs from any `QueueAdapter`, runs
 * the user's handler with `concurrency`-bounded parallelism, wraps each
 * call in an idempotency-key cache so redeliveries hit cache, and acks /
 * nacks based on the handler's outcome.
 *
 * Idempotency window: the cache is keyed on the job id alone and holds
 * only SUCCESSFUL results for `idempotencyTtlMs`. It fires when a job that
 * already completed comes back — a swallowed ack, a crash between handler
 * and ack, a visibility lease that expired mid-handler, a competing
 * consumer — and the handler is skipped (`fromCache: true`). A clean
 * pull → success → ack cycle never re-delivers, so a healthy run reports
 * `fromCache: false` throughout; that is the window doing nothing because
 * nothing was duplicated, not the window being inert.
 *
 * Visibility renewal: while a handler is running, a sidecar timer
 * extends the job's visibility every `visibilityRenewIntervalMs` until
 * either the handler completes or the consumer is told to stop. This
 * keeps long-running model calls from being yanked out from under the
 * worker by another consumer that thinks the lease expired.
 *
 * Retry policy:
 *   - handler throws + `attempt < maxRetries` → `nack(transient)` so
 *     the queue re-enqueues for the next consumer.
 *   - handler throws + `attempt >= maxRetries` → `nack(permanent)` so
 *     the queue moves the job to its DLQ.
 *   - handler resolves → `ack`.
 *   - handler throws `approval_pending` (loop contract 0.4, G11) → DEFER:
 *     neither ack nor nack, push the visibility lease out by
 *     `deferVisibilityMs`, and do not count the attempt.
 *
 * Why parking is not a retry: a parked job is waiting on a human running
 * `crewhaus approvals grant`, which takes as long as it takes. Counted as a
 * failure — the pre-G11 behaviour — the default 3-retry budget was spent in
 * under a minute and the job dead-lettered long before anyone looked at it,
 * so the approval seam could never actually complete on this shape. The
 * grant is keyed on `(toolName, inputHash)`, so any later re-delivery finds
 * it; the only thing that had to change was not throwing the job away first.
 *
 * Drain semantics: `drain()` stops new pulls but lets in-flight handlers
 * complete + ack. `stop()` is `drain()` plus a wait — used by the
 * SIGTERM path so the daemon shuts down cleanly without orphaning
 * mid-flight jobs.
 */
import { CrewhausError } from "@crewhaus/errors";
import { type IdempotencyStore, idempotencyKey, withIdempotency } from "@crewhaus/idempotency-keys";
import type { Job, NackReason, QueueAdapter } from "@crewhaus/queue-protocol";

export class QueueConsumerError extends CrewhausError {
  override readonly name = "QueueConsumerError";
  constructor(message: string, cause?: unknown) {
    super("runtime", message, cause);
  }
}

export type ConsumerHandlerOutcome<TResult> =
  | { kind: "ok"; value: TResult; fromCache: boolean }
  | { kind: "fail"; reason: NackReason; error: unknown }
  /**
   * The handler PARKED awaiting a human decision (`approval_pending`) rather
   * than failing. The job is neither ack'd nor nack'd: its visibility lease
   * is pushed out by `deferVisibilityMs`, and when that expires the adapter
   * returns it to pending for a later re-delivery. `defers` is how many times
   * THIS job has parked, and those attempts are excluded from the retry
   * budget — see `handleOne`.
   */
  | { kind: "deferred"; error: unknown; defers: number };

export type ConsumerObserver<TInput, TResult> = {
  onJobStart?(job: Job<TInput>): void;
  onJobEnd?(job: Job<TInput>, outcome: ConsumerHandlerOutcome<TResult>): void;
  /** Fires when drain begins. */
  onDrainStart?(): void;
  /** Fires after drain completes (no more in-flight). */
  onDrainEnd?(): void;
};

export type ConsumerOptions<TInput, TResult> = {
  readonly queue: QueueAdapter<TInput>;
  readonly handler: (input: TInput, ctx: { key: string; job: Job<TInput> }) => Promise<TResult>;
  readonly concurrency: number;
  readonly visibilityTimeoutMs: number;
  readonly visibilityRenewIntervalMs?: number;
  readonly idempotencyStore?: IdempotencyStore<TResult>;
  readonly idempotencyTtlMs?: number;
  readonly maxRetries?: number;
  /**
   * How long a PARKED job (handler threw `approval_pending`) stays invisible
   * before the queue re-delivers it. Defaults to 60s.
   *
   * A park is not a failure, so the job must come back — but it must not come
   * back IMMEDIATELY. Returning it straight to pending spins the consumer:
   * pull → run a model turn → hit the same ungranted permission → park, over
   * and over, burning a model call per lap while a human is still deciding.
   * The lease push is the backoff.
   */
  readonly deferVisibilityMs?: number;
  /** Per-pull batch cap. Defaults to `concurrency`. */
  readonly pullBatchSize?: number;
  /** Wait between empty-queue pulls. Defaults to 100ms. */
  readonly emptyQueuePollMs?: number;
  readonly observer?: ConsumerObserver<TInput, TResult>;
  /** Test seam — `setTimeout`/`clearTimeout` overrides for deterministic visibility renewal tests. */
  readonly _setTimeout?: typeof setTimeout;
  readonly _clearTimeout?: typeof clearTimeout;
};

export interface RunningConsumer {
  /**
   * Block until every in-flight handler completes; no new pulls happen
   * after this is called. Idempotent — second call returns the same
   * promise.
   */
  drain(): Promise<void>;
  /**
   * Start drain + return when finished. Convenience for SIGTERM paths.
   * Equivalent to `drain()` today; left as a separate verb so future
   * graceful-stop semantics (e.g. close adapter connections) can fit.
   */
  stop(): Promise<void>;
  /** Diagnostic — currently in-flight job count. */
  inFlight(): number;
}

const DEFAULT_VISIBILITY_RENEW_INTERVAL_MS = 5_000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_EMPTY_QUEUE_POLL_MS = 100;
const DEFAULT_DEFER_VISIBILITY_MS = 60_000;

/**
 * Loop contract 0.4 (G11) — did the handler PARK on a pending approval rather
 * than fail?
 *
 * Structural, not `instanceof`: the error crosses a package boundary (and, in
 * a compiled bundle, possibly a duplicated `@crewhaus/errors` instance), so an
 * identity check would silently fall through to the failure path — which is
 * exactly the bug this function exists to prevent, and it would be invisible.
 */
function isApprovalPending(err: unknown): boolean {
  const report = (err as { report?: { class?: unknown } } | null | undefined)?.report;
  return typeof report === "object" && report !== null && report.class === "approval_pending";
}

export function startConsumer<TInput, TResult>(
  opts: ConsumerOptions<TInput, TResult>,
): RunningConsumer {
  const visRenewMs = opts.visibilityRenewIntervalMs ?? DEFAULT_VISIBILITY_RENEW_INTERVAL_MS;
  const idempotencyTtlMs = opts.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const pullBatch = opts.pullBatchSize ?? opts.concurrency;
  const emptyPollMs = opts.emptyQueuePollMs ?? DEFAULT_EMPTY_QUEUE_POLL_MS;
  const deferVisibilityMs = opts.deferVisibilityMs ?? DEFAULT_DEFER_VISIBILITY_MS;
  const ts = opts._setTimeout ?? setTimeout;
  const tc = opts._clearTimeout ?? clearTimeout;

  const wrappedHandler = opts.idempotencyStore
    ? withIdempotency<{ input: TInput; job: Job<TInput> }, TResult>(
        async ({ input, job }, key) => opts.handler(input, { key, job }),
        { store: opts.idempotencyStore, ttlMs: idempotencyTtlMs },
      )
    : undefined;

  let stopping = false;
  let drainPromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();
  /**
   * jobId → how many of its deliveries ended in an approval park. Subtracted
   * from `job.attempt` so waiting on a human never advances a job toward the
   * DLQ. Cleared when the job reaches a terminal state (ack / permanent
   * nack), so this holds at most one integer per job currently awaiting
   * approval — a job parked forever is the intended outcome, not a leak.
   */
  const deferCounts = new Map<string, number>();

  // Pull loop runs as a background async function. It awaits available
  // concurrency before pulling the next batch.
  const loopPromise = (async () => {
    while (!stopping) {
      // Concurrency gate: wait until at least one slot is free.
      while (inFlight.size >= opts.concurrency && !stopping) {
        await Promise.race(inFlight);
      }
      if (stopping) break;

      const want = Math.max(1, Math.min(pullBatch, opts.concurrency - inFlight.size));
      let pulled: ReadonlyArray<Job<TInput>>;
      try {
        pulled = await opts.queue.pull({
          maxBatch: want,
          visibilityTimeoutMs: opts.visibilityTimeoutMs,
        });
      } catch (err) {
        // Adapter blip — treat as empty pull, slow down a bit, retry.
        await sleep(emptyPollMs * 2);
        continue;
      }

      if (pulled.length === 0) {
        await sleep(emptyPollMs);
        continue;
      }

      for (const job of pulled) {
        const p = handleOne(job).finally(() => {
          inFlight.delete(p);
        });
        inFlight.add(p);
      }
    }
  })().catch((err) => {
    // Surface any unhandled error from the loop itself (rare — handlers
    // already trap exceptions).
    process.stderr.write(`[queue-consumer] loop error: ${(err as Error).message}\n`);
  });

  async function handleOne(job: Job<TInput>): Promise<void> {
    opts.observer?.onJobStart?.(job);
    // Key on the job's IDENTITY only. Including `job.attempt` made the
    // idempotency window unreachable: a redelivery — the one case the cache
    // exists for — always arrives with a bumped attempt (the in-memory and
    // postgres adapters increment it on every pull), so every lookup missed
    // and `idempotencyTtlMs` was dead configuration. Failed attempts cache
    // nothing (see `withIdempotency`), so a retry after a genuine failure
    // still re-runs the handler.
    const key = idempotencyKey(job.id);
    const stopRenew = startVisibilityRenew(opts.queue, job.id, visRenewMs, ts, tc);
    let outcome: ConsumerHandlerOutcome<TResult>;
    try {
      const r = wrappedHandler
        ? await wrappedHandler({ input: job.input, job }, key)
        : { value: await opts.handler(job.input, { key, job }), fromCache: false };
      outcome = { kind: "ok", value: r.value, fromCache: r.fromCache };
    } catch (err) {
      if (isApprovalPending(err)) {
        // A park is NOT a failure — it is a run waiting on a human, and the
        // only thing that can resolve it is someone running `crewhaus
        // approvals grant`. Counting it against `maxRetries` meant a job
        // almost always dead-lettered before that happened: with the default
        // 3 retries and a visibility timeout in the tens of seconds, the
        // budget was spent in under a minute.
        const defers = (deferCounts.get(job.id) ?? 0) + 1;
        deferCounts.set(job.id, defers);
        outcome = { kind: "deferred", error: err, defers };
      } else {
        // Attempts spent parking do not count toward the retry budget, so a
        // job that parked twice and then genuinely fails still gets its full
        // `maxRetries` worth of real attempts.
        const effectiveAttempt = job.attempt - (deferCounts.get(job.id) ?? 0);
        outcome = {
          kind: "fail",
          reason: effectiveAttempt >= maxRetries ? "permanent" : "transient",
          error: err,
        };
      }
    } finally {
      stopRenew();
    }
    if (outcome.kind === "ok") {
      deferCounts.delete(job.id);
      try {
        await opts.queue.ack(job.id);
      } catch (err) {
        // Best-effort: log + continue. Adapter ack failures don't reach
        // userland; they'd surface as duplicate work on the next pull.
      }
    } else if (outcome.kind === "deferred") {
      // Neither ack nor nack: acking would drop the job on the floor, and
      // nacking would either burn the budget (transient) or dead-letter it
      // (permanent). Instead push the lease out — every adapter already
      // implements `extendVisibility`, so this needs no protocol change and
      // behaves the same on in-memory, SQS, Redis and Postgres. When the
      // lease expires the adapter returns the job to pending on its own.
      try {
        await opts.queue.extendVisibility(job.id, deferVisibilityMs);
      } catch {
        // If the lease can no longer be extended the job has already been
        // reclaimed — it will be re-delivered anyway, which is the same
        // outcome, just sooner.
      }
    } else {
      // Terminal for this job: stop tracking its parks.
      if (outcome.reason === "permanent") deferCounts.delete(job.id);
      try {
        await opts.queue.nack(job.id, outcome.reason);
      } catch {
        // Same rationale.
      }
    }
    opts.observer?.onJobEnd?.(job, outcome);
  }

  async function drain(): Promise<void> {
    if (drainPromise !== undefined) return drainPromise;
    stopping = true;
    opts.observer?.onDrainStart?.();
    drainPromise = (async () => {
      // First, let the pull loop notice the stop flag.
      await loopPromise;
      // Then wait for in-flight to finish.
      while (inFlight.size > 0) {
        await Promise.race(inFlight);
      }
      opts.observer?.onDrainEnd?.();
    })();
    return drainPromise;
  }

  return {
    drain,
    stop: drain,
    inFlight: () => inFlight.size,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start a sidecar that calls `extendVisibility(jobId, ...)` every
 * `intervalMs` until the returned `stop()` is invoked. We pass the
 * timer functions explicitly so tests can drive them deterministically.
 */
function startVisibilityRenew(
  queue: QueueAdapter<unknown>,
  jobId: string,
  intervalMs: number,
  setTimeoutImpl: typeof setTimeout,
  clearTimeoutImpl: typeof clearTimeout,
): () => void {
  let stopped = false;
  let handle: ReturnType<typeof setTimeoutImpl> | undefined;

  const tick = (): void => {
    if (stopped) return;
    handle = setTimeoutImpl(() => {
      if (stopped) return;
      // Best-effort: a renew failure after the job is already ack'd is
      // expected (extendVisibility throws unknown-jobId). Swallow.
      queue.extendVisibility(jobId, intervalMs * 2).catch(() => {});
      tick();
    }, intervalMs);
  };
  tick();

  return () => {
    stopped = true;
    if (handle !== undefined) clearTimeoutImpl(handle);
  };
}
