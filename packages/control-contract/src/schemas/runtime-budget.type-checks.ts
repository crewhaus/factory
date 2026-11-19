/**
 * Holds each schema of the runtime area's budget half to its type in the main entry, at
 * compile time, with the helpers `type-checks.ts` defines and proves.
 */
import type { z } from "zod";
import type * as T from "../index.js";
import type * as S from "./runtime-budget.js";
import type { Expect, Same } from "./type-checks.js";

export type RuntimeBudgetSchemaTypeChecks = [
  Expect<Same<z.infer<typeof S.budgetRead>, T.BudgetRead>>,
  Expect<Same<z.infer<typeof S.budgetHistory>, T.BudgetHistory>>,
  Expect<Same<z.infer<typeof S.budgetExtendRequest>, T.BudgetExtendRequest>>,
  Expect<Same<z.infer<typeof S.budgetExtendAnswer>, T.BudgetExtendAnswer>>,
];
