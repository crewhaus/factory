/**
 * The scripted regex worker the give-up and deadline tests run on (see
 * scriptWorkerClock): a cost lands on exactly the input it names, an input
 * scripted to hang holds its run until the deadline, and one scripted to
 * hold keeps its thread, through terminate(), until the test releases it,
 * also when the terminate() lands before the hold's wait has begun.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { restoreWorkerClock, scriptWorkerClock } from "./__test__/scripted-worker-clock";
import { REGEX_RUN_DEFAULTS, regexWorkerCounts, runRegex } from "./run";

/** Spies a test installed, restored after it. */
const spies: Array<{ mockRestore(): void }> = [];

// A body abandoned at its budget never reaches a finally of its own.
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  restoreWorkerClock();
});

const GIVE_UP_MS = REGEX_RUN_DEFAULTS.giveUpMs;

type Counts = { readonly live: number; readonly runaway: number };

/** Wait (bounded) until the regex worker counts are `want`; only a hang reaches the bound. */
async function workersAt(want: Counts, budgetMs: number): Promise<Counts> {
  const until = performance.now() + budgetMs;
  for (;;) {
    const counts = regexWorkerCounts();
    const there = counts.live === want.live && counts.runaway === want.runaway;
    if (there || performance.now() > until) return counts;
    await Bun.sleep(20);
  }
}

/** Wait (bounded) for every regex worker to exit; only a hang reaches the bound. */
function workersExited(budgetMs: number): Promise<Counts> {
  return workersAt({ live: 0, runaway: 0 }, budgetMs);
}

describe("the scripted worker", () => {
  // The inputs are written into the worker's source. A replacement string
  // expands $$, $&, $` and $' there: "$$" charged "$" instead, and the
  // others spliced worker source into the script, which then did not parse.
  test.each([
    ["$$", "$"],
    ["price $& tax", "price "],
    ["a$`b", "a"],
    ["a$'b", "b"],
    ["$1 and $<n>", "$1"],
  ])("%p is charged as written, and %p beside it is not", async (key, neighbour) => {
    scriptWorkerClock({ [key]: GIVE_UP_MS });
    const outcome = await runRegex({
      op: "testEach",
      pattern: "^z",
      inputs: [neighbour, key],
      onGiveUp: "skip",
      deadlineMs: 60_000,
    });
    expect(outcome).toMatchObject({
      status: "ok",
      result: { matched: [], undetermined: [1], scanned: 2 },
      elapsedMs: GIVE_UP_MS,
    });
  });

  test("an input scripted to hang holds its run to the deadline, and the thread then exits", async () => {
    // The exec never returns, so the deadline is the only way the run ends.
    scriptWorkerClock({}, ["stuck"]);
    const outcome = await runRegex({ op: "test", pattern: "z", input: "stuck", deadlineMs: 200 });
    expect(outcome.status).toBe("timeout");
    // terminate() ends the wait it is in.
    expect(await workersExited(60_000)).toEqual({ live: 0, runaway: 0 });
  }, 90_000);

  test("an input scripted to hold keeps its thread through terminate() until released, and it then runs nothing more", async () => {
    const scripted = scriptWorkerClock({}, [], ["held"]);
    const controller = new AbortController();
    const pending = runRegex({
      op: "testEach",
      pattern: "z",
      inputs: ["a", "held", "b", "c"],
      signal: controller.signal,
      deadlineMs: 60_000,
    });
    expect(await Promise.race([scripted.hung, pending.then((ended) => ({ ended }))])).toBe("held");
    // "a", then the held one; nothing after it yet.
    expect(scripted.execs()).toBe(2);
    controller.abort();
    expect(await pending).toMatchObject({ status: "error", code: "aborted" });
    // terminate() was called with the thread inside the held exec, so it was
    // put off: a hang would let the thread go within one 10 ms wait, and
    // only a broken hold can exit here, whatever the wait.
    expect(await workersExited(500)).toEqual({ live: 1, runaway: 1 });
    scripted.release();
    expect(await workersExited(60_000)).toEqual({ live: 0, runaway: 0 });
    // It exited before "b".
    expect(scripted.execs()).toBe(2);
  }, 90_000);

  test("a hold outlives a terminate() that lands before its wait has begun", async () => {
    // Stopped between announcing the hold and starting its wait, the thread
    // sits where one descheduled right after it posted does. A terminate()
    // that landed there was honoured at the wait loop's header, and the
    // thread exited, so the test above found none left (on CI, once in many
    // runs). Here it lands there every time.
    const scripted = scriptWorkerClock({}, [], ["held"], { pauseHolds: true });
    const controller = new AbortController();
    const pending = runRegex({
      op: "testEach",
      pattern: "z",
      inputs: ["a", "held", "b", "c"],
      signal: controller.signal,
      deadlineMs: 60_000,
    });
    expect(await Promise.race([scripted.hung, pending.then((ended) => ({ ended }))])).toBe("held");
    expect(scripted.execs()).toBe(2);
    controller.abort();
    expect(await pending).toMatchObject({ status: "error", code: "aborted" });
    // Only now does the thread go on, into its wait.
    scripted.resume();
    expect(await workersExited(500)).toEqual({ live: 1, runaway: 1 });
    scripted.release();
    expect(await workersExited(60_000)).toEqual({ live: 0, runaway: 0 });
    expect(scripted.execs()).toBe(2);
  }, 90_000);

  test("only a thread inside a held exec outlives terminate(); another worker's ends at once", async () => {
    const scripted = scriptWorkerClock({}, [], ["held"]);
    const controller = new AbortController();
    const pending = runRegex({
      op: "test",
      pattern: "z",
      input: "held",
      signal: controller.signal,
      deadlineMs: 60_000,
    });
    expect(await Promise.race([scripted.hung, pending.then((ended) => ({ ended }))])).toBe("held");
    controller.abort();
    expect(await pending).toMatchObject({ status: "error", code: "aborted" });
    // A run on a worker of its own, terminated once it has answered. Its
    // thread is not inside a held exec, so that terminate() goes through,
    // and only the held thread is left.
    const other = await runRegex({ op: "test", pattern: "a", input: "a", deadlineMs: 60_000 });
    expect(other).toMatchObject({ status: "ok", result: { matched: true } });
    expect(await workersAt({ live: 1, runaway: 1 }, 60_000)).toEqual({ live: 1, runaway: 1 });
    scripted.release();
    expect(await workersExited(60_000)).toEqual({ live: 0, runaway: 0 });
  }, 90_000);

  test("released, a put-off terminate() goes through before the thread is let go", async () => {
    // The real terminate() takes its time here. A thread let go before it
    // went through would run on past the held exec meanwhile, through "b"
    // and "c"; one still held cannot move.
    const realTerminate = Worker.prototype.terminate;
    const slowTerminate = spyOn(Worker.prototype, "terminate").mockImplementation(function (
      this: Worker,
    ) {
      Bun.sleepSync(200);
      realTerminate.call(this);
    });
    spies.push(slowTerminate);
    const scripted = scriptWorkerClock({}, [], ["held"]);
    const controller = new AbortController();
    const pending = runRegex({
      op: "testEach",
      pattern: "z",
      inputs: ["a", "held", "b", "c"],
      signal: controller.signal,
      deadlineMs: 60_000,
    });
    expect(await Promise.race([scripted.hung, pending.then((ended) => ({ ended }))])).toBe("held");
    controller.abort();
    expect(await pending).toMatchObject({ status: "error", code: "aborted" });
    // Put off: the real one has not been called yet.
    expect(slowTerminate).toHaveBeenCalledTimes(0);
    scripted.release();
    expect(slowTerminate).toHaveBeenCalledTimes(1);
    expect(await workersExited(60_000)).toEqual({ live: 0, runaway: 0 });
    expect(scripted.execs()).toBe(2);
  }, 90_000);

  test("released, a held exec gives the engine's own answer to a run still waiting for it", async () => {
    const scripted = scriptWorkerClock({}, [], ["held x"]);
    const pending = runRegex({ op: "test", pattern: "x$", input: "held x", deadlineMs: 60_000 });
    expect(await Promise.race([scripted.hung, pending.then((ended) => ({ ended }))])).toBe(
      "held x",
    );
    scripted.release();
    expect(await pending).toMatchObject({ status: "ok", result: { matched: true } });
    expect(scripted.execs()).toBe(1);
    expect(await workersExited(60_000)).toEqual({ live: 0, runaway: 0 });
  }, 90_000);
});
