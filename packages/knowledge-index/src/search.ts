/**
 * Search over the harnesses a reader may read. What the reader may not see is left out before
 * anything is ranked, counted, faceted or cut: a harness they may not read contributes nothing,
 * not even a count, and without content permission only names are matched and shown. No model
 * reads a query, and a query is never stored.
 *
 * A harness with an index answers from its index files alone. One without is searched by its
 * names, and the answer says so. Personal data is in no answer; a customer's memory is only in
 * a search of one harness by a reader who may read its content. Reads only.
 */
import type { ListTruncated } from "@crewhaus/control-contract";
import { KNOWLEDGE_LIFECYCLES } from "@crewhaus/control-contract/knowledge";
import type { SearchHit, SearchPage } from "@crewhaus/control-contract/search";
import { queryTerms, searchIndex, snippet } from "@crewhaus/tool-state/bm25";
import { currentItems } from "./adapters";
import { HarnessRead, type HarnessReadOptions, type ThredzSource } from "./context";
import { truncatedNote } from "./items";
import {
  type IndexedDoc,
  NAME_KINDS,
  type SearchDoc,
  indexedRow,
  rowsOf,
  searchProviders,
} from "./providers";
import { type ParsedQuery, parseQuery } from "./query";
import {
  type Postings,
  Shard,
  adapterNameOf,
  audienceOf,
  inAudience,
  postingsOf,
  revisionOf,
  searchedKinds,
  shardContent,
} from "./shard";

/** A harness a search may look in. */
export type SearchHarness = {
  readonly hrn: string;
  readonly dir: string;
  readonly name: string;
  /** Kept out of a search that does not ask for it. */
  readonly hidden?: boolean;
};

export type SearchOptions = {
  readonly q: string;
  readonly harnesses: readonly SearchHarness[];
  readonly hangarRoot?: string;
  /** Whether the reader may read this harness at all. */
  readonly canRead: (hrn: string) => boolean;
  /** Whether the reader may read its content. */
  readonly canReadContent: (hrn: string) => boolean;
  readonly limit?: number;
  readonly cursor?: string;
  /** `harness`: one harness is asked about, so a customer's memory may answer. Default `fleet`. */
  readonly scope?: "fleet" | "harness";
  readonly includeHidden?: boolean;
  /** Fold a harness that has no index in memory and search it whole; only for one harness. */
  readonly foldMissing?: boolean;
  readonly thredz?: (hrn: string) => ThredzSource | undefined;
  readonly now?: () => Date;
};

export type SearchAnswer = SearchPage & { readonly truncated?: ListTruncated };

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 100;
const SNIPPET_MAX = 200;
/** What a knowledge item's status says when the item is not live. */
const PAST: ReadonlySet<string> = new Set(KNOWLEDGE_LIFECYCLES.filter((word) => word !== "live"));
/** What an answer with harnesses that have no index yet says. */
export const STILL_BUILDING = "Search is still being built. Names are searchable now.";

/** One harness as it is searched: its docs, its words, and where they came from. */
type Source = {
  readonly harness: SearchHarness;
  readonly docs: readonly SearchDoc[];
  readonly postings: Postings;
  readonly asOf: string;
  readonly epoch: string;
  readonly shard: Shard | undefined;
  readonly namesOnly: boolean;
  readonly truncated: boolean;
  readonly thredz: "live" | "cached" | "off";
  readonly kinds: readonly string[];
};

type Match = {
  readonly source: Source;
  readonly doc: SearchDoc;
  readonly score: number;
  readonly content: boolean;
};

function readOptions(harness: SearchHarness, opts: SearchOptions): HarnessReadOptions {
  const thredz = opts.thredz?.(harness.hrn);
  return {
    harnessDir: harness.dir,
    hrn: harness.hrn,
    harnessName: harness.name,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(thredz !== undefined ? { thredz } : {}),
  };
}

async function sourceOf(harness: SearchHarness, opts: SearchOptions): Promise<Source> {
  const shard =
    opts.hangarRoot !== undefined
      ? Shard.open(opts.hangarRoot, harness.hrn, harness.dir)
      : undefined;
  const docs = shard?.docs();
  const postings = docs === undefined ? undefined : shard?.postings();
  if (shard !== undefined && docs !== undefined && postings !== undefined) {
    return {
      harness,
      docs,
      postings,
      asOf: shard.meta.asOf,
      epoch: shard.epoch,
      shard,
      namesOnly: false,
      truncated: shard.meta.truncated,
      thredz: shard.meta.thredz,
      kinds: shard.meta.kinds,
    };
  }
  const read = new HarnessRead(readOptions(harness, opts));
  const asOf = read.now().toISOString();
  if (opts.foldMissing === true) {
    const content = await shardContent(readOptions(harness, opts));
    return {
      harness,
      docs: content.docs.map(({ doc }) => doc),
      postings: postingsOf(content.docs),
      asOf,
      epoch: "direct",
      shard: undefined,
      namesOnly: false,
      truncated: content.truncated,
      thredz: content.thredz,
      kinds: searchedKinds(),
    };
  }
  // Names only: a bounded fold that opens no store.
  const rows: IndexedDoc[] = [];
  for (const provider of searchProviders()) {
    if (!NAME_KINDS.includes(provider.kind)) continue;
    for (const row of await rowsOf(provider, read, { canReadContent: false })) {
      rows.push(indexedRow(row));
    }
  }
  return {
    harness,
    docs: rows.map(({ doc }) => doc),
    postings: postingsOf(rows),
    asOf,
    epoch: "names",
    shard: undefined,
    namesOnly: true,
    truncated: false,
    thredz: "off",
    kinds: NAME_KINDS,
  };
}

/** A doc's status now: a past expiry says expired, whatever the index was built with. */
function statusAt(doc: SearchDoc, now: Date): string | undefined {
  const expired = doc.expiresAt !== undefined && Date.parse(doc.expiresAt) <= now.getTime();
  return expired && doc.status === "live" ? "expired" : doc.status;
}

/** Every status a doc answers to: its store's own word, and `live` for an item that is. */
function statusWords(doc: SearchDoc, now: Date): readonly string[] {
  const status = statusAt(doc, now)?.toLowerCase();
  if (status === undefined) return [];
  return doc.item !== undefined && !PAST.has(status) ? [status, "live"] : [status];
}

/**
 * Whether this reader may get this doc at all: exactly the docs of the term list they are
 * ranked against ({@link audienceOf}), so what they may not get moves no score they see.
 */
function visible(doc: SearchDoc, scope: "fleet" | "harness", content: boolean): boolean {
  return inAudience(doc, audienceOf(scope, content));
}

function passes(doc: SearchDoc, query: ParsedQuery, now: Date): boolean {
  if (query.kinds.length > 0 && !query.kinds.includes(doc.kind)) return false;
  if (query.statuses.length > 0) {
    const asked = query.statuses.map((word) => (word === "corrected" ? "superseded" : word));
    if (!statusWords(doc, now).some((word) => asked.includes(word))) return false;
  }
  if (query.tags.length > 0) {
    const tags = doc.tags.map((tag) => tag.toLowerCase());
    if (!query.tags.every((tag) => tags.includes(tag))) return false;
  }
  if (query.sinceDays !== undefined) {
    const at = doc.updatedAt === undefined ? Number.NaN : Date.parse(doc.updatedAt);
    if (!(at >= now.getTime() - query.sinceDays * 86_400_000)) return false;
  }
  return true;
}

/** Whether a harness is one the query asked for by name or id. */
function askedFor(harness: SearchHarness, query: ParsedQuery): boolean {
  return query.inHarnesses.some(
    (name) => name === harness.hrn || name.toLowerCase() === harness.name.toLowerCase(),
  );
}

type Cursor = { readonly at: number; readonly of: string };

function readCursor(text: string | undefined): Cursor | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Cursor;
    return Number.isSafeInteger(value.at) && value.at >= 0 && typeof value.of === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

/** Search the harnesses the reader may read. */
export async function search(opts: SearchOptions): Promise<SearchAnswer> {
  const now = opts.now?.() ?? new Date();
  const query = parseQuery(opts.q);
  const scope = opts.scope ?? "fleet";
  const limit = Math.max(1, Math.min(opts.limit ?? SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX));
  // Before anything is opened: only the harnesses the reader may read.
  const readable = opts.harnesses.filter((harness) => {
    if (!opts.canRead(harness.hrn)) return false;
    if (query.inHarnesses.length > 0) return askedFor(harness, query);
    return harness.hidden !== true || opts.includeHidden === true || scope === "harness";
  });
  const sources: Source[] = [];
  for (const harness of readable) sources.push(await sourceOf(harness, opts));

  const matches: Match[] = [];
  for (const source of sources) {
    const content = opts.canReadContent(source.harness.hrn);
    // Ranked only against the docs this reader may get.
    const index = source.postings[audienceOf(scope, content)];
    const scored =
      query.words === ""
        ? source.docs.map((_, i) => ({ i, score: 0 }))
        : searchIndex(index, query.words, { limit: -1 }).hits.map((hit) => ({
            i: Number(hit.id),
            score: hit.score,
          }));
    for (const { i, score } of scored) {
      const doc = source.docs[i];
      if (doc === undefined || !visible(doc, scope, content)) continue;
      if (passes(doc, query, now)) matches.push({ source, doc, score, content });
    }
  }
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      (query.words === "" ? compare(b.doc.updatedAt ?? "", a.doc.updatedAt ?? "") : 0) ||
      compare(a.doc.ref, b.doc.ref) ||
      compare(a.source.harness.hrn, b.source.harness.hrn),
  );

  const of = revisionOf(
    JSON.stringify([opts.q, scope, sources.map((s) => [s.harness.hrn, s.epoch])]),
  );
  const cursor = readCursor(opts.cursor);
  const start = cursor !== undefined && cursor.of === of ? cursor.at : 0;
  const page = matches.slice(start, start + limit);
  const { hits, gone } = await withFreshness(page, query, opts, now);
  const kept = gone.size === 0 ? matches : matches.filter(({ doc }) => !gone.has(doc));
  const namesOnly = sources.filter((s) => s.namesOnly).map((s) => s.harness.hrn);
  const truncated = sources.some((s) => s.truncated);
  return {
    items: hits,
    ...(start + limit < matches.length
      ? {
          next: Buffer.from(JSON.stringify({ at: start + limit, of } satisfies Cursor)).toString(
            "base64url",
          ),
        }
      : {}),
    total: kept.length,
    facets: facetsOf(kept, now),
    coverage: {
      kinds: [...new Set(sources.flatMap((s) => s.kinds))].sort(),
      namesOnly,
      thredz: thredzOf(sources),
    },
    ...(truncated ? { truncated: truncatedNote() } : {}),
    ...emptyOf({ query, total: kept.length, readable: readable.length, namesOnly }),
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function thredzOf(sources: readonly Source[]): "live" | "cached" | "off" {
  if (sources.some((s) => s.thredz === "live")) return "live";
  return sources.some((s) => s.thredz === "cached") ? "cached" : "off";
}

function facetsOf(matches: readonly Match[], now: Date): SearchPage["facets"] {
  const kind: Record<string, number> = {};
  const harness: Record<string, number> = {};
  const status: Record<string, number> = {};
  const count = (into: Record<string, number>, name: string | undefined): void => {
    if (name !== undefined) into[name] = (into[name] ?? 0) + 1;
  };
  for (const { doc, source } of matches) {
    count(kind, doc.kind);
    count(harness, source.harness.hrn);
    count(status, statusAt(doc, now));
  }
  return { kind, harness, status };
}

/** Why an answer is empty, or that names only were searched. */
function emptyOf(at: {
  readonly query: ParsedQuery;
  readonly total: number;
  readonly readable: number;
  readonly namesOnly: readonly string[];
}): { readonly empty?: SearchPage["empty"] } {
  if (at.total > 0) return {};
  if (at.readable === 0) {
    return { empty: { reason: "no-access", remedy: "Ask an owner for access to a harness." } };
  }
  if (at.namesOnly.length > 0) return { empty: { reason: "not-indexed", remedy: STILL_BUILDING } };
  const filtered =
    at.query.kinds.length > 0 ||
    at.query.tags.length > 0 ||
    at.query.statuses.length > 0 ||
    at.query.sinceDays !== undefined;
  return filtered
    ? { empty: { reason: "filtered", remedy: "Remove a filter from the search." } }
    : { empty: { reason: "no-data" } };
}

/**
 * The page's hits. A hit from a store that changed since its index was built is stale and is
 * read again from that store: one that is not there any more, is personal now or is not what
 * the query asked for is gone.
 */
async function withFreshness(
  page: readonly Match[],
  query: ParsedQuery,
  opts: SearchOptions,
  now: Date,
): Promise<{ readonly hits: SearchHit[]; readonly gone: ReadonlySet<SearchDoc> }> {
  const terms = queryTerms(query.words);
  const bySource = new Map<Source, Match[]>();
  for (const match of page) {
    bySource.set(match.source, [...(bySource.get(match.source) ?? []), match]);
  }
  const gone = new Set<SearchDoc>();
  const stale = new Set<SearchDoc>();
  for (const [source, matches] of bySource) {
    if (source.shard === undefined) continue;
    const read = new HarnessRead(readOptions(source.harness, opts));
    const changed = source.shard.changed(read);
    if (changed.size === 0) continue;
    const affected = matches.filter(
      ({ doc }) =>
        doc.store !== undefined &&
        changed.has(adapterNameOf({ store: doc.store, backend: doc.backend ?? "local" })),
    );
    const current = await currentItems(
      read,
      affected.flatMap(({ doc }) => (doc.item !== undefined ? [doc.item] : [])),
    );
    for (const { doc } of affected) {
      stale.add(doc);
      const item = doc.item === undefined ? undefined : current.get(doc.item);
      if (item === undefined || item.item.category === "person") {
        gone.add(doc);
        continue;
      }
      const { lifecycle, status } = item.item;
      const fresh = { ...doc, status: lifecycle === "live" ? (status ?? "live") : lifecycle };
      if (!passes(fresh, query, now)) gone.add(doc);
    }
  }
  return {
    hits: page
      .filter(({ doc }) => !gone.has(doc))
      .map((match) => hitOf(match, terms, stale.has(match.doc))),
    gone,
  };
}

function hitOf(match: Match, terms: readonly string[], stale: boolean): SearchHit {
  const { doc, source, content } = match;
  const cut =
    content && doc.preview !== undefined
      ? (snippet(doc.preview, terms, SNIPPET_MAX) ?? (terms.length === 0 ? doc.preview : undefined))
      : undefined;
  return {
    kind: doc.kind,
    ref: doc.ref,
    title: content ? (doc.contentTitle ?? doc.title) : doc.title,
    ...(cut !== undefined ? { snippet: { text: cut, highlights: highlightsOf(cut, terms) } } : {}),
    source: {
      harness: source.harness.hrn,
      harnessName: source.harness.name,
      ...(doc.store !== undefined ? { store: doc.store } : {}),
      ...(doc.backend !== undefined ? { backend: doc.backend } : {}),
    },
    ...(doc.updatedAt !== undefined ? { updatedAt: doc.updatedAt } : {}),
    freshness: { asOf: source.asOf, stale },
    ...(doc.owner !== undefined ? { owner: doc.owner } : {}),
    href: doc.href ?? `/#/i/${doc.ref}`,
  };
}

/** Where the query's words are in a snippet, in order and without overlap. */
function highlightsOf(
  text: string,
  terms: readonly string[],
): ReadonlyArray<readonly [number, number]> {
  const out: [number, number][] = [];
  const lower = text.toLowerCase();
  // Lower-casing can change a text's length; then no offset into it can be trusted.
  if (lower.length !== text.length) return out;
  for (const match of lower.matchAll(/[\p{L}\p{N}_]+/gu)) {
    if (terms.includes(match[0])) out.push([match.index, match.index + match[0].length]);
  }
  return out;
}
