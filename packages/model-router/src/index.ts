/**
 * `@crewhaus/model-router` — parse `agent.model` strings and lazy-load
 * the matching `ProviderAdapter` (Section 17). Critical-path module —
 * every non-Anthropic provider routes through `resolveModel`.
 */

export type { ParsedModelString, ProviderId } from "./parse.js";
export { parseModelString } from "./parse.js";
export type { ModelResolution } from "./router.js";
export { clearAdapterCache, resolveModel } from "./router.js";
