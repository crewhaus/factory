/**
 * Runs through the control API (#507, #513): start one, cancel one, resume one, carried
 * out by the run adapter for the harness's shape. One table says which adapter a shape
 * has, and both a harness's `runs.create` capability and its admission read it, so the
 * two cannot disagree.
 *
 * - **managed**: the run is queued for the daemon's follower (`queueManagedRun`, under the
 *   one tenant `home`), and the daemon is woken to claim it. A daemon that is not running
 *   claims it when it starts, when the caller asked to queue.
 * - **job** (cli, crew, workflow, graph): the input goes to a `0600` file inside the
 *   harness, the run is `queued` on the run ledger, and the head's supervisor starts one
 *   job for it, whose environment names the run and the origin of its input (`api`). A
 *   parked job resumes under the same run, continuing the run that parked.
 * - **daemon** (every other shape): a run is not started this way; the answer names the
 *   shape's own intake.
 *
 * Each operation is planned first: every refusal (the operator record, an old build, an
 * executor that is not there, a run that ended) is decided before the command is
 * accepted, so a refusal writes nothing. The plan's effect runs once the receipt is
 * written, and settles it.
 *
 * Cancelling a run withdraws what it waits on. A parked job run that nothing holds (its
 * process ends when it parks) is cancelled here, with no daemon and no Home running: under
 * the run ledger's lock, while it is still parked, every request bound to it, to the
 * top-level runs it started or to a run any of them continues is withdrawn
 * (`run-cancelled`, naming the run), and then it and each of its parked runs are
 * `cancelled`. A grant decided after that finds nothing to decide, and no resume starts
 * any of them again.
 *
 * A resumed job is started again under the same run; runtime-core's loops under that
 * root continue its parked top-level run, so a grant decided for the park is spent by the
 * resumed job. Only a run the API started (trigger `api`, its input file still there) is
 * resumed this way.
 */
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  CANONICAL_RUN_ID_RE,
  type CapabilityDescriptor,
  type CommandReceipt,
  type CursorPosition,
  type ErrorCode,
  type ReceiptEffect,
  type RunControlShape,
  SHAPE_RUN_CONTROLS,
  canTransition,
  parseRef,
} from "@crewhaus/control-contract";
import {
  type LedgerRecord,
  append,
  casAppendLocked,
  controlPaths,
  foldStates,
  intakeVerdict,
  publishClaim,
  readPage,
  runsLedger,
  withLedgerLock,
} from "@crewhaus/control-records";
import type { ControlClient, ControlTarget } from "@crewhaus/gateway-protocol/control-client";
import { queueManagedRun } from "@crewhaus/gateway-server/managed-runs";
import {
  type ApiRunInput,
  type StartResult,
  readBundleStamp,
  readHarnessEnvFiles,
  removeApiRunInput,
  resolveBundle,
} from "@crewhaus/harness-supervisor";
import { createPendingApprovalStore, resolveHarnessSessionRoot } from "@crewhaus/session-store";
import type { ReconcileContext, Reconciler, Reconciliation, Settlement } from "./executor";
import { type Outcome, outcomeOf } from "./refusal";

/** The tenant every run Home starts on a managed daemon serves. */
export const HOME_RUN_TENANT = "home";

/** The oldest build that checks a run's input where the run starts. */
export const RUNS_MIN_BUNDLE = "0.9.0";

export type RunAdapterShape = "managed" | "job" | "daemon";

/** Which adapter carries out a shape's runs: the one table capabilities and admission read. */
export const RUN_ADAPTER_SHAPES: Readonly<Record<RunControlShape, RunAdapterShape>> = {
  cli: "job",
  workflow: "job",
  channel: "daemon",
  graph: "job",
  managed: "managed",
  pipeline: "daemon",
  crew: "job",
  research: "daemon",
  batch: "daemon",
  voice: "daemon",
  browser: "daemon",
};

/** Job shapes that read their input on stdin, which carries no subject. */
const STDIN_SHAPES: ReadonlySet<string> = new Set(["crew", "workflow", "graph"]);

/** A refusal before acceptance: nothing was written. */
export type RunRefusal = {
  readonly code: ErrorCode;
  readonly reason: string;
  readonly message: string;
  /** A real CLI command that does it, when there is one. */
  readonly verb?: string;
  /** What to do instead. */
  readonly remedy?: string;
};

/** What a planned effect returns: how the command ended, and what the caller is answered. */
export type RunEffectAnswer<T> = { readonly settle: Settlement; readonly value: T };

/** A planned run operation: refused, or an effect to run once its receipt is written. */
export type RunPlan<T> =
  | { readonly ok: false; readonly refusal: RunRefusal }
  | {
      readonly ok: true;
      readonly effect: (receipt: CommandReceipt) => Promise<RunEffectAnswer<T>>;
    };

/** What the head lends a run operation. Every part is optional; one that is missing refuses. */
export type RunHome = {
  /** Start one job for an API run through the head's supervisor (its plan passes `apiRun`). */
  readonly startRunJob?: (harnessDir: string, apiRun: ApiRunInput) => Promise<StartResult>;
  /** Stop the job process that holds a run, when this head holds it. `false`: it does not. */
  readonly stopRunJob?: (harnessDir: string, runId: string) => Promise<boolean>;
  /** The client the head reaches a daemon's control plane with. */
  readonly controlClient?: ControlClient;
  /** Where a harness's daemon's control plane is. */
  readonly controlTarget?: (harnessDir: string) => ControlTarget;
  readonly now?: () => number;
};

/** A run as the ledger last recorded it. */
export type RunRow = Readonly<Record<string, unknown>> & { readonly id: string };

export type RunCreateValue = {
  /** The run's queued row, when it was recorded. */
  readonly run?: RunRow;
  /** Why it was not started, when it was not. */
  readonly problem?: string;
  /** Something worth saying that did not stop it (a daemon that could not be woken). */
  readonly warnings: readonly string[];
};

export type RunActionValue = {
  readonly run: string;
  /** The run's state once the command ended. */
  readonly state?: string;
  readonly problem?: string;
};

export type RunAdapter = {
  readonly shape: RunAdapterShape;
  createRun(request: CreateRunRequest): Promise<RunPlan<RunCreateValue>>;
  cancelRun(request: RunTargetRequest): Promise<RunPlan<RunActionValue>>;
  resumeRun(request: RunTargetRequest): Promise<RunPlan<RunActionValue>>;
};

export type CreateRunRequest = {
  readonly harnessDir: string;
  /** The harness id (`hrn_…`), for the run's ref. */
  readonly harness: string;
  /** The harness's compiler shape. */
  readonly target: string;
  /** The run's canonical id; minted by the head. */
  readonly runId: string;
  readonly input: string;
  /** Who the run serves, as a verified source named them. Kept in the input file only. */
  readonly subject?: string;
  readonly admission: "reject" | "queue";
  /** A work item; not served by this release. */
  readonly work?: string;
  readonly home: RunHome;
};

export type RunTargetRequest = {
  readonly harnessDir: string;
  readonly harness: string;
  readonly target: string;
  readonly runId: string;
  readonly home: RunHome;
};

// ---------------------------------------------------------------------------
// Shared reads and writes
// ---------------------------------------------------------------------------

const API_TRIGGER = Object.freeze({ kind: "api" });
const TERMINAL: ReadonlySet<string> = new Set(["interrupted", "succeeded", "failed", "cancelled"]);
const NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;

function refused<T>(
  code: ErrorCode,
  reason: string,
  message: string,
  more: { readonly verb?: string; readonly remedy?: string } = {},
): RunPlan<T> {
  return { ok: false, refusal: { code, reason, message, ...more } };
}

/** The run's newest row, folded from the whole ledger (it decides a write). */
export function runRowOf(harnessDir: string, runId: string): RunRow | undefined {
  const fold = foldStates(runsLedger(harnessDir));
  if (!fold.ok) return undefined;
  const found = fold.objects.get(runId);
  return found === undefined ? undefined : ({ ...found.record, id: runId } as RunRow);
}

/** The run's ref, `<hrn>/run/<id>`. */
export function runRefOf(harness: string, runId: string): string {
  return `${harness}/run/${runId}`;
}

function runEffect(harness: string, runId: string, observed?: string): ReceiptEffect {
  return {
    kind: "run",
    ref: runRefOf(harness, runId),
    status: "done",
    ...(observed !== undefined ? { observed } : {}),
  };
}

/** Whether `dir`, found on disk, lies inside `root`, found on disk. */
function landsInside(root: string, dir: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Write a run's input file exclusively, `0600`, inside the harness; its path, or why not. */
function writeInputFile(
  harnessDir: string,
  name: string,
  text: string,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string } {
  const dir = join(harnessDir, controlPaths(harnessDir).inputsDir);
  const file = join(dir, name);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!landsInside(harnessDir, dir)) {
      return { ok: false, reason: "the inputs directory does not lie inside the harness" };
    }
    const fd = openSync(
      file,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, reason: `the run's input could not be saved: ${(err as Error).message}` };
  }
}

/** Whether a version is at least `min`, by its numeric major, minor and patch. */
export function versionAtLeast(version: string, min: string): boolean {
  const parse = (v: string): number[] | undefined => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const a = parse(version);
  const b = parse(min);
  if (a === undefined || b === undefined) return false;
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  }
  return true;
}

/** The operator record's refusal of new work, when it refuses. */
function operatorRefusal<T>(
  harnessDir: string,
  queue: boolean,
): { readonly plan?: RunPlan<T>; readonly paused: boolean } {
  const intake = intakeVerdict(harnessDir);
  if (intake.state === "open") return { paused: false };
  if (intake.code === "disabled") {
    return {
      plan: refused("disabled", "disabled", "This harness is disabled, so it starts nothing.", {
        verb: "crewhaus daemon enable",
      }),
      paused: false,
    };
  }
  if (queue) return { paused: true };
  return {
    plan: refused("paused", "paused", "This harness is paused, so it starts nothing new.", {
      verb: "crewhaus daemon resume",
    }),
    paused: true,
  };
}

/** The shape's own words for how it takes work, from the run-control table. */
function intakeOf(target: string): { readonly message: string; readonly verb?: string } {
  const cell = (
    SHAPE_RUN_CONTROLS as Readonly<Record<string, Record<string, CapabilityDescriptor>>>
  )[target]?.["runs.create"];
  if (cell !== undefined && cell.supported === false) {
    return { message: cell.reason, ...(cell.verb !== null ? { verb: cell.verb } : {}) };
  }
  return { message: `A ${target} harness does not start runs through the control API.` };
}

/** Withdraw a queued run nothing started: win its claim, and close it `cancelled`. */
function withdrawQueued(harnessDir: string, runId: string, receipt: CommandReceipt): void {
  const ledger = runsLedger(harnessDir);
  const claimed = publishClaim(ledger, `run/${runId}`, { pid: process.pid, host: hostname() });
  if (claimed.ok && runRowOf(harnessDir, runId)?.["state"] === "queued") {
    append(ledger, {
      id: runId,
      state: "cancelled",
      at: new Date().toISOString(),
      trigger: API_TRIGGER,
      by: receipt.actor,
      cmd: receipt.id,
      reason: "not-started",
    });
  }
  removeApiRunInput(harnessDir, runId);
}

/**
 * The outcome a cancel answers when the run had already started: `running`, naming the
 * run. Not an error code, so it is written as the receipt's open outcome shape.
 */
function runningOutcome(runId: string): Outcome {
  const outcome = { code: "running", message: "refused: the run had already started", run: runId };
  return outcome as unknown as Outcome;
}

// ---------------------------------------------------------------------------
// The job adapter: cli, crew, workflow, graph
// ---------------------------------------------------------------------------

/**
 * Why a harness's compiled build cannot start an API run, when it cannot: no build, or
 * one stamped older than {@link RUNS_MIN_BUNDLE} (a managed build that old has no
 * queued-run follower; a job build that old does not check its input where it starts).
 * A cli run is the interpreter's, `crewhaus run`, never a bundle.
 */
export function runBundleRefusal(harnessDir: string, target: string): RunRefusal | undefined {
  if (target === "cli") return undefined;
  const bundle = resolveBundle(harnessDir, target);
  const stamp = bundle === undefined ? undefined : readBundleStamp(bundle.bundleDir);
  const compiledWith = stamp?.compiledWith;
  if (compiledWith !== undefined && versionAtLeast(compiledWith, RUNS_MIN_BUNDLE)) return undefined;
  return {
    code: "unsupported",
    reason: "bundle_too_old",
    message:
      bundle === undefined
        ? "This harness has no compiled build to start a run with."
        : `This harness's build is older than ${RUNS_MIN_BUNDLE}, which starts runs through the control API. Compile it again.`,
    verb: "crewhaus compile",
  };
}

function bundleRefusal<T>(harnessDir: string, target: string): RunPlan<T> | undefined {
  const refusal = runBundleRefusal(harnessDir, target);
  return refusal === undefined ? undefined : { ok: false, refusal };
}

const jobRunAdapter: RunAdapter = {
  shape: "job",

  async createRun(req) {
    const operator = operatorRefusal<RunCreateValue>(req.harnessDir, false);
    if (operator.plan !== undefined) {
      const plan = operator.plan;
      if (!plan.ok && req.admission === "queue" && plan.refusal.code === "paused") {
        return refused(
          "paused",
          "paused",
          "This harness is paused, and Home keeps no queue for one-shot jobs, so nothing was started.",
          { verb: "crewhaus daemon resume" },
        );
      }
      return plan;
    }
    const old = bundleRefusal<RunCreateValue>(req.harnessDir, req.target);
    if (old !== undefined) return old;
    if (req.home.startRunJob === undefined) {
      return refused("unavailable", "executor_offline", "This head cannot start jobs.");
    }
    if (req.work !== undefined) {
      return refused(
        "unsupported",
        "not_served",
        "Starting a run for a work item is not served yet.",
      );
    }
    if (req.subject !== undefined && STDIN_SHAPES.has(req.target)) {
      return refused(
        "unsupported",
        "subject_unsupported_by_shape",
        `A ${req.target} harness reads its input on stdin, which carries no subject.`,
      );
    }
    const startRunJob = req.home.startRunJob;
    return {
      ok: true,
      async effect(receipt) {
        const cli = req.target === "cli";
        const written = writeInputFile(
          req.harnessDir,
          cli ? `${req.runId}.json` : `${req.runId}.txt`,
          cli
            ? `${JSON.stringify({
                v: 1,
                run: req.runId,
                input: req.input,
                ...(req.subject !== undefined ? { subject: req.subject } : {}),
              })}\n`
            : req.input,
        );
        if (!written.ok) {
          return {
            settle: { state: "failed", outcome: outcomeOf("unavailable") },
            value: { problem: written.reason, warnings: [] },
          };
        }
        const now = req.home.now ?? Date.now;
        const row = {
          id: req.runId,
          state: "queued",
          at: new Date(now()).toISOString(),
          trigger: API_TRIGGER,
          by: receipt.actor,
          cmd: receipt.id,
        };
        const queued = append(runsLedger(req.harnessDir), row);
        if (!queued.ok) {
          removeApiRunInput(req.harnessDir, req.runId);
          return {
            settle: { state: "failed", outcome: outcomeOf("unavailable") },
            value: { problem: `the queued row could not be written: ${queued.code}`, warnings: [] },
          };
        }
        let started: StartResult;
        try {
          started = await startRunJob(req.harnessDir, {
            runId: req.runId,
            ...(cli ? { inputFile: written.path } : { stdinFile: written.path }),
          });
        } catch (err) {
          started = { ok: false, reason: "plan-failed", stage: "spawn", error: err as Error };
        }
        if (!started.ok) {
          withdrawQueued(req.harnessDir, req.runId, receipt);
          return {
            settle: {
              state: "failed",
              outcome: outcomeOf(started.reason === "disabled" ? "disabled" : "unavailable"),
            },
            value: {
              problem: "error" in started ? started.error.message : started.reason,
              warnings: [],
            },
          };
        }
        return {
          settle: { state: "succeeded", effects: [runEffect(req.harness, req.runId)] },
          value: { run: row, warnings: [] },
        };
      },
    };
  },

  async cancelRun(req) {
    return cancelPlan(req, "job");
  },

  async resumeRun(req) {
    const row = runRowOf(req.harnessDir, req.runId);
    if (row === undefined)
      return refused("not_found", "run_unknown", "This harness has no such run.");
    if (row["state"] !== "waiting-for-approval") {
      return refused(
        "conflict",
        TERMINAL.has(String(row["state"])) ? "run_ended" : "run_not_parked",
        `This run is ${String(row["state"])}, so there is nothing to resume.`,
      );
    }
    if (typeof row["tenant"] === "string") {
      return refused(
        "unsupported",
        "unsupported_by_shape",
        "A managed run is resumed by its daemon.",
        { remedy: "Continue its session with crewhaus.v1 `runs.continue`." },
      );
    }
    if (!startedByApi(req.harnessDir, row, req.target === "cli")) {
      return refused(
        "unsupported",
        "not_started_by_api",
        "This run was not started through the control API, so it is not resumed here.",
        { verb: `crewhaus runs resume ${req.runId}` },
      );
    }
    const children = childRunsOf(req.harnessDir, req.runId);
    if (children === undefined) {
      return refused(
        "unavailable",
        "records_unreadable",
        "The run records could not be read whole, so nothing was resumed.",
      );
    }
    const pending = await pendingFor(req.harnessDir, familyOf(row, children));
    if (pending.length > 0) {
      return refused(
        "conflict",
        "decision_pending",
        "This run still waits on a decision. Decide it first.",
        { verb: `crewhaus approvals show ${pending[0]} --dir ${req.harnessDir}` },
      );
    }
    if (req.home.startRunJob === undefined) {
      return refused("unavailable", "executor_offline", "This head cannot start jobs.");
    }
    const old = bundleRefusal<RunActionValue>(req.harnessDir, req.target);
    if (old !== undefined) return old;
    const startRunJob = req.home.startRunJob;
    const inputs = join(req.harnessDir, controlPaths(req.harnessDir).inputsDir);
    const cli = req.target === "cli";
    const file = join(inputs, cli ? `${req.runId}.json` : `${req.runId}.txt`);
    return {
      ok: true,
      async effect() {
        let started: StartResult;
        try {
          started = await startRunJob(req.harnessDir, {
            runId: req.runId,
            ...(cli ? { inputFile: file } : { stdinFile: file }),
          });
        } catch (err) {
          started = { ok: false, reason: "plan-failed", stage: "spawn", error: err as Error };
        }
        if (!started.ok) {
          return {
            settle: { state: "failed", outcome: outcomeOf("unavailable") },
            value: {
              run: req.runId,
              problem: "error" in started ? started.error.message : started.reason,
            },
          };
        }
        return {
          settle: { state: "succeeded", effects: [runEffect(req.harness, req.runId, "resumed")] },
          value: { run: req.runId, state: "preparing" },
        };
      },
    };
  },
};

/** The run a run continues, when its row names one. */
function continuesOf(row: RunRow): string | undefined {
  const continues = row["continues"];
  return typeof continues === "string" && continues !== "" ? continues : undefined;
}

/**
 * Whether a run is one the control API started and can start again: its trigger is
 * `api`, and its input file (`inputs/<run>.json` for cli, `.txt` otherwise) is a regular
 * file, not a link, in an inputs directory that lies inside the harness.
 */
function startedByApi(harnessDir: string, row: RunRow, cli: boolean): boolean {
  const trigger = row["trigger"] as { readonly kind?: unknown } | undefined;
  if (trigger?.kind !== "api") return false;
  const dir = join(harnessDir, controlPaths(harnessDir).inputsDir);
  try {
    if (!landsInside(harnessDir, dir)) return false;
    return lstatSync(join(dir, cli ? `${row.id}.json` : `${row.id}.txt`)).isFile();
  } catch {
    return false;
  }
}

/** A top-level run a root started: its id, and the run it continues when it names one. */
type ChildRun = { readonly id: string; readonly continues?: string };

/**
 * The top-level runs `rootId` started: each run whose `running` row names it as
 * `parent`, newest first, with the run each continues. A job's loops run under their own
 * ids and name the API run only as their parent, so what a park waits on is bound to one
 * of these. Read whole, following every page; `undefined` when a page has a gap (this
 * read decides a withdrawal, so a gap is never skipped).
 */
export function childRunsOf(harnessDir: string, rootId: string): ChildRun[] | undefined {
  const ledger = runsLedger(harnessDir);
  const out: ChildRun[] = [];
  const seen = new Set<string>();
  let before: CursorPosition | undefined;
  for (;;) {
    let page: ReturnType<typeof readPage>;
    try {
      page = readPage(ledger, { limit: 1000, ...(before !== undefined ? { before } : {}) });
    } catch {
      return undefined;
    }
    if (page.gaps.length > 0) return undefined;
    for (const { record } of page.items) {
      const id = record["id"];
      if (record["state"] !== "running" || record["parent"] !== rootId) continue;
      if (typeof id !== "string" || id === rootId || seen.has(id)) continue;
      seen.add(id);
      const continues = record["continues"];
      out.push({
        id,
        ...(typeof continues === "string" && continues !== "" ? { continues } : {}),
      });
    }
    if (page.next === undefined) return out;
    before = page.next;
  }
}

/**
 * Every run a request a parked API run waits on can be bound to: the run, the run it
 * continues, each top-level run it started and the run each of those continues. The run
 * comes first, so a withdrawal names it.
 */
function familyOf(row: RunRow, children: readonly ChildRun[]): string[] {
  const ids = [
    row.id,
    continuesOf(row),
    ...children.flatMap((child) => [child.id, child.continues]),
  ].filter((id): id is string => id !== undefined);
  return [...new Set(ids)];
}

/** The harness's approval store, at its session root. */
function approvalStoreOf(harnessDir: string) {
  const root = resolveHarnessSessionRoot(harnessDir, readHarnessEnvFiles(harnessDir).vars).root;
  return createPendingApprovalStore({ rootDir: root });
}

/** The pending requests bound to any of `runs`, by id. A read: it rewrites nothing. */
async function pendingFor(
  harnessDir: string,
  runs: readonly (string | undefined)[],
): Promise<string[]> {
  const named = new Set(runs.filter((id): id is string => id !== undefined));
  const live = await approvalStoreOf(harnessDir).list();
  return live
    .filter((record) => {
      const binding = record.binding as { readonly runId?: unknown } | undefined;
      const bound = typeof binding?.runId === "string" ? binding.runId : record.runId;
      return named.has(bound) && record.decision === undefined;
    })
    .map((record) => record.id);
}

// ---------------------------------------------------------------------------
// Cancel, by the run's folded state
// ---------------------------------------------------------------------------

async function cancelPlan(
  req: RunTargetRequest,
  shape: "job" | "managed",
): Promise<RunPlan<RunActionValue>> {
  const row = runRowOf(req.harnessDir, req.runId);
  if (row === undefined)
    return refused("not_found", "run_unknown", "This harness has no such run.");
  const state = String(row["state"]);
  if (TERMINAL.has(state)) {
    return refused("conflict", "run_ended", `This run is ${state}; there is nothing to cancel.`);
  }
  const ledger = runsLedger(req.harnessDir);
  const at = (): string => new Date((req.home.now ?? Date.now)()).toISOString();
  const tenant = typeof row["tenant"] === "string" ? row["tenant"] : undefined;

  if (state === "queued") {
    return {
      ok: true,
      async effect(receipt) {
        // The follower's claim, and a job start's: whoever publishes it first owns the run.
        const claimed = publishClaim(ledger, `run/${req.runId}`, {
          pid: process.pid,
          host: hostname(),
        });
        if (!claimed.ok) {
          if (claimed.code === "exists") {
            return {
              settle: { state: "rejected", outcome: runningOutcome(req.runId) },
              value: { run: req.runId, problem: "the run had already started" },
            };
          }
          return {
            settle: { state: "failed", outcome: outcomeOf("unavailable") },
            value: { run: req.runId, problem: claimed.reason },
          };
        }
        const written = append(ledger, {
          id: req.runId,
          state: "cancelled",
          at: at(),
          trigger: row["trigger"] ?? API_TRIGGER,
          by: receipt.actor,
          cmd: receipt.id,
          ...(tenant !== undefined ? { tenant } : {}),
        });
        if (!written.ok) {
          return {
            settle: { state: "failed", outcome: outcomeOf("unavailable") },
            value: { run: req.runId, problem: written.reason },
          };
        }
        removeApiRunInput(req.harnessDir, req.runId);
        return {
          settle: {
            state: "succeeded",
            effects: [runEffect(req.harness, req.runId, "cancelled")],
          },
          value: { run: req.runId, state: "cancelled" },
        };
      },
    };
  }

  if (state === "waiting-for-approval") {
    if (tenant !== undefined || shape === "managed") {
      return refused(
        "unsupported",
        "unsupported_by_shape",
        "A parked managed run is not cancelled here: its requests are kept with its tenant.",
        {
          remedy:
            "Deny what it waits on with `crewhaus approvals deny <appr> --dir <the tenant's session folder>`.",
        },
      );
    }
    return { ok: true, effect: (receipt) => cancelParked(req, receipt, at) };
  }

  // Preparing or running: whoever holds the run stops it.
  if (shape === "managed" || tenant !== undefined) {
    const client = req.home.controlClient;
    const target = req.home.controlTarget?.(req.harnessDir);
    if (client === undefined || target === undefined) {
      return refused("unavailable", "executor_offline", "This head cannot reach the daemon.");
    }
    return {
      ok: true,
      async effect() {
        const answer = await client.cancelRun(target, req.runId);
        return answer.ok
          ? {
              settle: {
                state: "succeeded",
                effects: [runEffect(req.harness, req.runId, "cancel signalled")],
              },
              value: { run: req.runId, state },
            }
          : {
              settle: { state: "failed", outcome: outcomeOf("unavailable") },
              value: { run: req.runId, problem: answer.reason },
            };
      },
    };
  }
  const stop = req.home.stopRunJob;
  if (stop === undefined) {
    return refused(
      "unavailable",
      "executor_offline",
      "This run's process is held by another head; cancel it where it was started.",
    );
  }
  return {
    ok: true,
    async effect() {
      const stopped = await stop(req.harnessDir, req.runId);
      return stopped
        ? {
            settle: {
              state: "succeeded",
              effects: [runEffect(req.harness, req.runId, "stopped")],
            },
            value: { run: req.runId, state: "cancelled" },
          }
        : {
            settle: { state: "failed", outcome: outcomeOf("unavailable") },
            value: { run: req.runId, problem: "no process this head holds runs it" },
          };
    },
  };
}

/**
 * Cancel a parked job run that nothing holds. Under the run ledger's lock, with the run
 * folded again there, and only while it is still parked: withdraw every request bound
 * to it, to the run it continues, to each top-level run it started (a job's loops run
 * under their own ids and name it as their parent) and to the runs those continue
 * (`supersedeRun`, the run first so it names the run); then append `cancelled` to it by
 * compare-and-set, and to each of its top-level runs still parked, so neither it nor any
 * of them, nor their sessions, is resumed; then remove its input file. A run that moved
 * meanwhile (a resume holds it) is left as it is, and nothing is withdrawn.
 */
async function cancelParked(
  req: RunTargetRequest,
  receipt: CommandReceipt,
  at: () => string,
): Promise<RunEffectAnswer<RunActionValue>> {
  const ledger = runsLedger(req.harnessDir);
  const answer = await withLedgerLock(ledger, async () => {
    const fold = foldStates(ledger);
    if (!fold.ok) return { kind: "failed" as const, reason: fold.reason };
    const current = fold.objects.get(req.runId);
    if (current?.state !== "waiting-for-approval") {
      return { kind: "moved" as const, state: current?.state ?? "absent" };
    }
    const children = childRunsOf(req.harnessDir, req.runId);
    if (children === undefined) {
      return {
        kind: "failed" as const,
        reason: "the run records could not be read whole; nothing was withdrawn",
      };
    }
    if (!canTransition("run", "waiting-for-approval", "cancelled")) {
      return { kind: "failed" as const, reason: "the run machine refuses the move" };
    }
    const record = { ...current.record, id: req.runId } as RunRow;
    const withdrawn = await approvalStoreOf(req.harnessDir).supersedeRun?.(
      familyOf(record, children),
      { reason: "run-cancelled", via: "system" },
    );
    const cancelledRow = (id: string, trigger: unknown): LedgerRecord =>
      ({
        id,
        state: "cancelled",
        at: at(),
        trigger: trigger ?? API_TRIGGER,
        by: receipt.actor,
        cmd: receipt.id,
      }) as LedgerRecord;
    const moved = await casAppendLocked(
      ledger,
      req.runId,
      "waiting-for-approval",
      cancelledRow(req.runId, current.record["trigger"]),
    );
    if (!moved.ok) return { kind: "failed" as const, reason: moved.reason };
    if (!moved.applied) return { kind: "moved" as const, state: "changed" };
    const problems: string[] = [];
    for (const child of children) {
      const folded = fold.objects.get(child.id);
      if (folded?.state !== "waiting-for-approval") continue;
      const closed = await casAppendLocked(
        ledger,
        child.id,
        "waiting-for-approval",
        cancelledRow(child.id, folded.record["trigger"]),
      );
      if (!closed.ok) problems.push(`${child.id}: ${closed.reason}`);
    }
    removeApiRunInput(req.harnessDir, req.runId);
    return {
      kind: "cancelled" as const,
      withdrawn: withdrawn?.superseded.length ?? 0,
      problems,
    };
  });
  if ("ok" in answer || answer.kind === "failed") {
    return {
      settle: { state: "failed", outcome: outcomeOf("unavailable") },
      value: { run: req.runId, problem: answer.reason },
    };
  }
  if (answer.kind === "moved") {
    return {
      settle: { state: "rejected", outcome: outcomeOf("conflict") },
      value: { run: req.runId, problem: `the run is ${answer.state} now`, state: answer.state },
    };
  }
  return {
    settle: {
      state: "succeeded",
      effects: [
        runEffect(req.harness, req.runId, "cancelled"),
        { kind: "decisions", status: "done", observed: `${answer.withdrawn} withdrawn` },
      ],
    },
    value: {
      run: req.runId,
      state: "cancelled",
      ...(answer.problems.length > 0
        ? { problem: `some of its runs could not be closed: ${answer.problems.join("; ")}` }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The managed adapter
// ---------------------------------------------------------------------------

const managedRunAdapter: RunAdapter = {
  shape: "managed",

  async createRun(req) {
    const operator = operatorRefusal<RunCreateValue>(req.harnessDir, req.admission === "queue");
    if (operator.plan !== undefined) return operator.plan;
    // A build without the queued-run follower would never claim what is queued for it.
    const old = bundleRefusal<RunCreateValue>(req.harnessDir, "managed");
    if (old !== undefined) return old;
    const client = req.home.controlClient;
    const target = req.home.controlTarget?.(req.harnessDir);
    const status =
      client !== undefined && target !== undefined ? await client.status(target) : undefined;
    let wake = false;
    if (status?.ok === true) {
      const caps = status.body.capabilities;
      if (!Array.isArray(caps) || !caps.includes("runs.create")) {
        return refused(
          "unsupported",
          "bundle_too_old",
          "This daemon's build does not start queued runs. Compile it again and restart it.",
          { verb: "crewhaus compile" },
        );
      }
      wake = !operator.paused;
    } else if (req.admission === "reject") {
      return refused(
        "unavailable",
        "executor_offline",
        "The daemon is not running, so the run cannot start now. Ask to queue it, or start the daemon.",
        { verb: "crewhaus daemon start" },
      );
    }
    if (req.work !== undefined) {
      return refused(
        "unsupported",
        "not_served",
        "Starting a run for a work item is not served yet.",
      );
    }
    return {
      ok: true,
      async effect(receipt) {
        const queued = queueManagedRun({
          harnessDir: req.harnessDir,
          runId: req.runId,
          tenant: HOME_RUN_TENANT,
          input: req.input,
          by: receipt.actor,
          cmd: receipt.id,
          ...(req.subject !== undefined ? { subject: req.subject } : {}),
          ...(req.home.now !== undefined ? { now: req.home.now } : {}),
        });
        if (!queued.ok) {
          return {
            settle: { state: "failed", outcome: outcomeOf("unavailable") },
            value: { problem: queued.reason, warnings: [] },
          };
        }
        const warnings: string[] = [];
        // A nudge only: the follower's own poll claims it when the wake is lost.
        if (wake && client !== undefined && target !== undefined) {
          const nudged = await client.claimRuns(target);
          if (!nudged.ok) warnings.push(`the daemon was not woken (${nudged.reason})`);
        }
        return {
          settle: { state: "succeeded", effects: [runEffect(req.harness, req.runId)] },
          value: { run: runRowOf(req.harnessDir, req.runId) ?? { id: req.runId }, warnings },
        };
      },
    };
  },

  async cancelRun(req) {
    return cancelPlan(req, "managed");
  },

  async resumeRun() {
    return refused(
      "unsupported",
      "unsupported_by_shape",
      "A managed run is resumed by its daemon.",
      { remedy: "Continue its session with crewhaus.v1 `runs.continue`." },
    );
  },
};

// ---------------------------------------------------------------------------
// The daemon adapter: every shape that takes its work through its own intake
// ---------------------------------------------------------------------------

function daemonAdapterFor(target: string): RunAdapter {
  const intake = intakeOf(target);
  const notHere = <T>(): RunPlan<T> =>
    refused("unsupported", "unsupported_by_shape", intake.message, {
      ...(intake.verb !== undefined ? { verb: intake.verb } : {}),
    });
  return {
    shape: "daemon",
    createRun: async () => notHere(),
    cancelRun: async () => notHere(),
    resumeRun: async () =>
      refused(
        "unsupported",
        "unsupported_by_shape",
        "This harness resumes a parked run itself, once what it waits on is decided.",
      ),
  };
}

/** The adapter that carries out a harness's runs, by its compiler shape. */
export function runAdapterFor(target: string): RunAdapter {
  const shape = (RUN_ADAPTER_SHAPES as Readonly<Record<string, RunAdapterShape>>)[target];
  if (shape === "managed") return managedRunAdapter;
  if (shape === "job") return jobRunAdapter;
  return daemonAdapterFor(target);
}

/** Whether `runId` is a run id a head may name a new run with. */
export function isRunId(runId: string): boolean {
  return CANONICAL_RUN_ID_RE.test(runId);
}

// ---------------------------------------------------------------------------
// Reconcilers: what recovery finds for a run command it could not settle
// ---------------------------------------------------------------------------

/** The run a receipt's target names (`<hrn>/run/<id>`), when it names one. */
function runOfReceipt(receipt: CommandReceipt): string | undefined {
  const parsed = parseRef(receipt.target);
  return !("error" in parsed) && parsed.kind === "run" ? parsed.id : undefined;
}

/** Whether any row of the run ledger names the receipt, read whole; `undefined` when it cannot be read. */
function ledgerNamesReceipt(harnessDir: string, cmd: string): boolean | undefined {
  const ledger = runsLedger(harnessDir);
  let before: CursorPosition | undefined;
  for (;;) {
    let page: ReturnType<typeof readPage>;
    try {
      page = readPage(ledger, { limit: 1000, ...(before !== undefined ? { before } : {}) });
    } catch {
      return undefined;
    }
    if (page.gaps.length > 0) return undefined;
    if (page.items.some((item) => item.record["cmd"] === cmd)) return true;
    if (page.next === undefined) return false;
    before = page.next;
  }
}

/**
 * `runs.create`: a run row that names the receipt is the run it recorded (`done`); none
 * means nothing was queued, so nothing ran (`not-done`).
 */
export function reconcileRunCreate(receipt: CommandReceipt, ctx: ReconcileContext): Reconciliation {
  if (ctx.harnessDir === undefined) return "unknown";
  const named = ledgerNamesReceipt(ctx.harnessDir, receipt.id);
  return named === undefined ? "unknown" : named ? "done" : "not-done";
}

/** `runs.cancel`: the run's newest row says whether it ended cancelled. */
export function reconcileRunCancel(receipt: CommandReceipt, ctx: ReconcileContext): Reconciliation {
  const runId = runOfReceipt(receipt);
  if (ctx.harnessDir === undefined || runId === undefined) return "unknown";
  const state = runRowOf(ctx.harnessDir, runId)?.["state"];
  if (state === "cancelled") return "done";
  if (state === "queued" || state === "waiting-for-approval" || TERMINAL.has(String(state))) {
    return "not-done";
  }
  return "unknown";
}

/** `runs.resume`: a run still parked was not resumed; one that moved on was. */
export function reconcileRunResume(receipt: CommandReceipt, ctx: ReconcileContext): Reconciliation {
  const runId = runOfReceipt(receipt);
  if (ctx.harnessDir === undefined || runId === undefined) return "unknown";
  const state = runRowOf(ctx.harnessDir, runId)?.["state"];
  if (state === "waiting-for-approval") return "not-done";
  if (state === "preparing" || state === "running" || state === "succeeded" || state === "failed") {
    return "done";
  }
  return "unknown";
}

/** The run commands' reconcilers. Each runs inline, so none has an executor. */
export const RUN_RECONCILERS: Readonly<Record<string, Reconciler>> = {
  "runs.create": reconcileRunCreate,
  "runs.cancel": reconcileRunCancel,
  "runs.resume": reconcileRunResume,
};
