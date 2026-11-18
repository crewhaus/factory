/**
 * The body of an inbox list, as Home's `attention.list` answers it and `crewhaus inbox
 * list --json` prints it: the items after the filter and the page limit, the harnesses
 * that could not be read (named whether or not anything is listed), the ones the Advisor
 * has not checked yet, every mentioned harness's name, why a list is empty and what fills
 * it, and when it was cut short with the command that reads the rest. Pure.
 */
import type { AttentionItem, AttentionList, EmptyReason } from "@crewhaus/control-contract";
import type { Inbox } from "./fold";

/** What an unreadable harness's empty list says. No command moves a sessions folder. */
export const UNREACHABLE_REMEDY =
  "A harness keeps its sessions folder outside its own folder, so Home shows no decisions from it. Keep the sessions folder inside the harness folder.";

/** The command that reads a list past its page. */
export const LIST_VERB = "crewhaus inbox list --json";

const OPEN_STATES: ReadonlySet<string> = new Set(["open", "assigned", "deferred"]);

export type ListBodyOptions = {
  /** At most this many items, 1 to 500. */
  readonly limit: number;
  /** A kind, a band or a harness narrowed the list. */
  readonly filtered: boolean;
  /** How many harnesses the reader may see at all. */
  readonly visible: number;
  /** The display name of a harness the list may mention. */
  readonly nameOf: (id: string) => string | undefined;
  readonly snapshotAt: string;
};

/** Why an empty list is empty, and what would fill it. Pure. */
export function emptyReasonOf(
  inbox: Pick<Inbox, "all" | "unreachable">,
  opts: Pick<ListBodyOptions, "filtered" | "visible">,
): { readonly reason: EmptyReason; readonly remedy: string } {
  if (opts.visible === 0) {
    return {
      reason: "no-access",
      remedy: "You cannot see any harness here yet. Ask the owner to share one with you.",
    };
  }
  const nothingOpen = !inbox.all.some((item) => OPEN_STATES.has(item.state));
  if (inbox.unreachable.length > 0 && nothingOpen) {
    return { reason: "unreachable", remedy: UNREACHABLE_REMEDY };
  }
  if (opts.filtered) {
    return { reason: "filtered", remedy: "Nothing matches these filters. Clear them to see all." };
  }
  if (inbox.unreachable.length > 0) return { reason: "unreachable", remedy: UNREACHABLE_REMEDY };
  return { reason: "no-data", remedy: "Nothing needs you right now." };
}

/** The harnesses an answer mentions, each with its name. Pure. */
export function namesIn(
  items: readonly AttentionItem[],
  lists: ReadonlyArray<readonly string[]>,
  nameOf: (id: string) => string | undefined,
): Array<{ id: string; name: string }> {
  const named = new Set<string>(lists.flat());
  for (const item of items) {
    if (item.harness !== undefined) named.add(item.harness);
    for (const id of item.harnesses ?? []) named.add(id);
  }
  return [...named].sort().flatMap((id) => {
    const name = nameOf(id);
    return name === undefined ? [] : [{ id, name }];
  });
}

/** One page of an assembled inbox, as the list answers it. Pure. */
export function attentionListBody(inbox: Inbox, opts: ListBodyOptions): AttentionList {
  const items = inbox.items.slice(0, opts.limit);
  const cut = inbox.items.length > opts.limit;
  return {
    items,
    snapshotAt: opts.snapshotAt,
    ...(cut || inbox.truncated.length > 0
      ? { truncated: { reason: cut ? "page_limit" : "harness_capped", verb: LIST_VERB } }
      : {}),
    ...(inbox.unreachable.length > 0 ? { unreachable: inbox.unreachable } : {}),
    ...(inbox.advisorUnchecked.length > 0 ? { advisorUnchecked: inbox.advisorUnchecked } : {}),
    names: namesIn(items, [inbox.unreachable, inbox.advisorUnchecked], opts.nameOf),
    ...(items.length === 0 ? { empty: emptyReasonOf(inbox, opts) } : {}),
  };
}
