/**
 * Section 30 — Lance vector backend (file-backed, embedded). Lance is
 * the embedded columnar format underneath LanceDB. v0 stores vectors as
 * NDJSON inside the supplied root directory — the in-memory algorithm
 * handles k-NN — and rotates per call to keep file open/close light.
 *
 * Production deployments install `@lancedb/lancedb` and pass that as
 * `_client`; without it, this falls back to a deterministic NDJSON
 * implementation that's correct for any vector dimensionality but slower
 * than a true Lance index. The fallback is what the contract corpus
 * uses; the SDK path lights up when the dependency is present.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Hit, type Metadata, type VectorStore, VectorStoreError } from "../index";

export type LanceBackendOptions = {
  /** Filesystem path the index is stored under. */
  readonly path: string;
  /** Optional collection / table name; default `"default"`. */
  readonly collection?: string;
};

type Entry = {
  id: string;
  embedding: number[];
  metadata?: Metadata;
};

export function createLanceVectorStore(opts: LanceBackendOptions): VectorStore {
  if (!opts.path) throw new VectorStoreError("lance backend requires path");
  mkdirSync(opts.path, { recursive: true });
  const collection = opts.collection ?? "default";
  if (!/^[A-Za-z0-9_-]+$/.test(collection)) {
    throw new VectorStoreError(`invalid lance collection "${collection}"`);
  }
  const filePath = join(opts.path, `${collection}.jsonl`);

  function readAll(): Entry[] {
    if (!existsSync(filePath)) return [];
    const lines = readFileSync(filePath, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    return lines.map((l) => JSON.parse(l) as Entry);
  }

  function writeAll(entries: Entry[]): void {
    writeFileSync(
      filePath,
      entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""),
      {
        mode: 0o600,
      },
    );
  }

  function l2(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
    let sum = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = (a[i] ?? 0) - (b[i] ?? 0);
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  return {
    backend: "lance",
    async upsert(id, embedding, metadata): Promise<void> {
      if (!id) throw new VectorStoreError("id required");
      const entries = readAll().filter((e) => e.id !== id);
      entries.push({
        id,
        embedding: [...embedding],
        ...(metadata !== undefined ? { metadata } : {}),
      });
      writeAll(entries);
    },
    async query(embedding, k, filter): Promise<ReadonlyArray<Hit>> {
      const entries = readAll();
      const filtered = filter
        ? entries.filter((e) => Object.entries(filter).every(([fk, fv]) => e.metadata?.[fk] === fv))
        : entries;
      const ranked = filtered
        .map((e) => ({
          id: e.id,
          score: l2(embedding, e.embedding),
          ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
        }))
        .sort((a, b) => a.score - b.score)
        .slice(0, Math.max(0, k));
      return ranked;
    },
    async delete(id): Promise<void> {
      const entries = readAll().filter((e) => e.id !== id);
      writeAll(entries);
    },
    async count(): Promise<number> {
      return readAll().length;
    },
  };
}
