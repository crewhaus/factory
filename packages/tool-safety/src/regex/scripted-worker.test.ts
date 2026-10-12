/**
 * The scripted regex worker the give-up and deadline tests run on (see
 * scriptWorkerClock): a cost lands on exactly the input it names, an input
 * scripted to hang holds its run until the deadline, and one scripted to
 * hold keeps its thread, through terminate(), until the test releases it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { restoreWorkerClock, scriptWorkerClock } from "./__test__/scripted-worker-clock";
import { REGEX_RUN_DEFAULTS, regexWorkerCounts, runRegex } from "./run";

// A body abandoned at its budget never reaches a finally of its own.
afterEach(restoreWorkerClock);

const GIVE_UP_MS = REGEX_RUN_DEFAULTS.giveUpMs;

/** Wait (bounded) for every regex worker to exit; only a hang reaches the bound. */
async function workersExited(budgetMs: number): Promise<{ live: number; runaway: number }> {
  const until = performance.now() + budgetMs;
  for (;;) {
    const counts = regexWorkerCounts();
    if ((counts.live === 0 && counts.runaway === 0) || performance.now() > until) return counts;
    await Bun.sleep(20);
  }
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
    // terminate() was called and cannot end an untimed wait: a hang would
    // let the thread go within one 10 ms wait, and only a broken hold can
    // exit here, whatever the wait.
    expect(await workersExited(500)).toEqual({ live: 1, runaway: 1 });
    scripted.release();
    expect(await workersExited(60_000)).toEqual({ live: 0, runaway: 0 });
    // It exited before "b".
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
