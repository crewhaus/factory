import { describe, expect, test } from "bun:test";
import { type TimerSeam, type Watcher, createWatchController, formatCycleLine } from "./watch";

/** A manual timer seam: `flush()` fires the pending timer synchronously so a
 *  test drives the debounce without wall-clock waits. */
function manualTimer(): TimerSeam & { flush(): void; pending(): boolean } {
  let pending: (() => void) | undefined;
  return {
    set: (fn) => {
      pending = fn;
      return {};
    },
    clear: () => {
      pending = undefined;
    },
    flush: () => {
      const fn = pending;
      pending = undefined;
      fn?.();
    },
    pending: () => pending !== undefined,
  };
}

/** A manual watcher: `emit()` triggers the subscribed change callback. */
function manualWatcher(): Watcher & { emit(): void; closed(): boolean } {
  let cb: (() => void) | undefined;
  let closed = false;
  return {
    subscribe: (fn) => {
      cb = fn;
    },
    close: () => {
      closed = true;
    },
    emit: () => cb?.(),
    closed: () => closed,
  };
}

describe("createWatchController — debounce", () => {
  test("coalesces a burst of events into ONE cycle", async () => {
    const timer = manualTimer();
    const watcher = manualWatcher();
    let cycles = 0;
    const printed: string[] = [];
    const controller = createWatchController({
      watcher,
      timer,
      debounceMs: 100,
      runCycle: async () => {
        cycles++;
        return { green: true, line: `cycle ${cycles}` };
      },
      print: (l) => printed.push(l),
    });

    // Three events within the window — the timer is reset each time, so only
    // one timer is armed.
    watcher.emit();
    watcher.emit();
    watcher.emit();
    expect(timer.pending()).toBe(true);

    timer.flush(); // debounce window elapsed → one cycle
    await controller.idle();

    expect(cycles).toBe(1);
    expect(printed).toEqual(["cycle 1"]);
    controller.stop();
  });

  test("an event DURING a running cycle re-triggers exactly one more cycle", async () => {
    const timer = manualTimer();
    const watcher = manualWatcher();
    let cycles = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const controller = createWatchController({
      watcher,
      timer,
      debounceMs: 100,
      runCycle: async () => {
        cycles++;
        if (cycles === 1) await firstGate; // hold the first cycle open
        return { green: true, line: `cycle ${cycles}` };
      },
      print: () => {},
    });

    watcher.emit();
    timer.flush(); // start cycle 1 (now awaiting firstGate)
    // Fire an event while cycle 1 runs — should be remembered, not dropped.
    watcher.emit();
    releaseFirst(); // let cycle 1 finish → cycle 2 auto-runs
    await controller.idle();

    expect(cycles).toBe(2);
    controller.stop();
  });

  test("stop() clears the pending timer and closes the watcher", () => {
    const timer = manualTimer();
    const watcher = manualWatcher();
    const controller = createWatchController({
      watcher,
      timer,
      debounceMs: 100,
      runCycle: async () => ({ green: true, line: "x" }),
      print: () => {},
    });
    watcher.emit();
    expect(timer.pending()).toBe(true);
    controller.stop();
    expect(timer.pending()).toBe(false);
    expect(watcher.closed()).toBe(true);
  });

  test("events after stop() are ignored", async () => {
    const timer = manualTimer();
    const watcher = manualWatcher();
    let cycles = 0;
    const controller = createWatchController({
      watcher,
      timer,
      debounceMs: 100,
      runCycle: async () => {
        cycles++;
        return { green: true, line: "x" };
      },
      print: () => {},
    });
    controller.stop();
    watcher.emit();
    expect(timer.pending()).toBe(false);
    await controller.idle();
    expect(cycles).toBe(0);
  });

  test("a crashing cycle is reported, not thrown", async () => {
    const timer = manualTimer();
    const watcher = manualWatcher();
    const printed: string[] = [];
    const controller = createWatchController({
      watcher,
      timer,
      debounceMs: 100,
      runCycle: async () => {
        throw new Error("boom");
      },
      print: (l) => printed.push(l),
    });
    watcher.emit();
    timer.flush();
    await controller.idle();
    expect(printed[0]).toContain("boom");
    controller.stop();
  });
});

describe("formatCycleLine", () => {
  test("green/red marker + timestamp + detail", () => {
    const at = new Date("2026-07-02T09:08:07");
    expect(formatCycleLine(true, "spec ok", at)).toBe("✓ [09:08:07] spec ok");
    expect(formatCycleLine(false, "compile ✗", at)).toBe("✗ [09:08:07] compile ✗");
  });
});
