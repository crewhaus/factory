/**
 * The delegation area's zod schemas. Requests are strict; responses pass unknown fields
 * through. `delegation.type-checks.ts` holds each one to its type in the main entry.
 *
 * A request carries terms (days, a use cap and the action's own named fields), a digest
 * and a name to confirm: nothing a model writes, and nothing a receipt's fingerprint
 * must leave out.
 */
import { z } from "zod";
import {
  DELEGATION_ACTIONS,
  DELEGATION_LOG_EVENTS,
  DELEGATION_RULE_REASONS,
  DELEGATION_RULE_STATES,
  SUSPEND_REASONS,
} from "../index.js";
import { commandReceipt, cursorString, decisionId, ruleId } from "./core.js";

function oneOf<const T extends readonly [string, ...string[]]>(list: T) {
  return z.enum(list as unknown as [T[number], ...T[number][]]);
}

const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected a timestamp");
const count = z.number().int().nonnegative();
const revision = z.number().int().positive();
const action = oneOf(DELEGATION_ACTIONS);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const scopeValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

/** Terms as a request offers them: every part optional; the service applies defaults. */
const termsRequest = z
  .object({
    days: z.number().int().min(1).max(90).optional(),
    maxUses: z.number().int().min(1).max(10_000).optional(),
    scope: z.record(scopeValue).optional(),
  })
  .strict();

const terms = z
  .object({
    days: z.number().int().min(1).max(90),
    maxUses: z.number().int().positive().optional(),
    scope: z.record(scopeValue).optional(),
  })
  .passthrough();

const truncated = z.object({ reason: z.string(), verb: z.string().optional() }).passthrough();

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const delegationRuleView = z
  .object({
    id: ruleId,
    action,
    state: z.enum(["active", "suspended", "revoked", "expired", "exhausted"]),
    revision,
    label: z.string(),
    endsAt: timestamp,
    uses: count,
    maxUses: z.number().int().positive().optional(),
    lastAction: z
      .object({
        at: timestamp,
        decision: decisionId.optional(),
        cmd: z.string().optional(),
      })
      .passthrough()
      .optional(),
    suspendedReason: oneOf(SUSPEND_REASONS).optional(),
  })
  .passthrough();

export const delegationList = z
  .object({
    items: z.array(delegationRuleView),
    next: cursorString.optional(),
    snapshotAt: cursorString,
    truncated: truncated.optional(),
    empty: z
      .object({
        reason: z.enum(["not-allowed", "no-data", "unreadable"]),
        remedy: z.string().optional(),
        verb: z.string().optional(),
      })
      .passthrough()
      .optional(),
    unreadable: z.array(z.string()).optional(),
    ceiling: z.object({ present: z.boolean(), maxDays: count.optional() }).passthrough(),
    offers: z.array(z.object({ action, label: z.string(), verb: z.string() }).passthrough()),
    proposals: z.array(
      z
        .object({
          id: decisionId,
          action,
          days: count,
          createdAt: timestamp,
          expiresAt: timestamp,
          verb: z.string(),
        })
        .passthrough(),
    ),
    note: z.string(),
    you: z
      .object({ manage: z.boolean(), propose: z.boolean(), suspend: z.boolean() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const delegationDetail = z
  .object({
    rule: delegationRuleView,
    terms,
    revisions: z.array(
      z
        .object({
          revision,
          state: oneOf(DELEGATION_RULE_STATES),
          at: timestamp,
          days: count,
          reason: oneOf(DELEGATION_RULE_REASONS).optional(),
        })
        .passthrough(),
    ),
    log: z.array(
      z
        .object({
          at: timestamp,
          event: oneOf(DELEGATION_LOG_EVENTS),
          revision: count,
          decision: decisionId.optional(),
          cmd: z.string().optional(),
          reason: z.string().optional(),
          gates: z
            .array(z.object({ gate: z.string(), outcome: z.string() }).passthrough())
            .optional(),
          decidedByText: z.string().optional(),
        })
        .passthrough(),
    ),
    truncated: truncated.optional(),
  })
  .passthrough();

export const delegationPage = z
  .object({
    action,
    title: z.string(),
    sections: z.array(
      z.object({ id: z.string(), heading: z.string(), lines: z.array(z.string()) }).passthrough(),
    ),
    text: z.string(),
    consequencesDigest: digest.optional(),
    note: z.string().optional(),
    confirmName: z.string(),
    verb: z.string(),
  })
  .passthrough();

export const delegationAnswer = z
  .object({
    receipt: commandReceipt,
    rule: delegationRuleView.optional(),
    proposal: decisionId.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export const delegationPreviewRequest = z
  .object({
    action,
    terms: termsRequest.optional(),
    rule: ruleId.optional(),
    mode: z.enum(["change", "resume"]).optional(),
  })
  .strict();

export const delegationEnableRequest = z
  .object({
    action,
    terms: termsRequest.optional(),
    consequencesDigest: digest,
    confirm: z.string().min(1).max(64),
    proposal: decisionId.optional(),
  })
  .strict();

export const delegationProposeRequest = z
  .object({ action, terms: termsRequest.optional() })
  .strict();

export const delegationUpdateRequest = z
  .object({
    expect: revision,
    terms: termsRequest.optional(),
    consequencesDigest: digest,
    confirm: z.string().min(1).max(64),
  })
  .strict();

export const delegationResumeRequest = z
  .object({
    expect: revision,
    consequencesDigest: digest,
    confirm: z.string().min(1).max(64),
  })
  .strict();

export const delegationRevokeRequest = z.object({ expect: revision.optional() }).strict();

export const delegationPauseRequest = z
  .object({ reason: z.literal("paused-by-member").optional() })
  .strict();

export const DELEGATION_SCHEMAS = {
  delegationAnswer,
  delegationDetail,
  delegationEnableRequest,
  delegationList,
  delegationPage,
  delegationPauseRequest,
  delegationPreviewRequest,
  delegationProposeRequest,
  delegationResumeRequest,
  delegationRevokeRequest,
  delegationRuleView,
  delegationUpdateRequest,
} as const;
