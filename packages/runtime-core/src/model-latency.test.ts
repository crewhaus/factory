/**
 * 0.6.0 §7.9 — the span-union tracker behind `modelLatencyMs`. Fake clock
 * throughout: the semantics under test are the UNION of overlapping tool
 * spans (never their sum) and the non-negative clamp, not wall time.
 */
import { describe, expect, test } from "bun:test";
import { createSpanUnionTracker, modelLatencyMs } from "./model-latency";

function fakeClock(): { now: () => number; set: (t: number) => void } {
  let t = 0;
  return {
    now: () => t,
    set: (next) => {
      t = next;
    },
  };
}

describe("createSpanUnionTracker", () => {
  test("a single span counts its own length", () => {
    const clock = fakeClock();
    const tracker = createSpanUnionTracker(clock.now);
    clock.set(10);
    tracker.enter();
    clock.set(40);
    tracker.exit();
    expect(tracker.busyMs()).toBe(30);
  });

  test("overlapping spans count the UNION, not the sum (concurrent tools)", () => {
    const clock = fakeClock();
    const tracker = createSpanUnionTracker(clock.now);
    clock.set(0);
    tracker.enter(); // tool A: 0 → 100
    clock.set(20);
    tracker.enter(); // tool B: 20 → 60 (fully inside A)
    clock.set(60);
    tracker.exit(); // B done — still busy (A open)
    expect(tracker.busyMs()).toBe(60); // live stretch so far
    clock.set(100);
    tracker.exit(); // A done
    expect(tracker.busyMs()).toBe(100); // sum would have been 140
  });

  test("disjoint spans add up; an idle gap between them is model time", () => {
    const clock = fakeClock();
    const tracker = createSpanUnionTracker(clock.now);
    clock.set(0);
    tracker.enter();
    clock.set(10);
    tracker.exit();
    clock.set(50);
    tracker.enter();
    clock.set(70);
    tracker.exit();
    expect(tracker.busyMs()).toBe(30);
  });

  test("an unmatched exit is tolerated and never goes negative", () => {
    const clock = fakeClock();
    const tracker = createSpanUnionTracker(clock.now);
    tracker.exit();
    expect(tracker.busyMs()).toBe(0);
    clock.set(5);
    tracker.enter();
    clock.set(9);
    tracker.exit();
    tracker.exit();
    expect(tracker.busyMs()).toBe(4);
  });

  test("busyMs() while a span is still open includes the in-progress stretch", () => {
    const clock = fakeClock();
    const tracker = createSpanUnionTracker(clock.now);
    clock.set(100);
    tracker.enter();
    clock.set(130);
    expect(tracker.busyMs()).toBe(30);
  });

  test("defaults to performance.now when no clock is injected", () => {
    const tracker = createSpanUnionTracker();
    tracker.enter();
    tracker.exit();
    expect(tracker.busyMs()).toBeGreaterThanOrEqual(0);
  });
});

describe("modelLatencyMs", () => {
  test("wall minus tool-busy union", () => {
    expect(modelLatencyMs(1000, 1500, 200)).toBe(300);
  });

  test("no tools → the wall span (the pre-0.6.0 value)", () => {
    expect(modelLatencyMs(1000, 1500, 0)).toBe(500);
  });

  test("clamped at zero — a tool span can never read as negative model latency", () => {
    expect(modelLatencyMs(1000, 1500, 900)).toBe(0);
    expect(modelLatencyMs(1000, 1500, -50)).toBe(500);
  });
});
