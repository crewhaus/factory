/** What a scoped browser token may do: read actions only, from a closed list. */
import { MODULES, type ModuleField } from "./areas/index.js";
import { classifyRunId } from "./run-ids.js";
import { deepFreeze } from "./util.js";

export type ScopedAct = ModuleField<"scopedActs"> extends readonly (infer Row)[] ? Row : never;

export const SCOPED_ACTS: readonly ScopedAct[] = deepFreeze(
  MODULES.flatMap((module) => module.scopedActs ?? []) as ScopedAct[],
);

/**
 * The ref kinds a scoped token may name: a run, and a supervisor's execution. A
 * `run_<16 hex>` is named `exec`, the kind the grammar already gives it, so no id is
 * ever read as a run by its shape alone.
 */
export const SCOPED_REF_KINDS = deepFreeze(["run", "exec"] as const);

export type ScopedRefKind = (typeof SCOPED_REF_KINDS)[number];

/**
 * The ref a scoped token names for a run id in one harness: `<hrn>/run/<id>` for a
 * canonical, hex8 or base36 id, `<hrn>/exec/<id>` for a `run_<16 hex>`, and `undefined`
 * for anything else. Whether the run exists is the server's to decide, from the
 * harness's own records.
 */
export function scopedRunRef(harness: string, id: string): string | undefined {
  const { family } = classifyRunId(id);
  if (family === "canonical" || family === "hex8" || family === "base36") {
    return `${harness}/run/${id}`;
  }
  if (family === "hex16") return `${harness}/exec/${id}`;
  return undefined;
}
