/**
 * The runtime area (#516, #514, #513, module brief 333): where a harness's work comes from
 * and how it runs. The module composes one half per file, so each half lands on its own
 * lines: `./runtime-work.ts` holds work items. A later half spreads its rows on the line
 * below the work half's, in every array.
 */
import {
  WORK_CAPABILITY_KEYS,
  WORK_COMMAND_KINDS,
  WORK_EVENT_FAMILIES,
  WORK_MACHINES,
  WORK_OPERATIONS,
  WORK_RAW_EXCLUSIONS,
  WORK_REASON_CODES,
} from "./runtime-work.js";
import type { AreaModule } from "./types.js";

export const RUNTIME_MODULE = {
  area: "runtime",
  operations: [
    ...WORK_OPERATIONS,

    // ...BUDGET_OPERATIONS,
  ],
  refKinds: [],
  eventFamilies: [
    ...WORK_EVENT_FAMILIES,

    // ...BUDGET_EVENT_FAMILIES,
  ],
  machines: {
    ...WORK_MACHINES,

    // ...BUDGET_MACHINES,
  },
  commandKinds: [
    ...WORK_COMMAND_KINDS,

    // ...BUDGET_COMMAND_KINDS,
  ],
  permissions: [],
  reasonCodes: {
    ...WORK_REASON_CODES,

    // ...BUDGET_REASON_CODES,
  },
  capabilityKeys: [
    ...WORK_CAPABILITY_KEYS,

    // ...BUDGET_CAPABILITY_KEYS,
  ],
  rawExclusions: [
    ...WORK_RAW_EXCLUSIONS,

    // ...BUDGET_RAW_EXCLUSIONS,
  ],
} as const satisfies AreaModule;
