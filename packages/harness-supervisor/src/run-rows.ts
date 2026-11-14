/**
 * The rows the supervisor writes to the harness's run ledger,
 * `.crewhaus/run/control/runs/`, the same ledger the runs in its children
 * write (their working directory is the harness root).
 *
 *  - **A root run for a one-shot job.** Before the spawn, a job gets a root
 *    run: `queued`, then `preparing`, naming the execution. The child is
 *    handed `CREWHAUS_RUN_ID` and `CREWHAUS_EXECUTION_ID`, and runtime-core
 *    honours the id only because these rows say this supervisor queued it.
 *    The supervisor writes both rows until a command layer queues work.
 *  - **A root the control API queued.** A run started through the API is
 *    `queued` before its job starts (or `waiting-for-approval` when it is
 *    resumed); the start holds it under that id with no new mint: from
 *    `queued` it wins the claim `run/<id>` (a cancel that took it first
 *    refuses the start), from `waiting-for-approval` it moves by
 *    compare-and-set, and either way it appends `preparing`, copying the
 *    run's trigger and naming the execution. Any other newest row refuses the
 *    start before the spawn ({@link openApiRoot}).
 *  - **The close, when the child exits.** Under the ledger's lock, with a
 *    fold that reads the whole ledger (it decides writes): every run of the
 *    execution still `preparing` or `running` is `interrupted` by
 *    `sys:reconcile` (the process that would end it is gone; a parked run
 *    stays parked), and the root takes the exit's outcome.
 *
 * `CREWHAUS_RUN_LEDGER=0` in the plan's environment skips every row here. A
 * row that cannot be written is reported on one line and never changes the
 * supervision state.
 */
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { CANONICAL_RUN_ID_RE, type Trigger, canTransition } from "@crewhaus/control-contract";
import {
  type Ledger,
  append,
  casAppendLocked,
  controlPaths,
  foldStates,
  harnessLedger,
  publishClaim,
  withLedgerLock,
} from "@crewhaus/control-records";

/** The run ledger's directory, relative to the harness directory. */
export const RUN_LEDGER_DIR = join(controlPaths(".").controlDir, "runs");

/** The run ledger of the harness at `harnessDir`. */
export function runLedgerFor(harnessDir: string): Ledger {
  return harnessLedger(harnessDir, { dir: RUN_LEDGER_DIR }, { machine: "run" });
}

/** Whether an environment turns run rows off. */
export function runLedgerOff(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["CREWHAUS_RUN_LEDGER"] === "0";
}

/** What a supervisor-started root was started by, until a command layer says more. */
const ROOT_TRIGGER: Trigger = { kind: "cli" };

/**
 * Write a job's root run: `queued`, then `preparing`, both naming the
 * execution. Answers whether the root exists now (its `queued` row landed);
 * when it does not, the job runs without one.
 */
export function openRootRun(
  harnessDir: string,
  root: string,
  execution: string,
  at: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const ledger = runLedgerFor(harnessDir);
  const base = { id: root, at, trigger: ROOT_TRIGGER, execution };
  const queued = append(ledger, { ...base, state: "queued" });
  if (!queued.ok) return { ok: false, reason: queued.reason };
  const preparing = append(ledger, { ...base, state: "preparing" });
  // A root left `queued` still verifies; only its close goes the long way round.
  return preparing.ok ? { ok: true } : { ok: false, reason: preparing.reason };
}

/** What holds an API run's root: the supervising process. */
export type ApiRootHolder = { readonly pid: number; readonly host: string };

/**
 * Hold a run the control API queued as this execution's root: under the ledger's lock,
 * with the run folded again there, from `queued` win `run/<id>` and append `preparing`;
 * from `waiting-for-approval` (a resume, whose first start still holds the claim) append
 * `preparing` by compare-and-set. The row copies the run's trigger and names the
 * execution. Anything else, a lost claim or a lost compare-and-set refuses, and nothing is
 * written.
 */
export async function openApiRoot(
  harnessDir: string,
  run: {
    readonly id: string;
    readonly execution: string;
    readonly at: string;
    readonly holder: ApiRootHolder;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  if (!CANONICAL_RUN_ID_RE.test(run.id)) {
    return { ok: false, reason: "an API run needs a crewhaus run id: run_ and 26 characters" };
  }
  const ledger = runLedgerFor(harnessDir);
  const answer = await withLedgerLock(ledger, async (lockedAppend) => {
    const fold = foldStates(ledger);
    if (!fold.ok) return { ok: false as const, reason: fold.reason };
    const current = fold.objects.get(run.id);
    const row = {
      id: run.id,
      state: "preparing",
      at: run.at,
      trigger: current?.record["trigger"] ?? API_TRIGGER,
      execution: run.execution,
    };
    if (current?.state === "queued") {
      const claimed = publishClaim(ledger, `run/${run.id}`, { ...run.holder });
      if (!claimed.ok) {
        return {
          ok: false as const,
          reason:
            claimed.code === "exists"
              ? `run ${run.id} was taken by another process (a cancel, or another start)`
              : claimed.reason,
        };
      }
      const written = lockedAppend(row);
      return written.ok ? { ok: true as const } : { ok: false as const, reason: written.reason };
    }
    if (current?.state === "waiting-for-approval") {
      const moved = await casAppendLocked(ledger, run.id, "waiting-for-approval", row);
      if (!moved.ok) return { ok: false as const, reason: moved.reason };
      return moved.applied
        ? { ok: true as const }
        : { ok: false as const, reason: `run ${run.id} is no longer parked` };
    }
    return {
      ok: false as const,
      reason:
        current === undefined
          ? `run ${run.id} is not on the run ledger`
          : `run ${run.id} is ${current.state}, so it cannot be started`,
    };
  });
  return answer.ok ? { ok: true } : { ok: false, reason: answer.reason };
}

/** What an API run's root carries when nothing better is on its row. */
const API_TRIGGER: Trigger = { kind: "api" };

/**
 * The input file a control-API run keeps while its root is open, `inputs/<run>.json` or
 * `inputs/<run>.txt`: removed once the root ends, a regular file inside the harness only.
 */
export function removeApiRunInput(harnessDir: string, runId: string): void {
  if (!CANONICAL_RUN_ID_RE.test(runId)) return;
  const dir = join(harnessDir, controlPaths(harnessDir).inputsDir);
  for (const name of [`${runId}.json`, `${runId}.txt`]) {
    const file = join(dir, name);
    try {
      if (!lstatSync(file).isFile()) continue;
      const rel = relative(realpathSync(harnessDir), realpathSync(dir));
      if (!(rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))) continue;
      unlinkSync(file);
    } catch {
      // Gone already, or not ours to remove: nothing else depends on it.
    }
  }
}

/** How the process that carried a root ended. */
export type RootEnding =
  | { readonly state: "succeeded" | "cancelled" | "waiting-for-approval" }
  | { readonly state: "failed"; readonly failureClass: string };

const TERMINAL = new Set(["interrupted", "succeeded", "failed", "cancelled"]);
const SWEPT = new Set(["preparing", "running"]);

/** The moves from `from` to `to`, through `running` when the machine needs it; `[]` when none fits. */
function pathTo(from: string, to: string): string[] {
  if (canTransition("run", from, to)) return [to];
  if (canTransition("run", from, "running") && canTransition("run", "running", to)) {
    return ["running", to];
  }
  return [];
}

/**
 * Close what an execution left: interrupt its runs still `preparing` or
 * `running`, and move its root, when it has one, to how the process ended. A
 * root already ended is left alone. Writes nothing, and creates nothing, when
 * the harness has no run ledger and there is no root to close.
 */
export async function closeExecution(
  harnessDir: string,
  args: {
    readonly execution: string;
    readonly root?: { readonly id: string; readonly ending: RootEnding };
    readonly now: () => number;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  if (args.root === undefined && !ledgerExists(harnessDir)) return { ok: true };
  const ledger = runLedgerFor(harnessDir);
  const answer = await withLedgerLock(ledger, (lockedAppend) => {
    const fold = foldStates(ledger);
    if (!fold.ok) return { ok: false as const, reason: fold.reason };
    const at = new Date(args.now()).toISOString();
    const rows: Record<string, unknown>[] = [];
    for (const object of fold.objects.values()) {
      if (object.id === args.root?.id) continue;
      if (object.record["execution"] !== args.execution) continue;
      if (object.state === undefined || !SWEPT.has(object.state)) continue;
      rows.push({
        id: object.id,
        state: "interrupted",
        at,
        trigger: object.record["trigger"] ?? ROOT_TRIGGER,
        execution: args.execution,
        by: "sys:reconcile",
      });
    }
    const root = args.root;
    const current = root === undefined ? undefined : fold.objects.get(root.id);
    if (root !== undefined && current?.state !== undefined && !TERMINAL.has(current.state)) {
      const { state: target, ...fields } = root.ending;
      for (const state of pathTo(current.state, target)) {
        rows.push({
          id: root.id,
          state,
          at,
          trigger: current.record["trigger"] ?? ROOT_TRIGGER,
          execution: args.execution,
          ...(state === target ? fields : {}),
        });
      }
    }
    for (const row of rows) {
      const written = lockedAppend(row);
      if (!written.ok) return { ok: false as const, reason: written.reason };
    }
    // An API run's input stays while its root can still run (a park keeps it) and goes
    // once the root has ended.
    const ended =
      root !== undefined &&
      current?.state !== undefined &&
      (TERMINAL.has(current.state) || TERMINAL.has(root.ending.state));
    if (ended && root !== undefined) removeApiRunInput(harnessDir, root.id);
    return { ok: true as const };
  });
  return answer.ok ? { ok: true } : { ok: false, reason: answer.reason };
}

function ledgerExists(harnessDir: string): boolean {
  try {
    lstatSync(join(harnessDir, RUN_LEDGER_DIR));
    return true;
  } catch {
    return false;
  }
}
