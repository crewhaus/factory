/**
 * The machine-wide harness registry — one JSON document
 * (`<registryRoot>/harnesses.json`, format v2) listing every harness the
 * user has registered on this machine, plus scan roots and group
 * definitions.
 *
 * Roots and switches:
 *   - registry root: `CREWHAUS_REGISTRY_ROOT` (the DIRECTORY containing
 *     `harnesses.json`), default `~/.crewhaus`; an explicit `root` option
 *     wins over the env var.
 *   - `CREWHAUS_NO_REGISTRY=1` — global opt-out: every write becomes a
 *     no-op while reads keep working.
 *
 * Write discipline (the watchme-store registry posture, promoted):
 *   - atomic tmp+rename with a per-writer-unique tmp name, file mode 0600,
 *     directory mode 0700;
 *   - read-merge-write with a small fingerprint-checked retry loop so two
 *     same-machine writers do not lose each other's rows;
 *   - vanished directories are NEVER silently pruned — `list()` stamps
 *     `missingSince` (and clears it when the dir is back), and only an
 *     explicit `remove()` deletes a row.
 *
 * watchme interop: `seedFromWatchme()` merges the legacy watchme registry
 * in once (idempotent, safe every boot), and `upsert`/`relocate` MIRROR
 * freshness (dir/specName/target) onto a watchme row that ALREADY exists,
 * best-effort. Hangar-side writes never create a watchme row, never delete
 * one, and never touch `share`/`agentId` — watchme membership means
 * "explicitly watched" and belongs to the watchme verbs (`watchme start`,
 * `watchme stop --forget`) alone. The mirror uses `@crewhaus/watchme-store`'s
 * own API — this package never touches the watchme file format directly.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { openHarnessRegistry as openWatchmeRegistry } from "@crewhaus/watchme-store";
import type { HarnessEntry as WatchmeHarnessEntry } from "@crewhaus/watchme-store";
import {
  EMPTY_DOC,
  HARNESS_ID_RE,
  REGISTRY_FILENAME,
  fingerprintPath,
  mintHarnessId,
  normalizeDoc,
  sleepSync,
  sortDoc,
} from "./doc.js";
import type {
  GroupDef,
  HangarHarnessEntry,
  HangarRegistryDoc,
  HarnessKind,
  HarnessOrigin,
  ScanRoot,
} from "./types.js";

export type OpenHangarRegistryOptions = {
  /** Directory containing `harnesses.json`. Wins over the env var. */
  readonly root?: string;
  /** Root of the legacy watchme registry (for seed + write-through).
   *  Default: `CREWHAUS_WATCHME_ROOT` or `~/.crewhaus/watchme`. */
  readonly watchmeRoot?: string;
  /** Clock (epoch ms); injected so tests are deterministic. */
  readonly now?: () => number;
  /** Environment to consult; defaults to `process.env`. When supplied it is
   *  used EXCLUSIVELY, so tests are isolated from the real environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Receives one line per best-effort failure (watchme write-through).
   *  Default: silent — hooks run on every CLI command and must stay quiet. */
  readonly onWarn?: (message: string) => void;
  /** Internal test seam: invoked after every document read inside the
   *  read-merge-write loop (used to exercise the concurrent-writer retry). */
  readonly hooks?: { readonly afterRead?: () => void };
};

/** Fields accepted by {@link HangarRegistry.upsert}. Only `dir` is
 *  required; callers supply `specName`/`target` (no spec parsing here). */
export type UpsertFields = {
  readonly dir: string;
  readonly specName?: string;
  readonly target?: string;
  /** Recorded on first registration only; refreshes never rewrite it. */
  readonly origin?: HarnessOrigin;
  readonly originDetail?: string;
  readonly kind?: HarnessKind;
  readonly watchme?: { readonly share: boolean };
  readonly remotes?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** Initial value for new entries; ignored on refresh (use `setGroups`). */
  readonly groups?: readonly string[];
  /** Initial value for new entries; ignored on refresh (use `setTags`). */
  readonly tags?: readonly string[];
  /** Initial value for new entries; ignored on refresh (use `setPinned`). */
  readonly pinned?: boolean;
  /** Initial value for new entries; ignored on refresh (use `setNotes`). */
  readonly notes?: string;
};

export type ListOptions = {
  /** Include entries whose dir is currently missing (default true — a
   *  vanished harness is surfaced with `missingSince`, never hidden). */
  readonly includeMissing?: boolean;
};

export type RegisterHookFields = {
  readonly dir: string;
  readonly specName?: string;
  readonly target?: string;
  /** Which command touched the harness, e.g. `run|compile|eval|dev`. */
  readonly originDetail: string;
};

export type RegisterHookResult = {
  readonly ok: boolean;
  readonly id?: string;
  readonly error?: string;
};

/**
 * A group's members in BOOT order.
 *
 * Two tiers, because a fleet is rarely fully ordered: everything with a
 * declared `groupOrder[group]` first, ascending, then everything without
 * one. Inside a tier the sort is by spec name — an arbitrary but STABLE
 * choice, so the same fleet walks the same way on every machine and a
 * `--group` start is reproducible rather than registry-insertion-ordered.
 */
export function sortGroupMembers(
  group: string,
  entries: readonly HangarHarnessEntry[],
): HangarHarnessEntry[] {
  return entries
    .filter((e) => e.groups.includes(group))
    .sort((a, b) => {
      const ao = a.groupOrder?.[group];
      const bo = b.groupOrder?.[group];
      if (ao !== bo) {
        if (ao === undefined) return 1;
        if (bo === undefined) return -1;
        return ao - bo;
      }
      return a.specName.localeCompare(b.specName) || a.dir.localeCompare(b.dir);
    });
}

export type HangarRegistry = {
  /** Absolute path of the registry file. */
  readonly path: string;
  /** True when `CREWHAUS_NO_REGISTRY` disabled all writes. */
  readonly disabled: boolean;
  /** All entries, missing-dir state freshly stamped (and persisted, along
   *  with any pending v1 lift, unless writes are disabled). An unwritable
   *  registry root degrades to the computed, un-persisted view (reported
   *  via `onWarn`) — a read surface never fails on a persist error. */
  list(opts?: ListOptions): HangarHarnessEntry[];
  /** Look up by absolute dir or `hrn_` id; liveness is recomputed for the
   *  returned entry but nothing is persisted. */
  get(dirOrId: string): HangarHarnessEntry | undefined;
  /** Upsert keyed by absolute dir. New entries mint a stable id; refreshes
   *  keep `id`/`registeredAt`/`origin` and the user-managed fields
   *  (groups/tags/pinned/notes), refresh `lastSeen` and any descriptive
   *  fields provided, and clear `missingSince`. */
  upsert(fields: UpsertFields): HangarHarnessEntry;
  /** Remove the registry row only — the directory is never touched. */
  remove(dirOrId: string): boolean;
  /** Point an entry at a new dir (same id), clearing `missingSince`.
   *  Throws if `newDir` is already registered to a different entry. */
  relocate(id: string, newDir: string): HangarHarnessEntry | undefined;
  setGroups(dirOrId: string, groups: readonly string[]): HangarHarnessEntry | undefined;
  /** Set (or, with `undefined`, clear) this member's boot order INSIDE one
   *  group. Independent of membership: an order for a group the entry does
   *  not belong to is simply never consulted. */
  setGroupOrder(
    dirOrId: string,
    group: string,
    order: number | undefined,
  ): HangarHarnessEntry | undefined;
  /** The members of a group in BOOT order: declared orders ascending first,
   *  then the undeclared ones, each tier by spec name so the walk is stable
   *  across machines. `stop` is this list reversed. */
  groupMembers(group: string, opts?: ListOptions): HangarHarnessEntry[];
  setTags(dirOrId: string, tags: readonly string[]): HangarHarnessEntry | undefined;
  setPinned(dirOrId: string, pinned: boolean): HangarHarnessEntry | undefined;
  /** Hide from (or return to) the manager's default Library view. The entry
   *  stays registered with all its state — hiding is curation, not removal. */
  setHidden(dirOrId: string, hidden: boolean): HangarHarnessEntry | undefined;
  setNotes(dirOrId: string, notes: string): HangarHarnessEntry | undefined;
  listGroups(): GroupDef[];
  /** Idempotent by name; new groups append at the end of the order. */
  addGroup(def: { readonly name: string; readonly color?: string }): GroupDef;
  /** Rename and/or recolor; a rename rewrites entry membership too.
   *  Throws when renaming onto an existing group. */
  updateGroup(
    name: string,
    patch: { readonly name?: string; readonly color?: string },
  ): GroupDef | undefined;
  /** Drops the definition AND strips the name from every entry. */
  removeGroup(name: string): boolean;
  /** Groups listed first in the given order, unlisted ones keep their
   *  relative order after; all orders renumbered 1..n. */
  reorderGroups(names: readonly string[]): GroupDef[];
  listScanRoots(): ScanRoot[];
  /** Upsert keyed by absolute dir. Defaults: depth 6, auto true,
   *  rescanIntervalMin 15, lastScanAt null. */
  addScanRoot(fields: {
    readonly dir: string;
    readonly depth?: number;
    readonly auto?: boolean;
    readonly rescanIntervalMin?: number;
  }): ScanRoot;
  updateScanRoot(
    dir: string,
    patch: Partial<Pick<ScanRoot, "depth" | "auto" | "rescanIntervalMin" | "lastScanAt">>,
  ): ScanRoot | undefined;
  removeScanRoot(dir: string): boolean;
  /** The best-effort self-registration entry point for CLI hooks: never
   *  throws, respects `CREWHAUS_NO_REGISTRY`, registers with origin
   *  `run-hook`. */
  registerHook(fields: RegisterHookFields): RegisterHookResult;
  /** One-time merge of the legacy watchme registry (idempotent — safe to
   *  call every boot; already-registered dirs are left untouched). Imported
   *  entries get origin `import` / originDetail `watchme`. */
  seedFromWatchme(): { imported: number };
};

/** Resolve the registry ROOT directory (the one containing
 *  `harnesses.json`): `CREWHAUS_REGISTRY_ROOT` or `~/.crewhaus`. */
export function resolveRegistryRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const fromEnv = env["CREWHAUS_REGISTRY_ROOT"];
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv);
  return join(homedir(), ".crewhaus");
}

const MAX_WRITE_ATTEMPTS = 5;

type ReadState = {
  readonly doc: HangarRegistryDoc;
  /** File existed on disk. */
  readonly existed: boolean;
  /** File parsed to a JSON object (a heal can preserve its content). */
  readonly healable: boolean;
  /** Persisting the normalized doc would change the schema (v1 lift or
   *  minted ids). */
  readonly lifted: boolean;
  readonly fp: string;
};

type MutationOutcome<T> = {
  readonly doc: HangarRegistryDoc;
  readonly result: T;
  readonly write: boolean;
};
type Mutation<T> = (state: ReadState) => MutationOutcome<T>;

/** Open the registry (file created lazily on first write). */
export function openHangarRegistry(opts: OpenHangarRegistryOptions = {}): HangarRegistry {
  const env = opts.env ?? process.env;
  const root = opts.root !== undefined ? resolve(opts.root) : resolveRegistryRoot(env);
  const watchmeEnv = env["CREWHAUS_WATCHME_ROOT"];
  const watchmeRoot =
    opts.watchmeRoot ??
    (watchmeEnv !== undefined && watchmeEnv.length > 0
      ? resolve(watchmeEnv)
      : join(homedir(), ".crewhaus", "watchme"));
  const noRegistry = env["CREWHAUS_NO_REGISTRY"];
  const disabled = noRegistry === "1" || noRegistry === "true";
  const path = join(root, REGISTRY_FILENAME);
  const now = opts.now ?? Date.now;
  const onWarn = opts.onWarn ?? (() => {});
  const afterRead = opts.hooks?.afterRead;

  const nowIso = (): string => new Date(now()).toISOString();

  // Ids minted for a dir stay stable within this handle even before they
  // are persisted (e.g. repeated reads of a v1 doc under NO_REGISTRY).
  const mintCache = new Map<string, string>();
  const mint = (dir: string, taken: Set<string>): string => {
    const cached = mintCache.get(dir);
    if (cached !== undefined && !taken.has(cached)) {
      taken.add(cached);
      return cached;
    }
    const id = mintHarnessId(taken);
    taken.add(id);
    mintCache.set(dir, id);
    return id;
  };

  const read = (): ReadState => {
    const fp = fingerprintPath(path);
    let existed = false;
    let healable = false;
    let parsed: unknown;
    try {
      const text = readFileSync(path, "utf8");
      existed = true;
      parsed = JSON.parse(text) as unknown;
      healable = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    } catch {
      // Missing file → empty registry; unreadable/garbage file → empty view,
      // healed wholesale by the next write (watchme posture — never healed
      // by a read, in case the content is hand-recoverable).
      parsed = undefined;
    }
    const { doc, lifted } = healable
      ? normalizeDoc(parsed, { nowIso: nowIso(), mint })
      : { doc: EMPTY_DOC, lifted: false };
    afterRead?.();
    return { doc, existed, healable, lifted, fp };
  };

  const writeDoc = (doc: HangarRegistryDoc): void => {
    if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
    // Per-writer-unique tmp name: two concurrent writers must never share a
    // staging file, or one could rename the other's half-written content.
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(sortDoc(doc), null, 2)}\n`, { mode: 0o600 });
    try {
      renameSync(tmp, path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort tmp cleanup; the original error is what matters.
      }
      throw err;
    }
  };

  /** Read-merge-write with a fingerprint-checked retry loop: if another
   *  writer landed between our read and our rename, re-read and re-apply
   *  rather than clobbering their rows. Disabled mode computes the result
   *  against the current file but never writes. `degradeOnWriteError` is for
   *  read-triggered persists (list()'s stamp/lift heals): a failing write
   *  (EROFS, EACCES, ENOSPC) warns and returns the computed view un-persisted
   *  — mirroring the disabled path — instead of failing a semantic read. */
  const mutate = <T>(
    fn: Mutation<T>,
    mutateOpts: { readonly degradeOnWriteError?: boolean } = {},
  ): { result: T; wrote: boolean } => {
    if (disabled) {
      const out = fn(read());
      return { result: out.result, wrote: false };
    }
    const tryWrite = (doc: HangarRegistryDoc): boolean => {
      try {
        writeDoc(doc);
        return true;
      } catch (err) {
        if (mutateOpts.degradeOnWriteError !== true) throw err;
        onWarn(
          `harness-registry: could not persist to ${path} (continuing with the un-persisted view): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return false;
      }
    };
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const state = read();
      const out = fn(state);
      if (!out.write) return { result: out.result, wrote: false };
      if (fingerprintPath(path) !== state.fp) {
        sleepSync(1 + attempt * 2);
        continue;
      }
      return { result: out.result, wrote: tryWrite(out.doc) };
    }
    // Contention exhausted the retries: land last-writer-wins on a final
    // fresh read (still merge-based, so only same-instant races can lose).
    const state = read();
    const out = fn(state);
    if (!out.write) return { result: out.result, wrote: false };
    return { result: out.result, wrote: tryWrite(out.doc) };
  };

  const findEntry = (doc: HangarRegistryDoc, dirOrId: string): HangarHarnessEntry | undefined =>
    HARNESS_ID_RE.test(dirOrId)
      ? doc.harnesses.find((e) => e.id === dirOrId)
      : doc.harnesses.find((e) => e.dir === resolve(dirOrId));

  const replaceEntry = (doc: HangarRegistryDoc, entry: HangarHarnessEntry): HangarRegistryDoc => ({
    ...doc,
    harnesses: [...doc.harnesses.filter((e) => e.id !== entry.id), entry],
  });

  // ---- watchme mirror (best-effort, never fails the primary write) --------

  const watchme = (): ReturnType<typeof openWatchmeRegistry> =>
    openWatchmeRegistry(watchmeRoot, { now, onWarn: () => {} });

  const warnInterop = (op: string, err: unknown): void =>
    onWarn(
      `harness-registry: watchme ${op} write-through failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );

  /**
   * Freshness-only mirror: refresh the dir/specName/target of a watchme row
   * that ALREADY exists, and nothing else. A hangar-side write never CREATES
   * a watchme row (membership means "explicitly watched" — only the watchme
   * verbs enroll, so `watchme stop --forget` stays durable) and never
   * touches `share`/`agentId` (those belong to the watchme verbs too — a
   * fresh hangar row defaulting share:false must not clobber an enrolled
   * share:true). `previousDir` handles relocate: the pre-existing row is
   * looked up at the OLD dir and moved.
   */
  const watchmeRefresh = (entry: HangarHarnessEntry, previousDir?: string): void => {
    try {
      const reg = watchme();
      const fromDir = previousDir ?? entry.dir;
      const prev = reg.list().find((e) => e.dir === fromDir);
      if (prev === undefined) return; // never explicitly watched — never create
      if (previousDir !== undefined && previousDir !== entry.dir) reg.deregister(previousDir);
      reg.register({
        dir: entry.dir,
        specName: entry.specName,
        target: entry.target,
        ...(prev.share !== undefined ? { share: prev.share } : {}),
        ...(prev.agentId !== undefined ? { agentId: prev.agentId } : {}),
      });
    } catch (err) {
      warnInterop("register", err);
    }
  };

  // ---- API ----------------------------------------------------------------

  const list = (listOpts: ListOptions = {}): HangarHarnessEntry[] => {
    const includeMissing = listOpts.includeMissing !== false;
    const stampIso = nowIso();
    const { result } = mutate<HangarHarnessEntry[]>(
      (state) => {
        let stampsChanged = false;
        const entries = state.doc.harnesses.map((entry) => {
          const alive = existsSync(entry.dir);
          if (!alive && entry.missingSince === null) {
            stampsChanged = true;
            return { ...entry, missingSince: stampIso };
          }
          if (alive && entry.missingSince !== null) {
            stampsChanged = true;
            return { ...entry, missingSince: null };
          }
          return entry;
        });
        // Persist when stamps moved, or to heal a pre-v2 / id-less document.
        // A registry that has never been written is NOT created by a read.
        const write = stampsChanged || (state.existed && state.healable && state.lifted);
        return { doc: { ...state.doc, harnesses: entries }, result: entries, write };
        // degrade: list() is semantically a READ — an unwritable registry root
        // (root-owned ~/.crewhaus, read-only home fs, disk full) must not take
        // down every read surface just because a stamp/lift wanted persisting.
      },
      { degradeOnWriteError: true },
    );
    const sorted = [...result].sort((a, b) => a.dir.localeCompare(b.dir));
    return includeMissing ? sorted : sorted.filter((e) => e.missingSince === null);
  };

  const get = (dirOrId: string): HangarHarnessEntry | undefined => {
    const entry = findEntry(read().doc, dirOrId);
    if (entry === undefined) return undefined;
    const alive = existsSync(entry.dir);
    if (!alive && entry.missingSince === null) return { ...entry, missingSince: nowIso() };
    if (alive && entry.missingSince !== null) return { ...entry, missingSince: null };
    return entry;
  };

  const upsert = (fields: UpsertFields): HangarHarnessEntry => {
    const dir = resolve(fields.dir);
    const stampIso = nowIso();
    const { result, wrote } = mutate<HangarHarnessEntry>((state) => {
      const existing = state.doc.harnesses.find((e) => e.dir === dir);
      let entry: HangarHarnessEntry;
      if (existing !== undefined) {
        entry = {
          ...existing,
          specName: fields.specName ?? existing.specName,
          target: fields.target ?? existing.target,
          kind: fields.kind ?? existing.kind,
          watchme:
            fields.watchme !== undefined
              ? { ...existing.watchme, share: fields.watchme.share }
              : existing.watchme,
          remotes: fields.remotes !== undefined ? [...fields.remotes] : existing.remotes,
          lastSeen: stampIso,
          missingSince: null,
        };
      } else {
        const taken = new Set(state.doc.harnesses.map((e) => e.id));
        entry = {
          id: mint(dir, taken),
          dir,
          specName: fields.specName ?? basename(dir),
          target: fields.target ?? "unknown",
          origin: fields.origin ?? "manual",
          originDetail: fields.originDetail ?? "",
          registeredAt: stampIso,
          lastSeen: stampIso,
          groups: [...(fields.groups ?? [])],
          tags: [...(fields.tags ?? [])],
          pinned: fields.pinned ?? false,
          hidden: false,
          notes: fields.notes ?? "",
          kind: fields.kind ?? "local",
          watchme: { share: fields.watchme?.share ?? false },
          remotes: fields.remotes !== undefined ? [...fields.remotes] : [],
          missingSince: null,
        };
      }
      return {
        doc: {
          ...state.doc,
          harnesses: [...state.doc.harnesses.filter((e) => e.dir !== dir), entry],
        },
        result: entry,
        write: true,
      };
    });
    if (wrote) watchmeRefresh(result);
    return result;
  };

  const remove = (dirOrId: string): boolean => {
    const { result, wrote } = mutate<HangarHarnessEntry | undefined>((state) => {
      const entry = findEntry(state.doc, dirOrId);
      if (entry === undefined) return { doc: state.doc, result: undefined, write: false };
      return {
        doc: { ...state.doc, harnesses: state.doc.harnesses.filter((e) => e.id !== entry.id) },
        result: entry,
        write: true,
      };
    });
    // Deliberately NO watchme mirror: removing a hangar row never
    // un-watches a harness the user explicitly enrolled.
    return wrote && result !== undefined;
  };

  const relocate = (id: string, newDir: string): HangarHarnessEntry | undefined => {
    const dir = resolve(newDir);
    const stampIso = nowIso();
    let oldDir: string | undefined;
    const { result, wrote } = mutate<HangarHarnessEntry | undefined>((state) => {
      const entry = state.doc.harnesses.find((e) => e.id === id);
      if (entry === undefined) return { doc: state.doc, result: undefined, write: false };
      const conflict = state.doc.harnesses.find((e) => e.dir === dir && e.id !== id);
      if (conflict !== undefined) {
        throw new Error(
          `harness-registry: cannot relocate ${id} to ${dir} — already registered as ${conflict.id}`,
        );
      }
      oldDir = entry.dir;
      const next = { ...entry, dir, missingSince: null, lastSeen: stampIso };
      return { doc: replaceEntry(state.doc, next), result: next, write: true };
    });
    if (wrote && result !== undefined && oldDir !== undefined && oldDir !== result.dir) {
      // Move a PRE-EXISTING watchme row along with the relocate (a dir
      // refresh of an explicitly-watched harness); never creates one.
      watchmeRefresh(result, oldDir);
    }
    return result;
  };

  const patchEntry = (
    dirOrId: string,
    patch: (entry: HangarHarnessEntry) => HangarHarnessEntry,
  ): HangarHarnessEntry | undefined => {
    const { result } = mutate<HangarHarnessEntry | undefined>((state) => {
      const entry = findEntry(state.doc, dirOrId);
      if (entry === undefined) return { doc: state.doc, result: undefined, write: false };
      const next = patch(entry);
      return { doc: replaceEntry(state.doc, next), result: next, write: true };
    });
    return result;
  };

  const mutateGroups = <T>(
    fn: (
      groups: readonly GroupDef[],
      state: ReadState,
    ) => {
      readonly groups: readonly GroupDef[];
      readonly harnesses?: readonly HangarHarnessEntry[];
      readonly result: T;
      readonly write: boolean;
    },
  ): T => {
    const { result } = mutate<T>((state) => {
      const out = fn(state.doc.groups, state);
      return {
        doc: {
          ...state.doc,
          groups: [...out.groups],
          harnesses: out.harnesses !== undefined ? [...out.harnesses] : state.doc.harnesses,
        },
        result: out.result,
        write: out.write,
      };
    });
    return result;
  };

  const addGroup = (def: { readonly name: string; readonly color?: string }): GroupDef =>
    mutateGroups<GroupDef>((groups) => {
      const existing = groups.find((g) => g.name === def.name);
      if (existing !== undefined) {
        if (def.color !== undefined && def.color !== existing.color) {
          const next = { ...existing, color: def.color };
          return {
            groups: groups.map((g) => (g.name === def.name ? next : g)),
            result: next,
            write: true,
          };
        }
        return { groups, result: existing, write: false };
      }
      const order = groups.reduce((max, g) => Math.max(max, g.order), 0) + 1;
      const next: GroupDef = { name: def.name, order, color: def.color ?? "" };
      return { groups: [...groups, next], result: next, write: true };
    });

  const updateGroup = (
    name: string,
    patch: { readonly name?: string; readonly color?: string },
  ): GroupDef | undefined =>
    mutateGroups<GroupDef | undefined>((groups, state) => {
      const existing = groups.find((g) => g.name === name);
      if (existing === undefined) return { groups, result: undefined, write: false };
      const nextName = patch.name ?? existing.name;
      if (nextName !== name && groups.some((g) => g.name === nextName)) {
        throw new Error(`harness-registry: group "${nextName}" already exists`);
      }
      const next: GroupDef = { ...existing, name: nextName, color: patch.color ?? existing.color };
      const harnesses =
        nextName === name
          ? undefined
          : state.doc.harnesses.map((e) =>
              e.groups.includes(name)
                ? { ...e, groups: e.groups.map((g) => (g === name ? nextName : g)) }
                : e,
            );
      return {
        groups: groups.map((g) => (g.name === name ? next : g)),
        ...(harnesses !== undefined ? { harnesses } : {}),
        result: next,
        write: true,
      };
    });

  const removeGroup = (name: string): boolean =>
    mutateGroups<boolean>((groups, state) => {
      if (!groups.some((g) => g.name === name)) return { groups, result: false, write: false };
      const harnesses = state.doc.harnesses.map((e) =>
        e.groups.includes(name) ? { ...e, groups: e.groups.filter((g) => g !== name) } : e,
      );
      return {
        groups: groups.filter((g) => g.name !== name),
        harnesses,
        result: true,
        write: true,
      };
    });

  const reorderGroups = (names: readonly string[]): GroupDef[] =>
    mutateGroups<GroupDef[]>((groups) => {
      const byOrder = [...groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      const listed = names
        .map((name) => byOrder.find((g) => g.name === name))
        .filter((g): g is GroupDef => g !== undefined);
      const rest = byOrder.filter((g) => !names.includes(g.name));
      const next = [...listed, ...rest].map((g, index) => ({ ...g, order: index + 1 }));
      return { groups: next, result: next, write: next.length > 0 };
    });

  const listGroups = (): GroupDef[] =>
    [...read().doc.groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  const addScanRoot = (fields: {
    readonly dir: string;
    readonly depth?: number;
    readonly auto?: boolean;
    readonly rescanIntervalMin?: number;
  }): ScanRoot => {
    const dir = resolve(fields.dir);
    const { result } = mutate<ScanRoot>((state) => {
      const existing = state.doc.scanRoots.find((r) => r.dir === dir);
      const next: ScanRoot =
        existing !== undefined
          ? {
              ...existing,
              depth: fields.depth ?? existing.depth,
              auto: fields.auto ?? existing.auto,
              rescanIntervalMin: fields.rescanIntervalMin ?? existing.rescanIntervalMin,
            }
          : {
              dir,
              depth: fields.depth ?? 6,
              auto: fields.auto ?? true,
              rescanIntervalMin: fields.rescanIntervalMin ?? 15,
              lastScanAt: null,
            };
      return {
        doc: {
          ...state.doc,
          scanRoots: [...state.doc.scanRoots.filter((r) => r.dir !== dir), next],
        },
        result: next,
        write: true,
      };
    });
    return result;
  };

  const updateScanRoot = (
    dirRaw: string,
    patch: Partial<Pick<ScanRoot, "depth" | "auto" | "rescanIntervalMin" | "lastScanAt">>,
  ): ScanRoot | undefined => {
    const dir = resolve(dirRaw);
    const { result } = mutate<ScanRoot | undefined>((state) => {
      const existing = state.doc.scanRoots.find((r) => r.dir === dir);
      if (existing === undefined) return { doc: state.doc, result: undefined, write: false };
      const next: ScanRoot = {
        ...existing,
        depth: patch.depth ?? existing.depth,
        auto: patch.auto ?? existing.auto,
        rescanIntervalMin: patch.rescanIntervalMin ?? existing.rescanIntervalMin,
        lastScanAt: patch.lastScanAt !== undefined ? patch.lastScanAt : existing.lastScanAt,
      };
      return {
        doc: {
          ...state.doc,
          scanRoots: state.doc.scanRoots.map((r) => (r.dir === dir ? next : r)),
        },
        result: next,
        write: true,
      };
    });
    return result;
  };

  const removeScanRoot = (dirRaw: string): boolean => {
    const dir = resolve(dirRaw);
    const { result } = mutate<boolean>((state) => {
      if (!state.doc.scanRoots.some((r) => r.dir === dir)) {
        return { doc: state.doc, result: false, write: false };
      }
      return {
        doc: { ...state.doc, scanRoots: state.doc.scanRoots.filter((r) => r.dir !== dir) },
        result: true,
        write: true,
      };
    });
    return result;
  };

  const listScanRoots = (): ScanRoot[] =>
    [...read().doc.scanRoots].sort((a, b) => a.dir.localeCompare(b.dir));

  const registerHook = (fields: RegisterHookFields): RegisterHookResult => {
    try {
      if (disabled) return { ok: false, error: "registry disabled (CREWHAUS_NO_REGISTRY)" };
      const entry = upsert({
        dir: fields.dir,
        specName: fields.specName,
        target: fields.target,
        origin: "run-hook",
        originDetail: fields.originDetail,
      });
      return { ok: true, id: entry.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const seedFromWatchme = (): { imported: number } => {
    if (disabled) return { imported: 0 };
    let source: WatchmeHarnessEntry[];
    try {
      source = watchme().list();
    } catch (err) {
      warnInterop("seed", err);
      return { imported: 0 };
    }
    if (source.length === 0) return { imported: 0 };
    const { result } = mutate<number>((state) => {
      const have = new Set(state.doc.harnesses.map((e) => e.dir));
      const taken = new Set(state.doc.harnesses.map((e) => e.id));
      const added: HangarHarnessEntry[] = [];
      for (const src of source) {
        const dir = resolve(src.dir);
        if (have.has(dir)) continue;
        have.add(dir);
        added.push({
          id: mint(dir, taken),
          dir,
          specName: src.specName,
          target: src.target,
          origin: "import",
          originDetail: "watchme",
          registeredAt: new Date(src.registeredAt).toISOString(),
          lastSeen: new Date(src.lastSeen).toISOString(),
          groups: [],
          tags: [],
          pinned: false,
          hidden: false,
          notes: "",
          kind: "local",
          watchme: { share: src.share === true },
          remotes: [],
          missingSince: null,
          // Kept as a pass-through field so a later delegation round-trips it.
          ...(src.agentId !== undefined ? { agentId: src.agentId } : {}),
        });
      }
      if (added.length === 0) return { doc: state.doc, result: 0, write: false };
      return {
        doc: { ...state.doc, harnesses: [...state.doc.harnesses, ...added] },
        result: added.length,
        write: true,
      };
    });
    return { imported: result };
  };

  return {
    path,
    disabled,
    list,
    get,
    upsert,
    remove,
    relocate,
    setGroups: (dirOrId, groups) => patchEntry(dirOrId, (e) => ({ ...e, groups: [...groups] })),
    setGroupOrder: (dirOrId, group, order) =>
      patchEntry(dirOrId, (e) => {
        const next: Record<string, number> = { ...(e.groupOrder ?? {}) };
        // An absent key, not a key holding undefined: this object is written
        // to JSON, where the two are the same thing on read and different on
        // write.
        if (order === undefined) delete next[group];
        else next[group] = order;
        if (Object.keys(next).length === 0) {
          const { groupOrder: _dropped, ...rest } = e;
          return rest as HangarHarnessEntry;
        }
        return { ...e, groupOrder: next };
      }),
    groupMembers: (group, opts) => sortGroupMembers(group, list(opts)),
    setTags: (dirOrId, tags) => patchEntry(dirOrId, (e) => ({ ...e, tags: [...tags] })),
    setPinned: (dirOrId, pinned) => patchEntry(dirOrId, (e) => ({ ...e, pinned })),
    setHidden: (dirOrId, hidden) => patchEntry(dirOrId, (e) => ({ ...e, hidden })),
    setNotes: (dirOrId, notes) => patchEntry(dirOrId, (e) => ({ ...e, notes })),
    listGroups,
    addGroup,
    updateGroup,
    removeGroup,
    reorderGroups,
    listScanRoots,
    addScanRoot,
    updateScanRoot,
    removeScanRoot,
    registerHook,
    seedFromWatchme,
  };
}

/**
 * The ~10-line CLI-hook entry point: open the default registry and record
 * that a command touched `dir`. Never throws — any failure (including a
 * broken registry root) is swallowed into `{ ok: false }`, because a
 * registry write must never fail the command that triggered it. Respects
 * `CREWHAUS_NO_REGISTRY`.
 */
export function registerHarnessHook(
  fields: RegisterHookFields,
  opts: OpenHangarRegistryOptions = {},
): RegisterHookResult {
  try {
    return openHangarRegistry(opts).registerHook(fields);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
