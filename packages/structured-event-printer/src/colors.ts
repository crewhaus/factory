/**
 * Minimal ANSI palette for the pretty printer. Color is enabled when the
 * sink is a TTY and `NO_COLOR` is not set.
 */
import type { TraceEventKind } from "@crewhaus/trace-event-bus";

const RESET = "[0m";

const PALETTE: Record<TraceEventKind, string> = {
  turn_start: "[36m", // cyan
  turn_end: "[36m",
  model_request: "[34m", // blue
  model_response: "[34m",
  model_stream_token: "[2m", // dim
  tool_call_start: "[33m", // yellow
  tool_call_end: "[33m",
  mcp_call_start: "[35m", // magenta
  mcp_call_end: "[35m",
  hook_fired: "[35m",
  compaction_fired: "[32m", // green
  permission_decision: "[33m",
  error_recovered: "[31m", // red
  sub_agent_start: "[36m",
  sub_agent_end: "[36m",
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
