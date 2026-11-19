/**
 * The runtime area's budget half (#516, #513, module briefs 108 and 324): a harness's
 * spending period, read and raised. Static data, like every area module: the three
 * `budget.*` operations, the one command kind a raise submits, the permission a
 * maintainer holds for it, the `budget` event family, the closed reasons a raise gives
 * and the capability keys a bundle built before periods existed answers unsupported.
 *
 * A raise is never delegable and never implied for an agent: `h.budget.extend` has the
 * floor `maintainer` and no service principal may hold it.
 */
import type { CommandReceipt } from "../commands.js";
import { HARNESS_COMMAND, READ } from "../operations/shared.js";
import { deepFreeze } from "../util.js";
import type { AreaModule } from "./types.js";

/** Why a person raised a period's limit. Closed: a fifth reason is a schema change. */
export const BUDGET_EXTEND_REASONS = deepFreeze([
  "planned-work",
  "incident",
  "one-off",
  "other",
] as const);

export type BudgetExtendReason = (typeof BUDGET_EXTEND_REASONS)[number];

/** How long a period lasts. */
export const BUDGET_PERIOD_EVERY = deepFreeze(["day", "week", "month"] as const);

/** The current period, as `budget.get` answers it. Every amount is in USD-micros. */
export type BudgetFoldView = {
  readonly periodId: string;
  readonly every: (typeof BUDGET_PERIOD_EVERY)[number];
  readonly startsAt: string;
  readonly renewsAt: string;
  readonly capUsdMicros: number;
  readonly extensionsUsdMicros: number;
  readonly spentUsdMicros: number;
  readonly reservedUsdMicros: number;
  /** Settled calls nothing could price: their cost is unknown, not $0. */
  readonly unknownCalls: number;
  readonly exhausted: boolean;
  readonly asOf: string;
  readonly truncated: boolean;
  readonly gaps: number;
};

/** `budget.get`: the current period, or why there is none. */
export type BudgetRead =
  | {
      readonly present: true;
      readonly note: string;
      readonly verb: string;
      readonly fold: BudgetFoldView;
    }
  | { readonly present: false; readonly note: string; readonly verb: string };

/** One closed period's summary. */
export type BudgetPeriodView = {
  readonly periodId: string;
  readonly closedAt: string;
  readonly spentUsdMicros: number;
  readonly extensionsUsdMicros: number;
  readonly unknownCalls: number;
  readonly truncated: boolean;
};

/** `budget.periods`: the closed periods, newest first, or why there are none. */
export type BudgetHistory =
  | {
      readonly present: true;
      readonly note: string;
      readonly verb: string;
      readonly periods: readonly BudgetPeriodView[];
      readonly gaps: number;
    }
  | { readonly present: false; readonly note: string; readonly verb: string };

/** `budget.extend`'s request: the amount in USD, the reason, and the period it raises. */
export type BudgetExtendRequest = {
  readonly usd: number;
  readonly reasonCode: BudgetExtendReason;
  /** The `periodId` the raise is for: a raise for any other period is refused (412). */
  readonly expect: string;
};

/** `budget.extend`'s answer: the receipt, and the period's fold once the raise is in. */
export type BudgetExtendAnswer = {
  readonly receipt: CommandReceipt;
  readonly fold?: BudgetFoldView;
};

const BUDGET_PATH = "/api/v1/harnesses/{h}/budget";

const TWINS = {
  show: { argv: ["budget", "show", "--harness", "{hrn}"] },
  history: { argv: ["budget", "history", "--harness", "{hrn}"] },
  extend: {
    argv: [
      "budget",
      "extend",
      "--usd",
      "{usd}",
      "--reason",
      "{budgetReason}",
      "--harness",
      "{hrn}",
    ],
  },
} as const;

export const BUDGET_OPERATIONS = [
  {
    ...READ,
    id: "budget.get",
    method: "GET",
    path: BUDGET_PATH,
    permission: "h.read",
    request: "noBody",
    response: "budgetRead",
    cliTwin: TWINS.show,
    qualifiers: [],
  },
  {
    ...READ,
    id: "budget.periods",
    method: "GET",
    path: `${BUDGET_PATH}/periods`,
    permission: "h.read",
    request: "noBody",
    response: "budgetHistory",
    cliTwin: TWINS.history,
    qualifiers: [],
  },
  {
    ...HARNESS_COMMAND,
    id: "budget.extend",
    method: "POST",
    path: `${BUDGET_PATH}/extensions`,
    permission: "h.budget.extend",
    request: "budgetExtendRequest",
    response: "budgetExtendAnswer",
    cliTwin: TWINS.extend,
    qualifiers: ["human-only"],
  },
] as const satisfies AreaModule["operations"];

export const BUDGET_COMMAND_KINDS = [
  {
    id: "budget.extend",
    permission: "h.budget.extend",
    // A second topup would raise the limit twice.
    idempotent: false,
    effect: "local",
    cliTwin: TWINS.extend,
  },
] as const satisfies AreaModule["commandKinds"];

export const BUDGET_PERMISSIONS = [
  { id: "h.budget.extend", scope: "harness", floor: "maintainer", service: "never" },
] as const satisfies AreaModule["permissions"];

export const BUDGET_EVENT_FAMILIES = [
  {
    family: "budget",
    types: [
      { type: "budget.unpriced", sensitivity: "internal" },
      { type: "budget.exhausted", sensitivity: "internal" },
      { type: "budget.extended", sensitivity: "internal" },
      { type: "budget.renewed", sensitivity: "internal" },
    ],
  },
] as const satisfies AreaModule["eventFamilies"];

export const BUDGET_REASON_CODES = { budget: [...BUDGET_EXTEND_REASONS] } as const;

/** What a harness answers about spending periods: a bundle built before them, unsupported. */
export const BUDGET_CAPABILITY_KEYS = ["budget.period", "budget.reservations"] as const;
