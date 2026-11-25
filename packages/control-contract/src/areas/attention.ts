/**
 * The attention area: one list of everything that needs a person across the harnesses a
 * caller may read, each item derived read-only from a record another part of the system
 * already keeps (#517, #513, module brief 331), and what a person does about one: decide
 * it, assign it, put it off, or discuss it. Static data, like every area module: the
 * closed vocabularies an item uses, the `attention` lifecycle, the operations and their
 * twins, the events its writers append, and the pure part of an item's id.
 *
 * An item's id is derived from what it is about, never minted: `attIdFromDigest` over the
 * sha256 of {@link attentionKey}, so the same evidence names the same item in every
 * process. Hashing is `@crewhaus/attention`'s, which keeps this entry free of
 * `node:crypto`. An item is home-scoped (`home/attention/att_…`), as the core declares
 * the kind, and lists the harness it is about.
 *
 * Nothing here is keyed by a kind or a failure class: Home's masker hides a value under a
 * key named like a credential (`credential`, `auth`), so every breakdown is an array of
 * rows, and template params are named around the masker's words.
 */
import { encodeBase32 } from "../base32.js";
import type { CommandReceipt } from "../commands.js";
import type { DecisionClass, DeferReason } from "../decisions.js";
import type { EmptyReason } from "../lists.js";
import { HARNESS_COMMAND, NOT_MODEL_BOUND, READ } from "../operations/shared.js";
import { deepFreeze } from "../util.js";
import type { AreaModule } from "./types.js";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** Decide: a choice is waiting. Fix: something is broken. Consider: it would run better. */
export const ATTENTION_BANDS = deepFreeze(["decide", "fix", "consider"] as const);

export type AttentionBand = (typeof ATTENTION_BANDS)[number];

/**
 * Every kind an item may be, with its band. Closed per build: a later area's kind is a
 * new row here in its own change. `decision` is a pending `dec_` decision of a kind no
 * row claims yet (a merge, a rollout), shown with its decision kind as a param.
 * `checkpoint` is a graph run paused for a decision, and `deploy-approval` a version
 * waiting on a protected environment's quorum.
 */
export const ATTENTION_KIND_ROWS = deepFreeze([
  { kind: "permission", band: "decide" },
  { kind: "question", band: "decide" },
  { kind: "review", band: "decide" },
  { kind: "standing-rule-proposal", band: "decide" },
  { kind: "quality-adoption", band: "decide" },
  { kind: "decision", band: "decide" },
  { kind: "checkpoint", band: "decide" },
  { kind: "deploy-approval", band: "decide" },
  { kind: "credential", band: "fix" },
  { kind: "provider-limit", band: "fix" },
  { kind: "budget", band: "fix" },
  { kind: "spec", band: "fix" },
  { kind: "run-failures", band: "fix" },
  { kind: "security", band: "fix" },
  { kind: "quality-regression", band: "consider" },
  { kind: "setup", band: "consider" },
] as const);

export const ATTENTION_KINDS = deepFreeze(ATTENTION_KIND_ROWS.map((row) => row.kind));

export type AttentionKind = (typeof ATTENTION_KIND_ROWS)[number]["kind"];

/** The band a kind sits in, or `undefined` for a word that is not a kind. Pure. */
export function attentionBandOf(kind: unknown): AttentionBand | undefined {
  return ATTENTION_KIND_ROWS.find((row) => row.kind === kind)?.band;
}

/** An item's lifecycle, on the `attention` machine. */
export const ATTENTION_STATES = deepFreeze([
  "open",
  "assigned",
  "deferred",
  "resolved",
  "expired",
  "superseded",
] as const);

export type AttentionState = (typeof ATTENTION_STATES)[number];

/** Where an item was read from. */
export const ATTENTION_SOURCE_KINDS = deepFreeze([
  "approval",
  "decision",
  "review",
  "advisor",
  "runs",
  "checkpoint",
  "producer",
] as const);

export type AttentionSourceKind = (typeof ATTENTION_SOURCE_KINDS)[number];

/**
 * What groups failed runs. The first three may group runs of several harnesses; the rest
 * group within one.
 */
export const CAUSE_KINDS = deepFreeze([
  "credential",
  "provider-limit",
  "deployment",
  "budget",
  "spec",
  "message",
  "failure-class",
] as const);

export type CauseKind = (typeof CAUSE_KINDS)[number];

/** The cause kinds that may group runs of more than one harness. */
export const CROSS_HARNESS_CAUSES = deepFreeze([
  "credential",
  "provider-limit",
  "deployment",
] as const);

/** How an item stopped needing a person. */
export const ATTENTION_RESOLUTIONS = deepFreeze([
  "decided",
  "cleared",
  "dismissed",
  "acted",
  "answered",
  "fallback",
] as const);

export type AttentionResolution = (typeof ATTENTION_RESOLUTIONS)[number];

/** What a piece of evidence is. */
export const ATTENTION_EVIDENCE_KINDS = deepFreeze([
  "run",
  "decision",
  "review",
  "advisor",
  "incident",
  "file",
] as const);

/**
 * Every title, why-now, reason and if-unanswered text an item may carry: closed ids that
 * each surface turns into its own words. A param is an id, a slug, a tool or model name,
 * a class or a count, never a person's text, a tool input or a model's words.
 */
export const TITLE_TEMPLATES = deepFreeze([
  // Titles
  "permission.ask",
  "question.ask",
  "review.open",
  "standing-rule-proposal.pending",
  "delegation-proposal.pending",
  "quality-adoption.pending",
  "decision.pending",
  "checkpoint.waiting",
  "deploy-approval.pending",
  "deploy-approval.ready",
  "credential.failing",
  "provider-limit.hit",
  "budget.exhausted",
  "spec.failing",
  "deployment.failing",
  "run-failures.message",
  "run-failures.class",
  "advisor.spec-unreadable",
  "advisor.preflight-blocked",
  "advisor.crash-looping",
  "advisor.parked",
  "advisor.terminal",
  "advisor.quality-regressed",
  "advisor.incident-open",
  "advisor.dream-overdue",
  "advisor.budget-exceeded",
  "advisor.budget-near",
  "advisor.budget-absent",
  "advisor.spec-issue",
  "advisor.evals-none",
  "advisor.evals-no-baseline",
  "advisor.advice-waiting",
  "advisor.policy-flip-ready",
  "advisor.candidate-underperforming",
  "advisor.audition-ready",
  "advisor.escalation-rate-high",
  "advisor.judge-spend-dominates",
  "advisor.model-retiring",
  "advisor.pin-not-served",
  "advisor.other",
  // Why now
  "why.waiting",
  "why.asked-again",
  "why.runs-failed",
  "why.review-open",
  "why.decision-open",
  "why.graph-paused",
  "why.deploy-blocked",
  "why.deploy-approved",
  "why.advisor-critical",
  "why.advisor-warn",
  "why.advisor-suggestion",
  // Recommendations
  "recommend.refused-before",
  // What a budget can do
  "budget.raise-spec",
  "budget.raise-period",
  // What a deferral did
  "note.deadline-unchanged",
  // If no one answers
  "if-unanswered.continue-independent",
  "if-unanswered.defer",
  "if-unanswered.pause-lane",
  "if-unanswered.deny",
  "if-unanswered.waits",
  "if-unanswered.expires",
] as const);

export type TitleTemplate = (typeof TITLE_TEMPLATES)[number];

// ---------------------------------------------------------------------------
// What a person may do about an item
// ---------------------------------------------------------------------------

/**
 * Every choice an item may offer, closed by its kind. `decide` and `act` are carried out
 * by `attention.resolve`: `decide` settles a record, and `act` does something about a
 * problem. `open` is a place to go, never carried out from the inbox.
 */
export const ATTENTION_CHOICE_ROWS = deepFreeze([
  { kind: "permission", choice: "grant", does: "decide" },
  { kind: "permission", choice: "deny", does: "decide" },
  { kind: "permission", choice: "grant-always", does: "decide" },
  { kind: "permission", choice: "grant-propose", does: "decide" },
  { kind: "review", choice: "pass", does: "decide" },
  { kind: "review", choice: "fail", does: "decide" },
  { kind: "review", choice: "up", does: "decide" },
  { kind: "review", choice: "down", does: "decide" },
  { kind: "standing-rule-proposal", choice: "grant", does: "decide" },
  { kind: "standing-rule-proposal", choice: "deny", does: "decide" },
  { kind: "standing-rule-proposal", choice: "review", does: "open" },
  { kind: "quality-adoption", choice: "grant", does: "decide" },
  { kind: "quality-adoption", choice: "deny", does: "decide" },
  { kind: "quality-adoption", choice: "adopt", does: "open" },
  { kind: "decision", choice: "grant", does: "decide" },
  { kind: "decision", choice: "deny", does: "decide" },
  { kind: "checkpoint", choice: "approve", does: "decide" },
  { kind: "checkpoint", choice: "reject", does: "decide" },
  { kind: "deploy-approval", choice: "approve", does: "decide" },
  { kind: "deploy-approval", choice: "deny", does: "decide" },
  { kind: "deploy-approval", choice: "promote", does: "act" },
  { kind: "credential", choice: "acknowledge", does: "act" },
  { kind: "credential", choice: "inspect", does: "open" },
  { kind: "provider-limit", choice: "acknowledge", does: "act" },
  { kind: "provider-limit", choice: "inspect", does: "open" },
  { kind: "budget", choice: "raise-spec", does: "open" },
  { kind: "budget", choice: "raise-period", does: "open" },
  { kind: "budget", choice: "wait-for-renewal", does: "act" },
  { kind: "budget", choice: "acknowledge", does: "act" },
  { kind: "budget", choice: "act", does: "act" },
  { kind: "budget", choice: "open", does: "open" },
  { kind: "spec", choice: "acknowledge", does: "act" },
  { kind: "spec", choice: "inspect", does: "open" },
  { kind: "spec", choice: "act", does: "act" },
  { kind: "spec", choice: "open", does: "open" },
  { kind: "run-failures", choice: "acknowledge", does: "act" },
  { kind: "run-failures", choice: "inspect", does: "open" },
  { kind: "security", choice: "act", does: "act" },
  { kind: "security", choice: "open", does: "open" },
  { kind: "quality-regression", choice: "act", does: "act" },
  { kind: "quality-regression", choice: "open", does: "open" },
  { kind: "setup", choice: "act", does: "act" },
  { kind: "setup", choice: "open", does: "open" },
] as const);

/** Every choice id, once, in the order the rows list them. */
export const ATTENTION_CHOICE_IDS: readonly string[] = deepFreeze([
  ...new Set(ATTENTION_CHOICE_ROWS.map((row) => row.choice)),
]);

/** The choices `attention.resolve` carries out. */
export const ATTENTION_ACT_CHOICES: readonly string[] = deepFreeze([
  ...new Set(
    ATTENTION_CHOICE_ROWS.filter((row) => row.does !== "open").map((row) => row.choice as string),
  ),
]);

/** What a kind's choice does, or `undefined` for a choice the kind does not offer. Pure. */
export function attentionChoiceDoes(
  kind: unknown,
  choice: unknown,
): "decide" | "act" | "open" | undefined {
  return ATTENTION_CHOICE_ROWS.find((row) => row.kind === kind && row.choice === choice)?.does;
}

/** Why a person sets a problem or a suggestion aside. */
export const DISMISS_REASONS = deepFreeze([
  "not-a-problem",
  "known",
  "handled-elsewhere",
  "not-now",
  "other",
] as const);

export type DismissReason = (typeof DISMISS_REASONS)[number];

/** What a person did about an item, as its actions line and its event name it. */
export const ATTENTION_ACTION_EVENTS = deepFreeze([
  "resolved",
  "assigned",
  "unassigned",
  "deferred",
  "undeferred",
  "snoozed",
  "dismissed",
  "reopened",
  "acknowledged",
  "message",
] as const);

export type AttentionActionEvent = (typeof ATTENTION_ACTION_EVENTS)[number];

/** A discussion message holds at most this many bytes. */
export const ATTENTION_MESSAGE_MAX_BYTES = 8 * 1024;

/** A note beside a verdict or a dismissal holds at most this many bytes. */
export const ATTENTION_NOTE_MAX_BYTES = 2 * 1024;

// ---------------------------------------------------------------------------
// The protected-environment quorum
// ---------------------------------------------------------------------------

/**
 * The kind of the `dec_` decision that asks a protected environment's quorum whether a
 * version may go there, opened when a promotion or an activation is blocked.
 */
export const DEPLOY_QUORUM_KIND = "deploy-quorum";

/** A registered spec's name, as an item or a command may hold it. */
export const SPEC_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** An environment's name, the same way. */
export const ENVIRONMENT_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/** A registered version, or a deployment's id. */
export const SPEC_VERSION_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** A spec's content revision, `sha256:` and 64 hex. */
export const SPEC_REVISION_RE = /^sha256:[0-9a-f]{64}$/;

/** What a quorum decision is about: one version of one spec, for one environment. */
export type DeployQuorumSubject = {
  readonly spec: string;
  readonly environment: string;
  readonly version: string;
  /** The content an approval binds: `sha256:` and 64 hex. */
  readonly specHash: string;
};

// ---------------------------------------------------------------------------
// The item
// ---------------------------------------------------------------------------

/** A closed template and its params: ids, slugs, names, classes and counts only. */
export type AttentionText = {
  readonly template: string;
  readonly params: Readonly<Record<string, string | number>>;
};

export type AttentionEvidence = {
  readonly kind: string;
  readonly ref: string;
  readonly label: string;
};

/** One way to settle an item, with who may take it and the command that does, when one does. */
export type AttentionChoice = {
  readonly id: string;
  readonly needs: DecisionClass;
  readonly cliTwin: string | null;
  /** Why there is no command, when there is none. */
  readonly nullReason?: string;
  /** The permission this choice needs beyond the one to decide. */
  readonly permission?: string;
};

export type AttentionCause = {
  readonly id: string;
  readonly kind: CauseKind;
  /** A plain label built from the cause's own names (a provider, an env name, a class). */
  readonly label: string;
};

export type AttentionFreshness = {
  readonly asOf: string;
  readonly mode: "projection" | "direct-fold";
  /** The read stopped at its caps: the answer is behind the records. */
  readonly stale?: boolean;
  /** What this read could not do, in plain words (messages unreadable, say). */
  readonly note?: string;
};

export type AttentionItem = {
  /** `home/attention/att_…`. */
  readonly ref: string;
  readonly kind: AttentionKind;
  readonly band: AttentionBand;
  /** The harness it is about; a group across harnesses lists them in `harnesses`. */
  readonly harness?: string;
  readonly harnesses?: readonly string[];
  readonly source: { readonly kind: AttentionSourceKind; readonly id: string };
  readonly title: AttentionText;
  readonly whyNow: AttentionText;
  /** The newest runs it affects (at most 50) and how many there are. */
  readonly affected: { readonly runs: readonly string[]; readonly count: number };
  readonly evidence: readonly AttentionEvidence[];
  readonly choices: readonly AttentionChoice[];
  readonly recommendation?: { readonly choiceId: string; readonly reason: AttentionText };
  /** Only a real deadline: one an agreement set, or the record's time to live. */
  readonly deadline?: { readonly at: string; readonly source: "agreement" | "ttl" };
  readonly ifUnanswered?: { readonly template: string };
  readonly requiredClass: DecisionClass;
  readonly state: AttentionState;
  readonly resolution?: {
    readonly how: AttentionResolution;
    readonly at: string;
    readonly via?: string;
  };
  readonly cause?: AttentionCause;
  /** The first characters of the decision's binding digest, when it has one. */
  readonly binding?: { readonly digestPrefix: string };
  /** Moves only when the evidence does: 16 hex characters. */
  readonly evidenceRev: string;
  /** The oldest evidence time, never when the item was first seen. */
  readonly since: string;
  /** How many asks this one folds, and when the same ask was last refused. */
  readonly asks?: { readonly count: number; readonly refusedAt?: string };
  /** The item this one replaced. */
  readonly previous?: string;
  /** Tool input, question text or an excerpt: only for a caller who may read the content. */
  readonly body?: unknown;
  /** There is content this caller may not read. */
  readonly bodyWithheld?: true;
  /** `people` when it is about a person's records: Home withholds it from a caller who may not see those. */
  readonly sensitivity?: "people";
  /** The member it is assigned to. Assignment grants nothing. */
  readonly assignee?: string;
  /**
   * Put off until then. `deadlineMoved`: its own deadline moved with it (a request); a
   * problem or a decision with no such move is hidden from the open list until then.
   */
  readonly deferral?: {
    readonly until: string;
    readonly reasonCode?: DeferReason;
    readonly deadlineMoved: boolean;
  };
  /** Hidden from this viewer's open list until then. */
  readonly snoozedUntil?: string;
  /** It was dismissed or acknowledged, and newer evidence opened it again. */
  readonly previously?: {
    readonly how: AttentionResolution;
    readonly at: string;
    readonly evidenceRev: string;
  };
  /** Recorded actions that its lifecycle does not allow: kept, counted, never applied. */
  readonly anomalies?: number;
  readonly freshness: AttentionFreshness;
};

/** A verdict on an item: one of its choices, and what it was read as. */
export type AttentionResolveRequest = {
  readonly choice: string;
  /** The item's state or evidence revision when it was read. */
  readonly expect?: string;
  readonly note?: string;
};

export type AttentionAssignRequest = {
  /** The member to assign it to. */
  readonly to: string;
};

export type AttentionDeferRequest = {
  readonly until: string;
  readonly reason: DeferReason;
};

export type AttentionSnoozeRequest = {
  readonly harness: string;
  readonly until: string;
};

export type AttentionDismissRequest = {
  readonly reasonCode: DismissReason;
  readonly note?: string;
};

export type AttentionNoteRequest = {
  readonly note?: string;
};

export type AttentionMessageRequest = {
  readonly text: string;
};

/** An action's answer: its receipt, and the item as the action left it. */
export type AttentionActed = {
  readonly receipt: CommandReceipt;
  /** `home/attention/att_…`. */
  readonly ref: string;
  readonly harness: string;
  readonly event: AttentionActionEvent;
  readonly state: AttentionState;
  /** What else happened, as a closed sentence (a job was queued, say). */
  readonly detail?: string;
  /** The job a choice queued. */
  readonly job?: string;
};

/** One message of an item's discussion. */
export type AttentionMessage = {
  readonly at: string;
  /** The writer, as a stored actor. */
  readonly by: string;
  readonly via: string;
  readonly text: string;
};

export type AttentionMessages = {
  readonly ref: string;
  readonly items: readonly AttentionMessage[];
  readonly truncated?: { readonly reason: string; readonly verb?: string };
  readonly empty?: { readonly reason: EmptyReason; readonly remedy?: string };
};

export type AttentionListQuery = {
  readonly harness?: string;
  readonly kind?: AttentionKind;
  readonly band?: AttentionBand;
  /** `open` (the default) lists what still needs a person; `all` adds what ended. */
  readonly state?: "open" | "all";
  readonly limit?: number;
  readonly cursor?: string;
};

/** What the reader may do about the items of one harness. Home decides again as they act. */
export type AttentionYou = {
  readonly harness: string;
  /** They may act on its items: decide, assign, put off, set aside, discuss. */
  readonly act: boolean;
  /** The highest class they decide at here; `null` when they decide nothing. */
  readonly class: DecisionClass | null;
  /** They may read what its items hold, and its discussions. */
  readonly content: boolean;
  /** Which of the permissions this answer's choices name they hold here. */
  readonly can: readonly string[];
};

export type AttentionList = {
  readonly items: readonly AttentionItem[];
  readonly next?: string;
  readonly snapshotAt: string;
  readonly truncated?: { readonly reason: string; readonly verb?: string };
  readonly empty?: { readonly reason: EmptyReason; readonly remedy?: string };
  /** Harnesses whose decisions cannot be read here, whether or not anything is listed. */
  readonly unreachable?: readonly string[];
  /** Harnesses Home has not gathered Advisor findings for yet. */
  readonly advisorUnchecked?: readonly string[];
  /** The name of every harness this answer mentions, for display. */
  readonly names?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** What the reader may do in each harness this answer's items are about. Home's alone. */
  readonly you?: readonly AttentionYou[];
};

export type AttentionMetricsQuery = {
  readonly harness?: string;
  /** A window like `30d`, `12h` or `90m`; 30 days when absent. */
  readonly since?: string;
};

/** Open items of one kind, and how long they have waited (milliseconds). */
export type AttentionOpenRow = {
  readonly kind: string;
  readonly open: number;
  readonly p50Ms: number | null;
  readonly p90Ms: number | null;
};

/** Settled decisions of one kind, and how long they took. */
export type AttentionResolutionRow = {
  readonly kind: string;
  readonly resolved: number;
  readonly p50Ms: number | null;
  readonly p90Ms: number | null;
};

/** Settled decisions by the door they came through. */
export type AttentionViaRow = {
  readonly decidedVia: string;
  readonly resolved: number;
  readonly p50Ms: number | null;
  readonly p90Ms: number | null;
};

export type AttentionMetrics = {
  readonly since: string;
  readonly asOf: string;
  readonly harnesses: number;
  readonly open: readonly AttentionOpenRow[];
  readonly resolution: readonly AttentionResolutionRow[];
  readonly resolutionByVia: readonly AttentionViaRow[];
  /** Decisions an agreement's fallback settled because no one did. */
  readonly fallbacks: number;
  /** Asks repeated within 30 days of the same ask. */
  readonly reasks: number;
  readonly unreachable?: readonly string[];
};

/** A harness row's attention counts, served under `areas.attention`. */
export type AttentionOverview = {
  readonly decide: number;
  readonly fix: number;
  readonly consider: number;
  readonly unreachable?: true;
};

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** `att_` and 26 Crockford characters. */
export const ATTENTION_ID_RE = /^att_[0-9a-hjkmnp-tv-z]{26}$/;

/**
 * The text an item's id is the digest of: `v1|<scope>|<kind>|<key>`. `scope` is the
 * harness id, or `home` for a group across harnesses; `key` holds only ids, kinds, names,
 * classes and digests. Pure.
 */
export function attentionKey(scope: string, kind: string, key: string): string {
  return `v1|${scope}|${kind}|${key}`;
}

/** `att_` and the first 26 base32 characters of a digest (at least 17 bytes). Pure. */
export function attIdFromDigest(bytes: Uint8Array): string {
  if (bytes.length < 17)
    throw new RangeError("control-contract: an att_ id needs 17 or more digest bytes");
  return `att_${encodeBase32(bytes).slice(0, 26)}`;
}

/** The ref of an item id. Pure. */
export function attentionRef(id: string): string {
  return `home/attention/${id}`;
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const TWINS = {
  list: { argv: ["inbox", "list"] },
  show: { argv: ["inbox", "show", "{att}"] },
  stats: { argv: ["inbox", "stats"] },
  decide: { argv: ["inbox", "decide", "{att}", "{attChoice}"] },
  assign: { argv: ["inbox", "assign", "{att}", "--to", "{prn}"] },
  unassign: { argv: ["inbox", "unassign", "{att}"] },
  defer: {
    argv: ["inbox", "defer", "{att}", "--until", "{until}", "--reason", "{deferReason}"],
  },
  undefer: { argv: ["inbox", "undefer", "{att}"] },
  snooze: { argv: ["inbox", "snooze", "{att}", "--until", "{until}"] },
  dismiss: { argv: ["inbox", "dismiss", "{att}", "--reason", "{dismissReason}"] },
  reopen: { argv: ["inbox", "reopen", "{att}"] },
  acknowledge: { argv: ["inbox", "acknowledge", "{att}"] },
  messages: { argv: ["inbox", "show", "{att}", "--messages"] },
  graphResume: {
    argv: ["runs", "resume", "{grun}", "--decision", "{graphDecision}", "--harness", "{hrn}"],
  },
  deployApprove: {
    argv: [
      "deploy",
      "approve",
      "{specName}",
      "--env",
      "{env}",
      "--version",
      "{version}",
      "--harness",
      "{hrn}",
    ],
  },
} as const;

/** The commands an item's choices show beside `inbox decide`: a pause's, and a quorum's. */
export const ATTENTION_TWINS = deepFreeze({
  graphResume: TWINS.graphResume,
  deployApprove: TWINS.deployApprove,
  decide: TWINS.decide,
  show: TWINS.show,
});

/** Why a message has no twin: its text is never a command's argument. */
const MESSAGE_TWIN_REASON =
  "The message goes in a file you choose: `crewhaus inbox discuss <att> --file <path>`.";

const OPEN_ONWARD = ["resolved", "expired", "superseded"] as const;

/** One item, acted on in one harness it is about: the router checks that harness. */
const ITEM_PATH = "/api/v1/harnesses/{h}/attention/{ref}";

const ACTED = { ...HARNESS_COMMAND, response: "attentionActed" } as const;

const DECIDES = "h.decision.resolve";

export const ATTENTION_MODULE = {
  area: "attention",
  operations: [
    {
      ...READ,
      id: "attention.list",
      method: "GET",
      path: "/api/v1/attention",
      permission: "home.read",
      request: "attentionListQuery",
      response: "attentionList",
      cliTwin: TWINS.list,
      qualifiers: ["filtered", "content-fields"],
    },
    {
      ...READ,
      id: "attention.metrics",
      method: "GET",
      path: "/api/v1/attention/metrics",
      permission: "home.read",
      request: "attentionMetricsQuery",
      response: "attentionMetrics",
      cliTwin: TWINS.stats,
      qualifiers: ["filtered"],
    },
    {
      ...READ,
      id: "attention.get",
      method: "GET",
      path: "/api/v1/attention/{ref}",
      // An item is home-scoped, so its ref names no harness: a harness permission would be
      // refused to every member. The handler looks only in the harnesses the caller reads.
      permission: "home.read",
      request: "noBody",
      response: "attentionItem",
      cliTwin: TWINS.show,
      qualifiers: ["filtered", "content-fields"],
    },
    {
      ...ACTED,
      id: "attention.resolve",
      method: "POST",
      path: `${ITEM_PATH}/resolve`,
      permission: DECIDES,
      request: "attentionResolveRequest",
      cliTwin: TWINS.decide,
      qualifiers: ["class"],
      modelBound: { expect: NOT_MODEL_BOUND.revision, note: NOT_MODEL_BOUND.note },
    },
    {
      ...ACTED,
      id: "attention.assign",
      method: "POST",
      path: `${ITEM_PATH}/assign`,
      permission: DECIDES,
      request: "attentionAssignRequest",
      cliTwin: TWINS.assign,
      qualifiers: [],
    },
    {
      ...ACTED,
      id: "attention.unassign",
      method: "POST",
      path: `${ITEM_PATH}/unassign`,
      permission: DECIDES,
      request: "emptyRequest",
      cliTwin: TWINS.unassign,
      qualifiers: [],
    },
    {
      ...ACTED,
      id: "attention.defer",
      method: "POST",
      path: `${ITEM_PATH}/defer`,
      permission: DECIDES,
      request: "attentionDeferRequest",
      cliTwin: TWINS.defer,
      qualifiers: ["class"],
    },
    {
      ...ACTED,
      id: "attention.undefer",
      method: "POST",
      path: `${ITEM_PATH}/undefer`,
      permission: DECIDES,
      request: "emptyRequest",
      cliTwin: TWINS.undefer,
      qualifiers: ["class"],
    },
    {
      ...ACTED,
      id: "attention.snooze",
      method: "POST",
      path: "/api/v1/me/attention/{ref}/snooze",
      // A snooze hides an item from its own viewer only; the handler also asks that the
      // caller may read the harness the body names.
      permission: "self.preferences",
      request: "attentionSnoozeRequest",
      cliTwin: TWINS.snooze,
      qualifiers: ["self"],
    },
    {
      ...ACTED,
      id: "attention.dismiss",
      method: "POST",
      path: `${ITEM_PATH}/dismiss`,
      permission: DECIDES,
      request: "attentionDismissRequest",
      cliTwin: TWINS.dismiss,
      qualifiers: [],
      modelBound: { note: NOT_MODEL_BOUND.note },
    },
    {
      ...ACTED,
      id: "attention.reopen",
      method: "POST",
      path: `${ITEM_PATH}/reopen`,
      permission: DECIDES,
      request: "attentionNoteRequest",
      cliTwin: TWINS.reopen,
      qualifiers: [],
      modelBound: { note: NOT_MODEL_BOUND.note },
    },
    {
      ...ACTED,
      id: "attention.acknowledge",
      method: "POST",
      path: `${ITEM_PATH}/acknowledge`,
      permission: DECIDES,
      request: "attentionNoteRequest",
      cliTwin: TWINS.acknowledge,
      qualifiers: [],
      modelBound: { note: NOT_MODEL_BOUND.note },
    },
    {
      ...READ,
      id: "attention.messages.list",
      method: "GET",
      path: `${ITEM_PATH}/messages`,
      permission: "h.read.content",
      request: "noBody",
      response: "attentionMessages",
      cliTwin: TWINS.messages,
      qualifiers: [],
    },
    {
      ...ACTED,
      id: "attention.messages.add",
      method: "POST",
      path: `${ITEM_PATH}/messages`,
      permission: DECIDES,
      request: "attentionMessageRequest",
      cliTwin: null,
      noTwinReason: MESSAGE_TWIN_REASON,
      qualifiers: [],
      modelBound: { text: NOT_MODEL_BOUND.note },
    },
  ],
  refKinds: [],
  eventFamilies: [
    {
      family: "attention",
      types: [
        { type: "attention.resolved", sensitivity: "internal" },
        { type: "attention.assigned", sensitivity: "internal" },
        { type: "attention.unassigned", sensitivity: "internal" },
        { type: "attention.deferred", sensitivity: "internal" },
        { type: "attention.undeferred", sensitivity: "internal" },
        // Which member hid what from themselves is that member's own.
        { type: "attention.snoozed", sensitivity: "restricted" },
        { type: "attention.dismissed", sensitivity: "internal" },
        { type: "attention.reopened", sensitivity: "internal" },
        { type: "attention.acknowledged", sensitivity: "internal" },
        { type: "attention.message", sensitivity: "internal" },
      ],
    },
  ],
  machines: {
    attention: {
      states: [...ATTENTION_STATES],
      entry: ["open"],
      terminal: ["resolved", "expired", "superseded"],
      transitions: {
        open: ["assigned", "deferred", ...OPEN_ONWARD],
        assigned: ["open", "deferred", ...OPEN_ONWARD],
        deferred: ["open", "assigned", ...OPEN_ONWARD],
        resolved: [],
        expired: [],
        superseded: [],
      },
      recoveryOwner: {
        open: "operator",
        assigned: "operator",
        deferred: "operator",
        resolved: "none",
        expired: "none",
        superseded: "none",
      },
    },
  },
  commandKinds: [
    {
      id: "attention.resolve",
      permission: DECIDES,
      idempotent: false,
      effect: "local",
      cliTwin: TWINS.decide,
    },
    {
      id: "attention.assign",
      permission: DECIDES,
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.assign,
    },
    {
      id: "attention.unassign",
      permission: DECIDES,
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.unassign,
    },
    {
      id: "attention.defer",
      permission: DECIDES,
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.defer,
    },
    {
      id: "attention.undefer",
      permission: DECIDES,
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.undefer,
    },
    {
      id: "attention.snooze",
      permission: "self.preferences",
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.snooze,
    },
    {
      id: "attention.dismiss",
      permission: DECIDES,
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.dismiss,
    },
    {
      id: "attention.reopen",
      permission: DECIDES,
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.reopen,
    },
    {
      id: "attention.acknowledge",
      permission: DECIDES,
      idempotent: true,
      effect: "local",
      cliTwin: TWINS.acknowledge,
    },
    {
      id: "attention.messages.add",
      permission: DECIDES,
      idempotent: false,
      effect: "local",
      cliTwin: null,
    },
    {
      id: "graphs.resume",
      permission: "h.run.submit",
      idempotent: false,
      effect: "local",
      cliTwin: TWINS.graphResume,
      noRowReason: "Home settles a pause through attention.resolve; the CLI submits this itself.",
    },
    {
      id: "deployments.approve",
      permission: DECIDES,
      idempotent: false,
      effect: "local",
      cliTwin: TWINS.deployApprove,
      noRowReason: "Home records a vote through attention.resolve; the CLI submits this itself.",
    },
  ],
  permissions: [],
} as const satisfies AreaModule;
