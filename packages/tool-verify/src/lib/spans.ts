/**
 * Locating a claim's words inside a source.
 *
 * This is the whole of what a deterministic cross-check can do, and the limit
 * is the point. Finding the span of a source that carries a claim's words
 * establishes that the source SAYS the thing. It establishes nothing about
 * whether the thing is true, and a span that cannot be found means only that
 * it could not be found — not that the source says otherwise.
 *
 * Everything here is pure and offline. Nothing fetches, and no rule guesses
 * at meaning: the two places where a guess is tempting — numeric spellings
 * and word endings — are both deliberately narrow, and say so.
 */

export type SourceToken = {
  /** Compared against. */
  readonly norm: string;
  /** As written, for the excerpt. */
  readonly raw: string;
  /** Character offset into the folded text, so an excerpt and a line number
   *  both come from the same string the tokens were cut from. */
  readonly at: number;
};

export type SourceIndex = {
  readonly tokens: ReadonlyArray<SourceToken>;
  /** The typography-folded text the offsets belong to. */
  readonly text: string;
  readonly lineStarts: ReadonlyArray<number>;
};

/**
 * Grammatical negation only.
 *
 * A negation is never a stopword: dropping the "not" out of "revenue did not
 * rise" would let the source's "revenue rose" answer for it, which is the one
 * way a word-matching check can call a claim supported by a span that says
 * the opposite. Lexical negatives ("fails", "lacks") are left out on purpose —
 * they are ordinary content words, and treating them as polarity would fire
 * on every source that happens to mention a failure nearby.
 */
export const NEGATIONS: ReadonlySet<string> = new Set([
  "no",
  "not",
  "never",
  "none",
  "nor",
  "neither",
  "without",
  "cannot",
  "can't",
  "won't",
  "don't",
  "doesn't",
  "didn't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "hasn't",
  "haven't",
  "hadn't",
  "couldn't",
  "wouldn't",
  "shouldn't",
]);

/**
 * Words that carry no claim on their own.
 *
 * Kept short and literal: articles, conjunctions, plain prepositions, copulas
 * and pronouns. Modals ("may", "will", "could") are NOT here — "may rise" and
 * "rises" are different claims, and a source that only supports the second
 * should not answer for the first.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "of",
  "to",
  "in",
  "into",
  "on",
  "at",
  "by",
  "for",
  "from",
  "with",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "that",
  "this",
  "these",
  "those",
  "it",
  "they",
  "them",
  "their",
  "we",
  "our",
  "us",
  "you",
  "your",
  "he",
  "she",
  "his",
  "her",
  "there",
  "here",
  "such",
  "also",
  "than",
  "then",
  "so",
  "which",
  "who",
  "whom",
  "whose",
]);

/**
 * Curly quotes folded to straight ones, one character for one character.
 *
 * The 1:1 rule is load-bearing: every offset in the index is an offset into
 * the folded text, so a fold that changed a length would move every excerpt
 * and line number after it.
 */
export function foldTypography(text: string): string {
  return text.replace(/[‘’‛]/g, "'").replace(/[“”„‟]/g, '"');
}

/**
 * A number (with its percent sign, if it has one) or a word.
 *
 * The percent sign belongs to the token on purpose: "4.5%" and "4.5" are
 * different figures, and a tokenizer that dropped the sign would let a source
 * saying 4.5 support a claim of 4.5%.
 */
const TOKEN = /\d+(?:[.,]\d+)*%?|[\p{L}\p{N}]+(?:'[\p{L}]+)*/gu;

/** The comparable form of one token. */
export function normalizeToken(raw: string): string {
  let t = raw.toLowerCase();
  // Grouped thousands are the one numeric respelling safe to collapse: the
  // pattern is unambiguous. `1.200` is left alone, because a dot is a decimal
  // point in one locale and a group separator in another — a tool that
  // guessed would report a different figure as the claimed one. Parse the
  // shape first, then act on the parsed form, never on the raw string.
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?%?$/.test(t)) t = t.replace(/,/g, "");
  if (t.endsWith("'s")) t = t.slice(0, -2);
  // Plural fold, minimal on purpose: a trailing "s" on a word of five letters
  // or more, never on "-ss". Anything cleverer (real stemming) starts calling
  // claims supported on words the source does not contain, and "supported" is
  // the one verdict here that must not be generous.
  if (t.length >= 5 && !t.endsWith("ss") && t.endsWith("s") && /^[\p{L}]+$/u.test(t)) {
    t = t.slice(0, -1);
  }
  return t;
}

/** Every token of a text, in order, with offsets into that same text. */
export function tokenize(text: string): SourceToken[] {
  const out: SourceToken[] = [];
  for (const m of text.matchAll(TOKEN)) {
    if (m.index === undefined) continue;
    out.push({ norm: normalizeToken(m[0]), raw: m[0], at: m.index });
  }
  return out;
}

/**
 * The words of a claim that a source has to contain for the claim to have
 * been located: distinct, in first-seen order, stopwords dropped, negations
 * kept.
 */
export function contentTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenize(foldTypography(text))) {
    if (STOPWORDS.has(token.norm)) continue;
    if (seen.has(token.norm)) continue;
    seen.add(token.norm);
    out.push(token.norm);
  }
  return out;
}

/** Every token of a source, plus what an excerpt and a line number need. */
export function indexSource(text: string): SourceIndex {
  const folded = foldTypography(text);
  const lineStarts = [0];
  for (let i = folded.indexOf("\n"); i !== -1; i = folded.indexOf("\n", i + 1)) {
    lineStarts.push(i + 1);
  }
  return { tokens: tokenize(folded), text: folded, lineStarts };
}

/** The 1-based line a character offset falls on. */
export function lineOf(index: SourceIndex, offset: number): number {
  let lo = 0;
  let hi = index.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((index.lineStarts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The source's own words over a token range, whitespace collapsed. */
export function spanExcerpt(
  index: SourceIndex,
  fromToken: number,
  toToken: number,
  maxChars: number,
): string {
  const tokens = index.tokens;
  if (fromToken < 0 || tokens.length === 0) return "";
  const first = tokens[Math.min(fromToken, tokens.length - 1)] as SourceToken;
  const last = tokens[Math.min(Math.max(toToken, fromToken), tokens.length - 1)] as SourceToken;
  const text = index.text
    .slice(first.at, last.at + last.raw.length)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export type BestSpan = {
  /** How many of the claim's words the best span carries. */
  readonly matched: number;
  readonly total: number;
  /** The claim's words that span does not carry, in the claim's order. */
  readonly missing: ReadonlyArray<string>;
  /** Words inside the matched span that the claim does not have, in order. */
  readonly extra: ReadonlyArray<string>;
  /** Negations inside the matched span that the claim does not have. */
  readonly extraNegations: ReadonlyArray<string>;
  /** Token indices of the matched span itself, or -1 when nothing matched. */
  readonly firstToken: number;
  readonly lastToken: number;
};

const EMPTY_SPAN = (need: ReadonlyArray<string>): BestSpan => ({
  matched: 0,
  total: need.length,
  missing: [...need],
  extra: [],
  extraNegations: [],
  firstToken: -1,
  lastToken: -1,
});

/**
 * The window of at most `windowTokens` consecutive source tokens that carries
 * the most of `need`.
 *
 * One left-to-right pass with a running count, so a large source costs its
 * size once per claim rather than once per candidate position. Ties go to the
 * earliest window, which is what makes the result stable — never rely on the
 * order two equally good spans happen to be visited in.
 */
export function bestSpan(
  index: SourceIndex,
  need: ReadonlyArray<string>,
  windowTokens: number,
): BestSpan {
  const tokens = index.tokens;
  if (need.length === 0 || tokens.length === 0) return EMPTY_SPAN(need);
  const want = new Set(need);
  // A window smaller than the claim could never hold all of it.
  const width = Math.min(Math.max(windowTokens, need.length), tokens.length);

  const counts = new Map<string, number>();
  let matched = 0;
  let bestMatched = -1;
  let bestStart = 0;
  for (let i = 0; i < tokens.length; i++) {
    const entering = (tokens[i] as SourceToken).norm;
    if (want.has(entering)) {
      const next = (counts.get(entering) ?? 0) + 1;
      counts.set(entering, next);
      if (next === 1) matched++;
    }
    if (i >= width) {
      const leaving = (tokens[i - width] as SourceToken).norm;
      if (want.has(leaving)) {
        const next = (counts.get(leaving) as number) - 1;
        counts.set(leaving, next);
        if (next === 0) matched--;
      }
    }
    if (i >= width - 1 && matched > bestMatched) {
      bestMatched = matched;
      bestStart = i - width + 1;
    }
  }
  if (bestMatched <= 0) return EMPTY_SPAN(need);

  // Second pass over the one winning window. Everything reported — the
  // missing words, the extras, the polarity — is measured across the MATCHED
  // span rather than the whole window: a negation sixty tokens away from any
  // of the claim's words is not this claim's negation.
  const end = Math.min(bestStart + width, tokens.length);
  let firstToken = -1;
  let lastToken = -1;
  const present = new Set<string>();
  for (let i = bestStart; i < end; i++) {
    const token = tokens[i] as SourceToken;
    if (!want.has(token.norm)) continue;
    present.add(token.norm);
    if (firstToken === -1) firstToken = i;
    lastToken = i;
  }
  const extra: string[] = [];
  const extraNegations: string[] = [];
  const seenExtra = new Set<string>();
  for (let i = firstToken; i <= lastToken; i++) {
    const token = tokens[i] as SourceToken;
    if (want.has(token.norm) || seenExtra.has(token.norm)) continue;
    seenExtra.add(token.norm);
    // Stopwords are kept here, unlike in a claim's own words: this list is
    // what a verbatim quotation got wrong, and "we" for "anyone" is exactly
    // the substitution a caller needs to see.
    extra.push(token.norm);
    if (NEGATIONS.has(token.norm)) extraNegations.push(token.norm);
  }
  return {
    matched: present.size,
    total: need.length,
    missing: need.filter((t) => !present.has(t)),
    extra,
    extraNegations,
    firstToken,
    lastToken,
  };
}

/**
 * Where `sequence` appears as consecutive source tokens, or -1.
 *
 * Used for an attributed quotation, which is the strictest promise a citation
 * makes. Punctuation and whitespace are not compared — only the run of words —
 * so a quote that differs from the source in a comma still counts as found,
 * while one that differs in a word does not.
 */
export function findSequence(index: SourceIndex, sequence: ReadonlyArray<string>): number {
  const tokens = index.tokens;
  if (sequence.length === 0 || sequence.length > tokens.length) return -1;
  const head = sequence[0] as string;
  for (let i = 0; i + sequence.length <= tokens.length; i++) {
    if ((tokens[i] as SourceToken).norm !== head) continue;
    let ok = true;
    for (let j = 1; j < sequence.length; j++) {
      if ((tokens[i + j] as SourceToken).norm !== (sequence[j] as string)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * The spans a claim puts in quotation marks, as token runs.
 *
 * Only double quotes count. An apostrophe is a single quote far more often
 * than a quotation is, and a checker that read "the company's" as an opening
 * quote would invent quotations nobody made.
 */
export function quotedRuns(claim: string, minTokens: number): string[][] {
  const runs: string[][] = [];
  for (const m of foldTypography(claim).matchAll(/"([^"\n]{1,600})"/g)) {
    const words = tokenize(m[1] as string).map((t) => t.norm);
    if (words.length >= minTokens) runs.push(words);
  }
  return runs;
}
