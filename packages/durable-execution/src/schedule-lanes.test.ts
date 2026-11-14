/**
 * `armScheduleLanes` (#514): one wake loop per named lane, each on its own
 * clock. Driven by a fake timer queue; nothing here waits on the wall clock.
 */
import { describe, expect, test } from "bun:test";
import { type WakeScheduleLane, armScheduleLanes } from "./index";

type Pending = { readonly id: number; readonly at: number; readonly fn: () => void };

/** A fake clock and timer queue: `advanceTo` fires due timers in time order. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  let pending: Pending[] = [];
  const counts = { set: 0, clear: 0 };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    counts,
    now: () => now,
    pending: () => pending.length,
    setTimer: (fn: () => void, ms: number): unknown => {
      counts.set += 1;
      const id = nextId++;
      pending.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      counts.clear += 1;
      pending = pending.filter((p) => p.id !== handle);
    },
    async advanceTo(t: number): Promise<void> {
      await flush();
      for (;;) {
        const due = pending.filter((p) => p.at <= t).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (due === undefined) break;
        pending = pending.filter((p) => p.id !== due.id);
        now = due.at;
        due.fn();
        await flush();
      }
      now = t;
    },
  };
}

const A_B: ReadonlyArray<WakeScheduleLane> = [
  { name: "a", kind: "interval", everyMs: 1000 },
  { name: "b", kind: "interval", everyMs: 3000 },
];

describe("armScheduleLanes", () => {
  test("each lane wakes on its own cadence", async () => {
    const t = fakeTimers();
    const wakes: Record<string, number> = { a: 0, b: 0 };
    armScheduleLanes(A_B, {
      onWake: (name) => {
        wakes[name] = (wakes[name] ?? 0) + 1;
      },
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    await t.advanceTo(6000);
    expect(wakes).toEqual({ a: 6, b: 2 });
  });

  test("a lane held in its wake never holds up another, and re-arms only once released", async () => {
    const t = fakeTimers();
    const wakes: Record<string, number> = { a: 0, b: 0 };
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    armScheduleLanes(A_B, {
      onWake: async (name) => {
        wakes[name] = (wakes[name] ?? 0) + 1;
        if (name === "a" && wakes[name] === 1) await held;
      },
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    await t.advanceTo(6000);
    expect(wakes).toEqual({ a: 1, b: 2 });
    // Only b's next timer is pending: a has not re-armed.
    expect(t.pending()).toBe(1);
    release();
    await t.advanceTo(6000);
    expect(t.pending()).toBe(2);
    await t.advanceTo(7000);
    expect(wakes).toEqual({ a: 2, b: 2 });
  });

  test("a throwing wake reaches onError with its lane's name, and the lane re-arms", async () => {
    const t = fakeTimers();
    const errors: Array<readonly [string, string]> = [];
    let aWakes = 0;
    armScheduleLanes(A_B, {
      onWake: (name) => {
        if (name === "a") {
          aWakes += 1;
          throw new Error(`boom ${aWakes}`);
        }
      },
      onError: (err, name) => errors.push([name, (err as Error).message]),
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    await t.advanceTo(2000);
    expect(errors).toEqual([
      ["a", "boom 1"],
      ["a", "boom 2"],
    ]);
    expect(aWakes).toBe(2);
  });

  test("cancel() clears every pending timer, once", async () => {
    const t = fakeTimers();
    let wakes = 0;
    const armed = armScheduleLanes(A_B, {
      onWake: () => {
        wakes += 1;
      },
      now: t.now,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    expect(t.pending()).toBe(2);
    armed.cancel();
    expect(t.counts.clear).toBe(2);
    expect(t.pending()).toBe(0);
    armed.cancel();
    expect(t.counts.clear).toBe(2);
    await t.advanceTo(10_000);
    expect(wakes).toBe(0);
  });

  const refused: ReadonlyArray<readonly [string, ReadonlyArray<WakeScheduleLane>, RegExp]> = [
    ["zero lanes", [], /at least one lane/],
    [
      "nine lanes",
      Array.from({ length: 9 }, (_, i) => ({
        name: `l${i}`,
        kind: "interval" as const,
        everyMs: 1000,
      })),
      /at most 8 lanes/,
    ],
    [
      "a repeated name",
      [
        { name: "a", kind: "interval", everyMs: 1000 },
        { name: "a", kind: "interval", everyMs: 2000 },
      ],
      /"a" is used twice/,
    ],
    ["an empty name", [{ name: "", kind: "interval", everyMs: 1000 }], /non-empty name/],
  ];
  for (const [label, lanes, message] of refused) {
    test(`${label} throws a TypeError before any timer is set`, () => {
      const t = fakeTimers();
      expect(() =>
        armScheduleLanes(lanes, {
          onWake: () => {},
          now: t.now,
          setTimer: t.setTimer,
          clearTimer: t.clearTimer,
        }),
      ).toThrow(TypeError);
      expect(() => armScheduleLanes(lanes, { onWake: () => {}, setTimer: t.setTimer })).toThrow(
        message,
      );
      expect(t.counts.set).toBe(0);
    });
  }
});
