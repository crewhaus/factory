/**
 * The citation grammar: a marker in the prose, `[1]` or `[^a]`, and the line
 * that declares what it cites, `[1]: ./report.md`.
 *
 * Moved here from tool-verify's `lib/markdown.ts` (design §4.1). CitationLint,
 * FactCrossCheck, the claim extractor and the provability gate all read
 * markers and definitions through the two constants below and nothing else:
 * the rule this release enforces is the one the original comment stated —
 * two copies of this drift, and then one tool checks a claim the other never
 * saw. Keep these the only copies: design §10 has `doctor
 * --philosophy-alignment` check that the marker pattern is defined once in
 * the tree.
 */
import { codeSpans, inSpan, indexSpans, inlineLinks, lineIndex } from "./markdown";
import { splitSentences } from "./sentences";

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
 *
 * The 0.8.0 evidence-ref prefixes (`tool:`, `proof:`, `assume:`, `doi:`)
 * live in the source text this captures, so this pattern did not change for
 * them: every existing document parses as before, and `classifyDefinition`
 * (`refs.ts`) reads the prefix afterwards.
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
 * Every marker outside code, with where it sits, in document order. For
 * `extractClaims`, which needs the markers of each sentence and must find
 * exactly the ones `lintCitations` and `citedClaims` find — so it reads them
 * through the same constant, from here. Not exported from the package.
 */
export function* markersOutsideCode(
  text: string,
  inCode: (offset: number) => boolean,
): Generator<{ readonly marker: string; readonly at: number }> {
  for (const m of text.matchAll(CITATION_MARKER)) {
    if (m.index === undefined || inCode(m.index)) continue;
    yield { marker: m[1] as string, at: m.index };
  }
}

/**
 * Where the run of bracketed ids that ends at `at` starts — the `[1]` of
 * `[1][2]` — or `at` when nothing bracketed ends there. For `extractClaims`.
 *
 * The grammar reads `[1][2]` as one marker, `[2]`: CommonMark renders it as
 * a reference link whose text is "1", and the marker set has to stay the one
 * CitationLint reads (so `[1]`, defined and cited nowhere else, is reported
 * uncited by both). But the run is still where the sentence's citation sits:
 * "Revenue rose.[1][2] Costs fell." ends its first sentence at the full stop
 * before the run, and "Revenue rose. [1][2] Costs fell." cites [2] for the
 * sentence before it. So the extractor asks this where a marker's run
 * begins. Only ids the marker grammar could read — `[\w.-]+`, after an
 * optional `^` — count; linear in the run. Not exported from the package.
 */
export function labelRunStart(text: string, at: number): number {
  let start = at;
  for (;;) {
    if (text[start - 1] !== "]") return start;
    let i = start - 1;
    while (i > 0 && /[\w.-]/.test(text[i - 1] as string)) i--;
    if (i === start - 1) return start;
    if (text[i - 1] === "^") i--;
    if (text[i - 1] !== "[") return start;
    start = i - 1;
  }
}

/**
 * The character ranges of every definition outside code — the marker line,
 * and the next line too when the source sits under it. For `extractClaims`,
 * which must never read a definition as prose (a definition block with no
 * blank line above it otherwise joins the sentence before it). Not exported
 * from the package.
 */
export function definitionRanges(
  text: string,
  inCode: (offset: number) => boolean,
): Array<[number, number]> {
  return definitionEntries(text, inCode).map((entry) => entry.range);
}

/** One definition line outside code, as `definitionRanges` finds it. */
export type DefinitionEntry = {
  readonly range: [number, number];
  /** The source, as `citationDefinitions` would return it. */
  readonly source: string;
  /** Is this the definition `citationDefinitions` returns for its id: the
   *  first one, outside the code that grammar's own reader sees? A second
   *  `[1]:` line, or one only the CommonMark reader calls prose, is not. */
  readonly entry: boolean;
};

/**
 * Every definition outside code (`inCode`, the caller's reading of it),
 * with its source and whether it is the entry `citationDefinitions` keeps.
 * For `extractClaims`, which leaves a definition line out only where the
 * text it shows is read some other way: an entry's, by the provability
 * gate under that definition; an empty one's, by nobody, because a
 * renderer shows none. Not exported from the package.
 */
export function definitionEntries(
  text: string,
  inCode: (offset: number) => boolean,
): DefinitionEntry[] {
  // `citationDefinitions`' own reading, so `entry` is its answer exactly.
  const spans = indexSpans(codeSpans(text));
  const kept = new Set<string>();
  const out: DefinitionEntry[] = [];
  for (const m of text.matchAll(DEFINITION)) {
    if (m.index === undefined) continue;
    const id = m[1] as string;
    const entry = !inSpan(m.index, spans) && !kept.has(id);
    if (entry) kept.add(id);
    if (inCode(m.index)) continue;
    out.push({
      range: [m.index, m.index + m[0].length],
      source: (m[2] as string).trim(),
      entry,
    });
  }
  return out;
}

/** A list item's bullet, `- `, `* `, `+ `, `1. ` or `1) `, at any indent. */
const LIST_BULLET = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/** `DEFINITION` without the `g` flag, for one match from the start of a
 *  string: the same source, so it cannot drift from the shared pattern. */
const DEFINITION_AT_START = new RegExp(DEFINITION.source, "m");

/**
 * The source of a list item that holds nothing but a definition —
 * `- [1]: https://…` — or null when the item is anything else. The one
 * `DEFINITION` pattern, run on the item's content after its bullet. For
 * `extractClaims`, which must not read a reference list written as bullets
 * as claims; `citationDefinitions` itself never reads such an item, because
 * the pattern is anchored at the line's start. Not exported from the package.
 */
export function definitionItemSource(item: string): string | null {
  const bullet = LIST_BULLET.exec(item);
  if (bullet === null) return null;
  const m = DEFINITION_AT_START.exec(item.slice(bullet[0].length));
  return m === null || m.index !== 0 ? null : (m[2] as string).trim();
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

/**
 * Markdown down to the words the sentence actually asserts. Shared by
 * `citedClaims` and `extractClaims`, so a claim both see has one text.
 */
export function plainClaim(sentence: string): string {
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
  // `seen` holds the markers already in `markers`: a sentence can carry
  // thousands of them, and searching the list for each was quadratic in them.
  const byStart = new Map<
    number,
    { markers: string[]; seen: Set<string>; start: number; end: number }
  >();
  const order: number[] = [];

  for (const m of text.matchAll(CITATION_MARKER)) {
    if (m.index === undefined || inSpan(m.index, spans)) continue;
    const at = m.index;
    const sentence = sentenceAt(at);
    if (sentence === undefined) continue;
    let bucket = byStart.get(sentence.start);
    if (bucket === undefined) {
      bucket = { markers: [], seen: new Set(), start: sentence.start, end: sentence.end };
      byStart.set(sentence.start, bucket);
      order.push(sentence.start);
    }
    const marker = m[1] as string;
    if (!bucket.seen.has(marker)) {
      bucket.seen.add(marker);
      bucket.markers.push(marker);
    }
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
