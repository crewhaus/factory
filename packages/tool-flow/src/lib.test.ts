/**
 * The behaviour of the pure functions under `./lib`.
 *
 * This is where the edge cases live — the divide-by-zero that would read as
 * "plenty of budget left", the tie that would read as a decision, the
 * catch-all arm that would swallow a table. The tool wrappers in
 * `index.test.ts` test the contract; this tests the thinking.
 */
import { describe, expect, test } from "bun:test";
import { assignOwner } from "./lib/assign";
import { evaluateBranches } from "./lib/branch";
import { jaccard, normalizeValue, tallyVotes } from "./lib/consensus";
import { checkDeadline } from "./lib/deadline";
import { evaluateTable, hashTable } from "./lib/decision";
import { classifyError, parseRetryAfter } from "./lib/errors";
import { scoreValue } from "./lib/score";
import { planSequence } from "./lib/sequence";
import { detectStall } from "./lib/stall";

describe("evaluateBranches", () => {
  const arms = [
    { name: "client", when: [{ path: "status", op: "lessThan" as const, expected: 500 }] },
    {
      name: "server",
      when: [{ path: "status", op: "greaterThanOrEqual" as const, expected: 500 }],
    },
  ];

  test("the first matching arm wins", () => {
    const outcome = evaluateBranches({ status: 404 }, arms);
    expect(outcome.matched).toBe(true);
    expect(outcome.name).toBe("client");
    expect(outcome.index).toBe(0);
  });

  test("arms after the winner are never evaluated", () => {
    const outcome = evaluateBranches({ status: 404 }, arms);
    expect(outcome.evaluated.map((a) => a.name)).toEqual(["client"]);
  });

  test("a later arm's broken check cannot affect an earlier arm's win", () => {
    const outcome = evaluateBranches({ status: 404 }, [
      arms[0] as (typeof arms)[number],
      { name: "broken", when: [{ path: "status", op: "matches" as const, expected: "([a-" }] },
    ]);
    expect(outcome.name).toBe("client");
  });

  test("the report says why an arm missed", () => {
    const outcome = evaluateBranches({ status: 503 }, arms);
    expect(outcome.name).toBe("server");
    expect(outcome.evaluated[0]?.ok).toBe(false);
    expect(outcome.evaluated[0]?.reason).not.toBe("");
  });

  test("otherwise supplies the fallback", () => {
    const outcome = evaluateBranches(
      { status: 200 },
      [{ name: "bad", when: [{ path: "status", op: "greaterThan" as const, expected: 400 }] }],
      { otherwise: { name: "fine", result: { go: true } } },
    );
    expect(outcome).toMatchObject({ matched: true, name: "fine", fallback: true, index: null });
    expect(outcome.result).toEqual({ go: true });
  });

  test("without otherwise, no match is reported as no match", () => {
    const outcome = evaluateBranches({ status: 200 }, [
      { name: "bad", when: [{ path: "status", op: "greaterThan" as const, expected: 400 }] },
    ]);
    expect(outcome).toMatchObject({ matched: false, name: null, result: undefined });
  });

  test("match:any needs only one check to hold", () => {
    const outcome = evaluateBranches({ a: 1, b: 2 }, [
      {
        name: "either",
        match: "any" as const,
        when: [
          { path: "a", op: "equals" as const, expected: 99 },
          { path: "b", op: "equals" as const, expected: 2 },
        ],
      },
    ]);
    expect(outcome.matched).toBe(true);
  });

  test("an arm with no checks is rejected, not treated as a catch-all", () => {
    expect(() => evaluateBranches(1, [{ name: "any", when: [] }])).toThrow(/no checks/);
  });

  test("two arms with one name are rejected", () => {
    const dup = { name: "same", when: [{ path: "a", op: "exists" as const }] };
    expect(() => evaluateBranches(1, [dup, dup])).toThrow(/both named/);
  });

  test("no arms at all is an error", () => {
    expect(() => evaluateBranches(1, [])).toThrow(/no branch arms/);
  });
});

describe("evaluateTable", () => {
  const rows = [
    {
      id: "vip",
      when: [{ path: "tier", op: "equals" as const, expected: "enterprise" }],
      priority: 10,
      outputs: { queue: "P1" },
    },
    {
      id: "sev",
      when: [{ path: "severity", op: "equals" as const, expected: "high" }],
      priority: 5,
      outputs: { queue: "P2" },
    },
  ];
  const value = { tier: "enterprise", severity: "high" };

  test("first takes the earliest match and stops looking", () => {
    const result = evaluateTable(value, { policy: "first", rows });
    expect(result.matchedIds).toEqual(["vip"]);
    expect(result.outputs).toEqual({ queue: "P1" });
  });

  test("collect returns every match, in declared order", () => {
    const result = evaluateTable(value, { policy: "collect", rows });
    expect(result.matchedIds).toEqual(["vip", "sev"]);
    expect(result.outputs).toEqual([{ queue: "P1" }, { queue: "P2" }]);
  });

  test("priority takes the highest, whatever order the rows are in", () => {
    const reversed = { policy: "priority" as const, rows: [...rows].reverse() };
    expect(evaluateTable(value, reversed).outputs).toEqual({ queue: "P1" });
  });

  test("unique reports the overlap rather than picking one", () => {
    const result = evaluateTable(value, { policy: "unique", rows });
    expect(result.ok).toBe(false);
    expect(result.matched).toBe(false);
    expect(result.outputs).toBeNull();
    expect(result.conflict).toContain("vip");
    expect(result.conflict).toContain("sev");
  });

  test("unique is satisfied when exactly one row matches", () => {
    const result = evaluateTable({ tier: "enterprise" }, { policy: "unique", rows });
    expect(result.ok).toBe(true);
    expect(result.outputs).toEqual({ queue: "P1" });
  });

  test("a priority tie is a conflict, not an arbitrary winner", () => {
    const tied = rows.map((r) => ({ ...r, priority: 1 }));
    const result = evaluateTable(value, { policy: "priority", rows: tied });
    expect(result.ok).toBe(false);
    expect(result.conflict).toContain("share the top priority");
  });

  test("otherwise answers a miss, and says it was the fallback", () => {
    const result = evaluateTable({}, { policy: "first", rows, otherwise: { queue: "P4" } });
    expect(result).toMatchObject({ matched: true, fallback: true, matchedIds: [] });
    expect(result.outputs).toEqual({ queue: "P4" });
  });

  test("a miss with no otherwise is not an error", () => {
    const result = evaluateTable({}, { policy: "first", rows });
    expect(result).toMatchObject({ ok: true, matched: false, outputs: null, conflict: null });
  });

  test("the version is echoed so a decision is attributable", () => {
    expect(evaluateTable(value, { policy: "first", rows, version: "2026-Q3" }).version).toBe(
      "2026-Q3",
    );
  });

  test("the digest ignores key order, so reformatting is not a policy change", () => {
    const a = { policy: "first" as const, rows: [{ ...rows[0] } as (typeof rows)[number]] };
    const reordered = {
      policy: "first" as const,
      rows: [
        {
          outputs: { queue: "P1" },
          priority: 10,
          when: [{ expected: "enterprise", op: "equals" as const, path: "tier" }],
          id: "vip",
        },
      ],
    };
    expect(hashTable(a)).toBe(hashTable(reordered));
  });

  test("the digest changes when a threshold does", () => {
    const a = { policy: "first" as const, rows };
    const b = {
      policy: "first" as const,
      rows: [{ ...(rows[0] as (typeof rows)[number]), outputs: { queue: "P3" } }, rows[1]],
    };
    expect(hashTable(a)).not.toBe(hashTable(b as typeof a));
  });

  test("the version is a label, not part of the digest", () => {
    expect(hashTable({ policy: "first", rows, version: "v1" })).toBe(
      hashTable({ policy: "first", rows, version: "v2" }),
    );
  });

  test("duplicate row ids are rejected", () => {
    expect(() =>
      evaluateTable(value, { policy: "first", rows: [rows[0], rows[0]] as typeof rows }),
    ).toThrow(/share the id/);
  });

  test("a row with no checks is rejected", () => {
    expect(() =>
      evaluateTable(value, { policy: "first", rows: [{ id: "x", when: [], outputs: {} }] }),
    ).toThrow(/matches everything/);
  });

  test("an empty table is rejected", () => {
    expect(() => evaluateTable(value, { policy: "first", rows: [] })).toThrow(/no rows/);
  });
});

describe("classifyError", () => {
  test("a 429 with Retry-After seconds gives the wait the server asked for", () => {
    expect(classifyError({ status: 429, retryAfter: "30" })).toMatchObject({
      class: "rate_limited",
      action: "retry_after",
      retryable: true,
      waitMs: 30_000,
    });
  });

  test("a Retry-After date needs a now to become a wait", () => {
    const at = "Thu, 01 Jan 2026 00:00:30 GMT";
    const without = classifyError({ status: 503, retryAfter: at });
    expect(without.waitMs).toBeNull();
    expect(without.retryAt).toBe("2026-01-01T00:00:30.000Z");

    const withNow = classifyError(
      { status: 503, retryAfter: at },
      { nowMs: Date.parse("2026-01-01T00:00:00Z") },
    );
    expect(withNow.waitMs).toBe(30_000);
  });

  test("a Retry-After date already past means retry now, not a negative wait", () => {
    const result = classifyError(
      { status: 503, retryAfter: "Thu, 01 Jan 2026 00:00:00 GMT" },
      { nowMs: Date.parse("2026-01-01T01:00:00Z") },
    );
    expect(result.waitMs).toBe(0);
  });

  test("retry_after with no usable wait degrades to a backoff", () => {
    expect(classifyError({ status: 429 }).action).toBe("backoff");
  });

  test("statuses outside the table fall back by class", () => {
    expect(classifyError({ status: 201 }).class).toBe("ok");
    expect(classifyError({ status: 301 }).class).toBe("redirect");
    expect(classifyError({ status: 418 }).class).toBe("bad_request");
    expect(classifyError({ status: 599 }).class).toBe("transient");
  });

  test("exit codes carry their agreed meanings", () => {
    expect(classifyError({ exitCode: 0 })).toMatchObject({ class: "ok", action: "continue" });
    expect(classifyError({ exitCode: 127 }).class).toBe("not_found");
    expect(classifyError({ exitCode: 126 }).class).toBe("permission");
    expect(classifyError({ exitCode: 124 }).class).toBe("timeout");
  });

  test("exit code 1 claims nothing, because it means nothing", () => {
    expect(classifyError({ exitCode: 1 })).toMatchObject({ class: "unknown", source: "default" });
  });

  test("128+N is read as the signal it encodes", () => {
    expect(classifyError({ exitCode: 139 })).toMatchObject({ class: "bug", source: "signal" });
    expect(classifyError({ exitCode: 130 }).class).toBe("cancelled");
  });

  test("an OOM kill is not reported as retryable", () => {
    // Class `capacity` is retryable by default; this particular one resolves
    // to `escalate`, and the boolean has to follow the action or a caller
    // re-runs the identical command and is killed identically.
    const result = classifyError({ exitCode: 137 });
    expect(result).toMatchObject({ class: "capacity", action: "escalate", retryable: false });
  });

  test("errno codes are classified", () => {
    expect(classifyError({ code: "ECONNRESET" })).toMatchObject({
      class: "transient",
      retryable: true,
    });
    expect(classifyError({ code: "ENOSPC" }).class).toBe("capacity");
    expect(classifyError({ code: "EACCES" }).class).toBe("permission");
  });

  test("a temporary resolver failure is separated from a real NXDOMAIN", () => {
    expect(classifyError({ code: "EAI_AGAIN" }).retryable).toBe(true);
    expect(classifyError({ code: "ENOTFOUND" }).retryable).toBe(false);
  });

  test("message signatures are the last resort, and the specific one wins", () => {
    expect(classifyError({ message: "Error: 429 Too Many Requests" }).class).toBe("rate_limited");
    expect(classifyError({ message: "maximum context length is 200000 tokens" })).toMatchObject({
      class: "too_large",
      action: "reduce_input",
    });
    expect(classifyError({ message: "your credit balance is too low" }).class).toBe("quota");
  });

  test("signals outrank a message, and a status outranks both", () => {
    const result = classifyError({ status: 404, code: "ECONNRESET", message: "rate limit" });
    expect(result).toMatchObject({ class: "not_found", source: "status" });
  });

  test("running out of attempts turns a retry into an escalation", () => {
    // 503 maps to retry_after; with no Retry-After header to supply a wait it
    // degrades to a backoff, which is still a retry action.
    const fresh = classifyError({ status: 503, attempt: 1, maxAttempts: 5 });
    expect(fresh).toMatchObject({ action: "backoff", retryable: true, exhausted: false });

    const spent = classifyError({ status: 503, attempt: 5, maxAttempts: 5 });
    expect(spent).toMatchObject({ action: "escalate", retryable: false, exhausted: true });
  });

  test("exhaustion does not rewrite an action that was never a retry", () => {
    const result = classifyError({ status: 401, attempt: 3, maxAttempts: 3 });
    expect(result).toMatchObject({ action: "reauth", exhausted: true });
  });

  test("caller rules are tried before every builtin pack", () => {
    const result = classifyError(
      { status: 404, message: "tenant not provisioned yet" },
      {
        rules: [
          {
            id: "provisioning",
            contains: "not provisioned",
            class: "transient",
            action: "backoff",
          },
        ],
      },
    );
    expect(result).toMatchObject({ class: "transient", source: "custom", matched: "provisioning" });
  });

  test("a rule matches the message or the code, not the two joined together", () => {
    // Joining them would break an anchored pattern, and an anchored pattern
    // that can never match is the worst case for a backtracking engine.
    const anchored = {
      id: "tail",
      matches: "timeout$",
      class: "timeout" as const,
      action: "retry" as const,
    };
    expect(
      classifyError({ message: "connection timeout", code: "EGENERIC" }, { rules: [anchored] }),
    ).toMatchObject({ source: "custom", matched: "tail" });
  });

  test("a rule with no conditions is rejected rather than matching everything", () => {
    expect(() =>
      classifyError({ status: 500 }, { rules: [{ id: "oops", class: "ok", action: "continue" }] }),
    ).toThrow(/no conditions/);
  });

  test("a rule with an invalid pattern names itself in the error", () => {
    expect(() =>
      classifyError(
        { message: "x" },
        { rules: [{ id: "bad", matches: "([a-", class: "ok", action: "continue" }] },
      ),
    ).toThrow(/rule "bad"/);
  });

  test("an unrecognised failure escalates rather than being retried blindly", () => {
    expect(classifyError({ message: "flurb" })).toMatchObject({
      class: "unknown",
      action: "escalate",
      retryable: false,
    });
  });

  test("a huge hostile message does not become a hang", () => {
    // The builtin packs are substrings, not patterns, precisely because this
    // text comes from a remote server.
    const message = `${"a(".repeat(200_000)}rate limit`;
    const started = performance.now();
    const result = classifyError({ message });
    expect(performance.now() - started).toBeLessThan(500);
    // Truncated well before the signature, so it lands in the default class.
    expect(result.class).toBe("unknown");
  });

  test("parseRetryAfter handles both legal forms and rejects the rest", () => {
    expect(parseRetryAfter("120")).toEqual({ waitMs: 120_000, retryAt: null });
    expect(parseRetryAfter("")).toEqual({ waitMs: null, retryAt: null });
    expect(parseRetryAfter("soon")).toEqual({ waitMs: null, retryAt: null });
  });
});

describe("checkDeadline", () => {
  const start = Date.parse("2026-01-01T00:00:00Z");

  test("a budget becomes a deadline", () => {
    const report = checkDeadline({ nowMs: start, budgetMs: 60_000, startedAtMs: start });
    expect(report.deadline).toBe("2026-01-01T00:01:00.000Z");
    expect(report.remainingMs).toBe(60_000);
    expect(report.fractionRemaining).toBe(1);
    expect(report.phase).toBe("ample");
  });

  test("the phase tracks the fraction left", () => {
    const at = (ms: number) =>
      checkDeadline({ nowMs: start + ms, budgetMs: 100_000, startedAtMs: start }).phase;
    expect(at(0)).toBe("ample");
    expect(at(50_000)).toBe("tight");
    expect(at(80_000)).toBe("critical");
    expect(at(100_001)).toBe("expired");
  });

  test("an expired budget reports negative remaining time, not zero", () => {
    const report = checkDeadline({ nowMs: start + 90_000, budgetMs: 60_000, startedAtMs: start });
    expect(report.expired).toBe(true);
    expect(report.remainingMs).toBe(-30_000);
    expect(report.fractionRemaining).toBe(0);
  });

  test("a zero-length budget is spent, not infinite", () => {
    // remaining/total would be NaN here, and NaN compares false against every
    // threshold — which would fall through to "ample", the worst answer.
    const report = checkDeadline({ nowMs: start, budgetMs: 0, startedAtMs: start });
    expect(Number.isNaN(report.fractionRemaining)).toBe(false);
    expect(report.fractionRemaining).toBe(0);
    expect(report.phase).toBe("expired");
  });

  test("a step cost says whether one more unit fits, and how many do", () => {
    const report = checkDeadline({
      nowMs: start + 40_000,
      budgetMs: 100_000,
      startedAtMs: start,
      stepCostMs: 25_000,
    });
    expect(report.fits).toBe(true);
    expect(report.stepsRemaining).toBe(2);
  });

  test("nothing fits once the budget is gone", () => {
    const report = checkDeadline({
      nowMs: start + 200_000,
      budgetMs: 100_000,
      startedAtMs: start,
      stepCostMs: 1,
    });
    expect(report.fits).toBe(false);
    expect(report.stepsRemaining).toBe(0);
  });

  test("without a step cost, the fit questions are answered null rather than guessed", () => {
    const report = checkDeadline({ nowMs: start, budgetMs: 1000 });
    expect(report.fits).toBeNull();
    expect(report.stepsRemaining).toBeNull();
  });

  test("an inverted threshold pair is rejected", () => {
    expect(() =>
      checkDeadline({ nowMs: start, budgetMs: 10, tightAt: 0.1, criticalAt: 0.9 }),
    ).toThrow(/must not be above/);
  });

  test("neither a deadline nor a budget is an error", () => {
    expect(() => checkDeadline({ nowMs: start })).toThrow(/deadlineMs or budgetMs/);
  });
});

describe("tallyVotes", () => {
  test("weighted plurality, with the agreement fraction that qualifies it", () => {
    const result = tallyVotes([
      { value: "a", voter: "x" },
      { value: "a", voter: "y" },
      { value: "b", voter: "z" },
    ]);
    expect(result).toMatchObject({ winner: "a", support: 2, total: 3, decided: true });
    expect(result.agreement).toBeCloseTo(2 / 3);
    expect(result.dissenters).toEqual(["z"]);
  });

  test("weights count, not heads", () => {
    const result = tallyVotes([
      { value: "a", weight: 1, voter: "x" },
      { value: "b", weight: 5, voter: "y" },
    ]);
    expect(result.winner).toBe("b");
  });

  test("a tie is never decided, however high the fraction", () => {
    // Two answers at 50% each would both clear a 0.5 threshold.
    const result = tallyVotes([
      { value: "a", voter: "x" },
      { value: "b", voter: "y" },
    ]);
    expect(result).toMatchObject({ tie: true, decided: false });
    expect(result.agreement).toBe(0.5);
  });

  test("a plurality below the threshold is reported, not decided", () => {
    const result = tallyVotes(
      [{ value: "a" }, { value: "a" }, { value: "b" }, { value: "c" }, { value: "d" }],
      { threshold: 0.6 },
    );
    expect(result).toMatchObject({ winner: "a", decided: false });
  });

  test("unanimity is stated explicitly", () => {
    expect(tallyVotes([{ value: 1 }, { value: 1 }])).toMatchObject({
      unanimous: true,
      agreement: 1,
      dissenters: [],
    });
  });

  test("ties in weight break by first appearance, so the answer is stable", () => {
    const first = tallyVotes([{ value: "a" }, { value: "b" }]).winner;
    expect(tallyVotes([{ value: "a" }, { value: "b" }]).winner).toBe(first);
    expect(first).toBe("a");
  });

  test("numeric mode groups within a tolerance", () => {
    const result = tallyVotes([{ value: 10.0 }, { value: 10.2 }, { value: 42 }], {
      mode: "numeric",
      tolerance: 0.5,
    });
    expect(result.winner).toBe(10);
    expect(result.support).toBe(2);
  });

  test("numeric mode does not group non-numbers, or NaN with itself", () => {
    const result = tallyVotes([{ value: Number.NaN }, { value: Number.NaN }], { mode: "numeric" });
    expect(result.groups.length).toBe(2);
  });

  test("set mode groups by overlap", () => {
    const result = tallyVotes(
      [{ value: ["a", "b", "c"] }, { value: ["a", "b", "d"] }, { value: ["x"] }],
      { mode: "set", overlap: 0.4 },
    );
    expect(result.support).toBe(2);
  });

  test("normalization is applied before grouping", () => {
    const result = tallyVotes([{ value: " Yes " }, { value: "yes" }, { value: "YES!" }], {
      normalize: { lowercase: true, stripPunctuation: true, collapseWhitespace: true },
    });
    expect(result).toMatchObject({ unanimous: true, winner: "yes" });
  });

  test("all-zero weights give an agreement of zero, not NaN", () => {
    const result = tallyVotes([
      { value: "a", weight: 0 },
      { value: "b", weight: 0 },
    ]);
    expect(Number.isNaN(result.agreement)).toBe(false);
    expect(result.decided).toBe(false);
  });

  test("a negative weight is rejected", () => {
    expect(() => tallyVotes([{ value: "a", weight: -1 }])).toThrow(/non-negative/);
  });

  test("no votes at all is an error", () => {
    expect(() => tallyVotes([])).toThrow(/no votes/);
  });

  test("objects that differ only in key order are one answer, not two", () => {
    // Two models that agreed would otherwise be reported as dissenting, and
    // the escalation this tool exists to avoid would fire on agreement.
    const result = tallyVotes([
      { value: { label: "refund", confidence: 0.9 }, voter: "m1" },
      { value: { confidence: 0.9, label: "refund" }, voter: "m2" },
    ]);
    expect(result).toMatchObject({ unanimous: true, agreement: 1 });
    expect(result.dissenters).toEqual([]);
  });

  test("array order is still content, because in an array it is", () => {
    const result = tallyVotes([{ value: [1, 2] }, { value: [2, 1] }]);
    expect(result.groups.length).toBe(2);
  });

  test("jaccard ignores key order inside members", () => {
    expect(jaccard([{ a: 1, b: 2 }], [{ b: 2, a: 1 }])).toBe(1);
  });

  test("jaccard is 1 for two empty sets and 0 for disjoint ones", () => {
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a"], ["b"])).toBe(0);
  });

  test("normalizeValue leaves non-strings alone", () => {
    expect(normalizeValue(42, { lowercase: true })).toBe(42);
  });
});

describe("detectStall", () => {
  const snap = (t: string) => ({ tests: t });

  test("identical snapshots for the whole window is a stall", () => {
    const result = detectStall([snap("a"), snap("a"), snap("a")], { window: 3 });
    expect(result).toMatchObject({
      stalled: true,
      reason: "unchanged",
      repeats: 3,
      cycleLength: 1,
    });
  });

  test("a changing signal is progress", () => {
    const result = detectStall([snap("a"), snap("b"), snap("c")], { window: 3 });
    expect(result).toMatchObject({ stalled: false, reason: "progressing" });
    expect(result.changed).toEqual(["tests"]);
  });

  test("an A-B-A-B loop is caught even though nothing repeats twice in a row", () => {
    const result = detectStall([snap("a"), snap("b"), snap("a"), snap("b")], { window: 3 });
    expect(result).toMatchObject({ stalled: true, reason: "oscillating", cycleLength: 2 });
  });

  test("a three-state cycle is caught too", () => {
    const history = ["a", "b", "c", "a", "b", "c"].map(snap);
    expect(detectStall(history, { window: 3, maxCycle: 3 })).toMatchObject({
      reason: "oscillating",
      cycleLength: 3,
    });
  });

  test("a cycle longer than maxCycle is not claimed", () => {
    const history = ["a", "b", "c", "d", "a", "b", "c", "d"].map(snap);
    expect(detectStall(history, { window: 3, maxCycle: 3 }).stalled).toBe(false);
  });

  test("too little history says so rather than claiming progress", () => {
    const result = detectStall([snap("a")], { window: 3 });
    expect(result).toMatchObject({ stalled: false, reason: "insufficient", observed: 1 });
  });

  test("signals that never moved are named", () => {
    const history = [
      { tests: "a", diff: "z" },
      { tests: "b", diff: "z" },
      { tests: "c", diff: "z" },
    ];
    expect(detectStall(history, { window: 3 }).frozen).toEqual(["diff"]);
  });

  test("the signal filter decides what counts as progress", () => {
    const history = [
      { tests: "a", spinner: "1" },
      { tests: "a", spinner: "2" },
      { tests: "a", spinner: "3" },
    ];
    expect(detectStall(history, { window: 3 }).stalled).toBe(false);
    expect(detectStall(history, { window: 3, signals: ["tests"] })).toMatchObject({
      stalled: true,
      reason: "unchanged",
    });
  });

  test("key order in a snapshot does not matter", () => {
    const a = { x: "1", y: "2" };
    const b = { y: "2", x: "1" };
    expect(detectStall([a, b, a], { window: 3 }).reason).toBe("unchanged");
  });

  test("a separator inside a fingerprint cannot make two snapshots collide", () => {
    // Fingerprints are opaque caller text; joining them with any delimiter
    // would let a crafted one impersonate a different pair of signals.
    // Under a naive `name=value` joined by commas, both of these render as
    // "a=1,b=2" and the loop would look frozen while it was moving.
    const a = { a: "1,b=2" };
    const b = { a: "1", b: "2" };
    expect(detectStall([a, b, a], { window: 3 }).reason).not.toBe("unchanged");
    expect(detectStall([a, a, a], { window: 3 }).reason).toBe("unchanged");
  });

  test("a window below 2 is rejected", () => {
    expect(() => detectStall([snap("a")], { window: 1 })).toThrow(/at least 2/);
  });
});

describe("scoreValue", () => {
  const model = {
    version: "2026-Q3",
    rules: [
      {
        id: "seats",
        when: [{ path: "seats", op: "greaterThan" as const, expected: 100 }],
        points: 30,
        label: "over 100 seats",
      },
      {
        id: "trial",
        when: [{ path: "plan", op: "equals" as const, expected: "trial" }],
        points: -10,
      },
    ],
    bands: [
      { name: "cold", min: 0 },
      { name: "hot", min: 25 },
    ],
  };

  test("fired rules are summed and attributed", () => {
    const result = scoreValue({ seats: 500, plan: "ent" }, model);
    expect(result.score).toBe(30);
    expect(result.band).toBe("hot");
    expect(result.version).toBe("2026-Q3");
    expect(result.contributors).toEqual([{ id: "seats", label: "over 100 seats", points: 30 }]);
  });

  test("negative points subtract", () => {
    expect(scoreValue({ seats: 500, plan: "trial" }, model).score).toBe(20);
  });

  test("rules that missed carry the reason they missed", () => {
    const result = scoreValue({ seats: 5, plan: "ent" }, model);
    expect(result.score).toBe(0);
    expect(result.missed.map((m) => m.id)).toEqual(["seats", "trial"]);
    expect(result.missed[0]?.reason).not.toBe("");
  });

  test("the highest qualifying band wins, in either declaration order", () => {
    const reversed = { ...model, bands: [...model.bands].reverse() };
    expect(scoreValue({ seats: 500, plan: "ent" }, reversed).band).toBe("hot");
  });

  test("a score below every band gets no band rather than the lowest", () => {
    const strict = { ...model, bands: [{ name: "hot", min: 1000 }] };
    expect(scoreValue({ seats: 500, plan: "ent" }, strict).band).toBeNull();
  });

  test("clamping is visible: the raw sum is kept alongside", () => {
    const capped = { ...model, max: 10 };
    const result = scoreValue({ seats: 500, plan: "ent" }, capped);
    expect(result).toMatchObject({ score: 10, rawScore: 30 });
  });

  test("the band is chosen from the clamped score", () => {
    const capped = { ...model, max: 10 };
    expect(scoreValue({ seats: 500, plan: "ent" }, capped).band).toBe("cold");
  });

  test("a rule with no checks would always fire, so it is rejected", () => {
    expect(() => scoreValue({}, { rules: [{ id: "x", when: [], points: 1 }] })).toThrow(
      /always award/,
    );
  });

  test("duplicate rule ids are rejected", () => {
    const dup = { id: "x", when: [{ path: "a", op: "exists" as const }], points: 1 };
    expect(() => scoreValue({}, { rules: [dup, dup] })).toThrow(/share the id/);
  });

  test("non-finite points are rejected", () => {
    expect(() =>
      scoreValue({}, { rules: [{ id: "x", when: [{ op: "exists" }], points: Number.NaN }] }),
    ).toThrow(/non-finite/);
  });

  test("an inverted clamp is rejected", () => {
    expect(() =>
      scoreValue(
        {},
        { rules: [{ id: "x", when: [{ op: "exists" }], points: 1 }], min: 10, max: 1 },
      ),
    ).toThrow(/above max/);
  });

  test("an empty model is rejected", () => {
    expect(() => scoreValue({}, { rules: [] })).toThrow(/no rules/);
  });
});

describe("assignOwner", () => {
  const roster = [
    {
      id: "ana",
      when: [
        { path: "country", op: "equals" as const, expected: "DE" },
        { path: "state", op: "equals" as const, expected: "BY" },
      ],
    },
    { id: "bo", when: [{ path: "country", op: "equals" as const, expected: "DE" }] },
    { id: "cy", when: [{ path: "country", op: "equals" as const, expected: "FR" }] },
  ];
  const lead = { country: "DE", state: "BY" };

  test("first takes the earliest eligible owner", () => {
    const result = assignOwner(lead, { strategy: "first", owners: roster });
    expect(result).toMatchObject({ ok: true, assigned: true, owner: "ana", fallback: false });
    expect(result.eligible).toEqual(["ana", "bo"]);
  });

  test("specific prefers the narrower territory, whatever order it was written in", () => {
    const reversed = [roster[1] as (typeof roster)[number], roster[0] as (typeof roster)[number]];
    expect(assignOwner(lead, { strategy: "specific", owners: reversed }).owner).toBe("ana");
  });

  test("two equally specific territories are a conflict, not a coin toss", () => {
    const result = assignOwner(lead, {
      strategy: "specific",
      owners: [
        { id: "ana", when: [{ path: "country", op: "equals", expected: "DE" }] },
        { id: "bo", when: [{ path: "state", op: "equals", expected: "BY" }] },
      ],
    });
    expect(result).toMatchObject({ ok: false, assigned: false, owner: null });
    expect(result.conflict).toContain("ana");
    expect(result.conflict).toContain("bo");
  });

  test("specific ranks the territory as declared, not whatever the record happened to satisfy", () => {
    // A `match: "any"` owner requires exactly one condition however many
    // happen to hold, so counting the holders ranks the record rather than
    // the roster: the same two territories would swap places lead by lead
    // over fields neither of them asked for.
    const owners = [
      {
        id: "broad",
        match: "any" as const,
        when: [
          { path: "country", op: "equals" as const, expected: "DE" },
          { path: "language", op: "equals" as const, expected: "de" },
          { path: "tier", op: "equals" as const, expected: "smb" },
        ],
      },
      {
        id: "narrow",
        when: [
          { path: "country", op: "equals" as const, expected: "DE" },
          { path: "state", op: "equals" as const, expected: "BY" },
        ],
      },
    ];
    const bavarian = { country: "DE", state: "BY" };
    expect(
      assignOwner({ ...bavarian, language: "de", tier: "smb" }, { strategy: "specific", owners })
        .owner,
    ).toBe("narrow");
    expect(
      assignOwner(
        { ...bavarian, language: "fr", tier: "enterprise" },
        { strategy: "specific", owners },
      ).owner,
    ).toBe("narrow");
  });

  test("an owner whose room could not be worked out is not reported as eligible", () => {
    // The per-owner report is what a rep is shown when they ask why a lead
    // went elsewhere. Recording "eligible, no reason" for the very owner the
    // roster could not rank states a fact the tool does not have.
    const result = assignOwner(lead, {
      strategy: "first",
      owners: [
        { id: "ana", when: [{ path: "country", op: "equals", expected: "DE" }], capacity: 20 },
        { id: "bo", when: [{ path: "country", op: "equals", expected: "DE" }], load: 1 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.considered[0]).toMatchObject({ id: "ana", eligible: null });
    expect(result.considered[0]?.reason).toContain("capacity");
    expect(result.eligible).toEqual(["bo"]);
  });

  test("least_loaded takes the lightest, and a tie goes to the earlier declaration", () => {
    const owners = [
      { id: "ana", when: [{ path: "country", op: "equals" as const, expected: "DE" }], load: 4 },
      { id: "bo", when: [{ path: "country", op: "equals" as const, expected: "DE" }], load: 1 },
      { id: "cy", when: [{ path: "country", op: "equals" as const, expected: "DE" }], load: 1 },
    ];
    expect(assignOwner(lead, { strategy: "least_loaded", owners }).owner).toBe("bo");
  });

  test("an eligible owner with no load makes least_loaded refuse rather than rank them as zero", () => {
    const result = assignOwner(lead, {
      strategy: "least_loaded",
      owners: [
        { id: "ana", when: [{ path: "country", op: "equals", expected: "DE" }], load: 7 },
        { id: "bo", when: [{ path: "country", op: "equals", expected: "DE" }] },
      ],
    });
    expect(result).toMatchObject({ ok: false, assigned: false, owner: null });
    expect(result.conflict).toContain("bo");
    expect(result.conflict).toContain("least_loaded");
  });

  test("an undecidable roster does not fall through to the catch-all owner", () => {
    // Routing "I could not work out who" to the fallback would bury a broken
    // roster in one rep's inbox until somebody audited the quarter.
    const result = assignOwner(lead, {
      strategy: "least_loaded",
      owners: [{ id: "bo", when: [{ path: "country", op: "equals", expected: "DE" }] }],
      fallback: { id: "queue" },
    });
    expect(result).toMatchObject({ ok: false, owner: null, fallback: false });
  });

  test("a missing load on an owner who was ruled out anyway is not a problem", () => {
    const result = assignOwner(lead, {
      strategy: "least_loaded",
      owners: [
        { id: "ana", when: [{ path: "country", op: "equals", expected: "DE" }], load: 7 },
        { id: "cy", when: [{ path: "country", op: "equals", expected: "FR" }] },
      ],
    });
    expect(result).toMatchObject({ ok: true, owner: "ana" });
  });

  test("an owner at capacity is skipped, with the numbers in the reason", () => {
    const result = assignOwner(lead, {
      strategy: "first",
      owners: [
        {
          id: "ana",
          when: [{ path: "country", op: "equals", expected: "DE" }],
          load: 20,
          capacity: 20,
        },
        { id: "bo", when: [{ path: "country", op: "equals", expected: "DE" }] },
      ],
    });
    expect(result.owner).toBe("bo");
    expect(result.considered[0]).toMatchObject({ id: "ana", eligible: false });
    expect(result.considered[0]?.reason).toContain("20 of 20");
  });

  test("a capacity with no load is undetermined, not room to spare", () => {
    const result = assignOwner(lead, {
      strategy: "first",
      owners: [
        { id: "ana", when: [{ path: "country", op: "equals", expected: "DE" }], capacity: 20 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.conflict).toContain("capacity");
  });

  test("available:false takes an owner out; an absent flag does not", () => {
    const owners = [
      {
        id: "ana",
        when: [{ path: "country", op: "equals" as const, expected: "DE" }],
        available: false,
      },
      { id: "bo", when: [{ path: "country", op: "equals" as const, expected: "DE" }] },
    ];
    const result = assignOwner(lead, { strategy: "first", owners });
    expect(result.owner).toBe("bo");
    expect(result.considered[0]?.reason).toBe("unavailable");
  });

  test("round_robin walks the declared roster and hands back where it got to", () => {
    const owners = ["ana", "bo", "cy"].map((id) => ({
      id,
      when: [{ path: "country", op: "equals" as const, expected: "DE" }],
    }));
    const seen: string[] = [];
    let cursor: number | undefined;
    for (let i = 0; i < 4; i++) {
      const result = assignOwner(lead, { strategy: "round_robin", owners, cursor });
      seen.push(result.owner as string);
      cursor = result.cursor as number;
    }
    expect(seen).toEqual(["ana", "bo", "cy", "ana"]);
  });

  test("an owner going out of office does not re-deal everybody else's turn", () => {
    // The cursor counts positions in the declared roster, so with "bo" out
    // the rotation still resumes at "cy" rather than sliding a place.
    const owners = [
      { id: "ana", when: [{ path: "country", op: "equals" as const, expected: "DE" }] },
      {
        id: "bo",
        when: [{ path: "country", op: "equals" as const, expected: "DE" }],
        available: false,
      },
      { id: "cy", when: [{ path: "country", op: "equals" as const, expected: "DE" }] },
    ];
    const result = assignOwner(lead, { strategy: "round_robin", owners, cursor: 1 });
    expect(result).toMatchObject({ owner: "cy", cursor: 0 });
  });

  test("round_robin wraps past the end of the roster", () => {
    const owners = [
      { id: "ana", when: [{ path: "country", op: "equals" as const, expected: "DE" }] },
      { id: "cy", when: [{ path: "country", op: "equals" as const, expected: "FR" }] },
    ];
    expect(assignOwner(lead, { strategy: "round_robin", owners, cursor: 1 })).toMatchObject({
      owner: "ana",
      cursor: 1,
    });
  });

  test("a rotation that picked nobody leaves the cursor alone", () => {
    // The fallback is not in the rotation, so returning a new position would
    // skip a rep's turn every time a lead fell through to the queue.
    const result = assignOwner(
      { country: "JP" },
      {
        strategy: "round_robin",
        owners: [{ id: "ana", when: [{ path: "country", op: "equals", expected: "DE" }] }],
        cursor: 0,
        fallback: { id: "queue" },
      },
    );
    expect(result).toMatchObject({ owner: "queue", fallback: true, cursor: null });
  });

  test("nobody eligible with a fallback routes to the fallback", () => {
    const result = assignOwner(
      { country: "JP" },
      {
        strategy: "first",
        owners: roster,
        fallback: { id: "queue" },
      },
    );
    expect(result).toMatchObject({ ok: true, assigned: true, owner: "queue", fallback: true });
  });

  test("nobody eligible without a fallback is a settled no, not a failure", () => {
    const result = assignOwner({ country: "JP" }, { strategy: "first", owners: roster });
    expect(result).toMatchObject({ ok: true, assigned: false, owner: null, conflict: null });
    expect(result.considered).toHaveLength(3);
  });

  test("match:any lets one condition carry the owner", () => {
    const result = assignOwner(
      { country: "JP", language: "de" },
      {
        strategy: "first",
        owners: [
          {
            id: "ana",
            match: "any" as const,
            when: [
              { path: "country", op: "equals" as const, expected: "DE" },
              { path: "language", op: "equals" as const, expected: "de" },
            ],
          },
        ],
      },
    );
    expect(result.owner).toBe("ana");
  });

  test("an owner with no conditions is rejected, not treated as a catch-all", () => {
    expect(() => assignOwner(lead, { strategy: "first", owners: [{ id: "x", when: [] }] })).toThrow(
      /no conditions/,
    );
  });

  test("two owners with one id are rejected", () => {
    const dup = { id: "same", when: [{ path: "a", op: "exists" as const }] };
    expect(() => assignOwner(lead, { strategy: "first", owners: [dup, dup] })).toThrow(
      /share the id/,
    );
  });

  test("a non-finite load is rejected rather than compared", () => {
    expect(() =>
      assignOwner(lead, {
        strategy: "least_loaded",
        owners: [{ id: "x", when: [{ op: "exists" }], load: Number.NaN }],
      }),
    ).toThrow(/non-finite load/);
  });

  test("a fractional cursor is rejected", () => {
    expect(() =>
      assignOwner(lead, {
        strategy: "round_robin",
        owners: [{ id: "x", when: [{ op: "exists" }] }],
        cursor: 1.5,
      }),
    ).toThrow(/whole number/);
  });

  test("an empty roster is an error", () => {
    expect(() => assignOwner(lead, { strategy: "first", owners: [] })).toThrow(/no owners/);
  });
});

describe("planSequence", () => {
  const steps = [
    { id: "fetch", params: { url: "/a" } },
    { id: "parse", needs: ["fetch"] },
    { id: "store", needs: ["parse"] },
  ];
  const at = (nowMs: number) => ({ nowMs });

  test("the plan is the steps that can run now, and nothing else", () => {
    const plan = planSequence({}, { steps }, at(0));
    expect(plan.ready).toEqual([{ id: "fetch", index: 0, params: { url: "/a" } }]);
    expect(plan.next).toMatchObject({ id: "fetch" });
    expect(plan.waiting.map((w) => w.id)).toEqual(["parse", "store"]);
    expect(plan).toMatchObject({ state: "ready", total: 3 });
  });

  test("completing a step unlocks the next one", () => {
    const plan = planSequence({}, { steps }, { nowMs: 0, completed: ["fetch"] });
    expect(plan.ready.map((r) => r.id)).toEqual(["parse"]);
    expect(plan.completed).toEqual(["fetch"]);
  });

  test("a failed prerequisite makes a step unreachable, not waiting", () => {
    // A flow that reports "waiting" here hangs forever on a step that died
    // three turns ago.
    const plan = planSequence({}, { steps }, { nowMs: 0, failed: ["fetch"] });
    expect(plan.waiting).toEqual([]);
    expect(plan.unreachable.map((u) => u.id)).toEqual(["parse", "store"]);
    expect(plan.unreachable[0]?.reason).toContain("fetch");
    expect(plan.state).toBe("halted");
  });

  test("unreachability is transitive through the chain", () => {
    const plan = planSequence(
      { mode: "cold" },
      {
        steps: [
          { id: "a", when: [{ path: "mode", op: "equals" as const, expected: "warm" }] },
          { id: "b", needs: ["a"] },
          { id: "c", needs: ["b"] },
        ],
      },
      at(0),
    );
    expect(plan.skipped.map((s) => s.id)).toEqual(["a"]);
    expect(plan.unreachable.map((u) => u.id)).toEqual(["b", "c"]);
    expect(plan.unreachable[1]?.reason).toContain("unreachable");
  });

  test("a waiting step's own conditions are not evaluated yet", () => {
    // `parse` gates on a field `fetch` has not produced. Evaluating it now
    // would report a settled "skipped" about a context that does not exist.
    const plan = planSequence(
      {},
      {
        steps: [
          { id: "fetch" },
          {
            id: "parse",
            needs: ["fetch"],
            when: [{ path: "body", op: "isNotEmpty" as const }],
          },
        ],
      },
      at(0),
    );
    expect(plan.waiting.map((w) => w.id)).toEqual(["parse"]);
    expect(plan.skipped).toEqual([]);
  });

  test("a step that is not due yet is waiting, with how long is left", () => {
    const plan = planSequence({}, { steps: [{ id: "retry", afterMs: 5_000 }] }, at(1_000));
    expect(plan.waiting[0]).toMatchObject({ id: "retry", dueInMs: 4_000 });
    expect(plan.state).toBe("blocked");
  });

  test("the same step is in the plan once its time has come", () => {
    const plan = planSequence({}, { steps: [{ id: "retry", afterMs: 5_000 }] }, at(5_000));
    expect(plan.ready.map((r) => r.id)).toEqual(["retry"]);
  });

  test("the clock gate is read before the conditions, so a pending step is never a settled skip", () => {
    const plan = planSequence(
      { ok: false },
      {
        steps: [
          {
            id: "later",
            afterMs: 9_000,
            when: [{ path: "ok", op: "equals" as const, expected: true }],
          },
        ],
      },
      at(1_000),
    );
    expect(plan.waiting.map((w) => w.id)).toEqual(["later"]);
    expect(plan.skipped).toEqual([]);
  });

  test("everything finished is done, and nothing is left to plan", () => {
    const plan = planSequence({}, { steps }, { nowMs: 0, completed: ["fetch", "parse", "store"] });
    expect(plan).toMatchObject({ state: "finished", next: null });
    expect(plan.ready).toEqual([]);
  });

  test("a flow that ran out is finished; one that died is halted", () => {
    // A step whose conditions said no is a settled decision, so a flow that
    // only skipped is finished. A failed step is not, and calling both "done"
    // reports a cadence that died on its second step as one that completed.
    const skippedOnly = planSequence(
      { mode: "cold" },
      { steps: [{ id: "a", when: [{ path: "mode", op: "equals" as const, expected: "warm" }] }] },
      at(0),
    );
    expect(skippedOnly.state).toBe("finished");

    const died = planSequence({}, { steps: [{ id: "a" }] }, { nowMs: 0, failed: ["a"] });
    expect(died.state).toBe("halted");
  });

  test("the plan keeps the order the steps were declared in", () => {
    // The topological walk would put "b" before "c"; the caller wrote them
    // the other way round and a reshuffled plan reads as a reordering.
    const plan = planSequence(
      {},
      { steps: [{ id: "c", needs: ["a"] }, { id: "a" }, { id: "b" }] },
      { nowMs: 0, completed: ["a"] },
    );
    expect(plan.ready.map((r) => r.id)).toEqual(["c", "b"]);
  });

  test("a condition that cannot be evaluated reads as one that did not hold, and says why", () => {
    // Pinning the shared evaluator's behaviour rather than endorsing it: a
    // regex that will not compile is reported as a failing check, so the step
    // is skipped and its dependents are unreachable. The reason is the one
    // thing that distinguishes it, and it has to survive the cascade.
    const plan = planSequence(
      { name: "ana" },
      {
        steps: [
          { id: "a", when: [{ path: "name", op: "matches" as const, expected: "([a-" }] },
          { id: "b", needs: ["a"] },
        ],
      },
      at(0),
    );
    expect(plan.skipped[0]?.reason).toContain("invalid regex");
    expect(plan.unreachable.map((u) => u.id)).toEqual(["b"]);
  });

  test("a step with no params carries none", () => {
    const plan = planSequence({}, { steps: [{ id: "bare" }] }, at(0));
    expect(plan.ready[0]).toEqual({ id: "bare", index: 0 });
  });

  test("steps that depend on each other are rejected, not walked forever", () => {
    expect(() =>
      planSequence(
        {},
        {
          steps: [
            { id: "a", needs: ["b"] },
            { id: "b", needs: ["a"] },
          ],
        },
        at(0),
      ),
    ).toThrow(/cycle/);
  });

  test("a need naming a step that does not exist is rejected", () => {
    expect(() => planSequence({}, { steps: [{ id: "a", needs: ["ghost"] }] }, at(0))).toThrow(
      /not a step in this sequence/,
    );
  });

  test("a step that needs itself is rejected", () => {
    expect(() => planSequence({}, { steps: [{ id: "a", needs: ["a"] }] }, at(0))).toThrow(
      /needs itself/,
    );
  });

  test("progress naming a step that does not exist is rejected", () => {
    // A typo here would silently re-run a step the caller believes is done.
    expect(() =>
      planSequence({}, { steps: [{ id: "a" }] }, { nowMs: 0, completed: ["A"] }),
    ).toThrow(/completed names "A"/);
  });

  test("a step that is both completed and failed is rejected", () => {
    expect(() =>
      planSequence({}, { steps: [{ id: "a" }] }, { nowMs: 0, completed: ["a"], failed: ["a"] }),
    ).toThrow(/both completed and failed/);
  });

  test("an empty condition list is rejected, though an absent one is fine", () => {
    expect(() => planSequence({}, { steps: [{ id: "a", when: [] }] }, at(0))).toThrow(
      /empty condition list/,
    );
    expect(planSequence({}, { steps: [{ id: "a" }] }, at(0)).ready).toHaveLength(1);
  });

  test("two steps with one id are rejected", () => {
    expect(() => planSequence({}, { steps: [{ id: "a" }, { id: "a" }] }, at(0))).toThrow(
      /share the id/,
    );
  });

  test("an empty sequence is an error", () => {
    expect(() => planSequence({}, { steps: [] }, at(0))).toThrow(/no steps/);
  });
});
