import { z } from "zod";
import type { Spec } from "../index";
import type { SpecAddIssue } from "./delta-090";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `budget.period` (#514, #516): a harness-wide spending limit per day, week or
 * month, across every run, sub-agent, eval and optimizer call, kept in the
 * harness's local spend ledger. A period that is used up closes the harness
 * to new work until it renews; a maintainer can raise the current period.
 *
 * - `every`: how long a period lasts.
 * - `usd`: the limit for one period, in USD.
 * - `starts`: an ISO date the periods are counted from (a week starts on its
 *   weekday, a month on its day of the month, 1 to 28). Default: midnight,
 *   Mondays, and the 1st.
 * - `timezone`: the IANA zone a period's midnight is in. Default UTC.
 *
 * Only a person sets it: the optimizer never edits a spending period
 * (`packages/spec-patch/src/owner-keys.ts`).
 */
export const budgetPeriodBlock = z
  .object({
    every: z.enum(["day", "week", "month"]),
    usd: z.number().positive(),
    starts: z
      .string()
      .regex(ISO_DATE_RE, "budget.period.starts is an ISO date (YYYY-MM-DD)")
      .optional(),
    timezone: z.string().min(1).optional(),
  })
  .strict()
  .optional()
  .describe("a harness-wide spending limit per day, week or month");

/** True when this runtime's `Intl` knows `timezone`. */
function knownTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar day of an ISO date, or `undefined` when it names no real day. */
function calendarDay(iso: string): number | undefined {
  const match = ISO_DATE_RE.exec(iso);
  if (match === null) return undefined;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d
    ? d
    : undefined;
}

/**
 * A period's `timezone` is one the runtime knows; its `starts` is a real
 * calendar day, and a monthly period starts on day 1 to 28 (no month is
 * shortened to fit).
 */
export function budgetPeriodIssues(data: Spec, custom: SpecAddIssue): void {
  const budget = "budget" in data ? data.budget : undefined;
  const period = budget?.period;
  if (period === undefined) return;
  if (period.timezone !== undefined && !knownTimeZone(period.timezone)) {
    custom(
      ["budget", "period", "timezone"],
      `budget.period.timezone ${JSON.stringify(period.timezone)} is not a time zone this runtime knows; use an IANA name such as "Europe/Berlin".`,
    );
  }
  if (period.starts !== undefined) {
    const day = calendarDay(period.starts);
    if (day === undefined) {
      custom(
        ["budget", "period", "starts"],
        `budget.period.starts ${JSON.stringify(period.starts)} is not a calendar date.`,
      );
    } else if (period.every === "month" && day > 28) {
      custom(
        ["budget", "period", "starts"],
        `budget.period.starts is day ${day}: a monthly period starts on day 1 to 28, so every month has that day.`,
      );
    }
  }
}
