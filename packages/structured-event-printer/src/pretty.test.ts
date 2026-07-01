/**
 * T1 unit tests — pretty formatter golden-file coverage per kind.
 */
import { describe, expect, test } from "bun:test";
import type { TraceEvent, TraceEventEnvelope } from "@crewhaus/trace-event-bus";
import { formatJsonLine } from "./json";
import { formatLine } from "./pretty";

const env = (overrides: Partial<TraceEvent> = {}) => ({
  runId: "run_a",
  sessionId: "sess_1",
  turnNumber: 1,
  traceId: `${"0".repeat(31)}1`,
  spanId: `${"0".repeat(15)}1`,
  timestamp: "2026-05-07T12:00:00.000Z",
  ...overrides,
});

describe("formatLine — pretty", () => {
  test("turn_start", () => {
    const ev = { ...env(), kind: "turn_start", turn: 3, messageCount: 7 } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      "2026-05-07T12:00:00.000Z [turn_start]           turn=3 messages=7",
    );
  });

  test("turn_end with stop reason", () => {
    const ev = {
      ...env(),
      kind: "turn_end",
      turn: 3,
      durationMs: 1234.5,
      stopReason: "end_turn",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      "2026-05-07T12:00:00.000Z [turn_end]             turn=3 duration=1235ms stop=end_turn",
    );
  });

  test("model_request streaming", () => {
    const ev = {
      ...env(),
      kind: "model_request",
      model: "claude-opus-4-7",
      messageCount: 5,
      toolCount: 3,
      streaming: true,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      "2026-05-07T12:00:00.000Z [model_request]        model=claude-opus-4-7 messages=5 tools=3 streaming",
    );
  });

  test("tool_call_end with error", () => {
    const ev = {
      ...env(),
      kind: "tool_call_end",
      toolUseId: "toolu_x",
      toolName: "Bash",
      isError: true,
      outputBytes: 256,
      durationMs: 42,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      "2026-05-07T12:00:00.000Z [tool_call_end]        tool=Bash id=toolu_x ERROR output=256B duration=42ms",
    );
  });

  test("model_response with usage", () => {
    const ev = {
      ...env(),
      kind: "model_response",
      model: "claude-opus-4-7",
      stopReason: "end_turn",
      usage: { input: 100, output: 50 },
      durationMs: 1000,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      "2026-05-07T12:00:00.000Z [model_response]       model=claude-opus-4-7 stop=end_turn in=100 out=50 duration=1000ms",
    );
  });
});

describe("formatBody — every kind + optional-field branches", () => {
  // A strongly-typed *envelope* (no variant payload). Spreading this — rather
  // than the loose `Partial<TraceEvent>` `env()` helper — keeps each event
  // literal below validated against its own variant, so cross-variant fields
  // (e.g. `summary`, which is `string` on sanitizer_report but `boolean` on
  // cost_accrual) don't leak in and break `satisfies TraceEvent`.
  const envelope: TraceEventEnvelope = {
    runId: "run_a",
    sessionId: "sess_1",
    turnNumber: 1,
    traceId: `${"0".repeat(31)}1`,
    spanId: `${"0".repeat(15)}1`,
    timestamp: "2026-05-07T12:00:00.000Z",
  };
  // The fixed prefix is "<timestamp> [<kind>]" padded so the kind bracket
  // occupies KIND_WIDTH (22) chars. Build it here so each assertion below
  // can focus on the kind-specific body, which is the load-bearing part.
  const prefix = (kind: TraceEvent["kind"]) =>
    `2026-05-07T12:00:00.000Z ${`[${kind}]`.padEnd(22)} `;

  test("turn_end WITHOUT stop reason omits the stop= suffix", () => {
    const ev = { ...envelope, kind: "turn_end", turn: 2, durationMs: 999.4 } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(`${prefix("turn_end")}turn=2 duration=999ms`);
  });

  test("model_request NON-streaming omits the streaming suffix", () => {
    const ev = {
      ...envelope,
      kind: "model_request",
      model: "claude-opus-4-7",
      messageCount: 4,
      toolCount: 0,
      streaming: false,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("model_request")}model=claude-opus-4-7 messages=4 tools=0`,
    );
  });

  test("model_stream_token", () => {
    const ev = {
      ...envelope,
      kind: "model_stream_token",
      chunkIndex: 7,
      deltaChars: 13,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(`${prefix("model_stream_token")}chunk=7 chars=13`);
  });

  test("tool_call_start", () => {
    const ev = {
      ...envelope,
      kind: "tool_call_start",
      toolUseId: "toolu_a",
      toolName: "Read",
      inputBytes: 64,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(`${prefix("tool_call_start")}tool=Read id=toolu_a input=64B`);
  });

  test("tool_call_end WITHOUT error omits the ERROR marker", () => {
    const ev = {
      ...envelope,
      kind: "tool_call_end",
      toolUseId: "toolu_b",
      toolName: "Read",
      isError: false,
      outputBytes: 128,
      durationMs: 9,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("tool_call_end")}tool=Read id=toolu_b output=128B duration=9ms`,
    );
  });

  test("tool_stream_chunk (stdout)", () => {
    const ev = {
      ...envelope,
      kind: "tool_stream_chunk",
      toolUseId: "toolu_c",
      toolName: "Bash",
      stream: "stdout",
      bytes: 512,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(`${prefix("tool_stream_chunk")}tool=Bash id=toolu_c stdout=512B`);
  });

  test("mcp_call_start", () => {
    const ev = {
      ...envelope,
      kind: "mcp_call_start",
      server: "github",
      toolName: "create_pr",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(`${prefix("mcp_call_start")}server=github tool=create_pr`);
  });

  test("mcp_call_end WITH error includes the ERROR marker", () => {
    const ev = {
      ...envelope,
      kind: "mcp_call_end",
      server: "github",
      toolName: "create_pr",
      isError: true,
      durationMs: 33,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("mcp_call_end")}server=github tool=create_pr ERROR duration=33ms`,
    );
  });

  test("mcp_call_end WITHOUT error omits the ERROR marker", () => {
    const ev = {
      ...envelope,
      kind: "mcp_call_end",
      server: "github",
      toolName: "list_issues",
      isError: false,
      durationMs: 5,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("mcp_call_end")}server=github tool=list_issues duration=5ms`,
    );
  });

  test("hook_fired WITH matcher + reason includes both", () => {
    const ev = {
      ...envelope,
      kind: "hook_fired",
      event: "PreToolUse",
      matcher: "Bash",
      allowed: false,
      durationMs: 2,
      reason: "blocked",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("hook_fired")}event=PreToolUse matcher=Bash allowed=false duration=2ms reason=blocked`,
    );
  });

  test("hook_fired WITHOUT matcher + reason omits both", () => {
    const ev = {
      ...envelope,
      kind: "hook_fired",
      event: "SessionStart",
      allowed: true,
      durationMs: 1,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("hook_fired")}event=SessionStart allowed=true duration=1ms`,
    );
  });

  test("compaction_fired", () => {
    const ev = {
      ...envelope,
      kind: "compaction_fired",
      subKind: "autocompact",
      before: 1000,
      after: 400,
      phase: "pre-turn",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("compaction_fired")}kind=autocompact phase=pre-turn before=1000 after=400`,
    );
  });

  test("permission_decision WITH outcome + reason includes both", () => {
    const ev = {
      ...envelope,
      kind: "permission_decision",
      toolName: "Bash",
      decision: "deny",
      mode: "default",
      outcome: "egress-blocked",
      reason: "tagged content",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("permission_decision")}tool=Bash decision=deny mode=default outcome=egress-blocked reason=tagged content`,
    );
  });

  test("permission_decision WITHOUT outcome + reason omits both", () => {
    const ev = {
      ...envelope,
      kind: "permission_decision",
      toolName: "Read",
      decision: "allow",
      mode: "acceptEdits",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("permission_decision")}tool=Read decision=allow mode=acceptEdits`,
    );
  });

  test("error_recovered", () => {
    const ev = {
      ...envelope,
      kind: "error_recovered",
      action: "retry",
      errorName: "OverloadedError",
      depth: 2,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("error_recovered")}action=retry error=OverloadedError depth=2`,
    );
  });

  test("sub_agent_start", () => {
    const ev = {
      ...envelope,
      kind: "sub_agent_start",
      name: "researcher",
      childRunId: "run_child",
      childSessionId: "sess_child",
      toolCount: 5,
      promptBytes: 2048,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("sub_agent_start")}name=researcher childRun=run_child tools=5 prompt=2048B`,
    );
  });

  test("sub_agent_end WITH error includes the ERROR marker", () => {
    const ev = {
      ...envelope,
      kind: "sub_agent_end",
      name: "researcher",
      childRunId: "run_child",
      childSessionId: "sess_child",
      isError: true,
      toolCallCount: 3,
      finalMessageBytes: 512,
      durationMs: 4321,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("sub_agent_end")}name=researcher childRun=run_child ERROR toolCalls=3 finalMsg=512B duration=4321ms`,
    );
  });

  test("sub_agent_end WITHOUT error omits the ERROR marker", () => {
    const ev = {
      ...envelope,
      kind: "sub_agent_end",
      name: "writer",
      childRunId: "run_child2",
      childSessionId: "sess_child2",
      isError: false,
      toolCallCount: 0,
      finalMessageBytes: 64,
      durationMs: 10,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("sub_agent_end")}name=writer childRun=run_child2 toolCalls=0 finalMsg=64B duration=10ms`,
    );
  });

  test("role_start", () => {
    const ev = {
      ...envelope,
      kind: "role_start",
      role: "planner",
      activation: 0,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(`${prefix("role_start")}role=planner activation=0`);
  });

  test("role_end", () => {
    const ev = {
      ...envelope,
      kind: "role_end",
      role: "planner",
      activation: 1,
      finalMessageBytes: 256,
      durationMs: 1500,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("role_end")}role=planner activation=1 finalMsg=256B duration=1500ms`,
    );
  });

  test("handoff WITH reason includes it", () => {
    const ev = {
      ...envelope,
      kind: "handoff",
      from: "planner",
      to: "coder",
      reason: "ready to implement",
      depth: 1,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("handoff")}from=planner to=coder depth=1 reason=ready to implement`,
    );
  });

  test("handoff WITHOUT reason omits it", () => {
    // `reason` is required by the type but the formatter guards on it being
    // falsy; an empty string exercises the false branch of `ev.reason ? …`.
    const ev = {
      ...envelope,
      kind: "handoff",
      from: "coder",
      to: "reviewer",
      reason: "",
      depth: 2,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(`${prefix("handoff")}from=coder to=reviewer depth=2`);
  });

  test("a2a_message", () => {
    const ev = {
      ...envelope,
      kind: "a2a_message",
      from: "planner",
      to: "coder",
      messageKind: "question",
      payloadBytes: 1024,
      traceparent: `00-${"0".repeat(31)}1-${"0".repeat(15)}1-01`,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("a2a_message")}from=planner to=coder kind=question payload=1024B`,
    );
  });

  test("crew_done", () => {
    const ev = {
      ...envelope,
      kind: "crew_done",
      finalRole: "reviewer",
      totalActivations: 4,
      durationMs: 12000,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("crew_done")}finalRole=reviewer activations=4 duration=12000ms`,
    );
  });

  test("cost_accrual WITH tenant includes the tenant= field", () => {
    const ev = {
      ...envelope,
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      inputTokens: 100,
      outputTokens: 50,
      cachedReadTokens: 10,
      costUsdMicros: 4200,
      tenantId: "acme",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("cost_accrual")}provider=anthropic model=claude-opus-4-7 tenant=acme in=100 out=50 cached=10 micros=4200`,
    );
  });

  test("cost_accrual WITHOUT tenant omits the tenant= field", () => {
    const ev = {
      ...envelope,
      kind: "cost_accrual",
      provider: "openai",
      modelId: "gpt-4o",
      inputTokens: 5,
      outputTokens: 3,
      cachedReadTokens: 0,
      costUsdMicros: 11,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("cost_accrual")}provider=openai model=gpt-4o in=5 out=3 cached=0 micros=11`,
    );
  });

  test("circuit_state_changed WITH reason includes it", () => {
    const ev = {
      ...envelope,
      kind: "circuit_state_changed",
      adapter: "anthropic",
      fromState: "closed",
      toState: "open",
      reason: "5xx burst",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("circuit_state_changed")}adapter=anthropic closed→open reason=5xx burst`,
    );
  });

  test("circuit_state_changed WITHOUT reason omits it", () => {
    const ev = {
      ...envelope,
      kind: "circuit_state_changed",
      adapter: "openai",
      fromState: "open",
      toState: "half_open",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(`${prefix("circuit_state_changed")}adapter=openai open→half_open`);
  });

  test("test_verdict WITH reason includes it", () => {
    const ev = {
      ...envelope,
      kind: "test_verdict",
      testId: "t-42",
      verdict: "fail",
      reason: "assertion x",
      durationMs: 88,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("test_verdict")}test=t-42 verdict=fail duration=88ms reason=assertion x`,
    );
  });

  test("test_verdict WITHOUT reason omits it", () => {
    const ev = {
      ...envelope,
      kind: "test_verdict",
      testId: "t-1",
      verdict: "pass",
      durationMs: 7,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(`${prefix("test_verdict")}test=t-1 verdict=pass duration=7ms`);
  });

  test("response_rated (thumbs) with source + comment", () => {
    const ev = {
      ...envelope,
      kind: "response_rated",
      rating: "up",
      source: "cli",
      comment: "great cite",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("response_rated")}rating=up source=cli comment=great cite`,
    );
  });

  test("response_rated (numeric) formats to 2 decimals and omits absent fields", () => {
    const ev = { ...envelope, kind: "response_rated", rating: 0.5 } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(`${prefix("response_rated")}rating=0.50`);
  });

  test("program_output", () => {
    const ev = {
      ...envelope,
      kind: "program_output",
      programId: "p-1",
      exitCode: 0,
      stdoutBytes: 300,
      stderrBytes: 0,
      durationMs: 250,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("program_output")}program=p-1 exit=0 stdout=300B stderr=0B duration=250ms`,
    );
  });

  test("coverage_report", () => {
    const ev = {
      ...envelope,
      kind: "coverage_report",
      programId: "p-1",
      linesCovered: 90,
      linesTotal: 100,
      branchesCovered: 40,
      branchesTotal: 50,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("coverage_report")}program=p-1 lines=90/100 branches=40/50`,
    );
  });

  test("sanitizer_report WITH error includes the ERROR marker", () => {
    const ev = {
      ...envelope,
      kind: "sanitizer_report",
      programId: "p-1",
      sanitizer: "asan",
      isError: true,
      summary: "heap-buffer-overflow at parser.c:42",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("sanitizer_report")}program=p-1 sanitizer=asan ERROR heap-buffer-overflow at parser.c:42`,
    );
  });

  test("sanitizer_report WITHOUT error omits the ERROR marker", () => {
    const ev = {
      ...envelope,
      kind: "sanitizer_report",
      programId: "p-2",
      sanitizer: "ubsan",
      isError: false,
      summary: "clean",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(`${prefix("sanitizer_report")}program=p-2 sanitizer=ubsan clean`);
  });
});

describe("formatJsonLine — JSON Lines", () => {
  test("emits a single JSON object terminated by newline", () => {
    const ev = { ...env(), kind: "turn_start", turn: 1, messageCount: 0 } satisfies TraceEvent;
    const line = formatJsonLine(ev);
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.kind).toBe("turn_start");
    expect(parsed.turn).toBe(1);
    expect(parsed.runId).toBe("run_a");
  });
});
