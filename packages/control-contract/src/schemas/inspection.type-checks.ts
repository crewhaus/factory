/**
 * Holds each inspection schema to its type in the main entry, at compile time, with the
 * helpers `type-checks.ts` defines and proves.
 */
import type { z } from "zod";
import type * as T from "../index.js";
import type * as S from "./inspection.js";
import type { Expect, Same } from "./type-checks.js";

export type InspectionSchemaTypeChecks = [
  Expect<Same<z.infer<typeof S.inspectTimelineQuery>, T.InspectTimelineQuery>>,
  Expect<Same<z.infer<typeof S.inspectRawQuery>, T.InspectRawQuery>>,
  Expect<Same<z.infer<typeof S.inspectSummary>, T.InspectSummaryAnswer>>,
  Expect<Same<z.infer<typeof S.inspectTimeline>, T.InspectTimelineAnswer>>,
  Expect<Same<z.infer<typeof S.inspectWhy>, T.InspectWhyAnswer>>,
  Expect<Same<z.infer<typeof S.inspectContext>, T.InspectContextAnswer>>,
  Expect<Same<z.infer<typeof S.inspectRequest>, T.InspectRequestAnswer>>,
  Expect<Same<z.infer<typeof S.inspectExport>, T.InspectExportAnswer>>,
  Expect<Same<z.infer<typeof S.inspectRaw>, T.InspectRawAnswer>>,
  Expect<Same<z.infer<typeof S.inspectSession>, T.InspectSessionAnswer>>,
  Expect<Same<z.infer<typeof S.inspectWork>, T.InspectWorkAnswer>>,
];
