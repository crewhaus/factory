/** One minimal valid value per schema of the runtime area's budget half. */
import { RECEIPT } from "./schema-examples.js";

const AT = "2026-11-18T00:00:00.000Z";

const FOLD = {
  periodId: "month-2026-11-01",
  every: "month",
  startsAt: "2026-11-01T00:00:00.000Z",
  renewsAt: "2026-12-01T00:00:00.000Z",
  capUsdMicros: 50_000_000,
  extensionsUsdMicros: 0,
  spentUsdMicros: 1_200_000,
  reservedUsdMicros: 0,
  unknownCalls: 0,
  exhausted: false,
  asOf: AT,
  truncated: false,
  gaps: 0,
} as const;

export const EXAMPLES = {
  budgetRead: {
    present: true,
    note: "Spend so far this period.",
    verb: "crewhaus budget show",
    fold: FOLD,
  },
  budgetHistory: {
    present: false,
    note: "No period has closed yet.",
    verb: "crewhaus budget history",
  },
  budgetExtendRequest: { usd: 50, reasonCode: "planned-work", expect: "month-2026-11-01" },
  budgetExtendAnswer: { receipt: RECEIPT, fold: FOLD },
};
