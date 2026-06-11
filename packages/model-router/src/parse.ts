/**
 * Parse `agent.model` strings into a discriminated union the router
 * uses to dispatch.
 *
 * Routing rules (per Section 17):
 *   - `claude-*` (no prefix)              → anthropic
 *   - `openai/<model>`                    → openai
 *   - `gemini/<model>`                    → gemini
 *   - `bedrock/<modelId>`                 → bedrock with family inferred
 *                                           from the modelId prefix
 *                                           (anthropic|llama|mistral|nova|
 *                                           titan|deepseek|cohere|ai21|qwen|
 *                                           gpt-oss|writer), tolerating a
 *                                           leading geo segment
 *                                           ("us." / "eu." / "apac." / ...)
 *                                           from cross-region inference
 *                                           profile ids
 *   - `local/<model>@<url>`               → openai with baseURL=<url>
 *                                           (the URL must include the `/v1`
 *                                           segment for Ollama/vLLM/LM Studio)
 *   - `local/<model>`                     → openai with the Ollama default
 *                                           baseURL (http://localhost:11434/v1)
 *   - `groq/…` `together/…` `fireworks/…`
 *     `openrouter/…` `deepseek/…` `xai/…`
 *     `mistral/…` `cerebras/…`            → openai against the host's known
 *                                           baseURL, keyed by the host's own
 *                                           env var (GROQ_API_KEY, …)
 *   - `azure/<deployment>`                → openai via the AzureOpenAI client
 *                                           (AZURE_OPENAI_ENDPOINT /
 *                                           AZURE_OPENAI_API_KEY /
 *                                           AZURE_OPENAI_API_VERSION)
 *   - `vertex/claude-*`                   → anthropic on Vertex AI
 *                                           (@anthropic-ai/vertex-sdk, ADC)
 *   - `vertex/gemini-*`                   → gemini with Vertex mode forced
 *
 * Anything else is rejected with a `ConfigError` carrying a hint so
 * spec authors get a helpful message rather than a runtime crash deep
 * inside an SDK.
 */

import { ConfigError } from "@crewhaus/errors";

export type ProviderId = "anthropic" | "openai" | "gemini" | "bedrock";

/**
 * Geo segments AWS prepends to Bedrock model ids to form cross-region
 * inference-profile ids (e.g. `us.anthropic.claude-...`). Mirrored in
 * `@crewhaus/adapter-bedrock` (detectFamily) and `@crewhaus/cost-tracker`
 * (resolvePricing) — those packages cannot share code with this one
 * without breaking the router's lazy-import seam, so the twin copies
 * carry identical test vectors instead.
 */
export const BEDROCK_GEO_PREFIX = /^(?:us|eu|apac|jp|au|ca|sa|us-gov|global)\./;

/**
 * Bedrock model families the router accepts. Anthropic streams over the
 * native InvokeModel path; every other family goes through the
 * model-agnostic Converse API. Twin of `BedrockFamily` in
 * `@crewhaus/adapter-bedrock` (family.ts) — keep in sync.
 */
export type BedrockModelFamily =
  | "anthropic"
  | "llama"
  | "mistral"
  | "nova"
  | "titan"
  | "deepseek"
  | "cohere"
  | "ai21"
  | "qwen"
  | "gpt-oss"
  | "writer";

/**
 * Ordered `(modelId prefix → family)` table, matched after the geo
 * segment is stripped. Prefixes are deliberately narrow where a vendor
 * ships non-chat models under the same vendor segment (titan-text vs
 * titan-embed, cohere.command vs cohere.embed) so genuinely unsupported
 * models keep being rejected at parse time.
 * Twin logic: adapter-bedrock/src/family.ts FAMILY_PREFIXES — keep the
 * two copies and their test vectors in sync.
 */
const BEDROCK_FAMILY_PREFIXES: ReadonlyArray<{
  readonly prefix: string;
  readonly family: BedrockModelFamily;
}> = [
  { prefix: "anthropic.", family: "anthropic" },
  { prefix: "meta.llama", family: "llama" },
  { prefix: "mistral.", family: "mistral" },
  { prefix: "amazon.nova", family: "nova" },
  { prefix: "amazon.titan-text", family: "titan" },
  { prefix: "deepseek.", family: "deepseek" },
  { prefix: "cohere.command", family: "cohere" },
  { prefix: "ai21.", family: "ai21" },
  { prefix: "qwen.", family: "qwen" },
  { prefix: "openai.gpt-oss", family: "gpt-oss" },
  { prefix: "writer.", family: "writer" },
];

/**
 * Known OpenAI-compatible cloud hosts addressable by name. Each entry
 * pins the host's chat-completions baseURL and the env var its API key
 * is read from — so a spec can mix hosts (e.g. a Groq judge next to a
 * real-OpenAI agent) without the keys fighting over OPENAI_API_KEY.
 */
export const OPENAI_COMPAT_HOSTS: Readonly<
  Record<string, { readonly baseUrl: string; readonly apiKeyEnv: string }>
> = {
  groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
  together: { baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
  xai: { baseUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY" },
  mistral: { baseUrl: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY" },
};

/** Default baseURL for `local/<model>` without an explicit `@<url>` (Ollama). */
export const LOCAL_DEFAULT_BASE_URL = "http://localhost:11434/v1";

export type ParsedModelString =
  | { readonly providerId: "anthropic"; readonly modelId: string; readonly vertex?: true }
  | {
      readonly providerId: "openai";
      readonly modelId: string;
      readonly baseUrl?: string;
      /** Named OPENAI_COMPAT_HOSTS entry this string addressed (for errors/caching). */
      readonly hostId?: string;
      /** Env var carrying the named host's API key. */
      readonly apiKeyEnv?: string;
      /** True when the string used the local/ grammar — keys are then
       *  restricted: loopback URLs may fall back to OPENAI_API_KEY, any
       *  other URL only gets CREWHAUS_LOCAL_API_KEY (never the OpenAI
       *  key — a spec-supplied URL must not be able to exfiltrate it). */
      readonly localUrl?: true;
      /** Azure OpenAI deployment routing (azure/<deployment>). */
      readonly azure?: { readonly deployment: string };
    }
  | { readonly providerId: "gemini"; readonly modelId: string; readonly vertex?: true }
  | {
      readonly providerId: "bedrock";
      readonly modelId: string;
      readonly family: BedrockModelFamily;
    };

export function parseModelString(modelString: string): ParsedModelString {
  if (typeof modelString !== "string" || modelString.length === 0) {
    throw new ConfigError("model string must be a non-empty string");
  }

  // Local OpenAI-compatible: `local/<model>@<url>` or `local/<model>`
  // (the latter defaults to Ollama's endpoint).
  if (modelString.startsWith("local/")) {
    const rest = modelString.slice("local/".length);
    const at = rest.indexOf("@");
    if (at === -1) {
      if (rest.length === 0) {
        throw new ConfigError(`model "${modelString}": local model id is empty`);
      }
      return {
        providerId: "openai",
        modelId: rest,
        baseUrl: LOCAL_DEFAULT_BASE_URL,
        localUrl: true,
      };
    }
    const modelId = rest.slice(0, at);
    const baseUrl = rest.slice(at + 1);
    if (modelId.length === 0) {
      throw new ConfigError(`model "${modelString}": local model id is empty`);
    }
    if (baseUrl.length === 0) {
      throw new ConfigError(
        `model "${modelString}": local base URL is empty (e.g. local/llama3.2@http://localhost:11434/v1 — include the /v1 segment for Ollama/vLLM/LM Studio)`,
      );
    }
    return { providerId: "openai", modelId, baseUrl, localUrl: true };
  }

  // Azure OpenAI: `azure/<deployment>` — routed through the AzureOpenAI
  // client (api-key header + api-version query), configured from
  // AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_API_VERSION.
  if (modelString.startsWith("azure/")) {
    const deployment = modelString.slice("azure/".length);
    if (deployment.length === 0) {
      throw new ConfigError(
        `model "${modelString}": azure/* requires a deployment name after the slash`,
      );
    }
    return { providerId: "openai", modelId: deployment, azure: { deployment } };
  }

  // Vertex AI: `vertex/claude-*` (Anthropic on Vertex via
  // @anthropic-ai/vertex-sdk) or `vertex/gemini-*` (Gemini with Vertex
  // mode forced). Both authenticate via Application Default Credentials.
  if (modelString.startsWith("vertex/")) {
    const modelId = modelString.slice("vertex/".length);
    if (modelId.startsWith("claude-")) {
      return { providerId: "anthropic", modelId, vertex: true };
    }
    if (modelId.startsWith("gemini-") || modelId.startsWith("gemma-")) {
      return { providerId: "gemini", modelId, vertex: true };
    }
    throw new ConfigError(
      `model "${modelString}": vertex/* expects a claude-* or gemini-* model id`,
    );
  }

  if (modelString.startsWith("openai/")) {
    const modelId = modelString.slice("openai/".length);
    if (modelId.length === 0) {
      throw new ConfigError(`model "${modelString}": openai/* requires a model id after the slash`);
    }
    return { providerId: "openai", modelId };
  }

  if (modelString.startsWith("gemini/")) {
    const modelId = modelString.slice("gemini/".length);
    if (modelId.length === 0) {
      throw new ConfigError(`model "${modelString}": gemini/* requires a model id after the slash`);
    }
    return { providerId: "gemini", modelId };
  }

  if (modelString.startsWith("bedrock/")) {
    const modelId = modelString.slice("bedrock/".length);
    if (modelId.length === 0) {
      throw new ConfigError(
        `model "${modelString}": bedrock/* requires a model id after the slash`,
      );
    }
    // Cross-region inference profiles prefix the family with a geo
    // segment (us. / eu. / apac. / global. / ...). AWS requires the
    // profile id — not the bare model id — to invoke current-generation
    // models on demand, so strip the segment for family sniffing only
    // and keep the full id as the wire modelId.
    // Twin logic: adapter-bedrock/src/family.ts detectFamily — keep in sync.
    const stem = modelId.replace(BEDROCK_GEO_PREFIX, "");
    const match = BEDROCK_FAMILY_PREFIXES.find((entry) => stem.startsWith(entry.prefix));
    if (match === undefined) {
      throw new ConfigError(
        `model "${modelString}": Bedrock family unknown — expected anthropic.* / meta.llama* / mistral.* / amazon.nova* / amazon.titan-text* / deepseek.* / cohere.command* / ai21.* / qwen.* / openai.gpt-oss* / writer.*, optionally behind a cross-region inference-profile prefix (us. / eu. / apac. / global. / ...)`,
      );
    }
    return { providerId: "bedrock", modelId, family: match.family };
  }

  // Named OpenAI-compatible cloud hosts: `groq/<model>`, `xai/<model>`, …
  const slash = modelString.indexOf("/");
  if (slash > 0) {
    const host = OPENAI_COMPAT_HOSTS[modelString.slice(0, slash)];
    if (host !== undefined) {
      const hostId = modelString.slice(0, slash);
      const modelId = modelString.slice(slash + 1);
      if (modelId.length === 0) {
        throw new ConfigError(
          `model "${modelString}": ${hostId}/* requires a model id after the slash`,
        );
      }
      return {
        providerId: "openai",
        modelId,
        baseUrl: host.baseUrl,
        hostId,
        apiKeyEnv: host.apiKeyEnv,
      };
    }
  }

  // Unprefixed: must be claude-* (Anthropic-direct).
  if (modelString.startsWith("claude-")) {
    return { providerId: "anthropic", modelId: modelString };
  }

  throw new ConfigError(
    `model "${modelString}": unrecognised model string — expected claude-*, openai/*, gemini/*, bedrock/*, local/<model>[@<url>], azure/<deployment>, vertex/<model>, or a named OpenAI-compatible host (${Object.keys(OPENAI_COMPAT_HOSTS).join("/, ")}/)`,
  );
}
