/**
 * `@crewhaus/adapter-openai` — OpenAI provider adapter (Section 17).
 * Implements the `ProviderAdapter` contract from
 * `@crewhaus/adapter-anthropic` against OpenAI's Chat Completions API.
 */

export { OpenAIAdapter, createOpenAIAdapter } from "./adapter.js";
export type { CreateOpenAIAdapterEnv, OpenAIAdapterOptions } from "./adapter.js";
export { translateOpenAIStream } from "./stream.js";
export { toOpenAIChatParams } from "./translate.js";
