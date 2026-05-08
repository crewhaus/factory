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
 * spec declares.
 *
 * Layer R12. Pairs with `embedder`, `vector-store`, `pipeline-engine`,
 * `target-pipeline`.
 */

import { type Embedder, createEmbedder } from "@crewhaus/embedder";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { type VectorStore, createVectorStore } from "@crewhaus/vector-store";
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
  readonly vectorBackend?: "in-memory";
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
    vectorStore = createVectorStore({ backend: input.vectorBackend ?? "in-memory" });
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

export const retrieve: RegisteredTool = buildTool({
  name: "Retrieve",
  description:
    "Retrieve top-k chunks from the configured vector store for a natural-language query. Pass `query` (required), optional `k` (default 5), and optional `filter` (metadata predicates). Returns a numbered list of hits with citations.",
  inputSchema: retrieveSchema,
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const cfg = activeConfig;
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
