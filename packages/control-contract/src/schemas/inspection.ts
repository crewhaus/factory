/**
 * The inspection area's zod schemas. Requests are strict; responses pass unknown fields
 * through, and pin only the fields a view dereferences: the folds' own records travel as
 * they are. `inspection.type-checks.ts` holds each one to its type.
 */
import { z } from "zod";
import { INSPECT_GAP_REASONS, type InspectGapReason, TIMELINE_VIEWS } from "../areas/inspection.js";

/** An entry id: `s:`, `d:`, `x:` or `g:` and what follows, never a flag. */
const entryId = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[sdxg]:[A-Za-z0-9:._-]+$/);

const view = z.enum(TIMELINE_VIEWS as unknown as ["key", "full"]);

export const inspectTimelineQuery = z
  .object({
    view: view.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    before: entryId.optional(),
    after: entryId.optional(),
  })
  .strict();

export const inspectRawQuery = z.object({ before: entryId.optional() }).strict();

const loose = z.object({}).passthrough();

const gap = z
  .object({
    reason: z.enum(INSPECT_GAP_REASONS as unknown as [InspectGapReason, ...InspectGapReason[]]),
    from: entryId.optional(),
    to: entryId.optional(),
    count: z.number().int().min(0).optional(),
    remedy: z.string().optional(),
  })
  .passthrough();

const gaps = z.array(gap);

const hidden = z.array(z.literal("content")).optional();

export const inspectSummary = z
  .object({
    subject: loose,
    status: loose,
    trigger: loose,
    cost: loose,
    gaps,
    hidden,
  })
  .passthrough();

const timelineEntry = z
  .object({
    id: z.string(),
    at: z.string(),
    kind: z.string(),
    group: z.string(),
    importance: z.enum(["key", "detail"]),
    title: z.string(),
  })
  .passthrough();

export const inspectTimeline = z
  .object({
    entries: z.array(timelineEntry),
    gaps,
    next: z.string().optional(),
    truncated: z.boolean(),
    empty: z.enum(["filtered", "no-data"]).optional(),
    view,
    hidden,
  })
  .passthrough();

export const inspectWhy = z
  .object({
    action: z.string(),
    kind: z.string(),
    span: z.string(),
    started: loose,
    used: loose,
    rules: loose,
    did: loose,
    options: loose,
    checks: loose,
    result: loose,
    gaps,
  })
  .passthrough();

export const inspectContext = z.object({ calls: z.array(loose), gaps }).passthrough();

export const inspectRequest = z
  .object({
    present: z.boolean(),
    note: z.string(),
    verb: z.string().nullable(),
    receipt: loose.optional(),
    input: z
      .object({ source: z.enum(["input-file", "reconstructed"]), text: z.string() })
      .passthrough()
      .nullable()
      .optional(),
    hidden,
  })
  .passthrough();

export const inspectExport = z
  .object({
    v: z.literal(1),
    run: z.string(),
    summary: loose,
    timeline: z.array(loose),
    why: z.literal(null),
    gaps,
    truncated: z.boolean(),
  })
  .passthrough();

const rawAnnotation = z
  .object({
    id: z.string(),
    path: z.array(z.union([z.string(), z.number()])),
    label: z.enum(["thinking", "redacted-thinking"]),
  })
  .passthrough();

export const inspectRaw = z
  .object({
    entries: z.array(z.object({ id: z.string(), line: loose }).passthrough()),
    annotations: z.array(rawAnnotation),
    next: z.string().optional(),
    truncated: z.boolean(),
    gaps,
  })
  .passthrough();

export const inspectSession = z
  .object({ summary: loose, sessionRuns: z.array(z.string()) })
  .passthrough();

export const inspectWork = z
  .object({
    runs: z.array(loose),
    empty: z
      .object({ reason: z.string(), note: z.string(), verb: z.string().nullable() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const INSPECTION_SCHEMAS = Object.freeze({
  inspectTimelineQuery,
  inspectRawQuery,
  inspectSummary,
  inspectTimeline,
  inspectWhy,
  inspectContext,
  inspectRequest,
  inspectExport,
  inspectRaw,
  inspectSession,
  inspectWork,
});
