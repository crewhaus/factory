import { tokenize } from "./locate";

/**
 * Classic Levenshtein edit distance, two-row variant, over UTF-16 code
 * units. The rows are typed arrays reused across the table, not a fresh
 * array per row: the same answers at a fraction of the time per cell.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = b.length;
  // Int32, not Uint32: an unsigned element can exceed 2^31, so the engine
  // reads Uint32 cells as doubles and the table ran four times slower.
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      let best = (prev[j - 1] as number) + (ai === b.charCodeAt(j - 1) ? 0 : 1);
      const insert = (cur[j - 1] as number) + 1;
      if (insert < best) best = insert;
      const remove = (prev[j] as number) + 1;
      if (remove < best) best = remove;
      cur[j] = best;
    }
    const done = prev;
    prev = cur;
    cur = done;
  }
  return prev[m] as number;
}

/** Edit distance expressed as a 0..1 similarity. */
export function levenshteinRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Jaro-Winkler, which rewards a shared prefix — good for names and ids. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  // Typed flags and code units: the same answers, at a fraction of the time
  // per window step.
  const aFlags = new Uint8Array(a.length);
  const bFlags = new Uint8Array(b.length);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    const ai = a.charCodeAt(i);
    for (let j = lo; j <= hi; j++) {
      if (bFlags[j] === 1 || ai !== b.charCodeAt(j)) continue;
      aFlags[i] = 1;
      bFlags[j] = 1;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (aFlags[i] !== 1) continue;
    while (bFlags[k] !== 1) k++;
    if (a.charCodeAt(i) !== b.charCodeAt(k)) transpositions++;
    k++;
  }
  const t = transpositions / 2;
  const jaro = (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Character n-grams, the basis for trigram similarity. */
export function nGrams(text: string, n: number): Set<string> {
  const padded = ` ${text.toLowerCase()} `;
  const out = new Set<string>();
  for (let i = 0; i + n <= padded.length; i++) out.add(padded.slice(i, i + n));
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export type SimilarityMethod = "levenshtein" | "jaro" | "trigram" | "tokenJaccard";

/**
 * The most work one Levenshtein or Jaro comparison may do, in Levenshtein
 * cells: about a second of one thread. Both methods are O(n x m) and run
 * synchronously on the harness thread, so two 20,000-character strings
 * stalled every session in the process; this refuses those and still
 * answers the sizes 0.7.0 answered in a fraction of a second.
 */
export const MAX_SIMILARITY_WORK = 200_000_000;

/**
 * A Jaro cell (one step of the matching window) costs about a quarter of a
 * Levenshtein cell, measured: 25 M of them take 30-40 ms where 25 M
 * Levenshtein cells take over 100 ms.
 */
const JARO_CELLS_PER_UNIT = 4;

/**
 * The work one comparison does, in Levenshtein cells: the DP table for
 * Levenshtein, the matching window for Jaro at its measured discount.
 * Trigram and token overlap are linear, so they cost nothing against the
 * quadratic budget.
 */
export function similarityCost(a: string, b: string, method: SimilarityMethod): number {
  if (a === b || a.length === 0 || b.length === 0) return 0;
  if (method === "levenshtein") return a.length * b.length;
  if (method === "jaro") {
    const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    return Math.ceil((a.length * Math.min(b.length, 2 * window + 1)) / JARO_CELLS_PER_UNIT);
  }
  return 0;
}

export function similarity(a: string, b: string, method: SimilarityMethod): number {
  if (method === "levenshtein") return levenshteinRatio(a, b);
  if (method === "jaro") return jaroWinkler(a, b);
  if (method === "trigram") return jaccard(nGrams(a, 3), nGrams(b, 3));
  return jaccard(new Set(tokenize(a)), new Set(tokenize(b)));
}

export type FuzzyHit = {
  readonly candidate: string;
  readonly score: number;
  readonly index: number;
};

/** Rank candidates against a query, best first, ties broken by input order. */
export function fuzzyRank(
  query: string,
  candidates: ReadonlyArray<string>,
  method: SimilarityMethod,
  minScore: number,
  limit: number,
): FuzzyHit[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: similarity(query, candidate, method) }))
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit);
}

/** Very common words carry no signal; excluding them is what makes a keyword
 *  list readable rather than a list of "the, and, of". */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "he",
  "her",
  "his",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "she",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "was",
  "were",
  "which",
  "who",
  "will",
  "with",
  "you",
  "your",
  "we",
  "our",
  "i",
  "not",
  "no",
  "can",
  "could",
  "should",
  "would",
  "do",
  "does",
  "did",
  "been",
  "being",
  "had",
  "how",
  "what",
  "when",
  "where",
  "why",
  "all",
  "any",
  "each",
  "more",
  "most",
  "other",
  "some",
  "such",
  "than",
  "too",
  "very",
  "just",
  "also",
  "may",
  "might",
  "must",
  "one",
  "two",
  "get",
  "got",
  "make",
  "made",
  "use",
]);

export type Keyword = { readonly term: string; readonly count: number; readonly score: number };

/**
 * Rank terms by frequency with a length bonus, so multi-character terms beat
 * short noise. Single-document term frequency only: there is no corpus here
 * to compute a real inverse document frequency against, and inventing one
 * would make the score depend on hidden state.
 */
export function extractKeywords(text: string, limit: number, minLength: number): Keyword[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    if (token.length < minLength) continue;
    if (STOP_WORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count, score: count * Math.log2(term.length + 1) }))
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, limit);
}
