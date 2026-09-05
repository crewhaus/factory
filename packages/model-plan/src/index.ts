/**
 * `@crewhaus/model-plan` — pure, fs-free per-model plan primitives (0.6.0,
 * module brief 307). Everything here is deterministic and replayable from
 * the transcript: no I/O, no clock beyond an injectable one, no adapter
 * construction. The compiler consumes it for validation, runtime-core for
 * the per-candidate plan table, apps/cli for `models` / `route` verbs, and
 * hangar-server read-only.
 *
 *   - profile refs: `resolveProfileRef`, `applyProfileDefaults`, `PROFILE_NAME_RE`
 *   - request params: `buildRequestParams` (§4.4, N1 clamp)
 *   - subset-only advertisement: `buildAdvertisement`, `unmetRequirement`, `toolConfigFor` (§5)
 *   - rule-directed routing: `evaluateRules`, `validateRuleRegex`, `deriveSignalRecord` (§7.2.2)
 *   - user-directed routing: `parseModelDirective` (§7.2.1)
 *   - N1 eligibility: `eligibleCandidates`, `cheapestEligible`, `strongestArm` (§7.11)
 *   - fingerprints: `planFingerprint`, `profileFingerprint`, `canonicalJson`
 *   - N2 priors: `loadPriors`, `seededScoreLookup` (§7.11)
 *   - the floor: `checkFloor`, `wilsonLowerBound` (§7.10)
 */

export type {
  ArmPrior,
  CandidateCapabilities,
  FeatureRequirement,
  ModelProfile,
  ModelThinking,
  ProfilePermissions,
  ProfileRegistry,
  RequestParams,
  RequestParamsBase,
  RouteHint,
  RouteHintSource,
  RouteRule,
  RouteRuleUse,
  RouteRuleWhen,
  RouteSignalRecord,
  RouteSignals,
} from "./types.js";

export {
  ModelPlanError,
  PROFILE_NAME_RE,
  applyProfileDefaults,
  invalidProfileNames,
  isProfileRef,
  profileRefName,
  resolveProfileRef,
} from "./profile.js";
export type { ResolvedProfileRef } from "./profile.js";

export { buildRequestParams } from "./params.js";

export {
  buildAdvertisement,
  matchesToolPattern,
  satisfiesFeatures,
  toolConfigFor,
  unmetRequirement,
} from "./advertisement.js";
export type {
  Advertisement,
  AdvertisementExclusion,
  AdvertisableTool,
  BuildAdvertisementOptions,
} from "./advertisement.js";

export { deriveSignalRecord, evaluateRules, validateRuleRegex } from "./rules.js";
export type { EvaluateRulesOptions, EvaluateRulesResult, RuleMatch, RuleSkip } from "./rules.js";

export { parseModelDirective, resolveDirectiveTarget, stripDirectiveToken } from "./directive.js";
export type { DirectiveRosterArm, ModelDirective } from "./directive.js";

export { cheapestEligible, eligibleCandidates, strongestArm } from "./eligibility.js";
export type {
  EligibilityCandidate,
  EligibilityExclusionReason,
  EligibilityResult,
  EligibleCandidatesOptions,
  TurnRequirement,
} from "./eligibility.js";

export { canonicalJson, fnv1a64, planFingerprint, profileFingerprint } from "./fingerprint.js";

export { MAX_PRIOR_PSEUDO_COUNT, loadPriors, priorKey, seededScoreLookup } from "./priors.js";
export type { LoadPriorsOptions, LoadPriorsResult, LoadedPriors, PriorsFile } from "./priors.js";

export { checkFloor, normalQuantile, wilsonLowerBound } from "./floor.js";
export type { ArmQuality, FloorConfig, FloorVerdict } from "./floor.js";
