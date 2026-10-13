import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  type ScriptedWorker,
  restoreWorkerClock,
  scriptWorkerClock,
} from "./__test__/scripted-worker-clock";
import {
  REGEX_RUN_DEFAULTS,
  type RegexOutcome,
  type RegexSession,
  type TestResult,
  describeRegexOutcome,
  openRegexSession,
  regexVerdict,
  regexWorkerCounts,
  runRegex,
} from "./run";
import { REGEX_WORKER_SOURCE } from "./worker-source";

/**
 * Wait (bounded) for every regex worker this file started to exit.
 *
 * A worker abandoned at a deadline keeps its thread until the `exec` it is
 * inside returns, and the tests below deliberately leave such threads
 * behind (held on the scripted worker until they release them). Waiting
 * keeps one test's leftovers from making the next one `busy`, and doubles
 * as the check that abandoned threads really do exit.
 */
async function settleWorkers(budgetMs: number): Promise<{ live: number; runaway: number }> {
  const until = performance.now() + budgetMs;
  for (;;) {
    const counts = regexWorkerCounts();
    if ((counts.live === 0 && counts.runaway === 0) || performance.now() > until) return counts;
    await Bun.sleep(20);
  }
}

/** Whether `signal` has aborted within `ms`, polled without adding a listener. */
async function firesWithin(signal: AbortSignal, ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    if (signal.aborted) return true;
    await Bun.sleep(20);
  }
  return signal.aborted;
}

afterAll(async () => {
  await settleWorkers(60_000);
});

/** The worker's real give-up threshold and run deadline, taken before any test moves them. */
const REAL = { giveUpMs: REGEX_RUN_DEFAULTS.giveUpMs, deadlineMs: REGEX_RUN_DEFAULTS.deadlineMs };
const defaults = REGEX_RUN_DEFAULTS as { giveUpMs: number; deadlineMs: number };

/**
 * Every test here gets definite answers unless it is about give-ups.
 *
 * The worker reports a failing `exec` that took giveUpMs (100 ms) as the
 * engine giving up, so one preemption of the worker thread that long inside
 * a no-match turned "no match" into "gave-up", and a stall past the default
 * 1 s deadline turned a run into a timeout: a dozen tests failed under one
 * injected 110 ms worker stall, and more under a worker clock moved 150 ms
 * per read. Both are held out of any runner's reach here. A deadline a test
 * passes is its own; the 60 s default only stops a hang. A test about
 * give-ups scripts the worker's clock instead ({@link scriptedGiveUps}).
 */
beforeEach(() => {
  defaults.giveUpMs = 60_000;
  defaults.deadlineMs = 60_000;
});

/** What {@link holdDeadline} replaced, put back by {@link releaseDeadline}. */
const heldDeadline: { restore: (() => void) | undefined } = { restore: undefined };

function releaseDeadline(): void {
  heldDeadline.restore?.();
  heldDeadline.restore = undefined;
}

/**
 * Every session a test opened through {@link openSession}, closed after it.
 *
 * A test abandoned at its budget never reaches its own `finally`, and its
 * session stayed open with the worker busy: under a 1.5 s delay on every
 * request, the 540 runs of the built-in comparison went on for minutes, and
 * the later tests that wait for the workers to exit failed with it, each
 * passing alone. Closed, the worker is stopped, and the abandoned body's
 * next run answers `closed` at once instead of starting more work.
 */
const openedSessions: RegexSession[] = [];

function openSession(): RegexSession {
  const session = openRegexSession();
  openedSessions.push(session);
  return session;
}

// A body abandoned at its budget never reaches a finally of its own, so
// everything is put back here, after every test: its sessions closed, then
// any thread the scripted worker holds released, so it exits too.
afterEach(() => {
  for (const session of openedSessions.splice(0)) session.close();
  releaseDeadline();
  restoreWorkerClock();
  defaults.giveUpMs = REAL.giveUpMs;
  defaults.deadlineMs = REAL.deadlineMs;
});

/**
 * Hold the deadline of the regex runs started until `release` (or
 * {@link releaseDeadline}): the timer is never armed, and `fire` runs it
 * when the test says. The caller's clock stands still meanwhile, so the
 * screen takes nothing off the deadline and the timer asks for exactly
 * `deadlineMs`; any other timer is left alone. `fire` throws unless exactly
 * one such timer was held, so a changed deadline cannot quietly put the race
 * back. `release` puts back only this hold: a body abandoned at its budget
 * that gets there late, during a later test, leaves that test's hold alone.
 */
function holdDeadline(deadlineMs: number): { fire(): void; release(): void } {
  releaseDeadline();
  const realSetTimeout = globalThis.setTimeout;
  const held: Array<() => void> = [];
  const clock = spyOn(performance, "now").mockReturnValue(0);
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: (...args: unknown[]) => void,
    delay?: number,
    ...rest: unknown[]
  ) => {
    if (delay !== deadlineMs) return realSetTimeout(fn, delay, ...rest);
    held.push(() => fn(...rest));
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  const restore = (): void => {
    timers.mockRestore();
    clock.mockRestore();
  };
  heldDeadline.restore = restore;
  return {
    fire(): void {
      if (held.length !== 1) {
        throw new Error(`expected one ${deadlineMs} ms deadline to hold, held ${held.length}`);
      }
      held[0]?.();
    },
    release(): void {
      if (heldDeadline.restore === restore) releaseDeadline();
    },
  };
}

/**
 * For a test about give-ups: the real threshold, against a worker clock on
 * which each input in `costs` takes that many milliseconds and every other
 * input none (see {@link scriptWorkerClock}). Which inputs give up is then
 * the test's to say, on any machine and under any stall.
 */
function scriptedGiveUps(costs: Record<string, number>): void {
  defaults.giveUpMs = REAL.giveUpMs;
  scriptWorkerClock(costs);
}

/**
 * Screen-passing, and still abandoned by JavaScriptCore: four adjacent loops
 * over a two-branch group, which is polynomial rather than exponential, so
 * no structural screen refuses it. On a*100 + "x" the engine exceeds its
 * backtracking budget and returns null — "no match" — although the input
 * ends in "x" and the pattern says `|x`. The executor must not believe it.
 */
const GIVES_UP = { pattern: "(?:a|b)*(?:a|b)*(?:a|b)*(?:a|b)*!|x", input: `${"a".repeat(100)}x` };

/** What a give-up costs on the scripted worker clock. Every real one measured took 0.4–3 s. */
const GIVE_UP_COST_MS = 1_000;

/**
 * An input the scripted worker holds (see {@link scriptWorkerClock}): its
 * exec does not return until the test releases it, and terminate() cannot
 * end it, as a thread terminated inside a slow real match runs on until the
 * match returns. The tests below used a real one, \s+$ over 40 000 spaces
 * (about a second of one core here), to outlast a 20-100 ms deadline, and an
 * engine some 20 times faster answered first. Held, a run ends only as the
 * test says: at its deadline, on an abort, or on a close.
 */
const HELD = "the worker holds this one, x";

/** Wait until a worker is inside the held exec; if the run ended first, say how. */
async function untilHeld(
  scripted: ScriptedWorker,
  pending: Promise<RegexOutcome<unknown>>,
): Promise<void> {
  const reached = await Promise.race([scripted.hung, pending.then((ended) => ({ ended }))]);
  expect(reached).toBe(HELD);
}

describe("runRegex: answers", () => {
  test("test, matchAll, replace, split, testEach and firstMatchingRule", async () => {
    const session = openSession();
    try {
      expect(await session.run({ op: "test", pattern: "b", input: "abc" })).toMatchObject({
        status: "ok",
        result: { matched: true },
      });
      expect(await session.run({ op: "test", pattern: "z", input: "abc" })).toMatchObject({
        status: "ok",
        result: { matched: false },
      });
      const all = await session.run({ op: "matchAll", pattern: "(?<d>\\d)(x)?", input: "a1b2x" });
      expect(all).toMatchObject({
        status: "ok",
        result: {
          truncated: false,
          matches: [
            { match: "1", index: 1, captures: ["1", undefined], groups: { d: "1" } },
            { match: "2x", index: 3, captures: ["2", "x"], groups: { d: "2" } },
          ],
        },
      });
      expect(
        await session.run({
          op: "replace",
          pattern: "(\\w+)@(\\w+)",
          flags: "g",
          input: "a@b c@d",
          replacement: "$2 at $1",
        }),
      ).toMatchObject({ status: "ok", result: { output: "b at a d at c", replacements: 2 } });
      expect(await session.run({ op: "split", pattern: "(,)\\s*", input: "a, b,c" })).toMatchObject(
        { status: "ok", result: { pieces: ["a", ",", "b", ",", "c"], truncated: false } },
      );
      expect(
        await session.run({
          op: "testEach",
          pattern: "err",
          flags: "gi",
          inputs: ["ok", "ERR one", "fine", "err two"],
        }),
      ).toMatchObject({ status: "ok", result: { matched: [1, 3], scanned: 4, truncated: false } });
      expect(
        await session.run({
          op: "firstMatchingRule",
          rules: [{ pattern: "^warn" }, { pattern: "err", flags: "i" }],
          inputs: ["warn: disk", "Error: x", "nothing"],
        }),
      ).toMatchObject({ status: "ok", result: { ruleIndexes: [0, 1, -1] } });
    } finally {
      session.close();
    }
  });

  test("replace, split and matchAll agree with the built-in methods", async () => {
    const replacements = ["$&-", "$1", "$01", "$10", "$0", "$<n>", "$<nope>", "$`|$'", "$$", "x$"];
    const patterns: Array<[string, string]> = [
      ["(?<n>a)(b)?", "g"],
      ["a*", "g"],
      ["", "g"],
      ["b", ""],
      ["(a)|(b)", "gi"],
      ["\\b", "g"],
      ["\u{1F600}", "gu"],
      ["(?:)", "gu"],
      ["a", "gy"],
    ];
    const inputs = ["aabab", "", "b\u{1F600}a", "ABab"];
    const session = openSession();
    let compared = 0;
    try {
      for (const [pattern, flags] of patterns) {
        for (const input of inputs) {
          for (const replacement of replacements) {
            const got = await session.run({ op: "replace", pattern, flags, input, replacement });
            expect(got.status === "ok" ? got.result.output : got.status).toBe(
              input.replace(new RegExp(pattern, flags), replacement),
            );
            compared += 1;
          }
          for (const limit of [undefined, 0, 1, 3]) {
            const got = await session.run({ op: "split", pattern, flags, input, limit });
            expect(got.status === "ok" ? got.result.pieces : got.status).toEqual(
              input.split(new RegExp(pattern, flags), limit),
            );
            compared += 1;
          }
          const got = await session.run({ op: "matchAll", pattern, flags, input });
          const native = [
            ...input.matchAll(new RegExp(pattern, flags.includes("g") ? flags : `${flags}g`)),
          ].map((m) => [m[0], m.index]);
          expect(
            got.status === "ok" ? got.result.matches.map((m) => [m.match, m.index]) : got.status,
          ).toEqual(native);
          compared += 1;
        }
      }
    } finally {
      session.close();
    }
    expect(compared).toBe(patterns.length * inputs.length * (replacements.length + 4 + 1));
    // 540 runs, one after another on one worker: slow by construction, its
    // time is 540 round trips (40-52 ms on CI). The budget still covers a
    // worker that takes 150 ms to answer each one, as an injected delay does.
  }, 120_000);

  test("matchAll and split say when they stopped at a cap, and which cap", async () => {
    const byCount = await runRegex({ op: "matchAll", pattern: "a", input: "aaaa", maxMatches: 2 });
    expect(byCount).toMatchObject({
      status: "ok",
      result: { truncated: true, truncatedBy: "maxMatches" },
    });
    if (byCount.status === "ok") expect(byCount.result.matches.length).toBe(2);
    // A lookahead capture copies the rest of the input at every position.
    const bySize = await runRegex({
      op: "matchAll",
      pattern: "(?=([\\s\\S]*))",
      input: "x".repeat(1000),
      maxOutputChars: 5000,
    });
    expect(bySize).toMatchObject({
      status: "ok",
      result: { truncated: true, truncatedBy: "maxOutputChars" },
    });
    const pieces = await runRegex({ op: "split", pattern: ",", input: "a,b,c,d", maxMatches: 2 });
    expect(pieces).toMatchObject({
      status: "ok",
      result: { pieces: ["a", "b"], truncated: true },
    });
    // The standard `limit` is the caller's choice, not a truncation.
    const limited = await runRegex({ op: "split", pattern: ",", input: "a,b,c,d", limit: 2 });
    expect(limited).toMatchObject({
      status: "ok",
      result: { pieces: ["a", "b"], truncated: false },
    });
  });

  test("a replacement that would outgrow maxOutputChars is refused, not cut", async () => {
    const outcome = await runRegex({
      op: "replace",
      pattern: "",
      flags: "g",
      input: "x".repeat(200),
      replacement: "$'",
      maxOutputChars: 10_000,
    });
    expect(outcome.status).toBe("output-too-large");
  });

  test("too much input is refused before a worker is started", async () => {
    const before = regexWorkerCounts().live;
    const one = await runRegex({
      op: "test",
      pattern: "a",
      input: "a".repeat(11),
      maxInputChars: 10,
    });
    expect(one.status).toBe("input-too-large");
    // Batch inputs count one extra per item, so a million empty strings cost something.
    const many = await runRegex({
      op: "testEach",
      pattern: "a",
      inputs: new Array<string>(11).fill(""),
      maxInputChars: 10,
    });
    expect(many.status).toBe("input-too-large");
    expect(regexWorkerCounts().live).toBe(before);
  });

  test("a refused pattern is named, and a refused rule says which rule", async () => {
    const one = await runRegex({ op: "test", pattern: "(a+)+$", input: "aaa" });
    expect(one).toMatchObject({ status: "rejected", code: "nested-quantifier", fragment: "(a+)+" });
    const rules = await runRegex({
      op: "firstMatchingRule",
      rules: [{ pattern: "ok" }, { pattern: "(\\w|\\d)*" }],
      inputs: ["x"],
    });
    expect(rules).toMatchObject({
      status: "rejected",
      code: "overlapping-alternation",
      ruleIndex: 1,
    });
    expect(describeRegexOutcome(rules)).toContain("overlapping-alternation");
  });
});

describe("runRegex: never turns 'did not finish' into 'no match'", () => {
  test("JavaScriptCore's silent give-up is reported as gave-up, and the verdict is undetermined", async () => {
    // The engine itself answers wrongly here — the premise of the test.
    expect(new RegExp(GIVES_UP.pattern).test(GIVES_UP.input)).toBe(false);
    expect(GIVES_UP.input.endsWith("x")).toBe(true);
    // The worker runs the same exec and gets the same wrong "no". Only the
    // time it took tells it from a real no-match, and an engine a few times
    // faster than this one made it look like one. The worker's clock is
    // scripted to what a give-up costs; the deadline only stops a hang.
    scriptedGiveUps({ [GIVES_UP.input]: GIVE_UP_COST_MS });
    const outcome = await runRegex({ op: "test", ...GIVES_UP, deadlineMs: 30_000 });
    expect(outcome).toMatchObject({ status: "gave-up", execMs: GIVE_UP_COST_MS });
    expect(regexVerdict(outcome)).toBe("undetermined");
    if (outcome.status === "gave-up") expect(outcome.reason).toContain("undetermined");
  }, 60_000);

  test("a no-match that took at least giveUpMs is not trusted, and a batch says where it stopped", async () => {
    // A genuine no-match the worker's clock says took a second. "none" is
    // tried in the same group of inputs, takes no time, and is a definite no.
    const slow = "spaces, then y";
    scriptedGiveUps({ [slow]: GIVE_UP_COST_MS });
    const outcome = await runRegex({
      op: "testEach",
      pattern: "\\s+$",
      inputs: ["trailing  ", "none", slow, "also  "],
      deadlineMs: 60_000,
    });
    expect(outcome).toMatchObject({
      status: "gave-up",
      execMs: GIVE_UP_COST_MS,
      index: 2,
      partial: { matched: [0], scanned: 2, truncated: false },
    });
  }, 90_000);

  test("the deadline holds while the caller's event loop keeps running", async () => {
    await settleWorkers(60_000);
    const scripted = scriptWorkerClock({}, [], [HELD]);
    // Every message a regex worker posts, in the order this thread receives
    // them. The listener is added in the constructor, before the session's
    // own, so a message is recorded before the session acts on it.
    const ScriptedClockWorker = globalThis.Worker;
    const received: string[] = [];
    class Watched extends ScriptedClockWorker {
      constructor(...args: ConstructorParameters<typeof ScriptedClockWorker>) {
        super(...args);
        this.addEventListener("message", (event) => {
          received.push(String((event.data as { kind?: unknown } | null)?.kind));
        });
      }
    }
    // afterEach puts the real Worker back: a finally here would run after
    // it when the body is abandoned, and leave this class for later tests.
    (globalThis as { Worker: unknown }).Worker = Watched;
    const session = openSession();
    try {
      // Warm the worker so start-up is not part of the run.
      expect((await session.run({ op: "test", pattern: "a", input: "a" })).status).toBe("ok");
      const doneBefore = received.filter((kind) => kind === "done").length;
      expect(doneBefore).toBe(1);
      let ticks = 0;
      const tick = setInterval(() => {
        ticks += 1;
      }, 10);
      // The exec is held: the worker cannot answer, however fast its engine,
      // so only the deadline can end the run. (It matches, once released:
      // the `x` is there.)
      const outcome = await session.run({
        op: "test",
        pattern: "\\s+$|x",
        input: HELD,
        deadlineMs: 50,
      });
      // Read before anything else runs. The answer came at the deadline,
      // with the worker's own answer not yet received: one that waited for
      // it (and then called the run a timeout) is told apart by order, not
      // by how long it took. And the abandoned thread had not yet exited:
      // waiting for it would have answered with none left running.
      const doneByAnswer = received.filter((kind) => kind === "done").length - doneBefore;
      const stillRunning = regexWorkerCounts().runaway;
      clearInterval(tick);
      expect(outcome.status).toBe("timeout");
      expect(regexVerdict(outcome as RegexOutcome<TestResult>)).toBe("undetermined");
      expect(doneByAnswer).toBe(0);
      expect(stillRunning).toBe(1);
      // The interval was due before the deadline, so it ran first.
      expect(ticks).toBeGreaterThan(0);
      // The same session recovers with a fresh worker.
      expect(await session.run({ op: "test", pattern: "b", input: "abc" })).toMatchObject({
        status: "ok",
        result: { matched: true },
      });
    } finally {
      session.close();
    }
    // Released, the abandoned thread exits.
    scripted.release();
    expect(await settleWorkers(60_000)).toEqual({ live: 0, runaway: 0 });
  }, 90_000);

  test("a timed-out batch is stopped where it is, reports how far it got, and its thread exits", async () => {
    await settleWorkers(60_000);
    // 300 lines, each one progress interval on the worker's scripted clock,
    // so every group of lines is reported once decided; every seventh ends in
    // spaces and matches. Line 150 is held. The deadline is held until the
    // worker is inside that exec and then fired, so the run stops there,
    // whatever the engine's speed: a real slow batch (3 000 lines of 3 000
    // spaces, about 15 s here) let an engine fast enough finish first. Few
    // lines, so a worker stalled after every exec still gets there.
    const interval = REGEX_RUN_DEFAULTS.progressEveryMs;
    const hit = "row ends  ";
    const miss = "row";
    const stop = 150;
    const inputs: string[] = Array.from({ length: 300 }, (_, i) => (i % 7 === 0 ? hit : miss));
    inputs[stop] = HELD;
    const scripted = scriptWorkerClock({ [hit]: interval, [miss]: interval }, [], [HELD]);
    const deadline = holdDeadline(100);
    const pending = runRegex({ op: "testEach", pattern: "\\s+$", inputs, deadlineMs: 100 });
    await untilHeld(scripted, pending);
    // Each line before it ran once (none took long enough to be run again),
    // and none after it.
    const execsAtDeadline = scripted.execs();
    expect(execsAtDeadline).toBe(stop + 1);
    deadline.fire();
    const outcome = await pending;
    deadline.release();
    expect(outcome.status).toBe("timeout");
    if (outcome.status !== "timeout") return;
    // How far it got is what the worker reported before the held line: some
    // of the batch, never past that line, and every match below it.
    const completed = outcome.completed ?? -1;
    expect(completed).toBeGreaterThan(0);
    expect(completed).toBeLessThanOrEqual(stop);
    expect(outcome.partial).toEqual({
      matched: inputs.slice(0, completed).flatMap((s, i) => (s === hit ? [i] : [])),
      scanned: completed,
      truncated: false,
      undetermined: [],
    });
    // The terminated thread is still inside the held exec, as one inside a
    // slow real match is. Once that exec returns, terminate() stops the
    // batch before its next line, and the thread exits: not one of the 149
    // lines after it runs. Without terminate() it would run them all, and
    // never exit.
    expect(regexWorkerCounts().runaway).toBe(1);
    scripted.release();
    expect(await settleWorkers(60_000)).toEqual({ live: 0, runaway: 0 });
    expect(scripted.execs()).toBe(execsAtDeadline);
  }, 90_000);

  test("past maxRunawayWorkers abandoned threads, a new run is refused as busy", async () => {
    await settleWorkers(60_000);
    // Held, the first run's thread stays a runaway until the test releases
    // it, however fast the engine: a real slow input let an engine fast
    // enough finish, and exit, before the second run was asked.
    const scripted = scriptWorkerClock({}, [], [HELD]);
    const deadline = holdDeadline(20);
    const pending = runRegex({
      op: "test",
      pattern: "\\s+$|x",
      input: HELD,
      deadlineMs: 20,
      maxRunawayWorkers: 1,
    });
    await untilHeld(scripted, pending);
    deadline.fire();
    const first = await pending;
    deadline.release();
    expect(first.status).toBe("timeout");
    // Asked while that thread is still inside its exec.
    const second = await runRegex({
      op: "test",
      pattern: "a",
      input: "a",
      maxRunawayWorkers: 1,
    });
    expect(second).toMatchObject({ status: "error", code: "busy" });
    expect(regexVerdict(second as RegexOutcome<TestResult>)).toBe("undetermined");
    scripted.release();
    expect(await settleWorkers(60_000)).toEqual({ live: 0, runaway: 0 });
    // And once it has exited, runs start again.
    expect(
      (await runRegex({ op: "test", pattern: "a", input: "a", maxRunawayWorkers: 1 })).status,
    ).toBe("ok");
  }, 120_000);
});

describe("screening many patterns", () => {
  /** A distinct, screen-accepted ~900-character pattern that takes real work to screen. */
  function heavyPattern(n: number): string {
    let nest = "x";
    let cp = 0x4e00;
    while (nest.length + 7 < 880) {
      nest = `(?:${nest})+${String.fromCharCode(cp)}`;
      cp += 2;
    }
    return `${nest}${n}`;
  }

  test("yields to the event loop, and counts against the deadline", async () => {
    await settleWorkers(60_000);
    // Counted on a fake performance.now(), not timed: each rule's screen
    // costs 1 ms of it, and the rules screened between two turns of the event
    // loop are counted. Before, screening held the event loop for the whole
    // list (36 s at 1000 rules) and only then found the deadline gone.
    let now = 0;
    let screened = 0;
    let sinceTurn = 0;
    let mostBetweenTurns = 0;
    const rules = Array.from({ length: 600 }, (_, i) => ({
      pattern: heavyPattern(i),
      // Read once per rule, as it is screened.
      get flags(): string {
        screened += 1;
        sinceTurn += 1;
        mostBetweenTurns = Math.max(mostBetweenTurns, sinceTurn);
        now += 1;
        return "i";
      },
    }));
    let probing = true;
    const probe = (): void => {
      sinceTurn = 0;
      if (probing) setImmediate(probe);
    };
    setImmediate(probe);
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const before = regexWorkerCounts().live;
    let outcome: RegexOutcome<unknown>;
    try {
      outcome = await runRegex({
        op: "firstMatchingRule",
        rules,
        inputs: ["x"],
        deadlineMs: 50,
        maxTotalPatternChars: 1_000_000,
      });
    } finally {
      clock.mockRestore();
      probing = false;
    }
    // It stopped at the deadline, about 50 rules in, not after all 600.
    expect(outcome).toMatchObject({ status: "timeout", completed: 0 });
    if (outcome.status === "timeout") expect(outcome.reason).toContain("screening");
    expect(screened).toBeLessThan(rules.length / 10);
    // The event loop ran at least every screenSliceMs of screening.
    expect(mostBetweenTurns).toBeLessThanOrEqual(2 * REGEX_RUN_DEFAULTS.screenSliceMs);
    // Nothing was run, so no worker was started.
    expect(regexWorkerCounts().live).toBe(before);
  }, 60_000);

  test("the patterns' combined length is capped before any is screened", async () => {
    const outcome = await runRegex({
      op: "testMatrix",
      patterns: [{ pattern: "a".repeat(60) }, { pattern: "b".repeat(60) }],
      inputs: ["a"],
      maxTotalPatternChars: 100,
    });
    expect(outcome).toMatchObject({ status: "input-too-large" });
    if (outcome.status === "input-too-large") expect(outcome.reason).toContain("120");
  });
});

describe("batch ops", () => {
  const inputs = ["ERR: disk", "warn: cpu", "fine", "xx err", "warning", ""];
  const patterns = [
    { pattern: "err", flags: "i" },
    { pattern: "^warn" },
    { pattern: "x+" },
    { pattern: "$" },
  ];

  test("testMatrix answers every pattern for every input, as a native loop would", async () => {
    const outcome = await runRegex({ op: "testMatrix", patterns, inputs });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const native = patterns.map(({ pattern, flags }) =>
      inputs.flatMap((input, i) => (new RegExp(pattern, flags).test(input) ? [i] : [])),
    );
    expect(outcome.result.matched).toEqual(native);
    expect(outcome.result.undetermined).toEqual(patterns.map(() => []));
  });

  test("replaceEach replaces in every input, as the built-in method does, under one output cap", async () => {
    const outcome = await runRegex({
      op: "replaceEach",
      pattern: "(\\w)(\\w*)",
      flags: "g",
      inputs,
      replacement: "$2$1",
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.outputs).toEqual(inputs.map((s) => s.replace(/(\w)(\w*)/g, "$2$1")));
    expect(outcome.result.replacements).toBe(
      inputs.reduce((n, s) => n + (s.match(/(\w)(\w*)/g)?.length ?? 0), 0),
    );
    const capped = await runRegex({
      op: "replaceEach",
      pattern: "x",
      flags: "g",
      inputs: ["x".repeat(50), "x".repeat(50)],
      replacement: "yy",
      maxOutputChars: 150,
    });
    expect(capped.status).toBe("output-too-large");
  });

  test("an input over maxItemChars stops the batch, or is skipped as undetermined", async () => {
    const long = "a".repeat(101);
    const stopped = await runRegex({
      op: "testEach",
      pattern: "a",
      inputs: ["a", long, "a"],
      maxItemChars: 100,
    });
    expect(stopped).toMatchObject({ status: "input-too-large", index: 1 });
    const skipped = await runRegex({
      op: "testEach",
      pattern: "a",
      inputs: ["a", long, "b", "a"],
      maxItemChars: 100,
      onGiveUp: "skip",
    });
    expect(skipped).toMatchObject({
      status: "ok",
      result: { matched: [0, 3], undetermined: [1], scanned: 4 },
    });
    const rules = await runRegex({
      op: "firstMatchingRule",
      rules: [{ pattern: "b" }, { pattern: "a" }],
      inputs: ["a", long],
      maxItemChars: 100,
      onGiveUp: "skip",
    });
    expect(rules).toMatchObject({
      status: "ok",
      result: { ruleIndexes: [1, null], undetermined: [1] },
    });
  });

  test('onGiveUp "skip" reports a give-up as undetermined and answers the inputs after it', async () => {
    await settleWorkers(60_000);
    // GIVES_UP's pattern does not match twelve a's, and the engine says so
    // at once; the worker's clock says it took as long as a give-up does.
    // "no" is the same kind of answer, quick, and stays a definite no.
    const slow = "a".repeat(12);
    scriptedGiveUps({ [slow]: GIVE_UP_COST_MS });
    const session = openSession();
    try {
      const each = await session.run({
        op: "testEach",
        pattern: GIVES_UP.pattern,
        inputs: ["x", slow, "yx", "no"],
        onGiveUp: "skip",
        deadlineMs: 60_000,
      });
      expect(each).toMatchObject({
        status: "ok",
        result: { matched: [0, 2], undetermined: [1], scanned: 4 },
      });
      const first = await session.run({
        op: "firstMatchingRule",
        rules: [{ pattern: GIVES_UP.pattern }, { pattern: "a" }],
        inputs: ["zzz", slow, "a"],
        onGiveUp: "skip",
        deadlineMs: 60_000,
      });
      // Rule 0 could not be answered for input 1, so which rule matches
      // first is undetermined there, although rule 1 would match.
      expect(first).toMatchObject({
        status: "ok",
        result: { ruleIndexes: [-1, null, 1], undetermined: [1] },
      });
      const matrix = await session.run({
        op: "testMatrix",
        patterns: [{ pattern: GIVES_UP.pattern }, { pattern: "a" }],
        inputs: ["zzz", slow],
        onGiveUp: "skip",
        deadlineMs: 60_000,
      });
      expect(matrix).toMatchObject({
        status: "ok",
        result: { matched: [[], [1]], undetermined: [[1], []] },
      });
    } finally {
      session.close();
    }
  }, 120_000);

  test("a timed-out testMatrix reports its partial answers per pattern", async () => {
    await settleWorkers(60_000);
    // Each exec over a row is half a progress interval on the worker's
    // scripted clock, so each row (two patterns) is reported once both have
    // run on it; every third row ends in "y". Row 20 is held, and the
    // deadline fired once the worker is inside it, so the run stops there on
    // any engine: a real slow matrix (3 000 rows of 3 000 spaces) let an
    // engine fast enough finish first. Few rows, so a worker stalled after
    // every exec still gets there.
    const half = REGEX_RUN_DEFAULTS.progressEveryMs / 2;
    const plain = "row x";
    const withY = "row y";
    const stop = 20;
    const inputs: string[] = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? withY : plain));
    inputs[stop] = HELD;
    const scripted = scriptWorkerClock({ [plain]: half, [withY]: half }, [], [HELD]);
    const deadline = holdDeadline(100);
    const pending = runRegex({
      op: "testMatrix",
      patterns: [{ pattern: "\\s+$" }, { pattern: "y" }],
      inputs,
      deadlineMs: 100,
    });
    await untilHeld(scripted, pending);
    deadline.fire();
    const outcome = await pending;
    deadline.release();
    expect(outcome).toMatchObject({
      status: "timeout",
      completed: stop,
      partial: {
        matched: [[], inputs.slice(0, stop).flatMap((s, i) => (s === withY ? [i] : []))],
        undetermined: [[], []],
      },
    });
    scripted.release();
    expect(await settleWorkers(30_000)).toEqual({ live: 0, runaway: 0 });
  }, 90_000);
});

describe("testEach times inputs in groups, and a slow group one input at a time", () => {
  // The clock is read once per group of inputs; a group slower than
  // giveUpMs has each no-match run again alone, so only the slow input is
  // undetermined, and a match beside it still counts.
  test("one slow no-match among quick ones is the only undetermined input", async () => {
    // Slow on the worker's scripted clock; every other input takes no time.
    const slow = "row 101 is slow";
    scriptedGiveUps({ [slow]: GIVE_UP_COST_MS });
    const inputs: string[] = [];
    for (let i = 0; i < 200; i++) inputs.push(i % 7 === 0 ? `row ${i} ends  ` : `row ${i}`);
    inputs[101] = slow;
    for (const form of ["array", "lines"] as const) {
      const outcome = await runRegex({
        op: "testEach",
        pattern: "\\s+$",
        inputs: form === "array" ? inputs : { lines: inputs.join("\n") },
        onGiveUp: "skip",
        deadlineMs: 60_000,
        maxInputChars: 1_000_000,
      });
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") return;
      expect(outcome.result.undetermined).toEqual([101]);
      expect(outcome.result.matched).toEqual(
        inputs.flatMap((s, i) => (i !== 101 && /\s+$/.test(s) ? [i] : [])),
      );
      expect(outcome.result.scanned).toBe(inputs.length);
      // The slow input ran exactly twice: in its group, and then alone.
      expect(outcome.elapsedMs).toBe(2 * GIVE_UP_COST_MS);
    }
  }, 90_000);

  test("maxMatches stops at the input past the cap, as before", async () => {
    const inputs = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? "hit" : "miss"));
    const outcome = await runRegex({ op: "testEach", pattern: "hit", inputs, maxMatches: 50 });
    expect(outcome).toMatchObject({ status: "ok", result: { truncated: true, scanned: 150 } });
    if (outcome.status === "ok") {
      expect(outcome.result.matched).toEqual(Array.from({ length: 50 }, (_, i) => i * 3));
    }
  });

  test("a timed-out batch's partial answers cover only the inputs it counts as done", async () => {
    await settleWorkers(60_000);
    // On the worker's scripted clock, in groups of 1, 2 and then up to 4
    // inputs. The second group holds a match and takes one progress interval,
    // so a report covers it. The third holds a match that takes another
    // interval, then an input whose exec never returns. A match reported
    // while its group was still running came back as partial.matched [.., 3]
    // with completed 3: an answer for an input the caller was told was not
    // reached. The deadline is held until the worker is inside that exec and
    // then fired, so it is the only way the run ends, whatever the engine's
    // speed, the give-up threshold or a stall of either thread.
    const interval = REGEX_RUN_DEFAULTS.progressEveryMs;
    const endless = "never returns";
    const { hung } = scriptWorkerClock({ c: interval, "d  ": interval }, [endless]);
    const deadline = holdDeadline(30_000);
    const pending = runRegex({
      op: "testEach",
      pattern: "\\s+$",
      inputs: ["a", "b  ", "c", "d  ", endless, "e"],
      deadlineMs: 30_000,
      runawayKey: "testEach-partial-within-count",
    });
    // The run cannot end on its own; if it does, say how.
    const reached = await Promise.race([hung, pending.then((ended) => ({ ended }))]);
    expect(reached).toBe(endless);
    deadline.fire();
    const outcome = await pending;
    deadline.release();
    expect(outcome).toMatchObject({
      status: "timeout",
      completed: 3,
      partial: { matched: [1], scanned: 3, truncated: false, undetermined: [] },
    });
    // terminate() ends the endless exec, and the thread exits.
    expect(await settleWorkers(60_000)).toEqual({ live: 0, runaway: 0 });
  }, 90_000);
});

describe("testEach over one text's lines ({ lines })", () => {
  // Exactly the answers testEach gives the same lines as an array; only the
  // way they cross to the worker differs.
  const lines = ["ERR: disk", "", "warn: cpu\r", "fine", "xx err", "warning", "  ", ""];
  const text = lines.join("\n");

  test.each([
    ["err", "i"],
    ["^warn", ""],
    ["^\\s*$", ""],
    ["\\r$", ""],
    ["x+", "g"],
    ["$", "y"],
  ] as const)("%p/%p answers as the array does", async (pattern, flags) => {
    const asArray = await runRegex({ op: "testEach", pattern, flags, inputs: lines });
    const asText = await runRegex({ op: "testEach", pattern, flags, inputs: { lines: text } });
    expect(asArray.status).toBe("ok");
    expect(asText.status).toBe("ok");
    if (asArray.status !== "ok" || asText.status !== "ok") return;
    expect(asText.result).toEqual(asArray.result);
    const native = lines.flatMap((l, i) =>
      new RegExp(pattern, flags.replace("g", "")).test(l) ? [i] : [],
    );
    expect(asText.result.matched).toEqual(native);
    expect(asText.result.scanned).toBe(lines.length);
  });

  test("a line over maxItemChars is refused at its index, or skipped as undetermined", async () => {
    const long = "a".repeat(101);
    const block = { lines: ["a", "b", long, "a"].join("\n") };
    const stopped = await runRegex({
      op: "testEach",
      pattern: "a",
      inputs: block,
      maxItemChars: 100,
    });
    expect(stopped).toMatchObject({ status: "input-too-large", index: 2 });
    if (stopped.status === "input-too-large")
      expect(stopped.reason).toContain("input 2 is 101 characters");
    const skipped = await runRegex({
      op: "testEach",
      pattern: "a",
      inputs: block,
      maxItemChars: 100,
      onGiveUp: "skip",
    });
    expect(skipped).toMatchObject({
      status: "ok",
      result: { matched: [0, 3], undetermined: [2], scanned: 4 },
    });
  });

  test("its size is counted as the array's: each line and one for its end", async () => {
    // 11 empty lines: 10 separators, 11 characters as an array counts them.
    const block = { lines: "\n".repeat(10) };
    expect(
      (await runRegex({ op: "testEach", pattern: "a", inputs: block, maxInputChars: 10 })).status,
    ).toBe("input-too-large");
    expect(
      (await runRegex({ op: "testEach", pattern: "a", inputs: block, maxInputChars: 11 })).status,
    ).toBe("ok");
  });

  test("a slow no-match is still undetermined, never a miss", async () => {
    // Slow on the worker's scripted clock; "none" beside it takes no time.
    const slow = "spaces, then y";
    scriptedGiveUps({ [slow]: GIVE_UP_COST_MS });
    const outcome = await runRegex({
      op: "testEach",
      pattern: "\\s+$",
      inputs: { lines: ["trailing  ", "none", slow, "also  "].join("\n") },
      onGiveUp: "skip",
      deadlineMs: 60_000,
    });
    expect(outcome).toMatchObject({
      status: "ok",
      result: { matched: [0, 3], undetermined: [2], scanned: 4 },
    });
  }, 90_000);

  test("anything but a string of lines is a caller error", async () => {
    await expect(
      runRegex({ op: "testEach", pattern: "a", inputs: { lines: 5 } as never }),
    ).rejects.toThrow(TypeError);
  });
});

describe("abort and busy", () => {
  test("a signal aborts before or during a run, and the verdict is undetermined", async () => {
    await settleWorkers(60_000);
    const early = await runRegex({
      op: "test",
      pattern: "a",
      input: "a",
      signal: AbortSignal.abort(),
    });
    expect(early).toMatchObject({ status: "error", code: "aborted" });
    // Held, the run cannot finish, however fast the engine, so only the
    // abort can end it (the 60 s deadline only stops a hang). A real slow
    // input aborted after 30 ms let an engine fast enough answer first.
    const scripted = scriptWorkerClock({}, [], [HELD]);
    const controller = new AbortController();
    const pending = runRegex({
      op: "test",
      pattern: "\\s+$|x",
      input: HELD,
      deadlineMs: 60_000,
      signal: controller.signal,
    });
    await untilHeld(scripted, pending);
    controller.abort();
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: "error", code: "aborted" });
    expect(regexVerdict(outcome as RegexOutcome<TestResult>)).toBe("undetermined");
    // The aborted run's thread was stopped inside its exec: a runaway until
    // the exec returns, and then it exits.
    expect(regexWorkerCounts().runaway).toBe(1);
    scripted.release();
    expect(await settleWorkers(60_000)).toEqual({ live: 0, runaway: 0 });
  }, 90_000);

  test("a caller's AbortSignal.timeout still fires after a run finished with it", async () => {
    // Bun 1.3.14 cancels an AbortSignal.timeout() for good when its last
    // listener is removed, so a finished run must not leave it without one.
    const signal = AbortSignal.timeout(500);
    const first = await runRegex({ op: "test", pattern: "a", input: "a", signal });
    expect(["ok", "error"]).toContain(first.status);
    expect(await firesWithin(signal, 15_000)).toBe(true);
  }, 30_000);

  test("abandoned workers make only their own runawayKey busy", async () => {
    await settleWorkers(60_000);
    // Held, the hostile run's thread stays a runaway of "session-a" until
    // the test releases it, however fast the engine.
    const scripted = scriptWorkerClock({}, [], [HELD]);
    const deadline = holdDeadline(20);
    const pending = runRegex({
      op: "test",
      pattern: "\\s+$|x",
      input: HELD,
      deadlineMs: 20,
      maxRunawayWorkers: 1,
      runawayKey: "session-a",
    });
    await untilHeld(scripted, pending);
    deadline.fire();
    const hostile = await pending;
    deadline.release();
    expect(hostile.status).toBe("timeout");
    const again = await runRegex({
      op: "test",
      pattern: "a",
      input: "a",
      maxRunawayWorkers: 1,
      runawayKey: "session-a",
    });
    expect(again).toMatchObject({ status: "error", code: "busy" });
    const neighbour = await runRegex({
      op: "test",
      pattern: "a",
      input: "a",
      maxRunawayWorkers: 1,
      runawayKey: "session-b",
    });
    expect(neighbour).toMatchObject({ status: "ok", result: { matched: true } });
    scripted.release();
    expect(await settleWorkers(60_000)).toEqual({ live: 0, runaway: 0 });
  }, 120_000);
});

describe("sessions", () => {
  test("one warm worker serves every run until the session closes", async () => {
    await settleWorkers(60_000);
    const session = openSession();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        session.run({ op: "test", pattern: String(i % 10), input: "0123456789" }),
      ),
    );
    expect(outcomes.every((o) => o.status === "ok")).toBe(true);
    expect(regexWorkerCounts().live).toBe(1);
    session.close();
    expect(await session.run({ op: "test", pattern: "a", input: "a" })).toMatchObject({
      status: "error",
      code: "closed",
    });
    expect(await settleWorkers(10_000)).toEqual({ live: 0, runaway: 0 });
  });

  test("closing mid-run resolves the run as closed instead of leaving it hanging", async () => {
    // Held, the run is still going when the session closes, however fast the
    // engine; a real slow input closed after 50 ms let one fast enough
    // answer "ok" first, so the test had to accept either.
    const scripted = scriptWorkerClock({}, [], [HELD]);
    const session = openSession();
    const pending = session.run({
      op: "test",
      pattern: "\\s+$|x",
      input: HELD,
      deadlineMs: 60_000,
    });
    await untilHeld(scripted, pending);
    session.close();
    expect(await pending).toMatchObject({ status: "error", code: "closed" });
    // The thread was stopped inside its exec: a runaway until it returns.
    expect(regexWorkerCounts().runaway).toBe(1);
    scripted.release();
    expect(await settleWorkers(60_000)).toEqual({ live: 0, runaway: 0 });
  }, 90_000);
});

describe("the worker source", () => {
  test("is plain, parseable JavaScript with no interpolation left in it", () => {
    expect(() => new Function(REGEX_WORKER_SOURCE)).not.toThrow();
    expect(REGEX_WORKER_SOURCE).not.toContain("${");
    expect(REGEX_WORKER_SOURCE).toContain('postMessage({ kind: "ready" })');
  });
});
