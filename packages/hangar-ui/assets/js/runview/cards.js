/**
 * One trace event → one card the run view draws: `{kind, title, badge?, sub?,
 * meta?, severity, children?}`. Pure: no DOM.
 *
 * Every kind a harness's trace can carry has its card here, in plain words; a
 * kind this console does not know yet still draws, as "Other event (<kind>)", so
 * nothing is dropped from a feed. What a model thought is never shown: a
 * response card says how much it wrote, never what.
 *
 * A card states an outcome (allowed, given, finished, ok) only when the field that
 * proves it is present: the versioned stream sends a trace line's kind alone, and
 * then each card says only what kind of thing happened. Every title starts with a
 * capital letter and never holds a placeholder.
 *
 * Severity is one of `quiet`, `info`, `notice`, `warn`, `error`; the feed's
 * Important filter keeps `notice` and above.
 *
 * The card models follow the shape UIs' renderers (https://github.com/crewhaus/ui,
 * `_shared/events.js`) and this console's earlier trace cards.
 */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" && v !== "" ? v : null);

/** Milliseconds as a short duration. */
export function fmtMs(ms) {
  const n = num(ms);
  if (n === null) return null;
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(n / 60_000)} min ${Math.round((n % 60_000) / 1000)} s`;
}

/** A byte count in plain units. */
export function fmtBytes(bytes) {
  const n = num(bytes);
  if (n === null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Micro-dollars as dollars; an unpriced amount is "cost unknown", never $0. */
export function fmtMicros(micros) {
  const n = num(micros);
  if (n === null) return "cost unknown";
  return `$${(n / 1_000_000).toFixed(n < 10_000 ? 4 : 2)}`;
}

const joined = (...parts) => {
  const kept = parts.filter((p) => p !== null && p !== undefined && p !== "");
  return kept.length === 0 ? undefined : kept.join(" · ");
};

const tool = (e) => str(e.toolName) ?? "a tool";

/** A call that ended: failed or finished only when `isError` says which. */
const callEnd = (e, extra) => {
  const name = str(e.toolName);
  const what = name !== null ? `A call to ${name}` : "A tool call";
  if (e.isError === true)
    return { severity: "error", title: `${what} failed`, badge: "failed", ...extra };
  if (e.isError === false)
    return { severity: "info", title: `${what} finished`, badge: "ok", ...extra };
  return { severity: "info", title: `${what} ended`, ...extra };
};

/** The renderer for each kind of the trace union. */
const CARDS = {
  turn_start: (e) => ({
    severity: "quiet",
    title: num(e.turn) !== null ? `Turn ${e.turn} started` : "A turn started",
    meta: num(e.messageCount) !== null ? `${e.messageCount} messages` : undefined,
  }),
  turn_end: (e) => ({
    severity: "quiet",
    title: num(e.turn) !== null ? `Turn ${e.turn} ended` : "A turn ended",
    sub: str(e.stopReason) !== null ? `Stopped: ${e.stopReason}` : undefined,
    meta: fmtMs(e.durationMs) ?? undefined,
  }),
  model_request: (e) => ({
    severity: "quiet",
    title: "Asked the model",
    badge: str(e.model) ?? undefined,
  }),
  model_response: (e) => ({
    severity: "info",
    title: "The model answered",
    badge: str(e.model) ?? undefined,
    sub:
      e.usage && typeof e.usage === "object"
        ? joined(
            num(e.usage.input) !== null ? `${e.usage.input} in` : null,
            num(e.usage.output) !== null ? `${e.usage.output} out` : null,
            num(e.usage.cacheRead) ? `${e.usage.cacheRead} cached` : null,
          )
        : undefined,
  }),
  model_stream_token: (e) => ({
    severity: "quiet",
    title: "The model is writing",
    meta: num(e.deltaChars) !== null ? `${e.deltaChars} characters` : undefined,
  }),
  tool_call_start: (e) => ({
    severity: "info",
    title: `Using ${tool(e)}`,
    meta: fmtBytes(e.inputBytes) ?? undefined,
  }),
  tool_call_end: (e) => callEnd(e, { meta: joined(fmtMs(e.durationMs), fmtBytes(e.outputBytes)) }),
  tool_stream_chunk: (e) => ({
    severity: "quiet",
    title: `${str(e.stream) === "stderr" ? "Errors" : "Output"} from ${tool(e)}`,
    meta: fmtBytes(e.bytes) ?? undefined,
  }),
  mcp_call_start: (e) => ({
    severity: "info",
    title: `Using ${tool(e)}`,
    badge: str(e.server) ?? undefined,
  }),
  mcp_call_end: (e) => {
    const card = callEnd(e, { meta: fmtMs(e.durationMs) ?? undefined });
    return str(e.server) !== null ? { ...card, sub: `Server: ${e.server}` } : card;
  },
  hook_fired: (e) => ({
    severity: e.allowed === false ? "warn" : "quiet",
    title:
      e.allowed === false
        ? `A hook blocked ${str(e.event) ?? "a step"}`
        : `A hook ran on ${str(e.event) ?? "a step"}`,
    sub: str(e.reason) ?? undefined,
    meta: fmtMs(e.durationMs) ?? undefined,
  }),
  compaction_fired: (e) => ({
    severity: "notice",
    title: "The conversation was shortened to fit",
    sub: num(e.before) !== null && num(e.after) !== null ? `${e.before} → ${e.after}` : undefined,
  }),
  curate: (e) => ({
    severity: "quiet",
    title: "Older context was tidied",
    meta: num(e.dropped) !== null ? `${e.dropped} dropped` : undefined,
  }),
  cache_rotation: () => ({ severity: "quiet", title: "The prompt cache was refreshed" }),
  permission_decision: (e) => ({
    severity: e.decision === "deny" ? "warn" : e.decision === "ask" ? "notice" : "quiet",
    title:
      e.decision === "deny"
        ? `Not allowed to use ${tool(e)}`
        : e.decision === "ask"
          ? `Asking a person before using ${tool(e)}`
          : e.decision === "allow"
            ? `Allowed to use ${tool(e)}`
            : "A permission was decided",
    sub: str(e.reason) ?? undefined,
  }),
  error_recovered: (e) => ({
    severity: "notice",
    title: "Recovered from an error",
    sub: joined(str(e.errorName), str(e.action)),
  }),
  run_failed: (e) => ({
    severity: "error",
    title: "The run failed",
    badge: str(e.class) ?? undefined,
    sub: str(e.message) ?? undefined,
    children: str(e.remediation) !== null ? [{ label: "Fix", text: e.remediation }] : undefined,
  }),
  sub_agent_start: (e) => ({
    severity: "notice",
    title: `Started a helper${str(e.name) !== null ? `: ${e.name}` : ""}`,
    badge: str(e.model) ?? undefined,
  }),
  sub_agent_end: (e) => ({
    severity: e.isError === true ? "error" : "notice",
    title: `${e.isError === true ? "A helper failed" : e.isError === false ? "A helper finished" : "A helper ended"}${str(e.name) !== null ? `: ${e.name}` : ""}`,
    meta: fmtMs(e.durationMs) ?? undefined,
  }),
  role_start: (e) => ({
    severity: "info",
    title: str(e.role) !== null ? `Role ${e.role} started` : "A role started",
    badge: str(e.model) ?? undefined,
  }),
  role_end: (e) => ({
    severity: "info",
    title: str(e.role) !== null ? `Role ${e.role} ended` : "A role ended",
    meta: fmtMs(e.durationMs) ?? undefined,
  }),
  handoff: (e) => ({
    severity: "notice",
    title:
      str(e.from) !== null && str(e.to) !== null
        ? `Handed off from ${e.from} to ${e.to}`
        : "Work was handed off",
    sub: str(e.reason) ?? undefined,
  }),
  a2a_message: (e) => ({
    severity: "info",
    title:
      str(e.from) !== null && str(e.to) !== null
        ? `Message from ${e.from} to ${e.to}`
        : "A message between agents",
    meta: fmtBytes(e.payloadBytes) ?? undefined,
  }),
  crew_done: (e) => ({
    severity: "notice",
    title: "The crew is done",
    sub: str(e.finalRole) !== null ? `Last role: ${e.finalRole}` : undefined,
    meta: fmtMs(e.durationMs) ?? undefined,
  }),
  cost_accrual: (e) => ({
    severity: "quiet",
    title: "Cost so far",
    badge: str(e.modelId) ?? str(e.model) ?? undefined,
    meta: fmtMicros(e.costUsdMicros),
  }),
  circuit_state_changed: (e) => ({
    severity: e.toState === "open" ? "warn" : "notice",
    title:
      e.toState === "open"
        ? `Provider ${str(e.adapter) ?? ""} paused after errors`.replace("  ", " ")
        : str(e.toState) !== null
          ? `Provider ${str(e.adapter) ?? ""} is now ${e.toState}`.replace("  ", " ")
          : "A provider's state changed",
    sub: str(e.reason) ?? undefined,
  }),
  model_failover: (e) => ({
    severity: "warn",
    title:
      str(e.from) !== null && str(e.to) !== null
        ? `Switched model from ${e.from} to ${e.to}`
        : "The model changed",
    sub: str(e.reason) ?? undefined,
  }),
  model_tier_route: (e) => ({
    severity: "quiet",
    title: "Picked a model",
    badge: str(e.model) ?? undefined,
    sub: str(e.reason) ?? undefined,
  }),
  model_route: (e) => ({
    severity: "quiet",
    title: "Picked a model",
    badge: str(e.model) ?? undefined,
    sub: str(e.reason) ?? undefined,
  }),
  model_stage: (e) => ({
    severity: e.outcome === "failed" ? "warn" : "quiet",
    title: `${str(e.stage) !== null ? `Stage ${e.stage}` : "A model stage"}${str(e.outcome) !== null ? `: ${e.outcome}` : " ran"}`,
    badge: str(e.model) ?? undefined,
  }),
  model_directive: (e) => ({
    severity: e.accepted === false ? "warn" : "info",
    title:
      e.accepted === false
        ? "A model change was refused"
        : e.accepted === true
          ? "The model was changed"
          : "A model change was asked for",
    sub: joined(str(e.requested), str(e.reason)),
  }),
  janitor_action: (e) => ({
    severity: e.status === "failed" ? "warn" : "quiet",
    title: `Housekeeping: ${str(e.step) ?? "a step"}`,
    sub: str(e.detail) ?? undefined,
  }),
  response_rated: (e) => ({
    severity: "notice",
    title: "Someone rated an answer",
    badge: e.rating !== undefined ? String(e.rating) : undefined,
  }),
  approval_requested: (e) => ({
    severity: "notice",
    title: `Waiting for approval to use ${tool(e)}`,
  }),
  approval_resolved: (e) => ({
    severity: e.decision === "deny" ? "warn" : "notice",
    title:
      e.decision === "deny"
        ? "Approval was denied"
        : str(e.decision) !== null
          ? "Approval was given"
          : "An approval was settled",
    sub: str(e.by) !== null ? `By ${e.by}` : undefined,
  }),
  test_verdict: (e) => ({
    severity: e.verdict === "fail" ? "warn" : "info",
    title:
      str(e.verdict) !== null
        ? `${str(e.testId) !== null ? `Test ${e.testId}` : "A test"}: ${e.verdict}`
        : str(e.testId) !== null
          ? `Test ${e.testId} reported`
          : "A test reported",
    meta: fmtMs(e.durationMs) ?? undefined,
  }),
  program_output: (e) => ({
    severity: num(e.exitCode) !== null && e.exitCode !== 0 ? "warn" : "info",
    title: `A program ran${num(e.exitCode) !== null ? ` (exit ${e.exitCode})` : ""}`,
    meta: fmtMs(e.durationMs) ?? undefined,
  }),
  coverage_report: (e) => ({
    severity: "info",
    title: "Coverage measured",
    sub:
      num(e.linesCovered) !== null && num(e.linesTotal) !== null
        ? `${e.linesCovered} of ${e.linesTotal} lines`
        : undefined,
  }),
  sanitizer_report: (e) => ({
    severity: e.isError === true ? "warn" : "info",
    title: `${str(e.sanitizer) !== null ? `Sanitizer ${e.sanitizer}` : "A sanitizer"} ${
      e.isError === true ? "found a problem" : e.isError === false ? "found nothing" : "ran"
    }`,
    sub: str(e.summary) ?? undefined,
  }),
  alert_raised: (e) => ({
    severity: "warn",
    title: `Alert: ${str(e.metric) ?? "a measure"} is off`,
    sub: str(e.detail) ?? undefined,
  }),
  eval_graded: (e) => ({
    severity: e.verdict === "fail" ? "warn" : "info",
    title: str(e.verdict) !== null ? `Graded: ${e.verdict}` : "A grade was recorded",
    meta: num(e.score) !== null ? `score ${e.score}` : undefined,
  }),
  eval_unmeasured: (e) => ({
    severity: "warn",
    title: "A check could not be measured",
    sub: str(e.reason) ?? undefined,
  }),
  judge_verdict: (e) => ({
    severity: e.verdict === "fail" ? "warn" : "info",
    title: str(e.verdict) !== null ? `Judged: ${e.verdict}` : "A judge gave a verdict",
    meta: num(e.score) !== null ? `score ${e.score}` : undefined,
  }),
  provability_graded: (e) => ({
    severity: e.verdict === "fail" ? "warn" : "info",
    title:
      str(e.level) !== null && str(e.verdict) !== null
        ? `Proof level ${e.level}: ${e.verdict}`
        : "A proof level was graded",
  }),
  proof_checked: (e) => ({
    severity: e.ok === false ? "warn" : "info",
    title:
      e.ok === false
        ? "A proof did not check"
        : e.ok === true
          ? "A proof checked"
          : "A proof was checked",
    badge: str(e.checker) ?? undefined,
  }),
  context_assembled: (e) => ({
    severity: "quiet",
    title: "Prepared what the model sees",
    meta: num(e.messages) !== null ? `${e.messages} messages` : undefined,
  }),
};

/** Every kind this console draws its own card for. */
export const CARD_KINDS = Object.freeze(Object.keys(CARDS));

/** One trace event → its card. */
export function cardFor(event) {
  const e = event !== null && typeof event === "object" ? event : {};
  const kind = typeof e.kind === "string" && e.kind !== "" ? e.kind : "unknown";
  const render = Object.hasOwn(CARDS, kind) ? CARDS[kind] : null;
  if (render === null) {
    return { kind, title: `Other event (${kind})`, severity: "info" };
  }
  const card = render(e);
  const out = { kind, title: card.title, severity: card.severity };
  for (const field of ["badge", "sub", "meta", "children"]) {
    if (card[field] !== undefined && card[field] !== null) out[field] = card[field];
  }
  return out;
}

/** The severities the Important filter keeps. */
export const IMPORTANT_SEVERITIES = Object.freeze(["notice", "warn", "error"]);

/** Whether a card is shown under Important. */
export function isImportant(card) {
  return IMPORTANT_SEVERITIES.includes(card?.severity);
}
