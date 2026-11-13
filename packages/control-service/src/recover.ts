/**
 * `commands.recover(scope)`: what to do with commands whose process died. It looks only at
 * `accepted` and `running` receipts whose executor is provably dead (a receipt already
 * `unknown` is the reconcile sweep's), and for each the first matching rule acts:
 *
 * | Found | Action |
 * |---|---|
 * | a job's receipt | the job queue moves it; Home alone settles one no job row names |
 * | a control a later control of the same family on the same harness overtook | `unknown`: superseded, never run |
 * | a daemon start accepted before the machine booted | `unknown`: not started, the machine restarted |
 * | `accepted`, safe to repeat | run again |
 * | `accepted`, not safe to repeat | reconcile: done → `succeeded`, not done → run again |
 * | `running`, safe to repeat | the first recoverer to claim it runs it again |
 * | `running`, not safe to repeat | reconcile: done → `succeeded`, not done → `failed` |
 * | no executor | `unknown`: interrupted, needs a decision |
 *
 * An inline effect never writes `running`, so an `accepted` receipt does not prove its
 * effect never started: that is why a kind that is not safe to repeat is reconciled first.
 * A control is run again only while it is the latest of its family on the harness: once
 * an operator has started, stopped or drained the daemon since, re-running an older daemon
 * command would undo theirs, and the same holds for a pause or resume, and for a disable
 * or enable. The families are independent: a pause after a stop leaves the stop to run.
 *
 * | Family | Kinds |
 * |---|---|
 * | daemon | `controls.start`, `controls.stop`, `controls.restart`, `controls.drain` |
 * | intake | `controls.pause`, `controls.resume` |
 * | deployment | `controls.disable`, `controls.enable` |
 *
 * `controls.retire` is in none: it has no executor, so it is never run again.
 * Recovery writes; it runs at Home's boot and before the CLI's first change to a harness,
 * never on a read.
 */
import type { CommandReceipt } from "@crewhaus/control-contract";
import {
  type FoldedObject,
  type Ledger,
  foldStates,
  publishClaim,
  readClaim,
} from "@crewhaus/control-records";
import {
  type CommandsInternals,
  harnessDirOfTarget,
  kindIsIdempotent,
  receiptOf,
  settledRow,
} from "./commands";
import type { ControlCore } from "./context";
import { executorDead } from "./executor";
import { commandsLedgerOf, workspaceCommandsLedger } from "./ledgers";
import { NEEDS_DECISION, NOT_STARTED_REBOOT, type Outcome, SUPERSEDED } from "./refusal";

export type RecoverScope = { readonly harness: string } | "all";

export type RecoverCounts = {
  /** Run again by this process. */
  readonly redispatched: number;
  /** Settled by a reconciler's observation. */
  readonly reconciled: number;
  /** Left for a person: interrupted, needs a decision. */
  readonly unknown: number;
};

/** What the job queue holds, for Home's recovery to tell a job that was never queued. */
export type JobRowsView = () => ReadonlySet<string> | undefined;

const DAEMON_STARTS = new Set(["controls.start", "controls.restart"]);

export function isJobReceipt(receipt: CommandReceipt): boolean {
  return receipt.effects.some((effect) => effect.kind === "job");
}

/** The family each control belongs to; a kind not named here is in none. */
const CONTROL_FAMILIES: Readonly<Record<string, string>> = {
  "controls.start": "daemon",
  "controls.stop": "daemon",
  "controls.restart": "daemon",
  "controls.drain": "daemon",
  "controls.pause": "intake",
  "controls.resume": "intake",
  "controls.disable": "deployment",
  "controls.enable": "deployment",
};

/**
 * The controls in one ledger that a later control of the same family on the same harness
 * overtook: every one but the latest per harness and family, by acceptance time, then by
 * place in the ledger. In a harness's own ledger every control is that harness's; in
 * Home's they are told apart by target. A later command counts whatever state it reached:
 * the operator asked for it after.
 */
export function supersededControls(
  objects: Iterable<FoldedObject>,
  ownHarness: boolean,
): ReadonlySet<string> {
  const latest = new Map<string, { readonly id: string; readonly at: number }>();
  const all: string[] = [];
  for (const object of objects) {
    const kind = object.record["kind"];
    const family =
      typeof kind === "string" && Object.hasOwn(CONTROL_FAMILIES, kind)
        ? CONTROL_FAMILIES[kind]
        : undefined;
    if (family === undefined) continue;
    const subject = `${family}\0${ownHarness ? "" : String(object.record["target"])}`;
    const parsed = Date.parse(String(object.record["acceptedAt"]));
    const at = Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    all.push(object.id);
    const seen = latest.get(subject);
    // Fold order is ledger order, so a tie goes to the one written later.
    if (seen === undefined || at >= seen.at) latest.set(subject, { id: object.id, at });
  }
  const keep = new Set([...latest.values()].map((entry) => entry.id));
  return new Set(all.filter((id) => !keep.has(id)));
}

export function createRecover(
  core: ControlCore,
  commands: CommandsInternals,
  jobs: { readonly idle: () => Promise<void>; readonly commandIds: JobRowsView },
): (scope: RecoverScope) => Promise<RecoverCounts> {
  const iso = (ms: number): string => new Date(ms).toISOString();

  return async (scope) => {
    const counts = { redispatched: 0, reconciled: 0, unknown: 0 };
    const targets: Array<{ readonly ledger: Ledger; readonly dir: string | undefined }> = [];
    if (scope === "all") {
      // The job restore's moves land first, so a receipt it settled is not judged again.
      await jobs.idle();
      for (const dir of core.harnessDirs()) targets.push({ ledger: commandsLedgerOf(dir), dir });
      targets.push({ ledger: workspaceCommandsLedger(core.hangarRoot), dir: undefined });
    } else {
      targets.push({ ledger: commandsLedgerOf(scope.harness), dir: scope.harness });
    }
    const queued = scope === "all" && core.mode === "server" ? jobs.commandIds() : undefined;
    const hostBootedAt = core.hostBootedAt();

    const settle = async (
      ledger: Ledger,
      receipt: CommandReceipt,
      state: "succeeded" | "failed" | "unknown",
      outcome?: Outcome,
    ): Promise<void> => {
      await commands.move(
        ledger,
        receipt.state,
        settledRow(
          receipt,
          {
            state,
            ...(state === "succeeded"
              ? { effects: [...receipt.effects, { kind: "reconcile", status: "done" as const }] }
              : {}),
            ...(outcome !== undefined ? { outcome } : {}),
          },
          iso(core.now()),
        ),
      );
    };

    for (const { ledger, dir } of targets) {
      const fold = foldStates(ledger);
      if (!fold.ok) {
        if (fold.code !== "not-found")
          core.warn(`control-service: recovery skipped a ledger: ${fold.reason}`);
        continue;
      }
      const superseded = supersededControls(fold.objects.values(), dir !== undefined);
      for (const object of fold.objects.values()) {
        if (object.state !== "accepted" && object.state !== "running") continue;
        const receipt = receiptOf(object.record);
        if (!executorDead(receipt.executor, core.probe, core.host, hostBootedAt)) continue;
        const harnessDir = dir ?? harnessDirOfTarget(core, receipt.target);

        if (isJobReceipt(receipt)) {
          // The job queue's restore is authoritative. Home settles only a command whose
          // job never reached the queue: it died between acceptance and the submit.
          if (queued !== undefined && !queued.has(receipt.id)) {
            await settle(ledger, receipt, "unknown", NEEDS_DECISION);
            counts.unknown += 1;
          }
          continue;
        }

        if (superseded.has(receipt.id)) {
          // Running it now would undo what the operator asked for since.
          await settle(ledger, receipt, "unknown", SUPERSEDED);
          counts.unknown += 1;
          continue;
        }

        if (
          receipt.state === "accepted" &&
          DAEMON_STARTS.has(receipt.kind) &&
          Date.parse(receipt.acceptedAt) < hostBootedAt
        ) {
          await settle(ledger, receipt, "unknown", NOT_STARTED_REBOOT);
          counts.unknown += 1;
          continue;
        }

        const executor = core.executors.get(receipt.kind);
        if (executor === undefined || harnessDir === undefined) {
          await settle(ledger, receipt, "unknown", NEEDS_DECISION);
          counts.unknown += 1;
          continue;
        }

        const idempotent = kindIsIdempotent(receipt.kind);
        const reconciler = core.reconcilers.get(receipt.kind);
        const observe = async () =>
          reconciler === undefined
            ? "unknown"
            : await reconciler(receipt, {
                harnessDir,
                probe: core.probe,
                now: core.now,
                hangarRoot: core.hangarRoot,
              });

        if (receipt.state === "accepted") {
          if (idempotent) {
            await commands.dispatch(ledger, receipt, harnessDir);
            counts.redispatched += 1;
            continue;
          }
          const seen = await observe();
          if (seen === "done") {
            await settle(ledger, receipt, "succeeded");
            counts.reconciled += 1;
          } else if (seen === "not-done") {
            await commands.dispatch(ledger, receipt, harnessDir);
            counts.redispatched += 1;
          } else {
            await settle(ledger, receipt, "unknown", NEEDS_DECISION);
            counts.unknown += 1;
          }
          continue;
        }

        // running
        if (idempotent) {
          const claim = `recover/${receipt.id}`;
          const won = publishClaim(ledger, claim, {
            id: receipt.id,
            executor: core.selfExecutor(),
          });
          if (won.ok) {
            await commands.dispatch(ledger, receipt, harnessDir);
            counts.redispatched += 1;
            continue;
          }
          if (won.code !== "exists") {
            core.warn(`control-service: recovery could not claim ${receipt.id}: ${won.reason}`);
            continue;
          }
          const holder = readClaim(ledger, claim);
          const recorded = holder.ok ? holder.content.record["executor"] : undefined;
          if (executorDead(recorded, core.probe, core.host, hostBootedAt)) {
            // A recoverer that died too: a second crash must not strand the receipt.
            await settle(ledger, receipt, "unknown", NEEDS_DECISION);
            counts.unknown += 1;
          }
          continue;
        }
        const seen = await observe();
        if (seen === "done") {
          await settle(ledger, receipt, "succeeded");
          counts.reconciled += 1;
        } else if (seen === "not-done") {
          await settle(ledger, receipt, "failed");
          counts.reconciled += 1;
        } else {
          await settle(ledger, receipt, "unknown", NEEDS_DECISION);
          counts.unknown += 1;
        }
      }
    }
    return counts;
  };
}
