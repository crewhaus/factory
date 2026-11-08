import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { createTicker } from "../assets/js/ui/time.js";

function fakeScheduler() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    pending,
    schedule: (fn: () => void, ms: number) => {
      pending.push({ fn, ms });
      return pending.length;
    },
    cancel: (handle: number) => {
      pending[handle - 1] = { fn: () => {}, ms: -1 };
    },
    runNext: () => {
      const next = pending.find((p) => p.ms >= 0);
      if (next === undefined) return false;
      pending.splice(pending.indexOf(next), 1);
      next.fn();
      return true;
    },
  };
}

const node = () => ({ textContent: "", isConnected: true });

describe("the shared ticker", () => {
  test("refreshes every tracked time from its own clock", () => {
    let now = 0;
    const sched = fakeScheduler();
    const ticker = createTicker({
      now: () => now,
      schedule: sched.schedule,
      cancel: sched.cancel,
      intervalMs: 1000,
    });
    const a = node();
    ticker.track(a, "t0", (_iso: string, at: number) => `${at / 1000}s`);
    expect(ticker.running()).toBe(true);
    now = 5000;
    sched.runNext();
    expect(a.textContent).toBe("5s");
    now = 9000;
    sched.runNext();
    expect(a.textContent).toBe("9s");
  });

  test("does not tick while paused (a hidden tab, or reduced motion), and stops when told", () => {
    let paused = true;
    const sched = fakeScheduler();
    const ticker = createTicker({
      now: () => 1,
      schedule: sched.schedule,
      cancel: sched.cancel,
      paused: () => paused,
    });
    const a = node();
    ticker.track(a, "t", () => "ticked");
    expect(ticker.running()).toBe(false);
    expect(sched.pending).toHaveLength(0);
    paused = false;
    ticker.start();
    expect(ticker.running()).toBe(true);
    paused = true;
    sched.runNext();
    // The loop saw it was paused: no tick, and nothing more scheduled.
    expect(a.textContent).toBe("");
    expect(ticker.running()).toBe(false);
    paused = false;
    ticker.start();
    ticker.stop();
    expect(ticker.running()).toBe(false);
    expect(sched.runNext()).toBe(false);
  });

  test("forgets a time that left the page, and stops when none is left", () => {
    const sched = fakeScheduler();
    const ticker = createTicker({ now: () => 1, schedule: sched.schedule, cancel: sched.cancel });
    const gone = { textContent: "", isConnected: false };
    ticker.track(gone, "t", () => "x");
    sched.runNext();
    expect(ticker.size()).toBe(0);
    expect(ticker.running()).toBe(false);
  });
});
