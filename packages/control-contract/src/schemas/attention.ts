/**
 * The attention area's zod schemas. Queries are strict; responses pass unknown fields
 * through. `attention.type-checks.ts` holds each one to its type in the main entry.
 *
 * No field is named like a credential and nothing is keyed by a kind: Home masks every
 * answer by key name, so a breakdown is an array of rows.
 */
import { z } from "zod";
import {
  ATTENTION_BANDS,
  ATTENTION_KINDS,
  ATTENTION_RESOLUTIONS,
  ATTENTION_SOURCE_KINDS,
  ATTENTION_STATES,
  CAUSE_KINDS,
  DECISION_CLASSES,
  PAGE_LIMIT_MAX,
} from "../index.js";
import { cursorString, harnessId, listEnvelope } from "./core.js";

function oneOf<T extends string>(list: readonly T[]) {
  return z.enum(list as unknown as [T, ...T[]]);
}

const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected a timestamp");
const count = z.number().int().nonnegative();
const percentile = z.number().nonnegative().nullable();
const attentionRef = z.string().regex(/^home\/attention\/att_[0-9a-hjkmnp-tv-z]{26}$/);
/** A harness by its id or its name: never free text. */
const harnessName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/);

const text = z
  .object({
    template: z.string().min(1),
    params: z.record(z.union([z.string(), z.number()])),
  })
  .passthrough();

const evidence = z.object({ kind: z.string(), ref: z.string(), label: z.string() }).passthrough();

const choice = z
  .object({
    id: z.string().min(1),
    needs: oneOf(DECISION_CLASSES),
    cliTwin: z.string().nullable(),
    nullReason: z.string().optional(),
  })
  .passthrough();

const freshness = z
  .object({
    asOf: timestamp,
    mode: z.enum(["projection", "direct-fold"]),
    stale: z.boolean().optional(),
    note: z.string().optional(),
  })
  .passthrough();

export const attentionItem = z
  .object({
    ref: attentionRef,
    kind: oneOf(ATTENTION_KINDS),
    band: oneOf(ATTENTION_BANDS),
    harness: harnessId.optional(),
    harnesses: z.array(harnessId).optional(),
    source: z.object({ kind: oneOf(ATTENTION_SOURCE_KINDS), id: z.string() }).passthrough(),
    title: text,
    whyNow: text,
    affected: z.object({ runs: z.array(z.string()).max(50), count }).passthrough(),
    evidence: z.array(evidence),
    choices: z.array(choice),
    recommendation: z.object({ choiceId: z.string(), reason: text }).passthrough().optional(),
    deadline: z
      .object({ at: timestamp, source: z.enum(["agreement", "ttl"]) })
      .passthrough()
      .optional(),
    ifUnanswered: z.object({ template: z.string() }).passthrough().optional(),
    requiredClass: oneOf(DECISION_CLASSES),
    state: oneOf(ATTENTION_STATES),
    resolution: z
      .object({ how: oneOf(ATTENTION_RESOLUTIONS), at: timestamp, via: z.string().optional() })
      .passthrough()
      .optional(),
    cause: z
      .object({ id: z.string().min(1), kind: oneOf(CAUSE_KINDS), label: z.string() })
      .passthrough()
      .optional(),
    binding: z.object({ digestPrefix: z.string() }).passthrough().optional(),
    evidenceRev: z.string().regex(/^[0-9a-f]{16}$/),
    since: timestamp,
    asks: z.object({ count, refusedAt: timestamp.optional() }).passthrough().optional(),
    previous: attentionRef.optional(),
    body: z.unknown(),
    bodyWithheld: z.literal(true).optional(),
    sensitivity: z.literal("people").optional(),
    freshness,
  })
  .passthrough();

export const attentionList = listEnvelope.extend({
  items: z.array(attentionItem),
  advisorUnchecked: z.array(harnessId).optional(),
  names: z.array(z.object({ id: harnessId, name: z.string() }).passthrough()).optional(),
});

export const attentionListQuery = z
  .object({
    harness: harnessName.optional(),
    kind: oneOf(ATTENTION_KINDS).optional(),
    band: oneOf(ATTENTION_BANDS).optional(),
    state: z.enum(["open", "all"]).optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).optional(),
    cursor: cursorString.optional(),
  })
  .strict();

export const attentionMetricsQuery = z
  .object({
    harness: harnessName.optional(),
    since: z
      .string()
      .regex(/^[1-9][0-9]{0,4}[dhm]$/)
      .optional(),
  })
  .strict();

const openRow = z
  .object({ kind: z.string(), open: count, p50Ms: percentile, p90Ms: percentile })
  .passthrough();
const resolutionRow = z
  .object({ kind: z.string(), resolved: count, p50Ms: percentile, p90Ms: percentile })
  .passthrough();
const viaRow = z
  .object({ decidedVia: z.string(), resolved: count, p50Ms: percentile, p90Ms: percentile })
  .passthrough();

export const attentionMetrics = z
  .object({
    since: timestamp,
    asOf: timestamp,
    harnesses: count,
    open: z.array(openRow),
    resolution: z.array(resolutionRow),
    resolutionByVia: z.array(viaRow),
    fallbacks: count,
    reasks: count,
    unreachable: z.array(harnessId).optional(),
  })
  .passthrough();

export const ATTENTION_SCHEMAS = {
  attentionItem,
  attentionList,
  attentionListQuery,
  attentionMetrics,
  attentionMetricsQuery,
} as const;
