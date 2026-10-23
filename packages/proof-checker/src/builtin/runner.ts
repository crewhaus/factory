/**
 * The `builtin` checker as a {@link ProofChecker}: each check runs on a
 * worker thread of its own, inside its deadline (design §6.4; §18, "checkers
 * bounded by timeout_ms").
 *
 * WHY A WORKER. `checkCertificate` is synchronous and may spend its whole
 * budget: a statement a model can write (big rationals over a 10 000-value
 * domain) keeps it busy for all 10 s. On the harness's thread nothing else
 * runs meanwhile: no timer, no other session, no other tenant of a managed
 * daemon, and no abort, since an abort is an event and the thread never
 * yields to deliver it. Nor does a turn yield between its tool calls (the
 * artifact write and the event-log append are synchronous too), so a turn
 * with three such checks held the whole process for 30 s. On a worker the
 * caller's event loop stays free, an abort terminates the worker at once, and
 * the worker's own budget ends the check at its deadline.
 *
 * WHY THE WORKER IS TEXT. The CLI ships as a `bun build --compile` single
 * binary, which embeds only what static imports reach: a worker loaded from
 * a file URL would start from source and fail only in the binary. So the
 * worker runs {@link BUILTIN_WORKER_SOURCE} from a Blob URL — ./worker and
 * the checker it imports, bundled by `scripts/gen-worker-source.ts`, which a
 * test holds identical to a fresh build (`@crewhaus/tool-safety`'s regex
 * worker is the precedent). `runner.compiled-binary.test.ts` builds a real
 * binary to prove it starts there.
 *
 * BOUNDS. At most `BUILTIN_LIMITS.maxConcurrentChecks` workers run at once;
 * a check past that waits for one to finish. One deadline covers the whole
 * call — the wait, the worker's start and the check — and a worker still
 * running {@link WORKER_GRACE_MS} past it is terminated, so no call outlives
 * its deadline by more than that.
 *
 * WHERE NO WORKER CAN START (a runtime without `Worker`, or one that refuses
 * the Blob), the check runs on the caller's thread as it always could, after
 * yielding to the event loop once, so a turn's checks at least take turns
 * with everything else. {@link builtinCheckerCounts} says how often.
 */
import type { CheckInput, CheckResult, ProofChecker } from "../types";
import { BUILTIN_LIMITS, STOP_REASONS } from "./budget";
import {
  BUILTIN_CHECKER_ID,
  BUILTIN_LANGUAGE,
  type BuiltinVerdict,
  checkCertificate,
  usableMs,
} from "./checker";
import { BUILTIN_WORKER_SOURCE } from "./worker-source";

/**
 * How long past its deadline a worker may run before it is terminated: its
 * start-up, and the last step of work before its own clock check.
 */
export const WORKER_GRACE_MS = 2_000;

/** Options for {@link createBuiltinChecker}. */
export type BuiltinCheckerOptions = {
  /**
   * Per-check budget when the input carries none (default 10 s). Capped at
   * `BUILTIN_LIMITS.maxTimeoutMs` (10 s) whatever is passed: a check holds a
   * core for all of it, so `formal.timeout_ms` — sized for a container's
   * cold start — must not stretch it.
   */
  readonly timeoutMs?: number;
};

const counts = { running: 0, waiting: 0, inProcess: 0 };

/**
 * Process-wide counts: checks `running` (each on a worker, or on the
 * caller's thread where no worker could start), checks `waiting` for a free
 * worker, and how many checks so far ran `inProcess` because no worker
 * could start. The first two return to zero on their own.
 */
export function builtinCheckerCounts(): {
  readonly running: number;
  readonly waiting: number;
  readonly inProcess: number;
} {
  return { running: counts.running, waiting: counts.waiting, inProcess: counts.inProcess };
}

// ─── Slots ──────────────────────────────────────────────────────────────────

/** Checks waiting for a slot, first come first served. */
const queue: Array<() => void> = [];

type SlotOutcome = "start" | "cancelled" | "timed out";

/** A slot to run in, or why the check never got one. */
function acquire(signal: AbortSignal | undefined, deadlineAt: number): Promise<SlotOutcome> {
  if (counts.running < BUILTIN_LIMITS.maxConcurrentChecks) {
    counts.running += 1;
    return Promise.resolve("start");
  }
  return new Promise((resolve) => {
    let left = false;
    const start = (): void => leave("start");
    const onAbort = (): void => leave("cancelled");
    const timer = setTimeout(() => leave("timed out"), Math.max(0, deadlineAt - performance.now()));
    function leave(outcome: SlotOutcome): void {
      if (left) return;
      left = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const at = queue.indexOf(start);
      if (at >= 0) queue.splice(at, 1);
      counts.waiting -= 1;
      if (outcome === "start") counts.running += 1;
      resolve(outcome);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    counts.waiting += 1;
    queue.push(start);
  });
}

function release(): void {
  counts.running -= 1;
  queue[0]?.();
}

// ─── The worker ─────────────────────────────────────────────────────────────

let workerUrl: string | undefined;

function workerUrlOnce(): string {
  workerUrl ??= URL.createObjectURL(new Blob([BUILTIN_WORKER_SOURCE], { type: "text/javascript" }));
  return workerUrl;
}

/** A worker's answer, or why none could start (the caller then checks in-process). */
type WorkerOutcome = { readonly verdict: BuiltinVerdict } | { readonly notStarted: string };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const stopped = (reason: string): BuiltinVerdict => ({
  ok: false,
  assumptions: [],
  axioms: [],
  output: "",
  reason,
});

/** How a check that never got a thread, or whose checker failed, says so. */
const THREAD_WAIT = "the check ran out of time waiting for a free checker thread";
const INTERNAL_ERROR = "internal checker error: ";

/**
 * Did a builtin check stop without a verdict on the proof — cancelled, out
 * of time (its own budget, which a step's rejection wraps, or the wait for a
 * thread), or the checker itself failing — rather than reject it? A re-check
 * that stopped says nothing about the proof it was given (tool-proof
 * `recheckProof`). The phrases cannot come from the proof: a step's id and
 * rule are checked before they reach a reason.
 */
export function stoppedWithoutVerdict(result: {
  readonly ok: boolean;
  readonly reason?: string;
}): boolean {
  if (result.ok || result.reason === undefined) return false;
  const { reason } = result;
  return (
    reason.includes(STOP_REASONS.cancelled) ||
    reason.includes(STOP_REASONS.timedOut) ||
    reason.startsWith(THREAD_WAIT) ||
    reason.startsWith(INTERNAL_ERROR)
  );
}

function isVerdict(value: unknown): value is BuiltinVerdict {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["ok"] === "boolean" &&
    Array.isArray(v["assumptions"]) &&
    Array.isArray(v["axioms"]) &&
    typeof v["output"] === "string"
  );
}

/**
 * One check on a fresh worker, terminated when it answers, when the signal
 * aborts, or {@link WORKER_GRACE_MS} past the deadline. A worker that fails
 * before it says it is ready never started; one that fails after has
 * rejected the proof — its check is NOT run again on the caller's thread,
 * where whatever brought the worker down would bring the harness down.
 */
function runOnWorker(
  input: CheckInput,
  signal: AbortSignal | undefined,
  deadlineAt: number,
): Promise<WorkerOutcome> {
  // An abort between getting a slot and getting here fired no listener.
  if (signal?.aborted === true) {
    return Promise.resolve({ verdict: stopped(STOP_REASONS.cancelled) });
  }
  if (typeof Worker !== "function") {
    return Promise.resolve({ notStarted: "this runtime has no Worker" });
  }
  let worker: Worker;
  try {
    worker = new Worker(workerUrlOnce());
  } catch (err) {
    return Promise.resolve({ notStarted: message(err) });
  }
  return new Promise((resolve) => {
    let ready = false;
    let settled = false;
    const onAbort = (): void => finish({ verdict: stopped(STOP_REASONS.cancelled) });
    const backstop = setTimeout(
      () => finish({ verdict: stopped(STOP_REASONS.timedOut) }),
      Math.max(0, deadlineAt - performance.now()) + WORKER_GRACE_MS,
    );
    function finish(outcome: WorkerOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      resolve(outcome);
    }
    const failed = (why: string): void =>
      finish(
        ready ? { verdict: stopped(`${INTERNAL_ERROR}${why.slice(0, 300)}`) } : { notStarted: why },
      );
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as { readonly kind?: unknown; readonly verdict?: unknown } | null;
      if (data?.kind === "ready") {
        ready = true;
      } else if (data?.kind === "verdict" && isVerdict(data.verdict)) {
        finish({ verdict: data.verdict });
      } else {
        failed("the checker's worker answered with something other than a verdict");
      }
    });
    worker.addEventListener("error", (event: Event) => {
      failed(event instanceof ErrorEvent ? event.message : "the checker's worker failed");
    });
    worker.addEventListener("close", () => {
      failed("the checker's worker exited without a verdict");
    });
    // Not what keeps the process up: the backstop timer does, while a check
    // is in flight.
    worker.unref();
    worker.postMessage({
      statement: input.statement,
      proof: input.proof,
      timeoutMs: Math.max(0, deadlineAt - performance.now()),
    });
  });
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The `builtin` checker: always available, no sandbox, no model. */
export function createBuiltinChecker(opts: BuiltinCheckerOptions = {}): ProofChecker {
  return {
    id: BUILTIN_CHECKER_ID,
    language: BUILTIN_LANGUAGE,
    async available() {
      return { ok: true };
    },
    async check(input: CheckInput): Promise<CheckResult> {
      const started = performance.now();
      const result = (verdict: BuiltinVerdict): CheckResult => ({
        ...verdict,
        checker: BUILTIN_CHECKER_ID,
        durationMs: Math.round(performance.now() - started),
      });
      const { signal } = input;
      if (signal?.aborted === true) return result(stopped(STOP_REASONS.cancelled));
      const deadlineAt =
        started + Math.min(usableMs(input.timeoutMs, opts.timeoutMs), BUILTIN_LIMITS.maxTimeoutMs);
      const slot = await acquire(signal, deadlineAt);
      if (slot === "cancelled") return result(stopped(STOP_REASONS.cancelled));
      if (slot === "timed out") {
        return result(
          stopped(
            `${THREAD_WAIT} (${BUILTIN_LIMITS.maxConcurrentChecks} other checks were running); nothing was checked, so try again`,
          ),
        );
      }
      try {
        const outcome = await runOnWorker(input, signal, deadlineAt);
        if ("verdict" in outcome) return result(outcome.verdict);
        // No worker here: the caller's thread, as it always could, after
        // letting everything that is waiting run first.
        counts.inProcess += 1;
        await yieldToLoop();
        return result(
          checkCertificate({
            statement: input.statement,
            proof: input.proof,
            timeoutMs: Math.max(0, deadlineAt - performance.now()),
            ...(signal !== undefined ? { signal } : {}),
          }),
        );
      } finally {
        release();
      }
    },
  };
}
