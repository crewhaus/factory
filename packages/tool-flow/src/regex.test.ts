/**
 * A caller's `matches` pattern never runs on the caller's thread, and one it
 * could not answer never routes, scores or classifies as "no match".
 *
 * 0.7.0 evaluated every `matches` check and every ErrorClassify rule with a
 * synchronous `RegExp` (C073). A polynomial pattern held the whole process
 * (ErrorClassify with `a*a*a*a*b` on a 200-character message: 3.7 s), and a
 * pattern the engine gave up on read as a miss, so a router fell through to
 * the next arm or `otherwise`, a scorer left the rule's points out, and a
 * classifier fell back to its builtin packs.
 */
import { describe, expect, test } from "bun:test";
import {
  type FLOW_TOOLS,
  branch,
  decisionTable,
  errorClassify,
  leadAssign,
  ruleScore,
  sequenceRun,
} from "./index";

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
async function call(tool: (typeof FLOW_TOOLS)[number], input: unknown): Promise<any> {
  return JSON.parse(await tool.execute(tool.inputSchema.parse(input), {} as never));
}

/** How many times a 5 ms timer fired while `body` ran: 0 means the thread was held. */
async function ticksDuring<T>(body: () => Promise<T>): Promise<{ result: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 5);
  try {
    return { result: await body(), ticks };
  } finally {
    clearInterval(timer);
  }
}

/**
 * ~0.3 s of backtracking locally; polynomial, so the screen lets it through,
 * and a no-match that slow is read as the engine giving up: undetermined.
 */
const SLOW = { pattern: "a*a*a*a*b", text: "a".repeat(120) };
/** Exponential: refused by the screen before it runs. */
const CATASTROPHIC = "(a+)+!$|refund";

describe("ErrorClassify", () => {
  test("a caller rule's pattern runs off the caller's thread, and an undecided one decides nothing", async () => {
    const { result, ticks } = await ticksDuring(() =>
      call(errorClassify, {
        status: 503,
        message: SLOW.text,
        rules: [{ id: "slow", matches: SLOW.pattern, class: "bug", action: "fail" }],
      }),
    );
    expect(ticks).toBeGreaterThan(0);
    // 0.7.0 skipped the rule as "no match" and answered from the status pack:
    // transient / retry. The rule might have said "bug / fail".
    expect(result).toMatchObject({
      class: "unknown",
      action: "escalate",
      retryable: false,
      source: "undetermined",
      matched: "slow",
    });
    expect(result.undetermined).toMatch(/rule "slow" could not be decided/);
  }, 20_000);

  test("a rule that matches, or definitely does not, still decides as before", async () => {
    const hit = await call(errorClassify, {
      status: 503,
      message: "Disk FULL on /var",
      rules: [
        { id: "no", matches: "^nothing", class: "bug", action: "fail" },
        { id: "disk", matches: "disk full", class: "capacity", action: "escalate" },
      ],
    });
    expect(hit).toMatchObject({ class: "capacity", source: "custom", matched: "disk" });
    const miss = await call(errorClassify, {
      status: 503,
      rules: [{ id: "no", matches: "^nothing", class: "bug", action: "fail" }],
    });
    expect(miss).toMatchObject({ class: "unavailable", source: "status" });
  });

  test("a pattern the screen refuses is an invalid rule, as a syntax error always was", async () => {
    await expect(
      call(errorClassify, {
        message: `${"a".repeat(30)}! refund`,
        rules: [{ id: "bad", matches: CATASTROPHIC, class: "bug", action: "fail" }],
      }),
    ).rejects.toThrow(/rule "bad" has an invalid pattern: .*nested-quantifier/);
  });
});

describe("the routers and scorers read the answers three ways", () => {
  const slow = [{ op: "matches", expected: SLOW.pattern }];
  const yes = [{ op: "matches", expected: "^a+$" }];

  test("Branch takes no arm past one it could not decide, and not otherwise either", async () => {
    const { result, ticks } = await ticksDuring(() =>
      call(branch, {
        value: SLOW.text,
        arms: [
          { name: "slow", when: slow, result: 1 },
          { name: "later", when: yes, result: 2 },
        ],
        otherwise: { name: "default" },
      }),
    );
    expect(ticks).toBeGreaterThan(0);
    // 0.7.0: the slow arm read as a miss, so "later" won.
    expect(result).toMatchObject({ matched: false, name: null, fallback: false });
    expect(result.undetermined).toMatch(/arm "slow" could not be decided/);
    // An arm decided before it still wins.
    const first = await call(branch, {
      value: SLOW.text,
      arms: [
        { name: "first", when: yes, result: 1 },
        { name: "slow", when: slow, result: 2 },
      ],
    });
    expect(first).toMatchObject({ matched: true, name: "first" });
  }, 20_000);

  test("DecisionTable gives no outputs while a row that could change them is undecided", async () => {
    const out = await call(decisionTable, {
      value: SLOW.text,
      policy: "collect",
      rows: [
        { id: "slow", when: slow, outputs: { a: 1 } },
        { id: "yes", when: yes, outputs: { b: 2 } },
      ],
      otherwise: { c: 3 },
    });
    expect(out).toMatchObject({ ok: false, matched: false, outputs: null, fallback: false });
    expect(out.undetermined).toMatch(/row "slow"/);
  }, 20_000);

  test("RuleScore gives no score while a rule's points are undecided", async () => {
    const out = await call(ruleScore, {
      value: SLOW.text,
      rules: [
        { id: "slow", when: slow, points: 10 },
        { id: "yes", when: yes, points: 1 },
      ],
      bands: [{ name: "hot", min: 5 }],
    });
    // 0.7.0: score 1, band null, as if the slow rule had not fired.
    expect(out).toMatchObject({ score: null, rawScore: null, band: null });
    expect(out.undetermined).toEqual([
      { id: "slow", reason: expect.stringMatching(/could not evaluate/) },
    ]);
  }, 20_000);

  test("LeadAssign refuses rather than hand the lead past an owner it could not decide", async () => {
    const out = await call(leadAssign, {
      value: SLOW.text,
      strategy: "first",
      owners: [
        { id: "slow", when: slow },
        { id: "yes", when: yes },
      ],
      fallback: { id: "queue" },
    });
    expect(out).toMatchObject({ ok: false, assigned: false, owner: null });
    expect(out.conflict).toMatch(/owner "slow" could not be decided/);
  }, 20_000);

  test("SequenceRun holds a step it could not decide, and is blocked on it", async () => {
    const out = await call(sequenceRun, {
      value: SLOW.text,
      steps: [{ id: "slow", when: slow }, { id: "after", needs: ["slow"] }, { id: "free" }],
      now: "2026-01-01T00:00:00Z",
    });
    // 0.7.0: "slow" skipped, "after" unreachable, and the flow finished once
    // "free" ran.
    expect(out.ready.map((s: { id: string }) => s.id)).toEqual(["free"]);
    expect(out.skipped).toEqual([]);
    expect(out.unreachable).toEqual([]);
    expect(out.undetermined).toEqual([
      { id: "slow", reason: expect.stringMatching(/could not evaluate/) },
    ]);
    const next = await call(sequenceRun, {
      value: SLOW.text,
      steps: [{ id: "slow", when: slow }, { id: "after", needs: ["slow"] }, { id: "free" }],
      completed: ["free"],
      now: "2026-01-01T00:00:00Z",
    });
    expect(next.state).toBe("blocked");
  }, 20_000);

  test("a refused pattern fails its check, as an invalid regex always has", async () => {
    const out = await call(branch, {
      value: `${"a".repeat(30)}! refund`,
      arms: [
        { name: "bad", when: [{ op: "matches", expected: CATASTROPHIC }] },
        { name: "later", when: [{ op: "matches", expected: "refund" }] },
      ],
      verbose: true,
    });
    expect(out).toMatchObject({ matched: true, name: "later" });
    expect(out.evaluated[0].reason).toMatch(/invalid regex .*nested-quantifier/);
  });
});
