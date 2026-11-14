/**
 * Holds each creation schema to its type in the main entry, at compile time, with the
 * helpers `type-checks.ts` defines and proves.
 */
import type { z } from "zod";
import type * as T from "../index.js";
import type * as S from "./creation.js";
import type { Expect, Same } from "./type-checks.js";

export type CreationSchemaTypeChecks = [
  Expect<Same<z.infer<typeof S.specSchemaView>, T.SpecSchemaView>>,
];
