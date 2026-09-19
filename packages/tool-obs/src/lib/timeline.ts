/**
 * Where one run's time went.
 *
 * The events carry a timestamp each; the gaps between them are what a reader
 * actually wants, and computing them by hand from a wall of epoch integers is
 * exactly the sort of arithmetic that should not cost a model turn.
 *
 * Two honesty rules hold here.
 *
 *   1. A gap is the distance to the PREVIOUS timestamped event, and it is
 *      attributed to the event that ENDS it. `gapMs` on a `tool_result` is how
 *      long the log waited before that line appeared — it is not necessarily
 *      how long the tool took, because other work can happen in between. Where
 *      the runtime measured the call itself, `durationMs` carries the measured
 *      figure and is the one to trust.
 *   2. An event with no timestamp keeps its place in log order and carries no
 *      gap at all, rather than being given the previous event's time. A made-up
 *      timestamp reads exactly like a real one.
 */
import { EMITTED_KIND_PREFIX } from "./emit";
import { type ObsEvent, asNumber, asRecord, asString } from "./events";

export type TimelineEntry = {
  readonly session: string;
  readonly line: number;
  readonly kind: string;
  readonly ts?: number;
  /** Milliseconds since the previous timestamped event in this timeline. */
  readonly gapMs?: number;
  /** Milliseconds since the first timestamped event in this timeline. */
  readonly offsetMs?: number;
  /** The runtime's own measurement of this step, where it recorded one. */
  readonly durationMs?: number;
  /** Tool name, model, or stop reason — whatever identifies the step. */
  readonly label?: string;
  readonly isError?: boolean;
};

export type SpanTotal = { readonly kind: string; readonly count: number; readonly totalMs: number };

export type Timeline = {
  readonly entries: readonly TimelineEntry[];
  readonly events: number;
  /** True when the entry cap cut the timeline short. */
  readonly truncated: boolean;
  readonly startTs?: number;
  readonly endTs?: number;
  readonly elapsedMs?: number;
  /**
   * Measured time by kind, from the runtime's own `durationMs` records only.
   * It does not add up to `elapsedMs` and is not meant to: the difference is
   * model time, queueing and anything the runtime did not measure.
   */
  readonly measuredByKind: readonly SpanTotal[];
};

/** What identifies a step, per kind. Best-effort; absent when the kind has none. */
function labelOf(kind: string, payload: Record<string, unknown> | undefined): string | undefined {
  if (payload === undefined) return undefined;
  // A `custom.<name>` line is one `EmitTraceEvent` wrote. Its label is the
  // name it was emitted under — without this the timeline would draw the
  // events a tool-only workflow left behind as unlabelled rows, which is the
  // one thing that would make writing them pointless. Checked before the
  // switch because the namespace is a prefix, not a kind.
  if (kind.startsWith(EMITTED_KIND_PREFIX)) return asString(payload["name"]);
  switch (kind) {
    case "tool_use":
    case "tool_stats":
      return asString(payload["name"]) ?? asString(payload["toolName"]);
    case "mcp_stats":
      return `${asString(payload["server"]) ?? "?"}/${asString(payload["toolName"]) ?? "?"}`;
    case "model_meta":
      return asString(payload["model"]);
    case "model_route":
    case "model_tier_route":
      return asString(payload["model"]);
    case "model_stage":
      return asString(payload["stage"]);
    case "run_failed":
      return asString(payload["class"]);
    case "role_start":
    case "role_end":
      return asString(payload["role"]);
    default:
      return undefined;
  }
}

/**
 * Order a run's events and annotate them with gaps.
 *
 * `events` must already be filtered to the run and ordered — this function
 * does not reorder, because the canonical order (session, line) is the order
 * the caller paged in, and re-sorting by timestamp here would silently
 * interleave two sessions that happened to overlap.
 */
export function buildTimeline(events: readonly ObsEvent[], maxEntries = 500): Timeline {
  const kept = events.slice(0, maxEntries);
  const entries: TimelineEntry[] = [];
  const measured = new Map<string, { count: number; totalMs: number }>();
  let previousTs: number | undefined;
  let startTs: number | undefined;
  let endTs: number | undefined;

  for (const event of kept) {
    const payload = asRecord(event.payload);
    const durationMs = asNumber(payload?.["durationMs"]);
    if (durationMs !== undefined) {
      const row = measured.get(event.kind) ?? { count: 0, totalMs: 0 };
      row.count += 1;
      row.totalMs += durationMs;
      measured.set(event.kind, row);
    }
    const label = labelOf(event.kind, payload);
    const isError = payload?.["isError"] === true ? true : undefined;

    if (event.ts === undefined) {
      entries.push({
        session: event.session,
        line: event.line,
        kind: event.kind,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(isError !== undefined ? { isError } : {}),
      });
      continue;
    }
    if (startTs === undefined) startTs = event.ts;
    endTs = event.ts;
    entries.push({
      session: event.session,
      line: event.line,
      kind: event.kind,
      ts: event.ts,
      ...(previousTs !== undefined ? { gapMs: event.ts - previousTs } : {}),
      ...(startTs !== undefined ? { offsetMs: event.ts - startTs } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(isError !== undefined ? { isError } : {}),
    });
    previousTs = event.ts;
  }

  return {
    entries,
    events: events.length,
    truncated: events.length > kept.length,
    ...(startTs !== undefined ? { startTs } : {}),
    ...(endTs !== undefined ? { endTs } : {}),
    ...(startTs !== undefined && endTs !== undefined ? { elapsedMs: endTs - startTs } : {}),
    measuredByKind: [...measured.keys()]
      .map((kind) => {
        const row = measured.get(kind) as { count: number; totalMs: number };
        return { kind, count: row.count, totalMs: row.totalMs };
      })
      .sort((a, b) => b.totalMs - a.totalMs || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)),
  };
}
