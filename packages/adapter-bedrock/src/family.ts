/**
 * Detect the model family from a Bedrock modelId.
 * The modelId carries the family prefix, optionally behind a geo
 * segment from a cross-region inference-profile id:
 *   - "anthropic.claude-*" or "us.anthropic.claude-*"
 *   - "meta.llama*" or "eu.meta.llama*"
 *   - "mistral.mistral-*" / "mistral.mixtral-*" (geo-prefixed likewise)
 *
 * AWS requires the inference-profile id (not the bare model id) to
 * invoke current-generation models on demand, so the geo segment is
 * stripped for family sniffing only — the full id stays the wire
 * modelId.
 *
 * Anything else returns `"unknown"`; the router rejects unknown
 * families at parse time before this adapter is ever loaded.
 *
 * Twin logic: model-router/src/parse.ts (BEDROCK_GEO_PREFIX) — the
 * router cannot import this optional package eagerly, so keep the two
 * copies and their test vectors in sync.
 */

import type { ProviderFeatures } from "@crewhaus/adapter-anthropic";

export type BedrockFamily = "anthropic" | "llama" | "mistral";

const GEO_PREFIX = /^(?:us|eu|apac|jp|au|ca|sa|us-gov|global)\./;

export function detectFamily(modelId: string): BedrockFamily | "unknown" {
  const stem = modelId.replace(GEO_PREFIX, "");
  if (stem.startsWith("anthropic.")) return "anthropic";
  if (stem.startsWith("meta.llama")) return "llama";
  if (stem.startsWith("mistral.")) return "mistral";
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
