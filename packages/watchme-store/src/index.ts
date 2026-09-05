/**
 * `@crewhaus/watchme-store` — durable "watch me" state, independent of the
 * 30-day transcript TTL. Three pieces: a per-harness store of redacted
 * session digests + judge verdicts (`openWatchmeStore`), the global
 * cross-harness registry (`openHarnessRegistry`), and the pure
 * quality→shadow-arm join (`joinQualityToArms`) behind
 * `crewhaus watchme report --feed-routing`. Zero-dep by design; redaction is
 * an injected callback at every CLI append site — this package never imports
 * PII detectors.
 */
export {
  joinQualityToArms,
  QUALITY_LANE_PREFIX,
  type QualityArmRow,
  type RouteDecision,
  type TurnQuality,
} from "./join.js";
export {
  openHarnessRegistry,
  type HarnessRegistry,
  type HarnessRegistryOptions,
} from "./registry.js";
export { openWatchmeStore, type WatchmeStore, type WatchmeStoreOptions } from "./store.js";
export type {
  HarnessEntry,
  WatchmeAggregate,
  WatchmeJudgment,
  WatchmeObservation,
  WatchmeState,
} from "./types.js";
