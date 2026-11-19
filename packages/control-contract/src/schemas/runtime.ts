/**
 * The runtime area's zod schemas, composed from one file per half so each half lands on
 * its own line: `./runtime-work.ts` holds work items'.
 */
import type { z } from "zod";
import { WORK_SCHEMAS } from "./runtime-work.js";

export const RUNTIME_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  ...WORK_SCHEMAS,

  // ...BUDGET_SCHEMAS,
};
