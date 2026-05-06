/**
 * Catalog R1 `run-context` — per-run object threaded through the
 * orchestrator, tools, and policy. Constructed once per
 * `runChatLoop()` invocation; `turnNumber` is mutated by the
 * orchestrator as turns advance.
 *
 * Reference: claude-code/Tool.ts `ToolUseContext`,
 * openai-agents/run_context.py.
 */
import { randomUUID } from "node:crypto";
import { type Logger, createLogger } from "@crewhaus/logging";

export type RunContext = {
  readonly runId: string;
  readonly sessionId: string;
  /** Mutable: orchestrator increments at the start of each user turn. */
  turnNumber: number;
  readonly abortSignal: AbortSignal;
  readonly logger: Logger;
};

export type RunContextOptions = {
  runId?: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
  logger?: Logger;
};

function shortId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Build a fresh RunContext with sensible defaults: random ids, a
 * never-aborted signal, and a logger that has the run/session ids
 * pre-bound so every log line is tagged automatically.
 */
export function createRunContext(opts: RunContextOptions = {}): RunContext {
  const runId = opts.runId ?? `run_${shortId()}`;
  const sessionId = opts.sessionId ?? `sess_${shortId()}`;
  const abortSignal = opts.abortSignal ?? new AbortController().signal;
  const baseLogger = opts.logger ?? createLogger();
  const logger = baseLogger.child({ runId, sessionId });
  return {
    runId,
    sessionId,
    turnNumber: 0,
    abortSignal,
    logger,
  };
}
