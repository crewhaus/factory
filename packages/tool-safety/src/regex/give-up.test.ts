/**
 * Where the regex worker draws the line between "no match" and "the engine
 * gave up", told on a scripted worker clock.
 *
 * The worker cannot see JavaScriptCore give up: the engine returns null, as
 * a real no-match does. Only the time tells them apart, so a null that took
 * giveUpMs or longer is reported as `gave-up`. These tests hold every input
 * at an exact cost on the worker's clock (see scriptWorkerClock), so the
 * boundary is checked to the millisecond, and no stall or engine speed can
 * move it. The deadlines only stop a hang.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { restoreWorkerClock, scriptWorkerClock } from "./__test__/scripted-worker-clock";
import { REGEX_RUN_DEFAULTS, openRegexSession, runRegex } from "./run";

// A body abandoned at its budget never reaches a finally of its own.
afterEach(restoreWorkerClock);

const GIVE_UP_MS = REGEX_RUN_DEFAULTS.giveUpMs;

/** A no-match for every pattern below that the worker's clock says took exactly giveUpMs. */
const AT = "took giveUpMs";
/** The same, one millisecond quicker. */
const UNDER = "took one ms less";

describe("the give-up threshold", () => {
  test("a no-match is undetermined from exactly giveUpMs, and definite below it", async () => {
    scriptWorkerClock({ [AT]: GIVE_UP_MS, [UNDER]: GIVE_UP_MS - 1 });
    const session = openRegexSession();
    try {
      const run = (input: string, giveUpMs?: number) =>
        session.run({ op: "test", pattern: "z", input, giveUpMs, deadlineMs: 60_000 });
      expect(await run(AT)).toMatchObject({ status: "gave-up", execMs: GIVE_UP_MS });
      expect(await run(UNDER)).toMatchObject({ status: "ok", result: { matched: false } });
      // A request's own threshold is the one the worker uses.
      expect(await run(UNDER, GIVE_UP_MS - 1)).toMatchObject({
        status: "gave-up",
        execMs: GIVE_UP_MS - 1,
      });
      expect(await run(AT, GIVE_UP_MS + 1)).toMatchObject({
        status: "ok",
        result: { matched: false },
      });
      // A match is a match however long it took.
      expect(
        await session.run({ op: "test", pattern: "took", input: AT, deadlineMs: 60_000 }),
      ).toMatchObject({ status: "ok", result: { matched: true } });
    } finally {
      session.close();
    }
  });

  test("testEach: a group that took giveUpMs has each no-match run again alone", async () => {
    scriptWorkerClock({ [AT]: GIVE_UP_MS, [UNDER]: GIVE_UP_MS - 1 });
    // Groups of one, then two: the second holds a quick no-match and the
    // timed one.
    const slowGroup = await runRegex({
      op: "testEach",
      pattern: "\\s+$",
      inputs: ["hit  ", "quick", AT],
      onGiveUp: "skip",
      deadlineMs: 60_000,
    });
    expect(slowGroup).toMatchObject({
      status: "ok",
      result: { matched: [0], undetermined: [2], scanned: 3 },
      // AT ran in its group and then alone; "quick" took no time either way.
      elapsedMs: 2 * GIVE_UP_MS,
    });
    // A group quicker than giveUpMs holds no input that took that long, so
    // its no-matches are trusted without a second run.
    const quickGroup = await runRegex({
      op: "testEach",
      pattern: "\\s+$",
      inputs: ["hit  ", "quick", UNDER],
      onGiveUp: "skip",
      deadlineMs: 60_000,
    });
    expect(quickGroup).toMatchObject({
      status: "ok",
      result: { matched: [0], undetermined: [], scanned: 3 },
      elapsedMs: GIVE_UP_MS - 1,
    });
  });
});

describe("every op reports a give-up, never an answer built on the engine's null", () => {
  // "a.a" and "q" are quick; SLOW is not. Each op's matches before the
  // give-up are real, and are kept where the op reports partial answers.
  const SLOW = "a.a, slow";

  test("matchAll, replace and split", async () => {
    scriptWorkerClock({ [SLOW]: GIVE_UP_MS });
    const session = openRegexSession();
    try {
      // Every exec over SLOW is charged; the two that match still match.
      const all = await session.run({
        op: "matchAll",
        pattern: "a\\b",
        input: SLOW,
        deadlineMs: 60_000,
      });
      expect(all).toMatchObject({
        status: "gave-up",
        partial: {
          matches: [
            { match: "a", index: 0 },
            { match: "a", index: 2 },
          ],
          truncated: false,
        },
      });
      for (const flags of ["g", ""]) {
        const replaced = await session.run({
          op: "replace",
          pattern: "z",
          flags,
          input: SLOW,
          replacement: "y",
          deadlineMs: 60_000,
        });
        expect(replaced.status).toBe("gave-up");
      }
      const pieces = await session.run({
        op: "split",
        pattern: ";",
        input: SLOW,
        deadlineMs: 60_000,
      });
      expect(pieces.status).toBe("gave-up");
    } finally {
      session.close();
    }
  });

  test("replaceEach stops at the input, or skips it as undetermined", async () => {
    scriptWorkerClock({ [SLOW]: GIVE_UP_MS });
    const request = {
      op: "replaceEach",
      pattern: "q",
      flags: "g",
      inputs: ["quick", SLOW, "q"],
      replacement: "Q",
      deadlineMs: 60_000,
    } as const;
    expect(await runRegex(request)).toMatchObject({
      status: "gave-up",
      index: 1,
      partial: { outputs: ["Quick"], replacements: 1, undetermined: [] },
    });
    expect(await runRegex({ ...request, onGiveUp: "skip" })).toMatchObject({
      status: "ok",
      result: { outputs: ["Quick", null, "Q"], replacements: 2, undetermined: [1] },
    });
  });
});
