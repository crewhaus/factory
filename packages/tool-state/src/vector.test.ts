/**
 * `VectorDelete`, against fake stores.
 *
 * No network and no fixtures: the tool talks to a store through a structural
 * interface, so a Map behind three methods is the real thing as far as it is
 * concerned. Nothing here reads `process.platform`, the clock, or the
 * filesystem — and with no store registered the tool refuses, which is the
 * shipped default and the one a forgotten seam produces identically on every
 * machine.
 *
 * What is being tested is mostly what the tool REFUSES to claim: the honesty
 * of the wording is the whole feature.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { auditToolScopes } from "@crewhaus/tool-builder";
import {
  STATE_TOOLS,
  VECTOR_TOOLS,
  VectorTargetError,
  _resetVectorTarget,
  parseChunkId,
  registerVectorTarget,
  selectVectorIds,
  vectorDelete,
} from "./index";
import type { VectorDeleteTarget } from "./index";
import {
  checkCollection,
  countIsIndicative,
  describeStoreError,
  readVectorToolConfig,
  unionProtected,
} from "./vector";

/** A store that records every call, so a test can prove what was NOT called. */
class FakeStore implements VectorDeleteTarget {
  readonly deleted: string[] = [];
  countCalls = 0;
  /** Ids whose `delete` throws, and with what. */
  readonly failures = new Map<string, Error>();
  /** When set, `count()` throws this instead of answering. */
  countError?: Error;
  /** When true, `count()` keeps answering the first value — an eventually
   *  consistent backend that has not caught up with the deletes yet. */
  stale = false;

  constructor(
    readonly entries: Set<string>,
    readonly backend: string | undefined,
  ) {}

  async delete(id: string): Promise<void> {
    const failure = this.failures.get(id);
    if (failure !== undefined) throw failure;
    this.deleted.push(id);
    this.entries.delete(id);
  }

  async count(): Promise<number> {
    this.countCalls += 1;
    if (this.countError !== undefined) throw this.countError;
    return this.stale ? this.entries.size + this.deleted.length : this.entries.size;
  }
}

/** `null` means a store that does not name its backend — distinct from
 *  "omitted", which a default parameter could not tell apart. */
function store(ids: string[], backend: string | null = "in-memory"): FakeStore {
  return new FakeStore(new Set(ids), backend ?? undefined);
}

// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(input: unknown, ctx?: unknown): Promise<any> {
  const out = await vectorDelete.execute(input, ctx as never);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

beforeEach(() => {
  _resetVectorTarget();
});

afterEach(() => {
  _resetVectorTarget();
});

// ---------------------------------------------------------------------------

describe("the tool's own labels", () => {
  test("it is a destructive, network-scoped tool, and the audit agrees", () => {
    expect({
      destructive: vectorDelete.destructive,
      readOnly: vectorDelete.readOnly,
      scope: vectorDelete.scope,
      io: vectorDelete.ioCapability,
      justify: vectorDelete.requireJustification,
      concurrencySafe: vectorDelete.concurrencySafe,
    }).toEqual({
      destructive: true,
      readOnly: false,
      scope: "external",
      io: "network",
      justify: true,
      concurrencySafe: false,
    });
    expect(auditToolScopes(VECTOR_TOOLS)).toEqual([]);
  });

  test("it is NOT a member of STATE_TOOLS, whose promise it cannot keep", () => {
    expect(STATE_TOOLS.map((tool) => tool.name)).not.toContain("VectorDelete");
    expect(VECTOR_TOOLS.map((tool) => tool.name)).toEqual(["VectorDelete"]);
  });

  test("it follows the package's naming and description conventions", () => {
    expect(vectorDelete.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
    expect(vectorDelete.description.split(". ")[1]?.slice(0, 4)).toBe("Use ");
    expect(vectorDelete.inputSchema.safeParse(42).success).toBe(false);
  });
});

describe("with nothing registered", () => {
  test("it refuses rather than inventing an empty store to succeed against", async () => {
    const out = await run({ ids: ["a"] });
    expect(out).toContain("no vector store registered");
    expect(out).toContain("Nothing was deleted");
  });

  test("a registration missing the methods is refused at boot, not at erasure", () => {
    expect(() => registerVectorTarget({ store: {} as VectorDeleteTarget })).toThrow(
      VectorTargetError,
    );
    // biome-ignore lint/suspicious/noExplicitAny: the point is a wrong shape.
    expect(() => registerVectorTarget({ store: { delete: 1 } as any })).toThrow(VectorTargetError);
  });

  // Found by review. Only the two methods were checked, and each of the other
  // three fields failed OPEN when it was not what it said it was — so each is
  // now refused at boot for the reason the methods already were.
  test("a protection list that is a bare string is refused, not spread letter by letter", async () => {
    const fake = store(["a"]);
    expect(() =>
      registerVectorTarget({
        store: fake,
        collection: "audit",
        // biome-ignore lint/suspicious/noExplicitAny: a host reading a config file supplies this.
        protectedCollections: "audit" as any,
      }),
    ).toThrow(VectorTargetError);
    // The reason it may not be accepted: "audit" iterates to five letters, none
    // of which is "audit", so the protected collection would be deleted from.
    expect(unionProtected(["a", "u", "d", "i", "t"])).not.toContain("audit");
    // Nothing was registered, so the tool refuses rather than running unguarded.
    expect(await run({ ids: ["a"] })).toContain("no vector store registered");
    expect(fake.deleted).toEqual([]);
  });

  test("a collection name that is not a usable name is refused rather than read as one", async () => {
    // "" is `!== undefined`, so the gate called it KNOWN, matched it against
    // nothing and ALLOWED the delete — where an absent name refuses.
    expect(() => registerVectorTarget({ store: store([]), collection: "" })).toThrow(
      VectorTargetError,
    );
    // biome-ignore lint/suspicious/noExplicitAny: this reached `collection.toLowerCase()` and threw out of execute.
    expect(() => registerVectorTarget({ store: store([]), collection: 123 as any })).toThrow(
      VectorTargetError,
    );
  });

  test("a countConsistency that is neither word is refused, not read as the confident one", () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: a typo in a config file.
      registerVectorTarget({ store: store([], "qdrant"), countConsistency: "Immediate" as any }),
    ).toThrow(VectorTargetError);
  });
});

describe("what the result claims, and what it does not", () => {
  test("a delete reports attempts and acknowledgements, never a deleted/missing split", async () => {
    const fake = store(["a:0:0", "b:0:0"]);
    registerVectorTarget({ store: fake, collection: "chunks" });

    // "c:0:0" is not in the store. The store accepts the delete anyway, and
    // the result must not pretend to know that it was absent.
    const out = await run({ ids: ["a:0:0", "c:0:0"] });
    expect(out.refused).toBe(false);
    expect(out.deletesAttempted).toBe(2);
    expect(out.deletesAcknowledged).toBe(2);
    expect(out.perIdOutcome).toBe("unavailable");
    const keys = Object.keys(out).join(" ");
    expect(keys).not.toMatch(/deleted|missing|notFound|removed/i);
    expect(out.caveats[0]).toContain("accepted the request");
  });

  test("an errored delete is reported per id and the run continues", async () => {
    const fake = store(["a", "b", "c"]);
    fake.failures.set("b", new Error("qdrant 503: service unavailable"));
    registerVectorTarget({ store: fake, collection: "chunks" });

    const out = await run({ ids: ["a", "b", "c"] });
    expect(out.deletesAttempted).toBe(3);
    expect(out.deletesAcknowledged).toBe(2);
    expect(out.deletesErrored).toEqual([{ id: "b", error: "qdrant 503: service unavailable" }]);
    expect(fake.deleted).toEqual(["a", "c"]);
  });

  test("an unreadable count is null WITH a reason, never a fabricated 0", async () => {
    const fake = store(["a"]);
    fake.countError = new Error("connection refused");
    registerVectorTarget({ store: fake, collection: "chunks" });

    const out = await run({ ids: ["a"] });
    expect(out.countBefore).toBeNull();
    expect(out.countBeforeError).toBe("connection refused");
    expect(out.countAfter).toBeNull();
    expect(out.countAfterError).toBe("connection refused");
    // A count this tool could not read is no reason to abandon an erasure.
    expect(out.deletesAttempted).toBe(1);
  });

  test("a count that is not a number is reported as such, not coerced", async () => {
    const fake = store(["a"]);
    // biome-ignore lint/suspicious/noExplicitAny: a misbehaving backend is the case.
    (fake as any).count = async () => Number.NaN;
    registerVectorTarget({ store: fake, collection: "chunks" });

    const out = await run({ ids: ["a"] });
    expect(out.countBefore).toBeNull();
    expect(out.countBeforeError).toContain("count() returned");
  });

  // Found by review. Every other store-controlled string here is capped
  // because "a result is a model's context"; this one was rendered with a
  // bare JSON.stringify and was not.
  test("a store's non-numeric count is rendered bounded, like every other store text", async () => {
    const fake = store(["a"]);
    // biome-ignore lint/suspicious/noExplicitAny: an HTTP backend answering with a parsed error page.
    (fake as any).count = async () => ({ error: "x".repeat(50_000) });
    registerVectorTarget({ store: fake, collection: "chunks" });

    const out = await run({ ids: ["a"] });
    expect(out.countBefore).toBeNull();
    expect(out.countBeforeError.length).toBeLessThan(300);
    expect(out.countBeforeError).toContain("count() returned");
    // Still a whole result, not a truncated one: the erasure went ahead.
    expect(out.deletesAttempted).toBe(1);
  });

  test("a backend that is not a string is 'unknown', not pasted into the result", async () => {
    const fake = store(["a"]);
    // biome-ignore lint/suspicious/noExplicitAny: a store whose `backend` is its config object.
    (fake as any).backend = { url: "https://vectors.internal", token: "x".repeat(5_000) };
    registerVectorTarget({ store: fake, collection: "chunks" });

    const out = await run({ ids: ["a"] });
    expect(out.backend).toBe("unknown");
    // And the same reading drives the claim, not just the display.
    expect(out.countAfterIsIndicative).toBe(true);
  });

  // The case MAX_STORE_ERROR_CHARS was written for, which nothing exercised:
  // a failing HTTP backend hands back a whole error page.
  test("a store error the size of an error page is capped in the result", async () => {
    const fake = store(["a", "b"]);
    fake.failures.set("a", new Error(`<!doctype html>${"x".repeat(50_000)}`));
    registerVectorTarget({ store: fake, collection: "chunks" });

    const out = await run({ ids: ["a", "b"] });
    expect(out.deletesErrored[0].error.length).toBeLessThan(300);
    expect(out.deletesErrored[0].error.startsWith("<!doctype html>")).toBe(true);
    // Capped, not abandoned: the other id was still attempted.
    expect(fake.deleted).toEqual(["b"]);
  });

  test("a store that throws a value with no message still gets a sentence", () => {
    expect(describeStoreError(new Error(""))).toBe("the store threw a value carrying no message");
    expect(describeStoreError("   \n  ")).toBe("the store threw a value carrying no message");
  });

  test("an eventually-consistent count is labelled indicative and never differenced", async () => {
    const fake = store(["a", "b"], "qdrant");
    fake.stale = true; // the backend has not caught up; count does not move
    registerVectorTarget({ store: fake, collection: "chunks" });

    const out = await run({ ids: ["a"] });
    expect(out.countBefore).toBe(2);
    expect(out.countAfter).toBe(2); // the delete landed; the count has not
    expect(out.countAfterIsIndicative).toBe(true);
    expect(out.caveats[1]).toContain("eventually consistent");
    expect(Object.keys(out)).not.toContain("countDelta");
  });

  test("an immediate backend still refuses to call the difference a deletion count", async () => {
    registerVectorTarget({ store: store(["a", "b"]), collection: "chunks" });
    const out = await run({ ids: ["a"] });
    expect(out.countAfterIsIndicative).toBe(false);
    expect(out.caveats[1]).toContain("not a count of what this call deleted");
  });

  test("the backend's own name is echoed, and 'unknown' when it does not give one", async () => {
    registerVectorTarget({ store: store([], null), collection: "chunks" });
    const out = await run({ ids: ["a"] });
    expect(out.backend).toBe("unknown");
    // An unnamed backend is assumed eventually consistent, not assumed local.
    expect(out.countAfterIsIndicative).toBe(true);
  });
});

describe("the dry run runs the real selection", () => {
  test("it reports the same selection as the real run and touches nothing", async () => {
    const ids = ["b:0:0", "a:0:0", "b:0:0", "", "a:0:0"];
    const dryStore = store(["a:0:0", "b:0:0"]);
    registerVectorTarget({ store: dryStore, collection: "chunks" });
    const dry = await run({ ids, dryRun: true });

    _resetVectorTarget();
    const realStore = store(["a:0:0", "b:0:0"]);
    registerVectorTarget({ store: realStore, collection: "chunks" });
    const real = await run({ ids });

    for (const field of ["idsRequested", "idsSelected", "duplicatesCollapsed", "idsRejected"]) {
      expect({ field, value: dry[field] }).toEqual({ field, value: real[field] });
    }
    expect(dryStore.deleted).toEqual([]);
    expect(dry.deletesAttempted).toBe(0);
    expect(dry.countAfter).toBeNull();
    expect(dry.countAfterSkipped).toContain("dry run");
    // The real run attempted exactly what the dry run selected.
    expect(realStore.deleted).toEqual(["a:0:0", "b:0:0"]);
    expect(real.deletesAttempted).toBe(2);
  });

  test("a dry run still reads the count, so an unreachable store shows up first", async () => {
    const fake = store(["a"]);
    fake.countError = new Error("connection refused");
    registerVectorTarget({ store: fake, collection: "chunks" });
    const out = await run({ ids: ["a"], dryRun: true });
    expect(out.countBeforeError).toBe("connection refused");
  });
});

describe("the collection gate runs once, before anything happens", () => {
  test("a protected collection refuses without touching the store at all", async () => {
    const fake = store(["a", "b", "c"]);
    registerVectorTarget({ store: fake, collection: "chunks" });

    const out = await run({ ids: ["a", "b", "c"], protectedCollections: ["chunks"] });
    expect(out).toMatchObject({
      refused: true,
      reasonCode: "protected-collection",
      deletesAttempted: 0,
    });
    // Not "it stopped after the first one" — it never started.
    expect(fake.deleted).toEqual([]);
    expect(fake.countCalls).toBe(0);
  });

  test("the dry run predicts that refusal, in the same shape", async () => {
    registerVectorTarget({ store: store(["a"]), collection: "chunks" });
    const dry = await run({ ids: ["a"], protectedCollections: ["chunks"], dryRun: true });
    const real = await run({ ids: ["a"], protectedCollections: ["chunks"] });
    expect({ ...dry, dryRun: false }).toEqual(real);
  });

  test("an unknown collection with a protection list refuses: it cannot be proven safe", async () => {
    const fake = store(["a"]);
    registerVectorTarget({ store: fake });
    const out = await run({ ids: ["a"], protectedCollections: ["chunks"] });
    expect(out.reasonCode).toBe("collection-unknown");
    expect(fake.deleted).toEqual([]);
  });

  test("no protection list and no collection is allowed — nothing was claimed", async () => {
    const fake = store(["a"]);
    registerVectorTarget({ store: fake });
    const out = await run({ ids: ["a"] });
    expect(out.collection).toBeNull();
    expect(out.collectionSource).toBe("none");
    expect(fake.deleted).toEqual(["a"]);
  });

  test("a collection that is not the one expected refuses", async () => {
    const fake = store(["a"]);
    registerVectorTarget({ store: fake, collection: "prod-chunks" });
    const out = await run({ ids: ["a"], expectCollection: "test-chunks" });
    expect(out.reasonCode).toBe("collection-mismatch");
    expect(out.reason).toContain("prod-chunks");
    expect(fake.deleted).toEqual([]);
  });

  test("the operator's list is unioned with the caller's, not replaced by it", async () => {
    const fake = store(["a"]);
    registerVectorTarget({ store: fake, collection: "audit", protectedCollections: ["audit"] });
    // The caller protects something else entirely; the operator's still holds.
    const out = await run({ ids: ["a"], protectedCollections: ["other"] });
    expect(out.reasonCode).toBe("protected-collection");
    expect(out.protectedCollections).toEqual(["audit", "other"]);
  });

  test("a per-call tool_config block adds to the list too", async () => {
    registerVectorTarget({ store: store(["a"]), collection: "audit" });
    const out = await run({ ids: ["a"] }, { toolConfig: { protected_collections: ["audit"] } });
    expect(out.reasonCode).toBe("protected-collection");
  });

  test("a malformed tool_config block refuses — unreadable policy is not absent policy", async () => {
    const fake = store(["a"]);
    registerVectorTarget({ store: fake, collection: "chunks" });
    const out = await run({ ids: ["a"] }, { toolConfig: { protectedCollections: "audit" } });
    expect(out).toContain("not a list of non-empty collection names");
    expect(fake.deleted).toEqual([]);
  });

  // Found by review. The block accepts two spellings "so a spec block can be
  // passed verbatim" — and a spec block may well carry both. Reading only the
  // camelCase one dropped the other list on the floor and deleted from the
  // collection it named: accepting two spellings and acting on one.
  test("a block carrying BOTH spellings is unioned, not resolved to one of them", async () => {
    const fake = store(["a"]);
    registerVectorTarget({ store: fake, collection: "audit" });
    const out = await run(
      { ids: ["a"] },
      { toolConfig: { protectedCollections: ["other"], protected_collections: ["audit"] } },
    );
    expect(out.reasonCode).toBe("protected-collection");
    expect(out.protectedCollections).toEqual(["audit", "other"]);
    expect(fake.deleted).toEqual([]);
  });

  test("each spelling is validated on its own — a good one does not excuse a bad one", () => {
    expect(
      readVectorToolConfig({ protectedCollections: ["a"], protected_collections: "audit" }),
    ).toEqual({
      ok: false,
      reason: "tool_config.protected_collections is not a list of non-empty collection names",
    });
    expect(
      readVectorToolConfig({ protectedCollections: ["a"], protected_collections: ["b"] }),
    ).toEqual({ ok: true, protectedCollections: ["a", "b"] });
  });
});

describe("ids are acted on exactly as given", () => {
  test("the store receives the caller's bytes, untrimmed and unfolded", async () => {
    const fake = store([]);
    registerVectorTarget({ store: fake, collection: "chunks" });
    await run({ ids: [" a:0:0 ", "Ä:1:2", "B:0:0"] });
    expect(fake.deleted).toEqual([" a:0:0 ", "B:0:0", "Ä:1:2"]);
  });

  test("repeats are collapsed and counted, not attempted twice", async () => {
    const fake = store(["a"]);
    registerVectorTarget({ store: fake, collection: "chunks" });
    const out = await run({ ids: ["a", "a", "a"] });
    expect(out.duplicatesCollapsed).toBe(2);
    expect(out.idsSelected).toBe(1);
    expect(fake.deleted).toEqual(["a"]);
  });

  test("an unusable id is rejected with its reason, and the rest still run", async () => {
    const fake = store(["a"]);
    registerVectorTarget({ store: fake, collection: "chunks" });
    const out = await run({ ids: ["a", "", "bad id"] });
    expect(out.idsRejected).toHaveLength(2);
    expect(out.idsRejected[1].reason).toContain("control characters");
    expect(fake.deleted).toEqual(["a"]);
  });

  test("requireChunkIdShape refuses ids that are not chunk ids", async () => {
    const fake = store([]);
    registerVectorTarget({ store: fake, collection: "chunks" });
    const out = await run({ ids: ["doc.md:0:400", "loose-id"], requireChunkIdShape: true });
    expect(out.idsSelected).toBe(1);
    expect(out.idsRejected[0]).toMatchObject({ id: "loose-id" });
    expect(fake.deleted).toEqual(["doc.md:0:400"]);
  });

  test("a docId full of colons still parses — the numbers are the last two fields", () => {
    expect(parseChunkId("https://example.com/a:0:400")).toEqual({
      docId: "https://example.com/a",
      index: 0,
      startOffset: 400,
    });
    expect(parseChunkId("plain.md:12:3400")).toEqual({
      docId: "plain.md",
      index: 12,
      startOffset: 3400,
    });
  });

  test("a chunk id whose numbers are not numbers is not a chunk id", () => {
    // Number.parseInt would read each of these as a number and move on.
    for (const id of ["a:0x10:4", "a:1abc:4", "a: 1:4", "a:1:4.5", "a:+1:4", "a::4", ":0:4"]) {
      expect({ id, parsed: parseChunkId(id) }).toEqual({ id, parsed: undefined });
    }
  });

  test("more ids than the cap are refused by the schema, not silently cut", () => {
    const tooMany = Array.from({ length: 1_001 }, (_, i) => `id-${i}`);
    expect(vectorDelete.inputSchema.safeParse({ ids: tooMany }).success).toBe(false);
    expect(vectorDelete.inputSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  test("a long rejection list is capped, and says it was", async () => {
    registerVectorTarget({ store: store([]), collection: "chunks" });
    const out = await run({ ids: Array.from({ length: 30 }, () => ""), dryRun: true });
    expect(out.idsRejected).toHaveLength(20);
    expect(out.idsRejectedTruncated).toBe(true);
    // The count is still recoverable: requested − selected − repeats.
    expect(out.idsRequested - out.idsSelected - out.duplicatesCollapsed).toBe(30);
  });
});

describe("an aborted run says where it stopped", () => {
  test("it reports the abort rather than a clean finish", async () => {
    const fake = store(["a", "b", "c"]);
    const controller = new AbortController();
    // Abort after the first delete lands — no timers, no wall-clock waiting.
    const inner = fake.delete.bind(fake);
    fake.delete = async (id: string) => {
      await inner(id);
      controller.abort();
    };
    registerVectorTarget({ store: fake, collection: "chunks" });

    const out = await run({ ids: ["a", "b", "c"] }, { signal: controller.signal });
    expect(out.deletesAttempted).toBe(1);
    expect(out.deletesAcknowledged).toBe(1);
    expect(out.halted).toContain("aborted");
    expect(fake.deleted).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// the pure pieces
// ---------------------------------------------------------------------------

describe("selectVectorIds", () => {
  test("keeps insertion-independent order: the same set always sorts the same", () => {
    const forwards = selectVectorIds(["c", "a", "b"], { requireChunkIdShape: false });
    const backwards = selectVectorIds(["b", "c", "a"], { requireChunkIdShape: false });
    expect(forwards.ids).toEqual(backwards.ids);
    expect(forwards.ids).toEqual(["a", "b", "c"]);
  });

  test("an over-long id is rejected, and echoed back truncated", () => {
    const long = "x".repeat(600);
    const selection = selectVectorIds([long], { requireChunkIdShape: false });
    expect(selection.ids).toEqual([]);
    expect(selection.rejected[0]?.id.length).toBeLessThan(long.length);
    expect(selection.rejected[0]?.reason).toContain("over the 512 limit");
  });
});

describe("checkCollection", () => {
  test("a case-only difference from a protected name is refused, not waved through", () => {
    const refusal = checkCollection({
      collection: "Chunks",
      protectedCollections: ["chunks"],
      expectCollection: undefined,
    });
    expect(refusal?.code).toBe("protected-collection");
    expect(refusal?.message).toContain("differs only in case");
  });

  test("an unrelated collection passes", () => {
    expect(
      checkCollection({
        collection: "scratch",
        protectedCollections: ["chunks"],
        expectCollection: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("countIsIndicative", () => {
  test("an explicit declaration beats the backend's self-report", () => {
    const fake = store([], "qdrant");
    expect(countIsIndicative({ store: fake, countConsistency: "immediate" })).toBe(false);
    expect(countIsIndicative({ store: store([], "in-memory"), countConsistency: "eventual" })).toBe(
      true,
    );
  });

  test("anything that is not the word 'immediate' is indicative", () => {
    // The cautious answer for an unreadable setting. `=== "eventual"` gave the
    // confident one, so a typo made countAfter sound authoritative on qdrant.
    expect(
      countIsIndicative({
        store: store([], "in-memory"),
        // biome-ignore lint/suspicious/noExplicitAny: a target built without the registration check.
        countConsistency: "Immediate" as any,
      }),
    ).toBe(true);
  });

  test("every backend but the in-process one is indicative by default", () => {
    for (const backend of ["qdrant", "pinecone", "weaviate", "lance", null]) {
      expect({ backend, indicative: countIsIndicative({ store: store([], backend) }) }).toEqual({
        backend,
        indicative: true,
      });
    }
    expect(countIsIndicative({ store: store([], "in-memory") })).toBe(false);
  });
});

describe("readVectorToolConfig", () => {
  test("absent is an empty list; malformed is a refusal", () => {
    expect(readVectorToolConfig(undefined)).toEqual({ ok: true, protectedCollections: [] });
    expect(readVectorToolConfig({})).toEqual({ ok: true, protectedCollections: [] });
    expect(readVectorToolConfig({ protectedCollections: ["a"] })).toEqual({
      ok: true,
      protectedCollections: ["a"],
    });
    // The key is present but says nothing readable — that is not "no policy".
    expect(readVectorToolConfig({ protectedCollections: null }).ok).toBe(false);
    expect(readVectorToolConfig({ protected_collections: undefined }).ok).toBe(false);
    expect(readVectorToolConfig([]).ok).toBe(false);
    expect(readVectorToolConfig("chunks").ok).toBe(false);
    expect(readVectorToolConfig({ protectedCollections: [""] }).ok).toBe(false);
    expect(readVectorToolConfig({ protectedCollections: [1] }).ok).toBe(false);
  });
});
