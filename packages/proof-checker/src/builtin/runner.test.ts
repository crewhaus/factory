import { describe, expect, spyOn, test } from "bun:test";
import { withScriptedWorker } from "../test-helpers";
import type { CheckResult } from "../types";
import { BUILTIN_LIMITS } from "./budget";
import { type BuiltinVerdict, checkCertificate } from "./checker";
import {
  WORKER_GRACE_MS,
  builtinCheckerCounts,
  createBuiltinChecker,
  stoppedWithoutVerdict,
} from "./runner";

/**
 * The builtin runner: every check on a worker thread of its own, inside its
 * deadline (design §18, "checkers bounded by timeout_ms").
 *
 * The first block runs real workers. It never times how fast a check is,
 * only what happens in what order, so a slow machine cannot fail it. The
 * rest script the worker (test-helpers' `withScriptedWorker`) to reach the
 * paths a real one seldom takes: one that never answers, a busy pool, a
 * runtime with no worker at all.
 */

/**
 * Holds a core until any deadline it is given (10 000 cases of 8 000-bit
 * rationals take some 10 s): the statement that held a harness's thread for
 * 10 s per check, and a turn of three checks for 30 s.
 */
const WORST = "let a = 3^2500 / 7^1100 in forall i in 0..9999: a * a / (a + i) > -1";

const nextMacrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The verdict a result carries, without what the runner adds to it. */
function verdictOf(result: CheckResult): BuiltinVerdict {
  const { checker: _checker, durationMs: _durationMs, ...verdict } = result;
  return verdict;
}

describe("a check runs on its own worker thread", () => {
  test("timers fire while a worst-case check runs: the caller's thread stays free", async () => {
    const events: string[] = [];
    const pending = createBuiltinChecker()
      .check({ claim: "c", statement: WORST, proof: "eval", timeoutMs: 1_000 })
      .then((result) => {
        events.push("checked");
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    events.push("timer");
    const result = await pending;
    // On the caller's thread the whole check ran inside check(), before any
    // timer could fire.
    expect(events).toEqual(["timer", "checked"]);
    expect(result.reason).toMatch(/ran out of time/);
    expect(builtinCheckerCounts()).toMatchObject({ running: 0, waiting: 0 });
  }, 20_000);

  test("an abort ends a running check at once: the worker is terminated, not waited for", async () => {
    const ac = new AbortController();
    const pending = createBuiltinChecker().check({
      claim: "c",
      statement: WORST,
      proof: "eval",
      timeoutMs: BUILTIN_LIMITS.maxTimeoutMs,
      signal: ac.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    ac.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("the check was cancelled");
    // An abort cannot reach a thread busy with the check: there, it was seen
    // only once the whole budget was spent.
    expect(result.durationMs).toBeLessThan(BUILTIN_LIMITS.maxTimeoutMs);
    expect(builtinCheckerCounts()).toMatchObject({ running: 0, waiting: 0 });
  }, 20_000);

  test("the verdict crosses from the worker intact: assumptions, counterexample, trace", async () => {
    const proof = JSON.stringify([
      { id: "g1", stmt: "x = 3", by: "given" },
      { id: "g2", stmt: "x = 3 -> y = 2*x + 1", by: "given" },
      { id: "m", stmt: "y = 2*x + 1", by: "mp", from: ["g1", "g2"] },
      { id: "s", stmt: "y = 2*3 + 1", by: "subst", from: ["g1", "m"] },
      { id: "a", stmt: "2*3 + 1 = 7", by: "arith" },
      { id: "done", stmt: "y = 7", by: "subst", from: ["a", "s"] },
    ]);
    const overlap =
      "let s = [9, 10.5, 12], e = [10, 13, 13] in forall i in 0..2: forall j in 0..2: i = j or e[i] <= s[j] or e[j] <= s[i]";
    const checker = createBuiltinChecker();
    const inProcess = builtinCheckerCounts().inProcess;
    for (const [statement, text] of [
      ["y = 7", proof],
      [overlap, "eval"],
      ["1 = 1", "[{}]"],
    ] as const) {
      const result = await checker.check({ claim: "c", statement, proof: text });
      expect(result.checker).toBe("builtin");
      expect(verdictOf(result)).toEqual(checkCertificate({ statement, proof: text }));
    }
    const proved = await checker.check({ claim: "c", statement: "y = 7", proof });
    expect(proved.assumptions).toEqual(["x = 3", "x = 3 -> y = 2 * x + 1"]);
    const refuted = await checker.check({ claim: "c", statement: overlap, proof: "eval" });
    expect(refuted.counterexample).toMatch(/^i = 1, j = 2:/);
    // Every one of them crossed: none ran on this thread.
    expect(builtinCheckerCounts().inProcess).toBe(inProcess);
  }, 20_000);
});

describe("the deadline holds whatever the worker does", () => {
  test("a worker that never answers is terminated at the deadline plus the grace", async () => {
    await withScriptedWorker({}, async (workers) => {
      // The backstop's delay is recorded and the timer fired at once, so the
      // test waits for nothing.
      const realSetTimeout = globalThis.setTimeout;
      const delays: number[] = [];
      const clock = spyOn(globalThis, "setTimeout").mockImplementation(((
        fn: () => void,
        ms?: number,
      ) => {
        delays.push(ms ?? 0);
        return realSetTimeout(fn, 0);
      }) as unknown as typeof setTimeout);
      let result: CheckResult;
      try {
        result = await createBuiltinChecker().check({
          claim: "c",
          statement: "1 = 1",
          proof: "eval",
          timeoutMs: 3_000,
        });
      } finally {
        clock.mockRestore();
      }
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/ran out of time/);
      expect(delays).toHaveLength(1);
      expect(delays[0]).toBeGreaterThan(WORKER_GRACE_MS);
      expect(delays[0]).toBeLessThanOrEqual(3_000 + WORKER_GRACE_MS);
      expect(workers.jobs[0]?.timeoutMs).toBeLessThanOrEqual(3_000);
      expect(workers.terminated()).toBe(1);
    });
  });

  test("a budget past maxTimeoutMs is capped before the worker sees it", async () => {
    const verdict = checkCertificate({ statement: "1 = 1", proof: "eval" });
    await withScriptedWorker(
      { reply: () => ({ post: { kind: "verdict", verdict } }) },
      async (workers) => {
        const r = await createBuiltinChecker({ timeoutMs: 30_000 }).check({
          claim: "c",
          statement: "1 = 1",
          proof: "eval",
          timeoutMs: 60_000,
        });
        expect(r.ok).toBe(true);
        expect(workers.jobs[0]?.timeoutMs).toBeLessThanOrEqual(BUILTIN_LIMITS.maxTimeoutMs);
        expect(workers.jobs[0]?.timeoutMs).toBeGreaterThan(BUILTIN_LIMITS.maxTimeoutMs - 1_000);
      },
    );
  });

  test("an aborted signal never starts a worker", async () => {
    await withScriptedWorker({}, async (workers) => {
      const ac = new AbortController();
      ac.abort();
      const r = await createBuiltinChecker().check({
        claim: "c",
        statement: "1 = 1",
        proof: "eval",
        signal: ac.signal,
      });
      expect(r.reason).toBe("the check was cancelled");
      expect(workers.spawned()).toBe(0);
    });
  });
});

describe("at most maxConcurrentChecks workers run at once", () => {
  const cap = BUILTIN_LIMITS.maxConcurrentChecks;
  const busy = (signal: AbortSignal, timeoutMs = 10_000) =>
    createBuiltinChecker().check({
      claim: "c",
      statement: "1 = 1",
      proof: "eval",
      timeoutMs,
      signal,
    });

  test("the next check waits for a free thread, and gets the first one freed", async () => {
    await withScriptedWorker({}, async (workers) => {
      const controllers = Array.from({ length: cap + 2 }, () => new AbortController());
      const pending = controllers.map((ac) => busy(ac.signal));
      await nextMacrotask();
      expect(builtinCheckerCounts()).toMatchObject({ running: cap, waiting: 2 });
      expect(workers.spawned()).toBe(cap);
      // A running check ends: its thread goes to the first in line.
      controllers[0]?.abort();
      await nextMacrotask();
      expect(builtinCheckerCounts()).toMatchObject({ running: cap, waiting: 1 });
      expect(workers.spawned()).toBe(cap + 1);
      // A waiting check is aborted: it leaves the line without a thread.
      controllers[cap + 1]?.abort();
      await nextMacrotask();
      expect(builtinCheckerCounts()).toMatchObject({ running: cap, waiting: 0 });
      for (const ac of controllers) ac.abort();
      const results = await Promise.all(pending);
      expect(results.map((r) => r.reason)).toEqual(
        Array.from({ length: cap + 2 }, () => "the check was cancelled"),
      );
      expect(builtinCheckerCounts()).toMatchObject({ running: 0, waiting: 0 });
      expect(workers.spawned()).toBe(cap + 1);
      expect(workers.terminated()).toBe(cap + 1);
    });
  });

  test("a check that waits past its deadline is refused without running", async () => {
    await withScriptedWorker({}, async (workers) => {
      const controllers = Array.from({ length: cap }, () => new AbortController());
      const pending = controllers.map((ac) => busy(ac.signal));
      const late = await busy(new AbortController().signal, 0);
      expect(late.ok).toBe(false);
      expect(late.reason).toMatch(/waiting for a free checker thread .* nothing was checked/);
      expect(workers.spawned()).toBe(cap);
      for (const ac of controllers) ac.abort();
      await Promise.all(pending);
      expect(builtinCheckerCounts()).toMatchObject({ running: 0, waiting: 0 });
    });
  });
});

describe("where no worker can start, the check runs on the caller's thread", () => {
  const check = () =>
    createBuiltinChecker().check({
      claim: "c",
      statement: "exists k in 0..3: 2*k + 1 = 3",
      proof: "eval",
    });

  test("a runtime with no Worker", async () => {
    const globals = globalThis as Record<string, unknown>;
    const real = globals["Worker"];
    const before = builtinCheckerCounts().inProcess;
    globals["Worker"] = undefined;
    try {
      expect((await check()).ok).toBe(true);
    } finally {
      globals["Worker"] = real;
    }
    expect(builtinCheckerCounts().inProcess).toBe(before + 1);
  });

  test("a Worker that refuses to construct, or fails before it is ready", async () => {
    for (const start of ["throw", { error: "blob URLs are not allowed" }] as const) {
      const before = builtinCheckerCounts().inProcess;
      await withScriptedWorker({ start }, async () => {
        expect((await check()).ok).toBe(true);
      });
      expect(builtinCheckerCounts().inProcess).toBe(before + 1);
    }
  });

  test("a worker that fails mid-check has rejected the proof; the check is not run again here", async () => {
    for (const reply of [
      () => ({ error: "out of memory" }),
      () => ({ post: { kind: "verdict", verdict: { ok: true } } }),
    ]) {
      const before = builtinCheckerCounts().inProcess;
      await withScriptedWorker({ reply }, async () => {
        const r = await check();
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/^internal checker error: /);
      });
      expect(builtinCheckerCounts().inProcess).toBe(before);
    }
  });
});

describe("stoppedWithoutVerdict: a stop is not a rejection", () => {
  test("an abort and a deadline stop; a refuted statement and an accepted proof do not", async () => {
    const checker = createBuiltinChecker();
    const stop = new AbortController();
    stop.abort();
    const cancelled = await checker.check({
      claim: "c",
      statement: "1 < 2",
      proof: "eval",
      signal: stop.signal,
    });
    expect(stoppedWithoutVerdict(cancelled)).toBe(true);
    const timedOut = await checker.check({
      claim: "c",
      statement: WORST,
      proof: "eval",
      timeoutMs: 50,
    });
    expect([timedOut.ok, stoppedWithoutVerdict(timedOut)]).toEqual([false, true]);
    const refuted = await checker.check({ claim: "c", statement: "2 < 1", proof: "eval" });
    expect([refuted.ok, stoppedWithoutVerdict(refuted)]).toEqual([false, false]);
    const proved = await checker.check({ claim: "c", statement: "1 < 2", proof: "eval" });
    expect([proved.ok, stoppedWithoutVerdict(proved)]).toEqual([true, false]);
  }, 20_000);
});
