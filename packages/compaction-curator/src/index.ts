/**
 * Pillar 2 active context curation — pre-compaction relevance + dedupe.
 *
 * `compaction-autocompact` (model summarize-then-replace) and
 * `compaction-snip` (drop oldest) are *reactive*: they only fire when
 * context is already near its limit, and they cost a model call (autocompact)
 * or accept information loss (snip). Routray's "Stop Wasting Money on AI
 * Context You Don't Need" (Mar 2026) documents 60–80% token reduction
 * from a pre-compaction pass that:
 *
 *   1. Removes semantically duplicate items (embedding cosine ≥ threshold).
 *   2. Re-orders to front-load high-relevance items (since transformer
 *      attention favors prompt-start and prompt-end positions).
 *
 * This package implements both as pure functions over a generic `Item`
 * shape (string text + optional embedding). Callers (compaction-autocompact
 * primarily) wire it as an opt-in stage controlled by `spec.compaction.curate`.
 * When curation brings the item count below the model-summarize trigger,
 * the summarization model call is skipped entirely — that's where the
 * cost savings compound on top of token savings.
 *
 * The package does NOT carry an embedder dependency. Callers supply
 * `EmbedderFn` — typically wrapping `@crewhaus/embedder`'s configured
 * provider. This keeps `compaction-curator` light enough to be useful
 * from `target-pipeline` (which already has an embedder) without forcing
 * a heavy import onto `target-cli` (which doesn't).
 *
 * Catalog layer: R6 (extension of §17 compaction primitives, symmetric to
 * `compaction-autocompact` and `compaction-snip`). Recipe:
 * demos/recipes/52-context-curation.md.
 */
import { CrewhausError } from "@crewhaus/errors";

export class CompactionCuratorError extends CrewhausError {
  override readonly name = "CompactionCuratorError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * The generic shape this package operates on. Sufficient for two backends:
 *   - context items: `text` = message body, `embedding` = optional pre-
 *     computed vector
 *   - RAG-retrieved chunks: `text` = chunk body, `embedding` = the vector
 *     already used for retrieval
 */
export type Item = {
  readonly text: string;
  /** Optional pre-computed embedding. When absent, callers must supply
   *  `EmbedderFn` to `curate()`. */
  readonly embedding?: ReadonlyArray<number>;
  /** Optional client-side identifier carried through unchanged. */
  readonly id?: string;
};

/**
 * Async embedder callback. Returns a vector per input string in the same
 * order. Implementations typically batch internally for cost efficiency.
 *
 * Vectors must be normalized (unit length) so cosine reduces to a dot
 * product. Most production embedders return normalized vectors by default;
 * if yours doesn't, normalize before returning here.
 */
export type EmbedderFn = (
  texts: ReadonlyArray<string>,
) => Promise<ReadonlyArray<ReadonlyArray<number>>>;

export type CurateOptions = {
  /**
   * Query / goal string used to score relevance. When absent, the curator
   * skips the relevance-reorder pass and only does dedupe.
   */
  readonly query?: string;
  /**
   * Cosine-similarity threshold above which two items are considered
   * duplicates. Default 0.92 — high enough to avoid false-positive
   * collapses on near-but-distinct items (a function definition and its
   * caller share substantial token overlap but should NOT dedupe).
   */
  readonly dedupeThreshold?: number;
  /**
   * Max items to keep after relevance scoring. Items below this rank are
   * dropped entirely. When absent, no items are dropped from the
   * relevance pass — items are only reordered. Set when you want a hard
   * top-K filter.
   */
  readonly relevanceTopK?: number;
  /**
   * Embedder supplied by the caller. Required if any item lacks a
   * pre-computed `embedding` AND either dedupe or relevance reorder is
   * requested. The function-level types let it stay optional for the
   * pre-embedded case (most production callers).
   */
  readonly embedder?: EmbedderFn;
};

export const DEFAULT_DEDUPE_THRESHOLD = 0.92;

function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length) {
    throw new CompactionCuratorError(`embedding dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Ensure every input item has an embedding. Items already carrying one
 * pass through; items missing one are batched into a single embedder
 * call. Preserves order so the caller's downstream indexing isn't
 * disturbed.
 */
async function ensureEmbeddings(
  items: ReadonlyArray<Item>,
  embedder: EmbedderFn | undefined,
): Promise<ReadonlyArray<ReadonlyArray<number>>> {
  if (items.length === 0) return [];
  const missingIdx: number[] = [];
  const missingTexts: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item !== undefined && item.embedding === undefined) {
      missingIdx.push(i);
      missingTexts.push(item.text);
    }
  }
  if (missingIdx.length > 0 && embedder === undefined) {
    throw new CompactionCuratorError(
      `${missingIdx.length} item(s) lack pre-computed embeddings and no embedder was supplied — pass options.embedder or pre-embed your items`,
    );
  }
  const fresh = embedder !== undefined && missingIdx.length > 0 ? await embedder(missingTexts) : [];
  return items.map((item, i) => {
    if (item.embedding !== undefined) return item.embedding;
    const slot = missingIdx.indexOf(i);
    if (slot === -1) {
      throw new CompactionCuratorError(`internal: missing embedding for item ${i}`);
    }
    const v = fresh[slot];
    if (v === undefined) {
      throw new CompactionCuratorError(`embedder returned no vector for item ${i}`);
    }
    return v;
  });
}

/**
 * Pass 1 — semantic dedupe. For each item, if a *prior* item's embedding
 * has cosine ≥ threshold, drop the current. Order-preserving: the first
 * occurrence wins (keeps the head of the conversation, which carries
 * goal-setting context).
 */
export function dedupeBySimilarity(
  items: ReadonlyArray<Item>,
  embeddings: ReadonlyArray<ReadonlyArray<number>>,
  threshold: number,
): { kept: ReadonlyArray<number>; dropped: ReadonlyArray<number> } {
  const kept: number[] = [];
  const dropped: number[] = [];
  for (let i = 0; i < items.length; i++) {
    let isDuplicate = false;
    for (const k of kept) {
      const e1 = embeddings[i];
      const e2 = embeddings[k];
      if (e1 === undefined || e2 === undefined) continue;
      if (cosine(e1, e2) >= threshold) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) dropped.push(i);
    else kept.push(i);
  }
  return { kept, dropped };
}

/**
 * Pass 2 — relevance reorder. Compute cosine(query, item) for every
 * surviving item; return indices in descending similarity order.
 * Stable sort: items with identical similarity stay in original order.
 *
 * When `topK` is supplied, items beyond that rank are dropped.
 */
export async function rankByRelevance(
  items: ReadonlyArray<Item>,
  itemEmbeddings: ReadonlyArray<ReadonlyArray<number>>,
  query: string,
  embedder: EmbedderFn | undefined,
  topK?: number,
): Promise<ReadonlyArray<number>> {
  if (items.length === 0) return [];
  if (embedder === undefined) {
    throw new CompactionCuratorError(
      "rankByRelevance requires an embedder to compute the query vector",
    );
  }
  const queryVecs = await embedder([query]);
  const queryVec = queryVecs[0];
  if (queryVec === undefined) {
    throw new CompactionCuratorError("embedder returned no vector for the query");
  }
  const scored: Array<{ idx: number; sim: number; original: number }> = [];
  for (let i = 0; i < items.length; i++) {
    const e = itemEmbeddings[i];
    if (e === undefined) continue;
    scored.push({ idx: i, sim: cosine(queryVec, e), original: i });
  }
  scored.sort((a, b) => {
    if (a.sim !== b.sim) return b.sim - a.sim;
    return a.original - b.original; // stable
  });
  const ordered = scored.map((s) => s.idx);
  if (topK !== undefined && ordered.length > topK) return ordered.slice(0, topK);
  return ordered;
}

export type CurationResult = {
  /** Items in the curated order (deduped + relevance-ranked + topK-trimmed). */
  readonly items: ReadonlyArray<Item>;
  /** Indices into the *original* input array, in output order. */
  readonly originalIndices: ReadonlyArray<number>;
  /** Indices that were dropped (in original order). */
  readonly droppedIndices: ReadonlyArray<number>;
  /** Bytes saved as compared to the original total (text only). */
  readonly bytesSaved: number;
};

/**
 * High-level entry: dedupe then relevance-reorder (when a query is
 * supplied) then top-K filter. The most common call from
 * `compaction-autocompact` is `curate(items, { query, embedder })`.
 */
export async function curate(
  items: ReadonlyArray<Item>,
  opts: CurateOptions = {},
): Promise<CurationResult> {
  if (items.length === 0) {
    return { items: [], originalIndices: [], droppedIndices: [], bytesSaved: 0 };
  }
  const threshold = opts.dedupeThreshold ?? DEFAULT_DEDUPE_THRESHOLD;
  const embeddings = await ensureEmbeddings(items, opts.embedder);
  const { kept, dropped } = dedupeBySimilarity(items, embeddings, threshold);
  let surviving: ReadonlyArray<number> = kept;
  const droppedAll: number[] = [...dropped];
  if (opts.query !== undefined && opts.query.length > 0) {
    const subItems = surviving.map((i) => items[i]).filter((it): it is Item => it !== undefined);
    const subEmbeddings = surviving
      .map((i) => embeddings[i])
      .filter((e): e is ReadonlyArray<number> => e !== undefined);
    const localOrder = await rankByRelevance(
      subItems,
      subEmbeddings,
      opts.query,
      opts.embedder,
      opts.relevanceTopK,
    );
    const localToOriginal: ReadonlyArray<number> = surviving;
    surviving = localOrder
      .map((localIdx) => localToOriginal[localIdx])
      .filter((i): i is number => i !== undefined);
    if (opts.relevanceTopK !== undefined) {
      const survivingSet = new Set(surviving);
      for (const i of kept) if (!survivingSet.has(i)) droppedAll.push(i);
    }
  }
  const outItems = surviving.map((i) => items[i]).filter((it): it is Item => it !== undefined);
  const droppedTotal = droppedAll
    .map((i) => items[i])
    .filter((it): it is Item => it !== undefined)
    .reduce((acc, it) => acc + Buffer.byteLength(it.text, "utf8"), 0);
  return {
    items: outItems,
    originalIndices: surviving,
    droppedIndices: [...droppedAll].sort((a, b) => a - b),
    bytesSaved: droppedTotal,
  };
}
