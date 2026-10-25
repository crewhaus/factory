/**
 * The vacuous-pass backstop (design §2, §0 A and B).
 *
 * An answer with no claims passes every floor with nothing to prove — the
 * right verdict for a greeting, a clarifying question or a code block, and
 * the wrong one for an answer whose claim the extractor failed to see.
 * Review rounds one and two each found new shapes that merged a claim into
 * a question or a heading — "30 days [1] — anything else?", "1,284.60; want
 * the PDF?", a no-break space, a `<br>`, U+2028, a table row, a heading over
 * a question — and claim-ledger's `extractClaims` saw none of them, so the
 * gate served scenario A or B with a ✓. Each was fixed shape by shape, and
 * each fix left the next shape open. So the verdict does not rest on the
 * extractor alone: an answer may be vacuous only when what a reader sees
 * of it, code and definition lines aside, carries
 *
 * - no citation marker at all, and
 * - no figure outside a question,
 *
 * read by a segmenter far blunter than the extractor, which cuts at every
 * line break (U+0085, U+2028, U+2029, `\f`, `\v` and `<br>` included),
 * every sentence terminator whether a space follows it or not, every
 * semicolon, em or en dash and table pipe — never at a comma. A heading
 * is a title to the figure rule but for what it states after a label
 * (claim-ledger's `headingClaim` reads the headings that state one); a
 * marker in it still counts. Otherwise
 * each segment that carries a marker, and each that states a figure and is
 * no question, is a claim, verified like any other: "30 days" cut off a
 * trailing "anything else?" is checked against the page, and fails where
 * the page says 14.
 *
 * A question stays a question. A piece of text that ends in `?` is a
 * question from the first segment in it that opens as one ("Which of the 4
 * plans do you mean — Basic or Pro?", "Should I book 2 rooms\nfor Monday?")
 * or ends as one; what comes before that segment is said, not asked ("The
 * refund window is 30 days — anything else?"). A clarifying question with a
 * figure in it ("Do you want 2 or 3 copies?"), a greeting, and an answer
 * that is only code stay vacuous.
 */
import {
  type ExtractedClaim,
  citationMarkers,
  codeSpans,
  extractNumbers,
  isAssumptionMarker,
  lineIndex,
  plainClaim,
} from "@crewhaus/claim-ledger";

/** A definition line (`[1]: …`, `[^a]: …`), up to three spaces in. */
const DEFINITION_LINE = /^[ \t]{0,3}\[\^?[^\]\s]+\]:[^\n]*/gm;
/** A URL: its dots and slashes are not sentence ends. */
const URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
/** An HTML line break. */
const BREAK_TAG = /<br\s*\/?>/gi;
/**
 * A list item's marker at the start of a line — `1.`, `2)`, `-`, `*`, `+`,
 * a bold `**1.**` — inside block quotes too: a reader sees an item's number,
 * not a figure the answer states ("1. Open Settings").
 */
const LIST_MARKER =
  /^([ \t]*(?:>[ \t]?)*[ \t]*)((?:\*\*|__)?(?:\d{1,9}[.)]|[-*+])(?:\*\*|__)?)(?=[ \t])/gm;
/** Every character that breaks a line. */
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/;
/** What may close a sentence after its terminator: quotes, brackets, emphasis. */
const CLOSERS = /["'”’»)\]*_~`]/;

/**
 * Words a question opens with — the interrogatives, the auxiliaries an
 * inverted question starts on, and the openers of an elliptical one ("Want
 * the PDF?", "Any of these work?"). A conjunction is not one: "And the
 * window is 30 days; want details?" says something before it asks.
 */
const QUESTION_OPENERS: ReadonlySet<string> = new Set([
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "whether",
  "do",
  "does",
  "did",
  "don't",
  "doesn't",
  "didn't",
  "is",
  "isn't",
  "are",
  "aren't",
  "was",
  "wasn't",
  "were",
  "weren't",
  "am",
  "can",
  "can't",
  "could",
  "couldn't",
  "will",
  "won't",
  "would",
  "wouldn't",
  "shall",
  "should",
  "shouldn't",
  "may",
  "might",
  "must",
  "have",
  "haven't",
  "has",
  "hasn't",
  "had",
  "want",
  "wanna",
  "need",
  "any",
  "anything",
  "anyone",
  "anybody",
  "else",
  "ok",
  "okay",
  "please",
]);

/** A stretch of the answer: `[from, to)` in its offsets. */
type Span = readonly [number, number];

/** A sentence terminator. */
const TERMINATOR = /[.!?…]/;
/** What may open the segment glued to a terminator: a quote, a bracket, emphasis. */
const OPENERS = /["'“‘(\[*_]/;

/**
 * The answer as the segmenter reads it, offsets kept (one character per
 * UTF-16 unit): code (fenced and inline), definition lines, URLs and list
 * item markers blanked, `<br>` turned into a line break.
 */
function visibleText(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  for (const [from, to] of codeSpans(text)) blank(from, to);
  for (const m of text.matchAll(DEFINITION_LINE)) {
    if (m.index !== undefined) blank(m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(URL_TEXT)) {
    if (m.index !== undefined) blank(m.index, m.index + m[0].length);
  }
  for (const m of text.matchAll(LIST_MARKER)) {
    if (m.index === undefined) continue;
    const from = m.index + (m[1] as string).length;
    blank(from, from + (m[2] as string).length);
  }
  for (const m of text.matchAll(BREAK_TAG)) {
    if (m.index === undefined) continue;
    blank(m.index, m.index + m[0].length);
    out[m.index] = "\n";
  }
  return out.join("");
}

const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/u.test(c);
const isLetter = (c: string | undefined): boolean => c !== undefined && /\p{L}/u.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && /\p{N}/u.test(c);
const isBreak = (c: string | undefined): boolean => c !== undefined && LINE_BREAK.test(c);

/** Where the closers after a terminator that ends at `at` end. */
function pastClose(text: string, at: number): number {
  let i = at;
  while (i < text.length && CLOSERS.test(text[i] as string)) i++;
  return i;
}

/**
 * Past the markers that follow a sentence end on its line (`[1]` after
 * "rose 12%." is that sentence's), by where each marker the citation
 * grammar reads (`citationMarkers`) ends, keyed by where it starts.
 */
function pastMarkers(text: string, at: number, markers: ReadonlyMap<number, number>): number {
  let i = at;
  for (;;) {
    let j = i;
    while (j < text.length && isSpace(text[j]) && !isBreak(text[j])) j++;
    const end = markers.get(j);
    if (end === undefined) return i;
    i = end;
  }
}

/**
 * Is the `.` at `at` glued to a word that starts a new segment —
 * "days.Anything", "1,284.50.want" — rather than inside a name ("Node.js",
 * "e.g.", "policy.md")? A capital starts one; so does a lowercase word of
 * four letters or more. A decimal point never does.
 */
function gluedFullStop(text: string, at: number): boolean {
  if (isDigit(text[at - 1]) && isDigit(text[at + 1])) return false;
  if (!isLetter(text[at + 1])) return false;
  let end = at + 1;
  while (end < text.length && isLetter(text[end])) end++;
  const word = text.slice(at + 1, end);
  return /^\p{Lu}/u.test(word) || word.length >= 4;
}

/**
 * The answer cut into pieces — at a terminator a space or a line break
 * follows, and at a blank line — and each piece into segments: at every
 * other line break, at a terminator glued to the next word, and at every
 * semicolon, em dash, en dash (not one between figures, a range) and pipe.
 * Over {@link visibleText}.
 */
function segments(text: string): Array<{ readonly piece: Span; readonly parts: Span[] }> {
  const out: Array<{ piece: Span; parts: Span[] }> = [];
  const markers = new Map(citationMarkers(text).map((m) => [m.at, m.end] as const));
  let pieceStart = 0;
  let partStart = 0;
  let parts: Span[] = [];
  const cutPart = (end: number, next: number): void => {
    parts.push([partStart, end]);
    partStart = next;
  };
  const cutPiece = (end: number, next: number): void => {
    cutPart(end, next);
    out.push({ piece: [pieceStart, end], parts });
    parts = [];
    pieceStart = next;
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (TERMINATOR.test(c)) {
      let end = i + 1;
      while (end < text.length && TERMINATOR.test(text[end] as string)) end++;
      const closed = pastClose(text, end);
      if (closed >= text.length || isSpace(text[closed])) {
        const after = pastMarkers(text, closed, markers);
        cutPiece(after, after);
        i = after;
        continue;
      }
      const next = text[closed];
      const glued =
        c === "." && end === i + 1
          ? gluedFullStop(text, i)
          : isLetter(next) || isDigit(next) || OPENERS.test(next as string);
      if (glued) cutPart(closed, closed);
      i = glued ? closed : end;
      continue;
    }
    if (isBreak(c)) {
      let j = c === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1;
      while (j < text.length && /[ \t]/.test(text[j] as string)) j++;
      if (j >= text.length || isBreak(text[j])) {
        // A blank line: the piece ends.
        let next = j;
        while (next < text.length && isSpace(text[next])) next++;
        cutPiece(i, next);
        i = next;
      } else {
        cutPart(i, i + 1);
        i += 1;
      }
      continue;
    }
    const range = c === "–" && isDigit(text[i - 1]) && isDigit(text[i + 1]);
    if (c === ";" || c === "|" || c === "—" || (c === "–" && !range)) cutPart(i, i + 1);
    i += 1;
  }
  if (pieceStart < text.length) cutPiece(text.length, text.length);
  return out;
}

/** An ATX heading line, and a setext underline. */
const ATX_HEADING = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const SETEXT_UNDERLINE = /^[ \t]{0,3}(?:=+|-{2,})[ \t]*$/;
/** A line a list item or a block quote opens: its `---` is a break, not an underline. */
const BLOCK_OPENER = /^[ \t]*(?:[-*+>]|\d{1,9}[.)])[ \t]/;

/**
 * The heading lines of `text`, as `[from, to)` spans: a line `#` opens, and
 * the paragraph line a setext underline (`===`, `---`) sits under.
 */
function headingLines(text: string): Span[] {
  const out: Span[] = [];
  let previous: Span | undefined;
  let at = 0;
  for (const line of text.split("\n")) {
    const span: Span = [at, at + line.length];
    if (ATX_HEADING.test(line)) out.push(span);
    else if (
      SETEXT_UNDERLINE.test(line) &&
      previous !== undefined &&
      text.slice(...previous).trim() !== "" &&
      !BLOCK_OPENER.test(text.slice(...previous)) &&
      !SETEXT_UNDERLINE.test(text.slice(...previous))
    ) {
      out.push(previous);
    }
    previous = span;
    at += line.length + 1;
  }
  return out;
}

/** What a heading states after a label ("Invoice total: 1,284.50"), or nothing. */
function labelled(heading: string): string {
  const colon = heading.indexOf(":");
  return colon === -1 ? "" : heading.slice(colon + 1);
}

/** `text[from, to)` with its edges trimmed, as a span. */
function trimmed(text: string, [from, to]: Span): Span {
  let a = from;
  let b = to;
  while (a < b && isSpace(text[a])) a++;
  while (b > a && isSpace(text[b - 1])) b--;
  return [a, b];
}

/** Does `text` end as a question once its closers and the markers after it are set aside? */
function endsAsQuestion(text: string): boolean {
  const ends = new Map(citationMarkers(text).map((m) => [m.end, m.at] as const));
  let end = text.length;
  while (end > 0) {
    const mark = ends.get(end);
    if (mark !== undefined) end = mark;
    else if (isSpace(text[end - 1]) || CLOSERS.test(text[end - 1] as string)) end -= 1;
    else break;
  }
  return text[end - 1] === "?";
}

/** Does `text` open as a question: its first word, past bullets, figures and marks, an opener? */
function opensAsQuestion(text: string): boolean {
  const word = /[\p{L}][\p{L}'’]*/u.exec(text)?.[0];
  return word !== undefined && QUESTION_OPENERS.has(word.toLowerCase().replace(/’/g, "'"));
}

/**
 * Claims the backstop reads in an answer the extractor found nothing to
 * count in (see the module doc), numbered from `firstIndex`. Each is the
 * segment as written (`raw`, markers in it), read as `plainClaim` reads a
 * sentence, citing the markers it carries — a marker the document defines,
 * a numeral, a footnote or an assumption id; a segment that is only
 * markers gives them to the segment before it. A segment the extractor
 * already returned (an assumption it read) is not read twice. Empty when
 * the answer may be vacuous.
 */
export function backstopClaims(
  text: string,
  definitions: ReadonlyMap<string, string>,
  extracted: ReadonlyArray<ExtractedClaim>,
  firstIndex: number,
): ExtractedClaim[] {
  const visible = visibleText(text);
  const lineOf = lineIndex(text);
  // A heading is a title to the figure rule — "## Refund options for 2024"
  // over "Which option do you want?" has nothing to prove; claim-ledger's
  // `headingClaim` decides which heading states one. What one states after
  // a label ("## Invoice total: 1,284.50") is read, and a marker in one
  // still makes it a claim.
  const headings = headingLines(visible);
  const inHeading = ([from]: Span): boolean => headings.some(([a, b]) => from >= a && from < b);
  const known = extracted.map((claim) => claim.text.replace(/\s+/g, " ").trim().toLowerCase());
  const citing = (id: string, caret: boolean): boolean =>
    definitions.has(id) || caret || /^\d+$/.test(id) || isAssumptionMarker(id);
  type Part = { span: Span; markers: string[]; figure: boolean; question: boolean };
  const out: ExtractedClaim[] = [];
  for (const { piece, parts: spans } of segments(visible)) {
    const pieceText = visible.slice(...trimmed(visible, piece));
    const asked = endsAsQuestion(pieceText);
    const parts: Part[] = [];
    // In a piece that ends as a question: asked from the segment that
    // opens one to the segment that ends one; said before it.
    let questioning = false;
    for (const raw of spans) {
      const span = trimmed(visible, raw);
      const shown = visible.slice(...span);
      if (shown === "") continue;
      const markers: string[] = [];
      for (const m of citationMarkers(shown)) {
        if (citing(m.marker, m.caret) && !markers.includes(m.marker)) markers.push(m.marker);
      }
      const words = plainClaim(shown);
      if (words === "" && markers.length > 0 && parts.length > 0) {
        // Markers on their own: the segment before them is what they cite.
        const before = parts[parts.length - 1] as Part;
        for (const marker of markers)
          if (!before.markers.includes(marker)) before.markers.push(marker);
        before.span = [before.span[0], span[1]];
        continue;
      }
      const ends = endsAsQuestion(shown);
      if (asked && opensAsQuestion(words)) questioning = true;
      parts.push({
        span,
        markers,
        figure: extractNumbers(inHeading(span) ? labelled(words) : words).length > 0,
        question: questioning || ends,
      });
      if (ends) questioning = false;
    }
    for (const part of parts) {
      if (part.markers.length === 0 && (!part.figure || part.question)) continue;
      const raw = text.slice(...part.span).trim();
      const claimText = plainClaim(raw);
      if (claimText === "") continue;
      const folded = claimText.replace(/\s+/g, " ").trim().toLowerCase();
      if (known.some((seen) => seen.includes(folded) || folded.includes(seen))) continue;
      out.push({
        index: firstIndex + out.length,
        text: claimText,
        raw,
        line: lineOf(part.span[0]),
        markers: part.markers,
      });
    }
  }
  return out;
}
