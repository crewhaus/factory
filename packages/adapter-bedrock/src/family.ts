/**
 * Detect the model family from a Bedrock modelId.
 * The modelId carries the family prefix, optionally behind a geo
 * segment from a cross-region inference-profile id:
 *   - "anthropic.claude-*" or "us.anthropic.claude-*"
 *   - "meta.llama*" or "eu.meta.llama*"
 *   - "amazon.nova*", "deepseek.*", "cohere.command*", ... (geo-prefixed
 *     likewise)
 *
 * AWS requires the inference-profile id (not the bare model id) to
 * invoke current-generation models on demand, so the geo segment is
 * stripped for family sniffing only — the full id stays the wire
 * modelId.
 *
 * Anthropic streams over the native InvokeModelWithResponseStream path
 * (explicit caching + thinking); every other family goes through the
 * model-agnostic Converse/ConverseStream API (see converse.ts).
 *
 * Anything else returns `"unknown"`; the router rejects unknown
 * families at parse time before this adapter is ever loaded.
 *
 * Twin logic: model-router/src/parse.ts (BEDROCK_GEO_PREFIX +
 * BEDROCK_FAMILY_PREFIXES) — the router cannot import this optional
 * package eagerly, so keep the two copies and their test vectors in
 * sync.
 */

import type { ProviderFeatures } from "@crewhaus/adapter-anthropic";

export type BedrockFamily =
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

const GEO_PREFIX = /^(?:us|eu|apac|jp|au|ca|sa|us-gov|global)\./;

/**
 * Ordered `(modelId prefix → family)` table, matched after the geo
 * segment is stripped. Prefixes are deliberately narrow where a vendor
 * ships non-chat models under the same vendor segment (titan-text vs
 * titan-embed, cohere.command vs cohere.embed) so genuinely unsupported
 * models keep being rejected at parse time.
 * Twin logic: model-router/src/parse.ts BEDROCK_FAMILY_PREFIXES — keep
 * the two copies and their test vectors in sync.
 */
const FAMILY_PREFIXES: ReadonlyArray<{
  readonly prefix: string;
  readonly family: BedrockFamily;
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

export function detectFamily(modelId: string): BedrockFamily | "unknown" {
  const stem = modelId.replace(GEO_PREFIX, "");
  const match = FAMILY_PREFIXES.find((entry) => stem.startsWith(entry.prefix));
  return match?.family ?? "unknown";
}

/**
 * Family capability matrix. Anthropic keeps its native feature set; the
 * Converse families advertise what the Converse API genuinely supports
 * for them (tool use for llama/mistral/nova/cohere/qwen/gpt-oss, vision
 * for nova, reasoning for deepseek/gpt-oss). Converse has no
 * client-controlled prompt caching, so `caching` stays false outside
 * anthropic.
 */
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
    case "mistral":
    case "cohere":
    case "qwen":
      return {
        caching: false,
        tool_use: true,
        vision: false,
        thinking: false,
        web_search: false,
      };
    case "nova":
      return {
        caching: false,
        tool_use: true,
        vision: true,
        thinking: false,
        web_search: false,
      };
    case "deepseek":
      return {
        caching: false,
        tool_use: false,
        vision: false,
        thinking: true,
        web_search: false,
      };
    case "gpt-oss":
      return {
        caching: false,
        tool_use: true,
        vision: false,
        thinking: true,
        web_search: false,
      };
    case "titan":
    case "ai21":
    case "writer":
      return {
        caching: false,
        tool_use: false,
        vision: false,
        thinking: false,
        web_search: false,
      };
  }
}
