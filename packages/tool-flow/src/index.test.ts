/**
 * Every tool this package registers, exercised through its own `execute`.
 *
 * The package-wide block is the contract the runtime relies on: the safety
 * flags, the schemas that actually reject bad input, and the one documented
 * impurity — two tools read the clock, and both take an override.
 */
import { describe, expect, test } from "bun:test";
import {
  FLOW_TOOLS,
  branch,
  consensusVote,
  deadlineCheck,
  decisionTable,
  errorClassify,
  ruleScore,
  stallDetect,
} from "./index";

// biome-ignore lint/suspicious/noExplicitAny: the executor supplies this context, and none of these tools read it.
const ctx = {} as any;

/** Run a tool the way the executor does, and parse its JSON answer back. */
async function call<T = Record<string, unknown>>(
  tool: (typeof FLOW_TOOLS)[number],
  input: unknown,
): Promise<T> {
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`schema rejected the input: ${parsed.error.message}`);
  return JSON.parse(await tool.execute(parsed.data, ctx)) as T;
}

describe("package-wide contract", () => {
  test("every tool is exported in FLOW_TOOLS", () => {
    expect(FLOW_TOOLS.length).toBe(7);
  });

  test("names are unique and PascalCase", () => {
    const names = FLOW_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of FLOW_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only, non-destructive and internal — this package decides, it does not act", () => {
    for (const t of FLOW_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly }).toEqual({ name: t.name, readOnly: true });
      expect({ name: t.name, destructive: t.destructive }).toEqual({
        name: t.name,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
      expect({ name: t.name, sandbox: t.requiresSandbox }).toEqual({
        name: t.name,
        sandbox: false,
      });
    }
  });

  test("no tool declares an io capability, because none crosses a boundary", () => {
    for (const t of FLOW_TOOLS) {
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });

  test("every tool is concurrency-safe", () => {
    for (const t of FLOW_TOOLS) {
      expect({ name: t.name, safe: t.concurrencySafe }).toEqual({ name: t.name, safe: true });
    }
  });

  test("no tool opts out of output classification", () => {
    // These read tool results and remote error text, which is exactly the
    // material a post-tool injection classifier exists to look at.
    for (const t of FLOW_TOOLS) {
      expect({ name: t.name, off: t.classifyOutput === false }).toEqual({
        name: t.name,
        off: false,
      });
    }
  });

  test("every description says what it is for", () => {
    for (const t of FLOW_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).toContain("Use it");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of FLOW_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });

  test("every tool returns parseable JSON", async () => {
    const inputs: Record<string, unknown> = {
      Branch: { value: 1, arms: [{ name: "a", when: [{ op: "exists" }] }] },
      ConsensusVote: { votes: [{ value: "a" }] },
      DeadlineCheck: { budgetMs: 1000, now: 0, startedAt: 0 },
      DecisionTable: {
        value: 1,
        policy: "first",
        rows: [{ id: "r", when: [{ op: "exists" }], outputs: {} }],
      },
      ErrorClassify: { status: 500 },
      RuleScore: { value: 1, rules: [{ id: "r", when: [{ op: "exists" }], points: 1 }] },
      StallDetect: { history: [{ a: "1" }] },
    };
    for (const t of FLOW_TOOLS) {
      const result = await call(t, inputs[t.name]);
      expect({ name: t.name, isObject: typeof result === "object" }).toEqual({
        name: t.name,
        isObject: true,
      });
    }
  });

  test("the two clock-reading tools accept an explicit now, so a replay is reproducible", async () => {
    const a = await call(deadlineCheck, { budgetMs: 60_000, startedAt: 0, now: 30_000 });
    const b = await call(deadlineCheck, { budgetMs: 60_000, startedAt: 0, now: 30_000 });
    expect(a).toEqual(b);
    expect(a.remainingMs).toBe(30_000);
  });
});

describe("Branch", () => {
  test("routes a tool result without a model turn", async () => {
    const result = await call(branch, {
      value: { exitCode: 1, stderr: "ECONNRESET" },
      arms: [
        { name: "ok", when: [{ path: "exitCode", op: "equals", expected: 0 }], result: "continue" },
        {
          name: "network",
          when: [{ path: "stderr", op: "contains", expected: "ECONNRESET" }],
          result: "retry",
        },
      ],
      otherwise: { name: "other", result: "escalate" },
    });
    expect(result).toMatchObject({ name: "network", result: "retry", fallback: false });
  });

  test("verbose explains why the earlier arms missed", async () => {
    const quiet = await call(branch, {
      value: { n: 5 },
      arms: [
        { name: "big", when: [{ path: "n", op: "greaterThan", expected: 10 }] },
        { name: "small", when: [{ path: "n", op: "lessThan", expected: 10 }] },
      ],
    });
    expect(quiet.evaluated).toBeUndefined();

    const loud = await call<{ evaluated: Array<{ name: string; reason: string }> }>(branch, {
      value: { n: 5 },
      arms: [
        { name: "big", when: [{ path: "n", op: "greaterThan", expected: 10 }] },
        { name: "small", when: [{ path: "n", op: "lessThan", expected: 10 }] },
      ],
      verbose: true,
    });
    expect(loud.evaluated).toHaveLength(2);
    expect(loud.evaluated[0]).toMatchObject({ name: "big" });
    expect(loud.evaluated[0]?.reason).not.toBe("");
  });

  test("the schema requires at least one arm and at least one check", () => {
    expect(branch.inputSchema.safeParse({ value: 1, arms: [] }).success).toBe(false);
    expect(
      branch.inputSchema.safeParse({ value: 1, arms: [{ name: "a", when: [] }] }).success,
    ).toBe(false);
  });
});

describe("DecisionTable", () => {
  test("answers a real policy and reports the rows that decided it", async () => {
    const result = await call(decisionTable, {
      value: { severity: "high", tier: "free" },
      policy: "priority",
      version: "triage-v4",
      rows: [
        {
          id: "sev-high",
          when: [{ path: "severity", op: "equals", expected: "high" }],
          priority: 5,
          outputs: { queue: "P2", owner: "oncall" },
        },
        {
          id: "tier-ent",
          when: [{ path: "tier", op: "equals", expected: "enterprise" }],
          priority: 9,
          outputs: { queue: "P1", owner: "tam" },
        },
      ],
    });
    expect(result).toMatchObject({ ok: true, version: "triage-v4", matchedIds: ["sev-high"] });
    expect(result.outputs).toEqual({ queue: "P2", owner: "oncall" });
    expect(typeof result.tableHash).toBe("string");
  });

  test("an ambiguous unique table refuses to answer", async () => {
    const result = await call(decisionTable, {
      value: { a: 1, b: 2 },
      policy: "unique",
      rows: [
        { id: "x", when: [{ path: "a", op: "exists" }], outputs: { r: 1 } },
        { id: "y", when: [{ path: "b", op: "exists" }], outputs: { r: 2 } },
      ],
    });
    expect(result).toMatchObject({ ok: false, matched: false, outputs: null });
    expect(result.conflict).toContain("x");
  });

  test("the schema rejects an unknown hit policy", () => {
    expect(
      decisionTable.inputSchema.safeParse({
        value: 1,
        policy: "whatever",
        rows: [{ id: "r", when: [{ op: "exists" }], outputs: {} }],
      }).success,
    ).toBe(false);
  });
});

describe("ErrorClassify", () => {
  test("classifies a rate limit and carries the server's own wait", async () => {
    expect(await call(errorClassify, { status: 429, retryAfter: "12" })).toMatchObject({
      class: "rate_limited",
      action: "retry_after",
      waitMs: 12_000,
    });
  });

  test("an explicit now makes a date-form Retry-After reproducible", async () => {
    const result = await call(errorClassify, {
      status: 503,
      retryAfter: "Thu, 01 Jan 2026 00:01:00 GMT",
      now: "2026-01-01T00:00:00Z",
    });
    expect(result.waitMs).toBe(60_000);
  });

  test("an offset-less now is rejected rather than read as local time", async () => {
    await expect(
      call(errorClassify, { status: 503, retryAfter: "60", now: "2026-01-01T00:00:00" }),
    ).rejects.toThrow(/no UTC offset/);
  });

  test("a spent attempt budget escalates", async () => {
    expect(await call(errorClassify, { status: 500, attempt: 3, maxAttempts: 3 })).toMatchObject({
      action: "escalate",
      retryable: false,
      exhausted: true,
    });
  });
});

describe("DeadlineCheck", () => {
  test("reports the phase a branch switches on", async () => {
    const result = await call(deadlineCheck, {
      budgetMs: 100_000,
      startedAt: "2026-01-01T00:00:00Z",
      now: "2026-01-01T00:01:25Z",
      stepCostMs: 20_000,
    });
    expect(result).toMatchObject({
      phase: "critical",
      expired: false,
      fits: false,
      stepsRemaining: 0,
    });
  });

  test("an absolute deadline works as well as a budget", async () => {
    const result = await call(deadlineCheck, {
      deadline: "2026-01-01T01:00:00Z",
      startedAt: "2026-01-01T00:00:00Z",
      now: "2026-01-01T00:30:00Z",
    });
    expect(result.remainingMs).toBe(1_800_000);
    expect(result.fractionRemaining).toBe(0.5);
  });

  test("the schema insists on a deadline or a budget", () => {
    expect(deadlineCheck.inputSchema.safeParse({ now: 0 }).success).toBe(false);
  });

  test("an offset-less deadline is rejected", async () => {
    await expect(call(deadlineCheck, { deadline: "2026-01-01T00:00:00" })).rejects.toThrow(
      /no UTC offset/,
    );
  });
});

describe("ConsensusVote", () => {
  test("reports agreement, not just a winner", async () => {
    const result = await call(consensusVote, {
      votes: [
        { value: "ship", voter: "a" },
        { value: "ship", voter: "b" },
        { value: "hold", voter: "c" },
      ],
      threshold: 0.75,
    });
    expect(result).toMatchObject({ winner: "ship", decided: false });
    expect(result.dissenters).toEqual(["c"]);
  });

  test("numeric answers group within a tolerance", async () => {
    const result = await call(consensusVote, {
      votes: [{ value: 99.5 }, { value: 100 }, { value: 250 }],
      mode: "numeric",
      tolerance: 1,
    });
    expect(result).toMatchObject({ winner: 99.5, support: 2 });
  });

  test("a negative weight is rejected by the schema", () => {
    expect(consensusVote.inputSchema.safeParse({ votes: [{ value: 1, weight: -1 }] }).success).toBe(
      false,
    );
  });
});

describe("StallDetect", () => {
  test("catches a fix-test-fail loop that is going in circles", async () => {
    const result = await call(stallDetect, {
      history: [
        { tests: "3 failing", diff: "abc" },
        { tests: "1 failing", diff: "def" },
        { tests: "3 failing", diff: "abc" },
        { tests: "1 failing", diff: "def" },
      ],
    });
    expect(result).toMatchObject({ stalled: true, reason: "oscillating", cycleLength: 2 });
  });

  test("says when there is not enough history to judge", async () => {
    expect(await call(stallDetect, { history: [{ a: "1" }, { a: "2" }] })).toMatchObject({
      reason: "insufficient",
      stalled: false,
    });
  });
});

describe("RuleScore", () => {
  test("scores, bands and attributes", async () => {
    const result = await call(ruleScore, {
      value: { seats: 900, industry: "fintech", plan: "trial" },
      version: "lead-v7",
      rules: [
        {
          id: "seats",
          when: [{ path: "seats", op: "greaterThan", expected: 500 }],
          points: 40,
          label: "enterprise size",
        },
        {
          id: "icp",
          when: [{ path: "industry", op: "oneOf", expected: ["fintech", "health"] }],
          points: 25,
          label: "in ICP",
        },
        { id: "trial", when: [{ path: "plan", op: "equals", expected: "trial" }], points: -15 },
      ],
      bands: [
        { name: "nurture", min: 0 },
        { name: "MQL", min: 40 },
        { name: "SQL", min: 60 },
      ],
    });
    expect(result).toMatchObject({ score: 50, band: "MQL", version: "lead-v7" });
    expect(result.contributors).toHaveLength(3);
  });

  test("missed rules are omitted unless asked for", async () => {
    const input = {
      value: { seats: 1 },
      rules: [
        { id: "big", when: [{ path: "seats", op: "greaterThan", expected: 500 }], points: 1 },
      ],
    };
    expect((await call(ruleScore, input)).missed).toBeUndefined();
    expect((await call(ruleScore, { ...input, includeMissed: true })).missed).toHaveLength(1);
  });
});
