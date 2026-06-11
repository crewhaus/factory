/**
 * `@crewhaus/adapter-openai` — OpenAI provider adapter (Section 17).
 * Implements the `ProviderAdapter` contract from
 * `@crewhaus/adapter-anthropic` against OpenAI's Chat Completions API.
 */

export { OpenAIAdapter, createAzureOpenAIAdapter, createOpenAIAdapter } from "./adapter.js";
export type {
  CreateAzureOpenAIAdapterOptions,
  CreateOpenAIAdapterEnv,
  OpenAIAdapterOptions,
} from "./adapter.js";
export { translateOpenAIStream } from "./stream.js";
export { toOpenAIChatParams } from "./translate.js";
