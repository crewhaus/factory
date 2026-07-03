/**
 * Item 41 — `compile --watch` (and `run --watch`). Implements the watch mode
 * the CLI header has listed as "future": watch `crewhaus.yaml` + the
 * `.crewhaus/commands` and skills dirs, debounce bursts of fs events, and
 * re-run a parse→lint→compile cycle on change, printing one green/red status
 * per cycle. Ctrl-C-clean.
 *
 * The DEBOUNCE + cycle loop is factored out here as a pure controller driven by
 * an INJECTED watcher + clock so it is unit-testable without real fs events or
 * wall-clock waits. The CLI wrapper wires `node:fs.watch` and a real
 * `setTimeout` behind the seams.
 */

/** A watcher seam: register `onChange`, return a disposer. The CLI backs this
 *  with `fs.watch` over the spec + commands/skills dirs. */
export type Watcher = {
  /** Subscribe to change events; every fs event calls `cb`. */
  subscribe(cb: () => void): void;
  /** Stop watching + release handles (called on Ctrl-C). */
  close(): void;
};

/** A minimal timer seam so tests drive the debounce deterministically. */
export type TimerSeam = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

/** One cycle's result, printed as a status line. */
export type CycleOutcome = {
  readonly green: boolean;
  /** The status line to print (already colored/marked by the runner). */
  readonly line: string;
};

export type WatchControllerOptions = {
  readonly watcher: Watcher;
  readonly timer: TimerSeam;
  /** Debounce window: coalesce fs events arriving within this many ms. */
  readonly debounceMs: number;
  /** Run one parse→lint→compile cycle; returns the status to print. */
  runCycle(): Promise<CycleOutcome>;
  /** Sink for status lines (stdout in the CLI; a buffer in tests). */
  print(line: string): void;
};

/**
 * The debounced watch controller. A burst of fs events schedules exactly one
 * cycle after `debounceMs` of quiet; events arriving mid-window reset the
 * timer (classic trailing debounce). Cycles never overlap: an event during a
 * running cycle marks the run "dirty" and re-triggers once it finishes, so the
 * latest on-disk state always gets a final cycle.
 *
 * Returns a handle with `stop()` (used by the Ctrl-C handler) and, for tests,
 * `pendingCycles()` so a test can await the controller settling.
 */
export function createWatchController(opts: WatchControllerOptions): {
  stop(): void;
  /** Test seam: resolves once no cycle is running and none is queued. */
  idle(): Promise<void>;
} {
  let timerHandle: unknown;
  let running = false;
  let dirtyWhileRunning = false;
  let stopped = false;
  const idleWaiters: Array<() => void> = [];

  const settleIfIdle = (): void => {
    if (!running && timerHandle === undefined && !dirtyWhileRunning) {
      for (const w of idleWaiters.splice(0)) w();
    }
  };

  const runOnce = async (): Promise<void> => {
    if (stopped) return;
    running = true;
    try {
      const outcome = await opts.runCycle();
      opts.print(outcome.line);
    } catch (err) {
      opts.print(`✗ watch cycle crashed: ${(err as Error).message}`);
    } finally {
      running = false;
      // An event landed mid-cycle — the printed result is already stale, so run
      // one more cycle against the latest state.
      if (dirtyWhileRunning && !stopped) {
        dirtyWhileRunning = false;
        void runOnce();
      } else {
        settleIfIdle();
      }
    }
  };

  const onChange = (): void => {
    if (stopped) return;
    if (running) {
      // Don't interrupt a running cycle; remember to re-run after it finishes.
      dirtyWhileRunning = true;
      return;
    }
    // Trailing debounce: reset the timer on every event in the window.
    if (timerHandle !== undefined) opts.timer.clear(timerHandle);
    timerHandle = opts.timer.set(() => {
      timerHandle = undefined;
      void runOnce();
    }, opts.debounceMs);
  };

  opts.watcher.subscribe(onChange);

  return {
    stop: (): void => {
      stopped = true;
      if (timerHandle !== undefined) {
        opts.timer.clear(timerHandle);
        timerHandle = undefined;
      }
      opts.watcher.close();
      settleIfIdle();
    },
    idle: (): Promise<void> =>
      new Promise<void>((resolveIdle) => {
        idleWaiters.push(resolveIdle);
        settleIfIdle();
      }),
  };
}

/** Compose a green/red status line for a cycle, timestamped. Pure formatter. */
export function formatCycleLine(green: boolean, detail: string, at: Date = new Date()): string {
  const ts = at.toTimeString().slice(0, 8);
  const marker = green ? "✓" : "✗";
  return `${marker} [${ts}] ${detail}`;
}
