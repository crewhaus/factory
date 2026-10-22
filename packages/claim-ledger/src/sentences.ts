/**
 * Where one sentence ends and the next begins — two splitters, kept apart on
 * purpose.
 *
 * `splitSentences` is the Markdown-aware one (moved from tool-verify's
 * `lib/markdown.ts`): offsets into the document, paragraph breaks, headings
 * and list items as boundaries, abbreviations held back. The citation reader,
 * the claim extractor and tool-verify's SEO prose statistics all use it, so
 * a claim the gate checks is the claim FactCrossCheck checks.
 *
 * `sentences` is the transcript one (moved from grader-continuity's
 * heuristics): one line at a time, split after terminal punctuation. The
 * continuity and faithfulness graders score with it, and their thresholds
 * were set against it, so swapping it for the Markdown splitter would move
 * every `continuity.*` and `twelve.*` verdict (design §15: the hoist is
 * behaviour-neutral). Both stay; neither is "the" splitter for the other's
 * callers.
 */
import { contentTokens } from "./tokens";

/**
 * Abbreviations a full stop does not end a sentence after.
 *
 * Only what can be decided from the characters: a paragraph break, a heading
 * line, the start of a list item, and terminal punctuation followed by space.
 * A handful of abbreviations and single initials are held back, because
 * "e.g." and "J. Smith" are the two that turn one claim into two.
 */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "e.g.",
  "i.e.",
  "etc.",
  "vs.",
  "cf.",
  "al.",
  "fig.",
  "no.",
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
  "prof.",
  "st.",
  "jr.",
  "sr.",
  "inc.",
  "ltd.",
  "co.",
  "pp.",
  "ch.",
  "sec.",
  "approx.",
]);

/** Sentence ranges of a Markdown document, as `[start, end)` offsets that tile it. */
export function splitSentences(text: string): Array<{ start: number; end: number }> {
  const bounds = new Set<number>([0, text.length]);
  for (const m of text.matchAll(/\n[ \t]*\n/g)) {
    if (m.index !== undefined) bounds.add(m.index + m[0].length);
  }
  // A heading and a list item each start a claim of their own: without this a
  // heading with no full stop runs into the sentence under it, and the claim
  // checked is not the claim written.
  for (const m of text.matchAll(/^#{1,6}[ \t].*$/gm)) {
    if (m.index !== undefined) {
      bounds.add(m.index);
      bounds.add(m.index + m[0].length);
    }
  }
  for (const m of text.matchAll(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gm)) {
    if (m.index !== undefined) bounds.add(m.index);
  }
  // The lookbehind lets a run of `.!?` be tried only from its first
  // character; every later start ends where the first does, so trying them
  // too made a long run of `!` quadratic.
  for (const m of text.matchAll(/(?<![.!?])[.!?]+["')\]]*(?=[ \t\n]|$)/g)) {
    if (m.index === undefined) continue;
    // The word that ends here, found by walking back to the whitespace
    // before it — not by copying the whole text up to here per match.
    const end = m.index + m[0].length;
    let from = end;
    while (from > 0 && !/\s/.test(text[from - 1] as string)) from--;
    const word = text.slice(from, end).toLowerCase();
    if (ABBREVIATIONS.has(word)) continue;
    // "J. Smith" — a single letter and a dot is an initial, not an end.
    if (/^[\p{L}]\.$/u.test(word)) continue;
    bounds.add(m.index + m[0].length);
  }
  const ordered = [...bounds].sort((a, b) => a - b);
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const start = ordered[i] as number;
    const end = ordered[i + 1] as number;
    if (end > start) out.push({ start, end });
  }
  return out;
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

/** Minimum content tokens for a declarative sentence to be a verifiable
 *  claim — "Done." or "Sure thing." carry nothing to fact-check. */
export const MIN_CLAIM_TOKENS = 3;

/**
 * Declarative, non-question sentences of an answer with enough content
 * tokens to be verifiable: `twelve.answerFaithfulness`'s CLAIM (the
 * `doneClaimSentences`-style extraction minus the completed-work regex,
 * because faithfulness audits EVERY factual assertion, not just completion
 * claims). Over the transcript splitter, as the graders were calibrated;
 * the gate's Markdown-aware extractor is `extractClaims`.
 */
export function claimSentences(text: string): string[] {
  return sentences(text).filter((s) => !isQuestion(s) && contentTokens(s).size >= MIN_CLAIM_TOKENS);
}
