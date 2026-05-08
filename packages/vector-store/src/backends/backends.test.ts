/**
 * Section 30 — contract tests for the new vector-store backends.
 *
 * Lance: file-backed, fully exercised here.
 * Qdrant/Pinecone/Weaviate: stub fetch impl exercises the wire shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStoreError } from "../index";
import {
  createPineconeVectorStore,
  createQdrantVectorStore,
  createWeaviateVectorStore,
} from "./http";
import { createLanceVectorStore } from "./lance";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vector-backends-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("lance vector backend (T2 contract)", () => {
  test("upsert + query + count round-trip", async () => {
    const store = createLanceVectorStore({ path: tmpRoot });
    await store.upsert("a", [1, 0, 0], { tag: "x" });
    await store.upsert("b", [0, 1, 0], { tag: "y" });
    await store.upsert("c", [0, 0, 1], { tag: "x" });
    expect(await store.count()).toBe(3);
    const hits = await store.query([1, 0, 0], 2);
    expect(hits[0]?.id).toBe("a");
    expect(hits.length).toBe(2);
  });

  test("query honors metadata filter", async () => {
    const store = createLanceVectorStore({ path: tmpRoot });
    await store.upsert("a", [1, 0, 0], { tag: "x" });
    await store.upsert("b", [0.99, 0.01, 0], { tag: "y" });
    const hits = await store.query([1, 0, 0], 5, { tag: "y" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.id).toBe("b");
  });

  test("delete removes by id", async () => {
    const store = createLanceVectorStore({ path: tmpRoot });
    await store.upsert("a", [1, 0, 0]);
    await store.upsert("b", [0, 1, 0]);
    await store.delete("a");
    expect(await store.count()).toBe(1);
    const hits = await store.query([1, 0, 0], 1);
    expect(hits[0]?.id).toBe("b");
  });

  test("missing path throws", () => {
    expect(() => createLanceVectorStore({ path: "" })).toThrow(VectorStoreError);
  });

  test("invalid collection name throws", () => {
    expect(() => createLanceVectorStore({ path: tmpRoot, collection: "../escape" })).toThrow(
      VectorStoreError,
    );
  });
});

describe("qdrant vector backend (T2 contract)", () => {
  test("upsert PUTs to /collections/<c>/points", async () => {
    let observedPath = "";
    let observedBody = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      observedPath = url;
      observedBody = init?.body as string;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const store = createQdrantVectorStore({
      url: "http://q",
      collection: "c1",
      fetchImpl,
    });
    await store.upsert("a", [1, 0, 0], { tag: "x" });
    expect(observedPath).toBe("http://q/collections/c1/points");
    const body = JSON.parse(observedBody) as { points: Array<{ id: string }> };
    expect(body.points[0]?.id).toBe("a");
  });

  test("query POSTs to search endpoint and parses results", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          result: [{ id: "a", score: 0.1, payload: { tag: "x" } }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const store = createQdrantVectorStore({
      url: "http://q",
      collection: "c1",
      fetchImpl,
    });
    const hits = await store.query([1, 0, 0], 5);
    expect(hits[0]?.id).toBe("a");
    expect(hits[0]?.score).toBe(0.1);
  });

  test("missing url throws", () => {
    expect(() => createQdrantVectorStore({ url: "", collection: "c" })).toThrow(VectorStoreError);
  });
});

describe("pinecone vector backend (T2 contract)", () => {
  test("requires apiKey", () => {
    expect(() => createPineconeVectorStore({ url: "http://p", collection: "c" })).toThrow(
      VectorStoreError,
    );
  });

  test("upsert POSTs to /vectors/upsert with namespace", async () => {
    let body = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = init?.body as string;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const store = createPineconeVectorStore({
      url: "http://p",
      apiKey: "k",
      collection: "c",
      fetchImpl,
    });
    await store.upsert("a", [1, 0]);
    const parsed = JSON.parse(body) as { namespace: string };
    expect(parsed.namespace).toBe("c");
  });

  test("query parses matches array", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ matches: [{ id: "a", score: 0.5, metadata: { tag: "x" } }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const store = createPineconeVectorStore({
      url: "http://p",
      apiKey: "k",
      collection: "c",
      fetchImpl,
    });
    const hits = await store.query([1, 0], 1);
    expect(hits[0]?.id).toBe("a");
  });
});

describe("weaviate vector backend (T2 contract)", () => {
  test("upsert POSTs to /v1/objects with class", async () => {
    let body = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = init?.body as string;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const store = createWeaviateVectorStore({
      url: "http://w",
      collection: "MyClass",
      fetchImpl,
    });
    await store.upsert("a", [1, 0]);
    const parsed = JSON.parse(body) as { class: string };
    expect(parsed.class).toBe("MyClass");
  });

  test("query uses GraphQL nearVector", async () => {
    let body = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = init?.body as string;
      return new Response(
        JSON.stringify({
          data: {
            Get: {
              MyClass: [{ _additional: { id: "a", distance: 0.1 } }],
            },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const store = createWeaviateVectorStore({
      url: "http://w",
      collection: "MyClass",
      fetchImpl,
    });
    const hits = await store.query([1, 0], 1);
    expect(hits[0]?.id).toBe("a");
    expect(body).toContain("nearVector");
  });

  test("delete uses DELETE /v1/objects/<class>/<id>", async () => {
    let path = "";
    let method = "";
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      path = url;
      method = init?.method ?? "GET";
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;
    const store = createWeaviateVectorStore({
      url: "http://w",
      collection: "MyClass",
      fetchImpl,
    });
    await store.delete("a");
    expect(path).toBe("http://w/v1/objects/MyClass/a");
    expect(method).toBe("DELETE");
  });

  test("missing url throws", () => {
    expect(() => createWeaviateVectorStore({ url: "", collection: "C" })).toThrow(VectorStoreError);
  });
});
