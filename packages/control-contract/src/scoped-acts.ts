/** What a scoped browser token may do: read actions only, from a closed list. */
import { MODULES, type ModuleField } from "./areas/index.js";
import { deepFreeze } from "./util.js";

export type ScopedAct = ModuleField<"scopedActs"> extends readonly (infer Row)[] ? Row : never;

export const SCOPED_ACTS: readonly ScopedAct[] = deepFreeze(
  MODULES.flatMap((module) => module.scopedActs ?? []) as ScopedAct[],
);
