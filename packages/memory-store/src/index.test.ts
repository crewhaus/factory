/**
 * Tests for the persistent memory store. Covers basic remember/recall,
 * BM25 ranking sanity, file persistence across instances, graceful
 * handling of malformed lines, and the v2 surface: mixed v1/v2 reads,
 * forget/supersede tombstones, TTL sweep, compact rewrites, hybrid
 * recall with the mock embedder (incl. the proof-grounded boost), and
 * the BM25-only regression guard.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbedder } from "@crewhaus/embedder";
import {
  DEFAULT_AUTO_CAPTURE_THRESHOLD,
  DEFAULT_AUTO_RECALL_K,
  MEMORY_SCHEMA_VERSION,
  MemoryStoreError,
  captureFacts,
  createMemoryStore,
  deriveMemoryDecision,
  summarizeDurableFacts,
  summarizeDurableFactsWithEvidence,
  turnsFromEvents,
} from "./index";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memory-store-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("createMemoryStore", () => {
  test("rejects empty specName", () => {
    expect(() => createMemoryStore({ specName: "", rootDir: tmp })).toThrow(MemoryStoreError);
  });

  test("rejects specName with bad characters (path traversal etc.)", () => {
    expect(() => createMemoryStore({ specName: "../etc/passwd", rootDir: tmp })).toThrow(
      MemoryStoreError,
    );
    expect(() => createMemoryStore({ specName: "foo bar", rootDir: tmp })).toThrow(
      MemoryStoreError,
    );
  });

  test("path() returns the expected file location", () => {
    const store = createMemoryStore({ specName: "my-spec", rootDir: tmp });
    expect(store.path()).toBe(join(tmp, "my-spec.jsonl"));
  });
});

describe("remember + recall", () => {
  test("size() returns 0 before any remember", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    expect(await store.size()).toBe(0);
  });

  test("remember() persists and recall() finds it", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await store.remember("the user prefers TypeScript over JavaScript");
    const results = await store.recall("TypeScript");
    expect(results.length).toBe(1);
    expect(results[0]?.entry.text).toBe("the user prefers TypeScript over JavaScript");
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  test("remember assigns ids with the mem_ prefix", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    const e1 = await store.remember("a");
    const e2 = await store.remember("b");
    expect(e1.id).toMatch(/^mem_[0-9a-f]{16}$/);
    expect(e2.id).toMatch(/^mem_[0-9a-f]{16}$/);
    expect(e1.id).not.toBe(e2.id);
  });

  test("recall() ranks closer matches higher", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await store.remember("the user prefers TypeScript");
    await store.remember("we discussed Python yesterday");
    await store.remember("TypeScript is a typed superset of JavaScript");
    const results = await store.recall("TypeScript", 3);
    expect(results.length).toBe(2);
    // Both TypeScript-mentioning entries should outrank the Python one,
    // which is excluded entirely (zero score).
    expect(results[0]?.score).toBeGreaterThanOrEqual(results[1]?.score);
    expect(results.find((r) => r.entry.text.includes("Python"))).toBeUndefined();
  });

  test("tags are indexed for recall", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await store.remember("personal note", ["family", "anniversary"]);
    const results = await store.recall("anniversary");
    expect(results.length).toBe(1);
    expect(results[0]?.entry.tags).toEqual(["family", "anniversary"]);
  });

  test("recall returns empty array when nothing matches", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await store.remember("apples and oranges");
    const results = await store.recall("kumquat");
    expect(results).toEqual([]);
  });

  test("k parameter caps the result count", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    for (let i = 0; i < 5; i++) {
      await store.remember(`memory entry number ${i} about banana`);
    }
    const results = await store.recall("banana", 2);
    expect(results.length).toBe(2);
  });

  test("persists across store instances (file-backed)", async () => {
    const store1 = createMemoryStore({ specName: "persist", rootDir: tmp });
    await store1.remember("durable claim");
    const store2 = createMemoryStore({ specName: "persist", rootDir: tmp });
    expect(await store2.size()).toBe(1);
    const results = await store2.recall("durable");
    expect(results.length).toBe(1);
  });

  test("malformed lines in the JSONL are skipped (not raised)", async () => {
    const store = createMemoryStore({ specName: "broken", rootDir: tmp });
    await store.remember("good entry");
    // Corrupt the file by appending a broken line.
    appendFileSync(store.path(), "{not json\n");
    await store.remember("another good entry");
    expect(await store.size()).toBe(2);
    const results = await store.recall("entry");
    expect(results.length).toBe(2);
  });

  test("recall rejects empty queries", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await expect(store.recall("")).rejects.toThrow(MemoryStoreError);
  });

  test("remember rejects empty text", async () => {
    const store = createMemoryStore({ specName: "s", rootDir: tmp });
    await expect(store.remember("")).rejects.toThrow(MemoryStoreError);
  });
});

describe("deriveMemoryDecision (#53)", () => {
  test("absent config disables capture + recall", () => {
    const d = deriveMemoryDecision(undefined, 100);
    expect(d.capture).toBe(false);
    expect(d.recall).toBe(false);
    expect(d.recallK).toBe(DEFAULT_AUTO_RECALL_K);
    expect(d.captureThreshold).toBe(DEFAULT_AUTO_CAPTURE_THRESHOLD);
  });

  test("enabled:false disables both even with auto flags set", () => {
    const d = deriveMemoryDecision({ enabled: false, autoCapture: true, autoRecall: true }, 100);
    expect(d.capture).toBe(false);
    expect(d.recall).toBe(false);
  });

  test("autoCapture gated by threshold on completed turns", () => {
    const cfg = { autoCapture: true, autoCaptureThreshold: 3 };
    expect(deriveMemoryDecision(cfg, 2).capture).toBe(false);
    expect(deriveMemoryDecision(cfg, 3).capture).toBe(true);
  });

  test("autoRecall + recallK honoured", () => {
    const d = deriveMemoryDecision({ autoRecall: true, recallK: 9 }, 0);
    expect(d.recall).toBe(true);
    expect(d.recallK).toBe(9);
  });

  test("threshold and recallK are floored at 1", () => {
    const d = deriveMemoryDecision({ autoCapture: true, autoCaptureThreshold: 0, recallK: 0 }, 1);
    expect(d.captureThreshold).toBe(1);
    expect(d.recallK).toBe(1);
    expect(d.capture).toBe(true);
  });
});

describe("summarizeDurableFacts (#53)", () => {
  test("keeps one durable line per turn, dropping empties + dupes", () => {
    const facts = summarizeDurableFacts([
      { input: "q1", output: "The build uses Bun.\nmore detail" },
      { input: "q2", output: "   " },
      { input: "q3", output: "The build uses Bun." },
      { input: "q4", output: "Deploys go to Cloudflare Workers." },
    ]);
    expect(facts).toEqual(["The build uses Bun.", "Deploys go to Cloudflare Workers."]);
  });

  test("truncates very long answers with an ellipsis", () => {
    const long = "x".repeat(400);
    const [fact] = summarizeDurableFacts([{ input: "q", output: long }], { maxLen: 50 });
    expect(fact?.length).toBe(50);
    expect(fact?.endsWith("…")).toBe(true);
  });

  test("caps at maxFacts", () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ input: "q", output: `fact ${i}` }));
    expect(summarizeDurableFacts(turns, { maxFacts: 3 })).toHaveLength(3);
  });
});

describe("captureFacts (#53) idempotency", () => {
  test("writes facts once; re-running is a no-op", async () => {
    const store = createMemoryStore({ specName: "cap", rootDir: tmp });
    const facts = ["The user prefers dark mode.", "Releases ship on Fridays."];
    const first = await captureFacts(store, facts);
    expect(first).toHaveLength(2);
    expect(await store.size()).toBe(2);
    const second = await captureFacts(store, facts);
    expect(second).toHaveLength(0);
    expect(await store.size()).toBe(2);
  });

  test("skips a fact that differs only by case/whitespace from an existing one", async () => {
    const store = createMemoryStore({ specName: "cap2", rootDir: tmp });
    await captureFacts(store, ["Deploys go to Cloudflare."]);
    const again = await captureFacts(store, ["deploys   go to cloudflare."]);
    expect(again).toHaveLength(0);
    expect(await store.size()).toBe(1);
  });

  test("empty facts list writes nothing", async () => {
    const store = createMemoryStore({ specName: "cap3", rootDir: tmp });
    expect(await captureFacts(store, [])).toHaveLength(0);
  });

  test("stamps provenance.sessionId + evidence on written facts (proof-linked capture)", async () => {
    const store = createMemoryStore({ specName: "cap4", rootDir: tmp });
    const written = await captureFacts(
      store,
      [{ text: "The deploy ran green.", evidence: ["tu_aaa", "tu_bbb"] }, "A plain-string fact."],
      ["auto-capture", "sess_0123456789abcdef"],
      { sessionId: "sess_0123456789abcdef" },
    );
    expect(written).toHaveLength(2);
    expect(written[0]?.provenance).toEqual({
      sessionId: "sess_0123456789abcdef",
      evidence: ["tu_aaa", "tu_bbb"],
    });
    expect(written[1]?.provenance).toEqual({ sessionId: "sess_0123456789abcdef" });
    // Still idempotent with the new shapes.
    const again = await captureFacts(
      store,
      [{ text: "The deploy ran green.", evidence: ["tu_aaa"] }],
      ["auto-capture"],
      { sessionId: "sess_0123456789abcdef" },
    );
    expect(again).toHaveLength(0);
  });
});

// -------- v2: schema, forgetting, TTL, compaction, hybrid recall --------

/** Append a raw v1 line (no schemaVersion) as a pre-v2 writer would. */
function appendV1Line(path: string, id: string, text: string, tags: string[] = []): void {
  appendFileSync(
    path,
    `${JSON.stringify({ id, text, tags, createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
  );
}

describe("schema v2 writes + v1/v2 mixed reads", () => {
  test("remember() stamps schemaVersion 2 and persists ttl/provenance", async () => {
    const t0 = new Date("2026-07-01T00:00:00.000Z");
    const store = createMemoryStore({ specName: "v2", rootDir: tmp, now: () => t0 });
    const entry = await store.remember("fact with everything", ["tagged"], {
      ttlMs: 1000,
      provenance: { sessionId: "sess_0123456789abcdef", evidence: ["tu_1"] },
    });
    expect(entry.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    expect(entry.expiresAt).toBe(t0.getTime() + 1000);
    expect(entry.provenance?.sessionId).toBe("sess_0123456789abcdef");
    // Round-trips through the file.
    const [item] = await createMemoryStore({ specName: "v2", rootDir: tmp }).list();
    expect(item?.entry.schemaVersion).toBe(2);
    expect(item?.entry.provenance?.evidence).toEqual(["tu_1"]);
  });

  test("v1 lines in a mixed file are read untouched alongside v2 lines", async () => {
    const store = createMemoryStore({ specName: "mixed", rootDir: tmp });
    await store.remember("a v2 fact about kumquats");
    appendV1Line(store.path(), "mem_00000000000000aa", "a v1 fact about kumquats");
    const items = await store.list();
    expect(items).toHaveLength(2);
    const v1 = items.find((i) => i.entry.id === "mem_00000000000000aa");
    expect(v1?.entry.schemaVersion).toBeUndefined();
    expect(v1?.status).toBe("live");
    const results = await store.recall("kumquats", 5);
    expect(results).toHaveLength(2);
  });

  test("rejects non-positive ttlMs", async () => {
    const store = createMemoryStore({ specName: "v2ttl", rootDir: tmp });
    await expect(store.remember("x", [], { ttlMs: 0 })).rejects.toThrow(MemoryStoreError);
  });

  test("an entry line with a mangled v2 field is skipped as malformed", async () => {
    const store = createMemoryStore({ specName: "mangled", rootDir: tmp });
    await store.remember("good entry");
    appendFileSync(
      store.path(),
      `${JSON.stringify({
        id: "mem_00000000000000bb",
        text: "bad provenance",
        tags: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        provenance: "not-an-object",
      })}\n`,
    );
    expect(await store.size()).toBe(1);
  });
});

describe("forget() — supersede tombstones, append-only", () => {
  test("forget by id tombstones exactly that entry and returns it", async () => {
    const store = createMemoryStore({ specName: "forget-id", rootDir: tmp });
    const keep = await store.remember("the user prefers TypeScript");
    const drop = await store.remember("the user prefers tabs");
    const forgotten = await store.forget(drop.id);
    expect(forgotten.map((e) => e.id)).toEqual([drop.id]);
    const results = await store.recall("the user prefers", 10);
    expect(results.map((r) => r.entry.id)).toEqual([keep.id]);
    expect(await store.size()).toBe(1);
    // Append-only: the original line is still in the file, plus a tombstone.
    const raw = readFileSync(store.path(), "utf-8");
    expect(raw).toContain("the user prefers tabs");
    expect(raw).toContain('"tombstone":"superseded"');
    // list() reports the superseded status.
    const items = await store.list();
    expect(items.find((i) => i.entry.id === drop.id)?.status).toBe("superseded");
  });

  test("forget by query tombstones every positive BM25 match", async () => {
    const store = createMemoryStore({ specName: "forget-q", rootDir: tmp });
    await store.remember("coffee brewing notes");
    await store.remember("more coffee thoughts");
    const keep = await store.remember("tea is unrelated");
    const forgotten = await store.forget("coffee");
    expect(forgotten).toHaveLength(2);
    const items = await store.list();
    expect(items.filter((i) => i.status === "live").map((i) => i.entry.id)).toEqual([keep.id]);
  });

  test("an id-shaped input that matches nothing forgets nothing (no text fallback)", async () => {
    const store = createMemoryStore({ specName: "forget-miss", rootDir: tmp });
    await store.remember("mem_0000000000000000 mentioned in text");
    const forgotten = await store.forget("mem_ffffffffffffffff");
    expect(forgotten).toHaveLength(0);
    expect(await store.size()).toBe(1);
  });

  test("forget records the reason on the tombstone line", async () => {
    const store = createMemoryStore({ specName: "forget-reason", rootDir: tmp });
    const e = await store.remember("stale fact");
    await store.forget(e.id, { reason: "contradicted by newer session" });
    expect(readFileSync(store.path(), "utf-8")).toContain("contradicted by newer session");
  });

  test("forgetting a v1 entry works (lazy read, no rewrite)", async () => {
    const store = createMemoryStore({ specName: "forget-v1", rootDir: tmp });
    appendV1Line(store.path(), "mem_00000000000000cc", "old v1 fact", []);
    const forgotten = await store.forget("mem_00000000000000cc");
    expect(forgotten).toHaveLength(1);
    expect(await store.size()).toBe(0);
  });
});

describe("sweep() — TTL, deterministic + idempotent", () => {
  test("marks expired entries with tombstones and reports counts", async () => {
    let nowMs = Date.parse("2026-07-01T00:00:00.000Z");
    const store = createMemoryStore({
      specName: "sweep",
      rootDir: tmp,
      now: () => new Date(nowMs),
    });
    await store.remember("short-lived", [], { ttlMs: 1000 });
    await store.remember("long-lived", [], { ttlMs: 1_000_000 });
    await store.remember("immortal");
    // Before expiry nothing sweeps.
    expect(await store.sweep()).toEqual({ swept: 0, live: 3 });
    nowMs += 2000;
    // recall() filters the expired entry even before a sweep runs.
    const hits = await store.recall("short lived", 5);
    expect(hits.find((r) => r.entry.text === "short-lived")).toBeUndefined();
    const first = await store.sweep();
    expect(first).toEqual({ swept: 1, live: 2 });
    expect(readFileSync(store.path(), "utf-8")).toContain('"tombstone":"expired"');
    // Idempotent: same clock, nothing new to sweep.
    expect(await store.sweep()).toEqual({ swept: 0, live: 2 });
  });

  test("sweep accepts an explicit nowMs", async () => {
    const t0 = new Date("2026-07-01T00:00:00.000Z");
    const store = createMemoryStore({ specName: "sweep-at", rootDir: tmp, now: () => t0 });
    await store.remember("ttl fact", [], { ttlMs: 500 });
    expect((await store.sweep(t0.getTime() + 499)).swept).toBe(0);
    expect((await store.sweep(t0.getTime() + 500)).swept).toBe(1);
  });
});

describe("compact() — atomic growth-bounding rewrite", () => {
  test("drops tombstoned/expired entries + tombstones, keeps live lines", async () => {
    let nowMs = Date.parse("2026-07-01T00:00:00.000Z");
    const store = createMemoryStore({
      specName: "compact",
      rootDir: tmp,
      now: () => new Date(nowMs),
    });
    const keep = await store.remember("keep me around");
    const drop = await store.remember("forget me");
    await store.remember("expiring soon", [], { ttlMs: 100 });
    await store.forget(drop.id);
    nowMs += 200;
    await store.sweep();
    const result = await store.compact();
    // Dropped: forgotten entry + its tombstone + expired entry + its tombstone.
    expect(result).toEqual({ kept: 1, dropped: 4 });
    const raw = readFileSync(store.path(), "utf-8");
    expect(raw).toContain("keep me around");
    expect(raw).not.toContain("forget me");
    expect(raw).not.toContain("tombstone");
    expect(existsSync(`${store.path()}.tmp`)).toBe(false);
    // Recall unaffected before/after compact.
    const results = await store.recall("keep", 5);
    expect(results.map((r) => r.entry.id)).toEqual([keep.id]);
  });

  test("preserves v1 lines and parseable-unknown lines verbatim", async () => {
    const store = createMemoryStore({ specName: "compact-v1", rootDir: tmp });
    appendV1Line(store.path(), "mem_00000000000000dd", "v1 line survives compact", ["v1"]);
    const unknownLine = `{"futureKind":"reserved","payload":{"x":1}}`;
    appendFileSync(store.path(), `${unknownLine}\n`);
    appendFileSync(store.path(), "{broken json\n");
    const before = readFileSync(store.path(), "utf-8");
    const v1Line = before.split("\n").find((l) => l.includes("v1 line survives"));
    const result = await store.compact();
    expect(result).toEqual({ kept: 2, dropped: 1 });
    const after = readFileSync(store.path(), "utf-8");
    expect(after.split("\n")).toContain(v1Line);
    expect(after.split("\n")).toContain(unknownLine);
    expect(after).not.toContain("{broken json");
  });

  test("compacting an empty/missing file is a no-op", async () => {
    const store = createMemoryStore({ specName: "compact-empty", rootDir: tmp });
    expect(await store.compact()).toEqual({ kept: 0, dropped: 0 });
  });
});

describe("hybrid recall (mock embedder) + BM25-only regression guard", () => {
  const seed = async (
    rootDir: string,
    specName: string,
    embed: boolean,
  ): Promise<ReturnType<typeof createMemoryStore>> => {
    const store = createMemoryStore({
      specName,
      rootDir,
      ...(embed ? { embedder: createEmbedder({ model: "mock/deterministic" }) } : {}),
    });
    await store.remember("the user prefers TypeScript for new services");
    await store.remember("we discussed Python packaging yesterday");
    await store.remember("TypeScript is the team's daily driver");
    await store.remember("lunch orders arrive at noon");
    return store;
  };

  test("no embedder ⇒ exactly today's BM25 ranking (regression guard)", async () => {
    const store = await seed(tmp, "bm25-only", false);
    const results = await store.recall("TypeScript services", 4);
    // BM25 semantics preserved: only positive matches, best first.
    expect(results.map((r) => r.entry.text)).toEqual([
      "the user prefers TypeScript for new services",
      "TypeScript is the team's daily driver",
    ]);
    expect(results.every((r) => r.score > 0)).toBe(true);
  });

  test("hybrid recall fuses BM25 + embedding ranks (RRF) and respects k", async () => {
    const store = await seed(tmp, "hybrid", true);
    const results = await store.recall("TypeScript services", 4);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // The doubly-relevant entry still wins under fusion.
    expect(results[0]?.entry.text).toBe("the user prefers TypeScript for new services");
    // Scores are fused RRF votes: bounded by 2 full votes + proof boost.
    expect(results[0]?.score).toBeLessThan(3 / 61 + 0.001);
    const capped = await store.recall("TypeScript services", 1);
    expect(capped).toHaveLength(1);
  });

  test("tool-grounded facts get the documented rank boost under hybrid recall", async () => {
    const store = createMemoryStore({
      specName: "boost",
      rootDir: tmp,
      embedder: createEmbedder({ model: "mock/deterministic" }),
    });
    // Identical text ⇒ identical BM25 + cosine ranks; the proof boost is
    // the only differentiator. The unproven entry is written FIRST so
    // stable-sort insertion order would otherwise keep it on top.
    await store.remember("the deploy pipeline runs on bun");
    const proven = await store.remember("the deploy pipeline runs on bun", [], {
      provenance: { sessionId: "sess_0123456789abcdef", evidence: ["tu_proof"] },
    });
    const results = await store.recall("deploy pipeline bun", 2);
    expect(results).toHaveLength(2);
    expect(results[0]?.entry.id).toBe(proven.id);
    // Without the boost the unproven entry holds rank 1 in both rankers
    // (2/61 vs 2/62); the proof boost (1/61) flips the order. The exact
    // gap is (2/62 + 1/61) − 2/61.
    expect((results[0]?.score ?? 0) - (results[1]?.score ?? 0)).toBeCloseTo(
      2 / 62 + 1 / 61 - 2 / 61,
      10,
    );
  });

  test("without an embedder the proof boost does NOT apply (ranking unchanged)", async () => {
    const store = createMemoryStore({ specName: "no-boost", rootDir: tmp });
    const first = await store.remember("the deploy pipeline runs on bun");
    await store.remember("the deploy pipeline runs on bun", [], {
      provenance: { evidence: ["tu_proof"] },
    });
    const results = await store.recall("deploy pipeline bun", 2);
    // Equal BM25 scores keep stable insertion order — no boost.
    expect(results[0]?.entry.id).toBe(first.id);
    expect(results[0]?.score).toBeCloseTo(results[1]?.score ?? 0, 10);
  });

  test("hybrid recall still filters superseded and expired entries", async () => {
    let nowMs = Date.parse("2026-07-01T00:00:00.000Z");
    const store = createMemoryStore({
      specName: "hybrid-filter",
      rootDir: tmp,
      now: () => new Date(nowMs),
      embedder: createEmbedder({ model: "mock/deterministic" }),
    });
    const keep = await store.remember("kumquat inventory is stable");
    const gone = await store.remember("kumquat prices are rising");
    await store.remember("kumquat futures expire", [], { ttlMs: 100 });
    await store.forget(gone.id);
    nowMs += 200;
    const results = await store.recall("kumquat", 5);
    expect(results.map((r) => r.entry.id)).toEqual([keep.id]);
  });
});

describe("turnsFromEvents — toolUseIds threading (v2)", () => {
  test("carries successful tool_result ids through to the turn", () => {
    const turns = turnsFromEvents([
      { kind: "user_message", payload: { content: "deploy the service" } },
      { kind: "tool_use", payload: { id: "tu_1", name: "Bash", input: {} } },
      { kind: "tool_result", payload: { toolUseId: "tu_1", content: "ok", isError: false } },
      { kind: "tool_result", payload: { toolUseId: "tu_2", content: "boom", isError: true } },
      { kind: "assistant_message", payload: { content: "Deployed the service." } },
      { kind: "user_message", payload: { content: "thanks" } },
      { kind: "assistant_message", payload: { content: "Anytime." } },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.toolUseIds).toEqual(["tu_1"]); // errored tu_2 excluded
    expect(turns[1]?.toolUseIds).toBeUndefined(); // no tool ran ⇒ field absent
  });

  test("tool_result events before any user turn are ignored", () => {
    const turns = turnsFromEvents([
      { kind: "tool_result", payload: { toolUseId: "tu_0", content: "early" } },
      { kind: "user_message", payload: { content: "hi" } },
      { kind: "assistant_message", payload: { content: "hello" } },
    ]);
    expect(turns[0]?.toolUseIds).toBeUndefined();
  });
});

describe("summarizeDurableFactsWithEvidence (v2)", () => {
  test("maps each fact to its source turn's evidence", () => {
    const facts = summarizeDurableFactsWithEvidence([
      { input: "q1", output: "The build uses Bun.", toolUseIds: ["tu_a", "tu_b"] },
      { input: "q2", output: "Deploys go to Cloudflare Workers." },
    ]);
    expect(facts).toEqual([
      { text: "The build uses Bun.", evidence: ["tu_a", "tu_b"] },
      { text: "Deploys go to Cloudflare Workers.", evidence: [] },
    ]);
  });

  test("string-returning wrapper is unchanged", () => {
    const facts = summarizeDurableFacts([
      { input: "q1", output: "The build uses Bun.", toolUseIds: ["tu_a"] },
    ]);
    expect(facts).toEqual(["The build uses Bun."]);
  });
});
