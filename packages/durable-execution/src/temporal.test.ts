import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newGraphRunId } from "@crewhaus/checkpoint-store";
import {
  FileIdempotencyStore,
  type IdempotencyRecord,
  InMemoryIdempotencyStore,
  type WakeSchedule,
  armSchedule,
  createIdempotencyStore,
  idempotencyKey,
  nextCronMatch,
  nextWakeDelayMs,
  runOnce,
  withIdempotency,
} from "./index";

describe("nextCronMatch", () => {
  test("every 6 hours (UTC) rolls to the next 6h boundary", () => {
    const from = new Date("2026-07-17T01:23:45.000Z");
    const next = nextCronMatch("0 */6 * * *", from);
    expect(next.toISOString()).toBe("2026-07-17T06:00:00.000Z");
  });

  test("step minutes fire at the next multiple", () => {
    const from = new Date("2026-07-17T10:02:30.000Z");
    expect(nextCronMatch("*/5 * * * *", from).toISOString()).toBe("2026-07-17T10:05:00.000Z");
  });

  test("a specific minute+hour rolls to the next day when already past", () => {
    const from = new Date("2026-07-17T09:30:00.000Z");
    expect(nextCronMatch("0 9 * * *", from).toISOString()).toBe("2026-07-18T09:00:00.000Z");
  });

  test("day-of-week restriction (Mondays at 00:00 UTC)", () => {
    // 2026-07-17 is a Friday; the next Monday is 2026-07-20.
    const from = new Date("2026-07-17T12:00:00.000Z");
    const next = nextCronMatch("0 0 * * 1", from);
    expect(next.toISOString()).toBe("2026-07-20T00:00:00.000Z");
    expect(next.getUTCDay()).toBe(1);
  });

  test("day-of-week accepts named tokens and Sunday as 7", () => {
    const from = new Date("2026-07-17T12:00:00.000Z"); // Friday
    expect(nextCronMatch("0 0 * * SUN", from).toISOString()).toBe("2026-07-19T00:00:00.000Z");
    expect(nextCronMatch("0 0 * * 7", from).toISOString()).toBe("2026-07-19T00:00:00.000Z");
  });

  test("6-field cron honours the leading seconds field", () => {
    const from = new Date("2026-07-17T10:00:10.000Z");
    // seconds=30, every minute → next :30 second in the next minute.
    expect(nextCronMatch("30 * * * * *", from).toISOString()).toBe("2026-07-17T10:00:30.000Z");
  });

  test("timezone shifts the wall-clock evaluation", () => {
    // 09:00 America/New_York on 2026-07-17 (EDT, UTC-4) == 13:00Z.
    const from = new Date("2026-07-17T00:00:00.000Z");
    const next = nextCronMatch("0 9 * * *", from, "America/New_York");
    expect(next.toISOString()).toBe("2026-07-17T13:00:00.000Z");
  });

  test("day-of-month union with day-of-week (either matches)", () => {
    // "on the 1st OR on Mondays". From mid-Friday 2026-07-17, next is Mon 07-20.
    const from = new Date("2026-07-17T12:00:00.000Z");
    expect(nextCronMatch("0 0 1 * 1", from).toISOString()).toBe("2026-07-20T00:00:00.000Z");
  });

  test("Quartz L/W/# tokens fail open (treated as wildcard, never throw)", () => {
    const from = new Date("2026-07-17T10:00:00.000Z");
    // dom field "L" → wildcard → fires next midnight.
    expect(nextCronMatch("0 0 L * *", from).toISOString()).toBe("2026-07-18T00:00:00.000Z");
  });
});

describe("nextWakeDelayMs", () => {
  test("interval returns everyMs with no jitter", () => {
    const s: WakeSchedule = { kind: "interval", everyMs: 6 * 3_600_000 };
    expect(nextWakeDelayMs(s, 0)).toBe(6 * 3_600_000);
  });

  test("interval jitter is bounded to +/- jitterMs", () => {
    const s: WakeSchedule = { kind: "interval", everyMs: 10_000, jitterMs: 500 };
    expect(nextWakeDelayMs(s, 0, () => 1)).toBe(10_500); // rand=1 → +jitter
    expect(nextWakeDelayMs(s, 0, () => 0)).toBe(9_500); // rand=0 → -jitter
    expect(nextWakeDelayMs(s, 0, () => 0.5)).toBe(10_000); // rand=0.5 → no offset
  });

  test("never returns a negative delay", () => {
    const s: WakeSchedule = { kind: "interval", everyMs: 100, jitterMs: 10_000 };
    expect(nextWakeDelayMs(s, 0, () => 0)).toBe(0);
  });

  test("cron delay is the ms until the next match", () => {
    const s: WakeSchedule = { kind: "cron", cron: "0 */6 * * *" };
    const from = new Date("2026-07-17T05:00:00.000Z").getTime();
    expect(nextWakeDelayMs(s, from)).toBe(3_600_000); // one hour to 06:00Z
  });
});

describe("armSchedule", () => {
  test("fires onWake and re-arms with each tick's own delay", async () => {
    const delays: number[] = [];
    let fireNext: (() => void) | undefined;
    let wakes = 0;
    const armed = armSchedule(
      { kind: "interval", everyMs: 1000 },
      {
        onWake: () => {
          wakes += 1;
        },
        now: () => 0,
        setTimer: (fn, ms) => {
          delays.push(ms);
          fireNext = fn;
          return delays.length;
        },
        clearTimer: () => {},
      },
    );
    expect(delays).toEqual([1000]); // armed once immediately
    // Fire the first timer; onWake runs (async) then re-arms.
    fireNext?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(wakes).toBe(1);
    expect(delays).toEqual([1000, 1000]); // re-armed after the tick
    armed.cancel();
  });

  test("cancel clears the pending timer and stops re-arming", async () => {
    let cleared = 0;
    let fireNext: (() => void) | undefined;
    let wakes = 0;
    const armed = armSchedule(
      { kind: "interval", everyMs: 1000 },
      {
        onWake: () => {
          wakes += 1;
        },
        now: () => 0,
        setTimer: (fn) => {
          fireNext = fn;
          return "h";
        },
        clearTimer: () => {
          cleared += 1;
        },
      },
    );
    armed.cancel();
    expect(cleared).toBe(1);
    // A late timer fire after cancel must not run onWake.
    fireNext?.();
    await Promise.resolve();
    expect(wakes).toBe(0);
  });

  test("a throwing onWake is routed to onError and still re-arms", async () => {
    const errors: unknown[] = [];
    let fireNext: (() => void) | undefined;
    let arms = 0;
    const armed = armSchedule(
      { kind: "interval", everyMs: 1000 },
      {
        onWake: () => {
          throw new Error("boom");
        },
        onError: (e) => errors.push(e),
        now: () => 0,
        setTimer: (fn) => {
          arms += 1;
          fireNext = fn;
          return arms;
        },
        clearTimer: () => {},
      },
    );
    fireNext?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    expect(arms).toBe(2); // re-armed despite the throw
    armed.cancel();
  });
});

describe("FileIdempotencyStore + createIdempotencyStore", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "durable-idem-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("round-trips a record across separate store instances (crash-resume)", async () => {
    const grun = newGraphRunId();
    const dir = join(tmp, "run");
    const first = new FileIdempotencyStore(dir);
    const record: IdempotencyRecord = {
      key: idempotencyKey(grun, "step-a", 0),
      graphRunId: grun,
      nodeName: "step-a",
      attempt: 0,
      result: { text: "done" },
      completedAt: new Date(0).toISOString(),
    };
    await first.put(record);
    // A brand-new instance (fresh process) still finds it on disk.
    const second = new FileIdempotencyStore(dir);
    expect(await second.get(record.key)).toEqual(record);
  });

  test("get fails safe for an absent key", async () => {
    const store = new FileIdempotencyStore(join(tmp, "empty"));
    expect(await store.get("nope")).toBeUndefined();
  });

  test("withIdempotency over a file store dedups a replayed attempt", async () => {
    const grun = newGraphRunId();
    const dir = join(tmp, "wrap");
    let calls = 0;
    const inner = async (): Promise<{ n: number }> => {
      calls += 1;
      return { n: calls };
    };
    const a = await withIdempotency<{ n: number }>(inner, {
      store: new FileIdempotencyStore(dir),
    })(grun, "node", { n: 0 });
    // Simulate a crash-restart: a fresh wrapper + fresh store over the SAME dir.
    const b = await withIdempotency<{ n: number }>(inner, {
      store: new FileIdempotencyStore(dir),
    })(grun, "node", { n: 0 });
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 }); // cache hit — inner ran once total
    expect(calls).toBe(1);
  });

  test("factory: default is in-memory", () => {
    expect(createIdempotencyStore("spec", {})).toBeInstanceOf(InMemoryIdempotencyStore);
    expect(createIdempotencyStore("spec", { CREWHAUS_IDEMPOTENCY_STORE: "memory" })).toBeInstanceOf(
      InMemoryIdempotencyStore,
    );
  });

  test("factory: file:<dir> yields a spec-namespaced durable store", async () => {
    const store = createIdempotencyStore("my/spec name", {
      CREWHAUS_IDEMPOTENCY_STORE: `file:${tmp}`,
    });
    expect(store).toBeInstanceOf(FileIdempotencyStore);
    const grun = newGraphRunId();
    const rec: IdempotencyRecord = {
      key: idempotencyKey(grun, "n", 0),
      graphRunId: grun,
      nodeName: "n",
      attempt: 0,
      result: 1,
      completedAt: new Date(0).toISOString(),
    };
    await store.put(rec);
    // Persisted under a sanitized spec segment.
    const mirror = new FileIdempotencyStore(join(tmp, "my_spec_name"));
    expect(await mirror.get(rec.key)).toEqual(rec);
  });

  test("factory: an unknown value throws loudly", () => {
    expect(() => createIdempotencyStore("spec", { CREWHAUS_IDEMPOTENCY_STORE: "redis" })).toThrow(
      /unknown CREWHAUS_IDEMPOTENCY_STORE/,
    );
  });
});

describe("runOnce (linear/plain-string resume)", () => {
  test("runs fn once and caches by (runId, name, attempt)", async () => {
    const store = new InMemoryIdempotencyStore();
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls += 1;
      return `out-${calls}`;
    };
    const a = await runOnce(store, "wf_1", "draft", fn);
    const b = await runOnce(store, "wf_1", "draft", fn);
    expect(a).toBe("out-1");
    expect(b).toBe("out-1");
    expect(calls).toBe(1);
  });

  test("different steps and different runIds do not collide", async () => {
    const store = new InMemoryIdempotencyStore();
    const f = (v: string) => async () => v;
    expect(await runOnce(store, "wf_1", "a", f("A"))).toBe("A");
    expect(await runOnce(store, "wf_1", "b", f("B"))).toBe("B");
    expect(await runOnce(store, "wf_2", "a", f("A2"))).toBe("A2");
  });

  test("a fresh process (new store over the same dir + runId) resumes completed steps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "durable-runonce-"));
    try {
      let stepAcalls = 0;
      const stepA = async (): Promise<string> => {
        stepAcalls += 1;
        return "drafted";
      };
      // First "process": step A completes, then a crash before step B.
      await runOnce(new FileIdempotencyStore(dir), "wf_fixed", "A", stepA);
      // Restart: same runId, durable store — step A is skipped (cached).
      const resumed = await runOnce(new FileIdempotencyStore(dir), "wf_fixed", "A", stepA);
      expect(resumed).toBe("drafted");
      expect(stepAcalls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
