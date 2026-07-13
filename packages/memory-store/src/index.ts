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
 * file atomically (tmp + rename) dropping tombstoned/expired entries
 * and the tombstone lines themselves; parseable lines it does not
 * recognise (future line kinds) are preserved verbatim.
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
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";

export const DEFAULT_ROOT_DIR = ".crewhaus/memories";

/** Schema version stamped on every new write. Absent = v1 (read lazily). */
export const MEMORY_SCHEMA_VERSION = 2;

/** Where a memory came from, and which tool runs prove it (toolUseIds). */
export type MemoryProvenance = {
  readonly sessionId?: string;
  /** toolUseIds from the source session's event log — proof the fact is
   *  grounded in tool results, not just assistant narration. */
  readonly evidence?: readonly string[];
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

export type MemoryListItem = {
  readonly entry: MemoryEntry;
  readonly status: MemoryEntryStatus;
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
   * entries and tombstone lines, preserving live entries (v1 lines
   * untouched) and parseable-but-unknown lines verbatim. Atomic via
   * tmp + rename.
   */
  compact(): Promise<CompactResult>;
  /** Every entry in file order with its materialized lifecycle status. */
  list(): Promise<readonly MemoryListItem[]>;
  /** Diagnostic: how many LIVE entries are stored. */
  size(): Promise<number>;
  /** Diagnostic: where on disk this store writes. */
  path(): string;
}

export class MemoryStoreError extends CrewhausError {
  override readonly name = "MemoryStoreError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

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
};

/**
 * Construct a memory store for a given spec. The store is lazy — the
 * underlying file is created on the first `remember()` call.
 */
export function createMemoryStore(opts: MemoryStoreOptions): MemoryStore {
  if (!opts.specName) {
    throw new MemoryStoreError("specName is required");
  }
  if (!/^[a-zA-Z0-9_\-.]+$/.test(opts.specName)) {
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

  async function readLines(): Promise<string[]> {
    if (!existsSync(filePath)) return [];
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      return [];
    }
    return raw.split("\n").filter((l) => l.trim() !== "");
  }

  type Loaded = {
    readonly entries: MemoryEntry[];
    readonly tombstones: MemoryTombstone[];
  };

  async function loadAll(): Promise<Loaded> {
    const entries: MemoryEntry[] = [];
    const tombstones: MemoryTombstone[] = [];
    for (const line of await readLines()) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isMemoryEntry(parsed)) entries.push(parsed);
        else if (isMemoryTombstone(parsed)) tombstones.push(parsed);
      } catch {
        // Malformed line — skip. Append-only writes mean partial-write
        // corruption is the most likely failure mode; one bad line
        // shouldn't block recall on the others.
      }
    }
    return { entries, tombstones };
  }

  /** Fold tombstones + TTL over the raw entries into status-carrying items. */
  function materialize(loaded: Loaded, nowMs: number): MemoryListItem[] {
    const superseded = new Map<string, MemoryTombstone>();
    const expired = new Set<string>();
    for (const t of loaded.tombstones) {
      if (t.tombstone === "superseded") superseded.set(t.target, t);
      else expired.add(t.target);
    }
    return loaded.entries.map((entry) => {
      const sup = superseded.get(entry.id);
      if (sup !== undefined || entry.supersededBy !== undefined) {
        const supersededBy = entry.supersededBy ?? sup?.supersededBy;
        return {
          entry: supersededBy !== undefined ? { ...entry, supersededBy } : entry,
          status: "superseded" as const,
        };
      }
      if (expired.has(entry.id) || (entry.expiresAt !== undefined && nowMs >= entry.expiresAt)) {
        return { entry, status: "expired" as const };
      }
      return { entry, status: "live" as const };
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

  async function appendTombstones(
    targets: ReadonlyArray<MemoryEntry>,
    kind: MemoryTombstone["tombstone"],
    reason?: string,
  ): Promise<void> {
    if (targets.length === 0) return;
    await ensureRootDir();
    const at = now().toISOString();
    const lines = targets
      .map((e) => {
        const t: MemoryTombstone = {
          tombstone: kind,
          target: e.id,
          at,
          schemaVersion: MEMORY_SCHEMA_VERSION,
          ...(reason !== undefined ? { reason } : {}),
        };
        return JSON.stringify(t);
      })
      .join("\n");
    await appendFile(filePath, `${lines}\n`, { mode: 0o600 });
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
      await ensureRootDir();
      // #53 F7 (unbounded growth) is addressed by the explicit-forgetting
      // primitives: `sweep()` tombstones expired entries, `forget()`
      // supersedes stale ones, and `compact()` rewrites the file dropping
      // dead lines (`crewhaus memory sweep --compact` runs both).
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
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
      const live = await loadLive();
      let targets: MemoryEntry[];
      if (ENTRY_ID_RE.test(idOrQuery)) {
        // Id-shaped input NEVER falls back to text matching — forgetting
        // a missing id must forget nothing.
        targets = live.filter((e) => e.id === idOrQuery);
      } else {
        targets = bm25Rank(live, idOrQuery).map((r) => r.entry);
      }
      await appendTombstones(targets, "superseded", forgetOpts.reason);
      return targets;
    },

    async sweep(nowMs?: number): Promise<SweepResult> {
      const at = nowMs ?? now().getTime();
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
      await appendTombstones(fresh, "expired");
      const live = items.filter((i) => i.status === "live").length;
      return { swept: fresh.length, live };
    },

    async compact(): Promise<CompactResult> {
      const lines = await readLines();
      if (lines.length === 0) return { kept: 0, dropped: 0 };
      const loaded = await loadAll();
      const items = materialize(loaded, now().getTime());
      const liveIds = new Set(items.filter((i) => i.status === "live").map((i) => i.entry.id));
      const kept: string[] = [];
      let dropped = 0;
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          dropped += 1; // unparseable partial-write junk
          continue;
        }
        if (isMemoryEntry(parsed)) {
          if (liveIds.has(parsed.id)) kept.push(line);
          else dropped += 1;
          continue;
        }
        if (isMemoryTombstone(parsed)) {
          dropped += 1; // its target is gone — the tombstone has no referent
          continue;
        }
        // Parseable but unknown line kind (a future writer's) — preserve
        // verbatim so compact never destroys forward-compatible data.
        kept.push(line);
      }
      const tmpPath = `${filePath}.tmp`;
      writeFileSync(tmpPath, kept.length > 0 ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
      renameSync(tmpPath, filePath);
      embeddingCache.clear();
      return { kept: kept.length, dropped };
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
  return true;
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

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}
