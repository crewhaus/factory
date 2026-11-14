/**
 * Holds each delegation schema to its type in the main entry, at compile time, with the
 * helpers `type-checks.ts` defines and proves.
 */
import type { z } from "zod";
import type * as T from "../index.js";
import type * as S from "./delegation.js";
import type { Expect, Same } from "./type-checks.js";

export type DelegationSchemaTypeChecks = [
  Expect<Same<z.infer<typeof S.delegationAnswer>, T.DelegationAnswer>>,
  Expect<Same<z.infer<typeof S.delegationDetail>, T.DelegationDetail>>,
  Expect<Same<z.infer<typeof S.delegationEnableRequest>, T.DelegationEnableRequest>>,
  Expect<Same<z.infer<typeof S.delegationList>, T.DelegationList>>,
  Expect<Same<z.infer<typeof S.delegationPage>, T.DelegationPage>>,
  Expect<Same<z.infer<typeof S.delegationPauseRequest>, T.DelegationPauseRequest>>,
  Expect<Same<z.infer<typeof S.delegationPreviewRequest>, T.DelegationPreviewRequest>>,
  Expect<Same<z.infer<typeof S.delegationProposeRequest>, T.DelegationProposeRequest>>,
  Expect<Same<z.infer<typeof S.delegationResumeRequest>, T.DelegationResumeRequest>>,
  Expect<Same<z.infer<typeof S.delegationRevokeRequest>, T.DelegationRevokeRequest>>,
  Expect<Same<z.infer<typeof S.delegationRuleView>, T.DelegationRuleView>>,
  Expect<Same<z.infer<typeof S.delegationUpdateRequest>, T.DelegationUpdateRequest>>,
];
