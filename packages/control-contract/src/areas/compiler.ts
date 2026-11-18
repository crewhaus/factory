/**
 * The compiler area's module: one capability key per setting in the support
 * manifest (`@crewhaus/ir/support`), `features.<setting>`, which Home answers
 * per harness from the manifest and the crewhaus version its bundle was
 * compiled with. The key list is generated with the manifest
 * (`scripts/gen-support-manifest.ts`). No operations, no events.
 */
import { COMPILER_FEATURE_KEYS } from "./compiler-features.generated.js";
import type { AreaModule } from "./types.js";

export const COMPILER_MODULE = {
  area: "compiler",
  operations: [],
  refKinds: [],
  eventFamilies: [],
  machines: {},
  commandKinds: [],
  permissions: [],
  capabilityKeys: COMPILER_FEATURE_KEYS,
} as const satisfies AreaModule;
