/**
 * Tests for the continuity tool surface: flags per the §2.4/§2.6 tool table,
 * happy/error paths for every tool, MemoryClear's justification gate, and
 * plan_update/goal_update/action_proof emission through the injected seam.
 * The underlying store logic is tested in @crewhaus/continuity-store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventLog } from "@crewhaus/event-log";
import type { ContinuityEvent } from "./index";
import { PLAN_DIRTY_STATE_KEY, createPlanTools } from "./index";

let tmp: string;
let events: ContinuityEvent[];

const SESS = "sess_0123456789abcdef";

function makeTools(overrides: Record<string, unknown> = {}) {
  return createPlanTools({
    specName: "support-bot",
    rootDir: join(tmp, ".crewhaus", "state"),
    appendEvent: (e) => {
      events.push(e);
    },
    ...overrides,
  });
}

function logToolPair(toolUseId: string, isError = false): void {
  const dir = join(tmp, ".crewhaus", "sessions");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, `${SESS}.jsonl`),
    `${JSON.stringify({ ts: 1, version: 1, kind: "tool_use", payload: { id: toolUseId, name: "Bash", input: { cmd: "bun test" } } })}\n` +
      `${JSON.stringify({ ts: 2, version: 1, kind: "tool_result", payload: { toolUseId, content: "42 pass", isError } })}\n`,
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tool-plan-"));
  events = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("tool flags — the §2.4/§2.6 table", () => {
  test("read tools are readOnly, non-destructive", () => {
    const { focusRead, planRead, goalList } = makeTools();
    for (const tool of [focusRead, planRead, goalList]) {
      expect(tool.readOnly).toBe(true);
      expect(tool.destructive).toBe(false);
      expect(tool.requireJustification).toBe(false);
      expect(tool.scope).toBe("internal");
    }
  });

  test("write tools are destructive WITHOUT justification (audit-and-allow hot loop)", () => {
    const { focusWrite, planUpdate, planComplete, goalWrite, goalUpdate } = makeTools();
    for (const tool of [focusWrite, planUpdate, planComplete, goalWrite, goalUpdate]) {
      expect(tool.destructive).toBe(true);
      expect(tool.readOnly).toBe(false);
      expect(tool.requireJustification).toBe(false);
      expect(tool.scope).toBe("internal");
    }
  });

  test("MemoryClear is destructive AND requireJustification: true", () => {
    const { memoryClear } = makeTools();
    expect(memoryClear.destructive).toBe(true);
    expect(memoryClear.requireJustification).toBe(true);
  });

  test("bundle exposes all nine tools with the design's names", () => {
    const { all } = makeTools();
    expect(all.map((t) => t.name)).toEqual([
      "FocusRead",
      "FocusWrite",
      "PlanRead",
      "PlanUpdate",
      "PlanComplete",
      "GoalWrite",
      "GoalUpdate",
      "GoalList",
      "MemoryClear",
    ]);
  });
});

describe("FocusRead / FocusWrite", () => {
  test("read before any write teaches the next step", async () => {
    const { focusRead } = makeTools();
    expect(await focusRead.execute({})).toContain("no focus set");
  });

  test("write → read round-trip, including the requirements ledger", async () => {
    const bundle = makeTools();
    await bundle.focusWrite.execute({ focus: "Ship CSV export" });
    await bundle.store.appendRequirement({
      text: "tab delimiter",
      source: { sessionId: SESS, turn: 2 },
    });
    const out = (await bundle.focusRead.execute({})) as string;
    expect(out).toContain("Ship CSV export");
    expect(out).toContain('REQ-001 [open] "tab delimiter"');
    expect(out).toContain(`(user, ${SESS}, turn 2)`);
  });

  test("FocusWrite surfaces the focusMaxChars cap as an error", async () => {
    const bundle = makeTools({ store: undefined });
    const big = "x".repeat(5000);
    await expect(bundle.focusWrite.execute({ focus: big })).rejects.toThrow(/focusMaxChars/);
  });
});

describe("PlanUpdate / PlanRead", () => {
  test("create → read renders numbered steps with ladder statuses", async () => {
    const { planUpdate, planRead } = makeTools();
    const created = (await planUpdate.execute({
      action: "create",
      title: "Ship CSV export",
      steps: ["Parse", "Export"],
    })) as string;
    expect(created).toContain("created plan-0001");
    const out = (await planRead.execute({})) as string; // active plan by default
    expect(out).toContain("plan-0001 — Ship CSV export");
    expect(out).toContain("1. [open] Parse");
    expect(events).toContainEqual({
      kind: "plan_update",
      payload: { planId: "plan-0001", action: "create", title: "Ship CSV export" },
    });
  });

  test("add_step and set_step_status default to the active plan and emit events", async () => {
    const { planUpdate } = makeTools();
    await planUpdate.execute({ action: "create", title: "p", steps: ["a"] });
    await planUpdate.execute({ action: "add_step", text: "b" });
    const out = (await planUpdate.execute({
      action: "set_step_status",
      step: 2,
      status: "claimed",
    })) as string;
    expect(out).toContain("step 2 → claimed");
    expect(out).toContain("unverified");
    expect(events).toContainEqual({
      kind: "plan_update",
      payload: { planId: "plan-0001", action: "set_step_status", step: 2, status: "claimed" },
    });
  });

  test("the schema refuses status 'proven' — that path is PlanComplete's", () => {
    const { planUpdate } = makeTools();
    expect(() =>
      planUpdate.inputSchema.parse({ action: "set_step_status", step: 1, status: "proven" }),
    ).toThrow();
  });

  test("set_active moves the pointer; unknown plan rejects", async () => {
    const { planUpdate, planRead } = makeTools();
    await planUpdate.execute({ action: "create", title: "one" });
    await planUpdate.execute({ action: "create", title: "two" });
    await planUpdate.execute({ action: "set_active", planId: "plan-0002" });
    expect(await planRead.execute({})).toContain("plan-0002 — two");
    await expect(planUpdate.execute({ action: "set_active", planId: "plan-0099" })).rejects.toThrow(
      /no plan/,
    );
  });

  test("plan-scoped actions without an active plan teach plan creation", async () => {
    const { planUpdate } = makeTools();
    await expect(planUpdate.execute({ action: "add_step", text: "x" })).rejects.toThrow(
      /no active plan/,
    );
  });
});

describe("PlanComplete — the proven transition", () => {
  test("verifies evidence, emits action_proof (verified) + plan_update", async () => {
    const bundle = makeTools({ sessionId: SESS });
    await bundle.planUpdate.execute({ action: "create", title: "p", steps: ["run tests"] });
    logToolPair("tu_abc");
    const out = (await bundle.planComplete.execute({
      step: 1,
      evidence: [{ toolUseId: "tu_abc" }],
    })) as string;
    expect(out).toContain("plan-0001 step 1 proven");
    expect(events).toContainEqual({
      kind: "action_proof",
      payload: { planId: "plan-0001", step: 1, toolUseId: "tu_abc", verdict: "verified" },
    });
    expect(events).toContainEqual({
      kind: "plan_update",
      payload: { planId: "plan-0001", action: "prove_step", step: 1, status: "proven" },
    });
    const plan = await bundle.store.getPlan("plan-0001");
    expect(plan?.steps[0]?.status).toBe("proven");
  });

  test("resolves the session from ctx.runContext.sessionId at execute time", async () => {
    const bundle = makeTools(); // no construction-time sessionId
    await bundle.planUpdate.execute({ action: "create", title: "p", steps: ["a"] });
    logToolPair("tu_ctx");
    const ctx = { runContext: { sessionId: SESS } } as unknown as Parameters<
      typeof bundle.planComplete.execute
    >[1];
    const out = (await bundle.planComplete.execute(
      { step: 1, evidence: [{ toolUseId: "tu_ctx" }] },
      ctx,
    )) as string;
    expect(out).toContain("proven");
  });

  test("missing evidence rejects with the instructive design text and audits the attempt", async () => {
    const bundle = makeTools({ sessionId: SESS });
    await bundle.planUpdate.execute({ action: "create", title: "p", steps: ["a"] });
    logToolPair("tu_real");
    await expect(
      bundle.planComplete.execute({ step: 1, evidence: [{ toolUseId: "tu_ghost" }] }),
    ).rejects.toThrow(
      "no verified evidence for tu_ghost: run the action first, then complete the step with its toolUseId.",
    );
    // Give the rejected promise's emit a tick, then check the audit event.
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toContainEqual({
      kind: "action_proof",
      payload: { planId: "plan-0001", step: 1, toolUseId: "tu_ghost", verdict: "missing" },
    });
  });

  test("isError evidence rejects with verdict error_result", async () => {
    const bundle = makeTools({ sessionId: SESS });
    await bundle.planUpdate.execute({ action: "create", title: "p", steps: ["a"] });
    logToolPair("tu_bad", true);
    await expect(
      bundle.planComplete.execute({ step: 1, evidence: [{ toolUseId: "tu_bad" }] }),
    ).rejects.toThrow(/isError: true/);
    expect(events).toContainEqual({
      kind: "action_proof",
      payload: { planId: "plan-0001", step: 1, toolUseId: "tu_bad", verdict: "error_result" },
    });
  });

  test("schema demands at least one evidence ref", () => {
    const { planComplete } = makeTools();
    expect(() => planComplete.inputSchema.parse({ step: 1, evidence: [] })).toThrow();
  });
});

describe("GoalWrite / GoalUpdate / GoalList", () => {
  test("create, list, and update a goal with progress", async () => {
    const { goalWrite, goalList, goalUpdate } = makeTools();
    expect(
      await goalWrite.execute({ title: "coverage", target: 80, current: 40, unit: "%" }),
    ).toContain("created goal-0001");
    expect(await goalList.execute({})).toContain("goal-0001 [open] coverage (40/80 %)");
    const out = (await goalUpdate.execute({
      goalId: "goal-0001",
      current: 60,
      status: "claimed",
    })) as string;
    expect(out).toContain("claimed — unverified");
    expect(events).toContainEqual({
      kind: "goal_update",
      payload: { goalId: "goal-0001", action: "create", title: "coverage" },
    });
    expect(events).toContainEqual({
      kind: "goal_update",
      payload: { goalId: "goal-0001", action: "update", status: "claimed" },
    });
  });

  test("goal proven requires evidence; with evidence it verifies like a step", async () => {
    const bundle = makeTools({ sessionId: SESS });
    await bundle.goalWrite.execute({ title: "g" });
    await expect(
      bundle.goalUpdate.execute({ goalId: "goal-0001", status: "proven" }),
    ).rejects.toThrow(/requires evidence/);
    logToolPair("tu_goal");
    const out = (await bundle.goalUpdate.execute({
      goalId: "goal-0001",
      status: "proven",
      evidence: [{ toolUseId: "tu_goal" }],
    })) as string;
    expect(out).toContain("[proven]");
  });

  test("GoalList teaches GoalWrite when empty", async () => {
    const { goalList } = makeTools();
    expect(await goalList.execute({})).toContain("no goals yet");
  });
});

describe("MemoryClear", () => {
  test("clears via trash and returns the undo handle", async () => {
    const bundle = makeTools();
    await bundle.planUpdate.execute({ action: "create", title: "p" });
    const out = (await bundle.memoryClear.execute({ scope: "plans" })) as string;
    expect(out).toContain("cleared: plans");
    expect(out).toContain(join(tmp, ".crewhaus", "trash"));
    expect(out).toMatch(/undo: crewhaus memory restore \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    expect(existsSync(join(bundle.store.dir(), "plans"))).toBe(false);
  });

  test("clearing an empty store reports a no-op", async () => {
    const { memoryClear } = makeTools();
    expect(await memoryClear.execute({ scope: "goals" })).toContain("nothing to clear");
  });

  test("schema validates the scope enum", () => {
    const { memoryClear } = makeTools();
    expect(() => memoryClear.inputSchema.parse({ scope: "everything" })).toThrow();
    expect(() => memoryClear.inputSchema.parse({ scope: "all" })).not.toThrow();
  });
});

describe("event seam decoupling", () => {
  test("tools work without an appendEvent seam (events optional)", async () => {
    const bundle = createPlanTools({
      specName: "support-bot",
      rootDir: join(tmp, ".crewhaus", "state"),
    });
    expect(await bundle.planUpdate.execute({ action: "create", title: "p" })).toContain(
      "created plan-0001",
    );
  });
});

describe("plan.dirty — the §2.5 runtime bridge seam", () => {
  function makeBridgeCtx() {
    const sets: Record<string, unknown>[] = [];
    const ctx = {
      bridge: {
        runState: {
          set: (partial: Record<string, unknown>) => {
            sets.push(partial);
          },
        },
      },
    };
    return { ctx, sets };
  }

  test("every successful mutation flips plan.dirty via bridge.runState", async () => {
    const bundle = makeTools();
    logToolPair("tu_1");
    const { ctx, sets } = makeBridgeCtx();

    await bundle.focusWrite.execute({ focus: "ship it" }, ctx);
    await bundle.planUpdate.execute({ action: "create", title: "p", steps: ["a"] }, ctx);
    await bundle.planUpdate.execute({ action: "add_step", text: "b" }, ctx);
    await bundle.planUpdate.execute({ action: "set_step_status", step: 1, status: "claimed" }, ctx);
    await bundle.planUpdate.execute({ action: "set_active", planId: "plan-0001" }, ctx);
    await bundle.planComplete.execute(
      { step: 1, evidence: [{ toolUseId: "tu_1", sessionId: SESS }] },
      { ...ctx, runContext: undefined },
    );
    await bundle.goalWrite.execute({ title: "coverage" }, ctx);
    await bundle.goalUpdate.execute({ goalId: "goal-0001", status: "in_progress" }, ctx);
    await bundle.memoryClear.execute({ scope: "all" }, ctx);

    expect(sets.length).toBe(9);
    for (const partial of sets) {
      expect(partial).toEqual({ [PLAN_DIRTY_STATE_KEY]: true });
    }
    // The literal runtime-core reads back (its exported PLAN_DIRTY_STATE_KEY).
    expect(PLAN_DIRTY_STATE_KEY).toBe("plan.dirty");
  });

  test("read-only tools never flip the flag; failed mutations don't either", async () => {
    const bundle = makeTools();
    const { ctx, sets } = makeBridgeCtx();
    await bundle.planUpdate.execute({ action: "create", title: "p", steps: ["a"] }, ctx);
    sets.length = 0;

    await bundle.focusRead.execute({}, ctx);
    await bundle.planRead.execute({}, ctx);
    await bundle.goalList.execute({}, ctx);
    // A rejected proof (no such toolUseId anywhere) must not mark the plan dirty.
    await expect(
      bundle.planComplete.execute({ step: 1, evidence: [{ toolUseId: "tu_ghost" }] }, ctx),
    ).rejects.toThrow();
    expect(sets.length).toBe(0);
  });

  test("mutations without a bridge (or without runState) stay a no-op", async () => {
    const bundle = makeTools();
    await bundle.focusWrite.execute({ focus: "no bridge at all" });
    await bundle.focusWrite.execute({ focus: "bridge without runState" }, { bridge: {} });
    // Reaching here without a throw is the assertion.
    expect(await bundle.focusRead.execute({})).toContain("bridge without runState");
  });
});

describe("appendEvent seam against the real event-log union (v0.3.0 integration)", () => {
  test("plan_update / goal_update / action_proof round-trip through a real EventLog", async () => {
    // The seam wiring the composition root will use: `ContinuityEvent` must be
    // assignable to event-log's `AppendEvent` (a compile-time union check —
    // the parallel 0.3.0 branches each added kinds to the same union).
    const seamSession = "sess_00000000000000aa";
    const log = await openEventLog(seamSession, {
      rootDir: join(tmp, ".crewhaus", "sessions"),
    });
    const bundle = makeTools({
      sessionId: SESS,
      appendEvent: (e: ContinuityEvent) => log.append(e),
    });

    await bundle.planUpdate.execute({ action: "create", title: "p", steps: ["a"] });
    await bundle.goalWrite.execute({ title: "coverage" });
    logToolPair("tu_seam");
    await bundle.planComplete.execute({ step: 1, evidence: [{ toolUseId: "tu_seam" }] });

    const kinds: string[] = [];
    const payloads: unknown[] = [];
    for await (const ev of log.read()) {
      kinds.push(ev.kind);
      payloads.push(ev.payload);
    }
    expect(kinds).toEqual(["plan_update", "goal_update", "action_proof", "plan_update"]);
    expect(payloads[2]).toEqual({
      planId: "plan-0001",
      step: 1,
      toolUseId: "tu_seam",
      verdict: "verified",
    });
    await log.close();
  });
});
