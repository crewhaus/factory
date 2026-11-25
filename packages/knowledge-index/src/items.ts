/**
 * Reading what one harness knows: a page of items, one item, its history, and what became of
 * the items a run used. An index that was built is read; a harness without one is folded in
 * memory. Nothing here writes, and nothing here builds an index.
 */
import type { ListTruncated } from "@crewhaus/control-contract";
import {
  type KnowledgeItem,
  type KnowledgeLifecycle,
  type KnowledgeStore,
  RECORD_STORE_OF,
  formatKnowledgeId,
  knowledgeStoreOf,
} from "@crewhaus/control-contract/knowledge";
import { type KnowledgeHistoryEntry, currentItems, itemHistory } from "./adapters";
import { type CoverageNote, HarnessRead, type HarnessReadOptions } from "./context";
import type { FoldedItem, RecordRef } from "./model";
import { type ItemRow, REINDEX_VERB, SHARD_ITEM_CAP, Shard, itemRow, shardContent } from "./shard";

export type ItemFilter = {
  /** Stores to list; every store when absent. */
  readonly stores?: readonly KnowledgeStore[];
  readonly lifecycles?: readonly KnowledgeLifecycle[];
  /** The store's own word, or a lifecycle. */
  readonly status?: string;
  readonly scope?: KnowledgeItem["scope"]["kind"];
  readonly backend?: "local" | "thredz";
  readonly tag?: string;
};

export type ItemsRead = {
  readonly items: readonly KnowledgeItem[];
  readonly total: number;
  /** Where the next page starts, when there is one. */
  readonly next?: number;
  /** Counted over every item the filter keeps. */
  readonly stores: Readonly<Partial<Record<KnowledgeStore, number>>>;
  readonly freshness: { readonly asOf: string; readonly from: "index" | "direct-fold" };
  readonly truncated?: ListTruncated;
  readonly notes: readonly CoverageNote[];
  readonly usageRecorded: boolean;
  readonly thredz: "live" | "cached" | "off";
};

export type ReadItemsOptions = HarnessReadOptions & {
  /** Home's root; without one the harness is folded in memory. */
  readonly hangarRoot?: string;
  readonly canReadContent: boolean;
  readonly filter?: ItemFilter;
  /** Where the page starts. */
  readonly offset?: number;
  readonly limit?: number;
  /** Test seam: how many items an index lists. */
  readonly cap?: number;
};

export const ITEMS_LIMIT_DEFAULT = 50;

/** A past `expiresAt` says expired, whatever the files said when they were folded. */
function lifecycleAt(
  item: Pick<KnowledgeItem, "lifecycle" | "expiresAt">,
  now: Date,
): KnowledgeLifecycle {
  const expired = item.expiresAt !== undefined && Date.parse(item.expiresAt) <= now.getTime();
  return expired && item.lifecycle === "live" ? "expired" : item.lifecycle;
}

function matches(row: ItemRow, filter: ItemFilter, now: Date): boolean {
  const { item } = row;
  const lifecycle = lifecycleAt(item, now);
  if (filter.stores !== undefined && !filter.stores.includes(item.ref.store)) return false;
  if (filter.lifecycles !== undefined && !filter.lifecycles.includes(lifecycle)) return false;
  if (filter.status !== undefined) {
    if (filter.status !== lifecycle && filter.status !== item.status) return false;
  }
  if (filter.scope !== undefined && item.scope.kind !== filter.scope) return false;
  if (filter.backend !== undefined && item.ref.backend !== filter.backend) return false;
  if (filter.tag !== undefined && !item.tags.includes(filter.tag)) return false;
  return true;
}

/** The stores a run records the use of. */
const RECORDED_STORES: ReadonlySet<KnowledgeStore> = new Set(
  Object.keys(RECORD_STORE_OF) as KnowledgeStore[],
);

/** A row as one reader sees it: without content permission, no text of any kind. */
function shown(
  row: ItemRow,
  at: {
    readonly asOf: string;
    readonly stale: boolean;
    readonly now: Date;
    readonly canReadContent: boolean;
    readonly usageRecorded: boolean;
  },
): KnowledgeItem {
  const { preview, ...rest } = row.item;
  return {
    ...rest,
    ...(at.canReadContent && preview !== undefined ? { preview } : {}),
    lifecycle: lifecycleAt(row.item, at.now),
    usage: {
      runs: row.use?.runs ?? 0,
      ...(row.use?.lastUsedAt !== undefined ? { lastUsedAt: row.use.lastUsedAt } : {}),
      recorded:
        at.usageRecorded &&
        row.item.scope.kind !== "tenant" &&
        row.item.lifecycle !== "deleted-restorable" &&
        // A row of personal data holds no use of it, so it never says there was none.
        row.item.category !== "person" &&
        RECORDED_STORES.has(row.item.ref.store),
    },
    freshness: { asOf: at.asOf, stale: at.stale },
  };
}

/**
 * A page of one harness's items. From its index: two files are opened, the hits whose store
 * changed since are marked stale and read again (only those). Without an index the harness is
 * folded in memory. A reader who may not read content gets no item whose title is its text.
 */
export async function readItems(opts: ReadItemsOptions): Promise<ItemsRead> {
  const read = new HarnessRead(opts);
  const now = read.now();
  const filter = opts.filter ?? {};
  const limit = opts.limit ?? ITEMS_LIMIT_DEFAULT;
  const offset = opts.offset ?? 0;
  const shard = opts.hangarRoot !== undefined ? Shard.open(opts.hangarRoot, opts.hrn) : undefined;
  const stored = shard?.items();
  let rows: readonly ItemRow[];
  let usageRecorded: boolean;
  let truncated: boolean;
  let notes: readonly CoverageNote[];
  let asOf: string;
  let thredz: ItemsRead["thredz"];
  if (shard !== undefined && stored !== undefined) {
    rows = stored;
    truncated = shard.meta.truncated;
    notes = shard.meta.notes;
    asOf = shard.meta.asOf;
    thredz = shard.meta.thredz;
    usageRecorded = shard.meta.usageRecorded;
  } else {
    const content = await shardContent(opts, opts.cap);
    rows = content.rows;
    usageRecorded = content.usage.recorded;
    truncated = content.truncated;
    notes = content.notes;
    asOf = now.toISOString();
    thredz = content.thredz;
  }
  const kept = rows.filter(
    (row) => (opts.canReadContent || !row.contentOnly) && matches(row, filter, now),
  );
  const stores: Partial<Record<KnowledgeStore, number>> = {};
  for (const { item } of kept) stores[item.ref.store] = (stores[item.ref.store] ?? 0) + 1;
  const page = kept.slice(offset, offset + limit);
  const items = await withCurrent(page, shard, read, (row, stale) =>
    shown(row, { asOf, stale, now, canReadContent: opts.canReadContent, usageRecorded }),
  );
  return {
    items,
    total: kept.length,
    ...(offset + limit < kept.length ? { next: offset + limit } : {}),
    stores,
    freshness: {
      asOf,
      from: shard !== undefined && stored !== undefined ? "index" : "direct-fold",
    },
    ...(truncated ? { truncated: truncatedNote(opts.cap) } : {}),
    notes,
    usageRecorded,
    thredz,
  };
}

export function truncatedNote(cap: number = SHARD_ITEM_CAP): ListTruncated {
  return {
    reason: `This harness knows more than ${cap.toLocaleString("en-US")} things, and ${REINDEX_VERB} cannot list them all.`,
    verb: REINDEX_VERB,
  };
}

/** A page with each row of a changed store read again from its store. */
async function withCurrent(
  page: readonly ItemRow[],
  shard: Shard | undefined,
  read: HarnessRead,
  show: (row: ItemRow, stale: boolean) => KnowledgeItem,
): Promise<KnowledgeItem[]> {
  const changed = shard?.changed(read) ?? new Set<string>();
  const stale = page.filter((row) => changed.has(row.adapter));
  if (stale.length === 0) return page.map((row) => show(row, false));
  const current = await currentItems(
    read,
    stale.map((row) => row.item.id),
  );
  return page.map((row) => {
    if (!changed.has(row.adapter)) return show(row, false);
    const now = current.get(row.item.id);
    if (now === undefined)
      return show({ ...row, item: { ...row.item, lifecycle: "cleared" } }, true);
    const fresh = itemRow(now);
    // Marked personal since the index was built: the row it has now, which holds no text.
    if (fresh.item.category === "person") return show(fresh, true);
    const { lifecycle, status, version } = fresh.item;
    return show(
      {
        ...row,
        item: {
          ...row.item,
          lifecycle,
          ...(status !== undefined ? { status } : {}),
          ...(version !== undefined ? { version } : {}),
        },
      },
      true,
    );
  });
}

/** One item read from its own store, with what it says; `undefined` when it is not there. */
export async function readItem(
  opts: HarnessReadOptions,
  id: string,
): Promise<(FoldedItem & { readonly freshness: KnowledgeItem["freshness"] }) | undefined> {
  const read = new HarnessRead(opts);
  const folded = (await currentItems(read, [id])).get(id);
  if (folded === undefined) return undefined;
  const now = read.now();
  return {
    ...folded,
    item: { ...folded.item, lifecycle: lifecycleAt(folded.item, now) },
    freshness: { asOf: now.toISOString(), stale: false },
  };
}

/** What an item was before, oldest first. */
export async function readHistory(
  opts: HarnessReadOptions,
  id: string,
): Promise<readonly KnowledgeHistoryEntry[]> {
  return itemHistory(new HarnessRead(opts), id);
}

/** An item a run used, as it is now. */
export type LookedUp = {
  readonly ref: RecordRef;
  readonly id?: string;
  /** `unknown` when nothing here is that item any more, or its store keeps no such record. */
  readonly state: "found" | "unknown";
  readonly lifecycle?: KnowledgeLifecycle;
  readonly version?: number | string;
  /** The item is not what the run saw: another version, or one that is not live. */
  readonly changedSince?: boolean;
};

/** The item id a run record's ref names. */
export function idOfRecordRef(ref: RecordRef): string | undefined {
  const store = knowledgeStoreOf(ref.store);
  if (store === undefined) return undefined;
  const bare = store === "sessions" || store === "documents" ? "-" : ref.spec;
  return formatKnowledgeId({
    store,
    spec: bare ?? "-",
    ...(ref.partition !== undefined && ref.partition !== "-" ? { partition: ref.partition } : {}),
    localId: ref.localId,
  });
}

/**
 * What became of the items a run used: their lifecycle and version now, from the harness's
 * index when one is fresh, else from the stores.
 */
export async function lookup(
  opts: HarnessReadOptions & { readonly hangarRoot?: string },
  refs: readonly RecordRef[],
): Promise<readonly LookedUp[]> {
  const read = new HarnessRead(opts);
  const now = read.now();
  const ids = refs.map(idOfRecordRef);
  const found = new Map<string, Pick<KnowledgeItem, "lifecycle" | "version">>();
  const shard = opts.hangarRoot !== undefined ? Shard.open(opts.hangarRoot, opts.hrn) : undefined;
  const rows = shard?.items();
  const changed = shard?.changed(read) ?? new Set<string>();
  const wanted = new Set(ids.filter((id): id is string => id !== undefined));
  const ask: string[] = [];
  if (rows !== undefined) {
    const byId = new Map(rows.map((row) => [row.item.id, row]));
    for (const id of wanted) {
      const row = byId.get(id);
      if (row === undefined) continue;
      if (changed.has(row.adapter)) ask.push(id);
      else found.set(id, { ...row.item, lifecycle: lifecycleAt(row.item, now) });
    }
  } else {
    for (const id of wanted) ask.push(id);
  }
  for (const [id, { item }] of await currentItems(read, ask)) {
    found.set(id, { ...item, lifecycle: lifecycleAt(item, now) });
  }
  return refs.map((ref, i) => {
    const id = ids[i];
    const item = id === undefined ? undefined : found.get(id);
    if (id === undefined || item === undefined) {
      return { ref, ...(id !== undefined ? { id } : {}), state: "unknown" };
    }
    const moved =
      ref.version !== undefined && item.version !== undefined && ref.version !== item.version;
    return {
      ref,
      id,
      state: "found",
      lifecycle: item.lifecycle,
      ...(item.version !== undefined ? { version: item.version } : {}),
      changedSince: moved || item.lifecycle !== "live",
    };
  });
}
