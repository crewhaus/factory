/**
 * Sitemap parsing, per the sitemaps.org 0.9 schema.
 *
 * Two document shapes exist and they are not interchangeable: `<urlset>`
 * lists pages, `<sitemapindex>` lists other sitemaps. The result says which
 * one it read, because a caller that treats an index as a page list ends up
 * crawling nothing.
 *
 * Limits worth knowing: this reads ONE document. It does not follow an
 * index's children, it does not fetch anything, and it does not read the
 * plain-text or gzipped variants — a `.txt` sitemap is a line-per-URL file
 * that needs no parser, and a `.gz` must be decompressed first.
 */
import { childrenNamed, parseXml, textOf } from "./xml";

export type SitemapEntry = {
  readonly loc: string;
  readonly lastmod?: string;
  readonly changefreq?: string;
  readonly priority?: number;
};

export type SitemapResult =
  | { readonly kind: "urlset"; readonly entries: readonly SitemapEntry[] }
  | { readonly kind: "sitemapindex"; readonly entries: readonly SitemapEntry[] };

const CHANGEFREQ = new Set(["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"]);

/**
 * Parse a sitemap document. Entries are sorted by `loc` so the same document
 * always yields the same list regardless of how the server ordered it.
 * Throws `XmlParseError` for a document that is not XML at all.
 */
export function parseSitemap(source: string): SitemapResult {
  const root = parseXml(source);
  if (root.name !== "urlset" && root.name !== "sitemapindex") {
    throw new Error(`root element is <${root.name}>; a sitemap must be <urlset> or <sitemapindex>`);
  }
  const childName = root.name === "urlset" ? "url" : "sitemap";
  const entries: SitemapEntry[] = [];
  for (const child of childrenNamed(root, childName)) {
    const loc = textOf(child, "loc");
    if (loc === undefined) continue; // <loc> is required; a member without one is not an entry
    const changefreq = textOf(child, "changefreq")?.toLowerCase();
    const priorityRaw = textOf(child, "priority");
    const priority = priorityRaw === undefined ? Number.NaN : Number.parseFloat(priorityRaw);
    entries.push({
      loc,
      ...(textOf(child, "lastmod") !== undefined ? { lastmod: textOf(child, "lastmod") } : {}),
      ...(changefreq !== undefined && CHANGEFREQ.has(changefreq) ? { changefreq } : {}),
      ...(Number.isFinite(priority) && priority >= 0 && priority <= 1 ? { priority } : {}),
    });
  }
  entries.sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
  return { kind: root.name === "urlset" ? "urlset" : "sitemapindex", entries };
}
