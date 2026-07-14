/**
 * Engine semantics (design §6.2): window idempotency (incl. concurrent
 * double-fire), the unpriced-model refusal, budget threading into the
 * model-phase seam, dream_run event + state round-trip, and the janitor
 * step's env knobs / due-check / outcome mapping.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DREAM_MAX_TOOL_ITERATIONS,
  type DreamModelPhaseInput,
  type DreamRunReport,
  createDreamEngine,
  dreamJanitorStep,
  dreamWindowKey,
  readDreamState,
  scanDreamSessionEvidence,
  unpricedModelReason,
} from "./index";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-13T19:04:12.000Z");

let tmp: string; // the .crewhaus dir

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dream-engine-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const DREAM_SESS = "sess_00000000000000dd";

function writeDreamSessionLog(): void {
  const dir = join(tmp, "sessions");
  mkdirSync(dir, { recursive: true });
  const events = [
    {
      kind: "tool_use",
      payload: { id: "tu_ok1", name: "wiki_write", input: { slug: "eu-locale-delimiters" } },
    },
    { kind: "tool_result", payload: { toolUseId: "tu_ok1", content: "v1", isError: false } },
    {
      kind: "tool_use",
      payload: { id: "tu_bad", name: "MemoryForget", input: { idOrQuery: "mem_x" } },
    },
    { kind: "tool_result", payload: { toolUseId: "tu_bad", content: "nope", isError: true } },
  ];
  writeFileSync(
    join(dir, `${DREAM_SESS}.jsonl`),
    `${events.map((e, i) => JSON.stringify({ ts: NOW.getTime() + i, version: 1, ...e })).join("\n")}\n`,
  );
}

type EngineOverrides = Partial<Parameters<typeof createDreamEngine>[0]>;

function makeEngine(overrides: EngineOverrides = {}) {
  return createDreamEngine({
    specName: "bot",
    crewhausDir: tmp,
    dream: { everyMs: DAY },
    now: () => NOW,
    ...overrides,
  });
}

describe("unpricedModelReason", () => {
  test("unknown provider prefix and missing pricing rows both refuse", () => {
    expect(unpricedModelReason("made-up-model-9000")).toMatch(/unrecognized provider prefix/);
    expect(unpricedModelReason("claude-nonexistent-99")).toMatch(/no pricing entry/);
    expect(unpricedModelReason("openai/gpt-nonexistent")).toMatch(/no pricing entry/);
  });

  test("a priced model passes", () => {
    expect(unpricedModelReason("claude-haiku-4-5")).toBeNull();
    expect(unpricedModelReason("openai/gpt-4o-mini")).toBeNull();
  });
});

describe("model phase — refusal, threading, failure", () => {
  test("REFUSES an unpriced model before ever calling the runner", async () => {
    let called = 0;
    const engine = makeEngine({
      dream: { everyMs: DAY, mode: "full", budgetUsd: 0.5 },
      modelPhase: {
        model: "made-up-model-9000",
        run: async () => {
          called += 1;
          return {};
        },
      },
    });
    const report = await engine.run();
    expect(called).toBe(0);
    expect(report.outcome).toBe("model_refused_unpriced");
    expect(report.model?.refusal).toMatch(/budget cap would be a silent no-op/);
    // The deterministic phase still ran and the state records the refusal.
    const state = await readDreamState(engine.stateDir());
    expect(state?.lastOutcome).toBe("model_refused_unpriced");
  });

  test("threads budgetUsd, the tool-iteration cap, playbook and findings into the seam", async () => {
    const inputs: DreamModelPhaseInput[] = [];
    const engine = makeEngine({
      dream: { everyMs: DAY, mode: "full", budgetUsd: 0.5 },
      playbook: "the dream skill body",
      modelPhase: {
        model: "claude-haiku-4-5",
        run: async (input) => {
          inputs.push(input);
          return { sessionId: DREAM_SESS, spentUsd: 0.11, summary: "consolidated" };
        },
      },
    });
    writeDreamSessionLog();
    const report = await engine.run();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.budgetUsd).toBe(0.5);
    expect(inputs[0]?.maxToolIterations).toBe(DREAM_MAX_TOOL_ITERATIONS);
    expect(inputs[0]?.playbook).toBe("the dream skill body");
    expect(inputs[0]?.prompt).toContain("## Phase-1 counts");
    expect(inputs[0]?.prompt).toContain("capped at $0.50");
    expect(report.outcome).toBe("full");
    expect(report.model?.spentUsd).toBe(0.11);
    // Evidence derived from the session log: successful calls only.
    expect(report.model?.evidence).toEqual(["tu_ok1"]);
    expect(report.model?.actions).toEqual([
      { toolUseId: "tu_ok1", toolName: "wiki_write", detail: '"eu-locale-delimiters"' },
    ]);
  });

  test("dream.instructions wins over the injected playbook", async () => {
    const inputs: DreamModelPhaseInput[] = [];
    const engine = makeEngine({
      dream: { everyMs: DAY, mode: "full", budgetUsd: 0.25, instructions: "spec override" },
      playbook: "the dream skill body",
      modelPhase: {
        model: "claude-haiku-4-5",
        run: async (input) => {
          inputs.push(input);
          return {};
        },
      },
    });
    await engine.run();
    expect(inputs[0]?.playbook).toBe("spec override");
  });

  test("budget 0 / mode deterministic never invoke the runner", async () => {
    let called = 0;
    const runner = {
      model: "claude-haiku-4-5",
      run: async () => {
        called += 1;
        return {};
      },
    };
    const detEngine = makeEngine({
      dream: { everyMs: DAY, mode: "deterministic", budgetUsd: 5 },
      modelPhase: runner,
    });
    expect((await detEngine.run()).outcome).toBe("deterministic");
    const zeroBudget = makeEngine({
      crewhausDir: join(tmp, "b"),
      dream: { everyMs: DAY, mode: "full", budgetUsd: 0 },
      modelPhase: runner,
    });
    expect((await zeroBudget.run()).outcome).toBe("deterministic");
    expect(called).toBe(0);
  });

  test("a throwing runner yields model_failed and does NOT consume the window", async () => {
    let calls = 0;
    const engine = makeEngine({
      dream: { everyMs: DAY, mode: "full", budgetUsd: 0.5 },
      modelPhase: {
        model: "claude-haiku-4-5",
        run: async () => {
          calls += 1;
          throw new Error("provider blip");
        },
      },
    });
    const first = await engine.run();
    expect(first.outcome).toBe("model_failed");
    expect(first.model?.error).toBe("provider blip");
    // Same window, same engine: the failed window was not recorded → retry.
    const second = await engine.run();
    expect(calls).toBe(2);
    expect(second.cached).toBe(false);
  });
});

describe("window idempotency", () => {
  test("a second run in the same window returns the cached report", async () => {
    const engine = makeEngine();
    const first = await engine.run();
    expect(first.cached).toBe(false);
    const second = await engine.run();
    expect(second.cached).toBe(true);
    expect(second.windowKey).toBe(first.windowKey);
    expect(second.phase1.counts).toEqual(first.phase1.counts);
  });

  test("boot catch-up (deterministic) and the full run use separate window keys", async () => {
    let modelCalls = 0;
    const engine = makeEngine({
      dream: { everyMs: DAY, mode: "full", budgetUsd: 0.5 },
      modelPhase: {
        model: "claude-haiku-4-5",
        run: async () => {
          modelCalls += 1;
          return {};
        },
      },
    });
    const catchUp = await engine.runDeterministic({ trigger: "boot" });
    expect(catchUp.phase).toBe("deterministic");
    expect(modelCalls).toBe(0);
    // The full consolidation is still available in the SAME window.
    const full = await engine.run();
    expect(full.cached).toBe(false);
    expect(full.phase).toBe("full");
    expect(modelCalls).toBe(1);
  });

  test("concurrent double-fire executes exactly once (janitor tick + cron race)", async () => {
    let executions = 0;
    const engine = makeEngine({
      appendEvent: () => {
        executions += 1;
      },
    });
    const [a, b] = await Promise.all([engine.run(), engine.run()]);
    expect(executions).toBe(1);
    expect([a.cached, b.cached].filter((c) => c)).toHaveLength(1);
    expect([a.cached, b.cached].filter((c) => !c)).toHaveLength(1);
  });

  test("a new window executes again; force bypasses within a window", async () => {
    let clock = NOW.getTime();
    const engine = createDreamEngine({
      specName: "bot",
      crewhausDir: tmp,
      dream: { everyMs: DAY },
      now: () => new Date(clock),
    });
    const first = await engine.run();
    clock += DAY; // next window
    const second = await engine.run();
    expect(second.cached).toBe(false);
    expect(second.windowKey).not.toBe(first.windowKey);
    const forced = await engine.run({ force: true });
    expect(forced.cached).toBe(false);
  });

  test("the window key floors now/everyMs (§6.2)", () => {
    expect(dreamWindowKey("bot", NOW.getTime(), DAY)).toBe(
      `dream:bot:${Math.floor(NOW.getTime() / DAY)}`,
    );
  });
});

describe("dream_run event + state round-trip", () => {
  test("one event per executed run; payload and state agree", async () => {
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    writeDreamSessionLog();
    const engine = makeEngine({
      dream: { everyMs: DAY, mode: "full", budgetUsd: 0.5 },
      modelPhase: {
        model: "claude-haiku-4-5",
        run: async () => ({ sessionId: DREAM_SESS, spentUsd: 0.11 }),
      },
      appendEvent: (event) => {
        events.push(event);
      },
    });
    const report = await engine.run({ trigger: "janitor" });
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(events[0]?.kind).toBe("dream_run");
    expect(payload["specName"]).toBe("bot");
    expect(payload["trigger"]).toBe("janitor");
    expect(payload["outcome"]).toBe("full");
    expect(payload["windowKey"]).toBe(report.windowKey);
    expect(payload["sessionId"]).toBe(DREAM_SESS);
    expect(payload["spentUsd"]).toBe(0.11);
    expect(payload["evidence"]).toEqual(["tu_ok1"]);
    // The payload survives a JSON round-trip unchanged (it is written into
    // an append-only .jsonl by the sinks).
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);

    // state.json round-trips through readDreamState.
    const state = await readDreamState(engine.stateDir());
    expect(state).not.toBeNull();
    expect(state?.lastRunAt).toBe(report.startedAt);
    expect(state?.lastOutcome).toBe("full");
    expect(state?.phase1Counts).toEqual(report.phase1.counts);
    expect(state?.lastEvidence).toEqual(["tu_ok1"]);
    const raw = JSON.parse(readFileSync(join(engine.stateDir(), "state.json"), "utf8"));
    expect(raw).toEqual(state);
    // A cached repeat does NOT emit a second proof record.
    await engine.run({ trigger: "janitor" });
    expect(events).toHaveLength(1);
  });
});

describe("status + janitor step", () => {
  test("status: never ran → overdue; after a run → next due at lastRunAt+everyMs", async () => {
    const engine = makeEngine();
    const before = await engine.status();
    expect(before.overdue).toBe(true);
    expect(before.nextDueAt).toBeNull();
    await engine.run();
    const after = await engine.status();
    expect(after.overdue).toBe(false);
    expect(after.nextDueAt).toBe(new Date(NOW.getTime() + DAY).toISOString());
  });

  test("janitor step: CREWHAUS_DREAM=0 disables; not-due skips; due runs", async () => {
    const engine = makeEngine();
    const disabled = dreamJanitorStep(engine, { env: { CREWHAUS_DREAM: "0" } });
    expect((await disabled.run()).status).toBe("skipped");

    const step = dreamJanitorStep(engine, { env: {} });
    expect(step.name).toBe("dream_consolidation");
    const first = await step.run();
    expect(first.status).toBe("ok");
    expect(first.detail).toContain("deterministic run");
    const second = await step.run();
    expect(second.status).toBe("skipped");
    expect(second.detail).toContain("not due");
  });

  test("CREWHAUS_DREAM_INTERVAL_MS overrides the cadence (due again sooner)", async () => {
    let clock = NOW.getTime();
    const engine = createDreamEngine({
      specName: "bot",
      crewhausDir: tmp,
      dream: { everyMs: 7 * DAY },
      now: () => new Date(clock),
    });
    const step = dreamJanitorStep(engine, {
      env: { CREWHAUS_DREAM_INTERVAL_MS: String(DAY) },
    });
    expect((await step.run()).status).toBe("ok");
    clock += DAY + 1; // past the OVERRIDDEN cadence, far under the spec's 7d
    expect((await step.run()).status).toBe("ok");
  });

  test("janitor step surfaces an unpriced-model refusal as an error", async () => {
    const engine = makeEngine({
      dream: { everyMs: DAY, mode: "full", budgetUsd: 0.5 },
      modelPhase: { model: "made-up-model-9000", run: async () => ({}) },
    });
    const outcome = await dreamJanitorStep(engine, { env: {} }).run();
    expect(outcome.status).toBe("error");
    expect(outcome.detail).toMatch(/silent no-op/);
  });
});

describe("evidence scanning", () => {
  test("scanDreamSessionEvidence keeps successful calls only; missing log is empty", async () => {
    writeDreamSessionLog();
    const trail = await scanDreamSessionEvidence(DREAM_SESS, join(tmp, "sessions"));
    expect(trail.evidence).toEqual(["tu_ok1"]);
    expect(trail.actions.map((a) => a.toolName)).toEqual(["wiki_write"]);
    const missing = await scanDreamSessionEvidence("sess_00000000000000ee", join(tmp, "sessions"));
    expect(missing).toEqual({ actions: [], evidence: [] });
  });
});
