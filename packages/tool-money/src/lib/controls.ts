/**
 * Spending controls and refund-abuse signals.
 *
 * An unattended harness that can move money needs a limit it cannot talk
 * itself past, and a function cannot be that limit on its own: it computes
 * over the history, limits and clock it is handed. When a model hands them
 * over, the verdict is advisory. It is a control only where those inputs come
 * from a record the model cannot edit, and a limit that must hold belongs in
 * the policy of whatever actually moves the money.
 *
 * Both functions take the history as an argument and the clock as a
 * parameter. Nothing here reads a database or the time, so the same facts
 * always give the same verdict — which is what makes a refusal explicable
 * afterwards.
 */

import { addExact, mathRound, sumExact, toNumber } from "./exact";

export type Spend = {
  readonly id: string;
  /** ISO-8601 with an offset. */
  readonly at: string;
  readonly amountMinor: number;
  readonly counterparty?: string;
};

export type SpendLimits = {
  /** Largest single payment allowed. */
  readonly perTransactionMinor?: number;
  readonly perHourMinor?: number;
  readonly perDayMinor?: number;
  readonly perWeekMinor?: number;
  /** Cap on the total to any one counterparty within the day window. */
  readonly perCounterpartyPerDayMinor?: number;
  readonly maxTransactionsPerHour?: number;
  /**
   * Hours during which nothing may move, as UTC hours 0-23. The window is
   * about when a human could notice, so it is deliberately absolute rather
   * than local to anybody.
   */
  readonly quietHoursUtc?: ReadonlyArray<number>;
  /** Payments to a counterparty never paid before are refused. */
  readonly knownCounterpartiesOnly?: boolean;
  readonly knownCounterparties?: ReadonlyArray<string>;
};

export type SpendDecision = {
  readonly allowed: boolean;
  /** Every limit the payment breaks, not just the first. */
  readonly violations: ReadonlyArray<{
    readonly limit: string;
    readonly capMinor: number | null;
    readonly wouldBeMinor: number | null;
    readonly detail: string;
  }>;
  readonly windows: Readonly<Record<string, number>>;
  readonly headroomMinor: number | null;
};

function instant(value: string, what: string): number {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())) {
    throw new Error(`${what} ("${value}") has no UTC offset`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${what} ("${value}") is not a valid ISO-8601 instant`);
  return parsed;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function checkSpendLimit(
  proposed: { readonly amountMinor: number; readonly counterparty?: string },
  history: ReadonlyArray<Spend>,
  limits: SpendLimits,
  nowMs: number,
): SpendDecision {
  const entries = history.map((s) => ({ ...s, atMs: instant(s.at, `spend "${s.id}" at`) }));
  const since = (ms: number): typeof entries =>
    entries.filter((e) => nowMs - e.atMs < ms && e.atMs <= nowMs);
  const sum = (list: typeof entries, what: string): number =>
    sumExact(
      list.map((e) => e.amountMinor),
      what,
    );

  const hour = since(HOUR);
  const day = since(DAY);
  const week = since(WEEK);
  const windows = {
    hourMinor: sum(hour, "the spend in the last hour"),
    dayMinor: sum(day, "the spend in the last day"),
    weekMinor: sum(week, "the spend in the last week"),
    hourCount: hour.length,
  };

  const violations: Array<{
    limit: string;
    capMinor: number | null;
    wouldBeMinor: number | null;
    detail: string;
  }> = [];
  const check = (name: string, cap: number | undefined, spent: number): void => {
    if (cap === undefined) return;
    const wouldBe = addExact(spent, proposed.amountMinor, `the ${name} spend with this payment`);
    if (wouldBe > cap) {
      violations.push({
        limit: name,
        capMinor: cap,
        wouldBeMinor: wouldBe,
        detail: `${spent} already spent in this window, ${proposed.amountMinor} proposed, cap ${cap}`,
      });
    }
  };

  if (
    limits.perTransactionMinor !== undefined &&
    proposed.amountMinor > limits.perTransactionMinor
  ) {
    violations.push({
      limit: "perTransaction",
      capMinor: limits.perTransactionMinor,
      wouldBeMinor: proposed.amountMinor,
      detail: `a single payment of ${proposed.amountMinor} is over the ${limits.perTransactionMinor} ceiling`,
    });
  }
  check("perHour", limits.perHourMinor, windows.hourMinor);
  check("perDay", limits.perDayMinor, windows.dayMinor);
  check("perWeek", limits.perWeekMinor, windows.weekMinor);

  if (limits.perCounterpartyPerDayMinor !== undefined && proposed.counterparty !== undefined) {
    const spent = sum(
      day.filter((e) => e.counterparty === proposed.counterparty),
      "the spend to this counterparty in the last day",
    );
    check(
      `perCounterpartyPerDay:${proposed.counterparty}`,
      limits.perCounterpartyPerDayMinor,
      spent,
    );
  }

  if (
    limits.maxTransactionsPerHour !== undefined &&
    windows.hourCount + 1 > limits.maxTransactionsPerHour
  ) {
    violations.push({
      limit: "maxTransactionsPerHour",
      capMinor: null,
      wouldBeMinor: null,
      detail: `${windows.hourCount} payments in the last hour, cap ${limits.maxTransactionsPerHour}`,
    });
  }

  if (limits.quietHoursUtc && limits.quietHoursUtc.length > 0) {
    const hourUtc = new Date(nowMs).getUTCHours();
    if (limits.quietHoursUtc.includes(hourUtc)) {
      violations.push({
        limit: "quietHours",
        capMinor: null,
        wouldBeMinor: null,
        detail: `${hourUtc}:00 UTC is inside the quiet window, when nobody is watching`,
      });
    }
  }

  if (limits.knownCounterpartiesOnly) {
    // When the operator supplies a list, that list IS the allow-list.
    //
    // Deriving "known" from payment history as well looked like a
    // convenience and was a hole: one payment that got through by any means
    // added its counterparty to the allow-list permanently, so the control
    // stopped exactly one payment and then approved every one after it. A
    // control that weakens itself the first time it is defeated is not a
    // control.
    //
    // With no list supplied there is nothing else to go on, so history is
    // used — a weaker rule, and one the result names.
    const known = new Set(
      limits.knownCounterparties && limits.knownCounterparties.length > 0
        ? limits.knownCounterparties
        : entries.map((e) => e.counterparty).filter((c): c is string => c !== undefined),
    );
    const basis =
      limits.knownCounterparties && limits.knownCounterparties.length > 0
        ? "the declared allow-list"
        : "counterparties paid before, since no allow-list was declared";
    if (proposed.counterparty === undefined || !known.has(proposed.counterparty)) {
      violations.push({
        limit: "knownCounterpartiesOnly",
        capMinor: null,
        wouldBeMinor: null,
        detail:
          proposed.counterparty === undefined
            ? "the payment names no counterparty, and only known ones are allowed"
            : `"${proposed.counterparty}" is not in ${basis}`,
      });
    }
  }

  // Headroom is the tightest remaining amount limit, which is the number a
  // caller needs to propose something that would pass.
  const room = (cap: number | undefined, spent: number, what: string): number | undefined =>
    cap === undefined ? undefined : addExact(cap, -spent, what);
  const caps = [
    limits.perTransactionMinor,
    room(limits.perHourMinor, windows.hourMinor, "the hourly headroom"),
    room(limits.perDayMinor, windows.dayMinor, "the daily headroom"),
    room(limits.perWeekMinor, windows.weekMinor, "the weekly headroom"),
  ].filter((v): v is number => v !== undefined);

  return {
    allowed: violations.length === 0,
    violations,
    windows,
    headroomMinor: caps.length === 0 ? null : Math.max(0, Math.min(...caps)),
  };
}

export type RefundEvent = {
  readonly id: string;
  readonly at: string;
  readonly amountMinor: number;
  readonly reason?: string;
  readonly replacement?: boolean;
};

export type OrderEvent = { readonly id: string; readonly at: string; readonly amountMinor: number };

export type AbuseSignals = {
  readonly windows: ReadonlyArray<{
    readonly days: number;
    readonly refunds: number;
    readonly refundedMinor: number;
    readonly orders: number;
    readonly spentMinor: number;
    /** Refunded over spent, in basis points. 10000 is everything. */
    readonly ratioBps: number | null;
  }>;
  readonly replacements: number;
  readonly nonDeliveryClaims: number;
  readonly flags: ReadonlyArray<string>;
};

/**
 * Refund-abuse signals over fixed windows.
 *
 * This reports ratios and counts. It does not decide that somebody is a
 * fraudster, and the tool that wraps it must not present it as if it had —
 * a high ratio is also what a customer with one broken delivery looks like.
 */
export function refundAbuseSignals(
  refunds: ReadonlyArray<RefundEvent>,
  orders: ReadonlyArray<OrderEvent>,
  nowMs: number,
  thresholds: { readonly ratioBps?: number; readonly refundCount?: number } = {},
): AbuseSignals {
  const windows = [30, 90, 365].map((days) => {
    const cutoff = nowMs - days * DAY;
    const r = refunds.filter((x) => instant(x.at, `refund "${x.id}" at`) >= cutoff);
    const o = orders.filter((x) => instant(x.at, `order "${x.id}" at`) >= cutoff);
    const refundedMinor = sumExact(
      r.map((x) => x.amountMinor),
      `the refunds in ${days} days`,
    );
    const spentMinor = sumExact(
      o.map((x) => x.amountMinor),
      `the orders in ${days} days`,
    );
    return {
      days,
      refunds: r.length,
      refundedMinor,
      orders: o.length,
      spentMinor,
      // Undefined rather than infinite when nothing was spent: a ratio
      // against zero is not a large number, it is not a number.
      ratioBps:
        spentMinor === 0
          ? null
          : toNumber(
              mathRound(BigInt(refundedMinor) * 10_000n, BigInt(spentMinor)),
              `the ${days}-day refund ratio`,
            ),
    };
  });

  const flags: string[] = [];
  const ratioCap = thresholds.ratioBps;
  const countCap = thresholds.refundCount;
  for (const w of windows) {
    if (ratioCap !== undefined && w.ratioBps !== null && w.ratioBps > ratioCap) {
      flags.push(`refunded ${(w.ratioBps / 100).toFixed(1)}% of spend in ${w.days} days`);
    }
    if (countCap !== undefined && w.refunds > countCap) {
      flags.push(`${w.refunds} refunds in ${w.days} days`);
    }
  }

  return {
    windows,
    replacements: refunds.filter((r) => r.replacement).length,
    nonDeliveryClaims: refunds.filter((r) =>
      /not.?(delivered|received)|never arrived|missing/i.test(r.reason ?? ""),
    ).length,
    flags,
  };
}
