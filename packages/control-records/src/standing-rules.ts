/**
 * Standing rules, and the requests that ask a harness's owner for one, as files in the
 * harness.
 *
 * A standing rule is a narrow allow for one tool that ends on its own: `active` when it
 * is made, then `revoked` by the owner or `expired` by its clock, both final, on
 * control-contract's `rule` machine. The allow itself stays a plain entry in
 * `.crewhaus/settings.json`, in the shape every release reads; these rows are what keep
 * that entry live (permission-engine's `loadSettingsRules`). A row holds ids, the tool,
 * the pattern as the settings file holds it, a stored actor, times and a closed reason
 * code: never free text.
 *
 * A request to the owner is a `dec_` decision of kind `standing-rule-proposal`, on the
 * `decision` machine, in `.crewhaus/run/control/decisions/` (size segments). The first
 * decision on it wins through `casAppend(…, "pending", …)`: its generation claim decides.
 * The same ledger holds `change-adoption` decisions (a change record waiting to be
 * adopted) and the `merge` and `rollout` decisions a delegation rule may resolve; each
 * reader reads its own kind and passes over the other known kinds.
 *
 * Both ledgers are `harnessLedger`s, so they share the harness's control lock and claims
 * directory: a writer that holds the lock for one may compare-and-set on both
 * (`casAppendLocked`). Reads take no lock, write nothing and repair nothing.
 */
import {
  DECISION_CLASSES,
  DECISION_LOG_REASONS,
  DELEGABLE_DECISION_KINDS,
  DELEGATION_ACTIONS,
  type DecisionClass,
  type DelegableDecisionKind,
  type DelegationSubject,
  type StandingRuleTerms,
  isId,
  isRef,
  isStoredActor,
  mintId,
} from "@crewhaus/control-contract";
import { isDelegationTerms } from "./delegations";
import { cachedPerPath } from "./fail-closed";
import { type FoldAnswer, type LedgerRecord, casAppend, foldStates } from "./ledger";
import { type Ledger, controlPaths, harnessLedger } from "./paths";

/**
 * How long a request to the owner waits before it reads `expired`.
 *
 * First consumer: the requests a member's `--always` files for the owner.
 */
export const PROPOSAL_TTL_MS = 30 * 86_400_000;

/** Why a standing rule was made: an owner's own grant, or a request the owner accepted. */
export type StandingRuleReason = "approval" | "proposal";

export type StandingRuleRow = {
  readonly id: string;
  readonly kind: "allow";
  readonly tool: string;
  readonly pattern: string;
  readonly derivedFrom?: string;
  readonly proposal?: string;
  readonly createdBy: string;
  readonly reason: StandingRuleReason;
  readonly policyRevision?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** The receipt of the command that made the rule. */
  readonly cmd?: string;
  readonly state: "active" | "revoked" | "expired";
  readonly revokedAt?: string;
  readonly revokedBy?: string;
  readonly expiredAt?: string;
};

export type ProposalRow = {
  readonly id: string;
  readonly kind: "standing-rule-proposal";
  readonly createdAt: string;
  /** When the request stops waiting: it then reads `expired`. */
  readonly expiresAt: string;
  readonly requiredClass: DecisionClass;
  /** The tool approval an `allow` request was made from. A `delegate` request has none. */
  readonly derivedFrom?: string;
  readonly proposedBy: string;
  readonly terms: StandingRuleTerms;
  readonly state: "pending" | "granted" | "denied";
  readonly decision?: "grant" | "deny";
  readonly decidedAt?: string;
  readonly decidedByPrincipal?: string;
  /** The rule a grant made. */
  readonly rule?: string;
};

/** What a change-adoption decision is bound to: content-free ids, keyed digests, a revision. */
export type ChangeAdoptionSubjectRow = {
  readonly chg: string;
  readonly patchDigest: string;
  readonly baseRevision: string;
  readonly evidenceDigest: string;
};

/** A `dec_` decision that a change may be adopted, on the `decision` machine. */
export type ChangeAdoptionRow = {
  readonly id: string;
  readonly kind: "change-adoption";
  readonly createdAt: string;
  /** When the decision stops waiting: it then reads `expired`. */
  readonly expiresAt: string;
  /** Who may decide: a maintainer, or the owner for a change to a protected, intent or
   *  security surface. */
  readonly requiredClass: "maintainer" | "owner";
  readonly subject: ChangeAdoptionSubjectRow;
  /** A keyed digest over the subject: what a grant is bound to. */
  readonly bindingDigest: string;
  readonly proposedBy: string;
  readonly state: "pending" | "granted" | "denied" | "consumed" | "superseded";
  readonly decision?: "grant" | "deny";
  readonly decidedAt?: string;
  readonly decidedByPrincipal?: string;
  readonly consumedAt?: string;
  readonly supersededAt?: string;
  readonly supersededReason?: string;
};

/**
 * A decision a delegation rule may resolve (`merge`, `rollout`), or a person in its place:
 * a `ship`-class action bound to its subject's ref and revision, on the `decision` machine.
 */
export type ActionDecisionRow = {
  readonly id: string;
  readonly kind: DelegableDecisionKind;
  readonly actionClass: "ship";
  readonly createdAt: string;
  /** When the decision stops waiting: it then reads `expired`. */
  readonly expiresAt: string;
  readonly requiredClass: DecisionClass;
  readonly subject: DelegationSubject;
  readonly proposedBy: string;
  readonly state: "pending" | "granted" | "denied" | "consumed" | "superseded";
  readonly decision?: "grant" | "deny";
  readonly decidedAt?: string;
  /** A person who decided. Never set when a rule did. */
  readonly decidedByPrincipal?: string;
  readonly resolvedBy?: "delegation";
  readonly delegation?: { readonly rule: string; readonly revision: number };
  /** Who ran the pass that applied the rule. It decided nothing. */
  readonly appliedBy?: string;
  readonly consumedAt?: string;
  readonly supersededAt?: string;
  readonly supersededReason?: string;
  /** The fresh decision asked in this one's place. */
  readonly supersededBy?: string;
};

/** The decision kinds the decisions ledger holds; a reader passes over the others. */
const DECISION_ROW_KINDS: ReadonlySet<string> = new Set([
  "standing-rule-proposal",
  "change-adoption",
  ...DELEGABLE_DECISION_KINDS,
]);

export type LedgerRead<T> =
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly reason: string }
  | {
      readonly state: "present";
      readonly rows: readonly T[];
      /** What the fold could not use, one sentence each, never a value from a row. */
      readonly anomalies: readonly string[];
    };

/**
 * The standing rules of a harness, on the `rule` machine.
 *
 * First consumers: the decision service's rule writers and permission-engine's load.
 */
export function standingRulesLedger(harnessDir: string): Ledger {
  return harnessLedger(
    harnessDir,
    { file: controlPaths(harnessDir).standingRulesFile },
    { machine: "rule" },
  );
}

/**
 * The `dec_` decisions of a harness, on the `decision` machine.
 *
 * First consumer: the requests a member's `--always` files for the owner.
 */
export function decisionsLedger(harnessDir: string): Ledger {
  return harnessLedger(
    harnessDir,
    { dir: controlPaths(harnessDir).decisionsDir },
    { machine: "decision" },
  );
}

const BOOKKEEPING = new Set(["claim", "gen", "repaired"]);

function withoutBookkeeping(row: LedgerRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    if (!BOOKKEEPING.has(name)) out[name] = value;
  }
  return out;
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const isTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
/**
 * A time in the one form the writers write (`Date.prototype.toISOString`): a
 * standing rule's and a request's times are shown to a person, so a value that
 * merely parses (a date with a comment in it) is not one.
 */
const isInstant = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
};
const optional = (value: unknown, check: (v: unknown) => boolean): boolean =>
  value === undefined || check(value);

/**
 * A row as a standing rule, or `undefined` when it is not one.
 *
 * First consumer: {@link readStandingRules}.
 */
export function standingRuleOf(row: LedgerRecord): StandingRuleRow | undefined {
  const r = withoutBookkeeping(row);
  const ok =
    isId("rule", r["id"]) &&
    r["kind"] === "allow" &&
    isText(r["tool"]) &&
    isText(r["pattern"]) &&
    optional(r["derivedFrom"], (v) => isId("appr", v) || isId("dec", v)) &&
    optional(r["proposal"], (v) => isId("dec", v)) &&
    isStoredActor(r["createdBy"]) &&
    (r["reason"] === "approval" || r["reason"] === "proposal") &&
    optional(r["policyRevision"], isText) &&
    isInstant(r["createdAt"]) &&
    isInstant(r["expiresAt"]) &&
    optional(r["cmd"], (v) => isId("cmd", v)) &&
    (r["state"] === "active" || r["state"] === "revoked" || r["state"] === "expired") &&
    optional(r["revokedAt"], isInstant) &&
    optional(r["revokedBy"], isStoredActor) &&
    optional(r["expiredAt"], isInstant);
  return ok ? (r as StandingRuleRow) : undefined;
}

/**
 * A row as a request to the owner, or `undefined` when it is not one.
 *
 * First consumer: {@link readProposals}.
 */
export function proposalOf(row: LedgerRecord): ProposalRow | undefined {
  const r = withoutBookkeeping(row);
  const terms = r["terms"];
  const t =
    typeof terms === "object" && terms !== null && !Array.isArray(terms)
      ? (terms as Record<string, unknown>)
      : undefined;
  // An `allow` request names the approval it came from; a `delegate` request names none.
  const termsOk =
    t === undefined
      ? false
      : t["ruleKind"] === "allow"
        ? isId("appr", r["derivedFrom"]) &&
          isText(t["tool"]) &&
          isText(t["pattern"]) &&
          isInstant(t["expiresAt"])
        : t["ruleKind"] === "delegate" &&
          r["derivedFrom"] === undefined &&
          (DELEGATION_ACTIONS as readonly unknown[]).includes(t["action"]) &&
          isDelegationTerms(t["terms"]) &&
          Number.isSafeInteger(t["days"]) &&
          (t["days"] as number) >= 1 &&
          (t["days"] as number) <= 90;
  const ok =
    isId("dec", r["id"]) &&
    r["kind"] === "standing-rule-proposal" &&
    isInstant(r["createdAt"]) &&
    isInstant(r["expiresAt"]) &&
    (DECISION_CLASSES as readonly unknown[]).includes(r["requiredClass"]) &&
    isStoredActor(r["proposedBy"]) &&
    termsOk &&
    (r["state"] === "pending" || r["state"] === "granted" || r["state"] === "denied") &&
    optional(r["decision"], (v) => v === "grant" || v === "deny") &&
    optional(r["decidedAt"], isInstant) &&
    optional(r["decidedByPrincipal"], isStoredActor) &&
    optional(r["rule"], (v) => isId("rule", v));
  return ok ? (r as ProposalRow) : undefined;
}

function readLedger<T>(
  fold: FoldAnswer,
  of: (row: LedgerRecord) => T | undefined,
  what: string,
  /** A row of one of these other known kinds is another reader's, never an anomaly here. */
  otherKinds: ReadonlySet<string> = new Set(),
): LedgerRead<T> {
  if (!fold.ok) {
    return fold.code === "not-found"
      ? { state: "absent" }
      : { state: "unreadable", reason: fold.reason };
  }
  if (fold.records === 0 && fold.gaps.length === 0) return { state: "absent" };
  const rows: T[] = [];
  const anomalies: string[] = [];
  for (const object of fold.objects.values()) {
    const row = of(object.record);
    if (row !== undefined) {
      rows.push(row);
      continue;
    }
    const kind = object.record["kind"];
    if (typeof kind === "string" && otherKinds.has(kind)) continue;
    anomalies.push(`${object.id}: the row is not a ${what}`);
  }
  for (const anomaly of fold.anomalies) {
    anomalies.push(
      `${anomaly.id}: a row moving ${anomaly.from ?? "nothing"} to ${anomaly.to ?? "nothing"} is not a move its machine allows`,
    );
  }
  if (fold.gaps.length > 0) anomalies.push(`${fold.gaps.length} line(s) cannot be read`);
  return { state: "present", rows, anomalies };
}

/**
 * Every standing rule of a harness, as its latest row says: a tolerant fold that takes no
 * lock and writes nothing. A row of another shape is left out and reported; a ledger that
 * cannot be read at all answers `unreadable`.
 *
 * First consumers: the decision service, `crewhaus approvals rules`, the load filter.
 */
export function readStandingRules(harnessDir: string): LedgerRead<StandingRuleRow> {
  return readLedger(foldStates(standingRulesLedger(harnessDir)), standingRuleOf, "standing rule");
}

/**
 * {@link readStandingRules} behind a one-second cache per path, by the injected clock, as
 * the approver reader is: synchronous, no lock, nothing created.
 *
 * First consumer: permission-engine's liveness check on a loaded rule.
 */
export function createStandingRuleReader(
  options: { readonly now?: () => number } = {},
): (harnessDir: string) => LedgerRead<StandingRuleRow> {
  return cachedPerPath(readStandingRules, options.now ?? (() => Date.now()));
}

/**
 * Whether a rule allows now: `active`, and its end not reached. An end that cannot be
 * read has passed.
 *
 * First consumer: permission-engine's liveness check on a loaded rule.
 */
export function ruleIsLive(rule: StandingRuleRow, nowMs: number): boolean {
  if (rule.state !== "active") return false;
  const ends = Date.parse(rule.expiresAt);
  return Number.isFinite(ends) && Number.isFinite(nowMs) && nowMs < ends;
}

/**
 * Every request to the owner in a harness, as its latest row says. A tolerant fold, like
 * {@link readStandingRules}.
 *
 * First consumers: the decision service and `crewhaus approvals rules`.
 */
export function readProposals(harnessDir: string): LedgerRead<ProposalRow> {
  return readLedger(
    foldStates(decisionsLedger(harnessDir)),
    proposalOf,
    "standing-rule request",
    otherDecisionKinds("standing-rule-proposal"),
  );
}

function otherDecisionKinds(own: string): ReadonlySet<string> {
  return new Set([...DECISION_ROW_KINDS].filter((kind) => kind !== own));
}

const isDigestText = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9:_-]{8,200}$/.test(value);

/**
 * A row as a change-adoption decision, or `undefined` when it is not one.
 *
 * First consumer: {@link readChangeAdoptions}.
 */
export function changeAdoptionOf(row: LedgerRecord): ChangeAdoptionRow | undefined {
  const r = withoutBookkeeping(row);
  const subject = r["subject"];
  const s =
    typeof subject === "object" && subject !== null && !Array.isArray(subject)
      ? (subject as Record<string, unknown>)
      : undefined;
  const state = r["state"];
  const ok =
    isId("dec", r["id"]) &&
    r["kind"] === "change-adoption" &&
    isTime(r["createdAt"]) &&
    isTime(r["expiresAt"]) &&
    (r["requiredClass"] === "maintainer" || r["requiredClass"] === "owner") &&
    s !== undefined &&
    isId("chg", s["chg"]) &&
    isDigestText(s["patchDigest"]) &&
    isDigestText(s["baseRevision"]) &&
    isDigestText(s["evidenceDigest"]) &&
    isDigestText(r["bindingDigest"]) &&
    isStoredActor(r["proposedBy"]) &&
    (state === "pending" ||
      state === "granted" ||
      state === "denied" ||
      state === "consumed" ||
      state === "superseded") &&
    optional(r["decision"], (v) => v === "grant" || v === "deny") &&
    optional(r["decidedAt"], isTime) &&
    optional(r["decidedByPrincipal"], isStoredActor) &&
    optional(r["consumedAt"], isTime) &&
    optional(r["supersededAt"], isTime) &&
    optional(r["supersededReason"], isText);
  return ok ? (r as ChangeAdoptionRow) : undefined;
}

/**
 * Every change-adoption decision in a harness, as its latest row says. A tolerant fold,
 * like {@link readProposals}: a standing-rule request is passed over, any other row that
 * is not one is reported.
 *
 * First consumers: the decision service and `@crewhaus/quality-service`.
 */
export function readChangeAdoptions(harnessDir: string): LedgerRead<ChangeAdoptionRow> {
  return readLedger(
    foldStates(decisionsLedger(harnessDir)),
    changeAdoptionOf,
    "change-adoption decision",
    otherDecisionKinds("change-adoption"),
  );
}

/**
 * A change-adoption decision's state as every reader shows it: a pending one, or an
 * unconsumed grant, past its `expiresAt` reads `expired`. Computed, never written.
 *
 * First consumers: the decision service and `@crewhaus/quality-service`.
 */
export function changeAdoptionState(
  row: ChangeAdoptionRow,
  nowMs: number,
): ChangeAdoptionRow["state"] | "expired" {
  if (row.state !== "pending" && row.state !== "granted") return row.state;
  const ends = Date.parse(row.expiresAt);
  return Number.isFinite(ends) && Number.isFinite(nowMs) && nowMs <= ends ? row.state : "expired";
}

const SUBJECT_REVISION_RE = /^[A-Za-z0-9:_.-]{1,200}$/;

/**
 * A row as a decision a delegation rule may resolve, or `undefined` when it is not one. A
 * row that says a rule resolved it names the rule and no person; one a person decided
 * names no rule.
 *
 * First consumer: {@link readActionDecisions}.
 */
export function actionDecisionOf(row: LedgerRecord): ActionDecisionRow | undefined {
  const r = withoutBookkeeping(row);
  const subject = r["subject"];
  const s =
    typeof subject === "object" && subject !== null && !Array.isArray(subject)
      ? (subject as Record<string, unknown>)
      : undefined;
  const delegation = r["delegation"];
  const d =
    typeof delegation === "object" && delegation !== null && !Array.isArray(delegation)
      ? (delegation as Record<string, unknown>)
      : undefined;
  const state = r["state"];
  const delegated = r["resolvedBy"] === "delegation";
  const ok =
    isId("dec", r["id"]) &&
    (DELEGABLE_DECISION_KINDS as readonly unknown[]).includes(r["kind"]) &&
    r["actionClass"] === "ship" &&
    isInstant(r["createdAt"]) &&
    isInstant(r["expiresAt"]) &&
    (DECISION_CLASSES as readonly unknown[]).includes(r["requiredClass"]) &&
    s !== undefined &&
    Object.keys(s).every((key) => key === "ref" || key === "revision") &&
    isRef(s["ref"]) &&
    typeof s["revision"] === "string" &&
    SUBJECT_REVISION_RE.test(s["revision"]) &&
    isStoredActor(r["proposedBy"]) &&
    (state === "pending" ||
      state === "granted" ||
      state === "denied" ||
      state === "consumed" ||
      state === "superseded") &&
    optional(r["decision"], (v) => v === "grant" || v === "deny") &&
    optional(r["decidedAt"], isInstant) &&
    optional(r["resolvedBy"], (v) => v === "delegation") &&
    (delegated
      ? r["decidedByPrincipal"] === undefined &&
        d !== undefined &&
        isId("rule", d["rule"]) &&
        Number.isSafeInteger(d["revision"]) &&
        (d["revision"] as number) >= 1 &&
        optional(r["appliedBy"], isStoredActor)
      : r["delegation"] === undefined &&
        r["appliedBy"] === undefined &&
        optional(r["decidedByPrincipal"], isStoredActor)) &&
    optional(r["consumedAt"], isInstant) &&
    optional(r["supersededAt"], isInstant) &&
    optional(r["supersededReason"], (v) =>
      (DECISION_LOG_REASONS.supersede as readonly unknown[]).includes(v),
    ) &&
    optional(r["supersededBy"], (v) => isId("dec", v));
  return ok ? (r as ActionDecisionRow) : undefined;
}

/**
 * Every decision a delegation rule may resolve in a harness, as its latest row says. A
 * tolerant fold, like {@link readProposals}: the other known kinds are passed over.
 *
 * First consumers: the delegation service and the decision service.
 */
export function readActionDecisions(harnessDir: string): LedgerRead<ActionDecisionRow> {
  const fold = foldStates(decisionsLedger(harnessDir));
  const others = new Set(
    [...DECISION_ROW_KINDS].filter(
      (kind) => !(DELEGABLE_DECISION_KINDS as readonly string[]).includes(kind),
    ),
  );
  return readLedger(fold, actionDecisionOf, "delegable decision", others);
}

/**
 * An action decision's state as every reader shows it: a pending one, or an unconsumed
 * grant, past its `expiresAt` reads `expired`. Computed, never written.
 *
 * First consumers: the delegation service and the decision service.
 */
export function actionDecisionState(
  row: ActionDecisionRow,
  nowMs: number,
): ActionDecisionRow["state"] | "expired" {
  if (row.state !== "pending" && row.state !== "granted") return row.state;
  const ends = Date.parse(row.expiresAt);
  return Number.isFinite(ends) && Number.isFinite(nowMs) && nowMs < ends ? row.state : "expired";
}

/**
 * How long a decision a rule may resolve waits for an answer when its producer names none.
 *
 * First consumer: {@link openActionDecision}.
 */
export const ACTION_DECISION_TTL_MS = 7 * 86_400_000;

export type OpenActionDecision = {
  readonly kind: DelegableDecisionKind;
  readonly subject: DelegationSubject;
  readonly requiredClass: DecisionClass;
  /** Who raised it: the producer's stored actor (a system actor, for an area's producer). */
  readonly proposedBy: string;
  readonly ttlMs?: number;
  readonly now: number;
  /** The id, when the caller names it first. */
  readonly id?: string;
};

/**
 * Open a pending decision a delegation rule may resolve: a `ship`-class `merge` or
 * `rollout` bound to its subject's revision. A person may decide it from any surface, and
 * the first decision wins. A row that would not read back is refused before anything is
 * written.
 *
 * First consumers: the producers that raise merges and rollouts, and the delegation
 * service when a refused grant is asked again.
 */
export async function openActionDecision(
  harnessDir: string,
  input: OpenActionDecision,
): Promise<
  | { readonly ok: true; readonly row: ActionDecisionRow }
  | { readonly ok: false; readonly reason: string }
> {
  const id = input.id ?? mintId("dec", { now: input.now });
  const row: ActionDecisionRow = {
    id,
    kind: input.kind,
    actionClass: "ship",
    createdAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + (input.ttlMs ?? ACTION_DECISION_TTL_MS)).toISOString(),
    requiredClass: input.requiredClass,
    subject: { ref: input.subject.ref, revision: input.subject.revision },
    proposedBy: input.proposedBy,
    state: "pending",
  };
  if (actionDecisionOf(row as unknown as LedgerRecord) === undefined) {
    return { ok: false, reason: "the decision would not be one a reader accepts" };
  }
  const cas = await casAppend(
    decisionsLedger(harnessDir),
    id,
    null,
    row as unknown as LedgerRecord,
  );
  if (!cas.ok) return { ok: false, reason: cas.reason };
  if (!cas.applied) return { ok: false, reason: "the decision's id was taken" };
  return { ok: true, row };
}

/**
 * A request's state as every reader shows it: a pending one past its `expiresAt` reads
 * `expired`. Computed, never written by a read.
 *
 * First consumer: `crewhaus approvals rules`.
 */
export function proposalState(
  row: ProposalRow,
  nowMs: number,
): "pending" | "granted" | "denied" | "expired" {
  if (row.state !== "pending") return row.state;
  const ends = Date.parse(row.expiresAt);
  return Number.isFinite(ends) && Number.isFinite(nowMs) && nowMs <= ends ? "pending" : "expired";
}
