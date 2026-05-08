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
   *   "redacted" — the tool output was replaced with a redaction notice
   *   "warned"   — the output was kept but a one-shot system warning was
   *                appended for the model
   * Absent on ordinary permission decisions.
   */
  outcome?: "redacted" | "warned";
  /** Section 18 — names of detector rules that fired, when outcome is set. */
  rules?: ReadonlyArray<string>;
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
  | SubAgentEndEvent;

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
