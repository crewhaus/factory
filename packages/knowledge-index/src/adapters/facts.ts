/**
 * Facts: each spec's live file through memory-store's own reader, the lines a compaction moved
 * to the archive, the marks people set, and the legacy `shared.jsonl` an older knowledge sync
 * left. A fact that expired by its own time reads live here, and expired to a reader once the
 * time has passed, so two folds of the same files are the same.
 */
import {
  type KnowledgeIdParts,
  type KnowledgeItem,
  formatKnowledgeId,
} from "@crewhaus/control-contract/knowledge";
import { memoryContentHash } from "@crewhaus/harness-lifecycle/knowledge-sync";
import {
  type MemoryEntry,
  type MemoryListItem,
  type MemoryStore,
  type MemoryTombstone,
  createMemoryStore,
  isMemoryAnnotation,
  isMemoryEntry,
  isMemorySpecName,
  isMemoryTombstone,
} from "@crewhaus/memory-store";
import type { HarnessRead } from "../context";
import { relOf } from "../context";
import { type FoldedItem, can, cannot, folded, shellArg } from "../model";
import {
  type KnowledgeAdapter,
  type KnowledgeHistoryEntry,
  type StoreRoot,
  isoField,
  sessionEvidence,
  storeRoots,
} from "./types";

/** The landing file of an older knowledge sync, beside the spec files. */
const LEGACY_SHARED_FILE = "shared.jsonl";
/** What is refused to an item nobody marked. */
export const NOT_PERSONAL = "This isn't marked as personal data. Forget or archive it instead.";

/** One spec's fact store: where it is, and its reader. */
export type SpecStore = {
  readonly root: StoreRoot;
  readonly rel: string;
  readonly spec: string;
  readonly store: MemoryStore;
};

/** Every spec's fact store: the harness's own, then each customer's. */
export function specStores(read: HarnessRead): SpecStore[] {
  const out: SpecStore[] = [];
  for (const root of storeRoots(read)) {
    const rel = relOf(root.base, "memories");
    const dir = read.directory(rel, "facts");
    if (dir === undefined) continue;
    for (const name of read.names(rel, "files", "facts")) {
      const spec = name.slice(0, -".jsonl".length);
      if (!name.endsWith(".jsonl") || name === LEGACY_SHARED_FILE || !isMemorySpecName(spec)) {
        continue;
      }
      out.push({
        root,
        rel,
        spec,
        // Nothing has expired by its own time at the epoch: the reader decides.
        store: createMemoryStore({ specName: spec, rootDir: dir, now: () => new Date(0) }),
      });
    }
  }
  return out;
}

/** A fact's author, as its line records it. */
export function factAuthor(entry: MemoryEntry): KnowledgeItem["author"] {
  const { author, sessionId, evidence } = entry.provenance ?? {};
  const session = sessionId !== undefined ? { session: sessionId } : {};
  if (author === undefined) {
    const captured = sessionId !== undefined || (evidence?.length ?? 0) > 0;
    return { kind: captured ? "extractor" : "unknown", ...session };
  }
  return {
    kind: author.kind,
    ...session,
    ...(author.via !== undefined ? { via: author.via } : {}),
    ...(author.cmd !== undefined ? { cmd: author.cmd } : {}),
  };
}

function factOrigin(entry: MemoryEntry): KnowledgeItem["origin"] {
  const { author, sessionId, evidence, origin } = entry.provenance ?? {};
  const session = sessionId !== undefined ? { session: sessionId } : {};
  if (origin !== undefined) return { kind: "sync", fromHarness: origin.harness };
  if (author?.kind === "operator") return { kind: "operator", ...session };
  if (evidence !== undefined && evidence.length > 0) {
    return { kind: "tool-result", ...session, toolUseIds: [...evidence] };
  }
  return sessionId !== undefined ? { kind: "conversation", ...session } : { kind: "unknown" };
}

type FactState = {
  readonly lifecycle: "live" | "superseded" | "expired";
  readonly archived: boolean;
  readonly category?: "person";
};

function factItem(
  read: HarnessRead,
  at: SpecStore,
  entry: MemoryEntry,
  state: FactState,
  supersededBy: string | undefined,
): FoldedItem | undefined {
  const idOf = (localId: string): string | undefined =>
    formatKnowledgeId({
      store: "facts",
      spec: at.spec,
      ...(at.root.partition !== undefined ? { partition: at.root.partition } : {}),
      localId,
    });
  const correctionOf = entry.provenance?.correctionOf;
  const live = state.lifecycle === "live" && !state.archived;
  // The fact verbs work on the harness's own stores; a customer's are read here only.
  const own = at.root.partition === undefined;
  const spec = ` --spec ${shellArg(at.spec)}`;
  const id = idOf(entry.id) ?? "";
  const older = "This fact was replaced or forgotten. Its history is kept.";
  const customer = "Customer memory is changed by the deployment that serves the customer.";
  const why = own ? older : customer;
  return folded(read, {
    store: "facts",
    spec: at.spec,
    ...(at.root.partition !== undefined ? { partition: at.root.partition } : {}),
    localId: entry.id,
    title: entry.text,
    titleIsText: true,
    body: entry.text,
    lifecycle: state.lifecycle,
    ...(state.archived ? { status: "in the archive" } : {}),
    ...isoField("createdAt", entry.createdAt),
    ...isoField("expiresAt", entry.expiresAt),
    author: factAuthor(entry),
    origin: factOrigin(entry),
    evidence: sessionEvidence(read, at.root.base, entry.provenance?.sessionId),
    ...(supersededBy !== undefined && idOf(supersededBy) !== undefined
      ? { supersededBy: idOf(supersededBy) as string }
      : {}),
    ...(correctionOf !== undefined && idOf(correctionOf) !== undefined
      ? { correctionOf: idOf(correctionOf) as string, supersedes: idOf(correctionOf) as string }
      : {}),
    tags: entry.tags,
    ...(state.category !== undefined ? { category: state.category } : {}),
    record: { store: "fact", backend: "local", spec: at.spec, localId: entry.id },
    operations: [
      live && own
        ? can(
            "correct",
            `crewhaus memory correct ${entry.id} --text "<text>" --reason "<why>"${spec}`,
          )
        : cannot("correct", why),
      live && own
        ? can("forget", `crewhaus memory forget ${entry.id} --reason "<why>"${spec}`)
        : cannot("forget", why),
      own && !state.archived
        ? can(
            "mark",
            `crewhaus memory mark ${entry.id} ${state.category === "person" ? "--not-personal" : "--personal"}${spec}`,
          )
        : cannot("mark", own ? "This fact is in the archive." : customer),
      state.category === "person"
        ? can("erase", `crewhaus knowledge erase ${shellArg(id)}`)
        : cannot("erase", NOT_PERSONAL),
    ],
  });
}

/** What a compaction moved to the archive: entries, and what was said about them. */
type Archive = {
  readonly entries: ReadonlyMap<string, MemoryEntry>;
  readonly tombstones: ReadonlyMap<string, MemoryTombstone>;
  readonly personal: ReadonlySet<string>;
};

async function archiveOf(store: MemoryStore): Promise<Archive> {
  const entries = new Map<string, MemoryEntry>();
  const tombstones = new Map<string, MemoryTombstone>();
  const marks = new Map<string, "person" | null>();
  for (const { line } of await store.history()) {
    if (isMemoryEntry(line)) entries.set(line.id, line);
    else if (isMemoryTombstone(line)) tombstones.set(line.target, line);
    else if (isMemoryAnnotation(line)) marks.set(line.target, line.value);
  }
  const personal = new Set([...marks].filter(([, v]) => v === "person").map(([id]) => id));
  return { entries, tombstones, personal };
}

/** One spec's facts, live and archived, and how they hang together. */
export type SpecFacts = {
  readonly live: readonly MemoryListItem[];
  /** Entries only the archive holds. */
  readonly archived: readonly MemoryEntry[];
  readonly tombstones: ReadonlyMap<string, MemoryTombstone>;
  /** Every fact's correction chain, itself included. */
  readonly chainOf: ReadonlyMap<string, readonly string[]>;
  /**
   * Facts marked personal, and the rest of their chains: a correction and what it corrected
   * say the same thing about the same person.
   */
  readonly personal: ReadonlySet<string>;
};

/** Read one spec's facts. Throws what the store throws. */
export async function loadSpecFacts(at: SpecStore): Promise<SpecFacts> {
  const live = await at.store.list();
  const archive = await archiveOf(at.store);
  const inFile = new Set(live.map((item) => item.entry.id));
  const archived = [...archive.entries.values()].filter((entry) => !inFile.has(entry.id));
  const personal = new Set([
    ...live.filter((item) => item.category === "person").map((item) => item.entry.id),
    ...archived.filter((entry) => archive.personal.has(entry.id)).map((entry) => entry.id),
  ]);
  const chains = chainsOf([
    ...live.map((item) => item.entry),
    ...archived.map((entry) => ({
      ...entry,
      ...supersededOf(entry.supersededBy ?? archive.tombstones.get(entry.id)?.supersededBy),
    })),
  ]);
  const chainOf = new Map<string, readonly string[]>();
  for (const chain of chains) {
    for (const id of chain) chainOf.set(id, chain);
    if (chain.some((id) => personal.has(id))) for (const id of chain) personal.add(id);
  }
  return { live, archived, tombstones: archive.tombstones, chainOf, personal };
}

async function foldSpec(read: HarnessRead, at: SpecStore): Promise<FoldedItem[]> {
  let facts: SpecFacts;
  try {
    facts = await loadSpecFacts(at);
  } catch {
    read.note("unreadable", "facts", "A file here could not be read, so it is left out.");
    return [];
  }
  const out: FoldedItem[] = [];
  const add = (entry: MemoryEntry, state: Omit<FactState, "category">, by?: string): void => {
    const personal = facts.personal.has(entry.id) ? { category: "person" as const } : {};
    const item = factItem(read, at, entry, { ...state, ...personal }, by);
    if (item !== undefined) out.push(item);
  };
  for (const item of facts.live) {
    add(item.entry, { lifecycle: item.status, archived: false }, item.entry.supersededBy);
  }
  for (const entry of facts.archived) {
    const tombstone = facts.tombstones.get(entry.id);
    const superseded = tombstone?.tombstone === "superseded" || entry.supersededBy !== undefined;
    add(
      entry,
      { lifecycle: superseded ? "superseded" : "expired", archived: true },
      entry.supersededBy ?? tombstone?.supersededBy,
    );
  }
  return out;
}

function supersededOf(id: string | undefined): { supersededBy?: string } {
  return id !== undefined ? { supersededBy: id } : {};
}

/**
 * Facts that are one correction chain: linked by `correctionOf`, or by what replaced them.
 * Erasing one of them is erasing them all.
 */
export function chainsOf(entries: readonly MemoryEntry[]): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let at = id;
    for (let up = parent.get(at); up !== undefined && up !== at; up = parent.get(at)) {
      // Halve the path on the way, so a long chain is walked once, not once per fact.
      const above = parent.get(up) ?? up;
      parent.set(at, above);
      at = above;
    }
    return at;
  };
  const known = new Set(entries.map((entry) => entry.id));
  for (const id of known) parent.set(id, id);
  for (const entry of entries) {
    for (const other of [entry.supersededBy, entry.provenance?.correctionOf]) {
      if (other === undefined || !known.has(other)) continue;
      const [x, y] = [find(entry.id), find(other)];
      if (x !== y) parent.set(x, y);
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of known) {
    const root = find(id);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [id]);
    else group.push(id);
  }
  return [...groups.values()].map((group) => group.sort());
}

/** The legacy shared file's facts: text an older sync pulled, with no store of its own. */
function legacyShared(read: HarnessRead): FoldedItem[] {
  const rel = relOf(".crewhaus", "memories", LEGACY_SHARED_FILE);
  const out: FoldedItem[] = [];
  const seen = new Set<string>();
  for (const record of read.records(rel, "shared")) {
    const text = record["text"];
    if (typeof text !== "string" || text === "") continue;
    const tags = Array.isArray(record["tags"])
      ? record["tags"].filter((tag): tag is string => typeof tag === "string")
      : [];
    const from = tags.find((tag) => tag.startsWith("shared:"))?.slice("shared:".length);
    const own = tags.filter((tag) => !tag.startsWith("shared:"));
    const localId = `h${memoryContentHash(text, own).slice(0, 16)}`;
    if (seen.has(localId)) continue;
    seen.add(localId);
    const item = folded(read, {
      store: "shared",
      spec: "-",
      localId,
      title: text,
      titleIsText: true,
      body: text,
      author: { kind: "sync" },
      origin: { kind: "sync", ...(from !== undefined ? { fromHarness: from } : {}) },
      ...isoField("createdAt", record["createdAt"]),
      tags: own,
      operations: [
        cannot("correct", "Correct it in the harness that shared it."),
        cannot("erase", NOT_PERSONAL),
      ],
    });
    if (item !== undefined) out.push(item);
  }
  return out;
}

async function factHistory(
  read: HarnessRead,
  id: KnowledgeIdParts,
): Promise<KnowledgeHistoryEntry[]> {
  const at = specStores(read).find(
    (s) => s.spec === id.spec && (s.root.partition ?? "-") === (id.partition ?? "-"),
  );
  if (at === undefined) return [];
  const live = await at.store.list();
  const archived = await at.store.history();
  const entries = new Map<string, MemoryEntry>();
  for (const { line } of archived) if (isMemoryEntry(line)) entries.set(line.id, line);
  for (const { entry } of live) entries.set(entry.id, entry);
  const tombstones = new Map<string, MemoryTombstone>();
  const moved = new Map<string, string>();
  for (const { line, archivedAt } of archived) {
    if (isMemoryTombstone(line)) tombstones.set(line.target, line);
    if (isMemoryEntry(line)) moved.set(line.id, archivedAt);
  }
  for (const record of read.records(relOf(at.rel, `${at.spec}.jsonl`), "facts")) {
    if (isMemoryTombstone(record)) tombstones.set(record.target, record);
  }
  const withLinks = [...entries.values()].map((entry) => ({
    ...entry,
    ...supersededOf(entry.supersededBy ?? tombstones.get(entry.id)?.supersededBy),
  }));
  const chain = chainsOf(withLinks).find((ids) => ids.includes(id.localId)) ?? [];
  const idOf = (localId: string): string | undefined => formatKnowledgeId({ ...id, localId });
  // What was replaced comes before what replaced it, even where both bear one time.
  const before = (factId: string): string[] =>
    withLinks
      .filter(
        (entry) =>
          entry.supersededBy === factId ||
          entries.get(factId)?.provenance?.correctionOf === entry.id,
      )
      .map((entry) => entry.id);
  const depths = new Map<string, number>();
  const depthOf = (factId: string): number => {
    const known = depths.get(factId);
    if (known !== undefined) return known;
    depths.set(factId, 0); // a link back to itself ends here
    const depth = Math.max(0, ...before(factId).map((other) => depthOf(other) + 1));
    depths.set(factId, depth);
    return depth;
  };
  const out: (KnowledgeHistoryEntry & { readonly depth: number })[] = [];
  for (const factId of chain) {
    const entry = entries.get(factId);
    if (entry === undefined) continue;
    const itemId = idOf(factId);
    const of = { ...(itemId !== undefined ? { id: itemId } : {}), depth: depthOf(factId) };
    out.push({
      ...isoField("at", entry.createdAt),
      what: entry.provenance?.correctionOf !== undefined ? "corrected" : "created",
      ...of,
      author: factAuthor(entry),
      body: entry.text,
    });
    const tombstone = tombstones.get(factId);
    if (tombstone !== undefined) {
      out.push({
        ...isoField("at", tombstone.at),
        what: tombstone.tombstone,
        ...of,
        ...(tombstone.reason !== undefined ? { reason: tombstone.reason } : {}),
      });
    }
    const movedAt = moved.get(factId);
    if (movedAt !== undefined) out.push({ at: movedAt, what: "archived", ...of });
  }
  const timeOf = (entry: KnowledgeHistoryEntry): string => entry.at ?? "";
  return out
    .sort((a, b) => {
      if (timeOf(a) !== timeOf(b)) return timeOf(a) < timeOf(b) ? -1 : 1;
      return a.depth - b.depth;
    })
    .map(({ depth: _depth, ...entry }) => entry);
}

export const factsAdapter: KnowledgeAdapter = {
  name: "facts",
  stores: ["facts", "shared"],
  async list(read) {
    const out: FoldedItem[] = [];
    for (const at of specStores(read)) {
      for (const item of await foldSpec(read, at)) out.push(item);
    }
    for (const item of legacyShared(read)) out.push(item);
    return out;
  },
  marks(read) {
    const out: Record<string, string> = {};
    const mark = (rel: string): void => {
      out[rel] = read.sourceMark(rel);
    };
    for (const root of storeRoots(read)) {
      const rel = relOf(root.base, "memories");
      mark(rel);
      for (const name of read.names(rel, "files", "facts")) {
        if (name.endsWith(".jsonl")) mark(relOf(rel, name));
      }
      for (const spec of read.names(relOf(rel, "archive"), "dirs", "facts")) {
        const archive = relOf(rel, "archive", spec);
        for (const name of read.names(archive, "files", "facts")) {
          if (name.endsWith(".jsonl")) mark(relOf(archive, name));
        }
      }
    }
    return out;
  },
  async current(read, ids) {
    const out: FoldedItem[] = [];
    const wanted = new Set(ids.map((p) => `${p.spec}\0${p.partition ?? "-"}\0${p.localId}`));
    for (const at of specStores(read)) {
      const partition = at.root.partition ?? "-";
      if (!ids.some((p) => p.spec === at.spec && (p.partition ?? "-") === partition)) continue;
      for (const item of await foldSpec(read, at)) {
        if (wanted.has(`${at.spec}\0${partition}\0${item.item.ref.localId}`)) out.push(item);
      }
    }
    if (ids.some((p) => p.store === "shared")) {
      const shared = new Set(ids.map((p) => p.localId));
      out.push(...legacyShared(read).filter((item) => shared.has(item.item.ref.localId)));
    }
    return out;
  },
  history: factHistory,
};
