/**
 * The Markdown a claim reader has to see past: code, link destinations and
 * the bookkeeping that turns an offset into a line.
 *
 * Moved here from `tool-verify/src/lib/markdown.ts` (design §4.1) because the
 * citation grammar and the claim extractor both stand on it, and both now
 * live in this package. The link checker in tool-verify still reads links
 * through `inlineLinks` and `splitLinkTarget` below, so a destination means
 * the same thing to the tool that checks it and to the gate that cites it.
 *
 * Every scan here is linear in the document. These run synchronously on
 * workspace Markdown anyone can put in a checkout, and 0.7.0's were not: the
 * sentence splitter, the line lookup and the code-span test each rescanned
 * from the start per hit. A pattern here either cannot scan past the next
 * place it could start again, or starts only once per run.
 */

/** Fenced code blocks and inline code spans, whose contents are not prose. */
export function codeSpans(text: string): Array<[number, number]> {
  return [...fencedSpans(text), ...inlineCodeSpans(text)];
}

/** Inline code spans, `` `like this` ``, on one line. */
export function inlineCodeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const inline of text.matchAll(/`[^`\n]+`/g)) {
    if (inline.index !== undefined) spans.push([inline.index, inline.index + inline[0].length]);
  }
  return spans;
}

/**
 * Fenced code blocks alone, fence lines included, as the citation grammar
 * has always read them: a fence line is any line that starts at column 0
 * with ` ``` ` or `~~~`, and the next one closes it.
 *
 * CitationLint, FactCrossCheck and `citedClaims` read code through this, and
 * their output must not move (design §15), so it stays as loose as it was.
 * The claim extractor reads `commonMarkFences` instead.
 */
export function fencedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const fence = /^(```|~~~)[^\n]*$/gm;
  let open: number | null = null;
  let m: RegExpExecArray | null = fence.exec(text);
  while (m !== null) {
    if (open === null) open = m.index;
    else {
      spans.push([open, m.index + m[0].length]);
      open = null;
    }
    m = fence.exec(text);
  }
  // An unclosed fence runs to the end, which is what a renderer does too.
  if (open !== null) spans.push([open, text.length]);
  return spans;
}

/**
 * Fenced code blocks as CommonMark reads them, for the claim extractor.
 *
 * `fencedSpans` treats anything that looks like a fence at column 0 as one,
 * and anything after an unclosed one as code. For a linter that only hides
 * markers that is a small error; for the gate it is a claim passed unread,
 * because everything the reader calls code is cut out of the claims. So this
 * one is at least as strict as a renderer about what is code:
 *
 * - a fence opens with three or more backticks or tildes, indented by at
 *   most three spaces, and a backtick fence's info string has no backtick
 *   (` ```x` ` is inline code, not a fence);
 * - it closes only on a line of the same character, at least as long, with
 *   nothing after it but spaces, indented by at most three spaces;
 * - inside a list item all of that is counted from the item's content, not
 *   from column 0: `- ```js` opens a fence and `  ```` under it closes it,
 *   and a fence the item leaves open ends where the item does — at the first
 *   line indented less than the item's content (code has no lazy lines).
 *   Read from column 0 instead, the bullet hides the opener and the indented
 *   closer opens a fence of its own that swallows the rest of the answer;
 * - lines break at `\n`, `\r\n` and `\r` only — never at U+2028 or U+2029,
 *   which a renderer shows as text and a `^` under the `m` flag would read as
 *   a line start.
 *
 * An unclosed fence still runs to the end of its container, as a renderer's
 * does. One pass over the text (`readBlocks`).
 */
export function commonMarkFences(text: string): Array<[number, number]> {
  return [...readBlocks(text).fences];
}

/**
 * A document's lines and the block structure a claim reader needs from them,
 * read once: where fenced code is, which lines open or sit in a list item,
 * which are headings. The claim extractor's one reading of containers, so
 * the code it cuts out and the headings and list items it recognizes come
 * from the same idea of where a list item ends.
 *
 * Only as much of CommonMark as those answers need. List items nest by
 * their content column; a line belongs to every open item it is indented
 * into, and a line of paragraph text that opens no block of its own
 * continues the paragraph above it wherever that is (a lazy line). Block
 * quotes are not containers here: a fence or a heading after `>` is read as
 * text, which errs toward reading a claim, never toward hiding one.
 */
export type BlockLines = {
  /** Offset each line starts at. Lines break at `\n`, `\r\n` and `\r`. */
  readonly starts: ReadonlyArray<number>;
  /** Fenced code blocks, fence lines included, in document order. */
  readonly fences: ReadonlyArray<[number, number]>;
  /** 1 where the line is inside a fenced block (its fence lines included). */
  readonly code: Uint8Array;
  /** 1 where the line opens a list item. */
  readonly item: Uint8Array;
  /** 1 where the line is non-blank and sits in a list item, its marker line included. */
  readonly contained: Uint8Array;
  /** 1 where the line is an ATX heading: `#` first, after at most three
   *  spaces of indent counted from the list item it sits in. A `#` after a
   *  bullet on the same line is not counted. */
  readonly heading: Uint8Array;
};

/** A fence still waiting for its closing line. */
type OpenFence = {
  readonly start: number;
  readonly char: string;
  readonly length: number;
  /** The content column of the list item it opened in (0 outside one). */
  readonly indent: number;
};

/**
 * Read a document's block structure, one pass over it (`BlockLines`). What
 * it leaves out of CommonMark — block quotes as containers, HTML blocks,
 * setext headings, which `extractClaims` reads from the lines itself — is
 * read as paragraph text. Not exported from the package.
 */
export function readBlocks(text: string): BlockLines {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) starts.push(i + 1);
  }
  const count = starts.length;
  const code = new Uint8Array(count);
  const item = new Uint8Array(count);
  const contained = new Uint8Array(count);
  const heading = new Uint8Array(count);
  const fences: Array<[number, number]> = [];
  // The content columns of the open list items, innermost last; increasing.
  const items: number[] = [];
  let open: OpenFence | null = null;
  let paragraph = false;
  let previousEnd = 0;
  // How many items were open before an item whose marker line was empty, on
  // the line just read; -1 when that line opened none. An item may begin with
  // one blank line only: a blank line under an empty marker ends the item.
  let emptyFrom = -1;
  for (let k = 0; k < count; k++) {
    const at = starts[k] as number;
    const lineEnd = lineEndAt(text, at, k + 1 < count ? (starts[k + 1] as number) : text.length);
    const { column, offset } = indentFrom(text, at, lineEnd, 0);
    const blank = offset === lineEnd;
    if (open !== null && !blank && column < open.indent) {
      // The list item holding the fence ended, and the fence with it.
      fences.push([open.start, previousEnd]);
      open = null;
    }
    previousEnd = lineEnd;
    if (open !== null) {
      code[k] = 1;
      contained[k] = !blank && items.length > 0 ? 1 : 0;
      if (!blank && column - open.indent <= 3) {
        const run = fenceRunAt(text, offset, lineEnd);
        if (
          run !== null &&
          run.char === open.char &&
          run.length >= open.length &&
          /^[ \t]*$/.test(text.slice(run.end, lineEnd))
        ) {
          fences.push([open.start, lineEnd]);
          open = null;
        }
      }
      continue;
    }
    if (blank) {
      if (emptyFrom >= 0) items.length = emptyFrom;
      emptyFrom = -1;
      paragraph = false;
      continue;
    }
    emptyFrom = -1;
    if (paragraph && !opensBlock(text, offset, column, lineEnd, items)) {
      // Paragraph text going on, in whatever items the paragraph is in.
      contained[k] = items.length > 0 ? 1 : 0;
      continue;
    }
    while (items.length > 0 && column < (items[items.length - 1] as number)) items.pop();
    let container = items.length > 0 ? (items[items.length - 1] as number) : 0;
    const thematic = thematicFrom(text, offset, lineEnd);
    let from = offset;
    let col = column;
    let opened = false;
    let indentedCode = false;
    for (;;) {
      if (col - container > 3) {
        indentedCode = true;
        break;
      }
      const marker = listMarkerAt(text, from, col, lineEnd, thematic);
      if (marker === null) break;
      if (marker.empty) emptyFrom = items.length;
      items.push(marker.contentColumn);
      opened = true;
      container = marker.contentColumn;
      from = marker.contentOffset;
      col = marker.contentColumn;
      if (from >= lineEnd) break;
    }
    item[k] = opened ? 1 : 0;
    contained[k] = items.length > 0 ? 1 : 0;
    if (indentedCode || from >= lineEnd) {
      paragraph = false;
      continue;
    }
    const run = fenceRunAt(text, from, lineEnd);
    if (run !== null && (run.char === "~" || !text.slice(run.end, lineEnd).includes("`"))) {
      code[k] = 1;
      open = { start: at, char: run.char, length: run.length, indent: container };
      paragraph = false;
      continue;
    }
    if (isAtxHeading(text, from, lineEnd)) {
      if (!opened) heading[k] = 1;
      paragraph = false;
      continue;
    }
    paragraph = !thematic(from);
  }
  if (open !== null) fences.push([open.start, text.length]);
  return { starts, fences, code, item, contained, heading };
}

/** Where the line starting at `at` ends, its line break left out. */
function lineEndAt(text: string, at: number, next: number): number {
  let end = next;
  while (end > at && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  return end;
}

/**
 * The column of the first character after the spaces and tabs at `from`,
 * starting from `column`, and its offset. A tab advances to the next
 * multiple of four, as CommonMark counts indentation.
 */
function indentFrom(
  text: string,
  from: number,
  to: number,
  column: number,
): { readonly column: number; readonly offset: number } {
  let col = column;
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === " ") col += 1;
    else if (c === "\t") col += 4 - (col % 4);
    else break;
    i++;
  }
  return { column: col, offset: i };
}

/** A run of three or more backticks or tildes at `at`, or null. */
function fenceRunAt(
  text: string,
  at: number,
  lineEnd: number,
): { readonly char: string; readonly length: number; readonly end: number } | null {
  const char = text[at];
  if (char !== "`" && char !== "~") return null;
  let end = at;
  while (end < lineEnd && text[end] === char) end++;
  return end - at >= 3 ? { char, length: end - at, end } : null;
}

/** `#` to `######` at `at`, then a space, a tab or the end of the line. */
function isAtxHeading(text: string, at: number, lineEnd: number): boolean {
  let end = at;
  while (end < lineEnd && text[end] === "#") end++;
  const level = end - at;
  return level >= 1 && level <= 6 && (end === lineEnd || text[end] === " " || text[end] === "\t");
}

/** Three or more of one of `-`, `*`, `_` from `at` to the line's end, with
 *  nothing else but spaces and tabs. */
function isThematicBreak(text: string, at: number, lineEnd: number): boolean {
  const char = text[at];
  if (char !== "-" && char !== "*" && char !== "_") return false;
  let marks = 0;
  for (let i = at; i < lineEnd; i++) {
    const c = text[i];
    if (c === char) marks++;
    else if (c !== " " && c !== "\t") return false;
  }
  return marks >= 3;
}

/**
 * `isThematicBreak` for every position of one line from `from` on, read in
 * one backward pass on first use. A bullet is a bullet only where no
 * thematic break starts, and "- - - … - x" holds a bullet per two
 * characters: asking `isThematicBreak` at each scanned to the line's end
 * every time, quadratic in the line (14 s for 80 KB of them).
 */
function thematicFrom(text: string, from: number, lineEnd: number): (at: number) => boolean {
  let table: Uint8Array | null = null;
  return (at) => {
    if (table === null) {
      table = new Uint8Array(lineEnd - from);
      let only = "";
      let count = 0;
      for (let i = lineEnd - 1; i >= from; i--) {
        const c = text[i] as string;
        if (c === " " || c === "\t") continue;
        if (only === "") only = c;
        else if (c !== only) break;
        count++;
        if ((c === "-" || c === "*" || c === "_") && count >= 3) table[i - from] = 1;
      }
    }
    return at >= from && at < lineEnd && table[at - from] === 1;
  };
}

/** A list item's marker, and where the item's content is. */
type ListMarker = {
  /** The ordered item's number, or null for a bullet. */
  readonly start: number | null;
  /** Nothing follows the marker on its line. */
  readonly empty: boolean;
  /** The column a line must be indented to to belong to the item. */
  readonly contentColumn: number;
  /** Where the content on the marker's own line starts, or the line's end
   *  when there is none or it is indented code (nothing on it opens a block). */
  readonly contentOffset: number;
};

/**
 * A list item's marker at `at` (column `column`): `-`, `*` or `+`, or one to
 * nine digits and `.` or `)`, followed by a space, a tab or the end of the
 * line. A thematic break (`- - -`, `***`) is not one.
 */
function listMarkerAt(
  text: string,
  at: number,
  column: number,
  lineEnd: number,
  thematic: (at: number) => boolean,
): ListMarker | null {
  const char = text[at];
  let end: number;
  let start: number | null = null;
  if (char === "-" || char === "*" || char === "+") {
    if (thematic(at)) return null;
    end = at + 1;
  } else {
    end = at;
    while (end < lineEnd && end - at < 10 && /[0-9]/.test(text[end] as string)) end++;
    const digits = end - at;
    if (digits < 1 || digits > 9 || (text[end] !== "." && text[end] !== ")")) return null;
    start = Number(text.slice(at, end));
    end += 1;
  }
  if (end < lineEnd && text[end] !== " " && text[end] !== "\t") return null;
  const markerColumn = column + (end - at);
  const after = indentFrom(text, end, lineEnd, markerColumn);
  if (after.offset === lineEnd) {
    return { start, empty: true, contentColumn: markerColumn + 1, contentOffset: lineEnd };
  }
  // Five or more spaces after the marker: the content is indented code, and
  // the item's content column is one past the marker (CommonMark).
  if (after.column - markerColumn > 4) {
    return { start, empty: false, contentColumn: markerColumn + 1, contentOffset: lineEnd };
  }
  return { start, empty: false, contentColumn: after.column, contentOffset: after.offset };
}

/**
 * Does a line under paragraph text open a block of its own, rather than
 * continue the paragraph? Counted from the innermost open item the line is
 * indented into. A list item may interrupt a paragraph only when it has
 * content, and an ordered one only from 1 — CommonMark's rule, so "12." on
 * the line under a sentence is the sentence going on. Inside an open list
 * an item is taken to continue it, whatever its number.
 */
function opensBlock(
  text: string,
  offset: number,
  column: number,
  lineEnd: number,
  items: ReadonlyArray<number>,
): boolean {
  let container = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if ((items[i] as number) <= column) {
      container = items[i] as number;
      break;
    }
  }
  if (column - container > 3) return false;
  if (text[offset] === ">" || isAtxHeading(text, offset, lineEnd)) return true;
  if (isThematicBreak(text, offset, lineEnd)) return true;
  const run = fenceRunAt(text, offset, lineEnd);
  if (run !== null && (run.char === "~" || !text.slice(run.end, lineEnd).includes("`"))) {
    return true;
  }
  const marker = listMarkerAt(text, offset, column, lineEnd, (at) =>
    isThematicBreak(text, at, lineEnd),
  );
  if (marker === null) return false;
  return items.length > 0 || (!marker.empty && (marker.start === null || marker.start === 1));
}

/** A membership test over spans, built once: sorted starts plus a running max end. */
export type SpanIndex = { readonly starts: number[]; readonly maxEnd: number[] };

export function indexSpans(spans: ReadonlyArray<[number, number]>): SpanIndex {
  const sorted = [...spans].sort((x, y) => x[0] - y[0]);
  const starts: number[] = [];
  const maxEnd: number[] = [];
  let furthest = Number.NEGATIVE_INFINITY;
  for (const [a, b] of sorted) {
    furthest = Math.max(furthest, b);
    starts.push(a);
    maxEnd.push(furthest);
  }
  return { starts, maxEnd };
}

/** Is `at` inside any span? O(log spans), where a scan of every span was O(spans) per hit. */
export function inSpan(at: number, index: SpanIndex): boolean {
  let lo = 0;
  let hi = index.starts.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((index.starts[mid] as number) <= at) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return last >= 0 && at < (index.maxEnd[last] as number);
}

/**
 * A test for "is this offset inside code?", built once per document.
 *
 * The code-span helper every reader in this package and in tool-verify asks,
 * so a marker inside a code block is invisible to the linter, the claim
 * reader and the gate alike.
 */
export function codeSpanTest(text: string): (offset: number) => boolean {
  const index = indexSpans(codeSpans(text));
  return (offset) => inSpan(offset, index);
}

/**
 * Offsets at which each line starts. The same rule as tool-text's
 * `lineStarts`, written out here because this package depends on nothing.
 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line of an offset, from one pass over the text rather than one per lookup. */
export function lineIndex(text: string): (index: number) => number {
  const starts = lineStarts(text);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * True when a link destination names a scheme rather than a path.
 *
 * `https:` and `mailto:` are destinations nothing here opens; `./http-notes.md`
 * is a file. The test is for a scheme, not for the letters "http".
 */
export function hasUriScheme(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/** A code unit `\s` matches: WhiteSpace or LineTerminator. */
function isRegExpSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/**
 * A Markdown definition's destination without the ` "title"` after it: what
 * `text.replace(/\s+"[^"]*"\s*$/, "")` returned, read from the end. That
 * pattern tries every start inside a run of whitespace and, where no title
 * follows the run, rescans the rest of it from each before giving the start
 * up, so a long run inside a destination was quadratic in its length.
 */
export function withoutLinkTitle(text: string): string {
  let end = text.length;
  while (end > 0 && isRegExpSpace(text.charCodeAt(end - 1))) end--;
  if (end < 2 || text.charCodeAt(end - 1) !== 0x22) return text;
  const open = text.lastIndexOf('"', end - 2);
  if (open < 1 || !isRegExpSpace(text.charCodeAt(open - 1))) return text;
  let start = open - 1;
  while (start > 0 && isRegExpSpace(text.charCodeAt(start - 1))) start--;
  return text.slice(0, start);
}

/**
 * A link destination split into the file it names and the fragment after it.
 *
 * Every tool that turns a destination into a path asks this one function,
 * because two of them asking separately is how they come to disagree about
 * which file a citation names: the link checker would call
 * `./report.md#findings` fine while the cross-checker went looking for a file
 * whose name ends in `#findings` and reported a source that is right there as
 * one it could not read. The evidence-ref grammar (`classifyDefinition`) asks
 * it too, for the same reason.
 *
 * A second `#` stays in the fragment's tail rather than starting a third
 * part, which is what a renderer does with it.
 */
export function splitLinkTarget(href: string): {
  readonly target: string;
  readonly fragment: string | undefined;
} {
  const [target = "", fragment] = href.split("#");
  return { target, fragment };
}

/** An inline link or image, `[text](destination "title")`, and where it sits. */
export type InlineLink = {
  readonly start: number;
  readonly end: number;
  readonly image: boolean;
  readonly text: string;
  readonly href: string;
};

/**
 * Where an inline link can start: `[text](` or `![alt](`. The text excludes
 * `[` as well as `]`, so each attempt stops where the next one would start.
 */
const INLINE_OPENER = /(!?)\[([^\[\]]*)\]\(/g;

const isSpace = (ch: string): boolean => /\s/.test(ch);

/**
 * Every inline link and image, in one left-to-right pass.
 *
 * The destination and title are read by hand, not by a regex, and never past
 * the next opener. A single pattern for `(dest "title")` has to let whitespace
 * sit before the destination, before the title and before the `)`, and those
 * runs compete for the same spaces: `[](` and 60 KB of spaces held
 * MarkdownLinkCheck for seconds, and `[^)\n]*` let every `[](` on a line read
 * to its end. Bounding each read by the next opener makes the reads disjoint,
 * so the whole scan is linear. A link whose title holds another `[x](` is the
 * one shape that costs: it is read as the inner link, not the outer one.
 *
 * The destination follows CommonMark rather than 0.7.0's pattern where they
 * differ: parentheses in it must balance and are kept (`Foo_(bar)` was cut to
 * `Foo_(bar`), `<…>` may hold spaces, and a title may be quoted with `"`, `'`
 * or `(…)`.
 */
export function inlineLinks(text: string): InlineLink[] {
  const openers = [...text.matchAll(INLINE_OPENER)];
  const out: InlineLink[] = [];
  for (let k = 0; k < openers.length; k++) {
    const m = openers[k] as RegExpMatchArray;
    const start = m.index as number;
    const limit =
      k + 1 < openers.length ? ((openers[k + 1] as RegExpMatchArray).index as number) : text.length;
    const read = readDestination(text, start + m[0].length, limit);
    if (read === null) continue;
    out.push({ start, end: read.end, image: m[1] === "!", text: m[2] as string, href: read.href });
  }
  return out;
}

/** The `destination "title")` after an opener, read no further than `limit`. */
function readDestination(
  text: string,
  from: number,
  limit: number,
): { readonly href: string; readonly end: number } | null {
  let i = from;
  while (i < limit && isSpace(text[i] as string)) i++;
  let href: string;
  if (text[i] === "<") {
    let j = i + 1;
    while (j < limit && text[j] !== ">") {
      if (text[j] === "\n" || text[j] === "<") return null;
      j += text[j] === "\\" ? 2 : 1;
    }
    if (j >= limit) return null;
    href = text.slice(i + 1, j);
    i = j + 1;
  } else {
    const begin = i;
    let depth = 0;
    while (i < limit) {
      const ch = text[i] as string;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (isSpace(ch)) break;
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
      i++;
    }
    if (depth !== 0 || i > limit) return null;
    href = text.slice(begin, i);
  }
  const afterDestination = i;
  while (i < limit && isSpace(text[i] as string)) i++;
  const open = text[i];
  if (i > afterDestination && (open === '"' || open === "'" || open === "(")) {
    const close = open === "(" ? ")" : open;
    let j = i + 1;
    while (j < limit && text[j] !== close) j += text[j] === "\\" ? 2 : 1;
    if (j >= limit) return null;
    i = j + 1;
    while (i < limit && isSpace(text[i] as string)) i++;
  }
  if (i >= limit || text[i] !== ")") return null;
  return { href, end: i + 1 };
}
