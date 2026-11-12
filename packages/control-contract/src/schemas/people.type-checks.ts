/**
 * Holds each people schema to its type in the main entry, at compile time, with the
 * helpers `type-checks.ts` defines and proves.
 */
import type { z } from "zod";
import type * as T from "../index.js";
import type * as S from "./people.js";
import type { Expect, Same } from "./type-checks.js";

export type PeopleSchemaTypeChecks = [
  Expect<Same<z.infer<typeof S.claimCreateRequest>, T.ClaimCreateRequest>>,
  Expect<Same<z.infer<typeof S.claimReviewRequest>, T.ClaimReviewRequest>>,
  Expect<Same<z.infer<typeof S.claimReviseRequest>, T.ClaimReviseRequest>>,
  Expect<Same<z.infer<typeof S.erasurePlan>, T.ErasurePlanView>>,
  Expect<Same<z.infer<typeof S.erasureRunRequest>, T.ErasureRunRequest>>,
  Expect<Same<z.infer<typeof S.exportPreview>, T.ExportPreview>>,
  Expect<Same<z.infer<typeof S.exportRequest>, T.ExportRequest>>,
  Expect<Same<z.infer<typeof S.peopleSetupRequest>, T.PeopleSetupRequest>>,
  Expect<Same<z.infer<typeof S.peopleVaultState>, T.VaultStateView>>,
  Expect<Same<z.infer<typeof S.personActivityList>, T.ListEnvelope<T.PersonActivityRow>>>,
  Expect<Same<z.infer<typeof S.personActivityRow>, T.PersonActivityRow>>,
  Expect<Same<z.infer<typeof S.personClaim>, T.PersonClaimView>>,
  Expect<Same<z.infer<typeof S.personClaimList>, T.ListEnvelope<T.PersonClaimView>>>,
  Expect<Same<z.infer<typeof S.personCreateRequest>, T.PersonCreateRequest>>,
  Expect<Same<z.infer<typeof S.personList>, T.ListEnvelope<T.PersonRow>>>,
  Expect<Same<z.infer<typeof S.personRow>, T.PersonRow>>,
  Expect<Same<z.infer<typeof S.personUpdateRequest>, T.PersonUpdateRequest>>,
  Expect<Same<z.infer<typeof S.personView>, T.PersonView>>,
];
