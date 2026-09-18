/**
 * RSS 2.0, RDF/RSS 1.0 and Atom 1.0 flattened into one entry shape.
 *
 * The three formats disagree about almost every field name, so the mapping
 * is spelled out rather than guessed:
 *
 *   entry field | RSS               | Atom
 *   ------------|-------------------|--------------------------------
 *   id          | <guid>, else link | <id>
 *   title       | <title>           | <title>
 *   link        | <link> text       | <link href> (rel=alternate wins)
 *   published   | <pubDate>         | <published>
 *   updated     | <lastBuildDate>*  | <updated>
 *   summary     | <description>     | <summary>, else <content>
 *
 *   * RSS has no per-item updated timestamp; the field is simply absent.
 *
 * Entries keep DOCUMENT ORDER. A feed is an ordered thing — newest first by
 * convention — and re-sorting it would destroy the one signal it carries.
 * Order is still deterministic: the same bytes give the same list.
 *
 * Dates are returned as the feed wrote them (RFC 822 for RSS, RFC 3339 for
 * Atom). Normalising them would mean guessing at a timezone this parser
 * cannot verify; `@crewhaus/tool-datetime` exists for that.
 */
import { childrenNamed, firstNamed, parseXml, textOf } from "./xml";
import type { XmlNode } from "./xml";

export type FeedEntry = {
  readonly id?: string;
  readonly title?: string;
  readonly link?: string;
  readonly published?: string;
  readonly updated?: string;
  readonly summary?: string;
  readonly authors?: readonly string[];
  readonly categories?: readonly string[];
};

export type FeedResult = {
  readonly kind: "rss" | "atom";
  readonly title?: string;
  readonly link?: string;
  readonly description?: string;
  readonly entries: readonly FeedEntry[];
};

/** The href of an Atom `<link>`: `rel="alternate"` wins, then the first one. */
function atomLink(entry: XmlNode): string | undefined {
  const links = childrenNamed(entry, "link");
  const alternate = links.find((l) => (l.attrs["rel"] ?? "alternate") === "alternate");
  const chosen = alternate ?? links[0];
  const href = chosen?.attrs["href"];
  return href === undefined || href === "" ? undefined : href;
}

function optional(key: string, value: string | undefined): Record<string, string> {
  return value === undefined ? {} : { [key]: value };
}

function list(values: readonly string[]): readonly string[] | undefined {
  return values.length === 0 ? undefined : values;
}

/**
 * Parse a feed document. Throws when the root element is neither a feed nor
 * a channel-bearing RSS/RDF document.
 */
export function parseFeed(source: string): FeedResult {
  const root = parseXml(source);

  if (root.name === "feed") {
    const entries = childrenNamed(root, "entry").map((entry): FeedEntry => {
      const authors = childrenNamed(entry, "author")
        .map((a) => textOf(a, "name"))
        .filter((n): n is string => n !== undefined);
      const categories = childrenNamed(entry, "category")
        .map((c) => c.attrs["term"] ?? c.text.trim())
        .filter((c) => c !== "");
      return {
        ...optional("id", textOf(entry, "id")),
        ...optional("title", textOf(entry, "title")),
        ...optional("link", atomLink(entry)),
        ...optional("published", textOf(entry, "published")),
        ...optional("updated", textOf(entry, "updated")),
        ...optional("summary", textOf(entry, "summary", "content")),
        ...(list(authors) !== undefined ? { authors } : {}),
        ...(list(categories) !== undefined ? { categories } : {}),
      };
    });
    return {
      kind: "atom",
      ...optional("title", textOf(root, "title")),
      ...optional("link", atomLink(root)),
      ...optional("description", textOf(root, "subtitle")),
      entries,
    };
  }

  // RSS 2.0 nests items under <channel>; RDF/RSS 1.0 puts them beside it.
  const channel = firstNamed(root, "channel");
  const itemHost = channel ?? root;
  const items = [...childrenNamed(itemHost, "item"), ...childrenNamed(root, "item")].filter(
    (item, index, all) => all.indexOf(item) === index,
  );
  if (channel === undefined && items.length === 0) {
    throw new Error(
      `root element is <${root.name}> with no <channel> or <item>; not an RSS or Atom feed`,
    );
  }

  const entries = items.map((item): FeedEntry => {
    const link = textOf(item, "link");
    const guid = textOf(item, "guid");
    const authors = [textOf(item, "author"), textOf(item, "creator")].filter(
      (a): a is string => a !== undefined,
    );
    const categories = childrenNamed(item, "category")
      .map((c) => c.text.trim())
      .filter((c) => c !== "");
    return {
      ...optional("id", guid ?? link),
      ...optional("title", textOf(item, "title")),
      ...optional("link", link),
      ...optional("published", textOf(item, "pubdate", "date")),
      ...optional("summary", textOf(item, "description", "encoded")),
      ...(list(authors) !== undefined ? { authors } : {}),
      ...(list(categories) !== undefined ? { categories } : {}),
    };
  });

  const head = channel ?? root;
  return {
    kind: "rss",
    ...optional("title", textOf(head, "title")),
    ...optional("link", textOf(head, "link")),
    ...optional("description", textOf(head, "description")),
    entries,
  };
}
