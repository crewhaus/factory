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

  test("curate — embedder-backed pass", () => {
    const ev = {
      ...envelope,
      kind: "curate",
      before: 42,
      after: 30,
      dropped: 12,
      bytesSaved: 8192,
      embedded: true,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("curate")}before=42 after=30 dropped=12 bytesSaved=8192 embedded`,
    );
  });

  test("curate — BM25-only fallback labels bm25", () => {
    const ev = {
      ...envelope,
      kind: "curate",
      before: 10,
      after: 9,
      dropped: 1,
      bytesSaved: 128,
      embedded: false,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("curate")}before=10 after=9 dropped=1 bytesSaved=128 bm25`,
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

  // Audit item 21 — runtime-core publishes a `decision: "ask"` event BEFORE
  // the approval prompt and a SECOND one carrying `askOutcome` after it
  // resolves. The renderer only knew about the (unrelated) egress `outcome`
  // field, so both publishes printed the same bytes and an ask's resolution
  // was invisible under CREWHAUS_TRACE=pretty.
  test("permission_decision ask resolution renders askOutcome", () => {
    const preAsk = {
      ...envelope,
      kind: "permission_decision",
      toolName: "Bash",
      decision: "ask",
      mode: "default",
    } satisfies TraceEvent;
    const resolved = {
      ...envelope,
      kind: "permission_decision",
      toolName: "Bash",
      decision: "ask",
      mode: "default",
      askOutcome: "denied",
    } satisfies TraceEvent;
    expect(formatLine(preAsk)).toBe(
      `${prefix("permission_decision")}tool=Bash decision=ask mode=default`,
    );
    expect(formatLine(resolved)).toBe(
      `${prefix("permission_decision")}tool=Bash decision=ask mode=default askOutcome=denied`,
    );
    // The two publishes must be distinguishable.
    expect(formatLine(preAsk)).not.toBe(formatLine(resolved));
  });

  test("permission_decision renders askOutcome approved", () => {
    const ev = {
      ...envelope,
      kind: "permission_decision",
      toolName: "Write",
      decision: "ask",
      mode: "default",
      askOutcome: "approved",
      reason: "user approved",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("permission_decision")}tool=Write decision=ask mode=default askOutcome=approved reason=user approved`,
    );
  });

  test("permission_decision renders askOutcome and outcome side by side", () => {
    const ev = {
      ...envelope,
      kind: "permission_decision",
      toolName: "Bash",
      decision: "ask",
      mode: "default",
      askOutcome: "approved",
      outcome: "egress-warned",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("permission_decision")}tool=Bash decision=ask mode=default askOutcome=approved outcome=egress-warned`,
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

  test("error_recovered renders the halt action (0.3.0 Goal 6)", () => {
    const ev = {
      ...envelope,
      kind: "error_recovered",
      action: "halt",
      errorName: "AdapterError",
      depth: 0,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("error_recovered")}action=halt error=AdapterError depth=0`,
    );
  });

  test("run_failed renders the canonical multi-line report block (0.3.0 Goal 6)", () => {
    const ev = {
      ...envelope,
      kind: "run_failed",
      class: "billing",
      message:
        'provider account out of funding: Anthropic said: "Your credit balance is too low to access the Anthropic API."',
      remediation: "add credits at https://console.anthropic.com/settings/billing, then rerun.",
      exitCode: 31,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      [
        `${prefix("run_failed")}✗ run stopped — provider account out of funding: Anthropic said: "Your credit balance is too low to access the Anthropic API."`,
        "  Fix: add credits at https://console.anthropic.com/settings/billing, then rerun.",
        "  (exit 31)",
      ].join("\n"),
    );
  });

  test("run_failed without remediation still prints the coded exit line", () => {
    const ev = {
      ...envelope,
      kind: "run_failed",
      class: "unknown",
      message: "recovery failed: tombstone budget exhausted: boom",
      exitCode: 1,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      [
        `${prefix("run_failed")}✗ run stopped — recovery failed: tombstone budget exhausted: boom`,
        "  (exit 1)",
      ].join("\n"),
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

  test("model_failover renders from/to/reason (item 22)", () => {
    const ev = {
      ...envelope,
      kind: "model_failover",
      from: "claude-opus-4-7",
      to: "openai/gpt-4o-mini",
      reason: "breaker_open",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("model_failover")}from=claude-opus-4-7 to=openai/gpt-4o-mini reason=breaker_open`,
    );
  });

  test("model_failover renders the budget_degrade reason (item 27)", () => {
    const ev = {
      ...envelope,
      kind: "model_failover",
      from: "claude-opus-4-1",
      to: "claude-haiku-4-5",
      reason: "budget_degrade",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("model_failover")}from=claude-opus-4-1 to=claude-haiku-4-5 reason=budget_degrade`,
    );
  });

  test("model_tier_route renders tier/model/reason (item 26)", () => {
    const ev = {
      ...envelope,
      kind: "model_tier_route",
      tier: "fast",
      model: "claude-haiku-4-5",
      reason: "no hard-turn signal → fast tier",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("model_tier_route")}tier=fast model=claude-haiku-4-5 reason=no hard-turn signal → fast tier`,
    );
  });

  test("model_tier_route marks an escalated misroute recovery (item 26)", () => {
    const ev = {
      ...envelope,
      kind: "model_tier_route",
      tier: "default",
      model: "claude-sonnet-4-5",
      reason: "escalated after fast-tier failure",
      escalated: true,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("model_tier_route")}tier=default model=claude-sonnet-4-5 escalated reason=escalated after fast-tier failure`,
    );
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

  // Loop contract 0.4 (Batch C, G11) — pending-approval lifecycle.
  test("approval_requested renders tool/approval/surface", () => {
    const ev = {
      ...envelope,
      kind: "approval_requested",
      approvalId: "appr_1",
      toolName: "Bash",
      surface: "single-turn",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("approval_requested")}tool=Bash approval=appr_1 surface=single-turn`,
    );
  });

  test("approval_resolved renders approval/decision/by", () => {
    const ev = {
      ...envelope,
      kind: "approval_resolved",
      approvalId: "appr_1",
      decision: "grant",
      by: "slack:U0123",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("approval_resolved")}approval=appr_1 decision=grant by=slack:U0123`,
    );
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

  // Loop contract 0.4 (Batch B, G62) — in-loop evaluation verdicts.
  test("eval_graded renders grader/score/threshold/verdict/retry", () => {
    const ev = {
      ...envelope,
      kind: "eval_graded",
      score: 0.8,
      threshold: 0.7,
      verdict: "pass",
      graderType: "llm_judge",
      retryIndex: 0,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("eval_graded")}grader=llm_judge score=0.80 threshold=0.70 verdict=pass retry=0`,
    );
  });

  test("eval_graded fail on a retry renders the retry index", () => {
    const ev = {
      ...envelope,
      kind: "eval_graded",
      score: 0,
      threshold: 1,
      verdict: "fail",
      graderType: "contains",
      retryIndex: 1,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("eval_graded")}grader=contains score=0.00 threshold=1.00 verdict=fail retry=1`,
    );
  });

  test("judge_verdict WITH rationale includes it", () => {
    const ev = {
      ...envelope,
      kind: "judge_verdict",
      stepOrNode: "gate",
      verdict: "fail",
      score: 0.4,
      rationale: "missing second source",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("judge_verdict")}at=gate verdict=fail score=0.40 rationale=missing second source`,
    );
  });

  test("judge_verdict WITHOUT rationale omits the suffix", () => {
    const ev = {
      ...envelope,
      kind: "judge_verdict",
      stepOrNode: "gate",
      verdict: "pass",
      score: 0.95,
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(`${prefix("judge_verdict")}at=gate verdict=pass score=0.95`);
  });

  // ---- 0.6.0 (design §8.1) — role/stage/profile attribution + the two new kinds.

  test("model_request WITH attribution appends role/stage/profile/params/dropped", () => {
    const ev = {
      ...envelope,
      kind: "model_request",
      model: "claude-haiku-4-5",
      messageCount: 4,
      toolCount: 2,
      streaming: true,
      role: "draft",
      stage: "draft",
      profile: "fast",
      paramsFingerprint: "p1a2b3",
      effectiveParams: { model: "claude-haiku-4-5", maxTokens: 4096, dropped: ["temperature"] },
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("model_request")}model=claude-haiku-4-5 messages=4 tools=2 streaming role=draft stage=draft profile=fast params=p1a2b3 dropped=temperature`,
    );
  });

  test("model_response WITH role only appends just role", () => {
    const ev = {
      ...envelope,
      kind: "model_response",
      model: "claude-sonnet-5",
      stopReason: "end_turn",
      usage: { input: 10, output: 5 },
      durationMs: 12,
      role: "judge",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("model_response")}model=claude-sonnet-5 stop=end_turn in=10 out=5 duration=12ms role=judge`,
    );
  });

  test("cost_accrual WITH attribution appends role/profile after the 0.5.x fields", () => {
    const ev = {
      ...envelope,
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 5,
      cachedReadTokens: 0,
      costUsdMicros: 105,
      role: "judge",
      profile: "checker",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("cost_accrual")}provider=anthropic model=claude-sonnet-5 in=10 out=5 cached=0 micros=105 role=judge profile=checker`,
    );
  });

  test("model_route WITH the 0.6.0 attribution renders every optional facet before reason", () => {
    const ev = {
      ...envelope,
      kind: "model_route",
      routeKey: "main/hard",
      model: "claude-opus-5",
      policy: "heuristic",
      reason: "rule matched",
      specModel: "anthropic/claude-opus-5",
      profile: "strong",
      stage: "escalation",
      strategy: "cascade",
      scope: "main",
      ruleId: "code-goes-strong",
      hint: { source: "rule", evidence: "code-goes-strong" },
      eligible: ["fast", "strong"],
      classifierVerdict: { label: "strong" },
      signals: { contextTokens: 1200, toolsInPlay: true },
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("model_route")}routeKey=main/hard model=claude-opus-5 policy=heuristic spec=anthropic/claude-opus-5 profile=strong stage=escalation strategy=cascade scope=main rule=code-goes-strong hint=rule eligible=fast,strong label=strong reason=rule matched`,
    );
  });

  test("model_stage renders stage/strategy/role/model/outcome with optional profile/cause/micros", () => {
    const done = {
      ...envelope,
      kind: "model_stage",
      stage: "draft",
      strategy: "cascade",
      role: "draft",
      model: "claude-haiku-4-5",
      profile: "fast",
      outcome: "done",
      costUsdMicros: 120,
    } satisfies TraceEvent;
    expect(formatLine(done)).toBe(
      `${prefix("model_stage")}stage=draft strategy=cascade role=draft model=claude-haiku-4-5 profile=fast outcome=done micros=120`,
    );
    const skipped = {
      ...envelope,
      kind: "model_stage",
      stage: "escalate",
      strategy: "cascade",
      role: "escalation",
      model: "claude-opus-5",
      outcome: "skipped",
      cause: "max_escalations",
    } satisfies TraceEvent;
    expect(formatLine(skipped)).toBe(
      `${prefix("model_stage")}stage=escalate strategy=cascade role=escalation model=claude-opus-5 outcome=skipped cause=max_escalations`,
    );
  });

  test("model_directive renders source/requested/accepted with optional resolved/reason", () => {
    const accepted = {
      ...envelope,
      kind: "model_directive",
      source: "repl",
      requested: "fast",
      resolved: "fast",
      accepted: true,
    } satisfies TraceEvent;
    expect(formatLine(accepted)).toBe(
      `${prefix("model_directive")}source=repl requested=fast resolved=fast accepted=true`,
    );
    const refused = {
      ...envelope,
      kind: "model_directive",
      source: "none",
      requested: "turbo",
      accepted: false,
      reason: "unknown arm",
    } satisfies TraceEvent;
    expect(formatLine(refused)).toBe(
      `${prefix("model_directive")}source=none requested=turbo accepted=false reason=unknown arm`,
    );
  });

  test("eval_graded WITH attribution appends model/judge/judgeMicros/escalatedTo", () => {
    const ev = {
      ...envelope,
      kind: "eval_graded",
      score: 0.4,
      threshold: 0.7,
      verdict: "fail",
      graderType: "llm_judge",
      retryIndex: 0,
      model: "claude-haiku-4-5",
      profile: "fast",
      judgeModel: "claude-sonnet-5",
      judgeCostUsdMicros: 900,
      escalatedTo: "claude-opus-5",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("eval_graded")}grader=llm_judge score=0.40 threshold=0.70 verdict=fail retry=0 model=claude-haiku-4-5 profile=fast judge=claude-sonnet-5 judgeMicros=900 escalatedTo=claude-opus-5`,
    );
  });

  test("judge_verdict WITH judge/panel/micros renders them before the rationale", () => {
    const ev = {
      ...envelope,
      kind: "judge_verdict",
      stepOrNode: "gate",
      verdict: "pass",
      score: 0.9,
      judgeModel: "claude-sonnet-5",
      panel: ["claude-sonnet-5", "claude-opus-5"],
      costUsdMicros: 900,
      rationale: "both sources present",
    } satisfies TraceEvent;
    expect(formatLine(ev)).toBe(
      `${prefix("judge_verdict")}at=gate verdict=pass score=0.90 judge=claude-sonnet-5 panel=claude-sonnet-5,claude-opus-5 micros=900 rationale=both sources present`,
    );
  });

  test("sub_agent_start and role_start WITH model/profile append them", () => {
    const sub = {
      ...envelope,
      kind: "sub_agent_start",
      name: "researcher",
      childRunId: "run_c",
      childSessionId: "sess_c",
      toolCount: 3,
      promptBytes: 40,
      model: "claude-haiku-4-5",
      profile: "fast",
    } satisfies TraceEvent;
    expect(formatLine(sub)).toBe(
      `${prefix("sub_agent_start")}name=researcher childRun=run_c tools=3 prompt=40B model=claude-haiku-4-5 profile=fast`,
    );
    const role = {
      ...envelope,
      kind: "role_start",
      role: "writer",
      activation: 2,
      model: "claude-sonnet-5",
    } satisfies TraceEvent;
    expect(formatLine(role)).toBe(
      `${prefix("role_start")}role=writer activation=2 model=claude-sonnet-5`,
    );
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

  test("carries the Batch-C agentId envelope field onto the JSON wire when stamped", () => {
    const ev = {
      ...env({ agentId: "ed25519:abc123" }),
      kind: "turn_start",
      turn: 1,
      messageCount: 0,
    } satisfies TraceEvent;
    const parsed = JSON.parse(formatJsonLine(ev).trimEnd());
    expect(parsed.agentId).toBe("ed25519:abc123");
  });
});
