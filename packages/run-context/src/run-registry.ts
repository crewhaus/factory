/**
 * The process-wide run registry: the abort controller of every run whose
 * context made its own, and the holds that say a run is still in progress.
 *
 * `createRunContext` with no `abortSignal` keeps the controller it creates
 * here, so {@link cancelRun} can stop the run by its id: the runtime roots
 * the run's abort tree on the context's signal, so cancelling it stops every
 * turn and tool call beneath. A context made with a caller's signal keeps no
 * controller; the caller owns cancelling it.
 *
 * A hold ({@link retainRun}) says the run has not ended: a loop holds its run
 * while it runs, and a library that drives several loops on one context holds
 * it for the whole run. When the last hold is released the run is idle: its
 * idle handler ({@link onRunIdle}) runs once and the entry is removed. A
 * holder that knows how the run ended says so on its release
 * ({@link RunHoldOutcome}), and the idle handler is handed it: a library that
 * drives several loops ends the run however it ended itself, not however its
 * last loop did.
 *
 * {@link activeRunCount} counts the runs that hold at least one hold, and
 * {@link isRunHeld} says whether one run does: an entry made only for a
 * controller, by `createRunContext`, is not held.
 *
 * One map, kept on `globalThis` under `Symbol.for("@crewhaus/run-context/runs")`
 * so two copies of this package in one process share it, capped at
 * {@link RUN_REGISTRY_CAP} entries. Entries leave by that cap, never by time:
 * the oldest entry with no holds goes first, and a held one only when every
 * other entry is held too, then the oldest.
 */

/** How many runs the registry keeps. */
export const RUN_REGISTRY_CAP = 1024;

/** The branded reason {@link cancelRun} aborts with, read by {@link isCancelReason}. */
export type CancelAbortReason = { readonly crewhausCancel: true };

/**
 * How a holder ended the run it held, said on its release: it finished, it
 * paused for a person's decision, or it failed with `error`.
 */
export type RunHoldOutcome =
  | { readonly outcome: "succeeded" }
  | { readonly outcome: "paused" }
  | { readonly outcome: "failed"; readonly error: unknown };

type Entry = {
  controller?: AbortController;
  holds: number;
  idle?: (ended: RunHoldOutcome | undefined) => void;
  ended?: RunHoldOutcome;
};

const REGISTRY_KEY = Symbol.for("@crewhaus/run-context/runs");

function registry(): Map<string, Entry> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Entry> | undefined>;
  let map = holder[REGISTRY_KEY];
  if (map === undefined) {
    map = new Map<string, Entry>();
    holder[REGISTRY_KEY] = map;
  }
  return map;
}

/** Make room for one more entry: the oldest unheld one goes, else the oldest. */
function evictForInsert(map: Map<string, Entry>): void {
  if (map.size < RUN_REGISTRY_CAP) return;
  let victim: string | undefined;
  for (const [runId, entry] of map) {
    if (entry.holds === 0) {
      victim = runId;
      break;
    }
  }
  victim ??= map.keys().next().value;
  if (victim !== undefined) map.delete(victim);
}

function entryFor(runId: string): Entry {
  const map = registry();
  const existing = map.get(runId);
  if (existing !== undefined) return existing;
  evictForInsert(map);
  const entry: Entry = { holds: 0 };
  map.set(runId, entry);
  return entry;
}

/** Keep the controller a new context made for itself. Called by `createRunContext`. */
export function registerRunController(runId: string, controller: AbortController): void {
  entryFor(runId).controller = controller;
}

/**
 * Stop a run by its id: abort the controller its context made with
 * `{crewhausCancel: true}` as the reason, and answer `true`. `false` when this
 * process holds no controller for it: an unknown or ended run, one evicted by
 * the cap, or one whose context was made with a caller's signal.
 *
 * First consumer: the per-run cancel of the control.v1 interface.
 */
export function cancelRun(runId: string): boolean {
  const controller = registry().get(runId)?.controller;
  if (controller === undefined) return false;
  if (!controller.signal.aborted) {
    const reason: CancelAbortReason = { crewhausCancel: true };
    controller.abort(reason);
  }
  return true;
}

/** Whether `signal` was aborted by {@link cancelRun}. */
export function isCancelReason(signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const reason = signal.reason as { crewhausCancel?: unknown } | null | undefined;
  return typeof reason === "object" && reason !== null && reason.crewhausCancel === true;
}

/**
 * Hold a run open: it is not idle until every hold is released. Creates an
 * entry with no controller when the run has none (a context made with a
 * caller's signal still has an end to record; {@link cancelRun} keeps
 * answering `false` for it). The returned release is idempotent: the call
 * that brings the holds to zero runs the run's idle handler once, then removes
 * the entry, controller included.
 *
 * A release may say how the holder ended the run. The idle handler is handed
 * the outcome the releases said: a failure, once said, stands; otherwise the
 * last one said wins. A release that says nothing changes nothing.
 */
export function retainRun(ctx: { readonly runId: string }): (ended?: RunHoldOutcome) => void {
  const runId = ctx.runId;
  const entry = entryFor(runId);
  entry.holds += 1;
  let released = false;
  return (ended?: RunHoldOutcome) => {
    if (released) return;
    released = true;
    if (ended !== undefined && entry.ended?.outcome !== "failed") entry.ended = ended;
    entry.holds -= 1;
    if (entry.holds > 0) return;
    const idle = entry.idle;
    entry.idle = undefined;
    try {
      idle?.(entry.ended);
    } catch {
      // An idle handler records what happened; its failure must not reach the run.
    } finally {
      const map = registry();
      if (map.get(runId) === entry) map.delete(runId);
    }
  };
}

/**
 * Set what runs when the run goes idle (its last hold is released), handed
 * the outcome its holders said, if any. The last caller wins. Answers
 * `false`, and sets nothing, when the registry has no entry for the run: take
 * a hold first.
 */
export function onRunIdle(runId: string, fn: (ended: RunHoldOutcome | undefined) => void): boolean {
  const entry = registry().get(runId);
  if (entry === undefined) return false;
  entry.idle = fn;
  return true;
}

/**
 * How many runs in this process hold at least one hold: the runs it is running.
 * A run that never took a hold is not counted.
 *
 * First consumer: the control plane's `/status` and heartbeat.
 */
export function activeRunCount(): number {
  let count = 0;
  for (const entry of registry().values()) {
    if (entry.holds > 0) count += 1;
  }
  return count;
}

/**
 * Whether `runId` holds at least one hold in this process: the run is still going.
 * A hold says nothing about admission: a crew or a graph holds its run before its
 * first loop is admitted.
 *
 * First consumer: the runtime's admission at loop start, which continues a later loop
 * only on a run it admitted itself and that is still held.
 */
export function isRunHeld(runId: string): boolean {
  return (registry().get(runId)?.holds ?? 0) > 0;
}
