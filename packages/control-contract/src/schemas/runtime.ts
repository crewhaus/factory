/**
 * The runtime area's zod schemas, composed from one file per half so each half lands on
 * its own line: `./runtime-work.ts` holds work items' and `./runtime-budget.ts` holds
 * spending periods', with `./runtime-workspace.ts` beside work items for their delivery.
 */
import type { z } from "zod";
import { BUDGET_SCHEMAS } from "./runtime-budget.js";
import { WORK_SCHEMAS } from "./runtime-work.js";
import { WORKSPACE_SCHEMAS } from "./runtime-workspace.js";

export const RUNTIME_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  ...WORK_SCHEMAS,

  ...WORKSPACE_SCHEMAS,

  ...BUDGET_SCHEMAS,
};
