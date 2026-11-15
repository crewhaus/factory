/**
 * The job adapter: a command carried out by a queued job (an eval, a compile, a doctor run)
 * moves with its job. `wrapStore` returns a store that forwards every append and moves the
 * receipt the job names; `wrapRun` returns the runner that starts such a job only while its
 * command may still run:
 *
 * | Job | Receipt |
 * |---|---|
 * | `running` | `accepted → running`, stamped with this process, while the submitter may still do it; otherwise `rejected` (`forbidden`) and the job ends `cancelled` without running |
 * | `done` | `succeeded` |
 * | `failed` | `failed` |
 * | `cancelled` while pending | `cancelled` |
 * | `cancelled` while running | `failed`, outcome `cancelled` (a running command is never cancelled) |
 * | `interrupted` | `unknown`, needs a decision; a read-only job's is `failed`, outcome `interrupted` |
 *
 * Only a job's first, `pending` row carries `commandId`: every later append is a patch of
 * `{jobId, state, …}`, so the command, the harness and the job's previous state are read
 * from the store's fold, before the patch is forwarded. Moves are asynchronous and chained
 * per command; `idle()` resolves when every move has landed.
 *
 * A job that carries a command starts only after its receipt is checked again
 * (`actorRefused`), whatever state the receipt is in: for its kind's permission and for
 * every permission the command's submit needed (the job's `needs`). Whoever wraps the store
 * and the runner of one queue gets that check when a job is submitted and when the queue's
 * restore puts it back after a restart. A refused job never reaches the inner runner, even
 * when its receipt's move does not land.
 */
import type { CommandReceipt, ReceiptEffect } from "@crewhaus/control-contract";
import type { Ledger } from "@crewhaus/control-records";
import {
  type JobRecord,
  type JobRunner,
  type JobStore,
  isReadOnlyJob,
} from "@crewhaus/harness-supervisor";
import { type CommandsInternals, settledRow } from "./commands";
import type { ControlCore } from "./context";
import type { Settlement } from "./executor";
import { commandsLedgerOf, workspaceCommandsLedger } from "./ledgers";
import { CANCELLED, JOB_INTERRUPTED, NEEDS_DECISION, outcomeOf } from "./refusal";

export type JobAdapter = {
  wrapStore(store: JobStore): JobStore;
  /**
   * The runner a queue starts its jobs through: a job that carries a command runs only
   * while its receipt's submitter may still do it. A refused job never calls `run`, its
   * receipt moves `accepted → rejected` (`forbidden`), and the queue records it `cancelled`.
   */
  wrapRun(run: JobRunner): JobRunner;
  /** Resolves when every receipt move a job append started has landed. */
  idle(): Promise<void>;
  /** The command ids the wrapped store's job rows carry; undefined before a store is wrapped. */
  commandIds(): ReadonlySet<string> | undefined;
};

type Patch = Partial<JobRecord> & { readonly jobId: string };

const TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "cancelled", "interrupted"]);

export function createJobAdapter(core: ControlCore, commands: CommandsInternals): JobAdapter {
  const chains = new Map<string, Promise<void>>();
  const stores: JobStore[] = [];
  /** Each starting job's answer, by job id: whether its command was refused. */
  const verdicts = new Map<string, boolean>();
  let runners = 0;
  const iso = (ms: number): string => new Date(ms).toISOString();

  /** The receipt a job's command names, in its harness's ledger or Home's own. */
  const receiptFor = (
    job: JobRecord,
    commandId: string,
  ): { readonly ledger: Ledger; readonly receipt: CommandReceipt } | undefined => {
    for (const ledger of [
      commandsLedgerOf(job.harnessDir),
      workspaceCommandsLedger(core.hangarRoot),
    ]) {
      const receipt = commands.get(ledger, commandId);
      if (receipt !== undefined) return { ledger, receipt };
    }
    return undefined;
  };

  /** A refused job's receipt: `rejected` before it started, else a failed start. */
  const refusedRow = (receipt: CommandReceipt, jobId: string, at: string): CommandReceipt =>
    settledRow(
      receipt,
      {
        state: receipt.state === "accepted" ? "rejected" : "failed",
        effects: [{ kind: "job", ref: jobId, status: "skipped" }],
        outcome: outcomeOf("forbidden"),
      },
      at,
    );

  /**
   * Whether a job's command is refused: its kind's permission, and every permission its
   * submit needed (the job's `needs`), must still hold.
   */
  const refusedNow = (job: JobRecord, receipt: CommandReceipt): boolean =>
    core.actorRefused(receipt) ||
    (job.needs ?? []).some((need) => core.actorRefused(receipt, need));

  /**
   * Whether a starting job's command is refused: asked once per job, by whichever of the
   * store's `running` append and the runner reaches it first, so both act on one answer.
   */
  const verdictFor = (job: JobRecord, receipt: CommandReceipt): boolean => {
    const known = verdicts.get(job.jobId);
    if (known !== undefined) return known;
    const refused = refusedNow(job, receipt);
    verdicts.set(job.jobId, refused);
    return refused;
  };

  /** A receipt this adapter settled as refused: a later job of the same command does not run either. */
  const settledForbidden = (receipt: CommandReceipt): boolean =>
    (receipt.state === "rejected" || receipt.state === "failed") &&
    receipt.outcome?.code === "forbidden";

  /** Move a refused job's receipt; a move that does not land is said once, and the job still does not run. */
  const moveRefused = async (
    ledger: Ledger,
    receipt: CommandReceipt,
    jobId: string,
  ): Promise<void> => {
    const next = refusedRow(receipt, jobId, iso(core.now()));
    const moved = await commands.move(ledger, receipt.state, next);
    // An unwritten move is said by `move` itself.
    if (moved !== undefined && moved.state !== next.state) {
      core.warn(
        `control-service: ${receipt.id} was refused, and its receipt is ${moved.state}; its job does not run`,
      );
    }
  };

  const nextFor = (
    receipt: CommandReceipt,
    job: JobRecord,
    patch: Patch,
    previous: JobRecord["state"],
  ): CommandReceipt | undefined => {
    const effect = (status: ReceiptEffect["status"]): ReceiptEffect[] => [
      { kind: "job", ref: job.jobId, status },
    ];
    const at = patch.endedAt ?? iso(core.now());
    const settle = (s: Settlement): CommandReceipt => settledRow(receipt, s, at);
    switch (patch.state) {
      case "running":
        return receipt.state !== "accepted"
          ? undefined
          : {
              ...receipt,
              state: "running",
              startedAt: patch.startedAt ?? iso(core.now()),
              executor: core.selfExecutor(),
              effects: effect("unknown"),
            };
      case "done":
        return settle({ state: "succeeded", effects: effect("done") });
      case "failed":
        return settle({ state: "failed", effects: effect("failed") });
      case "cancelled":
        return previous === "running" || receipt.state === "running"
          ? settle({ state: "failed", effects: effect("failed"), outcome: CANCELLED })
          : settle({ state: "cancelled", effects: effect("skipped"), outcome: CANCELLED });
      case "interrupted":
        return isReadOnlyJob(job.kind)
          ? settle({ state: "failed", effects: effect("unknown"), outcome: JOB_INTERRUPTED })
          : settle({ state: "unknown", effects: effect("unknown"), outcome: NEEDS_DECISION });
      default:
        return undefined;
    }
  };

  const moveFor = async (job: JobRecord, patch: Patch, previous: JobRecord["state"]) => {
    const commandId = job.commandId;
    if (commandId === undefined) return;
    const refusedBefore = verdicts.get(job.jobId) === true;
    if (patch.state !== undefined && TERMINAL.has(patch.state)) verdicts.delete(job.jobId);
    const found = receiptFor(job, commandId);
    if (found === undefined) return;
    const { ledger, receipt } = found;
    if (receipt.state !== "accepted" && receipt.state !== "running") return;
    // A job about to start through a wrapped runner: its command is checked first.
    if (patch.state === "running" && runners > 0 && verdictFor(job, receipt)) {
      await moveRefused(ledger, receipt, job.jobId);
      return;
    }
    // The refused job's end: its receipt settles as refused when it has not yet.
    if (patch.state === "cancelled" && refusedBefore) {
      await moveRefused(ledger, receipt, job.jobId);
      return;
    }
    const next = nextFor(receipt, job, patch, previous);
    if (next !== undefined) await commands.move(ledger, receipt.state, next);
  };

  return {
    wrapStore(store) {
      stores.push(store);
      return {
        append(record) {
          // The previous state and the command come from the fold, as the queue left it.
          const before =
            record.state === undefined || record.state === "pending"
              ? undefined
              : store.read().find((job) => job.jobId === record.jobId);
          store.append(record);
          if (before === undefined || before.commandId === undefined) return;
          const job: JobRecord = { ...before, ...record } as JobRecord;
          const key = before.commandId;
          const prior = chains.get(key) ?? Promise.resolve();
          const chained = prior
            .then(() => moveFor(job, record, before.state))
            .catch((err: unknown) => {
              core.warn(
                `control-service: a job's receipt did not move: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          chains.set(key, chained);
          void chained.then(() => {
            if (chains.get(key) === chained) chains.delete(key);
          });
        },
        read: () => store.read(),
      };
    },
    wrapRun(run) {
      runners += 1;
      return (job, ctx) => {
        const commandId = job.commandId;
        if (commandId === undefined) return run(job, ctx);
        const cancelled = { cancelled: true } as const;
        const known = verdicts.get(job.jobId);
        if (known !== undefined) return known ? Promise.resolve(cancelled) : run(job, ctx);
        const found = receiptFor(job, commandId);
        if (found === undefined) return run(job, ctx);
        const { ledger, receipt } = found;
        if (settledForbidden(receipt)) return Promise.resolve(cancelled);
        // A store this adapter wrapped chained the receipt's move when the queue appended the
        // job's `running` row; it moves a refused receipt itself. Otherwise the move is here.
        if (chains.has(commandId)) {
          return verdictFor(job, receipt) ? Promise.resolve(cancelled) : run(job, ctx);
        }
        if (!refusedNow(job, receipt)) return run(job, ctx);
        // Whatever state its receipt is in, a refused job does not run; only a receipt that
        // has not settled moves.
        if (receipt.state !== "accepted" && receipt.state !== "running") {
          return Promise.resolve(cancelled);
        }
        return moveRefused(ledger, receipt, job.jobId).then(() => cancelled);
      };
    },
    idle: async () => {
      while (chains.size > 0) await Promise.all([...chains.values()]);
    },
    commandIds() {
      if (stores.length === 0) return undefined;
      const ids = new Set<string>();
      for (const store of stores) {
        for (const job of store.read()) if (job.commandId !== undefined) ids.add(job.commandId);
      }
      return ids;
    },
  };
}
