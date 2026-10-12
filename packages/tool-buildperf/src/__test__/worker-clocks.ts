import { spyOn } from "bun:test";
import { REGEX_RUN_DEFAULTS } from "@crewhaus/tool-safety/regex";

/** The deadline BundleSizeCheck and FlakyTestDetect give each regex worker run. */
const RUN_DEADLINE_MS = 2_000;
/** Taken before any test runs, so a spy left over from an abandoned test is never called back. */
const realSetTimeout = globalThis.setTimeout;

/** Puts back what the running {@link withoutWorkerClocks} installed; undefined when nothing is. */
let installed: (() => void) | undefined;

/**
 * Put back whatever {@link withoutWorkerClocks} still has installed. Call it
 * from `afterEach`: a body that never settles (a regression that hangs) is
 * abandoned at its budget and never reaches its own `finally`, and the clock
 * and timers must not stay frozen for the tests after it.
 */
export function restoreWorkerClocks(): void {
  installed?.();
}

/**
 * Run `body` so that no clock decides what the regex worker answers. Two
 * would otherwise. The worker reports a failing `exec` that took 100 ms as
 * the engine giving up, never as "no match", so a worker thread a loaded
 * runner stalls that long turns a definite answer into "could not determine"
 * and the call fails. And each run has a 2 s deadline, armed when the worker
 * is ready, which a worker held that long misses.
 *
 * So the give-up threshold is 60 s, and each run's deadline timer is held:
 * never armed. The caller's clock stands still meanwhile, so the screen's
 * time takes nothing off the deadline and the timer is exactly 2 s. A body
 * that arms no such timer throws, so a changed deadline cannot quietly put
 * the race back. A pattern that hangs still fails the test, at its budget.
 * Everything is put back before this returns.
 */
export async function withoutWorkerClocks<T>(body: () => Promise<T>): Promise<T> {
  restoreWorkerClocks();
  const defaults = REGEX_RUN_DEFAULTS as { giveUpMs: number };
  const giveUpMs = defaults.giveUpMs;
  let held = 0;
  defaults.giveUpMs = 60_000;
  const clock = spyOn(performance, "now").mockReturnValue(0);
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    if (delay !== RUN_DEADLINE_MS) return realSetTimeout(fn, delay, ...rest);
    held += 1;
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  // Once only, and only while it is still the installation in place: a body
  // abandoned earlier must not undo a later test's.
  const restore = (): void => {
    if (installed !== restore) return;
    installed = undefined;
    timers.mockRestore();
    clock.mockRestore();
    defaults.giveUpMs = giveUpMs;
  };
  installed = restore;
  try {
    const value = await body();
    if (held === 0) {
      throw new Error(`no regex run armed a ${RUN_DEADLINE_MS} ms deadline, so none was held`);
    }
    return value;
  } finally {
    restore();
  }
}
