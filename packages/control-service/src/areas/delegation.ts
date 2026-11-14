/**
 * The delegation area's running code (#517, module brief 325). Its own command kinds run
 * as inline effects under the harness's control lock, so recovery never acts again: each
 * kind's executor observes whether a rule row or a request carries the receipt's id, and
 * the four that are not safe to repeat (`enable`, `propose`, `update`, `resume`) have a
 * reconciler that does the same. Every kind acts on records alone (`unsupervised`).
 *
 * Retire's `delegations` revoker ends every rule with the harness. No action is
 * registered here: an area that performs an action registers its `DelegatedAction`.
 */
import type { CommandReceipt } from "@crewhaus/control-contract";
import {
  type Ledger,
  decisionsLedger,
  delegationsLedger,
  readPage,
} from "@crewhaus/control-records";
import { DELEGATIONS_REVOKER } from "../delegations";
import type { AreaRuntime, Executor, Reconciler } from "../executor";
import { NEEDS_DECISION } from "../refusal";

/** Lines read per page while looking for a receipt's row. */
const PAGE = 512;

/** Whether any row of a ledger, applied or not, names this receipt. A raw read. */
export function ledgerNames(ledger: Ledger, cmd: string): boolean {
  let before: Parameters<typeof readPage>[1]["before"];
  for (;;) {
    const page = readPage(ledger, { limit: PAGE, ...(before !== undefined ? { before } : {}) });
    if (page.items.some((item) => item.record["cmd"] === cmd)) return true;
    if (page.next === undefined) return false;
    before = page.next;
  }
}

type Observe = (receipt: CommandReceipt, harnessDir: string) => boolean;

const onRules: Observe = (receipt, harnessDir) =>
  ledgerNames(delegationsLedger(harnessDir), receipt.id);

const onRequests: Observe = (receipt, harnessDir) =>
  ledgerNames(decisionsLedger(harnessDir), receipt.id);

const executorFor =
  (observe: Observe): Executor =>
  async ({ receipt, harnessDir }) =>
    observe(receipt, harnessDir)
      ? { state: "succeeded" }
      : { state: "unknown", outcome: NEEDS_DECISION };

const reconcilerFor =
  (observe: Observe): Reconciler =>
  (receipt, { harnessDir }) =>
    harnessDir !== undefined && observe(receipt, harnessDir) ? "done" : "unknown";

const KINDS = {
  "delegations.enable": onRules,
  "delegations.update": onRules,
  "delegations.resume": onRules,
  "delegations.revoke": onRules,
  "delegations.pause": onRules,
  "delegations.propose": onRequests,
  "delegations.apply": onRules,
  // A kept watch's line names the watch, not the receipt: nothing can be observed.
  "delegations.watches.keep": () => false,
} as const;

export const DELEGATION_RUNTIME: AreaRuntime = {
  area: "delegation",
  executors: Object.fromEntries(
    Object.entries(KINDS).map(([kind, observe]) => [kind, executorFor(observe)]),
  ),
  reconcilers: {
    "delegations.enable": reconcilerFor(onRules),
    "delegations.update": reconcilerFor(onRules),
    "delegations.resume": reconcilerFor(onRules),
    "delegations.propose": reconcilerFor(onRequests),
  },
  unsupervised: Object.keys(KINDS),
  retireRevokers: [DELEGATIONS_REVOKER],
  delegatedActions: [],
};
