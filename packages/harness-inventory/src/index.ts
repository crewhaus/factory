/**
 * `@crewhaus/harness-inventory` — cross-harness discovery, fleet
 * inventory/health rollup, and the seam-injected bulk runner behind
 * `crewhaus fleet`. Everything is side-effect-free on import: discovery and
 * aggregation are tolerant pure reads over harness dirs, and the only
 * side-effect surface (launching per-harness CLI invocations) is the injected
 * `FleetRunner`.
 */
export {
  buildFleetInventory,
  buildHarnessHealth,
  buildHarnessInventory,
  type BuildInventoryDeps,
  type BulkCommandPlan,
  type BulkRunResult,
  type ConfirmMutating,
  countFeedback,
  countOpenIncidents,
  countSessions,
  describeFleetExit,
  type DiscoveredHarness,
  discoverHarnesses,
  type EvalHealthReader,
  type EvalIndexReader,
  FleetError,
  type FleetRunner,
  fleetSelfInvokeArgv,
  formatBulkReport,
  formatHealth,
  formatInventory,
  HARNESS_SPEC_FILENAME,
  type HarnessHealth,
  type HarnessInventory,
  healthMark,
  isCompiledEntryPath,
  type LastEval,
  type LastEvalEntry,
  lastEvalFor,
  type ManifestReader,
  matchesFilter,
  READ_ONLY_BULK_COMMANDS,
  readSpecHeader,
  type RegistryStatus,
  resolveBulkCommand,
  runFleetBulk,
  type RunFleetBulkOptions,
  type RunFleetBulkReport,
  type SelfInvokeContext,
  type SpecHeader,
} from "./inventory.js";
