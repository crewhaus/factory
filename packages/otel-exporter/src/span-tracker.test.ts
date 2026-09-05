/**
 * SpanTracker — lifecycle pairing tests, plus the F1 regression: item 14
 * (advisor groundwork) added a SECOND `permission_decision` publish for the
 * ask RESOLUTION (`askOutcome` set) alongside the pre-existing pre-prompt
 * publish (`decision: "ask"`, no `askOutcome`). `ingest` must still emit
 * exactly one span per ask — the resolved one, mirroring the advisor
 * persistence subscriber's de-dupe in runtime-core/observability.ts.
 */
import { describe, expect, test } from "bun:test";
import type {
  ModelRequestEvent,
  ModelResponseEvent,
  PermissionDecisionEvent,
} from "@crewhaus/trace-event-bus";
import { SpanTracker } from "./span-tracker";
import type { OtelSpan } from "./types";

const env = (overrides: Record<string, unknown> = {}) => ({
  runId: "run_a",
  sessionId: "sess_1",
  turnNumber: 1,
  traceId: `${"0".repeat(31)}1`,
  spanId: `${"0".repeat(15)}1`,
  timestamp: "2026-05-07T12:00:00.000Z",
  ...overrides,
});

function tracked(): { tracker: SpanTracker; spans: OtelSpan[] } {
  const spans: OtelSpan[] = [];
  const tracker = new SpanTracker((span) => spans.push(span));
  return { tracker, spans };
}

describe("SpanTracker permission_decision de-dupe", () => {
  test("interactive-resolution ask path: pre-prompt + resolution → exactly one span", () => {
    const { tracker, spans } = tracked();
    // Pre-prompt publish (runtime-core/index.ts ~:1216) — decision "ask",
    // no askOutcome yet.
    const prePrompt: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Bash",
      decision: "ask",
      mode: "default",
    };
    // Resolution publish (runtime-core/index.ts ~:1242) — same ask, now
    // carrying askOutcome after askApproval() resolves.
    const resolution: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Bash",
      decision: "ask",
      mode: "default",
      askOutcome: "approved",
    };
    tracker.ingest(prePrompt);
    tracker.ingest(resolution);

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("permission.ask");
  });

  test("single-turn collapse-to-deny path: pre-prompt + denied resolution → exactly one span", () => {
    const { tracker, spans } = tracked();
    const prePrompt: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Write",
      decision: "ask",
      mode: "default",
    };
    // Single-turn mode has no interactive surface, so the ask collapses to
    // a denial — the resolution still carries askOutcome: "denied".
    const resolution: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Write",
      decision: "ask",
      mode: "default",
      askOutcome: "denied",
    };
    tracker.ingest(prePrompt);
    tracker.ingest(resolution);

    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("permission.ask");
  });

  test("allow/deny decisions (no askOutcome) still emit exactly one span each", () => {
    const { tracker, spans } = tracked();
    const allow: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Read",
      decision: "allow",
      mode: "default",
    };
    const deny: PermissionDecisionEvent = {
      ...env(),
      kind: "permission_decision",
      toolName: "Bash",
      decision: "deny",
      mode: "default",
      reason: "blocked by rule",
    };
    tracker.ingest(allow);
    tracker.ingest(deny);

    expect(spans).toHaveLength(2);
    expect(spans.map((s) => s.name).sort()).toEqual(["permission.allow", "permission.deny"]);
  });
});

describe("SpanTracker model pairing keyed by spanId (0.6.0 §8.4)", () => {
  const request = (spanId: string, model: string, role?: ModelRequestEvent["role"]) =>
    ({
      ...env({ spanId }),
      kind: "model_request",
      model,
      messageCount: 1,
      toolCount: 0,
      streaming: false,
      ...(role !== undefined ? { role } : {}),
    }) satisfies ModelRequestEvent;
  const response = (spanId: string, model: string, role?: ModelResponseEvent["role"]) =>
    ({
      ...env({ spanId, timestamp: "2026-05-07T12:00:01.000Z" }),
      kind: "model_response",
      model,
      stopReason: "end_turn",
      usage: { input: 10, output: 5 },
      durationMs: 1000,
      ...(role !== undefined ? { role } : {}),
    }) satisfies ModelResponseEvent;
  const attr = (span: OtelSpan, key: string) =>
    span.attributes.find((a) => a.key === key)?.value as { stringValue?: string } | undefined;

  test("a draft and a shadow call in flight together pair request↔response by spanId, not by order", () => {
    const { tracker, spans } = tracked();
    const DRAFT = `${"0".repeat(15)}a`;
    const SHADOW = `${"0".repeat(15)}b`;
    tracker.ingest(request(DRAFT, "claude-haiku-4-5", "draft"));
    tracker.ingest(request(SHADOW, "claude-sonnet-5", "shadow"));
    expect(tracker.inFlightModelCalls()).toBe(2);
    // The SHADOW response arrives first — the single-slot tracker this
    // replaced would have paired it with whichever request came last and
    // dropped the other.
    tracker.ingest(response(SHADOW, "claude-sonnet-5", "shadow"));
    tracker.ingest(response(DRAFT, "claude-haiku-4-5", "draft"));
    expect(spans).toHaveLength(2);
    expect(tracker.inFlightModelCalls()).toBe(0);
    const bySpan = new Map(spans.map((s) => [s.spanId, s]));
    const shadow = bySpan.get(SHADOW);
    const draft = bySpan.get(DRAFT);
    expect(shadow?.name).toBe("gen_ai.chat");
    expect(attr(shadow as OtelSpan, "gen_ai.request.model")?.stringValue).toBe("claude-sonnet-5");
    expect(attr(shadow as OtelSpan, "crewhaus.model.role")?.stringValue).toBe("shadow");
    expect(attr(draft as OtelSpan, "gen_ai.request.model")?.stringValue).toBe("claude-haiku-4-5");
    expect(attr(draft as OtelSpan, "crewhaus.model.role")?.stringValue).toBe("draft");
  });

  test("a response under a fresh envelope still pairs with the latest in-flight request (LIFO fallback)", () => {
    const { tracker, spans } = tracked();
    tracker.ingest(request(`${"0".repeat(15)}a`, "claude-haiku-4-5"));
    tracker.ingest(response(`${"0".repeat(15)}f`, "claude-haiku-4-5"));
    expect(spans).toHaveLength(1);
    expect(tracker.inFlightModelCalls()).toBe(0);
    // An unattributed pair carries none of the attribution attributes.
    const keys = spans[0]?.attributes.map((a) => a.key) ?? [];
    expect(keys).not.toContain("crewhaus.model.role");
    expect(keys).not.toContain("crewhaus.model.profile");
    expect(keys).not.toContain("crewhaus.model.stage");
  });

  test("stream tokens attach to the latest in-flight call; an orphan response emits nothing", () => {
    const { tracker, spans } = tracked();
    tracker.ingest(response(`${"0".repeat(15)}9`, "claude-haiku-4-5"));
    expect(spans).toHaveLength(0);
    const A = `${"0".repeat(15)}a`;
    tracker.ingest(request(A, "claude-haiku-4-5"));
    tracker.ingest({
      ...env({ spanId: `${"0".repeat(15)}c` }),
      kind: "model_stream_token",
      chunkIndex: 0,
      deltaChars: 3,
    });
    tracker.ingest(response(A, "claude-haiku-4-5"));
    expect(spans).toHaveLength(1);
    expect(spans[0]?.events).toHaveLength(1);
  });
});

describe("SpanTracker abandons in-flight model calls (review of #424)", () => {
  // runtime-core publishes `model_response` on its two success paths only; a
  // stream that throws leaves its `model_request` unpaired. On origin/main the
  // single `this.model` slot was overwritten by the next request; keyed by
  // spanId, every failed call would otherwise stay in the Map — with every
  // stream-token event it collected — for the life of the process.
  const request = (spanId: string, ts = "2026-05-07T12:00:00.000Z") =>
    ({
      ...env({ spanId, timestamp: ts }),
      kind: "model_request",
      model: "claude-haiku-4-5",
      messageCount: 1,
      toolCount: 0,
      streaming: true,
    }) satisfies ModelRequestEvent;
  const response = (spanId: string) =>
    ({
      ...env({ spanId, timestamp: "2026-05-07T12:00:01.000Z" }),
      kind: "model_response",
      model: "claude-haiku-4-5",
      stopReason: "end_turn",
      usage: { input: 10, output: 5 },
      durationMs: 1000,
    }) satisfies ModelResponseEvent;
  const token = (chunkIndex: number) => ({
    ...env({ spanId: `${"0".repeat(15)}c` }),
    kind: "model_stream_token" as const,
    chunkIndex,
    deltaChars: 3,
  });
  const turnEnd = () => ({
    ...env({ timestamp: "2026-05-07T12:00:02.000Z" }),
    kind: "turn_end" as const,
    turn: 1,
    durationMs: 2000,
  });
  const STATUS_ERROR = 2;
  const STATUS_OK = 1;
  const A = `${"0".repeat(15)}a`;
  const B = `${"0".repeat(15)}b`;

  test("model_request → stream tokens → turn_end with no response leaves nothing in flight", () => {
    const { tracker, spans } = tracked();
    tracker.ingest({ ...env(), kind: "turn_start", turn: 1, messageCount: 0 });
    tracker.ingest(request(A));
    tracker.ingest(token(0));
    tracker.ingest(token(1));
    expect(tracker.inFlightModelCalls()).toBe(1);
    tracker.ingest(turnEnd());
    expect(tracker.inFlightModelCalls()).toBe(0);
    // The failure is visible: an ERROR-status gen_ai.chat span built from the
    // request (carrying the tokens it streamed), then the turn span last.
    expect(spans.map((s) => s.name)).toEqual(["gen_ai.chat", "turn"]);
    const chat = spans[0] as OtelSpan;
    expect(chat.spanId).toBe(A);
    expect(chat.status.code).toBe(STATUS_ERROR);
    expect(chat.status.message).toBe("no model_response before turn_end");
    expect(chat.events).toHaveLength(2);
    expect(chat.endTimeUnixNano).toBe(`${BigInt(Date.parse("2026-05-07T12:00:02.000Z"))}000000`);
    expect(chat.attributes.find((a) => a.key === "gen_ai.request.model")?.value).toEqual({
      stringValue: "claude-haiku-4-5",
    });
    expect(chat.attributes.find((a) => a.key === "crewhaus.error.name")?.value).toEqual({
      stringValue: "model_response_missing",
    });
  });

  test("repeated request-without-response cycles across turn_ends do not accumulate", () => {
    const { tracker } = tracked();
    for (let i = 0; i < 5; i++) {
      tracker.ingest(request(`${"0".repeat(15)}${i}`));
      tracker.ingest(token(0));
      tracker.ingest(turnEnd());
    }
    expect(tracker.inFlightModelCalls()).toBe(0);
  });

  test("error_recovered closes the failed call; the retry's request/response pair normally", () => {
    const { tracker, spans } = tracked();
    tracker.ingest(request(A));
    tracker.ingest({
      ...env({ spanId: `${"0".repeat(15)}e`, timestamp: "2026-05-07T12:00:00.500Z" }),
      kind: "error_recovered",
      action: "retry",
      errorName: "ProviderError",
      depth: 1,
    });
    expect(tracker.inFlightModelCalls()).toBe(0);
    tracker.ingest(request(B));
    tracker.ingest(response(B));
    expect(tracker.inFlightModelCalls()).toBe(0);
    expect(spans.map((s) => s.name)).toEqual([
      "gen_ai.chat",
      "error_recovered.retry",
      "gen_ai.chat",
    ]);
    expect(spans[0]?.spanId).toBe(A);
    expect(spans[0]?.status.code).toBe(STATUS_ERROR);
    expect(spans[0]?.status.message).toBe("no model_response before error_recovered");
    expect(spans[2]?.spanId).toBe(B);
    expect(spans[2]?.status.code).toBe(STATUS_OK);
  });

  test("model_failover does NOT close the call — the chain publishes it mid-stream and the call then completes", () => {
    const { tracker, spans } = tracked();
    tracker.ingest(request(A));
    tracker.ingest({
      ...env({ spanId: `${"0".repeat(15)}f` }),
      kind: "model_failover",
      from: "claude-haiku-4-5",
      to: "claude-sonnet-5",
      reason: "candidate_error",
    });
    expect(tracker.inFlightModelCalls()).toBe(1);
    tracker.ingest(response(A));
    expect(tracker.inFlightModelCalls()).toBe(0);
    const chat = spans.find((s) => s.name === "gen_ai.chat");
    expect(chat?.spanId).toBe(A);
    expect(chat?.status.code).toBe(STATUS_OK);
  });

  test("a response arriving after its call was abandoned is dropped, not LIFO-paired", () => {
    const { tracker, spans } = tracked();
    tracker.ingest(request(A));
    tracker.ingest(turnEnd());
    expect(spans).toHaveLength(1); // A, abandoned
    tracker.ingest(request(B));
    tracker.ingest(response(A)); // late
    expect(spans).toHaveLength(1);
    expect(tracker.inFlightModelCalls()).toBe(1); // B untouched
    tracker.ingest(response(B));
    expect(spans).toHaveLength(2);
    expect(spans[1]?.spanId).toBe(B);
    expect(spans[1]?.status.code).toBe(STATUS_OK);
  });

  test("hard cap: more than 32 requests without responses evicts the oldest", () => {
    const { tracker, spans } = tracked();
    for (let i = 0; i < 40; i++) tracker.ingest(request(i.toString(16).padStart(16, "0")));
    expect(tracker.inFlightModelCalls()).toBe(32);
    expect(spans).toHaveLength(8);
    for (const s of spans) {
      expect(s.status.code).toBe(STATUS_ERROR);
      expect(s.status.message).toBe("no model_response before in_flight_cap");
    }
    expect(spans.map((s) => s.spanId)).toEqual(
      Array.from({ length: 8 }, (_, i) => i.toString(16).padStart(16, "0")),
    );
  });
});

describe("SpanTracker turn pairing", () => {
  test("turn_start + turn_end emits one turn span", () => {
    const { tracker, spans } = tracked();
    tracker.ingest({ ...env(), kind: "turn_start", turn: 1, messageCount: 0 });
    tracker.ingest({ ...env(), kind: "turn_end", turn: 1, durationMs: 5 });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("turn");
  });
});
