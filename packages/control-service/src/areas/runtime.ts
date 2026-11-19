/**
 * The runtime area's running code (#516, module brief 333), composed from one half per
 * file so each half lands on its own lines. The work half is here; a later half spreads its
 * executors and reconcilers on the line below the work half's.
 *
 * Work commands run as inline effects, so recovery never acts again: each kind's executor
 * observes whether the work log (or, for `work.start`, the run ledger) has a line carrying
 * the receipt's id, and the kinds that are not safe to repeat have a reconciler that does
 * the same. Every work kind but `work.start` acts on records alone (`unsupervised`).
 */
import type { CommandReceipt } from "@crewhaus/control-contract";
import { runsLedger } from "@crewhaus/control-records";
import { workLedger } from "@crewhaus/tool-work/work-items";
import type { AreaRuntime, Executor, Reconciler } from "../executor";
import { NEEDS_DECISION } from "../refusal";
import { ledgerNames } from "./delegation";

type Observe = (receipt: CommandReceipt, harnessDir: string) => boolean;

const onWork: Observe = (receipt, harnessDir) => ledgerNames(workLedger(harnessDir), receipt.id);

const onRuns: Observe = (receipt, harnessDir) => ledgerNames(runsLedger(harnessDir), receipt.id);

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

/** Each work kind and the ledger its effect writes a line to. */
const WORK_KINDS = {
  "work.create": onWork,
  "work.update": onWork,
  "work.accept": onWork,
  "work.decline": onWork,
  "work.reopen": onWork,
  "work.cancel": onWork,
  "work.rank": onWork,
  "work.adopt": onWork,
  "work.start": onRuns,
} as const;

export const WORK_EXECUTORS: Readonly<Record<string, Executor>> = Object.fromEntries(
  Object.entries(WORK_KINDS).map(([kind, observe]) => [kind, executorFor(observe)]),
);

/** The kinds that are not safe to repeat, each settled by what its ledger shows. */
export const WORK_RECONCILERS: Readonly<Record<string, Reconciler>> = {
  "work.create": reconcilerFor(onWork),
  "work.update": reconcilerFor(onWork),
  "work.start": reconcilerFor(onRuns),
};

export const WORK_UNSUPERVISED: readonly string[] = Object.keys(WORK_KINDS).filter(
  (kind) => kind !== "work.start",
);

export const RUNTIME_RUNTIME: AreaRuntime = {
  area: "runtime",
  executors: {
    ...WORK_EXECUTORS,

    // ...BUDGET_EXECUTORS,
  },
  reconcilers: {
    ...WORK_RECONCILERS,

    // ...BUDGET_RECONCILERS,
  },
  unsupervised: [
    ...WORK_UNSUPERVISED,

    // ...BUDGET_UNSUPERVISED,
  ],
};
