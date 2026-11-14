/**
 * The creation area's zod schemas. Responses pass unknown fields through.
 * `creation.type-checks.ts` holds each one to its type in the main entry.
 */
import { z } from "zod";
import { harnessId } from "./core.js";

const count = z.number().int().nonnegative();

const specSchemaIssue = z
  .object({
    path: z.array(z.string()),
    message: z.string(),
    code: z.string().nullable(),
  })
  .passthrough();

const specEffectiveRow = z
  .object({
    path: z.string(),
    segments: z.array(z.string()),
    value: z.unknown(),
    source: z.enum(["declared", "default"]),
  })
  .passthrough();

const specReadOnly = z
  .object({
    reason: z.string(),
    paths: z.array(z.string()),
    verb: z.string().nullable(),
  })
  .passthrough();

export const specSchemaView = z
  .object({
    harness: harnessId,
    present: z.boolean(),
    note: z.string().nullable(),
    verb: z.string().nullable(),
    specName: z.string(),
    target: z.string().nullable(),
    schema: z.record(z.unknown()).nullable(),
    schemaSource: z.enum(["harness", "manager"]),
    schemaVersion: z.string().nullable(),
    schemaNote: z.string().nullable(),
    effective: z.array(specEffectiveRow),
    effectiveTruncated: z.boolean(),
    effectiveNote: z.string().nullable(),
    declaredCount: count,
    defaultedCount: count,
    issues: z.array(specSchemaIssue),
    rev: z.string(),
    readOnly: specReadOnly.nullable(),
    truncated: z.boolean(),
  })
  .passthrough();

export const CREATION_SCHEMAS = { specSchemaView } as const;
