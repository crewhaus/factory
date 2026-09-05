/**
 * `@crewhaus/adapter-bedrock` — AWS Bedrock provider adapter
 * (Section 17). Single SDK (`@aws-sdk/client-bedrock-runtime`) with two
 * wire paths: Anthropic over native InvokeModelWithResponseStream, and
 * every other family (llama / mistral / nova / titan / deepseek /
 * cohere / ai21 / qwen / gpt-oss / writer) over the model-agnostic
 * Converse/ConverseStream API.
 */

export { BedrockAdapter, createBedrockAdapter } from "./adapter.js";
export type { BedrockAdapterOptions, CreateBedrockAdapterOptions } from "./adapter.js";
export {
  buildConverseRequest,
  converseEffectiveParams,
  translateConverseStream,
} from "./converse.js";
export {
  ANTHROPIC_BEDROCK_VERSION,
  anthropicBedrockEffectiveParams,
  buildAnthropicBedrockBody,
  decodeAnthropicBedrockChunk,
} from "./families/anthropic.js";
export type { AnthropicBedrockBody } from "./families/anthropic.js";
export type { BedrockFamily } from "./family.js";
export { detectFamily, featuresForFamily } from "./family.js";
