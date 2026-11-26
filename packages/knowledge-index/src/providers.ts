/**
 * What a search finds besides the knowledge stores: harness and session names, work items,
 * criteria, graders and datasets. A provider lists rows for one harness; an area registers
 * its own. A row says which of its words are a name (shown and matched for anyone who may
 * read the harness) and which are content.
 */
import { SESSION_ID_RE } from "@crewhaus/control-contract";
import type { SearchHit, SearchKind } from "@crewhaus/control-contract/search";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import {
  contentOf,
  foldWork,
  itemViews,
  openWorkStore,
  viewContext,
} from "@crewhaus/tool-work/work-items";
import type { HarnessRead } from "./context";
import { relOf } from "./context";
import { masked, previewOf, tagsOf, titleOf } from "./text";

/** One thing a provider found, before it is masked. */
export type SearchRow = {
  readonly kind: SearchKind;
  readonly ref: string;
  /** A name anyone who may read the harness may see. */
  readonly title: string;
  /** Shown instead of `title` to a reader who may read content. */
  readonly contentTitle?: string;
  /** The title is a sentence, shown up to a preview's length. */
  readonly longTitle?: true;
  /** More words it is found by, without content permission. */
  readonly words?: readonly string[];
  /** What it says. */
  readonly body?: string;
  readonly status?: string;
  readonly updatedAt?: string;
  readonly tags?: readonly string[];
  readonly owner?: SearchHit["owner"];
  readonly href?: string;
};

export type SearchProvider = {
  readonly kind: SearchKind;
  /**
   * This harness's rows. Without `canReadContent` a provider opens nothing that holds content
   * and gives no `contentTitle` or `body`.
   */
  list(read: HarnessRead, ctx: { readonly canReadContent: boolean }): Promise<readonly SearchRow[]>;
};

/** A row as a search index holds it: masked, with its names apart from its content. */
export type SearchDoc = {
  readonly kind: SearchKind;
  readonly ref: string;
  readonly title: string;
  readonly contentTitle?: string;
  readonly preview?: string;
  readonly status?: string;
  readonly updatedAt?: string;
  readonly tags: readonly string[];
  readonly owner?: SearchHit["owner"];
  readonly href?: string;
  /** For a knowledge item: its store, where it is kept, its id. */
  readonly store?: SearchHit["source"]["store"];
  readonly backend?: SearchHit["source"]["backend"];
  readonly item?: string;
  /** False for what never enters a fleet-wide answer. */
  readonly fleet: boolean;
  /** True when a reader who may not read content does not get it at all. */
  readonly contentOnly: boolean;
  readonly expiresAt?: string;
};

/** A doc and the words it is found by, with and without content. */
export type IndexedDoc = {
  readonly doc: SearchDoc;
  readonly full: string;
  readonly names: string;
};

export function indexedRow(row: SearchRow): IndexedDoc {
  const names = [row.title, ...(row.words ?? []), ...(row.tags ?? [])].join(" ");
  return {
    doc: {
      kind: row.kind,
      ref: row.ref,
      title: row.longTitle === true ? previewOf(row.title) : titleOf(row.title),
      ...(row.contentTitle !== undefined ? { contentTitle: titleOf(row.contentTitle) } : {}),
      ...(row.body !== undefined && row.body !== "" ? { preview: previewOf(row.body) } : {}),
      ...(row.status !== undefined ? { status: row.status } : {}),
      ...(row.updatedAt !== undefined ? { updatedAt: row.updatedAt } : {}),
      tags: tagsOf(row.tags ?? []),
      ...(row.owner !== undefined ? { owner: row.owner } : {}),
      ...(row.href !== undefined ? { href: row.href } : {}),
      fleet: true,
      contentOnly: false,
    },
    names: masked(names),
    full: masked([names, row.contentTitle ?? "", row.body ?? ""].join(" ")),
  };
}

const harnesses: SearchProvider = {
  kind: "harness",
  async list(read) {
    return [
      {
        kind: "harness",
        ref: `home/harness/${read.hrn}`,
        title: read.name,
        owner: { kind: "harness-owner" },
      },
    ];
  },
};

/** Session names by a raw listing: the session store's own `list()` evicts, and a read never does. */
const sessions: SearchProvider = {
  kind: "session",
  async list(read) {
    const dir = relOf(".crewhaus", "sessions");
    const out: SearchRow[] = [];
    for (const name of read.names(dir, "files", "sessions")) {
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      if (!SESSION_ID_RE.test(id)) continue;
      const session = read.json(relOf(dir, name), "sessions");
      const title = typeof session?.["name"] === "string" ? session["name"] : "session";
      const updatedAt = session?.["updatedAt"];
      out.push({
        kind: "session",
        ref: `${read.hrn}/session/${id}`,
        title,
        words: [id],
        ...(typeof session?.["target"] === "string" ? { status: session["target"] } : {}),
        ...(typeof updatedAt === "string" ? { updatedAt } : {}),
        owner: { kind: "agent" },
      });
    }
    return out;
  },
};

const work: SearchProvider = {
  kind: "work",
  async list(read, ctx) {
    const fold = foldWork(read.dir);
    if (!fold.ok) {
      read.note("unreadable", "work", "The work log could not be read.");
      return [];
    }
    const items = [...fold.items.values()];
    const base = (item: (typeof items)[number]): SearchRow => ({
      kind: "work",
      ref: `${read.hrn}/work/${item.id}`,
      // Titles live with the content, so an item is named by what the log holds of it.
      title: `${item.id} (${item.kind}, ${item.state})`,
      words: [item.kind, item.state],
      status: item.state,
      updatedAt: item.updatedAt,
      owner: { kind: "agent" },
    });
    if (!ctx.canReadContent) return items.map(base);
    const store = openWorkStore(read.dir);
    const views = itemViews(store, items, viewContext(read.dir, fold));
    return items.map((item, i) => {
      const revision = store.revision(item.id, item.rev);
      if (revision === undefined) return base(item);
      const content = contentOf(revision);
      const body = [content.goal ?? "", ...(content.acceptance ?? [])]
        .filter((text) => text !== "")
        .join("\n");
      return {
        ...base(item),
        contentTitle: views[i]?.title ?? revision.title,
        ...(body !== "" ? { body } : {}),
      };
    });
  },
};

const GRADERS_REL = relOf("eval", "graders.yaml");

function gradersOf(read: HarnessRead) {
  const text = read.text(GRADERS_REL, "quality");
  if (text === undefined) return undefined;
  try {
    return parseGradersConfig(text).config;
  } catch {
    read.note("unreadable", "quality", "eval/graders.yaml could not be read.");
    return undefined;
  }
}

const criteria: SearchProvider = {
  kind: "criterion",
  async list(read) {
    return (gradersOf(read)?.criteria ?? []).map((criterion) => ({
      kind: "criterion" as const,
      ref: `${read.hrn}/criterion/${criterion.id}`,
      title: [
        criterion.id,
        criterion.severity,
        criterion.protected === true ? "protected" : undefined,
        criterion.description,
      ]
        .filter((part) => part !== undefined)
        .join(" · "),
      longTitle: true as const,
      words: [criterion.id, criterion.description ?? "", criterion.severity ?? ""],
      ...(criterion.severity !== undefined ? { status: criterion.severity } : {}),
      owner: { kind: "harness-owner" as const },
      href: `/#/h/${read.hrn}`,
    }));
  },
};

const graders: SearchProvider = {
  kind: "grader",
  async list(read) {
    return (gradersOf(read)?.graders ?? []).map((grader) => ({
      kind: "grader" as const,
      ref: `${read.hrn}/grader/${grader.name}`,
      title: grader.name,
      words: [grader.type],
      status: grader.type,
      owner: { kind: "harness-owner" as const },
      href: `/#/h/${read.hrn}`,
    }));
  },
};

const registry = new Map<SearchKind, SearchProvider>(
  [harnesses, sessions, work, criteria, graders].map((provider) => [provider.kind, provider]),
);

/** Add a provider, or replace the one of its kind. */
export function registerSearchProvider(provider: SearchProvider): void {
  registry.set(provider.kind, provider);
}

/** Test seam: the registry as this package ships it. */
export function _resetSearchProvidersForTest(): void {
  registry.clear();
  for (const provider of [harnesses, sessions, work, criteria, graders]) {
    registry.set(provider.kind, provider);
  }
}

/** Every registered provider, by kind. */
export function searchProviders(): readonly SearchProvider[] {
  return [...registry.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1));
}

/** The kinds whose rows are names only: what a harness without a shard is searched by. */
export const NAME_KINDS: readonly SearchKind[] = ["harness", "session"];

/** One provider's rows, or none when it cannot list: one area never empties another's answer. */
export async function rowsOf(
  provider: SearchProvider,
  read: HarnessRead,
  ctx: { readonly canReadContent: boolean },
): Promise<readonly SearchRow[]> {
  try {
    return await provider.list(read, ctx);
  } catch {
    read.note("unreadable", provider.kind, "A part of this harness could not be listed.");
    return [];
  }
}
