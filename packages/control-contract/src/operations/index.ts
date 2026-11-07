/** The operation table of `crewhaus.hangar.v1`: the union of the composed modules. */
import { MODULES, type ModuleField } from "../areas/index.js";
import type { OperationRow, Qualifier } from "../areas/types.js";
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
