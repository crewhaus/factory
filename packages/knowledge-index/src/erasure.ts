/**
 * `@crewhaus/knowledge-index/erasure`: the one door through which CrewHaus's own commands
 * delete what a harness knows about a person.
 *
 * Everything else a harness knows keeps its history, so the door acts only on facts marked
 * personal; anything else is refused. It works in three steps, and each can stop it:
 *
 * 1. {@link planErasure} lists what would go and what would stay, and writes nothing.
 * 2. {@link authorizeErasure} asks that the caller may manage every harness the plan reaches
 *    (one refusal refuses the whole call) and that they typed the harness's name. It answers a
 *    grant: what each store may erase, by name.
 * 3. {@link executeErasure} plans again, refuses when anything moved since, runs each store's
 *    purge with the grant, removes the affected search indexes, and appends one receipt that
 *    holds counts and codes: no id, no hash, no text.
 *
 * A fact's target is its whole correction chain, live and archived; its copies in the shared
 * store and in the other registered harnesses; and, with its sources, what the conversation it
 * came from left behind: its summary, the wiki versions and working state written in it, and
 * the facts captured from it. What cannot be reached is named as residue before anyone
 * confirms.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  type ContinuityErasure,
  purgeSessions,
  purgeTrashSnapshot,
  stateFromSessions,
  trashHolding,
} from "@crewhaus/continuity-store/erasure";
import { HARNESS_ID_RE, type ReceiptEffect } from "@crewhaus/control-contract";
import {
  type ErasureGrant,
  type ErasureScope,
  formatKnowledgeId,
  parseKnowledgeId,
} from "@crewhaus/control-contract/knowledge";
import {
  append,
  controlPaths,
  ensureDigestKey,
  harnessLedger,
  storedLocalActor,
  writeNudgeMarker,
} from "@crewhaus/control-records";
import { eraseShared } from "@crewhaus/harness-lifecycle/erasure";
import {
  SHARED_DIR_DEFAULT,
  maskKnowledgeSecrets,
  memoryContentHash,
} from "@crewhaus/harness-lifecycle/knowledge-sync";
import { type MemoryEntry, createMemoryStore } from "@crewhaus/memory-store";
import { purge, purgeWhere } from "@crewhaus/memory-store/erasure";
import { purgeSummaries, summariesOf } from "@crewhaus/session-store/erasure";
import { openForReadSync } from "@crewhaus/tool-safety/fs";
import { eraseVersions, versionsWrittenIn } from "@crewhaus/wiki-store/erasure";
import { NOT_PERSONAL, type SpecStore, loadSpecFacts, specStores } from "./adapters/facts";
import { sessionEvidence, storePlaces, storeRoots } from "./adapters/types";
import { HarnessRead, relOf } from "./context";
import { knowledgeIndexEffect } from "./effect";
import { KNOWLEDGE_PROJECTION, Shard, deleteShard } from "./shard";

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** A harness the door may look in for copies. */
export type ErasureHarness = {
  readonly dir: string;
  readonly hrn?: string;
  readonly name?: string;
};

/** Why the door may act on an item at all. */
export type ErasureBasis = { readonly kind: "marked" };

export type ErasureRequest = {
  readonly harnessDir: string;
  readonly hrn?: string;
  readonly harnessName?: string;
  /** Home's root, where the search indexes are. */
  readonly hangarRoot?: string;
  /** Item ids. */
  readonly items: readonly string[];
  /** Also what the conversations the facts came from left behind. */
  readonly includeSources: boolean;
  readonly basis: ErasureBasis;
  /** The other registered harnesses, for the copies they pulled. */
  readonly harnesses?: readonly ErasureHarness[];
  /** Shared stores. Default: the named one, else the usual places beside the harness. */
  readonly sharedDirs?: readonly string[];
  readonly now?: () => Date;
};

/** Where copies would go from: the words a dry run shows, and how many. */
export type ErasureTargetLine = {
  readonly store: ErasureTargetStore;
  readonly copies: number;
  /** The harness it is in, when that is not the one asked about. */
  readonly harness?: string;
};

export type ErasureTargetStore =
  | "facts"
  | "fact-archive"
  | "session-summaries"
  | "wiki-versions"
  | "working-memory"
  | "trash"
  | "shared-store"
  | "pulled-copies"
  | "search-index";

/** What cannot be reached, by code; `until` when it goes by itself. */
export type ErasureResidue = {
  readonly code:
    | "session-logs"
    | "usage-lines"
    | "backups"
    | "thredz"
    | "shared-retraction"
    | "origin-harness"
    | "dream-reports"
    | "unread-stores";
  readonly until?: string;
};

export type ErasureRefusal = { readonly item: string; readonly reason: string };

export type ErasurePlan = {
  readonly nonce: string;
  /** What the plan would do, as one digest: a store that changes since moves it. */
  readonly digest: string;
  readonly targets: readonly ErasureTargetLine[];
  readonly residue: readonly ErasureResidue[];
  readonly refusals: readonly ErasureRefusal[];
  /** Every harness the plan reaches: the one asked about first. */
  readonly harnesses: readonly string[];
  /** What each store may erase. */
  readonly scopes: readonly ErasureScope[];
};

const ITEM_MISSING = "There is no such item here.";
const SHARED_MAX_BYTES = 512 * 1024 * 1024;

/** One harness's part of a plan. */
type Part = {
  readonly dir: string;
  readonly hrn: string | undefined;
  readonly name: string;
  /** Facts to purge, by spec store. */
  readonly facts: Map<string, { readonly at: SpecStore; readonly root: string; ids: Set<string> }>;
};

type Inventory = {
  readonly lines: ErasureTargetLine[];
  readonly residue: ErasureResidue[];
  readonly refusals: ErasureRefusal[];
  readonly scopes: ErasureScope[];
  readonly harnesses: string[];
  readonly steps: Step[];
  /** What the digest covers. */
  readonly facts: unknown[];
};

/** One purge the executor runs. */
type Step = {
  readonly store: ErasureTargetStore;
  readonly run: (grant: ErasureGrant) => Promise<number>;
};

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function readOf(harness: ErasureHarness, now?: () => Date): HarnessRead {
  return new HarnessRead({
    harnessDir: harness.dir,
    hrn: harness.hrn ?? "hrn_0000000000000000",
    ...(harness.name !== undefined ? { harnessName: harness.name } : {}),
    ...(now !== undefined ? { now } : {}),
  });
}

/** A part's facts of one spec, by the store's place. */
function factsIn(part: Part, at: SpecStore, read: HarnessRead): Set<string> {
  const place = `${at.rel}/${at.spec}`;
  const held = part.facts.get(place);
  if (held !== undefined) return held.ids;
  const root = read.directory(at.rel, "facts") ?? join(part.dir, at.rel);
  const entry = { at, root, ids: new Set<string>() };
  part.facts.set(place, entry);
  return entry.ids;
}

/** The content hashes a fact may be shared under: as it is, masked, and as it was pulled. */
function hashesOf(entry: MemoryEntry): string[] {
  const own = entry.tags.filter((tag) => !tag.startsWith("shared:"));
  return [
    memoryContentHash(entry.text, own),
    memoryContentHash(entry.text, entry.tags),
    memoryContentHash(maskKnowledgeSecrets(entry.text), own),
    ...(entry.provenance?.origin !== undefined ? [entry.provenance.origin.contentHash] : []),
  ];
}

type SharedLine = { readonly hashes: readonly string[]; readonly origin: string };

/**
 * A shared store's lines, read without loading what they say into an answer; `unread` when
 * one is there and cannot be read whole.
 */
function sharedLines(dir: string): SharedLine[] | "unread" {
  const read = openForReadSync(dir, "memories.jsonl", {
    maxBytes: SHARED_MAX_BYTES,
    followLeafSymlink: false,
  });
  if (!read.ok) return read.code === "not-found" ? [] : "unread";
  if (read.truncated) return "unread";
  const out: SharedLine[] = [];
  for (const text of read.text.split("\n")) {
    if (text.trim() === "") continue;
    try {
      const line = JSON.parse(text) as Record<string, unknown>;
      const tags = Array.isArray(line["tags"])
        ? line["tags"].filter((tag): tag is string => typeof tag === "string")
        : [];
      const origin = line["origin"] as { harness?: unknown; fact?: unknown } | null | undefined;
      out.push({
        hashes: [
          ...(typeof line["contentHash"] === "string" ? [line["contentHash"]] : []),
          ...(typeof line["text"] === "string" ? [memoryContentHash(line["text"], tags)] : []),
        ],
        origin: `${String(origin?.harness)}\n${String(origin?.fact)}`,
      });
    } catch {
      // A line that is not one of ours.
    }
  }
  return out;
}

function sharedDirsOf(request: ErasureRequest): string[] {
  const dirs = request.sharedDirs ?? [
    ...(process.env["CREWHAUS_SHARED_DIR"] !== undefined
      ? [process.env["CREWHAUS_SHARED_DIR"]]
      : []),
    join(request.harnessDir, SHARED_DIR_DEFAULT),
    join(request.harnessDir, "..", SHARED_DIR_DEFAULT),
  ];
  return [...new Set(dirs.map((dir) => realOr(dir)))];
}

async function inventory(request: ErasureRequest): Promise<Inventory> {
  const home: Part = {
    dir: request.harnessDir,
    hrn: request.hrn,
    name: request.harnessName ?? basename(resolve(request.harnessDir)),
    facts: new Map(),
  };
  const read = readOf(
    {
      dir: request.harnessDir,
      ...(request.hrn !== undefined ? { hrn: request.hrn } : {}),
      ...(request.harnessName !== undefined ? { name: request.harnessName } : {}),
    },
    request.now,
  );
  const refusals: ErasureRefusal[] = [];
  const stores = specStores(read);
  const loaded = new Map<SpecStore, Awaited<ReturnType<typeof loadSpecFacts>>>();
  for (const at of stores) loaded.set(at, await loadSpecFacts(at));

  // 1. The facts asked for, each with its whole chain.
  const entries = new Map<string, MemoryEntry>();
  const noteEntries = (at: SpecStore, ids: Iterable<string>): void => {
    const facts = loaded.get(at);
    if (facts === undefined) return;
    const wanted = new Set(ids);
    for (const { entry } of facts.live) {
      if (wanted.has(entry.id)) entries.set(`${at.rel}/${at.spec}/${entry.id}`, entry);
    }
    for (const entry of facts.archived) {
      if (wanted.has(entry.id)) entries.set(`${at.rel}/${at.spec}/${entry.id}`, entry);
    }
  };
  const bases = new Set<string>();
  for (const item of request.items) {
    const parts = parseKnowledgeId(item);
    const at =
      parts?.store !== "facts"
        ? undefined
        : stores.find(
            (s) => s.spec === parts.spec && (s.root.partition ?? "-") === (parts.partition ?? "-"),
          );
    const facts = at === undefined ? undefined : loaded.get(at);
    const chain = parts === undefined ? undefined : facts?.chainOf.get(parts.localId);
    if (parts !== undefined && parts.store !== "facts") {
      refusals.push({ item, reason: NOT_PERSONAL });
    } else if (at === undefined || facts === undefined || chain === undefined) {
      refusals.push({ item, reason: ITEM_MISSING });
    } else if (!facts.personal.has(parts?.localId ?? "")) {
      refusals.push({ item, reason: NOT_PERSONAL });
    } else {
      for (const id of chain) factsIn(home, at, read).add(id);
      noteEntries(at, chain);
      bases.add(at.root.base);
    }
  }

  // 2. What the conversations they came from left behind.
  const sources = new Set<string>();
  for (const entry of entries.values()) {
    const session = entry.provenance?.sessionId;
    if (session !== undefined) sources.add(session);
  }
  const sessions = request.includeSources ? [...sources].sort() : [];
  const lines: ErasureTargetLine[] = [];
  const scopes: ErasureScope[] = [];
  const steps: Step[] = [];
  const covered: unknown[] = [];
  /** One line per store and harness, however many places they keep it in. */
  const line = (store: ErasureTargetStore, copies: number, harness?: string): void => {
    if (copies === 0) return;
    const at = lines.findIndex((l) => l.store === store && l.harness === harness);
    const before = lines[at];
    if (before === undefined) {
      lines.push({ store, copies, ...(harness !== undefined ? { harness } : {}) });
    } else {
      lines[at] = { ...before, copies: before.copies + copies };
    }
  };
  if (sessions.length > 0) {
    for (const at of stores) {
      if (!bases.has(at.root.base)) continue;
      const facts = loaded.get(at);
      const captured = [
        ...(facts?.live.map(({ entry }) => entry) ?? []),
        ...(facts?.archived ?? []),
      ]
        .filter((entry) => sessions.includes(entry.provenance?.sessionId ?? ""))
        .flatMap((entry) => facts?.chainOf.get(entry.id) ?? [entry.id]);
      if (captured.length === 0) continue;
      for (const id of captured) factsIn(home, at, read).add(id);
      noteEntries(at, captured);
    }
    for (const base of [...bases].sort()) {
      for (const left of await leftBehind(read, base, sessions)) {
        line(left.store, left.copies);
        covered.push([left.store, base, left.covers]);
        scopes.push(left.scope);
        steps.push({ store: left.store, run: left.run });
      }
    }
  }

  // 3. Shared copies, and the copies other harnesses pulled.
  const hashes = new Set([...entries.values()].flatMap(hashesOf));
  const origins = new Set(
    [...home.facts.values()].flatMap(({ ids }) =>
      [...ids].map((id) => `${basename(resolve(request.harnessDir))}\n${id}`),
    ),
  );
  let shared = 0;
  // Stores that may hold a copy and could not be read: named, never passed over.
  let unread = 0;
  for (const dir of sharedDirsOf(request)) {
    const lines = sharedLines(dir);
    if (lines === "unread") {
      unread += 1;
      continue;
    }
    const found = lines.filter(
      (l) => origins.has(l.origin) || l.hashes.some((hash) => hashes.has(hash)),
    );
    if (found.length === 0) continue;
    const targets = [...new Set(found.flatMap((l) => l.hashes))].sort();
    for (const hash of targets) hashes.add(hash);
    shared += found.length;
    line("shared-store", found.length);
    covered.push(["shared", targets]);
    scopes.push({ store: "shared", root: dir, targets });
    steps.push({
      store: "shared-store",
      run: async (grant) => (await eraseShared(dir, targets, grant, request.now)).removed,
    });
  }
  const parts: Part[] = [home];
  const here = realOr(request.harnessDir);
  for (const harness of request.harnesses ?? []) {
    if (realOr(harness.dir) === here) continue;
    const pulled = await pulledInto(harness, hashes, request.now);
    unread += pulled.unread;
    if (pulled.part !== undefined) parts.push(pulled.part);
  }
  legacyShared(home, read, hashes);

  // 4. The fact purges themselves, each store once.
  for (const part of parts) {
    for (const { at, root, ids } of part.facts.values()) {
      if (ids.size === 0) continue;
      const targets = [...ids].sort();
      const place = { rootDir: root, specName: at.spec };
      const elsewhere = part === home ? undefined : part.name;
      const counted = await countsOf(at, ids, root);
      covered.push(["facts", part.dir, at.rel, at.spec, targets, counted]);
      scopes.push({ store: "memory", root, spec: at.spec, targets });
      if (elsewhere === undefined) {
        line("facts", counted.live);
        line("fact-archive", counted.archived);
      } else {
        line("pulled-copies", counted.live + counted.archived, elsewhere);
      }
      steps.push({
        store: elsewhere === undefined ? "facts" : "pulled-copies",
        run: async (grant) => {
          // What the source conversations left first, by the conversation itself; then every
          // fact by name, whole chains included.
          const captured =
            sessions.length > 0 && elsewhere === undefined
              ? await purgeWhere(
                  place,
                  (entry) => sessions.includes(entry.provenance?.sessionId ?? ""),
                  grant,
                )
              : { live: 0, archived: 0 };
          const named = await purge(place, targets, grant);
          return captured.live + captured.archived + named.live + named.archived;
        },
      });
    }
  }

  // 5. The search indexes.
  for (const part of parts) {
    if (request.hangarRoot === undefined || !hasIds(part)) continue;
    if (part.hrn === undefined || !HARNESS_ID_RE.test(part.hrn)) continue;
    if (Shard.open(request.hangarRoot, part.hrn) !== undefined) {
      line("search-index", 1, part === home ? undefined : part.name);
    }
  }

  const residue = residueOf({
    read,
    entries: [...entries.values()],
    bases,
    sources,
    shared,
    unread,
  });
  return {
    lines,
    residue,
    refusals,
    scopes,
    harnesses: parts.filter((part) => part === home || hasIds(part)).map((part) => part.dir),
    steps,
    facts: covered,
  };
}

/** One store's share of what the source conversations left behind. */
type LeftBehind = {
  readonly store: ErasureTargetStore;
  readonly copies: number;
  readonly covers: unknown;
  readonly scope: ErasureScope;
  readonly run: Step["run"];
};

/** The summaries, wiki versions, working state and trash these conversations left in one place. */
async function leftBehind(
  read: HarnessRead,
  base: string,
  sessions: readonly string[],
): Promise<LeftBehind[]> {
  const root = read.directory(base, "harness");
  if (root === undefined) return [];
  const out: LeftBehind[] = [];
  const summaries = summariesOf(root, sessions);
  if (summaries.length > 0) {
    out.push({
      store: "session-summaries",
      copies: summaries.length,
      covers: summaries,
      scope: { store: "summaries", root, targets: [...summaries] },
      run: (grant) => purgeSummaries(root, summaries, grant),
    });
  }
  for (const place of storePlaces(read, "wiki").filter((p) => p.root.base === base)) {
    const at = { rootDir: place.rootDir, specName: place.name };
    const versions = versionsWrittenIn(at, sessions);
    if (versions.length === 0) continue;
    out.push({
      store: "wiki-versions",
      copies: versions.length,
      covers: [place.rel, versions],
      scope: { store: "wiki", root: at.rootDir, spec: at.specName, targets: sessions },
      run: async (grant) => (await eraseVersions(at, { sessions }, grant)).versions,
    });
  }
  for (const place of storePlaces(read, "state").filter((p) => p.root.base === base)) {
    const at = { rootDir: place.rootDir, specName: place.name };
    const left = stateFromSessions(at, sessions);
    if (sumOf(left) === 0) continue;
    out.push({
      store: "working-memory",
      copies: sumOf(left),
      covers: [place.rel, left],
      scope: { store: "continuity", root: at.rootDir, spec: at.specName, targets: sessions },
      run: async (grant) => sumOf(await purgeSessions(at, sessions, grant)),
    });
  }
  const stamps = await trashHolding(root, sessions);
  if (stamps.length > 0) {
    out.push({
      store: "trash",
      copies: stamps.length,
      covers: stamps,
      scope: { store: "trash", root, targets: [...stamps] },
      run: async (grant) => {
        let gone = 0;
        for (const stamp of stamps) if (await purgeTrashSnapshot(root, stamp, grant)) gone += 1;
        return gone;
      },
    });
  }
  return out;
}

const hasIds = (part: Part): boolean => [...part.facts.values()].some(({ ids }) => ids.size > 0);

const sumOf = (left: ContinuityErasure): number => left.sessions + left.requirements + left.proofs;

/** How many lines of a store are about these facts, live and archived. */
async function countsOf(
  at: SpecStore,
  ids: ReadonlySet<string>,
  root: string,
): Promise<{ readonly live: number; readonly archived: number }> {
  const read = openForReadSync(root, `${at.spec}.jsonl`, {
    maxBytes: SHARED_MAX_BYTES,
    followLeafSymlink: false,
  });
  const about = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return ids.has(record["id"] as string) || ids.has(record["target"] as string);
  };
  let live = 0;
  for (const text of read.ok ? read.text.split("\n") : []) {
    try {
      if (text.trim() !== "" && about(JSON.parse(text))) live += 1;
    } catch {
      if ([...ids].some((id) => text.includes(id))) live += 1;
    }
  }
  const archived = (await at.store.history()).filter(({ line }) => about(line)).length;
  return { live, archived };
}

/**
 * The copies of these memories another harness pulled (`part` is `undefined` when it has
 * none), and how many of its fact stores could not be read.
 */
async function pulledInto(
  harness: ErasureHarness,
  hashes: ReadonlySet<string>,
  now: (() => Date) | undefined,
): Promise<{ readonly part: Part | undefined; readonly unread: number }> {
  if (!existsSync(harness.dir)) return { part: undefined, unread: 1 };
  const read = readOf(harness, now);
  const part: Part = {
    dir: harness.dir,
    hrn: harness.hrn,
    name: harness.name ?? basename(resolve(harness.dir)),
    facts: new Map(),
  };
  let unread = 0;
  for (const at of specStores(read)) {
    let facts: Awaited<ReturnType<typeof loadSpecFacts>>;
    try {
      facts = await loadSpecFacts(at);
    } catch {
      unread += 1;
      continue;
    }
    for (const entry of [...facts.live.map((item) => item.entry), ...facts.archived]) {
      const origin = entry.provenance?.origin;
      if (origin === undefined || !hashes.has(origin.contentHash)) continue;
      for (const id of facts.chainOf.get(entry.id) ?? [entry.id]) factsIn(part, at, read).add(id);
    }
  }
  legacyShared(part, read, hashes);
  // A fact store kept outside that harness's folder, or one that is there and cannot be read.
  unread += read
    .notes()
    .filter((note) => ["facts", "shared", "customers"].includes(note.store))
    .reduce((sum, note) => sum + note.count, 0);
  return { part: hasIds(part) ? part : undefined, unread };
}

/** The legacy `shared.jsonl` an older sync pulled into: its lines have ids of their own. */
function legacyShared(part: Part, read: HarnessRead, hashes: ReadonlySet<string>): void {
  for (const root of storeRoots(read)) {
    const rel = relOf(root.base, "memories");
    const dir = read.directory(rel, "facts");
    if (dir === undefined) continue;
    for (const record of read.records(relOf(rel, "shared.jsonl"), "shared")) {
      const { id, text, tags } = record;
      if (typeof id !== "string" || typeof text !== "string" || !Array.isArray(tags)) continue;
      const own = tags.filter(
        (t): t is string => typeof t === "string" && !t.startsWith("shared:"),
      );
      if (!hashes.has(memoryContentHash(text, own))) continue;
      const at: SpecStore = {
        root,
        rel,
        spec: "shared",
        store: createMemoryStore({ specName: "shared", rootDir: dir }),
      };
      factsIn(part, at, read).add(id);
    }
  }
}

/** What stays after an erasure, and until when. */
function residueOf(at: {
  readonly read: HarnessRead;
  readonly entries: readonly MemoryEntry[];
  readonly bases: ReadonlySet<string>;
  readonly sources: ReadonlySet<string>;
  readonly shared: number;
  readonly unread: number;
}): ErasureResidue[] {
  const { read } = at;
  if (at.entries.length === 0) return [];
  const out: ErasureResidue[] = [];
  // Conversations keep what was said in them until they expire; the last of these to go
  // says when.
  let until: string | undefined;
  for (const base of at.bases) {
    for (const session of at.sources) {
      const { evictsAt } = sessionEvidence(read, base, session);
      if (evictsAt !== undefined && (until === undefined || evictsAt > until)) until = evictsAt;
    }
  }
  out.push({ code: "session-logs", ...(until !== undefined ? { until } : {}) });
  if (read.directory(controlPaths(read.dir).knowledgeUsageDir, "harness") !== undefined) {
    out.push({ code: "usage-lines" });
  }
  out.push({ code: "backups" });
  const spec = read.text("crewhaus.yaml") ?? read.text("crewhaus.yml") ?? "";
  if (/^thredz:/m.test(spec)) out.push({ code: "thredz" });
  if (at.shared > 0) out.push({ code: "shared-retraction" });
  // A fact this harness pulled: the harness that shared it keeps its own.
  if (at.entries.some((entry) => entry.provenance?.origin !== undefined)) {
    out.push({ code: "origin-harness" });
  }
  // Each store root keeps its own consolidation reports: the harness's, and a customer's.
  const quoted = [...at.bases].sort().some((base) =>
    read.names(relOf(base, "dream"), "dirs", "suggestions").some((name) => {
      const report = read.text(relOf(base, "dream", name, "idempotency.json"), "suggestions");
      // A report is JSON, so what it quotes is spelled as JSON spells it.
      return at.entries.some(({ text }) => {
        const spelled = JSON.stringify(text.replace(/\s+/g, " ").trim()).slice(1, -1);
        return report?.includes(spelled.slice(0, 100)) === true;
      });
    }),
  );
  if (quoted) out.push({ code: "dream-reports" });
  if (at.unread > 0) out.push({ code: "unread-stores" });
  return out;
}

function digestOf(inv: Inventory): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        inv.facts,
        inv.lines,
        inv.refusals,
        inv.scopes,
        inv.harnesses,
        inv.residue.map((r) => r.code),
      ]),
    )
    .digest("hex");
}

/** List what an erasure would remove and what would stay. Writes nothing. */
export async function planErasure(request: ErasureRequest): Promise<ErasurePlan> {
  const inv = await inventory(request);
  const plan: ErasurePlan = {
    nonce: randomBytes(16).toString("hex"),
    digest: digestOf(inv),
    targets: inv.lines,
    residue: inv.residue,
    refusals: inv.refusals,
    harnesses: inv.harnesses,
    scopes: inv.scopes,
  };
  planned.set(plan, request);
  return plan;
}

/** The request behind a plan made in this process. */
const planned = new WeakMap<ErasurePlan, ErasureRequest>();
/** The request behind a grant minted in this process, until it is run. */
const granted = new WeakMap<ErasureGrant, ErasureRequest>();

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export type ErasureAuthority = {
  /** Whether the caller may manage what this harness keeps. */
  readonly mayManage: (harnessDir: string) => boolean;
  /** What the person typed. */
  readonly confirmName: string;
  /** The name they had to type. */
  readonly harnessName: string;
};

export type ErasureAuthorization =
  | { readonly ok: true; readonly grant: ErasureGrant }
  | {
      readonly ok: false;
      readonly code: "refused-items" | "nothing" | "not-allowed" | "wrong-name" | "unknown-plan";
      readonly reason: string;
    };

/** Turn a plan into a grant, or say why not. One harness refused refuses the whole call. */
export function authorizeErasure(
  plan: ErasurePlan,
  authority: ErasureAuthority,
): ErasureAuthorization {
  const request = planned.get(plan);
  if (request === undefined) {
    return { ok: false, code: "unknown-plan", reason: "This plan was not made here. Plan again." };
  }
  const refused = plan.refusals[0];
  if (refused !== undefined) {
    return { ok: false, code: "refused-items", reason: refused.reason };
  }
  if (plan.scopes.length === 0) {
    return { ok: false, code: "nothing", reason: "There is nothing here to delete." };
  }
  for (const dir of plan.harnesses) {
    if (!authority.mayManage(dir)) {
      return {
        ok: false,
        code: "not-allowed",
        reason: `You don't manage every harness this reaches (${basename(resolve(dir))}), so nothing was deleted.`,
      };
    }
  }
  if (authority.confirmName !== authority.harnessName) {
    return {
      ok: false,
      code: "wrong-name",
      reason: `Type the harness's name (${authority.harnessName}) to confirm. Nothing was deleted.`,
    };
  }
  const grant: ErasureGrant = { nonce: plan.nonce, digest: plan.digest, scopes: plan.scopes };
  granted.set(grant, request);
  return { ok: true, grant };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** One harness whose index an erasure removed. */
export type ErasedHarness = {
  readonly dir: string;
  readonly hrn: string;
  /** Whether it had an index. */
  readonly hadIndex: boolean;
};

export type ExecuteErasureOptions = {
  /** Rebuild a harness's index: the projector's pass, when it runs now. */
  readonly refreshIndex?: (harness: ErasedHarness) => Promise<void>;
  /** Who did it: a principal, else the local user, stored as a keyed digest. */
  readonly actor?: { readonly principal?: string; readonly local?: string };
};

/** The content-free record of one erasure. */
export type ErasureReceipt = {
  readonly v: 1;
  readonly id: string;
  readonly at: string;
  readonly by?: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly residue: readonly ErasureResidue[];
  readonly effects: readonly ReceiptEffect[];
};

export type ErasureAnswer =
  | { readonly ok: true; readonly receipt: ErasureReceipt; readonly failed: readonly string[] }
  | {
      readonly ok: false;
      readonly code: "unknown-grant" | "changed" | "receipt";
      readonly reason: string;
    };

const CHANGED = "This changed since the dry run. Review it again.";
const NOT_ERASED = "could not be deleted; run it again";

/**
 * Run an erasure. It plans once more and refuses when anything moved since the dry run; then
 * each store's purge runs under the grant, and one that fails leaves the others done and says
 * so. A grant runs once.
 */
export async function executeErasure(
  grant: ErasureGrant,
  opts: ExecuteErasureOptions = {},
): Promise<ErasureAnswer> {
  const request = granted.get(grant);
  if (request === undefined) {
    return {
      ok: false,
      code: "unknown-grant",
      reason: "This confirmation was used already, or was not made here. Plan again.",
    };
  }
  granted.delete(grant);
  const inv = await inventory(request);
  if (digestOf(inv) !== grant.digest) return { ok: false, code: "changed", reason: CHANGED };

  const counts: Record<string, number> = {};
  const status = new Map<string, ReceiptEffect["status"]>();
  for (const step of inv.steps) {
    try {
      counts[step.store] = (counts[step.store] ?? 0) + (await step.run(grant));
      if (status.get(step.store) !== "failed") status.set(step.store, "done");
    } catch {
      status.set(step.store, "failed");
    }
  }

  // The indexes after the stores, so nothing builds one from what is going.
  const named = [
    { dir: request.harnessDir, hrn: request.hrn },
    ...(request.harnesses ?? []).map(({ dir, hrn }) => ({ dir, hrn })),
  ];
  const reached = inv.harnesses.flatMap((dir) => {
    const hrn = named.find((harness) => harness.dir === dir)?.hrn;
    return hrn !== undefined && HARNESS_ID_RE.test(hrn) ? [{ dir, hrn }] : [];
  });
  if (request.hangarRoot !== undefined) {
    let removed = 0;
    for (const { dir, hrn } of reached) {
      const hadIndex = deleteShard(request.hangarRoot, hrn);
      if (hadIndex) removed += 1;
      writeNudgeMarker(request.hangarRoot, KNOWLEDGE_PROJECTION, hrn);
      if (opts.refreshIndex !== undefined) {
        try {
          await opts.refreshIndex({ dir, hrn, hadIndex });
        } catch {
          // The effect below says what the index reflects.
        }
      }
    }
    if (removed > 0) counts["search-index"] = removed;
  }

  const effects: ReceiptEffect[] = [...status.entries()].map(([kind, state]) => ({
    kind,
    status: state,
    ...(state === "failed" ? { note: NOT_ERASED } : {}),
  }));
  effects.push(
    request.hangarRoot !== undefined && request.hrn !== undefined && HARNESS_ID_RE.test(request.hrn)
      ? knowledgeIndexEffect({
          hangarRoot: request.hangarRoot,
          hrn: request.hrn,
          harnessDir: request.harnessDir,
        })
      : { kind: "index", status: "skipped", note: "this harness has no search index" },
  );
  const by = await storedActor(request.harnessDir, opts.actor);
  const receipt: ErasureReceipt = {
    v: 1,
    id: `erasure_${randomBytes(16).toString("hex")}`,
    at: (request.now?.() ?? new Date()).toISOString(),
    ...(by !== undefined ? { by } : {}),
    counts,
    residue: inv.residue,
    effects,
  };
  const ledger = harnessLedger(request.harnessDir, {
    dir: controlPaths(request.harnessDir).knowledgeErasuresDir,
  });
  const written = append(ledger, receipt);
  if (!written.ok) {
    return {
      ok: false,
      code: "receipt",
      reason: "The data was deleted, but the record of it could not be written.",
    };
  }
  return {
    ok: true,
    receipt,
    failed: [...status.entries()].filter(([, state]) => state === "failed").map(([kind]) => kind),
  };
}

/** Who did it, as a record may hold it: a principal's id, or the local user's keyed digest. */
async function storedActor(
  harnessDir: string,
  actor: ExecuteErasureOptions["actor"],
): Promise<string | undefined> {
  if (actor?.principal !== undefined) return actor.principal;
  if (actor?.local === undefined) return undefined;
  const key = await ensureDigestKey(harnessDir);
  return key.state === "present" ? storedLocalActor(key.hmac, actor.local) : undefined;
}

export type { ErasureGrant, ErasureScope };

/** The item id of a fact named by its own id, when exactly one fact store here holds it. */
export async function factItemId(
  harness: ErasureHarness,
  factId: string,
): Promise<string | undefined> {
  const read = readOf(harness);
  const found: string[] = [];
  for (const at of specStores(read)) {
    const facts = await loadSpecFacts(at);
    if (!facts.chainOf.has(factId)) continue;
    const id = formatKnowledgeId({
      store: "facts",
      spec: at.spec,
      ...(at.root.partition !== undefined ? { partition: at.root.partition } : {}),
      localId: factId,
    });
    if (id !== undefined) found.push(id);
  }
  return found.length === 1 ? found[0] : undefined;
}
