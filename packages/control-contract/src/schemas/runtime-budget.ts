/**
 * The budget half of the runtime area's zod schemas. Requests are strict; responses pass
 * unknown fields through. Every amount on the wire is integer USD-micros except a raise's
 * `usd`, which a person types in dollars.
 */
import { z } from "zod";
import { BUDGET_EXTEND_REASONS, BUDGET_PERIOD_EVERY } from "../areas/runtime-budget.js";
import { commandReceipt } from "./core.js";

function oneOf<const T extends readonly [string, ...string[]]>(list: T) {
  return z.enum(list as unknown as [T[number], ...T[number][]]);
}

const micros = z.number().int().nonnegative();
const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected a timestamp");
const periodId = z.string().regex(/^(day|week|month)-\d{4}-\d{2}-\d{2}(?:-[0-9a-f]{6})?$/);

const budgetFold = z
  .object({
    periodId,
    every: oneOf(BUDGET_PERIOD_EVERY),
    timezone: z.string().min(1).optional(),
    startsAt: timestamp,
    renewsAt: timestamp,
    capUsdMicros: micros,
    extensionsUsdMicros: micros,
    spentUsdMicros: micros,
    reservedUsdMicros: micros,
    unknownCalls: z.number().int().nonnegative(),
    exhausted: z.boolean(),
    asOf: timestamp,
    truncated: z.boolean(),
    gaps: z.number().int().nonnegative(),
  })
  .passthrough();

const absent = z
  .object({ present: z.literal(false), note: z.string(), verb: z.string() })
  .passthrough();

const budgetRights = z.object({ extend: z.boolean() }).passthrough();

export const budgetRead = z.union([
  z
    .object({
      present: z.literal(true),
      note: z.string(),
      verb: z.string(),
      fold: budgetFold,
      you: budgetRights.optional(),
    })
    .passthrough(),
  z
    .object({
      present: z.literal(false),
      note: z.string(),
      verb: z.string(),
      why: z.enum(["no_period", "spec_unreadable"]).optional(),
      you: budgetRights.optional(),
    })
    .passthrough(),
]);

export const budgetHistory = z.union([
  z
    .object({
      present: z.literal(true),
      note: z.string(),
      verb: z.string(),
      periods: z.array(
        z
          .object({
            periodId,
            closedAt: timestamp,
            spentUsdMicros: micros,
            extensionsUsdMicros: micros,
            unknownCalls: z.number().int().nonnegative(),
            truncated: z.boolean(),
          })
          .passthrough(),
      ),
      gaps: z.number().int().nonnegative(),
    })
    .passthrough(),
  absent,
]);

export const budgetExtendRequest = z
  .object({
    usd: z.number().positive().max(1_000_000),
    reasonCode: oneOf(BUDGET_EXTEND_REASONS),
    expect: periodId,
  })
  .strict();

export const budgetExtendAnswer = z
  .object({ receipt: commandReceipt, fold: budgetFold.optional() })
  .passthrough();

export const BUDGET_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  budgetRead,
  budgetHistory,
  budgetExtendRequest,
  budgetExtendAnswer,
};
