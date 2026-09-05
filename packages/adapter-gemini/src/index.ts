/**
 * `@crewhaus/adapter-gemini` — Google Gemini provider adapter (Section 17).
 * Implements the `ProviderAdapter` contract from `@crewhaus/adapter-anthropic`
 * against the unified `@google/genai` SDK.
 */

export { GeminiAdapter, createGeminiAdapter } from "./adapter.js";
export type { GeminiAdapterOptions } from "./adapter.js";
export { translateGeminiStream } from "./stream.js";
export { geminiEffectiveParams, toGeminiParams } from "./translate.js";
