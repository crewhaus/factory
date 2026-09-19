/**
 * Time, injected.
 *
 * Two tools here need a clock: `EvmWaitForReceipt` sleeps between polls and
 * stops at a deadline, and `EvmRpcHealth` reports how old the head block is.
 * Both would otherwise be untestable without a real wait — and a test that
 * waits is a test that is slow on a good day and flaky on a loaded CI box.
 *
 * With the seam, the deadline test costs nothing and asserts the thing that
 * matters (how many polls happened and why it stopped) rather than how long it
 * took. No test in this package asserts wall-clock time.
 */
export type Clock = {
  /** Milliseconds since the epoch. */
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error("aborted"));
        return;
      }
      const handle = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(handle);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

let clock: Clock = realClock;

/** Test seam — `_setClock(undefined)` restores the real one. */
export function _setClock(next: Clock | undefined): void {
  clock = next ?? realClock;
}

export function nowMs(): number {
  return clock.now();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return clock.sleep(ms, signal);
}

/**
 * A clock a test drives: `now` only moves when something sleeps.
 *
 * Exported from the package's fixtures rather than kept in one test file
 * because three suites need it. Sleeping advances the virtual clock and
 * returns immediately, so a fifteen-minute deadline costs microseconds and the
 * poll count is exactly what the code decided rather than what the machine had
 * time for.
 */
export function virtualClock(startMs = 1_700_000_000_000): Clock & {
  readonly sleeps: number[];
  advance(ms: number): void;
} {
  let current = startMs;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    async sleep(ms: number, signal?: AbortSignal) {
      if (signal?.aborted === true) throw new Error("aborted");
      sleeps.push(ms);
      current += ms;
    },
  };
}
