import { z } from "zod";

/**
 * `permissions.delegation:` — the ceiling an owner's delegation rules live under (#514,
 * #517). It names how long any rule on this harness may last (`max_days`, 1 to 90, 30
 * when unset); the actions a rule may cover join it as members later. It is policy, so
 * it is part of the policy revision; it is read only from the active deployment's record,
 * never from the saved spec, so an edit allows nothing until a person activates it; and
 * only the owner changes it: the optimizer refuses it on every shape and the spec editor
 * treats it as a security surface (`packages/spec-patch/src/owner-keys.ts`). No bundle
 * reads it: a spec that sets it compiles to the same files.
 */
export const delegationBlock = z
  .object({
    max_days: z
      .number()
      .int("permissions.delegation.max_days is a whole number of days")
      .min(1, "permissions.delegation.max_days is at least 1")
      .max(90, "permissions.delegation.max_days is at most 90")
      .optional(),
  })
  .strict()
  .optional()
  .describe("how long an owner's delegation rules may last; only the owner edits it");
