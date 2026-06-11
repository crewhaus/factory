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
import { ConfigError, ProviderAuthError } from "@crewhaus/errors";
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
      return parsed.vertex === true ? "anthropic:vertex" : "anthropic";
    case "openai":
      if (parsed.azure !== undefined) return `azure:${parsed.azure.deployment}`;
      // Named hosts and local/ URLs resolve their key differently from
      // plain openai/ even at the same baseUrl — keep the keys distinct.
      return `openai:${parsed.baseUrl ?? ""}:${parsed.apiKeyEnv ?? ""}:${parsed.localUrl === true ? "local" : ""}`;
    case "gemini":
      return parsed.vertex === true ? "gemini:vertex" : "gemini";
    case "bedrock":
      return `bedrock:${parsed.family}`;
  }
}

/**
 * Loopback test for `local/<model>@<url>` key fallback. Only loopback
 * hosts may inherit OPENAI_API_KEY (documented LiteLLM-on-localhost
 * compat); any other host gets the placeholder unless
 * CREWHAUS_LOCAL_API_KEY is set — a URL embedded in a third-party spec
 * must not be able to exfiltrate the OpenAI key.
 *
 * @internal — exported only for tests.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "[::1]" ||
      host.startsWith("127.")
    );
  } catch {
    return false;
  }
}

/**
 * API-key policy for the openai-routed model strings:
 *   - named host (`groq/…`)   → the host's own env var, required; never
 *                               OPENAI_API_KEY.
 *   - `local/…` loopback URL  → OPENAI_API_KEY if set (LiteLLM-on-
 *                               localhost compat), else placeholder.
 *   - `local/…` remote URL    → CREWHAUS_LOCAL_API_KEY if set, else
 *                               placeholder. OPENAI_API_KEY is never
 *                               sent to a non-loopback spec-supplied URL.
 *   - plain `openai/…`        → undefined (createOpenAIAdapter's own
 *                               env resolution applies).
 *
 * @internal — exported only for tests.
 */
export function resolveOpenAICompatApiKey(
  parsed: Extract<ParsedModelString, { providerId: "openai" }>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (parsed.apiKeyEnv !== undefined) {
    const key = env[parsed.apiKeyEnv];
    if (key === undefined || key.length === 0) {
      throw new ProviderAuthError(
        "openai",
        `${parsed.hostId}/* model strings require ${parsed.apiKeyEnv} to be set`,
      );
    }
    return key;
  }
  if (parsed.localUrl === true && parsed.baseUrl !== undefined) {
    return isLoopbackUrl(parsed.baseUrl)
      ? env["OPENAI_API_KEY"] || "local"
      : env["CREWHAUS_LOCAL_API_KEY"] || "local";
  }
  return undefined;
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
    if (parsed.vertex === true) {
      return mod.createAnthropicVertexAdapter(env);
    }
    return mod.createAnthropicAdapter(env);
  }
  if (parsed.providerId === "openai") {
    let mod: typeof import("@crewhaus/adapter-openai");
    try {
      mod = await __adapterImporters.openai();
    } catch (err) {
      throw new ConfigError(
        "model-router: @crewhaus/adapter-openai is not installed — required for openai/*, local/*, azure/*, and named-host model strings",
        err,
      );
    }
    if (parsed.azure !== undefined) {
      return mod.createAzureOpenAIAdapter({ deployment: parsed.azure.deployment }, env);
    }
    const override: { baseURL?: string; apiKey?: string } = {};
    if (parsed.baseUrl !== undefined) override.baseURL = parsed.baseUrl;
    const apiKey = resolveOpenAICompatApiKey(parsed, env);
    if (apiKey !== undefined) override.apiKey = apiKey;
    return mod.createOpenAIAdapter(env, override);
  }
  if (parsed.providerId === "gemini") {
    let mod: typeof import("@crewhaus/adapter-gemini");
    try {
      mod = await __adapterImporters.gemini();
    } catch (err) {
      throw new ConfigError(
        "model-router: @crewhaus/adapter-gemini is not installed — required for gemini/* and vertex/gemini-* model strings",
        err,
      );
    }
    return mod.createGeminiAdapter(env, parsed.vertex === true ? { vertexai: true } : {});
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
