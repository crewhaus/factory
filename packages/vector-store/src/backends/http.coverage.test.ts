/**
 * Section 30 — exhaustive coverage for the HTTP vector backends.
 *
 * Every request is served by a deterministic stub `fetchImpl` — no real
 * network, no real clock, no leaked handles. The default `fetch` is left
 * untouched (we never call `mock.module`); each test injects its own
 * `fetchImpl`, so there is nothing to restore in `afterEach`. The block
 * still guards that the global fetch was never swapped.
 *
 * These tests complement `backends.test.ts` (which exercises the happy
 * wire shapes) by driving the error / non-200 paths, the filter and
 * payload branches, and the `delete` / `count` operations of every
 * provider.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { VectorStoreError } from "../index";
import {
  createPineconeVectorStore,
  createQdrantVectorStore,
  createWeaviateVectorStore,
} from "./http";

const realFetch = globalThis.fetch;

type Call = { url: string; init?: RequestInit };

/**
 * Build a stub `fetch` that records every call and returns a fixed
 * response (or one chosen per-request via a function). Deterministic and
 * synchronous-resolving — no timers, no sockets.
 */
function stubFetch(responder: Response | ((call: Call) => Response)): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call: Call = { url, ...(init !== undefined ? { init } : {}) };
    calls.push(call);
    return typeof responder === "function" ? responder(call) : responder.clone();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

afterEach(() => {
  // Nothing here ever replaces the global fetch; assert that invariant so
  // a future careless edit can't leak a mock into sibling test files.
  expect(globalThis.fetch).toBe(realFetch);
});

describe("qdrant backend — full surface", () => {
  test("invalid collection name throws before any fetch", () => {
    const { fetchImpl, calls } = stubFetch(json({}));
    expect(() =>
      createQdrantVectorStore({ url: "http://q", collection: "bad name!", fetchImpl }),
    ).toThrow(VectorStoreError);
    expect(calls.length).toBe(0);
  });

  test("missing collection throws", () => {
    expect(() => createQdrantVectorStore({ url: "http://q", collection: "" })).toThrow(
      VectorStoreError,
    );
  });

  test("non-200 response surfaces status + body text", async () => {
    const { fetchImpl } = stubFetch(new Response("boom", { status: 500 }));
    const store = createQdrantVectorStore({ url: "http://q", collection: "c1", fetchImpl });
    await expect(store.upsert("a", [1, 0, 0])).rejects.toThrow(/qdrant PUT .* returned 500: boom/);
  });

  test("sends api-key header when apiKey is supplied", async () => {
    const { fetchImpl, calls } = stubFetch(json({}));
    const store = createQdrantVectorStore({
      url: "http://q",
      apiKey: "secret",
      collection: "c1",
      fetchImpl,
    });
    await store.upsert("a", [1, 0, 0]);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("secret");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("omits api-key header when apiKey is absent", async () => {
    const { fetchImpl, calls } = stubFetch(json({}));
    const store = createQdrantVectorStore({ url: "http://q", collection: "c1", fetchImpl });
    await store.upsert("a", [1, 0, 0]);
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect("api-key" in headers).toBe(false);
  });

  test("query with filter builds a must-match clause", async () => {
    const { fetchImpl, calls } = stubFetch(
      json({ result: [{ id: 42, score: 0.9, payload: { tag: "x" } }] }),
    );
    const store = createQdrantVectorStore({ url: "http://q", collection: "c1", fetchImpl });
    const hits = await store.query([1, 0, 0], 3, { tag: "x", lang: "en" });
    // numeric id is coerced to string; payload is surfaced as metadata.
    expect(hits[0]?.id).toBe("42");
    expect(hits[0]?.metadata).toEqual({ tag: "x" });
    const body = JSON.parse(calls[0]?.init?.body as string) as {
      filter: { must: Array<{ key: string; match: { value: unknown } }> };
      limit: number;
      with_payload: boolean;
    };
    expect(body.limit).toBe(3);
    expect(body.with_payload).toBe(true);
    expect(body.filter.must).toEqual([
      { key: "tag", match: { value: "x" } },
      { key: "lang", match: { value: "en" } },
    ]);
  });

  test("query without filter omits the filter clause and handles missing payload", async () => {
    const { fetchImpl, calls } = stubFetch(json({ result: [{ id: "p1", score: 0.5 }] }));
    const store = createQdrantVectorStore({ url: "http://q", collection: "c1", fetchImpl });
    const hits = await store.query([1, 0, 0], 1);
    expect(hits[0]?.id).toBe("p1");
    expect(hits[0]?.metadata).toBeUndefined();
    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect("filter" in body).toBe(false);
  });

  test("query non-200 throws", async () => {
    const { fetchImpl } = stubFetch(new Response("nope", { status: 404 }));
    const store = createQdrantVectorStore({ url: "http://q", collection: "c1", fetchImpl });
    await expect(store.query([1, 0, 0], 1)).rejects.toThrow(VectorStoreError);
  });

  test("delete POSTs the id to the delete endpoint", async () => {
    const { fetchImpl, calls } = stubFetch(json({}));
    const store = createQdrantVectorStore({ url: "http://q", collection: "c1", fetchImpl });
    await store.delete("a");
    expect(calls[0]?.url).toBe("http://q/collections/c1/points/delete");
    const body = JSON.parse(calls[0]?.init?.body as string) as { points: string[] };
    expect(body.points).toEqual(["a"]);
  });

  test("delete non-200 throws", async () => {
    const { fetchImpl } = stubFetch(new Response("err", { status: 500 }));
    const store = createQdrantVectorStore({ url: "http://q", collection: "c1", fetchImpl });
    await expect(store.delete("a")).rejects.toThrow(VectorStoreError);
  });

  test("count returns the exact count from the count endpoint", async () => {
    const { fetchImpl, calls } = stubFetch(json({ result: { count: 7 } }));
    const store = createQdrantVectorStore({ url: "http://q", collection: "c1", fetchImpl });
    expect(await store.count()).toBe(7);
    expect(calls[0]?.url).toBe("http://q/collections/c1/points/count");
    const body = JSON.parse(calls[0]?.init?.body as string) as { exact: boolean };
    expect(body.exact).toBe(true);
  });

  test("count non-200 throws", async () => {
    const { fetchImpl } = stubFetch(new Response("err", { status: 503 }));
    const store = createQdrantVectorStore({ url: "http://q", collection: "c1", fetchImpl });
    await expect(store.count()).rejects.toThrow(VectorStoreError);
  });
});

describe("pinecone backend — full surface", () => {
  test("invalid collection name throws", () => {
    expect(() =>
      createPineconeVectorStore({ url: "http://p", apiKey: "k", collection: "bad/name" }),
    ).toThrow(VectorStoreError);
  });

  test("missing url throws", () => {
    expect(() => createPineconeVectorStore({ url: "", apiKey: "k", collection: "c" })).toThrow(
      VectorStoreError,
    );
  });

  test("upsert includes metadata and sends Api-Key header", async () => {
    const { fetchImpl, calls } = stubFetch(json({}));
    const store = createPineconeVectorStore({
      url: "http://p",
      apiKey: "k",
      collection: "c",
      fetchImpl,
    });
    await store.upsert("a", [1, 0], { tag: "x" });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Api-Key"]).toBe("k");
    const body = JSON.parse(calls[0]?.init?.body as string) as {
      vectors: Array<{ id: string; metadata?: Record<string, unknown> }>;
    };
    expect(body.vectors[0]?.metadata).toEqual({ tag: "x" });
  });

  test("upsert non-200 throws", async () => {
    const { fetchImpl } = stubFetch(new Response("bad", { status: 400 }));
    const store = createPineconeVectorStore({
      url: "http://p",
      apiKey: "k",
      collection: "c",
      fetchImpl,
    });
    await expect(store.upsert("a", [1, 0])).rejects.toThrow(/pinecone upsert returned 400: bad/);
  });

  test("query non-200 throws", async () => {
    const { fetchImpl } = stubFetch(new Response("bad", { status: 401 }));
    const store = createPineconeVectorStore({
      url: "http://p",
      apiKey: "k",
      collection: "c",
      fetchImpl,
    });
    await expect(store.query([1, 0], 1)).rejects.toThrow(VectorStoreError);
  });

  test("query maps matches with and without metadata and passes filter through", async () => {
    const { fetchImpl, calls } = stubFetch(
      json({
        matches: [
          { id: "a", score: 0.9, metadata: { tag: "x" } },
          { id: "b", score: 0.4 },
        ],
      }),
    );
    const store = createPineconeVectorStore({
      url: "http://p",
      apiKey: "k",
      collection: "c",
      fetchImpl,
    });
    const hits = await store.query([1, 0], 2, { tag: "x" });
    expect(hits[0]?.metadata).toEqual({ tag: "x" });
    expect(hits[1]?.metadata).toBeUndefined();
    const body = JSON.parse(calls[0]?.init?.body as string) as { filter?: unknown; topK: number };
    expect(body.topK).toBe(2);
    expect(body.filter).toEqual({ tag: "x" });
  });

  test("query without filter omits the filter key and tolerates a missing matches array", async () => {
    const { fetchImpl, calls } = stubFetch(json({}));
    const store = createPineconeVectorStore({
      url: "http://p",
      apiKey: "k",
      collection: "c",
      fetchImpl,
    });
    const hits = await store.query([1, 0], 1);
    expect(hits).toEqual([]);
    const body = JSON.parse(calls[0]?.init?.body as string) as Record<string, unknown>;
    expect("filter" in body).toBe(false);
  });

  test("delete POSTs ids + namespace", async () => {
    const { fetchImpl, calls } = stubFetch(json({}));
    const store = createPineconeVectorStore({
      url: "http://p",
      apiKey: "k",
      collection: "c",
      fetchImpl,
    });
    await store.delete("a");
    expect(calls[0]?.url).toBe("http://p/vectors/delete");
    const body = JSON.parse(calls[0]?.init?.body as string) as { ids: string[]; namespace: string };
    expect(body.ids).toEqual(["a"]);
    expect(body.namespace).toBe("c");
  });

  test("delete non-200 throws", async () => {
    const { fetchImpl } = stubFetch(new Response("err", { status: 500 }));
    const store = createPineconeVectorStore({
      url: "http://p",
      apiKey: "k",
      collection: "c",
      fetchImpl,
    });
    await expect(store.delete("a")).rejects.toThrow(VectorStoreError);
  });

  test("count reads vectorCount for the configured namespace", async () => {
    const { fetchImpl, calls } = stubFetch(
      json({ namespaces: { c: { vectorCount: 12 }, other: { vectorCount: 99 } } }),
    );
    const store = createPineconeVectorStore({
      url: "http://p",
      apiKey: "k",
      collection: "c",
      fetchImpl,
    });
    expect(await store.count()).toBe(12);
    expect(calls[0]?.url).toBe("http://p/describe_index_stats");
  });

  test("count falls back to 0 when the namespace is absent", async () => {
    const { fetchImpl } = stubFetch(json({ namespaces: {} }));
    const store = createPineconeVectorStore({
      url: "http://p",
      apiKey: "k",
      collection: "c",
      fetchImpl,
    });
    expect(await store.count()).toBe(0);
  });

  test("count non-200 throws", async () => {
    const { fetchImpl } = stubFetch(new Response("err", { status: 500 }));
    const store = createPineconeVectorStore({
      url: "http://p",
      apiKey: "k",
      collection: "c",
      fetchImpl,
    });
    await expect(store.count()).rejects.toThrow(VectorStoreError);
  });
});

describe("weaviate backend — full surface", () => {
  test("invalid collection name throws", () => {
    expect(() => createWeaviateVectorStore({ url: "http://w", collection: "bad name" })).toThrow(
      VectorStoreError,
    );
  });

  test("missing collection throws", () => {
    expect(() => createWeaviateVectorStore({ url: "http://w", collection: "" })).toThrow(
      VectorStoreError,
    );
  });

  test("upsert sends Authorization header and properties when apiKey + metadata present", async () => {
    const { fetchImpl, calls } = stubFetch(json({}));
    const store = createWeaviateVectorStore({
      url: "http://w",
      apiKey: "tok",
      collection: "MyClass",
      fetchImpl,
    });
    await store.upsert("a", [1, 0], { tag: "x" });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    const body = JSON.parse(calls[0]?.init?.body as string) as {
      properties?: Record<string, unknown>;
    };
    expect(body.properties).toEqual({ tag: "x" });
  });

  test("upsert treats 422 (already exists) as success", async () => {
    const { fetchImpl } = stubFetch(new Response("exists", { status: 422 }));
    const store = createWeaviateVectorStore({ url: "http://w", collection: "MyClass", fetchImpl });
    await expect(store.upsert("a", [1, 0])).resolves.toBeUndefined();
  });

  test("upsert non-200 (and not 422) throws", async () => {
    const { fetchImpl } = stubFetch(new Response("nope", { status: 500 }));
    const store = createWeaviateVectorStore({ url: "http://w", collection: "MyClass", fetchImpl });
    await expect(store.upsert("a", [1, 0])).rejects.toThrow(/weaviate upsert returned 500: nope/);
  });

  test("query non-200 throws", async () => {
    const { fetchImpl } = stubFetch(new Response("nope", { status: 500 }));
    const store = createWeaviateVectorStore({ url: "http://w", collection: "MyClass", fetchImpl });
    await expect(store.query([1, 0], 1)).rejects.toThrow(VectorStoreError);
  });

  test("query returns empty when the GraphQL data block is absent", async () => {
    const { fetchImpl } = stubFetch(json({}));
    const store = createWeaviateVectorStore({ url: "http://w", collection: "MyClass", fetchImpl });
    expect(await store.query([1, 0], 1)).toEqual([]);
  });

  test("delete treats 404 as success (idempotent)", async () => {
    const { fetchImpl, calls } = stubFetch(new Response("", { status: 404 }));
    const store = createWeaviateVectorStore({ url: "http://w", collection: "MyClass", fetchImpl });
    await expect(store.delete("a")).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe("http://w/v1/objects/MyClass/a");
  });

  test("delete non-200 (and not 404) throws", async () => {
    const { fetchImpl } = stubFetch(new Response("err", { status: 500 }));
    const store = createWeaviateVectorStore({ url: "http://w", collection: "MyClass", fetchImpl });
    await expect(store.delete("a")).rejects.toThrow(/weaviate delete returned 500: err/);
  });

  test("count parses the Aggregate meta count", async () => {
    const { fetchImpl, calls } = stubFetch(
      json({ data: { Aggregate: { MyClass: [{ meta: { count: 5 } }] } } }),
    );
    const store = createWeaviateVectorStore({ url: "http://w", collection: "MyClass", fetchImpl });
    expect(await store.count()).toBe(5);
    expect(calls[0]?.url).toBe("http://w/v1/graphql");
    expect(calls[0]?.init?.body as string).toContain("Aggregate");
  });

  test("count returns 0 on a non-200 response", async () => {
    const { fetchImpl } = stubFetch(new Response("err", { status: 500 }));
    const store = createWeaviateVectorStore({ url: "http://w", collection: "MyClass", fetchImpl });
    expect(await store.count()).toBe(0);
  });

  test("count falls back to 0 when the Aggregate block is missing", async () => {
    const { fetchImpl } = stubFetch(json({ data: {} }));
    const store = createWeaviateVectorStore({ url: "http://w", collection: "MyClass", fetchImpl });
    expect(await store.count()).toBe(0);
  });
});
