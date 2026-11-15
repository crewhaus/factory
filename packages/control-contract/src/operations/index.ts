/** The operation table of `crewhaus.hangar.v1`: the union of the composed modules. */
import { MODULES, type ModuleField } from "../areas/index.js";
import type { OperationRow, Qualifier } from "../areas/types.js";
import { SCOPED_ACTS } from "../scoped-acts.js";
import { deepFreeze } from "../util.js";

export type { CliTwin, ModelBoundDecl, OperationRow, Qualifier } from "../areas/types.js";

type Row = ModuleField<"operations"> extends readonly (infer R)[] ? R : never;

export type OperationId = Row extends { readonly id: infer I } ? I : never;

export const OPERATIONS: readonly OperationRow[] = deepFreeze(
  MODULES.flatMap((module) => module.operations),
);

export const QUALIFIERS = deepFreeze([
  "filtered",
  "content-fields",
  "class",
  "maintainer-or-above",
  "subject-assert",
  "creating-service",
  "human-only",
  "self",
  "service-delegation",
  "view-target",
  "workspace-target",
] as const satisfies readonly Qualifier[]);

/**
 * The ids of the rows whose `scopedAct` is not a scoped act, or sits on a row a scoped
 * token may not read through: not a GET, or naming no object (`ref`). Pure.
 *
 * First consumer: `operations.test.ts`, over {@link OPERATIONS} and planted rows.
 */
export function badScopedOperations(rows: readonly OperationRow[]): string[] {
  return rows
    .filter(
      (row) =>
        row.scopedAct !== undefined &&
        (!(SCOPED_ACTS as readonly string[]).includes(row.scopedAct) ||
          row.method !== "GET" ||
          row.ref === undefined),
    )
    .map((row) => row.id);
}
