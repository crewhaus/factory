/**
 * Catalog R12 `embedder` — provider-agnostic text embedding.
 *
 * Mirrors `model-router`'s prefix-grammar:
 *
 *   openai/text-embedding-3-small    → OpenAI Embeddings API
 *   voyage/voyage-3                  → Voyage AI
 *   cohere/embed-v3                  → Cohere
 *   local/<model>@<base-url>         → OpenAI-compatible local server
 *   mock/deterministic               → in-process hashed BoW vectors (tests + smoke fallback)
 *
 * `embed(texts, opts?)` accepts up to 100 texts per call (provider rate
 * limit) and returns `number[][]` of equal length. Empty input returns
 * `[]` without making a network call.
 *
 * The mock backend produces a deterministic 256-dim vector based on a
 * hashed bag-of-words representation, suitable for the Section 21 smoke
 * test when `OPENAI_API_KEY` is unset.
 *
 * Layer R12. Pairs with `vector-store`, `tool-retrieve`, `pipeline-engine`.
 */

import { createHash } from "node:crypto";
import { CrewhausError } from "@crewhaus/errors";

export type EmbedderProviderId = "openai" | "voyage" | "cohere" | "local" | "mock";

export type ParsedEmbedderModel = {
  readonly providerId: EmbedderProviderId;
  readonly modelId: string;
  readonly baseUrl?: string;
};

export class EmbedderError extends CrewhausError {
  override readonly name = "EmbedderError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * Parse an embedder model string with the same prefix grammar
 * `model-router` uses for chat models.
 *   openai/text-embedding-3-small
 *   voyage/voyage-3
 *   cohere/embed-v3
 *   local/<model>@<base-url>
 *   mock/<anything>
 */
export function parseEmbedderModel(spec: string): ParsedEmbedderModel {
  if (typeof spec !== "string" || spec.length === 0) {
    throw new EmbedderError("embedder model must be a non-empty string");
  }
  if (spec.startsWith("openai/")) {
    return { providerId: "openai", modelId: spec.slice("openai/".length) };
  }
  if (spec.startsWith("voyage/")) {
    return { providerId: "voyage", modelId: spec.slice("voyage/".length) };
  }
  if (spec.startsWith("cohere/")) {
    return { providerId: "cohere", modelId: spec.slice("cohere/".length) };
  }
  if (spec.startsWith("local/")) {
    const rest = spec.slice("local/".length);
    const at = rest.lastIndexOf("@");
    if (at === -1) {
      throw new EmbedderError(`local/ embedder must be local/<model>@<base-url> (got "${spec}")`);
    }
    const modelId = rest.slice(0, at);
    const baseUrl = rest.slice(at + 1);
    return { providerId: "local", modelId, baseUrl };
  }
  if (spec.startsWith("mock/")) {
    return { providerId: "mock", modelId: spec.slice("mock/".length) };
  }
  throw new EmbedderError(
    `unknown embedder prefix in "${spec}" — expected openai/, voyage/, cohere/, local/<m>@<url>, or mock/`,
  );
}

export type EmbedOptions = {
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
};

export interface Embedder {
  readonly model: string;
  readonly provider: EmbedderProviderId;
  embed(texts: ReadonlyArray<string>, opts?: EmbedOptions): Promise<number[][]>;
}

const DEFAULT_BATCH = 100;

// ---------------------------------------------------------------------------
// Mock backend — deterministic hashed bag-of-words.
// ---------------------------------------------------------------------------

const MOCK_DIM = 256;

function hashedBow(text: string, dim: number): number[] {
  const out = new Array<number>(dim).fill(0);
  // Tokenise on word boundaries; lowercased; ASCII-only (good enough for hashed BoW).
  const tokens = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 0);
  for (const t of tokens) {
    const h = createHash("sha256").update(t).digest();
    const slot = h.readUInt32BE(0) % dim;
    const sign = (h.readUInt8(4) & 1) === 0 ? 1 : -1;
    out[slot] = (out[slot] ?? 0) + sign;
  }
  // L2-normalise so cosine similarity ≈ dot product.
  let norm = 0;
  for (const v of out) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return out;
  return out.map((v) => v / norm);
}

class MockEmbedder implements Embedder {
  readonly provider: EmbedderProviderId = "mock";
  constructor(public readonly model: string) {}
  async embed(texts: ReadonlyArray<string>): Promise<number[][]> {
    return texts.map((t) => hashedBow(t, MOCK_DIM));
  }
}

// ---------------------------------------------------------------------------
// OpenAI / OpenAI-compatible (covers OpenAI cloud + local OpenAI-shaped
// servers like Ollama, vLLM, llama.cpp).
// ---------------------------------------------------------------------------

class OpenAILikeEmbedder implements Embedder {
  readonly provider: EmbedderProviderId;
  constructor(
    provider: EmbedderProviderId,
    public readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
  ) {
    this.provider = provider;
  }
  async embed(texts: ReadonlyArray<string>, opts: EmbedOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
    const batchSize = opts.batchSize ?? DEFAULT_BATCH;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.apiKey !== undefined && this.apiKey.length > 0) {
        headers["authorization"] = `Bearer ${this.apiKey}`;
      }
      const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, input: batch }),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new EmbedderError(
          `embedding request failed (${this.provider} ${this.model}): ${res.status} ${text}`,
        );
      }
      const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
      for (const row of json.data) out.push(row.embedding);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

export type CreateEmbedderOptions = {
  readonly model: string;
  /** Override the API key; defaults to provider-specific env vars. */
  readonly apiKey?: string;
  /** For "local/" prefix; otherwise ignored. */
  readonly baseUrl?: string;
};

export function createEmbedder(opts: CreateEmbedderOptions): Embedder {
  const parsed = parseEmbedderModel(opts.model);
  switch (parsed.providerId) {
    case "mock":
      return new MockEmbedder(parsed.modelId);
    case "openai": {
      const apiKey = opts.apiKey ?? process.env["OPENAI_API_KEY"];
      if (apiKey === undefined || apiKey === "") {
        throw new EmbedderError("openai embedder requires OPENAI_API_KEY");
      }
      return new OpenAILikeEmbedder(
        "openai",
        parsed.modelId,
        opts.baseUrl ?? "https://api.openai.com",
        apiKey,
      );
    }
    case "voyage": {
      const apiKey = opts.apiKey ?? process.env["VOYAGE_API_KEY"];
      if (apiKey === undefined || apiKey === "") {
        throw new EmbedderError("voyage embedder requires VOYAGE_API_KEY");
      }
      return new OpenAILikeEmbedder(
        "voyage",
        parsed.modelId,
        opts.baseUrl ?? "https://api.voyageai.com",
        apiKey,
      );
    }
    case "cohere": {
      const apiKey = opts.apiKey ?? process.env["COHERE_API_KEY"];
      if (apiKey === undefined || apiKey === "") {
        throw new EmbedderError("cohere embedder requires COHERE_API_KEY");
      }
      return new OpenAILikeEmbedder(
        "cohere",
        parsed.modelId,
        opts.baseUrl ?? "https://api.cohere.ai",
        apiKey,
      );
    }
    case "local":
      return new OpenAILikeEmbedder(
        "local",
        parsed.modelId,
        opts.baseUrl ?? parsed.baseUrl ?? "",
        opts.apiKey,
      );
    default: {
      const exhaustive: never = parsed.providerId;
      throw new EmbedderError(`unknown provider "${exhaustive}"`);
    }
  }
}
