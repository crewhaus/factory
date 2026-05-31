/**
 * TraceEvent discriminated union and helper types for the in-process
 * observability bus. Every variant carries the same envelope so subscribers
 * can correlate events across runs, sessions, turns, and traces.
 */

export type TraceEventEnvelope = {
  readonly runId: string;
  readonly sessionId: string;
  readonly turnNumber: number;
  /** 32 hex chars (W3C 16 bytes). Stable for the lifetime of one trace. */
  readonly traceId: string;
  /** 16 hex chars (W3C 8 bytes). Identifies the originating span. */
  readonly spanId: string;
  /** When the event nests inside another span. */
  readonly parentSpanId?: string;
  /** ISO 8601 timestamp when the event was published. */
  readonly timestamp: string;
};

export type TurnStartEvent = TraceEventEnvelope & {
  kind: "turn_start";
  turn: number;
  messageCount: number;
};

export type TurnEndEvent = TraceEventEnvelope & {
  kind: "turn_end";
  turn: number;
  stopReason?: string;
  durationMs: number;
};

/**
 * Section 17 — `provider` identifies which adapter handled the request
 * so the OTel exporter can populate `gen_ai.system` correctly. Optional
 * for backwards-compat with code paths that haven't been threaded
 * through the router yet; defaults to "anthropic" when absent.
 */
export type ProviderId = "anthropic" | "openai" | "gemini" | "bedrock";

export type ModelRequestEvent = TraceEventEnvelope & {
  kind: "model_request";
  model: string;
  provider?: ProviderId;
  messageCount: number;
  toolCount: number;
  streaming: boolean;
};

export type ModelUsage = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreate?: number;
};

export type ModelResponseEvent = TraceEventEnvelope & {
  kind: "model_response";
  model: string;
  provider?: ProviderId;
  stopReason: string;
  usage: ModelUsage;
  durationMs: number;
};

export type ModelStreamTokenEvent = TraceEventEnvelope & {
  kind: "model_stream_token";
  chunkIndex: number;
  deltaChars: number;
};

export type ToolCallStartEvent = TraceEventEnvelope & {
  kind: "tool_call_start";
  toolUseId: string;
  toolName: string;
  inputBytes: number;
};

export type ToolCallEndEvent = TraceEventEnvelope & {
  kind: "tool_call_end";
  toolUseId: string;
  toolName: string;
  isError: boolean;
  outputBytes: number;
  durationMs: number;
};

/**
 * Section 18 — fired by streaming tools (notably `tool-code-execution`)
 * for each stdout/stderr chunk emerging from the sandboxed process. The
 * full output is still captured in `tool_call_end` (`outputBytes`) — these
 * chunk events let observability subscribers visualise progress mid-call.
 *
 * Published `ephemeral: true` so a noisy stream (e.g. a 10s shell
 * command) does not evict structurally important events from the ring
 * buffer.
 */
export type ToolStreamChunkEvent = TraceEventEnvelope & {
  kind: "tool_stream_chunk";
  toolUseId: string;
  toolName: string;
  stream: "stdout" | "stderr";
  bytes: number;
};

export type McpCallStartEvent = TraceEventEnvelope & {
  kind: "mcp_call_start";
  server: string;
  toolName: string;
};

export type McpCallEndEvent = TraceEventEnvelope & {
  kind: "mcp_call_end";
  server: string;
  toolName: string;
  isError: boolean;
  durationMs: number;
};

export type HookFiredEvent = TraceEventEnvelope & {
  kind: "hook_fired";
  event: string;
  matcher?: string;
  allowed: boolean;
  durationMs: number;
  reason?: string;
};

export type CompactionFiredEvent = TraceEventEnvelope & {
  kind: "compaction_fired";
  subKind: "snip" | "autocompact" | "reactive";
  before: number;
  after: number;
  phase: "pre-turn" | "reactive";
};

export type PermissionDecisionEvent = TraceEventEnvelope & {
  kind: "permission_decision";
  toolName: string;
  decision: "allow" | "deny" | "ask";
  mode: string;
  reason?: string;
  /**
   * Section 18 — set when runtime-core's post-tool prompt-injection
   * classifier alters the tool result before it reaches the model.
   *   "redacted"      — the tool output was replaced with a redaction notice
   *   "warned"        — the output was kept but a one-shot system warning was
   *                     appended for the model
   * Pillar 3 sink-side egress fabric — set when the egress classifier
   * decides on an external-scope tool call.
   *   "egress-passed" — payload contained no tagged cross-origin content
   *   "egress-warned" — tagged content found; the configured-sink policy
   *                     allows transmission but logs the lineage
   *   "egress-blocked" — tagged content found; the dynamic-sink policy
   *                     blocks transmission; the tool call was denied
   * Absent on ordinary permission decisions.
   */
  outcome?: "redacted" | "warned" | "egress-passed" | "egress-warned" | "egress-blocked";
  /** Section 18 — names of detector rules that fired, when outcome is set. */
  rules?: ReadonlyArray<string>;
  /**
   * Pillar 3 (FR-004) intent gate — the judge identity that produced this
   * decision, promoted to a first-class field so the judge model is
   * recorded on the canonical audit/trace surface rather than only being
   * embedded in `reason`. `"rule-based"` for the default judge, otherwise
   * the model id supplied by the configured `JustificationJudge` (e.g.
   * `"claude-haiku-4-5"`, or `"<model> (error)"` when a model-backed judge
   * failed closed). Absent on permission decisions that didn't run the
   * justification gate.
   */
  judgeModel?: string;
  /** Pillar 3 (FR-004) intent gate — the judge's confidence in [0,1] when
   *  it supplied one. Absent on non-justification decisions and on binary
   *  judges that omit confidence. */
  justificationConfidence?: number;
};

export type ErrorRecoveredEvent = TraceEventEnvelope & {
  kind: "error_recovered";
  action: "retry" | "compact" | "continue" | "tombstone" | "fail";
  errorName: string;
  depth: number;
};

export type SubAgentStartEvent = TraceEventEnvelope & {
  kind: "sub_agent_start";
  name: string;
  childRunId: string;
  childSessionId: string;
  toolCount: number;
  promptBytes: number;
};

export type SubAgentEndEvent = TraceEventEnvelope & {
  kind: "sub_agent_end";
  name: string;
  childRunId: string;
  childSessionId: string;
  isError: boolean;
  toolCallCount: number;
  finalMessageBytes: number;
  durationMs: number;
};

/**
 * Section 22 — CRW (multi-agent crew) lifecycle events. Every variant
 * shares the run/session/trace envelope so an entire crew run nests
 * under one OTel trace and lands in one JSONL session log.
 */
export type RoleStartEvent = TraceEventEnvelope & {
  kind: "role_start";
  role: string;
  /** Position in the crew's role-activation sequence (0 = entry role). */
  activation: number;
};

export type RoleEndEvent = TraceEventEnvelope & {
  kind: "role_end";
  role: string;
  activation: number;
  finalMessageBytes: number;
  durationMs: number;
};

export type HandoffEvent = TraceEventEnvelope & {
  kind: "handoff";
  from: string;
  to: string;
  reason: string;
  /** Increments each time control changes hands; refusal-loop guard trips at the configured depth. */
  depth: number;
};

export type A2AMessageEvent = TraceEventEnvelope & {
  kind: "a2a_message";
  from: string;
  to: string;
  /** Free-form classifier (`question` | `answer` | `notify` | …); orchestrator stamps `question` on tool calls today. */
  messageKind: string;
  payloadBytes: number;
  /** W3C traceparent embedded in the A2A envelope. Should equal the bus's traceId on both ends. */
  traceparent: string;
};

export type CrewDoneEvent = TraceEventEnvelope & {
  kind: "crew_done";
  finalRole: string;
  totalActivations: number;
  durationMs: number;
};

/**
 * Section 27 — `cost-tracker` emits this once per `model_response` it
 * observes. `costUsdMicros` is the dollar total in microdollars (1e-6 USD)
 * derived from the per-provider pricing table; downstream consumers
 * (`audit-log`, `gateway-server` budgeter, `studio-server` cost dashboard)
 * read this field for historical reproducibility.
 */
export type CostAccrualEvent = TraceEventEnvelope & {
  kind: "cost_accrual";
  provider: ProviderId;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  costUsdMicros: number;
  tenantId?: string;
  /**
   * FR-003 — when true, this event is an *aggregate* run total rather than a
   * single model call: the `eval-optimizer-orchestrator` publishes one such
   * terminal accrual at the end of a budget-gated `crewhaus optimize` run so
   * the spend summary (total $ + token totals) lands on the trace bus, not
   * only on the result/report.json. Its token/cost fields are the sums over
   * the run's per-call accruals. Subscribers that aggregate per-call spend
   * (`cost-tracker`) ignore externally-published `cost_accrual` events
   * entirely — they only sum the ones they emit from `model_response` — so a
   * terminal total never double-counts. Absent (falsy) on ordinary per-call
   * accruals, including every `cost-tracker`-emitted one.
   */
  summary?: boolean;
};

/**
 * Track F (Section 57) — runtime feedback channel: test verdict.
 * Source: AgentFlow (arxiv 2604.20801, §3.2). Emitted by an `eval`
 * target or any test-running tool to report a structured pass/fail.
 * Separate event kind from `tool_call_end` so the optimizer can
 * filter cheaply and so OTel exporters can route verdicts to a
 * different sink (often a verdict-focused dashboard, not a generic
 * tool-call trace).
 */
export type TestVerdictEvent = TraceEventEnvelope & {
  kind: "test_verdict";
  testId: string;
  verdict: "pass" | "fail" | "skip" | "error";
  /** Optional human-readable reason for the verdict. */
  reason?: string;
  durationMs: number;
};

/**
 * Track F (Section 57) — runtime feedback channel: program stdout/stderr.
 * Source: AgentFlow (arxiv 2604.20801, §3.2). Emitted by sandboxed
 * program runs (`tool-code-execution`, `tool-bash`). Per-chunk
 * emission is `tool_stream_chunk`; this event is the per-process
 * summary that lands at exit.
 */
export type ProgramOutputEvent = TraceEventEnvelope & {
  kind: "program_output";
  programId: string;
  exitCode: number;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
};

/**
 * Track F (Section 57) — runtime feedback channel: coverage report.
 * Source: AgentFlow (arxiv 2604.20801, §3.2). Line/branch coverage
 * obtained from LLVM source-based instrumentation or v8 coverage.
 * Reveals whether the agent's input reached the code region the
 * eval cares about — essential signal for sparse-reward eval loops.
 */
export type CoverageReportEvent = TraceEventEnvelope & {
  kind: "coverage_report";
  programId: string;
  linesCovered: number;
  linesTotal: number;
  branchesCovered: number;
  branchesTotal: number;
};

/**
 * Track F (Section 57) — runtime feedback channel: sanitizer report.
 * Source: AgentFlow (arxiv 2604.20801, §3.2). AddressSanitizer /
 * UndefinedBehaviorSanitizer reports — detects memory-safety
 * violations and UB even when the program does not visibly crash.
 * Mostly relevant for security-research deployments (the AgentFlow
 * paper discovered 10 Chrome zero-days using exactly this channel).
 */
export type SanitizerReportEvent = TraceEventEnvelope & {
  kind: "sanitizer_report";
  programId: string;
  sanitizer: "asan" | "ubsan" | "msan" | "tsan" | "lsan" | "other";
  isError: boolean;
  /** Short summary line (e.g. "heap-buffer-overflow at parser.c:42"). */
  summary: string;
};

/**
 * Section 27 — `circuit-breaker` emits this on every state transition.
 * Subscribers (audit-log, OTel exporter, structured-event-printer) can
 * surface degraded providers without subscribing to the breaker directly.
 */
export type CircuitStateChangedEvent = TraceEventEnvelope & {
  kind: "circuit_state_changed";
  /** Adapter identifier (e.g. "anthropic", "openai", or a router-key like "anthropic/claude-opus-4-7"). */
  adapter: string;
  fromState: "closed" | "open" | "half_open";
  toState: "closed" | "open" | "half_open";
  /** Why the breaker tripped or recovered (optional human-readable reason). */
  reason?: string;
};

export type TraceEvent =
  | TurnStartEvent
  | TurnEndEvent
  | ModelRequestEvent
  | ModelResponseEvent
  | ModelStreamTokenEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | ToolStreamChunkEvent
  | McpCallStartEvent
  | McpCallEndEvent
  | HookFiredEvent
  | CompactionFiredEvent
  | PermissionDecisionEvent
  | ErrorRecoveredEvent
  | SubAgentStartEvent
  | SubAgentEndEvent
  | RoleStartEvent
  | RoleEndEvent
  | HandoffEvent
  | A2AMessageEvent
  | CrewDoneEvent
  | CostAccrualEvent
  | CircuitStateChangedEvent
  | TestVerdictEvent
  | ProgramOutputEvent
  | CoverageReportEvent
  | SanitizerReportEvent;

export type TraceEventKind = TraceEvent["kind"];

export type Subscriber = (event: TraceEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

export type PublishOptions = {
  /**
   * When true, the event still reaches every subscriber but is NOT recorded
   * in the ring buffer. Used for `model_stream_token` so a 10k-token response
   * does not evict structurally important events from the buffer.
   */
  ephemeral?: boolean;
};

export type Span = {
  readonly spanId: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  /** End the span and return elapsed milliseconds since `startSpan`. */
  end(): number;
};

export type RecentQuery = {
  /** ISO 8601; events with timestamp >= since are returned. */
  since?: string;
  /** Restrict to a subset of TraceEvent kinds. */
  kinds?: ReadonlyArray<TraceEventKind>;
};
