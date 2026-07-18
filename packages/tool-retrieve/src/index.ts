/**
 * Catalog R12 `tool-retrieve` — `Retrieve(query, k?, filter?)` agent tool.
 *
 * Embeds the query via the configured embedder, queries the vector
 * store for top-k hits, and returns a numbered list with citations
 * the model can read (`[1] (id=…) text…`).
 *
 * Configuration is registered at boot via
 * `registerRetrieveConfig({ embedder, vectorStore, defaultK? })` so
 * the codegen layer can wire the tool with whichever backends the
 * spec declares (the pipeline shape's path).
 *
 * The agent-shape RAG path (`knowledge:` on cli/channel/managed, Batch E
 * item 3/G22) is served by {@link knowledgeRetrieve}: it ingests declared
 * `sources` (path/glob/url) through the SAME chunker → embedder →
 * vector-store engine target-pipeline emits inline, then hands back a
 * self-contained `Retrieve` tool bound to its own config (no module
 * singleton). {@link resolveKnowledgeEmbedder} enforces the G76 embedder
 * resolution order the emitters share.
 *
 * Layer R12. Pairs with `embedder`, `vector-store`, `chunker`,
 * `pipeline-engine`, `target-pipeline`, `target-cli`/`-channel-bot`/`-managed`.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { type ChunkStrategy, type Document, chunk } from "@crewhaus/chunker";
import { type Embedder, createEmbedder } from "@crewhaus/embedder";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { type VectorBackendId, type VectorStore, createVectorStore } from "@crewhaus/vector-store";
import { z } from "zod";

export class RetrieveConfigError extends CrewhausError {
  override readonly name = "RetrieveConfigError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export type RetrieveConfig = {
  readonly embedder: Embedder;
  readonly vectorStore: VectorStore;
  readonly defaultK?: number;
};

export type RetrieveConfigInput = {
  readonly embedder?: Embedder;
  readonly embedderModel?: string;
  readonly embedderApiKey?: string;
  readonly vectorStore?: VectorStore;
  readonly vectorBackend?: VectorBackendId;
  /**
   * Connection config for the chosen `vectorBackend`, consulted only when no
   * `vectorStore` instance is supplied. Mirrors the pipeline spec's
   * `retrieve.{url,collection,apiKey}`. The HTTP backends
   * (qdrant/pinecone/weaviate) require `url` + `collection`; lance reads
   * `url` as its on-disk index path. `apiKey` here is the vector store's,
   * distinct from `embedderApiKey`. (At runtime the caller passes the
   * resolved secret — there is no bundle to keep it out of.)
   */
  readonly url?: string;
  readonly collection?: string;
  readonly apiKey?: string;
  readonly defaultK?: number;
  readonly default_k?: number;
};

let activeConfig: RetrieveConfig | undefined;

export function registerRetrieveConfig(input: RetrieveConfigInput): void {
  let embedder = input.embedder;
  if (embedder === undefined && input.embedderModel !== undefined) {
    embedder = createEmbedder({
      model: input.embedderModel,
      ...(input.embedderApiKey !== undefined ? { apiKey: input.embedderApiKey } : {}),
    });
  }
  let vectorStore = input.vectorStore;
  if (vectorStore === undefined) {
    vectorStore = createVectorStore({
      backend: input.vectorBackend ?? "in-memory",
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      ...(input.collection !== undefined ? { collection: input.collection } : {}),
    });
  }
  if (embedder === undefined) {
    throw new RetrieveConfigError(
      "registerRetrieveConfig requires either an `embedder` instance or `embedderModel` string",
    );
  }
  activeConfig = {
    embedder,
    vectorStore,
    ...((input.defaultK ?? input.default_k !== undefined)
      ? { defaultK: input.defaultK ?? input.default_k }
      : {}),
  };
}

export function getRetrieveConfig(): RetrieveConfig | undefined {
  return activeConfig;
}

/** Test-only — clear cached config. */
export function _resetRetrieveConfig(): void {
  activeConfig = undefined;
}

const retrieveSchema = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().max(50).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
});

type RetrieveInput = z.infer<typeof retrieveSchema>;

function formatHits(
  hits: ReadonlyArray<{ id: string; score: number; metadata?: Readonly<Record<string, unknown>> }>,
): string {
  if (hits.length === 0) return "no hits";
  const lines: string[] = [];
  hits.forEach((h, i) => {
    const text = (h.metadata?.["text"] as string | undefined) ?? "";
    const docId = (h.metadata?.["docId"] as string | undefined) ?? "?";
    const preview = text.length > 280 ? `${text.slice(0, 280)}…` : text;
    lines.push(`[${i + 1}] id=${h.id} doc=${docId} score=${h.score.toFixed(4)}\n${preview}`);
  });
  return lines.join("\n\n");
}

/**
 * Build a `Retrieve` tool whose backends come from `getConfig` at call time.
 * Shared by the singleton `retrieve` export (pipeline shape — reads
 * `activeConfig`) and every {@link knowledgeRetrieve} tool (agent shape —
 * reads its own captured, already-ingested config), so the schema,
 * citation formatting, and safety flags never fork between the two paths.
 */
function makeRetrieveTool(getConfig: () => RetrieveConfig | undefined): RegisteredTool {
  return buildTool({
    name: "Retrieve",
    description:
      "Retrieve top-k chunks from the configured vector store for a natural-language query. Pass `query` (required), optional `k` (default 5), and optional `filter` (metadata predicates). Returns a numbered list of hits with citations.",
    inputSchema: retrieveSchema,
    readOnly: true,
    concurrencySafe: true,
    execute: async (input) => {
      const cfg = getConfig();
      if (cfg === undefined) {
        throw new RetrieveConfigError(
          "Retrieve tool is unconfigured — call registerRetrieveConfig at boot",
        );
      }
      const inp = input as RetrieveInput;
      const k = inp.k ?? cfg.defaultK ?? 5;
      const [vec] = await cfg.embedder.embed([inp.query]);
      if (vec === undefined) {
        throw new RetrieveConfigError("embedder returned 0 vectors for the query");
      }
      const hits = await cfg.vectorStore.query(vec, k, inp.filter);
      return formatHits(hits);
    },
  });
}

export const retrieve: RegisteredTool = makeRetrieveTool(() => activeConfig);

// ===========================================================================
// Agent-shape RAG — `knowledge:` on cli/channel/managed (Batch E item 3, G22)
// ===========================================================================

/** The target's default embedder model when nothing else resolves (G76). A
 *  vector store needs embeddings, so knowledge RAG never degrades to BM25 —
 *  this is the floor {@link resolveKnowledgeEmbedder} lands on. Mirrors the
 *  egress-classifier default model the serving emitters already carry. */
export const DEFAULT_KNOWLEDGE_EMBEDDER_MODEL = "openai/text-embedding-3-small";

/** Resolved knowledge-RAG defaults — kept in lockstep with the pipeline
 *  retrieve engine (`in-memory` / k=5 / 400-char chunks / no overlap) so a
 *  `knowledge:` block and a `retrieve:` block index identically. */
export const DEFAULT_KNOWLEDGE_K = 5;
export const DEFAULT_KNOWLEDGE_CHUNK_SIZE = 400;
export const DEFAULT_KNOWLEDGE_CHUNK_OVERLAP = 0;
/** Knowledge sources are arbitrary docs, so the general-purpose fixed-window
 *  strategy is the safe default (pipeline lets the spec pick; `knowledge:`
 *  carries only size/overlap, so the strategy is fixed here). */
export const DEFAULT_KNOWLEDGE_CHUNK_STRATEGY: ChunkStrategy = "fixed";

/**
 * One declared knowledge corpus entry — EXACTLY one of path/glob/url, mirroring
 * the `knowledge.sources[]` spec grammar and `IrKnowledgeSource`. Paths and
 * globs resolve against the ingest `cwd`; a url is fetched verbatim at boot.
 */
export type KnowledgeSource =
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "glob"; readonly glob: string }
  | { readonly kind: "url"; readonly url: string };

/**
 * The four candidate embedder-model strings for a knowledge block, in the
 * G76 resolution order. Every field is the raw declared string the IR carries
 * (or absent); {@link resolveKnowledgeEmbedder} folds them.
 */
export type KnowledgeEmbedderInputs = {
  /** `knowledge.embedder` — highest precedence. */
  readonly knowledgeEmbedder?: string;
  /** `memory.embedder` — the fact-store/curator embedder. */
  readonly memoryEmbedder?: string;
  /** `memory.wiki.embedder` — the wiki-tier embedder. */
  readonly wikiEmbedder?: string;
  /** The emitting target's own default (defaults to
   *  {@link DEFAULT_KNOWLEDGE_EMBEDDER_MODEL} when omitted). */
  readonly targetDefault?: string;
};

function firstNonEmpty(...values: ReadonlyArray<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/**
 * G76 embedder resolution for agent-shape RAG, the one place the order is
 * enforced so cli/channel/managed emitters cannot drift:
 *
 *   `knowledge.embedder → memory.embedder → memory.wiki.embedder → target default`
 *
 * Unlike fact-store recall + the curator (which degrade to BM25 when nothing
 * resolves), a vector store REQUIRES an embedding model, so this always
 * returns a non-empty string — falling through to
 * {@link DEFAULT_KNOWLEDGE_EMBEDDER_MODEL} rather than ever yielding
 * "BM25-only". (Contrast the wiki tier, which flips memory/wiki precedence,
 * and the fact store, which stops at BM25.)
 */
export function resolveKnowledgeEmbedder(inputs: KnowledgeEmbedderInputs): string {
  return (
    firstNonEmpty(
      inputs.knowledgeEmbedder,
      inputs.memoryEmbedder,
      inputs.wikiEmbedder,
      inputs.targetDefault,
    ) ?? DEFAULT_KNOWLEDGE_EMBEDDER_MODEL
  );
}

/** The subset of the WHATWG `fetch` reply {@link knowledgeRetrieve} reads from
 *  a `url` source. Kept structural so tests inject a stub without a live net. */
export type KnowledgeFetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
};

export type KnowledgeFetch = (url: string) => Promise<KnowledgeFetchResponse>;

/**
 * The config {@link knowledgeRetrieve} ingests. The embedder + vector store
 * arrive EITHER as a ready instance (tests, or a caller that already built
 * them) OR as the primitives to construct — exactly the two-way shape
 * {@link RetrieveConfigInput} accepts, so the pipeline and knowledge paths
 * build their backends identically. `embedderModel` is expected to already
 * be the {@link resolveKnowledgeEmbedder} output.
 */
export type KnowledgeRetrieveConfig = {
  readonly sources: readonly KnowledgeSource[];
  /** Prebuilt embedder (wins over `embedderModel`). */
  readonly embedder?: Embedder;
  /** Resolved embedder model string (built when no `embedder` instance). */
  readonly embedderModel?: string;
  readonly embedderApiKey?: string;
  /** Prebuilt vector store (wins over `vectorBackend` + connection fields). */
  readonly vectorStore?: VectorStore;
  readonly vectorBackend?: VectorBackendId;
  /** Vector-store connection (HTTP backends need url + collection; lance reads
   *  url as its on-disk path) — the vector store's key, not the embedder's. */
  readonly url?: string;
  readonly collection?: string;
  readonly apiKey?: string;
  readonly defaultK?: number;
  readonly chunkSize?: number;
  readonly chunkOverlap?: number;
  readonly chunkStrategy?: ChunkStrategy;
  /** Base directory for relative path/glob sources. Default `process.cwd()`. */
  readonly cwd?: string;
  /** `url`-source loader. Default: the global `fetch`. */
  readonly fetch?: KnowledgeFetch;
  /** Boot status-line sink (`[knowledge] …`). Compiled bundles stay silent. */
  readonly log?: (line: string) => void;
};

/**
 * Read every declared source into a `chunker` {@link Document}. `path` reads
 * one file; `glob` scans the cwd for matches (a zero-match glob contributes
 * nothing — it is a wildcard, not an assertion); `url` fetches the body.
 * A missing explicit `path`/`url`, or an errored fetch, throws with the
 * offending source named — a boot-time ingest fails loudly rather than
 * silently indexing an empty corpus.
 */
export async function loadKnowledgeSources(
  sources: readonly KnowledgeSource[],
  opts: { readonly cwd?: string; readonly fetch?: KnowledgeFetch } = {},
): Promise<Document[]> {
  const cwd = opts.cwd ?? process.cwd();
  const fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as KnowledgeFetch | undefined);
  const docs: Document[] = [];
  for (const src of sources) {
    if (src.kind === "path") {
      const abs = isAbsolute(src.path) ? src.path : resolvePath(cwd, src.path);
      if (!existsSync(abs)) {
        throw new RetrieveConfigError(`knowledge source path not found: ${src.path}`);
      }
      let text: string;
      try {
        text = await readFile(abs, "utf-8");
      } catch (cause) {
        throw new RetrieveConfigError(`knowledge source path unreadable: ${src.path}`, cause);
      }
      docs.push({ id: src.path, text, metadata: { docId: src.path, source: src.path } });
    } else if (src.kind === "glob") {
      // Bun.Glob — the same matcher tool-fs's Glob tool uses.
      const matcher = new Bun.Glob(src.glob);
      const rels: string[] = [];
      for await (const rel of matcher.scan({ cwd, onlyFiles: true })) rels.push(rel);
      rels.sort(); // deterministic chunk ids across boots
      for (const rel of rels) {
        const abs = resolvePath(cwd, rel);
        let text: string;
        try {
          text = await readFile(abs, "utf-8");
        } catch (cause) {
          throw new RetrieveConfigError(`knowledge glob match unreadable: ${rel}`, cause);
        }
        docs.push({ id: rel, text, metadata: { docId: rel, source: rel } });
      }
    } else {
      if (fetchImpl === undefined) {
        throw new RetrieveConfigError(
          `knowledge url source needs a fetch implementation: ${src.url}`,
        );
      }
      let res: KnowledgeFetchResponse;
      try {
        res = await fetchImpl(src.url);
      } catch (cause) {
        throw new RetrieveConfigError(`knowledge url fetch failed: ${src.url}`, cause);
      }
      if (!res.ok) {
        throw new RetrieveConfigError(`knowledge url fetch failed (${res.status}): ${src.url}`);
      }
      const text = await res.text();
      docs.push({ id: src.url, text, metadata: { docId: src.url, source: src.url } });
    }
  }
  return docs;
}

/**
 * Item 3 (G22) — the one wiring helper all three serving emitters
 * (cli/channel/managed) call to turn a `knowledge:` block into a live,
 * citation-bearing `Retrieve` tool. It ingests `config.sources` through the
 * SAME chunk → embed → upsert engine target-pipeline emits inline (reusing
 * `@crewhaus/chunker`, `@crewhaus/embedder`, `@crewhaus/vector-store`, and
 * this package's `formatHits` citations — no fork), then returns a
 * self-contained tool bound to its own already-populated store. It does NOT
 * touch the pipeline `activeConfig` singleton, so a bundle may register it
 * alongside anything else without global cross-talk.
 *
 * Failure is loud: an unconstructable embedder, or zero documents across all
 * sources, throws {@link RetrieveConfigError} at ingest rather than shipping a
 * `Retrieve` tool that silently answers "no hits" forever.
 */
export async function knowledgeRetrieve(config: KnowledgeRetrieveConfig): Promise<RegisteredTool> {
  if (config.sources.length === 0) {
    throw new RetrieveConfigError("knowledgeRetrieve requires at least one source");
  }
  let embedder = config.embedder;
  if (embedder === undefined) {
    if (config.embedderModel === undefined || config.embedderModel.trim() === "") {
      throw new RetrieveConfigError(
        "knowledgeRetrieve requires either an `embedder` instance or a resolved `embedderModel`",
      );
    }
    embedder = createEmbedder({
      model: config.embedderModel,
      ...(config.embedderApiKey !== undefined ? { apiKey: config.embedderApiKey } : {}),
    });
  }
  const vectorStore =
    config.vectorStore ??
    createVectorStore({
      backend: config.vectorBackend ?? "in-memory",
      ...(config.url !== undefined ? { url: config.url } : {}),
      ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
      ...(config.collection !== undefined ? { collection: config.collection } : {}),
    });

  const docs = await loadKnowledgeSources(config.sources, {
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
  });
  if (docs.length === 0) {
    throw new RetrieveConfigError(
      "knowledgeRetrieve indexed zero documents — every source was empty or matched nothing",
    );
  }

  const chunks = docs.flatMap((doc) =>
    chunk(doc, {
      strategy: config.chunkStrategy ?? DEFAULT_KNOWLEDGE_CHUNK_STRATEGY,
      size: config.chunkSize ?? DEFAULT_KNOWLEDGE_CHUNK_SIZE,
      overlap: config.chunkOverlap ?? DEFAULT_KNOWLEDGE_CHUNK_OVERLAP,
    }),
  );
  if (chunks.length > 0) {
    const vectors = await embedder.embed(chunks.map((c) => c.text));
    for (let i = 0; i < chunks.length; i += 1) {
      const c = chunks[i];
      const v = vectors[i];
      if (c === undefined || v === undefined) continue;
      await vectorStore.upsert(c.id, v, { docId: c.docId, text: c.text });
    }
  }
  config.log?.(
    `[knowledge] indexed ${await vectorStore.count()} chunks from ${docs.length} source doc(s)\n`,
  );

  const bound: RetrieveConfig = {
    embedder,
    vectorStore,
    defaultK: config.defaultK ?? DEFAULT_KNOWLEDGE_K,
  };
  return makeRetrieveTool(() => bound);
}
