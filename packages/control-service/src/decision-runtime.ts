/**
 * Recovery for the decision service's commands. A receipt keeps no argument, so none of
 * these acts again: each observes what the receipt's target names and settles by what it
 * finds there.
 *
 * | Kind | What is observed |
 * |---|---|
 * | `decisions.resolve` | an `appr_`: its decision claim in the approvals ledger of the harness's session root; a `dec_`: its row in the harness's requests |
 * | `decisions.supersede` | the `appr_`'s supersede claim |
 * | `rules.create` | the standing rule whose row carries this receipt's id |
 * | `rules.revoke` | the `rule_`'s row |
 *
 * The same member as the receipt's actor → `succeeded`; another member → `rejected`
 * (`already_decided`); nothing, or an actor that is not a member id on either side (a
 * local user is kept as a keyed digest, under a different key in each ledger), or a
 * target that names only the harness → `unknown`, which a person decides. Nothing
 * becomes `succeeded` without an observation.
 */
import { type CommandReceipt, isId, parseRef } from "@crewhaus/control-contract";
import { readClaim, readProposals, readStandingRules } from "@crewhaus/control-records";
import { readHarnessEnvFiles } from "@crewhaus/harness-supervisor";
import {
  approvalsLedger,
  parseDecisionClaim,
  parseSupersedeClaim,
  resolveHarnessSessionRoot,
} from "@crewhaus/session-store";
import type { Executor, Reconciler, Reconciliation, Settlement } from "./executor";
import { NEEDS_DECISION, outcomeOf } from "./refusal";

/** What an observation found, against the receipt's own actor. */
export type Observed = "same" | "other" | "unknown";

function compare(found: unknown, receiptActor: unknown): Observed {
  if (!isId("prn", found) || !isId("prn", receiptActor)) return "unknown";
  return found === receiptActor ? "same" : "other";
}

/** The id a receipt's target names, when it is `<hrn>/<kind>/<id>` of this kind. */
function targetId(receipt: CommandReceipt, kind: string): string | undefined {
  const ref = parseRef(receipt.target);
  if ("error" in ref || ref.scope === "home" || ref.kind !== kind) return undefined;
  return ref.id;
}

function approvalsLedgerOf(harnessDir: string) {
  return approvalsLedger(
    resolveHarnessSessionRoot(harnessDir, readHarnessEnvFiles(harnessDir).vars).root,
  );
}

/** Who decided what a `decisions.resolve` receipt names. */
export function observeResolve(receipt: CommandReceipt, harnessDir: string): Observed {
  const id = targetId(receipt, "decision");
  if (id === undefined) return "unknown";
  if (isId("dec", id)) {
    const read = readProposals(harnessDir);
    const row = read.state === "present" ? read.rows.find((r) => r.id === id) : undefined;
    if (row === undefined || row.state === "pending") return "unknown";
    return compare(row.decidedByPrincipal, receipt.actor);
  }
  const claim = readClaim(approvalsLedgerOf(harnessDir), `decision/${id}`);
  if (!claim.ok) return "unknown";
  const parsed = parseDecisionClaim(claim.content.record);
  return typeof parsed === "string" ? "unknown" : compare(parsed.decidedByPrincipal, receipt.actor);
}

/** Who superseded what a `decisions.supersede` receipt names. */
export function observeSupersede(receipt: CommandReceipt, harnessDir: string): Observed {
  const id = targetId(receipt, "decision");
  if (id === undefined || isId("dec", id)) return "unknown";
  const claim = readClaim(approvalsLedgerOf(harnessDir), `supersede/${id}`);
  if (!claim.ok) return "unknown";
  const parsed = parseSupersedeClaim(claim.content.record);
  return typeof parsed === "string" ? "unknown" : compare(parsed.byPrincipal, receipt.actor);
}

/** Who made the standing rule that carries a `rules.create` receipt's id. */
export function observeRuleCreate(receipt: CommandReceipt, harnessDir: string): Observed {
  const read = readStandingRules(harnessDir);
  const row = read.state === "present" ? read.rows.find((r) => r.cmd === receipt.id) : undefined;
  return row === undefined ? "unknown" : compare(row.createdBy, receipt.actor);
}

/** Who revoked the standing rule a `rules.revoke` receipt names. */
export function observeRuleRevoke(receipt: CommandReceipt, harnessDir: string): Observed {
  const id = targetId(receipt, "rule");
  if (id === undefined) return "unknown";
  const read = readStandingRules(harnessDir);
  const row = read.state === "present" ? read.rows.find((r) => r.id === id) : undefined;
  if (row === undefined || row.state !== "revoked") return "unknown";
  return compare(row.revokedBy, receipt.actor);
}

function settleOf(observed: Observed): Settlement {
  if (observed === "same") return { state: "succeeded" };
  if (observed === "other") return { state: "rejected", outcome: outcomeOf("already_decided") };
  return { state: "unknown", outcome: NEEDS_DECISION };
}

function reconcileOf(observed: Observed): Reconciliation {
  return observed === "same" ? "done" : observed === "other" ? "not-done" : "unknown";
}

type Observer = (receipt: CommandReceipt, harnessDir: string) => Observed;

const executorFor =
  (observe: Observer): Executor =>
  async ({ receipt, harnessDir }) =>
    settleOf(observe(receipt, harnessDir));

const reconcilerFor =
  (observe: Observer): Reconciler =>
  (receipt, { harnessDir }) =>
    reconcileOf(observe(receipt, harnessDir));

/** The decision service's executors: each settles by observation, and none acts again. */
export const DECISION_EXECUTORS: Readonly<Record<string, Executor>> = {
  "decisions.resolve": executorFor(observeResolve),
  "decisions.supersede": executorFor(observeSupersede),
  "rules.create": executorFor(observeRuleCreate),
  "rules.revoke": executorFor(observeRuleRevoke),
};

/** The reconcilers of the two kinds that are not safe to repeat. */
export const DECISION_RECONCILERS: Readonly<Record<string, Reconciler>> = {
  "decisions.supersede": reconcilerFor(observeSupersede),
  "rules.create": reconcilerFor(observeRuleCreate),
};
