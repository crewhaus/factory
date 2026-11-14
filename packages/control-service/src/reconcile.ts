/**
 * `commands.reconcile(scope)`: settle the receipts recovery left `unknown`, by what each
 * kind's reconciler observes. It visits the ledgers recovery visits (every registered
 * harness and Home's own for `"all"`, one harness's otherwise), and for each `unknown`
 * receipt whose kind has a reconciler:
 *
 * | Observed | Receipt |
 * |---|---|
 * | `done` | `succeeded`, with a `reconcile` effect that says so |
 * | `not-done` | `failed`, outcome "not done: recovery found it did not happen" |
 * | `unknown` | left as it is; nothing is written |
 *
 * Left as recorded, never asked: a receipt recovery settled `unknown` on purpose because a
 * later command overtook it ("superseded") or because the machine restarted before it ran
 * ("not started"), and a control a later control of its family on the same harness
 * overtook in its ledger. A later live daemon would otherwise be credited to an older
 * start.
 *
 * A receipt in Home's ledger whose harness has no live directory (a retire's, once the
 * harness is archived) still reaches its reconciler, with no directory: one that reads
 * only Home's root can answer, and every other answers `unknown`.
 *
 * It writes only to settle a receipt. Home runs it on its reconcile tick; it never runs on
 * a read.
 */
import type { CommandReceipt } from "@crewhaus/control-contract";
import { type Ledger, foldStates } from "@crewhaus/control-records";
import { type CommandsInternals, harnessDirOfTarget, receiptOf, settledRow } from "./commands";
import type { ControlCore } from "./context";
import { commandsLedgerOf, workspaceCommandsLedger } from "./ledgers";
import { supersededControls } from "./recover";
import type { RecoverScope } from "./recover";
import { NOT_STARTED_REBOOT, type Outcome, RECONCILED_NOT_DONE, SUPERSEDED } from "./refusal";

export type ReconcileCounts = {
  /** Observed done: settled `succeeded`. */
  readonly succeeded: number;
  /** Observed not done: settled `failed`. */
  readonly failed: number;
  /** Asked, and still unknown: left as they were. */
  readonly left: number;
};

/** Outcomes recovery chose on purpose: such a receipt stays as recorded. */
const DELIBERATE: readonly Outcome[] = [SUPERSEDED, NOT_STARTED_REBOOT];

function deliberatelyUnknown(receipt: CommandReceipt): boolean {
  const outcome = receipt.outcome;
  return DELIBERATE.some(
    (chosen) => outcome?.code === chosen.code && outcome.message === chosen.message,
  );
}

export function createReconcile(
  core: ControlCore,
  commands: CommandsInternals,
): (scope: RecoverScope) => Promise<ReconcileCounts> {
  const iso = (ms: number): string => new Date(ms).toISOString();
  return async (scope) => {
    const counts = { succeeded: 0, failed: 0, left: 0 };
    const targets: Array<{ readonly ledger: Ledger; readonly dir: string | undefined }> = [];
    if (scope === "all") {
      for (const dir of core.harnessDirs()) targets.push({ ledger: commandsLedgerOf(dir), dir });
      targets.push({ ledger: workspaceCommandsLedger(core.hangarRoot), dir: undefined });
    } else {
      targets.push({ ledger: commandsLedgerOf(scope.harness), dir: scope.harness });
    }
    for (const { ledger, dir } of targets) {
      const fold = foldStates(ledger);
      if (!fold.ok) {
        if (fold.code !== "not-found")
          core.warn(`control-service: reconciliation skipped a ledger: ${fold.reason}`);
        continue;
      }
      const overtaken = supersededControls(fold.objects.values(), dir !== undefined);
      for (const object of fold.objects.values()) {
        if (object.state !== "unknown") continue;
        const receipt = receiptOf(object.record);
        if (deliberatelyUnknown(receipt) || overtaken.has(receipt.id)) continue;
        const reconciler = core.reconcilers.get(receipt.kind);
        if (reconciler === undefined) continue;
        let seen: "done" | "not-done" | "unknown";
        try {
          seen = await reconciler(receipt, {
            harnessDir: dir ?? harnessDirOfTarget(core, receipt.target),
            probe: core.probe,
            now: core.now,
            hangarRoot: core.hangarRoot,
          });
        } catch (err) {
          core.warn(
            `control-service: reconciling ${receipt.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          seen = "unknown";
        }
        if (seen === "unknown") {
          counts.left += 1;
          continue;
        }
        const moved = await commands.move(
          ledger,
          "unknown",
          settledRow(
            receipt,
            seen === "done"
              ? {
                  state: "succeeded",
                  effects: [...receipt.effects, { kind: "reconcile", status: "done" }],
                }
              : { state: "failed", outcome: RECONCILED_NOT_DONE },
            iso(core.now()),
          ),
        );
        if (moved?.state === "succeeded") counts.succeeded += 1;
        else if (moved?.state === "failed") counts.failed += 1;
        else counts.left += 1;
      }
    }
    return counts;
  };
}
