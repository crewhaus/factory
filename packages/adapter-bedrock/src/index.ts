/**
 * `@crewhaus/adapter-bedrock` — AWS Bedrock provider adapter
 * (Section 17). Single SDK (`@aws-sdk/client-bedrock-runtime`) with
 * per-family marshalling for Anthropic / Llama / Mistral.
 */

export { BedrockAdapter, createBedrockAdapter } from "./adapter.js";
export type { BedrockAdapterOptions, CreateBedrockAdapterOptions } from "./adapter.js";
export type { BedrockFamily } from "./family.js";
export { detectFamily, featuresForFamily } from "./family.js";
export {
  ANTHROPIC_BEDROCK_VERSION,
  buildAnthropicBedrockBody,
  decodeAnthropicBedrockChunk,
} from "./families/anthropic.js";
export type { AnthropicBedrockBody } from "./families/anthropic.js";
export {
  buildLlamaBedrockBody,
  decodeLlamaBedrockChunk,
  newLlamaStreamState,
} from "./families/llama.js";
export type { LlamaBedrockBody, LlamaStreamState } from "./families/llama.js";
export {
  buildMistralBedrockBody,
  decodeMistralBedrockChunk,
  newMistralStreamState,
} from "./families/mistral.js";
export type { MistralBedrockBody, MistralStreamState } from "./families/mistral.js";
