/**
 * Catalog R14 `queue-consumer` — Section 23 BATCH.
 *
 * Long-running consumer loop. Pulls jobs from any `QueueAdapter`, runs
 * the user's handler with `concurrency`-bounded parallelism, wraps each
 * call in an idempotency-key cache so retries hit cache, and acks /
 * nacks based on the handler's outcome.
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
  | { kind: "fail"; reason: NackReason; error: unknown };

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

export function startConsumer<TInput, TResult>(
  opts: ConsumerOptions<TInput, TResult>,
): RunningConsumer {
  const visRenewMs = opts.visibilityRenewIntervalMs ?? DEFAULT_VISIBILITY_RENEW_INTERVAL_MS;
  const idempotencyTtlMs = opts.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const pullBatch = opts.pullBatchSize ?? opts.concurrency;
  const emptyPollMs = opts.emptyQueuePollMs ?? DEFAULT_EMPTY_QUEUE_POLL_MS;
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
    const key = idempotencyKey(job.id, job.attempt);
    const stopRenew = startVisibilityRenew(opts.queue, job.id, visRenewMs, ts, tc);
    let outcome: ConsumerHandlerOutcome<TResult>;
    try {
      const r = wrappedHandler
        ? await wrappedHandler({ input: job.input, job }, key)
        : { value: await opts.handler(job.input, { key, job }), fromCache: false };
      outcome = { kind: "ok", value: r.value, fromCache: r.fromCache };
    } catch (err) {
      const isLast = job.attempt >= maxRetries;
      outcome = {
        kind: "fail",
        reason: isLast ? "permanent" : "transient",
        error: err,
      };
    } finally {
      stopRenew();
    }
    if (outcome.kind === "ok") {
      try {
        await opts.queue.ack(job.id);
      } catch (err) {
        // Best-effort: log + continue. Adapter ack failures don't reach
        // userland; they'd surface as duplicate work on the next pull.
      }
    } else {
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
