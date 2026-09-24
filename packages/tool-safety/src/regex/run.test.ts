import { afterAll, describe, expect, test } from "bun:test";
import {
  type RegexOutcome,
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
 * behind. Waiting keeps one test's leftovers from making the next one
 * `busy`, and doubles as the check that abandoned threads really do exit.
 */
async function settleWorkers(budgetMs: number): Promise<{ live: number; runaway: number }> {
  const until = performance.now() + budgetMs;
  for (;;) {
    const counts = regexWorkerCounts();
    if ((counts.live === 0 && counts.runaway === 0) || performance.now() > until) return counts;
    await Bun.sleep(20);
  }
}

afterAll(async () => {
  await settleWorkers(60_000);
});

/**
 * Screen-passing, and still abandoned by JavaScriptCore: four adjacent loops
 * over a two-branch group, which is polynomial rather than exponential, so
 * no structural screen refuses it. On a*100 + "x" the engine exceeds its
 * backtracking budget and returns null — "no match" — although the input
 * ends in "x" and the pattern says `|x`. The executor must not believe it.
 */
const GIVES_UP = { pattern: "(?:a|b)*(?:a|b)*(?:a|b)*(?:a|b)*!|x", input: `${"a".repeat(100)}x` };

describe("runRegex: answers", () => {
  test("test, matchAll, replace, split, testEach and firstMatchingRule", async () => {
    const session = openRegexSession();
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
    const session = openRegexSession();
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
  });

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
    const outcome = await runRegex({ op: "test", ...GIVES_UP, deadlineMs: 30_000 });
    // gave-up is the expected path; a slow runner may hit the deadline first,
    // which is equally undetermined. What must never happen is "ok".
    expect(["gave-up", "timeout"]).toContain(outcome.status);
    expect(regexVerdict(outcome)).toBe("undetermined");
    if (outcome.status === "gave-up") {
      expect(outcome.execMs).toBeGreaterThanOrEqual(100);
      expect(outcome.reason).toContain("undetermined");
    }
  }, 60_000);

  test("a no-match that took at least giveUpMs is not trusted, and a batch says where it stopped", async () => {
    // A genuine but slow no-match: quadratic over a long run of spaces.
    const slow = `${" ".repeat(40_000)}y`;
    const outcome = await runRegex({
      op: "testEach",
      pattern: "\\s+$",
      inputs: ["trailing  ", "none", slow, "also  "],
      giveUpMs: 20,
      deadlineMs: 60_000,
    });
    expect(outcome).toMatchObject({
      status: "gave-up",
      index: 2,
      partial: { matched: [0], scanned: 2, truncated: false },
    });
  }, 90_000);

  test("the deadline holds while the caller's event loop keeps running", async () => {
    const session = openRegexSession();
    try {
      // Warm the worker so start-up is not inside the measurement.
      expect((await session.run({ op: "test", pattern: "a", input: "a" })).status).toBe("ok");
      let ticks = 0;
      const tick = setInterval(() => {
        ticks += 1;
      }, 10);
      const started = performance.now();
      // Quadratic and uninterruptible from inside: ≈1 s of one core here,
      // far longer on a slow runner. It matches — the `x` is there.
      const outcome = await session.run({
        op: "test",
        pattern: "\\s+$|x",
        input: `${" ".repeat(40_000)}x`,
        deadlineMs: 50,
      });
      const took = performance.now() - started;
      clearInterval(tick);
      expect(outcome.status).toBe("timeout");
      expect(regexVerdict(outcome as RegexOutcome<TestResult>)).toBe("undetermined");
      expect(took).toBeLessThan(2_000);
      expect(ticks).toBeGreaterThan(0);
      // The same session recovers with a fresh worker.
      expect(await session.run({ op: "test", pattern: "b", input: "abc" })).toMatchObject({
        status: "ok",
        result: { matched: true },
      });
    } finally {
      session.close();
    }
    const settled = await settleWorkers(60_000);
    expect(settled).toEqual({ live: 0, runaway: 0 });
  }, 90_000);

  test("a timed-out batch is stopped where it is, reports how far it got, and its thread exits", async () => {
    await settleWorkers(60_000);
    // ≈5 ms per line here, 3000 lines: ≈15 s of work the deadline cuts short.
    const line = `${" ".repeat(3_000)}y`;
    const inputs = new Array<string>(3_000).fill(line);
    inputs[0] = "match  ";
    const outcome = await runRegex({
      op: "testEach",
      pattern: "\\s+$",
      inputs,
      deadlineMs: 100,
      maxInputChars: 20_000_000,
    });
    expect(outcome.status).toBe("timeout");
    if (outcome.status !== "timeout") return;
    expect(outcome.completed ?? -1).toBeGreaterThanOrEqual(0);
    expect(outcome.completed ?? 0).toBeLessThan(inputs.length);
    const partial = outcome.partial as { matched: number[]; scanned: number } | undefined;
    expect(partial?.scanned).toBe(outcome.completed);
    for (const i of partial?.matched ?? []) expect(i).toBeLessThan(outcome.completed ?? 0);
    // terminate() took effect between lines: the thread is gone long
    // before the batch could have finished. Without terminate() it would
    // never exit at all.
    const exitedWithin = performance.now();
    const settled = await settleWorkers(10_000);
    expect(settled).toEqual({ live: 0, runaway: 0 });
    expect(performance.now() - exitedWithin).toBeLessThan(10_000);
  }, 90_000);

  test("past maxRunawayWorkers abandoned threads, a new run is refused as busy", async () => {
    await settleWorkers(60_000);
    const first = await runRegex({
      op: "test",
      pattern: "\\s+$|x",
      input: `${" ".repeat(40_000)}x`,
      deadlineMs: 20,
      maxRunawayWorkers: 1,
    });
    expect(first.status).toBe("timeout");
    // Issued immediately, while that thread is still inside its exec.
    const second = await runRegex({
      op: "test",
      pattern: "a",
      input: "a",
      maxRunawayWorkers: 1,
    });
    expect(second).toMatchObject({ status: "error", code: "busy" });
    expect(regexVerdict(second as RegexOutcome<TestResult>)).toBe("undetermined");
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
    const rules = Array.from({ length: 600 }, (_, i) => ({ pattern: heavyPattern(i), flags: "i" }));
    let last = performance.now();
    let maxGap = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 1);
    last = performance.now();
    const before = regexWorkerCounts().live;
    const outcome = await runRegex({
      op: "firstMatchingRule",
      rules,
      inputs: ["x"],
      deadlineMs: 50,
      maxTotalPatternChars: 1_000_000,
    });
    // The stretch since the last tick counts too: a continuation runs
    // before the interval can fire again.
    maxGap = Math.max(maxGap, performance.now() - last);
    clearInterval(tick);
    // Screening all 600 takes far longer than 50 ms; it stopped at the deadline.
    expect(outcome).toMatchObject({ status: "timeout", completed: 0 });
    if (outcome.status === "timeout") expect(outcome.reason).toContain("screening");
    // Before, this held the event loop for the whole screen (36 s at 1000 rules).
    expect(maxGap).toBeLessThan(500);
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
    const session = openRegexSession();
    try {
      const each = await session.run({
        op: "testEach",
        pattern: GIVES_UP.pattern,
        inputs: ["x", GIVES_UP.input, "yx", "no"],
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
        inputs: ["zzz", GIVES_UP.input, "a"],
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
        inputs: ["zzz", GIVES_UP.input],
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
    const line = `${" ".repeat(3_000)}y`;
    const outcome = await runRegex({
      op: "testMatrix",
      patterns: [{ pattern: "\\s+$" }, { pattern: "y" }],
      inputs: new Array<string>(3_000).fill(line),
      deadlineMs: 100,
      maxInputChars: 20_000_000,
    });
    expect(outcome.status).toBe("timeout");
    if (outcome.status !== "timeout") return;
    const partial = outcome.partial as { matched: number[][]; undetermined: number[][] };
    expect(partial.matched.length).toBe(2);
    expect(partial.matched[0]).toEqual([]);
    expect(partial.matched[1]?.length ?? 0).toBeLessThanOrEqual(outcome.completed ?? 0);
    expect(await settleWorkers(30_000)).toEqual({ live: 0, runaway: 0 });
  }, 90_000);
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
    const controller = new AbortController();
    const pending = runRegex({
      op: "test",
      pattern: "\\s+$|x",
      input: `${" ".repeat(40_000)}x`,
      deadlineMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    const outcome = await pending;
    // ≈1 s of one core here, far longer on a slow runner: it cannot finish
    // before the abort, so only an abort explains the outcome.
    expect(outcome).toMatchObject({ status: "error", code: "aborted" });
    expect(regexVerdict(outcome as RegexOutcome<TestResult>)).toBe("undetermined");
    expect(await settleWorkers(60_000)).toEqual({ live: 0, runaway: 0 });
  }, 90_000);

  test("a caller's AbortSignal.timeout still fires after an earlier run finished with it", async () => {
    await settleWorkers(60_000);
    // Bun 1.3.14 cancels an AbortSignal.timeout() for good when its last
    // listener is removed, so a finished run must not leave it without one.
    const signal = AbortSignal.timeout(300);
    const session = openRegexSession();
    try {
      expect((await session.run({ op: "test", pattern: "a", input: "a", signal })).status).toBe(
        "ok",
      );
      const outcome = await session.run({
        op: "test",
        pattern: "\\s+$|x",
        input: `${" ".repeat(40_000)}x`,
        deadlineMs: 60_000,
        signal,
      });
      expect(outcome).toMatchObject({ status: "error", code: "aborted" });
    } finally {
      session.close();
    }
    expect(await settleWorkers(60_000)).toEqual({ live: 0, runaway: 0 });
  }, 90_000);

  test("abandoned workers make only their own runawayKey busy", async () => {
    await settleWorkers(60_000);
    const hostile = await runRegex({
      op: "test",
      pattern: "\\s+$|x",
      input: `${" ".repeat(40_000)}x`,
      deadlineMs: 20,
      maxRunawayWorkers: 1,
      runawayKey: "session-a",
    });
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
    expect(await settleWorkers(60_000)).toEqual({ live: 0, runaway: 0 });
  }, 120_000);
});

describe("sessions", () => {
  test("one warm worker serves every run until the session closes", async () => {
    await settleWorkers(60_000);
    const session = openRegexSession();
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
    const session = openRegexSession();
    const pending = session.run({
      op: "test",
      pattern: "\\s+$|x",
      input: `${" ".repeat(20_000)}x`,
      deadlineMs: 60_000,
    });
    await Bun.sleep(50);
    session.close();
    const outcome = await pending;
    expect(["error", "ok"]).toContain(outcome.status);
    if (outcome.status === "error") expect(outcome.code).toBe("closed");
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
