/**
 * `@crewhaus/control-contract/delegation`: the pure half of a delegation rule. What a
 * rule reads as now, whether it may resolve one decision, the consequences page an owner
 * confirms, and the words every surface shows for who decided. Nothing here opens a
 * file, reads a clock or makes a digest: a caller passes the records it read and the
 * time, and takes the digest of `material` itself.
 *
 * The main entry never imports this one. It reaches only its own file and files the main
 * entry reaches, so it carries no package and no builtin.
 *
 * Bad input never throws from a check: a time that cannot be read counts as passed, and
 * a check that cannot be made refuses. The renderer throws on a template it does not
 * know or a parameter of the wrong shape, because both are a programmer's error.
 */
import {
  DELEGATION_ACTIONS,
  DELEGATION_RULE_REASONS,
  type DelegableDecisionKind,
  type DelegationAction,
  type DelegationRuleRow,
  type DelegationScopeValue,
  type DelegationTerms,
  type DelegationTermsRequest,
  LIVE_RULE_STATES,
  SUSPEND_REASONS,
  type SuspendReason,
} from "./areas/delegation.js";
import { deepFreeze } from "./util.js";

// ---------------------------------------------------------------------------
// Lengths
// ---------------------------------------------------------------------------

/** How long a rule lasts when its terms name no length (and the ceiling allows it). */
export const DELEGATION_DEFAULT_DAYS = 14;
/** The longest any rule may last, whatever the ceiling says. */
export const DELEGATION_MAX_DAYS = 90;
/** The ceiling's `max_days` when the agreement names none. */
export const DELEGATION_DEFAULT_CEILING_DAYS = 30;
/** The most uses a rule may be capped at. */
export const DELEGATION_MAX_USES = 10_000;

// ---------------------------------------------------------------------------
// Gates, watches and rollbacks
// ---------------------------------------------------------------------------

/** The held-out gates an action may require. Closed. */
export const GATE_IDS = deepFreeze([
  "scope",
  "host",
  "acceptance",
  "held_out",
  "one_at_a_time",
  "rehearsal",
  "policy",
  "activation",
  "routine",
  "comparison",
  "fresh",
] as const);

export type GateId = (typeof GATE_IDS)[number];

/** A gate's answer. Only `pass` passes; `pending` waits for the next pass. */
export const GATE_OUTCOMES = deepFreeze([
  "pass",
  "fail",
  "not-comparable",
  "not-run",
  "pending",
  "unknown",
] as const);

export type GateOutcome = (typeof GATE_OUTCOMES)[number];

/** Why a gate did not pass, from a closed list. */
export const GATE_REASONS = deepFreeze([
  "checks_failed",
  "checks_missing",
  "holdout_absent",
  "protected_path",
  "review_required",
  "over_limit",
  "not_routine",
  "stale",
  "no_evidence",
  "gate_error",
] as const);

export type GateReason = (typeof GATE_REASONS)[number];

/**
 * One gate's verdict, evaluated by the control plane over evidence the agent cannot
 * write. `boundTo` names the exact subject revision evaluated; a verdict past
 * `freshUntil` counts as unknown.
 */
export type GateVerdict = {
  readonly gate: GateId;
  readonly outcome: GateOutcome;
  readonly boundTo: string;
  /** Refs to the evidence, never its content. */
  readonly evidence: readonly string[];
  readonly at: string;
  readonly freshUntil: string;
  readonly reason?: GateReason;
};

/** What a watch reads while it is open. Closed. */
export const SIGNAL_IDS = deepFreeze([
  "base-checks",
  "eval-regression",
  "crash-loop",
  "slo-breach",
  "failure-spike",
] as const);

export type SignalId = (typeof SIGNAL_IDS)[number];

/** How to undo a delegated action, planned and persisted before the action runs. */
export type RollbackPlan =
  | {
      readonly kind: "revert";
      readonly binding: string;
      readonly pr: number;
      readonly mergeSha?: string;
      readonly base: string;
      readonly method: string;
    }
  | {
      readonly kind: "previous-deployment";
      readonly from: string;
      readonly to: string;
      readonly toDigest: string;
      readonly change?: string;
    };

/** A watch over one delegated action, named by the receipt id of the command that acted. */
export type Watch = {
  readonly rule: string;
  readonly revision: number;
  readonly action: DelegationAction;
  readonly subject: { readonly ref: string; readonly revision: string };
  readonly cmd: string;
  readonly startedAt: string;
  readonly until: string;
  readonly signals: readonly SignalId[];
  readonly plan: RollbackPlan;
};

/** What a watch's signals say on one read: a signal with no data is `unknown`, never healthy. */
export type SignalReading = "regression" | "healthy" | "unknown";

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * Why a rule did not apply to a decision: one or more per authorizer check, in check
 * order. The gate reasons (`gates-pending`, `gates-refused`) are logged as `refused`;
 * the rest as `not-applied`.
 */
export const NOT_APPLIED_REASONS = deepFreeze([
  "rule-inactive",
  "kind-not-claimed",
  "not-ship-class",
  "policy-changed",
  "ceiling-changed",
  "out-of-scope",
  "owner-authority-changed",
  "owner-unknown",
  "operator-closed",
  "gates-pending",
  "gates-refused",
  "uses-exhausted",
  "one-at-a-time",
] as const);

export type NotAppliedReason = (typeof NOT_APPLIED_REASONS)[number];

/** Every `reason` an application line may carry. Closed. */
export const DELEGATION_LOG_REASONS = deepFreeze([
  ...new Set([
    ...NOT_APPLIED_REASONS,
    ...DELEGATION_RULE_REASONS,
    "rollback_unavailable",
    "not-measured",
    "kept-by-member",
    "effect-failed",
    "rule-revoked",
    "revision-changed",
    "paused",
    "already-spent",
    "decision-expired",
    "regression",
  ]),
] as const);

/** Which decision kinds each action resolves. An action with none resolves nothing yet. */
export const ACTION_CLAIMS: Readonly<Record<DelegationAction, readonly DelegableDecisionKind[]>> =
  deepFreeze({
    merge: ["merge"],
    rollout: ["rollout"],
    adopt: [],
    assistant: [],
  });

// ---------------------------------------------------------------------------
// effectiveRuleState
// ---------------------------------------------------------------------------

export type EffectiveRuleState = {
  readonly state: "active" | "suspended" | "revoked" | "expired" | "exhausted";
  /** `false` only when a read computed `expired` or `exhausted` and no writer recorded it. */
  readonly materialized: boolean;
  readonly revision: number;
};

function timeOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function countOf(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

/**
 * What a rule reads as now: `active` only while its row is `enabled`, `revised` or
 * `resumed`, `now` is before its end and its uses are under its cap. Past the end it
 * reads `expired`, at the cap `exhausted`, unmaterialized until a writer records it. An
 * end or a `now` that cannot be read counts as passed; uses that cannot be read count as
 * the cap.
 */
export function effectiveRuleState(
  row: Pick<DelegationRuleRow, "state" | "expiresAt" | "revision"> & { readonly maxUses?: number },
  now: number,
  uses: number,
): EffectiveRuleState {
  if (typeof row !== "object" || row === null) {
    return { state: "expired", materialized: false, revision: 0 };
  }
  const revision = countOf(row.revision) ?? 0;
  const settled = (state: EffectiveRuleState["state"]): EffectiveRuleState => ({
    state,
    materialized: true,
    revision,
  });
  if (row.state === "revoked") return settled("revoked");
  if (row.state === "expired") return settled("expired");
  if (row.state === "exhausted") return settled("exhausted");
  const live = (LIVE_RULE_STATES as readonly string[]).includes(row.state);
  if (!live && row.state !== "suspended") {
    return { state: "expired", materialized: false, revision };
  }
  const ends = timeOf(row.expiresAt);
  if (ends === undefined || !Number.isFinite(now) || now >= ends) {
    return { state: "expired", materialized: false, revision };
  }
  if (row.maxUses !== undefined) {
    const cap = countOf(row.maxUses);
    const used = countOf(uses);
    if (cap === undefined || used === undefined || used >= cap) {
      return { state: "exhausted", materialized: false, revision };
    }
  }
  return settled(live ? "active" : "suspended");
}

// ---------------------------------------------------------------------------
// authorizeDelegated
// ---------------------------------------------------------------------------

/** The operator's intake verdict, as control-records answers it. */
export type OperatorGate =
  | { readonly state: "open" }
  | { readonly state: "closed"; readonly code?: string };

export type AuthorizeInput = {
  readonly decision: { readonly kind?: unknown; readonly actionClass?: unknown };
  readonly rule: Pick<DelegationRuleRow, "action" | "policyRevision" | "ceilingDigest"> & {
    readonly maxUses?: number;
  };
  readonly ruleState: EffectiveRuleState;
  /** The active deployment's ceiling digest and policy revision; absent without one. */
  readonly ceiling: { readonly digest?: string; readonly policyRevision?: string } | undefined;
  /** The subject, its revision, and whether the rule's scope (inside the ceiling) holds it. */
  readonly subject: { readonly revision: string; readonly inScope: boolean };
  /** The gates the action requires, from its registration. Never from the terms. */
  readonly requiredGates: readonly GateId[];
  readonly verdicts: readonly GateVerdict[];
  readonly operator: OperatorGate;
  /** Whether the enabling owner still holds the owner's authority; `undefined`: unknown. */
  readonly ownerHolds: boolean | undefined;
  readonly now: number;
  /** How many times the rule has acted. */
  readonly uses: number;
  /** The action's own one-at-a-time condition. */
  readonly oneAtATime: boolean;
};

export type AuthorizeAnswer =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly reason: NotAppliedReason;
      /** The check that refused, 1 to 6. */
      readonly step: 1 | 2 | 3 | 4 | 5 | 6;
      /** Set when the refusal also suspends the rule. */
      readonly suspend?: SuspendReason;
    };

const ALLOW: AuthorizeAnswer = Object.freeze({ allow: true });

function deny(
  step: 1 | 2 | 3 | 4 | 5 | 6,
  reason: NotAppliedReason,
  suspend?: SuspendReason,
): AuthorizeAnswer {
  return { allow: false, reason, step, ...(suspend !== undefined ? { suspend } : {}) };
}

/** A gate's verdict counts only when it passed, for this revision, and is still fresh. */
function gateAnswer(
  gate: GateId,
  verdicts: readonly GateVerdict[],
  revision: string,
  now: number,
): "pass" | "pending" | "refused" {
  const verdict = Array.isArray(verdicts) ? verdicts.find((v) => v?.gate === gate) : undefined;
  if (verdict === undefined) return "refused";
  if (verdict.outcome === "pending") return "pending";
  if (verdict.outcome !== "pass") return "refused";
  if (typeof revision !== "string" || revision === "" || verdict.boundTo !== revision) {
    return "refused";
  }
  const fresh = timeOf(verdict.freshUntil);
  if (fresh === undefined || !Number.isFinite(now) || now >= fresh) return "refused";
  return "pass";
}

/**
 * Whether a rule may resolve one decision now. Six checks, in order; the first failure
 * wins:
 *
 * 1. the rule is active, its action claims the decision's kind, and the decision is
 *    `ship`-class;
 * 2. the rule is bound to the active deployment's ceiling and policy revision (else it is
 *    suspended), and the subject is inside the rule's scope (which never suspends);
 * 3. the enabling owner still holds the owner's authority (`false` suspends; could not
 *    tell refuses and suspends nothing);
 * 4. the operator lets new work in;
 * 5. every gate the action requires passed, for this exact revision, and is still fresh
 *    (`pending` waits for the next pass);
 * 6. the rule's uses are under its cap and the action's one-at-a-time condition holds.
 *
 * The rule never denies anything: a refusal leaves the decision for a person.
 */
export function authorizeDelegated(input: AuthorizeInput): AuthorizeAnswer {
  const { decision, rule, ruleState, ceiling, subject } = input;
  if (ruleState?.state !== "active") return deny(1, "rule-inactive");
  const claims = (ACTION_CLAIMS as Readonly<Record<string, readonly string[]>>)[
    String(rule?.action)
  ];
  if (claims === undefined || !claims.includes(String(decision?.kind))) {
    return deny(1, "kind-not-claimed");
  }
  if (decision?.actionClass !== "ship") return deny(1, "not-ship-class");

  if (ceiling?.digest === undefined || ceiling.digest !== rule.ceilingDigest) {
    return deny(2, "ceiling-changed", "ceiling-changed");
  }
  if (ceiling.policyRevision === undefined || ceiling.policyRevision !== rule.policyRevision) {
    return deny(2, "policy-changed", "policy-changed");
  }
  if (subject?.inScope !== true) return deny(2, "out-of-scope");

  if (input.ownerHolds === false) {
    return deny(3, "owner-authority-changed", "owner-authority-changed");
  }
  if (input.ownerHolds !== true) return deny(3, "owner-unknown");

  if (input.operator?.state !== "open") return deny(4, "operator-closed");

  const required = Array.isArray(input.requiredGates) ? input.requiredGates : [];
  let pending = false;
  for (const gate of required) {
    const answer = gateAnswer(gate, input.verdicts, subject.revision, input.now);
    if (answer === "refused") return deny(5, "gates-refused");
    if (answer === "pending") pending = true;
  }
  if (pending) return deny(5, "gates-pending");

  if (rule.maxUses !== undefined) {
    const cap = countOf(rule.maxUses);
    const used = countOf(input.uses);
    if (cap === undefined || used === undefined || used >= cap) return deny(6, "uses-exhausted");
  }
  if (input.oneAtATime !== true) return deny(6, "one-at-a-time");
  return ALLOW;
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

/** The ceiling an active deployment's agreement sets, as a rule's terms read it. */
export type DelegationCeiling = {
  readonly maxDays: number;
};

/**
 * How one action reads one narrowing field of its scope: `undefined` when the value is
 * allowed inside the ceiling, else a sentence. An action registers one per field it has.
 */
export type ScopeFieldCheck = (
  value: DelegationScopeValue,
  ceiling: DelegationCeiling,
) => string | undefined;

/** Scope fields no action may ever have: a rule never changes which checks it needs. */
const FORBIDDEN_SCOPE_FIELDS: ReadonlySet<string> = new Set([
  "gates",
  "requiredGates",
  "required_gates",
]);

const TERM_FIELDS: ReadonlySet<string> = new Set(["days", "maxUses", "scope"]);

/** The most days a rule under this ceiling may last. */
export function maxRuleDays(ceiling: DelegationCeiling | undefined): number {
  const max = ceiling?.maxDays;
  return Number.isSafeInteger(max) && (max as number) >= 1
    ? Math.min(max as number, DELEGATION_MAX_DAYS)
    : 0;
}

/**
 * Why these terms are refused for this action under this ceiling, or `undefined`. A
 * length above the ceiling's `max_days` or 90 days, a use cap that is not a whole number
 * from 1, a scope field the action does not have (a field naming gates is never one), and
 * a field the action's own check refuses are each refused with a sentence. Pure.
 */
export function ruleTermsProblem(input: {
  readonly action: unknown;
  readonly terms: unknown;
  readonly ceiling: DelegationCeiling | undefined;
  readonly scopeFields?: Readonly<Record<string, ScopeFieldCheck>>;
}): string | undefined {
  if (!(DELEGATION_ACTIONS as readonly unknown[]).includes(input.action)) {
    return "That is not something a rule can cover.";
  }
  const most = maxRuleDays(input.ceiling);
  if (most === 0) return "This harness's agreement does not allow delegation.";
  const terms = input.terms;
  if (terms === undefined) return undefined;
  if (typeof terms !== "object" || terms === null || Array.isArray(terms)) {
    return "A rule's terms are a set of named fields.";
  }
  const record = terms as Record<string, unknown>;
  for (const name of Object.keys(record)) {
    if (!TERM_FIELDS.has(name)) return `A rule has no term named ${JSON.stringify(name)}.`;
  }
  const days = record["days"];
  if (days !== undefined) {
    if (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > most) {
      return `A rule lasts from 1 to ${most} days here.`;
    }
  }
  const uses = record["maxUses"];
  if (uses !== undefined) {
    if (
      !Number.isSafeInteger(uses) ||
      (uses as number) < 1 ||
      (uses as number) > DELEGATION_MAX_USES
    ) {
      return `A use cap is a whole number from 1 to ${DELEGATION_MAX_USES}.`;
    }
  }
  const scope = record["scope"];
  if (scope === undefined) return undefined;
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    return "A rule's scope is a set of named fields.";
  }
  const fields = input.scopeFields ?? {};
  for (const [name, value] of Object.entries(scope as Record<string, unknown>)) {
    if (FORBIDDEN_SCOPE_FIELDS.has(name)) {
      return "A rule cannot change which checks it needs: they come with the action.";
    }
    const check = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (check === undefined) return `This action has no scope field named ${JSON.stringify(name)}.`;
    if (!isScopeValue(value))
      return `The scope field ${JSON.stringify(name)} holds no usable value.`;
    const problem = check(value, input.ceiling as DelegationCeiling);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function isScopeValue(value: unknown): value is DelegationScopeValue {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Terms with their defaults: the length is the ceiling's shorter of 14 days and its own
 * `max_days`. Assumes {@link ruleTermsProblem} found none.
 */
export function normalizeRuleTerms(
  terms: DelegationTermsRequest | undefined,
  ceiling: DelegationCeiling,
): DelegationTerms {
  const days = terms?.days ?? Math.min(DELEGATION_DEFAULT_DAYS, maxRuleDays(ceiling));
  const scope = terms?.scope;
  return {
    days,
    ...(terms?.maxUses !== undefined ? { maxUses: terms.maxUses } : {}),
    ...(scope !== undefined && Object.keys(scope).length > 0 ? { scope } : {}),
  };
}

// ---------------------------------------------------------------------------
// The consequences page
// ---------------------------------------------------------------------------

type ParamKind = "name" | "names" | "int" | "date" | "glob" | "harness" | "argv";

type Template = {
  readonly text: string;
  readonly params?: Readonly<Record<string, ParamKind>>;
};

/**
 * Every line the consequences page and a rule's label can say. A line is a template id
 * and typed parameters, never a string from a client or a model.
 */
export const CONSEQUENCE_TEMPLATES: Readonly<Record<string, Template>> = deepFreeze({
  "title.merge": {
    text: "Let {harness} merge its own pull requests",
    params: { harness: "harness" },
  },
  "title.rollout": {
    text: "Let {harness} roll out its own saved revisions",
    params: { harness: "harness" },
  },
  "title.adopt": {
    text: "Let {harness} adopt its own routine improvements",
    params: { harness: "harness" },
  },
  "title.assistant": { text: "Let the assistant carry out the actions you confirm" },

  "heading.does": { text: "What it will do on its own" },
  "heading.only-when": { text: "Only when all of these pass, for the exact revision it acts on" },
  "heading.if-wrong": { text: "If something goes wrong" },
  "heading.never-covered": { text: "Never covered" },
  "heading.good-to-know": { text: "Good to know" },
  "heading.evidence": { text: "What happened before" },
  "heading.ends": { text: "Ends" },
  "heading.stop": { text: "Stop" },

  "does.merge": {
    text: "Merge pull requests this harness opened, once every check below passes.",
  },
  "does.rollout": { text: "Make a prepared build of this harness the active one." },
  "does.adopt": {
    text: "Adopt improvements its checks show are better and routine, then roll them out.",
  },
  "does.assistant": {
    text: "Carry out the actions you confirm in a conversation, within your own access.",
  },

  "gate.scope": { text: "the change is one this harness made, within this rule's limits" },
  "gate.host": { text: "the code host says it is ready, with every required check passing" },
  "gate.acceptance": { text: "the acceptance check the harness ran before asking passes" },
  "gate.held_out": { text: "held-out checks Home runs itself pass" },
  "gate.one_at_a_time": { text: "nothing else this rule did is still waiting for its result" },
  "gate.rehearsal": { text: "a rehearsal of the exact build finished" },
  "gate.policy": { text: "the build changes no permission, check or purpose" },
  "gate.activation": { text: "every check an activation runs passes" },
  "gate.routine": { text: "the change is routine" },
  "gate.comparison": { text: "it does better on held-out cases, with nothing worse" },
  "gate.fresh": { text: "nothing it was checked against has changed since" },

  "if-wrong.merge": {
    text: "After each merge, Home watches the checks on the merged commit. If they fail, it reverts the merge, turns this rule off until you look, and tells you.",
  },
  "if-wrong.rollout": {
    text: "After each rollout, Home watches for failures and worse results. If it sees them, it goes back to the previous build, turns this rule off until you look, and tells you.",
  },
  "if-wrong.adopt": {
    text: "After each change, Home watches for failures and worse results. If it sees them, it rolls the change back, turns this rule off until you look, and tells you.",
  },
  "if-wrong.assistant": {
    text: "Each action can be undone from Home. Nothing it does decides anything for you.",
  },

  "never.merge": {
    text: "Other repositories, changes to its purpose, permissions or protected checks, deployments, and anything over this rule's limits. Those still ask.",
  },
  "never.rollout": {
    text: "Builds that change its permissions, checks or purpose, and protected environments. Those still ask.",
  },
  "never.adopt": {
    text: "Changes that edit a check, changes to its tools, and anything that is not routine. Those still ask.",
  },
  "never.assistant": {
    text: "Decisions, access, settings, secrets and retiring a harness. Those still ask.",
  },

  "good.none": { text: "Nothing more to know before turning it on." },
  "good.runs-here": { text: "Held-out checks run your project's code on this computer." },

  "evidence.none": { text: "No history yet." },
  "evidence.approved": {
    text: "In the last {days} days a person approved {count} like these.",
    params: { days: "int", count: "int" },
  },
  "evidence.refused": {
    text: "In the last {days} days a person refused {count} like these.",
    params: { days: "int", count: "int" },
  },
  "evidence.rolled-back": {
    text: "In the last {days} days {count} were rolled back.",
    params: { days: "int", count: "int" },
  },

  ends: {
    text: "{date}, after {days} days, or sooner if you turn it off.",
    params: { date: "date", days: "int" },
  },
  "ends.uses": {
    text: "{date}, after {days} days or {uses} uses, or sooner if you turn it off.",
    params: { date: "date", days: "int", uses: "int" },
  },
  stop: { text: "Any maintainer can pause it. Only an owner can resume it or change it." },
  cli: { text: "CLI: crewhaus {argv}", params: { argv: "argv" } },

  "label.merge": { text: "Merges its own pull requests" },
  "label.rollout": { text: "Rolls out its own saved revisions" },
  "label.adopt": { text: "Adopts its own routine improvements" },
  "label.assistant": { text: "Carries out the actions you confirm" },
});

/** One line of the page: a template id and its parameters. */
export type ConsequenceLine = {
  readonly template: string;
  readonly params?: Readonly<Record<string, unknown>>;
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HARNESS_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const GLOB_RE = /^[A-Za-z0-9._*?/{}[\],!-]{1,200}$/;
const ARGV_TOKEN_RE = /^(?:--)?[A-Za-z0-9_][A-Za-z0-9._:/=@+,-]{0,199}$/;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** `YYYY-MM-DD` as words, by the calendar date it names: no clock and no time zone. */
function dateWords(value: string): string | undefined {
  const match = DATE_RE.exec(value);
  if (match === null) return undefined;
  const [, year, month, day] = match;
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return `${d} ${MONTHS[m - 1]} ${year}`;
}

function paramText(template: string, name: string, kind: ParamKind, value: unknown): string {
  const wrong = (): never => {
    throw new TypeError(
      `control-contract: parameter ${name} of ${template} is not a valid ${kind}`,
    );
  };
  switch (kind) {
    case "name":
      return typeof value === "string" && NAME_RE.test(value) ? value : wrong();
    case "harness":
      return typeof value === "string" && HARNESS_RE.test(value) ? value : wrong();
    case "names":
      if (!Array.isArray(value) || value.length === 0 || value.length > 20) return wrong();
      return value.map((item) => paramText(template, name, "name", item)).join(", ");
    case "int":
      return Number.isSafeInteger(value) && (value as number) >= 0 ? String(value) : wrong();
    case "date":
      return (typeof value === "string" ? dateWords(value) : undefined) ?? wrong();
    case "glob":
      return typeof value === "string" && GLOB_RE.test(value) ? value : wrong();
    case "argv":
      if (!Array.isArray(value) || value.length === 0 || value.length > 40) return wrong();
      return value
        .map((token) => (typeof token === "string" && ARGV_TOKEN_RE.test(token) ? token : wrong()))
        .join(" ");
  }
}

/** One line in words. An unknown template id, a missing or extra parameter, or one of the
 *  wrong shape throws. */
export function renderLine(line: ConsequenceLine): string {
  const template = CONSEQUENCE_TEMPLATES[line?.template];
  if (template === undefined || !Object.hasOwn(CONSEQUENCE_TEMPLATES, line.template)) {
    throw new TypeError(`control-contract: unknown consequence template ${String(line?.template)}`);
  }
  const declared = template.params ?? {};
  const given = line.params ?? {};
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(declared, name)) {
      throw new TypeError(`control-contract: ${line.template} takes no parameter ${name}`);
    }
  }
  return template.text.replace(/\{(\w+)\}/g, (_whole, name: string) => {
    const kind = declared[name];
    if (kind === undefined) {
      throw new TypeError(`control-contract: ${line.template} names an undeclared ${name}`);
    }
    if (!Object.hasOwn(given, name)) {
      throw new TypeError(`control-contract: ${line.template} needs its parameter ${name}`);
    }
    return paramText(line.template, name, kind, given[name]);
  });
}

/** The closed sections of the page, in their fixed order. */
export const CONSEQUENCE_SECTIONS = deepFreeze([
  "does",
  "only-when",
  "if-wrong",
  "never-covered",
  "good-to-know",
  "evidence",
  "ends",
  "stop",
] as const);

export type ConsequenceSection = (typeof CONSEQUENCE_SECTIONS)[number];

/** Which command the page's last line prints: turn a rule on, change one, or resume one. */
export type ConsequenceCommand =
  | { readonly kind: "enable" }
  | { readonly kind: "change"; readonly rule: string; readonly expect: number }
  | { readonly kind: "resume"; readonly rule: string; readonly expect: number };

export type ConsequencesInput = {
  readonly action: DelegationAction;
  /** The harness's id and the name a person types to confirm. */
  readonly harness: { readonly id: string; readonly name: string };
  /** Normalized terms ({@link normalizeRuleTerms}). */
  readonly terms: DelegationTerms;
  /** The active deployment's ceiling digest and policy revision the rule binds to. */
  readonly ceiling: { readonly digest: string; readonly policyRevision: string };
  readonly requiredGates: readonly GateId[];
  /** What the host says, from the action's own templates. None: "nothing more to know". */
  readonly host?: readonly ConsequenceLine[];
  /** Counts from the decision record over a window; `null` or absent: no history. */
  readonly evidence?: {
    readonly days: number;
    readonly approved: number;
    readonly refused: number;
    readonly rolledBack: number;
  } | null;
  /** The calendar date the rule would end, `YYYY-MM-DD`: shown, never digested. */
  readonly endsOn: string;
  readonly command?: ConsequenceCommand;
};

export type ConsequencesPage = {
  readonly title: string;
  readonly sections: readonly {
    readonly id: ConsequenceSection;
    readonly heading: string;
    readonly lines: readonly string[];
  }[];
  /** The exact command line, after `crewhaus`. */
  readonly argv: readonly string[];
  readonly text: string;
  /** The canonical object a caller takes the page's digest over. */
  readonly material: Readonly<Record<string, unknown>>;
};

function flagOf(name: string): string {
  return `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** The command a person types for this page, from closed parts only. */
function commandArgv(input: ConsequencesInput): string[] {
  const command = input.command ?? { kind: "enable" };
  const terms: string[] = ["--days", String(input.terms.days)];
  if (input.terms.maxUses !== undefined) terms.push("--uses", String(input.terms.maxUses));
  for (const [name, value] of Object.entries(input.terms.scope ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) terms.push(flagOf(name), String(item));
  }
  const confirm = ["--confirm", input.harness.name];
  switch (command.kind) {
    case "enable":
      return [
        "delegations",
        "enable",
        input.action,
        "--harness",
        input.harness.id,
        ...terms,
        ...confirm,
      ];
    case "change":
      return [
        "delegations",
        "change",
        command.rule,
        "--harness",
        input.harness.id,
        ...terms,
        "--expect",
        String(command.expect),
        ...confirm,
      ];
    case "resume":
      return [
        "delegations",
        "resume",
        command.rule,
        "--harness",
        input.harness.id,
        "--expect",
        String(command.expect),
        ...confirm,
      ];
  }
}

/**
 * The consequences page for a rule, from closed templates and typed parameters only: no
 * clock and no model, so the same input gives the same bytes on every surface. `material`
 * is what the page's digest is taken over: the action, the normalized terms (days, never
 * an end), the ceiling's digest, the policy revision, the host's lines and the harness's
 * id. A template it does not know, or a parameter of the wrong shape, throws.
 */
export function renderConsequences(input: ConsequencesInput): ConsequencesPage {
  const { action } = input;
  if (!(DELEGATION_ACTIONS as readonly string[]).includes(action)) {
    throw new TypeError(`control-contract: no consequences page for ${String(action)}`);
  }
  if (typeof input.harness?.id !== "string" || !NAME_RE.test(input.harness.id)) {
    throw new TypeError("control-contract: the harness id is not a valid name");
  }
  const harnessName = paramText("title", "harness", "harness", input.harness.name);
  const title =
    action === "assistant"
      ? renderLine({ template: "title.assistant" })
      : renderLine({ template: `title.${action}`, params: { harness: harnessName } });
  const gates = (Array.isArray(input.requiredGates) ? input.requiredGates : []).map((gate) => {
    if (!(GATE_IDS as readonly string[]).includes(gate)) {
      throw new TypeError(`control-contract: unknown gate ${String(gate)}`);
    }
    return `· ${renderLine({ template: `gate.${gate}` })}`;
  });
  const host = input.host ?? [];
  const evidence = input.evidence;
  const evidenceLines =
    evidence === undefined || evidence === null
      ? [renderLine({ template: "evidence.none" })]
      : [
          renderLine({
            template: "evidence.approved",
            params: { days: evidence.days, count: evidence.approved },
          }),
          renderLine({
            template: "evidence.refused",
            params: { days: evidence.days, count: evidence.refused },
          }),
          renderLine({
            template: "evidence.rolled-back",
            params: { days: evidence.days, count: evidence.rolledBack },
          }),
        ];
  const ends =
    input.terms.maxUses === undefined
      ? renderLine({ template: "ends", params: { date: input.endsOn, days: input.terms.days } })
      : renderLine({
          template: "ends.uses",
          params: { date: input.endsOn, days: input.terms.days, uses: input.terms.maxUses },
        });
  const bare: { id: ConsequenceSection; lines: string[] }[] = [
    { id: "does", lines: [renderLine({ template: `does.${action}` })] },
    { id: "only-when", lines: gates },
    { id: "if-wrong", lines: [renderLine({ template: `if-wrong.${action}` })] },
    { id: "never-covered", lines: [renderLine({ template: `never.${action}` })] },
    {
      id: "good-to-know",
      lines: host.length === 0 ? [renderLine({ template: "good.none" })] : host.map(renderLine),
    },
    { id: "evidence", lines: evidenceLines },
    { id: "ends", lines: [ends] },
    { id: "stop", lines: [renderLine({ template: "stop" })] },
  ];
  const argv = commandArgv(input);
  const cli = renderLine({ template: "cli", params: { argv } });
  const headings: Record<ConsequenceSection, string> = {
    does: renderLine({ template: "heading.does" }),
    "only-when": renderLine({ template: "heading.only-when" }),
    "if-wrong": renderLine({ template: "heading.if-wrong" }),
    "never-covered": renderLine({ template: "heading.never-covered" }),
    "good-to-know": renderLine({ template: "heading.good-to-know" }),
    evidence: renderLine({ template: "heading.evidence" }),
    ends: renderLine({ template: "heading.ends" }),
    stop: renderLine({ template: "heading.stop" }),
  };
  const sections = bare.map((section) => ({ ...section, heading: headings[section.id] }));
  const text = [
    title,
    "",
    ...sections.flatMap((section) => [
      section.heading,
      ...section.lines.map((line) => `  ${line}`),
      "",
    ]),
    cli,
  ].join("\n");
  const material = {
    v: 1,
    action,
    harness: input.harness.id,
    terms: input.terms,
    ceilingDigest: input.ceiling.digest,
    policyRevision: input.ceiling.policyRevision,
    host: host.map((line) => ({ template: line.template, params: line.params ?? {} })),
  };
  return { title, sections, argv, text: `${text}\n`, material };
}

/** A rule's one-line label, from the closed templates. */
export function ruleLabelOf(action: DelegationAction): string {
  return renderLine({ template: `label.${action}` });
}

// ---------------------------------------------------------------------------
// Who decided
// ---------------------------------------------------------------------------

const LABEL_MAX = 80;

/** A display label as a line may carry it: no control or bidirectional character, no markup. */
function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > LABEL_MAX) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩<>]/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/** An ISO time's calendar date, in UTC, as words. */
function dayOf(value: unknown): string | undefined {
  const ms = timeOf(value);
  if (ms === undefined) return undefined;
  return dateWords(new Date(ms).toISOString().slice(0, 10));
}

export type DecidedByInput = {
  readonly resolvedBy?: unknown;
  readonly delegation?: { readonly rule?: unknown; readonly revision?: unknown };
  /** The rule's label (its closed template line), or its id when none can be given. */
  readonly ruleLabel?: unknown;
  /** The enabling owner's display name. */
  readonly ownerLabel?: unknown;
  /** When the rule was turned on. */
  readonly enabledAt?: unknown;
  /** The person who decided, for a decision a person made. Never read for a delegated one. */
  readonly deciderLabel?: unknown;
};

/**
 * Who decided, in the words every surface shows. A delegated decision is the rule's,
 * never a person's: its text names the rule, its revision and the owner who turned it on,
 * and ignores any decider label. A fallback is the agreement's outcome. Anything else is
 * the person who decided.
 */
export function decidedByText(input: DecidedByInput): string {
  if (input?.resolvedBy === "delegation") {
    const label =
      cleanLabel(input.ruleLabel) ??
      (typeof input.delegation?.rule === "string" ? input.delegation.rule : "a delegation rule");
    const revision = countOf(input.delegation?.revision);
    const owner = cleanLabel(input.ownerLabel) ?? "its owner";
    const on = dayOf(input.enabledAt);
    return `Decided by delegation rule ${label}${revision !== undefined ? ` (revision ${revision})` : ""}, turned on by ${owner}${on !== undefined ? ` on ${on}` : ""}`;
  }
  if (input?.resolvedBy === "policy") {
    return "Decided by this harness's agreement, because no one answered in time";
  }
  return `Decided by ${cleanLabel(input?.deciderLabel) ?? "a person"}`;
}

/** Whether a reason code is one a rule's suspension carries. */
export function isSuspendReason(value: unknown): value is SuspendReason {
  return (SUSPEND_REASONS as readonly unknown[]).includes(value);
}
