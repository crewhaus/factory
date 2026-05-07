import { describe, expect, test } from "bun:test";
import { createStore } from "./index";

describe("createStore — basic semantics", () => {
  test("get() returns the initial state", () => {
    const s = createStore({ a: 1, b: "x" });
    expect(s.get()).toEqual({ a: 1, b: "x" });
  });

  test("set(partial) shallow-merges and updates get()", () => {
    const s = createStore({ a: 1, b: "x" });
    s.set({ a: 2 });
    expect(s.get()).toEqual({ a: 2, b: "x" });
    s.set({ b: "y" });
    expect(s.get()).toEqual({ a: 2, b: "y" });
  });

  test("set accepts a functional updater that receives current state", () => {
    const s = createStore({ count: 0 });
    s.set((curr) => ({ count: curr.count + 1 }));
    s.set((curr) => ({ count: curr.count + 1 }));
    expect(s.get().count).toBe(2);
  });

  test("subscribe fires on each set with (next, prev)", () => {
    const s = createStore({ a: 1 });
    const calls: Array<{ next: { a: number }; prev: { a: number } }> = [];
    s.subscribe((next, prev) => {
      calls.push({ next, prev });
    });
    s.set({ a: 2 });
    s.set({ a: 3 });
    expect(calls.length).toBe(2);
    expect(calls[0]?.prev.a).toBe(1);
    expect(calls[0]?.next.a).toBe(2);
    expect(calls[1]?.prev.a).toBe(2);
    expect(calls[1]?.next.a).toBe(3);
  });

  test("unsubscribe stops further notifications", () => {
    const s = createStore({ a: 0 });
    let count = 0;
    const unsub = s.subscribe(() => {
      count += 1;
    });
    s.set({ a: 1 });
    unsub();
    s.set({ a: 2 });
    s.set({ a: 3 });
    expect(count).toBe(1);
  });

  test("multiple subscribers each receive every change", () => {
    const s = createStore({ a: 0 });
    let n1 = 0;
    let n2 = 0;
    s.subscribe(() => {
      n1 += 1;
    });
    s.subscribe(() => {
      n2 += 1;
    });
    s.set({ a: 1 });
    s.set({ a: 2 });
    expect(n1).toBe(2);
    expect(n2).toBe(2);
  });

  test("a throwing subscriber does not block sibling subscribers", () => {
    const s = createStore({ a: 0 });
    const originalError = console.error;
    const errs: unknown[] = [];
    console.error = (...args: unknown[]) => {
      errs.push(args);
    };
    try {
      s.subscribe(() => {
        throw new Error("boom");
      });
      let saw = 0;
      s.subscribe(() => {
        saw += 1;
      });
      s.set({ a: 1 });
      expect(saw).toBe(1);
      expect(errs.length).toBe(1);
    } finally {
      console.error = originalError;
    }
  });
});

describe("createStore — selectors", () => {
  type State = { a: number; b: string; nested: { x: number } };

  test("select(s => s.a).get() returns the current projected value", () => {
    const s = createStore<State>({ a: 1, b: "x", nested: { x: 10 } });
    const view = s.select((curr) => curr.a);
    expect(view.get()).toBe(1);
    s.set({ a: 5 });
    expect(view.get()).toBe(5);
  });

  test("selector subscriber fires only when projection changes (Object.is)", () => {
    const s = createStore<State>({ a: 1, b: "x", nested: { x: 10 } });
    const view = s.select((curr) => curr.a);
    let fires = 0;
    view.subscribe(() => {
      fires += 1;
    });
    s.set({ b: "y" }); // does not change a
    s.set({ b: "z" }); // does not change a
    expect(fires).toBe(0);
    s.set({ a: 2 }); // changes a
    expect(fires).toBe(1);
    s.set({ a: 2 }); // re-set to same value — Object.is true → no fire
    expect(fires).toBe(1);
    s.set({ a: 3 });
    expect(fires).toBe(2);
  });

  test("selector receives the projected (next, prev), not the root state", () => {
    const s = createStore<State>({ a: 1, b: "x", nested: { x: 10 } });
    const view = s.select((curr) => curr.a);
    const calls: Array<{ next: number; prev: number }> = [];
    view.subscribe((next, prev) => {
      calls.push({ next, prev });
    });
    s.set({ a: 7 });
    s.set({ a: 9 });
    expect(calls).toEqual([
      { next: 7, prev: 1 },
      { next: 9, prev: 7 },
    ]);
  });

  test("selectors over object projections compare by reference (Object.is)", () => {
    const s = createStore<State>({ a: 1, b: "x", nested: { x: 10 } });
    const view = s.select((curr) => curr.nested);
    let fires = 0;
    view.subscribe(() => {
      fires += 1;
    });
    s.set({ a: 2 }); // nested ref unchanged
    expect(fires).toBe(0);
    s.set({ nested: { x: 11 } }); // nested ref changed (new object literal)
    expect(fires).toBe(1);
  });

  test("unsubscribing the selector view stops further fires", () => {
    const s = createStore<State>({ a: 1, b: "x", nested: { x: 10 } });
    const view = s.select((curr) => curr.a);
    let fires = 0;
    const unsub = view.subscribe(() => {
      fires += 1;
    });
    s.set({ a: 2 });
    unsub();
    s.set({ a: 3 });
    s.set({ a: 4 });
    expect(fires).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T9 — property tests
// ---------------------------------------------------------------------------
//
// Hand-rolled randomized testing (no fast-check dep) following the pattern in
// `tool-orchestrator/src/index.test.ts`. Seeded so failures reproduce.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("createStore — T9 property", () => {
  test("100 random sequences: model state matches store state", () => {
    const rand = mulberry32(0xc0ffee);
    const KEYS = ["a", "b", "c", "d"] as const;
    type Key = (typeof KEYS)[number];
    type S = Record<Key, number>;

    for (let iter = 0; iter < 100; iter++) {
      const initial: S = { a: 0, b: 0, c: 0, d: 0 };
      const store = createStore<S>({ ...initial });
      const model: S = { ...initial };

      const opCount = 5 + Math.floor(rand() * 25);
      for (let op = 0; op < opCount; op++) {
        const key = KEYS[Math.floor(rand() * KEYS.length)] as Key;
        const value = Math.floor(rand() * 10);
        store.set({ [key]: value } as Partial<S>);
        model[key] = value;
      }

      expect(store.get()).toEqual(model);
    }
  });

  test("100 random sequences: selector fires == count of distinct projections", () => {
    const rand = mulberry32(0xb16b00b5);
    const KEYS = ["a", "b", "c"] as const;
    type Key = (typeof KEYS)[number];
    type S = Record<Key, number>;

    for (let iter = 0; iter < 100; iter++) {
      const store = createStore<S>({ a: 0, b: 0, c: 0 });
      const view = store.select((s) => s.a);

      let fires = 0;
      view.subscribe(() => {
        fires += 1;
      });

      let prevA = 0;
      let expectedFires = 0;
      const opCount = 5 + Math.floor(rand() * 30);
      for (let op = 0; op < opCount; op++) {
        const key = KEYS[Math.floor(rand() * KEYS.length)] as Key;
        const value = Math.floor(rand() * 5);
        store.set({ [key]: value } as Partial<S>);
        if (key === "a") {
          if (!Object.is(value, prevA)) {
            expectedFires += 1;
          }
          prevA = value;
        }
        // mutating any other key never bumps expectedFires
      }
      expect(fires).toBe(expectedFires);
    }
  });
});
