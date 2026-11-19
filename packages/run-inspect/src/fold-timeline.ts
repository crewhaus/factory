import type { SessionLine } from "./lines";
/**
 * The run's timeline: one entry per thing that happened, newest first, each under its
 * span, key events or everything recorded. A tool call and its result are one entry;
 * each check sits on the call it judged; an approval's later outcome from the decision
 * log is an entry of its own. Titles are fixed templates; content is only ever in
 * `detail`, and it is whole: a reader masks it first and only then cuts it short, so a
 * cut never leaves part of a secret the masker would have matched whole.
 */
import type { LoadedRun } from "./load";
import {
  type InspectRefusal,
  STATUS_WORDS,
  type TimelineEntry,
  type TimelinePage,
  refusal,
} from "./model";
import {
  type RunIndex,
  code,
  costFold,
  indexRun,
  isTurnStart,
  isoOf,
  laterOutcomes,
  num,
  payloadOf,
  rec,
  str,
  textOf,
  triggerOf,
  wakeOf,
} from "./records";
import { type EntryKind, LINE_KINDS, groupOf, importanceOf } from "./taxonomy";

export const TIMELINE_DEFAULT_LIMIT = 50;
export const TIMELINE_MAX_LIMIT = 500;

/** The words for each check, in a title. */
const GATE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  permission: "Permission check",
  justification: "Reason check",
  egress: "Outbound check",
  "post-tool": "Result check",
  hook: "Hook",
  approval: "Approval",
  "rate-limit": "Rate limit",
  loop: "Loop check",
  eval: "Answer check",
  provability: "Proof check",
});

const SPAN_STATUS_STATE: Readonly<Record<string, string>> = Object.freeze({
  ok: "succeeded",
  error: "failed",
  aborted: "cancelled",
  parked: "waiting-for-approval",
  denied: "failed",
});

type Draft = Omit<TimelineEntry, "group" | "importance"> & {
  readonly entryKind: EntryKind;
  readonly outcome?: string;
  readonly atMs: number;
};

function entryOf(draft: Draft): TimelineEntry & { readonly atMs: number } {
  const { entryKind, outcome, ...rest } = draft;
  return {
    ...rest,
    kind: entryKind,
    group: groupOf(entryKind),
    importance: importanceOf(entryKind, outcome),
  };
}

function placeOf(index: RunIndex, line: SessionLine): { span?: string; parent?: string } {
  const span = line.span;
  if (span === undefined) {
    return index.rootSpan !== undefined ? { parent: index.rootSpan } : {};
  }
  const info = index.spans.get(span);
  const parent =
    span === index.rootSpan
      ? undefined
      : info?.parent !== undefined &&
          (index.spans.has(info.parent) || info.parent === index.rootSpan)
        ? info.parent
        : index.rootSpan;
  return { span, ...(parent !== undefined ? { parent } : {}) };
}

/** One line's entry, or `undefined` for a line another entry carries. */
function draftOf(index: RunIndex, line: SessionLine): Draft | undefined {
  const p = payloadOf(line);
  const base = {
    id: line.id,
    at: isoOf(line.ts),
    atMs: line.ts,
    ...placeOf(index, line),
    refs: [line.id] as readonly string[],
  };
  const turn = index.turnOf(line);
  switch (line.kind) {
    case "run_stamp": {
      const trigger = triggerOf(index).value;
      const wake = wakeOf(index)?.value;
      return {
        ...base,
        entryKind: "run-start",
        kind: "run-start",
        title: `Run started: ${trigger?.words ?? "trigger not recorded"}`,
        ...(wake !== undefined ? { detail: wake.words } : {}),
        sensitivity: wake !== undefined ? "restricted" : "internal",
      };
    }
    case "span_closed": {
      const info = index.spans.get(str(p["span"]) ?? line.span ?? "");
      if (info?.kind === "run") {
        const state = info.status !== undefined ? SPAN_STATUS_STATE[info.status] : undefined;
        return {
          ...base,
          entryKind: "run-end",
          kind: "run-end",
          title: `Run ended: ${(state !== undefined ? STATUS_WORDS[state] : undefined) ?? "status unknown"}`,
          sensitivity: "internal",
        };
      }
      if (info?.kind === "model") {
        return {
          ...base,
          entryKind: "model-call",
          kind: "model-call",
          title: `Model call ${info.call ?? "?"}${info.status !== undefined && info.status !== "ok" ? `: ${info.status}` : ""}`,
          sensitivity: "internal",
        };
      }
      if (info?.kind === "turn") {
        return {
          ...base,
          entryKind: "turn",
          kind: "turn",
          title: `Turn ${info.turn?.session ?? "?"} ended${info.status !== undefined && info.status !== "ok" ? `: ${info.status}` : ""}`,
          sensitivity: "internal",
        };
      }
      return undefined;
    }
    case "user_message": {
      const control = rec(p["control"]);
      if (control?.["synthetic"] === true) {
        const reason = str(control["reason"]);
        const by = str(control["by"]);
        return {
          ...base,
          entryKind: "operator-wake",
          kind: "operator-wake",
          title: "Operator wake",
          ...(reason !== undefined
            ? { detail: `${reason}${by !== undefined ? ` (by ${by})` : ""}` }
            : {}),
          sensitivity: "restricted",
        };
      }
      const text = textOf(p["content"]);
      if (p["synthetic"] === true) {
        return {
          ...base,
          entryKind: "note",
          kind: "note",
          title: "A note the runtime added",
          ...(text !== undefined ? { detail: text } : {}),
          sensitivity: "restricted",
        };
      }
      if (!isTurnStart(line)) return undefined;
      return {
        ...base,
        entryKind: "message",
        kind: "message",
        title: "Message",
        ...(text !== undefined ? { detail: text } : {}),
        sensitivity: "restricted",
        ...(turn !== undefined ? { turn } : {}),
      };
    }
    case "assistant_message": {
      const text = textOf(p["content"]);
      if (text === undefined || text.trim() === "") return undefined;
      return {
        ...base,
        entryKind: "answer",
        kind: "answer",
        title: "Answer",
        detail: text,
        sensitivity: "restricted",
        ...(turn !== undefined ? { turn } : {}),
      };
    }
    case "tool_use": {
      const tool = index.tools.find((t) => t.use === line);
      if (tool === undefined) return undefined;
      const spanInfo = tool.span !== undefined ? index.spans.get(tool.span) : undefined;
      const result = tool.result !== undefined ? payloadOf(tool.result) : undefined;
      const resultText = result !== undefined ? textOf(result["content"]) : undefined;
      const failed = result?.["isError"] === true;
      return {
        ...base,
        entryKind: "tool",
        kind: "tool",
        title: `Used ${tool.name}${failed ? ": failed" : spanInfo?.status !== undefined && spanInfo.status !== "ok" ? `: ${spanInfo.status}` : ""}`,
        ...(resultText !== undefined ? { detail: resultText } : {}),
        refs: [
          line.id,
          ...(tool.ran !== undefined ? [tool.ran.id] : []),
          ...(tool.result !== undefined ? [tool.result.id] : []),
          ...(spanInfo !== undefined ? [spanInfo.lineId] : []),
        ],
        sensitivity: "restricted",
        ...(turn !== undefined ? { turn } : {}),
      };
    }
    case "verdict": {
      const gate = code(p["gate"]);
      const outcome = code(p["outcome"]);
      const reason = str(p["reason"]);
      return {
        ...base,
        entryKind: "check",
        kind: "check",
        outcome,
        title: `${GATE_WORDS[gate] ?? "Check"}: ${outcome}`,
        ...(reason !== undefined ? { detail: reason } : {}),
        sensitivity: "internal",
      };
    }
    case "compaction": {
      const before = num(p["before"]);
      const after = num(p["after"]);
      return {
        ...base,
        entryKind: "compaction",
        kind: "compaction",
        title: `Compacted the conversation${before !== undefined && after !== undefined ? ` (${before} → ${after} messages)` : ""}`,
        sensitivity: "internal",
      };
    }
    case "context_evicted":
      return {
        ...base,
        entryKind: "eviction",
        kind: "eviction",
        title: "Moved an earlier message out of the context",
        sensitivity: "internal",
      };
    case "context_manifest":
      return {
        ...base,
        entryKind: "context",
        kind: "context",
        title: `Context for model call ${num(p["call"]) ?? "?"}`,
        sensitivity: "internal",
      };
    case "model_route":
    case "model_tier_route":
      return {
        ...base,
        entryKind: "route",
        kind: "route",
        title: `Model chosen: ${code(p["model"])}`,
        sensitivity: "internal",
      };
    case "model_failover":
      return {
        ...base,
        entryKind: "failover",
        kind: "failover",
        title: `Switched model: ${code(p["from"])} → ${code(p["to"])}`,
        sensitivity: "internal",
      };
    case "cost_accrual": {
      const cost = costFold([line], index.attribution)?.value;
      if (cost === undefined) return undefined;
      return {
        ...base,
        entryKind: "cost",
        kind: "cost",
        title: `Cost: ${cost.words}`,
        sensitivity: "internal",
      };
    }
    case "run_failed":
      return {
        ...base,
        entryKind: "run-failed",
        kind: "run-failed",
        title: `Run failed: ${code(p["class"])}`,
        ...(str(p["message"]) !== undefined ? { detail: str(p["message"]) as string } : {}),
        sensitivity: "restricted",
      };
    case "error":
      return {
        ...base,
        entryKind: "error",
        kind: "error",
        title: "An error was recorded",
        ...(str(p["message"]) !== undefined ? { detail: str(p["message"]) as string } : {}),
        sensitivity: "restricted",
      };
    case "sub_agent_start":
      return {
        ...base,
        entryKind: "helper",
        kind: "helper",
        title: `Ran a helper: ${code(p["name"])}`,
        ...(str(p["childRunId"]) !== undefined ? { detail: code(p["childRunId"]) } : {}),
        sensitivity: "internal",
      };
    default: {
      const kind = LINE_KINDS[line.kind];
      if (kind === undefined) {
        if (Object.hasOwn(LINE_KINDS, line.kind)) return undefined;
        return {
          ...base,
          entryKind: "other",
          kind: "other",
          title: `Recorded: ${code(line.kind)}`,
          sensitivity: "internal",
        };
      }
      return {
        ...base,
        entryKind: kind,
        kind,
        title: `Recorded: ${code(line.kind)}`,
        sensitivity: kind === "feedback" ? "restricted" : "internal",
      };
    }
  }
}

/** Every entry of the run, oldest first. */
export function timelineEntries(index: RunIndex): ReadonlyArray<TimelineEntry & { atMs: number }> {
  const session: Array<TimelineEntry & { atMs: number }> = [];
  // An operator's wake: its marker is unscoped and precedes the run, and is the one
  // unscoped line attributed to it.
  const wake = wakeOf(index);
  const markerId = wake?.state === "reconstructed" ? wake.refs[0] : undefined;
  const marker = [...index.loaded.markers, ...index.loaded.lines].find(
    (line) => line.id === markerId,
  );
  if (marker !== undefined && !index.lines.includes(marker)) {
    const draft = draftOf(index, marker);
    if (draft !== undefined) session.push(entryOf(draft));
  }
  for (const line of index.lines) {
    const draft = draftOf(index, line);
    if (draft !== undefined) session.push(entryOf(draft));
  }
  for (const gap of index.loaded.gaps) {
    if (gap.from === undefined || !gap.from.startsWith("s:")) continue;
    const off = Number(gap.from.slice(2));
    const before = [...index.loaded.lines].reverse().find((line) => line.off < off);
    const atMs = before?.ts ?? Number.NaN;
    const draft: Draft = {
      id: `g:${gap.from}`,
      at: isoOf(atMs),
      atMs,
      entryKind: "gap",
      kind: "gap",
      title:
        gap.reason === "torn" ? "A damaged line was skipped" : "Reading stopped at a size limit",
      refs: [gap.from],
      sensitivity: "internal",
      ...(index.rootSpan !== undefined ? { parent: index.rootSpan } : {}),
    };
    const at = session.findIndex(
      (entry) => entry.id.startsWith("s:") && Number(entry.id.slice(2)) > off,
    );
    session.splice(at === -1 ? session.length : at, 0, entryOf(draft));
  }
  // An approval's later outcomes, at their place in time.
  const seen = new Set<string>();
  for (const verdict of index.verdicts) {
    for (const later of laterOutcomes(index.loaded.decisions, index.loaded.session, verdict)) {
      if (seen.has(later.id)) continue;
      seen.add(later.id);
      const atMs = Date.parse(later.at);
      const draft: Draft = {
        id: later.id,
        at: later.at,
        atMs,
        entryKind: "approval-outcome",
        kind: "approval-outcome",
        title: `Approval ${later.outcome}`,
        ...(later.by !== undefined || later.surface !== undefined
          ? {
              detail: [
                later.by !== undefined ? `by ${later.by}` : undefined,
                later.surface !== undefined ? `in ${later.surface}` : undefined,
              ]
                .filter((part) => part !== undefined)
                .join(" "),
            }
          : {}),
        refs: [later.id, verdict.line.id],
        sensitivity: "internal",
        ...placeOf(index, verdict.line),
      };
      const at = session.findIndex((entry) => entry.atMs > atMs);
      session.splice(at === -1 ? session.length : at, 0, entryOf(draft));
    }
  }
  return session;
}

export type TimelineOptions = {
  readonly view?: "key" | "full";
  readonly limit?: number;
  /** An entry id: the page starts after it, older. */
  readonly before?: string;
};

/** A page of the run's timeline, newest first. */
export function timelineOf(
  index: RunIndex,
  options: TimelineOptions = {},
): TimelinePage | InspectRefusal {
  const view = options.view ?? "key";
  const limit = Math.min(
    TIMELINE_MAX_LIMIT,
    Math.max(1, Math.floor(options.limit ?? TIMELINE_DEFAULT_LIMIT)),
  );
  const all = [...timelineEntries(index)].reverse();
  let start = 0;
  if (options.before !== undefined) {
    const at = all.findIndex((entry) => entry.id === options.before);
    if (at === -1) {
      return refusal(
        "invalid",
        `no entry ${options.before.slice(0, 40)} in this run's timeline`,
        "crewhaus runs inspect <run> --timeline full",
      );
    }
    start = at + 1;
  }
  const rest = all.slice(start);
  const shown = view === "key" ? rest.filter((entry) => entry.importance === "key") : rest;
  const page = shown.slice(0, limit).map(({ atMs: _atMs, ...entry }) => entry);
  const last = page.at(-1);
  return {
    entries: page,
    gaps: index.gaps,
    ...(shown.length > limit && last !== undefined ? { next: last.id } : {}),
    snapshotAt: `s:${index.loaded.readTo}`,
    truncated: index.gaps.some((gap) => gap.reason === "truncated"),
    ...(page.length === 0 ? { empty: rest.length > 0 ? "filtered" : "no-data" } : {}),
    view,
  };
}

/** A page of a loaded run's timeline. */
export function foldTimeline(
  loaded: LoadedRun,
  options: TimelineOptions = {},
): TimelinePage | InspectRefusal {
  return timelineOf(indexRun(loaded), options);
}
