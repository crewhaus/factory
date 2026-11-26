/**
 * What people did about items, read from the harness's actions ledger
 * (`.crewhaus/run/control/attention/`): assigned, put off, set aside, taken up again,
 * hidden from one member, decided. Lines fold in order into one overlay per item, through
 * the `attention` machine; a line the machine does not allow is kept on disk, counted, and
 * leaves the item open.
 *
 * An overlay never decides a decision: an item that waits on a request, a review, a pause
 * or a quorum is settled by that record alone, so the overlay can assign it or put it off,
 * and never close it. A request's deferral is on its own record, so no line hides one. A dismissal or an acknowledgement closes a problem for the evidence
 * it was made on; newer evidence opens it again. Pure.
 */
import {
  ATTENTION_ACTION_EVENTS,
  ATTENTION_ID_RE,
  ATTENTION_RESOLUTIONS,
  ATTENTION_STATES,
  type AttentionItem,
  type AttentionState,
  DEFER_REASONS,
  RECEIPT_VIA,
  canTransition,
  isId,
  isStoredActor,
} from "@crewhaus/control-contract";
import { msOf, timeOf } from "./items";
import { effectiveAttentionState } from "./lifecycle";
import {
  type AttentionModel,
  type Drafted,
  type HarnessAttention,
  type ItemOverlay,
  OVERLAYS_KEPT,
} from "./types";

/** How far ahead an item may be put off or hidden. */
export const DEFER_MAX_MS = 90 * 86_400_000;

/** At most this many members' snoozes are kept for one item. */
const SNOOZES_KEPT = 200;

const EVIDENCE_REV_RE = /^[0-9a-f]{16}$/;

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

/** A time a line may hide an item until: one, and not further than the cap from the line's own. */
function untilOf(value: unknown, at: string): string | undefined {
  const until = timeOf(value);
  if (until === undefined) return undefined;
  const ahead = (msOf(until) as number) - (msOf(at) as number);
  return ahead > 0 && ahead <= DEFER_MAX_MS ? until : undefined;
}

/** An actions line as the fold reads it, or `undefined` for one that is not one. */
function lineOf(record: Readonly<Record<string, unknown>>) {
  const id = record["id"];
  const event = oneOf(ATTENTION_ACTION_EVENTS, record["event"]);
  const state = oneOf(ATTENTION_STATES, record["state"]);
  const at = timeOf(record["at"]);
  const rev = record["evidenceRev"];
  if (
    typeof id !== "string" ||
    !ATTENTION_ID_RE.test(id) ||
    event === undefined ||
    state === undefined ||
    at === undefined ||
    typeof rev !== "string" ||
    !EVIDENCE_REV_RE.test(rev)
  ) {
    return undefined;
  }
  const via = oneOf(RECEIPT_VIA, record["via"]);
  const how = oneOf(ATTENTION_RESOLUTIONS, record["how"]);
  const until = untilOf(record["until"], at);
  const deferReason = oneOf(DEFER_REASONS, record["reasonCode"]);
  const to = isId("prn", record["to"]) ? (record["to"] as string) : undefined;
  const member = isStoredActor(record["member"]) ? (record["member"] as string) : undefined;
  return { id, event, state, at, rev, via, how, until, deferReason, to, member };
}

/**
 * The overlay with the fields a state change leaves behind dropped. A line that settles the
 * item ends its round: who had it and who hid it from themselves stay with that round, so a
 * later ask that reuses the item's id starts with neither.
 */
function moved(
  before: ItemOverlay | undefined,
  next: { readonly state: AttentionState; readonly evidenceRev: string; readonly at: string },
  extra: Partial<ItemOverlay> = {},
): ItemOverlay {
  const carried = next.state !== "resolved";
  return {
    ...next,
    ...(carried && before?.assignee !== undefined ? { assignee: before.assignee } : {}),
    ...(carried && before?.snoozes !== undefined ? { snoozes: before.snoozes } : {}),
    ...(before?.anomalies !== undefined ? { anomalies: before.anomalies } : {}),
    ...extra,
  };
}

/** One overlay after one line. */
function applied(
  before: ItemOverlay | undefined,
  line: NonNullable<ReturnType<typeof lineOf>>,
): ItemOverlay | undefined {
  const { event, state, at, rev, via } = line;
  const seen = via !== undefined ? { via } : {};
  if (event === "message") return before;
  if (event === "snoozed") {
    if (line.member === undefined || line.until === undefined) return before;
    const snoozes = { ...before?.snoozes };
    const names = Object.keys(snoozes);
    if (!Object.hasOwn(snoozes, line.member) && names.length >= SNOOZES_KEPT) {
      Reflect.deleteProperty(snoozes, names[0] as string);
    }
    snoozes[line.member] = line.until;
    return { ...(before ?? { state: "open", evidenceRev: rev, at }), snoozes };
  }
  const next = { state, evidenceRev: rev, at };
  // Taken up again: the item starts over, whatever was recorded before.
  if (event === "reopened") return moved(before, { ...next, state: "open" }, seen);
  // Evidence newer than what closed it opened it again before this line.
  const from: AttentionState =
    before === undefined || (before.state === "resolved" && before.evidenceRev !== rev)
      ? "open"
      : before.state;
  if (from !== state && !canTransition("attention", from, state)) {
    return moved(
      before,
      { state: "open", evidenceRev: rev, at },
      { anomalies: (before?.anomalies ?? 0) + 1 },
    );
  }
  switch (event) {
    case "assigned":
      return line.to === undefined ? before : moved(before, next, { ...seen, assignee: line.to });
    case "unassigned": {
      const { assignee: _was, ...rest } = moved(before, next, seen);
      return rest;
    }
    case "undeferred":
      return moved(before, next, seen);
    default:
      // Put off, by its own verb or by a verdict that waits: until when is the line's.
      if (state === "deferred") {
        return line.until === undefined
          ? before
          : moved(before, next, {
              ...seen,
              deferredUntil: line.until,
              ...(line.deferReason !== undefined ? { deferReason: line.deferReason } : {}),
            });
      }
      return moved(before, next, { ...seen, ...(line.how !== undefined ? { how: line.how } : {}) });
  }
}

/** Fold one actions line into the model, in place. */
export function foldActionLine(
  state: AttentionModel,
  record: Readonly<Record<string, unknown>>,
): AttentionModel {
  const line = lineOf(record);
  if (line === undefined) return state;
  const before = state.overlays[line.id];
  const after = applied(before, line);
  if (after === undefined || after === before) return state;
  if (before === undefined) {
    const ids = Object.keys(state.overlays);
    if (ids.length >= OVERLAYS_KEPT) {
      Reflect.deleteProperty(state.overlays, ids[0] as string);
    }
  }
  state.overlays[line.id] = after;
  return state;
}

/** Whether an item waits on a record of its own, which alone settles it. */
export function decidesItself(item: Pick<AttentionItem, "band">): boolean {
  return item.band === "decide";
}

/** An item's id, from its ref. */
export function idOfItem(item: Pick<AttentionItem, "ref">): string {
  return item.ref.slice(item.ref.lastIndexOf("/") + 1);
}

/**
 * Whether an overlay is about the item as it stands. An item that waits on a record of its
 * own starts a new round with each ask that reuses its id: an overlay whose newest line is
 * older than the item's oldest evidence was made on an earlier round, decided wherever it was
 * decided, and says nothing about this one.
 */
export function currentFor(
  item: Pick<AttentionItem, "band" | "since">,
  overlay: ItemOverlay | undefined,
): overlay is ItemOverlay {
  if (overlay === undefined) return false;
  if (!decidesItself(item)) return true;
  const since = msOf(item.since);
  const at = msOf(overlay.at);
  return since === undefined || at === undefined || at >= since;
}

/** An item with what people did about it. Pure. */
export function overlaid(
  drafted: Drafted,
  overlay: ItemOverlay | undefined,
  now: number,
  viewer: string | undefined,
): Drafted {
  const { item } = drafted;
  if (!currentFor(item, overlay)) return drafted;
  const effective = effectiveAttentionState(
    {
      source: "item",
      state: item.state,
      decides: decidesItself(item),
      ownDeferral: item.source.kind === "approval",
      evidenceRev: item.evidenceRev,
      overlays: [overlay],
      ...(item.resolution !== undefined ? { resolution: item.resolution } : {}),
    },
    now,
  );
  const snoozed = viewer === undefined ? [] : [overlay.snoozes?.[viewer]];
  return {
    ...drafted,
    item: withOverlay(item, effective.state, effective.resolution, [overlay], now, snoozed),
  };
}

/**
 * A group with what people did about it in each of its harnesses: it is put off, set aside
 * or hidden only when every one of them says so, and assigned when any does. Pure.
 */
export function overlaidGroup(
  drafted: Drafted,
  perHarness: readonly HarnessAttention[],
  now: number,
): Drafted {
  const { item } = drafted;
  const members = new Set(item.harnesses ?? (item.harness !== undefined ? [item.harness] : []));
  const id = idOfItem(item);
  const reads = perHarness.filter((h) => members.has(h.harness));
  const overlays = reads.flatMap((h) => {
    const overlay = h.overlays[id];
    return currentFor(item, overlay) ? [overlay] : [];
  });
  if (overlays.length === 0) return drafted;
  const everywhere = overlays.length === reads.length;
  const effective = effectiveAttentionState(
    {
      source: "item",
      state: item.state,
      decides: decidesItself(item),
      ownDeferral: item.source.kind === "approval",
      evidenceRev: item.evidenceRev,
      overlays: everywhere ? overlays : overlays.filter((o) => o.state === "assigned"),
      ...(item.resolution !== undefined ? { resolution: item.resolution } : {}),
    },
    now,
  );
  // Each harness knows its reader by its own name for them.
  const snoozed = everywhere
    ? reads.map((h) => (h.viewer === undefined ? undefined : h.overlays[id]?.snoozes?.[h.viewer]))
    : [];
  return {
    ...drafted,
    item: withOverlay(item, effective.state, effective.resolution, overlays, now, snoozed),
  };
}

const OPEN_STATES: ReadonlySet<string> = new Set(["open", "assigned", "deferred"]);

function withOverlay(
  item: AttentionItem,
  state: AttentionState,
  resolution: AttentionItem["resolution"],
  overlays: readonly ItemOverlay[],
  now: number,
  /** Until when the reader hid it from themselves, in each place it is about. */
  snoozes: ReadonlyArray<string | undefined>,
): AttentionItem {
  const open = OPEN_STATES.has(state);
  const assignee = overlays.find((o) => o.assignee !== undefined)?.assignee;
  const deferred = overlays.filter((o) => o.state === "deferred" && o.deferredUntil !== undefined);
  // Several harnesses put a group off until the earliest of their times.
  const until = deferred
    .map((o) => o.deferredUntil as string)
    .sort((a, b) => (msOf(a) ?? 0) - (msOf(b) ?? 0))[0];
  const reason = deferred[0]?.deferReason;
  const hidden = snoozes.filter(
    (until): until is string => until !== undefined && (msOf(until) ?? 0) > now,
  );
  const snoozed =
    hidden.length > 0 && hidden.length === snoozes.length
      ? hidden.sort((a, b) => (msOf(a) ?? 0) - (msOf(b) ?? 0))[0]
      : undefined;
  const closed = overlays.find((o) => o.state === "resolved" && o.how !== undefined);
  const reopened =
    open && !decidesItself(item) && closed !== undefined && closed.evidenceRev !== item.evidenceRev
      ? {
          previous: item.previous ?? item.ref,
          previously: {
            how: closed.how as NonNullable<ItemOverlay["how"]>,
            at: closed.at,
            evidenceRev: closed.evidenceRev,
          },
        }
      : {};
  const anomalies = overlays.reduce((n, o) => n + (o.anomalies ?? 0), 0);
  const { resolution: _was, ...rest } = item;
  return {
    ...rest,
    state,
    // A closed item offers nothing to do; it can be taken up again.
    choices: open ? item.choices : [],
    ...(resolution !== undefined ? { resolution } : {}),
    ...(open && assignee !== undefined ? { assignee } : {}),
    ...(state === "deferred" && until !== undefined && item.deferral === undefined
      ? {
          deferral: {
            until,
            deadlineMoved: false,
            ...(reason !== undefined ? { reasonCode: reason } : {}),
          },
        }
      : {}),
    ...(open && snoozed !== undefined ? { snoozedUntil: snoozed } : {}),
    ...reopened,
    ...(anomalies > 0 ? { anomalies } : {}),
  };
}

/** Whether an open item is out of the way for now: put off with no deadline moved, or snoozed. */
export function hiddenNow(
  item: Pick<AttentionItem, "state" | "deferral" | "snoozedUntil">,
): boolean {
  return (
    item.snoozedUntil !== undefined ||
    (item.state === "deferred" && item.deferral !== undefined && !item.deferral.deadlineMoved)
  );
}
