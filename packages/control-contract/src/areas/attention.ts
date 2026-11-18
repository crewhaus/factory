/**
 * The attention area: one list of everything that needs a person across the harnesses a
 * caller may read, each item derived read-only from a record another part of the system
 * already keeps (#517, #513, module brief 331). Static data, like every area module: the
 * closed vocabularies an item uses, the `attention` lifecycle, the three read operations
 * and their twins, and the pure part of an item's id.
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
import type { DecisionClass } from "../decisions.js";
import type { EmptyReason } from "../lists.js";
import { READ } from "../operations/shared.js";
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
 */
export const ATTENTION_KIND_ROWS = deepFreeze([
  { kind: "permission", band: "decide" },
  { kind: "question", band: "decide" },
  { kind: "review", band: "decide" },
  { kind: "standing-rule-proposal", band: "decide" },
  { kind: "quality-adoption", band: "decide" },
  { kind: "decision", band: "decide" },
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
  "why.advisor-critical",
  "why.advisor-warn",
  "why.advisor-suggestion",
  // Recommendations
  "recommend.refused-before",
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
  readonly freshness: AttentionFreshness;
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
} as const;

const OPEN_ONWARD = ["resolved", "expired", "superseded"] as const;

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
  ],
  refKinds: [],
  eventFamilies: [],
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
  commandKinds: [],
  permissions: [],
} as const satisfies AreaModule;
