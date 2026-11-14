/**
 * The core's zod schemas, one per shape. Requests are strict: an unknown field is
 * refused. Responses pass unknown fields through, because they only ever gain
 * fields. `type-checks.ts` holds each schema to its type in the main entry.
 */
import { z } from "zod";
import {
  APPROVAL_ID_RE,
  CANONICAL_RUN_ID_RE,
  CAPABILITY_NAMES,
  type CommandState,
  DECISION_CLASSES,
  DECISION_LOG_REASONS,
  DELEGABLE_DECISION_KINDS,
  type DecisionState,
  type DeferReason,
  type DeploymentState,
  EMPTY_REASONS,
  ERROR_CODES,
  type EventType,
  HARNESS_DISPLAY_STATES,
  HARNESS_ID_RE,
  IF_UNANSWERED,
  LINK_PROVIDERS,
  MACHINES,
  OPERATOR_SUPERSEDE_REASONS,
  PAGE_LIMIT_MAX,
  PROTOCOL_ID,
  QUALIFIERS,
  RECEIPT_AUTHORITY_KINDS,
  RECEIPT_VIA,
  REF_MAX_LENGTH,
  ROLES,
  RUN_CAUSE_KINDS,
  type RunState,
  SCOPED_ACTS,
  SESSION_ID_RE,
  type SupersedeReason,
  TRIGGER_KINDS,
  classifyRunId,
  isCommandKind,
  isCursor,
  isEventType,
  isGrantScope,
  isId,
  isLaneId,
  isPermission,
  isRef,
  isStoredActor,
  parseLinkSubject,
  parseResumeScope,
} from "../index.js";

/** `z.enum` over one of the contract's frozen lists. */
function oneOf<const T extends readonly [string, ...string[]]>(list: T) {
  return z.enum(list as unknown as [T[number], ...T[number][]]);
}

function asTuple<T extends string>(list: readonly T[]): readonly [T, ...T[]] {
  return list as unknown as readonly [T, ...T[]];
}

// ---------------------------------------------------------------------------
// Refined leaves
// ---------------------------------------------------------------------------

const prefixedId = (prefix: string) =>
  z.string().refine((id) => isId(prefix, id), `expected a ${prefix}_ id`);

export const harnessId = z.string().regex(HARNESS_ID_RE);
export const sessionId = z.string().regex(SESSION_ID_RE);
export const canonicalRunId = z.string().regex(CANONICAL_RUN_ID_RE);
export const deploymentId = prefixedId("dep");
export const commandId = prefixedId("cmd");
export const ruleId = prefixedId("rule");
export const principalId = prefixedId("prn");
export const grantId = prefixedId("grt");
export const inviteId = prefixedId("inv");
export const credentialId = prefixedId("crd");
export const linkId = prefixedId("lnk");
export const deviceId = prefixedId("dev");
export const workItemId = prefixedId("wi");

/** A run a row can name: canonical, or a legacy trace or managed id. Never `run_channel`. */
export const runRowId = z
  .string()
  .refine((id) => classifyRunId(id).refKinds.includes("run"), "expected a run id");

export const decisionId = z
  .string()
  .refine((id) => APPROVAL_ID_RE.test(id) || isId("dec", id), "expected an appr_ or dec_ id");

export const refString = z.string().refine(isRef, "expected a ref");

/** An actor as a record holds it: never a raw `local:` id. */
export const storedActor = z.string().refine(isStoredActor, "expected a stored actor");

export const cursorString = z.string().refine(isCursor, "expected a cursor");

const timestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected a timestamp");

const resumeScope = z
  .string()
  .refine((value) => parseResumeScope(value) !== null, "expected a resume scope");

const laneId = z.string().refine(isLaneId, "expected a lane id");

const grantScope = z.string().refine(isGrantScope, "expected a grant scope");

/** A readable subject an API caller may name. A local subject is linked only at first boot. */
const externalSubject = z.string().refine((value) => {
  const provider = parseLinkSubject(value);
  return provider !== null && provider !== "local";
}, "expected a slack, github or proxy subject");

/** A keyed digest, so an append-only record never holds the person it names. */
const subjectDigest = z.string().regex(/^[0-9a-f]{64}$/);

const permissionId = z.string().refine(isPermission, "expected a permission");

const count = z.number().int().nonnegative();

const roleName = oneOf(ROLES);
const decisionClass = oneOf(DECISION_CLASSES);
const decisionChoice = z.enum(["grant", "deny"]);
const sensitivityName = z.enum(["internal", "restricted", "people"]);

const runState = oneOf(asTuple(MACHINES.run.states as readonly RunState[]));
const commandState = oneOf(asTuple(MACHINES.command.states as readonly CommandState[]));
const decisionState = oneOf(asTuple(MACHINES.decision.states as readonly DecisionState[]));
const deploymentState = oneOf(asTuple(MACHINES.deployment.states as readonly DeploymentState[]));

// ---------------------------------------------------------------------------
// Sealed issuance
// ---------------------------------------------------------------------------

/** One P-256 coordinate, base64url. */
const jwkCoordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const seal = z
  .object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: jwkCoordinate, y: jwkCoordinate })
  .strict();

export const deviceJwk = z
  .object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: jwkCoordinate, y: jwkCoordinate })
  .strict();

const hexValue = z.string().regex(/^(?:[0-9a-f]{2})+$/);

export const issued = z
  .object({ alg: z.literal("ECDH-ES+A256GCM"), epk: hexValue, iv: hexValue, ct: hexValue })
  .passthrough();

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export const errorEnvelope = z
  .object({
    error: z
      .object({
        code: oneOf(asTuple(Object.keys(ERROR_CODES) as (keyof typeof ERROR_CODES)[])),
        message: z.string(),
        retryable: z.boolean(),
        retryAfterMs: count.optional(),
        current: z.unknown(),
        needs: z.string().optional(),
        role: z.string().optional(),
        verb: z.string().optional(),
        reason: z.string().optional(),
        remedy: z.string().optional(),
        details: z.record(z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const listTruncated = z.object({ reason: z.string(), verb: z.string().optional() }).passthrough();

const listEmpty = z
  .object({ reason: oneOf(EMPTY_REASONS), remedy: z.string().optional() })
  .passthrough();

function listOf<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      items: z.array(item),
      next: cursorString.optional(),
      snapshotAt: cursorString,
      truncated: listTruncated.optional(),
      empty: listEmpty.optional(),
    })
    .passthrough();
}

/** The list envelope over any row; each list schema below names its own. */
export const listEnvelope = listOf(z.unknown());

export const noBody = z.undefined();

export const emptyRequest = z.object({}).strict();

export const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).optional(),
    cursor: cursorString.optional(),
  })
  .strict();

export const streamQuery = z.object({ after: cursorString.optional() }).strict();

// ---------------------------------------------------------------------------
// Runs and receipts
// ---------------------------------------------------------------------------

export const triggerSource = z
  .object({
    platform: z.string(),
    conversationRef: z.string(),
    messageRef: z.string(),
    senderRef: z.string().optional(),
  })
  .passthrough();

export const trigger = z
  .object({
    kind: oneOf(TRIGGER_KINDS),
    lane: laneId.optional(),
    via: oneOf(RECEIPT_VIA).optional(),
    workItem: workItemId.optional(),
    synthetic: z.literal(true).optional(),
    source: triggerSource.optional(),
  })
  .passthrough();

export const runCause = z.object({ kind: oneOf(RUN_CAUSE_KINDS), ref: z.string() }).passthrough();

export const runCost = z.object({ usdMicros: count.nullable(), unpriced: count }).passthrough();

export const run = z
  .object({
    id: runRowId,
    harness: harnessId.optional(),
    state: runState,
    trigger,
    at: timestamp.optional(),
    execution: z.string().optional(),
    deployment: deploymentId.optional(),
    session: z.string().optional(),
    parent: z.string().optional(),
    continues: z.string().optional(),
    continuedIn: z.string().optional(),
    attemptOf: z.string().optional(),
    resumeScope: resumeScope.optional(),
    mode: z.string().optional(),
    subjectRef: subjectDigest.optional(),
    decision: decisionId.optional(),
    failureClass: z.string().optional(),
    cost: runCost.optional(),
    workItem: workItemId.optional(),
    sessionAt: count.optional(),
    cause: runCause.optional(),
    by: storedActor.optional(),
    tenant: z.string().min(1).optional(),
  })
  .passthrough();

export const commandReceipt = z
  .object({
    id: commandId,
    v: z.literal(1),
    kind: z.string().refine((kind) => isCommandKind(kind), "unknown command kind"),
    target: refString,
    actor: storedActor,
    via: oneOf(RECEIPT_VIA),
    dedupeRef: z.string().optional(),
    fingerprint: z.string(),
    state: commandState,
    acceptedAt: timestamp,
    startedAt: timestamp.optional(),
    endedAt: timestamp.optional(),
    executor: z
      .object({
        pid: count,
        startedAt: timestamp,
        host: z.string(),
        head: z.enum(["server", "resident", "cli"]),
      })
      .passthrough()
      .optional(),
    effects: z.array(
      z
        .object({
          kind: z.string(),
          ref: z.string().optional(),
          status: z.enum(["done", "unknown", "failed", "skipped"]),
          observed: z.string().optional(),
          note: z.string().optional(),
        })
        .passthrough(),
    ),
    outcome: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
    retry: z
      .object({
        retryable: z.boolean(),
        afterMs: count.optional(),
        safety: z.enum(["idempotent", "reconcile-first", "never"]),
      })
      .passthrough(),
    winner: refString.optional(),
    authority: z
      .object({
        kind: oneOf(RECEIPT_AUTHORITY_KINDS),
        rule: ruleId,
        revision: z.number().int().positive(),
        clause: z.literal("rollback").optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

export const commandAccepted = z.object({ receipt: commandReceipt }).passthrough();

export const runCreateRequest = z
  .object({
    input: z.string().min(1),
    subject: z.string().min(1).optional(),
    admission: z.enum(["reject", "queue"]).default("reject"),
    work: refString.optional(),
  })
  .strict();

export const runCreated = z.object({ run, receipt: commandReceipt }).passthrough();

export const runResult = z
  .object({
    run: runRowId,
    state: runState,
    outputRef: z.string().optional(),
    evidenceRefs: z.array(z.string()).optional(),
    evaluationRefs: z.array(z.string()).optional(),
    cost: runCost.optional(),
    inspectionUrl: z.string().optional(),
  })
  .passthrough();

export const runList = listOf(run);
export const commandList = listOf(commandReceipt);

// ---------------------------------------------------------------------------
// Decisions and standing rules
// ---------------------------------------------------------------------------

const decisionPlace = z.object({ path: z.string(), at: z.array(z.string()) }).passthrough();

export const decisionBinding = z
  .object({
    runId: z.string(),
    resumeScope,
    sessionId: z.string(),
    workItem: workItemId.optional(),
    deploymentId: deploymentId.optional(),
    specHash: z.string().optional(),
    placesDigest: z.string(),
    resourceRevision: z.string().optional(),
    resourceRevisionBound: z.boolean(),
  })
  .passthrough();

export const decisionOverlays = z
  .object({ assigned: z.object({ to: storedActor, at: timestamp }).strict().optional() })
  .strict();

const delegationScopeValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

/** A delegation rule's terms: days, an optional use cap and the action's own scope fields. */
export const delegationTerms = z
  .object({
    days: z.number().int().min(1).max(90),
    maxUses: z.number().int().positive().optional(),
    scope: z.record(delegationScopeValue).optional(),
  })
  .strict();

/** A standing-rule proposal's terms; `ruleKind` says which terms follow. */
export const standingRuleTerms = z.union([
  z
    .object({
      ruleKind: z.literal("allow"),
      tool: z.string(),
      pattern: z.string(),
      expiresAt: timestamp,
    })
    .passthrough(),
  z
    .object({
      ruleKind: z.literal("delegate"),
      action: z.string(),
      terms: delegationTerms,
      days: z.number().int().min(1).max(90),
    })
    .passthrough(),
]);

export const decision = z
  .object({
    id: decisionId,
    createdAt: timestamp,
    toolName: z.string().optional(),
    inputHash: z.string().optional(),
    input: z.unknown(),
    places: z.array(decisionPlace).optional(),
    supersedes: z
      .object({
        id: decisionId,
        decision: decisionChoice.optional(),
        places: z.array(decisionPlace).optional(),
      })
      .passthrough()
      .optional(),
    runId: z.string().optional(),
    sessionId: z.string().optional(),
    surface: z.string().optional(),
    decision: decisionChoice.optional(),
    decidedBy: z.string().optional(),
    decidedAt: timestamp.optional(),
    consumedAt: timestamp.optional(),
    consumedByRun: z.string().optional(),
    always: z.boolean().optional(),
    kind: z
      .enum([
        "tool",
        "input",
        "standing-rule-proposal",
        "change-adoption",
        ...DELEGABLE_DECISION_KINDS,
      ])
      .optional(),
    decidedByPrincipal: storedActor.optional(),
    decidedVia: z.string().optional(),
    // A fresh request's id, or the run whose cancel withdrew this one (`run-cancelled`).
    supersededBy: z.union([decisionId, canonicalRunId]).optional(),
    supersededReason: oneOf(
      asTuple(DECISION_LOG_REASONS.supersede as readonly SupersedeReason[]),
    ).optional(),
    expiresAt: timestamp.optional(),
    deferredUntil: timestamp.optional(),
    escalation: z.object({ at: timestamp, toClass: decisionClass }).passthrough().optional(),
    sensitivity: sensitivityName.optional(),
    ifUnanswered: oneOf(IF_UNANSWERED).optional(),
    expiredAt: timestamp.optional(),
    resolvedBy: z.enum(["policy", "delegation"]).optional(),
    delegation: z
      .object({ rule: ruleId, revision: z.number().int().positive() })
      .passthrough()
      .optional(),
    appliedBy: storedActor.optional(),
    actionClass: z.literal("ship").optional(),
    agreementRevision: z.string().optional(),
    requiredClass: decisionClass.optional(),
    binding: decisionBinding.optional(),
    bindingDigest: z.string().optional(),
    askDigest: z.string().optional(),
    state: decisionState,
    overdue: z.boolean().optional(),
    fallback: oneOf(IF_UNANSWERED).optional(),
    assignedTo: storedActor.optional(),
    harness: harnessId.optional(),
    choices: z.array(z.string()).optional(),
    evidenceRefs: z.array(z.string()).optional(),
    terms: standingRuleTerms.optional(),
    proposedBy: storedActor.optional(),
    derivedFrom: decisionId.optional(),
    subject: z
      .union([
        z
          .object({
            chg: z.string().regex(/^chg_[0-9a-hjkmnp-tv-z]{26}$/),
            patchDigest: z.string(),
            baseRevision: z.string(),
            evidenceDigest: z.string(),
          })
          .passthrough(),
        z.object({ ref: refString, revision: z.string().min(1) }).passthrough(),
      ])
      .optional(),
  })
  .passthrough();

export const decisionList = listOf(decision);

export const decisionResolveRequest = z
  .object({
    choice: decisionChoice,
    expect: z.string().min(1).optional(),
    note: z.string().optional(),
  })
  .strict();

export const decisionSupersedeRequest = z
  .object({ reason: oneOf(OPERATOR_SUPERSEDE_REASONS) })
  .strict();

/** Deferring a decision: until when, and why, from the closed `defer` list. No `expect`. */
export const decisionDeferRequest = z
  .object({
    until: timestamp,
    reason: oneOf(asTuple(DECISION_LOG_REASONS.defer as readonly DeferReason[])),
  })
  .strict();

export const decisionResolved = z.object({ decision, receipt: commandReceipt }).passthrough();

/** Local actors are not projected: a CLI decision is recorded under its linked `prn_`. */
export const approverProjection = z
  .object({
    v: z.literal(1),
    epoch: count,
    generatedAt: timestamp,
    harness: harnessId,
    owner: principalId,
    governedSince: timestamp,
    members: z.array(
      z
        .object({ principal: principalId, decide: decisionClass, until: timestamp.optional() })
        .passthrough(),
    ),
    links: z.array(z.object({ external: externalSubject, principal: principalId }).passthrough()),
    homeUrl: z.string().optional(),
    accessRoot: z.string().optional(),
  })
  .passthrough();

export const standingRule = z
  .object({
    id: ruleId,
    kind: z.literal("allow"),
    tool: z.string(),
    pattern: z.string(),
    derivedFrom: decisionId.optional(),
    proposal: decisionId.optional(),
    createdBy: storedActor,
    reason: z.enum(["approval", "proposal"]),
    policyRevision: z.string().optional(),
    createdAt: timestamp,
    expiresAt: timestamp,
    state: z.enum(["active", "revoked", "expired"]),
    revokedAt: timestamp.optional(),
    revokedBy: storedActor.optional(),
    expiredAt: timestamp.optional(),
  })
  .passthrough();

export const ruleList = listOf(standingRule);

export const ruleCreateRequest = z
  .object({
    tool: z.string().min(1),
    pattern: z.string().min(1),
    derivedFrom: decisionId.optional(),
    reason: z.string().min(1),
    expiresAt: timestamp.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Harnesses and deployments
// ---------------------------------------------------------------------------

export const harnessDisplay = z
  .object({
    state: oneOf(HARNESS_DISPLAY_STATES),
    enforcement: z.enum(["enforced", "recorded-not-enforced"]),
  })
  .passthrough();

export const harnessOverview = z
  .object({
    id: harnessId,
    slug: z.string(),
    owner: storedActor.optional(),
    createdAt: timestamp.optional(),
    display: harnessDisplay,
    savedSpecHash: z.string().optional(),
    deployedSpecHash: z.string().optional(),
    activeDeployment: deploymentId.optional(),
    openDecisions: count.optional(),
    lastVerifiedContactAt: timestamp.optional(),
    asOf: timestamp.optional(),
    stale: z.boolean().optional(),
    freshness: z.enum(["projection", "direct-fold"]).optional(),
  })
  .passthrough();

export const harnessList = listOf(harnessOverview);

export const capabilityDescriptor = z.union([
  z
    .object({ supported: z.literal(true), mode: z.enum(["validated", "legacy"]).optional() })
    .passthrough(),
  z
    .object({ supported: z.literal(false), reason: z.string(), verb: z.string().nullable() })
    .passthrough(),
  z.object({ supported: z.literal("unknown"), reason: z.string() }).passthrough(),
]);

export const harnessCapabilities = z
  .object({
    harness: harnessId,
    capabilities: z.record(capabilityDescriptor).superRefine((map, ctx) => {
      for (const [name, descriptor] of Object.entries(map)) {
        if (!(CAPABILITY_NAMES as readonly string[]).includes(name)) {
          ctx.addIssue({ code: "custom", message: `unknown capability ${name}` });
        }
        if (
          descriptor.supported === true &&
          descriptor.mode !== undefined &&
          name !== "decisions.consumeChecks"
        ) {
          ctx.addIssue({ code: "custom", message: `${name} has no mode` });
        }
      }
    }),
  })
  .passthrough();

export const harnessHealth = z
  .object({
    harness: harnessId,
    heartbeatAgeMs: count.optional(),
    controlReachable: z.boolean().optional(),
    backlog: count.optional(),
    recovery: z.string().optional(),
  })
  .passthrough();

export const deployment = z
  .object({
    id: deploymentId,
    harness: harnessId,
    state: deploymentState,
    artifact: z
      .object({
        digest: z.string(),
        // A build whose stamp does not match the saved spec has no spec hash to name, and a
        // bundle with no `compiledWith` names none: a guessed value would be wrong.
        specHash: z.string().optional(),
        compiledWith: z.string().optional(),
        shape: z.string(),
        entry: z.string(),
      })
      .passthrough(),
    host: z.string().optional(),
    environment: z.string().optional(),
    policyRevision: z.string().optional(),
    tenantsRoot: z.string().optional(),
    autostart: z.boolean().optional(),
    activatedBy: storedActor.optional(),
    cmd: commandId.optional(),
    delegation: z.object({}).passthrough().optional(),
  })
  .passthrough();

export const deploymentList = listOf(deployment);

export const deploymentActivateRequest = z.object({ deployment: deploymentId }).strict();

export const pauseRequest = z.object({ quiet: z.boolean().optional() }).strict();

export const retireRequest = z
  .object({
    dryRun: z.boolean().default(true),
    confirmName: z.string().min(1).optional(),
    nonce: z.string().min(1).optional(),
    stop: z.boolean().default(false),
  })
  .strict();

export const retireResponse = z
  .object({
    dryRun: z.boolean(),
    steps: z.array(
      z
        .object({
          kind: z.string(),
          status: z.enum(["planned", "done", "skipped", "failed", "manual"]),
          note: z.string().optional(),
        })
        .passthrough(),
    ),
    nonce: z.string().optional(),
    receipt: commandReceipt.optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export const member = z
  .object({
    id: principalId,
    kind: z.enum(["member", "service"]),
    displayName: z.string().optional(),
    createdAt: timestamp.optional(),
  })
  .passthrough();

export const grant = z
  .object({
    id: grantId,
    principal: principalId,
    role: roleName,
    scope: grantScope,
    grantedBy: storedActor,
    expiresAt: timestamp.optional(),
    revokedAt: timestamp.optional(),
  })
  .passthrough();

export const invite = z
  .object({
    id: inviteId,
    role: roleName,
    scope: grantScope,
    createdBy: storedActor,
    expiresAt: timestamp,
    consumedAt: timestamp.optional(),
    revokedAt: timestamp.optional(),
  })
  .passthrough();

export const tokenRow = z
  .object({
    id: credentialId,
    principal: principalId,
    kind: z.enum(["bootstrap", "personal", "service"]),
    prefixHint: z.string().optional(),
    permissions: z.array(permissionId).optional(),
    harnesses: z.array(harnessId).optional(),
    lastUsedAt: timestamp.optional(),
    expiresAt: timestamp.optional(),
    revokedAt: timestamp.optional(),
  })
  .passthrough();

export const link = z
  .object({
    id: linkId,
    principal: principalId,
    provider: oneOf(LINK_PROVIDERS),
    subjectRef: subjectDigest,
    verifiedVia: z.string(),
    at: timestamp,
    revokedAt: timestamp.optional(),
  })
  .passthrough();

export const device = z
  .object({
    id: deviceId,
    principal: principalId,
    label: z.string().optional(),
    createdAt: timestamp,
    lastUsedAt: timestamp.optional(),
    revokedAt: timestamp.optional(),
  })
  .passthrough();

export const memberList = listOf(member);
export const inviteList = listOf(invite);
export const grantList = listOf(grant);
export const tokenList = listOf(tokenRow);
export const linkList = listOf(link);
export const deviceList = listOf(device);

export const inviteCreateRequest = z
  .object({ role: roleName, scope: grantScope, expiresAt: timestamp.optional(), seal })
  .strict();

export const grantCreateRequest = z
  .object({
    principal: principalId,
    role: roleName,
    scope: grantScope,
    expiresAt: timestamp.optional(),
  })
  .strict();

export const tokenMintRequest = z
  .object({
    principal: principalId,
    permissions: z.array(permissionId).optional(),
    harnesses: z.array(harnessId).optional(),
    contentRead: z.boolean().optional(),
    subjectAssert: z.boolean().optional(),
    expiresAt: timestamp.optional(),
    seal,
  })
  .strict();

export const linkCreateRequest = z
  .object({ subject: externalSubject, principal: principalId })
  .strict();

/** A scoped token lives at most 15 minutes. */
const SCOPED_TOKEN_MAX_SECONDS = 900;

/**
 * The refs are checked by Home against its own records, each one: a ref that does not
 * parse, or names a run Home does not have, is named back in `details.refs`.
 */
export const scopedTokenMintRequest = z
  .object({
    subject: z.string().min(1).optional(),
    refs: z.array(z.string().min(1).max(REF_MAX_LENGTH)).min(1),
    acts: z.array(oneOf(asTuple(SCOPED_ACTS))).min(1),
    ttlSeconds: z.number().int().min(1).max(SCOPED_TOKEN_MAX_SECONDS).optional(),
    seal,
  })
  .strict();

export const inviteIssued = z.object({ invite, issued, receipt: commandReceipt }).passthrough();

export const tokenIssued = z
  .object({
    issued,
    credentialRef: credentialId.optional(),
    prefixHint: z.string().optional(),
    expiresAt: timestamp.optional(),
    receipt: commandReceipt.optional(),
  })
  .passthrough();

export const sessionIssued = z
  .object({
    issued,
    expiresAt: timestamp.optional(),
    principal: principalId.optional(),
    receipt: commandReceipt.optional(),
  })
  .passthrough();

/** Joining from an invite answers a sealed session, or, for a tab-only session, no secret at all. */
export const inviteAccepted = z.union([
  sessionIssued,
  z
    .object({
      tabOnly: z.literal(true),
      expiresAt: timestamp,
      principal: principalId.optional(),
    })
    .passthrough(),
]);

export const signedOut = z.object({ signedOut: z.literal(true) }).passthrough();

export const authChallenge = z.object({ nonce: z.string(), expiresAt: timestamp }).passthrough();

export const authSessionRequest = z
  .object({ device: deviceId, nonce: z.string().min(1), signature: z.string().min(1), seal })
  .strict();

export const authExchangeRequest = z.object({ code: z.string().min(1), deviceJwk, seal }).strict();

/**
 * Joining from an invite: a device key and a seal where the page can make them, or, on a
 * page served over plain HTTP, a 32-byte secret the page made itself (43 base64url
 * characters), of which Home keeps only a digest.
 */
export const authAcceptInviteRequest = z.union([
  z.object({ code: z.string().min(1), displayName: z.string().min(1), deviceJwk, seal }).strict(),
  z
    .object({
      code: z.string().min(1),
      displayName: z.string().min(1),
      sessionSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .strict(),
]);

export const authRefreshRequest = z.object({ seal }).strict();

// ---------------------------------------------------------------------------
// Signing in a device with a short code
// ---------------------------------------------------------------------------

/** What a device names itself on the page that allows it: a short label, never authority. */
const clientName = z
  .string()
  .min(1)
  .max(64)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  .regex(/^[^\u0000-\u001f\u007f]+$/);

export const deviceStartRequest = z
  .object({ seal, clientName: clientName.optional(), readOnly: z.boolean().optional() })
  .strict();

/** The start's answer: the poll reference travels sealed to the start's own seal. */
export const deviceStarted = z
  .object({
    issued,
    userCode: z.string().regex(/^[A-Z]{4}-[A-Z]{4}$/),
    verificationUrl: z.string(),
    intervalMs: count,
    expiresAt: timestamp,
  })
  .passthrough();

export const devicePollRequest = z
  .object({ pollRef: z.string().regex(/^[0-9a-f]{64}$/), seal })
  .strict();

/** Still waiting, refused, ended or already collected; or, once, the sealed token. */
export const devicePolled = z.union([
  z.object({ state: z.enum(["pending", "denied", "expired", "consumed"]) }).passthrough(),
  tokenIssued,
]);

export const deviceLookupRequest = z.object({ code: z.string().min(1).max(32) }).strict();

/** A pending sign-in request, as the person allowing it sees it. */
export const deviceRequestView = z
  .object({
    state: z.enum(["pending", "allowed", "denied", "consumed", "expired"]),
    readOnly: z.boolean(),
    expiresAt: timestamp,
    clientName: z.string().optional(),
    tokenDays: count,
  })
  .passthrough();

export const deviceDecideRequest = z
  .object({ code: z.string().min(1).max(32), choice: z.enum(["allow", "deny"]) })
  .strict();

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const eventEnvelope = z
  .object({
    v: z.literal(1),
    id: cursorString,
    type: z.custom<EventType>(isEventType, "unknown event type"),
    at: timestamp,
    ingestedAt: timestamp,
    harness: harnessId.optional(),
    run: z.string().optional(),
    work: z.string().optional(),
    decision: z.string().optional(),
    command: z.string().optional(),
    deployment: z.string().optional(),
    parent: refString.optional(),
    actor: storedActor.optional(),
    revision: z.object({ object: z.string(), rev: count }).passthrough().optional(),
    sensitivity: sensitivityName,
    payload: z.record(z.unknown()).optional(),
    payloadRef: z
      .object({ href: z.string(), bytes: count, truncated: z.boolean() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const eventFrame = z
  .object({
    id: cursorString,
    event: z.custom<EventType>(isEventType, "unknown event type"),
    data: eventEnvelope,
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const modelBoundDecl = z.union([
  z.object({ origin: z.string(), at: z.enum(["write", "run-entry"]) }).passthrough(),
  z.object({ none: z.literal(true), reason: z.string() }).passthrough(),
]);

export const discoveryOperation = z
  .object({
    id: z.string(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string(),
    permission: z.string(),
    receipt: z.enum(["none", "harness", "workspace"]),
    request: z.string(),
    response: z.string(),
    cliTwin: z
      .object({ argv: z.array(z.string()) })
      .passthrough()
      .nullable(),
    qualifiers: z.array(oneOf(QUALIFIERS)),
    idempotency: z.enum(["none", "accepted", "required-for-services", "required"]),
    noReceiptReason: z.string().optional(),
    noTwinReason: z.string().optional(),
    stream: z.literal("sse").optional(),
    secretFields: z.array(z.string()).optional(),
    modelBound: z.record(modelBoundDecl).optional(),
  })
  .passthrough();

export const discovery = z
  .object({
    protocol: z.literal(PROTOCOL_ID),
    signIn: z.object({ methods: z.array(z.string()) }).passthrough(),
    operations: z.array(discoveryOperation).optional(),
    capabilities: z.array(z.string()).optional(),
    limits: z
      .object({ pageLimitDefault: count, pageLimitMax: count, cursorMaxLength: count })
      .passthrough()
      .optional(),
    links: z.object({ baseUrl: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

export const me = z
  .object({
    principal: member,
    grants: z.array(grant),
    can: z.record(z.boolean()),
  })
  .passthrough();

const refCandidate = z.object({ kind: z.string(), ref: refString, href: z.string() }).passthrough();

export const refResolved = z
  .object({
    kind: z.string(),
    href: z.string(),
    /** What changes when the object does: a row count, a state, an id. */
    rev: z.string(),
    url: z.string().optional(),
    revisions: z
      .object({
        spec: z.string().optional(),
        deployedSpec: z.string().optional(),
        deployment: z.string().optional(),
        policy: z.string().optional(),
      })
      .passthrough()
      .optional(),
    candidates: z.array(refCandidate).optional(),
    summary: z.string(),
  })
  .passthrough();

/**
 * Every core schema, by the id an operation row names it with. Typed as a record: its
 * literal type is longer than a declaration can hold.
 */
export const CORE_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  // Refined leaves.
  canonicalRunId,
  commandId,
  credentialId,
  cursorString,
  decisionId,
  deploymentId,
  deviceId,
  grantId,
  harnessId,
  inviteId,
  linkId,
  principalId,
  refString,
  ruleId,
  runRowId,
  sessionId,
  storedActor,
  workItemId,
  // Shapes.
  approverProjection,
  authAcceptInviteRequest,
  authChallenge,
  authExchangeRequest,
  authRefreshRequest,
  authSessionRequest,
  capabilityDescriptor,
  commandAccepted,
  commandList,
  commandReceipt,
  decision,
  decisionBinding,
  decisionDeferRequest,
  decisionList,
  decisionOverlays,
  decisionResolveRequest,
  decisionResolved,
  decisionSupersedeRequest,
  deployment,
  deploymentActivateRequest,
  deploymentList,
  device,
  deviceDecideRequest,
  deviceJwk,
  deviceList,
  deviceLookupRequest,
  devicePollRequest,
  devicePolled,
  deviceRequestView,
  deviceStartRequest,
  deviceStarted,
  discovery,
  discoveryOperation,
  emptyRequest,
  errorEnvelope,
  eventEnvelope,
  eventFrame,
  grant,
  grantCreateRequest,
  grantList,
  harnessCapabilities,
  harnessDisplay,
  harnessHealth,
  harnessList,
  harnessOverview,
  invite,
  inviteCreateRequest,
  inviteAccepted,
  inviteIssued,
  inviteList,
  issued,
  link,
  linkCreateRequest,
  linkList,
  listEnvelope,
  listQuery,
  me,
  member,
  memberList,
  noBody,
  pauseRequest,
  refResolved,
  retireRequest,
  retireResponse,
  ruleCreateRequest,
  ruleList,
  run,
  runCause,
  runCost,
  runCreateRequest,
  runCreated,
  runList,
  runResult,
  scopedTokenMintRequest,
  seal,
  sessionIssued,
  signedOut,
  standingRule,
  streamQuery,
  tokenIssued,
  tokenList,
  tokenMintRequest,
  tokenRow,
  trigger,
  triggerSource,
} as const;
