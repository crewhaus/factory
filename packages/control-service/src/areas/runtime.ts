/**
 * The runtime area's running code (#516), composed from one half per file's worth of
 * kinds so each half lands on its own lines. The budget half is here: `budget.extend`
 * runs as an inline effect, so recovery never acts again: its executor and reconciler
 * observe whether a period's ledger holds a topup carrying the receipt's id. It acts on
 * records alone (`unsupervised`).
 */
import { budgetTopupWritten } from "../budget";
import type { AreaRuntime } from "../executor";
import { NEEDS_DECISION } from "../refusal";

const BUDGET_KINDS = ["budget.extend"] as const;

export const RUNTIME_RUNTIME: AreaRuntime = {
  area: "runtime",
  executors: {
    // ...WORK_EXECUTORS,

    "budget.extend": async ({ receipt, harnessDir }) =>
      budgetTopupWritten(harnessDir, receipt.id)
        ? { state: "succeeded" }
        : { state: "unknown", outcome: NEEDS_DECISION },
  },
  reconcilers: {
    // ...WORK_RECONCILERS,

    "budget.extend": (receipt, { harnessDir }) =>
      harnessDir !== undefined && budgetTopupWritten(harnessDir, receipt.id) ? "done" : "unknown",
  },
  unsupervised: [
    // ...WORK_UNSUPERVISED,

    ...BUDGET_KINDS,
  ],
};
