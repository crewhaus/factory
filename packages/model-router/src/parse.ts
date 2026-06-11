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
 *                                           (anthropic|llama|mistral),
 *                                           tolerating a leading geo segment
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

export type ParsedModelString =
  | { readonly providerId: "anthropic"; readonly modelId: string }
  | { readonly providerId: "openai"; readonly modelId: string; readonly baseUrl?: string }
  | { readonly providerId: "gemini"; readonly modelId: string }
  | {
      readonly providerId: "bedrock";
      readonly modelId: string;
      readonly family: "anthropic" | "llama" | "mistral";
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
    let family: "anthropic" | "llama" | "mistral";
    if (stem.startsWith("anthropic.")) family = "anthropic";
    else if (stem.startsWith("meta.llama")) family = "llama";
    else if (stem.startsWith("mistral.")) family = "mistral";
    else {
      throw new ConfigError(
        `model "${modelString}": Bedrock family unknown — expected anthropic.* / meta.llama* / mistral.*, optionally behind a cross-region inference-profile prefix (us. / eu. / apac. / global. / ...)`,
      );
    }
    return { providerId: "bedrock", modelId, family };
  }

  // Unprefixed: must be claude-* (Anthropic-direct).
  if (modelString.startsWith("claude-")) {
    return { providerId: "anthropic", modelId: modelString };
  }

  throw new ConfigError(
    `model "${modelString}": unrecognised model string — expected claude-*, openai/*, gemini/*, bedrock/*, or local/<model>@<url>`,
  );
}
