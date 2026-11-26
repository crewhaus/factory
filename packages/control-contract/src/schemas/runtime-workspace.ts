/**
 * The runtime area's workspace schemas: a steward's work delivered as a pull request.
 * Responses pass unknown fields through. `runtime.type-checks.ts` holds each one to its
 * type in the main entry. No field here is named like a credential: the masker would
 * hide it from every reader.
 */
import { z } from "zod";
import {
  WORKSPACE_STATES,
  WORK_ACCEPTANCE_VERDICTS,
  WORK_CHECK_VERDICTS,
  WORK_PR_REVIEWS,
  WORK_PR_STATES,
  WORK_PUBLISH_CODES,
  WORK_PUBLISH_STATES,
  WORK_PUBLISH_WHYS,
} from "../index.js";
import { commandReceipt, listEnvelope } from "./core.js";

function oneOf<const T extends readonly [string, ...string[]]>(list: T) {
  return z.enum(list as unknown as [T[number], ...T[number][]]);
}

const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected a timestamp");
const count = z.number().int().nonnegative();

export const workPublishVerdict = z
  .object({
    checks: oneOf(WORK_CHECK_VERDICTS),
    acceptance: oneOf(WORK_ACCEPTANCE_VERDICTS),
    sha: z.string(),
  })
  .passthrough();

export const workPublishView = z
  .object({
    id: z.string(),
    attempt: z.number().int().positive(),
    state: oneOf(WORK_PUBLISH_STATES),
    at: timestamp,
    branch: z.string().optional(),
    baseSha: z.string().optional(),
    headSha: z.string().optional(),
    pushedSha: z.string().optional(),
    pr: z.number().int().positive().optional(),
    code: oneOf(WORK_PUBLISH_CODES).optional(),
    why: oneOf(WORK_PUBLISH_WHYS).optional(),
    files: count.optional(),
    lines: count.optional(),
    verdict: workPublishVerdict.optional(),
    rebased: z.literal(true).optional(),
  })
  .passthrough();

export const workPrView = z
  .object({
    pr: z.number().int().positive(),
    state: oneOf(WORK_PR_STATES),
    at: timestamp,
    review: oneOf(WORK_PR_REVIEWS).optional(),
    url: z.string().optional(),
    changed: z.literal(true).optional(),
    reverted: z.literal(true).optional(),
  })
  .passthrough();

export const workspaceCheckView = z
  .object({ name: z.string(), exit: z.number().int(), passed: z.boolean() })
  .passthrough();

export const workspaceSummary = z
  .object({
    work: z.string(),
    binding: z.string(),
    branch: z.string(),
    state: oneOf(WORKSPACE_STATES),
    baseSha: z.string().optional(),
    publish: oneOf(WORK_PUBLISH_STATES).optional(),
    pr: z.number().int().positive().optional(),
    prState: oneOf(WORK_PR_STATES).optional(),
    outcome: workPrView.optional(),
  })
  .passthrough();

export const workspaceView = workspaceSummary
  .extend({
    headSha: z.string().optional(),
    wip: z.boolean().optional(),
    declared: z.array(z.string()).optional(),
    checks: z.array(workspaceCheckView).optional(),
    attempts: z.array(workPublishView),
    reasons: z.string().optional(),
    logs: z.array(z.object({ name: z.string(), text: z.string() }).passthrough()).optional(),
    hidden: z.array(z.literal("content")).optional(),
  })
  .passthrough();

export const workspaceList = listEnvelope.extend({ items: z.array(workspaceSummary) });

export const workspaceAnswer = z.object({ workspace: workspaceView }).passthrough();

export const workPublishAnswer = z
  .object({
    receipt: commandReceipt,
    attempt: workPublishView.optional(),
    problem: z.string().optional(),
  })
  .passthrough();

export const WORKSPACE_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  workPrView,
  workPublishAnswer,
  workPublishVerdict,
  workPublishView,
  workspaceAnswer,
  workspaceCheckView,
  workspaceList,
  workspaceSummary,
  workspaceView,
};
