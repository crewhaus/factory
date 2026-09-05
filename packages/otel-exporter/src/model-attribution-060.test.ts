/**
 * 0.6.0 (design §8.4) — OTel attribution on the model span and the routing
 * kinds: `gen_ai.response.model` beside `gen_ai.request.model`, cost stamped
 * onto the `gen_ai.chat` span from the accrual that prices it, a judge call
 * pairing correctly with a concurrent shadow-style call (acceptance item 15's
 * OTel half), and dedicated spans for `model_stage` / `model_directive` plus
 * the additive `model_route` / `eval_graded` / `judge_verdict` attributes.
 */
import { describe, expect, test } from "bun:test";
import type {
  CostAccrualEvent,
  EvalGradedEvent,
  JudgeVerdictEvent,
  ModelDirectiveEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  ModelRouteEvent,
  ModelStageEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import {
  ATTR,
  buildEvalGradedSpan,
  buildJudgeVerdictSpan,
  buildModelDirectiveSpan,
  buildModelRouteSpan,
  buildModelStageSpan,
  modelCostJoinKey,
} from "./gen-ai-mapping";
import { SpanTracker } from "./span-tracker";
import { type OtelSpan, STATUS_ERROR, STATUS_OK } from "./types";

const TRACE = `${"0".repeat(31)}1`;
const env = (overrides: Record<string, unknown> = {}) => ({
  runId: "run_a",
  sessionId: "sess_1",
  turnNumber: 1,
  traceId: TRACE,
  spanId: `${"0".repeat(15)}1`,
  timestamp: "2026-09-04T12:00:00.000Z",
  ...overrides,
});

const sid = (c: string): string => `${"0".repeat(15)}${c}`;

function tracked(): { tracker: SpanTracker; spans: OtelSpan[] } {
  const spans: OtelSpan[] = [];
  const tracker = new SpanTracker((s) => spans.push(s));
  return { tracker, spans };
}

const attr = (span: OtelSpan | undefined, key: string) =>
  span?.attributes.find((a) => a.key === key)?.value as
    | { stringValue?: string; intValue?: string; boolValue?: boolean }
    | undefined;

const request = (
  spanId: string,
  model: string,
  extra: Partial<ModelRequestEvent> = {},
): ModelRequestEvent =>
  ({
    ...env({ spanId }),
    kind: "model_request",
    model,
    messageCount: 1,
    toolCount: 0,
    streaming: false,
    ...extra,
  }) as ModelRequestEvent;

const response = (
  spanId: string,
  model: string,
  extra: Partial<ModelResponseEvent> = {},
): ModelResponseEvent =>
  ({
    ...env({ spanId, timestamp: "2026-09-04T12:00:01.000Z" }),
    kind: "model_response",
    model,
    stopReason: "end_turn",
    usage: { input: 10, output: 5 },
    durationMs: 1000,
    ...extra,
  }) as ModelResponseEvent;

const accrual = (model: string, micros: number, extra: Partial<CostAccrualEvent> = {}) =>
  ({
    // cost-tracker publishes under a FRESH envelope — a different spanId.
    ...env({ spanId: sid("e"), timestamp: "2026-09-04T12:00:01.001Z" }),
    kind: "cost_accrual",
    provider: "anthropic",
    modelId: model,
    inputTokens: 10,
    outputTokens: 5,
    cachedReadTokens: 0,
    costUsdMicros: micros,
    ...extra,
  }) as CostAccrualEvent;

describe("acceptance item 15 (OTel half) — a judge call pairs beside a concurrent shadow call", () => {
  test("judge span carries crewhaus.model.role=judge; both pair by spanId, not by order", () => {
    const { tracker, spans } = tracked();
    const PRIMARY = sid("a");
    const JUDGE = sid("b");
    const SHADOW = sid("c");
    tracker.ingest(request(PRIMARY, "claude-haiku-4-5", { role: "draft", profile: "fast" }));
    tracker.ingest(response(PRIMARY, "claude-haiku-4-5", { role: "draft", profile: "fast" }));
    // The judge and a shadow replay are in flight together; the shadow's
    // response lands first.
    tracker.ingest(request(JUDGE, "claude-sonnet-5", { role: "judge", profile: "checker" }));
    tracker.ingest(request(SHADOW, "claude-opus-5", { role: "shadow", stage: "shadow" }));
    expect(tracker.inFlightModelCalls()).toBe(2);
    tracker.ingest(response(SHADOW, "claude-opus-5", { role: "shadow", stage: "shadow" }));
    tracker.ingest(response(JUDGE, "claude-sonnet-5", { role: "judge", profile: "checker" }));
    expect(tracker.inFlightModelCalls()).toBe(0);

    const chat = spans.filter((s) => s.name === "gen_ai.chat");
    expect(chat).toHaveLength(3);
    const bySpan = new Map(chat.map((s) => [s.spanId, s]));
    const judge = bySpan.get(JUDGE);
    const shadow = bySpan.get(SHADOW);
    expect(attr(judge, ATTR.CREWHAUS_MODEL_ROLE)?.stringValue).toBe("judge");
    expect(attr(judge, ATTR.CREWHAUS_MODEL_PROFILE)?.stringValue).toBe("checker");
    expect(attr(judge, ATTR.GEN_AI_RESPONSE_MODEL)?.stringValue).toBe("claude-sonnet-5");
    expect(attr(shadow, ATTR.CREWHAUS_MODEL_ROLE)?.stringValue).toBe("shadow");
    expect(attr(shadow, ATTR.CREWHAUS_MODEL_STAGE)?.stringValue).toBe("shadow");
    expect(attr(shadow, ATTR.GEN_AI_RESPONSE_MODEL)?.stringValue).toBe("claude-opus-5");
    expect(attr(bySpan.get(PRIMARY), ATTR.CREWHAUS_MODEL_ROLE)?.stringValue).toBe("draft");
  });
});

describe("gen_ai.request.model vs gen_ai.response.model", () => {
  test("agree on a plain call; diverge when a failover chain served another model", () => {
    const { tracker, spans } = tracked();
    tracker.ingest(request(sid("a"), "claude-opus-5"));
    tracker.ingest(response(sid("a"), "claude-opus-5"));
    tracker.ingest(request(sid("b"), "claude-opus-5"));
    // The chain rewrote the model mid-call; the response names the rung that served.
    tracker.ingest(response(sid("b"), "gpt-4o", { provider: "openai" }));
    const plain = spans.find((s) => s.spanId === sid("a"));
    const failedOver = spans.find((s) => s.spanId === sid("b"));
    expect(attr(plain, ATTR.GEN_AI_REQUEST_MODEL)?.stringValue).toBe("claude-opus-5");
    expect(attr(plain, ATTR.GEN_AI_RESPONSE_MODEL)?.stringValue).toBe("claude-opus-5");
    expect(attr(failedOver, ATTR.GEN_AI_REQUEST_MODEL)?.stringValue).toBe("claude-opus-5");
    expect(attr(failedOver, ATTR.GEN_AI_RESPONSE_MODEL)?.stringValue).toBe("gpt-4o");
    expect(attr(failedOver, ATTR.GEN_AI_SYSTEM)?.stringValue).toBe("openai");
  });
});

describe("cost on the model span", () => {
  test("a per-call accrual is stamped onto the gen_ai.chat span it prices, matched by role", () => {
    const { tracker, spans } = tracked();
    const PRIMARY = sid("a");
    const JUDGE = sid("b");
    tracker.ingest(request(PRIMARY, "claude-sonnet-5"));
    tracker.ingest(response(PRIMARY, "claude-sonnet-5"));
    tracker.ingest(request(JUDGE, "claude-sonnet-5", { role: "judge" }));
    tracker.ingest(response(JUDGE, "claude-sonnet-5", { role: "judge" }));
    expect(tracker.awaitingCostCalls()).toBe(2);
    // Same model, different roles: the judge's accrual must land on the judge
    // span even though the primary span is older.
    tracker.ingest(accrual("claude-sonnet-5", 900, { role: "judge" }));
    tracker.ingest(accrual("claude-sonnet-5", 4200));
    expect(tracker.awaitingCostCalls()).toBe(0);

    const primary = spans.find((s) => s.spanId === PRIMARY);
    const judge = spans.find((s) => s.spanId === JUDGE);
    expect(attr(primary, ATTR.CREWHAUS_COST_USD_MICROS)?.intValue).toBe("4200");
    expect(attr(judge, ATTR.CREWHAUS_COST_USD_MICROS)?.intValue).toBe("900");
    // The accrual keeps its own point span too (pre-0.6.0 dashboards sum these).
    const accruals = spans.filter((s) => s.name === "cost_accrual");
    expect(accruals).toHaveLength(2);
    expect(attr(accruals[0], ATTR.CREWHAUS_MODEL_ROLE)?.stringValue).toBe("judge");
  });

  test("an unpriced accrual stamps the unpriced flag; a summary accrual stamps nothing", () => {
    const { tracker, spans } = tracked();
    tracker.ingest(request(sid("a"), "local/llama"));
    tracker.ingest(response(sid("a"), "local/llama"));
    tracker.ingest(
      accrual("local/llama", 0, {
        summary: true,
        inputTokens: 999,
      }),
    );
    // The summary total never prices a call.
    expect(tracker.awaitingCostCalls()).toBe(1);
    tracker.ingest(accrual("local/llama", 0, { unpriced: true }));
    const chat = spans.find((s) => s.spanId === sid("a"));
    expect(attr(chat, ATTR.CREWHAUS_COST_USD_MICROS)?.intValue).toBe("0");
    expect(attr(chat, ATTR.CREWHAUS_COST_UNPRICED)?.boolValue).toBe(true);
    expect(spans.some((s) => s.name === "cost_accrual.summary")).toBe(true);
  });

  test("an accrual with no waiting span is not an error, and the wait list stays bounded", () => {
    const { tracker, spans } = tracked();
    tracker.ingest(accrual("claude-sonnet-5", 100, { role: "subagent" }));
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("cost_accrual");
    // Cost tracking off: responses arrive, accruals never do.
    for (let i = 0; i < 80; i += 1) {
      const id = i.toString(16).padStart(16, "0");
      tracker.ingest(request(id, "claude-haiku-4-5"));
      tracker.ingest(response(id, "claude-haiku-4-5"));
    }
    expect(tracker.awaitingCostCalls()).toBeLessThanOrEqual(64);
    expect(spans.filter((s) => s.name === "gen_ai.chat")).toHaveLength(80);
  });

  test("the join key folds an absent role onto primary", () => {
    expect(modelCostJoinKey({ traceId: "t", model: "m" })).toBe(
      modelCostJoinKey({ traceId: "t", model: "m", role: "primary" }),
    );
    expect(modelCostJoinKey({ traceId: "t", model: "m", role: "judge" })).not.toBe(
      modelCostJoinKey({ traceId: "t", model: "m" }),
    );
  });
});

describe("model_stage / model_directive spans", () => {
  test("model_stage gets a dedicated span; a failed stage is ERROR with its cause", () => {
    const done: ModelStageEvent = {
      ...env(),
      kind: "model_stage",
      stage: "draft",
      strategy: "cascade",
      role: "draft",
      model: "claude-haiku-4-5",
      profile: "fast",
      outcome: "done",
      costUsdMicros: 120,
    };
    const span = buildModelStageSpan(done);
    expect(span.name).toBe("model_stage.draft");
    expect(span.status.code).toBe(STATUS_OK);
    expect(attr(span, ATTR.CREWHAUS_MODEL_STAGE)?.stringValue).toBe("draft");
    expect(attr(span, ATTR.CREWHAUS_MODEL_STRATEGY)?.stringValue).toBe("cascade");
    expect(attr(span, ATTR.CREWHAUS_MODEL_ROLE)?.stringValue).toBe("draft");
    expect(attr(span, ATTR.CREWHAUS_MODEL_PROFILE)?.stringValue).toBe("fast");
    expect(attr(span, ATTR.CREWHAUS_MODEL_STAGE_OUTCOME)?.stringValue).toBe("done");
    expect(attr(span, ATTR.CREWHAUS_COST_USD_MICROS)?.intValue).toBe("120");

    const failed = buildModelStageSpan({
      ...done,
      stage: "escalate",
      role: "escalation",
      outcome: "failed",
      cause: "escalation target unavailable",
    });
    expect(failed.status.code).toBe(STATUS_ERROR);
    expect(failed.status.message).toBe("escalation target unavailable");
    expect(attr(failed, ATTR.CREWHAUS_MODEL_STAGE_CAUSE)?.stringValue).toBe(
      "escalation target unavailable",
    );

    // Through the tracker: no longer the generic `crewhaus.model_stage` fallback.
    const { tracker, spans } = tracked();
    tracker.ingest(done);
    expect(spans[0]?.name).toBe("model_stage.draft");
  });

  test("model_directive: a refused directive stays OK and carries its reason", () => {
    const ev: ModelDirectiveEvent = {
      ...env(),
      kind: "model_directive",
      source: "repl",
      requested: "fast",
      resolved: "fast",
      accepted: false,
      reason: "forced lane outranked the directive",
    };
    const span = buildModelDirectiveSpan(ev);
    expect(span.name).toBe("model_directive");
    expect(span.status.code).toBe(STATUS_OK);
    expect(attr(span, ATTR.CREWHAUS_MODEL_DIRECTIVE_SOURCE)?.stringValue).toBe("repl");
    expect(attr(span, ATTR.CREWHAUS_MODEL_DIRECTIVE_REQUESTED)?.stringValue).toBe("fast");
    expect(attr(span, ATTR.CREWHAUS_MODEL_DIRECTIVE_RESOLVED)?.stringValue).toBe("fast");
    expect(attr(span, ATTR.CREWHAUS_MODEL_DIRECTIVE_ACCEPTED)?.boolValue).toBe(false);
    expect(attr(span, ATTR.CREWHAUS_MODEL_DIRECTIVE_REASON)?.stringValue).toBe(
      "forced lane outranked the directive",
    );
    const { tracker, spans } = tracked();
    tracker.ingest(ev as TraceEvent);
    expect(spans[0]?.name).toBe("model_directive");
  });
});

describe("additive attribution on route / eval / judge spans", () => {
  test("model_route carries profile, scope, rule, hint, eligible, classifier label", () => {
    const ev: ModelRouteEvent = {
      ...env(),
      kind: "model_route",
      routeKey: "main/hard",
      model: "claude-opus-5",
      specModel: "anthropic/claude-opus-5",
      policy: "heuristic",
      reason: "rule matched",
      profile: "strong",
      stage: "escalation",
      strategy: "cascade",
      scope: "main",
      ruleId: "code-goes-strong",
      hint: { source: "rule", forcedArm: "strong" },
      eligible: ["fast", "strong"],
      toolsetFingerprint: "ts-1",
      classifierVerdict: { label: "strong" },
    };
    const span = buildModelRouteSpan(ev);
    expect(attr(span, ATTR.CREWHAUS_MODEL_PROFILE)?.stringValue).toBe("strong");
    expect(attr(span, ATTR.CREWHAUS_MODEL_SPEC)?.stringValue).toBe("anthropic/claude-opus-5");
    expect(attr(span, ATTR.CREWHAUS_MODEL_STAGE)?.stringValue).toBe("escalation");
    expect(attr(span, ATTR.CREWHAUS_MODEL_STRATEGY)?.stringValue).toBe("cascade");
    expect(attr(span, ATTR.CREWHAUS_ROUTE_SCOPE)?.stringValue).toBe("main");
    expect(attr(span, ATTR.CREWHAUS_ROUTE_RULE_ID)?.stringValue).toBe("code-goes-strong");
    expect(attr(span, ATTR.CREWHAUS_ROUTE_HINT_SOURCE)?.stringValue).toBe("rule");
    expect(attr(span, ATTR.CREWHAUS_ROUTE_ELIGIBLE)?.stringValue).toBe("fast,strong");
    expect(attr(span, ATTR.CREWHAUS_ROUTE_TOOLSET_FINGERPRINT)?.stringValue).toBe("ts-1");
    expect(attr(span, ATTR.CREWHAUS_ROUTE_CLASSIFIER_LABEL)?.stringValue).toBe("strong");
  });

  test("a 0.5.x route span carries none of the new keys", () => {
    const span = buildModelRouteSpan({
      ...env(),
      kind: "model_route",
      routeKey: "hard",
      model: "m",
      policy: "static",
      reason: "only candidate",
    });
    const keys = span.attributes.map((a) => a.key);
    for (const k of [
      ATTR.CREWHAUS_MODEL_PROFILE,
      ATTR.CREWHAUS_ROUTE_SCOPE,
      ATTR.CREWHAUS_ROUTE_RULE_ID,
      ATTR.CREWHAUS_ROUTE_HINT_SOURCE,
      ATTR.CREWHAUS_ROUTE_ELIGIBLE,
    ]) {
      expect(keys).not.toContain(k);
    }
  });

  test("eval_graded carries graded model, judge model, judge cost and escalation target", () => {
    const ev: EvalGradedEvent = {
      ...env(),
      kind: "eval_graded",
      score: 0.4,
      threshold: 0.7,
      verdict: "fail",
      graderType: "llm_judge",
      retryIndex: 0,
      model: "claude-haiku-4-5",
      profile: "fast",
      judgeModel: "claude-sonnet-5",
      judgeCostUsdMicros: 310,
      escalatedTo: "anthropic/claude-opus-5",
      reason: "judge_share_exhausted",
    };
    const span = buildEvalGradedSpan(ev);
    expect(attr(span, ATTR.GEN_AI_REQUEST_MODEL)?.stringValue).toBe("claude-haiku-4-5");
    expect(attr(span, ATTR.CREWHAUS_MODEL_PROFILE)?.stringValue).toBe("fast");
    expect(attr(span, ATTR.CREWHAUS_JUDGE_MODEL)?.stringValue).toBe("claude-sonnet-5");
    expect(attr(span, ATTR.CREWHAUS_JUDGE_COST_USD_MICROS)?.intValue).toBe("310");
    expect(attr(span, ATTR.CREWHAUS_EVAL_ESCALATED_TO)?.stringValue).toBe(
      "anthropic/claude-opus-5",
    );
    expect(attr(span, ATTR.CREWHAUS_EVAL_REASON)?.stringValue).toBe("judge_share_exhausted");
    expect(span.status.code).toBe(STATUS_ERROR);
  });

  test("judge_verdict carries the judge, the panel and the gate's cost", () => {
    const ev: JudgeVerdictEvent = {
      ...env(),
      kind: "judge_verdict",
      stepOrNode: "review",
      verdict: "pass",
      score: 0.9,
      judgeModel: "claude-sonnet-5",
      panel: ["claude-sonnet-5", "gpt-4o"],
      costUsdMicros: 640,
    };
    const span = buildJudgeVerdictSpan(ev);
    expect(attr(span, ATTR.CREWHAUS_JUDGE_MODEL)?.stringValue).toBe("claude-sonnet-5");
    expect(attr(span, ATTR.CREWHAUS_JUDGE_PANEL)?.stringValue).toBe("claude-sonnet-5,gpt-4o");
    expect(attr(span, ATTR.CREWHAUS_JUDGE_COST_USD_MICROS)?.intValue).toBe("640");
    expect(span.status.code).toBe(STATUS_OK);
  });
});
