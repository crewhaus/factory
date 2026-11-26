/**
 * The attention area's zod schemas. Queries are strict; responses pass unknown fields
 * through. `attention.type-checks.ts` holds each one to its type in the main entry.
 *
 * No field is named like a credential and nothing is keyed by a kind: Home masks every
 * answer by key name, so a breakdown is an array of rows.
 */
import { z } from "zod";
import {
  ATTENTION_ACTION_EVENTS,
  ATTENTION_ACT_CHOICES,
  ATTENTION_BANDS,
  ATTENTION_JOBS,
  ATTENTION_KINDS,
  ATTENTION_MESSAGE_MAX_BYTES,
  ATTENTION_NOTE_MAX_BYTES,
  ATTENTION_PLACES,
  ATTENTION_RESOLUTIONS,
  ATTENTION_SOURCE_KINDS,
  ATTENTION_STATES,
  CAUSE_KINDS,
  DECISION_CLASSES,
  DEFER_REASONS,
  DISMISS_REASONS,
  EMPTY_REASONS,
  PAGE_LIMIT_MAX,
  RECEIPT_VIA,
  isPermission,
} from "../index.js";
import { commandReceipt, cursorString, harnessId, listEnvelope, storedActor } from "./core.js";

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
    permission: z.string().optional(),
    job: oneOf(ATTENTION_JOBS).optional(),
    place: oneOf(ATTENTION_PLACES).optional(),
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
    assignee: storedActor.optional(),
    deferral: z
      .object({
        until: timestamp,
        reasonCode: oneOf(DEFER_REASONS).optional(),
        deadlineMoved: z.boolean(),
      })
      .passthrough()
      .optional(),
    snoozedUntil: timestamp.optional(),
    previously: z
      .object({
        how: oneOf(ATTENTION_RESOLUTIONS),
        at: timestamp,
        evidenceRev: z.string().regex(/^[0-9a-f]{16}$/),
      })
      .passthrough()
      .optional(),
    anomalies: count.optional(),
    freshness,
  })
  .passthrough();

/** A person an answer names: the id it carries, and the name to show for it. */
const person = z.object({ id: storedActor, name: z.string().min(1) }).passthrough();

export const attentionList = listEnvelope.extend({
  items: z.array(attentionItem),
  advisorUnchecked: z.array(harnessId).optional(),
  names: z.array(z.object({ id: harnessId, name: z.string() }).passthrough()).optional(),
  people: z.array(person).optional(),
  you: z
    .array(
      z
        .object({
          harness: harnessId,
          act: z.boolean(),
          class: oneOf(DECISION_CLASSES).nullable(),
          content: z.boolean(),
          can: z.array(
            z.string().refine((id): boolean => isPermission(id), "expected a permission"),
          ),
        })
        .passthrough(),
    )
    .optional(),
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

// ---------------------------------------------------------------------------
// What a person does about an item
// ---------------------------------------------------------------------------

/** A person's own words beside a verdict. The writer counts its bytes, not its characters. */
const note = z.string().min(1).max(ATTENTION_NOTE_MAX_BYTES);

export const attentionResolveRequest = z
  .object({
    choice: z
      .string()
      .refine((value) => ATTENTION_ACT_CHOICES.includes(value), "not a choice an item offers"),
    expect: z.string().min(1).max(64).optional(),
    note: note.optional(),
  })
  .strict();

export const attentionAssignRequest = z
  .object({ to: z.string().regex(/^prn_[0-9a-hjkmnp-tv-z]{26}$/) })
  .strict();

export const attentionDeferRequest = z
  .object({ until: timestamp, reason: oneOf(DEFER_REASONS) })
  .strict();

export const attentionSnoozeRequest = z.object({ harness: harnessName, until: timestamp }).strict();

export const attentionDismissRequest = z
  .object({ reasonCode: oneOf(DISMISS_REASONS), note: note.optional() })
  .strict();

export const attentionNoteRequest = z.object({ note: note.optional() }).strict();

export const attentionMessageRequest = z
  .object({ text: z.string().min(1).max(ATTENTION_MESSAGE_MAX_BYTES) })
  .strict();

export const attentionActed = z
  .object({
    receipt: commandReceipt,
    ref: attentionRef,
    harness: harnessId,
    event: oneOf(ATTENTION_ACTION_EVENTS),
    state: oneOf(ATTENTION_STATES),
    detail: z.string().optional(),
    job: z.string().optional(),
  })
  .passthrough();

export const attentionMessages = z
  .object({
    ref: attentionRef,
    items: z.array(
      z.object({ at: timestamp, by: storedActor, via: z.string(), text: z.string() }).passthrough(),
    ),
    people: z.array(person).optional(),
    truncated: z
      .object({ reason: z.string(), verb: z.string().optional() })
      .passthrough()
      .optional(),
    empty: z
      .object({ reason: oneOf(EMPTY_REASONS), remedy: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const ATTENTION_SCHEMAS = {
  attentionActed,
  attentionAssignRequest,
  attentionDeferRequest,
  attentionDismissRequest,
  attentionItem,
  attentionList,
  attentionListQuery,
  attentionMessageRequest,
  attentionMessages,
  attentionMetrics,
  attentionMetricsQuery,
  attentionNoteRequest,
  attentionResolveRequest,
  attentionSnoozeRequest,
} as const;
