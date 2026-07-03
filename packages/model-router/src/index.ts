/**
 * `@crewhaus/model-router` — parse `agent.model` strings and lazy-load
 * the matching `ProviderAdapter` (Section 17). Critical-path module —
 * every non-Anthropic provider routes through `resolveModel`.
 */

export type { BedrockModelFamily, ParsedModelString, ProviderId } from "./parse.js";
export { LOCAL_DEFAULT_BASE_URL, OPENAI_COMPAT_HOSTS, parseModelString } from "./parse.js";
export type { ModelResolution } from "./router.js";
export { clearAdapterCache, resolveModel } from "./router.js";
export type {
  CreateFailoverChainOptions,
  FailoverActiveInfo,
  FailoverBreakerTuning,
  FailoverCandidateSnapshot,
  FailoverChain,
  FallbackRankInput,
} from "./failover.js";
export { FailoverExhaustedError, createFailoverChain } from "./failover.js";
export type {
  ModelTier,
  ResolvedTier,
  TierDecision,
  TierRouter,
  TierRouterOptions,
  TierRoutingConfig,
  TierSignals,
} from "./tier-router.js";
export { createTierRouter, pickTier } from "./tier-router.js";
