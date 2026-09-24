/**
 * `VectorDelete`'s seam: the vector store it deletes from, the selection it
 * runs against that store, and the two observations it is able to make.
 *
 * WHY THIS IS ITS OWN MODULE. Every other tool in this package touches files
 * under the workspace and nothing else — `index.ts` says so, and
 * `index.test.ts` asserts `scope: "internal"` with no `ioCapability` for all
 * twenty members of `STATE_TOOLS`. A vector store is not that: one interface
 * covers an in-process Map, a file-backed lance index and an HTTP collection
 * on qdrant, pinecone or weaviate. `VectorDelete` therefore declares
 * `scope: "external"` + `ioCapability: "network"`, and is deliberately NOT a
 * member of `STATE_TOOLS` — that list's membership is exactly what the
 * no-boundary test checks, and a list that quietly stopped meaning what it
 * says would be worse than no test at all. `VECTOR_TOOLS` holds it instead.
 *
 * WHY NOTHING HERE IMPORTS `@crewhaus/vector-store`. {@link VectorDeleteTarget}
 * is the structural slice of that package's `VectorStore` a delete needs, and
 * every store it builds already satisfies it — so the tool costs this package
 * no new runtime dependency. The price is that the store must be handed in by
 * whoever built it ({@link registerVectorTarget}, the seam
 * `@crewhaus/tool-retrieve` already uses as `registerRetrieveConfig`): nothing
 * here can construct a store from a backend name. There is deliberately NO
 * ambient fallback — with nothing registered the tool refuses, because an
 * implicit empty in-process store would let a right-to-erasure call report a
 * clean success having deleted nothing at all.
 *
 * WHAT CANNOT BE KNOWN HERE, and so is never claimed. The store interface
 * exposes neither `exists` nor `get`, so per-id truth is unobtainable: a
 * `delete(id)` that resolves means the store ACCEPTED the request, not that
 * the id was there or that the vector is now gone. Every name below says
 * "attempted" or "acknowledged" for that reason, and there is no
 * deleted/missing split anywhere — a caller erasing someone's data on legal
 * request has to be able to read this result without being misled by it.
 * `count()` is not a way round that either: on the HTTP backends it is
 * eventually consistent, so a count taken immediately after a delete can
 * equal the one before it for deletes that did land.
 */
import { CrewhausError } from "@crewhaus/errors";
import { createVectorStore } from "@crewhaus/vector-store";
import { compareStrings, validateKey } from "./lib/names";

/** Most ids one call takes. Bounds the work, and the result, per call. */
export const MAX_VECTOR_IDS = 1_000;

/** Most entries echoed back in the `idsRejected` / `deletesErrored` lists. */
const MAX_LISTED = 20;

/** Longest store-error message carried into a result. A failing HTTP backend
 *  can hand back a whole error page, and a result is a model's context. */
const MAX_STORE_ERROR_CHARS = 200;

/** Longest id echoed back in a rejection. A rejected id is DISPLAY ONLY — it
 *  is never the thing acted on — so truncating it here cannot mis-target a
 *  delete, while echoing a 100 kB id would cost the caller its whole context. */
const MAX_REJECTED_ID_CHARS = 80;

/**
 * The slice of a vector store a delete needs.
 *
 * Structural on purpose: `@crewhaus/vector-store`'s `VectorStore` satisfies it
 * as it stands, and a test satisfies it with a Map — no network, no fixtures,
 * no dependency. `backend` is the store's own self-report and may be absent;
 * it is used for display and for one fail-closed default, never as proof of
 * anything.
 */
export type VectorDeleteTarget = {
  readonly backend?: string;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
};

/** Whether `count()` on this backend reads back a write it just made. */
export type VectorCountConsistency = "immediate" | "eventual";

/**
 * What the host registers at boot.
 *
 * `collection` is the name the store is bound to. It is an ASSERTION by the
 * host — the store interface exposes no way to ask — which is precisely why
 * {@link checkCollection} refuses rather than guesses when it is absent and a
 * protection list is in play.
 */
export type VectorTargetRegistration = {
  readonly store: VectorDeleteTarget;
  readonly collection?: string;
  /** Operator-side protection list, unioned with the caller's. */
  readonly protectedCollections?: readonly string[];
  readonly countConsistency?: VectorCountConsistency;
};

/** Raised when the registration itself is unusable. */
export class VectorTargetError extends CrewhausError {
  override readonly name = "VectorTargetError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

let activeTarget: VectorTargetRegistration | undefined;

/**
 * Replace the registered vector store. The host calls this at boot with the
 * store it already built for retrieval, so a delete and a search address the
 * same collection.
 *
 * The shape is checked HERE rather than at the first call: a missing method
 * discovered during an erasure request is discovered at the worst moment. The
 * SAME argument covers the other three fields, which is why they are checked
 * here too rather than trusted to the type: `collection` and
 * `protectedCollections` are the whole of the gate, and `countConsistency`
 * decides how strong a claim the result makes. Each of them used to fail
 * OPEN when it was not what it said it was — see the three refusals below.
 */
export function registerVectorTarget(registration: VectorTargetRegistration): void {
  const store = registration?.store as VectorDeleteTarget | undefined;
  if (
    store === undefined ||
    typeof store.delete !== "function" ||
    typeof store.count !== "function"
  ) {
    throw new VectorTargetError(
      "registerVectorTarget needs a store with delete(id) and count() — pass the same VectorStore the retriever uses",
    );
  }
  const { collection, protectedCollections, countConsistency } = registration;
  // An empty or non-string name is not a name. Read as one it was worse than
  // absent: `collection: ""` is `!== undefined`, so the gate called the
  // collection KNOWN, compared "" against the protection list, matched
  // nothing and allowed the delete — where an absent name would have refused.
  // A non-string one got as far as `collection.toLowerCase()` and threw a
  // TypeError out of `execute` mid-erasure.
  if (collection !== undefined && (typeof collection !== "string" || collection.length === 0)) {
    throw new VectorTargetError(
      `registerVectorTarget's \`collection\` must be a non-empty string when given, not ${describeStoreValue(collection)} — a name the gate cannot compare must be omitted, so that it refuses instead of passing`,
    );
  }
  // NOT a truthiness check, and not `for (const x of list)` either: a bare
  // string is iterable, so `protectedCollections: "audit"` spread into
  // ["a","u","d","i","t"] and left "audit" itself unprotected — a deny-list
  // silently replaced by one that denies nothing it names.
  if (
    protectedCollections !== undefined &&
    (!Array.isArray(protectedCollections) ||
      protectedCollections.some((name) => typeof name !== "string" || name.length === 0))
  ) {
    throw new VectorTargetError(
      "registerVectorTarget's `protectedCollections` must be an array of non-empty strings — a bare string is read one character at a time and protects nothing it names",
    );
  }
  // Anything but the two known words used to come out as `=== "eventual"` is
  // false, i.e. as the STRONGER claim: a typo made `countAfter` sound
  // authoritative on qdrant. An unreadable setting is not the confident one.
  if (
    countConsistency !== undefined &&
    countConsistency !== "immediate" &&
    countConsistency !== "eventual"
  ) {
    throw new VectorTargetError(
      `registerVectorTarget's \`countConsistency\` must be "immediate" or "eventual", not ${describeStoreValue(countConsistency)}`,
    );
  }
  activeTarget = registration;
}

/** The spec's `tool_config.vectorDelete` block: which store to delete from. */
export type VectorDeleteConfigInput = {
  readonly backend?: unknown;
  readonly url?: unknown;
  readonly collection?: unknown;
  readonly api_key?: unknown;
  readonly apiKey?: unknown;
  readonly protected_collections?: unknown;
  readonly protectedCollections?: unknown;
  readonly count_consistency?: unknown;
  readonly countConsistency?: unknown;
};

/** Backends a delete can reach. An in-process store starts empty in every process. */
const DELETE_BACKENDS = ["qdrant", "pinecone", "weaviate", "lance"] as const;

/** What a spec writes to give VectorDelete a store — quoted by every refusal about it. */
export const VECTOR_DELETE_EXAMPLE =
  "tool_config.vectorDelete: { backend: qdrant, url: https://qdrant.example:6333, collection: chunks, api_key: $QDRANT_API_KEY }";

function oneOf(block: Record<string, unknown>, snake: string, camel: string): unknown {
  const a = Object.hasOwn(block, snake);
  const b = Object.hasOwn(block, camel);
  if (a && b) {
    throw new VectorTargetError(
      `tool_config.vectorDelete sets both ${snake} and ${camel}. Write it once, as ${snake}.`,
    );
  }
  return a ? block[snake] : block[camel];
}

/**
 * Deliver the spec's block at boot: build the named store and register it,
 * with the block's protection list. The api key is read from the environment
 * when written `$VAR`, like every tool_config credential.
 *
 * A block without `backend` registers nothing, so the tool keeps refusing and
 * says what to write — the same as a spec with no block. `in-memory` is
 * refused: a store that starts empty in this process holds nothing to erase,
 * and a delete from it would report a clean success having deleted nothing.
 */
export function registerVectorDeleteConfig(input: VectorDeleteConfigInput): void {
  const block = (input ?? {}) as Record<string, unknown>;
  const backend = block["backend"];
  if (backend === undefined) return;
  if (
    typeof backend !== "string" ||
    !(DELETE_BACKENDS as ReadonlyArray<string>).includes(backend)
  ) {
    throw new VectorTargetError(
      `tool_config.vectorDelete.backend must be one of ${DELETE_BACKENDS.join(", ")}, not ${describeStoreValue(backend)}${backend === "in-memory" ? " — an in-memory store starts empty in every process, so there is nothing in it to delete" : ""}. For example: ${VECTOR_DELETE_EXAMPLE}`,
    );
  }
  const url = block["url"];
  const collection = block["collection"];
  const apiKey = oneOf(block, "api_key", "apiKey");
  for (const [name, value] of [
    ["url", url],
    ["collection", collection],
    ["api_key", apiKey],
  ] as const) {
    if (value !== undefined && typeof value !== "string") {
      throw new VectorTargetError(`tool_config.vectorDelete.${name} must be a string.`);
    }
  }
  const store = createVectorStore({
    backend: backend as (typeof DELETE_BACKENDS)[number],
    ...(url !== undefined ? { url: url as string } : {}),
    ...(collection !== undefined ? { collection: collection as string } : {}),
    ...(apiKey !== undefined ? { apiKey: apiKey as string } : {}),
  });
  const protectedCollections = oneOf(block, "protected_collections", "protectedCollections");
  const countConsistency = oneOf(block, "count_consistency", "countConsistency");
  registerVectorTarget({
    store,
    ...(collection !== undefined ? { collection: collection as string } : {}),
    ...(protectedCollections !== undefined
      ? { protectedCollections: protectedCollections as readonly string[] }
      : {}),
    ...(countConsistency !== undefined
      ? { countConsistency: countConsistency as VectorCountConsistency }
      : {}),
  });
}

export function getVectorTarget(): VectorTargetRegistration | undefined {
  return activeTarget;
}

/** Test-only — back to "nothing registered", which is the shipped default. */
export function _resetVectorTarget(): void {
  activeTarget = undefined;
}

/**
 * Backends whose `count()` reads back its own writes. Everything else —
 * qdrant, pinecone, weaviate, lance, and any store that does not name itself —
 * falls through to "indicative", which is the fail-closed answer: claiming a
 * count is authoritative when it is not is the overclaim this tool exists to
 * avoid.
 */
const IMMEDIATE_COUNT_BACKENDS: ReadonlySet<string> = new Set(["in-memory"]);

/**
 * The store's self-reported backend NAME, or `undefined` when it did not give
 * one. Only a non-empty string is a name: a store whose `backend` is an
 * object has not named itself, and `undefined` is the honest reading of that.
 *
 * One function, so the name the result REPORTS and the name
 * {@link countIsIndicative} DECIDES on are the same reading of the same field.
 */
function backendName(store: VectorDeleteTarget): string | undefined {
  const backend = store.backend;
  return typeof backend === "string" && backend.length > 0 ? backend : undefined;
}

/** Longest backend name echoed into a result. Display only — the decision in
 *  {@link countIsIndicative} uses the whole name, so a long one cannot be
 *  truncated into a match for a shorter one. */
const MAX_BACKEND_CHARS = 60;

/** The backend name for the result, bounded, or `"unknown"`. */
export function describeBackend(store: VectorDeleteTarget): string {
  const name = backendName(store);
  if (name === undefined) return "unknown";
  return name.length > MAX_BACKEND_CHARS ? `${name.slice(0, MAX_BACKEND_CHARS)}…` : name;
}

/** Is `countAfter` indicative only? An explicit registration wins over the
 *  backend name, which is only a self-report. */
export function countIsIndicative(registration: VectorTargetRegistration): boolean {
  if (registration.countConsistency !== undefined) {
    // Written as "anything that is not the word `immediate`", never as
    // `=== "eventual"`: a target built without going through
    // `registerVectorTarget` can still carry a typo, and the typo must come
    // out as the CAUTIOUS answer. `=== "eventual"` gave the confident one.
    return registration.countConsistency !== "immediate";
  }
  const backend = backendName(registration.store);
  return backend === undefined || !IMMEDIATE_COUNT_BACKENDS.has(backend);
}

// --- ids --------------------------------------------------------------------

/** A chunk id taken apart. `@crewhaus/chunker` builds `docId:index:start`. */
export type ChunkId = {
  readonly docId: string;
  readonly index: number;
  readonly startOffset: number;
};

/** A non-negative decimal integer, and nothing else.
 *
 *  `Number.parseInt` would read "12abc" as 12 and "0x10" as 0 — it stops at
 *  the first character it cannot use, which turns a malformed id into a
 *  plausible one. This refuses the whole string instead. */
function parseNonNegativeInt(text: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Parse a chunk id, or `undefined` when it is not one.
 *
 * Read from the RIGHT. A docId is routinely a URL or a path
 * (`https://example.com/a:0:400`, `C:\docs\x.md:3:120`), so it contains
 * colons of its own: splitting on the first colon, or demanding exactly three
 * colon-separated fields, mis-parses those ids. The survey sketch this tool
 * came from specified that naive split; the two numeric fields are the LAST
 * two, and everything before them is the docId.
 */
export function parseChunkId(id: string): ChunkId | undefined {
  const last = id.lastIndexOf(":");
  if (last <= 0) return undefined;
  const prev = id.lastIndexOf(":", last - 1);
  if (prev <= 0) return undefined;
  const index = parseNonNegativeInt(id.slice(prev + 1, last));
  const startOffset = parseNonNegativeInt(id.slice(last + 1));
  if (index === undefined || startOffset === undefined) return undefined;
  return { docId: id.slice(0, prev), index, startOffset };
}

export type RejectedVectorId = { readonly id: string; readonly reason: string };

export type VectorSelection = {
  /** Exactly the strings `delete()` will receive — byte for byte. */
  readonly ids: readonly string[];
  readonly rejected: readonly RejectedVectorId[];
  readonly duplicatesCollapsed: number;
};

/**
 * Turn the caller's `ids` into the selection a run acts on. The dry run and
 * the real run call THIS — there is no second, kinder preview path, which is
 * how a dry run ends up predicting something the real run will not do.
 *
 * Nothing is trimmed, case-folded or otherwise normalised. A store may hold an
 * id with a trailing space; "delete a near-miss of what you asked for" is not
 * a thing an erasure tool may do, so the id validated is the id deleted and
 * the id reported.
 */
export function selectVectorIds(
  ids: readonly string[],
  opts: { readonly requireChunkIdShape: boolean },
): VectorSelection {
  const seen = new Set<string>();
  const kept: string[] = [];
  const rejected: RejectedVectorId[] = [];
  let duplicatesCollapsed = 0;

  for (const id of ids) {
    const bad = validateKey("id", id);
    if (bad !== undefined) {
      rejected.push({ id: previewId(id), reason: bad });
      continue;
    }
    if (opts.requireChunkIdShape && parseChunkId(id) === undefined) {
      rejected.push({
        id: previewId(id),
        reason: "not a '<docId>:<index>:<startOffset>' chunk id",
      });
      continue;
    }
    if (seen.has(id)) {
      duplicatesCollapsed += 1;
      continue;
    }
    seen.add(id);
    kept.push(id);
  }

  // Sorted, so a half-finished run is reproducible and resumable: the same
  // input always attempts the same ids in the same order. Plain code-unit
  // order, never `localeCompare`, like every other listing in this package.
  kept.sort(compareStrings);
  return { ids: kept, rejected, duplicatesCollapsed };
}

function previewId(id: string): string {
  return id.length > MAX_REJECTED_ID_CHARS ? `${id.slice(0, MAX_REJECTED_ID_CHARS)}…` : id;
}

// --- the collection gate ----------------------------------------------------

export type GateRefusalCode = "protected-collection" | "collection-unknown" | "collection-mismatch";

export type GateRefusal = { readonly code: GateRefusalCode; readonly message: string };

/**
 * The one gate, run ONCE before anything is deleted.
 *
 * Per-id would be worse than useless: a refusal on the fourth of ten ids
 * leaves three deleted and a dry run that predicted none of it. So this
 * answers before the first `delete()` — before the store is touched at all —
 * and a refusal means nothing happened.
 *
 * Two fail-closed rules:
 *
 *   - An UNKNOWN collection with a protection list is a refusal, not a pass.
 *     "Could not determine" is not "no": if the host did not say which
 *     collection the store is bound to, this cannot prove it is not the
 *     protected one.
 *   - A name that matches a protected one except in case is refused as
 *     protected. Collection names are case-sensitive on the real backends, so
 *     `Chunks` and `chunks` are different collections — but a protection list
 *     that misses by a capital letter is a config slip whose cost is deleted
 *     data, while a needless refusal costs one edit.
 */
export function checkCollection(args: {
  readonly collection: string | undefined;
  readonly protectedCollections: readonly string[];
  readonly expectCollection: string | undefined;
}): GateRefusal | undefined {
  const { collection, protectedCollections, expectCollection } = args;

  if (expectCollection !== undefined) {
    if (collection === undefined) {
      return {
        code: "collection-unknown",
        message: `the registered store declares no collection, so it cannot be confirmed to be "${expectCollection}"`,
      };
    }
    if (collection !== expectCollection) {
      return {
        code: "collection-mismatch",
        message: `the registered store is bound to "${collection}", not the "${expectCollection}" you expected`,
      };
    }
  }

  if (protectedCollections.length === 0) return undefined;

  if (collection === undefined) {
    return {
      code: "collection-unknown",
      message:
        "the registered store declares no collection, so it cannot be shown not to be one of the protected ones — register the store with its collection name, or drop the protection list",
    };
  }
  if (protectedCollections.includes(collection)) {
    return { code: "protected-collection", message: `"${collection}" is a protected collection` };
  }
  const nearMiss = protectedCollections.find(
    (name) => name.toLowerCase() === collection.toLowerCase(),
  );
  if (nearMiss !== undefined) {
    return {
      code: "protected-collection",
      message: `"${collection}" differs only in case from the protected "${nearMiss}" — refused rather than guessed; make the two agree`,
    };
  }
  return undefined;
}

// --- the operator's own protection list -------------------------------------

export type ToolConfigRead =
  | { readonly ok: true; readonly protectedCollections: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * The per-call `tool_config.vectorDelete` block, when a serving profile
 * declares one (0.6.0 §4.4, the seam `@crewhaus/tool-fetch` reads the same
 * way). Both spellings of the key are accepted so a spec block can be passed
 * verbatim.
 *
 * It differs from tool-fetch's block in one way, on purpose: fetch's is an
 * ALLOW-list and REPLACES the registered one, while this is a DENY-list and is
 * UNIONED with the registration's and the caller's. Replacing a deny-list
 * would let a narrower block widen what may be deleted, which is the wrong
 * direction for a gate whose failure costs data.
 *
 * A malformed block is a refusal, never a silent empty list — an unreadable
 * policy is not an absent policy.
 */
export function readVectorToolConfig(override: unknown): ToolConfigRead {
  if (override === undefined || override === null) return { ok: true, protectedCollections: [] };
  if (typeof override !== "object" || Array.isArray(override)) {
    return { ok: false, reason: "tool_config for VectorDelete is not an object" };
  }
  const block = override as Record<string, unknown>;
  // BOTH spellings are read, each is validated on its own, and the two are
  // UNIONED. Reading only the camelCase one when both were present — which is
  // what this did first — silently dropped the `protected_collections` list a
  // verbatim spec block carried beside it, and deleted from the collection
  // that list named. Accepting two spellings and acting on one is the
  // validate-here-act-there shape, in the one place here that costs data.
  const names: string[] = [];
  for (const key of ["protectedCollections", "protected_collections"] as const) {
    // Keyed on PRESENCE, not on truthiness: a block that carries the key with
    // a null or undefined value has said something unreadable about the
    // policy, and reading that as "no policy" is the weakening this whole
    // function is here to prevent.
    if (!Object.hasOwn(block, key)) continue;
    const raw = block[key];
    if (!Array.isArray(raw) || raw.some((name) => typeof name !== "string" || name.length === 0)) {
      return {
        ok: false,
        reason: `tool_config.${key} is not a list of non-empty collection names`,
      };
    }
    names.push(...(raw as string[]));
  }
  return { ok: true, protectedCollections: names };
}

// --- the two things that can actually be observed ---------------------------

export type CountObservation = { readonly count: number | null; readonly error?: string };

/**
 * One `count()`, as an observation that may have failed.
 *
 * A failed count comes back as `null` WITH a reason, never as 0: "I could not
 * read the count" and "the collection is empty" are opposite answers, and a
 * caller reading a fabricated 0 would conclude the erasure was complete.
 */
export async function observeCount(store: VectorDeleteTarget): Promise<CountObservation> {
  try {
    const value = await store.count();
    if (typeof value !== "number" || !Number.isFinite(value)) {
      // Rendered BOUNDED, like every other store-controlled string here: a
      // backend that answers `count()` with a parsed error page put all of it
      // — 50 kB in the case that found this — straight into the result, and a
      // result is a model's context.
      return { count: null, error: `count() returned ${describeStoreValue(value)}` };
    }
    return { count: value };
  } catch (err) {
    return { count: null, error: describeStoreError(err) };
  }
}

export type VectorDeleteError = { readonly id: string; readonly error: string };

export type VectorApplyOutcome = {
  readonly attempted: number;
  /** `delete()` resolved. The store accepted the request — no more than that. */
  readonly acknowledged: number;
  readonly errors: readonly VectorDeleteError[];
  readonly halted: boolean;
};

/**
 * Delete each selected id, one at a time, in the selection's order.
 *
 * Sequential rather than `Promise.all`: the order has to be the sorted one for
 * a partial run to be resumable, `attempted` has to mean "these ones, up to
 * here", and a thousand parallel requests is not a thing to do to somebody's
 * qdrant during an erasure.
 *
 * An id whose `delete()` throws is recorded and the run CONTINUES. A caller
 * erasing data on request wants the other nine ids attempted, not abandoned
 * because the fourth timed out — and the error is reported per id, so nothing
 * is hidden. Note what the error does NOT mean: a request that failed after
 * reaching the backend may still have deleted the vector.
 */
export async function applyVectorDeletes(
  store: VectorDeleteTarget,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<VectorApplyOutcome> {
  let attempted = 0;
  let acknowledged = 0;
  const errors: VectorDeleteError[] = [];
  for (const id of ids) {
    // Checked between deletes, never mid-request: an abort stops the run and
    // the result says where it stopped, rather than reporting a clean finish
    // over a list that was never attempted.
    if (signal?.aborted === true) {
      return { attempted, acknowledged, errors, halted: true };
    }
    attempted += 1;
    try {
      await store.delete(id);
      acknowledged += 1;
    } catch (err) {
      errors.push({ id, error: describeStoreError(err) });
    }
  }
  return { attempted, acknowledged, errors, halted: false };
}

/** A store failure as one readable, bounded line. */
export function describeStoreError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "the store threw a value carrying no message";
  return flat.length > MAX_STORE_ERROR_CHARS ? `${flat.slice(0, MAX_STORE_ERROR_CHARS)}…` : flat;
}

/**
 * A value the store (or the host) handed over, as one bounded line — for
 * saying what arrived when what arrived was the wrong thing.
 *
 * Neither shortcut is safe alone: `JSON.stringify` returns `undefined` for
 * `undefined`, a function or a symbol, and THROWS on a BigInt; `String()`
 * throws on a symbol. So the type name is the fallback, and nothing here can
 * itself fail while describing a failure.
 */
export function describeStoreValue(value: unknown): string {
  if (value === undefined) return "undefined";
  let raw: string;
  try {
    raw = JSON.stringify(value) ?? typeof value;
  } catch {
    raw = typeof value === "bigint" ? `${value}n` : typeof value;
  }
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return typeof value;
  return flat.length > MAX_STORE_ERROR_CHARS ? `${flat.slice(0, MAX_STORE_ERROR_CHARS)}…` : flat;
}

/** Union of the three protection lists, de-duplicated and sorted. */
export function unionProtected(
  ...lists: ReadonlyArray<readonly string[] | undefined>
): readonly string[] {
  const all = new Set<string>();
  for (const list of lists) {
    for (const name of list ?? []) all.add(name);
  }
  return [...all].sort(compareStrings);
}

/** Cap a reported list, saying so rather than silently shortening it. */
export function capList<T>(items: readonly T[]): { listed: readonly T[]; truncated: boolean } {
  return items.length > MAX_LISTED
    ? { listed: items.slice(0, MAX_LISTED), truncated: true }
    : { listed: items, truncated: false };
}
