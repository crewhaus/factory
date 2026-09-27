/**
 * Checking a document's internal promises.
 *
 * A link that 404s and a citation marker with no source behind it are both
 * mechanical to find and embarrassing to ship. Neither needs a model, and a
 * model asked to check them will miss one in a long document.
 *
 * Every scan here is linear in the document. These run synchronously on
 * workspace Markdown anyone can put in a checkout, and 0.7.0's were not: the
 * heading regex was cubic (a 10 KB README with one long heading took
 * minutes), and the sentence splitter, the line lookup and the code-span test
 * each rescanned from the start per hit. A pattern here either cannot scan
 * past the next place it could start again, or starts only once per run.
 */
import { lineStarts, offsetToLineCol, parseAtxHeading } from "@crewhaus/tool-text";

export type LinkRef = {
  readonly href: string;
  readonly text: string;
  readonly line: number;
  readonly kind: "inline" | "reference" | "html" | "image";
};

/** Fenced and indented code blocks, whose contents are not links. */
function codeSpans(text: string): Array<[number, number]> {
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
  for (const inline of text.matchAll(/`[^`\n]+`/g)) {
    if (inline.index !== undefined) spans.push([inline.index, inline.index + inline[0].length]);
  }
  return spans;
}

/** A membership test over spans, built once: sorted starts plus a running max end. */
type SpanIndex = { readonly starts: number[]; readonly maxEnd: number[] };

function indexSpans(spans: ReadonlyArray<[number, number]>): SpanIndex {
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
function inSpan(at: number, index: SpanIndex): boolean {
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

/** 1-based line of an offset, from one pass over the text rather than one per lookup. */
function lineIndex(text: string): (index: number) => number {
  const starts = lineStarts(text);
  return (index) => offsetToLineCol(starts, index).line;
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

/**
 * A link destination split into the file it names and the fragment after it.
 *
 * Every tool in this package that turns a destination into a path asks this
 * one function, because two of them asking separately is how they come to
 * disagree about which file a citation names: the link checker would call
 * `./report.md#findings` fine while the cross-checker went looking for a file
 * whose name ends in `#findings` and reported a source that is right there as
 * one it could not read.
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
type InlineLink = {
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
function inlineLinks(text: string): InlineLink[] {
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

/** Every link a Markdown document points at, code blocks excluded. */
export function extractMarkdownLinks(text: string): LinkRef[] {
  const spans = indexSpans(codeSpans(text));
  const lineAt = lineIndex(text);
  const links: LinkRef[] = [];

  // Every bracket class below excludes `[` as well as `]`, and the HTML ones
  // exclude `<`: a scan then stops where the next attempt would start, where
  // `[^\]]*` from every `[` of a long `[[[[…` run read to the end each time.
  // Reference definitions: `[id]: https://…`
  const definitions = new Map<string, string>();
  for (const m of text.matchAll(/^\s{0,3}\[([^\[\]\n]+)\]:\s*(\S+)/gm)) {
    if (m.index !== undefined && inSpan(m.index, spans)) continue;
    definitions.set((m[1] as string).toLowerCase(), m[2] as string);
  }

  for (const link of inlineLinks(text)) {
    if (inSpan(link.start, spans)) continue;
    if (link.href === "") continue;
    links.push({
      href: link.href,
      text: link.text,
      line: lineAt(link.start),
      kind: link.image ? "image" : "inline",
    });
  }

  for (const m of text.matchAll(/\[([^\[\]]+)\]\[([^\[\]]*)\]/g)) {
    if (m.index === undefined || inSpan(m.index, spans)) continue;
    const id = ((m[2] as string) || (m[1] as string)).toLowerCase();
    const href = definitions.get(id);
    if (href === undefined) continue;
    links.push({ href, text: m[1] as string, line: lineAt(m.index), kind: "reference" });
  }

  for (const m of text.matchAll(/<(?:a[^<>]*href|img[^<>]*src)\s*=\s*["']([^"']+)["']/gi)) {
    if (m.index === undefined || inSpan(m.index, spans)) continue;
    links.push({ href: m[1] as string, text: "", line: lineAt(m.index), kind: "html" });
  }

  return links;
}

/** GitHub-style anchors: lowercased, punctuation dropped, spaces to dashes. */
export function headingAnchors(text: string): Set<string> {
  const spans = indexSpans(codeSpans(text));
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  // Candidate lines only; `parseAtxHeading` (shared with MarkdownOutline)
  // decides, in linear time, whether each is a heading and what it says.
  for (const m of text.matchAll(/^#{1,6}[ \t][^\n]*/gm)) {
    if (m.index !== undefined && inSpan(m.index, spans)) continue;
    const heading = parseAtxHeading(m[0]);
    if (heading === null) continue;
    const slug = heading.title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    if (slug === "") continue;
    // A repeated heading gets `-1`, `-2` and so on, as renderers do.
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
    anchors.add(slug);
  }
  for (const m of text.matchAll(/<a[^<>]+(?:name|id)\s*=\s*["']([^"'<>]+)["']/gi)) {
    anchors.add((m[1] as string).toLowerCase());
  }
  return anchors;
}

export type Citation = { readonly marker: string; readonly line: number };

/**
 * A citation marker in the prose: `[1]`, `[^a]`.
 *
 * One constant, shared by the linter and by the claim reader, because a
 * document's markers have to be the SAME set for both — two copies of this
 * drift, and then one tool checks a claim the other never saw. The lookahead
 * keeps `[x](url)` (a link), `[1]:` (a definition) and `[1][2]` (a reference
 * link) out; `matchAll` clones the regex, so sharing one `g` literal carries
 * no `lastIndex` between callers.
 */
const CITATION_MARKER = /\[\^?([\w.-]+)\](?!\(|:|\[)/g;

/**
 * Where a marker's source is declared: `[1]: ./report.md`.
 *
 * One rule, asked by everything that needs the answer. The whole rest of the
 * line is the source, not its first word, because a source is as often a
 * bibliographic reference as a path — a tool that took "Smith," out of
 * "Smith, J. (2024)" would go looking for a file by that name and report it
 * missing, which reads as a broken citation rather than an unread one.
 *
 * The destination may sit on the line UNDER the marker, as a Markdown link
 * reference definition may. Two things end a definition instead of continuing
 * it, and both are here because the generous version of each is wrong in a
 * way that is hard to see: a blank line, after which the text is prose and
 * not a source; and a line that opens a definition of its own, which would
 * otherwise be swallowed and leave the NEXT marker with nothing behind it.
 */
const DEFINITION =
  /^\s{0,3}\[\^?([\w.-]+)\]:[ \t]*(?:\r?\n[ \t]{0,3}(?!\[\^?[\w.-]+\]:))?(\S[^\n]*)$/gm;

export type CitationReport = {
  readonly markers: ReadonlyArray<Citation>;
  readonly defined: ReadonlyArray<string>;
  /** Cited in the text with nothing behind it — the serious one. */
  readonly undefinedMarkers: ReadonlyArray<Citation>;
  /** Listed as a source and never cited. */
  readonly uncited: ReadonlyArray<string>;
  readonly ok: boolean;
};

/**
 * Check that every `[n]` or `[^n]` marker has a source and vice versa.
 *
 * The asymmetry matters: a marker with no source is a claim with nothing
 * behind it, while a source nobody cites is usually just tidiness. Both are
 * reported, separately, so a caller can gate on the first alone.
 */
export function lintCitations(text: string): CitationReport {
  const spans = indexSpans(codeSpans(text));
  const lineAt = lineIndex(text);
  const markers: Citation[] = [];
  // Asked of `citationDefinitions`, never worked out again here: this tool
  // says whether a marker has a source and FactCrossCheck then reads that
  // source, and the two answering separately is how one came to report "no
  // source behind it — that is CitationLint's finding" about a marker
  // CitationLint had just passed.
  const defined = new Set(citationDefinitions(text).keys());

  for (const m of text.matchAll(CITATION_MARKER)) {
    if (m.index === undefined || inSpan(m.index, spans)) continue;
    markers.push({ marker: m[1] as string, line: lineAt(m.index) });
  }

  const cited = new Set(markers.map((c) => c.marker));
  const undefinedMarkers = markers.filter((c) => !defined.has(c.marker));
  const uncited = [...defined].filter((d) => !cited.has(d)).sort();

  return {
    markers,
    defined: [...defined].sort(),
    undefinedMarkers,
    uncited,
    ok: undefinedMarkers.length === 0,
  };
}

/** Every marker's declared source, by the one `DEFINITION` rule above. First
 *  definition wins, as a renderer does. */
export function citationDefinitions(text: string): Map<string, string> {
  const spans = indexSpans(codeSpans(text));
  const definitions = new Map<string, string>();
  for (const m of text.matchAll(DEFINITION)) {
    if (m.index !== undefined && inSpan(m.index, spans)) continue;
    const id = m[1] as string;
    if (definitions.has(id)) continue;
    definitions.set(id, (m[2] as string).trim());
  }
  return definitions;
}

/**
 * Where one sentence ends and the next begins.
 *
 * Only what can be decided from the characters: a paragraph break, a heading
 * line, the start of a list item, and terminal punctuation followed by space.
 * A handful of abbreviations and single initials are held back, because
 * "e.g." and "J. Smith" are the two that turn one claim into two.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
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

export type CitedClaim = {
  /** The sentence the marker sits in, with the marker and the Markdown taken
   *  out — exactly the text that will be looked for, so a caller can see what
   *  was checked rather than trust that it was the right span. */
  readonly text: string;
  readonly line: number;
  readonly markers: ReadonlyArray<string>;
};

/** A sentence with each inline link replaced by its text, by the same reader
 *  the link checker uses (a pattern of its own let every `[](` read to the end
 *  of the line: 192 KB of them held FactCrossCheck for nine seconds). */
function linksToText(sentence: string): string {
  let out = "";
  let at = 0;
  for (const link of inlineLinks(sentence)) {
    out += sentence.slice(at, link.start) + link.text;
    at = link.end;
  }
  return out + sentence.slice(at);
}

/** Markdown down to the words the sentence actually asserts. */
function plainClaim(sentence: string): string {
  return (
    linksToText(sentence) // a link's URL is not part of the claim
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "") // the bullet is not part of the claim
      .replace(/\[\^?[\w.-]+\]/g, " ") // the markers themselves
      .replace(/[`*_>#|]/g, "")
      .replace(/\s+/g, " ")
      // Taking a marker out leaves the space in front of it against the full
      // stop; the claim reported has to read like the sentence written.
      .replace(/\s+([.,;:!?])/g, "$1")
      .trim()
  );
}

/**
 * Every sentence that cites something, with what it cites.
 *
 * Two markers in one sentence make one claim with two sources, not two
 * claims: the sentence asserts one thing, and either source saying it is
 * enough for it to have been said.
 */
export function citedClaims(text: string): CitedClaim[] {
  const spans = indexSpans(codeSpans(text));
  const lineAt = lineIndex(text);
  const sentences = splitSentences(text);
  // Sentences are ordered and do not overlap: find one by binary search, not
  // by a scan per marker.
  const sentenceAt = (at: number): { start: number; end: number } | undefined => {
    let lo = 0;
    let hi = sentences.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = sentences[mid] as { start: number; end: number };
      if (at < s.start) hi = mid - 1;
      else if (at >= s.end) lo = mid + 1;
      else return s;
    }
    return undefined;
  };
  const byStart = new Map<number, { markers: string[]; start: number; end: number }>();
  const order: number[] = [];

  for (const m of text.matchAll(CITATION_MARKER)) {
    if (m.index === undefined || inSpan(m.index, spans)) continue;
    const at = m.index;
    const sentence = sentenceAt(at);
    if (sentence === undefined) continue;
    let bucket = byStart.get(sentence.start);
    if (bucket === undefined) {
      bucket = { markers: [], start: sentence.start, end: sentence.end };
      byStart.set(sentence.start, bucket);
      order.push(sentence.start);
    }
    if (!bucket.markers.includes(m[1] as string)) bucket.markers.push(m[1] as string);
  }

  const claims: CitedClaim[] = [];
  for (const start of order) {
    const bucket = byStart.get(start) as { markers: string[]; start: number; end: number };
    claims.push({
      text: plainClaim(text.slice(bucket.start, bucket.end)),
      line: lineAt(bucket.start),
      markers: bucket.markers,
    });
  }
  return claims;
}
