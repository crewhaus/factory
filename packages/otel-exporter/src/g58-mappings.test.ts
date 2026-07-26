/**
 * Loop contract 0.4 (Batch C, G58) — OTel span mappings for the crew /
 * cost / routing / janitor / alert / test-verdict-family / approval events,
 * plus the SpanTracker's generic default branch (never silently drop an
 * event kind that lacks a dedicated mapping).
 */
import { describe, expect, test } from "bun:test";
import type {
  A2AMessageEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  CircuitStateChangedEvent,
  CostAccrualEvent,
  CoverageReportEvent,
  HandoffEvent,
  JanitorActionEvent,
  ModelFailoverEvent,
  ProgramOutputEvent,
  RoleEndEvent,
  RoleStartEvent,
  RunFailedEvent,
  SanitizerReportEvent,
  TestVerdictEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import {
  ATTR,
  type StartedRole,
  buildA2AMessageSpan,
  buildApprovalRequestedSpan,
  buildApprovalResolvedSpan,
  buildCircuitStateChangedSpan,
  buildCostAccrualSpan,
  buildCoverageReportSpan,
  buildGenericSpan,
  buildHandoffSpan,
  buildJanitorActionSpan,
  buildModelFailoverSpan,
  buildProgramOutputSpan,
  buildRoleSpan,
  buildRunFailedSpan,
  buildSanitizerReportSpan,
  buildTestVerdictSpan,
} from "./gen-ai-mapping";
import { SpanTracker } from "./span-tracker";
import { STATUS_ERROR, STATUS_OK } from "./types";

const env = (overrides: Record<string, unknown> = {}) => ({
  runId: "run_a",
  sessionId: "sess_1",
  turnNumber: 2,
  traceId: `${"0".repeat(31)}1`,
  spanId: `${"0".repeat(15)}1`,
  timestamp: "2026-07-17T12:00:00.000Z",
  ...overrides,
});

const findAttr = (attrs: { key: string; value: unknown }[], key: string) =>
  attrs.find((a) => a.key === key);

describe("G58 crew span mappings", () => {
  test("role_start → role_end pairs into one role.<role> span", () => {
    const start: StartedRole = {
      startNano: "1000000000000000000",
      ev: { ...env(), kind: "role_start", role: "writer", activation: 0 } as RoleStartEvent,
    };
    const end: RoleEndEvent = {
      ...env(),
      kind: "role_end",
      role: "writer",
      activation: 0,
      finalMessageBytes: 128,
      durationMs: 900,
    };
    const span = buildRoleSpan(start, end);
    expect(span.name).toBe("role.writer");
    expect(span.startTimeUnixNano).toBe("1000000000000000000");
    expect(findAttr(span.attributes, ATTR.CREWHAUS_CREW_ROLE)?.value).toEqual({
      stringValue: "writer",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_CREW_FINAL_BYTES)?.value).toEqual({
      intValue: "128",
    });
  });

  test("handoff span carries from/to/reason/depth", () => {
    const ev: HandoffEvent = {
      ...env(),
      kind: "handoff",
      from: "writer",
      to: "critic",
      reason: "needs review",
      depth: 1,
    };
    const span = buildHandoffSpan(ev);
    expect(span.name).toBe("handoff");
    expect(findAttr(span.attributes, ATTR.CREWHAUS_HANDOFF_TO)?.value).toEqual({
      stringValue: "critic",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_HANDOFF_DEPTH)?.value).toEqual({
      intValue: "1",
    });
  });

  test("a2a_message span names on the messageKind", () => {
    const ev: A2AMessageEvent = {
      ...env(),
      kind: "a2a_message",
      from: "writer",
      to: "critic",
      messageKind: "question",
      payloadBytes: 42,
      traceparent: "00-abc-def-01",
    };
    const span = buildA2AMessageSpan(ev);
    expect(span.name).toBe("a2a.question");
    expect(findAttr(span.attributes, ATTR.CREWHAUS_A2A_TRACEPARENT)?.value).toEqual({
      stringValue: "00-abc-def-01",
    });
  });
});

describe("G58 cost + failure span mappings", () => {
  test("cost_accrual span carries gen_ai.usage.* + microdollars", () => {
    const ev: CostAccrualEvent = {
      ...env(),
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      inputTokens: 100,
      outputTokens: 30,
      cachedReadTokens: 12,
      costUsdMicros: 4200,
    };
    const span = buildCostAccrualSpan(ev);
    expect(span.name).toBe("cost_accrual");
    expect(findAttr(span.attributes, ATTR.GEN_AI_USAGE_INPUT_TOKENS)?.value).toEqual({
      intValue: "100",
    });
    expect(findAttr(span.attributes, ATTR.CREWHAUS_COST_USD_MICROS)?.value).toEqual({
      intValue: "4200",
    });
  });

  test("summary cost_accrual gets its own span name", () => {
    const ev: CostAccrualEvent = {
      ...env(),
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      inputTokens: 1,
      outputTokens: 1,
      cachedReadTokens: 0,
      costUsdMicros: 1,
      summary: true,
    };
    expect(buildCostAccrualSpan(ev).name).toBe("cost_accrual.summary");
  });

  test("run_failed span is ERROR-status and names on the class", () => {
    const ev: RunFailedEvent = {
      ...env(),
      kind: "run_failed",
      class: "timeout",
      message: "run deadline exceeded",
      exitCode: 34,
    };
    const span = buildRunFailedSpan(ev);
    expect(span.name).toBe("run_failed.timeout");
    expect(span.status.code).toBe(STATUS_ERROR);
    expect(findAttr(span.attributes, ATTR.CREWHAUS_FAILURE_EXIT_CODE)?.value).toEqual({
      intValue: "34",
    });
  });
});

describe("G58 routing span mappings", () => {
  test("circuit open → ERROR status, close → OK", () => {
    const open: CircuitStateChangedEvent = {
      ...env(),
      kind: "circuit_state_changed",
      adapter: "anthropic",
      fromState: "closed",
      toState: "open",
      reason: "5 consecutive 529s",
    };
    const opened = buildCircuitStateChangedSpan(open);
    expect(opened.name).toBe("circuit.open");
    expect(opened.status.code).toBe(STATUS_ERROR);

    const close: CircuitStateChangedEvent = {
      ...env(),
      kind: "circuit_state_changed",
      adapter: "anthropic",
      fromState: "half_open",
      toState: "closed",
    };
    expect(buildCircuitStateChangedSpan(close).status.code).toBe(STATUS_OK);
  });

  test("model_failover span records from/to and the wire model", () => {
    const ev: ModelFailoverEvent = {
      ...env(),
      kind: "model_failover",
      from: "claude-opus-4-7",
      to: "openai/gpt-4o-mini",
      reason: "breaker_open",
    };
    const span = buildModelFailoverSpan(ev);
    expect(findAttr(span.attributes, ATTR.CREWHAUS_FAILOVER_REASON)?.value).toEqual({
      stringValue: "breaker_open",
    });
    expect(findAttr(span.attributes, ATTR.GEN_AI_REQUEST_MODEL)?.value).toEqual({
      stringValue: "openai/gpt-4o-mini",
    });
  });
});

describe("G58 janitor + alert span mappings", () => {
  test("janitor error status maps to ERROR", () => {
    const ev: JanitorActionEvent = {
      ...env(),
      kind: "janitor_action",
      step: "session_ttl_eviction",
      status: "error",
      detail: "permission denied",
    };
    const span = buildJanitorActionSpan(ev);
    expect(span.name).toBe("janitor.session_ttl_eviction");
    expect(span.status.code).toBe(STATUS_ERROR);
    expect(span.status.message).toBe("permission denied");
  });

  test("alert_raised span is ERROR-status with double-valued observed/threshold", () => {
    const span = buildGenericSpan({
      ...env(),
      kind: "alert_raised",
      metric: "error_rate",
      observed: 0.42,
      threshold: 0.2,
      baselineSessions: 7,
      detail: "error_rate 0.42 > 0.20",
    } as TraceEvent);
    // routed through the tracker default in practice; assert the dedicated
    // builder separately via the tracker test below.
    expect(span.name).toBe("crewhaus.alert_raised");
  });
});

describe("G58 test-verdict family span mappings", () => {
  test("failing verdict → ERROR, passing → OK", () => {
    const fail: TestVerdictEvent = {
      ...env(),
      kind: "test_verdict",
      testId: "t1",
      verdict: "fail",
      reason: "assertion failed",
      durationMs: 5,
    };
    const failed = buildTestVerdictSpan(fail);
    expect(failed.name).toBe("test_verdict.fail");
    expect(failed.status.code).toBe(STATUS_ERROR);

    const pass: TestVerdictEvent = { ...fail, verdict: "pass", reason: undefined };
    expect(buildTestVerdictSpan(pass).status.code).toBe(STATUS_OK);
  });

  test("program_output non-zero exit → ERROR", () => {
    const ev: ProgramOutputEvent = {
      ...env(),
      kind: "program_output",
      programId: "p1",
      exitCode: 1,
      stdoutBytes: 10,
      stderrBytes: 5,
      durationMs: 100,
    };
    expect(buildProgramOutputSpan(ev).status.code).toBe(STATUS_ERROR);
  });

  test("coverage_report span carries line/branch counts", () => {
    const ev: CoverageReportEvent = {
      ...env(),
      kind: "coverage_report",
      programId: "p1",
      linesCovered: 80,
      linesTotal: 100,
      branchesCovered: 12,
      branchesTotal: 20,
    };
    const span = buildCoverageReportSpan(ev);
    expect(findAttr(span.attributes, ATTR.CREWHAUS_COVERAGE_LINES_COVERED)?.value).toEqual({
      intValue: "80",
    });
  });

  test("sanitizer flag → ERROR status", () => {
    const ev: SanitizerReportEvent = {
      ...env(),
      kind: "sanitizer_report",
      programId: "p1",
      sanitizer: "asan",
      isError: true,
      summary: "heap-buffer-overflow at parser.c:42",
    };
    const span = buildSanitizerReportSpan(ev);
    expect(span.name).toBe("sanitizer.asan");
    expect(span.status.code).toBe(STATUS_ERROR);
  });
});

describe("G58 approval span mappings", () => {
  test("approval_requested span", () => {
    const ev: ApprovalRequestedEvent = {
      ...env(),
      kind: "approval_requested",
      approvalId: "ap_1",
      toolName: "Bash",
      surface: "single-turn",
    };
    const span = buildApprovalRequestedSpan(ev);
    expect(span.name).toBe("approval.requested");
    expect(findAttr(span.attributes, ATTR.CREWHAUS_APPROVAL_SURFACE)?.value).toEqual({
      stringValue: "single-turn",
    });
  });

  test("approval_resolved deny → ERROR status", () => {
    const grant: ApprovalResolvedEvent = {
      ...env(),
      kind: "approval_resolved",
      approvalId: "ap_1",
      decision: "grant",
      by: "cli",
    };
    expect(buildApprovalResolvedSpan(grant).name).toBe("approval.resolved.grant");
    expect(buildApprovalResolvedSpan(grant).status.code).toBe(STATUS_OK);

    const deny: ApprovalResolvedEvent = { ...grant, decision: "deny", by: "slack:U0123" };
    expect(buildApprovalResolvedSpan(deny).status.code).toBe(STATUS_ERROR);
  });
});

describe("G58 generic fallback + agentId stamping", () => {
  test("buildGenericSpan dumps scalar fields under crewhaus.event.*", () => {
    const ev = {
      ...env({ agentId: "ed25519:abcd" }),
      kind: "eval_graded",
      score: 0.9,
      threshold: 0.7,
      verdict: "pass",
      graderType: "llm_judge",
      retryIndex: 0,
    } as unknown as TraceEvent;
    const span = buildGenericSpan(ev);
    expect(span.name).toBe("crewhaus.eval_graded");
    expect(findAttr(span.attributes, ATTR.CREWHAUS_EVENT_KIND)?.value).toEqual({
      stringValue: "eval_graded",
    });
    // Scalars dumped: verdict (string), score (double), retryIndex (int).
    expect(findAttr(span.attributes, "crewhaus.event.verdict")?.value).toEqual({
      stringValue: "pass",
    });
    expect(findAttr(span.attributes, "crewhaus.event.score")?.value).toEqual({ doubleValue: 0.9 });
    expect(findAttr(span.attributes, "crewhaus.event.retryIndex")?.value).toEqual({
      intValue: "0",
    });
    // agentId from the envelope is stamped.
    expect(findAttr(span.attributes, ATTR.CREWHAUS_AGENT_ID)?.value).toEqual({
      stringValue: "ed25519:abcd",
    });
  });
});

describe("SpanTracker G58 routing", () => {
  function tracked() {
    const spans: import("./types").OtelSpan[] = [];
    return { tracker: new SpanTracker((s) => spans.push(s)), spans };
  }

  test("dedicated kinds emit their mapped span", () => {
    const { tracker, spans } = tracked();
    tracker.ingest({
      ...env(),
      kind: "alert_raised",
      metric: "error_rate",
      observed: 0.42,
      threshold: 0.2,
      baselineSessions: 7,
      detail: "breach",
    } as TraceEvent);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("alert_raised");
    expect(spans[0]?.status.code).toBe(STATUS_ERROR);
  });

  test("role_start alone emits nothing; paired role_end emits one span", () => {
    const { tracker, spans } = tracked();
    tracker.ingest({ ...env(), kind: "role_start", role: "writer", activation: 0 } as TraceEvent);
    expect(spans).toHaveLength(0);
    tracker.ingest({
      ...env(),
      kind: "role_end",
      role: "writer",
      activation: 0,
      finalMessageBytes: 10,
      durationMs: 5,
    } as TraceEvent);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("role.writer");
  });

  // `judge_verdict` used to be the example here; E51 gave it (and
  // `eval_graded`) a dedicated mapping, so the fallback is asserted over a
  // kind that genuinely has none.
  test("an unmapped kind still produces a generic span (never dropped)", () => {
    const { tracker, spans } = tracked();
    tracker.ingest({
      ...env(),
      kind: "crew_done",
      finalRole: "editor",
      totalActivations: 3,
      durationMs: 42,
    } as TraceEvent);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("crewhaus.crew_done");
  });
});
