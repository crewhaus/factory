/**
 * TraceEvent discriminated union and helper types for the in-process
 * observability bus. Every variant carries the same envelope so subscribers
 * can correlate events across runs, sessions, turns, and traces.
 */
import type { FailureClass } from "@crewhaus/errors";

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
  /**
   * WIRE model id — the stripped form the provider was actually called
   * with (`"bedrock/us.anthropic.claude-…"` spec → `"us.anthropic.claude-…"`).
   * This is the id cost-tracker pricing keys and the OTel
   * `gen_ai.request.model` attribute expect; `provider` carries the
   * routing half. The original spec string lives in `specModel`.
   */
  model: string;
  /**
   * Original spec model string (`"bedrock/us.anthropic.claude-…"`,
   * `"groq/llama-3.3-70b"`, …) when it differs from `model`. Preserves
   * grammar-only routing detail the (provider, model) pair can't recover
   * — e.g. which OpenAI-compatible host or azure deployment was hit.
   */
  specModel?: string;
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
  /** WIRE model id — see `ModelRequestEvent.model`. Pricing resolves on this. */
  model: string;
  /** Original spec model string when it differs — see `ModelRequestEvent.specModel`. */
  specModel?: string;
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

/**
 * v0.3.0 Goal 1 (§2.5) — published by runtime-core when
 * `prompt-cache-manager.manage()` injects a fresh cache marker at boot.
 * `rotatedAt` is the ms-epoch timestamp the caller must persist and thread
 * back as `RunChatLoopOptions.promptCacheLastRotatedAt` on the next run —
 * a fresh value makes `manage()` skip, so the harness stops force-rotating
 * (and cold-starting the cached prefix) on every boot. Until this event
 * existed the rotation bookkeeping was dead wiring: nothing observed a
 * rotation and nothing could persist the timestamp. The store wiring lands
 * with memory-service/threading (PR 10/11); this event + the
 * `onPromptCacheRotated` runtime seam are the observable halves.
 */
export type CacheRotationEvent = TraceEventEnvelope & {
  kind: "cache_rotation";
  /** ms-epoch timestamp of the fresh marker (ManageResult.rotatedAt). */
  rotatedAt: number;
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
  /**
   * Advisor groundwork (item 14) — the RESOLUTION of an "ask" decision.
   * runtime-core publishes the `decision: "ask"` event BEFORE the approval
   * prompt runs; once the prompt resolves (or the ask collapses to a deny
   * because single-turn mode has no interactive surface) it publishes a
   * SECOND `permission_decision` with `decision: "ask"` and this field set.
   * Absent on the pre-prompt publish and on ordinary allow/deny decisions —
   * subscribers that want one line per resolved decision (the advisor
   * persistence subscriber) key on its presence.
   */
  askOutcome?: "approved" | "denied";
};

export type ErrorRecoveredEvent = TraceEventEnvelope & {
  kind: "error_recovered";
  // Item 23 — `switch-model` joins the recovery-engine action set (an
  // opt-in failure_taxonomy verdict that reroutes onto the next failover
  // candidate mid-turn).
  // v0.3.0 Goal 6 — `halt` is the recovery engine's CLASSIFIED terminal
  // stop (billing/auth/rate-limit exhaustion/hinted taxonomy entries),
  // published first-class instead of the interim halt→"fail" mapping.
  // Consumers that count unrecovered errors (alert-watchdog, slo-monitor)
  // treat BOTH `fail` and `halt` as terminal. The accompanying `run_failed`
  // event carries the human-readable report this event never had room for.
  action: "retry" | "compact" | "continue" | "tombstone" | "switch-model" | "fail" | "halt";
  errorName: string;
  depth: number;
};

/**
 * v0.3.0 Goal 6 — the structured TERMINAL failure event, published by
 * runtime-core immediately BEFORE the run-ending throw (both the classified
 * `halt` path and the generic `fail` path). `error_recovered` carries only
 * `errorName` + `depth`; this event finally puts the human-readable reason
 * on the wire so structured consumers (the UI host feed, the pretty
 * printer, exporters, incident capture) can render WHY the run died.
 *
 * `class`/`remediation`/`exitCode` mirror the thrown `FailureReport`
 * (`@crewhaus/errors`); `message` is `"<title>: <detail>"` — the same text
 * `RunFailedError.message` carries after its "run stopped — " prefix.
 * Generic fails publish a best-effort report (`class: "unknown"`, exit 1).
 * Exactly one `run_failed` is published per terminal failure; successful
 * runs and recovered errors publish none.
 */
export type RunFailedEvent = TraceEventEnvelope & {
  kind: "run_failed";
  class: FailureClass;
  message: string;
  remediation?: string;
  exitCode: number;
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
  /**
   * WIRE model id (copied from `ModelResponseEvent.model`) — together
   * with `provider` this is exactly the `resolvePricing` lookup key, so
   * a historical re-aggregation reprices deterministically.
   */
  modelId: string;
  /** Original spec model string when it differs — see `ModelRequestEvent.specModel`. */
  specModel?: string;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  /**
   * Prompt-cache WRITE tokens (Anthropic `cache_creation_input_tokens`,
   * Bedrock `cacheWriteInputTokens` — the canonical `usage.cacheCreate`),
   * billed at a premium over the input rate. Optional so `cost_accrual`
   * records persisted before this field existed keep parsing; absent means
   * "not tracked", and emitters that do track it write 0 when no cache
   * segment was created.
   */
  cacheCreationTokens?: number;
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
 * User feedback channel — a rating a human placed on a specific assistant
 * turn: a thumbs up/down, a star/scalar score, and/or a free-text comment.
 * Distinct from `test_verdict` (an automated pass/fail): this is a HUMAN
 * signal. Published onto the bus by in-session capture surfaces (e.g. a
 * channel reaction) so the pretty printer and OTel exporter can surface it
 * live. The durable, offline record that `crewhaus distill` reads is the
 * separate `event-log` `user_feedback` kind — the two are siblings, not the
 * same wire object. `rating` is normalized at the boundary: the literal
 * "up"/"down" for a thumbs vote, or a number in [0,1] for a star/scale vote.
 */
export type ResponseRatedEvent = TraceEventEnvelope & {
  kind: "response_rated";
  /** spanId of the rated `model_response` (its gen_ai.chat span), when known. */
  targetSpanId?: string;
  rating: "up" | "down" | number;
  comment?: string;
  source?: "user" | "ui" | "channel" | "cli";
};

/**
 * Ops item 36 — emitted by `runtime-core`'s boot-time self-heal janitor,
 * once per maintenance step per run (daemon shapes run it at boot and on an
 * hourly interval). Steps: crash-leaked durable-state reservation cleanup,
 * session TTL eviction, and the orphaned-`tool_use` transcript sweep
 * (detect-and-report — the janitor never rewrites the append-only session
 * log; `--resume` already reconciles orphans in memory via
 * `sanitizeOrphanToolUses`). `status: "skipped"` records an intentional
 * no-op (step disabled, nothing to do, or already done at boot); `"error"`
 * carries the failure in `detail` — a throwing step never aborts the run.
 */
export type JanitorActionEvent = TraceEventEnvelope & {
  kind: "janitor_action";
  step: "reservation_cleanup" | "session_ttl_eviction" | "orphan_tool_use_sweep";
  status: "ok" | "skipped" | "error";
  /** Step tally: sessions evicted / orphaned tool_use ids found. Absent when the step has no meaningful count (reservation cleanup). */
  count?: number;
  /** Human-readable summary — skip reason, error message, or sweep stats. */
  detail?: string;
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

/**
 * Item 22 — emitted by the model-router failover chain each time the serving
 * candidate changes. `from`/`to` are SPEC model strings (`"claude-opus-4-7"`,
 * `"openai/gpt-4o-mini"`) — the routing identity, not the wire id — so the
 * event reads the way the spec's `model` / `model_fallbacks` were written.
 * Reasons:
 *   - `breaker_open`     — the previous candidate's circuit breaker is open;
 *                          traffic routed to the next candidate in the chain.
 *   - `probe_restore`    — a higher-priority candidate's cooldown elapsed
 *                          (breaker half-open) and traffic routed back up to
 *                          probe it — the auto-restore half of the breaker's
 *                          semantics.
 *   - `candidate_error`  — the previous candidate could not be constructed
 *                          when actually tried (missing credential /
 *                          uninstalled provider package); routed onward.
 *   - `budget_degrade`   — item 27: the run-level spend cap was reached and
 *                          the primary model was re-resolved to the cheaper
 *                          `budget.on_exceed` rung. Not a chain-routing
 *                          event — the whole primary adapter was swapped.
 */
export type ModelFailoverEvent = TraceEventEnvelope & {
  kind: "model_failover";
  /** Spec model string of the candidate traffic moved away from. */
  from: string;
  /** Spec model string of the candidate now serving. */
  to: string;
  reason: "breaker_open" | "probe_restore" | "candidate_error" | "budget_degrade";
};

/**
 * Ops item 31 — emitted by `runtime-core`'s alert watchdog (env/spec-gated via
 * CREWHAUS_ALERTS) when a live per-session metric breaches a threshold DERIVED
 * FROM HISTORY (trailing p95 ×1.5 over prior sessions' persisted snapshots)
 * rather than a hand-configured constant. One event per breached metric. The
 * watchdog also appends an audit record and invokes the configured
 * settings.json `alert` hook / webhook, but this trace event is the live
 * observable surface (the pretty printer + OTel exporter can render it).
 *
 * `metric` names the breached signal (e.g. "error_rate", "turn_p95_seconds",
 * "ttft_p95_seconds", "cost_burn_usd_per_min", "pricing_miss_rate",
 * "circuit_opens", "egress_blocked"); `observed`/`threshold` are the numeric
 * comparison; `baselineSessions` is how many historical snapshots the
 * threshold was derived from (0 ⇒ a bootstrap default was used because there
 * was no history yet).
 */
export type AlertRaisedEvent = TraceEventEnvelope & {
  kind: "alert_raised";
  metric: string;
  observed: number;
  threshold: number;
  baselineSessions: number;
  /** Human-readable one-liner (also used as the audit/hook message). */
  detail: string;
};

/**
 * Item 26 — emitted by the two-tier turn-difficulty router each turn, BEFORE
 * the model call, recording which tier (`fast` | `default`) was selected and
 * WHY. The decision is deterministic — derived from signals already computed
 * in the loop (estimated context tokens, whether tools are in play this turn,
 * turn index, last-turn tool_use density) — so the event is fully reproducible
 * from the transcript.
 *
 * `tier` is the chosen rung; `model` is the wire model id it resolved to;
 * `reason` is the human-readable trigger (e.g. "tools in play",
 * "context 42k > 20k threshold", "escalated after fast-tier failure").
 * `escalated` is true when this route is a MISROUTE RECOVERY — a fast-tier
 * turn failed and is being re-run on the default tier (item 23's switch-model
 * machinery, composed).
 */
export type ModelTierRouteEvent = TraceEventEnvelope & {
  kind: "model_tier_route";
  tier: "fast" | "default";
  /** Wire model id the chosen tier resolved to. */
  model: string;
  reason: string;
  /** True when this is a fast→default misroute recovery, not a fresh pick. */
  escalated?: boolean;
};

/**
 * `model_pool` — emitted by the PolicyRouter each turn, BEFORE the model call,
 * recording which pool candidate was selected and WHY. The generalisation of
 * `model_tier_route` (two rungs) to N declared candidates with a selection
 * `policy`. Deterministic and replayable: for `static`/`heuristic` from the
 * turn's signals alone, and for `learned` from the persisted reward scoreboard
 * plus those signals.
 *
 * `routeKey` is the learning bucket the decision keys on (`"hard"` | `"easy"`);
 * `model` is the wire model id it resolved to; `policy` is the active pool
 * policy; `reason` is the human-readable trigger. `explored` is true when the
 * learned policy chose an under-sampled arm to gather data on it (rather than
 * exploiting the current best). `policyVersion` fingerprints the pool config so
 * a learned decision can be tied back to the exact policy that made it.
 */
export type ModelRouteEvent = TraceEventEnvelope & {
  kind: "model_route";
  routeKey: string;
  /** Wire model id the chosen candidate resolved to. */
  model: string;
  policy: "static" | "heuristic" | "learned";
  reason: string;
  /** True when the learned policy is exploring an under-sampled arm. */
  explored?: boolean;
  /** Fingerprint of the pool config that produced this decision. */
  policyVersion?: string;
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
  | CacheRotationEvent
  | PermissionDecisionEvent
  | ErrorRecoveredEvent
  | RunFailedEvent
  | SubAgentStartEvent
  | SubAgentEndEvent
  | RoleStartEvent
  | RoleEndEvent
  | HandoffEvent
  | A2AMessageEvent
  | CrewDoneEvent
  | CostAccrualEvent
  | CircuitStateChangedEvent
  | ModelFailoverEvent
  | ModelTierRouteEvent
  | ModelRouteEvent
  | JanitorActionEvent
  | ResponseRatedEvent
  | TestVerdictEvent
  | ProgramOutputEvent
  | CoverageReportEvent
  | SanitizerReportEvent
  | AlertRaisedEvent;

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
