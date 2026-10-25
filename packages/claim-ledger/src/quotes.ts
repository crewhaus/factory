/**
 * The spans a claim quotes, and whether a tool's result carries them word
 * for word — the `checked` rung's second question after its values (design
 * §6.3).
 *
 * Read by the locate kernel's own quotation reader (`quotations`), so the
 * gate's `checked` rung and its `grounded` rung see the same quotations. Kept
 * apart from `numbers.ts` because that module is a dependency of the kernel
 * (figures are compared as values there), and this one depends on the kernel.
 */
import { QUOTE_MIN_TOKENS, findSequence, indexSource, quotations } from "./locate";

/** A span a claim puts in quotation marks: what it says, and the words compared. */
export type QuotedSpan = {
  /** The quoted text as written, without its quotation marks. */
  readonly text: string;
  /** Its words as the locate kernel compares them (`normalizeToken`). */
  readonly tokens: ReadonlyArray<string>;
};

/**
 * The spans a claim quotes, as the locate kernel finds them: double quotes
 * only (straight or curly), at least {@link QUOTE_MIN_TOKENS} words, each
 * different span once, in the order first quoted. A quotation of fewer words
 * is a phrase, checked with the claim's other words rather than verbatim.
 */
export function quotedSpans(text: string, minTokens: number = QUOTE_MIN_TOKENS): QuotedSpan[] {
  const out: QuotedSpan[] = [];
  const seen = new Set<string>();
  for (const { text: quoted, words } of quotations(text)) {
    if (words.length < minTokens) continue;
    const key = JSON.stringify(words);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: quoted, tokens: words });
  }
  return out;
}

/**
 * Does `haystack` carry the quoted span word for word? Punctuation and
 * whitespace are not compared — the locate kernel's rule for a quotation,
 * by its own linear search.
 */
export function containsQuote(haystack: string, span: QuotedSpan | ReadonlyArray<string>): boolean {
  const words = "tokens" in span ? span.tokens : span;
  if (words.length === 0) return false;
  return findSequence(indexSource(haystack), words) !== -1;
}
