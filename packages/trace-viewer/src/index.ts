/**
 * Catalog F4 `trace-viewer` — Section 26 Studio.
 *
 * Pure-logic Gantt-layout helper for `TraceEvent[]` corpora. Pairs
 * start events (`*_start`, `model_request`, `tool_call_start`,
 * `mcp_call_start`, `sub_agent_start`, `role_start`) with the
 * matching end events (`*_end`, `model_response`, `tool_call_end`,
 * `mcp_call_end`, `sub_agent_end`, `role_end`) by `spanId`, returns
 * a flat `TimelineSpan[]` with absolute t0/t1 ms, plus parent links
 * for indented rendering.
 *
 * The output is renderer-agnostic — studio-ui consumes it to build
 * Gantt bars; eval-report embeds it inside per-sample drilldowns. T1
 * snapshot tests use the deterministic structure.
 */
import type { TraceEvent } from "@crewhaus/trace-event-bus";

export type SpanKind =
  | "turn"
  | "model"
  | "tool"
  | "tool_stream"
  | "mcp"
  | "hook"
  | "compaction"
  | "permission"
  | "recovery"
  | "sub_agent"
  | "role"
  | "handoff"
  | "a2a_message"
  | "crew";

export type TimelineSpan = {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly kind: SpanKind;
  /** Short label for the span, e.g. "tool: WebFetch" or "role: writer". */
  readonly label: string;
  /** Absolute milliseconds since epoch (start). */
  readonly t0: number;
  /** Absolute ms since epoch (end). For point-events (no end), t1 === t0. */
  readonly t1: number;
  /** Hierarchical depth — 0 for spans whose parent is the run root, 1 for nested. */
  readonly depth: number;
  /** Free-form metadata; subscribers may render this on hover. */
  readonly meta: Readonly<Record<string, unknown>>;
};

export type Timeline = {
  /** Earliest event timestamp in the corpus. */
  readonly t0: number;
  /** Latest event timestamp + duration in the corpus. */
  readonly t1: number;
  readonly spans: ReadonlyArray<TimelineSpan>;
};

function tsMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function spanLabel(kind: SpanKind, ev: TraceEvent): string {
  switch (kind) {
    case "model":
      if (ev.kind === "model_request" || ev.kind === "model_response")
        return `model: ${(ev as unknown as { model: string }).model}`;
      return "model";
    case "tool":
      if (ev.kind === "tool_call_start" || ev.kind === "tool_call_end")
        return `tool: ${(ev as unknown as { toolName: string }).toolName}`;
      return "tool";
    case "mcp":
      if (ev.kind === "mcp_call_start" || ev.kind === "mcp_call_end")
        return `mcp: ${(ev as unknown as { toolName: string }).toolName}`;
      return "mcp";
    case "hook":
      if (ev.kind === "hook_fired") return `hook: ${(ev as unknown as { event: string }).event}`;
      return "hook";
    case "compaction":
      if (ev.kind === "compaction_fired")
        return `compaction: ${(ev as unknown as { subKind: string }).subKind}`;
      return "compaction";
    case "permission":
      if (ev.kind === "permission_decision")
        return `permission: ${(ev as unknown as { toolName: string; decision: string }).toolName}=${(ev as unknown as { decision: string }).decision}`;
      return "permission";
    case "recovery":
      if (ev.kind === "error_recovered")
        return `recover: ${(ev as unknown as { action: string }).action}`;
      return "recovery";
    case "sub_agent":
      if (ev.kind === "sub_agent_start" || ev.kind === "sub_agent_end")
        return `sub_agent: ${(ev as unknown as { name: string }).name}`;
      return "sub_agent";
    case "role":
      if (ev.kind === "role_start" || ev.kind === "role_end")
        return `role: ${(ev as unknown as { role: string }).role}`;
      return "role";
    case "handoff":
      if (ev.kind === "handoff")
        return `handoff: ${(ev as unknown as { from: string; to: string }).from}→${(ev as unknown as { to: string }).to}`;
      return "handoff";
    case "a2a_message":
      if (ev.kind === "a2a_message")
        return `a2a: ${(ev as unknown as { from: string; to: string }).from}→${(ev as unknown as { to: string }).to}`;
      return "a2a";
    case "turn":
      return `turn ${(ev as unknown as { turn?: number }).turn ?? "?"}`;
    case "crew":
      return "crew";
    case "tool_stream":
      return "tool stream";
  }
}

function startKind(eventKind: string): SpanKind | undefined {
  switch (eventKind) {
    case "turn_start":
      return "turn";
    case "model_request":
      return "model";
    case "tool_call_start":
      return "tool";
    case "mcp_call_start":
      return "mcp";
    case "sub_agent_start":
      return "sub_agent";
    case "role_start":
      return "role";
    default:
      return undefined;
  }
}

function endKindForStart(eventKind: string): string | undefined {
  switch (eventKind) {
    case "turn_start":
      return "turn_end";
    case "model_request":
      return "model_response";
    case "tool_call_start":
      return "tool_call_end";
    case "mcp_call_start":
      return "mcp_call_end";
    case "sub_agent_start":
      return "sub_agent_end";
    case "role_start":
      return "role_end";
    default:
      return undefined;
  }
}

function pointKind(eventKind: string): SpanKind | undefined {
  switch (eventKind) {
    case "hook_fired":
      return "hook";
    case "compaction_fired":
      return "compaction";
    case "permission_decision":
      return "permission";
    case "error_recovered":
      return "recovery";
    case "handoff":
      return "handoff";
    case "a2a_message":
      return "a2a_message";
    case "crew_done":
      return "crew";
    default:
      return undefined;
  }
}

export function buildTimeline(events: ReadonlyArray<TraceEvent>): Timeline {
  if (events.length === 0) return { t0: 0, t1: 0, spans: [] };

  // Index events by spanId for paired-event matching.
  const byEnvelope = events.map((e) => ({ ev: e, ts: tsMs(e.timestamp) }));

  // Pair start ↔ end events on spanId.
  const startsBySpanId = new Map<string, { ev: TraceEvent; ts: number }>();
  const endsBySpanId = new Map<string, { ev: TraceEvent; ts: number }>();
  for (const r of byEnvelope) {
    const sk = startKind(r.ev.kind);
    if (sk !== undefined) {
      startsBySpanId.set(r.ev.spanId, r);
      continue;
    }
    if (endKindForStart(r.ev.kind) !== undefined) {
      // Already handled above
    }
    if (
      r.ev.kind === "turn_end" ||
      r.ev.kind === "model_response" ||
      r.ev.kind === "tool_call_end" ||
      r.ev.kind === "mcp_call_end" ||
      r.ev.kind === "sub_agent_end" ||
      r.ev.kind === "role_end"
    ) {
      endsBySpanId.set(r.ev.spanId, r);
    }
  }

  // Build spans.
  const spans: TimelineSpan[] = [];
  for (const r of byEnvelope) {
    const sk = startKind(r.ev.kind);
    if (sk !== undefined) {
      const end = endsBySpanId.get(r.ev.spanId);
      const t1 = end ? end.ts : r.ts;
      const meta: Record<string, unknown> = {
        startEvent: r.ev.kind,
        ...(end ? { endEvent: end.ev.kind } : {}),
      };
      spans.push({
        spanId: r.ev.spanId,
        ...(r.ev.parentSpanId !== undefined ? { parentSpanId: r.ev.parentSpanId } : {}),
        kind: sk,
        label: spanLabel(sk, r.ev),
        t0: r.ts,
        t1,
        depth: 0, // computed below
        meta,
      });
      continue;
    }
    const pk = pointKind(r.ev.kind);
    if (pk !== undefined) {
      spans.push({
        spanId: r.ev.spanId,
        ...(r.ev.parentSpanId !== undefined ? { parentSpanId: r.ev.parentSpanId } : {}),
        kind: pk,
        label: spanLabel(pk, r.ev),
        t0: r.ts,
        t1: r.ts,
        depth: 0,
        meta: { eventKind: r.ev.kind },
      });
    }
  }

  // Depth: BFS by parentSpanId chains, parent root is the bus root span
  // (whichever spanId has no parent in the spans list — typically all
  // top-level spans share `parentSpanId = undefined` here because we
  // don't index outside the corpus).
  const spanById = new Map<string, TimelineSpan>(spans.map((s) => [s.spanId, s]));
  const depths = new Map<string, number>();
  function depthOf(s: TimelineSpan): number {
    const cached = depths.get(s.spanId);
    if (cached !== undefined) return cached;
    if (s.parentSpanId === undefined) {
      depths.set(s.spanId, 0);
      return 0;
    }
    const parent = spanById.get(s.parentSpanId);
    if (parent === undefined) {
      depths.set(s.spanId, 0);
      return 0;
    }
    const d = depthOf(parent) + 1;
    depths.set(s.spanId, d);
    return d;
  }
  const annotated = spans.map((s) => ({ ...s, depth: depthOf(s) }));

  // t0/t1 of the corpus
  let lo = Number.POSITIVE_INFINITY;
  let hi = 0;
  for (const s of annotated) {
    if (s.t0 < lo) lo = s.t0;
    if (s.t1 > hi) hi = s.t1;
  }
  if (!Number.isFinite(lo)) lo = 0;

  // Sort by t0 ascending — Gantt rendering convention.
  annotated.sort((a, b) => a.t0 - b.t0 || a.depth - b.depth);

  return { t0: lo, t1: hi, spans: annotated };
}

/**
 * Section 31 — replay scrubber. Yields events at the configured speed
 * via a deterministic scheduler. Tests pass `now()` and `setTimeout`
 * shims so they can verify event ordering without real wall-clock waits.
 */
export type ReplayOptions = {
  /** Replay speed multiplier; 1×/2×/4×/raw. */
  readonly speed: 1 | 2 | 4 | "raw";
  /** Override setTimeout for tests. */
  readonly setTimeoutImpl?: (cb: () => void, ms: number) => void;
};

/**
 * Replay events with timing relative to the first event. Returns an
 * AsyncIterable so callers can `for await ... of` to drive the UI.
 *
 * `speed: "raw"` yields every event immediately. `speed: 1` waits the
 * actual delta between consecutive events (capped at 5s per gap).
 * `speed: 2` halves the wait; `speed: 4` quarters.
 */
export async function* replay(
  events: ReadonlyArray<TraceEvent>,
  opts: ReplayOptions,
): AsyncIterable<TraceEvent> {
  if (events.length === 0) return;
  const setTimeoutImpl = opts.setTimeoutImpl ?? setTimeout;
  const speedDivisor = opts.speed === "raw" ? Number.POSITIVE_INFINITY : opts.speed;
  const firstTs = Date.parse((events[0] as TraceEvent).timestamp);
  let lastTs = firstTs;
  for (const ev of events) {
    const evTs = Date.parse(ev.timestamp);
    const gapMs = evTs - lastTs;
    if (Number.isFinite(speedDivisor) && gapMs > 0) {
      const wait = Math.min(5000, Math.max(0, gapMs / speedDivisor));
      await new Promise<void>((resolve) => setTimeoutImpl(resolve, wait));
    }
    yield ev;
    lastTs = evTs;
  }
}

/**
 * Section 31 — drilldown helper. Surface the matching event payload for
 * a clicked span so the UI can render the full request/response.
 */
export type SpanDrilldown = {
  readonly spanId: string;
  readonly span: TimelineSpan;
  readonly events: ReadonlyArray<TraceEvent>;
};

export function drilldownSpan(
  timeline: Timeline,
  events: ReadonlyArray<TraceEvent>,
  spanId: string,
): SpanDrilldown | undefined {
  const span = timeline.spans.find((s) => s.spanId === spanId);
  if (!span) return undefined;
  const related = events.filter((e) => e.spanId === spanId || e.parentSpanId === spanId);
  return { spanId, span, events: related };
}
