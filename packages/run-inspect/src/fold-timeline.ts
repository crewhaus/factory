/**
 * The run's timeline: one entry per thing that happened, newest first, each under its
 * span, key events or everything recorded. A tool call and its result are one entry;
 * each check sits on the call it judged; an approval's later outcome from the decision
 * log is an entry of its own. Titles are fixed templates; content is only ever in
 * `detail`, and it is whole: a reader masks it first and only then cuts it short, so a
 * cut never leaves part of a secret the masker would have matched whole.
 */
import { executionEntries } from "./exec";
import type { SessionLine } from "./lines";
import type { LoadedRun } from "./load";
import {
  type InspectGap,
  type InspectRefusal,
  STATUS_WORDS,
  type TimelineEntry,
  type TimelinePage,
  flatText,
  ownValue,
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
  wakeMarkerId,
  wakeOf,
} from "./records";
import { type EntryKind, groupOf, importanceOf, lineKindOf } from "./taxonomy";

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
        const state = ownValue(SPAN_STATUS_STATE, info.status);
        return {
          ...base,
          entryKind: "run-end",
          kind: "run-end",
          title: `Run ended: ${ownValue(STATUS_WORDS, state) ?? "status unknown"}`,
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
        // A wake marker is this run's only when it is the one its wake was read from; a
        // session written before run records shows every marker it holds.
        if (index.loaded.mode !== "legacy" && line.id !== wakeMarkerId(index)) return undefined;
        const rawReason = str(control["reason"]);
        const rawBy = str(control["by"]);
        const reason = rawReason !== undefined ? flatText(rawReason) : undefined;
        const by = rawBy !== undefined ? flatText(rawBy) : undefined;
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
      const tool = index.toolByUse.get(line);
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
        title: `${ownValue(GATE_WORDS, gate) ?? "Check"}: ${outcome}`,
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
      const kind = lineKindOf(line.kind);
      if (kind === "merged") return undefined;
      if (kind === "unknown") {
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

type Placed = TimelineEntry & { atMs: number };

/**
 * `inserts` placed into `list` in one pass: each goes before the first element whose key
 * is greater than its own (after every element when none is, or when its key is not a
 * number), inserts with equal keys in their given order. As inserting them one at a time
 * would place them, in time linear in both lists plus one sort of the inserts.
 */
function placeAll<T>(
  list: readonly T[],
  inserts: readonly T[],
  keyOf: (item: T) => number,
  insertKeyOf: (item: T) => number = keyOf,
): T[] {
  if (inserts.length === 0) return [...list];
  // The greatest key so far: the first element greater than k is the first place it passes k.
  const upTo: number[] = [];
  let most = Number.NEGATIVE_INFINITY;
  for (const item of list) {
    const key = keyOf(item);
    if (key > most) most = key;
    upTo.push(most);
  }
  const keyed = inserts.map((item, i) => ({ item, i, key: insertKeyOf(item) }));
  const timed = keyed
    .filter((k) => !Number.isNaN(k.key))
    .sort((a, b) => a.key - b.key || a.i - b.i);
  const out: T[] = [];
  let at = 0;
  for (const { item, key } of timed) {
    while (at < list.length && !((upTo[at] as number) > key)) out.push(list[at++] as T);
    out.push(item);
  }
  while (at < list.length) out.push(list[at++] as T);
  for (const k of keyed) if (Number.isNaN(k.key)) out.push(k.item);
  return out;
}

/** The session-log offset an entry stands for, or none. */
function sessionOffsetOf(entry: Placed): number {
  return entry.id.startsWith("s:") ? Number(entry.id.slice(2)) : Number.NEGATIVE_INFINITY;
}

/** The last line before byte `off`, in lines ordered by offset. */
function lineBefore(lines: readonly SessionLine[], off: number): SessionLine | undefined {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((lines[mid] as SessionLine).off < off) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? lines[lo - 1] : undefined;
}

/** Every entry of the run, oldest first. */
export function timelineEntries(index: RunIndex): ReadonlyArray<TimelineEntry & { atMs: number }> {
  let session: Placed[] = [];
  // An operator's wake: its marker is unscoped and precedes the run, and is the one
  // unscoped line attributed to it.
  const markerId = wakeMarkerId(index);
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
  const gapEntries: Placed[] = [];
  const gapOffsets = new Map<Placed, number>();
  for (const gap of index.loaded.gaps) {
    if (gap.from === undefined || !gap.from.startsWith("s:")) continue;
    const off = Number(gap.from.slice(2));
    const before = lineBefore(index.loaded.lines, off);
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
    const entry = entryOf(draft);
    gapEntries.push(entry);
    gapOffsets.set(entry, off);
  }
  session = placeAll(session, gapEntries, sessionOffsetOf, (entry) => gapOffsets.get(entry) ?? 0);
  // The execution's events the session log has no line for, at their place in time.
  const have = new Set(index.lines.map((line) => line.kind));
  const atMsOf = (entry: Placed) => entry.atMs;
  session = placeAll(
    session,
    executionEntries(index.loaded.executionEvents, have, index.rootSpan),
    atMsOf,
  );
  // An approval's later outcomes, at their place in time.
  const outcomes: Placed[] = [];
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
      outcomes.push(entryOf(draft));
    }
  }
  return placeAll(session, outcomes, atMsOf);
}

export type TimelineOptions = {
  readonly view?: "key" | "full";
  readonly limit?: number;
  /** An entry id: the page starts after it, older. */
  readonly before?: string;
  /** An entry id: only the entries newer than it, newest first. Never with `before`. */
  readonly after?: string;
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
  if (options.before !== undefined && options.after !== undefined) {
    return refusal("invalid", "page the timeline before an entry or after one, not both");
  }
  const all = [...timelineEntries(index)].reverse();
  const anchor = options.before ?? options.after;
  let rest = all;
  if (anchor !== undefined) {
    const at = all.findIndex((entry) => entry.id === anchor);
    if (at === -1) {
      return refusal(
        "invalid",
        `no entry ${flatText(anchor).slice(0, 40)} in this run's timeline`,
        "crewhaus runs inspect <run> --timeline full",
      );
    }
    rest = options.before !== undefined ? all.slice(at + 1) : all.slice(0, at);
  }
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

/**
 * Every entry of a loaded run's timeline, newest first, built once: what an export holds.
 * A reader that pages the whole timeline uses this instead of a fold per page.
 */
export function timelineAll(
  loaded: LoadedRun,
  view: "key" | "full" = "full",
): {
  readonly entries: readonly TimelineEntry[];
  readonly gaps: readonly InspectGap[];
  readonly truncated: boolean;
} {
  const index = indexRun(loaded);
  const all = [...timelineEntries(index)].reverse();
  const shown = view === "key" ? all.filter((entry) => entry.importance === "key") : all;
  return {
    entries: shown.map(({ atMs: _atMs, ...entry }) => entry),
    gaps: index.gaps,
    truncated: index.gaps.some((gap) => gap.reason === "truncated"),
  };
}
