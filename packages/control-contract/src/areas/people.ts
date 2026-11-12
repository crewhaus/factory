/**
 * The people area: profiles of people a harness helps, kept in an encrypted vault
 * outside every harness (#521, module briefs 328 and 329). Static data, like every
 * area module: the operations, the `person` ref kind, the `people.*` permissions, the
 * note and person lifecycles, the command kinds and the closed vocabularies the
 * requests use.
 *
 * Every `people.*` permission has floor `none`, so no role implies one, and is
 * `service: "never"`: a service holds people access only through a space bound to it,
 * which is the people domain's own record, never a credential's permission list.
 */
import { READ, WORKSPACE_COMMAND } from "../operations/shared.js";
import { deepFreeze } from "../util.js";
import type { AreaModule, ModelBoundDecl } from "./types.js";

/** What a note may be used for. Closed: a tenth purpose is a schema change. */
export const PEOPLE_PURPOSES = deepFreeze([
  "communication",
  "accessibility",
  "scheduling",
  "recommendations",
  "decision-support",
  "drafting",
  "learning-support",
  "research-context",
  "simulation",
] as const);

export type PeoplePurpose = (typeof PEOPLE_PURPOSES)[number];

/** Personal (the owner, or someone they look after), a group, or a made-up persona. */
export const PERSON_KINDS = deepFreeze(["personal", "audience", "synthetic"] as const);

export type PersonKind = (typeof PERSON_KINDS)[number];

/** Who a personal profile describes. */
export const PERSON_DESCRIBES = deepFreeze(["self", "someone-else"] as const);

/** Why a member may keep a personal profile about someone else. */
export const CUSTODIAL_BASES = deepFreeze(["custodian", "consent", "contract"] as const);

export type CustodialBasis = (typeof CUSTODIAL_BASES)[number];

/** How a group profile's description is known. */
export const AUDIENCE_BASES = deepFreeze(["survey", "usage", "interviews", "assumption"] as const);

export type AudienceBasis = (typeof AUDIENCE_BASES)[number];

/** How much a group's people differ from one another. */
export const AUDIENCE_VARIATIONS = deepFreeze(["uniform", "mixed", "unknown"] as const);

/** Ordered from least to most sensitive. `special`: health, beliefs, sexuality, ethnicity, biometrics. */
export const NOTE_SENSITIVITIES = deepFreeze([
  "ordinary",
  "personal",
  "sensitive",
  "special",
] as const);

export type NoteSensitivity = (typeof NOTE_SENSITIVITIES)[number];

export const NOTE_TYPES = deepFreeze([
  "preference",
  "communication",
  "value",
  "worldview",
  "goal",
  "routine",
  "skill",
  "accessibility-need",
  "accommodation",
  "constraint",
  "decision-example",
  "personality",
  "health",
  "other",
] as const);

export type NoteType = (typeof NOTE_TYPES)[number];

/** Note types that are special by nature, whatever sensitivity a caller declares. */
export const SPECIAL_NOTE_TYPES = deepFreeze(["health", "worldview"] as const);

export const NOTE_ACQUISITIONS = deepFreeze(["stated", "observed", "inferred"] as const);

export const NOTE_CONFIDENCES = deepFreeze(["low", "medium", "high"] as const);

/** What a review can do to a note. */
export const NOTE_VERDICTS = deepFreeze(["keep", "reject", "reopen", "narrow", "merge"] as const);

export type NoteVerdict = (typeof NOTE_VERDICTS)[number];

/** Where the key that opens the vault is kept. */
export const VAULT_CUSTODIES = deepFreeze(["keychain", "environment", "file"] as const);

export type VaultCustody = (typeof VAULT_CUSTODIES)[number];

/** A note's area: a short lowercase slug. */
export const NOTE_AREA_RE = /^[a-z][a-z0-9-]{0,39}$/;

export const NOTE_VALUE_MAX = 500;
export const NOTE_SITUATION_MAX = 200;
export const PERSON_LABEL_MAX = 120;
export const AUDIENCE_WHO_MAX = 200;

/** What an erasure leaves behind, by code. */
export const ERASURE_RESIDUE = deepFreeze([
  "downloaded-export",
  "backups",
  "backups-unknown",
  "space-key-not-rotated",
] as const);

/** What the vault's activity log records, by event. Counts only, never a value. */
export const PERSON_ACTIVITY_EVENTS = deepFreeze([
  "person.created",
  "person.updated",
  "claim.created",
  "claim.revised",
  "claim.reviewed",
  "export.created",
] as const);

export type PersonActivityEvent = (typeof PERSON_ACTIVITY_EVENTS)[number];

/** Where a note came from. */
export const NOTE_SOURCES = deepFreeze([
  "self",
  "custodian",
  "interview",
  "import",
  "work-sample",
  "reaction",
  "conversation",
] as const);

/** The export format's name and version. */
export const PEOPLE_EXPORT_FORMAT = "crewhaus.people.v1";

// ---------------------------------------------------------------------------
// Shapes, each held to its schema in `schemas/people.type-checks.ts`
// ---------------------------------------------------------------------------

export type PersonRole = "owner" | "custodian" | "viewer";

export type PersonRowState = "active" | "erasing";

export type VaultStateView = {
  readonly state: "not-set-up" | "locked" | "ready";
  readonly custody?: VaultCustody;
  readonly kekVersion?: number;
  readonly backupDays?: number;
  readonly reason?: string;
};

export type PeopleSetupRequest = {
  readonly custody: VaultCustody;
  readonly backupDays?: number;
};

export type PersonCreateRequest = {
  readonly kind: PersonKind;
  readonly label: string;
  readonly describes?: (typeof PERSON_DESCRIBES)[number];
  readonly basis?: CustodialBasis | AudienceBasis;
  readonly who?: string;
  readonly variation?: (typeof AUDIENCE_VARIATIONS)[number];
  readonly size?: number;
};

export type PersonUpdateRequest = {
  readonly expect: number;
  readonly label?: string;
  readonly offLimits?: readonly string[];
  readonly allow?: readonly string[];
  readonly viewers?: readonly string[];
  readonly removeViewers?: readonly string[];
};

export type PersonRow = {
  readonly person: string;
  readonly kind: PersonKind;
  readonly label: string;
  readonly role: PersonRole;
  readonly state: PersonRowState;
  readonly rev: number;
};

export type AudienceView = {
  readonly who: string;
  readonly basis: AudienceBasis;
  readonly size?: number;
  readonly variation: (typeof AUDIENCE_VARIATIONS)[number];
};

export type PersonView = PersonRow & {
  readonly owner: string;
  readonly custodian?: string;
  readonly describes?: (typeof PERSON_DESCRIBES)[number];
  readonly basis?: CustodialBasis;
  readonly audience?: AudienceView;
  readonly synthetic?: true;
  readonly offLimits: readonly string[];
  readonly viewers: readonly string[];
};

export type PersonClaimView = {
  readonly id: string;
  readonly rev: number;
  readonly person: string;
  readonly type: NoteType;
  readonly area: string;
  readonly value: string;
  readonly situation?: string;
  readonly source: { readonly kind: (typeof NOTE_SOURCES)[number] };
  readonly acquisition: (typeof NOTE_ACQUISITIONS)[number];
  readonly confidence: (typeof NOTE_CONFIDENCES)[number];
  readonly sensitivity: NoteSensitivity;
  readonly state: "proposed" | "active" | "rejected" | "superseded" | "conflicted";
  readonly confirmedBy?: "owner" | "auto";
  readonly reviewBy?: string;
  readonly purposes: readonly PeoplePurpose[];
  readonly mergedInto?: string;
  readonly createdBy: { readonly actor: string; readonly via: string };
  readonly createdAt: string;
  readonly at: string;
};

export type ClaimCreateRequest = {
  readonly area: string;
  readonly value: string;
  readonly situation?: string;
  readonly type?: NoteType;
  readonly purposes?: readonly PeoplePurpose[];
  readonly sensitivity?: NoteSensitivity;
  readonly confidence?: (typeof NOTE_CONFIDENCES)[number];
  readonly reviewBy?: string;
  readonly acquisition?: (typeof NOTE_ACQUISITIONS)[number];
};

export type ClaimReviseRequest = {
  readonly expect: number;
  readonly value: string;
  readonly situation?: string;
};

export type ClaimReviewRequest = {
  readonly verdict: NoteVerdict;
  readonly purposes?: readonly PeoplePurpose[];
  readonly into?: string;
};

export type ExportRequest = {
  readonly areas?: readonly string[];
  readonly purposes?: readonly PeoplePurpose[];
  readonly includeSensitive?: boolean;
  readonly includeRejected?: boolean;
  readonly summary?: boolean;
};

export type ExportCounts = {
  readonly notes: number;
  readonly rejected: number;
  readonly masked: number;
  readonly leftOut: number;
};

export type ExportPreview = {
  readonly format: typeof PEOPLE_EXPORT_FORMAT;
  readonly counts: ExportCounts;
  readonly sha256: string;
  readonly bytes: number;
};

export type PersonActivityRow = {
  readonly at: string;
  readonly actor: string;
  readonly event: PersonActivityEvent;
  readonly counts: Readonly<Record<string, number>>;
};

export type ErasureResidue = {
  readonly code: (typeof ERASURE_RESIDUE)[number];
  readonly until?: string;
  readonly at?: string;
};

export type ErasureCounts = {
  readonly notes: number;
  readonly revisions: number;
  readonly rejected: number;
  readonly exports: number;
};

export type ErasurePlanView = {
  readonly person: string;
  readonly counts: ErasureCounts;
  readonly residue: readonly ErasureResidue[];
  readonly nonce: string;
  readonly expiresAt: string;
};

export type ErasureRunRequest = {
  readonly nonce: string;
  readonly confirm: string;
};

const ULID = "ulid";

const SEALED: ModelBoundDecl = {
  none: true,
  reason: "Stored sealed in the vault; no model reads it in this release.",
};

const PERSON = "/api/v1/people/{psn}";

const NO_SWITCH = (verb: string) =>
  `\`crewhaus people ${verb}\` does this, and a twin cannot carry a switch.`;

export const PEOPLE_MODULE = {
  area: "people",
  operations: [
    {
      ...WORKSPACE_COMMAND,
      id: "people.vault.setup",
      method: "POST",
      path: "/api/v1/people/setup",
      permission: "home.settings.manage",
      request: "peopleSetupRequest",
      response: "commandAccepted",
      cliTwin: { argv: ["people", "init"] },
      qualifiers: [],
    },
    {
      ...READ,
      id: "people.vault.get",
      method: "GET",
      path: "/api/v1/people/keys",
      permission: "home.settings.manage",
      request: "noBody",
      response: "peopleVaultState",
      cliTwin: { argv: ["people", "keys"] },
      qualifiers: [],
    },
    {
      ...WORKSPACE_COMMAND,
      id: "people.vault.rotate",
      method: "POST",
      path: "/api/v1/people/keys/rotate",
      permission: "home.settings.manage",
      request: "emptyRequest",
      response: "commandAccepted",
      cliTwin: null,
      noTwinReason: NO_SWITCH("keys --rotate"),
      qualifiers: [],
    },
    {
      ...READ,
      id: "people.persons.list",
      method: "GET",
      path: "/api/v1/people",
      permission: "people.person.read",
      request: "listQuery",
      response: "personList",
      cliTwin: { argv: ["people", "list"] },
      qualifiers: ["filtered"],
    },
    {
      ...WORKSPACE_COMMAND,
      id: "people.persons.create",
      method: "POST",
      path: "/api/v1/people",
      permission: "people.space.use",
      request: "personCreateRequest",
      response: "commandAccepted",
      cliTwin: { argv: ["people", "add", "--kind", "{kind}"] },
      qualifiers: [],
      secretFields: ["label", "who"],
      modelBound: { label: SEALED, who: SEALED },
    },
    {
      ...READ,
      id: "people.persons.get",
      method: "GET",
      path: PERSON,
      permission: "people.person.read",
      request: "noBody",
      response: "personView",
      cliTwin: { argv: ["people", "show", "{psn}"] },
      qualifiers: [],
    },
    {
      ...WORKSPACE_COMMAND,
      id: "people.persons.update",
      method: "PATCH",
      path: PERSON,
      permission: "people.person.write",
      request: "personUpdateRequest",
      response: "commandAccepted",
      cliTwin: null,
      noTwinReason:
        "One change can edit several lists and take a new name, which is typed, never put on a command line.",
      qualifiers: [],
      secretFields: ["label", "offLimits", "allow"],
      modelBound: { label: SEALED, offLimits: SEALED, allow: SEALED },
    },
    {
      ...READ,
      id: "people.claims.list",
      method: "GET",
      path: `${PERSON}/claims`,
      permission: "people.person.read",
      request: "listQuery",
      response: "personClaimList",
      cliTwin: { argv: ["people", "show", "{psn}"] },
      qualifiers: [],
    },
    {
      ...WORKSPACE_COMMAND,
      id: "people.claims.create",
      method: "POST",
      path: `${PERSON}/claims`,
      permission: "people.person.write",
      request: "claimCreateRequest",
      response: "commandAccepted",
      cliTwin: { argv: ["people", "note", "{psn}", "--area", "{area}"] },
      qualifiers: [],
      secretFields: ["area", "value", "situation"],
      modelBound: { area: SEALED, value: SEALED, situation: SEALED },
    },
    {
      ...WORKSPACE_COMMAND,
      id: "people.claims.revise",
      method: "POST",
      path: `${PERSON}/claims/{pcl}/revise`,
      permission: "people.person.write",
      request: "claimReviseRequest",
      response: "commandAccepted",
      cliTwin: { argv: ["people", "edit", "{pcl}"] },
      qualifiers: [],
      secretFields: ["value", "situation"],
      modelBound: { value: SEALED, situation: SEALED },
    },
    {
      ...WORKSPACE_COMMAND,
      id: "people.claims.review",
      method: "POST",
      path: `${PERSON}/claims/{pcl}/review`,
      permission: "people.claim.review",
      request: "claimReviewRequest",
      response: "commandAccepted",
      cliTwin: { argv: ["people", "review", "{pcl}", "--as", "{verdict}"] },
      qualifiers: [],
    },
    {
      ...READ,
      id: "people.review.list",
      method: "GET",
      path: `${PERSON}/review`,
      permission: "people.person.read",
      request: "listQuery",
      response: "personClaimList",
      cliTwin: { argv: ["people", "review", "{psn}"] },
      qualifiers: [],
    },
    {
      ...READ,
      id: "people.exports.preview",
      method: "POST",
      path: `${PERSON}/exports/preview`,
      permission: "people.export",
      noReceiptReason: "A preview writes nothing.",
      request: "exportRequest",
      response: "exportPreview",
      cliTwin: null,
      noTwinReason: NO_SWITCH("export --dry-run"),
      qualifiers: [],
      secretFields: ["areas"],
      modelBound: { areas: SEALED },
    },
    {
      ...WORKSPACE_COMMAND,
      id: "people.exports.create",
      method: "POST",
      path: `${PERSON}/exports`,
      permission: "people.export",
      request: "exportRequest",
      response: "commandAccepted",
      cliTwin: { argv: ["people", "export", "{psn}"] },
      qualifiers: [],
      secretFields: ["areas"],
      modelBound: { areas: SEALED },
    },
    {
      ...READ,
      id: "people.activity.list",
      method: "GET",
      path: `${PERSON}/activity`,
      permission: "people.activity.read",
      request: "listQuery",
      response: "personActivityList",
      cliTwin: { argv: ["people", "activity", "{psn}"] },
      qualifiers: [],
    },
    {
      ...READ,
      id: "people.erasure.plan",
      method: "POST",
      path: `${PERSON}/erasure/plan`,
      permission: "people.erase",
      noReceiptReason: "A dry run writes nothing.",
      request: "emptyRequest",
      response: "erasurePlan",
      cliTwin: null,
      noTwinReason: NO_SWITCH("erase --dry-run"),
      qualifiers: [],
    },
    {
      ...WORKSPACE_COMMAND,
      id: "people.erasure.run",
      method: "POST",
      path: `${PERSON}/erasure`,
      permission: "people.erase",
      request: "erasureRunRequest",
      response: "commandAccepted",
      cliTwin: { argv: ["people", "erase", "{psn}"] },
      qualifiers: [],
      secretFields: ["confirm"],
      modelBound: { confirm: SEALED },
    },
  ],
  grammars: [
    { prefix: "psn", grammar: ULID },
    { prefix: "pcl", grammar: ULID },
    { prefix: "pex", grammar: ULID },
    { prefix: "per", grammar: ULID },
    { prefix: "spc", grammar: ULID },
    // Reserved: the later changes that add uses, projections, sources and interviews mint them.
    { prefix: "pgr", grammar: ULID },
    { prefix: "ppj", grammar: ULID },
    { prefix: "pso", grammar: ULID },
    { prefix: "piv", grammar: ULID },
  ],
  refKinds: [{ kind: "person", scope: "home", ids: [{ prefix: "psn", grammar: ULID }] }],
  eventFamilies: [
    {
      family: "people",
      types: [
        { type: "people.person.created", sensitivity: "people" },
        { type: "people.person.updated", sensitivity: "people" },
        { type: "people.person.erased", sensitivity: "people" },
        { type: "people.claim.changed", sensitivity: "people" },
        { type: "people.review.pending", sensitivity: "people" },
        { type: "people.export.created", sensitivity: "people" },
        { type: "people.erasure.planned", sensitivity: "people" },
        { type: "people.erasure.completed", sensitivity: "people" },
      ],
    },
  ],
  machines: {
    personClaim: {
      states: ["proposed", "active", "rejected", "superseded", "conflicted"],
      entry: ["proposed", "active"],
      terminal: ["superseded"],
      transitions: {
        proposed: ["active", "rejected", "superseded"],
        active: ["superseded", "rejected", "conflicted"],
        // A rejected note comes back only by reopening it.
        rejected: ["proposed"],
        conflicted: ["active", "superseded"],
        superseded: [],
      },
      recoveryOwner: {
        proposed: "operator",
        active: "operator",
        rejected: "operator",
        conflicted: "operator",
        superseded: "none",
      },
    },
    person: {
      states: ["active", "erasing", "erased"],
      entry: ["active"],
      terminal: ["erased"],
      transitions: {
        active: ["erasing"],
        // Every erasure step is idempotent: a run that stopped part way is finished, never undone.
        erasing: ["erased"],
        erased: [],
      },
      recoveryOwner: { active: "operator", erasing: "operator", erased: "none" },
    },
  },
  commandKinds: [
    {
      id: "people.vault.setup",
      permission: "home.settings.manage",
      idempotent: true,
      effect: "local",
      cliTwin: { argv: ["people", "init"] },
    },
    {
      id: "people.vault.rotate",
      permission: "home.settings.manage",
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "people.persons.create",
      permission: "people.space.use",
      idempotent: false,
      effect: "local",
      cliTwin: { argv: ["people", "add", "--kind", "{kind}"] },
    },
    {
      id: "people.persons.update",
      permission: "people.person.write",
      idempotent: true,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "people.claims.create",
      permission: "people.person.write",
      idempotent: true,
      effect: "local",
      cliTwin: { argv: ["people", "note", "{psn}", "--area", "{area}"] },
    },
    {
      id: "people.claims.revise",
      permission: "people.person.write",
      idempotent: true,
      effect: "local",
      cliTwin: { argv: ["people", "edit", "{pcl}"] },
    },
    {
      id: "people.claims.review",
      permission: "people.claim.review",
      idempotent: true,
      effect: "local",
      cliTwin: { argv: ["people", "review", "{pcl}", "--as", "{verdict}"] },
    },
    {
      id: "people.exports.create",
      permission: "people.export",
      idempotent: true,
      effect: "local",
      cliTwin: { argv: ["people", "export", "{psn}"] },
    },
    {
      id: "people.erasure.run",
      permission: "people.erase",
      idempotent: false,
      effect: "local",
      cliTwin: { argv: ["people", "erase", "{psn}"] },
    },
  ],
  permissions: [
    { id: "people.space.use", scope: "home", floor: "none", service: "never" },
    { id: "people.person.read", scope: "home", floor: "none", service: "never" },
    { id: "people.person.write", scope: "home", floor: "none", service: "never" },
    { id: "people.claim.review", scope: "home", floor: "none", service: "never" },
    { id: "people.grant.manage", scope: "home", floor: "none", service: "never" },
    { id: "people.export", scope: "home", floor: "none", service: "never" },
    { id: "people.activity.read", scope: "home", floor: "none", service: "never" },
    { id: "people.erase", scope: "home", floor: "none", service: "never" },
    { id: "people.derived.read", scope: "home", floor: "none", service: "never" },
  ],
} as const satisfies AreaModule;
