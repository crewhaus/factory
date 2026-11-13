/**
 * The harness's run ledger, `.crewhaus/run/control/runs/`, and the rows a library writes
 * there for a run whose turn has not started yet: the work was accepted, and nothing in
 * the runtime has recorded it.
 *
 *  - {@link appendPreparingRun}: `queued`, then `preparing`, for one fresh id, naming
 *    what started it and the process holding it (`holder`: pid, host, start time). The
 *    run machine's entry states are `queued` and `running`, so a run that is prepared
 *    first enters queued; the runtime's later `running` row folds legally after it.
 *  - {@link settleUnstartedRun}: when that run's newest row is still `preparing`, the row
 *    that closes it. The runtime's own rows are never written after: a run it opened is
 *    the runtime's to end.
 *
 * Both are one or two appends with no process spawned and no socket, so a compiled daemon
 * can call them.
 */
import { canTransition } from "@crewhaus/control-contract";
import type { SafeFsFailure } from "@crewhaus/tool-safety/fs";
import { type LedgerRecord, append, withLedgerLock } from "./ledger";
import type { Ledger, RecordSource } from "./paths";
import { readPage } from "./tail";

/**
 * How many of the ledger's newest lines a settle or a sweep reads to find a run's newest
 * row. A run older than this is left as it is: a capped read can only decline to write.
 *
 * First consumers: {@link settleUnstartedRun} and the control plane's run sweep.
 */
export const RUN_ROW_PAGE_LINES = 256;

/** The process that holds an accepted run, in the lease's vocabulary. */
export type RunHolder = {
  readonly pid: number;
  readonly host: string;
  /** When the process started, ISO. */
  readonly startedAt: string;
};

export type PreparingRun = {
  readonly id: string;
  readonly at: string;
  readonly trigger: LedgerRecord;
  readonly holder: RunHolder;
};

/**
 * Append `queued`, then `preparing`, for `run.id`: two lines, each refused whole when it
 * is not under the row bound. The first failure is the answer; a run left `queued` is
 * still on record.
 *
 * First consumer: channel-adapter-base's `acceptInbound`.
 */
export function appendPreparingRun(
  ledger: Ledger,
  run: PreparingRun,
): { readonly ok: true } | SafeFsFailure {
  const base = { id: run.id, at: run.at, trigger: run.trigger, holder: run.holder };
  const queued = append(ledger, { ...base, state: "queued" });
  if (!queued.ok) return queued;
  const preparing = append(ledger, { ...base, state: "preparing" });
  return preparing.ok ? { ok: true } : preparing;
}

/**
 * The newest row for each id among the ledger's newest {@link RUN_ROW_PAGE_LINES} lines.
 * A view: it decides nothing on its own.
 *
 * First consumers: {@link settleUnstartedRun} and the control plane's run sweep.
 */
export function newestRunRows(source: RecordSource): ReadonlyMap<string, LedgerRecord> {
  const page = readPage(source, { limit: RUN_ROW_PAGE_LINES });
  const newest = new Map<string, LedgerRecord>();
  for (const item of page.items) {
    const id = item.record["id"];
    if (typeof id === "string" && !newest.has(id)) newest.set(id, item.record);
  }
  return newest;
}

/** The row that closes a run its turn never reached. */
export type UnstartedClose = {
  readonly state: "cancelled" | "failed" | "interrupted";
  readonly at: string;
  /** The fields the row carries beside `id`, `state`, `at` and `trigger`. */
  readonly fields: Readonly<Record<string, unknown>>;
};

export type SettleAnswer = { readonly ok: true; readonly settled: boolean } | SafeFsFailure;

/**
 * Close run `id` when its newest row is still `preparing`, under the ledger's lock with the
 * row read again there. `accept`, when given, is asked about that row too (the sweep's
 * holder check). A run whose newest row is anything else, or is not among the newest
 * lines, is left as it is (`settled: false`). The closing row keeps the run's `trigger`.
 *
 * First consumers: channel-adapter-base's `acceptInbound` and the control plane's run sweep.
 */
export async function settleUnstartedRun(
  ledger: Ledger,
  id: string,
  close: UnstartedClose,
  accept?: (row: LedgerRecord) => boolean,
): Promise<SettleAnswer> {
  if (!canTransition("run", "preparing", close.state)) return { ok: true, settled: false };
  const answer = await withLedgerLock(ledger, (lockedAppend): SettleAnswer => {
    const row = newestRunRows(ledger).get(id);
    if (row === undefined || row["state"] !== "preparing") return { ok: true, settled: false };
    if (accept !== undefined && !accept(row)) return { ok: true, settled: false };
    const written = lockedAppend({
      ...close.fields,
      id,
      state: close.state,
      at: close.at,
      ...(row["trigger"] !== undefined ? { trigger: row["trigger"] } : {}),
    });
    return written.ok ? { ok: true, settled: true } : written;
  });
  return answer;
}
