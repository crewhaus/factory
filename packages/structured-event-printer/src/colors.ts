/**
 * Minimal ANSI palette for the pretty printer. Color is enabled when the
 * sink is a TTY and `NO_COLOR` is not set.
 */
import type { TraceEventKind } from "@crewhaus/trace-event-bus";

const RESET = "\x1b[0m";

const PALETTE: Record<TraceEventKind, string> = {
  turn_start: "\x1b[36m", // cyan
  turn_end: "\x1b[36m",
  model_request: "\x1b[34m", // blue
  model_response: "\x1b[34m",
  model_stream_token: "\x1b[2m", // dim
  tool_call_start: "\x1b[33m", // yellow
  tool_call_end: "\x1b[33m",
  tool_stream_chunk: "\x1b[2m", // Section 18 — dim, high-volume streaming chunks
  mcp_call_start: "\x1b[35m", // magenta
  mcp_call_end: "\x1b[35m",
  hook_fired: "\x1b[35m",
  compaction_fired: "\x1b[32m", // green
  permission_decision: "\x1b[33m",
  error_recovered: "\x1b[31m", // red
  sub_agent_start: "\x1b[36m",
  sub_agent_end: "\x1b[36m",
};

export function colorize(kind: TraceEventKind, text: string, useColor: boolean): string {
  if (!useColor) return text;
  return `${PALETTE[kind] ?? ""}${text}${RESET}`;
}

export function colorEnabled(
  stream: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env["NO_COLOR"]) return false;
  return Boolean(stream.isTTY);
}
