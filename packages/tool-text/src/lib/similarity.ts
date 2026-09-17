import { tokenize } from "./locate";

/** Classic Levenshtein edit distance, two-row variant. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1);
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (cur[j - 1] as number) + 1,
        (prev[j] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
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
  const aFlags = new Array<boolean>(a.length).fill(false);
  const bFlags = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (bFlags[j] === true || a[i] !== b[j]) continue;
      aFlags[i] = true;
      bFlags[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (aFlags[i] !== true) continue;
    while (bFlags[k] !== true) k++;
    if (a[i] !== b[k]) transpositions++;
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
