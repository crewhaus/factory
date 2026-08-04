/**
 * `@crewhaus/harness-registry` — the machine-wide harness registry file
 * layer behind the harness manager: one `harnesses.json` (format v2) under
 * the registry root (`CREWHAUS_REGISTRY_ROOT`, default `~/.crewhaus`)
 * listing every registered harness with a stable `hrn_` id, plus scan
 * roots and group definitions.
 *
 * Pure registry-file layer by design: no spec parsing (callers supply
 * `specName`/`target`) and no filesystem scanning (discovery is the
 * inventory layer's job). Writes are atomic tmp+rename, mode 0600, with a
 * read-merge-write retry loop for same-machine multi-writer races;
 * `CREWHAUS_NO_REGISTRY=1` turns every write into a no-op while reads keep
 * working. Interop with the legacy watchme registry (seed merge +
 * best-effort write-through) goes through `@crewhaus/watchme-store`'s own
 * API.
 */
export { HARNESS_ID_RE, REGISTRY_FILENAME } from "./doc.js";
export {
  openHangarRegistry,
  registerHarnessHook,
  resolveRegistryRoot,
  type HangarRegistry,
  type ListOptions,
  type OpenHangarRegistryOptions,
  type RegisterHookFields,
  type RegisterHookResult,
  type UpsertFields,
} from "./registry.js";
export type {
  GroupDef,
  HangarHarnessEntry,
  HangarRegistryDoc,
  HarnessKind,
  HarnessOrigin,
  ScanRoot,
} from "./types.js";
