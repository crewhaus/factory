/**
 * Every claim an answer makes, cited or not — what the provability gate
 * checks (design §2, §5.1).
 *
 * `citedClaims` (`citations.ts`) answers "which sentences cite something",
 * which is FactCrossCheck's question. The gate asks a stricter one: which
 * sentences ASSERT something, because an assertion with no marker is exactly
 * the claim a `cited` floor must refuse. So this reads every sentence through
 * the same splitter, the same marker constant and the same Markdown-to-words
 * rule (`plainClaim`) as `citedClaims`, and for a cited sentence of plain
 * prose the two agree on its text and its markers — pinned by a test, as is
 * the wider rule that every marker `citedClaims` gives a declarative
 * sentence is a marker of some claim here.
 *
 * Where they differ, `citedClaims` is left as it is, because FactCrossCheck's
 * output must not move (design §15), and this one does what a gate needs. A
 * sentence this skips is a sentence the gate passes unread, so every
 * difference leans toward reading:
 *
 * - Code is what a renderer calls code (`commonMarkFences`): a fence opens
 *   and closes as CommonMark says — inside a list item counted from the
 *   item's content, and ended by the item's end — and lines break at `\n`
 *   and `\r` only. The citation grammar's looser reader, which calls
 *   everything after a malformed fence code, would hide every claim after
 *   it; read from column 0, `- ```js` is no opener and its indented closer
 *   opens a fence that hides the rest of the answer. A fenced block
 *   or a definition line ends a claim: the splitter does not break at a
 *   fence or before a definition that follows a sentence with no full stop,
 *   so `citedClaims` can carry a block's code, or the source text after
 *   `[1]:`, into the claim before it. Here those ranges are cut out first.
 * - A marker after the full stop belongs to the sentence before it.
 *   "Revenue rose 12%. [1]" is one claim citing [1]; `citedClaims` reports
 *   the marker as a claim of its own with no words. So does a marker glued
 *   to it: "Revenue rose.[1] Costs fell.[2]" is two claims, where the
 *   splitter, which ends a sentence only at a full stop followed by space,
 *   gives `citedClaims` one sentence citing both. A run "[1][2]" is read
 *   the same way, but the grammar's marker in it is [2] alone: CommonMark
 *   renders it as a reference link to [2], and the marker set stays the one
 *   CitationLint reads, which reports [1] uncited. Only citation ids make a
 *   run — a number, a footnote, an assumption, an id the document defines:
 *   "[Stripe][2] charges 2.9%" opens its sentence with a link, and [2] is
 *   that sentence's, as `citedClaims` has it. A piece that is nothing but
 *   brackets, "Revenue rose. [x][2]", gives all its markers to the sentence
 *   before it, whatever the labels, rather than to no claim.
 * - A numbered list's marker is not a sentence. The splitter ends one after
 *   "1." as after any full stop; here "1." opening a list item is the item's
 *   bullet. Where it cannot open one — "12.", or "1." with nothing after it,
 *   on the line after a paragraph line, which CommonMark reads as the
 *   paragraph going on — it stays with the sentence above it, so the figure
 *   is still read. That holds inside a list item as at the top level: under
 *   "- Refunds take" an indented "  5." finishes the item's sentence. Only a
 *   marker indented less than the item's content leaves it for a new item.
 * - A heading is a line that is one: `#` opening a line (after up to three
 *   spaces, counted inside a list item from its content), or a setext
 *   underline under a paragraph that is not in a list item or a block quote
 *   (under those, `---` is a thematic break and the text above it a claim;
 *   a list item's paragraph after a blank line is in the item when indented
 *   to its content). A heading line is a piece of its own, so the claim on
 *   the line under it is never excluded with it. A `#` in the middle of a
 *   line, or after a bullet, is text. A heading is a title, not a claim —
 *   unless it cites a source for a figure or a claim's words, states a
 *   measured value after a label, or is a sentence stating a figure
 *   (`headingClaim`), whatever else the answer says or asks; or the answer
 *   has nothing else to read: "## The refund window is 30 days [1]" and
 *   "### No two of the six meetings overlap" over "Want me to send the
 *   invites?" passed every rung with nothing to prove (design §0).
 * - `line` is the line the claim's first character is on. A sentence that
 *   begins on a new line starts, in the splitter's ranges, at the newline
 *   before it.
 * - A question is a sentence, not a piece. The splitter breaks at a single
 *   line break only after a full stop, and at a full stop only before a
 *   space, a tab or `\n`, so "The refund window is 30 days [1]\nAnything
 *   else?", "…30 days.Anything else?", "…30 days. Anything else?" after a
 *   no-break space, and "…30 days [1] — anything else?" are one piece ending
 *   in `?` — and dropping it whole dropped the claim, so the gate passed the
 *   answer vacuously (design §0, tests A and B). Here only the question at
 *   the end is left out (`questionParts`, `clauseParts`), and a question the
 *   answer answers itself ("…30 days? Yes.") is a claim.
 *
 * Inline code is read as part of the sentence it sits in, words and figures
 * alike: "`packages/gate` holds the verifier" asserts something about the
 * code it names, and leaving the code out would drop it under the word
 * count. A sentence that is nothing but inline code is a literal, not a
 * claim — unless it carries a marker or states a figure, the two things
 * that make a sentence of any length a claim: "`max_retries = 30` [1]."
 * cites a source for the 30, and `citedClaims` reports it. Indented
 * (four-space) code blocks are read as prose, as everywhere else in the
 * citation grammar: models fence their code, and reading a block as prose
 * errs toward a claim checked, never toward one hidden.
 *
 * A definition line is not a claim when the text it shows is read some
 * other way or is nothing: the definition `citationDefinitions` keeps for
 * its id, whatever its source says ("[8]: https://… Payments are processed
 * within 5 days" renders as text, and the provability gate reads that text
 * as claims citing [8] — `definitionGloss`), and any definition that shows
 * nothing past what it names (a destination and at most a link title). A
 * definition-shaped line that is neither — a second `[8]:` line, a bullet
 * `- [8]: https://… Payments …`, which the citation grammar never counts as
 * a definition — is read here as the prose it renders as, so no sentence a
 * reader sees goes unread.
 */
import {
  citationIdTest,
  definitionEntries,
  definitionItemSource,
  labelRunStart,
  markersOutsideCode,
  plainClaim,
} from "./citations";
import { claimFigures } from "./locate";
import {
  type BlockLines,
  inSpan,
  indexSpans,
  inlineCodeSpans,
  lineIndex,
  readBlocks,
} from "./markdown";
import { extractNumbers } from "./numbers";
import { classifyDefinition, definitionGloss } from "./refs";
import { ABBREVIATIONS, MIN_CLAIM_TOKENS, isQuestion, splitSentences } from "./sentences";
import { STOPWORDS } from "./tokens";

export type ExtractedClaim = {
  /** 0-based position among the claims returned. */
  readonly index: number;
  /** The sentence with its markers and Markdown taken out (`plainClaim`). */
  readonly text: string;
  /** The sentence as written, markers included, whitespace trimmed. */
  readonly raw: string;
  /** 1-based line of the claim's first character. */
  readonly line: number;
  /** The marker ids it carries, in order, each once: `[1]` → `"1"`,
   *  `[^a]` → `"a"`, `[A1]` → `"A1"` — the keys `citationDefinitions` uses. */
  readonly markers: ReadonlyArray<string>;
};

export type ExtractClaimsOptions = {
  /** Fewest content words that make an uncited, number-free sentence a
   *  claim (default {@link MIN_CLAIM_TOKENS}). */
  readonly minTokens?: number;
  /** Free text is a reference, not prose, after a definition's marker (the
   *  gate's `sources.bibliographic`): read by `definitionGloss` when a
   *  definition line is weighed for what it shows. Default false. */
  readonly bibliographic?: boolean;
};

/** Letters of a script that does not separate words with spaces. The same
 *  class tool-verify's SEO prose check uses to switch its density off. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/gu;

/**
 * How many content words a sentence has, for the "too short to be a claim"
 * test.
 *
 * For ASCII text this is exactly `contentTokens(text).size`, the measure
 * `MIN_CLAIM_TOKENS` was calibrated against for the faithfulness grader. It
 * splits on Unicode letters and digits instead of `[a-z0-9]`, so a Russian
 * or Greek sentence has words rather than none. In a script that puts no
 * spaces between words a run of letters is a phrase, not a word, so there
 * each letter counts as one: that errs toward calling a short sentence a
 * claim, and the gate's mistake in that direction is a citation asked for,
 * where the other way it is a claim passed unread.
 */
function contentWords(text: string): number {
  let count = 0;
  const seen = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word === "") continue;
    const unspaced = word.match(UNSPACED)?.length ?? 0;
    if (unspaced > 0) {
      count += unspaced;
      continue;
    }
    if (word.length < 3 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    count += 1;
  }
  return count;
}

/** A marker in the text: its id, and the characters `[…]` it takes up. */
type Mark = { readonly marker: string; readonly at: number; readonly end: number };

/** A sentence range with the code and definitions cut out of it. */
type Piece = {
  /** Offset of the first non-whitespace character. */
  first: number;
  /** End offset (exclusive), trailing whitespace dropped. */
  end: number;
  marks: Mark[];
  excluded: boolean;
  /** A heading line, ATX or setext (the underline cut off): excluded as a
   *  sentence, and read as a claim only where `headingClaim` says. */
  heading?: boolean;
};

/** Sorted, merged `[start, end)` ranges. */
function merge(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const BLOCK_QUOTE = /^[ \t]{0,3}>/;
const BLANK = /^[ \t]*$/;
/** A whole line that underlines the paragraph above it into a heading. */
const UNDERLINE = /^[ \t]{0,3}(?:=+|-{2,})[ \t]*$/;
/** A whole line of dashes that is a thematic break, not an underline. */
const THEMATIC_DASHES = /^[ \t]{0,3}-{3,}[ \t]*$/;
/** A setext underline: a line of `=` or `-` straight under the text, with no
 *  blank line between (with one, `---` is a thematic break, a piece of its own). */
const SETEXT_UNDERLINE = /[\n\r][ \t]{0,3}(?:=+|-{2,})[ \t]*$/;
const HAS_WORD = /[\p{L}\p{N}]/u;
/** Between a sentence and the marker after it: spaces, and at most one line break. */
const SAME_PARAGRAPH = /^[ \t]*(?:(?:\r\n|\r|\n)[ \t]*)?$/;
const LINE_BREAK = /[\n\r]/;

/**
 * The document's lines as a renderer breaks them (`\n`, `\r\n`, `\r`), and
 * for each what block it opens or continues. Only what the extractor needs:
 * whether a line is an ATX heading, whether it opens a list item, whether
 * it sits in a list item or block quote, and where a block ends that the
 * splitter does not see. The list structure is `readBlocks`'s, the reading
 * `commonMarkFences` makes of the same document: a line sits in a list item
 * when it is indented to the item's content — after a blank line too, as a
 * continuation paragraph does — or continues a paragraph that does (a lazy
 * line). One pass, so a document with many list markers costs one reading.
 */
type Lines = {
  readonly starts: ReadonlyArray<number>;
  readonly heading: Uint8Array;
  readonly listItem: Uint8Array;
  readonly contained: Uint8Array;
  /** Where a block starts or ends that the splitter does not know of, so
   *  the text on either side is never one piece: just after a setext
   *  underline, or a thematic break under a list item or quote (the next
   *  line is a new block), on both sides of every heading line, and where a
   *  block quote opens under a line outside one. The splitter breaks around
   *  a heading only at column 0, so an indented one, or one inside a list
   *  item, ran into the line under it, and the whole piece — the claim on
   *  that line with it — was excluded as a heading. It never breaks before
   *  `>`, though a quote interrupts a paragraph (CommonMark): "Revenue rose
   *  [2]\n> Costs fell [1]." was one claim citing both. */
  readonly blockEnds: ReadonlyArray<number>;
  /** 0-based line of an offset. */
  readonly at: (offset: number) => number;
};

function readLines(text: string, blocks: BlockLines): Lines {
  const { starts, heading } = blocks;
  const count = starts.length;
  const contained = new Uint8Array(count);
  const cuts = new Set<number>();
  let previousBlank = true;
  // A heading or a fenced block: a block of its own, no paragraph to underline.
  let previousBlock = false;
  let inList = false;
  let inQuote = false;
  for (let k = 0; k < count; k++) {
    let end = k + 1 < count ? (starts[k + 1] as number) : text.length;
    while (end > (starts[k] as number) && LINE_BREAK.test(text[end - 1] as string)) end--;
    const line = text.slice(starts[k], end);
    const blank = BLANK.test(line);
    const quote = BLOCK_QUOTE.test(line);
    if (blocks.code[k] === 0 && !previousBlank && !previousBlock && k + 1 < count) {
      const underline = (inList || inQuote ? THEMATIC_DASHES : UNDERLINE).test(line);
      if (underline) cuts.add(starts[k + 1] as number);
    }
    if (heading[k] === 1) {
      cuts.add(starts[k] as number);
      if (k + 1 < count) cuts.add(starts[k + 1] as number);
    }
    if (quote && !inQuote && k > 0 && blocks.code[k] === 0) cuts.add(starts[k] as number);
    inList = !blank && blocks.contained[k] === 1;
    inQuote = !blank && (quote || (!previousBlank && inQuote));
    contained[k] = inList || inQuote ? 1 : 0;
    previousBlank = blank;
    previousBlock = heading[k] === 1 || blocks.code[k] === 1;
  }
  return {
    starts,
    heading,
    listItem: blocks.item,
    contained,
    blockEnds: [...cuts],
    at: (offset) => {
      let lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((starts[mid] as number) <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
  };
}

/** Is there nothing but spaces and tabs between the start of its line and `at`? */
function opensLine(text: string, at: number, lines: Lines): boolean {
  const start = lines.starts[lines.at(at)] as number;
  let i = at;
  while (i > start && (text[i - 1] === " " || text[i - 1] === "\t")) i--;
  return i === start;
}

/**
 * Where to end a sentence the splitter runs on: after markers glued to a
 * full stop, "text.[1] Next". The splitter ends a sentence only where the
 * punctuation is followed by space, so `[` keeps it going. The rule is the
 * splitter's otherwise — the markers must be followed by space or the end,
 * and "e.g.[1]" or "J.[2]" ends nothing — read off the markers this
 * extractor already found, so no second copy of the marker grammar is
 * written here. A marker's run starts where `labelRunStart` says: in
 * "text.[1][2] Next" the grammar's one marker is [2], and the full stop is
 * before the [1] glued to it. In "text.[Stripe][2] Next" the bracket before
 * [2] is a link's text, not an id (`isCitationId`), so no full stop sits
 * before the run and the sentence goes on, as `citedClaims` reads it.
 */
function gluedCuts(
  text: string,
  marks: ReadonlyArray<Mark>,
  isCitationId: (label: string) => boolean,
): number[] {
  const cuts: number[] = [];
  let k = 0;
  while (k < marks.length) {
    const first = marks[k] as Mark;
    let last = k;
    while (last + 1 < marks.length && (marks[last + 1] as Mark).at === (marks[last] as Mark).end) {
      last++;
    }
    const after = (marks[last] as Mark).end;
    k = last + 1;
    if (after < text.length && !/[ \t\r\n]/.test(text[after] as string)) continue;
    const run = labelRunStart(text, first.at, isCitationId);
    let p = run;
    while (p > 0 && `"')`.includes(text[p - 1] as string)) p--;
    if (p === 0 || !/[.!?]/.test(text[p - 1] as string)) continue;
    let from = run;
    while (from > 0 && !/\s/.test(text[from - 1] as string)) from--;
    const word = text.slice(from, run).toLowerCase();
    if (ABBREVIATIONS.has(word) || /^[\p{L}]\.$/u.test(word)) continue;
    cuts.push(after);
  }
  return cuts;
}

/** Sentence ranges with each cut inside one splitting it in two. */
function withCuts(
  ranges: ReadonlyArray<{ start: number; end: number }>,
  cuts: ReadonlyArray<number>,
): Array<{ start: number; end: number }> {
  if (cuts.length === 0) return [...ranges];
  const out: Array<{ start: number; end: number }> = [];
  let c = 0;
  for (const { start, end } of ranges) {
    let from = start;
    while (c < cuts.length && (cuts[c] as number) <= from) c++;
    while (c < cuts.length && (cuts[c] as number) < end) {
      out.push({ start: from, end: cuts[c] as number });
      from = cuts[c] as number;
      c++;
    }
    out.push({ start: from, end });
  }
  return out;
}

/** Record `[from, to)` as a piece, trimmed to its non-whitespace extent. */
function addPiece(text: string, from: number, to: number, pieces: Piece[]): void {
  let first = from;
  while (first < to && /\s/.test(text[first] as string)) first++;
  let end = to;
  while (end > first && /\s/.test(text[end - 1] as string)) end--;
  if (end > first) pieces.push({ first, end, marks: [], excluded: false });
}

/** `end` moved back over whitespace, never past `first`. */
function trimEnd(text: string, first: number, end: number): number {
  let e = end;
  while (e > first && /\s/.test(text[e - 1] as string)) e--;
  return e;
}

/**
 * Where a numbered-list marker that ends a piece starts — "1." alone, or on
 * a line of its own under the piece's other text — or -1. Read from the
 * end, so a long piece costs nothing extra.
 */
function trailingListMarker(text: string, piece: Piece): number {
  const close = text[piece.end - 1];
  if (close !== "." && close !== ")") return -1;
  let i = piece.end - 1;
  while (i > piece.first && piece.end - 1 - i < 10 && /\d/.test(text[i - 1] as string)) i--;
  const digits = piece.end - 1 - i;
  if (digits < 1 || digits > 9) return -1;
  let j = i;
  while (j > piece.first && (text[j - 1] === " " || text[j - 1] === "\t")) j--;
  if (j > piece.first && !LINE_BREAK.test(text[j - 1] as string)) return -1;
  return i;
}

/**
 * A numbered list's marker joined to its item: "1." opening a list item is
 * the item's bullet, not a sentence of its own. Where "12." cannot open one
 * — under a paragraph line, which CommonMark reads as the paragraph going on
 * — it stays with the sentence on the line above, so the figure is still
 * read.
 */
function joinListMarkers(text: string, pieces: ReadonlyArray<Piece>, lines: Lines): Piece[] {
  const out: Piece[] = [];
  let pending: { first: number; end: number } | null = null;
  for (const original of pieces) {
    const piece: Piece = { ...original };
    const at = trailingListMarker(text, piece);
    if (at === -1) {
      if (pending !== null && !LINE_BREAK.test(text.slice(pending.end, piece.first))) {
        piece.first = pending.first;
      }
      pending = null;
      out.push(piece);
      continue;
    }
    pending = null;
    if (lines.listItem[lines.at(at)] === 1) {
      if (at > piece.first) out.push({ ...piece, end: trimEnd(text, piece.first, at) });
      pending = { first: at, end: piece.end };
      continue;
    }
    const above = out[out.length - 1];
    if (at === piece.first && above !== undefined && lines.at(above.end) === lines.at(at) - 1) {
      above.end = piece.end;
      continue;
    }
    out.push(piece);
  }
  return out;
}

/**
 * Headings and reference-list items marked excluded, a heading marked as
 * one (`headingClaim` reads it), and a setext underline cut off the text it
 * underlines: under a list item or a quote `---` is a thematic break and
 * `===` is text, so the line above it is a claim, not a heading. Which it is
 * depends on the line the underline sits under, the one `readLines` asks
 * about too, not on where the piece starts: a piece that began in a
 * paragraph and ran into a quote was excluded whole as a heading.
 */
function markBlocks(text: string, pieces: Piece[], lines: Lines, bibliographic: boolean): void {
  for (const piece of pieces) {
    const lineOfFirst = lines.at(piece.first);
    const underline = SETEXT_UNDERLINE.exec(text.slice(piece.first, piece.end));
    if (underline !== null) {
      // The match starts at the line break that ends the line above it.
      piece.end = trimEnd(text, piece.first, piece.first + underline.index);
      if (lines.contained[lines.at(piece.first + underline.index)] !== 1) {
        piece.excluded = true;
        piece.heading = true;
      }
    }
    if (lines.heading[lineOfFirst] === 1) {
      piece.excluded = true;
      piece.heading = true;
    }
    if (!piece.excluded && opensLine(text, piece.first, lines)) {
      // A reference list written as bullets, `- [1]: https://…`, is not a
      // claim. A bullet that shows text beyond what it names — prose for
      // its "source", or a sentence after the URL — is one: it renders as
      // that text, and `citationDefinitions` never counts it as a
      // definition, so the gate would read it nowhere else.
      const source = definitionItemSource(text.slice(piece.first, piece.end));
      if (source !== null) {
        const ref = classifyDefinition(source);
        if (ref.kind !== "text" && definitionGloss(source, ref, bibliographic) === "") {
          piece.excluded = true;
        }
      }
    }
  }
}

/**
 * Does a sentence state a figure — the other thing besides a marker that
 * makes a sentence of any length a claim (design §2)? A numeral the number
 * layer reads, or a number word the locate kernel's figure rule reads
 * (`claimFigures`): "Seats: twelve." and "It holds a dozen." state 12 as
 * surely as "Seats: 12." does, and the figure rule already compares them so.
 * A list-counting "First," is no figure there and none here. "one" is left
 * out: it is a pronoun far more often than a count ("pick one", "one
 * moment", "the one you asked about"), and those are not claims. "Seats:
 * one." is therefore read only by the word count, the one gap this keeps.
 */
function statesFigure(plain: string): boolean {
  if (extractNumbers(plain).length > 0) return true;
  return claimFigures(plain).some((word) => !/^\d/.test(word) && word !== "one");
}

/**
 * A value's numeral, the whole word: signed, in a currency, grouped, with a
 * decimal part, a percent or a scale ("1,284.50", "$1,386.26", "-3%", "5k",
 * "$107.6B").
 */
const NUMERAL_WORD = /^[-−+]?\p{Sc}?\d[\d,.  ']*(?:%|[kKmMbB]|bn|mn)?\p{Sc}?$/u;
/** A numeral that is an amount, not a count, a year or a list's place: it
 *  carries a currency, a group or decimal separator, or a percent. */
const AMOUNT = /[\p{Sc},.%]/u;

/**
 * What a measured value may say after its numeral: a unit of time, money,
 * size or rate ("30 days", "1,284.50 USD", "99.9 percent", "$10 per month").
 * A count of things ("3 key takeaways", "5 tips", "10 Rules", "3 cloud
 * providers") is not one — that is a title's number.
 */
const UNIT_WORDS: ReadonlySet<string> = new Set([
  "second",
  "seconds",
  "sec",
  "secs",
  "s",
  "ms",
  "minute",
  "minutes",
  "min",
  "mins",
  "hour",
  "hours",
  "hr",
  "hrs",
  "h",
  "day",
  "days",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years",
  "yr",
  "yrs",
  "business",
  "working",
  "calendar",
  "percent",
  "pct",
  "%",
  "bps",
  "usd",
  "eur",
  "gbp",
  "jpy",
  "cad",
  "aud",
  "chf",
  "cny",
  "inr",
  "dollar",
  "dollars",
  "euro",
  "euros",
  "pound",
  "pounds",
  "cent",
  "cents",
  "kb",
  "mb",
  "gb",
  "tb",
  "kib",
  "mib",
  "gib",
  "tib",
  "bytes",
  "kg",
  "g",
  "lb",
  "lbs",
  "km",
  "mi",
  "miles",
  "m",
  "cm",
  "mm",
  "ft",
  "x",
  "times",
  "per",
  "a",
  "an",
  "each",
]);

/** The quantities a value with no colon names: "Total with tax 1,386.26". */
const AMOUNT_NOUNS: ReadonlySet<string> = new Set([
  "total",
  "subtotal",
  "sum",
  "amount",
  "balance",
  "price",
  "cost",
  "fee",
  "fees",
  "tax",
  "revenue",
  "profit",
  "income",
  "budget",
  "payment",
  "charge",
  "due",
  "owed",
]);

/**
 * A clause that only numbers a step or a part ("Step 6", "Axis 5", "Option
 * 2", "Part B"): a label, whose figure is its place in a list, not a value
 * it states.
 */
const LABEL_INDEX =
  /^(?:step|axis|option|part|phase|stage|section|chapter|item|tip|rule|case|scenario|example|question|level|tier|round|day|week|plan|appendix|lesson|module|unit|track|slide|figure|table)\s+(?:\d{1,3}|[a-z])$/i;

/** A schedule's label: a day, not the name of a quantity ("Monday: 5k run"). */
const SCHEDULE_LABEL =
  /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thurs|fri|sat|sun|today|tomorrow|tonight|weekend|weekdays?|morning|afternoon|evening)$/i;

/** A label that orders a list or a schedule, never a quantity's name. */
function ordersList(label: string): boolean {
  const said = label.trim();
  return LABEL_INDEX.test(said) || SCHEDULE_LABEL.test(said);
}

/** Is `value` a measured value, a numeral and at most three unit words? */
function measures(value: string): boolean {
  const words = value.trim().split(/\s+/);
  if (words.length > 4 || !NUMERAL_WORD.test(words[0] as string)) return false;
  return words.slice(1).every((word) => UNIT_WORDS.has(word.toLowerCase().replace(/[.,;!]+$/, "")));
}

/**
 * A heading that states its value after a label: "Invoice total: 1,284.50",
 * "Refund window: 30 days", "Total with tax: $1,386.26", and with no colon
 * an amount after the quantity it is, "Total with tax 1,386.26". The value
 * is the claim, as "The invoice total is 1,284.50." would be.
 *
 * A title is not one, and titles carry numbers too. A section title says
 * something else after its colon — "Step 1: Install the CLI", "Detection:
 * energy and zero-crossings" — or counts what the section holds: "Summary: 3
 * key takeaways", "Part 2: 5 tips", "Chapter 3: 10 Rules", "# Compare: 3
 * cloud providers", a report-writer goal. So the value must be a measure, a
 * numeral and its units (`measures`), never a count of things; and a label
 * that orders a list or a schedule ("Step 3: 10 minutes", "Phase 1: 2
 * weeks", "Monday: 5k run") names no quantity. With no colon the label must
 * name an amount and the numeral be one ("Top 5 providers", "Price list for
 * 2024" are titles).
 */
function labelsValue(plain: string): boolean {
  const colon = plain.lastIndexOf(": ");
  if (colon >= 1) {
    const label = plain.slice(0, colon);
    return HAS_WORD.test(label) && !ordersList(label) && measures(plain.slice(colon + 2));
  }
  const words = plain.trim().split(/\s+/);
  const at = words.findIndex((word) => NUMERAL_WORD.test(word));
  if (at < 1 || !AMOUNT.test(words[at] as string)) return false;
  const named = words.slice(0, at).some((word) => AMOUNT_NOUNS.has(word.toLowerCase()));
  return named && measures(words.slice(at).join(" "));
}

/** A heading that opens as an indirect question ("How it works", "What is
 *  included in 2024"): a title, whatever verb it holds. */
const WH_TITLE = /^(?:who|whom|whose|what|which|when|where|why|how)(?![\p{L}])/iu;
/** A form of "be" between a subject and what it is said to be: "The refund
 *  window is 30 days", "The meetings are 6". */
const COPULA =
  /(?:^|\s)(?:it's|that's|there's)(?=\s)|\s(?:is|are|was|were)(?:n't| not)?(?=\s+[^\s])/iu;
/** A heading that denies something of a set: "No two of the six meetings overlap". */
const NEGATED = /^(?:no|none|neither)\s/i;

/**
 * Does a heading read as a sentence rather than a title: a subject and a
 * form of "be" ("The refund window is 30 days", "The invoice total is
 * 1,284.60"), or a denial over a set ("No two of the six meetings overlap")?
 * A title is a noun phrase ("Top 5 providers by 2024 revenue", "Refund
 * options for 2024") or an indirect question ("How the 3 plans differ").
 */
function declares(plain: string): boolean {
  const said = plain.replace(/’/g, "'");
  if (WH_TITLE.test(said)) return false;
  return NEGATED.test(said) || COPULA.test(said);
}

/** A heading with a list's label taken off its front: "Step 2: The refund
 *  window is 30 days" says what "The refund window is 30 days" says. */
function withoutListLabel(plain: string): string {
  const colon = plain.indexOf(": ");
  return colon >= 1 && ordersList(plain.slice(0, colon)) ? plain.slice(colon + 2) : plain;
}

/**
 * Is a heading, ATX or setext, a claim (design §0: tests A, B and C are
 * un-servable even when the model misbehaves; §2: a marker or a number makes
 * a claim)? A heading is a section's title, and design §2 does not read one
 * — but a claim written as a heading ("## The refund window is 30 days [1]",
 * "## Invoice total: 1,284.50", "### No two of the six meetings overlap")
 * passed every rung with nothing to prove, and a question after it ("Want
 * me to send the invites?") hid it from the rule for an answer of nothing
 * but headings. So one is read when it is plainly a claim and not a title,
 * whatever else the answer says or asks:
 *
 * - it cites a source and says more than a title does — a figure, or the
 *   words of a claim: "## Results [1]" is a title, "## The refund window is
 *   30 days [1]" a claim;
 * - it states a value after a label (`labelsValue`);
 * - it is a sentence that states a figure (`declares`): "## The invoice
 *   total is 1,284.60", "### No two of the six meetings overlap". A list's
 *   label before it ("Step 2: …") is no figure it states.
 *
 * A figure alone does not make one: "## Step 2: Gather data", "## Top 5
 * providers by 2024 revenue" and a research report's "# Compare the 2024
 * revenue of the top 3 providers" are titles. They are read, as any
 * sentence would be, only in an answer that has no other claim (see
 * `extractClaims`). A heading that asks is never a claim.
 */
function headingClaim(plain: string, cited: boolean, figured: boolean, minTokens: number): boolean {
  if (cited && (figured || contentWords(plain) >= minTokens)) return true;
  if (labelsValue(plain)) return true;
  const said = withoutListLabel(plain);
  return declares(said) && statesFigure(said);
}

/**
 * The answer a question gets in the sentence after it, and nothing more:
 * "Is the refund window 30 days? Yes." The two are one claim.
 */
const BARE_ANSWER =
  /^(?:yes|no|yep|yeah|nope|correct|incorrect|exactly|indeed|true|false|right|wrong|absolutely|definitely|certainly|confirmed|that's (?:right|correct|wrong)|that is (?:right|correct|wrong))(?:,? (?:it|they|that|there|we|you) (?:is|are|was|were|does|do|did|has|have|had|will|can|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|hasn't|haven't|won't|can't))?[.!]*$/i;

/** What may open a line before its first letter: emphasis, a quote, code, a bracket. */
const LINE_OPENER = /[ \t*_~>`"'([]/;
/** What may close after a terminator before the next sentence: a quote, a bracket. */
const CLOSERS = `"')]”’»`;
/**
 * What may open a sentence glued to a terminator, before its first letter:
 * emphasis ("30 days.**Want more?**"), a quote or a bracket, a dash, an
 * inverted question or exclamation mark.
 */
const GLUE_OPENERS = `*_~"'(“‘«¿¡—–-`;
/** What ends a sentence: the splitter's three, and an ellipsis. */
const TERMINATORS = ".!?…";
/** An initialism, "U.S." or "J.": its full stops end no sentence. */
const INITIALISM = /^(?:[\p{L}]\.)+$/u;
/** No abbreviation is longer than this, so a glued word is read back no further. */
const MAX_ABBREVIATION = 16;
/**
 * What a dotted name goes on with after its `.`: a letter (`Text.Json`,
 * `acme.example`). A digit does not, so "1,284.50.Is it right?" still ends.
 */
const NAME_CHAR = /[\p{L}_]/u;
/** A line break as a reader sees one: CommonMark's `\n` and `\r`, Unicode's
 *  line and paragraph separators, and NEL. `<br>` is one too. This is where
 *  a sentence ends, not where a block does: headings and fences are read at
 *  CommonMark's line endings alone (`readBlocks`). */
const LINE_CHAR = /[\n\r\u2028\u2029\u0085]/;
/** Any whitespace, which ends a sentence after a terminator: the splitter
 *  ends one only before a space, a tab or `\n`. */
const SPACE_CHAR = /[\s\u0085]/;
/** A character Unicode marks default-ignorable: a zero-width space, a soft hyphen. */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
/** A numbered list item's number and the space after it, `1. ` or `2) `. */
const ITEM_NUMBER = /^\d{1,9}[.)][ \t]+/;
/** `<br>`, `<br/>` or `<br />`, read at a `<`. */
const BREAK_TAG = /^<br[ \t]*\/?>/i;
/** An emoji, which closes a clause as a full stop would ("30 days 👍 Anything else?"). */
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
/** What an emoji's sequence goes on with: a variation selector, a joiner, a skin tone. */
const PICTOGRAPH_TAIL = /\ufe0f|\u200d|\p{Emoji_Modifier}|\p{Extended_Pictographic}/u;

/**
 * Words a question opens with: an interrogative, an auxiliary put first, a
 * condition ("If you want the 12-month plan, should I…?"), and the openers
 * of a question with its verb left off ("Want the 2024 report, or the 2023
 * one?"). A sentence that opens with one asks: a clause before its comma,
 * or a name dotted inside it, is the question's, not a claim (design §2).
 */
const QUESTION_OPENERS: ReadonlySet<string> = new Set([
  "who",
  "whom",
  "whose",
  "what",
  "which",
  "when",
  "where",
  "why",
  "how",
  "who's",
  "what's",
  "where's",
  "how's",
  "whether",
  "if",
  "unless",
  "or",
  "is",
  "are",
  "am",
  "was",
  "were",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "don't",
  "doesn't",
  "didn't",
  "haven't",
  "hasn't",
  "hadn't",
  "can't",
  "couldn't",
  "won't",
  "wouldn't",
  "shouldn't",
  "want",
  "need",
  "prefer",
]);

/**
 * Words a fronted phrase opens with ("For the 2024 rates, should I use the
 * new table?"): what that phrase holds sets the question up, and only a
 * figure or a marker after it, in a clause of its own, is a claim.
 */
const FRONTED_OPENERS: ReadonlySet<string> = new Set([
  "about",
  "after",
  "as",
  "assuming",
  "at",
  "before",
  "besides",
  "between",
  "by",
  "considering",
  "during",
  "for",
  "from",
  "given",
  "in",
  "on",
  "once",
  "over",
  "per",
  "regarding",
  "since",
  "to",
  "under",
  "until",
  "while",
  "with",
  "within",
]);

/** A conjunction a sentence may open with before its first real word. */
const CONJUNCTIONS: ReadonlySet<string> = new Set(["and", "but", "so", "then", "also", "plus"]);
/** How far into a sentence its opening word is looked for. */
const OPENER_REACH = 64;

/**
 * The word a sentence opens with, lowercased, past its Markdown and a
 * leading conjunction ("And is it 30 days, or 14?" opens with "is"). Read
 * no further than {@link OPENER_REACH} characters, so a sentence is asked
 * once at a bounded cost.
 */
function openerOf(text: string, from: number, end: number): string {
  const to = Math.min(end, from + OPENER_REACH);
  let i = from;
  let word = "";
  for (let n = 0; n < 2; n++) {
    while (i < to && !/\p{L}/u.test(text[i] as string)) i++;
    let j = i;
    while (j < to && /[\p{L}'’]/u.test(text[j] as string)) j++;
    word = text.slice(i, j).toLowerCase().replace(/’/g, "'");
    if (!CONJUNCTIONS.has(word)) return word;
    i = j;
  }
  return word;
}

/**
 * Does the word glued to a terminator at `at` continue an identifier rather
 * than open a sentence: another name-joining `.` (`Text.Json`) or a capital
 * inside it (`WriteLine`) before it ends? The word is read only up to its
 * first `.`, `?`, `!` or whitespace — where the next terminator the caller
 * reads is — so every terminator's word is read once.
 */
function continuesName(text: string, at: number, end: number): boolean {
  for (let i = at + 1; i < end; i++) {
    const ch = text[i] as string;
    if (ch === ".") return NAME_CHAR.test(text[i + 1] ?? "");
    if (ch === "?" || ch === "!" || /\s/.test(ch)) return false;
    if (/\p{Lu}/u.test(ch) && /\p{Ll}/u.test(text[i - 1] as string)) return true;
  }
  return false;
}

/**
 * Does the word glued to a full stop at `at` run on to the question mark
 * that ends the piece, with nothing between ("…a call to Array.Sort?")?
 * Then it is the name the question asks about, not a question of its own
 * after a sentence (the review's I31). Read to the word's end only.
 */
function endsPieceAsName(text: string, at: number, end: number): boolean {
  let i = at;
  while (i < end && /[\p{L}\p{N}_]/u.test(text[i] as string)) i++;
  while (i < end && `*_~"')]”’`.includes(text[i] as string)) i++;
  if (text[i] !== "?") return false;
  while (i < end && `?!*_~"')]”’`.includes(text[i] as string)) i++;
  return i === end;
}

/**
 * Words that open a follow-up glued to a full stop ("…30 days.anything
 * else?", "…dollars.let me know"), besides the question openers. No domain
 * label or file extension is one of these.
 */
const FOLLOW_UPS: ReadonlySet<string> = new Set([
  "anything",
  "any",
  "let",
  "please",
  "thanks",
  "thank",
  "hope",
  "feel",
]);

/**
 * Is the full stop at `at` inside a domain or a file name — between a word
 * and a lowercase name part, "acme.example/refunds", "nodejs.org",
 * "policy.md", "v2.json" — and not before a sentence glued to it? The word
 * before must hold a letter (after "1,284.50" or "[1]" a full stop ends a
 * sentence: "1,284.50.want me to email it?"), and the word after must not
 * open a question or a follow-up ("days.anything else?"). Read no further
 * than {@link MAX_ABBREVIATION} characters either way.
 */
function insideName(text: string, at: number, first: number, end: number): boolean {
  let i = at;
  let lettered = false;
  while (i > first && at - i < MAX_ABBREVIATION && /[\p{L}\p{N}_-]/u.test(text[i - 1] as string)) {
    if (/\p{L}/u.test(text[i - 1] as string)) lettered = true;
    i--;
  }
  if (!lettered) return false;
  let j = at + 1;
  while (j < end && j - at <= MAX_ABBREVIATION && /[\p{L}'’]/u.test(text[j] as string)) j++;
  const word = text
    .slice(at + 1, j)
    .toLowerCase()
    .replace(/’/g, "'");
  return !QUESTION_OPENERS.has(word) && !FOLLOW_UPS.has(word);
}

/** Does the line starting at `at` open (after its Markdown) with a lowercase letter? */
function opensLowercase(text: string, at: number, end: number): boolean {
  let i = at;
  while (i < end && LINE_OPENER.test(text[i] as string)) i++;
  return i < end && /\p{Ll}/u.test(text[i] as string);
}

/** Where a sentence the splitter ran on ends inside a piece: the sentence
 *  before it ends at `left`, the next starts at `right`. */
type SentenceEnd = { readonly left: number; readonly right: number; readonly question: boolean };

/**
 * A piece whose text ends in `?`, cut where a sentence inside it ends that
 * the splitter ran on, so that only the question it ends with is left out
 * (design §2: a claim is a declarative, non-question sentence; §0: tests A
 * and B are un-servable even when the model misbehaves). Read from the end:
 * the question is the last sentence, and what comes before it is one piece,
 * as it would be with no question after it — a table above "Want the annual
 * prices too?" stays one claim, its marker with it.
 *
 * The splitter ends a sentence only at `.`, `!` or `?` before a space, a tab
 * or `\n`. Where else one ends is decided left to right, each place by the
 * sentence it would end — the text back to the last place one did. A
 * sentence "carries a claim" when it holds a marker or states a figure
 * (`statesFigure`), the two things that make a sentence of any length a
 * claim, and "opens as a question" when its first word is an interrogative,
 * an auxiliary put first or a condition (`QUESTION_OPENERS`). One ends at:
 *
 * - a line break — `\n`, `\r`, U+2028, U+2029, NEL, or `<br>` — unless the
 *   line after it opens with a lowercase letter and the sentence before it
 *   carries no claim. That is one question wrapped ("Should I send the
 *   corrected invoice to the billing contact\nbefore Friday?"). A wrapped
 *   question whose wrapped line opens with a capital, or whose first line
 *   states a figure, is therefore read as a claim too: at a `cited` floor
 *   that asks for a citation the question did not need, where the other way
 *   it served a figure unread;
 * - a terminator, `…` among them, and any closing quote or bracket, before
 *   whitespace the splitter does not break at: a no-break or ideographic
 *   space, a form feed, "30 days.” Anything else?". Not after an
 *   abbreviation or an initialism ("U.S."), and an ellipsis before a
 *   lowercase word ("it's… maybe 30?") only when the sentence carries a
 *   claim;
 * - a terminator glued to a letter, past any emphasis, quote, dash,
 *   inverted mark or list number that opens the next sentence, and any
 *   ignorable character ("30 days.Anything else?", "France [1].Right?",
 *   "[1].—anything else?", "[1].1) Anything else?"), not after an
 *   abbreviation or an initialism ("U.S.Army"), and not in code. A `?`, `!`
 *   or `…` glued to a capital ends a sentence, and one glued to a lowercase
 *   letter ends one that carries a claim. A full stop is also how a name is
 *   dotted. One between a word and a lowercase name part ("acme.example",
 *   "nodejs.org", "policy.md": `insideName`) ends nothing, marker or not,
 *   unless the word after it opens a question or a follow-up ("…days.anything
 *   else?"). One glued to a capital ends a sentence that holds a marker, and
 *   any other unless the sentence opens as a question ("Should I set the
 *   timeout to 30 seconds in Startup.Configure?", the review's I31), or the
 *   full stop is in a name: the token before it holds a `/` or a
 *   name-joining `.` ("System.Text.Json", "…/Guide.Html"), the word after it
 *   goes on as an identifier ("Console.WriteLine"), or that word runs
 *   straight to the `?` that ends the piece ("a call to Array.Sort?"). A
 *   full stop in such a name, and one glued to a lowercase letter after a
 *   figure or a marker, ends only a sentence that holds a marker, or states
 *   a figure and does not open as a question: "1,284.50.want me to email
 *   it?" and "…30 days [1], see the policy.md.Anything else?" end where the
 *   name would have hidden the claim (the review's I1), and "Is the 30-day
 *   window at acme.example/policy?" does not.
 *
 * After a cut, the text before it is read again when it too ends in `?`
 * ("Is it 30?Anything else?"). A question left whole is then read for a
 * claim joined to it inside the one sentence (`clauseParts`).
 */
function questionParts(text: string, piece: Piece, inCode: (offset: number) => boolean): Piece[] {
  const ends: SentenceEnd[] = [];
  const marks = piece.marks;
  // The sentence being read: where it starts, whether a marker or a figure
  // has been seen in it so far, and the word it opens with. The figure is
  // asked of each stretch between two places a sentence could end, once, so
  // a piece costs its length however many places it has.
  let start = piece.first;
  let stretch = piece.first;
  let figured = false;
  let marked = false;
  // Whether it says a word yet: a line of nothing but a marker is no
  // sentence, and its marker is the sentence's above it (or, with none
  // above, the one it runs into).
  let worded = false;
  let opener: string | undefined;
  let m = 0;
  const readTo = (left: number): void => {
    while (m < marks.length && (marks[m] as Mark).at < left) {
      if ((marks[m] as Mark).at >= start) marked = true;
      m++;
    }
    if ((figured && worded) || left <= stretch) return;
    const plain = plainClaim(text.slice(stretch, left));
    worded ||= HAS_WORD.test(plain);
    figured ||= statesFigure(plain);
  };
  const asks = (): boolean => {
    opener ??= openerOf(text, start, piece.end);
    return QUESTION_OPENERS.has(opener);
  };
  // `question` is asked only of a sentence that ends, so a run of lines
  // that end none is not read again at each one.
  const end = (left: number, right: number, question: () => boolean): void => {
    if (!worded) {
      const above = ends[ends.length - 1];
      if (above === undefined || !marked) return;
      ends[ends.length - 1] = { left, right, question: above.question || question() };
      start = right;
      marked = false;
      opener = undefined;
      return;
    }
    ends.push({ left, right, question: question() });
    start = right;
    figured = false;
    marked = false;
    worded = false;
    opener = undefined;
  };
  // Where the token the scan is in began (after the last whitespace), and
  // the last `/` or name-joining `.` seen: a token holding one is a dotted
  // name or a URL path, and a capital glued to it continues it. Both only
  // move right, so the piece is read once however many terminators it has.
  let scanned = piece.first;
  let tokenStart = piece.first;
  let joined = -1;
  const dottedBefore = (at: number): boolean => {
    for (; scanned < at; scanned++) {
      const ch = text[scanned] as string;
      if (/\s/.test(ch)) tokenStart = scanned + 1;
      else if (ch === "/" || (ch === "." && NAME_CHAR.test(text[scanned + 1] ?? ""))) {
        joined = scanned;
      }
    }
    return joined >= tokenStart;
  };
  for (let i = piece.first; i < piece.end; i++) {
    const c = text[i] as string;
    const tag = c === "<" && !inCode(i) ? BREAK_TAG.exec(text.slice(i, i + 8)) : null;
    if (LINE_CHAR.test(c) || tag !== null) {
      const right =
        tag !== null ? i + tag[0].length : c === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
      readTo(i);
      if (marked || figured || !opensLowercase(text, right, piece.end)) {
        end(i, right, () => isQuestion(plainClaim(text.slice(start, i))));
      }
      stretch = right;
      i = right - 1;
      continue;
    }
    if (!TERMINATORS.includes(c)) continue;
    let j = i + 1;
    while (j < piece.end && TERMINATORS.includes(text[j] as string)) j++;
    const run = text.slice(i, j);
    while (j < piece.end && CLOSERS.includes(text[j] as string)) j++;
    const next = i;
    i = j - 1;
    if (inCode(next)) continue;
    let from = next;
    while (
      from > piece.first &&
      next - from < MAX_ABBREVIATION &&
      !/\s/.test(text[from - 1] as string)
    ) {
      from--;
    }
    const word = text.slice(from, next + 1).toLowerCase();
    if (ABBREVIATIONS.has(word) || INITIALISM.test(word)) continue;
    const question = (): boolean => run.includes("?");
    const fullStop = /^\.+$/.test(run);
    // An ignorable character after it is nothing a reader sees.
    const close = j;
    while (j < piece.end && IGNORABLE.test(text[j] as string)) j++;
    if (j < piece.end && SPACE_CHAR.test(text[j] as string)) {
      // Where the splitter broke, the piece was joined back on purpose — a
      // list's "1." to its item, a marker after a full stop to its sentence.
      if (
        /^[.!?]+$/.test(run) &&
        /^["')\]]*$/.test(text.slice(next + run.length, j)) &&
        /[ \t\n]/.test(text[j] as string)
      ) {
        continue;
      }
      // Whitespace the splitter did not break at. A line break in it is read
      // as one, where the loop reaches it.
      let w = j;
      while (
        w < piece.end &&
        SPACE_CHAR.test(text[w] as string) &&
        !LINE_CHAR.test(text[w] as string)
      ) {
        w++;
      }
      if (w === piece.end || LINE_CHAR.test(text[w] as string)) continue;
      readTo(j);
      const trailing = !/[.!?]/.test(run) && opensLowercase(text, w, piece.end);
      if (!trailing || marked || figured) end(close, w, question);
      stretch = w;
      i = w - 1;
      continue;
    }
    let letter = j;
    while (letter < piece.end && GLUE_OPENERS.includes(text[letter] as string)) letter++;
    // A list item's number may open what follows: "…30 days.1) Anything else?".
    letter += ITEM_NUMBER.exec(text.slice(letter, letter + 16))?.[0].length ?? 0;
    if (letter >= piece.end || !/\p{L}/u.test(text[letter] as string)) continue;
    const upper = /\p{Lu}/u.test(text[letter] as string);
    // Read in order, so the token scan only moves right.
    const dotted = fullStop && dottedBefore(next);
    readTo(j);
    let isEnd: boolean;
    // A full stop between a word and the next part of its name is the
    // name's, marker or no marker: "…30 days per acme.example/refunds [1] —
    // anything else?" is one claim citing [1], not "…per acme." and an
    // uncited "example/refunds".
    if (
      fullStop &&
      !upper &&
      letter === next + 1 &&
      insideName(text, next, piece.first, piece.end)
    ) {
      isEnd = false;
    } else if (marked) isEnd = true;
    else if (!fullStop) isEnd = upper || figured;
    else {
      // A full stop glued to a lowercase letter, or inside a name, ends only
      // a sentence that states a figure and does not ask; one glued to a
      // capital ends any sentence that does not open as a question. A
      // question's figure does not end it there: "Should I set the timeout
      // to 30 seconds in Startup.Configure for production?" asks.
      const name =
        !upper ||
        dotted ||
        continuesName(text, letter, piece.end) ||
        endsPieceAsName(text, letter, piece.end);
      isEnd = name ? figured && !asks() : !asks();
    }
    if (isEnd) end(close, j, question);
    stretch = j;
  }

  // Cut from the end while what is left ends in a question: each end is
  // read once, and the markers are handed out once.
  const spans: Array<{ first: number; end: number }> = [];
  let last = piece.end;
  for (let k = ends.length - 1; k >= 0; k--) {
    const cut = ends[k] as SentenceEnd;
    let first = cut.right;
    while (first < last && /\s/.test(text[first] as string)) first++;
    if (first < last) spans.push({ first, end: last });
    last = trimEnd(text, piece.first, cut.left);
    if (!cut.question) break;
  }
  if (last > piece.first) spans.push({ first: piece.first, end: last });
  spans.reverse();
  const parts: Piece[] = [];
  let next = 0;
  for (const { first, end: to } of spans) {
    while (next < marks.length && (marks[next] as Mark).at < first) next++;
    const own: Mark[] = [];
    while (next < marks.length && (marks[next] as Mark).at < to) own.push(marks[next++] as Mark);
    const part: Piece = { first, end: to, marks: own, excluded: false };
    const asked = isQuestion(plainClaim(text.slice(first, to)));
    parts.push(...(asked ? clauseParts(text, part, inCode) : [part]));
  }
  return parts;
}

/** What the reader wants, said back to them: "you want …", "you'd like …". */
const READER_WANTS: ReadonlySet<string> = new Set([
  "want",
  "wanted",
  "need",
  "needed",
  "mean",
  "meant",
  "prefer",
  "asked",
  "said",
  "like",
  "would",
  "plan",
  "intend",
  "wish",
  "chose",
  "picked",
  "asking",
  "looking",
]);

/**
 * Does the clause from `from` to `to` say back what the reader wants ("you
 * want the 12-month plan at $96", "you'd like 2 seats", "you're asking
 * about the 30-day trial")? A clause before "right?" that confirms the
 * reader's request asks it; one that states the reader's account ("your
 * total is $45", "you have 3 seats left") is a claim.
 */
function echoesReader(text: string, from: number, to: number): boolean {
  const words = text
    .slice(from, Math.min(to, from + OPENER_REACH))
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .match(/[\p{L}']+/gu);
  if (words === null || !/^you(?:'d|'re)?$/.test(words[0] as string)) return false;
  const verb = (words[1] === "are" || words[1] === "were" ? words[2] : words[1]) ?? "";
  return READER_WANTS.has(verb);
}

/**
 * How a sentence opens when it acknowledges the reader or sets up the
 * question it ends with: "Got it —", "Thanks for the 3 files,", "Okay,",
 * "Just to confirm:", "Quick question about the 2024 report:", "Two quick
 * questions:", "Re:", "Before I book:". What follows such an opening, up to
 * the question, is the reader's request said back ("2 seats", "2 adults and
 * 1 child", "invoice #1042"), not something the answer asserts.
 */
const SETS_UP =
  /^(?:got it|gotcha|understood|noted|ok(?:ay)?|alright|all right|sure(?: thing)?|great|perfect|cool|thanks|thank you|sounds good|makes sense|(?:happy|glad) to help|no problem|of course|will do|(?:just )?to (?:confirm|clarify|be sure|make sure|double[- ]check|recap)|just checking|quick question|(?:one|two|three|four|five|a few|a couple(?: of)?|some|\d{1,2}) (?:quick |more |short )?questions?|re(?=\s*:)|before (?:i|we))(?![\p{L}\p{N}])/iu;

/**
 * A clause that asserts rather than restates: a subject and a finite verb
 * the answer could be wrong about ("the invoice total is 1,284.60", "you
 * have 3 seats left", "the refund came to $45"), with something after the
 * verb — "30 minutes it is" restates.
 */
const ASSERTS =
  /(?:^|\s)(?:is|are|was|were|isn't|aren't|wasn't|weren't|it's|that's|there's|has|have|had|hasn't|haven't|will|costs?|took|takes?|came|comes?|totals?|totaled|totalled|equals?|rose|fell|grew|dropped|increased|decreased|remains?|stands?|holds?|reached|runs?|ran|lasts?|expires?|includes?)(?=\s+[^\s])/iu;

/**
 * A question that one sentence makes of a claim and a question after it,
 * cut into the two: "The refund window is 30 days [1] — anything else I can
 * help with?", "The invoice total is 1,284.60; want me to send the PDF?",
 * "…30 days [1], right?", "| Refund window | 30 days | Any questions? |",
 * "Refund window: 30 days 👍 Anything else?". Left whole, the sentence ends
 * in `?` and was dropped, and the gate passed a cited figure it never read
 * (design §0, tests A and B; §2 reserves the vacuous pass for an answer that
 * only asks).
 *
 * A clause ends at a comma or a semicolon before whitespace, a colon before
 * whitespace or a letter, a dash (an em dash anywhere, an en dash or a
 * hyphen with space on both sides), a table cell's `|`, and an emoji before
 * whitespace — never inside code or a marker. The cut is made after the
 * last clause, short of the final one, that holds a marker or states a
 * figure — what a marker or a number makes a claim of (design §2) — so
 * everything that carries one is read and the question after it is not.
 * Nothing else makes the clause before a question a claim: "Thanks, should
 * I send it now?" and "Okay — should I use the 2024 rates?" are questions.
 * A sentence that opens by acknowledging the reader or setting the question
 * up (`SETS_UP`: "Got it — 2 seats, correct?", "Just to confirm: 2 adults
 * and 1 child, departing June 3?", "Thanks for the 3 files, should I merge
 * them?") says the reader's request back before it asks; there a clause
 * with a figure is a claim only when it asserts something (`ASSERTS`: "Got
 * it — the invoice total is 1,284.60, right?"), and a marker still makes one.
 *
 * A sentence that opens as a question (`QUESTION_OPENERS`) is one all
 * through, figures and all: "Is it 30 days, or 14?", "Would you like a
 * refund of $45, or store credit?", "If you want the 12-month plan, should
 * I upgrade you?". One that opens with a fronted phrase ("For the 2024
 * rates, should I…?") is cut only after a clause of its own past that
 * phrase ("In 2024, revenue rose 12% [1], right?").
 */
function clauseParts(text: string, part: Piece, inCode: (offset: number) => boolean): Piece[] {
  const opener = openerOf(text, part.first, part.end);
  if (QUESTION_OPENERS.has(opener)) return [part];
  let firstWord = part.first;
  while (firstWord < part.end && !HAS_WORD.test(text[firstWord] as string)) firstWord++;
  let lastWord = part.end;
  while (lastWord > firstWord && !HAS_WORD.test(text[lastWord - 1] as string)) lastWord--;
  const clauses: Array<{ left: number; right: number }> = [];
  let k = 0;
  for (let i = firstWord + 1; i < lastWord; i++) {
    while (k < part.marks.length && (part.marks[k] as Mark).end <= i) k++;
    const mark = part.marks[k];
    if (mark !== undefined && i >= mark.at) {
      i = mark.end - 1;
      continue;
    }
    const c = text[i] as string;
    let right = -1;
    if ((c === "," || c === ";") && SPACE_CHAR.test(text[i + 1] ?? "")) right = i + 1;
    else if (c === ":" && /[\s\p{L}]/u.test(text[i + 1] ?? "")) right = i + 1;
    else if (c === "—" || c === "―" || c === "|") right = i + 1;
    else if ((c === "–" || c === "-") && /\s/.test(text[i - 1] as string)) {
      let j = i;
      while (j < lastWord && text[j] === c) j++;
      if (j - i <= 2 && SPACE_CHAR.test(text[j] ?? "")) right = j;
      else {
        i = j - 1;
        continue;
      }
    } else {
      const point = text.codePointAt(i) as number;
      const ch = String.fromCodePoint(point);
      if (PICTOGRAPH.test(ch)) {
        let j = i + ch.length;
        while (j < lastWord) {
          const tail = String.fromCodePoint(text.codePointAt(j) as number);
          if (!PICTOGRAPH_TAIL.test(tail)) break;
          j += tail.length;
        }
        if (SPACE_CHAR.test(text[j] ?? "")) right = j;
        else {
          i = j - 1;
          continue;
        }
      }
    }
    if (right === -1 || right > lastWord || inCode(i)) continue;
    clauses.push({ left: i, right });
    i = right - 1;
  }
  if (clauses.length === 0) return [part];
  const setsUp = SETS_UP.test(
    text.slice(firstWord, Math.min(lastWord, firstWord + OPENER_REACH)).replace(/’/g, "'"),
  );
  // Which clause, short of the last, holds a marker or states a figure — a
  // clause that asks, or says back what the reader wants, holding neither,
  // and a step's number ("Step 6 —") being no figure it states. Each is read
  // with the mark that ends it, so a list-counting "First," is no figure.
  let carrying = -1;
  let from = part.first;
  let mk = 0;
  for (let c = 0; c < clauses.length; c++) {
    const clause = clauses[c] as { left: number; right: number };
    let held = false;
    while (mk < part.marks.length && (part.marks[mk] as Mark).at < clause.left) {
      if ((part.marks[mk] as Mark).at >= from) held = true;
      mk++;
    }
    const opens = c === 0 ? opener : openerOf(text, from, clause.left);
    const asks = c > 0 && QUESTION_OPENERS.has(opens);
    if (!asks && !echoesReader(text, from, clause.left)) {
      const said = plainClaim(text.slice(from, clause.left));
      const figured =
        !LABEL_INDEX.test(said) &&
        statesFigure(plainClaim(text.slice(from, clause.right))) &&
        (!setsUp || ASSERTS.test(said.replace(/’/g, "'")));
      if (held || figured) carrying = c;
    }
    from = clause.right;
  }
  if (carrying === -1 || (carrying === 0 && FRONTED_OPENERS.has(opener))) return [part];
  const cut = clauses[carrying] as { left: number; right: number };
  const leftEnd = trimEnd(text, part.first, cut.left);
  let rightStart = cut.right;
  while (rightStart < part.end && /\s/.test(text[rightStart] as string)) rightStart++;
  const own = (first: number, to: number): Mark[] =>
    part.marks.filter((mark) => mark.at >= first && mark.at < to);
  return [
    { first: part.first, end: leftEnd, marks: own(part.first, leftEnd), excluded: false },
    { first: rightStart, end: part.end, marks: own(rightStart, part.end), excluded: false },
  ];
}

/** Does the piece say anything outside inline code and its markers? */
function hasProse(
  text: string,
  piece: Piece,
  raw: string,
  inCode: (offset: number) => boolean,
): boolean {
  if (!raw.includes("`")) return true;
  let prose = "";
  let m = 0;
  for (let i = piece.first; i < piece.end; i++) {
    const mark = piece.marks[m];
    if (mark !== undefined && i >= mark.at) {
      i = mark.end - 1;
      m++;
      continue;
    }
    if (!inCode(i)) prose += text[i];
  }
  return HAS_WORD.test(plainClaim(prose));
}

/**
 * Every declarative, non-question sentence of `text` that is a claim: one
 * that carries a citation marker, or states a number (a numeral, or a number
 * word other than "one": `statesFigure`), or has at least `minTokens`
 * content words. Outside fenced code, never a heading that is a title
 * (`headingClaim`), never a definition line (`[n]: …`, an assumption's
 * `[A1]: assume: …` included) or a list item that is only one — except a
 * definition-shaped line whose text nothing else reads (see the module
 * comment). Uncited claims are included with `markers: []` — the gate flags
 * them.
 *
 * A marker or a number makes a claim of any length because the word count is
 * there to skip "Done." and "Sure thing.", not "The total is 1,284.50." (two
 * content words) or "Revenue rose 12% [1]." — and a sentence the extractor
 * skips is a sentence the gate passes unread.
 */
export function extractClaims(text: string, options: ExtractClaimsOptions = {}): ExtractedClaim[] {
  // A malformed bar falls back to the default rather than letting every
  // uncited sentence through unread (NaN compares false with everything).
  const asked = options.minTokens ?? MIN_CLAIM_TOKENS;
  const minTokens = Number.isFinite(asked) ? asked : MIN_CLAIM_TOKENS;
  const blocks = readBlocks(text);
  const fences = blocks.fences;
  const code = indexSpans([...fences, ...inlineCodeSpans(text)]);
  const inCode = (offset: number): boolean => inSpan(offset, code);
  const bibliographic = options.bibliographic === true;
  // A definition line is left out where what it shows is read elsewhere or
  // is nothing: the entry `citationDefinitions` keeps for its id (the gate
  // reads its text as claims under it), or a line that shows nothing past
  // what it names. A second `[1]:` line, or a line only this reader calls
  // prose, that shows a sentence is read here like any other.
  const definitions = definitionEntries(text, inCode).filter(
    (d) => d.entry || definitionGloss(d.source, classifyDefinition(d.source), bibliographic) === "",
  );
  const zones = merge([...fences, ...definitions.map((d) => d.range)]);
  const lineAt = lineIndex(text);
  const lines = readLines(text, blocks);
  const isCitationId = citationIdTest(text);
  const marks: Mark[] = [];
  for (const { marker, at } of markersOutsideCode(text, inCode)) {
    marks.push({ marker, at, end: text.indexOf("]", at) + 1 });
  }

  // Sentence ranges with the zones cut out, in document order.
  const cut: Piece[] = [];
  let z = 0;
  const cuts = [...gluedCuts(text, marks, isCitationId), ...lines.blockEnds].sort((a, b) => a - b);
  // The splitter breaks lines at `\n` alone: in a CRLF document the full
  // stop before `\r` ends nothing and `\r\n\r\n` is no paragraph break, so
  // whole paragraphs would run together. It reads a copy with each break as
  // `\n`, kept the same length so its offsets are this text's.
  const unix = text.replace(/\r\n?/g, (crlf) => (crlf.length === 2 ? " \n" : "\n"));
  for (const { start, end } of withCuts(splitSentences(unix), cuts)) {
    let from = start;
    while (z < zones.length && (zones[z] as [number, number])[1] <= from) z++;
    let k = z;
    while (from < end) {
      const zone = zones[k];
      const stop = zone === undefined || zone[0] >= end ? end : Math.max(zone[0], from);
      addPiece(text, from, stop, cut);
      if (zone === undefined || zone[0] >= end) break;
      from = Math.min(Math.max(zone[1], from), end);
      k++;
    }
  }
  const pieces = joinListMarkers(text, cut, lines);
  markBlocks(text, pieces, lines, bibliographic);

  // Each marker to the piece it sits in; markers inside a zone belong to none.
  let p = 0;
  for (const mark of marks) {
    while (p < pieces.length && (pieces[p] as Piece).end <= mark.at) p++;
    const piece = pieces[p];
    if (piece === undefined || mark.at < piece.first) continue;
    piece.marks.push(mark);
  }

  // Markers that open a piece belong to the sentence before it, in the same
  // paragraph: in "Revenue rose 12%. [1] Costs fell." the splitter ends the
  // first sentence at its full stop, and [1] is that sentence's citation.
  const joined: Piece[] = [];
  for (const piece of pieces) {
    const prev = joined[joined.length - 1];
    if (prev !== undefined && !prev.excluded && !piece.excluded && piece.marks.length > 0) {
      let to = piece.first;
      let lead = 0;
      if (!HAS_WORD.test(plainClaim(text.slice(piece.first, piece.end)))) {
        // Nothing but brackets: "Revenue rose. [x][2]" says nothing after
        // its full stop, so every marker in it is the sentence before's,
        // whatever the labels are. Left here they would cite no claim.
        lead = piece.marks.length;
        to = (piece.marks[lead - 1] as Mark).end;
      } else {
        for (const mark of piece.marks) {
          // Spaces, then the marker — or the run of citation ids it ends,
          // "[1][2]" (`labelRunStart`). "[Stripe][2] charges 2.9%" is a link
          // opening the sentence, and its [2] stays with that sentence.
          if (!/^\s*$/.test(text.slice(to, labelRunStart(text, mark.at, isCitationId)))) break;
          to = mark.end;
          lead++;
        }
      }
      if (lead > 0 && SAME_PARAGRAPH.test(text.slice(prev.end, piece.first))) {
        for (let i = 0; i < lead; i++) prev.marks.push(piece.marks[i] as Mark);
        prev.end = to;
        piece.marks = piece.marks.slice(lead);
        piece.first = to;
        while (piece.first < piece.end && /\s/.test(text[piece.first] as string)) piece.first++;
        if (piece.first >= piece.end) continue;
      }
    }
    joined.push(piece);
  }

  const claims: ExtractedClaim[] = [];
  const push = (piece: Piece, plain: string, raw: string): void => {
    claims.push({
      index: claims.length,
      text: plain,
      raw,
      line: lineAt(piece.first),
      markers: [...new Set(piece.marks.map((m) => m.marker))],
    });
  };
  // Headings that would be claims as sentences, for an answer that has no
  // other claim (`headingClaim`): read when it asks nothing, and when its
  // only questions are sentences of its body, read where they are sentences
  // ("## Refunds are accepted for unused items" over "Anything else?").
  const titles: Array<{ piece: Piece; plain: string; raw: string; declarative: boolean }> = [];
  let asks = false;
  let headingAsks = false;
  for (let w = 0; w < joined.length; w++) {
    let whole = joined[w] as Piece;
    if (whole.heading === true) {
      const raw = text.slice(whole.first, whole.end);
      const plain = plainClaim(raw);
      if (!HAS_WORD.test(plain)) continue;
      if (isQuestion(plain)) {
        asks = true;
        headingAsks = true;
        continue;
      }
      const cited = whole.marks.length > 0;
      const figured = statesFigure(plain);
      if (!cited && !figured && !hasProse(text, whole, raw, inCode)) continue;
      if (headingClaim(plain, cited, figured, minTokens)) push(whole, plain, raw);
      else if (cited || figured || contentWords(plain) >= minTokens) {
        // A list's or a schedule's label ("Day 1: 3 hikes", "Monday: 5k
        // run") orders the answer; it states nothing.
        const colon = plain.indexOf(": ");
        if (colon >= 1 && ordersList(plain.slice(0, colon))) continue;
        titles.push({ piece: whole, plain, raw, declarative: declares(withoutListLabel(plain)) });
      }
      continue;
    }
    if (whole.excluded) continue;
    // A question is left out by the sentence, not by the piece: the claim
    // run into one ahead of it is still read (`questionParts`).
    let asked = isQuestion(plainClaim(text.slice(whole.first, whole.end)));
    // A question the answer answers itself is a claim: "Is the refund window
    // 30 days? Yes." asserts the 30 days as surely as the sentence would.
    const after = joined[w + 1];
    if (
      asked &&
      after !== undefined &&
      !after.excluded &&
      SAME_PARAGRAPH.test(text.slice(whole.end, after.first)) &&
      BARE_ANSWER.test(plainClaim(text.slice(after.first, after.end)))
    ) {
      whole = {
        first: whole.first,
        end: after.end,
        marks: [...whole.marks, ...after.marks],
        excluded: false,
      };
      asked = false;
      w++;
    }
    for (const piece of asked ? questionParts(text, whole, inCode) : [whole]) {
      const raw = text.slice(piece.first, piece.end);
      // A bullet "[1]: …" whose source is prose reads as ": …" once the id
      // is out; the colon is not part of the claim.
      const plain = plainClaim(raw).replace(/^:\s*/, "");
      if (!HAS_WORD.test(plain)) continue;
      if (isQuestion(plain)) {
        asks = true;
        continue;
      }
      const cited = piece.marks.length > 0;
      const figured = statesFigure(plain);
      // Nothing but inline code is a literal — unless it cites or states a
      // figure, which is what makes any sentence a claim: "`max_retries =
      // 30` [1]." asserts the 30 its source is cited for.
      if (!cited && !figured && !hasProse(text, piece, raw, inCode)) continue;
      if (!cited && !figured && contentWords(plain) < minTokens) continue;
      push(piece, plain, raw);
    }
  }
  if (claims.length === 0 && !headingAsks) {
    for (const { piece, plain, raw, declarative } of titles) {
      if (!asks || declarative) push(piece, plain, raw);
    }
  }
  return claims;
}
