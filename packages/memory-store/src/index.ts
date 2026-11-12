/**
 * Catalog R7 sibling — `memory-store` (M4.2 of the heavy-hitter plan).
 *
 * Persistent cross-session memory: a file-backed JSONL store of facts
 * the user wants the agent to remember across sessions. Each entry
 * carries text + optional tags + a created-at timestamp. Recall does a
 * BM25-style ranking over the tokenized text.
 *
 * Why JSONL: matches event-log and session-store; trivial to inspect
 * with `tail`/`jq`; append-only writes are crash-safe; small enough
 * working sets (< 10k entries per spec) that an in-memory load on each
 * `recall()` call is fine.
 *
 * Why simple BM25 instead of embeddings: zero deps, deterministic for
 * tests, and the working set is small. When a user grows into a much
 * larger memory bank, swap the search backend behind the `MemoryStore`
 * interface — `recall()` is the only consumer-visible signature. As a
 * middle step, `createMemoryStore({ embedder })` upgrades recall to a
 * hybrid BM25 + embedding-similarity ranking (see "Hybrid recall").
 *
 * File path: `<rootDir>/<specName>.jsonl` where rootDir defaults to
 * `.crewhaus/memories/`. One file per spec keeps memories scoped.
 *
 * ## Schema v2 (0.3.0 memory release, design §3.4)
 *
 * New writes stamp `schemaVersion: 2` and may carry three additive
 * fields: `expiresAt` (epoch ms — explicit forgetting via TTL),
 * `supersededBy` (entry id — supersede, never delete), and
 * `provenance {sessionId?, evidence?: toolUseId[]}` (where a fact came
 * from and which tool runs prove it). Lines without `schemaVersion`
 * are v1 entries and are read untouched — old readers skip unknown
 * fields, new readers accept v1 lines as-is, so mixed files work in
 * both directions.
 *
 * ## Explicit forgetting (append-only tombstones)
 *
 * The file stays append-only: `forget()` and `sweep()` never rewrite
 * lines — they append tombstone lines (`{tombstone: "superseded" |
 * "expired", target: <id>, at, …}`) that the reader folds over the
 * entries. `recall()`/`size()` see only live entries. `compact()` is
 * the growth-bounding primitive (closes TODO #53 F7): it rewrites the
 * file atomically (tmp + rename) without tombstoned/expired entries,
 * the tombstone lines themselves and annotations of dead entries, and
 * moves every line it removes to the archive (below); parseable lines it
 * does not recognise (future line kinds) are preserved verbatim.
 *
 * ## Corrections, annotations and the archive (history is never rewritten)
 *
 * `supersede()` replaces a live fact with a corrected one: one append holds
 * the successor (its `provenance.correctionOf` names the old id) and the
 * old fact's tombstone (its `supersededBy` names the successor).
 * `annotate()` appends a `{annotate: "category", target, value}` line that
 * `list()` folds last-wins. `compact()` appends every line it drops to
 * `<rootDir>/archive/<spec>/NNNNNN.jsonl` (rolling segments) before the live
 * file is replaced, and `history()` reads them back, oldest first.
 *
 * Every write takes one lock, `<rootDir>/.<spec>.lock`, so a compaction
 * never loses a fact remembered while it ran. The dot-name and the
 * `archive/` directory are invisible to readers that list `*.jsonl`.
 *
 * ## Hybrid recall (design §3.4)
 *
 * With no `embedder` option, recall is byte-identical to the v1
 * BM25-only ranking (the regression-guarded default). With an
 * `embedder` (structurally compatible with `@crewhaus/embedder`'s
 * `Embedder`; use `mock/…` for offline tests), recall becomes a
 * reciprocal-rank fusion (RRF, k=60) of the BM25 ranking and a
 * cosine-similarity ranking over embeddings of `text + tags`.
 * Tool-grounded facts — entries whose `provenance.evidence` is
 * non-empty — receive a documented rank boost in the fused score: one
 * extra reciprocal-rank vote at rank 1 (`1/(60+1)`), as if a third
 * ranker had put every proof-backed fact first. This is the design's
 * write-path-governance rule: facts proven by tool runs outrank
 * pure-text claims of equal textual relevance.
 */
import { closeSync, existsSync, mkdirSync, readSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Ledger, type LockedAppend, withLedgerLock } from "@crewhaus/control-records";
import { CrewhausError } from "@crewhaus/errors";
import {
  appendContained,
  openForRead,
  openForReadFd,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";

export const DEFAULT_ROOT_DIR = ".crewhaus/memories";

/**
 * The most of a memory file the store reads, capped before anything is
 * buffered. Far past the working set the store is designed for; a file this
 * large is refused with the command that shrinks it, never read in part.
 */
export const MEMORY_FILE_MAX_BYTES = 512 * 1024 * 1024;

/** Schema version stamped on every new write. Absent = v1 (read lazily). */
export const MEMORY_SCHEMA_VERSION = 2;

/** Who wrote a fact: a person, the agent, the extractor or a knowledge sync. */
export type MemoryAuthor = {
  readonly kind: "operator" | "agent" | "extractor" | "sync";
  /** How it arrived, such as `"cli"`. */
  readonly via?: string;
  /** The command that wrote it, when one was recorded. */
  readonly cmd?: string;
};

/** Where a pulled fact came from: the harness that shared it, and its content hash. */
export type MemorySyncOrigin = {
  readonly kind: "sync";
  readonly harness: string;
  /** The fact's id in the harness that shared it, when known. */
  readonly fact?: string;
  readonly contentHash: string;
};

/** Where a memory came from, and which tool runs prove it (toolUseIds). */
export type MemoryProvenance = {
  readonly sessionId?: string;
  /** toolUseIds from the source session's event log — proof the fact is
   *  grounded in tool results, not just assistant narration. */
  readonly evidence?: readonly string[];
  /** The id of the fact this one corrects (set by `supersede`). */
  readonly correctionOf?: string;
  readonly author?: MemoryAuthor;
  /** Set on a fact a knowledge sync pulled in from another harness. */
  readonly origin?: MemorySyncOrigin;
};

export type MemoryEntry = {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly createdAt: string;
  /** 2 on new writes; absent = v1 entry (read untouched). */
  readonly schemaVersion?: number;
  /** Epoch ms after which the entry is expired (filtered from recall). */
  readonly expiresAt?: number;
  /** Entry id that supersedes this one (folded from tombstones at read). */
  readonly supersededBy?: string;
  readonly provenance?: MemoryProvenance;
};

/** Lifecycle status of an entry, materialized at read time. */
export type MemoryEntryStatus = "live" | "superseded" | "expired";

/** The one category an annotation can set today: the fact is about a person. */
export type MemoryCategory = "person";

export type MemoryListItem = {
  readonly entry: MemoryEntry;
  readonly status: MemoryEntryStatus;
  /** Folded last-wins from `annotate()` lines; absent when none set one. */
  readonly category?: MemoryCategory;
};

export type MemoryRecallResult = {
  readonly entry: MemoryEntry;
  /** BM25 score (no embedder) or fused RRF score (hybrid recall). */
  readonly score: number;
};

/**
 * Minimal structural interface for the hybrid-recall embedder. The
 * `@crewhaus/embedder` package's `Embedder` satisfies it (use
 * `createEmbedder({ model: "mock/deterministic" })` for offline tests).
 * Declared structurally here so memory-store keeps zero runtime deps.
 */
export interface MemoryEmbedder {
  embed(texts: ReadonlyArray<string>): Promise<number[][]>;
  /** `@crewhaus/embedder`'s provider id. Only `"mock"` is known to stay in
   *  the process; see {@link embedderLeavesProcess}. */
  readonly provider?: string;
}

/**
 * Whether calling this embedder sends text out of the process. Only
 * `@crewhaus/embedder`'s `mock` provider is known not to; every other
 * provider (openai, voyage, cohere, gemini, a `local/…@http://…` server) is
 * an HTTP call, and a structural embedder that does not say what it is
 * counts as one too, so an unknown embedder never makes a tool look local.
 */
export function embedderLeavesProcess(embedder: MemoryEmbedder | undefined): boolean {
  return embedder !== undefined && embedder.provider !== "mock";
}

export interface MemoryStoreOptions {
  readonly rootDir?: string;
  readonly specName: string;
  readonly now?: () => Date;
  /**
   * Optional embedder enabling hybrid BM25 + embedding recall (RRF).
   * Absent → BM25-only ranking, byte-identical to the pre-v2 behavior.
   */
  readonly embedder?: MemoryEmbedder;
}

export type RememberOptions = {
  /** Time-to-live in ms; the entry expires at `now + ttlMs`. */
  readonly ttlMs?: number;
  readonly provenance?: MemoryProvenance;
};

export type ForgetOptions = {
  /** Recorded on the tombstone line for later audit. */
  readonly reason?: string;
  /** The id of the fact that replaces the forgotten one, as a structured link. */
  readonly supersededBy?: string;
  /** Who forgot it, recorded on the tombstone. */
  readonly by?: string;
  /** The command that forgot it, recorded on the tombstone. */
  readonly cmd?: string;
};

export type SupersedeOptions = {
  /** The successor's tags; default the old fact's tags. */
  readonly tags?: readonly string[];
  /** Why the fact was corrected, recorded on the tombstone. */
  readonly reason: string;
  /** Stamped into the successor's `provenance.author`. */
  readonly author?: MemoryAuthor;
  /** Further provenance for the successor (`correctionOf` and `author` are set here). */
  readonly provenance?: MemoryProvenance;
  /** Recorded on the tombstone. */
  readonly by?: string;
  /** Recorded on the tombstone. */
  readonly cmd?: string;
};

export type SupersedeResult = {
  /** The new, live fact. */
  readonly successor: MemoryEntry;
  /** The old fact, now superseded by `successor`. */
  readonly superseded: MemoryEntry;
};

export type AnnotateOptions = {
  /** `"person"` marks a fact as personal; `null` clears the mark. */
  readonly category: MemoryCategory | null;
};

/** An append-only annotation line, folded last-wins over its target entry. */
export type MemoryAnnotation = {
  readonly annotate: "category";
  readonly target: string;
  readonly value: MemoryCategory | null;
  readonly at: string;
  readonly schemaVersion: number;
};

/** One line compaction moved out of the live file, as `history()` returns it. */
export type MemoryArchivedLine = {
  readonly v: 1;
  readonly archivedAt: string;
  readonly cause: "compaction";
  /** The parsed line: an entry, a tombstone or an annotation. */
  readonly line?: unknown;
  /** An unparseable line's text, kept as it was. */
  readonly raw?: string;
};

export type SweepResult = {
  /** Entries newly tombstoned as expired by this sweep. */
  readonly swept: number;
  /** Live entries remaining after the sweep. */
  readonly live: number;
};

export type CompactResult = {
  /** Lines kept (live entries + preserved unknown lines). */
  readonly kept: number;
  /** Lines dropped (dead entries, tombstones, unparseable lines). */
  readonly dropped: number;
  /** Lines appended to the archive: every dropped line. */
  readonly archived: number;
};

export interface MemoryStore {
  /** Append a new memory. Returns the assigned entry. */
  remember(text: string, tags?: readonly string[], opts?: RememberOptions): Promise<MemoryEntry>;
  /** Top-k matches for the query. Superseded/expired entries are filtered.
   *  BM25-ranked without an embedder; hybrid RRF-ranked with one. */
  recall(query: string, k?: number): Promise<readonly MemoryRecallResult[]>;
  /**
   * Explicit forgetting. `idOrQuery` that looks like an entry id
   * (`mem_<16hex>`) tombstones exactly that entry (no text fallback — a
   * missing id forgets nothing); anything else is a query and tombstones
   * every live entry with a positive BM25 match (the same match set
   * `recall(query, Infinity)` would return). The file stays append-only:
   * a supersede tombstone line is appended per forgotten entry. Returns
   * the entries that were forgotten.
   */
  forget(idOrQuery: string, opts?: ForgetOptions): Promise<readonly MemoryEntry[]>;
  /**
   * TTL sweep: appends an `expired` tombstone for every live entry whose
   * `expiresAt` has passed. Deterministic and idempotent — re-running at
   * the same time appends nothing new.
   */
  sweep(nowMs?: number): Promise<SweepResult>;
  /**
   * Growth-bounding rewrite (TODO #53 F7): drops tombstoned/expired
   * entries, tombstone lines and annotations of dead entries, preserving
   * live entries (v1 lines untouched) and parseable-but-unknown lines
   * verbatim. Every dropped line is appended to the archive first, and a
   * line appended while it ran is kept. Atomic via tmp + rename.
   */
  compact(): Promise<CompactResult>;
  /**
   * Correct a live fact: append its successor and the old fact's tombstone in
   * one write. Refuses a fact that is not live with {@link MemoryNotLiveError}
   * and an unknown id with {@link MemoryNotFoundError}. A re-run after a torn
   * write finds the successor it already appended and adds only the tombstone.
   */
  supersede(id: string, text: string, opts: SupersedeOptions): Promise<SupersedeResult>;
  /** Mark (or unmark) a fact as personal. Refuses an unknown id with {@link MemoryNotFoundError}. */
  annotate(id: string, opts: AnnotateOptions): Promise<void>;
  /** Every line compaction archived, oldest first, a line archived twice read once. */
  history(): Promise<readonly MemoryArchivedLine[]>;
  /**
   * Append each given entry whose id is not already in the file (live or dead),
   * in one write. Returns the ids it added. The knowledge sync's pull uses it.
   */
  importSynced(entries: ReadonlyArray<MemoryEntry>): Promise<readonly string[]>;
  /** Every entry in file order with its materialized lifecycle status. */
  list(): Promise<readonly MemoryListItem[]>;
  /** Diagnostic: how many LIVE entries are stored. */
  size(): Promise<number>;
  /** Diagnostic: where on disk this store writes. */
  path(): string;
  /**
   * True when `recall()` sends the query, and the text of stored memories,
   * to an embedder outside the process (see {@link embedderLeavesProcess}).
   * `@crewhaus/tool-memory` reads it to flag `Recall` as a network tool.
   * Optional so a hand-written store still type-checks; absent reads as a
   * store that never leaves the process.
   */
  readonly embedderLeavesProcess?: boolean;
}

export class MemoryStoreError extends CrewhausError {
  override readonly name: string = "MemoryStoreError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/** A correction or forget aimed at a fact that is already superseded or expired. */
export class MemoryNotLiveError extends MemoryStoreError {
  override readonly name = "MemoryNotLiveError";
  readonly id: string;
  readonly status: Exclude<MemoryEntryStatus, "live">;
  readonly supersededBy: string | undefined;
  constructor(id: string, status: Exclude<MemoryEntryStatus, "live">, supersededBy?: string) {
    super(
      `${id} is ${status}${supersededBy !== undefined ? ` (replaced by ${supersededBy})` : ""}, so it cannot be corrected; correct the live fact instead`,
    );
    this.id = id;
    this.status = status;
    this.supersededBy = supersededBy;
  }
}

/** An id that no line in the store names. */
export class MemoryNotFoundError extends MemoryStoreError {
  override readonly name = "MemoryNotFoundError";
  readonly id: string;
  constructor(id: string) {
    super(`no fact ${id} in this store`);
    this.id = id;
  }
}

/** Test seams for `compact()`: run code between its steps to force an interleaving. */
export type CompactSeams = {
  /** After the snapshot is read, before the lock is taken. */
  readonly afterSnapshot?: () => void | Promise<void>;
  /** Under the lock, after the archive append, before the last re-stat. */
  readonly beforeFinalStat?: () => void | Promise<void>;
};

let compactSeams: CompactSeams = {};

/** Test seam: force an interleaving in `compact()`. Pass `undefined` to restore. */
export function _setCompactSeamsForTest(next: CompactSeams | undefined): void {
  compactSeams = next ?? {};
}

/** The archive's segment names: six digits and `.jsonl`. */
const ARCHIVE_SEGMENT_RE = /^\d{6}\.jsonl$/;

const DEFAULT_K = 5;
const ID_PREFIX = "mem_";
const ENTRY_ID_RE = /^mem_[0-9a-f]{16}$/;

/** Reciprocal-rank-fusion constant (the standard k=60). */
const RRF_K = 60;
/**
 * Documented rank boost for tool-grounded facts in hybrid recall: one
 * extra reciprocal-rank vote at rank 1. Applied ONLY on the fused
 * (embedder-present) path so BM25-only ranking stays byte-identical.
 */
const PROOF_BOOST = 1 / (RRF_K + 1);

/** An append-only tombstone line folding a lifecycle change over an entry. */
export type MemoryTombstone = {
  readonly tombstone: "superseded" | "expired";
  readonly target: string;
  readonly at: string;
  readonly schemaVersion: number;
  readonly supersededBy?: string;
  readonly reason?: string;
  readonly by?: string;
  readonly cmd?: string;
};

/**
 * Construct a memory store for a given spec. The store is lazy — the
 * underlying file is created on the first `remember()` call.
 */
/** Whether `name` can name a memory store: `[a-zA-Z0-9_\-.]+`, so it is one file name. */
export function isMemorySpecName(name: string): boolean {
  return /^[a-zA-Z0-9_\-.]+$/.test(name);
}

export function createMemoryStore(opts: MemoryStoreOptions): MemoryStore {
  if (!opts.specName) {
    throw new MemoryStoreError("specName is required");
  }
  if (!isMemorySpecName(opts.specName)) {
    throw new MemoryStoreError(
      `invalid specName "${opts.specName}" — must match [a-zA-Z0-9_\\-.]+`,
    );
  }
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  const now = opts.now ?? (() => new Date());
  const embedder = opts.embedder;
  const filePath = join(rootDir, `${opts.specName}.jsonl`);
  // Embedding cache — entries are immutable once written, so id-keyed
  // vectors never go stale; the cache only saves re-embedding across
  // recall() calls within one store instance.
  const embeddingCache = new Map<string, number[]>();

  async function ensureRootDir(): Promise<void> {
    if (!existsSync(rootDir)) {
      mkdirSync(rootDir, { recursive: true });
    }
  }

  const fileName = `${opts.specName}.jsonl`;

  /**
   * Every read, append and rewrite goes through the contained primitives,
   * rooted at `rootDir`: a symlink planted at `<spec>.jsonl` or at the old
   * fixed compaction temp `<spec>.jsonl.tmp` used to be followed, so a
   * remembered line — model-written text — could be appended to, or a
   * compaction written over, any file the process could reach
   * (security-2#0's sibling). A link or special file at the leaf is now
   * refused, naming the file.
   */
  function refused(action: string, reason: string): MemoryStoreError {
    return new MemoryStoreError(`refusing to ${action} ${fileName} in ${rootDir}: ${reason}`);
  }

  async function readLines(): Promise<string[]> {
    const read = await openForRead(rootDir, fileName, {
      maxBytes: MEMORY_FILE_MAX_BYTES,
      followLeafSymlink: false,
    });
    if (!read.ok) {
      if (read.code === "not-found") return [];
      throw refused("read", read.reason);
    }
    if (read.truncated) {
      throw new MemoryStoreError(
        `${fileName} in ${rootDir} is larger than ${MEMORY_FILE_MAX_BYTES} bytes, so it was not read; archive or trim it (crewhaus memory sweep --compact rewrites it without forgotten entries)`,
      );
    }
    return read.text.split("\n").filter((l) => l.trim() !== "");
  }

  function appendLines(text: string): void {
    const appended = appendContained(rootDir, fileName, text, { mode: 0o600 });
    if (!appended.ok) throw refused("append to", appended.reason);
  }

  const lockName = `.${opts.specName}.lock`;
  const archiveDir = join("archive", opts.specName);
  /** The fact lock and the archive, on control-records' one lock policy. */
  const ledger: Ledger = {
    root: resolve(rootDir),
    lock: lockName,
    records: { dir: archiveDir },
    // Never written: the archive takes no claims.
    claims: join(archiveDir, ".claims"),
  };

  /**
   * Run `fn` holding `<rootDir>/.<spec>.lock`. A lock that cannot be taken
   * (file-lock's error names the holder pid) and a refused lock directory
   * both become a `MemoryStoreError` naming the file; an error `fn` throws
   * passes through unchanged.
   */
  async function withStoreLock<T>(fn: (lockedAppend: LockedAppend) => Promise<T> | T): Promise<T> {
    await ensureRootDir();
    let inner: { readonly err: unknown } | undefined;
    let answer: { readonly value: T } | { readonly ok: false; readonly reason: string };
    try {
      answer = await withLedgerLock(ledger, async (lockedAppend) => {
        try {
          return { value: await fn(lockedAppend) };
        } catch (err) {
          inner = { err };
          throw err;
        }
      });
    } catch (err) {
      if (inner !== undefined) throw inner.err;
      throw new MemoryStoreError(
        `could not lock ${fileName} in ${rootDir} (${lockName}): ${(err as Error).message}`,
        err,
      );
    }
    if ("value" in answer) return answer.value;
    throw new MemoryStoreError(
      `could not lock ${fileName} in ${rootDir} (${lockName}): ${answer.reason}`,
    );
  }

  type Loaded = {
    readonly entries: MemoryEntry[];
    readonly tombstones: MemoryTombstone[];
    readonly annotations: MemoryAnnotation[];
  };

  function parseInto(line: string, into: Loaded): void {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isMemoryEntry(parsed)) into.entries.push(parsed);
      else if (isMemoryTombstone(parsed)) into.tombstones.push(parsed);
      else if (isMemoryAnnotation(parsed)) into.annotations.push(parsed);
    } catch {
      // Malformed line — skip. Append-only writes mean partial-write
      // corruption is the most likely failure mode; one bad line
      // shouldn't block recall on the others.
    }
  }

  function loadLines(lines: ReadonlyArray<string>): Loaded {
    const loaded: Loaded = { entries: [], tombstones: [], annotations: [] };
    for (const line of lines) parseInto(line, loaded);
    return loaded;
  }

  async function loadAll(): Promise<Loaded> {
    return loadLines(await readLines());
  }

  /** Fold tombstones, TTL and annotations over the raw entries into status-carrying items. */
  function materialize(loaded: Loaded, nowMs: number): MemoryListItem[] {
    const superseded = new Map<string, MemoryTombstone>();
    const expired = new Set<string>();
    for (const t of loaded.tombstones) {
      if (t.tombstone === "superseded") superseded.set(t.target, t);
      else expired.add(t.target);
    }
    // Last annotation wins: file order is write order.
    const category = new Map<string, MemoryCategory | null>();
    for (const a of loaded.annotations) category.set(a.target, a.value);
    return loaded.entries.map((entry) => {
      const cat = category.get(entry.id);
      const extra = cat !== undefined && cat !== null ? { category: cat } : {};
      const sup = superseded.get(entry.id);
      if (sup !== undefined || entry.supersededBy !== undefined) {
        const supersededBy = entry.supersededBy ?? sup?.supersededBy;
        return {
          entry: supersededBy !== undefined ? { ...entry, supersededBy } : entry,
          status: "superseded" as const,
          ...extra,
        };
      }
      if (expired.has(entry.id) || (entry.expiresAt !== undefined && nowMs >= entry.expiresAt)) {
        return { entry, status: "expired" as const, ...extra };
      }
      return { entry, status: "live" as const, ...extra };
    });
  }

  async function loadLive(): Promise<MemoryEntry[]> {
    const items = materialize(await loadAll(), now().getTime());
    return items.filter((i) => i.status === "live").map((i) => i.entry);
  }

  function mkId(): string {
    // 8-byte random hex; collision probability with < 10k entries per
    // spec is negligible. crypto.randomUUID().replace would also work
    // but we keep a fixed-width id for grep-friendliness in the JSONL.
    let hex = "";
    for (let i = 0; i < 16; i++) {
      hex += Math.floor(Math.random() * 16).toString(16);
    }
    return `${ID_PREFIX}${hex}`;
  }

  type TombstoneFields = Pick<MemoryTombstone, "reason" | "supersededBy" | "by" | "cmd">;

  function tombstoneLine(
    target: string,
    kind: MemoryTombstone["tombstone"],
    at: string,
    fields: TombstoneFields,
  ): string {
    const t: MemoryTombstone = {
      tombstone: kind,
      target,
      at,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      ...(fields.supersededBy !== undefined ? { supersededBy: fields.supersededBy } : {}),
      ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
      ...(fields.by !== undefined ? { by: fields.by } : {}),
      ...(fields.cmd !== undefined ? { cmd: fields.cmd } : {}),
    };
    return JSON.stringify(t);
  }

  /** Append one tombstone per target in one write. The caller holds the lock. */
  function appendTombstones(
    targets: ReadonlyArray<MemoryEntry>,
    kind: MemoryTombstone["tombstone"],
    fields: TombstoneFields = {},
  ): void {
    if (targets.length === 0) return;
    const at = now().toISOString();
    const lines = targets.map((e) => tombstoneLine(e.id, kind, at, fields)).join("\n");
    appendLines(`${lines}\n`);
  }

  /** A contained read of the live file from `position` to its end, with its identity. */
  type Snapshot = {
    readonly bytes: Buffer;
    /** The file's size when read. */
    readonly size: number;
    readonly dev: number;
    readonly ino: number;
  };

  /** Read the live file from `position`; `undefined` when it is not there. */
  function readFrom(position: number): Snapshot | undefined {
    const opened = openForReadFd(rootDir, fileName, { followLeafSymlink: false });
    if (!opened.ok) {
      if (opened.code === "not-found") return undefined;
      throw refused("read", opened.reason);
    }
    try {
      const size = opened.stats.size;
      if (size > MEMORY_FILE_MAX_BYTES) {
        throw new MemoryStoreError(
          `${fileName} in ${rootDir} is larger than ${MEMORY_FILE_MAX_BYTES} bytes, so it was not read; archive or trim it (crewhaus memory sweep --compact rewrites it without forgotten entries)`,
        );
      }
      const length = Math.max(0, size - position);
      const bytes = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const got = readSync(opened.fd, bytes, done, length - done, position + done);
        if (got === 0) break;
        done += got;
      }
      return {
        bytes: done === length ? bytes : bytes.subarray(0, done),
        size: position + done,
        dev: opened.stats.dev,
        ino: opened.stats.ino,
      };
    } finally {
      closeSync(opened.fd);
    }
  }

  /** Split bytes into lines: whole lines, then any final unterminated fragment. */
  function splitLines(bytes: Buffer): string[] {
    return bytes
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
  }

  /** The archive line for one dropped live-file line. */
  function archiveRecord(line: string, archivedAt: string): Record<string, unknown> {
    try {
      return { v: 1, archivedAt, cause: "compaction", line: JSON.parse(line) as unknown };
    } catch {
      return { v: 1, archivedAt, cause: "compaction", raw: line };
    }
  }

  /** Which lines of a snapshot compaction keeps and which it moves to the archive. */
  function splitKeptDropped(
    lines: ReadonlyArray<string>,
    nowMs: number,
  ): { kept: string[]; dropped: string[] } {
    const items = materialize(loadLines(lines), nowMs);
    const liveIds = new Set(items.filter((i) => i.status === "live").map((i) => i.entry.id));
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        dropped.push(line); // unparseable partial-write junk, kept in the archive as text
        continue;
      }
      if (isMemoryEntry(parsed)) {
        (liveIds.has(parsed.id) ? kept : dropped).push(line);
        continue;
      }
      if (isMemoryTombstone(parsed)) {
        dropped.push(line); // its target is gone — the tombstone has no referent
        continue;
      }
      if (isMemoryAnnotation(parsed)) {
        (liveIds.has(parsed.target) ? kept : dropped).push(line);
        continue;
      }
      // Parseable but unknown line kind (a future writer's) — preserve
      // verbatim so compact never destroys forward-compatible data.
      kept.push(line);
    }
    return { kept, dropped };
  }

  /**
   * BM25-style scoring over the given entries — the exact pre-v2 math:
   *   - tf  = term frequency in this document
   *   - idf = log((N - df + 0.5) / (df + 0.5))
   *   - score = sum over terms of idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgdl)))
   * Returns only positive-scoring entries, sorted descending (stable).
   */
  function bm25Rank(entries: ReadonlyArray<MemoryEntry>, query: string): MemoryRecallResult[] {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || entries.length === 0) return [];
    const k1 = 1.5;
    const b = 0.75;
    const docs = entries.map((entry) => ({
      entry,
      terms: tokenize(`${entry.text} ${entry.tags.join(" ")}`),
    }));
    const N = docs.length;
    const avgdl = docs.reduce((sum, d) => sum + d.terms.length, 0) / Math.max(1, N);

    // Document frequency for each query term.
    const df = new Map<string, number>();
    for (const t of new Set(queryTerms)) {
      df.set(t, docs.filter((d) => d.terms.includes(t)).length);
    }

    const results: MemoryRecallResult[] = [];
    for (const d of docs) {
      let score = 0;
      for (const t of queryTerms) {
        const tf = d.terms.filter((x) => x === t).length;
        if (tf === 0) continue;
        const dfi = df.get(t) ?? 0;
        const idf = Math.log((N - dfi + 0.5) / (dfi + 0.5) + 1);
        const dl = d.terms.length;
        const norm = tf * (k1 + 1);
        const denom = tf + k1 * (1 - b + (b * dl) / Math.max(1, avgdl));
        score += idf * (norm / denom);
      }
      if (score > 0) results.push({ entry: d.entry, score });
    }
    results.sort((a, b2) => b2.score - a.score);
    return results;
  }

  /** Embed `text + tags` for the given entries, id-cached across calls. */
  async function embeddingsFor(
    entries: ReadonlyArray<MemoryEntry>,
  ): Promise<Map<string, number[]>> {
    if (embedder === undefined) return new Map();
    const missing = entries.filter((e) => !embeddingCache.has(e.id));
    if (missing.length > 0) {
      const vectors = await embedder.embed(missing.map((e) => `${e.text} ${e.tags.join(" ")}`));
      missing.forEach((e, i) => {
        const v = vectors[i];
        if (v !== undefined) embeddingCache.set(e.id, v);
      });
    }
    const out = new Map<string, number[]>();
    for (const e of entries) {
      const v = embeddingCache.get(e.id);
      if (v !== undefined) out.set(e.id, v);
    }
    return out;
  }

  /**
   * Hybrid recall: reciprocal-rank fusion (k=60) of the BM25 ranking and
   * a cosine-similarity ranking, plus the documented `PROOF_BOOST` for
   * entries with non-empty `provenance.evidence`. Candidates are the
   * union of both rankers' positive matches.
   */
  async function hybridRank(
    entries: ReadonlyArray<MemoryEntry>,
    query: string,
    emb: MemoryEmbedder,
  ): Promise<MemoryRecallResult[]> {
    const bmRanked = bm25Rank(entries, query);
    const [queryVec] = await emb.embed([query]);
    const entryVecs = await embeddingsFor(entries);
    const simRanked: Array<{ entry: MemoryEntry; sim: number }> = [];
    if (queryVec !== undefined) {
      for (const entry of entries) {
        const v = entryVecs.get(entry.id);
        if (v === undefined) continue;
        const sim = cosineSimilarity(queryVec, v);
        if (sim > 0) simRanked.push({ entry, sim });
      }
      simRanked.sort((a, b) => b.sim - a.sim);
    }

    const fused = new Map<string, { entry: MemoryEntry; score: number }>();
    const vote = (entry: MemoryEntry, rank: number): void => {
      const prev = fused.get(entry.id);
      const inc = 1 / (RRF_K + rank);
      if (prev === undefined) fused.set(entry.id, { entry, score: inc });
      else prev.score += inc;
    };
    bmRanked.forEach((r, i) => vote(r.entry, i + 1));
    simRanked.forEach((r, i) => vote(r.entry, i + 1));
    for (const f of fused.values()) {
      if (f.entry.provenance?.evidence !== undefined && f.entry.provenance.evidence.length > 0) {
        f.score += PROOF_BOOST;
      }
    }
    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .map((f) => ({ entry: f.entry, score: f.score }));
  }

  return {
    embedderLeavesProcess: embedderLeavesProcess(embedder),

    async remember(
      text: string,
      tags: readonly string[] = [],
      rememberOpts: RememberOptions = {},
    ): Promise<MemoryEntry> {
      if (typeof text !== "string" || text.length === 0) {
        throw new MemoryStoreError("remember(): text must be a non-empty string");
      }
      if (rememberOpts.ttlMs !== undefined && rememberOpts.ttlMs <= 0) {
        throw new MemoryStoreError("remember(): ttlMs must be a positive number of milliseconds");
      }
      const createdAt = now();
      const entry: MemoryEntry = {
        id: mkId(),
        text,
        tags: [...tags],
        createdAt: createdAt.toISOString(),
        schemaVersion: MEMORY_SCHEMA_VERSION,
        ...(rememberOpts.ttlMs !== undefined
          ? { expiresAt: createdAt.getTime() + rememberOpts.ttlMs }
          : {}),
        ...(rememberOpts.provenance !== undefined ? { provenance: rememberOpts.provenance } : {}),
      };
      // #53 F7 (unbounded growth) is addressed by the explicit-forgetting
      // primitives: `sweep()` tombstones expired entries, `forget()`
      // supersedes stale ones, and `compact()` rewrites the file dropping
      // dead lines (`crewhaus memory sweep --compact` runs both). The lock
      // keeps this append out of a compaction's window.
      await withStoreLock(() => appendLines(`${JSON.stringify(entry)}\n`));
      return entry;
    },

    async recall(query: string, k: number = DEFAULT_K): Promise<readonly MemoryRecallResult[]> {
      if (typeof query !== "string" || query.length === 0) {
        throw new MemoryStoreError("recall(): query must be a non-empty string");
      }
      const live = await loadLive();
      if (live.length === 0) return [];
      if (tokenize(query).length === 0) return [];
      const ranked =
        embedder === undefined ? bm25Rank(live, query) : await hybridRank(live, query, embedder);
      return ranked.slice(0, Math.max(0, k));
    },

    async forget(
      idOrQuery: string,
      forgetOpts: ForgetOptions = {},
    ): Promise<readonly MemoryEntry[]> {
      if (typeof idOrQuery !== "string" || idOrQuery.length === 0) {
        throw new MemoryStoreError("forget(): idOrQuery must be a non-empty string");
      }
      const fields: TombstoneFields = {
        ...(forgetOpts.reason !== undefined ? { reason: forgetOpts.reason } : {}),
        ...(forgetOpts.supersededBy !== undefined ? { supersededBy: forgetOpts.supersededBy } : {}),
        ...(forgetOpts.by !== undefined ? { by: forgetOpts.by } : {}),
        ...(forgetOpts.cmd !== undefined ? { cmd: forgetOpts.cmd } : {}),
      };
      return withStoreLock(async () => {
        const live = await loadLive();
        let targets: MemoryEntry[];
        if (ENTRY_ID_RE.test(idOrQuery)) {
          // Id-shaped input NEVER falls back to text matching — forgetting
          // a missing id must forget nothing.
          targets = live.filter((e) => e.id === idOrQuery);
        } else {
          targets = bm25Rank(live, idOrQuery).map((r) => r.entry);
        }
        appendTombstones(targets, "superseded", fields);
        return targets;
      });
    },

    async sweep(nowMs?: number): Promise<SweepResult> {
      const at = nowMs ?? now().getTime();
      return withStoreLock(async () => {
        const loaded = await loadAll();
        const items = materialize(loaded, at);
        // Only past-expiry entries that carry NO tombstone yet get one, so
        // re-running at the same time appends nothing (idempotent).
        const tombstoned = new Set(loaded.tombstones.map((t) => t.target));
        const fresh = items
          .filter(
            (i) =>
              i.status === "expired" &&
              i.entry.expiresAt !== undefined &&
              at >= i.entry.expiresAt &&
              !tombstoned.has(i.entry.id),
          )
          .map((i) => i.entry);
        appendTombstones(fresh, "expired");
        const live = items.filter((i) => i.status === "live").length;
        return { swept: fresh.length, live };
      });
    },

    async compact(): Promise<CompactResult> {
      // 1. Outside the lock: the snapshot, up to its last whole line. A
      //    fragment past it is re-read under the lock with the rest of the tail.
      const snap = readFrom(0);
      if (snap === undefined || snap.size === 0) return { kept: 0, dropped: 0, archived: 0 };
      await compactSeams.afterSnapshot?.();
      return withStoreLock(async (lockedAppend) => {
        // 2. Under the lock: the same file, grown or not. A file another
        //    compaction replaced since the snapshot is read again, whole.
        const current = readFrom(0);
        if (current === undefined) return { kept: 0, dropped: 0, archived: 0 };
        const outside = snap as Snapshot;
        const base = current.dev !== outside.dev || current.ino !== outside.ino ? current : outside;
        const noted = base.bytes.lastIndexOf(0x0a) + 1;
        const { kept, dropped } = splitKeptDropped(
          splitLines(base.bytes.subarray(0, noted)),
          now().getTime(),
        );
        let position = noted;
        const tail: string[] = [];
        const copyTail = (): void => {
          const more = readFrom(position);
          if (more === undefined || more.dev !== base.dev || more.ino !== base.ino) return;
          tail.push(...splitLines(more.bytes));
          position = more.size;
        };
        copyTail();
        // 3. Every dropped line to the archive, before the live file loses it.
        const archivedAt = now().toISOString();
        for (const line of dropped) {
          const appended = lockedAppend(archiveRecord(line, archivedAt));
          if (!appended.ok) {
            throw new MemoryStoreError(
              `refusing to archive ${fileName} lines in ${rootDir}: ${appended.reason}; the live file was not changed`,
            );
          }
        }
        // 4. Once more: a writer that went round a stolen lock appended here.
        await compactSeams.beforeFinalStat?.();
        copyTail();
        // 5. A random O_EXCL temp beside the file, renamed into place: the
        //    replaced file keeps its permission bits.
        const lines = [...kept, ...tail];
        const written = writeFileSafe(
          rootDir,
          fileName,
          lines.length > 0 ? `${lines.join("\n")}\n` : "",
          { overwrite: true, mode: 0o600 },
        );
        if (!written.ok) throw refused("rewrite", written.reason);
        embeddingCache.clear();
        return { kept: lines.length, dropped: dropped.length, archived: dropped.length };
      });
    },

    async supersede(
      id: string,
      text: string,
      supersedeOpts: SupersedeOptions,
    ): Promise<SupersedeResult> {
      if (typeof text !== "string" || text.length === 0) {
        throw new MemoryStoreError("supersede(): text must be a non-empty string");
      }
      if (typeof supersedeOpts?.reason !== "string" || supersedeOpts.reason.trim() === "") {
        throw new MemoryStoreError("supersede(): a reason is required");
      }
      if (!ENTRY_ID_RE.test(id)) {
        throw new MemoryStoreError(
          `supersede(): ${JSON.stringify(id)} is not a fact id (mem_<16 hex>)`,
        );
      }
      return withStoreLock(async () => {
        const items = materialize(await loadAll(), now().getTime());
        const target = items.find((i) => i.entry.id === id);
        if (target === undefined) throw new MemoryNotFoundError(id);
        if (target.status !== "live") {
          throw new MemoryNotLiveError(id, target.status, target.entry.supersededBy);
        }
        const at = now().toISOString();
        const tombstoneFields = (successorId: string): TombstoneFields => ({
          supersededBy: successorId,
          reason: supersedeOpts.reason,
          ...(supersedeOpts.by !== undefined ? { by: supersedeOpts.by } : {}),
          ...(supersedeOpts.cmd !== undefined ? { cmd: supersedeOpts.cmd } : {}),
        });
        // Repair: a crash after the successor and before the tombstone left a
        // live successor of this fact with this text. Finish that write.
        const torn = items.find(
          (i) =>
            i.status === "live" && i.entry.provenance?.correctionOf === id && i.entry.text === text,
        );
        if (torn !== undefined) {
          appendLines(`${tombstoneLine(id, "superseded", at, tombstoneFields(torn.entry.id))}\n`);
          return {
            successor: torn.entry,
            superseded: { ...target.entry, supersededBy: torn.entry.id },
          };
        }
        const provenance: MemoryProvenance = {
          ...(supersedeOpts.provenance ?? {}),
          correctionOf: id,
          ...(supersedeOpts.author !== undefined ? { author: supersedeOpts.author } : {}),
        };
        const successor: MemoryEntry = {
          id: mkId(),
          text,
          tags: [...(supersedeOpts.tags ?? target.entry.tags)],
          createdAt: at,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          provenance,
        };
        // One append: the successor and the tombstone land together.
        appendLines(
          `${JSON.stringify(successor)}\n${tombstoneLine(id, "superseded", at, tombstoneFields(successor.id))}\n`,
        );
        return { successor, superseded: { ...target.entry, supersededBy: successor.id } };
      });
    },

    async annotate(id: string, annotateOpts: AnnotateOptions): Promise<void> {
      const value = annotateOpts?.category;
      if (value !== "person" && value !== null) {
        throw new MemoryStoreError('annotate(): category must be "person" or null');
      }
      await withStoreLock(async () => {
        const loaded = await loadAll();
        if (!loaded.entries.some((e) => e.id === id)) throw new MemoryNotFoundError(id);
        const line: MemoryAnnotation = {
          annotate: "category",
          target: id,
          value,
          at: now().toISOString(),
          schemaVersion: MEMORY_SCHEMA_VERSION,
        };
        appendLines(`${JSON.stringify(line)}\n`);
      });
    },

    async history(): Promise<readonly MemoryArchivedLine[]> {
      let names: string[];
      try {
        names = readdirSync(join(rootDir, archiveDir), { withFileTypes: true })
          .filter((e) => e.isFile() && ARCHIVE_SEGMENT_RE.test(e.name))
          .map((e) => e.name)
          .sort();
      } catch {
        return []; // no archive yet
      }
      const out: MemoryArchivedLine[] = [];
      const seen = new Set<string>();
      for (const name of names) {
        const rel = join(archiveDir, name);
        const read = await openForRead(rootDir, rel, {
          maxBytes: MEMORY_FILE_MAX_BYTES,
          followLeafSymlink: false,
        });
        if (!read.ok) {
          if (read.code === "not-found") continue;
          throw new MemoryStoreError(`refusing to read ${rel} in ${rootDir}: ${read.reason}`);
        }
        if (read.truncated) {
          throw new MemoryStoreError(
            `${rel} in ${rootDir} is larger than ${MEMORY_FILE_MAX_BYTES} bytes, so it was not read`,
          );
        }
        for (const text of read.text.split("\n")) {
          if (text.trim() === "") continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            continue; // a torn archive line: the locked append seals it, skip it
          }
          if (!isArchivedLine(parsed)) continue;
          // A crash between the archive append and the rename archives a
          // line twice; it is one line of history.
          const key =
            parsed.line !== undefined ? `l:${canonicalJson(parsed.line)}` : `r:${parsed.raw}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(parsed);
        }
      }
      return out;
    },

    async importSynced(entries: ReadonlyArray<MemoryEntry>): Promise<readonly string[]> {
      for (const e of entries) {
        if (!isMemoryEntry(e) || !ENTRY_ID_RE.test(e.id)) {
          throw new MemoryStoreError(
            `importSynced(): ${JSON.stringify((e as { id?: unknown })?.id)} is not a well-formed fact`,
          );
        }
      }
      if (entries.length === 0) return [];
      return withStoreLock(async () => {
        const known = new Set((await loadAll()).entries.map((e) => e.id));
        const added: MemoryEntry[] = [];
        for (const e of entries) {
          if (known.has(e.id)) continue;
          known.add(e.id);
          added.push(e);
        }
        if (added.length > 0) appendLines(`${added.map((e) => JSON.stringify(e)).join("\n")}\n`);
        return added.map((e) => e.id);
      });
    },

    async list(): Promise<readonly MemoryListItem[]> {
      return materialize(await loadAll(), now().getTime());
    },

    async size(): Promise<number> {
      const live = await loadLive();
      return live.length;
    },

    path(): string {
      return filePath;
    },
  };
}

function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// -------- Feature #53: first-class memory config + auto-capture/recall --------

/**
 * Memory configuration lowered from the spec `memory:` block. All fields
 * optional so the block's mere presence wires the Remember/Recall tools; the
 * auto-* switches are opt-in on top of that.
 */
export type MemoryConfig = {
  /** Register Remember/Recall + honour the auto-* switches. Presence of the
   *  block implies enabled; an explicit `false` keeps everything off. */
  readonly enabled?: boolean;
  /** At teardown, summarize the session's durable outcomes into the store. */
  readonly autoCapture?: boolean;
  /** Minimum completed user-text turns before an auto-capture fires (default 1). */
  readonly autoCaptureThreshold?: number;
  /** At session start, recall the top-K memories and inject them into the prompt. */
  readonly autoRecall?: boolean;
  /** How many memories autoRecall injects. Default 5. */
  readonly recallK?: number;
};

export const DEFAULT_AUTO_CAPTURE_THRESHOLD = 1;
export const DEFAULT_AUTO_RECALL_K = 5;

/** A minimal transcript turn — the durable-fact extractor's input. Matches the
 *  shape `deriveTurns` in the CLI produces (input/output text per turn). */
export type CapturableTurn = {
  readonly input: string;
  readonly output: string;
  /** toolUseIds whose tool_result succeeded during this turn — the proof
   *  substrate for provenance.evidence on captured facts. */
  readonly toolUseIds?: readonly string[];
};

/**
 * Decide, from a memory config and a completed-turn count, whether an
 * auto-capture should run and how many memories auto-recall should inject.
 * Pure so the wiring in runtime-core is unit-testable without a filesystem.
 * A config that is absent, or explicitly `enabled: false`, disables both.
 */
export function deriveMemoryDecision(
  config: MemoryConfig | undefined,
  completedTurns: number,
): { capture: boolean; recall: boolean; recallK: number; captureThreshold: number } {
  const enabled = config !== undefined && config.enabled !== false;
  const captureThreshold = Math.max(
    1,
    config?.autoCaptureThreshold ?? DEFAULT_AUTO_CAPTURE_THRESHOLD,
  );
  const recallK = Math.max(1, config?.recallK ?? DEFAULT_AUTO_RECALL_K);
  return {
    capture: enabled && config?.autoCapture === true && completedTurns >= captureThreshold,
    recall: enabled && config?.autoRecall === true,
    recallK,
    captureThreshold,
  };
}

/** A parsed session event-log line (`{ kind, payload }`). */
export type SessionEvent = { readonly kind?: string; readonly payload?: unknown };

/**
 * Reconstruct `CapturableTurn`s from a raw session event log. A dependency-
 * free mirror of the CLI's `deriveTurns` restricted to what the fact
 * extractor needs (each user-text turn's final assistant answer). Kept here
 * so the auto-capture codegen and CLI both consume one extractor without
 * importing the CLI's feedback module. Synthetic (runtime-injected) user
 * messages and tool-result echoes are not turns.
 *
 * v2: each turn also carries the toolUseIds of `tool_result` events that
 * succeeded (`isError !== true`) between its user message and the next —
 * the proof links auto-capture stamps into `provenance.evidence`.
 */
export function turnsFromEvents(events: readonly SessionEvent[]): CapturableTurn[] {
  const turns: CapturableTurn[] = [];
  let current: { input: string; texts: string[]; toolUseIds: string[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    turns.push({
      input: current.input,
      output: current.texts.length > 0 ? (current.texts[current.texts.length - 1] as string) : "",
      ...(current.toolUseIds.length > 0 ? { toolUseIds: current.toolUseIds } : {}),
    });
  };
  for (const ev of events) {
    if (ev.kind === "user_message") {
      const text = userEventText(ev.payload);
      if (text !== undefined) {
        flush();
        current = { input: text, texts: [], toolUseIds: [] };
      }
    } else if (ev.kind === "assistant_message" && current !== undefined) {
      const t = assistantEventText(ev.payload);
      if (t !== "") current.texts.push(t);
    } else if (ev.kind === "tool_result" && current !== undefined) {
      const id = toolResultUseId(ev.payload);
      if (id !== undefined) current.toolUseIds.push(id);
    }
  }
  flush();
  return turns;
}

type EventBlock = { type?: string; text?: string };

function eventContent(payload: unknown): { blocks: EventBlock[]; text?: string } {
  const content = (payload as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return { blocks: [], text: content };
  if (Array.isArray(content)) return { blocks: content as EventBlock[] };
  return { blocks: [] };
}

function userEventText(payload: unknown): string | undefined {
  if (
    payload !== null &&
    typeof payload === "object" &&
    (payload as { synthetic?: unknown }).synthetic === true
  ) {
    return undefined;
  }
  const { blocks, text } = eventContent(payload);
  if (text !== undefined) return text;
  if (blocks.some((b) => b.type === "tool_result")) return undefined;
  const texts = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function assistantEventText(payload: unknown): string {
  const { blocks, text } = eventContent(payload);
  if (text !== undefined) return text;
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** The toolUseId of a successful `tool_result` event payload, if any. */
function toolResultUseId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const p = payload as { toolUseId?: unknown; isError?: unknown };
  if (typeof p.toolUseId !== "string" || p.toolUseId === "") return undefined;
  // Errored tool runs are not evidence — the proof ladder rejects them.
  if (p.isError === true) return undefined;
  return p.toolUseId;
}

// -------- v0.3.0 §7.1: capture walks sub-agent brackets into child logs --------

/**
 * Per-child event-read cap for the sub-agent capture walk. A researcher
 * fan-out can leave arbitrarily large child session JSONLs behind; the walk
 * reads AT MOST this many events per child (readers get the cap so they can
 * stop early; the walker slices defensively regardless). 2000 events is
 * roughly a few hundred turns — far beyond what a single-turn sub-agent
 * produces, small enough that a 50-child fan-out stays bounded.
 */
export const MAX_CAPTURE_EVENTS_PER_CHILD = 2000;

/**
 * Read one child session's parsed events. `maxEvents` is the per-child cap
 * (see {@link MAX_CAPTURE_EVENTS_PER_CHILD}) — implementations SHOULD stop
 * reading past it (e.g. slice the parsed JSONL lines); the walker slices
 * defensively either way. Return `undefined` (or throw) for an unreadable /
 * missing child log — the walker skips that child.
 */
export type ChildSessionEventsReader = (
  childSessionId: string,
  maxEvents: number,
) => readonly SessionEvent[] | undefined | Promise<readonly SessionEvent[] | undefined>;

/** One child session's capturable turns, keyed for provenance/tagging. */
export type ChildCapturableTurns = {
  /** The child's own sessionId — stamped into `provenance.sessionId`. */
  readonly sessionId: string;
  /** The sub-agent definition name — becomes the `subagent:<name>` tag. */
  readonly name: string;
  readonly turns: CapturableTurn[];
  /** True when the reader supplied more events than the cap (input was cut). */
  readonly truncated: boolean;
};

export type TurnsWithChildren = {
  /** The parent session's turns — identical to `turnsFromEvents(events)`. */
  readonly turns: CapturableTurn[];
  readonly children: ChildCapturableTurns[];
};

/**
 * `turnsFromEvents` extended with the sub-agent walk: follows the parent
 * log's `sub_agent_start` brackets (payload `{name, childSessionId}` — the
 * spawner appends one per spawn, before the matching `sub_agent_end`) and
 * lazily reads each referenced child session's events through the injected
 * reader, capped per child. Children are deduped by `childSessionId`;
 * unreadable child logs are skipped. This is THE shared helper both memory
 * wiring paths (target-cli codegen and the apps/cli interpreter) consume so
 * researcher sub-agent findings stop being structurally invisible to
 * auto-capture.
 */
export async function turnsFromEventsWithChildren(
  events: readonly SessionEvent[],
  readChildEvents: ChildSessionEventsReader,
  opts: { maxEventsPerChild?: number } = {},
): Promise<TurnsWithChildren> {
  const cap = Math.max(1, opts.maxEventsPerChild ?? MAX_CAPTURE_EVENTS_PER_CHILD);
  const children: ChildCapturableTurns[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.kind !== "sub_agent_start") continue;
    const p = ev.payload as { childSessionId?: unknown; name?: unknown } | null | undefined;
    const childSessionId = typeof p?.childSessionId === "string" ? p.childSessionId : undefined;
    if (childSessionId === undefined || childSessionId === "" || seen.has(childSessionId)) {
      continue;
    }
    seen.add(childSessionId);
    const name = typeof p?.name === "string" && p.name !== "" ? p.name : "unknown";
    let childEvents: readonly SessionEvent[] | undefined;
    try {
      childEvents = await readChildEvents(childSessionId, cap);
    } catch {
      childEvents = undefined;
    }
    if (childEvents === undefined) continue;
    const truncated = childEvents.length > cap;
    const capped = truncated ? childEvents.slice(0, cap) : childEvents;
    children.push({
      sessionId: childSessionId,
      name,
      turns: turnsFromEvents(capped),
      truncated,
    });
  }
  return { turns: turnsFromEvents(events), children };
}

/** A durable fact plus the toolUseIds that ground it (may be empty). */
export type DurableFact = {
  readonly text: string;
  readonly evidence: readonly string[];
};

/**
 * Extract durable, self-contained facts worth remembering from a session's
 * turns. Deterministic (no model call) so it runs offline and in tests: it
 * keeps each turn's final answer as one candidate fact, trimmed to a single
 * sentence-ish line, dropping empty/echo/error turns and near-duplicates.
 * Callers who have a model available can override with a summary; this is the
 * always-available fallback the auto-capture path uses when no summarizer is
 * injected.
 */
export function summarizeDurableFacts(
  turns: readonly CapturableTurn[],
  opts: { maxFacts?: number; maxLen?: number } = {},
): string[] {
  return summarizeDurableFactsWithEvidence(turns, opts).map((f) => f.text);
}

/**
 * `summarizeDurableFacts` carrying each fact's proof links: the toolUseIds
 * of the source turn's successful tool results (design §2.4 proof-linked
 * capture). Same extraction/dedupe rules; the string-returning wrapper above
 * stays for pre-v2 callers.
 */
export function summarizeDurableFactsWithEvidence(
  turns: readonly CapturableTurn[],
  opts: { maxFacts?: number; maxLen?: number } = {},
): DurableFact[] {
  const maxFacts = opts.maxFacts ?? 8;
  const maxLen = opts.maxLen ?? 240;
  const seen = new Set<string>();
  const facts: DurableFact[] = [];
  for (const t of turns) {
    const answer = (t.output ?? "").trim();
    if (answer === "") continue;
    // First non-empty line, collapsed whitespace — a durable one-liner.
    const firstLine = answer
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (firstLine === undefined) continue;
    let fact = firstLine.replace(/\s+/g, " ");
    if (fact.length > maxLen) fact = `${fact.slice(0, maxLen - 1).trimEnd()}…`;
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ text: fact, evidence: [...(t.toolUseIds ?? [])] });
    if (facts.length >= maxFacts) break;
  }
  return facts;
}

export type CaptureFactsOptions = {
  /** Stamped into each written entry's `provenance.sessionId`. */
  readonly sessionId?: string;
  /** TTL applied to each written entry. */
  readonly ttlMs?: number;
};

/**
 * Idempotently persist facts into a store, skipping any whose text (case- and
 * whitespace-insensitively) already matches an existing entry. Returns the
 * entries actually written. Re-running the same auto-capture never duplicates.
 *
 * Facts may be plain strings or `DurableFact`s; the latter carry their proof
 * toolUseIds into `provenance.evidence`. When `opts.sessionId` is given (the
 * auto-capture path) it is stamped into `provenance.sessionId`.
 */
export async function captureFacts(
  store: MemoryStore,
  facts: ReadonlyArray<string | DurableFact>,
  tags: readonly string[] = ["auto-capture"],
  opts: CaptureFactsOptions = {},
): Promise<MemoryEntry[]> {
  const written: MemoryEntry[] = [];
  if (facts.length === 0) return written;
  // Pull existing entries once (via a broad recall over the fact tokens) so a
  // re-run is a no-op. recall() needs a query; we normalize existing text by
  // recalling each fact and checking for an exact normalized match.
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
  const asFact = (f: string | DurableFact): DurableFact =>
    typeof f === "string" ? { text: f, evidence: [] } : f;
  const existing = new Set<string>();
  for (const fact of facts) {
    for (const r of await store.recall(asFact(fact).text, 20)) existing.add(norm(r.entry.text));
  }
  const writtenNorms = new Set<string>();
  for (const raw of facts) {
    const fact = asFact(raw);
    const n = norm(fact.text);
    if (existing.has(n) || writtenNorms.has(n)) continue;
    writtenNorms.add(n);
    const provenance: MemoryProvenance | undefined =
      opts.sessionId !== undefined || fact.evidence.length > 0
        ? {
            ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
            ...(fact.evidence.length > 0 ? { evidence: fact.evidence } : {}),
          }
        : undefined;
    written.push(
      await store.remember(fact.text, tags, {
        ...(provenance !== undefined ? { provenance } : {}),
        ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      }),
    );
  }
  return written;
}

export type CaptureChildFactsOptions = {
  /** TTL applied to each written entry. */
  readonly ttlMs?: number;
  /** Per-child fact cap forwarded to `summarizeDurableFactsWithEvidence`. */
  readonly maxFactsPerChild?: number;
};

/**
 * v0.3.0 §7.1 — persist the durable facts of walked child sessions (from
 * {@link turnsFromEventsWithChildren}). Each child's facts land with
 * `provenance.sessionId` set to the CHILD's sessionId (so proof/evidence
 * resolution walks the right log) and a `subagent:<name>` tag appended to
 * `baseTags` (so researcher findings are grep-able by sub-agent). Same
 * idempotent dedupe as {@link captureFacts}. Returns everything written.
 */
export async function captureChildFacts(
  store: MemoryStore,
  children: ReadonlyArray<ChildCapturableTurns>,
  baseTags: readonly string[] = ["auto-capture"],
  opts: CaptureChildFactsOptions = {},
): Promise<MemoryEntry[]> {
  const written: MemoryEntry[] = [];
  for (const child of children) {
    const facts = summarizeDurableFactsWithEvidence(
      child.turns,
      opts.maxFactsPerChild !== undefined ? { maxFacts: opts.maxFactsPerChild } : {},
    );
    if (facts.length === 0) continue;
    written.push(
      ...(await captureFacts(store, facts, [...baseTags, `subagent:${child.name}`], {
        sessionId: child.sessionId,
        ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      })),
    );
  }
  return written;
}

export function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const baseOk =
    typeof v["id"] === "string" &&
    typeof v["text"] === "string" &&
    Array.isArray(v["tags"]) &&
    (v["tags"] as unknown[]).every((t) => typeof t === "string") &&
    typeof v["createdAt"] === "string";
  if (!baseOk) return false;
  // Tombstone lines carry `tombstone` + `target` and never the entry base
  // fields, so they can't reach here — but guard anyway.
  if (v["tombstone"] !== undefined) return false;
  // v2 optional fields must be well-typed WHEN PRESENT; a line with a
  // mangled optional field is treated as malformed (skipped), never
  // half-read.
  if (v["schemaVersion"] !== undefined && typeof v["schemaVersion"] !== "number") return false;
  if (v["expiresAt"] !== undefined && typeof v["expiresAt"] !== "number") return false;
  if (v["supersededBy"] !== undefined && typeof v["supersededBy"] !== "string") return false;
  if (v["provenance"] !== undefined && !isProvenance(v["provenance"])) return false;
  return true;
}

function isProvenance(value: unknown): value is MemoryProvenance {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["sessionId"] !== undefined && typeof v["sessionId"] !== "string") return false;
  if (
    v["evidence"] !== undefined &&
    !(
      Array.isArray(v["evidence"]) &&
      (v["evidence"] as unknown[]).every((e) => typeof e === "string")
    )
  ) {
    return false;
  }
  if (v["correctionOf"] !== undefined && typeof v["correctionOf"] !== "string") return false;
  if (v["author"] !== undefined && !isAuthor(v["author"])) return false;
  if (v["origin"] !== undefined && !isSyncOrigin(v["origin"])) return false;
  return true;
}

const AUTHOR_KINDS: ReadonlyArray<MemoryAuthor["kind"]> = [
  "operator",
  "agent",
  "extractor",
  "sync",
];

function isAuthor(value: unknown): value is MemoryAuthor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    AUTHOR_KINDS.includes(v["kind"] as MemoryAuthor["kind"]) &&
    (v["via"] === undefined || typeof v["via"] === "string") &&
    (v["cmd"] === undefined || typeof v["cmd"] === "string")
  );
}

function isSyncOrigin(value: unknown): value is MemorySyncOrigin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v["kind"] === "sync" &&
    typeof v["harness"] === "string" &&
    typeof v["contentHash"] === "string" &&
    (v["fact"] === undefined || typeof v["fact"] === "string")
  );
}

/** An `annotate()` line. Neither an entry nor a tombstone, so a 0.8.0 reader skips it. */
export function isMemoryAnnotation(value: unknown): value is MemoryAnnotation {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["annotate"] === "category" &&
    typeof v["target"] === "string" &&
    (v["value"] === "person" || v["value"] === null) &&
    typeof v["at"] === "string"
  );
}

function isArchivedLine(value: unknown): value is MemoryArchivedLine {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v["v"] === 1 &&
    typeof v["archivedAt"] === "string" &&
    v["cause"] === "compaction" &&
    (v["line"] !== undefined || typeof v["raw"] === "string")
  );
}

/** JSON with object keys sorted, so two equal values spell the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isMemoryTombstone(value: unknown): value is MemoryTombstone {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v["tombstone"] === "superseded" || v["tombstone"] === "expired") &&
    typeof v["target"] === "string" &&
    typeof v["at"] === "string"
  );
}

/** The id pattern every fact carries: `mem_` and 16 lowercase hex digits. */
export function isMemoryEntryId(value: string): boolean {
  return ENTRY_ID_RE.test(value);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}
