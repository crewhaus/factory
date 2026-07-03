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

    async recall(query: string, k: number = DEFAULT_K): Promise<readonly MemoryRecallResult[]> {
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
 */
export function turnsFromEvents(events: readonly SessionEvent[]): CapturableTurn[] {
  const turns: CapturableTurn[] = [];
  let current: { input: string; texts: string[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    turns.push({
      input: current.input,
      output: current.texts.length > 0 ? (current.texts[current.texts.length - 1] as string) : "",
    });
  };
  for (const ev of events) {
    if (ev.kind === "user_message") {
      const text = userEventText(ev.payload);
      if (text !== undefined) {
        flush();
        current = { input: text, texts: [] };
      }
    } else if (ev.kind === "assistant_message" && current !== undefined) {
      const t = assistantEventText(ev.payload);
      if (t !== "") current.texts.push(t);
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
  const maxFacts = opts.maxFacts ?? 8;
  const maxLen = opts.maxLen ?? 240;
  const seen = new Set<string>();
  const facts: string[] = [];
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
    facts.push(fact);
    if (facts.length >= maxFacts) break;
  }
  return facts;
}

/**
 * Idempotently persist facts into a store, skipping any whose text (case- and
 * whitespace-insensitively) already matches an existing entry. Returns the
 * entries actually written. Re-running the same auto-capture never duplicates.
 */
export async function captureFacts(
  store: MemoryStore,
  facts: readonly string[],
  tags: readonly string[] = ["auto-capture"],
): Promise<MemoryEntry[]> {
  const written: MemoryEntry[] = [];
  if (facts.length === 0) return written;
  // Pull existing entries once (via a broad recall over the fact tokens) so a
  // re-run is a no-op. recall() needs a query; we normalize existing text by
  // recalling each fact and checking for an exact normalized match.
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
  const existing = new Set<string>();
  for (const fact of facts) {
    for (const r of await store.recall(fact, 20)) existing.add(norm(r.entry.text));
  }
  const writtenNorms = new Set<string>();
  for (const fact of facts) {
    const n = norm(fact);
    if (existing.has(n) || writtenNorms.has(n)) continue;
    writtenNorms.add(n);
    written.push(await store.remember(fact, tags));
  }
  return written;
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
