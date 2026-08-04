/**
 * @crewhaus/preflight — typed pre-spawn health checks for harnesses.
 *
 * "Will not boot: SLACK_SIGNING_SECRET unset" instead of a relayed stack
 * trace. The package composes seven areas into one report:
 *
 *   - spec        — `parseSpecIssues` lint (+ injected compiler warnings)
 *   - credentials — provider env-var matrix for the UNION of every model
 *                   the spec can route to (agent.model, model_fallbacks,
 *                   model_tiers, model_pool candidates, the evaluation
 *                   judge, the budget degrade model)
 *   - channels    — the channel daemon's boot-gate secret env refs
 *                   (offline: pure env presence, the exact set the compiled
 *                   daemon exits 2 on)
 *   - mcp         — dry-run of boot-time MCP secret-ref resolution, plus
 *                   lint for `$…` literals the transports never expand and
 *                   credentials pasted inline
 *   - ports       — bindability of requested/declared ports
 *   - bundle      — spec-vs-dist freshness (approximate mtime heuristic,
 *                   with a comparator seam for an exact spec-hash check)
 *   - durability  — warn-level footguns (no dedup store on a channel
 *                   daemon, live credentials without a budget cap)
 *
 * Every core function takes an explicit `env` — no `process.env` reads —
 * so checks run against the MERGED environment a spawn would receive and
 * stay deterministic in tests. `preflightHarness` is the one convenience
 * wrapper that defaults to `process.env`.
 */

export type {
  PreflightArea,
  PreflightCheck,
  PreflightEnv,
  PreflightItem,
  PreflightLevel,
  PreflightReport,
} from "./types";
export { buildReport, checkToItem, isEnvSet } from "./types";

export type { SecretRef } from "./secret-grammar";
export {
  CREDENTIAL_HEADER_NAMES,
  CREDENTIAL_SHAPED_KEY_RE,
  describeSecretRef,
  ENV_REF_RE,
  isMalformedEnvRef,
  lowerSecretString,
  malformedEnvRefMessage,
  UNPARSED_ENV_REF_RE,
} from "./secret-grammar";

export type { CredentialCheck, CredentialProviderId, SpecModelRef } from "./credentials";
export {
  anthropicAuthMode,
  buildCredentialChecks,
  collectSpecModels,
  extractSpecModel,
  hasLiveProviderCredentials,
  modelCredentialChecks,
  modelCredentialGroups,
  modelCredentialItems,
  providerCredentialsSatisfied,
  providerEnvStubs,
  selectedProvider,
} from "./credentials";

export type {
  ChannelEnvPlatform,
  ChannelPlatform,
  ChannelSecretConfigs,
  ChannelSecretRefEntry,
  LoweredSpecChannels,
} from "./channels";
export {
  buildChannelEnvSummaryChecks,
  CHANNEL_ENV_PLATFORMS,
  CHANNEL_PLATFORM_TITLE,
  CHANNEL_PLATFORMS,
  channelEnvChecks,
  channelItems,
  envRefCheck,
  lowerSpecChannels,
  platformSecretRefs,
} from "./channels";

export type { McpServersSpec } from "./mcp";
export { mcpDryRunItems } from "./mcp";

export type { PortChecker, PortRequest, PortStatus } from "./ports";
export { checkPortFree, portItems } from "./ports";

export type { BundleFreshness, FreshnessComparator } from "./bundle";
export { bundleFreshnessItem, compareBundleFreshnessByMtime } from "./bundle";

export type { DurabilityInput } from "./durability";
export { durabilityItems } from "./durability";

export type { RunPreflightOptions } from "./preflight";
export { preflightHarness, runPreflight } from "./preflight";
