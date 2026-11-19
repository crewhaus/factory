/**
 * The runtime area (#516, #514, #513): where a harness's work comes from, how it runs and
 * what it may spend. The module composes one half per file, so each half lands on its own
 * lines: `./runtime-budget.ts` holds spending periods. Another half spreads its rows on the
 * line beside the budget half's, in every array.
 */
import {
  BUDGET_CAPABILITY_KEYS,
  BUDGET_COMMAND_KINDS,
  BUDGET_EVENT_FAMILIES,
  BUDGET_OPERATIONS,
  BUDGET_PERMISSIONS,
  BUDGET_REASON_CODES,
} from "./runtime-budget.js";
import type { AreaModule } from "./types.js";

export const RUNTIME_MODULE = {
  area: "runtime",
  operations: [
    // ...WORK_OPERATIONS,

    ...BUDGET_OPERATIONS,
  ],
  refKinds: [],
  eventFamilies: [
    // ...WORK_EVENT_FAMILIES,

    ...BUDGET_EVENT_FAMILIES,
  ],
  machines: {
    // ...WORK_MACHINES,
  },
  commandKinds: [
    // ...WORK_COMMAND_KINDS,

    ...BUDGET_COMMAND_KINDS,
  ],
  permissions: [...BUDGET_PERMISSIONS],
  reasonCodes: {
    // ...WORK_REASON_CODES,

    ...BUDGET_REASON_CODES,
  },
  capabilityKeys: [
    // ...WORK_CAPABILITY_KEYS,

    ...BUDGET_CAPABILITY_KEYS,
  ],
} as const satisfies AreaModule;
