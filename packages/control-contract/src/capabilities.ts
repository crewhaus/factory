/**
 * What a harness can do, per bundle. Tri-state on purpose: a bundle built before
 * the support manifest answers `unknown`, not `false`, and "could not determine"
 * is not "no". A bundle compiled before 0.9.0 lacks `runs.create`, so the control
 * API refuses to start a run on it.
 */
import { MODULES, type ModuleField } from "./areas/index.js";
import { deepFreeze } from "./util.js";

type CapabilityRow = ModuleField<"capabilityKeys"> extends readonly (infer Row)[] ? Row : never;

export type CapabilityName = CapabilityRow;

export const CAPABILITY_NAMES: readonly CapabilityName[] = deepFreeze(
  MODULES.flatMap((module) => module.capabilityKeys ?? []) as CapabilityName[],
);

export type CapabilityDescriptor =
  | {
      readonly supported: true;
      /** `decisions.consumeChecks` only. */
      readonly mode?: "validated" | "legacy";
    }
  | {
      readonly supported: false;
      readonly reason: string;
      /** A real CLI command that fills the gap, or `null` when there is none. */
      readonly verb: string | null;
    }
  | {
      readonly supported: "unknown";
      readonly reason: string;
    };
