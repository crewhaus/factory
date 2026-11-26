/**
 * The runtime area's work half: what a harness was asked to do, as a `wi_` work item with
 * its own lifecycle (#516, #514, #513, module brief 333). Static data, like every area
 * module: the `work` machine, the command kinds and the `work.*` operations, and the closed
 * vocabularies a work log line, a proposal's assessment and a ranking correction use.
 *
 * The store, the assessment rules, the ranker and the display state live in
 * `@crewhaus/tool-work/work-items`; this module holds only what the operations, the
 * schemas and the twins need.
 *
 * The `work` machine lists each state's self-transition on purpose: a log line that
 * leaves the state where it was (`updated`, `linked`, `ranked`, `delivered`) is a legal
 * row, never an anomaly. Who may make which move is the store's rule, not the machine's.
 */
import type { CommandReceipt } from "../commands.js";
import { HARNESS_COMMAND, READ } from "../operations/shared.js";
import { deepFreeze } from "../util.js";
import type { AreaModule } from "./types.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** A work item's lifecycle states, on the `work` machine. */
export const WORK_STATES = deepFreeze(["proposed", "open", "closed"] as const);

export type WorkState = (typeof WORK_STATES)[number];

/** What a work log line records. */
export const WORK_EVENTS = deepFreeze([
  "opened",
  "accepted",
  "declined",
  "updated",
  "linked",
  "ranked",
  "delivered",
  "closed",
  "reopened",
] as const);

export type WorkEvent = (typeof WORK_EVENTS)[number];

/** What kind of work an item is. */
export const WORK_KINDS = deepFreeze([
  "fix",
  "feature",
  "maintenance",
  "research",
  "report",
  "request",
  "other",
] as const);

export type WorkKind = (typeof WORK_KINDS)[number];

/** Why a proposal matters: it keeps the harness safe and working, people ran into it, or it is an idea. */
export const WORK_BASES = deepFreeze([
  "compatibility-security",
  "user-pain",
  "speculative",
] as const);

export type WorkBasis = (typeof WORK_BASES)[number];

/** How a piece of evidence is known. */
export const EVIDENCE_LABELS = deepFreeze(["observed", "reported", "hypothesis"] as const);

export type EvidenceLabel = (typeof EVIDENCE_LABELS)[number];

/** Where a piece of evidence came from. */
export const EVIDENCE_KINDS = deepFreeze([
  "observed-usage",
  "user-report",
  "maintainer-note",
  "advisory",
  "release-note",
  "dependency-change",
  "inferred",
  "simulated",
] as const);

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** Where a work item came from. */
export const WORK_SOURCE_KINDS = deepFreeze([
  "operator",
  "api",
  "agent",
  "schedule",
  "github-issue",
  "thredz-task",
  "continuity-goal",
  "channel",
] as const);

export type WorkSourceKind = (typeof WORK_SOURCE_KINDS)[number];

/** How a closed item ended. */
export const WORK_CLOSE_OUTCOMES = deepFreeze([
  "done",
  "failed",
  "superseded",
  "declined",
  "cancelled",
] as const);

export type WorkCloseOutcome = (typeof WORK_CLOSE_OUTCOMES)[number];

/** Why a person declined a proposal. */
export const DECLINE_REASONS = deepFreeze([
  "out-of-scope",
  "duplicate",
  "not-now",
  "wont-fix",
  "needs-evidence",
  "other",
] as const);

export type DeclineReason = (typeof DECLINE_REASONS)[number];

/** How far a ranking correction reaches: this item, items like it, or every item of its basis. */
export const CORRECTION_SCOPES = deepFreeze(["item", "similar", "all"] as const);

export type CorrectionScope = (typeof CORRECTION_SCOPES)[number];

/** What a run delivered for an item. */
export const WORK_DELIVERY_KINDS = deepFreeze(["report", "answer", "artifact", "pr"] as const);

export type WorkDeliveryKind = (typeof WORK_DELIVERY_KINDS)[number];

/** The dimensions an owner may weight a ranking by. Closed: a new one is a schema change. */
export const WORK_RANK_DIMENSIONS = deepFreeze([
  "evidence",
  "cost",
  "upkeep",
  "uncertainty",
  "reversibility",
  "fit",
] as const);

export type WorkRankDimension = (typeof WORK_RANK_DIMENSIONS)[number];

/**
 * What an item reads as now, in precedence order (`effectiveWorkState`). The publish and
 * pull-request rows are filled in by the change that delivers work as pull requests.
 */
export const WORK_STATUSES = deepFreeze([
  "merged",
  "closed-unmerged",
  "reverted",
  "done",
  "declined",
  "cancelled",
  "superseded",
  "failed",
  "waiting-approval",
  "needs-input",
  "working",
  "in-review",
  "changes-requested",
  "publish-unfinished",
  "interrupted",
  "paused",
  "disabled",
  "waiting-budget",
  "proposed",
  "queued",
  "up-next",
] as const);

export type WorkStatus = (typeof WORK_STATUSES)[number];

/**
 * The closed key set of a work log line. A line holds ids, keyed digests, states, codes
 * from closed lists, numbers and times: never a title, a goal, a URL or issue text. A key
 * is added here on purpose, and its test changes with it. `claim` and `repaired` are
 * written by the ledger's exactly-once append and its repair.
 */
export const WORK_LOG_KEYS = deepFreeze([
  "v",
  "at",
  "id",
  "state",
  "event",
  "by",
  "via",
  "cmd",
  "run",
  "rev",
  "kind",
  "basis",
  "sourceKind",
  "sourceDigest",
  "parent",
  "priority",
  "outcome",
  "reasonCode",
  "supersededBy",
  "rule",
  "below",
  "scope",
  "delivered",
  "claim",
  "repaired",
] as const);

export type WorkLogKey = (typeof WORK_LOG_KEYS)[number];

/** The label a source claim's keyed digest is taken under. Stored digests join forever: a pin. */
export const WORK_SOURCE_LABEL = "work-source";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One piece of evidence, dated. A `hypothesis` is never shown as demand. */
export type WorkEvidence = {
  readonly label: EvidenceLabel;
  readonly kind: EvidenceKind;
  /** Where it can be checked: required for `observed` and `reported`. */
  readonly ref?: string;
  readonly note: string;
  readonly observedAt?: string;
  /** When the harness took it in; the store fills it when a writer leaves it out. */
  readonly ingestedAt?: string;
};

/**
 * A proposal's case for itself: one object, the same for every source. `doNothing` is
 * required for a feature; levels run 0 (none) to 3 (high).
 */
export type WorkAssessment = {
  readonly problem: string;
  readonly audience?: string;
  readonly evidence: readonly WorkEvidence[];
  readonly counterEvidence: readonly WorkEvidence[];
  readonly intentFit?: { readonly supports?: string; readonly conflicts?: string };
  readonly outcome?: string;
  readonly alternatives?: readonly string[];
  readonly doNothing?: string;
  readonly cost?: number;
  readonly upkeep?: number;
  readonly uncertainty?: number;
  readonly reversibility?: number;
  readonly dependencies?: readonly string[];
  readonly measure?: string;
};

/** A work item to create with a run, as `runs.create {work}` takes it. */
export type WorkCreateSpec = {
  readonly title: string;
  readonly kind: WorkKind;
  readonly goal?: string;
  readonly acceptance?: readonly string[];
};

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One ranking dimension as a row shows it: a level and the owner's weight. Never a score. */
export type WorkDimensionView = {
  readonly name: WorkRankDimension;
  readonly level: number;
  readonly weight?: number;
};

/** The correction that placed an item, when one did. */
export type WorkCorrectionView = {
  readonly scope: CorrectionScope;
  readonly by: string;
  readonly at: string;
};

/** One work item as a list shows it. A caller without content access sees its title and state only. */
export type WorkItemView = {
  readonly id: string;
  readonly state: WorkState;
  readonly status: WorkStatus;
  /** The status in words, from the server. */
  readonly statusWord: string;
  readonly title: string;
  readonly kind: WorkKind;
  readonly basis?: WorkBasis;
  readonly priority?: number;
  readonly rev: number;
  readonly sourceKind?: WorkSourceKind;
  readonly parent?: string;
  readonly outcome?: WorkCloseOutcome;
  readonly reasonCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Where the ranker put it among the items of its state. */
  readonly position?: number;
  readonly ranking?: "priority" | "weights";
  readonly dimensions?: readonly WorkDimensionView[];
  readonly corrected?: WorkCorrectionView;
  /** The runs linked to it, newest last. */
  readonly runs: readonly string[];
};

/** A note on an item, with the origin its text came through. */
export type WorkNoteView = {
  readonly by: string;
  readonly at: string;
  readonly text: string;
  readonly origin: string;
};

/** One log line in words a person reads: who did what, when, from where. */
export type WorkHistoryView = {
  readonly at: string;
  readonly event: WorkEvent;
  readonly by: string;
  readonly via?: string;
  readonly rev?: number;
  readonly run?: string;
  readonly outcome?: WorkCloseOutcome;
  readonly reasonCode?: string;
  readonly scope?: CorrectionScope;
};

/** An item's content, for a caller who may read it. */
export type WorkContentView = {
  readonly goal?: string;
  readonly acceptance?: readonly string[];
  readonly assessment?: WorkAssessment;
  readonly notes?: readonly WorkNoteView[];
  readonly source?: { readonly kind: WorkSourceKind; readonly ref?: string; readonly url?: string };
  readonly delivered?: readonly { readonly kind: WorkDeliveryKind; readonly ref: string }[];
};

export type WorkItemDetail = {
  readonly item: WorkItemView;
  /** Absent for a caller without content access; `hidden` then says why. */
  readonly content?: WorkContentView;
  readonly hidden?: readonly "content"[];
  readonly history: readonly WorkHistoryView[];
  readonly truncated?: { readonly reason: string; readonly verb?: string };
};

/** A feed section with nothing to show says why, and what fills it. */
export type WorkFeedEmpty = {
  readonly reason:
    | "no-data"
    | "no-access"
    | "unsupported"
    | "filtered"
    | "not-indexed"
    | "unreachable"
    | "expired"
    | "not-allowed";
  readonly remedy: string;
  /** A real CLI command that fills it, or `null` when there is none. */
  readonly verb: string | null;
};

/** One row of a feed section: a work item, a run or a group of runs, a job, a goal, a plan, a task. */
export type WorkFeedEntry = {
  readonly kind: "item" | "run" | "runs" | "job" | "goal" | "plan" | "task" | "schedule";
  readonly id: string;
  readonly label: string;
  readonly status?: string;
  readonly statusWord?: string;
  readonly item?: WorkItemView;
  readonly trigger?: string;
  readonly count?: number;
  readonly runs?: readonly string[];
  readonly progress?: {
    readonly current?: number;
    readonly target?: number;
    readonly unit?: string;
  };
  readonly steps?: readonly { readonly title: string; readonly status: string }[];
};

/** A feed section: its rows, or why it has none. Proposed also groups its rows by basis. */
export type WorkFeedSection = {
  readonly items?: readonly WorkFeedEntry[];
  /** More rows exist than the section shows. */
  readonly truncated?: boolean;
  readonly empty?: WorkFeedEmpty;
  readonly groups?: readonly { readonly basis: WorkBasis; readonly items: readonly string[] }[];
};

/** The Work view's sections, in the order it shows them. */
export const WORK_FEED_SECTIONS = deepFreeze([
  "needsYou",
  "workingNow",
  "upNext",
  "proposed",
  "scheduled",
  "delivered",
  "goals",
  "fromThredz",
] as const);

export type WorkFeedSectionName = (typeof WORK_FEED_SECTIONS)[number];

/** The Work view's sections, folded directly from the harness's records. Every section is sent. */
export type WorkFeed = {
  readonly freshness: "direct-fold";
  readonly at: string;
  readonly sections: Partial<Record<WorkFeedSectionName, WorkFeedSection>>;
  /** Log lines the machine refused: kept on disk, never applied. */
  readonly anomalies: number;
  /** Whether the harness's spec lists any of the Work tools. */
  readonly tools: boolean;
  readonly hidden?: readonly "content"[];
};

export type WorkCreateRequest = {
  readonly title: string;
  readonly goal?: string;
  readonly acceptance?: readonly string[];
  readonly kind: WorkKind;
  readonly basis?: WorkBasis;
  readonly parent?: string;
  readonly priority?: number;
  readonly assessment?: WorkAssessment;
};

export type WorkUpdateRequest = {
  /** The revision the caller read. */
  readonly expect: number;
  readonly title?: string;
  readonly goal?: string;
  readonly acceptance?: readonly string[];
  readonly kind?: WorkKind;
  readonly basis?: WorkBasis;
  readonly parent?: string;
  readonly priority?: number;
  readonly assessment?: WorkAssessment;
  readonly note?: string;
};

export type WorkDeclineRequest = {
  readonly reason: DeclineReason;
  readonly note?: string;
  /** The item that replaces this one, when the reason is `duplicate`. */
  readonly supersededBy?: string;
};

/** A ranking correction: move this item ahead of `below`, as far as `scope` reaches. */
export type WorkRankRequest = {
  readonly below: string;
  readonly scope: CorrectionScope;
};

/** Adopt a source as one item: `continuity-goal:<id>`, `thredz-task:<id>` or `github-issue:<owner>/<repo>#<n>`. */
export type WorkAdoptRequest = {
  readonly source: string;
};

/** A work command's answer: its receipt, the item it wrote and the run it started. */
export type WorkAnswer = {
  readonly receipt: CommandReceipt;
  readonly item?: WorkItemView;
  readonly run?: string;
};

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const TWINS = {
  list: { argv: ["work", "list", "--harness", "{hrn}"] },
  show: { argv: ["work", "show", "{wi}", "--harness", "{hrn}"] },
  add: { argv: ["work", "add", "--harness", "{hrn}"] },
  edit: { argv: ["work", "edit", "{wi}", "--harness", "{hrn}"] },
  accept: { argv: ["work", "accept", "{wi}", "--harness", "{hrn}"] },
  decline: {
    argv: ["work", "decline", "{wi}", "--reason", "{declineReason}", "--harness", "{hrn}"],
  },
  cancel: { argv: ["work", "cancel", "{wi}", "--harness", "{hrn}"] },
  reopen: { argv: ["work", "reopen", "{wi}", "--harness", "{hrn}"] },
  start: { argv: ["work", "start", "{wi}", "--harness", "{hrn}"] },
  rank: {
    argv: [
      "work",
      "rank",
      "{wi}",
      "--above",
      "{belowWi}",
      "--scope",
      "{correctionScope}",
      "--harness",
      "{hrn}",
    ],
  },
  adopt: { argv: ["work", "adopt", "--from", "{workSource}", "--harness", "{hrn}"] },
} as const;

const HARNESS_WORK = "/api/v1/harnesses/{h}/work";
const ITEM = "/api/v1/work/{ref}";
const WORK_REF = { kind: "work", param: "ref" } as const;

/** Free text a person or an API caller writes: classified at `api` when a tool reads it back. */
const WRITTEN = { origin: "api", at: "write" } as const;

const ITEM_TEXT = {
  title: WRITTEN,
  goal: WRITTEN,
  acceptance: WRITTEN,
  assessment: WRITTEN,
} as const;

const ALL_STATES = { proposed: "operator", open: "operator", closed: "operator" } as const;

/** One command kind per receipted row, its permission and twin the row's own. */
function kind(
  id: string,
  permission: string,
  idempotent: boolean,
  cliTwin: { readonly argv: readonly string[] } | null,
) {
  return { id, permission, idempotent, effect: "local", cliTwin } as const;
}

/** The work half of the runtime area's module, spread into `RUNTIME_MODULE`. */
export const WORK_OPERATIONS = [
  {
    ...READ,
    id: "work.list",
    method: "GET",
    path: HARNESS_WORK,
    permission: "h.read",
    request: "listQuery",
    response: "workList",
    cliTwin: TWINS.list,
    qualifiers: ["content-fields"],
  },
  {
    ...READ,
    id: "work.feed",
    method: "GET",
    path: `${HARNESS_WORK}/feed`,
    permission: "h.read",
    request: "noBody",
    response: "workFeed",
    cliTwin: null,
    noTwinReason: "`crewhaus api work.feed` reads it.",
    qualifiers: ["content-fields"],
  },
  {
    ...READ,
    id: "work.get",
    method: "GET",
    path: ITEM,
    permission: "h.read",
    request: "noBody",
    response: "workItemDetail",
    cliTwin: TWINS.show,
    qualifiers: ["content-fields"],
    ref: WORK_REF,
  },
  {
    ...HARNESS_COMMAND,
    id: "work.create",
    method: "POST",
    path: HARNESS_WORK,
    permission: "h.run.submit",
    idempotency: "required-for-services",
    request: "workCreateRequest",
    response: "workAnswer",
    cliTwin: TWINS.add,
    qualifiers: [],
    modelBound: ITEM_TEXT,
  },
  {
    ...HARNESS_COMMAND,
    id: "work.update",
    method: "POST",
    path: `${ITEM}/update`,
    permission: "h.run.submit",
    request: "workUpdateRequest",
    response: "workAnswer",
    cliTwin: TWINS.edit,
    qualifiers: [],
    modelBound: { ...ITEM_TEXT, note: WRITTEN },
    ref: WORK_REF,
  },
  {
    ...HARNESS_COMMAND,
    id: "work.accept",
    method: "POST",
    path: `${ITEM}/accept`,
    permission: "h.run.submit",
    request: "emptyRequest",
    response: "workAnswer",
    cliTwin: TWINS.accept,
    qualifiers: ["human-only"],
    ref: WORK_REF,
  },
  {
    ...HARNESS_COMMAND,
    id: "work.decline",
    method: "POST",
    path: `${ITEM}/decline`,
    permission: "h.run.submit",
    request: "workDeclineRequest",
    response: "workAnswer",
    cliTwin: TWINS.decline,
    qualifiers: ["human-only"],
    modelBound: { note: WRITTEN },
    ref: WORK_REF,
  },
  {
    ...HARNESS_COMMAND,
    id: "work.reopen",
    method: "POST",
    path: `${ITEM}/reopen`,
    permission: "h.run.submit",
    request: "emptyRequest",
    response: "workAnswer",
    cliTwin: TWINS.reopen,
    qualifiers: ["human-only"],
    ref: WORK_REF,
  },
  {
    ...HARNESS_COMMAND,
    id: "work.cancel",
    method: "POST",
    path: `${ITEM}/cancel`,
    permission: "h.control",
    request: "emptyRequest",
    response: "workAnswer",
    cliTwin: TWINS.cancel,
    qualifiers: [],
    ref: WORK_REF,
  },
  {
    ...HARNESS_COMMAND,
    id: "work.rank",
    method: "POST",
    path: `${ITEM}/rank`,
    permission: "h.run.submit",
    request: "workRankRequest",
    response: "workAnswer",
    cliTwin: TWINS.rank,
    qualifiers: ["human-only"],
    ref: WORK_REF,
  },
  {
    ...HARNESS_COMMAND,
    id: "work.start",
    method: "POST",
    path: `${ITEM}/start`,
    permission: "h.run.submit",
    idempotency: "required-for-services",
    request: "emptyRequest",
    response: "workAnswer",
    cliTwin: TWINS.start,
    qualifiers: [],
    ref: WORK_REF,
  },
  {
    ...HARNESS_COMMAND,
    id: "work.adopt",
    method: "POST",
    path: `${HARNESS_WORK}/adopt`,
    permission: "h.run.submit",
    idempotency: "required-for-services",
    request: "workAdoptRequest",
    response: "workAnswer",
    cliTwin: TWINS.adopt,
    qualifiers: [],
  },
] as const;

export const WORK_MACHINES = {
  work: {
    states: [...WORK_STATES],
    entry: ["proposed", "open"],
    terminal: [],
    transitions: {
      proposed: ["proposed", "open", "closed"],
      open: ["open", "closed"],
      closed: ["closed", "open"],
    },
    recoveryOwner: ALL_STATES,
  },
} as const;

export const WORK_COMMAND_KINDS = [
  kind("work.create", "h.run.submit", false, TWINS.add),
  kind("work.update", "h.run.submit", false, TWINS.edit),
  kind("work.accept", "h.run.submit", true, TWINS.accept),
  kind("work.decline", "h.run.submit", true, TWINS.decline),
  kind("work.reopen", "h.run.submit", true, TWINS.reopen),
  kind("work.cancel", "h.control", true, TWINS.cancel),
  kind("work.rank", "h.run.submit", true, TWINS.rank),
  kind("work.adopt", "h.run.submit", true, TWINS.adopt),
  kind("work.start", "h.run.submit", false, TWINS.start),
] as const;

export const WORK_EVENT_FAMILIES = [
  {
    family: "work",
    // Payloads are ids, digests and states only.
    types: [
      { type: "work.opened", sensitivity: "internal" },
      { type: "work.accepted", sensitivity: "internal" },
      { type: "work.declined", sensitivity: "internal" },
      { type: "work.updated", sensitivity: "internal" },
      { type: "work.linked", sensitivity: "internal" },
      { type: "work.ranked", sensitivity: "internal" },
      { type: "work.delivered", sensitivity: "internal" },
      { type: "work.closed", sensitivity: "internal" },
      { type: "work.reopened", sensitivity: "internal" },
    ],
  },
] as const;

export const WORK_CAPABILITY_KEYS = ["work.items"] as const;

export const WORK_REASON_CODES = { decline: [...DECLINE_REASONS] } as const;

/** Each item's content revisions: text the raw file browser never serves. */
export const WORK_RAW_EXCLUSIONS = [".crewhaus/run/control/work/items/"] as const;
