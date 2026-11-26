/**
 * `@crewhaus/control-contract/knowledge`: what a harness knows, as every surface names and
 * shows it. The item id and its codec, the item and its usage, and the grant a store checks
 * before it erases a person's data. Types, data and pure functions: nothing here opens a
 * file.
 *
 * An item id is `<store>~<spec>~<partition>~<localId>[@<version>]`. It names where an item
 * lives and never what it says: `localId` is the store's own id, and a lesson or a
 * suggestion that has none is named by a digest.
 *
 * Run records and usage lines name a store in the singular (`fact`, `goal`); an item id
 * names it in the plural (`facts`, `goals`). Both lists and the map between them live here.
 */
import { deepFreeze } from "./util.js";

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/** Every store an item can live in, as an item id names it. */
export const KNOWLEDGE_STORES = deepFreeze([
  "facts",
  "wiki",
  "plans",
  "goals",
  "focus",
  "requirements",
  "sessions",
  "lessons",
  "suggestions",
  "datasets",
  "documents",
  "records",
  "tasks",
  "shared",
] as const);

export type KnowledgeStore = (typeof KNOWLEDGE_STORES)[number];

/** Where an item's bytes are kept. */
export type KnowledgeBackend = "local" | "thredz";

/** The stores a run records the use of, and the word a run record names each by. */
export const RECORD_STORE_OF = deepFreeze({
  facts: "fact",
  wiki: "wiki",
  sessions: "session",
  plans: "plan",
  goals: "goal",
  focus: "focus",
  documents: "document",
} as const);

/** A store as a run record and a usage line name it. */
export type RecordStore = (typeof RECORD_STORE_OF)[keyof typeof RECORD_STORE_OF];

const STORE_OF_RECORD: ReadonlyMap<string, KnowledgeStore> = new Map(
  (Object.entries(RECORD_STORE_OF) as [KnowledgeStore, RecordStore][]).map(([store, word]) => [
    word,
    store,
  ]),
);

/** The store a run record's word names, or `undefined` for a word no record uses. */
export function knowledgeStoreOf(word: unknown): KnowledgeStore | undefined {
  return typeof word === "string" ? STORE_OF_RECORD.get(word) : undefined;
}

/** Whether `store` names a knowledge store. */
export function isKnowledgeStore(store: unknown): store is KnowledgeStore {
  return (KNOWLEDGE_STORES as readonly unknown[]).includes(store);
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * An item's longest id. A ref is at most 200 characters and a qualified item is
 * `hrn_<16 hex>/knowledge/<id>`, which leaves this many for the id. An item whose names are
 * longer is not addressable: an adapter leaves it out and says so.
 */
export const KNOWLEDGE_ID_MAX_LENGTH = 169;

// `ids.ts` builds on the composed areas, which hold this grammar, so the one shape the two
// share is spelled here as well; a test holds it equal.
const SESSION_ID_PATTERN = "sess_[0-9a-f]{16}";
/** A spec's name, or `-` for what belongs to the harness and to no one spec. */
const SPEC = "[A-Za-z0-9_.-]{1,128}";
const NAME = "[A-Za-z0-9_-]{1,64}";
/** The spec's own, a conversation's, a customer's, or a Thredz identity (crew or role) and space. */
const PARTITION = `(?:-|s\\.${SESSION_ID_PATTERN}|t\\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}|c(?:\\.${NAME})?|r\\.${NAME}(?:\\.${NAME})?)`;
/** One spelling per version: a whole number, or a content revision. */
const NUMBER_VERSION = "(?:0|[1-9][0-9]{0,8})";
const VERSION = `(?:${NUMBER_VERSION}|[0-9a-f]{8,16})`;
const HEX_16 = "[0-9a-f]{16}";
const THREDZ_ID = "[A-Za-z0-9_-]{1,64}";

/** Each store's own ids. */
const LOCAL_ID: Readonly<Record<KnowledgeStore, string>> = deepFreeze({
  facts: `mem_${HEX_16}`,
  wiki: `(?:[a-z0-9][a-z0-9-]{0,127}|${THREDZ_ID})`,
  plans: "plan-[0-9]{4,9}",
  goals: `(?:goal-[0-9]{4,9}|${THREDZ_ID})`,
  focus: "focus",
  requirements: "REQ-[0-9]{3,9}",
  sessions: SESSION_ID_PATTERN,
  lessons: `l${HEX_16}`,
  // A drafted spec by its file's name, or a consolidation finding by its digest.
  suggestions: `(?:w\\.[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|d\\.${HEX_16})`,
  datasets: "[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}",
  documents: "[0-9a-f]{12}",
  records: THREDZ_ID,
  tasks: THREDZ_ID,
  shared: `h${HEX_16}`,
});

/**
 * An item id as one regular expression source, unanchored: the grammar of the `knowledge`
 * ref kind. It holds the id to {@link KNOWLEDGE_ID_MAX_LENGTH}.
 */
export const KNOWLEDGE_ID_PATTERN = `(?=.{1,${KNOWLEDGE_ID_MAX_LENGTH}}$)(?:${KNOWLEDGE_STORES.map(
  (store) => `${store}~${SPEC}~${PARTITION}~${LOCAL_ID[store]}`,
).join("|")})(?:@${VERSION})?`;

const ID_RE = new RegExp(`^${KNOWLEDGE_ID_PATTERN}$`);
const NUMBER_VERSION_RE = new RegExp(`^${NUMBER_VERSION}$`);
const HARNESS_RE = /^hrn_[0-9a-f]{16}$/;

/** What an item id names. An absent `partition` is the spec's own (`-`). */
export type KnowledgeIdParts = {
  readonly store: KnowledgeStore;
  readonly spec: string;
  readonly partition?: string;
  readonly localId: string;
  readonly version?: number | string;
};

/** An item, and the harness it belongs to. */
export type KnowledgeItemRef = KnowledgeIdParts & {
  /** `hrn_<16 hex>`. */
  readonly harness: string;
  readonly backend: KnowledgeBackend;
};

/**
 * Print an item id, or `undefined` when a part does not fit its grammar or the whole is
 * longer than {@link KNOWLEDGE_ID_MAX_LENGTH}. Never throws, so an adapter that meets such
 * an item can count it. A version written in digits only reads back as the number it spells.
 */
export function formatKnowledgeId(parts: KnowledgeIdParts): string | undefined {
  const version = parts.version === undefined ? "" : `@${parts.version}`;
  const text = `${parts.store}~${parts.spec}~${parts.partition ?? "-"}~${parts.localId}${version}`;
  return ID_RE.test(text) ? text : undefined;
}

/** Split an item id, or `undefined` when it is not one. */
export function parseKnowledgeId(id: unknown): KnowledgeIdParts | undefined {
  if (typeof id !== "string" || !ID_RE.test(id)) return undefined;
  const [store, spec, partition, rest] = id.split("~") as [KnowledgeStore, string, string, string];
  const at = rest.indexOf("@");
  const localId = at === -1 ? rest : rest.slice(0, at);
  const version = at === -1 ? undefined : rest.slice(at + 1);
  return {
    store,
    spec,
    ...(partition !== "-" ? { partition } : {}),
    localId,
    ...(version !== undefined
      ? { version: NUMBER_VERSION_RE.test(version) ? Number(version) : version }
      : {}),
  };
}

/** The same item without its version: what a list names it by. */
export function unversionedKnowledgeId(id: string): string {
  const at = id.lastIndexOf("@");
  return at === -1 ? id : id.slice(0, at);
}

/** `hrn_<16 hex>/knowledge/<id>`, or `undefined` when either part is malformed. */
export function qualifiedKnowledgeId(harness: string, id: string): string | undefined {
  return HARNESS_RE.test(harness) && ID_RE.test(id) ? `${harness}/knowledge/${id}` : undefined;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const KNOWLEDGE_LIFECYCLES = deepFreeze([
  "live",
  "superseded",
  "expired",
  "archived",
  "cleared",
  "deleted-restorable",
  "retired",
] as const);

export type KnowledgeLifecycle = (typeof KNOWLEDGE_LIFECYCLES)[number];

export type KnowledgeAuthorKind =
  | "agent"
  | "operator"
  | "extractor"
  | "sync"
  | "upstream"
  | "unknown";

export type KnowledgeOriginKind =
  | "conversation"
  | "tool-result"
  | "document"
  | "feedback"
  | "sync"
  | "thredz"
  | "operator"
  | "unknown";

/** One thing a harness knows. A projection: the store that owns the bytes is the only writer. */
export type KnowledgeItem = {
  readonly v: 1;
  readonly id: string;
  readonly ref: KnowledgeItemRef;
  /** Masked. A fact's is its first 80 characters, so it is the fact's text. */
  readonly title: string;
  /** Masked, at most 280 characters; only for a reader who may read content. */
  readonly preview?: string;
  readonly scope: {
    readonly kind: "spec" | "session" | "tenant" | "shared";
    readonly id?: string;
  };
  readonly lifecycle: KnowledgeLifecycle;
  /** The store's own word: `draft`, `in_progress`, `confirmed`; `proposal` for a suggestion. */
  readonly status?: string;
  readonly version?: number | string;
  readonly versions?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
  readonly author: {
    readonly kind: KnowledgeAuthorKind;
    readonly actor?: string;
    readonly session?: string;
    readonly agentIdentity?: string;
    readonly via?: string;
    readonly cmd?: string;
  };
  readonly origin: {
    readonly kind: KnowledgeOriginKind;
    readonly session?: string;
    readonly toolUseIds?: readonly string[];
    readonly sources?: readonly string[];
    readonly fromHarness?: string;
  };
  readonly evidence: {
    readonly status: "available" | "evicted" | "frozen" | "not-recorded";
    readonly evictsAt?: string;
    readonly evictedAt?: string;
  };
  /** Articles and datasets only: a fact has none. */
  readonly confidence?: number;
  readonly verified?: boolean;
  readonly supersedes?: string;
  readonly supersededBy?: string;
  readonly correctionOf?: string;
  readonly tags: readonly string[];
  /** Marked as about a person: never in a shared store or a fleet result. */
  readonly category?: "person";
  readonly usage?: KnowledgeUsage;
  readonly freshness: { readonly asOf: string; readonly stale: boolean };
  readonly operations: readonly KnowledgeOperation[];
};

/** One thing a reader may do with an item. `cliTwin` is a real command, or `null`. */
export type KnowledgeOperation = {
  readonly op: string;
  readonly supported: boolean;
  readonly reason?: string;
  readonly cliTwin: string | null;
  readonly needs?: string;
};

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** How often an item was used. `recorded: false` says nothing was recorded, not that nothing happened. */
export type KnowledgeUsage = {
  readonly runs: number;
  readonly lastUsedAt?: string;
  readonly recorded: boolean;
};

/** Why a run's use of knowledge is not on record. */
export const KNOWLEDGE_NOT_RECORDED_REASONS = deepFreeze([
  "no-usage-log",
  "evicted",
  "none-seen",
] as const);

export type KnowledgeNotRecordedReason = (typeof KNOWLEDGE_NOT_RECORDED_REASONS)[number];

/** One item one run used, by its keyed digest, and by its ref when the item is still known. */
export type KnowledgeRunUse = {
  readonly item: string;
  readonly store: KnowledgeStore;
  readonly backend: KnowledgeBackend;
  readonly id?: string;
  readonly version?: number | string;
  readonly via: "recall" | "tool" | "tail" | "retrieve";
  readonly status: "included" | "warned" | "redacted" | "split-redacted";
  readonly at: string;
};

/** What one run used. A run with no line is `not-recorded`, and says why: never "used nothing". */
export type KnowledgeRunUsage =
  | { readonly state: "used"; readonly items: readonly KnowledgeRunUse[] }
  | { readonly state: "not-recorded"; readonly reason: KnowledgeNotRecordedReason };

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/** The stores that can erase a person's data. */
export const ERASURE_STORES = deepFreeze([
  "memory",
  "wiki",
  "continuity",
  "trash",
  "summaries",
  "shared",
] as const);

export type ErasureStore = (typeof ERASURE_STORES)[number];

/** What one store may erase: its own root, its spec where it has one, and each target by name. */
export type ErasureScope = {
  readonly store: ErasureStore;
  /** The store's own root directory. */
  readonly root: string;
  readonly spec?: string;
  /** Fact ids, article slugs, session ids, trash stamps or content hashes. */
  readonly targets: readonly string[];
};

/**
 * The right to run one erasure plan. The erasure door mints it after its checks; a store's
 * purge acts only on a target the scope of its own root names ({@link erasureTargets}).
 */
export type ErasureGrant = {
  /** The plan it was minted for. */
  readonly nonce: string;
  readonly digest: string;
  readonly scopes: readonly ErasureScope[];
};

/**
 * The targets `grant` names for this store at this root, or `undefined` when it names none.
 * `sameRoot` says whether a scope's root is the store's own, links resolved: this package
 * opens no file.
 */
export function erasureTargets(
  grant: ErasureGrant,
  at: {
    readonly store: ErasureStore;
    readonly spec?: string;
    readonly sameRoot: (root: string) => boolean;
  },
): ReadonlySet<string> | undefined {
  const scopes = grant.scopes.filter(
    (scope) => scope.store === at.store && scope.spec === at.spec && at.sameRoot(scope.root),
  );
  if (scopes.length === 0) return undefined;
  return new Set(scopes.flatMap((scope) => scope.targets));
}
