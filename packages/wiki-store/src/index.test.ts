/**
 * wiki-store tests (0.3.0 design §3.1): article round-trips, the version
 * history + supersede chain, the optimistic-concurrency (Thredz PATCH)
 * contract, index rebuild from articles, [[wikilink]] extraction, hybrid
 * recall (mock embedder) with a BM25-only regression pin, one-hop link
 * expansion, staleFirst ordering, signals semantics, and tenant fencing.
 * The lock policy has its own suite in lock.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbedder } from "@crewhaus/embedder";
import { TenancyError, buildTenant, withTenant } from "@crewhaus/tenancy";
import {
  STALE_ARTICLE_VERSION,
  type WikiStore,
  WikiStoreError,
  WikiVersionConflictError,
  createWikiStore,
  extractWikilinks,
  indexedText,
  parseArticle,
  serializeArticle,
} from "./index";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wiki-store-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A deterministic, strictly increasing clock (1s per call). */
function makeClock(startMs = Date.parse("2026-07-01T00:00:00.000Z")): () => Date {
  let t = startMs;
  return () => {
    const d = new Date(t);
    t += 1_000;
    return d;
  };
}

function makeStore(overrides: Partial<Parameters<typeof createWikiStore>[0]> = {}): WikiStore {
  return createWikiStore({ specName: "spec", rootDir: tmp, now: makeClock(), ...overrides });
}

describe("write + get round-trip", () => {
  test("create persists every frontmatter field and the body", async () => {
    const store = makeStore();
    const res = await store.write({
      slug: "csv-delimiters",
      title: "CSV delimiter conventions",
      body: "Comma by default; semicolon in EU locales.\n\n## Sources\n- RFC 4180",
      tags: ["csv", "locale"],
      confidence: 0.8,
      sources: ["RFC 4180"],
      createdBy: { sessionId: "sess_0123456789abcdef", agentIdentity: "role=researcher" },
    });
    expect(res).toEqual({ slug: "csv-delimiters", version: 1 });
    const article = await store.get("csv-delimiters");
    expect(article).not.toBeNull();
    expect(article?.title).toBe("CSV delimiter conventions");
    expect(article?.tags).toEqual(["csv", "locale"]);
    expect(article?.confidence).toBe(0.8);
    expect(article?.verified).toBe(false);
    expect(article?.version).toBe(1);
    expect(article?.sources).toEqual(["RFC 4180"]);
    expect(article?.supersedes).toBeUndefined();
    expect(article?.createdBy).toEqual({
      sessionId: "sess_0123456789abcdef",
      agentIdentity: "role=researcher",
    });
    expect(article?.status).toBe("published");
    expect(article?.body).toContain("## Sources");
  });

  test("get returns null for a missing article and rejects invalid slugs", async () => {
    const store = makeStore();
    expect(await store.get("nope")).toBeNull();
    await expect(store.get("../escape")).rejects.toThrow(WikiStoreError);
    await expect(store.get("Not A Slug")).rejects.toThrow(WikiStoreError);
  });

  test("serialize/parse round-trips an article byte-stably", () => {
    const article = {
      slug: "a",
      title: "A",
      tags: ["t1"],
      confidence: 0.7,
      verified: true,
      version: 3,
      sources: ["s1"],
      supersedes: 2,
      createdBy: { sessionId: "sess_0123456789abcdef" },
      status: "review" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      body: "Body with [[a-link]].",
    };
    const raw = serializeArticle(article);
    expect(parseArticle(raw)).toEqual(article);
    expect(serializeArticle(parseArticle(raw))).toBe(raw);
  });

  test("write validates title, body, confidence range, and slug shape", async () => {
    const store = makeStore();
    await expect(store.write({ slug: "x", title: "", body: "b" })).rejects.toThrow(WikiStoreError);
    await expect(store.write({ slug: "x", title: "t", body: "  " })).rejects.toThrow(
      WikiStoreError,
    );
    await expect(
      store.write({ slug: "x", title: "t", body: "b", confidence: 1.5 }),
    ).rejects.toThrow(WikiStoreError);
    await expect(store.write({ slug: "UPPER", title: "t", body: "b" })).rejects.toThrow(
      WikiStoreError,
    );
  });
});

describe("version history + supersede chain", () => {
  test("every edit freezes the prior version under versions/<slug>/<n>.md", async () => {
    const store = makeStore();
    await store.write({ slug: "a", title: "A v1", body: "first" });
    await store.write({ slug: "a", title: "A v2", body: "second", expectedVersion: 1 });
    await store.write({ slug: "a", title: "A v3", body: "third", expectedVersion: 2 });

    const live = await store.get("a");
    expect(live?.version).toBe(3);
    expect(live?.supersedes).toBe(2);
    expect(live?.body).toBe("third");

    const v1 = parseArticle(readFileSync(join(tmp, "spec", "versions", "a", "1.md"), "utf8"));
    const v2 = parseArticle(readFileSync(join(tmp, "spec", "versions", "a", "2.md"), "utf8"));
    expect(v1.body).toBe("first");
    expect(v1.version).toBe(1);
    expect(v2.body).toBe("second");
    expect(v2.supersedes).toBe(1);
    // Never a version 3 snapshot — the live file IS version 3.
    expect(existsSync(join(tmp, "spec", "versions", "a", "3.md"))).toBe(false);
  });

  test("update preserves createdAt + omitted fields, and RESETS verified", async () => {
    const store = makeStore();
    await store.write({
      slug: "a",
      title: "A",
      body: "b1",
      tags: ["keep"],
      confidence: 0.9,
      sources: ["s"],
      status: "review",
    });
    await store.setSignals("a", { verified: true });
    const before = await store.get("a");
    expect(before?.verified).toBe(true);

    await store.write({ slug: "a", title: "A", body: "b2", expectedVersion: 1 });
    const after = await store.get("a");
    expect(after?.tags).toEqual(["keep"]);
    expect(after?.confidence).toBe(0.9);
    expect(after?.sources).toEqual(["s"]);
    expect(after?.status).toBe("review");
    expect(after?.createdAt).toBe(before?.createdAt as string);
    // A new version is a new, not-yet-fact-checked claim.
    expect(after?.verified).toBe(false);
  });
});

describe("optimistic concurrency (the Thredz PATCH contract)", () => {
  test("stale expectedVersion throws the coded conflict error", async () => {
    const store = makeStore();
    await store.write({ slug: "a", title: "A", body: "v1" });
    await store.write({ slug: "a", title: "A", body: "v2", expectedVersion: 1 });

    let caught: unknown;
    try {
      await store.write({ slug: "a", title: "A", body: "v3", expectedVersion: 1 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WikiVersionConflictError);
    const conflict = caught as WikiVersionConflictError;
    expect(conflict.conflictCode).toBe(STALE_ARTICLE_VERSION);
    expect(conflict.message).toContain("stale_article_version");
    expect(conflict.currentVersion).toBe(2);
    expect(conflict.expectedVersion).toBe(1);
    // The losing write changed nothing.
    expect((await store.get("a"))?.body).toBe("v2");
  });

  test("omitting expectedVersion on an existing article conflicts (PATCH requires version)", async () => {
    const store = makeStore();
    await store.write({ slug: "a", title: "A", body: "v1" });
    await expect(store.write({ slug: "a", title: "A", body: "v2" })).rejects.toThrow(
      WikiVersionConflictError,
    );
  });

  test("expectedVersion on a missing article conflicts; 0 creates", async () => {
    const store = makeStore();
    await expect(
      store.write({ slug: "a", title: "A", body: "b", expectedVersion: 3 }),
    ).rejects.toThrow(WikiVersionConflictError);
    const res = await store.write({ slug: "a", title: "A", body: "b", expectedVersion: 0 });
    expect(res.version).toBe(1);
  });
});

describe("[[wikilink]] extraction into index.json", () => {
  test("extractWikilinks normalizes, drops invalid targets + self + dupes", () => {
    const body =
      "See [[Some Page]] and [[other-page|the label]] and [[Some Page]] again; " +
      "bad ones: [[../etc]] [[punct!uated]] and [[me]].";
    expect(extractWikilinks(body, "me")).toEqual(["some-page", "other-page"]);
    expect(extractWikilinks("[[../etc/passwd]]")).toEqual([]);
  });

  test("links land in index.json and on refs", async () => {
    const store = makeStore();
    await store.write({ slug: "a", title: "A", body: "links to [[b]] and [[c-page]]" });
    const index = JSON.parse(readFileSync(join(tmp, "spec", "index.json"), "utf8"));
    expect(index.articles.a.links).toEqual(["b", "c-page"]);
    const refs = await store.list();
    expect(refs.find((r) => r.slug === "a")?.links).toEqual(["b", "c-page"]);
  });
});

describe("index rebuild from articles", () => {
  test("a deleted index.json is rebuilt transparently on read", async () => {
    const store = makeStore();
    await store.write({ slug: "a", title: "Alpha", body: "alpha body [[b]]", tags: ["x"] });
    await store.write({ slug: "b", title: "Beta", body: "beta body" });
    const indexPath = join(tmp, "spec", "index.json");
    const before = readFileSync(indexPath, "utf8");
    unlinkSync(indexPath);

    const refs = await store.list();
    expect(refs.map((r) => r.slug).sort()).toEqual(["a", "b"]);
    expect(refs.find((r) => r.slug === "a")?.links).toEqual(["b"]);
    // The next mutation re-persists an equivalent index.
    await store.setSignals("b", { confidence: 0.9 });
    const rebuilt = JSON.parse(readFileSync(indexPath, "utf8"));
    expect(Object.keys(rebuilt.articles).sort()).toEqual(["a", "b"]);
    expect(JSON.parse(before).articles.a).toEqual(rebuilt.articles.a);
  });

  test("a corrupt index.json is ignored in favor of the article scan", async () => {
    const store = makeStore();
    await store.write({ slug: "a", title: "Alpha", body: "alpha body" });
    writeFileSync(join(tmp, "spec", "index.json"), "{not json");
    const refs = await store.list();
    expect(refs.map((r) => r.slug)).toEqual(["a"]);
  });
});

describe("recall — BM25-only regression + hybrid + one-hop expansion", () => {
  async function seedCorpus(store: WikiStore): Promise<void> {
    await store.write({
      slug: "csv-export",
      title: "CSV export",
      body: "How the CSV export pipeline works. Delimiters matter; see [[eu-locale-rules]].",
      tags: ["csv"],
    });
    await store.write({
      slug: "csv-import",
      title: "CSV import",
      body: "CSV import parsing and delimiter sniffing for csv files.",
      tags: ["csv"],
    });
    await store.write({
      slug: "eu-locale-rules",
      title: "EU locale rules",
      // Deliberately shares NO tokens with the "csv delimiter" query.
      body: "Continental spreadsheets prefer semicolons over commas in numeric regions.",
      tags: ["locale"],
    });
    await store.write({
      slug: "retry-backoff",
      title: "Retry backoff defaults",
      body: "Exponential backoff with jitter for network retries.",
      tags: ["network"],
    });
  }

  test("BM25-only: lexical matches rank by BM25 order (regression pin)", async () => {
    const store = makeStore();
    await seedCorpus(store);
    const hits = await store.recall("csv delimiter", 2);
    // csv-import mentions csv twice + delimiter; csv-export once each.
    expect(hits.map((h) => h.ref.slug)).toEqual(["csv-import", "csv-export"]);
    expect(hits.every((h) => h.via === "match")).toBe(true);
    expect(hits[0]?.body).toContain("delimiter sniffing");
  });

  test("one-hop expansion surfaces a linked-but-lexically-unrelated article", async () => {
    const store = makeStore();
    await seedCorpus(store);
    const hits = await store.recall("csv delimiter", 4);
    const slugs = hits.map((h) => h.ref.slug);
    // eu-locale-rules shares no query tokens; it is pulled in purely via the
    // [[eu-locale-rules]] link from the csv-export seed.
    expect(slugs).toContain("eu-locale-rules");
    const linked = hits.find((h) => h.ref.slug === "eu-locale-rules");
    expect(linked?.via).toBe("link");
    // The unlinked, unmatched article never appears.
    expect(slugs).not.toContain("retry-backoff");
  });

  test("expansion also follows IN-links (neighbor links to the seed)", async () => {
    const store = makeStore();
    await store.write({
      slug: "seed",
      title: "Seed",
      body: "unique-needle content lives here.",
    });
    await store.write({
      slug: "pointer",
      title: "Pointer",
      body: "Completely different words, but see [[seed]].",
    });
    const hits = await store.recall("unique-needle", 3);
    expect(hits.map((h) => h.ref.slug)).toEqual(["seed", "pointer"]);
    expect(hits[1]?.via).toBe("link");
  });

  test("hybrid recall with the mock embedder stays deterministic and ranked", async () => {
    const embedder = createEmbedder({ model: "mock/deterministic" });
    const store = makeStore({ embedder });
    await seedCorpus(store);
    const first = await store.recall("csv delimiter", 3);
    const second = await store.recall("csv delimiter", 3);
    expect(first.map((h) => h.ref.slug)).toEqual(second.map((h) => h.ref.slug));
    expect(first.length).toBeGreaterThan(0);
    // Lexical matches still lead the hybrid ranking on this corpus.
    expect(first[0]?.ref.slug.startsWith("csv-")).toBe(true);
    const scores = first.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  test("archived articles are excluded from recall and search", async () => {
    const store = makeStore();
    await store.write({ slug: "live", title: "Live", body: "needle here" });
    await store.write({ slug: "old", title: "Old", body: "needle here too", status: "archived" });
    expect((await store.recall("needle", 5)).map((h) => h.ref.slug)).toEqual(["live"]);
    expect((await store.search("needle")).map((r) => r.slug)).toEqual(["live"]);
  });

  test("semanticSearch exists only with an embedder and honors minScore", async () => {
    const bare = makeStore();
    expect(bare.semanticSearch).toBeUndefined();
    const store = makeStore({ embedder: createEmbedder({ model: "mock/deterministic" }) });
    await store.write({ slug: "a", title: "Alpha topic", body: "alpha body text" });
    expect(store.semanticSearch).toBeDefined();
    const hits = await store.semanticSearch?.("alpha body text", 5, 0);
    expect(hits?.map((h) => h.ref.slug)).toEqual(["a"]);
    // An impossible floor filters everything.
    expect(await store.semanticSearch?.("alpha body text", 5, 1.01)).toEqual([]);
  });

  test("contextual chunk header prefixes title + tags to the indexed text", () => {
    expect(indexedText({ title: "T", tags: ["a", "b"], body: "body" })).toBe(
      "T\n[tags: a, b]\n\nbody",
    );
    expect(indexedText({ title: "T", tags: [], body: "body" })).toBe("T\n\nbody");
  });
});

describe("list — staleFirst ordering + filters", () => {
  test("staleFirst sorts updatedAt ascending; default is descending", async () => {
    const store = makeStore(); // clock advances 1s per write
    await store.write({ slug: "oldest", title: "O", body: "b" });
    await store.write({ slug: "middle", title: "M", body: "b" });
    await store.write({ slug: "newest", title: "N", body: "b" });
    expect((await store.list({ staleFirst: true })).map((r) => r.slug)).toEqual([
      "oldest",
      "middle",
      "newest",
    ]);
    expect((await store.list()).map((r) => r.slug)).toEqual(["newest", "middle", "oldest"]);
  });

  test("tags filter requires EVERY tag; status filters; 'all' disables", async () => {
    const store = makeStore();
    await store.write({ slug: "a", title: "A", body: "b", tags: ["x", "y"] });
    await store.write({ slug: "b", title: "B", body: "b", tags: ["x"], status: "draft" });
    expect((await store.list({ tags: ["x", "y"] })).map((r) => r.slug)).toEqual(["a"]);
    expect((await store.list({ tags: ["x"] })).map((r) => r.slug).sort()).toEqual(["a", "b"]);
    expect((await store.list({ status: "draft" })).map((r) => r.slug)).toEqual(["b"]);
    expect((await store.list({ status: "all" })).length).toBe(2);
  });
});

describe("related", () => {
  test("scores tag overlap + link adjacency, sorted, excluding self", async () => {
    const store = makeStore();
    await store.write({ slug: "me", title: "Me", body: "links [[friend]]", tags: ["t1", "t2"] });
    await store.write({ slug: "friend", title: "F", body: "no tags in common" });
    await store.write({ slug: "tagged", title: "T", body: "plain", tags: ["t1", "t2"] });
    await store.write({ slug: "stranger", title: "S", body: "plain", tags: ["zzz"] });
    const related = await store.related("me");
    expect(related.map((r) => r.slug)).toEqual(["friend", "tagged"]);
    expect(related[0]?.relatedScore).toBe(2); // one out-link edge
    expect(related[1]?.relatedScore).toBe(2); // two shared tags
    await expect(store.related("missing")).rejects.toThrow(WikiStoreError);
  });
});

describe("setSignals", () => {
  test("updates verified/confidence without bumping the version or snapshotting", async () => {
    const store = makeStore();
    await store.write({ slug: "a", title: "A", body: "b", confidence: 0.5 });
    await store.setSignals("a", { verified: true, confidence: 0.95 });
    const article = await store.get("a");
    expect(article?.verified).toBe(true);
    expect(article?.confidence).toBe(0.95);
    expect(article?.version).toBe(1);
    expect(existsSync(join(tmp, "spec", "versions", "a"))).toBe(false);
  });

  test("rejects missing articles, empty signal sets, and out-of-range confidence", async () => {
    const store = makeStore();
    await store.write({ slug: "a", title: "A", body: "b" });
    await expect(store.setSignals("missing", { verified: true })).rejects.toThrow(WikiStoreError);
    await expect(store.setSignals("a", {})).rejects.toThrow(WikiStoreError);
    await expect(store.setSignals("a", { confidence: 2 })).rejects.toThrow(WikiStoreError);
  });
});

describe("stats", () => {
  test("counts articles, statuses, prior versions, tags, verified, links", async () => {
    const store = makeStore();
    await store.write({ slug: "a", title: "A", body: "[[b]]", tags: ["t1", "t2"], confidence: 1 });
    await store.write({
      slug: "b",
      title: "B",
      body: "x",
      tags: ["t2"],
      status: "draft",
      confidence: 0.5,
    });
    await store.write({ slug: "a", title: "A2", body: "[[b]] again", expectedVersion: 1 });
    await store.setSignals("b", { verified: true });
    const stats = await store.stats();
    expect(stats.articles).toBe(2);
    expect(stats.byStatus.published).toBe(1);
    expect(stats.byStatus.draft).toBe(1);
    expect(stats.priorVersions).toBe(1);
    expect(stats.uniqueTags).toBe(2);
    expect(stats.verified).toBe(1);
    expect(stats.links).toBe(1);
    // a kept its confidence (1) across the update; b is 0.5.
    expect(stats.averageConfidence).toBeCloseTo(0.75, 5);
  });

  test("empty wiki stats are all-zero", async () => {
    const stats = await makeStore().stats();
    expect(stats.articles).toBe(0);
    expect(stats.averageConfidence).toBe(0);
  });
});

describe("tenant fencing (fail-closed, CWE-1230)", () => {
  test("an ambient tenant rejects a rootDir outside the tenant's tree", async () => {
    const tenant = buildTenant("acme", { tenantsRoot: join(tmp, "tenants") });
    await withTenant(tenant, async () => {
      const store = createWikiStore({ specName: "spec", rootDir: join(tmp, "outside") });
      await expect(store.write({ slug: "a", title: "A", body: "b" })).rejects.toThrow(TenancyError);
    });
  });

  test("under a tenant the default root lands inside the tenant's tree and works", async () => {
    const tenant = buildTenant("acme", { tenantsRoot: join(tmp, "tenants") });
    await withTenant(tenant, async () => {
      const store = createWikiStore({ specName: "spec", now: makeClock() });
      expect(store.path()).toContain(join(tmp, "tenants", "acme", "wiki"));
      await store.write({ slug: "a", title: "A", body: "b" });
      expect((await store.get("a"))?.title).toBe("A");
    });
    expect(existsSync(join(tmp, "tenants", "acme", "wiki", "spec", "articles", "a.md"))).toBe(true);
  });

  test("an explicit tenant option fences without ambient context", async () => {
    const tenant = buildTenant("acme", { tenantsRoot: join(tmp, "tenants") });
    const store = createWikiStore({ specName: "spec", rootDir: join(tmp, "outside"), tenant });
    await expect(store.write({ slug: "a", title: "A", body: "b" })).rejects.toThrow(TenancyError);
  });
});

describe("store construction guards", () => {
  test("specName is required and path-safe", () => {
    expect(() => createWikiStore({ specName: "" })).toThrow(WikiStoreError);
    expect(() => createWikiStore({ specName: "../evil", rootDir: tmp })).toThrow(WikiStoreError);
  });
});
