/**
 * Checking a document's internal promises.
 *
 * A link that 404s and a citation marker with no source behind it are both
 * mechanical to find and embarrassing to ship. Neither needs a model, and a
 * model asked to check them will miss one in a long document.
 *
 * The citation grammar, the sentence splitter, code-span exclusion and the
 * link-destination reader now live in `@crewhaus/claim-ledger` (design/0.8.0
 * §4.1), the one text layer the provability gate and the graders read too:
 * this module re-exports them under the names it always had, so CitationLint,
 * FactCrossCheck and the gate find the same markers, the same sources and the
 * same claims. What stays here is the link checker's own reading of a
 * document — its links and its heading anchors.
 *
 * Every scan here is linear in the document. These run synchronously on
 * workspace Markdown anyone can put in a checkout, and 0.7.0's were not: the
 * heading regex was cubic (a 10 KB README with one long heading took
 * minutes). A pattern here either cannot scan past the next place it could
 * start again, or starts only once per run.
 */
import { codeSpans, inSpan, indexSpans, inlineLinks, lineIndex } from "@crewhaus/claim-ledger";
import { parseAtxHeading } from "@crewhaus/tool-text";

export {
  type Citation,
  type CitationReport,
  type CitedClaim,
  citationDefinitions,
  citedClaims,
  hasUriScheme,
  lintCitations,
  splitLinkTarget,
  splitSentences,
  withoutLinkTitle,
} from "@crewhaus/claim-ledger";

export type LinkRef = {
  readonly href: string;
  readonly text: string;
  readonly line: number;
  readonly kind: "inline" | "reference" | "html" | "image";
};

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
