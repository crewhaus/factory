/**
 * Lexical retrieval: an inverted index and Okapi BM25 ranking over it.
 *
 * LEXICAL ONLY. There are no embeddings here and no semantic matching of any
 * kind — a document scores because it literally contains the query's terms.
 * A search for "car" will not find "automobile". That is the honest limit of
 * a deterministic retriever, and it is the reason this is worth having: the
 * same corpus and the same query always produce the same ranking, with no
 * model call and no vector store.
 *
 * The scoring function is the standard one:
 *
 *   score(D,Q) = Σ_t  idf(t) · ( f(t,D)·(k1+1) ) / ( f(t,D) + k1·(1−b+b·|D|/avgdl) )
 *   idf(t)     = ln( 1 + (N − df(t) + 0.5) / (df(t) + 0.5) )
 *
 * with `k1` controlling how fast term frequency saturates and `b` how hard
 * long documents are penalised. The defaults are the usual `k1 = 1.2`,
 * `b = 0.75`; both are caller-tunable and both are reported in every result
 * so a ranking can be reproduced later.
 *
 * The `+1` inside the idf logarithm is the non-negative variant. The classic
 * Robertson/Sparck-Jones idf goes NEGATIVE once a term appears in more than
 * half the corpus, which perversely penalises a document for containing a
 * query term; this form floors it instead, so a term that appears everywhere
 * keeps a small positive weight and a rare term still dominates it.
 *
 * Tokenisation is Unicode-aware case folding on non-word boundaries. There is
 * no stemming and no stop-word list: "running" and "run" are different terms,
 * and common words are handled by idf rather than by a hardcoded list that
 * would be wrong in another language.
 */

/** Default term-frequency saturation. */
export const DEFAULT_K1 = 1.2;
/** Default length normalisation: 0 disables it, 1 applies it fully. */
export const DEFAULT_B = 0.75;
/** Longest token kept; anything longer is a checksum or a minified blob. */
const MAX_TOKEN_LENGTH = 64;

/** A document as the caller hands it over. */
export type IndexDoc = {
  readonly id: string;
  readonly text: string;
  readonly title?: string;
  readonly bytes?: number;
  readonly mtimeMs?: number;
};

/** What the index remembers about a document — never its text. */
export type IndexEntry = {
  readonly id: string;
  /** Token count, used for length normalisation. */
  readonly length: number;
  readonly title?: string;
  readonly bytes?: number;
  readonly mtimeMs?: number;
};

/** A posting: the document's position in `docs`, and the term frequency. */
export type Posting = readonly [number, number];

/** A serialisable inverted index. Term keys are sorted, so JSON is stable. */
export type InvertedIndex = {
  readonly version: 1;
  readonly docs: ReadonlyArray<IndexEntry>;
  readonly postings: Readonly<Record<string, ReadonlyArray<Posting>>>;
  /** Total tokens across every document, for the average-length term. */
  readonly totalTerms: number;
};

export type Bm25Params = { readonly k1: number; readonly b: number };

export type Hit = {
  readonly id: string;
  readonly score: number;
  /** Which query terms this document actually contained, sorted. */
  readonly matchedTerms: ReadonlyArray<string>;
  readonly entry: IndexEntry;
};

export type SearchResult = {
  /** The query's distinct terms, sorted. */
  readonly terms: ReadonlyArray<string>;
  /** Terms with no posting list at all, sorted. */
  readonly unknownTerms: ReadonlyArray<string>;
  /**
   * How many documents matched at least one term and cleared `minScore`,
   * before `limit` was applied.
   */
  readonly matched: number;
  readonly hits: ReadonlyArray<Hit>;
};

/** Case-folded word tokens: letters, digits and underscore, nothing else. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length > 0 && raw.length <= MAX_TOKEN_LENGTH) out.push(raw);
  }
  return out;
}

/** Distinct tokens of a query, sorted so the reported term list is stable. */
export function queryTerms(query: string): string[] {
  return [...new Set(tokenize(query))].sort();
}

/**
 * Build an inverted index over `docs`, in the order given. Callers sort the
 * documents first so that two builds over the same corpus are byte-identical.
 */
export function buildIndex(docs: ReadonlyArray<IndexDoc>): InvertedIndex {
  const entries: IndexEntry[] = [];
  const byTerm = new Map<string, Posting[]>();
  let totalTerms = 0;

  docs.forEach((doc, docIndex) => {
    const tokens = tokenize(doc.text);
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const [term, tf] of frequencies) {
      const list = byTerm.get(term);
      if (list === undefined) byTerm.set(term, [[docIndex, tf]]);
      else list.push([docIndex, tf]);
    }
    totalTerms += tokens.length;
    entries.push({
      id: doc.id,
      length: tokens.length,
      ...(doc.title !== undefined ? { title: doc.title } : {}),
      ...(doc.bytes !== undefined ? { bytes: doc.bytes } : {}),
      ...(doc.mtimeMs !== undefined ? { mtimeMs: doc.mtimeMs } : {}),
    });
  });

  // A NULL-PROTOTYPE object, because a term is arbitrary text from a document:
  // `postings["__proto__"] = […]` on a normal object literal sets the
  // prototype instead of a key, which silently loses that term AND corrupts
  // the index. With no prototype there is nothing to shadow.
  const postings: Record<string, ReadonlyArray<Posting>> = Object.create(null);
  for (const term of [...byTerm.keys()].sort()) {
    postings[term] = byTerm.get(term) ?? [];
  }
  return { version: 1, docs: entries, postings, totalTerms };
}

/**
 * The posting list for `term`, or `undefined` when the index has none.
 *
 * Read through `hasOwnProperty`, never as a plain property access: an index
 * that has been through JSON has an ordinary prototype, so `postings["toString"]`
 * would hand back a FUNCTION and `postings["__proto__"]` an object — and the
 * loop below would then throw "not iterable" out of the tool for any query
 * containing those perfectly ordinary English words. The shape is checked
 * too, so a hand-edited index cannot smuggle a non-pair through the scorer.
 */
function postingsFor(index: InvertedIndex, term: string): ReadonlyArray<Posting> | undefined {
  if (!Object.prototype.hasOwnProperty.call(index.postings, term)) return undefined;
  const postings = index.postings[term];
  if (!Array.isArray(postings) || postings.length === 0) return undefined;
  const usable = postings.filter(
    (posting): posting is Posting =>
      Array.isArray(posting) &&
      posting.length === 2 &&
      typeof posting[0] === "number" &&
      typeof posting[1] === "number",
  );
  return usable.length === 0 ? undefined : usable;
}

/** Scores are rounded here so the same ranking serialises to the same bytes. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Rank the index's documents against `query`.
 *
 * Ties break on document id, ascending, by plain code-unit comparison — never
 * `localeCompare`, whose ordering is machine-dependent.
 */
export function searchIndex(
  index: InvertedIndex,
  query: string,
  options: {
    readonly k1?: number;
    readonly b?: number;
    readonly limit?: number;
    readonly minScore?: number;
  } = {},
): SearchResult {
  const k1 = options.k1 ?? DEFAULT_K1;
  const b = options.b ?? DEFAULT_B;
  const limit = options.limit ?? 10;
  const minScore = options.minScore ?? 0;
  const terms = queryTerms(query);
  const docCount = index.docs.length;
  const avgLength = docCount === 0 ? 0 : index.totalTerms / docCount;

  const scores = new Map<number, number>();
  const matchedTerms = new Map<number, string[]>();
  const unknownTerms: string[] = [];

  for (const term of terms) {
    const postings = postingsFor(index, term);
    if (postings === undefined) {
      unknownTerms.push(term);
      continue;
    }
    const df = postings.length;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    for (const [docIndex, tf] of postings) {
      const entry = index.docs[docIndex];
      if (entry === undefined) continue; // a posting pointing nowhere: skip it
      const norm = avgLength === 0 ? 1 : 1 - b + (b * entry.length) / avgLength;
      const contribution = (idf * (tf * (k1 + 1))) / (tf + k1 * norm);
      scores.set(docIndex, (scores.get(docIndex) ?? 0) + contribution);
      const seen = matchedTerms.get(docIndex);
      if (seen === undefined) matchedTerms.set(docIndex, [term]);
      else seen.push(term);
    }
  }

  const hits: Hit[] = [];
  for (const [docIndex, raw] of scores) {
    const entry = index.docs[docIndex];
    if (entry === undefined) continue;
    const score = round(raw);
    if (score < minScore) continue;
    hits.push({
      id: entry.id,
      score,
      matchedTerms: (matchedTerms.get(docIndex) ?? []).slice().sort(),
      entry,
    });
  }
  hits.sort((x, y) => (y.score !== x.score ? y.score - x.score : x.id < y.id ? -1 : 1));

  return {
    terms,
    unknownTerms,
    matched: hits.length,
    hits: limit >= 0 ? hits.slice(0, limit) : hits,
  };
}

/** Structural check, so a hand-edited or half-written index file is reported. */
export function isInvertedIndex(value: unknown): value is InvertedIndex {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate["version"] !== 1) return false;
  if (typeof candidate["totalTerms"] !== "number") return false;
  const docs = candidate["docs"];
  if (!Array.isArray(docs)) return false;
  for (const doc of docs) {
    if (typeof doc !== "object" || doc === null) return false;
    const entry = doc as Record<string, unknown>;
    if (typeof entry["id"] !== "string" || typeof entry["length"] !== "number") return false;
  }
  const postings = candidate["postings"];
  if (typeof postings !== "object" || postings === null || Array.isArray(postings)) return false;
  for (const list of Object.values(postings)) {
    if (!Array.isArray(list)) return false;
  }
  return true;
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * The first whole-word occurrence of any term, as a trimmed window of text.
 *
 * Deliberately simple: the earliest match wins rather than the densest one,
 * so the snippet is cheap and stable. Returns `undefined` when no term occurs
 * in the text (a document can still score on a term it shares with the query
 * only through another field, e.g. its title).
 */
export function snippet(
  text: string,
  terms: ReadonlyArray<string>,
  maxChars: number,
): string | undefined {
  if (maxChars <= 0 || terms.length === 0) return undefined;
  const haystack = text.toLowerCase();
  let best = -1;
  for (const term of terms) {
    let from = 0;
    while (from <= haystack.length) {
      const at = haystack.indexOf(term, from);
      if (at === -1) break;
      const before = at === 0 ? "" : (haystack[at - 1] ?? "");
      const after = haystack[at + term.length] ?? "";
      if (!isWordChar(before) && !isWordChar(after)) {
        if (best === -1 || at < best) best = at;
        break;
      }
      from = at + 1;
    }
  }
  if (best === -1) return undefined;
  const lead = Math.floor(maxChars / 3);
  const start = Math.max(0, best - lead);
  const end = Math.min(text.length, start + maxChars);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}
