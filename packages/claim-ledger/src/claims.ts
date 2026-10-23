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
 *   line, or after a bullet, is text.
 * - `line` is the line the claim's first character is on. A sentence that
 *   begins on a new line starts, in the splitter's ranges, at the newline
 *   before it.
 * - A question is a sentence, not a piece. The splitter breaks at a single
 *   line break only after a full stop, and at a full stop only before space,
 *   so "The refund window is 30 days [1]\nAnything else?" and "…30
 *   days.Anything else?" are one piece ending in `?` — and dropping it whole
 *   dropped the claim, so the gate passed the answer vacuously (design §0,
 *   tests A and B). Here only the question at the end is left out
 *   (`questionParts`).
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
 * Headings and reference-list items marked excluded, and a setext underline
 * under a list item or a quote cut off: there `---` is a thematic break and
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
      if (lines.contained[lines.at(piece.first + underline.index)] === 1) {
        piece.end = trimEnd(text, piece.first, piece.first + underline.index);
      } else piece.excluded = true;
    }
    if (lines.heading[lineOfFirst] === 1) piece.excluded = true;
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

/** What may open a line before its first letter: emphasis, a quote, code, a bracket. */
const LINE_OPENER = /[ \t*_~>`"'([]/;
/** What may close after a terminator before the letter glued to it. */
const CLOSERS = `"')]`;
/** An initialism, "U.S." or "J.": its full stops end no sentence. */
const INITIALISM = /^(?:[\p{L}]\.)+$/u;
/** No abbreviation is longer than this, so a glued word is read back no further. */
const MAX_ABBREVIATION = 16;
/**
 * What a dotted name goes on with after its `.`: a letter (`Text.Json`,
 * `acme.example`). A digit does not, so "1,284.50.Is it right?" still ends.
 */
const NAME_CHAR = /[\p{L}_]/u;

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

/** Does the line starting at `at` open (after its Markdown) with a lowercase letter? */
function opensLowercase(text: string, at: number, end: number): boolean {
  let i = at;
  while (i < end && LINE_OPENER.test(text[i] as string)) i++;
  return i < end && /\p{Ll}/u.test(text[i] as string);
}

/**
 * A piece whose text ends in `?`, cut where a sentence inside it ends that
 * the splitter ran on, so that only the question it ends with is left out
 * (design §2: a claim is a declarative, non-question sentence; §0: tests A
 * and B are un-servable even when the model misbehaves). Read from the end:
 * the question is the last sentence, and what comes before it is one piece,
 * as it would be with no question after it — a table above "Want the annual
 * prices too?" stays one claim, its marker with it.
 *
 * A sentence ends inside the piece at:
 *
 * - a terminator glued to a capital, "30 days.Anything else?" or "France
 *   [1].Right?" — not after an abbreviation or an initialism ("U.S.Army"),
 *   not in code, and not inside a dotted name or a URL path: not where the
 *   token before the terminator already holds a `/` or a name-joining `.`
 *   ("System.Text.Json", "…/Docs/Guide.Html"), nor where the word after it
 *   goes on as an identifier, with another such `.` or a capital inside it
 *   ("Console.WriteLine"). `acme.example`, `Node.js` and `1.2` glue no
 *   capital; "1,284.50.Is it right?" still ends, its `.` joining digits;
 * - a line break, unless the line after it opens with a lowercase letter
 *   and the text before it, back to the last place a sentence could end,
 *   carries no marker and states no figure. That is one question wrapped
 *   ("Should I send the corrected invoice to the billing contact\nbefore
 *   Friday?"); with a marker or a figure before the break it is read as a
 *   claim, the direction every difference here leans. A wrapped question
 *   whose wrapped line opens with a capital, or whose first line states a
 *   figure, is therefore read as a claim too: at a `cited` floor that asks
 *   for a citation the question did not need, where the other way it served
 *   a figure unread.
 *
 * After a cut, the text before it is read again when it too ends in `?`
 * ("Is it 30?Anything else?"). A sentence that is itself a question —
 * "…30 days [1], right?" on one line — is still one; design §2 excludes it.
 */
function questionParts(text: string, piece: Piece, inCode: (offset: number) => boolean): Piece[] {
  // Where a sentence may end inside the piece, left to right: the left part
  // ends at `left`, the right part starts at `right`.
  const cuts: Array<{ left: number; right: number; glued: boolean; question: boolean }> = [];
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
    if (c === "\n" || c === "\r") {
      const right = c === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
      cuts.push({ left: i, right, glued: false, question: false });
      i = right - 1;
      continue;
    }
    if (c !== "." && c !== "!" && c !== "?") continue;
    let j = i + 1;
    while (j < piece.end && /[.!?]/.test(text[j] as string)) j++;
    const run = text.slice(i, j);
    while (j < piece.end && CLOSERS.includes(text[j] as string)) j++;
    // Emphasis may open the next sentence: "30 days.**Want more?**".
    let letter = j;
    while (letter < piece.end && "*_~".includes(text[letter] as string)) letter++;
    if (letter < piece.end && /\p{Lu}/u.test(text[letter] as string) && !inCode(i)) {
      let from = i;
      while (
        from > piece.first &&
        i - from < MAX_ABBREVIATION &&
        !/\s/.test(text[from - 1] as string)
      ) {
        from--;
      }
      const word = text.slice(from, i + 1).toLowerCase();
      if (
        !ABBREVIATIONS.has(word) &&
        !INITIALISM.test(word) &&
        !dottedBefore(i) &&
        !continuesName(text, letter, piece.end)
      ) {
        cuts.push({ left: j, right: j, glued: true, question: run.includes("?") });
      }
    }
    i = j - 1;
  }
  if (cuts.length === 0) return [piece];

  // Each cut is read once, and the markers with a pointer that only moves
  // left, so a long piece of many lines costs its length.
  const spans: Array<{ first: number; end: number }> = [];
  const marks = piece.marks;
  let m = marks.length;
  let end = piece.end;
  for (let k = cuts.length - 1; k >= 0; k--) {
    const cut = cuts[k] as (typeof cuts)[number];
    const from = k > 0 ? (cuts[k - 1] as (typeof cuts)[number]).right : piece.first;
    while (m > 0 && (marks[m - 1] as Mark).at >= cut.left) m--;
    const marked = m > 0 && (marks[m - 1] as Mark).at >= from;
    const before = cut.glued ? "" : plainClaim(text.slice(from, cut.left));
    const ends =
      cut.glued || marked || !opensLowercase(text, cut.right, end) || statesFigure(before);
    if (!ends) continue;
    let first = cut.right;
    while (first < end && /\s/.test(text[first] as string)) first++;
    if (first < end) spans.push({ first, end });
    end = trimEnd(text, piece.first, cut.left);
    if (!(cut.glued ? cut.question : isQuestion(before))) break;
  }
  if (end > piece.first) spans.push({ first: piece.first, end });
  spans.reverse();
  const parts: Piece[] = [];
  let next = 0;
  for (const { first, end: to } of spans) {
    while (next < marks.length && (marks[next] as Mark).at < first) next++;
    const own: Mark[] = [];
    while (next < marks.length && (marks[next] as Mark).at < to) own.push(marks[next++] as Mark);
    parts.push({ first, end: to, marks: own, excluded: false });
  }
  return parts;
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
 * content words. Outside fenced code, never a heading, never a
 * definition line (`[n]: …`, an assumption's `[A1]: assume: …` included) or
 * a list item that is only one — except a definition-shaped line whose text
 * nothing else reads (see the module comment). Uncited claims are included
 * with `markers: []` — the gate flags them.
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
  for (const whole of joined) {
    if (whole.excluded) continue;
    // A question is left out by the sentence, not by the piece: the claim
    // run into one ahead of it is still read (`questionParts`).
    const asked = isQuestion(plainClaim(text.slice(whole.first, whole.end)));
    for (const piece of asked ? questionParts(text, whole, inCode) : [whole]) {
      const raw = text.slice(piece.first, piece.end);
      // A bullet "[1]: …" whose source is prose reads as ": …" once the id
      // is out; the colon is not part of the claim.
      const plain = plainClaim(raw).replace(/^:\s*/, "");
      if (!HAS_WORD.test(plain) || isQuestion(plain)) continue;
      const cited = piece.marks.length > 0;
      const figured = statesFigure(plain);
      // Nothing but inline code is a literal — unless it cites or states a
      // figure, which is what makes any sentence a claim: "`max_retries =
      // 30` [1]." asserts the 30 its source is cited for.
      if (!cited && !figured && !hasProse(text, piece, raw, inCode)) continue;
      if (!cited && !figured && contentWords(plain) < minTokens) continue;
      claims.push({
        index: claims.length,
        text: plain,
        raw,
        line: lineAt(piece.first),
        markers: [...new Set(piece.marks.map((m) => m.marker))],
      });
    }
  }
  return claims;
}
