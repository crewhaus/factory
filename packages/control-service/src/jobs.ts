/**
 * The job adapter: a command carried out by a queued job (an eval, a compile, a doctor run)
 * moves with its job. `wrapStore` returns a store that forwards every append and moves the
 * receipt the job names:
 *
 * | Job | Receipt |
 * |---|---|
 * | `running` | `accepted → running`, stamped with this process |
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
 */
import type { CommandReceipt, ReceiptEffect } from "@crewhaus/control-contract";
import { type JobRecord, type JobStore, isReadOnlyJob } from "@crewhaus/harness-supervisor";
import { type CommandsInternals, settledRow } from "./commands";
import type { ControlCore } from "./context";
import type { Settlement } from "./executor";
import { commandsLedgerOf, workspaceCommandsLedger } from "./ledgers";
import { CANCELLED, JOB_INTERRUPTED, NEEDS_DECISION } from "./refusal";

export type JobAdapter = {
  wrapStore(store: JobStore): JobStore;
  /** Resolves when every receipt move a job append started has landed. */
  idle(): Promise<void>;
  /** The command ids the wrapped store's job rows carry; undefined before a store is wrapped. */
  commandIds(): ReadonlySet<string> | undefined;
};

type Patch = Partial<JobRecord> & { readonly jobId: string };

export function createJobAdapter(core: ControlCore, commands: CommandsInternals): JobAdapter {
  const chains = new Map<string, Promise<void>>();
  const stores: JobStore[] = [];
  const iso = (ms: number): string => new Date(ms).toISOString();

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
    for (const ledger of [
      commandsLedgerOf(job.harnessDir),
      workspaceCommandsLedger(core.hangarRoot),
    ]) {
      const receipt = commands.get(ledger, commandId);
      if (receipt === undefined) continue;
      if (receipt.state !== "accepted" && receipt.state !== "running") return;
      const next = nextFor(receipt, job, patch, previous);
      if (next !== undefined) await commands.move(ledger, receipt.state, next);
      return;
    }
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
