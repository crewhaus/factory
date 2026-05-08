/**
 * Detect the model family from a Bedrock modelId.
 * The modelId always carries the family prefix:
 *   - "anthropic.claude-*"
 *   - "meta.llama*"
 *   - "mistral.mistral-*" or "mistral.mixtral-*"
 *
 * Anything else falls into `"unknown"` and the adapter throws at
 * stream() time.
 */

import type { ProviderFeatures } from "@crewhaus/adapter-anthropic";

export type BedrockFamily = "anthropic" | "llama" | "mistral";

export function detectFamily(modelId: string): BedrockFamily | "unknown" {
  if (modelId.startsWith("anthropic.")) return "anthropic";
  if (modelId.startsWith("meta.llama")) return "llama";
  if (modelId.startsWith("mistral.")) return "mistral";
  return "unknown";
}

export function featuresForFamily(family: BedrockFamily): ProviderFeatures {
  switch (family) {
    case "anthropic":
      return {
        caching: "explicit",
        tool_use: true,
        vision: true,
        thinking: true,
        web_search: false,
      };
    case "llama":
      return {
        caching: false,
        tool_use: false,
        vision: false,
        thinking: false,
        web_search: false,
      };
    case "mistral":
      return {
        caching: false,
        tool_use: false,
        vision: false,
        thinking: false,
        web_search: false,
      };
  }
}
