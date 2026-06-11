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

export type ParsedModelString =
  | { readonly providerId: "anthropic"; readonly modelId: string }
  | { readonly providerId: "openai"; readonly modelId: string; readonly baseUrl?: string }
  | { readonly providerId: "gemini"; readonly modelId: string }
  | {
      readonly providerId: "bedrock";
      readonly modelId: string;
      readonly family: BedrockModelFamily;
    };

export function parseModelString(modelString: string): ParsedModelString {
  if (typeof modelString !== "string" || modelString.length === 0) {
    throw new ConfigError("model string must be a non-empty string");
  }

  // Local OpenAI-compatible: `local/<model>@<url>`
  if (modelString.startsWith("local/")) {
    const rest = modelString.slice("local/".length);
    const at = rest.indexOf("@");
    if (at === -1) {
      throw new ConfigError(
        `model "${modelString}": local/* requires "@<url>" suffix (e.g. local/llama-3.1-8b@http://localhost:11434/v1 — include the /v1 segment for Ollama/vLLM/LM Studio)`,
      );
    }
    const modelId = rest.slice(0, at);
    const baseUrl = rest.slice(at + 1);
    if (modelId.length === 0) {
      throw new ConfigError(`model "${modelString}": local model id is empty`);
    }
    if (baseUrl.length === 0) {
      throw new ConfigError(`model "${modelString}": local base URL is empty`);
    }
    return { providerId: "openai", modelId, baseUrl };
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

  // Unprefixed: must be claude-* (Anthropic-direct).
  if (modelString.startsWith("claude-")) {
    return { providerId: "anthropic", modelId: modelString };
  }

  throw new ConfigError(
    `model "${modelString}": unrecognised model string — expected claude-*, openai/*, gemini/*, bedrock/*, or local/<model>@<url>`,
  );
}
