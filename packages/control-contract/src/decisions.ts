/**
 * A decision as readers see it, and the pure checks over it. Nothing here opens
 * a file or reads a ledger: a caller passes the records it has read and the time.
 * A read can therefore show that a decision has expired, or that its fallback is
 * overdue, without writing anything; only a writer records the change.
 *
 * Bad input never throws. It answers the safe way: a time that cannot be read
 * counts as passed, and a check that cannot be made refuses.
 */
import { OPERATOR_SUPERSEDE_REASONS, VERIFY_REASONS } from "./areas/core.js";
import { MODULES, type ModuleField } from "./areas/index.js";
import type { Role } from "./areas/types.js";
import type { DecisionState } from "./machines.js";
import { parseActor, parseResumeScope } from "./refs.js";
import { deepFreeze } from "./util.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** A decision's class names the lowest role that may resolve it. */
export const DECISION_CLASSES = deepFreeze(["operator", "maintainer", "owner"] as const);

export type DecisionClass = (typeof DECISION_CLASSES)[number] & Role;

/** Whether someone holding `held` may decide at `required`. Unknown names answer `false`. */
export function classAllows(held: unknown, required: unknown): boolean {
  const classes: readonly unknown[] = DECISION_CLASSES;
  const heldRank = classes.indexOf(held);
  const requiredRank = classes.indexOf(required);
  return heldRank >= 0 && requiredRank >= 0 && heldRank >= requiredRank;
}

export const IF_UNANSWERED = deepFreeze([
  "continue-independent",
  "defer",
  "pause-lane",
  "deny",
] as const);

export type IfUnanswered = (typeof IF_UNANSWERED)[number];

type ReasonTable = ModuleField<"reasonCodes">;

type EventsOf<T> = T extends unknown ? keyof T & string : never;

type ReasonsOf<T, Event extends string> = T extends {
  readonly [K in Event]: readonly (infer Reason)[];
}
  ? Reason
  : never;

/** Closed reason lists for the decision log, by event, composed from the modules. */
export const DECISION_LOG_REASONS: Readonly<Record<EventsOf<ReasonTable>, readonly string[]>> =
  deepFreeze(
    MODULES.reduce<Record<string, string[]>>((table, module) => {
      for (const [event, reasons] of Object.entries(module.reasonCodes ?? {})) {
        table[event] = [...(table[event] ?? []), ...reasons];
      }
      return table;
    }, {}),
  ) as unknown as Readonly<Record<EventsOf<ReasonTable>, readonly string[]>>;

/**
 * What a decision-log line records. `refuse` is reserved for the check made
 * when a grant is spent, which records why it was not.
 */
export const DECISION_LOG_EVENTS = deepFreeze([
  "park",
  "decide",
  "supersede",
  "defer",
  "consume",
  "refuse",
  "expire",
  "evict",
] as const);

export type DecisionLogEvent = (typeof DECISION_LOG_EVENTS)[number];

/**
 * The closed key set of a decision-log line. The log holds ids, keyed digests,
 * times and codes from closed lists: never tool input, free text or a user name.
 * A key is added here on purpose, and its test changes with it.
 */
export const DECISION_LOG_KEYS = deepFreeze([
  "v",
  "at",
  "event",
  "decision",
  "runId",
  "sessionId",
  "tool",
  "inputDigest",
  "placesDigest",
  "bindingDigest",
  "by",
  "resolvedBy",
  "agreementRevision",
  "surface",
  "outcome",
  "reason",
  "until",
  "choice",
  "answered",
  "sensitivity",
] as const);

export type DecisionLogKey = (typeof DECISION_LOG_KEYS)[number];

/** Why a decision was superseded: a code from a closed list, never free text. */
export type SupersedeReason = ReasonsOf<ReasonTable, "supersede">;

/** Why a decision was deferred: a code from a closed list, never free text. */
export type DeferReason = ReasonsOf<ReasonTable, "defer">;

export { OPERATOR_SUPERSEDE_REASONS };

export type OperatorSupersedeReason = (typeof OPERATOR_SUPERSEDE_REASONS)[number];

/** The supersede reasons only the system records. A request can never claim one. */
export const SYSTEM_SUPERSEDE_REASONS: readonly SupersedeReason[] = deepFreeze(
  (DECISION_LOG_REASONS.supersede as readonly SupersedeReason[]).filter(
    (reason) => !(OPERATOR_SUPERSEDE_REASONS as readonly string[]).includes(reason),
  ),
);

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type DecisionPlace = {
  readonly path: string;
  readonly at: readonly string[];
};

export type DecisionSupersedes = {
  readonly id: string;
  readonly decision?: "grant" | "deny";
  readonly places?: readonly DecisionPlace[];
};

/** What a grant is good for: the action's places, a scope and the revisions. */
export type DecisionBinding = {
  readonly runId: string;
  readonly resumeScope: string;
  readonly sessionId: string;
  readonly workItem?: string;
  readonly deploymentId?: string;
  readonly specHash?: string;
  readonly placesDigest: string;
  readonly resourceRevision?: string;
  readonly resourceRevisionBound: boolean;
};

export type DecisionEscalation = {
  readonly at: string;
  readonly toClass: DecisionClass;
};

export type DecisionSensitivity = "internal" | "restricted" | "people";

/**
 * What a standing-rule proposal asks the owner to allow: a narrow allow for one
 * tool, until a time. `ruleKind` says which terms follow, so another kind of rule
 * adds its own.
 */
export type StandingRuleTerms = {
  readonly ruleKind: "allow";
  readonly tool: string;
  readonly pattern: string;
  readonly expiresAt: string;
};

/**
 * A decision record. A tool approval carries every name its parked record has; a
 * decision that is not a tool approval (`dec_`) has no tool call, so those names
 * are optional here.
 */
export type DecisionRecordView = {
  readonly id: string;
  readonly createdAt: string;
  readonly toolName?: string;
  readonly inputHash?: string;
  readonly input?: unknown;
  readonly places?: readonly DecisionPlace[];
  readonly supersedes?: DecisionSupersedes;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly surface?: string;
  readonly decision?: "grant" | "deny";
  /** Free text for display. It carries no authority. */
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly consumedAt?: string;
  readonly consumedByRun?: string;
  readonly always?: boolean;
  readonly kind?: "tool" | "input" | "standing-rule-proposal";
  /** The decider as a stored actor: `prn_`, `local:#<digest>` or `sys:`. */
  readonly decidedByPrincipal?: string;
  readonly decidedVia?: string;
  readonly supersededBy?: string;
  readonly supersededReason?: SupersedeReason;
  readonly expiresAt?: string;
  readonly deferredUntil?: string;
  readonly escalation?: DecisionEscalation;
  readonly sensitivity?: DecisionSensitivity;
  readonly ifUnanswered?: IfUnanswered;
  readonly expiredAt?: string;
  readonly resolvedBy?: "policy";
  readonly agreementRevision?: string;
  readonly requiredClass?: DecisionClass;
  readonly binding?: DecisionBinding;
  readonly bindingDigest?: string;
  readonly askDigest?: string;
  /** A standing-rule proposal's terms. */
  readonly terms?: StandingRuleTerms;
  /** Who asked, as a stored actor: a member whose own `--always` became a request to the owner. */
  readonly proposedBy?: string;
  /** The tool approval a proposal was made from. */
  readonly derivedFrom?: string;
};

/** What the workspace layers over a decision. A tool approval's deferral is on the record. */
export type DecisionOverlays = {
  readonly assigned?: {
    readonly to: string;
    readonly at: string;
  };
};

/**
 * The harness-local copy of who may decide. Local actors are never projected. A
 * member with `until` counts only before that instant: the file is rewritten when
 * access changes, so the time travels with it and a reader needs nothing else.
 */
export type ApproverProjection = {
  readonly v: 1;
  readonly epoch: number;
  readonly generatedAt: string;
  readonly harness: string;
  readonly owner: string;
  readonly governedSince: string;
  readonly members: readonly {
    readonly principal: string;
    readonly decide: DecisionClass;
    /** When this member's authority ends (ISO). Absent: it does not end on its own. */
    readonly until?: string;
  }[];
  readonly links: readonly {
    readonly external: string;
    readonly principal: string;
  }[];
};

// ---------------------------------------------------------------------------
// effectiveDecisionState
// ---------------------------------------------------------------------------

export type EffectiveDecisionState = {
  readonly state: DecisionState;
  /** A pending decision past its deadline, whose declared fallback has not been applied. */
  readonly overdue: boolean;
  readonly fallback?: IfUnanswered;
  /** `false` only when a read computed `expired` and no writer has recorded it yet. */
  readonly materialized: boolean;
  readonly assignedTo?: string;
  readonly deferredUntil?: string;
};

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Whether the deadline has passed. No `expiresAt` means no deadline; otherwise it
 * is the later of `expiresAt` and the record's `deferredUntil`. An `expiresAt` or
 * a `now` that cannot be read counts as passed; a `deferredUntil` that cannot be
 * read moves nothing.
 */
function deadlinePassed(record: DecisionRecordView, now: number): boolean {
  if (record.expiresAt === undefined) return false;
  const expires = parseTime(record.expiresAt);
  if (expires === undefined || !Number.isFinite(now)) return true;
  return now > Math.max(expires, parseTime(record.deferredUntil) ?? expires);
}

/** The state every reader shows: the record, its overlays and the time. */
export function effectiveDecisionState(
  record: DecisionRecordView,
  overlays: DecisionOverlays | null | undefined,
  now: number,
): EffectiveDecisionState {
  if (typeof record !== "object" || record === null) {
    return { state: "expired", overdue: false, materialized: false };
  }
  const assignedTo = overlays?.assigned?.to;
  const notes = {
    ...(assignedTo === undefined ? {} : { assignedTo }),
    ...(record.deferredUntil === undefined ? {} : { deferredUntil: record.deferredUntil }),
  };
  const settled = (state: DecisionState): EffectiveDecisionState => ({
    state,
    overdue: false,
    materialized: true,
    ...notes,
  });
  if (record.supersededBy !== undefined) return settled("superseded");
  if (record.consumedAt !== undefined) return settled("consumed");
  if (record.expiredAt !== undefined) return settled("expired");
  // A deny never expires: it stands until it is superseded.
  if (record.decision === "deny") return settled("denied");
  const passed = deadlinePassed(record, now);
  if (record.decision === "grant") {
    if (!passed) return settled("granted");
    return { state: "expired", overdue: false, materialized: false, ...notes };
  }
  if (!passed) return settled("pending");
  // Only a fallback the owner-approved agreement declared keeps it waiting.
  const fallback = (IF_UNANSWERED as readonly unknown[]).includes(record.ifUnanswered)
    ? record.ifUnanswered
    : undefined;
  if (fallback !== undefined) {
    return { state: "pending", overdue: true, fallback, materialized: true, ...notes };
  }
  return { state: "expired", overdue: false, materialized: false, ...notes };
}

// ---------------------------------------------------------------------------
// verifyDecision
// ---------------------------------------------------------------------------

export { VERIFY_REASONS };

export type VerifyReason = (typeof VERIFY_REASONS)[number];

export type VerifyConsumer = {
  readonly runId: string;
  readonly resumeScope: string;
  /** The parking run this one continues, when it is a continuation. */
  readonly continues?: string;
  readonly deploymentId?: string;
  readonly specHash?: string;
  readonly resourceRevision?: string;
  readonly placesDigest?: string;
};

export type VerifyApprovers =
  | { readonly state: "absent" | "unreadable" }
  | { readonly state: "present"; readonly projection: ApproverProjection };

export type VerifyDecisionInput = {
  readonly decision: DecisionRecordView;
  readonly overlays?: DecisionOverlays | null;
  readonly consumer: VerifyConsumer;
  readonly approvers: VerifyApprovers;
  readonly now: number;
};

export type VerifyVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: VerifyReason;
      /** Whether the caller records the grant as superseded before asking again. */
      readonly supersede: boolean;
      /** The reason the supersede records, when `supersede` is true. */
      readonly supersedeReason?: SupersedeReason;
      readonly detail?: string;
    };

const OK: VerifyVerdict = Object.freeze({ ok: true });

/**
 * Whether a refusal also retires the grant, and why. A grant whose revisions moved
 * can never be spent again, and neither can one whose decider has lost the right to
 * decide it: both are superseded, so the request asked in its place is the one a
 * person decides. Every other refusal leaves the grant as it is, since what it
 * found (a scope, a place, a list that cannot be read) can change back.
 */
function supersedeReasonOf(
  record: DecisionRecordView,
  reason: VerifyReason,
): SupersedeReason | undefined {
  if (reason === "revision-changed") return "revision-changed";
  if (
    reason === "decider-not-authorized" &&
    record.resolvedBy !== "policy" &&
    parseActor(record.decidedByPrincipal)?.form === "principal"
  ) {
    return "decider-revoked";
  }
  return undefined;
}

function refuse(record: DecisionRecordView, reason: VerifyReason, detail?: string): VerifyVerdict {
  const supersedeReason = supersedeReasonOf(record, reason);
  return {
    ok: false,
    reason,
    supersede: supersedeReason !== undefined,
    ...(supersedeReason === undefined ? {} : { supersedeReason }),
    ...(detail === undefined ? {} : { detail }),
  };
}

function differs(bound: string | undefined, current: string | undefined): boolean {
  return bound !== undefined && current !== undefined && bound !== current;
}

/** The only thing a scope, a run or a digest can match on: two absent values never match. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** A recorded reason, if it is one. Anything else is not repeated to whoever reads the verdict. */
function knownSupersedeReason(reason: unknown): string | undefined {
  return (DECISION_LOG_REASONS.supersede as readonly unknown[]).includes(reason)
    ? (reason as string)
    : undefined;
}

/** Whether a member's `until` has passed. Absent never passes; one that cannot be read has. */
function untilPassed(until: unknown, now: number): boolean {
  if (until === undefined) return false;
  const ends = parseTime(until);
  return ends === undefined || !Number.isFinite(now) || now >= ends;
}

/**
 * Whether `principal` may decide at `requiredClass` now, by a present projection:
 * the owner always may; a member may while its class allows it and its `until`,
 * if it has one, has not passed. A member whose `until` cannot be read does not count.
 */
export function memberMayDecide(
  projection: ApproverProjection,
  principal: string,
  requiredClass: unknown,
  now: number,
): boolean {
  if (typeof projection !== "object" || projection === null) return false;
  if (projection.owner === principal) return true;
  const members: readonly { principal: string; decide: string; until?: unknown }[] = Array.isArray(
    projection.members,
  )
    ? projection.members
    : [];
  return members.some(
    (member) =>
      member?.principal === principal &&
      classAllows(member?.decide, requiredClass) &&
      !untilPassed(member?.until, now),
  );
}

function verifyDecider(
  record: DecisionRecordView,
  approvers: VerifyApprovers,
  now: number,
): VerifyVerdict {
  const decider = parseActor(record.decidedByPrincipal);
  // Service principals and system actors never decide on their own authority,
  // and a grant is never what a fallback applies.
  if (decider?.form === "system" || record.resolvedBy === "policy") {
    return refuse(record, "decider-not-authorized");
  }
  if (approvers?.state === "absent") return OK;
  if (approvers?.state !== "present") return refuse(record, "approvers-unreadable");
  if (typeof approvers.projection !== "object" || approvers.projection === null) {
    return refuse(record, "approvers-unreadable");
  }
  if (decider?.form === "principal") {
    // Only an absent class defaults. One that is present and unreadable refuses all but the owner.
    const required = record.requiredClass === undefined ? "operator" : record.requiredClass;
    return memberMayDecide(approvers.projection, decider.id, required, now)
      ? OK
      : refuse(record, "decider-not-authorized");
  }
  // No principal, or an unlinked local actor: free text carries no authority, so
  // it passes only when decided before this harness was governed.
  const legacy = record.decidedByPrincipal === undefined || decider?.form === "stored-local";
  const decidedAt = parseTime(record.decidedAt);
  const governedSince = parseTime(approvers.projection.governedSince);
  if (legacy && decidedAt !== undefined && governedSince !== undefined) {
    if (decidedAt < governedSince) return OK;
  }
  return refuse(record, "decider-unverified");
}

/**
 * The checks made just before a grant is spent, in order; the first failure wins.
 * It reads no ledger, so turning run tracking off cannot weaken it. Current policy
 * and the pre-tool hook stay the runtime's own check. Any refusal leaves the grant
 * unspent, and the answer is always to ask again.
 *
 * The scope is the binding. A scope that a re-delivery, a lane tick or a
 * conversation's next message re-enters is the binding on its own: each of those
 * is a new run, and the grant was given for the work, not for one run of it. A
 * supervised job's root scope (`run:<root>`) also needs the parking run or the
 * run that continues it, so only a resume of that job spends its grant.
 */
export function verifyDecision(input: VerifyDecisionInput): VerifyVerdict {
  const { decision: record, overlays, consumer, approvers, now } = input;

  if (typeof record !== "object" || record === null) {
    return { ok: false, reason: "not-a-grant", supersede: false };
  }
  if (record.decision !== "grant") return refuse(record, "not-a-grant");
  if (record.consumedAt !== undefined) return refuse(record, "consumed");
  if (record.supersededBy !== undefined) {
    return refuse(record, "superseded", knownSupersedeReason(record.supersededReason));
  }
  if (effectiveDecisionState(record, overlays, now).state === "expired") {
    return refuse(record, "expired");
  }

  if (typeof consumer !== "object" || consumer === null) return refuse(record, "scope-mismatch");
  if (!isText(consumer.resumeScope)) return refuse(record, "scope-mismatch");
  const binding = record.binding;
  if (binding === undefined) {
    // Parked before grants were bound: bound to its session, with no run check.
    if (!isText(record.sessionId) || consumer.resumeScope !== `session:${record.sessionId}`) {
      return refuse(record, "scope-mismatch");
    }
  } else {
    if (typeof binding !== "object" || binding === null) return refuse(record, "scope-mismatch");
    if (!isText(binding.resumeScope) || !isText(binding.sessionId)) {
      return refuse(record, "scope-mismatch");
    }
    if (consumer.resumeScope !== binding.resumeScope) return refuse(record, "scope-mismatch");
    if (parseResumeScope(binding.resumeScope)?.kind === "run") {
      if (!isText(binding.runId) || !isText(consumer.runId)) return refuse(record, "run-mismatch");
      if (consumer.runId !== binding.runId && consumer.continues !== binding.runId) {
        return refuse(record, "run-mismatch");
      }
    }
    if (
      differs(binding.deploymentId, consumer.deploymentId) ||
      differs(binding.specHash, consumer.specHash)
    ) {
      return refuse(record, "revision-changed");
    }
    // Only an explicit `false` unbinds the resource: a flag that is missing or torn still checks.
    if (
      binding.resourceRevisionBound !== false &&
      (!isText(binding.resourceRevision) || binding.resourceRevision !== consumer.resourceRevision)
    ) {
      return refuse(record, "resource-changed");
    }
    if (!isText(binding.placesDigest) || binding.placesDigest !== consumer.placesDigest) {
      return refuse(record, "places-changed");
    }
  }

  return verifyDecider(record, approvers, now);
}
