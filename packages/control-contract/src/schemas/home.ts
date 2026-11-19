/**
 * The home area's zod schemas. Requests are strict; responses pass unknown fields
 * through. `home.type-checks.ts` holds each one to its type.
 */
import { z } from "zod";
import { EXPORT_FORMATS } from "../areas/home.js";
import { commandAccepted } from "./core.js";

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

export const HOME_SCHEMAS = Object.freeze({
  exportFormatQuery,
  specExport,
  evalResultsExport,
  harnessExportAccepted,
  harnessExportList,
});
