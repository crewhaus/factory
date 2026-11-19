/**
 * The runtime area's zod schemas, composed from one half per file so each half lands on
 * its own line: `./runtime-budget.ts` holds spending periods.
 */
import type { z } from "zod";
import { BUDGET_SCHEMAS } from "./runtime-budget.js";

export const RUNTIME_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  // ...WORK_SCHEMAS,

  ...BUDGET_SCHEMAS,
};
