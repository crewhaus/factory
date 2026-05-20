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
 * interface — `recall()` is the only consumer-visible signature.
 *
 * File path: `<rootDir>/<specName>.jsonl` where rootDir defaults to
 * `.crewhaus/memories/`. One file per spec keeps memories scoped.
 */
import { existsSync, mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";

export const DEFAULT_ROOT_DIR = ".crewhaus/memories";

export type MemoryEntry = {
  readonly id: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly createdAt: string;
};

export type MemoryRecallResult = {
  readonly entry: MemoryEntry;
  readonly score: number;
};

export interface MemoryStoreOptions {
  readonly rootDir?: string;
  readonly specName: string;
  readonly now?: () => Date;
}

export interface MemoryStore {
  /** Append a new memory. Returns the assigned entry. */
  remember(text: string, tags?: readonly string[]): Promise<MemoryEntry>;
  /** Top-k matches for the query, ranked by BM25-style score. */
  recall(query: string, k?: number): Promise<readonly MemoryRecallResult[]>;
  /** Diagnostic: how many entries are stored. */
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
  const filePath = join(rootDir, `${opts.specName}.jsonl`);

  async function ensureRootDir(): Promise<void> {
    if (!existsSync(rootDir)) {
      mkdirSync(rootDir, { recursive: true });
    }
  }

  async function loadAll(): Promise<MemoryEntry[]> {
    if (!existsSync(filePath)) return [];
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      return [];
    }
    const entries: MemoryEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isMemoryEntry(parsed)) entries.push(parsed);
      } catch {
        // Malformed line — skip. Append-only writes mean partial-write
        // corruption is the most likely failure mode; one bad line
        // shouldn't block recall on the others.
      }
    }
    return entries;
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

  return {
    async remember(text: string, tags: readonly string[] = []): Promise<MemoryEntry> {
      if (typeof text !== "string" || text.length === 0) {
        throw new MemoryStoreError("remember(): text must be a non-empty string");
      }
      const entry: MemoryEntry = {
        id: mkId(),
        text,
        tags: [...tags],
        createdAt: now().toISOString(),
      };
      await ensureRootDir();
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      return entry;
    },

    async recall(
      query: string,
      k: number = DEFAULT_K,
    ): Promise<readonly MemoryRecallResult[]> {
      if (typeof query !== "string" || query.length === 0) {
        throw new MemoryStoreError("recall(): query must be a non-empty string");
      }
      const all = await loadAll();
      if (all.length === 0) return [];
      const queryTerms = tokenize(query);
      if (queryTerms.length === 0) return [];

      // BM25-style scoring:
      //   - tf  = term frequency in this document
      //   - idf = log((N - df + 0.5) / (df + 0.5))
      //   - score = sum over terms of idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgdl)))
      const k1 = 1.5;
      const b = 0.75;
      const docs = all.map((entry) => ({
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
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, Math.max(0, k));
    },

    async size(): Promise<number> {
      const all = await loadAll();
      return all.length;
    },

    path(): string {
      return filePath;
    },
  };
}

function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["text"] === "string" &&
    Array.isArray(v["tags"]) &&
    (v["tags"] as unknown[]).every((t) => typeof t === "string") &&
    typeof v["createdAt"] === "string"
  );
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}
