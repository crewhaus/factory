/** What every store adapter answers. Each reads one store and writes nothing. */
import { join } from "node:path";
import type {
  KnowledgeIdParts,
  KnowledgeItem,
  KnowledgeStore,
} from "@crewhaus/control-contract/knowledge";
import type { HarnessRead } from "../context";
import { relOf } from "../context";
import type { FoldedItem } from "../model";

/** One entry of an item's history, oldest first. */
export type KnowledgeHistoryEntry = {
  readonly at?: string;
  readonly what:
    | "created"
    | "corrected"
    | "superseded"
    | "expired"
    | "archived"
    | "version"
    | "marked";
  /** The item or version this entry is about. */
  readonly id?: string;
  readonly version?: number;
  readonly author?: KnowledgeItem["author"];
  readonly reason?: string;
  /** What it said then, for a reader who may read content. */
  readonly body?: string;
};

export type KnowledgeAdapter = {
  readonly name: string;
  readonly stores: readonly KnowledgeStore[];
  /** Every item. What cannot be listed is a note on `read`, never a throw. */
  list(read: HarnessRead): Promise<FoldedItem[]>;
  /** `path → size:mtime` of what the list was made from: a different answer means a changed store. */
  marks(read: HarnessRead): Readonly<Record<string, string>>;
  /** These items as they are now; an id it does not answer is gone. */
  current(read: HarnessRead, ids: readonly KnowledgeIdParts[]): Promise<FoldedItem[]>;
  /** What an item was before, oldest first. */
  history?(read: HarnessRead, id: KnowledgeIdParts): Promise<KnowledgeHistoryEntry[]>;
};

const TENANT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SPEC_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** Whether a directory or file stem is a spec's name. */
export function isSpecName(name: string): boolean {
  return SPEC_RE.test(name) && !/^\.+$/.test(name);
}

/** One place a store can be: the harness's own, or a customer's. */
export type StoreRoot = {
  /** Relative to the harness: `.crewhaus`, or a customer's directory. */
  readonly base: string;
  readonly partition?: string;
};

/**
 * The harness's own root, then each customer's. Customers kept outside the harness's folder
 * are noted and never read.
 */
export function storeRoots(read: HarnessRead): StoreRoot[] {
  const roots: StoreRoot[] = [{ base: ".crewhaus" }];
  const dir = read.directory(read.tenantsRoot, "customers");
  if (dir === undefined) {
    if (read.notes().some((n) => n.store === "customers" && n.code === "outside-harness")) {
      read.note(
        "customers-outside",
        "customers",
        "Customer memory is kept outside this harness's folder, so it isn't read here.",
      );
    }
    return roots;
  }
  for (const name of read.names(read.tenantsRoot, "dirs", "customers")) {
    if (TENANT_RE.test(name)) {
      roots.push({ base: relOf(read.tenantsRoot, name), partition: `t.${name}` });
    }
  }
  return roots;
}

/** Where one spec's wiki or working memory is. */
export type StorePlace = {
  readonly root: StoreRoot;
  /** The store's directory, relative to the harness. */
  readonly rel: string;
  /** The directory the store library is rooted at, and the name it gives the store there. */
  readonly rootDir: string;
  readonly name: string;
  /** The spec, as an item id names it: `-` for an older tree that has no spec directory. */
  readonly spec: string;
};

/** What marks a directory as a store of its kind. */
const PROBES = {
  wiki: ["articles", "index.json"],
  state: ["focus.md", "goals.yaml", "plans", "handoff.md", "sessions"],
} as const;

/**
 * Every place an area's stores are: one directory per spec, for the harness and for each
 * customer. An older tree keeps the one store's files right in the area's directory; it is
 * read only where no spec has a directory, because a live harness writes the other.
 */
export function storePlaces(read: HarnessRead, area: "wiki" | "state"): StorePlace[] {
  const store = area === "wiki" ? "wiki" : "plans";
  const isStore = (rel: string): boolean =>
    PROBES[area].some((name) => read.sourceMark(relOf(rel, name)) !== "-");
  const out: StorePlace[] = [];
  for (const root of storeRoots(read)) {
    const areaRel = relOf(root.base, area);
    const areaDir = read.directory(areaRel, store);
    if (areaDir === undefined) continue;
    const found = read
      .names(areaRel, "dirs", store)
      .filter((name) => isSpecName(name) && isStore(relOf(areaRel, name)))
      .map((name) => ({
        root,
        rel: relOf(areaRel, name),
        rootDir: areaDir,
        name,
        spec: name,
      }));
    if (found.length > 0) {
      out.push(...found);
      continue;
    }
    const base = read.directory(root.base, store);
    if (base !== undefined && isStore(areaRel)) {
      out.push({ root, rel: areaRel, rootDir: base, name: area, spec: "-" });
    }
  }
  return out;
}

/** Whether a conversation's log is still there, and until when. */
export function sessionEvidence(
  read: HarnessRead,
  base: string,
  session: string | undefined,
): KnowledgeItem["evidence"] {
  if (session === undefined) return { status: "not-recorded" };
  const log = join(base, "sessions", `${session}.jsonl`);
  const written = read.modifiedAt(log);
  if (written === undefined) return { status: "evicted" };
  if (read.pinnedSessions().has(session)) return { status: "available" };
  // The retention sweep judges a session by its metadata file.
  const kept = read.modifiedAt(join(base, "sessions", `${session}.json`)) ?? written;
  return {
    status: "available",
    evictsAt: new Date(kept.getTime() + read.sessionMaxAgeDays * 86_400_000).toISOString(),
  };
}

/** Pick these ids out of a whole list: for an adapter whose store is one small file. */
export async function pick(
  adapter: Pick<KnowledgeAdapter, "list">,
  read: HarnessRead,
  ids: readonly KnowledgeIdParts[],
): Promise<FoldedItem[]> {
  const wanted = new Set(
    ids.map((p) => `${p.store}\0${p.spec}\0${p.partition ?? "-"}\0${p.localId}`),
  );
  return (await adapter.list(read)).filter(({ item }) =>
    wanted.has(
      `${item.ref.store}\0${item.ref.spec}\0${item.ref.partition ?? "-"}\0${item.ref.localId}`,
    ),
  );
}

/** `{[field]: iso}` for a time, and nothing for what is not one. */
export function isoField<K extends string>(field: K, value: unknown): { [P in K]?: string } {
  const iso = isoOf(value);
  return (iso === undefined ? {} : { [field]: iso }) as { [P in K]?: string };
}

/** A time as an ISO string, or `undefined` for what is not one. */
export function isoOf(value: unknown): string | undefined {
  const ms =
    typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
