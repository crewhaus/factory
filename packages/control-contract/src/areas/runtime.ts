/**
 * The runtime area (#516, #514, #513, module brief 333): where a harness's work comes from,
 * how it runs and what it may spend. The module composes one half per file, so each half
 * lands on its own lines: `./runtime-work.ts` holds work items, `./runtime-workspace.ts`
 * their delivery as pull requests, and `./runtime-budget.ts` spending periods.
 */
import {
  BUDGET_CAPABILITY_KEYS,
  BUDGET_COMMAND_KINDS,
  BUDGET_EVENT_FAMILIES,
  BUDGET_OPERATIONS,
  BUDGET_PERMISSIONS,
  BUDGET_REASON_CODES,
} from "./runtime-budget.js";
import {
  WORK_CAPABILITY_KEYS,
  WORK_COMMAND_KINDS,
  WORK_EVENT_FAMILIES,
  WORK_MACHINES,
  WORK_OPERATIONS,
  WORK_RAW_EXCLUSIONS,
  WORK_REASON_CODES,
} from "./runtime-work.js";
import {
  WORKSPACE_CAPABILITY_KEYS,
  WORKSPACE_COMMAND_KINDS,
  WORKSPACE_EVENT_FAMILIES,
  WORKSPACE_MACHINES,
  WORKSPACE_OPERATIONS,
  WORKSPACE_RAW_EXCLUSIONS,
  WORKSPACE_REASON_CODES,
} from "./runtime-workspace.js";
import type { AreaModule } from "./types.js";

export const RUNTIME_MODULE = {
  area: "runtime",
  operations: [
    ...WORK_OPERATIONS,

    ...WORKSPACE_OPERATIONS,

    ...BUDGET_OPERATIONS,
  ],
  refKinds: [],
  eventFamilies: [
    ...WORK_EVENT_FAMILIES,

    ...WORKSPACE_EVENT_FAMILIES,

    ...BUDGET_EVENT_FAMILIES,
  ],
  machines: {
    ...WORK_MACHINES,

    ...WORKSPACE_MACHINES,
  },
  commandKinds: [
    ...WORK_COMMAND_KINDS,

    ...WORKSPACE_COMMAND_KINDS,

    ...BUDGET_COMMAND_KINDS,
  ],
  permissions: [...BUDGET_PERMISSIONS],
  reasonCodes: {
    ...WORK_REASON_CODES,

    ...WORKSPACE_REASON_CODES,

    ...BUDGET_REASON_CODES,
  },
  capabilityKeys: [
    ...WORK_CAPABILITY_KEYS,

    ...WORKSPACE_CAPABILITY_KEYS,

    ...BUDGET_CAPABILITY_KEYS,
  ],
  rawExclusions: [
    ...WORK_RAW_EXCLUSIONS,

    ...WORKSPACE_RAW_EXCLUSIONS,
  ],
} as const satisfies AreaModule;
