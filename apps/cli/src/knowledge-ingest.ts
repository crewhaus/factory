/**
 * Loop contract 0.4 (Batch E, G22) — `knowledge:` RAG ingestion for the
 * interpreter path. `crewhaus run` (cli target) mirrors what the
 * cli/channel/managed emitters generate: when the compiled IR carries an
 * {@link IrKnowledge} block, the interpreter ingests every declared source at
 * boot, indexes the chunks into a vector store, and registers the shared
 * `@crewhaus/tool-retrieve` `Retrieve` tool so the agent can cite the corpus.
 *
 * The engine is REUSED verbatim from `target-pipeline` — same
 * chunk → embed → upsert stages, same `registerRetrieveConfig` seam — so a
 * knowledge-backed agent and a pipeline agent read the identical retrieval
 * baseline. The only shape-specific piece is source loading: the pipeline
 * inlines its corpus at compile time (`indexing.documents`), whereas the agent
 * shapes read `sources[]` (path / glob / url) from disk/network at boot.
 *
 * EMBEDDER RESOLUTION (G76) — the vector store needs embeddings, so unlike
 * memory recall this NEVER degrades to BM25. The model resolves in order
 * `knowledge.embedder → memory.embedder → memory.wiki.embedder → the target's
 * default embedder model`; {@link resolveKnowledgeEmbedderModel} is the single
 * source of that order, shared with the emitters' codegen.
 *
 * Side-effect-free on import (mirrors `knowledge-sync.ts` / `state-backup.ts`):
 * the loaders and the embedder/fetch seams are injected, so the ingestion flow
 * is exercised in tests without a real embedder or network. The real CLI wires
 * `@crewhaus/embedder`'s configured provider and the global `fetch`.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { chunk } from "@crewhaus/chunker";
import { type Embedder, createEmbedder } from "@crewhaus/embedder";
import { ConfigError } from "@crewhaus/errors";
import type { IrKnowledge, IrKnowledgeSource } from "@crewhaus/ir";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { registerRetrieveConfig, retrieve } from "@crewhaus/tool-retrieve";
import { createVectorStore } from "@crewhaus/vector-store";

/** The target's default embedder model — the last rung of the G76 resolution
 *  ladder, used when neither `knowledge.embedder` nor `memory.embedder` nor
 *  `memory.wiki.embedder` was declared. Matches the pipeline/egress default
 *  (`@crewhaus/target-cli`'s `DEFAULT_EGRESS_EMBEDDER_MODEL`). */
export const DEFAULT_KNOWLEDGE_EMBEDDER_MODEL = "openai/text-embedding-3-small";

/**
 * G76 embedder-model resolution for the knowledge RAG store:
 * `knowledge.embedder → memory.embedder → memory.wiki.embedder → default`.
 * A vector store always needs embeddings, so the ladder ends at a concrete
 * model rather than a BM25 fallback.
 */
export function resolveKnowledgeEmbedderModel(
  knowledge: IrKnowledge,
  memoryEmbedder?: string,
  wikiEmbedder?: string,
): string {
  return knowledge.embedder ?? memoryEmbedder ?? wikiEmbedder ?? DEFAULT_KNOWLEDGE_EMBEDDER_MODEL;
}

/** One ingested document: a stable id (path/glob-entry/url) and its raw text. */
export type KnowledgeDocument = {
  readonly id: string;
  readonly text: string;
};

export type KnowledgeIngestDeps = {
  /** Base directory relative `path`/`glob` sources resolve against (the
   *  interpreter passes the run's cwd). */
  readonly cwd: string;
  /** Declared `memory.embedder` (G76 fallback). */
  readonly memoryEmbedder?: string;
  /** Declared `memory.wiki.embedder` (G76 fallback). */
  readonly wikiEmbedder?: string;
  /** Injected embedder — the real CLI omits this and lets
   *  {@link resolveKnowledgeEmbedderModel} pick the model; tests inject a
   *  `mock/` embedder to avoid a provider key. */
  readonly embedder?: Embedder;
  /** Injected `fetch` for `url:` sources (defaults to the global `fetch`). */
  readonly fetchImpl?: typeof fetch;
  /** Injected glob expander (relative file paths under `cwd`); defaults to
   *  `Bun.Glob`. Seam so the pure ingest flow is unit-tested without a real
   *  filesystem walk. */
  readonly globScan?: (pattern: string, cwd: string) => ReadonlyArray<string>;
  /** Diagnostic sink (mirrors the pipeline's `[pipeline] indexed …` line). */
  readonly log?: (line: string) => void;
};

/** Default glob expander — `Bun.Glob`, matching `fleet.ts`/`tool-fs`. */
function bunGlobScan(pattern: string, cwd: string): string[] {
  const matcher = new Bun.Glob(pattern);
  return [...matcher.scanSync({ cwd, onlyFiles: true })];
}

/** Read one file source (path), failing with the source name when absent. */
function loadPathSource(path: string, cwd: string): KnowledgeDocument {
  const abs = isAbsolute(path) ? path : resolvePath(cwd, path);
  if (!existsSync(abs)) {
    throw new ConfigError(`knowledge source path not found: ${path} (resolved ${abs})`);
  }
  try {
    return { id: path, text: readFileSync(abs, "utf-8") };
  } catch (err) {
    throw new ConfigError(`could not read knowledge source ${path}: ${(err as Error).message}`);
  }
}

/** Expand a glob source into one document per matched file. */
function loadGlobSource(
  pattern: string,
  cwd: string,
  scan: (pattern: string, cwd: string) => ReadonlyArray<string>,
): KnowledgeDocument[] {
  const rels = [...scan(pattern, cwd)].sort();
  return rels.map((rel) => {
    const abs = resolvePath(cwd, rel);
    try {
      return { id: rel, text: readFileSync(abs, "utf-8") };
    } catch (err) {
      throw new ConfigError(
        `could not read knowledge source ${rel} (glob "${pattern}"): ${(err as Error).message}`,
      );
    }
  });
}

/** Fetch one url source as text, failing with the url on a non-2xx/network error. */
async function loadUrlSource(url: string, fetchImpl: typeof fetch): Promise<KnowledgeDocument> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new ConfigError(`could not fetch knowledge source ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new ConfigError(`knowledge source ${url} returned HTTP ${res.status}`);
  }
  return { id: url, text: await res.text() };
}

/**
 * Load every declared source into documents, in declaration order (globs
 * contribute their matches sorted for determinism). Exported for unit tests.
 */
export async function loadKnowledgeSources(
  sources: readonly IrKnowledgeSource[],
  deps: Pick<KnowledgeIngestDeps, "cwd" | "fetchImpl" | "globScan">,
): Promise<KnowledgeDocument[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const scan = deps.globScan ?? bunGlobScan;
  const docs: KnowledgeDocument[] = [];
  for (const src of sources) {
    switch (src.kind) {
      case "path":
        docs.push(loadPathSource(src.path, deps.cwd));
        break;
      case "glob":
        docs.push(...loadGlobSource(src.glob, deps.cwd, scan));
        break;
      case "url":
        docs.push(await loadUrlSource(src.url, fetchImpl));
        break;
      default: {
        const exhaustive: never = src;
        throw new ConfigError(
          `unknown knowledge source kind ${JSON.stringify(exhaustive)} (unreachable)`,
        );
      }
    }
  }
  return docs;
}

/**
 * Ingest a compiled `knowledge:` block and return the configured `Retrieve`
 * tool. Loads every source, chunks with the resolved size/overlap (the "fixed"
 * strategy — the knowledge grammar carries no strategy knob, matching the spec
 * default), embeds and upserts into the declared vector backend, then registers
 * the shared retrieve config so the returned tool answers against this corpus.
 *
 * The caller pushes the returned tool onto the run's tool list. Registration
 * uses `@crewhaus/tool-retrieve`'s module-level config — one `Retrieve` per
 * process, exactly as the codegen path does.
 */
export async function ingestKnowledge(
  knowledge: IrKnowledge,
  deps: KnowledgeIngestDeps,
): Promise<RegisteredTool> {
  const embedder =
    deps.embedder ??
    createEmbedder({
      model: resolveKnowledgeEmbedderModel(knowledge, deps.memoryEmbedder, deps.wikiEmbedder),
    });
  const vectorStore = createVectorStore({ backend: knowledge.vectorBackend });

  const docs = await loadKnowledgeSources(knowledge.sources, deps);
  const chunks = docs.flatMap((d) =>
    chunk(
      { id: d.id, text: d.text },
      { strategy: "fixed", size: knowledge.chunkSize, overlap: knowledge.chunkOverlap },
    ),
  );
  const vectors = chunks.length === 0 ? [] : await embedder.embed(chunks.map((c) => c.text));
  for (let i = 0; i < chunks.length; i += 1) {
    const c = chunks[i];
    const v = vectors[i];
    if (c === undefined || v === undefined) continue;
    await vectorStore.upsert(c.id, v, { docId: c.docId, text: c.text });
  }

  registerRetrieveConfig({ embedder, vectorStore, defaultK: knowledge.defaultK });

  deps.log?.(
    `[knowledge] indexed ${chunks.length} chunk(s) from ${docs.length} source document(s) — Retrieve tool wired\n`,
  );
  return retrieve;
}
