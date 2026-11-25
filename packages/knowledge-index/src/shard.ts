/**
 * The rebuildable index of one harness, under Home's cache:
 *
 *   <hangarRoot>/cache/index/knowledge/<hrn>/meta.json      what it was built from, and when
 *                                            items.jsonl    one row per item
 *                                            docs.jsonl     one row per thing a search finds
 *                                            postings.json  the term lists
 *                                            usage.json     how often each item was used
 *                                            epoch          the index's own revision
 *
 * Every file is `0600` in `0700` directories, replaced whole, contained in the Home root. A
 * row holds a masked title and a masked preview of at most 280 characters; the term lists
 * hold words. A fact marked personal is a row with no text, no words, no tags and no
 * conversation, so a list of one harness can still offer to erase it, and it is in no search
 * file at all. Everything but `meta.asOf` is a function of the stores: the same stores build
 * the same bytes, and a deleted index is built again with the same answers.
 *
 * Only {@link buildShard} writes; {@link readShard} and its callers never do.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_ID_RE } from "@crewhaus/control-contract";
import type { KnowledgeItem } from "@crewhaus/control-contract/knowledge";
import { CACHE_INDEX_DIR } from "@crewhaus/control-records";
import {
  type SafeFsFailure,
  ensureDirContained,
  openForReadSync,
  resolveContained,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";
import { type InvertedIndex, buildIndex, isInvertedIndex } from "@crewhaus/tool-state/bm25";
import { changedAdapters, foldItems, sourceMarks } from "./adapters";
import { type CoverageNote, HarnessRead, type HarnessReadOptions } from "./context";
import type { FoldedItem } from "./model";
import { type IndexedDoc, type SearchDoc, indexedRow, rowsOf, searchProviders } from "./providers";
import { masked } from "./text";
import { foldUsage } from "./usage";

/** The projection's name under `cache/index/`, beside its nudge markers. */
export const KNOWLEDGE_PROJECTION = "knowledge";
export const KNOWLEDGE_INDEX_REL = join(CACHE_INDEX_DIR, KNOWLEDGE_PROJECTION);

/** The most items one index lists. */
export const SHARD_ITEM_CAP = 50_000;
/** What a truncated read offers. */
export const REINDEX_VERB = "crewhaus knowledge reindex";

const SHARD_MAX_BYTES = 512 * 1024 * 1024;
const META_MAX_BYTES = 8 * 1024 * 1024;

/** An item as the index stores it: freshness is the reader's, usage is `usage.json`'s. */
export type StoredItem = Omit<KnowledgeItem, "freshness" | "usage">;

/** How often an item was used, and by how many runs that saw an older version. */
export type StoredUse = {
  readonly runs: number;
  readonly lastUsedAt?: string;
  readonly older?: number;
};

/** One row of `items.jsonl`. */
export type ItemRow = {
  readonly item: StoredItem;
  readonly adapter: string;
  readonly fleet: boolean;
  readonly contentOnly: boolean;
  readonly use?: StoredUse;
};

export type ShardUsage = {
  readonly v: 1;
  readonly recorded: boolean;
  /** By item id, for an item that was used. */
  readonly items: Readonly<Record<string, StoredUse>>;
};

export type ShardMeta = {
  readonly v: 1;
  readonly hrn: string;
  readonly name: string;
  /** When it was built. The one thing that is not a function of the stores. */
  readonly asOf: string;
  /** `adapter → path → size:mtime` of what the index was built from. */
  readonly marks: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly items: number;
  readonly docs: number;
  /** Past the cap: the index does not list everything. */
  readonly truncated: boolean;
  readonly notes: readonly CoverageNote[];
  readonly kinds: readonly string[];
  readonly thredz: "live" | "cached" | "off";
  /** Whether uses could be joined to items when it was built. */
  readonly usageRecorded: boolean;
  /** `file → digest` of the files beside this one. */
  readonly files: Readonly<Record<string, string>>;
};

/** A text's digest as the index names a revision. */
export function revisionOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function shardRel(hrn: string, file = ""): string {
  if (!HARNESS_ID_RE.test(hrn)) throw new TypeError(`knowledge-index: not a harness id: ${hrn}`);
  return join(KNOWLEDGE_INDEX_REL, hrn, file);
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** A fact marked personal, as an index may hold it: where it is, and nothing it says. */
export function contentFree(folded: FoldedItem): StoredItem {
  const { item } = folded;
  return {
    v: 1,
    id: item.id,
    ref: item.ref,
    title: "Personal data",
    scope: item.scope,
    lifecycle: item.lifecycle,
    author: { kind: "unknown" },
    origin: { kind: "unknown" },
    evidence: { status: "not-recorded" },
    tags: [],
    category: "person",
    operations: item.operations,
  };
}

/** The row of one item; a fact marked personal loses its text here, before anything is written. */
export function itemRow(folded: FoldedItem, use?: StoredUse): ItemRow {
  const personal = folded.item.category === "person";
  return {
    item: personal ? contentFree(folded) : folded.item,
    adapter: adapterNameOf(folded.item.ref),
    fleet: folded.fleet,
    contentOnly: folded.titleIsText && !personal,
    ...(use !== undefined && !personal ? { use } : {}),
  };
}

/** What a search finds an item by, or `undefined` for a fact marked personal. */
export function itemDoc(folded: FoldedItem, hrn: string): IndexedDoc | undefined {
  const { item } = folded;
  if (item.category === "person") return undefined;
  const names = folded.titleIsText ? "" : [item.title, ...item.tags].join(" ");
  const status = item.lifecycle === "live" ? (item.status ?? "live") : item.lifecycle;
  const owner =
    item.author.kind === "operator"
      ? { owner: { kind: "member" as const } }
      : item.author.kind === "agent" || item.author.kind === "extractor"
        ? { owner: { kind: "agent" as const } }
        : {};
  const updatedAt = item.updatedAt ?? item.createdAt;
  return {
    doc: {
      kind: item.ref.store === "datasets" ? "dataset" : item.ref.store,
      ref: `${hrn}/knowledge/${item.id}`,
      title: item.title,
      ...(item.preview !== undefined ? { preview: item.preview } : {}),
      status,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      tags: item.tags,
      ...owner,
      store: item.ref.store,
      backend: item.ref.backend,
      item: item.id,
      fleet: folded.fleet,
      contentOnly: folded.titleIsText,
      ...(item.expiresAt !== undefined ? { expiresAt: item.expiresAt } : {}),
    },
    names: masked(names),
    full: masked(folded.text),
  };
}

/** Everything an index of one harness holds, in memory. */
export type ShardContent = {
  readonly rows: readonly ItemRow[];
  readonly docs: readonly IndexedDoc[];
  readonly usage: ShardUsage;
  readonly marks: ShardMeta["marks"];
  readonly notes: readonly CoverageNote[];
  readonly truncated: boolean;
  readonly thredz: ShardMeta["thredz"];
};

/** Fold one harness into what its index holds. Reads only. */
export async function shardContent(
  opts: HarnessReadOptions,
  cap: number = SHARD_ITEM_CAP,
): Promise<ShardContent> {
  // The marks first: a store that changes while it is folded is noticed at the next read.
  const read = new HarnessRead(opts);
  const marks = sourceMarks(read);
  const fold = await foldItems(read);
  const truncated = fold.items.length > cap;
  const items = fold.items.slice(0, cap);
  const usage = await foldUsage(read.dir);
  const used: Record<string, StoredUse> = {};
  for (const folded of items) {
    if (folded.item.category === "person") continue;
    const { runs, lastUsedAt, olderRuns } = await usage.usageOf(folded);
    if (runs === 0) continue;
    used[folded.item.id] = {
      runs,
      ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
      ...(olderRuns.length > 0 ? { older: olderRuns.length } : {}),
    };
  }
  const docs: IndexedDoc[] = items.flatMap((folded) => {
    const doc = itemDoc(folded, read.hrn);
    return doc === undefined ? [] : [doc];
  });
  for (const provider of searchProviders()) {
    for (const row of await rowsOf(provider, read, { canReadContent: true })) {
      docs.push(indexedRow(row));
    }
  }
  return {
    rows: items.map((folded) => itemRow(folded, used[folded.item.id])),
    docs,
    usage: { v: 1, recorded: usage.recorded, items: used },
    marks,
    notes: read.notes(),
    truncated,
    thredz: opts.thredz?.state ?? "off",
  };
}

const ADAPTER_OF_STORE: Readonly<Record<string, string>> = {
  facts: "facts",
  shared: "facts",
  wiki: "wiki",
  focus: "working",
  plans: "working",
  goals: "working",
  requirements: "working",
  sessions: "sessions",
  lessons: "lessons",
  suggestions: "suggestions",
  documents: "documents",
  datasets: "datasets",
  records: "thredz",
  tasks: "thredz",
};

/** The adapter a store of this backend is read by. */
export function adapterNameOf(at: {
  readonly store: string;
  readonly backend: "local" | "thredz";
}): string {
  if (at.backend === "thredz") return "thredz";
  return ADAPTER_OF_STORE[at.store] ?? "facts";
}

export type BuildAnswer =
  | { readonly ok: true; readonly meta: ShardMeta; readonly epoch: string }
  | SafeFsFailure;

/**
 * Build one harness's index and write it under the Home root. The one writer. Each file is
 * replaced whole, `epoch` last; `meta.json` names each file by its digest, so a reader that
 * meets a half-replaced index sees that it does not fit and answers without it.
 */
export async function buildShard(
  opts: HarnessReadOptions & { readonly hangarRoot: string; readonly cap?: number },
): Promise<BuildAnswer> {
  const content = await shardContent(opts, opts.cap);
  const read = new HarnessRead(opts);
  const files: Record<string, string> = {
    "items.jsonl": content.rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
    "docs.jsonl": content.docs.map(({ doc }) => `${JSON.stringify(doc)}\n`).join(""),
    "postings.json": `${JSON.stringify(postingsOf(content.docs))}\n`,
    "usage.json": `${JSON.stringify(content.usage)}\n`,
  };
  const meta: ShardMeta = {
    v: 1,
    hrn: opts.hrn,
    name: read.name,
    asOf: read.now().toISOString(),
    marks: content.marks,
    items: content.rows.length,
    docs: content.docs.length,
    truncated: content.truncated,
    notes: content.notes,
    kinds: searchedKinds(),
    thredz: content.thredz,
    usageRecorded: content.usage.recorded,
    files: Object.fromEntries(
      Object.entries(files).map(([name, text]) => [name, revisionOf(text)]),
    ),
  };
  const { asOf: _asOf, ...fixed } = meta;
  const epoch = revisionOf(JSON.stringify(fixed));
  try {
    // Where Home has not run yet, its folder is made as Home makes it.
    mkdirSync(opts.hangarRoot, { recursive: true, mode: 0o700 });
  } catch {
    // The contained write says why.
  }
  const dir = ensureDirContained(opts.hangarRoot, shardRel(opts.hrn), { mode: 0o700 });
  if (!dir.ok) return dir;
  for (const [name, text] of [
    ...Object.entries(files),
    ["meta.json", `${JSON.stringify(meta)}\n`] as const,
    ["epoch", `${epoch}\n`] as const,
  ]) {
    const written = writeFileSafe(opts.hangarRoot, shardRel(opts.hrn, name), text, {
      overwrite: true,
      mode: 0o600,
    });
    if (!written.ok) return written;
  }
  return { ok: true, meta, epoch };
}

/** Every kind an index can hold. */
export function searchedKinds(): string[] {
  const stores = Object.keys(ADAPTER_OF_STORE).map((s) => (s === "datasets" ? "dataset" : s));
  return [...new Set([...stores, ...searchProviders().map((p) => p.kind)])].sort();
}

export type Postings = {
  readonly v: 1;
  /** The words of names: what a reader who may not read content searches. */
  readonly names: InvertedIndex;
  readonly full: InvertedIndex;
};

/** The term lists of these docs, each doc named by its place. */
export function postingsOf(docs: readonly IndexedDoc[]): Postings {
  const index = (field: "names" | "full"): InvertedIndex =>
    buildIndex(docs.map((doc, i) => ({ id: String(i), text: doc[field] })));
  return { v: 1, names: index("names"), full: index("full") };
}

/** Remove one harness's index. Answers whether there was one. */
export function deleteShard(hangarRoot: string, hrn: string): boolean {
  const at = resolveContained(hangarRoot, shardRel(hrn), { followLeaf: false });
  if (!at.ok) return false;
  try {
    if (!lstatSync(at.real).isDirectory()) return false;
  } catch {
    return false;
  }
  rmSync(at.real, { recursive: true, force: true });
  return true;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type IoTap = { readonly open?: (file: string) => void };
let tap: IoTap = {};

/** Test seam: what an answer opens. Pass `undefined` to restore. */
export function _setShardTapForTest(next: IoTap | undefined): void {
  tap = next ?? {};
}

function readText(hangarRoot: string, hrn: string, name: string, max: number): string | undefined {
  tap.open?.(`${hrn}/${name}`);
  const read = openForReadSync(hangarRoot, shardRel(hrn, name), {
    maxBytes: max,
    followLeafSymlink: false,
  });
  return read.ok && !read.truncated ? read.text : undefined;
}

/** One harness's index, its files read as they are asked for. */
export class Shard {
  readonly meta: ShardMeta;
  readonly epoch: string;
  private readonly hangarRoot: string;

  private constructor(hangarRoot: string, meta: ShardMeta) {
    this.hangarRoot = hangarRoot;
    this.meta = meta;
    const { asOf: _asOf, ...fixed } = meta;
    this.epoch = revisionOf(JSON.stringify(fixed));
  }

  /** The index of `hrn`, or `undefined` when there is none to read. Opens one file. */
  static open(hangarRoot: string, hrn: string): Shard | undefined {
    const text = readText(hangarRoot, hrn, "meta.json", META_MAX_BYTES);
    if (text === undefined) return undefined;
    try {
      const meta = JSON.parse(text) as ShardMeta;
      const shaped =
        meta.v === 1 &&
        meta.hrn === hrn &&
        typeof meta.asOf === "string" &&
        typeof meta.marks === "object" &&
        meta.marks !== null &&
        typeof meta.files === "object" &&
        meta.files !== null &&
        Array.isArray(meta.notes) &&
        Array.isArray(meta.kinds);
      return shaped ? new Shard(hangarRoot, meta) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A file's text when it is the one this index was written with. */
  private file(name: string): string | undefined {
    const text = readText(this.hangarRoot, this.meta.hrn, name, SHARD_MAX_BYTES);
    return text !== undefined && revisionOf(text) === this.meta.files[name] ? text : undefined;
  }

  private rows<T>(name: string): T[] | undefined {
    const text = this.file(name);
    if (text === undefined) return undefined;
    try {
      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as T);
    } catch {
      return undefined;
    }
  }

  items(): ItemRow[] | undefined {
    return this.rows<ItemRow>("items.jsonl");
  }

  docs(): SearchDoc[] | undefined {
    return this.rows<SearchDoc>("docs.jsonl");
  }

  postings(): Postings | undefined {
    const text = this.file("postings.json");
    if (text === undefined) return undefined;
    try {
      const value = JSON.parse(text) as Postings;
      return value.v === 1 && isInvertedIndex(value.names) && isInvertedIndex(value.full)
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }

  usage(): ShardUsage | undefined {
    const text = this.file("usage.json");
    if (text === undefined) return undefined;
    try {
      const value = JSON.parse(text) as ShardUsage;
      return value.v === 1 && typeof value.items === "object" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** The adapters whose stores changed since it was built: a few `stat`s, no file opened. */
  changed(read: HarnessRead): ReadonlySet<string> {
    return changedAdapters(this.meta.marks, read);
  }
}
