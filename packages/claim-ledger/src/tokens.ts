/**
 * Content tokens and coverage — the bag-of-words measure the continuity and
 * faithfulness graders score with, and the one the provability gate uses to
 * test that a proof's recorded claim is the sentence it is attached to.
 *
 * Moved here from `grader-continuity/src/heuristics.ts` (design §4.1).
 * `grader-12-metric-rubric/src/faithfulness.ts` carried a byte-for-byte copy
 * because it could not declare the dependency edge when it was written; both
 * now import this one, so a continuity re-ask and a faithfulness grounding
 * are measured over the same tokens.
 *
 * Deliberately crude, and pinned that way: lowercased ASCII alphanumeric runs
 * of three characters or more, minus a fixed stopword list. No stemming, no
 * locale, no model — the same input gives the same set on every machine,
 * which is what lets a grader's verdict be replayed.
 *
 * This is NOT the tokenizer `locateClaim` uses: locating a claim's words
 * inside a source keeps short words, numbers with their separators, and
 * every negation (`locate.ts` says why). Two measures for two questions —
 * "is this about the same thing" here, "does the source say these words"
 * there.
 */

/**
 * Words that carry no content: articles, conjunctions, prepositions, the
 * be/do/have and modal scaffolding of a question, pronouns and determiners,
 * and a little conversational glue. "not" is in it — a coverage measure is
 * about topic, not polarity; `locate.ts` is where polarity is checked.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // articles, conjunctions, prepositions
  "the",
  "and",
  "but",
  "for",
  "nor",
  "with",
  "without",
  "from",
  "into",
  "onto",
  "over",
  "under",
  "about",
  "after",
  "before",
  "between",
  "through",
  "during",
  "until",
  "than",
  "then",
  // be/do/have + modals (question scaffolding, not content)
  "are",
  "was",
  "were",
  "been",
  "being",
  "does",
  "did",
  "doing",
  "has",
  "had",
  "have",
  "having",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "must",
  // pronouns + determiners
  "you",
  "your",
  "yours",
  "our",
  "ours",
  "their",
  "theirs",
  "they",
  "them",
  "she",
  "her",
  "him",
  "his",
  "its",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "what",
  "which",
  "when",
  "where",
  "who",
  "whom",
  "whose",
  "why",
  "how",
  "any",
  "all",
  "each",
  "every",
  "some",
  "one",
  // misc glue
  "not",
  "yes",
  "also",
  "just",
  "now",
  "very",
  "please",
  "again",
  "already",
  "still",
  "too",
  "out",
  "off",
  "get",
  "got",
  "let",
  "lets",
]);

/** Lowercased alphanumeric tokens, ≥3 chars, stopwords removed. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/** Fraction of `needle` tokens present in `haystack` (0 when needle empty). */
export function coverage(needle: ReadonlySet<string>, haystack: ReadonlySet<string>): number {
  if (needle.size === 0) return 0;
  let hit = 0;
  for (const t of needle) {
    if (haystack.has(t)) hit += 1;
  }
  return hit / needle.size;
}
