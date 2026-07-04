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
  // Section 22 — CRW lifecycle events. Reuse the cyan/blue family so a
  // crew's role traffic visually parallels sub-agent + model spans.
  role_start: "\x1b[96m", // bright cyan
  role_end: "\x1b[96m",
  handoff: "\x1b[35m", // magenta — peer-coordination hand-off
  a2a_message: "\x1b[95m", // bright magenta
  crew_done: "\x1b[32m", // green — terminal success
  // Section 27 — production hardening events
  cost_accrual: "\x1b[2m", // dim — high-volume per-response accruals
  circuit_state_changed: "\x1b[31m", // red — degradation warnings stand out
  // Item 22 — provider failover chain rerouted a model call
  model_failover: "\x1b[91m", // bright red — a provider switch is a headline
  // Item 26 — two-tier turn-difficulty router picked a tier this turn
  model_tier_route: "\x1b[94m", // bright blue — a routing decision, in the model family
  // model_pool — the PolicyRouter picked a candidate this turn
  model_route: "\x1b[94m", // bright blue — a routing decision, in the model family
  // Human feedback channel — a user rating on an assistant turn.
  response_rated: "\x1b[92m", // bright green — a human signal worth spotting
  // Ops item 36 — boot-time self-heal janitor maintenance actions.
  janitor_action: "\x1b[2m", // dim — routine housekeeping
  // Track F (§57) — AgentFlow-style runtime feedback channels
  test_verdict: "\x1b[32m", // green by default; pretty printer flips to red for fail
  program_output: "\x1b[2m", // dim — high-volume
  coverage_report: "\x1b[34m", // blue
  sanitizer_report: "\x1b[31m", // red — almost always a finding
  // Ops item 31 — alert watchdog breach against a baseline-derived threshold
  alert_raised: "\x1b[91m", // bright red — an alert is a headline
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
