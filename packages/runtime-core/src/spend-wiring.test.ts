/**
 * The spend meter as `runChatLoop` uses it (#516): a model nothing can price is
 * reported once per model and never stops a budgeted run; a reservation the
 * meter refuses ends the run as a budget stop without sending the call or
 * logging any part of it; a declared period writes the harness's ledger, and a
 * run without one writes nothing there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { registerIntakeRoot, unregisterIntakeRoot } from "@crewhaus/control-records";
import { foldBudget } from "@crewhaus/control-records/budget";
import { DEFAULT_PRICING } from "@crewhaus/cost-tracker";
import { createSpendMeter } from "@crewhaus/cost-tracker/spend";
import { EXIT_CODES, RunFailedError } from "@crewhaus/errors";
import type { Scoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { BudgetUnpricedEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { runChatLoop } from "./index";

const ROOTS: string[] = [];
const tempDir = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `crewhaus-spend-${label}-`));
  ROOTS.push(dir);
  return dir;
};
const SESSIONS = tempDir("sessions");
let savedSessionDir: string | undefined;
beforeAll(() => {
  savedSessionDir = process.env["CREWHAUS_SESSION_DIR"];
  process.env["CREWHAUS_SESSION_DIR"] = SESSIONS;
});
afterAll(() => {
  if (savedSessionDir === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_SESSION_DIR");
  else process.env["CREWHAUS_SESSION_DIR"] = savedSessionDir;
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

const USAGE = { input: 100, output: 10 };
/** Priced by the table: 100 in + 10 out = 300 + 150 = 450 micros a call. */
const SONNET = "claude-sonnet-4-6";
/** No row in any table: its cost is unknown. */
const LOCAL = "local/qwen3@http://127.0.0.1:9/v1";

/** A scripted adapter: `tool` answers with a `noop` call, `text` ends the turn. */
function scripted(
  providerId: ProviderId,
  script: ReadonlyArray<"tool" | "text">,
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let call = 0;
  return {
    requests,
    providerId,
    features: { caching: false, tool_use: true, vision: false, thinking: false, web_search: false },
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      const step = script[call] ?? "text";
      const id = `tu_${call}`;
      call += 1;
      return (async function* () {
        yield { kind: "message_start", usage: { input: USAGE.input, output: 0 } };
        if (step === "tool") {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id, name: "noop", input: {} },
          };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "tool_use", usage: USAGE };
        } else {
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "end_turn", usage: USAGE };
        }
        yield { kind: "message_stop" };
      })();
    },
  };
}

const noop = buildTool({
  name: "noop",
  description: "does nothing",
  inputSchema: z.object({}),
  readOnly: true,
  execute: async () => "ok",
});

async function runOnce(
  overrides: Partial<Parameters<typeof runChatLoop>[0]> & { model: string },
  adapter: ProviderAdapter,
): Promise<{ events: TraceEvent[]; caught: unknown; sessionId: string }> {
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => {
    events.push(e);
  });
  let caught: unknown;
  try {
    await runChatLoop({
      instructions: "test",
      _adapter: adapter,
      tools: [noop],
      permissionMode: "bypass",
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      runContext,
      ...overrides,
    });
  } catch (err) {
    caught = err;
  }
  return { events, caught, sessionId: runContext.sessionId };
}

describe("a model with no price in a budgeted run", () => {
  test("the run goes on past the cap check and says budget_unpriced once per model, over three calls", async () => {
    const adapter = scripted("openai", ["tool", "tool", "text"]);
    const { events, caught } = await runOnce(
      { model: LOCAL, budget: { usdMicros: 1_000, onExceed: { kind: "stop" } } },
      adapter,
    );
    expect(caught).toBeUndefined();
    expect(events.filter((e) => e.kind === "model_response")).toHaveLength(3);
    const unpriced = events.filter((e): e is BudgetUnpricedEvent => e.kind === "budget_unpriced");
    expect(unpriced.map((e) => [e.provider, e.modelId])).toEqual([["openai", "qwen3"]]);
    expect(events.some((e) => e.kind === "run_failed")).toBe(false);
  });

  test("an unbudgeted run says nothing", async () => {
    const { events } = await runOnce({ model: LOCAL }, scripted("openai", ["tool", "text"]));
    expect(events.filter((e) => e.kind === "model_response")).toHaveLength(2);
    expect(events.some((e) => e.kind === "budget_unpriced")).toBe(false);
  });

  test("a declared price makes the model's cost known: nothing to report", async () => {
    const { events } = await runOnce(
      {
        model: LOCAL,
        budget: { usdMicros: 1_000_000, onExceed: { kind: "stop" } },
        declaredPricing: { [LOCAL]: { inputPer1M: 1, outputPer1M: 2 } },
      },
      scripted("openai", ["tool", "text"]),
    );
    expect(events.filter((e) => e.kind === "model_response")).toHaveLength(2);
    expect(events.some((e) => e.kind === "budget_unpriced")).toBe(false);
  });
});

describe("a reservation the meter refuses", () => {
  test("ends the run as a budget stop: one run_failed, nothing sent, nothing logged, no pool outcome", async () => {
    const adapter = scripted("anthropic", ["text"]);
    const observations: unknown[] = [];
    const spy: Scoreboard = {
      path: "(spy)",
      score: () => undefined,
      record: (...args) => {
        observations.push(args);
      },
      snapshot: () => [],
      compact: () => undefined,
    };
    // A meter whose cap is already spent: only the reservation can refuse.
    const spendMeter = createSpendMeter({
      capMicros: 400,
      seedMicros: 400,
      pricing: DEFAULT_PRICING,
    });
    const { events, caught, sessionId } = await runOnce(
      {
        model: SONNET,
        spendMeter,
        modelPool: { candidates: [{ model: SONNET, tags: ["cheap", "strong"] }], policy: "static" },
        _poolAdapters: new Map<string, ProviderAdapter>([[SONNET, adapter]]),
        _scoreboard: spy,
      },
      adapter,
    );
    expect(caught).toBeInstanceOf(RunFailedError);
    const report = (caught as RunFailedError).report;
    expect(report.class).toBe("crewhaus_budget");
    expect(report.exitCode).toBe(EXIT_CODES.crewhaus_budget);
    expect(events.filter((e) => e.kind === "run_failed")).toHaveLength(1);
    expect(adapter.requests).toHaveLength(0);
    expect(observations).toHaveLength(0);
    expect(spendMeter.snapshot().activeReservations).toBe(0);
    // The log holds the user's message and no assistant or tool_use line for the call.
    const lines = readFileSync(join(SESSIONS, `${sessionId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind?: string });
    expect(lines.some((l) => l.kind === "user_message")).toBe(true);
    expect(lines.some((l) => l.kind === "assistant_message" || l.kind === "tool_use")).toBe(false);

    // The session resumes, and its next call runs on a meter with room.
    const resumed = createRunContext({ sessionId });
    const next = scripted("anthropic", ["text"]);
    await runChatLoop({
      model: SONNET,
      instructions: "test",
      _adapter: next,
      tools: [noop],
      permissionMode: "bypass",
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go on" }],
      resume: { sessionId },
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      runContext: resumed,
      spendMeter: createSpendMeter({ capMicros: 10_000, pricing: DEFAULT_PRICING }),
    });
    expect(next.requests).toHaveLength(1);
  });

  test("a call that answers settles its worst case into the real cost", async () => {
    const spendMeter = createSpendMeter({ capMicros: 10_000, pricing: DEFAULT_PRICING });
    const { caught } = await runOnce(
      { model: SONNET, spendMeter },
      scripted("anthropic", ["tool", "text"]),
    );
    expect(caught).toBeUndefined();
    expect(spendMeter.snapshot()).toMatchObject({
      spentMicros: 900,
      reservedMicros: 0,
      activeReservations: 0,
    });
  });
});

describe("budget.period", () => {
  test("a run with a period reserves and settles on the harness's ledger", async () => {
    const harness = tempDir("period");
    registerIntakeRoot(harness);
    try {
      const period = { every: "month" as const, usdMicros: 1_000_000 };
      const { caught } = await runOnce(
        { model: SONNET, budget: { usdMicros: 100_000, onExceed: { kind: "stop" }, period } },
        scripted("anthropic", ["tool", "text"]),
      );
      expect(caught).toBeUndefined();
      const fold = foldBudget(harness, period, Date.now());
      expect(fold.spentUsdMicros).toBe(900);
      expect(fold.reservedUsdMicros).toBe(0);
      expect(fold.unknownCalls).toBe(0);
    } finally {
      unregisterIntakeRoot(harness);
    }
  });

  test("a budgeted run without a period, and an unbudgeted one, write nothing under budget/", async () => {
    const harness = tempDir("no-period");
    registerIntakeRoot(harness);
    try {
      await runOnce(
        { model: SONNET, budget: { usdMicros: 100_000, onExceed: { kind: "stop" } } },
        scripted("anthropic", ["text"]),
      );
      await runOnce({ model: SONNET }, scripted("anthropic", ["text"]));
      const control = join(harness, ".crewhaus", "run", "control");
      expect(existsSync(join(control, "budget"))).toBe(false);
      expect(existsSync(control) ? readdirSync(control).includes("budget-state.json") : false).toBe(
        false,
      );
    } finally {
      unregisterIntakeRoot(harness);
    }
  });
});
