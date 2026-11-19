/**
 * Holds each runtime schema to its type in the main entry, at compile time, with the
 * helpers `type-checks.ts` defines and proves.
 */
import type { z } from "zod";
import type * as T from "../index.js";
import type * as S from "./runtime-work.js";
import type { Expect, Same } from "./type-checks.js";

export type RuntimeSchemaTypeChecks = [
  Expect<Same<z.infer<typeof S.workAdoptRequest>, T.WorkAdoptRequest>>,
  Expect<Same<z.infer<typeof S.workAnswer>, T.WorkAnswer>>,
  Expect<Same<z.infer<typeof S.workAssessment>, T.WorkAssessment>>,
  Expect<Same<z.infer<typeof S.workCreateRequest>, T.WorkCreateRequest>>,
  Expect<Same<z.infer<typeof S.workCreateSpec>, T.WorkCreateSpec>>,
  Expect<Same<z.infer<typeof S.workDeclineRequest>, T.WorkDeclineRequest>>,
  Expect<Same<z.infer<typeof S.workEvidence>, T.WorkEvidence>>,
  Expect<Same<z.infer<typeof S.workFeed>, T.WorkFeed>>,
  Expect<Same<z.infer<typeof S.workItem>, T.WorkItemView>>,
  Expect<Same<z.infer<typeof S.workItemDetail>, T.WorkItemDetail>>,
  Expect<Same<z.infer<typeof S.workList>, T.ListEnvelope<T.WorkItemView>>>,
  Expect<Same<z.infer<typeof S.workRankRequest>, T.WorkRankRequest>>,
  Expect<Same<z.infer<typeof S.workUpdateRequest>, T.WorkUpdateRequest>>,
];
