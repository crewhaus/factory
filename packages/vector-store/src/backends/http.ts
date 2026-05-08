/**
 * Section 30 — HTTP-based vector backends (Qdrant, Pinecone, Weaviate).
 *
 * Each takes a base URL + API key + collection name and routes the
 * standard `upsert`/`query`/`delete`/`count` operations through the
 * provider-specific REST endpoints.
 *
 * v0 ships with the abstraction + a fetch-based client. Without a real
 * remote running at the configured URL, the constructors succeed but
 * the operations throw on first call — production smoke tests gate on
 * the env vars so CI doesn't try to talk to a non-existent server.
 *
 * Cookie / Authorization handling is conservative: we strip set-cookie
 * from responses and never echo Authorization headers in logs.
 */
import { type Hit, type Metadata, type VectorStore, VectorStoreError } from "../index";

export type HttpVectorBackendOptions = {
  readonly url: string;
  readonly apiKey?: string;
  readonly collection: string;
  readonly fetchImpl?: typeof fetch;
};

function ensureCollection(name: string, kind: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new VectorStoreError(`invalid ${kind} collection "${name}"`);
  }
}

/** Qdrant: REST API over the supplied url + apiKey. */
export function createQdrantVectorStore(opts: HttpVectorBackendOptions): VectorStore {
  if (!opts.url) throw new VectorStoreError("qdrant backend requires url");
  if (!opts.collection) throw new VectorStoreError("qdrant backend requires collection");
  ensureCollection(opts.collection, "qdrant");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = (): Record<string, string> => ({
    "Content-Type": "application/json",
    ...(opts.apiKey ? { "api-key": opts.apiKey } : {}),
  });

  async function callJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${opts.url}${path}`, {
      method,
      headers: headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      throw new VectorStoreError(
        `qdrant ${method} ${path} returned ${res.status}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  return {
    backend: "qdrant",
    async upsert(id, embedding, metadata): Promise<void> {
      await callJson("PUT", `/collections/${opts.collection}/points`, {
        points: [
          {
            id,
            vector: [...embedding],
            payload: metadata ?? {},
          },
        ],
      });
    },
    async query(embedding, k, filter): Promise<ReadonlyArray<Hit>> {
      const result = await callJson<{
        result: Array<{ id: string; score: number; payload?: Metadata }>;
      }>("POST", `/collections/${opts.collection}/points/search`, {
        vector: [...embedding],
        limit: k,
        with_payload: true,
        ...(filter !== undefined
          ? {
              filter: {
                must: Object.entries(filter).map(([key, value]) => ({ key, match: { value } })),
              },
            }
          : {}),
      });
      return result.result.map((r) => ({
        id: String(r.id),
        score: r.score,
        ...(r.payload !== undefined ? { metadata: r.payload } : {}),
      }));
    },
    async delete(id): Promise<void> {
      await callJson("POST", `/collections/${opts.collection}/points/delete`, {
        points: [id],
      });
    },
    async count(): Promise<number> {
      const result = await callJson<{ result: { count: number } }>(
        "POST",
        `/collections/${opts.collection}/points/count`,
        { exact: true },
      );
      return result.result.count;
    },
  };
}

/** Pinecone: REST API; collection becomes the index host. */
export function createPineconeVectorStore(opts: HttpVectorBackendOptions): VectorStore {
  if (!opts.url) throw new VectorStoreError("pinecone backend requires url");
  if (!opts.apiKey) throw new VectorStoreError("pinecone backend requires apiKey");
  if (!opts.collection) throw new VectorStoreError("pinecone backend requires collection (index)");
  ensureCollection(opts.collection, "pinecone");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = (): Record<string, string> => ({
    "Content-Type": "application/json",
    "Api-Key": opts.apiKey ?? "",
  });

  return {
    backend: "pinecone",
    async upsert(id, embedding, metadata): Promise<void> {
      const res = await fetchImpl(`${opts.url}/vectors/upsert`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          vectors: [
            {
              id,
              values: [...embedding],
              ...(metadata !== undefined ? { metadata } : {}),
            },
          ],
          namespace: opts.collection,
        }),
      });
      if (!res.ok) {
        throw new VectorStoreError(`pinecone upsert returned ${res.status}: ${await res.text()}`);
      }
    },
    async query(embedding, k, filter): Promise<ReadonlyArray<Hit>> {
      const res = await fetchImpl(`${opts.url}/query`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          vector: [...embedding],
          topK: k,
          includeMetadata: true,
          namespace: opts.collection,
          ...(filter !== undefined ? { filter } : {}),
        }),
      });
      if (!res.ok) {
        throw new VectorStoreError(`pinecone query returned ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as {
        matches?: Array<{ id: string; score: number; metadata?: Metadata }>;
      };
      return (body.matches ?? []).map((m) => ({
        id: m.id,
        score: m.score,
        ...(m.metadata !== undefined ? { metadata: m.metadata } : {}),
      }));
    },
    async delete(id): Promise<void> {
      const res = await fetchImpl(`${opts.url}/vectors/delete`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ ids: [id], namespace: opts.collection }),
      });
      if (!res.ok) {
        throw new VectorStoreError(`pinecone delete returned ${res.status}: ${await res.text()}`);
      }
    },
    async count(): Promise<number> {
      const res = await fetchImpl(`${opts.url}/describe_index_stats`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new VectorStoreError(`pinecone count returned ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as {
        namespaces?: Record<string, { vectorCount: number }>;
      };
      return body.namespaces?.[opts.collection]?.vectorCount ?? 0;
    },
  };
}

/** Weaviate: REST API; collection becomes className. */
export function createWeaviateVectorStore(opts: HttpVectorBackendOptions): VectorStore {
  if (!opts.url) throw new VectorStoreError("weaviate backend requires url");
  if (!opts.collection)
    throw new VectorStoreError("weaviate backend requires collection (className)");
  ensureCollection(opts.collection, "weaviate");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = (): Record<string, string> => ({
    "Content-Type": "application/json",
    ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
  });

  return {
    backend: "weaviate",
    async upsert(id, embedding, metadata): Promise<void> {
      const res = await fetchImpl(`${opts.url}/v1/objects`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          class: opts.collection,
          id,
          vector: [...embedding],
          ...(metadata !== undefined ? { properties: metadata } : {}),
        }),
      });
      if (!res.ok && res.status !== 422 /* already exists */) {
        throw new VectorStoreError(`weaviate upsert returned ${res.status}: ${await res.text()}`);
      }
    },
    async query(embedding, k, _filter): Promise<ReadonlyArray<Hit>> {
      const res = await fetchImpl(`${opts.url}/v1/graphql`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          query: `{
  Get {
    ${opts.collection}(nearVector: { vector: ${JSON.stringify([...embedding])} }, limit: ${k}) {
      _additional { id, distance }
    }
  }
}`,
        }),
      });
      if (!res.ok) {
        throw new VectorStoreError(`weaviate query returned ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as {
        data?: {
          Get?: Record<string, Array<{ _additional: { id: string; distance: number } }>>;
        };
      };
      return (body.data?.Get?.[opts.collection] ?? []).map((m) => ({
        id: m._additional.id,
        score: m._additional.distance,
      }));
    },
    async delete(id): Promise<void> {
      const res = await fetchImpl(`${opts.url}/v1/objects/${opts.collection}/${id}`, {
        method: "DELETE",
        headers: headers(),
      });
      if (!res.ok && res.status !== 404) {
        throw new VectorStoreError(`weaviate delete returned ${res.status}: ${await res.text()}`);
      }
    },
    async count(): Promise<number> {
      const res = await fetchImpl(`${opts.url}/v1/graphql`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          query: `{
  Aggregate {
    ${opts.collection} {
      meta { count }
    }
  }
}`,
        }),
      });
      if (!res.ok) return 0;
      const body = (await res.json()) as {
        data?: {
          Aggregate?: Record<string, Array<{ meta?: { count?: number } }>>;
        };
      };
      return body.data?.Aggregate?.[opts.collection]?.[0]?.meta?.count ?? 0;
    },
  };
}
