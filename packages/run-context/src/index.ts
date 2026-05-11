/**
 * Catalog R1 `run-context` — per-run object threaded through the
 * orchestrator, tools, and policy. Constructed once per
 * `runChatLoop()` invocation; `turnNumber` is mutated by the
 * orchestrator as turns advance.
 *
 * Reference: claude-code/Tool.ts `ToolUseContext`,
 * openai-agents/run_context.py.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { type Logger, createLogger } from "@crewhaus/logging";
import { TraceEventBus } from "@crewhaus/trace-event-bus";

/**
 * Where content currently flowing through the runtime originated. Mirrors
 * `TrustOrigin` in `@crewhaus/boundary-classifier`. Kept as a string-literal
 * union here (instead of an import) so `run-context` does not depend on the
 * classifier — it carries the metadata; the classifier owns the policy.
 */
export type TrustOrigin =
  | "user"
  | "mcp"
  | "subagent"
  | "channel"
  | "federation"
  | "skill"
  | "compaction"
  | "tool";

export type RunContext = {
  readonly runId: string;
  readonly sessionId: string;
  /** Mutable: orchestrator increments at the start of each user turn. */
  turnNumber: number;
  readonly abortSignal: AbortSignal;
  readonly logger: Logger;
  /**
   * Per-run trace bus. Always non-null — the factory mints a default
   * subscriber-less bus when none is supplied. Pluggable subscribers
   * (otel-exporter, metrics-collector, structured-event-printer) are
   * attached by the orchestrator's `attachDefaultSubscribers` helper based
   * on env vars.
   */
  readonly eventBus: TraceEventBus;
  /**
   * Pillar 3 — origin chain. The runtime appends an origin every time it
   * crosses a trust boundary (sub-agent enters with `["subagent"]`; a
   * federation peer call enters with `["federation"]`; an MCP tool inside
   * a sub-agent looks like `["subagent", "mcp"]` when the boundary checks
   * fire). Audit logs and trace events read this so a redacted payload
   * carries the *full provenance* of the trust transition that produced
   * the redaction. Optional + readonly for backward-compat — existing
   * `createRunContext` callers don't need to pass it.
   */
  readonly originStack?: ReadonlyArray<TrustOrigin>;
};

export type RunContextOptions = {
  /**
   * Override the auto-generated `runId`. Format is unconstrained; the
   * default factory produces `run_<8 hex>`.
   */
  runId?: string;
  /**
   * Override the auto-generated `sessionId`. Must follow the format
   * `sess_<16 hex>` so it round-trips through `@crewhaus/session-store`
   * (whose path-traversal guard rejects anything else). The default
   * factory produces a value that already conforms; runtime-core
   * overrides this when creating or resuming a persisted session.
   */
  sessionId?: string;
  abortSignal?: AbortSignal;
  logger?: Logger;
  /**
   * Override the auto-constructed `TraceEventBus`. Sub-agents pass a child
   * bus they minted via `inheritTraceId` so the parent and child share one
   * OpenTelemetry trace.
   */
  eventBus?: TraceEventBus;
  /** Initial origin chain. Defaults to undefined (top-level/user context). */
  originStack?: ReadonlyArray<TrustOrigin>;
};

function shortId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Generate a fresh sessionId in the format `sess_<16 hex>`. The 16-hex
 * suffix matches the regex `@crewhaus/session-store` enforces on every
 * read path, so a `RunContext`-supplied id can flow straight into
 * `sessionStore.create({ id })` without a format conversion.
 */
function generateSessionId(): string {
  return `sess_${randomBytes(8).toString("hex")}`;
}

/**
 * Build a fresh RunContext with sensible defaults: random ids, a
 * never-aborted signal, a logger that has the run/session ids
 * pre-bound so every log line is tagged automatically, and a fresh
 * `TraceEventBus`.
 */
export function createRunContext(opts: RunContextOptions = {}): RunContext {
  const runId = opts.runId ?? `run_${shortId()}`;
  const sessionId = opts.sessionId ?? generateSessionId();
  const abortSignal = opts.abortSignal ?? new AbortController().signal;
  const baseLogger = opts.logger ?? createLogger();
  const logger = baseLogger.child({ runId, sessionId });
  const eventBus = opts.eventBus ?? new TraceEventBus({ runId, sessionId, logger });
  const ctx: RunContext = {
    runId,
    sessionId,
    turnNumber: 0,
    abortSignal,
    logger,
    eventBus,
    ...(opts.originStack !== undefined ? { originStack: opts.originStack } : {}),
  };
  return ctx;
}

/**
 * Return a shallow-cloned `RunContext` with `origin` appended to
 * `originStack`. Used by boundary sites (sub-agent spawner, MCP host,
 * channel adapters, federation router, skills registry, compaction
 * packages) to record the trust-domain crossing in the audit trail.
 *
 * Does NOT mutate the input — every caller works with a fresh context
 * that the inner runtime sees with its own provenance chain.
 */
export function pushOrigin(ctx: RunContext, origin: TrustOrigin): RunContext {
  const next: ReadonlyArray<TrustOrigin> = ctx.originStack
    ? [...ctx.originStack, origin]
    : [origin];
  return { ...ctx, originStack: next };
}
