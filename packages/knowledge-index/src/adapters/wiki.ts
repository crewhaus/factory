/** The local wiki: articles, their kept versions, and who wrote each. */
import type { KnowledgeItem } from "@crewhaus/control-contract/knowledge";
import {
  type WikiArticle,
  type WikiStore,
  createWikiStore,
  isWikiSlug,
} from "@crewhaus/wiki-store";
import type { HarnessRead } from "../context";
import { relOf } from "../context";
import { type FoldedItem, can, cannot, folded, shellArg } from "../model";
import {
  type KnowledgeAdapter,
  type KnowledgeHistoryEntry,
  type StorePlace,
  isoField,
  sessionEvidence,
  storePlaces,
  storeRoots,
} from "./types";

type SpecWiki = StorePlace & { readonly store: WikiStore };

function wikis(read: HarnessRead): SpecWiki[] {
  return storePlaces(read, "wiki").map((place) => ({
    ...place,
    store: createWikiStore({ specName: place.name, rootDir: place.rootDir }),
  }));
}

function versionsOf(read: HarnessRead, rel: string, slug: string): number[] {
  return read
    .names(relOf(rel, "versions", slug), "files", "wiki")
    .flatMap((name) => {
      const n = /^([1-9]\d*)\.md$/.exec(name)?.[1];
      return n === undefined ? [] : [Number(n)];
    })
    .sort((a, b) => a - b);
}

/** Who wrote an article's version. */
export function articleAuthor(article: WikiArticle): KnowledgeItem["author"] {
  if (article.author !== undefined) {
    return {
      kind: "operator",
      ...(article.author.via !== undefined ? { via: article.author.via } : {}),
      ...(article.author.cmd !== undefined ? { cmd: article.author.cmd } : {}),
    };
  }
  const by = article.createdBy;
  if (by === undefined) return { kind: "unknown" };
  return {
    kind: "agent",
    session: by.sessionId,
    ...(by.agentIdentity !== undefined ? { agentIdentity: by.agentIdentity } : {}),
  };
}

function articleOrigin(article: WikiArticle): KnowledgeItem["origin"] {
  const session = article.createdBy !== undefined ? { session: article.createdBy.sessionId } : {};
  if (article.sources.length > 0) {
    return { kind: "document", ...session, sources: [...article.sources] };
  }
  if (article.author !== undefined) return { kind: "operator" };
  return article.createdBy !== undefined
    ? { kind: "conversation", ...session }
    : { kind: "unknown" };
}

async function foldArticle(
  read: HarnessRead,
  at: SpecWiki,
  slug: string,
): Promise<FoldedItem | undefined> {
  let article: WikiArticle | null;
  try {
    article = await at.store.get(slug);
  } catch {
    read.note("unreadable", "wiki", "An article could not be read, so it is left out.");
    return undefined;
  }
  if (article === null) return undefined;
  const older = versionsOf(read, at.rel, slug);
  const spec = at.spec === "-" ? "" : ` --spec ${shellArg(at.spec)}`;
  const own = at.root.partition === undefined && at.spec !== "-";
  const customer =
    at.root.partition === undefined
      ? "This wiki is kept the older way; the harness moves it when it next writes."
      : "Customer memory is changed by the deployment that serves the customer.";
  const archived = article.status === "archived";
  const last = older[older.length - 1];
  return folded(read, {
    store: "wiki",
    spec: at.spec,
    ...(at.root.partition !== undefined ? { partition: at.root.partition } : {}),
    localId: slug,
    title: article.title,
    body: article.body,
    lifecycle: archived ? "archived" : "live",
    status: article.status,
    version: article.version,
    versions: older.length + 1,
    ...isoField("createdAt", article.createdAt),
    ...isoField("updatedAt", article.updatedAt),
    author: articleAuthor(article),
    origin: articleOrigin(article),
    evidence: sessionEvidence(read, at.root.base, article.createdBy?.sessionId),
    confidence: article.confidence,
    verified: article.verified,
    ...(article.supersedes !== undefined ? { supersedes: String(article.supersedes) } : {}),
    tags: article.tags,
    ...(at.spec !== "-"
      ? { record: { store: "wiki", backend: "local", spec: at.spec, localId: slug } as const }
      : {}),
    operations: [
      own
        ? can(
            "revise",
            `crewhaus wiki write ${slug} --body-file <file> --expect ${article.version}${spec}`,
          )
        : cannot("revise", customer),
      own
        ? can(
            archived ? "restore" : "archive",
            `crewhaus wiki archive ${slug} --expect ${article.version}${archived ? " --undo" : ""}${spec}`,
          )
        : cannot("archive", customer),
      own && last !== undefined
        ? can(
            "rollback",
            `crewhaus wiki rollback ${slug} --to ${last} --expect ${article.version}${spec}`,
          )
        : cannot("rollback", own ? "There is no earlier version." : customer),
    ],
  });
}

export const wikiAdapter: KnowledgeAdapter = {
  name: "wiki",
  stores: ["wiki"],
  async list(read) {
    const out: FoldedItem[] = [];
    for (const at of wikis(read)) {
      for (const name of read.names(relOf(at.rel, "articles"), "files", "wiki")) {
        const slug = name.slice(0, -".md".length);
        if (!name.endsWith(".md") || !isWikiSlug(slug)) continue;
        const item = await foldArticle(read, at, slug);
        if (item !== undefined) out.push(item);
      }
    }
    return out;
  },
  marks(read) {
    const out: Record<string, string> = {};
    for (const at of wikis(read)) {
      // Every edit is a rename into the directory, so the directories' times say it all.
      for (const dir of ["articles", "versions"]) {
        const rel = relOf(at.rel, dir);
        out[rel] = read.sourceMark(rel);
      }
    }
    for (const root of storeRoots(read)) {
      const rel = relOf(root.base, "wiki");
      out[rel] = read.sourceMark(rel);
    }
    return out;
  },
  async current(read, ids) {
    const out: FoldedItem[] = [];
    const all = wikis(read);
    for (const id of ids) {
      const at = all.find(
        (w) => w.spec === id.spec && (w.root.partition ?? "-") === (id.partition ?? "-"),
      );
      if (at === undefined || !isWikiSlug(id.localId)) continue;
      const item = await foldArticle(read, at, id.localId);
      if (item !== undefined) out.push(item);
    }
    return out;
  },
  async history(read, id) {
    const at = wikis(read).find(
      (w) => w.spec === id.spec && (w.root.partition ?? "-") === (id.partition ?? "-"),
    );
    if (at === undefined || !isWikiSlug(id.localId)) return [];
    const out: KnowledgeHistoryEntry[] = [];
    const entryOf = (article: WikiArticle): KnowledgeHistoryEntry => ({
      ...isoField("at", article.updatedAt),
      what: "version",
      version: article.version,
      author: articleAuthor(article),
      body: article.body,
    });
    for (const n of versionsOf(read, at.rel, id.localId)) {
      try {
        const article = await at.store.getVersion(id.localId, n);
        if (article !== null) out.push(entryOf(article));
      } catch {
        read.note("unreadable", "wiki", "A version could not be read, so it is left out.");
      }
    }
    const current = await at.store.get(id.localId);
    if (current !== null) out.push(entryOf(current));
    return out;
  },
};
