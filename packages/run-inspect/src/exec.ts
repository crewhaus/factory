/**
 * A supervised execution's trace events, joined into the run they belong to. The events
 * are read through harness-supervisor's `./run-detail` (`runEventsAt`): contained to the
 * harness, from the run's place in the execution's run index when there is one, bounded,
 * and scrubbed of the harness's env values. Each event keeps the byte offset its line
 * starts at, which is its entry id, `x:<offset>`.
 *
 * The timeline lists the events the session log has no line for (breaker trips, model
 * switches, recoveries, MCP and tool call ends, hooks, unpriced models, a run failure),
 * under fixed titles; every other event is counted. What could not be read is a named gap,
 * never a refusal: a file that is gone is `pruned` when retention's record names the
 * execution and `not-recorded` otherwise, a damaged line is `torn`, and a byte budget
 * that ran out is `truncated`.
 */
import { type ExecutionEventsRead, runEventsAt } from "@crewhaus/harness-supervisor/run-detail";
import type { InspectGap, TimelineEntry } from "./model";
import { code, isoOf, num, str } from "./records";
import type { EntryKind } from "./taxonomy";
import { groupOf } from "./taxonomy";

/** One execution's events for one run, as read. */
export type ExecutionRead = ExecutionEventsRead & {
  /** The execution: a supervisor's run id. */
  readonly exec: string;
};

/** Read execution `exec`'s events for `run`. Reads only; never throws. */
export function readExecution(harnessDir: string, exec: string, run: string): ExecutionRead {
  try {
    return { exec, ...runEventsAt(harnessDir, exec, { run }) };
  } catch {
    return {
      exec,
      present: false,
      pruned: false,
      refused: "the execution's events could not be read",
      entries: [],
      truncated: false,
      torn: 0,
      from: "scan",
    };
  }
}

/** Why part of an execution's events cannot be shown. */
export function executionGaps(read: ExecutionRead | undefined): InspectGap[] {
  if (read === undefined) return [];
  if (!read.present) {
    return [read.pruned ? { reason: "pruned" } : { reason: "not-recorded" }];
  }
  const gaps: InspectGap[] = [];
  if (read.torn > 0) gaps.push({ reason: "torn", count: read.torn });
  if (read.truncated) gaps.push({ reason: "truncated" });
  return gaps;
}

type Event = Readonly<Record<string, unknown>>;

/** A listed event: its entry kind, its fixed title, whether it is a failure, any content. */
type Listed = {
  readonly kind: EntryKind;
  readonly title: string;
  readonly failure: boolean;
  readonly detail?: string;
};

/** "ok" or "failed", for an event that says whether it failed. */
function outcome(event: Event): string {
  return event["isError"] === true ? "failed" : "ok";
}

/**
 * The trace kinds the timeline lists, each with its entry: a closed table, read as its
 * own, so a recorded kind never resolves to a property of a built-in object.
 */
export const TRACE_ENTRY_KINDS: ReadonlyMap<string, (event: Event) => Listed> = new Map<
  string,
  (event: Event) => Listed
>([
  [
    "circuit_state_changed",
    (e) => ({
      kind: "failover",
      title: `Model breaker ${code(e["adapter"])}: ${code(e["fromState"])} → ${code(e["toState"])}`,
      failure: false,
    }),
  ],
  [
    "model_failover",
    (e) => ({
      kind: "failover",
      title: `Switched model: ${code(e["from"])} → ${code(e["to"])} (${code(e["reason"])})`,
      failure: false,
    }),
  ],
  [
    "error_recovered",
    (e) => {
      const action = code(e["action"]);
      return {
        kind: "error",
        title: `Recovered from ${code(e["errorName"])}: ${action}`,
        failure: action === "fail" || action === "halt",
      };
    },
  ],
  [
    "mcp_call_end",
    (e) => ({
      kind: "stats",
      title: `MCP call ${code(e["server"])}/${code(e["toolName"])}: ${outcome(e)}`,
      failure: false,
    }),
  ],
  [
    "tool_call_end",
    (e) => {
      const ms = num(e["durationMs"]);
      return {
        kind: "stats",
        title: `Tool ${code(e["toolName"])} ended: ${outcome(e)}${ms !== undefined ? ` (${Math.round(ms)} ms)` : ""}`,
        failure: false,
      };
    },
  ],
  [
    "hook_fired",
    (e) => ({
      kind: "check",
      title: `Hook ${code(e["event"])}: ${e["allowed"] === false ? "blocked" : "allowed"}`,
      failure: e["allowed"] === false,
    }),
  ],
  [
    "budget_unpriced",
    (e) => ({ kind: "cost", title: `A model has no price: ${code(e["modelId"])}`, failure: false }),
  ],
  [
    "run_failed",
    (e) => {
      const message = str(e["message"]);
      return {
        kind: "run-failed",
        title: `Run failed: ${code(e["class"])}`,
        failure: true,
        ...(message !== undefined ? { detail: message } : {}),
      };
    },
  ],
]);

/** The session-log line kind that records the same thing, for a kind both may hold. */
const SESSION_TWIN: ReadonlyMap<string, string> = new Map([
  ["model_failover", "model_failover"],
  ["run_failed", "run_failed"],
]);

/**
 * The timeline entries an execution's events add to a run, oldest first. A kind the run's
 * session lines already hold (`have`) is left to them.
 */
export function executionEntries(
  read: ExecutionRead | undefined,
  have: ReadonlySet<string>,
  parent: string | undefined,
): Array<TimelineEntry & { readonly atMs: number }> {
  if (read === undefined || !read.present) return [];
  const out: Array<TimelineEntry & { readonly atMs: number }> = [];
  for (const { off, event } of read.entries) {
    const kind = str(event["kind"]);
    if (kind === undefined) continue;
    const listed = TRACE_ENTRY_KINDS.get(kind);
    if (listed === undefined) continue;
    const twin = SESSION_TWIN.get(kind);
    if (twin !== undefined && have.has(twin)) continue;
    const entry = listed(event);
    const at = str(event["timestamp"]);
    const atMs = at !== undefined ? Date.parse(at) : Number.NaN;
    const id = `x:${off}`;
    out.push({
      id,
      at: isoOf(atMs),
      atMs,
      kind: entry.kind,
      group: groupOf(entry.kind),
      importance: entry.failure ? "key" : "detail",
      ...(parent !== undefined ? { parent } : {}),
      title: entry.title,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      refs: [id],
      sensitivity: entry.detail !== undefined ? "restricted" : "internal",
      ...(read.from === "scan" ? { rule: "execution-scan" as const } : {}),
    });
  }
  return out;
}

/** What the execution's events held for the run, for the summary. */
export function traceOf(
  read: ExecutionRead | undefined,
): { readonly present: boolean; readonly events: number; readonly truncated: boolean } | undefined {
  if (read === undefined) return undefined;
  return { present: read.present, events: read.entries.length, truncated: read.truncated };
}
