/**
 * 0.6.0 (design §8.1) — durable routing attribution over the LIVE
 * `runChatLoop` path plus the `attachRoutingPersistence` mirror on a bare bus.
 *
 * Asserts:
 *  - a tier decision writes a `model_tier_route` session line beside its bus
 *    publish (the tier twin of `model_route`);
 *  - a failover-chain `model_failover` — published by `@crewhaus/model-router`,
 *    which has no event log — lands in the session JSONL through the mirror;
 *  - `modelRole` / `modelStage` pass through onto `model_request` /
 *    `model_response`, from there onto `cost_accrual` (cost-tracker copies
 *    verbatim) and the persisted `cost_accrual` + `model_meta` lines;
 *  - an unattributed run writes NONE of the new fields (byte-identical lines);
 *  - `model_stage` / `model_directive` / `judge_verdict` published on the bus
 *    persist as their event-log kinds with the envelope `turnNumber`, and the
 *    mirror unsubscribes cleanly.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { openEventLog } from "@crewhaus/event-log";
import { createRunContext } from "@crewhaus/run-context";
import {
  type CostAccrualEvent,
  type ModelRequestEvent,
  type ModelResponseEvent,
  type TraceEvent,
  TraceEventBus,
} from "@crewhaus/trace-event-bus";
import { runChatLoop } from "./index";
import { attachRoutingPersistence } from "./observability";

let sessionRoot: string;
const savedTracking = process.env["CREWHAUS_COST_TRACKING"];

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "crewhaus-routing-persist-"));
});
afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
  process.env["CREWHAUS_COST_TRACKING"] = savedTracking;
});

type LoggedLine = { kind: string; payload?: Record<string, unknown> };

function readLines(root: string): LoggedLine[] {
  const out: LoggedLine[] = [];
  for (const file of readdirSync(root).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(root, file), "utf-8").split("\n")) {
      if (line === "") continue;
      out.push(JSON.parse(line) as LoggedLine);
    }
  }
  return out;
}

function linesOf(kind: string): LoggedLine[] {
  return readLines(sessionRoot).filter((l) => l.kind === kind);
}

async function* okEvents(text: string): AsyncIterable<StreamEvent> {
  yield { kind: "message_start", usage: { input: 100, output: 0 } };
  yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
  yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
  yield { kind: "content_block_stop", index: 0 };
  yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 100, output: 10 } };
  yield { kind: "message_stop" };
}

function okAdapter(providerId: ProviderId, text: string): ProviderAdapter {
  return {
    providerId,
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream: () => okEvents(text),
  };
}

/** Fails with a `continue`-recoverable (max_output_tokens) error while `down`. */
function failingAdapter(down: () => boolean): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(_req: ProviderRequest): AsyncIterable<StreamEvent> {
      return (async function* () {
        if (down()) {
          const err = new Error("scripted primary outage") as Error & { error: { type: string } };
          err.error = { type: "max_output_tokens" };
          throw err;
        }
        yield* okEvents("primary");
      })();
    },
  };
}

function captureStderr(): { restore: () => void } {
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((): boolean => true) as typeof process.stderr.write;
  return {
    restore: () => {
      process.stderr.write = original;
    },
  };
}

describe("durable routing lines over runChatLoop (0.6.0 §8.1)", () => {
  test("a tier decision writes a model_tier_route session line beside the bus publish", async () => {
    const runContext = createRunContext();
    // Not the first turn, so the router has a real decision to make.
    runContext.turnNumber = 2;
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));
    await runChatLoop({
      model: "claude-opus-4-7",
      instructions: "test",
      _adapter: okAdapter("anthropic", "primary"),
      modelTiers: { fast: "claude-haiku-4-5", default: "claude-sonnet-4-5" },
      _tierAdapters: new Map<string, ProviderAdapter>([
        ["claude-haiku-4-5", okAdapter("anthropic", "fast served")],
        ["claude-sonnet-4-5", okAdapter("anthropic", "default served")],
      ]),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hi" }],
      sessionRootDir: sessionRoot,
    });
    const published = seen.filter((e) => e.kind === "model_tier_route");
    expect(published).toHaveLength(1);
    const lines = linesOf("model_tier_route");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.payload).toEqual({
      turnNumber: 3,
      tier: "fast",
      model: "claude-haiku-4-5",
      reason: expect.any(String),
    });
    // The durable line never carries `escalated` on a fresh pick.
    expect(lines[0]?.payload).not.toHaveProperty("escalated");
  });

  test("a failover-chain model_failover (published by model-router) lands in the session JSONL", async () => {
    const primary = failingAdapter(() => true);
    const fallback = okAdapter("openai", "fallback says hi");
    const runContext = createRunContext();
    const stderr = captureStderr();
    try {
      const finalText = await runChatLoop({
        model: "claude-opus-4-7",
        instructions: "test",
        _adapter: primary,
        _failoverAdapters: new Map([["openai/gpt-4o-mini", fallback]]),
        modelFallbacks: ["openai/gpt-4o-mini"],
        circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
        runContext,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "hello" }],
        sessionRootDir: sessionRoot,
      });
      expect(finalText).toBe("fallback says hi");
    } finally {
      stderr.restore();
    }
    const lines = linesOf("model_failover");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.payload).toEqual({
      turnNumber: 1,
      from: "claude-opus-4-7",
      to: "openai/gpt-4o-mini",
      reason: "breaker_open",
    });
  });

  test("modelRole/modelStage stamp model_request + model_response and flow onto cost_accrual, the cost line and model_meta", async () => {
    process.env["CREWHAUS_COST_TRACKING"] = "1";
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));
    await runChatLoop({
      model: "claude-sonnet-4-6",
      instructions: "test",
      _adapter: okAdapter("anthropic", "ok"),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
      sessionRootDir: sessionRoot,
      modelRole: "consult",
      modelStage: "advice",
    });
    const req = seen.find((e): e is ModelRequestEvent => e.kind === "model_request");
    const resp = seen.find((e): e is ModelResponseEvent => e.kind === "model_response");
    const accrual = seen.find((e): e is CostAccrualEvent => e.kind === "cost_accrual");
    expect(req).toMatchObject({ role: "consult", stage: "advice" });
    expect(resp).toMatchObject({ role: "consult", stage: "advice" });
    // cost-tracker copies the attribution verbatim onto the accrual.
    expect(accrual).toMatchObject({ role: "consult", stage: "advice" });
    // …and the session mirrors persist it.
    const costLines = linesOf("cost_accrual");
    expect(costLines).toHaveLength(1);
    expect(costLines[0]?.payload).toMatchObject({ role: "consult", stage: "advice" });
    const meta = linesOf("model_meta");
    expect(meta).toHaveLength(1);
    expect(meta[0]?.payload).toEqual({
      stopReason: "end_turn",
      model: "claude-sonnet-4-6",
      role: "consult",
      usage: { input: 100, output: 10 },
      durationMs: expect.any(Number),
      turnNumber: 1,
    });
  });

  test("an unattributed run writes none of the new fields — the lines stay byte-identical", async () => {
    process.env["CREWHAUS_COST_TRACKING"] = "1";
    const runContext = createRunContext();
    const seen: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => seen.push(e));
    await runChatLoop({
      model: "claude-sonnet-4-6",
      instructions: "test",
      _adapter: okAdapter("anthropic", "ok"),
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
      sessionRootDir: sessionRoot,
    });
    for (const kind of ["model_request", "model_response", "cost_accrual"]) {
      const ev = seen.find((e) => e.kind === kind) as Record<string, unknown> | undefined;
      expect(ev).toBeDefined();
      for (const field of ["role", "stage", "profile", "paramsFingerprint", "effectiveParams"]) {
        expect(ev).not.toHaveProperty(field);
      }
    }
    const costLine = linesOf("cost_accrual")[0]?.payload;
    expect(costLine).toBeDefined();
    for (const field of ["role", "stage", "profile", "paramsFingerprint", "effectiveParams"]) {
      expect(costLine).not.toHaveProperty(field);
    }
    const meta = linesOf("model_meta")[0]?.payload;
    expect(meta).not.toHaveProperty("role");
    expect(meta).not.toHaveProperty("profile");
    // No routing decisions were made, so no routing lines either.
    for (const kind of [
      "model_tier_route",
      "model_failover",
      "model_stage",
      "model_directive",
      "judge_verdict",
    ]) {
      expect(linesOf(kind)).toHaveLength(0);
    }
  });
});

describe("attachRoutingPersistence — bus → event-log mirror (0.6.0 §8.1)", () => {
  const SESSION_ID = "sess_0123456789abcdef";

  test("model_stage / model_directive / judge_verdict / model_failover persist with the envelope turnNumber", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: SESSION_ID });
    bus.setTurnNumber(4);
    const log = await openEventLog(SESSION_ID, { rootDir: sessionRoot });
    const attached = attachRoutingPersistence(bus, log, createRunContext({ eventBus: bus }));

    bus.publish({
      ...bus.envelope(),
      kind: "model_stage",
      stage: "draft",
      strategy: "cascade",
      role: "draft",
      model: "claude-haiku-4-5",
      profile: "fast",
      outcome: "done",
      costUsdMicros: 120,
    });
    bus.publish({
      ...bus.envelope(),
      kind: "model_stage",
      stage: "escalate",
      strategy: "cascade",
      role: "escalation",
      model: "claude-opus-5",
      outcome: "skipped",
      cause: "max_escalations",
    });
    bus.publish({
      ...bus.envelope(),
      kind: "model_directive",
      source: "repl",
      requested: "fast",
      resolved: "fast",
      accepted: true,
    });
    bus.publish({
      ...bus.envelope(),
      kind: "model_directive",
      source: "none",
      requested: "strong",
      accepted: false,
      reason: "directives are off on this shape",
    });
    bus.publish({
      ...bus.envelope(),
      kind: "judge_verdict",
      stepOrNode: "gate",
      verdict: "fail",
      score: 0.4,
      rationale: "missing second source",
      judgeModel: "claude-sonnet-5",
      panel: ["claude-sonnet-5", "claude-opus-5"],
      costUsdMicros: 900,
    });
    bus.publish({
      ...bus.envelope(),
      kind: "model_failover",
      from: "claude-opus-4-7",
      to: "claude-haiku-4-5",
      reason: "budget_degrade",
    });
    // A kind the mirror does not own is ignored.
    bus.publish({ ...bus.envelope(), kind: "turn_start", turn: 4, messageCount: 1 });
    await bus.flush();
    attached.unsubscribe();
    await log.close();

    const lines = readLines(sessionRoot);
    expect(lines.map((l) => l.kind)).toEqual([
      "model_stage",
      "model_stage",
      "model_directive",
      "model_directive",
      "judge_verdict",
      "model_failover",
    ]);
    expect(lines[0]?.payload).toEqual({
      turnNumber: 4,
      stage: "draft",
      strategy: "cascade",
      role: "draft",
      model: "claude-haiku-4-5",
      profile: "fast",
      outcome: "done",
      costUsdMicros: 120,
    });
    expect(lines[1]?.payload).toEqual({
      turnNumber: 4,
      stage: "escalate",
      strategy: "cascade",
      role: "escalation",
      model: "claude-opus-5",
      outcome: "skipped",
      cause: "max_escalations",
    });
    expect(lines[2]?.payload).toEqual({
      turnNumber: 4,
      source: "repl",
      requested: "fast",
      resolved: "fast",
      accepted: true,
    });
    expect(lines[3]?.payload).toEqual({
      turnNumber: 4,
      source: "none",
      requested: "strong",
      accepted: false,
      reason: "directives are off on this shape",
    });
    expect(lines[4]?.payload).toEqual({
      turnNumber: 4,
      stepOrNode: "gate",
      verdict: "fail",
      score: 0.4,
      rationale: "missing second source",
      judgeModel: "claude-sonnet-5",
      panel: ["claude-sonnet-5", "claude-opus-5"],
      costUsdMicros: 900,
    });
    expect(lines[5]?.payload).toEqual({
      turnNumber: 4,
      from: "claude-opus-4-7",
      to: "claude-haiku-4-5",
      reason: "budget_degrade",
    });
  });

  test("unsubscribe detaches the mirror — later publishes write nothing", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: SESSION_ID });
    const log = await openEventLog(SESSION_ID, { rootDir: sessionRoot });
    const attached = attachRoutingPersistence(bus, log, createRunContext({ eventBus: bus }));
    attached.unsubscribe();
    bus.publish({
      ...bus.envelope(),
      kind: "model_failover",
      from: "a",
      to: "b",
      reason: "breaker_open",
    });
    await bus.flush();
    await log.close();
    expect(readLines(sessionRoot)).toHaveLength(0);
  });
});
