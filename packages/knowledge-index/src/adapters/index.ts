/** Every store adapter, in the order a list shows them, and one fold over all of them. */
import { type KnowledgeIdParts, parseKnowledgeId } from "@crewhaus/control-contract/knowledge";
import type { CoverageNote, HarnessRead } from "../context";
import type { FoldedItem } from "../model";
import { factsAdapter } from "./facts";
import {
  datasetsAdapter,
  documentsAdapter,
  lessonsAdapter,
  sessionsAdapter,
  suggestionsAdapter,
  thredzAdapter,
} from "./sources";
import type { KnowledgeAdapter, KnowledgeHistoryEntry, StoreRoot } from "./types";
import { wikiAdapter } from "./wiki";
import { workingAdapter } from "./working";

/** The facts of one spec and root that are personal: their promotion findings are left out. */
async function personalFacts(
  read: HarnessRead,
  root: StoreRoot,
  spec: string,
): Promise<ReadonlySet<string>> {
  const facts = await factsAdapter.list(read);
  const partition = root.partition ?? "-";
  return new Set(
    facts
      .filter(
        ({ item }) =>
          item.ref.spec === spec &&
          (item.ref.partition ?? "-") === partition &&
          item.category === "person",
      )
      .map(({ item }) => item.ref.localId),
  );
}

export const ADAPTERS: readonly KnowledgeAdapter[] = [
  factsAdapter,
  wikiAdapter,
  workingAdapter,
  sessionsAdapter,
  lessonsAdapter,
  suggestionsAdapter(personalFacts),
  documentsAdapter,
  datasetsAdapter,
  thredzAdapter,
];

/** The adapter an item's store is read by. */
export function adapterOf(id: KnowledgeIdParts): KnowledgeAdapter | undefined {
  const thredz = id.partition !== undefined && /^[cr](?:\.|$)/.test(id.partition);
  if (thredz) return thredzAdapter;
  return ADAPTERS.find((adapter) => adapter.stores.includes(id.store));
}

export type HarnessFold = {
  readonly items: readonly FoldedItem[];
  readonly notes: readonly CoverageNote[];
};

/** Everything one harness knows, sorted by id. Reads only. */
export async function foldItems(read: HarnessRead): Promise<HarnessFold> {
  const items: FoldedItem[] = [];
  // One item at a time: a store can hold more items than a call takes arguments.
  for (const adapter of ADAPTERS) {
    for (const item of await adapter.list(read)) items.push(item);
  }
  items.sort((a, b) => (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  return { items, notes: read.notes() };
}

/** The marks of every store, by adapter: what a shard was built from. */
export function sourceMarks(read: HarnessRead): Record<string, Readonly<Record<string, string>>> {
  const out: Record<string, Readonly<Record<string, string>>> = {};
  for (const adapter of ADAPTERS) {
    const marks = adapter.marks(read);
    out[adapter.name] = Object.fromEntries(
      Object.keys(marks)
        .sort()
        .map((rel) => [rel, marks[rel] as string]),
    );
  }
  return out;
}

/** The adapters whose stores are not what they were. */
export function changedAdapters(
  before: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>,
  read: HarnessRead,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [name, marks] of Object.entries(sourceMarks(read))) {
    if (JSON.stringify(before[name] ?? {}) !== JSON.stringify(marks)) out.add(name);
  }
  return out;
}

/** One item as it is now, from its own store. */
export async function currentItems(
  read: HarnessRead,
  ids: readonly string[],
): Promise<Map<string, FoldedItem>> {
  const byAdapter = new Map<KnowledgeAdapter, KnowledgeIdParts[]>();
  for (const id of ids) {
    const parts = parseKnowledgeId(id);
    const adapter = parts === undefined ? undefined : adapterOf(parts);
    if (parts === undefined || adapter === undefined) continue;
    byAdapter.set(adapter, [...(byAdapter.get(adapter) ?? []), parts]);
  }
  const out = new Map<string, FoldedItem>();
  for (const [adapter, parts] of byAdapter) {
    for (const item of await adapter.current(read, parts)) out.set(item.item.id, item);
  }
  return out;
}

/** What an item was before, oldest first; empty for a store that keeps no history. */
export async function itemHistory(
  read: HarnessRead,
  id: string,
): Promise<readonly KnowledgeHistoryEntry[]> {
  const parts = parseKnowledgeId(id);
  const adapter = parts === undefined ? undefined : adapterOf(parts);
  if (parts === undefined || adapter?.history === undefined) return [];
  return adapter.history(read, parts);
}

export type { KnowledgeAdapter, KnowledgeHistoryEntry };
