/**
 * The people area's zod schemas. Requests are strict; responses pass unknown fields
 * through. `people.type-checks.ts` holds each one to its type in the main entry.
 *
 * A request field that carries a person's words is listed in its operation's
 * `secretFields`, so a receipt's fingerprint never hashes it.
 */
import { z } from "zod";
import {
  AUDIENCE_BASES,
  AUDIENCE_VARIATIONS,
  AUDIENCE_WHO_MAX,
  CUSTODIAL_BASES,
  ERASURE_RESIDUE,
  NOTE_ACQUISITIONS,
  NOTE_AREA_RE,
  NOTE_CONFIDENCES,
  NOTE_SENSITIVITIES,
  NOTE_SITUATION_MAX,
  NOTE_SOURCES,
  NOTE_TYPES,
  NOTE_VALUE_MAX,
  NOTE_VERDICTS,
  PEOPLE_EXPORT_FORMAT,
  PEOPLE_PURPOSES,
  PERSON_ACTIVITY_EVENTS,
  PERSON_DESCRIBES,
  PERSON_KINDS,
  PERSON_LABEL_MAX,
  VAULT_CUSTODIES,
} from "../areas/people.js";
import { isId } from "../index.js";
import { listEnvelope, principalId } from "./core.js";

function oneOf<const T extends readonly [string, ...string[]]>(list: T) {
  return z.enum(list as unknown as [T[number], ...T[number][]]);
}

const personId = z.string().refine((id) => isId("psn", id), "expected a psn_ id");
const claimId = z.string().refine((id) => isId("pcl", id), "expected a pcl_ id");
const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected a timestamp");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int().nonnegative();
const revision = z.number().int().positive();
const area = z.string().regex(NOTE_AREA_RE);
const purpose = oneOf(PEOPLE_PURPOSES);
const personKind = oneOf(PERSON_KINDS);
const personRole = z.enum(["owner", "custodian", "viewer"]);
const rowState = z.enum(["active", "erasing"]);
/** The note machine's states; `people.test.ts` holds this list to `MACHINES.personClaim`. */
const claimState = z.enum(["proposed", "active", "rejected", "superseded", "conflicted"]);

// ---------------------------------------------------------------------------
// The vault
// ---------------------------------------------------------------------------

export const peopleSetupRequest = z
  .object({
    custody: oneOf(VAULT_CUSTODIES),
    backupDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();

export const peopleVaultState = z
  .object({
    state: z.enum(["not-set-up", "locked", "ready"]),
    custody: oneOf(VAULT_CUSTODIES).optional(),
    kekVersion: count.optional(),
    backupDays: count.optional(),
    reason: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export const personCreateRequest = z
  .object({
    kind: personKind,
    label: z.string().min(1).max(PERSON_LABEL_MAX),
    describes: oneOf(PERSON_DESCRIBES).optional(),
    basis: z.enum([...CUSTODIAL_BASES, ...AUDIENCE_BASES]).optional(),
    who: z.string().min(1).max(AUDIENCE_WHO_MAX).optional(),
    variation: oneOf(AUDIENCE_VARIATIONS).optional(),
    size: z.number().int().positive().optional(),
  })
  .strict();

export const personUpdateRequest = z
  .object({
    expect: revision,
    label: z.string().min(1).max(PERSON_LABEL_MAX).optional(),
    offLimits: z.array(area).optional(),
    allow: z.array(area).optional(),
    viewers: z.array(principalId).optional(),
    removeViewers: z.array(principalId).optional(),
  })
  .strict();

export const personRow = z
  .object({
    person: personId,
    kind: personKind,
    label: z.string(),
    role: personRole,
    state: rowState,
    rev: count,
  })
  .passthrough();

export const personList = listEnvelope.extend({ items: z.array(personRow) });

export const personView = personRow
  .extend({
    owner: principalId,
    custodian: principalId.optional(),
    describes: oneOf(PERSON_DESCRIBES).optional(),
    basis: oneOf(CUSTODIAL_BASES).optional(),
    audience: z
      .object({
        who: z.string(),
        basis: oneOf(AUDIENCE_BASES),
        size: z.number().int().positive().optional(),
        variation: oneOf(AUDIENCE_VARIATIONS),
      })
      .passthrough()
      .optional(),
    synthetic: z.literal(true).optional(),
    offLimits: z.array(z.string()),
    viewers: z.array(principalId),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const personClaim = z
  .object({
    id: claimId,
    rev: revision,
    person: personId,
    type: oneOf(NOTE_TYPES),
    area: z.string(),
    value: z.string(),
    situation: z.string().optional(),
    source: z.object({ kind: oneOf(NOTE_SOURCES) }).passthrough(),
    acquisition: oneOf(NOTE_ACQUISITIONS),
    confidence: oneOf(NOTE_CONFIDENCES),
    sensitivity: oneOf(NOTE_SENSITIVITIES),
    state: claimState,
    confirmedBy: z.enum(["owner", "auto"]).optional(),
    reviewBy: day.optional(),
    purposes: z.array(purpose),
    mergedInto: claimId.optional(),
    createdBy: z.object({ actor: principalId, via: z.string() }).passthrough(),
    createdAt: timestamp,
    at: timestamp,
  })
  .passthrough();

export const personClaimList = listEnvelope.extend({ items: z.array(personClaim) });

export const claimCreateRequest = z
  .object({
    area,
    value: z.string().min(1).max(NOTE_VALUE_MAX),
    situation: z.string().min(1).max(NOTE_SITUATION_MAX).optional(),
    type: oneOf(NOTE_TYPES).optional(),
    purposes: z.array(purpose).min(1).optional(),
    sensitivity: oneOf(NOTE_SENSITIVITIES).optional(),
    confidence: oneOf(NOTE_CONFIDENCES).optional(),
    reviewBy: day.optional(),
    acquisition: oneOf(NOTE_ACQUISITIONS).optional(),
  })
  .strict();

export const claimReviseRequest = z
  .object({
    expect: revision,
    value: z.string().min(1).max(NOTE_VALUE_MAX),
    situation: z.string().min(1).max(NOTE_SITUATION_MAX).optional(),
  })
  .strict();

export const claimReviewRequest = z
  .object({
    verdict: oneOf(NOTE_VERDICTS),
    purposes: z.array(purpose).min(1).optional(),
    into: claimId.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Export, activity and erasure
// ---------------------------------------------------------------------------

export const exportRequest = z
  .object({
    areas: z.array(area).optional(),
    purposes: z.array(purpose).optional(),
    includeSensitive: z.boolean().optional(),
    includeRejected: z.boolean().optional(),
    summary: z.boolean().optional(),
  })
  .strict();

export const exportPreview = z
  .object({
    format: z.literal(PEOPLE_EXPORT_FORMAT),
    counts: z
      .object({ notes: count, rejected: count, masked: count, leftOut: count })
      .passthrough(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: count,
  })
  .passthrough();

export const personActivityRow = z
  .object({
    at: timestamp,
    actor: principalId,
    event: oneOf(PERSON_ACTIVITY_EVENTS),
    counts: z.record(count),
  })
  .passthrough();

export const personActivityList = listEnvelope.extend({ items: z.array(personActivityRow) });

export const erasurePlan = z
  .object({
    person: personId,
    counts: z
      .object({ notes: count, revisions: count, rejected: count, exports: count })
      .passthrough(),
    residue: z.array(
      z
        .object({ code: oneOf(ERASURE_RESIDUE), until: day.optional(), at: timestamp.optional() })
        .passthrough(),
    ),
    nonce: z.string(),
    expiresAt: timestamp,
  })
  .passthrough();

export const erasureRunRequest = z
  .object({
    nonce: z.string().min(1).max(200),
    confirm: z.string().min(1).max(PERSON_LABEL_MAX),
  })
  .strict();

export const PEOPLE_SCHEMAS = {
  claimCreateRequest,
  claimReviewRequest,
  claimReviseRequest,
  erasurePlan,
  erasureRunRequest,
  exportPreview,
  exportRequest,
  peopleSetupRequest,
  peopleVaultState,
  personActivityList,
  personActivityRow,
  personClaim,
  personClaimList,
  personCreateRequest,
  personList,
  personRow,
  personUpdateRequest,
  personView,
} as const;
