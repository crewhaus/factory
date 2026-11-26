/**
 * The home area's zod schemas. Requests are strict; responses pass unknown fields
 * through. `home.type-checks.ts` holds each one to its type.
 */
import { z } from "zod";
import { EXPORT_FORMATS, HOME_REACHED_BY } from "../areas/home.js";
import { commandAccepted, harnessId, principalId } from "./core.js";

export const exportFormatQuery = z
  .object({ format: z.enum(EXPORT_FORMATS as unknown as ["csv", "jsonl"]).optional() })
  .strict();

export const specExport = z
  .object({
    filename: z.string(),
    contentType: z.literal("application/yaml"),
    text: z.string(),
    note: z.string().nullable(),
  })
  .passthrough();

export const evalResultsExport = z
  .object({
    filename: z.string(),
    contentType: z.enum(["text/csv", "application/x-ndjson"]),
    format: z.enum(EXPORT_FORMATS as unknown as ["csv", "jsonl"]),
    runId: z.string(),
    text: z.string(),
    rows: z.number().int().min(0),
    masked: z.literal(true),
  })
  .passthrough();

export const harnessExportAccepted = commandAccepted.extend({
  path: z.string(),
  command: z.string(),
  job: z.object({ jobId: z.string(), state: z.string() }).passthrough().nullable(),
});

const harnessExportRow = z
  .object({ name: z.string(), bytes: z.number().int().min(0), at: z.string() })
  .passthrough();

export const harnessExportList = z
  .object({ exports: z.array(harnessExportRow), note: z.string() })
  .passthrough();

const count = z.number().int().min(0);
const micros = z.number().int();

export const homeStatus = z
  .object({
    host: z
      .object({
        name: z.string(),
        loopback: z.boolean(),
        reachedBy: z.enum(HOME_REACHED_BY as unknown as ["loopback", "lan", "proxy"]),
      })
      .passthrough(),
    version: z.string(),
    service: z
      .object({
        installed: z.union([z.boolean(), z.literal("unknown")]),
        autostart: z.boolean().optional(),
      })
      .passthrough(),
    counts: z
      .object({
        harnesses: count.optional(),
        needsYou: count.optional(),
        working: count.optional(),
        paused: count.optional(),
        notResponding: count.optional(),
        waitingForBudget: count.optional(),
      })
      .passthrough(),
    notes: z.array(z.object({ count: z.string(), note: z.string() }).passthrough()).optional(),
    asOf: z.string(),
  })
  .passthrough();

const spendRow = z
  .object({
    harness: harnessId,
    name: z.string(),
    present: z.boolean(),
    why: z.enum(["no_period", "spec_unreadable"]).optional(),
    note: z.string(),
    verb: z.string(),
    periodId: z.string().optional(),
    every: z.enum(["day", "week", "month"]).optional(),
    renewsAt: z.string().optional(),
    timezone: z.string().optional(),
    capUsdMicros: micros.optional(),
    extensionsUsdMicros: micros.optional(),
    spentUsdMicros: micros.optional(),
    reservedUsdMicros: micros.optional(),
    unknownCalls: count.optional(),
    exhausted: z.boolean().optional(),
    truncated: z.boolean().optional(),
  })
  .passthrough();

export const homeSpend = z
  .object({
    rows: z.array(spendRow),
    totals: z
      .object({
        harnesses: count,
        capUsdMicros: micros,
        spentUsdMicros: micros,
        reservedUsdMicros: micros,
        unknownCalls: count,
        lowerBound: z.literal(true).optional(),
      })
      .passthrough(),
    asOf: z.string(),
  })
  .passthrough();

const harnessAccessGrant = z
  .object({
    role: z.string(),
    scope: z.enum(["home", "group", "harness"]),
    expiresAt: z.string().optional(),
  })
  .passthrough();

export const harnessAccess = z
  .object({
    harness: harnessId,
    members: z.array(
      z
        .object({
          principal: principalId,
          name: z.string().optional(),
          kind: z.enum(["member", "service"]),
          grants: z.array(harnessAccessGrant),
        })
        .passthrough(),
    ),
    note: z.string(),
  })
  .passthrough();

export const HOME_SCHEMAS = Object.freeze({
  exportFormatQuery,
  specExport,
  evalResultsExport,
  harnessExportAccepted,
  harnessExportList,
  homeStatus,
  homeSpend,
  harnessAccess,
});
