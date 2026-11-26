/**
 * Holds each attention schema to its type in the main entry, at compile time, with the
 * helpers `type-checks.ts` defines and proves.
 */
import type { z } from "zod";
import type * as T from "../index.js";
import type * as S from "./attention.js";
import type { Expect, Same } from "./type-checks.js";

export type AttentionSchemaTypeChecks = [
  Expect<Same<z.infer<typeof S.attentionActed>, T.AttentionActed>>,
  Expect<Same<z.infer<typeof S.attentionAssignRequest>, T.AttentionAssignRequest>>,
  Expect<Same<z.infer<typeof S.attentionDeferRequest>, T.AttentionDeferRequest>>,
  Expect<Same<z.infer<typeof S.attentionDismissRequest>, T.AttentionDismissRequest>>,
  Expect<Same<z.infer<typeof S.attentionMessageRequest>, T.AttentionMessageRequest>>,
  Expect<Same<z.infer<typeof S.attentionMessages>, T.AttentionMessages>>,
  Expect<Same<z.infer<typeof S.attentionNoteRequest>, T.AttentionNoteRequest>>,
  Expect<Same<z.infer<typeof S.attentionResolveRequest>, T.AttentionResolveRequest>>,
  Expect<Same<z.infer<typeof S.attentionSnoozeRequest>, T.AttentionSnoozeRequest>>,
  Expect<Same<z.infer<typeof S.attentionItem>, T.AttentionItem>>,
  Expect<Same<z.infer<typeof S.attentionList>, T.AttentionList>>,
  Expect<Same<z.input<typeof S.attentionListQuery>, T.AttentionListQuery>>,
  Expect<Same<z.infer<typeof S.attentionMetrics>, T.AttentionMetrics>>,
  Expect<Same<z.infer<typeof S.attentionMetricsQuery>, T.AttentionMetricsQuery>>,
];
