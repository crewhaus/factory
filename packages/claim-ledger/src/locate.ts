/**
 * Locating a claim's words inside a source.
 *
 * This is the whole of what a deterministic cross-check can do, and the limit
 * is the point. Finding the span of a source that carries a claim's words
 * establishes that the source SAYS the thing. It establishes nothing about
 * whether the thing is true, and a span that cannot be found means only that
 * it could not be found — not that the source says otherwise.
 *
 * Moved here from tool-verify's `lib/spans.ts` and FactCrossCheck's verdict
 * logic (design §4.1, §6.2), so the provability gate's `grounded` rung and
 * FactCrossCheck locate a claim with one kernel. FactCrossCheck asks for every
 * word (`coverage: 1`), as it always has; the gate asks for its configured
 * `grounded.coverage`, 0.8 by default.
 *
 * Everything here is pure and offline. Nothing fetches, and no rule guesses
 * at meaning: the two places where a guess is tempting — numeric spellings
 * and word endings — are both deliberately narrow, and say so. The one
 * respelling read below full coverage is the figure rule's (`figureKey`):
 * a figure is compared as the value the number layer reads, so a claim's
 * "thirty" or "$1,284.50" is the source's "30" or "1284.5" — and is never
 * among the words a partial bar lets go. The tokenizer keeps neither a
 * minus sign nor a magnitude glued after a numeral, so the rule reads both
 * off the characters around the token (`figureKeyAt`): "500" is not "-500",
 * and the "M" of "$5M" is a figure, "million".
 *
 * This tokenizer is not `contentTokens` (`tokens.ts`): it keeps short words,
 * numbers with their separators and percent signs, and every negation,
 * because the question here is "does the source say these words", not "is
 * this about the same thing".
 */
import { foldText } from "./fold";
import {
  type CompoundValue,
  compoundValues,
  figureWord,
  magnitudeSuffix,
  normalizeNumber,
  signedAt,
} from "./numbers";

export type SourceToken = {
  /** Compared against. */
  readonly norm: string;
  /** As folded (`foldTypography`): the token's characters in `text`. */
  readonly raw: string;
  /** Character offset into the folded text the tokens were cut from — and
   *  the written text's own outside a word the fold rearranged, so an
   *  excerpt is cut from what the source says (`writtenSpan`). */
  readonly at: number;
};

export type SourceIndex = {
  readonly tokens: ReadonlyArray<SourceToken>;
  /** The typography-folded text the offsets belong to. */
  readonly text: string;
  /** The text as written, where the fold changed it — what an excerpt is
   *  cut from (`spanExcerpt`, `writtenSpan`). Absent when the two are one. */
  readonly written?: string;
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
 * Curly quotes folded to straight ones, and every other spelling the reader
 * cannot tell apart folded to one (`fold.ts`): a digit of any script to its
 * ASCII digit, fullwidth and mathematical letters to ASCII, a Cyrillic or
 * Greek lookalike inside a Latin word to its Latin letter, and an ignorable
 * character out of the word it hides in — so "n\u200Bot" is a negation and
 * "٣٠" a figure on both sides of a comparison (design §6.2, §6.4).
 *
 * One character for one character. The 1:1 rule is load-bearing: every
 * offset in the index is an offset into the folded text, and the same
 * offset in the text as written outside the words the fold rearranges, so
 * a fold that changed a length would move every excerpt and line number
 * after it.
 */
export function foldTypography(text: string): string {
  return foldText(text);
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
 *
 * tool-verify's `lib/spans.ts` still exports this as `contentTokens`, its
 * name there; here that name belongs to the graders' Set-valued measure
 * (`tokens.ts`), which answers a different question.
 */
export function claimWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenize(foldTypography(text))) {
    if (STOPWORDS.has(token.norm) || SCRIPT_MARK.test(token.norm)) continue;
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
  const index = { tokens: tokenize(folded), text: folded, lineStarts };
  return folded === text ? index : { ...index, written: text };
}

/** What the fold reads as one word, and may rearrange inside (`fold.ts`). */
const FOLD_WORD = /[\p{L}\p{N}\p{M}\p{Default_Ignorable_Code_Point}]/u;
const FOLD_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
/** How far an excerpt's start or end is widened to the word it sits in, at most. */
const WORD_REACH = 64;

/** The code point that ends at `at` (one or two code units before it). */
function charBefore(text: string, at: number): string {
  const low = text.charCodeAt(at - 1);
  if (at >= 2 && low >= 0xdc00 && low <= 0xdfff) {
    const high = text.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(at - 2, at);
  }
  return text.slice(at - 1, at);
}

/** Where the folded word around `at` ends, or -1 when that is more than
 *  {@link WORD_REACH} code units on. */
function wordEnd(text: string, at: number): number {
  let end = at;
  while (end < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(end) as number);
    if (!FOLD_WORD.test(ch)) break;
    end += ch.length;
    if (end - at > WORD_REACH) return -1;
  }
  return end;
}

/** Where the folded word around `at` starts, or -1 when that is more than
 *  {@link WORD_REACH} code units back. */
function wordStart(text: string, at: number): number {
  let start = at;
  while (start > 0) {
    const ch = charBefore(text, start);
    if (!FOLD_WORD.test(ch)) break;
    start -= ch.length;
    if (at - start > WORD_REACH) return -1;
  }
  return start;
}

/**
 * The written text to cut `[from, to)` of the folded one from, and that
 * range in it (design §5.3: a frozen excerpt is the source's own words, so a
 * reader can find it in the page after the body is gone). The fold keeps
 * every length but moves a word's ignorable characters — a zero-width
 * joiner, a soft hyphen, the second code unit of a mathematical digit — to
 * its end ("می‌خواهم", "𝟑𝟎"), so inside such a word an offset of the folded
 * text is not the same character of the written one. A range that starts or
 * ends inside one is widened to the whole word, whose extent is the same in
 * both; anywhere else the offsets are the written text's own. A word longer
 * than {@link WORD_REACH} is not walked: the range is the folded text's.
 */
export function writtenSpan(
  index: SourceIndex,
  from: number,
  to: number,
): { readonly text: string; readonly from: number; readonly to: number } {
  const written = index.written;
  const folded = index.text;
  if (written === undefined) return { text: folded, from, to };
  const moved = (end: number): boolean => end > 0 && FOLD_IGNORABLE.test(charBefore(folded, end));
  let start = from;
  if (from > 0 && from < folded.length && FOLD_WORD.test(charBefore(folded, from))) {
    const end = wordEnd(folded, from);
    if (end === -1) return { text: folded, from, to };
    if (moved(end)) start = wordStart(folded, from);
    if (start === -1) return { text: folded, from, to };
  }
  let stop = to;
  if (to > 0 && to < folded.length && FOLD_WORD.test(charBefore(folded, to))) {
    const end = wordEnd(folded, to);
    if (end === -1) return { text: folded, from, to };
    if (end > to && moved(end)) stop = end;
  }
  // A zero-width no-break space is ignorable to the fold and whitespace to
  // an excerpt, so the written word may begin or end with one.
  while (start < stop && isSpace(written.charCodeAt(start))) start++;
  while (stop > start && isSpace(written.charCodeAt(stop - 1))) stop--;
  return { text: written, from: start, to: stop };
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

/**
 * Text between two adjacent tokens that ends a clause: sentence and clause
 * punctuation, a bracket, a straight double quote (the field boundaries of a
 * JSON tool result), a table bar, a line break, or a dash standing as one.
 * A hyphen inside a compound ("well-known") and the sign of "-3" are not
 * breaks.
 */
const CLAUSE_BREAK = /[.,;:!?()[\]{}"|…\n\r–—]|\s-\s/;

/** Does `gap`, the text between two adjacent tokens, end a clause? */
export function breaksClause(gap: string): boolean {
  return CLAUSE_BREAK.test(gap);
}

/** The text between token `i` and token `i + 1`. */
function gapAfter(index: SourceIndex, i: number): string {
  const left = index.tokens[i] as SourceToken;
  const right = index.tokens[i + 1] as SourceToken;
  return index.text.slice(left.at + left.raw.length, right.at);
}

/**
 * A copula between a negation and a word puts them in different phrases:
 * "the lines that did not ship IS 1,284.50", "the total without VAT IS
 * 1,284.50" — the negation sits in the subject, and the predicate after the
 * copula is stated, not denied.
 */
const COPULAS: ReadonlySet<string> = new Set(["is", "are", "was", "were", "be", "been", "am"]);

/**
 * A conjunction between a negation and a word starts another conjunct:
 * "the total is not 1284.05 BUT 1284.50" states the second figure.
 */
const CONJUNCTIONS: ReadonlySet<string> = new Set([
  "and",
  "but",
  "or",
  "yet",
  "so",
  "whereas",
  "while",
  "although",
  "though",
]);

/** A negation followed by one of these adds rather than denies: "not only 5". */
const NOT_A_DENIAL: ReadonlySet<string> = new Set(["only", "just", "merely", "least"]);

/** Words a negation may reach across to the word it governs. */
const NEGATION_REACH = 2;

/**
 * The position of the negation that governs token `at` of `index`, or -1.
 *
 * Polarity is a property of a phrase, not of a sentence: "no discount was
 * applied, so the total is 1,284.50" states the total, and a check that
 * read the whole sentence as negated would call it the opposite of a result
 * that says 1284.50. So a negation governs a word only when it stands right
 * before it — in the same clause (`breaksClause`), at most two words
 * between ("is not 1,284.50", "did not exceed 40", "is not equal to 12%",
 * "never has the company"), none of them a copula or a conjunction. "No" is a determiner
 * and denies only the word right after it ("no two of the six", not "no
 * doubt the window"). A negation joined to the next word by a hyphen
 * ("no-fee", "not-for-profit") is part of a compound modifier, and "not
 * only" / "not just" adds rather than denies; neither governs anything.
 *
 * Deliberately narrow, and it errs one way: a negation further off ("did
 * not reach a total of 1,284.50") is not found, so a caller asking "is
 * this word denied?" gets "no" where a parser might say yes. What it never
 * does is reach across a clause or a copula into a statement the negation
 * is not part of.
 */
export function governingNegation(index: SourceIndex, at: number): number {
  const tokens = index.tokens;
  if (at <= 0 || at >= tokens.length) return -1;
  for (let j = at - 1; j >= 0 && at - j - 1 <= NEGATION_REACH; j--) {
    if (breaksClause(gapAfter(index, j))) return -1;
    const token = tokens[j] as SourceToken;
    if (NEGATIONS.has(token.norm)) {
      if (gapAfter(index, j) === "-") return -1;
      if (NOT_A_DENIAL.has((tokens[j + 1] as SourceToken).norm)) return -1;
      // "No" is a determiner: it denies the word right after it ("no two
      // meetings", "no 1,284.50 charge"), and nothing past that word — "no
      // doubt the window is 14 days", "no more than 5".
      if (token.norm === "no" && j + 1 < at) return -1;
      return j;
    }
    if (COPULAS.has(token.norm) || CONJUNCTIONS.has(token.norm)) return -1;
  }
  return -1;
}

/**
 * For each token of `index`, the number of the clause it sits in: 0 for
 * the first, one more after every gap that `breaksClause`. One pass over
 * the text between tokens, so a caller asking which words share a clause
 * across a large source reads it once.
 */
export function clauseNumbers(index: SourceIndex): Uint32Array {
  const out = new Uint32Array(index.tokens.length);
  let clause = 0;
  for (let i = 1; i < index.tokens.length; i++) {
    if (breaksClause(gapAfter(index, i - 1))) clause += 1;
    out[i] = clause;
  }
  return out;
}

/**
 * True for exactly the UTF-16 code units `\s` matches: ECMAScript's
 * WhiteSpace and LineTerminator, which are also what `trim` removes.
 */
function isSpace(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  if (code < 0xa0) return false;
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/**
 * Where each run of whitespace in a source's text ends, by where it starts,
 * found the first time an excerpt crosses it: a run is read once per
 * source, however many excerpts cross it. Kept per text an excerpt is cut
 * from, the written one or (for a word too long to widen) the folded one.
 */
const SPACE_RUN_ENDS = new WeakMap<SourceIndex, Map<string, Map<number, number>>>();

function spaceRunEnd(index: SourceIndex, text: string, start: number): number {
  let byText = SPACE_RUN_ENDS.get(index);
  if (byText === undefined) {
    byText = new Map();
    SPACE_RUN_ENDS.set(index, byText);
  }
  const which = text === index.text ? "folded" : "written";
  let ends = byText.get(which);
  if (ends === undefined) {
    ends = new Map();
    byText.set(which, ends);
  }
  let end = ends.get(start);
  if (end === undefined) {
    end = start;
    while (end < text.length && isSpace(text.charCodeAt(end))) end++;
    ends.set(start, end);
  }
  return end;
}

/**
 * The source's own words over a token range, whitespace collapsed, and cut
 * to `maxChars` with an ellipsis.
 *
 * Cut from the text as written (`writtenSpan`), not the folded one the
 * tokens were read in: an excerpt of "مدة الاسترداد ٣٠ يوما" says ٣٠, and
 * one of "می‌خواهم" keeps its joiner where it stands — the folded "30" and
 * "میخواهم‌" are not in the page a reader checks the bundle against
 * (design §5.3).
 *
 * Read only as far as the cut: cutting the whole range out of the source
 * first charged every excerpt the whole distance between its words, so a
 * source of a few words far apart cost each claim the whole source. The
 * text is the one `slice(…).replace(/\s+/g, " ").trim()` gives: a run of
 * whitespace becomes one space, and the range begins and ends on a word.
 */
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
  const span = writtenSpan(index, first.at, last.at + last.raw.length);
  const source = span.text;
  const end = span.to;
  if (maxChars < 1) {
    const whole = source.slice(span.from, end).replace(/\s+/g, " ").trim();
    return whole.length > maxChars ? `${whole.slice(0, maxChars - 1)}…` : whole;
  }
  // Collapsed text up to one past the cut, which is enough to know whether
  // there is a cut and what comes before it.
  const want = maxChars + 1;
  const parts: string[] = [];
  let length = 0;
  let at = span.from;
  while (at < end && length < want) {
    if (isSpace(source.charCodeAt(at))) {
      at = spaceRunEnd(index, source, at);
      parts.push(" ");
      length += 1;
      continue;
    }
    let stop = at + 1;
    while (stop < end && stop - at < want - length && !isSpace(source.charCodeAt(stop))) {
      stop++;
    }
    parts.push(source.slice(at, stop));
    length += stop - at;
    at = stop;
  }
  const text = parts.join("");
  return length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/**
 * Source tokens the passes below have read: one per token of a pass over a
 * whole source (bestSpan's window sliding along it, findSequence's search),
 * for a test to count with, since a loop that indexes the tokens by hand is
 * invisible to a meter wrapping the array methods. bestSpan's second look at
 * the one winning window, at most twice the window, is not counted. Only
 * ever added to. tool-verify re-exports this same object, and its linear-time
 * tests read it there.
 */
export const scanMeter = { tokens: 0 };

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

const NONE: ReadonlySet<string> = new Set();

/**
 * The window of at most `windowTokens` consecutive source tokens that carries
 * the most of `need`.
 *
 * One left-to-right pass with a running count, so a large source costs its
 * size once per claim rather than once per candidate position. Ties go to the
 * earliest window, which is what makes the result stable — never rely on the
 * order two equally good spans happen to be visited in.
 *
 * `prefer` narrows the choice to the windows that carry every `required`
 * word, when the best of those still carries at least `atLeast` of `need`;
 * otherwise the best window overall is reported, and its `missing` says
 * which required word it lacks. `locateWords` passes the claim's numerals
 * and negations below full coverage, with the count the bar asks for: the
 * best window by count is otherwise free to be the one paragraph that has
 * every word of the claim except its number, while a window that does carry
 * the number clears the bar further on. Absent, the pass is exactly the
 * unconstrained one, in what it reads and in what it reports.
 */
export function bestSpan(
  index: SourceIndex,
  need: ReadonlyArray<string>,
  windowTokens: number,
  prefer?: { readonly required: ReadonlySet<string>; readonly atLeast: number },
): BestSpan {
  const tokens = index.tokens;
  if (need.length === 0 || tokens.length === 0) return EMPTY_SPAN(need);
  const want = new Set(need);
  // A window smaller than the claim could never hold all of it.
  const width = Math.min(Math.max(windowTokens, need.length), tokens.length);
  const required = prefer?.required ?? NONE;
  const mustHold = [...required].filter((t) => want.has(t)).length;

  const counts = new Map<string, number>();
  let matched = 0;
  let held = 0;
  let bestMatched = -1;
  let bestStart = 0;
  let bestHeld = -1;
  let heldStart = 0;
  // An iterator, not an index, so a meter wrapping the array iterator sees
  // the pass: one token entering per step.
  let at = -1;
  for (const token of tokens) {
    at += 1;
    scanMeter.tokens += 1;
    const entering = token.norm;
    if (want.has(entering)) {
      const next = (counts.get(entering) ?? 0) + 1;
      counts.set(entering, next);
      if (next === 1) {
        matched++;
        if (required.has(entering)) held++;
      }
    }
    if (at >= width) {
      const leaving = (tokens[at - width] as SourceToken).norm;
      if (want.has(leaving)) {
        const next = (counts.get(leaving) as number) - 1;
        counts.set(leaving, next);
        if (next === 0) {
          matched--;
          if (required.has(leaving)) held--;
        }
      }
    }
    if (at >= width - 1) {
      if (matched > bestMatched) {
        bestMatched = matched;
        bestStart = at - width + 1;
      }
      if (held === mustHold && matched > bestHeld) {
        bestHeld = matched;
        heldStart = at - width + 1;
      }
    }
  }
  // With nothing preferred the two choices are never compared, and the
  // unconstrained pass is unchanged.
  if (prefer !== undefined && bestHeld > 0 && bestHeld >= prefer.atLeast) {
    bestMatched = bestHeld;
    bestStart = heldStart;
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
 * Where `sequence` first appears as consecutive source tokens, or -1.
 *
 * Used for an attributed quotation, which is the strictest promise a citation
 * makes. Punctuation and whitespace are not compared — only the run of words —
 * so a quote that differs from the source in a comma still counts as found,
 * while one that differs in a word does not.
 *
 * Knuth–Morris–Pratt, so the source is read once. Restarting the comparison
 * at every token that matched the quote's first word read a source of
 * repeated words once per word of the quote: up to three hundred times.
 */
export function findSequence(index: SourceIndex, sequence: ReadonlyArray<string>): number {
  const tokens = index.tokens;
  const m = sequence.length;
  if (m === 0 || m > tokens.length) return -1;
  // border[j]: the length of the longest proper prefix of the first j + 1
  // words of the quote that is also a suffix of them.
  const border = new Int32Array(m);
  for (let j = 1, k = 0; j < m; j++) {
    const word = sequence[j] as string;
    while (k > 0 && word !== sequence[k]) k = border[k - 1] as number;
    if (word === sequence[k]) k += 1;
    border[j] = k;
  }
  let at = -1;
  let k = 0;
  for (const token of tokens) {
    at += 1;
    scanMeter.tokens += 1;
    while (k > 0 && token.norm !== sequence[k]) k = border[k - 1] as number;
    if (token.norm === sequence[k]) k += 1;
    if (k === m) return at - m + 1;
  }
  return -1;
}

/**
 * The spans a text puts in quotation marks: what each says, and its words.
 *
 * Only double quotes count. An apostrophe is a single quote far more often
 * than a quotation is, and a checker that read "the company's" as an opening
 * quote would invent quotations nobody made. One reader for `quotedRuns`
 * below and for the value layer's `quotedSpans` (`quotes.ts`), so the gate's
 * `checked` rung and its `grounded` rung see the same quotations.
 */
/** A quotation: double quotes (curly ones folded first), on one line. One
 *  pattern for `quotations` and for cutting quotations out of a claim's
 *  framing, so the two always agree on what was quoted. */
const QUOTATION = /"([^"\n]{1,600})"/g;

export function* quotations(
  text: string,
): Generator<{ readonly text: string; readonly words: string[] }> {
  for (const m of foldTypography(text).matchAll(QUOTATION)) {
    const quoted = m[1] as string;
    yield { text: quoted, words: tokenize(quoted).map((t) => t.norm) };
  }
}

/** The spans a claim puts in quotation marks, as token runs of at least `minTokens` words. */
export function quotedRuns(claim: string, minTokens: number): string[][] {
  const runs: string[][] = [];
  for (const { words } of quotations(claim)) {
    if (words.length >= minTokens) runs.push(words);
  }
  return runs;
}

// ---------------------------------------------------------------------------
// The verdict: what locating one claim in one source found.

/** Fewer words than this in quotation marks is a phrase, not a quotation. */
export const QUOTE_MIN_TOKENS = 4;
/** How much of a quotation a source span must carry to count as a misquote
 *  rather than as nothing at all. Below it there is no "nearly identical
 *  span" to show the caller, and claiming one would be an invention. */
export const MISQUOTE_COVERAGE = 0.7;
/** And how many of its words, at the least, for the same reason. */
export const MISQUOTE_MIN_MATCHED = 3;
/** How far apart a claim's words may sit in a source by default. */
export const DEFAULT_WINDOW_TOKENS = 60;
/** The longest excerpt a location carries — the proof bundle's cap too (design §5.3). */
export const MAX_EXCERPT_CHARS = 240;

export type LocateStatus = "supported" | "misquoted" | "polarityConflict" | "notFound";

/**
 * Why a location came out the way it did, for a caller that must treat the
 * cases differently. Only `coverage` is a paraphrase miss: the provability
 * gate's waiver judge may be asked about that one and no other (design
 * §6.2), because `value` is the claim's figure absent from the span that
 * carries its words — design acceptance test A, "30 days" against a source
 * saying 14 — and no reading of a paraphrase can supply a figure. Under the
 * figure rule (`strictFigures`) `value` and `negation` win over `coverage`
 * whatever the fraction: a claim whose figure is missing is a `value` miss
 * even when its other words fall short of the bar too, so a wrong number
 * never reaches the judge by also being a poor paraphrase. Without the rule
 * the status and detail of a miss are FactCrossCheck's, but the cause is
 * still `value` or `negation` when a missing word is one, so the same holds
 * at `coverage: 1`. Ask {@link isWaivableMiss} rather than reading the cause
 * by hand.
 *
 * - `words`    — supported: the claim's words were found in one span.
 * - `quote`    — quote mode: every quoted span appears verbatim (supported),
 *                or one does not (misquoted / notFound).
 * - `coverage` — fewer of the claim's words than the bar sit in any one
 *                window, and none of the missing ones is a figure or a
 *                negation the claim makes.
 * - `value`    — a figure of the claim (a numeral, a number word, an ordinal)
 *                is not in the reported span, or, in quote mode, not near
 *                the quotation.
 * - `negation` — a negation the claim makes is not in the reported span
 *                (or near the quotation). Under the figure rule the
 *                negation is also in `differing`; without it the detail is
 *                FactCrossCheck's, the negation in `missing` alone.
 * - `polarity` — the span carrying the words is negated where the claim is not.
 * - `empty`    — the claim has no words to look for; never found.
 */
export type LocateCause =
  | "words"
  | "quote"
  | "coverage"
  | "value"
  | "negation"
  | "polarity"
  | "empty";

/**
 * What locating a claim in one source found. The detail fields are declared
 * in the order FactCrossCheck has always reported them (coverage, missing,
 * differing, line, excerpt), and a field is present only where that tool
 * reported it, so its output is unchanged by the move.
 */
export type Location = {
  readonly status: LocateStatus;
  readonly mode: "quote" | "paraphrase";
  readonly cause: LocateCause;
  /** Words of the reported span the claim (or the quotation) has, of all of them. */
  readonly matched: number;
  readonly total: number;
  /** `matched / total`, rounded to two places; 1 for a verbatim quotation. */
  readonly coverage: number;
  /** The claim's words the reported span does not carry, in the claim's order. */
  readonly missing?: ReadonlyArray<string>;
  /** A misquote: the span's words the quotation lacks. A polarity conflict,
   *  or a `negation` miss: the negations on one side and not the other. */
  readonly differing?: ReadonlyArray<string>;
  /** 1-based line of the reported span in the source. */
  readonly line?: number;
  /** The reported span in the source's own words, whitespace collapsed. */
  readonly excerpt?: string;
};

/** A claim prepared for locating: its words, and what it quotes. */
export type ClaimQuery = {
  readonly text: string;
  /** `claimWords(text)`. */
  readonly need: ReadonlyArray<string>;
  /** Each different quoted span of at least {@link QUOTE_MIN_TOKENS} words,
   *  in the order first quoted. */
  readonly quotes: ReadonlyArray<ReadonlyArray<string>>;
  /** An attributed quotation is the strictest promise a citation makes, so
   *  when there is one it is what gets verified; the words around it are the
   *  author's framing, not the source's — except, under the figure rule, the
   *  framing's figures and negations (`locateClaim`). */
  readonly mode: "quote" | "paraphrase";
  /** `claimFigures(text)`: which words of `need` state a figure. */
  readonly figures: ReadonlyArray<string>;
  /** `claimFigureKeys(text)`: what each of them is compared as under the
   *  figure rule, its sign and a glued magnitude read. */
  readonly figureKeys: ReadonlyMap<string, ReadonlyArray<string>>;
  /** `quotes` as the figure rule locates them: a numeral the quotation signs
   *  is `-` and its digits (`signedRun`), so a quoted "500" is no source's
   *  "-500". Each different run once, in the order first quoted. */
  readonly signedQuotes: ReadonlyArray<ReadonlyArray<string>>;
  /** The dates and times of day the claim states whole (`compoundValues`),
   *  by key, each once: what the figure rule requires besides their parts. */
  readonly compounds: ReadonlyArray<string>;
};

export function claimQuery(text: string): ClaimQuery {
  const quotes: string[][] = [];
  const signedQuotes: string[][] = [];
  const keys = new Set<string>();
  const signedKeys = new Set<string>();
  for (const { text: quoted, words } of quotations(text)) {
    if (words.length < QUOTE_MIN_TOKENS) continue;
    const key = JSON.stringify(words);
    if (!keys.has(key)) {
      keys.add(key);
      quotes.push(words);
    }
    const signed = signedRun(quoted);
    const signedKey = JSON.stringify(signed);
    if (!signedKeys.has(signedKey)) {
      signedKeys.add(signedKey);
      signedQuotes.push(signed);
    }
  }
  return {
    text,
    need: claimWords(text),
    quotes,
    mode: quotes.length > 0 ? "quote" : "paraphrase",
    figures: claimFigures(text),
    figureKeys: claimFigureKeys(text),
    signedQuotes,
    compounds: [...new Set(compoundValues(foldTypography(text)).map(({ key }) => key))],
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Where one quoted span first appears in a source, and if nowhere, what to report. */
export type QuoteHit = { readonly at: number; readonly miss: Location | null };

/**
 * One quoted span located in one source: found word for word, or the
 * nearest span when that carries most of it (a misquote), or nothing.
 */
export function locateQuote(
  index: SourceIndex,
  run: ReadonlyArray<string>,
  maxExcerptChars: number = MAX_EXCERPT_CHARS,
): QuoteHit {
  const at = findSequence(index, run);
  if (at !== -1) return { at, miss: null };
  // The quotation is not there word for word. A span that carries most of
  // it is the useful answer — the caller needs to see what the source
  // actually wrote — and a span that carries little of it is no answer at
  // all, only a coincidence of vocabulary.
  const distinct = [...new Set(run)];
  const near = bestSpan(index, distinct, run.length);
  const ratio = near.total === 0 ? 0 : near.matched / near.total;
  const coverage = round2(ratio);
  const enough = ratio >= MISQUOTE_COVERAGE && near.matched >= MISQUOTE_MIN_MATCHED;
  const miss: Location = enough
    ? {
        status: "misquoted",
        mode: "quote",
        cause: "quote",
        matched: near.matched,
        total: near.total,
        coverage,
        missing: [...near.missing],
        differing: [...near.extra],
        line: lineOf(index, (index.tokens[near.firstToken] as SourceToken).at),
        excerpt: spanExcerpt(index, near.firstToken, near.lastToken, maxExcerptChars),
      }
    : {
        status: "notFound",
        mode: "quote",
        cause: "quote",
        matched: near.matched,
        total: near.total,
        coverage,
        missing: [...near.missing],
      };
  return { at, miss };
}

/** Lower is better when a claim quotes several spans: the worst one decides. */
const QUOTE_RANK: Readonly<Record<LocateStatus, number>> = {
  supported: 0,
  misquoted: 1,
  polarityConflict: 2,
  notFound: 3,
};

/**
 * A claim that quotes: every quoted span must appear verbatim, and the worst
 * span decides the answer. Once one span is not in the source at all nothing
 * later can change it — `notFound` outranks a misquote — so the rest are not
 * read.
 *
 * `find` is how one span is located (`position` is its place in `quotes`);
 * FactCrossCheck passes its own, which remembers each span per source for
 * the whole call.
 */
export function locateQuotes(
  index: SourceIndex,
  quotes: ReadonlyArray<ReadonlyArray<string>>,
  find: (run: ReadonlyArray<string>, position: number) => QuoteHit = (run) =>
    locateQuote(index, run),
  maxExcerptChars: number = MAX_EXCERPT_CHARS,
): Location {
  let worst: Location | null = null;
  let firstHit = -1;
  for (let i = 0; i < quotes.length; i++) {
    const { at, miss } = find(quotes[i] as ReadonlyArray<string>, i);
    if (miss === null) {
      if (firstHit === -1) firstHit = at;
      continue;
    }
    if (worst === null || QUOTE_RANK[miss.status] > QUOTE_RANK[worst.status]) worst = miss;
    if (worst.status === "notFound") break;
  }
  if (worst !== null) return worst;
  const first = quotes[0];
  if (first === undefined || firstHit === -1) {
    return { status: "notFound", mode: "quote", cause: "empty", matched: 0, total: 0, coverage: 0 };
  }
  const last = firstHit + first.length - 1;
  return {
    status: "supported",
    mode: "quote",
    cause: "quote",
    matched: first.length,
    total: first.length,
    coverage: 1,
    line: lineOf(index, (index.tokens[firstHit] as SourceToken).at),
    excerpt: spanExcerpt(index, firstHit, last, maxExcerptChars),
  };
}

// ---------------------------------------------------------------------------
// Figures: the words a claim must never lose.

/** A word opening with a numeral of any kind, `\p{N}`. */
const NUMERAL_LED = /^\p{N}/u;

/**
 * A word that is nothing but superscript or subscript digits: a footnote
 * mark or an exponent the fold left as written, because it does not stand
 * where a number would ("…of purchase.¹", "(see ²)", `fold.ts`). It states
 * no figure and is no word of the claim's: read as one, "…within 30 days of
 * purchase.¹" asked the source for a "¹" it has no reason to hold.
 */
const SCRIPT_MARK = /^[\u2070\u00b9\u00b2\u00b3\u2074-\u2079\u2080-\u2089]+$/u;

/**
 * What a figure is compared as, or null for a word that states none.
 *
 * A numeral (`normalizeToken` keeps its `%`) is compared as the number layer
 * reads it (`numbers.ts`), so `1284.50`, `1284.5` and the claim's
 * `$1,284.50` are one figure and `12.0%` is `12%` — the percent sign stays,
 * because 4.5% and 4.5 are different figures. A numeral the number layer
 * will not read (`1,5`, `1.2.3`) is compared as written. A cardinal word is
 * its value (`thirty` is `30`); an ordinal and `half` are compared as
 * spelled (`figureWord`). A signed numeral, as the figure rule reports one
 * missing (`-500`, `−3%`), is its key with the sign. A word that opens with
 * a numeral no fold reads as digits — a circled `㉚`, a fraction `½`, a
 * superscript glued to a number — is a figure compared as written: what
 * value it states is a guess, and leaving it out let it go under the bar
 * as an ordinary word (design §6.2, acceptance A).
 */
export function figureKey(word: string): string | null {
  if (/^[-−]\d/.test(word)) return negative(figureKey(word.slice(1)) as string);
  if (/^\d/.test(word)) {
    const percent = word.endsWith("%");
    const value = normalizeNumber(percent ? word.slice(0, -1) : word);
    if (value === null) return word;
    return percent ? `${value}%` : value;
  }
  if (NUMERAL_LED.test(word)) return SCRIPT_MARK.test(word) ? null : word;
  return figureWord(word)?.key ?? null;
}

/** A figure's key with a minus sign: `-500`, `-3%`. Zero has no sign. */
function negative(key: string): string {
  return key === "0" || key === "0%" ? key : `-${key}`;
}

const isFigure = (word: string): boolean => figureKey(word) !== null;

/**
 * What token `i` of `tokens` (cut from `text`) is compared as under the
 * figure rule, or null when it states no figure: `figureKey`, with what the
 * tokenizer leaves out of a token read off the characters around it (design
 * §6.2, acceptance A: a wrong figure never grounds).
 *
 * - A numeral's sign, by the number layer's own rule (`signedAt`): a `-` or
 *   `−` before it, optionally across a currency symbol, that cannot end a
 *   word. "-500", "−500" and "-$500" are -500, so a claim of 500 is not
 *   grounded in a source that says -500, nor the other way round — the
 *   `checked` rung's value layer already reads them so. "2024-01-15",
 *   "10-20" and "COVID-19" sign nothing. Accounting parentheses, "(500)",
 *   are not a sign: the number layer does not read them as one either.
 * - A magnitude glued to a numeral (`magnitudeSuffix`): in "$5M", "$1.2bn"
 *   and "30k" the letters are a figure, the value "million", "billion" or
 *   "thousand" names, so "$5M" is the source's "$5 million" and not its
 *   "$5B" — where an "m" the bar may let go grounded it. "Plan B" glues no
 *   numeral and is a word.
 */
function figureKeyAt(text: string, tokens: ReadonlyArray<SourceToken>, i: number): string | null {
  const token = tokens[i] as SourceToken;
  if (/^\d/.test(token.norm)) {
    const key = figureKey(token.norm) as string;
    return signedAt(text, token.at) ? negative(key) : key;
  }
  const before = tokens[i - 1];
  if (
    before !== undefined &&
    /^\d/.test(before.norm) &&
    before.at + before.raw.length === token.at
  ) {
    const magnitude = magnitudeSuffix(token.norm);
    if (magnitude !== null) return magnitude;
  }
  if (NUMERAL_LED.test(token.norm)) return SCRIPT_MARK.test(token.norm) ? null : token.norm;
  return figureWord(token.norm)?.key ?? null;
}

/**
 * Each token of a claim that states a figure, as `claimWords` spells it,
 * with what it is compared as (`figureKeyAt`), in order.
 *
 * One reading is left out: an ordinal that opens the claim and is followed
 * by a comma. "First, the refund window is 14 days" counts the points of an
 * answer; it states no rank, and a source that never says "first" has not
 * left out a figure. "Acme ranked first" keeps it.
 */
function figureTokens(text: string): Array<{ readonly word: string; readonly key: string }> {
  const folded = foldTypography(text);
  const tokens = tokenize(folded);
  const out: Array<{ readonly word: string; readonly key: string }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as SourceToken;
    const key = figureKeyAt(folded, tokens, i);
    if (key === null) continue;
    const ordinal = figureWord(token.norm)?.ordinal === true;
    if (i === 0 && ordinal && folded[token.at + token.raw.length] === ",") continue;
    out.push({ word: token.norm, key });
  }
  return out;
}

/**
 * The words of a claim that state a figure, as `claimWords` spells them,
 * distinct, in first-seen order: numerals, number words, ordinals, and a
 * magnitude glued to a numeral (the `m` of "$5M"). A list-counting "First,"
 * is left out (`figureTokens`).
 */
export function claimFigures(text: string): string[] {
  return [...new Set(figureTokens(text).map(({ word }) => word))];
}

/**
 * What each figure word of a claim is compared as under the figure rule
 * (`figureKeyAt`): `claimFigures` with the keys each was written as, in
 * first-seen order. "-500" is `500` → `["-500"]`, the `m` of "$5M" is
 * `m` → `["1000000"]`, and a word written both ways ("from -5 to 5") is
 * both keys. `need` drops the sign with the tokenizer, so the claim's text
 * is where it is read.
 */
export function claimFigureKeys(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { word, key } of figureTokens(text)) {
    const keys = out.get(word);
    if (keys === undefined) out.set(word, [key]);
    else if (!keys.includes(key)) keys.push(key);
  }
  return out;
}

/**
 * A quotation's words as the figure rule locates them: a numeral signed
 * inside the quotation (`signedAt`) is `-` and its digits, every other word
 * as `tokenize` gives it. Compared against `signedView`, so the verbatim
 * check holds for signs too, and a spelled "thirty" is still not a "30".
 */
function signedRun(quoted: string): string[] {
  return tokenize(quoted).map((token) =>
    /^\d/.test(token.norm) && signedAt(quoted, token.at) ? `-${token.norm}` : token.norm,
  );
}

/**
 * A source's tokens with every figure in the form it is compared as, made
 * once per index: the figure rule's view of a body, beside FactCrossCheck's
 * spelled one. Offsets and the text are shared, so a line or an excerpt
 * taken from the view is the source's own.
 */
const FIGURE_VIEWS = new WeakMap<SourceIndex, SourceIndex>();

function figureView(index: SourceIndex): SourceIndex {
  let view = FIGURE_VIEWS.get(index);
  if (view === undefined) {
    let changed = false;
    const tokens = index.tokens.map((token, i) => {
      const key = figureKeyAt(index.text, index.tokens, i);
      if (key === null || key === token.norm) return token;
      changed = true;
      return { ...token, norm: key };
    });
    view = changed ? { ...index, tokens } : index;
    FIGURE_VIEWS.set(index, view);
  }
  return view;
}

/**
 * A source's tokens with each signed numeral written with its sign, every
 * other token as spelled: the view a quotation is located in under the
 * figure rule (`signedRun`). Made once per index, offsets shared.
 */
const SIGNED_VIEWS = new WeakMap<SourceIndex, SourceIndex>();

function signedView(index: SourceIndex): SourceIndex {
  let view = SIGNED_VIEWS.get(index);
  if (view === undefined) {
    let changed = false;
    const tokens = index.tokens.map((token) => {
      if (!/^\d/.test(token.norm) || !signedAt(index.text, token.at)) return token;
      changed = true;
      return { ...token, norm: `-${token.norm}` };
    });
    view = changed ? { ...index, tokens } : index;
    SIGNED_VIEWS.set(index, view);
  }
  return view;
}

/** The fewest of `total` words whose fraction clears `bar`, asked of the
 *  same division the verdict makes, so the two can never disagree by a
 *  rounding error. */
function wordsFor(bar: number, total: number): number {
  for (let m = 0; m <= total; m++) if (m / total >= bar) return m;
  return total + 1;
}

export type LocateWordsOptions = {
  /** How far apart the claim's words may sit (default 60). Widened to the
   *  claim's own length, since a narrower window could never hold it. A
   *  malformed value (not a finite number of at least 1) is read as the
   *  narrowest window, the claim's own length. */
  readonly windowTokens?: number;
  /** Fraction of the claim's words that must sit in one window (default 1,
   *  every word — FactCrossCheck's bar). */
  readonly coverage?: number;
  readonly maxExcerptChars?: number;
  /**
   * The figure rule (design §6.2): a figure is compared as a value and never
   * excused. Numerals match by value (`1,284.50` ≡ `1284.5`), cardinal words
   * by theirs (`thirty` ≡ `30`); a figure or a negation the claim states is
   * never among the words a partial bar lets go; a negation that governs the
   * span's first word (`governingNegation`: "NO two of the six meetings
   * overlap") is a polarity conflict, like one inside the span; and a
   * quote-mode claim's figures and negations outside its quotation must sit
   * near it.
   *
   * On by default below full coverage — the provability gate's bar — and off
   * at `coverage: 1`, where every word is required anyway and FactCrossCheck
   * compares figures as written, unchanged by the move. A gate configured at
   * `coverage: 1` passes `true` to keep the rule.
   */
  readonly strictFigures?: boolean;
  /** Which words of `need` are figures, for a caller that has read the
   *  claim's text (`claimFigures` leaves out a list-counting "First,").
   *  Default: every word of `need` spelled as one. Read only under the
   *  figure rule. */
  readonly figures?: ReadonlyArray<string>;
  /** What each figure word of `need` is compared as, for a caller that has
   *  read the claim's text (`claimFigureKeys`): `need` keeps no sign, so a
   *  claim's "-500" is only "500" there. Default: `figureKey(word)` (or the
   *  value of a magnitude suffix listed in `figures`). Read only under the
   *  figure rule. */
  readonly figureKeys?: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Dates and times of day the claim states whole (`compoundValues` keys,
   *  from `claimQuery`). Under the figure rule each must start inside the
   *  span that carries the claim's words, whole, not only as its parts:
   *  "opens at 10:30" is not the "10" of "10:00" and the "30" of "18:30". */
  readonly compounds?: ReadonlyArray<string>;
};

type Resolved = {
  readonly windowTokens: number;
  readonly bar: number;
  readonly strict: boolean;
  readonly maxExcerptChars: number;
};

/**
 * The options as the verdict reads them. A malformed one falls back to the
 * strict reading, never a looser one: a NaN bar would otherwise let any
 * single word through, a fractional window would slide by half a token, and
 * a window of NaN or Infinity read as the default 60 was wider than asked.
 */
function resolve(options: LocateWordsOptions): Resolved {
  const window = options.windowTokens ?? DEFAULT_WINDOW_TOKENS;
  const asked = options.coverage ?? 1;
  const bar = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), 1) : 1;
  return {
    // 1 is widened to the claim's own length by bestSpan.
    windowTokens: Number.isFinite(window) && window >= 1 ? Math.floor(window) : 1,
    bar,
    strict: options.strictFigures ?? bar < 1,
    maxExcerptChars: options.maxExcerptChars ?? MAX_EXCERPT_CHARS,
  };
}

const EMPTY_CLAIM: Location = {
  status: "notFound",
  mode: "paraphrase",
  cause: "empty",
  matched: 0,
  total: 0,
  coverage: 0,
};

/** Where a span sits, for the location reported; nothing when nothing matched. */
function placeOf(
  index: SourceIndex,
  span: BestSpan,
  maxExcerptChars: number,
): { readonly line?: number; readonly excerpt?: string } {
  if (span.firstToken === -1) return {};
  return {
    line: lineOf(index, (index.tokens[span.firstToken] as SourceToken).at),
    excerpt: spanExcerpt(index, span.firstToken, span.lastToken, maxExcerptChars),
  };
}

/**
 * A claim with no quotation, located in one source by its words.
 *
 * Without the figure rule this is FactCrossCheck's rule, unchanged: the
 * fraction `coverage` of the words in one window (every word, by default),
 * then no negation in the span the claim lacks. Only the cause of a miss
 * reads the figures and negations there, which FactCrossCheck never reports:
 * a miss whose missing words hold a figure is `value`, one holding a
 * negation `negation`, so no strict-off location is a waivable miss for a
 * wrong number or a dropped "not".
 *
 * Under it (the default below full coverage) a fraction of the words may be
 * missing, but never a figure and never a negation the claim makes. Without
 * that, "the refund window is 30 days" clears 0.8 against a source saying 14
 * (every word but "30" is there), "thirty days" does too, and "the refund
 * window is not 30 days" clears it against a source saying it is — the
 * missing word is exactly the one the claim turns on. A missing figure is
 * `notFound` (cause `value`, the figure listed in `missing`), at any
 * fraction. A missing negation is `polarityConflict` when the rest clears
 * the bar and `notFound` when it does not, both with cause `negation` and
 * the negation in `differing`. The bar is compared against the unrounded
 * fraction: 0.795 does not clear 0.8 by being reported as 0.8.
 */
export function locateWords(
  index: SourceIndex,
  need: ReadonlyArray<string>,
  options: LocateWordsOptions = {},
): Location {
  const o = resolve(options);
  if (o.strict) {
    return locateFigures(
      index,
      need,
      new Set(options.figures ?? need.filter(isFigure)),
      options.figureKeys,
      options.compounds ?? [],
      o,
    );
  }
  const span = bestSpan(index, need, o.windowTokens);
  // A claim with no words of its own cannot be located, and an empty set of
  // words would otherwise be "found" in every source — a pass that checked
  // nothing, which is the one result worse than a failure.
  if (span.total === 0) return EMPTY_CLAIM;
  const ratio = span.matched / span.total;
  const base = {
    mode: "paraphrase" as const,
    matched: span.matched,
    total: span.total,
    coverage: round2(ratio),
  };
  const where = placeOf(index, span, o.maxExcerptChars);
  if (span.matched === 0 || ratio < o.bar) {
    // The status and the detail are FactCrossCheck's, unchanged; the cause
    // still names a missing figure or negation, so a caller asking
    // `isWaivableMiss` of a strict-off location never waives a wrong number.
    const figures = new Set(options.figures ?? need.filter(isFigure));
    const cause: LocateCause = span.missing.some((word) => figures.has(word))
      ? "value"
      : span.missing.some((word) => NEGATIONS.has(word))
        ? "negation"
        : "coverage";
    return { status: "notFound", cause, ...base, missing: [...span.missing], ...where };
  }
  if (span.extraNegations.length > 0) {
    // Every word the bar asks for matched, and the span carrying them is
    // negated where the claim is not. This is as close to "it says the
    // opposite" as counting words can honestly get, and it is reported as
    // something to read rather than as a contradiction found.
    return {
      status: "polarityConflict",
      cause: "polarity",
      ...base,
      ...(span.missing.length > 0 ? { missing: [...span.missing] } : {}),
      differing: [...span.extraNegations],
      ...where,
    };
  }
  return {
    status: "supported",
    cause: "words",
    ...base,
    ...(span.missing.length > 0 ? { missing: [...span.missing] } : {}),
    ...where,
  };
}

/**
 * Every shortest window of `keys` that holds each of `need` that `keys`
 * holds at all, as `[from, to]` positions, in order. One pass.
 *
 * The span a location reports runs from the first of the claim's words in
 * the winning window to the last, so it can open on a stray earlier copy of
 * one of them; the claim stated is the tightest run inside it. Ties are all
 * returned, so a caller asking "is the statement X" can require it of each.
 */
export function tightestWindows(
  keys: ReadonlyArray<string>,
  need: ReadonlySet<string>,
): Array<[number, number]> {
  const present = new Set(keys.filter((key) => need.has(key)));
  if (present.size === 0) return [];
  const counts = new Map<string, number>();
  const windows: Array<[number, number]> = [];
  let shortest = Number.POSITIVE_INFINITY;
  let held = 0;
  let left = 0;
  for (let right = 0; right < keys.length; right++) {
    const entering = keys[right] as string;
    if (present.has(entering)) {
      const count = (counts.get(entering) ?? 0) + 1;
      counts.set(entering, count);
      if (count === 1) held += 1;
    }
    while (held === present.size) {
      const length = right - left;
      if (length < shortest) {
        shortest = length;
        windows.length = 0;
      }
      if (length === shortest) windows.push([left, right]);
      const leaving = keys[left] as string;
      if (present.has(leaving)) {
        const count = (counts.get(leaving) as number) - 1;
        counts.set(leaving, count);
        if (count === 0) held -= 1;
      }
      left += 1;
    }
  }
  return windows;
}

/**
 * The negation that opens the claim's statement in `span`, or undefined:
 * the one governing the first word of every tightest run of the claim's
 * words in it (`tightestWindows`). "Customers who are not members pay 10
 * dollars; members pay 5 dollars" states "members pay 5 dollars" — its
 * span may open on the first "members", but the claim at its tightest is
 * the second, which nothing denies.
 */
function openingNegation(
  view: SourceIndex,
  span: BestSpan,
  need: ReadonlySet<string>,
): string | undefined {
  if (span.firstToken < 0) return undefined;
  const keys: string[] = [];
  for (let i = span.firstToken; i <= span.lastToken; i++) {
    keys.push((view.tokens[i] as SourceToken).norm);
  }
  let opener: string | undefined;
  for (const [from] of tightestWindows(keys, need)) {
    const at = governingNegation(view, span.firstToken + from);
    if (at === -1) return undefined;
    opener ??= (view.tokens[at] as SourceToken).norm;
  }
  return opener;
}

/** What a figure word of a claim is compared as when no reading of its text says. */
function keysOf(word: string): string[] {
  return [figureKey(word) ?? magnitudeSuffix(word) ?? word];
}

/** A figure key in the claim's own spelling: its word, signed when the key is. */
function spellingOf(word: string, key: string): string {
  return key.startsWith("-") && !word.startsWith("-") ? `-${word}` : word;
}

/** A source's dates and times of day (`compoundValues`), read once per index. */
const COMPOUNDS = new WeakMap<SourceIndex, ReadonlyArray<CompoundValue>>();

/**
 * Which of `wanted` (compound keys) no date or time of `index` that starts
 * between offsets `from` and `to` states. A compound's parts are figures the
 * span already carries; this asks that they are written together, in the
 * claim's order — a day and a month swapped, or a time made of two others'
 * pieces, is not the value the claim states (design §6.3, §0-B).
 */
function wholeMissing(
  index: SourceIndex,
  wanted: ReadonlyArray<string>,
  from: number,
  to: number,
): string[] {
  if (wanted.length === 0) return [];
  let found = COMPOUNDS.get(index);
  if (found === undefined) {
    found = compoundValues(index.text);
    COMPOUNDS.set(index, found);
  }
  const stated = new Set(
    found.filter((one) => one.at >= from && one.at < to).map((one) => one.key),
  );
  return wanted.filter((key) => !stated.has(key));
}

/** The character range of tokens `first` to `last`, or an empty one when nothing matched. */
function charRange(index: SourceIndex, first: number, last: number): [number, number] {
  if (first < 0 || last < first) return [0, 0];
  const end = index.tokens[last] as SourceToken;
  return [(index.tokens[first] as SourceToken).at, end.at + end.raw.length];
}

/** `locateWords` under the figure rule. */
function locateFigures(
  index: SourceIndex,
  need: ReadonlyArray<string>,
  figures: ReadonlySet<string>,
  read: ReadonlyMap<string, ReadonlyArray<string>> | undefined,
  compounds: ReadonlyArray<string>,
  o: Resolved,
): Location {
  // The claim's words as they are compared: a figure by its key, so two
  // spellings of one value in a claim are one word, and each key reported
  // back in the claim's own spelling. A figure written both signed and not
  // ("from -5 to 5") is both keys.
  const keys: string[] = [];
  const spelled = new Map<string, string>();
  const figureKeys = new Set<string>();
  const negations = new Set<string>();
  for (const word of need) {
    const figure = figures.has(word);
    for (const key of figure ? (read?.get(word) ?? keysOf(word)) : [word]) {
      if (figure) figureKeys.add(key);
      if (NEGATIONS.has(word)) negations.add(key);
      if (spelled.has(key)) continue;
      spelled.set(key, spellingOf(word, key));
      keys.push(key);
    }
  }
  const view = figureView(index);
  // The best window by count is otherwise free to be the one paragraph that
  // has every word of the claim except its figure, while a window that does
  // carry the figure clears the bar further on.
  const span = bestSpan(view, keys, o.windowTokens, {
    required: new Set([...figureKeys, ...negations]),
    atLeast: wordsFor(o.bar, keys.length),
  });
  if (span.total === 0) return EMPTY_CLAIM;
  const ratio = span.matched / span.total;
  const as = (key: string): string => spelled.get(key) ?? key;
  const missing = span.missing.map(as);
  const base = {
    mode: "paraphrase" as const,
    matched: span.matched,
    total: span.total,
    coverage: round2(ratio),
  };
  const where = placeOf(view, span, o.maxExcerptChars);
  // The figure and the negation come first, whatever the fraction: a claim
  // that is short of the bar AND missing its number is a wrong number, not a
  // paraphrase the judge may waive.
  if (span.missing.some((key) => figureKeys.has(key))) {
    return { status: "notFound", cause: "value", ...base, missing, ...where };
  }
  // Every part of a date or a time is there; is the value itself?
  const lostWhole = wholeMissing(
    view,
    compounds,
    ...charRange(view, span.firstToken, span.lastToken),
  );
  if (lostWhole.length > 0) {
    return {
      status: "notFound",
      cause: "value",
      ...base,
      missing: [...missing, ...lostWhole],
      ...where,
    };
  }
  const lostNegations = span.missing.filter((key) => negations.has(key)).map(as);
  if (lostNegations.length > 0) {
    return {
      status: span.matched > 0 && ratio >= o.bar ? "polarityConflict" : "notFound",
      cause: "negation",
      ...base,
      missing,
      differing: lostNegations,
      ...where,
    };
  }
  if (span.matched === 0 || ratio < o.bar) {
    return { status: "notFound", cause: "coverage", ...base, missing, ...where };
  }
  // The span runs from the claim's first word found to its last, so a
  // negation that opens the statement sits just outside it: "No two of the
  // six meetings overlap" carries every word of "two of the six meetings
  // overlap", and the "No" before them is the whole difference. A negation
  // governing the first word of the claim at its tightest (`governingNegation`:
  // the same clause, at most two words before it) is the span's own —
  // unless the claim makes it too.
  const opener = openingNegation(view, span, new Set(keys));
  const extraNegations =
    opener !== undefined && !negations.has(opener) && !span.extraNegations.includes(opener)
      ? [opener, ...span.extraNegations]
      : span.extraNegations;
  if (extraNegations.length > 0) {
    return {
      status: "polarityConflict",
      cause: "polarity",
      ...base,
      ...(missing.length > 0 ? { missing } : {}),
      differing: [...extraNegations],
      ...where,
    };
  }
  return {
    status: "supported",
    cause: "words",
    ...base,
    ...(missing.length > 0 ? { missing } : {}),
    ...where,
  };
}

/**
 * Is this a miss the provability gate's waiver judge may be asked about
 * (design §6.2)? Only a paraphrase whose words were partly found and whose
 * missing words hold no figure and no negation: the body was read, the claim
 * is about it, and what is left is wording. Nothing else is waivable — not a
 * figure, not a negation, not a quotation, and not a claim none of whose
 * words are in the source.
 */
export function isWaivableMiss(location: Location): boolean {
  return (
    location.status === "notFound" &&
    location.mode === "paraphrase" &&
    location.cause === "coverage" &&
    location.matched > 0
  );
}

/** A claim's text with every quotation of at least {@link QUOTE_MIN_TOKENS}
 *  words blanked out: the author's framing around what was quoted. */
function framingOf(text: string): string {
  return foldTypography(text).replace(QUOTATION, (whole, quoted: string) =>
    tokenize(quoted).length >= QUOTE_MIN_TOKENS ? " " : whole,
  );
}

/**
 * Under the figure rule, a quote-mode claim's framing has to agree with the
 * source too, where it states a figure or a negation.
 *
 * The quotation is verified word for word, and the words around it are the
 * author's — but "The refund window is 30 days, since \"customers may
 * request a refund\"" asserts 30 days, and a verbatim quotation of four
 * other words from a source saying 14 is not evidence for it. So each figure
 * and negation of the framing must sit within the window of the quotation:
 * `windowTokens` before its first word or after its last. A missing figure
 * is `notFound` with cause `value`; a missing negation is `polarityConflict`
 * with cause `negation`. Framing with neither is not read, so "Zebras say
 * \"…\"" is still the quotation's verdict.
 */
function framedQuote(
  index: SourceIndex,
  query: ClaimQuery,
  runs: ReadonlyArray<ReadonlyArray<string>>,
  hits: ReadonlyArray<number>,
  quoted: Location,
  o: Resolved,
): Location {
  const framing = framingOf(query.text);
  const want = new Map<string, string>();
  const figureKeys = new Set<string>();
  for (const [word, keys] of claimFigureKeys(framing)) {
    for (const key of keys) {
      figureKeys.add(key);
      if (!want.has(key)) want.set(key, spellingOf(word, key));
    }
  }
  for (const word of claimWords(framing)) {
    if (NEGATIONS.has(word) && !want.has(word)) want.set(word, word);
  }
  // A date or a time the framing states is a figure of it, whole.
  const wholes = [...new Set(compoundValues(framing).map(({ key }) => key))];
  for (const key of wholes) {
    figureKeys.add(key);
    if (!want.has(key)) want.set(key, key);
  }
  if (want.size === 0) return quoted;

  let first = Number.POSITIVE_INFINITY;
  let last = -1;
  runs.forEach((run, position) => {
    const at = hits[position];
    if (at === undefined || at < 0) return;
    first = Math.min(first, at);
    last = Math.max(last, at + run.length - 1);
  });
  if (last < 0) return quoted;
  const view = figureView(index);
  const from = Math.max(0, first - o.windowTokens);
  const to = Math.min(view.tokens.length - 1, last + o.windowTokens);
  const present = new Set<string>();
  for (let i = from; i <= to; i++) {
    const norm = (view.tokens[i] as SourceToken).norm;
    if (want.has(norm)) present.add(norm);
  }
  const lostWhole = new Set(wholeMissing(view, wholes, ...charRange(view, from, to)));
  for (const key of wholes) if (!lostWhole.has(key)) present.add(key);
  const lost = [...want.keys()].filter((key) => !present.has(key));
  if (lost.length === 0) return quoted;

  const quotedWords = runs.reduce((n, run) => n + run.length, 0);
  const total = quotedWords + want.size;
  const matched = total - lost.length;
  const base = {
    mode: "quote" as const,
    matched,
    total,
    coverage: round2(matched / total),
    missing: lost.map((key) => want.get(key) ?? key),
    ...(quoted.line === undefined ? {} : { line: quoted.line }),
    ...(quoted.excerpt === undefined ? {} : { excerpt: quoted.excerpt }),
  };
  if (lost.some((key) => figureKeys.has(key))) {
    return { status: "notFound", cause: "value", ...base };
  }
  return {
    status: "polarityConflict",
    cause: "negation",
    ...base,
    differing: lost.map((key) => want.get(key) ?? key),
  };
}

export type LocateOptions = LocateWordsOptions;

/**
 * Locate one claim in one source: by its quoted spans when it quotes
 * (strictest — each must appear verbatim, and `coverage` does not apply),
 * otherwise by its words at `coverage`. Under the figure rule a quotation's
 * framing figures and negations are checked as well (`strictFigures`), and
 * its numerals keep their signs: "the balance is 500 dollars" in quotation
 * marks is not verbatim in a source that says -500 (`signedRun`).
 *
 * Index a source once with `indexSource` and pass the index when many claims
 * are located in it; a string is indexed per call. The provability gate
 * passes its `grounded.coverage` and `grounded.window_tokens` (design §3,
 * §6.2); the defaults are FactCrossCheck's, every word within 60 tokens.
 */
export function locateClaim(
  claim: string | ClaimQuery,
  source: SourceIndex | string,
  options: LocateOptions = {},
): Location {
  const query = typeof claim === "string" ? claimQuery(claim) : claim;
  const index = typeof source === "string" ? indexSource(source) : source;
  const o = resolve(options);
  if (query.quotes.length > 0) {
    const runs = o.strict ? query.signedQuotes : query.quotes;
    const view = o.strict ? signedView(index) : index;
    const hits: number[] = [];
    const quoted = locateQuotes(
      view,
      runs,
      (run, position) => {
        const hit = locateQuote(view, run, o.maxExcerptChars);
        hits[position] = hit.at;
        return hit;
      },
      o.maxExcerptChars,
    );
    return o.strict && quoted.status === "supported"
      ? framedQuote(index, query, runs, hits, quoted, o)
      : quoted;
  }
  return locateWords(index, query.need, {
    ...options,
    figures: query.figures,
    figureKeys: query.figureKeys,
    compounds: query.compounds,
  });
}
