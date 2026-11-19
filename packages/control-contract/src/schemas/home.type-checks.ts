/**
 * Holds each home schema to its type in the main entry, at compile time, with the
 * helpers `type-checks.ts` defines and proves.
 */
import type { z } from "zod";
import type * as T from "../index.js";
import type * as S from "./home.js";
import type { Expect, Same } from "./type-checks.js";

export type HomeSchemaTypeChecks = [
  Expect<Same<z.input<typeof S.exportFormatQuery>, { format?: T.ExportFormat }>>,
  Expect<Same<z.infer<typeof S.specExport>, T.SpecExport>>,
  Expect<Same<z.infer<typeof S.evalResultsExport>, T.EvalResultsExport>>,
  Expect<
    Same<
      Pick<z.infer<typeof S.harnessExportAccepted>, "path" | "command" | "job">,
      T.HarnessExportStarted
    >
  >,
  Expect<Same<z.infer<typeof S.harnessExportList>, T.HarnessExportList>>,
];
