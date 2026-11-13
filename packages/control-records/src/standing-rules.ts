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
 *
 * Both ledgers are `harnessLedger`s, so they share the harness's control lock and claims
 * directory: a writer that holds the lock for one may compare-and-set on both
 * (`casAppendLocked`). Reads take no lock, write nothing and repair nothing.
 */
import {
  DECISION_CLASSES,
  type DecisionClass,
  type StandingRuleTerms,
  isId,
  isStoredActor,
} from "@crewhaus/control-contract";
import { cachedPerPath } from "./fail-closed";
import { type FoldAnswer, type LedgerRecord, foldStates } from "./ledger";
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
  readonly derivedFrom: string;
  readonly proposedBy: string;
  readonly terms: StandingRuleTerms;
  readonly state: "pending" | "granted" | "denied";
  readonly decision?: "grant" | "deny";
  readonly decidedAt?: string;
  readonly decidedByPrincipal?: string;
  /** The rule a grant made. */
  readonly rule?: string;
};

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
    isTime(r["createdAt"]) &&
    isTime(r["expiresAt"]) &&
    optional(r["cmd"], (v) => isId("cmd", v)) &&
    (r["state"] === "active" || r["state"] === "revoked" || r["state"] === "expired") &&
    optional(r["revokedAt"], isTime) &&
    optional(r["revokedBy"], isStoredActor) &&
    optional(r["expiredAt"], isTime);
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
  const ok =
    isId("dec", r["id"]) &&
    r["kind"] === "standing-rule-proposal" &&
    isTime(r["createdAt"]) &&
    isTime(r["expiresAt"]) &&
    (DECISION_CLASSES as readonly unknown[]).includes(r["requiredClass"]) &&
    isId("appr", r["derivedFrom"]) &&
    isStoredActor(r["proposedBy"]) &&
    t !== undefined &&
    t["ruleKind"] === "allow" &&
    isText(t["tool"]) &&
    isText(t["pattern"]) &&
    isTime(t["expiresAt"]) &&
    (r["state"] === "pending" || r["state"] === "granted" || r["state"] === "denied") &&
    optional(r["decision"], (v) => v === "grant" || v === "deny") &&
    optional(r["decidedAt"], isTime) &&
    optional(r["decidedByPrincipal"], isStoredActor) &&
    optional(r["rule"], (v) => isId("rule", v));
  return ok ? (r as ProposalRow) : undefined;
}

function readLedger<T>(
  fold: FoldAnswer,
  of: (row: LedgerRecord) => T | undefined,
  what: string,
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
    if (row === undefined) anomalies.push(`${object.id}: the row is not a ${what}`);
    else rows.push(row);
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
  return readLedger(foldStates(decisionsLedger(harnessDir)), proposalOf, "standing-rule request");
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
