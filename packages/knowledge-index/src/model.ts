/**
 * The folded item: what an adapter answers for one thing a harness knows. The item itself,
 * and beside it what only the index needs: the words it is found by, whether a fleet-wide
 * answer may hold it, how run records name it, and where its bytes are.
 */
import {
  type KnowledgeBackend,
  type KnowledgeItem,
  type KnowledgeStore,
  formatKnowledgeId,
} from "@crewhaus/control-contract/knowledge";
import type { HarnessRead } from "./context";
import { previewOf, tagsOf, titleOf } from "./text";

/** A ref as a run record and a usage line name an item. */
export type RecordRef = {
  readonly store: "fact" | "wiki" | "session" | "plan" | "goal" | "focus" | "document";
  readonly backend: KnowledgeBackend;
  readonly spec?: string;
  readonly partition?: string;
  readonly localId: string;
  readonly version?: number | string;
};

export type FoldedItem = {
  /** Freshness and usage are the reader's: a fold has neither. */
  readonly item: Omit<KnowledgeItem, "freshness" | "usage">;
  /** The words it is found by, for a reader who may read content. Never stored as text. */
  readonly text: string;
  /** The whole of what it says, unmasked: a live read for a reader who may read content. */
  readonly body?: string;
  /**
   * Its title is its text, so a reader who may not read content does not get the item at
   * all. Otherwise the title is a name.
   */
  readonly titleIsText: boolean;
  /** False for a customer's item and for one marked personal: never in a fleet-wide answer. */
  readonly fleet: boolean;
  /** How run records name it; absent for a store no run records the use of. */
  readonly record?: RecordRef;
};

/** What an adapter says of one item; the rest is filled in. */
export type ItemDraft = {
  readonly store: KnowledgeStore;
  readonly backend?: KnowledgeBackend;
  readonly spec: string;
  readonly partition?: string;
  readonly localId: string;
  /** Part of the id only where one id names several things (a trash snapshot). */
  readonly idVersion?: number | string;
  readonly title: string;
  readonly titleIsText?: boolean;
  /** What it says. */
  readonly body?: string;
  readonly fleet?: boolean;
  readonly record?: RecordRef;
  readonly tags?: readonly string[];
} & Partial<
  Pick<
    KnowledgeItem,
    | "status"
    | "version"
    | "versions"
    | "createdAt"
    | "updatedAt"
    | "expiresAt"
    | "confidence"
    | "verified"
    | "supersedes"
    | "supersededBy"
    | "correctionOf"
    | "category"
    | "author"
    | "origin"
    | "evidence"
    | "operations"
    | "lifecycle"
  >
>;

/** Where a partition puts an item. */
export function scopeOf(store: KnowledgeStore, partition?: string): KnowledgeItem["scope"] {
  if (store === "shared") return { kind: "shared" };
  if (partition?.startsWith("s.") === true) return { kind: "session", id: partition.slice(2) };
  if (partition?.startsWith("t.") === true) return { kind: "tenant", id: partition.slice(2) };
  return { kind: "spec" };
}

/**
 * The folded item, or `undefined` for one whose names do not fit an item id: it is left out
 * and counted.
 */
export function folded(read: HarnessRead, draft: ItemDraft): FoldedItem | undefined {
  const id = formatKnowledgeId({
    store: draft.store,
    spec: draft.spec,
    ...(draft.partition !== undefined ? { partition: draft.partition } : {}),
    localId: draft.localId,
    ...(draft.idVersion !== undefined ? { version: draft.idVersion } : {}),
  });
  if (id === undefined) {
    read.note(
      "unaddressable",
      draft.store,
      "An item here has a name too long to address, so it is left out.",
    );
    return undefined;
  }
  const body = draft.body ?? "";
  const tags = tagsOf(draft.tags ?? []);
  const { lifecycle, status, version, versions, createdAt, updatedAt, expiresAt } = draft;
  const { confidence, verified, supersedes, supersededBy, correctionOf, category } = draft;
  const tenant = draft.partition?.startsWith("t.") === true;
  return {
    item: {
      v: 1,
      id,
      ref: {
        harness: read.hrn,
        store: draft.store,
        backend: draft.backend ?? "local",
        spec: draft.spec,
        ...(draft.partition !== undefined ? { partition: draft.partition } : {}),
        localId: draft.localId,
        ...(version !== undefined ? { version } : {}),
      },
      title: titleOf(draft.title),
      ...(body !== "" ? { preview: previewOf(body) } : {}),
      scope: scopeOf(draft.store, draft.partition),
      lifecycle: lifecycle ?? "live",
      ...(status !== undefined ? { status } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(versions !== undefined ? { versions } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      author: draft.author ?? { kind: "unknown" },
      origin: draft.origin ?? { kind: "unknown" },
      evidence: draft.evidence ?? { status: "not-recorded" },
      ...(confidence !== undefined ? { confidence } : {}),
      ...(verified !== undefined ? { verified } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
      ...(supersededBy !== undefined ? { supersededBy } : {}),
      ...(correctionOf !== undefined ? { correctionOf } : {}),
      tags,
      ...(category !== undefined ? { category } : {}),
      operations: draft.operations ?? [],
    },
    text: [draft.title, tags.join(" "), body].filter((part) => part !== "").join("\n"),
    ...(draft.body !== undefined ? { body: draft.body } : {}),
    titleIsText: draft.titleIsText === true,
    fleet: draft.fleet !== false && !tenant && category !== "person",
    ...(draft.record !== undefined ? { record: draft.record } : {}),
  };
}

/** An operation that can be done, with the command that does it. */
export function can(op: string, cliTwin: string | null): KnowledgeItem["operations"][number] {
  return { op, supported: true, cliTwin };
}

/** An operation that cannot, and why. */
export function cannot(op: string, reason: string): KnowledgeItem["operations"][number] {
  return { op, supported: false, reason, cliTwin: null };
}

/** A value as one argument of a command line shown to a person. */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@~+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
