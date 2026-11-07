/**
 * `@crewhaus/control-contract/schemas`: the zod validators the server uses to
 * check what it receives. The only part of this package that imports zod.
 */
import type { z } from "zod";
import { AREA_SCHEMAS } from "./areas.js";

export * from "./core.js";

/** Every schema, by the id an operation row names it with. */
export const SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze(
  Object.assign({}, ...AREA_SCHEMAS),
);
