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
  /**
   * Loop contract 0.4 (Batch C, item 4) — the publishing agent's identity: the
   * fingerprint of the Ed25519 public key auto-generated at first boot into
   * `.crewhaus/identity.json`. Stamped by `TraceEventBus.envelope()` when the
   * runtime supplies an `agentId` on the bus (and read by publishers that build
   * envelopes by hand via `bus.agentId`). The same fingerprint is appended to
   * audit-log records so a trace event and its audit trail attribute to one
   * agent. Optional: absent when no identity is available (e.g. an isolated
   * unit test, or a subscriber replaying events published before this field
   * existed).
   */
  readonly agentId?: string;
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

/**
 * 0.6.0 (design §8.1) — WHY a model call was made. Every hybrid topology
 * (cascade, draft-verify, plan-execute, guide, consult, committee, shadow)
 * and every auxiliary slot (judge, compaction, sub-agent) publishes its
 * calls on the run bus with a role, so `budget`, `cost-summary`, Hangar and
 * OTel can split spend by purpose instead of by model alone.
 *
 *   primary     — the main-turn call (absent `role` on an event means this)
 *   draft       — a cascade's cheap first attempt
 *   judge       — an in-loop `evaluation:` grader or a `kind: judge` gate
 *   escalation  — the strong re-run after a failed draft / an `Escalate`
 *   consult     — a `Consult` tool side call
 *   guide       — a `strategy.guide` planning call
 *   classifier  — a `policy: classifier` label call
 *   committee   — one committee member's call
 *   shadow      — an audition-lane replay whose text never reaches the user
 *   compaction  — a summarisation side call
 *   subagent    — a Task/sub-agent child's spend re-published on the parent
 */
export type ModelRole =
  | "primary"
  | "draft"
  | "judge"
  | "escalation"
  | "consult"
  | "guide"
  | "classifier"
  | "committee"
  | "shadow"
  | "compaction"
  | "subagent";

/**
 * 0.6.0 (design §6.2, §7.12) — the AUXILIARY roles: model calls made in
 * service of the run's answer rather than as the answer itself. This is the
 * set `budget.judge_share` bounds (the sub-cap on judge, guide, classifier,
 * consult, committee, shadow and compaction spend inside `budget.usd`), and
 * the set the eval runner keeps OUT of `--budget-usd` (which bounds agent
 * spend). `primary`, `draft` and `escalation` are the answer's own rungs;
 * `subagent` is a child's re-published answer work — none of those is
 * auxiliary. Exported as a frozen array so every consumer (runtime-core's
 * meter, eval-runner's token fold, `cost-summary`) shares one definition.
 */
export const AUXILIARY_MODEL_ROLES: ReadonlyArray<ModelRole> = Object.freeze([
  "judge",
  "guide",
  "classifier",
  "consult",
  "committee",
  "shadow",
  "compaction",
]);

/** True when `role` is one of {@link AUXILIARY_MODEL_ROLES}. An absent role
 *  (`undefined`) reads as `"primary"` and is therefore NOT auxiliary. */
export function isAuxiliaryModelRole(role: ModelRole | undefined): boolean {
  return role !== undefined && AUXILIARY_MODEL_ROLES.includes(role);
}

/**
 * 0.6.0 (design §8.1) — what the adapter ACTUALLY sent after its own
 * parameter gating (Claude 5 drops `temperature`, OpenAI reasoning models
 * swap `max_tokens` for `max_completion_tokens`, …). Filled by the optional
 * `ProviderAdapter.effectiveParams?(req)` SPI projection; `dropped` names the
 * requested knobs the adapter silently omitted — the first time that drop
 * is visible anywhere. Absent when the serving adapter does not implement
 * the projection.
 */
export type EffectiveParams = {
  readonly model: string;
  readonly maxTokens: number;
  readonly thinking?: { readonly budgetTokens: number };
  readonly reasoningEffort?: string;
  readonly temperature?: number;
  /** Requested parameter names the adapter dropped before sending. */
  readonly dropped: ReadonlyArray<string>;
};

/**
 * 0.6.0 (design §8.1) — the attribution fields shared by `model_request`,
 * `model_response` and `cost_accrual`. Every field is OPTIONAL so events and
 * persisted JSONL written before this release keep parsing; readers treat an
 * absent `role` as `"primary"`. cost-tracker copies them verbatim from the
 * response onto the accrual, and runtime-core's session mirror persists them
 * only when present, so an unattributed run stays byte-identical.
 */
export type ModelAttributionFields = {
  /** Purpose of the call. Absent ⇒ `"primary"`. */
  role?: ModelRole;
  /** Hybrid-strategy stage name (e.g. `"draft"`, `"verify"`, `"plan"`) when the call belongs to one. */
  stage?: string;
  /** `models:` profile name the serving candidate was declared under, when any. */
  profile?: string;
  /**
   * Fingerprint of the request parameters (max tokens, thinking, temperature,
   * timeout) the serving plan resolved for this call — lets two calls on the
   * same model be told apart when their settings differ.
   */
  paramsFingerprint?: string;
  /** The adapter's own echo of what it sent — see {@link EffectiveParams}. */
  effectiveParams?: EffectiveParams;
};

export type ModelRequestEvent = TraceEventEnvelope &
  ModelAttributionFields & {
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

export type ModelResponseEvent = TraceEventEnvelope &
  ModelAttributionFields & {
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
 * Loop contract 0.4 (Batch E, G19) — published by runtime-core's
 * `maybeCompact` when the active-context curator (`@crewhaus/compaction-
 * curator`) runs its pre-compaction pass (gated on `compaction.curate`).
 * `before`/`after` are the item counts entering and surviving the pass;
 * `dropped` is `before - after` (semantic-dedupe + relevance top-K trim);
 * `bytesSaved` is the text bytes removed (`CurationResult.bytesSaved`).
 * `embedded` records whether an embedder was threaded (cosine dedupe) or the
 * pass fell back to BM25-only lexical dedupe (no embedder resolved — see the
 * memory block's embedder resolution order). Distinct from
 * `compaction_fired`: curation is the RELEVANCE reorder + dedupe that runs
 * BEFORE any snip/summarise, so it gets its own kind rather than a subKind.
 */
export type CurateEvent = TraceEventEnvelope & {
  kind: "curate";
  before: number;
  after: number;
  dropped: number;
  bytesSaved: number;
  embedded: boolean;
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
  /** 0.6.0 (design §7.7) — the child's SPEC model string, when known. Optional: absent on events published before this field existed. */
  model?: string;
  /** 0.6.0 (design §7.7) — the `models:` profile the child was started under (a Task `profile` argument validated against `allowed_profiles`). */
  profile?: string;
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
  /** 0.6.0 (design §7.7) — see `SubAgentStartEvent.model`. */
  model?: string;
  /** 0.6.0 (design §7.7) — see `SubAgentStartEvent.profile`. */
  profile?: string;
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
  /** 0.6.0 (design §7.7) — the role's SPEC model string, when known. Optional: absent on events published before this field existed. */
  model?: string;
  /** 0.6.0 (design §7.7) — the `models:` profile the role's model resolved from, when any. */
  profile?: string;
};

export type RoleEndEvent = TraceEventEnvelope & {
  kind: "role_end";
  role: string;
  activation: number;
  finalMessageBytes: number;
  durationMs: number;
  /** 0.6.0 (design §7.7) — see `RoleStartEvent.model`. */
  model?: string;
  /** 0.6.0 (design §7.7) — see `RoleStartEvent.profile`. */
  profile?: string;
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
export type CostAccrualEvent = TraceEventEnvelope &
  ModelAttributionFields & {
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
    /**
     * True when the `(provider, modelId)` pair had NO row in the pricing table,
     * so `costUsdMicros` is 0 not because the call was free but because it could
     * not be priced. `cost-tracker` still publishes the accrual (carrying the
     * REAL `inputTokens`/`outputTokens`) so a downstream token tally survives an
     * unpriced model, and so the alert-watchdog's pricing-miss detector fires.
     * Absent (falsy) on every priced accrual — a genuinely-$0 priced call (e.g.
     * a rounds-to-zero token count) is distinguishable from an unpriced one by
     * this flag rather than only by the `costUsdMicros === 0 && tokens > 0`
     * heuristic.
     */
    unpriced?: boolean;
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
 * Loop contract 0.4 (Batch C, G11) — published by the runtime when a tool
 * permission resolves to `ask` on a NON-interactive surface and
 * `permissions.ask_mode` is `"pause"` (the default): the runtime persists a
 * `PendingApproval` via the injected approvals store, publishes THIS event,
 * and parks the turn (the `approval_pending` failure class + a resume token).
 * `approvalId` is the persisted `PendingApproval.id` — the same id the later
 * `approval_resolved` event and the CLI/Slack approval verbs key on;
 * `toolName` is the parked tool call; `surface` is the non-interactive surface
 * the ask arose on (e.g. `"single-turn"`, `"daemon"`, `"gateway"`), a
 * free-form classifier so new surfaces don't need a schema bump.
 */
export type ApprovalRequestedEvent = TraceEventEnvelope & {
  kind: "approval_requested";
  approvalId: string;
  toolName: string;
  surface: string;
};

/**
 * Loop contract 0.4 (Batch C, G11) — published when a parked approval is
 * resolved (by a CLI verb, a Slack button, or any downstream approval surface)
 * and the decision is recorded in the approvals store, so the next run/turn
 * re-executes the tool call pre-resolved (`grant`) or denies it with a note
 * (`deny`). `approvalId` matches the originating `approval_requested.approvalId`;
 * `decision` is the recorded verdict; `by` is the deciding identity (free-form
 * — e.g. a username, `"cli"`, or `"slack:U0123"`).
 */
export type ApprovalResolvedEvent = TraceEventEnvelope & {
  kind: "approval_resolved";
  approvalId: string;
  decision: "grant" | "deny";
  by: string;
  /**
   * #383 — true when the grant was recorded as a STANDING allow
   * (`crewhaus approvals grant --always` / the Slack "Always allow" button):
   * the resolving surface also persisted a settings-source `alwaysAllow`
   * rule for the tool, so future calls never re-ask. Absent on one-shot
   * grants and denies.
   */
  always?: boolean;
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
  /** A built-in step (`reservation_cleanup` | `session_ttl_eviction` |
   *  `orphan_tool_use_sweep`) or a registered step's own name (v0.3.0
   *  PR 14 step registry — e.g. the dream `dream_consolidation` step). */
  step: string;
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
  /**
   * The configured pool policy, or `"forced"` (0.6.0 §7.12) when the loop
   * substituted a candidate outside the router's choice — today a
   * `budget.on_exceed: degrade` breach forcing the degrade rung
   * (`reason: "budget_degrade"`).
   */
  policy: "static" | "heuristic" | "learned" | "forced";
  reason: string;
  /** True when the learned policy is exploring an under-sampled arm. */
  explored?: boolean;
  /** Fingerprint of the pool config that produced this decision. */
  policyVersion?: string;
  // ---- 0.6.0 (design §7.2, §8.1) — additive routing attribution. Every
  // field is optional so `model_route` lines persisted by 0.5.x keep parsing.
  /** Hybrid-strategy stage this decision serves (`"draft"`, `"escalation"`, …). */
  stage?: string;
  /** The `model_pool.strategy` member that owns the turn (`"cascade"`, `"committee"`, …). */
  strategy?: string;
  /** `model_pool.rules[].id` of the first-match rule that steered this decision, when one did. */
  ruleId?: string;
  /** `models:` profile name of the chosen candidate, when it is a profile. */
  profile?: string;
  /**
   * SPEC model string of the chosen candidate when it differs from `model`
   * (the wire id). Scoreboard arms key on this string, so it is what
   * `route explain` needs to name the same arm `route status` shows.
   */
  specModel?: string;
  /** Derived per-turn signals the decision was made from — never user text. */
  signals?: ModelRouteSignals;
  /** The `preRoute` hint that constrained the policy, when one applied. */
  hint?: ModelRouteHint;
  /** Arm ids (profile name or spec model string) eligible after capability/breaker/cap filtering. */
  eligible?: ReadonlyArray<string>;
  /** Fingerprint of the toolset advertised to the chosen candidate. */
  toolsetFingerprint?: string;
  /** `model_pool.scope` — the step/role/node/sub-agent the pool belongs to; `"main"` for the agent's own pool. */
  scope?: string;
  /** Persisted verdict of a `policy: classifier` label call, so replay stays exact. */
  classifierVerdict?: ModelClassifierVerdict;
};

/**
 * 0.6.0 (design §7.2.2) — the DERIVED routing signals persisted on a
 * `model_route` line: counts, flags, names and hashes only. The user's text
 * itself is never carried, because on a channel shape it is attacker-
 * controlled and a route line lands in session logs and the Hangar timeline.
 * The first four are the 0.5.x router inputs; the rest arrive with rules.
 */
export type ModelRouteSignals = {
  readonly contextTokens?: number;
  readonly toolsInPlay?: boolean;
  readonly turnIndex?: number;
  readonly priorTurnToolUseCount?: number;
  readonly userTextChars?: number;
  readonly hasImages?: boolean;
  readonly toolNamesLastTurn?: ReadonlyArray<string>;
  readonly budgetSpentRatio?: number;
  readonly channelHint?: string;
  /** Hash of the user text a `message_matches` rule ran against — for replay, never the text. */
  readonly textHash?: string;
};

/**
 * 0.6.0 (design §7.2) — the `preRoute` phase's output as persisted on the
 * route line. `source` names which lane produced it (`"forced"` for budget /
 * cascade / escalation, `"directive"`, `"rule"`, `"classifier"`, `"none"`).
 */
export type ModelRouteHint = {
  readonly source: string;
  /** Arm id the hint pinned, when it forced one. */
  readonly forcedArm?: string;
  /** Arm ids the hint removed from eligibility. */
  readonly excludedArms?: ReadonlyArray<string>;
  /** Suffix appended to the learning bucket (`routeKey`) by the hint. */
  readonly routeKeySuffix?: string;
  /** Human-readable evidence for the hint (rule id, directive text class, …). */
  readonly evidence?: string;
};

/** 0.6.0 (design §7.2.3) — a `policy: classifier` label call's persisted verdict. */
export type ModelClassifierVerdict = {
  /** The chosen tag — constrained to the pool's declared tags. */
  readonly label: string;
  /** Wire model id of the classifier call. */
  readonly model?: string;
  readonly costUsdMicros?: number;
};

/**
 * 0.6.0 (design §7.3–§7.8) — one hybrid-strategy stage transition. Published
 * by runtime-core around each cascade / draft-verify / guide / consult /
 * committee / shadow stage, so `route explain`, Hangar and OTel can show the
 * shape of a turn (draft → judge → escalation) rather than a flat list of
 * model calls. `outcome` is the stage's lifecycle verdict; `cause` explains a
 * `skipped` / `failed` outcome (`"max_escalations"`, `"self"` for a
 * model-directed `Escalate`, `"judge_share_exhausted"`, …). `costUsdMicros`
 * is the stage's own spend when known at publish time (a `done` stage).
 * Mirrored into the session JSONL as the durable `model_stage` event-log kind.
 */
export type ModelStageEvent = TraceEventEnvelope & {
  kind: "model_stage";
  /** Stage name (`"draft"`, `"verify"`, `"escalate"`, `"plan"`, `"guide"`, `"shadow"`, `"member"`, …). */
  stage: string;
  /** The `model_pool.strategy` member that owns the stage. */
  strategy: string;
  /** The role the stage's model call(s) carry. */
  role: ModelRole;
  /** Wire model id serving the stage. */
  model: string;
  /** `models:` profile of the serving candidate, when any. */
  profile?: string;
  outcome: "started" | "done" | "failed" | "skipped";
  cause?: string;
  costUsdMicros?: number;
};

/**
 * 0.6.0 (design §7.2.1) — a per-message `/model …` directive parsed at a
 * typed INPUT seam (the REPL input loop or the singleTurn seed message —
 * never the transcript, whose synthetic user messages can echo a grader's
 * rationale). Published once per parse so `route explain` and `--resume`
 * reconstruct the session pin from a typed event instead of re-scanning
 * prose. `source` is where the directive was read (`"repl"`, `"seed"`, or
 * `"session"` for a pin restored from session metadata); `"none"` records
 * that a candidate string was seen somewhere directives are NOT honoured.
 * `requested` is the arm the user named (`"fast"`, `"auto"`, …); `resolved`
 * is the roster arm it mapped to; `accepted` is false when the request was
 * refused (unknown arm, directives off, a forced lane outranked it) with
 * `reason` saying why. Mirrored into the session JSONL as the durable
 * `model_directive` event-log kind.
 */
export type ModelDirectiveEvent = TraceEventEnvelope & {
  kind: "model_directive";
  source: "repl" | "seed" | "session" | "none";
  requested: string;
  resolved?: string;
  accepted: boolean;
  reason?: string;
};

/**
 * Loop contract 0.4 (Batch B, G62) — published by the in-loop `evaluation:`
 * machinery each time a completed assistant turn's final text is scored
 * (cli/channel/managed shapes). One event per grading pass, INCLUDING the
 * re-grades of evaluation-triggered retries: `retryIndex` is 0 for the
 * original attempt, 1 for the first retry, … up to the block's
 * `max_retries`. `verdict` is `"pass"` when `score >= threshold` (for the
 * deterministic `contains`/`regex` graders score is 1 or 0 against a
 * threshold of 1). Judge/model grading calls are metered into the run
 * budget as ordinary `cost_accrual` events (carrying `role: "judge"`) — this
 * event carries the verdict plus, from 0.6.0, the attribution needed to tie
 * it to the graded arm and the judge that scored it.
 */
export type EvalGradedEvent = TraceEventEnvelope & {
  kind: "eval_graded";
  /** The grader's score in [0,1] (deterministic graders emit 1 or 0). */
  score: number;
  /** The passing bar the score was compared against. */
  threshold: number;
  verdict: "pass" | "fail";
  /** Which `evaluation.grader.type` produced the score. */
  graderType: "llm_judge" | "contains" | "regex";
  /** 0 = the original turn, n = the n-th evaluation-triggered retry. */
  retryIndex: number;
  /**
   * The block's resolved `max_retries` cap. Without it a consumer cannot tell
   * a ladder that was SPENT (`retryIndex >= maxRetries`) from one cut short by
   * budget/halt/an abort — `dataset mine` was calling both "retries
   * exhausted". Optional so a sidecar recorded before this field still parses
   * (readers treat absence as "exhaustion unknown", never as "exhausted").
   */
  maxRetries?: number;
  // ---- 0.6.0 (design §7.3, §8.1) — additive attribution. All optional so
  // sidecars recorded before this release keep parsing.
  /** Wire model id of the GRADED response (the draft or primary arm). */
  model?: string;
  /** `models:` profile of the graded arm, when any. */
  profile?: string;
  /** Wire model id of the judge that produced `score`; absent for deterministic graders. */
  judgeModel?: string;
  /** The judge call's priced spend, when the grader reported usage. */
  judgeCostUsdMicros?: number;
  /** Under `on_fail: escalate`, the SPEC model string the turn was handed to after this failing grade. */
  escalatedTo?: string;
  /**
   * 0.6.0 (design §6.2, §7.12) — budget signal stamped on the grade: the
   * run's auxiliary-role spend (see {@link AUXILIARY_MODEL_ROLES}) had already
   * reached `budget.judge_share` × `budget.usd` when this grading pass ran.
   * The judge still ran — the existing retry path keeps judging under the
   * TOTAL cap — so this is the accounting signal a cascade consumes to serve
   * the strong rung directly instead of spending more on judging. Absent when
   * no budget is declared or the share is not yet spent.
   */
  reason?: "judge_share_exhausted";
};

/**
 * Loop contract 0.4 (Batch B, G62) — published by a `kind: "judge"`
 * workflow step / graph node when it scores its gated (previous/upstream)
 * output. `stepOrNode` is the judge step's/node's name; `verdict` is
 * `"pass"` when `score >= threshold`; `rationale` is the judge model's
 * explanation when it supplied one (also what `on_fail: retry_previous`
 * appends to the re-run as a system nudge).
 */
export type JudgeVerdictEvent = TraceEventEnvelope & {
  kind: "judge_verdict";
  /** Name of the judge step (workflow) or judge node (graph). */
  stepOrNode: string;
  verdict: "pass" | "fail";
  /** The judge's score in [0,1]. */
  score: number;
  /** Judge-model explanation, when it supplied one. */
  rationale?: string;
  // ---- 0.6.0 (design §6.2, §8.1) — additive attribution. All optional so
  // events published by 0.5.x gate helpers keep parsing.
  /** Wire model id of the judge (or the panel's first member) that scored the gate. */
  judgeModel?: string;
  /** Wire model ids of every panel member when the gate ran a `judges: [..]` panel. */
  panel?: ReadonlyArray<string>;
  /** The gate's priced judge spend, when the grader reported usage. */
  costUsdMicros?: number;
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
  | CurateEvent
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
  | ModelStageEvent
  | ModelDirectiveEvent
  | JanitorActionEvent
  | ResponseRatedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | TestVerdictEvent
  | ProgramOutputEvent
  | CoverageReportEvent
  | SanitizerReportEvent
  | AlertRaisedEvent
  | EvalGradedEvent
  | JudgeVerdictEvent;

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
