/**
 * Deterministic text heuristics backing the continuity graders — NO model
 * calls anywhere (design §7.3: memory-quality evals must run offline and
 * reproducibly, exactly like the stores they measure).
 *
 * The load-bearing detection rules, pinned by tests:
 *
 * RE-ASK — a QUESTION-shaped assistant sentence (ends with `?`) whose
 * content-token set (lowercased alphanumeric tokens, ≥3 chars, stopwords
 * dropped, at least {@link MIN_QUESTION_TOKENS} tokens) is covered
 * ≥{@link REASK_COVERAGE} by an earlier user statement or by a confirmed/
 * open REQ ledger entry from an EARLIER session. Token coverage is the
 * deterministic stand-in for "the answer already exists near-verbatim": a
 * clarifying question necessarily names the thing it asks about, so a
 * question whose content words all appeared in what the user already said
 * is asking about already-supplied information.
 *
 * REQ-WORTHY — a user sentence carrying a requirement marker
 * ({@link REQ_MARKER_REGEX}: must / should / need / require / never /
 * always / ensure / make sure / don't / has-have to / want) with ≥3
 * content tokens. This mirrors what the §2.3 ledger discipline tells the
 * model to pin.
 *
 * DONE-CLAIM — a non-question assistant sentence in completed-work form
 * ({@link DONE_CLAIM_REGEX}): a first-person past-tense completion ("I
 * (have) implemented/fixed/deployed/…"), a state-of-completion assertion
 * ("X is/has been done/complete/deployed/…"), or "marked … as done".
 * Intent ("I will…", "implementing…") deliberately does not match — the
 * proof ladder never penalizes honest in-progress narration.
 */

/** Minimum content tokens for a question to be considered for re-ask
 *  matching — one-token questions ("Why?") carry no matchable content. */
export const MIN_QUESTION_TOKENS = 2;

/** Fraction of a question's content tokens that must already exist in a
 *  prior user statement / earlier-session REQ entry to call it a re-ask. */
export const REASK_COVERAGE = 0.6;

/** Fraction of a REQ statement's tokens a focus-ledger entry must cover
 *  (either direction) to count the statement as retained. */
export const RETENTION_COVERAGE = 0.6;

/** Fraction of a handoff cue line's tokens that session 2's first turn must
 *  contain to count as "acting on the handoff". */
export const PICKUP_CUE_COVERAGE = 0.5;

const STOPWORDS = new Set([
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

/** Split text into sentences: newline-separated, then on `.`/`!`/`?`
 *  boundaries (the terminator stays attached, so `isQuestion` works). */
export function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\n+/)) {
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      const s = part.trim();
      if (s !== "") out.push(s);
    }
  }
  return out;
}

export function isQuestion(sentence: string): boolean {
  return sentence.trimEnd().endsWith("?");
}

/** Question-shaped sentences of an assistant turn. */
export function questionSentences(text: string): string[] {
  return sentences(text).filter(isQuestion);
}

/** Requirement markers a user sentence must carry to be REQ-worthy. */
export const REQ_MARKER_REGEX =
  /\b(must|should|need(?:s|ed)?|require[sd]?|never|always|ensure|make sure|don't|do not|has to|have to|want)\b/i;

/** REQ-worthy sentences of a user message (see the module header). */
export function reqWorthySentences(text: string): string[] {
  return sentences(text).filter(
    (s) => REQ_MARKER_REGEX.test(s) && contentTokens(s).size >= 3 && !isQuestion(s),
  );
}

/** Past-tense completed-work claims (see the module header). */
export const DONE_CLAIM_REGEX =
  /\b(i(?:'ve| have)?(?: now| also| just)? (?:completed|finished|implemented|fixed|deployed|created|built|updated|wrote|added|shipped|migrated|merged)|(?:is|are|was|were|has been|have been)(?: now| all)? (?:complete|completed|done|finished|deployed|fixed|implemented|shipped|merged)|marked [^.?!]* as (?:done|complete))\b/i;

/** Non-question assistant sentences that claim completed work. */
export function doneClaimSentences(text: string): string[] {
  return sentences(text).filter((s) => !isQuestion(s) && DONE_CLAIM_REGEX.test(s));
}

/** Lowercase + collapse whitespace, for verbatim-containment checks
 *  (evicted `context_evicted` records carry the message verbatim). */
export function normalizeVerbatim(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
