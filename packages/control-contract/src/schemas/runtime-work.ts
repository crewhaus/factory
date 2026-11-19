/**
 * The runtime area's work schemas. Requests are strict; responses pass unknown fields
 * through. `runtime.type-checks.ts` holds each one to its type in the main entry.
 *
 * Every free-text request field is bounded: a title is one short line, a goal at most
 * 8 KiB, at most 20 criteria of 500 characters, and an assessment's texts each 2 KiB.
 */
import { z } from "zod";
import {
  CORRECTION_SCOPES,
  DECLINE_REASONS,
  EMPTY_REASONS,
  EVIDENCE_KINDS,
  EVIDENCE_LABELS,
  WORK_BASES,
  WORK_CLOSE_OUTCOMES,
  WORK_DELIVERY_KINDS,
  WORK_EVENTS,
  WORK_FEED_SECTIONS,
  WORK_KINDS,
  WORK_RANK_DIMENSIONS,
  WORK_SOURCE_KINDS,
  WORK_STATES,
  WORK_STATUSES,
} from "../index.js";
import {
  commandReceipt,
  listEnvelope,
  refString,
  storedActor,
  workCreateSpec,
  workItemId,
} from "./core.js";

function oneOf<const T extends readonly [string, ...string[]]>(list: T) {
  return z.enum(list as unknown as [T[number], ...T[number][]]);
}

const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected a timestamp");
const level = z.number().int().min(0).max(3);
const priority = z.number().int().min(1).max(4);
const revision = z.number().int().positive();
const shortText = z.string().min(1).max(2048);
const title = z.string().min(1).max(200);
const goal = z.string().min(1).max(8192);
const acceptance = z.array(z.string().min(1).max(500)).max(20);
const note = z.string().min(1).max(4096);
/** A parent: a work item, or a qualified ref to one. */
const parent = z.union([workItemId, refString]);

export const workEvidence = z
  .object({
    label: oneOf(EVIDENCE_LABELS),
    kind: oneOf(EVIDENCE_KINDS),
    ref: z.string().min(1).max(500).optional(),
    note: shortText,
    observedAt: timestamp.optional(),
    ingestedAt: timestamp.optional(),
  })
  .strict();

export const workAssessment = z
  .object({
    problem: shortText,
    audience: shortText.optional(),
    evidence: z.array(workEvidence).max(50),
    counterEvidence: z.array(workEvidence).max(50),
    intentFit: z
      .object({ supports: shortText.optional(), conflicts: shortText.optional() })
      .strict()
      .optional(),
    outcome: shortText.optional(),
    alternatives: z.array(shortText).max(20).optional(),
    doNothing: shortText.optional(),
    cost: level.optional(),
    upkeep: level.optional(),
    uncertainty: level.optional(),
    reversibility: level.optional(),
    dependencies: z.array(z.string().min(1).max(500)).max(20).optional(),
    measure: shortText.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const workCreateRequest = z
  .object({
    title,
    goal: goal.optional(),
    acceptance: acceptance.optional(),
    kind: oneOf(WORK_KINDS),
    basis: oneOf(WORK_BASES).optional(),
    parent: parent.optional(),
    priority: priority.optional(),
    assessment: workAssessment.optional(),
  })
  .strict();

export const workUpdateRequest = z
  .object({
    expect: revision,
    title: title.optional(),
    goal: goal.optional(),
    acceptance: acceptance.optional(),
    kind: oneOf(WORK_KINDS).optional(),
    basis: oneOf(WORK_BASES).optional(),
    parent: parent.optional(),
    priority: priority.optional(),
    assessment: workAssessment.optional(),
    note: note.optional(),
  })
  .strict();

export const workDeclineRequest = z
  .object({
    reason: oneOf(DECLINE_REASONS),
    note: note.optional(),
    supersededBy: workItemId.optional(),
  })
  .strict();

export const workRankRequest = z
  .object({ below: workItemId, scope: oneOf(CORRECTION_SCOPES) })
  .strict();

/** The sources an item can be adopted from; the head serves the ones it can read. */
export const WORK_ADOPT_SOURCE_RE =
  /^(?:thredz-task:[A-Za-z0-9_][A-Za-z0-9._:-]{0,127}|continuity-goal:goal-\d{4}|github-issue:[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#[1-9]\d{0,9})$/;

export const workAdoptRequest = z
  .object({ source: z.string().max(260).regex(WORK_ADOPT_SOURCE_RE) })
  .strict();

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const dimension = z
  .object({
    name: oneOf(WORK_RANK_DIMENSIONS),
    level: z.number(),
    weight: z.number().optional(),
  })
  .passthrough();

export const workItem = z
  .object({
    id: workItemId,
    state: oneOf(WORK_STATES),
    status: oneOf(WORK_STATUSES),
    statusWord: z.string(),
    title: z.string(),
    kind: oneOf(WORK_KINDS),
    basis: oneOf(WORK_BASES).optional(),
    priority: priority.optional(),
    rev: revision,
    sourceKind: oneOf(WORK_SOURCE_KINDS).optional(),
    parent: z.string().optional(),
    outcome: oneOf(WORK_CLOSE_OUTCOMES).optional(),
    reasonCode: z.string().optional(),
    createdAt: timestamp,
    updatedAt: timestamp,
    position: z.number().int().positive().optional(),
    ranking: z.enum(["priority", "weights"]).optional(),
    dimensions: z.array(dimension).optional(),
    corrected: z
      .object({ scope: oneOf(CORRECTION_SCOPES), by: storedActor, at: timestamp })
      .passthrough()
      .optional(),
    runs: z.array(z.string()),
  })
  .passthrough();

const listTruncated = z.object({ reason: z.string(), verb: z.string().optional() }).passthrough();

/** The shared list envelope, its items work items. */
export const workList = listEnvelope.extend({ items: z.array(workItem) });

const contentView = z
  .object({
    goal: z.string().optional(),
    acceptance: z.array(z.string()).optional(),
    assessment: workAssessment.optional(),
    notes: z
      .array(
        z
          .object({ by: storedActor, at: timestamp, text: z.string(), origin: z.string() })
          .passthrough(),
      )
      .optional(),
    source: z
      .object({
        kind: oneOf(WORK_SOURCE_KINDS),
        ref: z.string().optional(),
        url: z.string().optional(),
      })
      .passthrough()
      .optional(),
    delivered: z
      .array(z.object({ kind: oneOf(WORK_DELIVERY_KINDS), ref: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();

const historyLine = z
  .object({
    at: timestamp,
    event: oneOf(WORK_EVENTS),
    by: storedActor,
    via: z.string().optional(),
    rev: revision.optional(),
    run: z.string().optional(),
    outcome: oneOf(WORK_CLOSE_OUTCOMES).optional(),
    reasonCode: z.string().optional(),
    scope: oneOf(CORRECTION_SCOPES).optional(),
  })
  .passthrough();

export const workItemDetail = z
  .object({
    item: workItem,
    content: contentView.optional(),
    hidden: z.array(z.literal("content")).optional(),
    history: z.array(historyLine),
    truncated: listTruncated.optional(),
  })
  .passthrough();

const feedEmpty = z
  .object({ reason: oneOf(EMPTY_REASONS), remedy: z.string(), verb: z.string().nullable() })
  .passthrough();

const feedEntry = z
  .object({
    kind: z.enum(["item", "run", "runs", "job", "goal", "plan", "task", "schedule"]),
    id: z.string(),
    label: z.string(),
    status: z.string().optional(),
    statusWord: z.string().optional(),
    item: workItem.optional(),
    trigger: z.string().optional(),
    count: z.number().int().nonnegative().optional(),
    runs: z.array(z.string()).optional(),
    progress: z
      .object({
        current: z.number().optional(),
        target: z.number().optional(),
        unit: z.string().optional(),
      })
      .passthrough()
      .optional(),
    steps: z.array(z.object({ title: z.string(), status: z.string() }).passthrough()).optional(),
  })
  .passthrough();

const feedSection = z
  .object({
    items: z.array(feedEntry).optional(),
    truncated: z.boolean().optional(),
    empty: feedEmpty.optional(),
    groups: z
      .array(z.object({ basis: oneOf(WORK_BASES), items: z.array(z.string()) }).passthrough())
      .optional(),
  })
  .passthrough();

export const workFeed = z
  .object({
    freshness: z.literal("direct-fold"),
    at: timestamp,
    sections: z.record(oneOf(WORK_FEED_SECTIONS), feedSection),
    anomalies: z.number().int().nonnegative(),
    tools: z.boolean(),
    hidden: z.array(z.literal("content")).optional(),
  })
  .passthrough();

export const workAnswer = z
  .object({
    receipt: commandReceipt,
    item: workItem.optional(),
    run: z.string().optional(),
  })
  .passthrough();

export { workCreateSpec };

export const WORK_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  workAdoptRequest,
  workAnswer,
  workAssessment,
  workCreateRequest,
  workCreateSpec,
  workDeclineRequest,
  workEvidence,
  workFeed,
  workItem,
  workItemDetail,
  workList,
  workRankRequest,
  workUpdateRequest,
};
