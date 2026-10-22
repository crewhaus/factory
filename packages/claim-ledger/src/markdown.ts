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
  const spans = fencedSpans(text);
  for (const inline of text.matchAll(/`[^`\n]+`/g)) {
    if (inline.index !== undefined) spans.push([inline.index, inline.index + inline[0].length]);
  }
  return spans;
}

/**
 * Fenced code blocks alone, fence lines included.
 *
 * Split out of `codeSpans` for the claim extractor, which removes a fenced
 * block from a sentence but keeps an inline span's words (as `citedClaims`
 * does), so the two agree on the text of every claim they both see.
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
