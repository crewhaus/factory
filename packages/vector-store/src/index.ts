/**
 * Catalog R12 `vector-store` — vector index abstraction.
 *
 *   const store = createVectorStore({ backend: "in-memory" });
 *   await store.upsert("id1", [0.1, 0.2, 0.3], { docId: "..." });
 *   const hits = await store.query([0.1, 0.2, 0.3], 5);
 *   await store.delete("id1");
 *
 * Backends:
 *   "in-memory" — flat L2 distance over an in-process Map (default).
 *   "lance"     — file-backed Lance index. NOT yet implemented; throws
 *                 a clear NotImplementedError so callers know to wire
 *                 a real adapter.
 *   "qdrant" / "pinecone" / "weaviate" — deferred to a follow-up. The
 *                 default factory throws to keep production deployments
 *                 from accidentally falling through.
 *
 * Filter shape: a flat `Record<string, unknown>` of metadata predicates.
 * The in-memory backend supports exact-equality only. Strings that
 * look like SQL injection (`=`, `;`, `'`, `"`, `--`) are rejected at
 * the boundary so attacker-controlled filters cannot bend the
 * predicate.
 *
 * Layer R12. Pairs with `chunker`, `embedder`, `tool-retrieve`.
 */

import { CrewhausError } from "@crewhaus/errors";

export type VectorBackendId = "in-memory" | "lance" | "qdrant" | "pinecone" | "weaviate";

export type Metadata = Readonly<Record<string, unknown>>;

export type Hit = {
  readonly id: string;
  readonly score: number;
  readonly metadata?: Metadata;
};

export type VectorStoreOptions = {
  readonly backend: VectorBackendId;
  /** HTTP backends only — base URL of the remote service. */
  readonly url?: string;
  readonly apiKey?: string;
  readonly collection?: string;
};

export interface VectorStore {
  readonly backend: VectorBackendId;
  upsert(id: string, embedding: ReadonlyArray<number>, metadata?: Metadata): Promise<void>;
  query(
    embedding: ReadonlyArray<number>,
    k: number,
    filter?: Metadata,
  ): Promise<ReadonlyArray<Hit>>;
  delete(id: string): Promise<void>;
  count(): Promise<number>;
  close?(): Promise<void>;
}

export class VectorStoreError extends CrewhausError {
  override readonly name = "VectorStoreError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

const FILTER_BAD_RE = /[;'"`]|(\s|^)(?:--|\/\*|\*\/)|=\s*1|or\s+1\s*=\s*1/i;

function validateFilter(filter: Metadata | undefined): void {
  if (filter === undefined) return;
  for (const [k, v] of Object.entries(filter)) {
    if (typeof k !== "string" || k.length === 0) {
      throw new VectorStoreError("filter keys must be non-empty strings");
    }
    if (FILTER_BAD_RE.test(k)) {
      throw new VectorStoreError(`filter key "${k}" looks like an injection probe — refused`);
    }
    if (typeof v === "string" && FILTER_BAD_RE.test(v)) {
      throw new VectorStoreError(`filter value for "${k}" looks like an injection probe — refused`);
    }
  }
}

function l2Distance(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length) {
    throw new VectorStoreError(`dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    const diff = ai - bi;
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

class InMemoryVectorStore implements VectorStore {
  readonly backend: VectorBackendId = "in-memory";
  private readonly entries = new Map<
    string,
    { embedding: ReadonlyArray<number>; metadata?: Metadata }
  >();

  async upsert(id: string, embedding: ReadonlyArray<number>, metadata?: Metadata): Promise<void> {
    if (typeof id !== "string" || id.length === 0) {
      throw new VectorStoreError("id must be a non-empty string");
    }
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new VectorStoreError("embedding must be a non-empty number array");
    }
    this.entries.set(id, {
      embedding,
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }

  async query(
    embedding: ReadonlyArray<number>,
    k: number,
    filter?: Metadata,
  ): Promise<ReadonlyArray<Hit>> {
    validateFilter(filter);
    if (k <= 0) throw new VectorStoreError("k must be positive");
    const matches: Hit[] = [];
    for (const [id, entry] of this.entries.entries()) {
      if (filter !== undefined) {
        let ok = true;
        for (const [fk, fv] of Object.entries(filter)) {
          if (entry.metadata?.[fk] !== fv) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
      }
      const score = -l2Distance(embedding, entry.embedding);
      matches.push({
        id,
        score,
        ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, k);
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async count(): Promise<number> {
    return this.entries.size;
  }
}

class NotImplementedVectorStore implements VectorStore {
  readonly backend: VectorBackendId;
  constructor(backend: VectorBackendId) {
    this.backend = backend;
  }
  private fail(): never {
    throw new VectorStoreError(
      `vector-store backend "${this.backend}" is not implemented in v0 — use "in-memory" for tests or wire your own adapter`,
    );
  }
  async upsert(): Promise<void> {
    this.fail();
  }
  async query(): Promise<ReadonlyArray<Hit>> {
    this.fail();
  }
  async delete(): Promise<void> {
    this.fail();
  }
  async count(): Promise<number> {
    this.fail();
  }
}

export function createVectorStore(opts: VectorStoreOptions): VectorStore {
  switch (opts.backend) {
    case "in-memory":
      return new InMemoryVectorStore();
    case "lance": {
      const lance = require("./backends/lance") as typeof import("./backends/lance");
      return lance.createLanceVectorStore({
        path: opts.url ?? ".crewhaus/vectors/lance",
        ...(opts.collection !== undefined ? { collection: opts.collection } : {}),
      });
    }
    case "qdrant":
    case "pinecone":
    case "weaviate": {
      if (!opts.url) {
        throw new VectorStoreError(`${opts.backend} backend requires url`);
      }
      if (!opts.collection) {
        throw new VectorStoreError(`${opts.backend} backend requires collection`);
      }
      const httpOpts = {
        url: opts.url,
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        collection: opts.collection,
      };
      const { createQdrantVectorStore, createPineconeVectorStore, createWeaviateVectorStore } =
        require("./backends/http") as typeof import("./backends/http");
      if (opts.backend === "qdrant") return createQdrantVectorStore(httpOpts);
      if (opts.backend === "pinecone") return createPineconeVectorStore(httpOpts);
      return createWeaviateVectorStore(httpOpts);
    }
    default: {
      const exhaustive: never = opts.backend;
      throw new VectorStoreError(`unknown backend "${exhaustive}"`);
    }
  }
}

// Section 30 — direct backend exports for callers that need custom auth.
export {
  createLanceVectorStore,
  type LanceBackendOptions,
} from "./backends/lance";
export {
  createPineconeVectorStore,
  createQdrantVectorStore,
  createWeaviateVectorStore,
  type HttpVectorBackendOptions,
} from "./backends/http";
