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
 *                                           (anthropic|llama|mistral)
 *   - `local/<model>@<url>`               → openai with baseURL=<url>
 *
 * Anything else is rejected with a `ConfigError` carrying a hint so
 * spec authors get a helpful message rather than a runtime crash deep
 * inside an SDK.
 */

import { ConfigError } from "@crewhaus/errors";

export type ProviderId = "anthropic" | "openai" | "gemini" | "bedrock";

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
        `model "${modelString}": local/* requires "@<url>" suffix (e.g. local/llama-3.1-8b@http://localhost:11434)`,
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
    let family: "anthropic" | "llama" | "mistral";
    if (modelId.startsWith("anthropic.")) family = "anthropic";
    else if (modelId.startsWith("meta.llama")) family = "llama";
    else if (modelId.startsWith("mistral.")) family = "mistral";
    else {
      throw new ConfigError(
        `model "${modelString}": Bedrock family unknown — expected anthropic.* / meta.llama* / mistral.*`,
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
