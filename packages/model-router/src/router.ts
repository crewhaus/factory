/**
 * Resolve a parsed model string into a `ProviderAdapter` instance.
 *
 * Lazy loading: each non-Anthropic adapter is loaded via
 * `await import(...)`. An Anthropic-only run (the dominant path)
 * never touches `@aws-sdk/client-bedrock-runtime`, `@google/genai`,
 * or `openai` on disk.
 *
 * Caching: one adapter instance per `(providerId, baseUrl, family)`
 * key kept in a module-local Map so repeat resolutions are free.
 * `clearAdapterCache()` is exposed for tests that need a fresh
 * dynamic-import sequence.
 */

import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { ConfigError } from "@crewhaus/errors";
import type { ParsedModelString, ProviderId } from "./parse.js";
import { parseModelString } from "./parse.js";

export interface ModelResolution {
  readonly adapter: ProviderAdapter;
  readonly modelId: string;
  readonly providerId: ProviderId;
}

const adapterCache = new Map<string, ProviderAdapter>();

/**
 * Dynamic-import seam for the optional provider adapters. Each entry is the
 * real `await import(...)` by default. Kept behind an indirection so tests can
 * simulate a missing optionalDependency (the `import()` rejecting) without
 * mutating the module registry — which would leak across test files. Restore
 * with `__resetAdapterImporters()` in `afterEach`.
 *
 * @internal — not part of the public API; exported only for tests.
 */
function importOpenAI(): Promise<typeof import("@crewhaus/adapter-openai")> {
  return import("@crewhaus/adapter-openai");
}
function importGemini(): Promise<typeof import("@crewhaus/adapter-gemini")> {
  return import("@crewhaus/adapter-gemini");
}
function importBedrock(): Promise<typeof import("@crewhaus/adapter-bedrock")> {
  return import("@crewhaus/adapter-bedrock");
}

export const __adapterImporters = {
  openai: importOpenAI,
  gemini: importGemini,
  bedrock: importBedrock,
};

/** @internal — restore the real dynamic-import functions after a test. */
export function __resetAdapterImporters(): void {
  __adapterImporters.openai = importOpenAI;
  __adapterImporters.gemini = importGemini;
  __adapterImporters.bedrock = importBedrock;
}

/**
 * For tests: drop every cached adapter so the next `resolveModel`
 * triggers a fresh dynamic import.
 */
export function clearAdapterCache(): void {
  adapterCache.clear();
}

function cacheKey(parsed: ParsedModelString): string {
  switch (parsed.providerId) {
    case "anthropic":
      return "anthropic";
    case "openai":
      return `openai:${parsed.baseUrl ?? ""}`;
    case "gemini":
      return "gemini";
    case "bedrock":
      return `bedrock:${parsed.family}`;
  }
}

export async function resolveModel(
  modelString: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelResolution> {
  const parsed = parseModelString(modelString);
  const key = cacheKey(parsed);
  const cached = adapterCache.get(key);
  if (cached !== undefined) {
    return { adapter: cached, modelId: parsed.modelId, providerId: parsed.providerId };
  }

  const adapter = await loadAdapter(parsed, env);
  adapterCache.set(key, adapter);
  return { adapter, modelId: parsed.modelId, providerId: parsed.providerId };
}

async function loadAdapter(
  parsed: ParsedModelString,
  env: NodeJS.ProcessEnv,
): Promise<ProviderAdapter> {
  if (parsed.providerId === "anthropic") {
    const mod = await import("@crewhaus/adapter-anthropic");
    return mod.createAnthropicAdapter(env);
  }
  if (parsed.providerId === "openai") {
    let mod: typeof import("@crewhaus/adapter-openai");
    try {
      mod = await __adapterImporters.openai();
    } catch (err) {
      throw new ConfigError(
        "model-router: @crewhaus/adapter-openai is not installed — required for openai/* and local/* model strings",
        err,
      );
    }
    return mod.createOpenAIAdapter(env, parsed.baseUrl ? { baseURL: parsed.baseUrl } : {});
  }
  if (parsed.providerId === "gemini") {
    let mod: typeof import("@crewhaus/adapter-gemini");
    try {
      mod = await __adapterImporters.gemini();
    } catch (err) {
      throw new ConfigError(
        "model-router: @crewhaus/adapter-gemini is not installed — required for gemini/* model strings",
        err,
      );
    }
    return mod.createGeminiAdapter(env);
  }
  // Only `bedrock` remains (ParsedModelString is a closed union).
  let mod: typeof import("@crewhaus/adapter-bedrock");
  try {
    mod = await __adapterImporters.bedrock();
  } catch (err) {
    throw new ConfigError(
      "model-router: @crewhaus/adapter-bedrock is not installed — required for bedrock/* model strings",
      err,
    );
  }
  return mod.createBedrockAdapter({ family: parsed.family }, env);
}
