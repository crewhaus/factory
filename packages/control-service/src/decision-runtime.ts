/**
 * Recovery for the decision service's commands. A receipt keeps no argument, so none of
 * these acts again: each observes what the receipt's target names and settles by what it
 * finds there.
 *
 * | Kind | What is observed |
 * |---|---|
 * | `decisions.resolve` | an `appr_`: its decision claim in the approvals ledger of the harness's session root; a `dec_`: its row in the harness's requests, change-adoption or merge and rollout decisions |
 * | `decisions.supersede` | the `appr_`'s supersede claim |
 * | `decisions.defer` | the `appr_`'s `defer` line in the decision log, at or after the receipt was accepted |
 * | `rules.create` | the standing rule whose row carries this receipt's id |
 * | `rules.revoke` | the `rule_`'s row |
 *
 * The same member as the receipt's actor → `succeeded`; another member → `rejected`
 * (`already_decided`); nothing, or an actor that is not a member id on either side (a
 * local user is kept as a keyed digest, under a different key in each ledger), or a
 * target that names only the harness → `unknown`, which a person decides. Nothing
 * becomes `succeeded` without an observation.
 */
import {
  type CommandReceipt,
  type CursorPosition,
  isId,
  parseRef,
} from "@crewhaus/control-contract";
import {
  readActionDecisions,
  readChangeAdoptions,
  readClaim,
  readPage,
  readProposals,
  readStandingRules,
} from "@crewhaus/control-records";
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
    if (row !== undefined) {
      if (row.state === "pending") return "unknown";
      return compare(row.decidedByPrincipal, receipt.actor);
    }
    // A change-adoption decision is observed the same way.
    const adoptions = readChangeAdoptions(harnessDir);
    const adoption =
      adoptions.state === "present" ? adoptions.rows.find((r) => r.id === id) : undefined;
    if (adoption !== undefined) {
      if (adoption.state === "pending") return "unknown";
      return compare(adoption.decidedByPrincipal, receipt.actor);
    }
    // And so is a merge or rollout decision: one a rule resolved names no person, so a
    // person's receipt observes it as another's.
    const actions = readActionDecisions(harnessDir);
    const action = actions.state === "present" ? actions.rows.find((r) => r.id === id) : undefined;
    if (action === undefined || action.state === "pending") return "unknown";
    if (action.resolvedBy === "delegation") return isId("prn", receipt.actor) ? "other" : "unknown";
    return compare(action.decidedByPrincipal, receipt.actor);
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

/** Lines read per page when a deferral is looked for in the decision log. */
const DEFER_SCAN_PAGE = 512;

/**
 * Who deferred what a `decisions.defer` receipt names: the receipt's actor's `defer` line
 * for that `appr_`, written at or after the receipt was accepted, is the same; a decision
 * or a supersede recorded for it since is another's; anything else is unknown. Reads the
 * log newest first and stops at the first line older than the receipt.
 */
export function observeDefer(receipt: CommandReceipt, harnessDir: string): Observed {
  const id = targetId(receipt, "decision");
  if (id === undefined || isId("dec", id)) return "unknown";
  const ledger = approvalsLedgerOf(harnessDir);
  const accepted = Date.parse(receipt.acceptedAt);
  let before: CursorPosition | undefined;
  for (;;) {
    const page = readPage(ledger, {
      limit: DEFER_SCAN_PAGE,
      ...(before !== undefined ? { before } : {}),
    });
    for (const item of page.items) {
      const line = item.record;
      const at = Date.parse(String(line["at"]));
      if (Number.isNaN(accepted) || Number.isNaN(at) || at < accepted) {
        if (!Number.isNaN(at) && at < accepted) return settledElsewhere(ledger, id);
        continue;
      }
      if (line["decision"] !== id || line["event"] !== "defer") continue;
      // Another member's deferral is not this receipt's; an older line may still be.
      if (compare(line["by"], receipt.actor) === "same") return "same";
    }
    if (page.next === undefined) return settledElsewhere(ledger, id);
    before = page.next;
  }
}

/** A deferral that is not found: another's when the request was decided or replaced since. */
function settledElsewhere(ledger: ReturnType<typeof approvalsLedgerOf>, id: string): Observed {
  for (const claim of [`decision/${id}`, `supersede/${id}`]) {
    if (readClaim(ledger, claim).ok) return "other";
  }
  return "unknown";
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
    harnessDir === undefined ? "unknown" : reconcileOf(observe(receipt, harnessDir));

/** The decision service's executors: each settles by observation, and none acts again. */
export const DECISION_EXECUTORS: Readonly<Record<string, Executor>> = {
  "decisions.resolve": executorFor(observeResolve),
  "decisions.supersede": executorFor(observeSupersede),
  "decisions.defer": executorFor(observeDefer),
  "rules.create": executorFor(observeRuleCreate),
  "rules.revoke": executorFor(observeRuleRevoke),
};

/**
 * The reconcilers the reconcile sweep asks about a receipt recovery left `unknown`: the two
 * kinds that are not safe to repeat, which recovery asks first too, and `decisions.resolve`,
 * which recovery runs again instead (it is safe to repeat), so only the sweep asks it.
 */
export const DECISION_RECONCILERS: Readonly<Record<string, Reconciler>> = {
  "decisions.resolve": reconcilerFor(observeResolve),
  "decisions.supersede": reconcilerFor(observeSupersede),
  "rules.create": reconcilerFor(observeRuleCreate),
};
