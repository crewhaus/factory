/**
 * The scripted regex worker the give-up and deadline tests run on (see
 * scriptWorkerClock): a cost lands on exactly the input it names, and an
 * input scripted to hang holds its run until the deadline.
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
});
