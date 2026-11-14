/**
 * The delegation area: an owner's rule that lets the control plane decide one narrow
 * class of `ship` decision on the owner's behalf, for a limited time, re-checked before
 * every use (#517, #513, module brief 322). Static data, like every area module: the
 * `delegation` lifecycle, the two permissions a maintainer holds, the command kinds and
 * the `delegations.*` operations, and the closed vocabularies a rule row and an
 * application line use.
 *
 * The record keys, the action vocabulary and the receipt's authority kinds live here, in
 * the main entry, because the twins, the schemas and the receipts need them and the main
 * entry never imports `./delegation`. The pure functions over them (`effectiveRuleState`,
 * `authorizeDelegated`, `renderConsequences`, `decidedByText`) are `./delegation`'s.
 *
 * A rule is a `rule_` id on the core's `rule` ref kind; this module declares no new id
 * grammar, ref kind or path parameter. No action is wired by this module: an action is
 * registered by the area that performs it.
 */
import type { CommandReceipt } from "../commands.js";
import { HARNESS_COMMAND, NOT_MODEL_BOUND, READ } from "../operations/shared.js";
import { deepFreeze } from "../util.js";
import type { AreaModule } from "./types.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** What a rule may let the control plane do. Closed: a fifth action is a schema change. */
export const DELEGATION_ACTIONS = deepFreeze(["merge", "rollout", "adopt", "assistant"] as const);

export type DelegationAction = (typeof DELEGATION_ACTIONS)[number];

/** The `dec_` kinds a rule may resolve. Only `ship`-class decisions are ever delegable. */
export const DELEGABLE_DECISION_KINDS = deepFreeze(["merge", "rollout"] as const);

export type DelegableDecisionKind = (typeof DELEGABLE_DECISION_KINDS)[number];

/** The lifecycle states of a rule, on the `delegation` machine. */
export const DELEGATION_RULE_STATES = deepFreeze([
  "enabled",
  "revised",
  "suspended",
  "resumed",
  "revoked",
  "expired",
  "exhausted",
] as const);

export type DelegationRuleState = (typeof DELEGATION_RULE_STATES)[number];

/** The states in which a rule may apply, subject to its clock and its use cap. */
export const LIVE_RULE_STATES = deepFreeze(["enabled", "revised", "resumed"] as const);

/** Why a rule stopped applying until an owner resumes it. */
export const SUSPEND_REASONS = deepFreeze([
  "paused-by-member",
  "rolled-back",
  "rollback-failed",
  "owner-authority-changed",
  "policy-changed",
  "ceiling-changed",
  "host-protection-changed",
  "capability-lost",
] as const);

export type SuspendReason = (typeof SUSPEND_REASONS)[number];

/** A rule row's `reason`: a suspension's, or `retired` when retire ended it. A person's
 *  revoke carries none. */
export const DELEGATION_RULE_REASONS = deepFreeze([...SUSPEND_REASONS, "retired"] as const);

export type DelegationRuleReason = (typeof DELEGATION_RULE_REASONS)[number];

/** What an application line records. */
export const DELEGATION_LOG_EVENTS = deepFreeze([
  "checked",
  "refused",
  "not-applied",
  "planned",
  "decided",
  "acted",
  "watch-started",
  "kept",
  "rolled-back",
  "rollback-failed",
  "superseded-by-person",
] as const);

export type DelegationLogEvent = (typeof DELEGATION_LOG_EVENTS)[number];

/** Whose authority a receipt was written under, beside its actor. */
export const RECEIPT_AUTHORITY_KINDS = deepFreeze(["delegation", "assistant-rule"] as const);

export type ReceiptAuthorityKind = (typeof RECEIPT_AUTHORITY_KINDS)[number];

/**
 * The closed key set of a rule row. A row holds ids, keyed digests, counts, times and
 * codes from closed lists: never free text or a person's name. A key is added here on
 * purpose, and its test changes with it.
 */
export const DELEGATION_RULE_KEYS = deepFreeze([
  "v",
  "at",
  "id",
  "state",
  "kind",
  "action",
  "revision",
  "scope",
  "terms",
  "termsDigest",
  "ceilingDigest",
  "policyRevision",
  "consequencesDigest",
  "hostDigest",
  "expiresAt",
  "maxUses",
  "owner",
  "by",
  "decision",
  "reason",
  "cmd",
] as const);

/** The closed key set of an application line, held the same way. */
export const DELEGATION_LOG_KEYS = deepFreeze([
  "v",
  "at",
  "event",
  "rule",
  "revision",
  "decision",
  "subject",
  "gates",
  "plan",
  "watch",
  "cmd",
  "appliedBy",
  "reason",
] as const);

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Who a rule covers: one harness, or the harnesses a workspace rule names. */
export type DelegationScope =
  | { readonly harness: string }
  | { readonly harnesses: readonly string[] };

/** One narrowing value of a rule's scope: a name, a glob, a count or a flag, never prose. */
export type DelegationScopeValue = string | number | boolean | readonly string[];

/**
 * What an owner agreed to, inside the ceiling: how long (days, never an absolute end), an
 * optional use cap, and the action's own narrowing fields. Terms never carry gates: an
 * action's required gates come from its registration.
 */
export type DelegationTerms = {
  readonly days: number;
  readonly maxUses?: number;
  readonly scope?: Readonly<Record<string, DelegationScopeValue>>;
};

/** One rule row, as `delegations.jsonl` holds it. Each row restates the whole rule. */
export type DelegationRuleRow = {
  readonly v: 1;
  readonly at: string;
  /** `rule_<ulid>`. */
  readonly id: string;
  /** The machine state this row moves the rule to. */
  readonly state: DelegationRuleState;
  readonly kind: "delegate";
  readonly action: DelegationAction;
  readonly revision: number;
  readonly scope: DelegationScope;
  readonly terms: DelegationTerms;
  /** A keyed digest of the terms. */
  readonly termsDigest: string;
  /** `sha256:` over the active deployment's ceiling the rule was bound to. */
  readonly ceilingDigest: string;
  readonly policyRevision: string;
  /** The keyed digest of the consequences page the owner confirmed. */
  readonly consequencesDigest: string;
  readonly hostDigest?: string;
  readonly expiresAt: string;
  readonly maxUses?: number;
  /** The owner who agreed to this revision's page, as a stored actor. */
  readonly owner: string;
  /** Who wrote this row: a stored actor, or a system actor. */
  readonly by?: string;
  /** The proposal (`dec_`) the rule was enabled from. */
  readonly decision?: string;
  readonly reason?: DelegationRuleReason;
  /** The receipt this row was written under. */
  readonly cmd: string;
};

/** A gate's verdict as an application line keeps it: ids, codes, a digest and times. */
export type DelegationGateLine = {
  readonly gate: string;
  readonly outcome: string;
  readonly boundTo: string;
  readonly evidence: readonly string[];
  readonly at: string;
  readonly freshUntil: string;
  readonly reason?: string;
};

/** What a decision is about, by ref, with the revision a grant is bound to. */
export type DelegationSubject = {
  readonly ref: string;
  readonly revision: string;
};

/** One application line, as `delegation-log/` holds it. */
export type DelegationLogLine = {
  readonly v: 1;
  readonly at: string;
  readonly event: DelegationLogEvent;
  readonly rule: string;
  readonly revision: number;
  readonly decision?: string;
  readonly subject?: DelegationSubject;
  readonly gates?: readonly DelegationGateLine[];
  /** The rollback plan, persisted before the effect. */
  readonly plan?: Readonly<Record<string, unknown>>;
  /** The watch a delegated action opened. */
  readonly watch?: Readonly<Record<string, unknown>>;
  /** The receipt of the command the line is about: on a watch's lines, the action's. */
  readonly cmd?: string;
  /** Who ran the pass that applied the rule: a stored actor, or a system actor. */
  readonly appliedBy?: string;
  readonly reason?: string;
};

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** What a rule reads as now: its live state, the clock and the use cap applied. */
export type DelegationDisplayState = "active" | "suspended" | "revoked" | "expired" | "exhausted";

/** Terms as a request offers them: each part optional, defaults applied by the service. */
export type DelegationTermsRequest = {
  readonly days?: number;
  readonly maxUses?: number;
  readonly scope?: Readonly<Record<string, DelegationScopeValue>>;
};

/** One rule, as `delegations.list` shows it. */
export type DelegationRuleView = {
  readonly id: string;
  readonly action: DelegationAction;
  readonly state: DelegationDisplayState;
  readonly revision: number;
  /** One line from closed templates: what the rule does. */
  readonly label: string;
  readonly endsAt: string;
  readonly uses: number;
  readonly maxUses?: number;
  readonly lastAction?: {
    readonly at: string;
    readonly decision?: string;
    readonly cmd?: string;
  };
  readonly suspendedReason?: SuspendReason;
};

/** An action a person may turn a rule on for here: the ceiling allows it and it is served. */
export type DelegationOffer = {
  readonly action: DelegationAction;
  readonly label: string;
  readonly verb: string;
};

/** A request to the owner for a rule, waiting. */
export type DelegationProposalView = {
  readonly id: string;
  readonly action: DelegationAction;
  readonly days: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly verb: string;
};

export type DelegationList = {
  readonly items: readonly DelegationRuleView[];
  readonly next?: string;
  readonly snapshotAt: string;
  readonly truncated?: { readonly reason: string; readonly verb?: string };
  readonly empty?: {
    readonly reason: "not-allowed" | "no-data" | "unreadable";
    readonly remedy?: string;
    readonly verb?: string;
  };
  /** What could not be read, one sentence each; absent when everything was. */
  readonly unreadable?: readonly string[];
  /** Whether the active deployment's agreement allows any delegation, and for how long. */
  readonly ceiling: { readonly present: boolean; readonly maxDays?: number };
  readonly offers: readonly DelegationOffer[];
  readonly proposals: readonly DelegationProposalView[];
  /** Where rules are applied, said on every read. */
  readonly note: string;
  /** What the caller may do here, as Home's access says: what the screen offers. */
  readonly you?: {
    readonly manage: boolean;
    readonly propose: boolean;
    readonly suspend: boolean;
  };
};

/** One revision of a rule, as `delegations.get` shows it. */
export type DelegationRevisionView = {
  readonly revision: number;
  readonly state: DelegationRuleState;
  readonly at: string;
  readonly days: number;
  readonly reason?: DelegationRuleReason;
};

/** One application line, as `delegations.get` shows it. */
export type DelegationLogView = {
  readonly at: string;
  readonly event: DelegationLogEvent;
  readonly revision: number;
  readonly decision?: string;
  readonly cmd?: string;
  readonly reason?: string;
  readonly gates?: readonly { readonly gate: string; readonly outcome: string }[];
  /** On a `decided` line: who decided, in words, from closed templates. */
  readonly decidedByText?: string;
};

export type DelegationDetail = {
  readonly rule: DelegationRuleView;
  readonly terms: DelegationTerms;
  readonly revisions: readonly DelegationRevisionView[];
  readonly log: readonly DelegationLogView[];
  readonly truncated?: { readonly reason: string; readonly verb?: string };
};

export type DelegationPreviewRequest = {
  readonly action: DelegationAction;
  readonly terms?: DelegationTermsRequest;
  /** For a rule that exists: the page that changes or resumes it. */
  readonly rule?: string;
  readonly mode?: "change" | "resume";
};

/** The consequences page, server-rendered from closed templates. */
export type DelegationPage = {
  readonly action: DelegationAction;
  readonly title: string;
  readonly sections: readonly {
    readonly id: string;
    readonly heading: string;
    readonly lines: readonly string[];
  }[];
  readonly text: string;
  /** Absent until the harness has a digest key: turning it on sets one up first. */
  readonly consequencesDigest?: string;
  readonly note?: string;
  /** What a person types to confirm: the harness's name. */
  readonly confirmName: string;
  /** The exact command that turns this rule on. */
  readonly verb: string;
};

export type DelegationEnableRequest = {
  readonly action: DelegationAction;
  readonly terms?: DelegationTermsRequest;
  readonly consequencesDigest: string;
  readonly confirm: string;
  readonly proposal?: string;
};

export type DelegationProposeRequest = {
  readonly action: DelegationAction;
  readonly terms?: DelegationTermsRequest;
};

export type DelegationUpdateRequest = {
  readonly expect: number;
  readonly terms?: DelegationTermsRequest;
  readonly consequencesDigest: string;
  readonly confirm: string;
};

export type DelegationResumeRequest = {
  readonly expect: number;
  readonly consequencesDigest: string;
  readonly confirm: string;
};

export type DelegationRevokeRequest = {
  readonly expect?: number;
};

export type DelegationPauseRequest = {
  readonly reason?: "paused-by-member";
};

/** A delegation command's answer: its receipt, and the rule or request it wrote. */
export type DelegationAnswer = {
  readonly receipt: CommandReceipt;
  readonly rule?: DelegationRuleView;
  readonly proposal?: string;
};

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const TURN_ON =
  "Turning a rule on needs its consequences page: `crewhaus delegations preview <action> --harness <h>` prints it and the exact command to type.";

const TWINS = {
  list: { argv: ["delegations", "list", "--harness", "{hrn}"] },
  show: { argv: ["delegations", "show", "{rule}", "--harness", "{hrn}"] },
  preview: { argv: ["delegations", "preview", "{delegationAction}", "--harness", "{hrn}"] },
  propose: { argv: ["delegations", "propose", "{delegationAction}", "--harness", "{hrn}"] },
  pause: { argv: ["delegations", "pause", "{rule}", "--harness", "{hrn}"] },
  revoke: { argv: ["delegations", "revoke", "{rule}", "--harness", "{hrn}"] },
  apply: { argv: ["delegations", "apply", "--harness", "{hrn}"] },
} as const;

const RULE_PATH = "/api/v1/harnesses/{h}/delegations";

const LIVE_ONWARD = ["revised", "suspended", "revoked", "expired", "exhausted"] as const;

export const DELEGATION_MODULE = {
  area: "delegation",
  operations: [
    {
      ...READ,
      id: "delegations.list",
      method: "GET",
      path: RULE_PATH,
      permission: "h.read",
      request: "listQuery",
      response: "delegationList",
      cliTwin: TWINS.list,
      qualifiers: [],
    },
    {
      ...READ,
      id: "delegations.get",
      method: "GET",
      path: `${RULE_PATH}/{rule}`,
      permission: "h.read",
      request: "noBody",
      response: "delegationDetail",
      cliTwin: TWINS.show,
      qualifiers: [],
    },
    {
      ...READ,
      id: "delegations.preview",
      method: "POST",
      path: `${RULE_PATH}/preview`,
      permission: "h.read",
      request: "delegationPreviewRequest",
      response: "delegationPage",
      noReceiptReason: "a read-only page: it changes nothing",
      cliTwin: TWINS.preview,
      qualifiers: [],
    },
    {
      ...HARNESS_COMMAND,
      id: "delegations.enable",
      method: "POST",
      path: RULE_PATH,
      permission: "h.standing-rule.manage",
      request: "delegationEnableRequest",
      response: "delegationAnswer",
      cliTwin: null,
      noTwinReason: TURN_ON,
      qualifiers: ["human-only"],
      modelBound: { confirm: NOT_MODEL_BOUND.name },
    },
    {
      ...HARNESS_COMMAND,
      id: "delegations.propose",
      method: "POST",
      path: `${RULE_PATH}/proposals`,
      permission: "h.delegation.propose",
      request: "delegationProposeRequest",
      response: "delegationAnswer",
      cliTwin: TWINS.propose,
      qualifiers: ["human-only"],
    },
    {
      ...HARNESS_COMMAND,
      id: "delegations.update",
      method: "POST",
      path: `${RULE_PATH}/{rule}/update`,
      permission: "h.standing-rule.manage",
      request: "delegationUpdateRequest",
      response: "delegationAnswer",
      cliTwin: null,
      noTwinReason: TURN_ON,
      qualifiers: ["human-only"],
      modelBound: { confirm: NOT_MODEL_BOUND.name },
    },
    {
      ...HARNESS_COMMAND,
      id: "delegations.resume",
      method: "POST",
      path: `${RULE_PATH}/{rule}/resume`,
      permission: "h.standing-rule.manage",
      request: "delegationResumeRequest",
      response: "delegationAnswer",
      cliTwin: null,
      noTwinReason: TURN_ON,
      qualifiers: ["human-only"],
      modelBound: { confirm: NOT_MODEL_BOUND.name },
    },
    {
      ...HARNESS_COMMAND,
      id: "delegations.revoke",
      method: "POST",
      path: `${RULE_PATH}/{rule}/revoke`,
      permission: "h.standing-rule.manage",
      request: "delegationRevokeRequest",
      response: "delegationAnswer",
      cliTwin: TWINS.revoke,
      qualifiers: ["human-only"],
    },
    {
      ...HARNESS_COMMAND,
      id: "delegations.pause",
      method: "POST",
      path: `${RULE_PATH}/{rule}/pause`,
      permission: "h.delegation.suspend",
      request: "delegationPauseRequest",
      response: "delegationAnswer",
      cliTwin: TWINS.pause,
      qualifiers: [],
    },
    {
      ...HARNESS_COMMAND,
      id: "delegations.apply",
      method: "POST",
      path: `${RULE_PATH}/apply`,
      permission: "h.control",
      request: "emptyRequest",
      cliTwin: TWINS.apply,
      qualifiers: [],
    },
    {
      ...HARNESS_COMMAND,
      id: "delegations.watches.keep",
      method: "POST",
      path: `${RULE_PATH}/watches/{cmd}/keep`,
      permission: "h.delegation.suspend",
      request: "emptyRequest",
      cliTwin: null,
      noTwinReason:
        "The CLI has no verb for this; `crewhaus api delegations.watches.keep` calls it.",
      qualifiers: [],
    },
  ],
  refKinds: [],
  eventFamilies: [],
  machines: {
    delegation: {
      states: [...DELEGATION_RULE_STATES],
      entry: ["enabled"],
      terminal: ["revoked", "expired", "exhausted"],
      transitions: {
        enabled: [...LIVE_ONWARD],
        revised: [...LIVE_ONWARD],
        resumed: [...LIVE_ONWARD],
        suspended: ["resumed", "revoked", "expired", "exhausted"],
        revoked: [],
        expired: [],
        exhausted: [],
      },
      recoveryOwner: {
        enabled: "operator",
        revised: "operator",
        suspended: "operator",
        resumed: "operator",
        revoked: "none",
        expired: "none",
        exhausted: "none",
      },
    },
  },
  commandKinds: [
    {
      id: "delegations.enable",
      permission: "h.standing-rule.manage",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "delegations.update",
      permission: "h.standing-rule.manage",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "delegations.resume",
      permission: "h.standing-rule.manage",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "delegations.revoke",
      permission: "h.standing-rule.manage",
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.revoke,
    },
    {
      id: "delegations.propose",
      permission: "h.delegation.propose",
      idempotent: false,
      effect: "local",
      cliTwin: TWINS.propose,
    },
    {
      id: "delegations.pause",
      permission: "h.delegation.suspend",
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.pause,
    },
    {
      id: "delegations.watches.keep",
      permission: "h.delegation.suspend",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "delegations.apply",
      permission: "h.control",
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.apply,
    },
  ],
  permissions: [
    { id: "h.delegation.propose", scope: "harness", floor: "maintainer", service: "never" },
    { id: "h.delegation.suspend", scope: "harness", floor: "maintainer", service: "never" },
  ],
  // Recorded by the system alone: no request can claim either.
  reasonCodes: { supersede: ["rule-revoked", "paused"] },
} as const satisfies AreaModule;
