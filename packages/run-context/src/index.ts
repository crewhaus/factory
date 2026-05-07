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
  return {
    runId,
    sessionId,
    turnNumber: 0,
    abortSignal,
    logger,
    eventBus,
  };
}
