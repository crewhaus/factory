/**
 * Checking a document's internal promises.
 *
 * A link that 404s and a citation marker with no source behind it are both
 * mechanical to find and embarrassing to ship. Neither needs a model, and a
 * model asked to check them will miss one in a long document.
 */

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

const inSpan = (at: number, spans: ReadonlyArray<[number, number]>): boolean =>
  spans.some(([a, b]) => at >= a && at < b);

const lineAt = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** Every link a Markdown document points at, code blocks excluded. */
export function extractMarkdownLinks(text: string): LinkRef[] {
  const spans = codeSpans(text);
  const links: LinkRef[] = [];

  // Reference definitions: `[id]: https://…`
  const definitions = new Map<string, string>();
  for (const m of text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(\S+)/gm)) {
    if (m.index !== undefined && inSpan(m.index, spans)) continue;
    definitions.set((m[1] as string).toLowerCase(), m[2] as string);
  }

  for (const m of text.matchAll(/(!?)\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g)) {
    if (m.index === undefined || inSpan(m.index, spans)) continue;
    const href = m[3] as string;
    if (href === "") continue;
    links.push({
      href,
      text: m[2] as string,
      line: lineAt(text, m.index),
      kind: m[1] === "!" ? "image" : "inline",
    });
  }

  for (const m of text.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
    if (m.index === undefined || inSpan(m.index, spans)) continue;
    const id = ((m[2] as string) || (m[1] as string)).toLowerCase();
    const href = definitions.get(id);
    if (href === undefined) continue;
    links.push({ href, text: m[1] as string, line: lineAt(text, m.index), kind: "reference" });
  }

  for (const m of text.matchAll(/<(?:a[^>]*href|img[^>]*src)\s*=\s*["']([^"']+)["']/gi)) {
    if (m.index === undefined || inSpan(m.index, spans)) continue;
    links.push({ href: m[1] as string, text: "", line: lineAt(text, m.index), kind: "html" });
  }

  return links;
}

/** GitHub-style anchors: lowercased, punctuation dropped, spaces to dashes. */
export function headingAnchors(text: string): Set<string> {
  const spans = codeSpans(text);
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const m of text.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)) {
    if (m.index !== undefined && inSpan(m.index, spans)) continue;
    const slug = (m[2] as string)
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
  for (const m of text.matchAll(/<a[^>]+(?:name|id)\s*=\s*["']([^"']+)["']/gi)) {
    anchors.add((m[1] as string).toLowerCase());
  }
  return anchors;
}

export type Citation = { readonly marker: string; readonly line: number };

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
  const spans = codeSpans(text);
  const markers: Citation[] = [];
  const defined = new Set<string>();

  for (const m of text.matchAll(/^\s{0,3}\[\^?([\w.-]+)\]:\s*\S/gm)) {
    if (m.index !== undefined && inSpan(m.index, spans)) continue;
    defined.add(m[1] as string);
  }

  for (const m of text.matchAll(/\[\^?([\w.-]+)\](?!\(|:|\[)/g)) {
    if (m.index === undefined || inSpan(m.index, spans)) continue;
    markers.push({ marker: m[1] as string, line: lineAt(text, m.index) });
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
