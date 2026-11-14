/**
 * `@crewhaus/gateway-server/managed-runs`: a managed daemon's `crewhaus.v1`
 * run handler, its run records, and the two checks its boot makes.
 *
 * Runs are recorded before they execute. `runs.create` and `runs.continue`
 * mint a canonical run id (`run_` and 26 characters), win the claim
 * `run/<id>` on the harness's run ledger (`.crewhaus/run/control/runs/`, the
 * claim's record names the process that holds the run) and append a
 * content-free `running` row with the tenant before the turn starts; how the
 * run ended follows it: `succeeded`, `cancelled` (`runs.cancel`, or control.v1's
 * per-run cancel), `waiting-for-approval` for a parked turn, or `failed` with
 * the failure class. An input the prompt-injection check refused is recorded
 * as `failed` with `input_blocked`, and no turn runs. A run cut off when its
 * process ended is marked `interrupted` at the next start, and never run
 * again. A row holds ids, states, the tenant and, on the terminal row, a keyed
 * digest of the subject (`subjectRefOf`); never the subject, the input or the
 * reply. Rows are best-effort: a failed claim or append warns once and the run
 * goes on, and `CREWHAUS_RUN_LEDGER=0` writes none.
 *
 * Queued runs. {@link queueManagedRun} writes a run's input to a `0600` file
 * under `.crewhaus/run/control/inputs/` and appends its `queued` row; the
 * follower ({@link ManagedRuns.claimQueued}) wins each queued run's claim,
 * classifies its input at TrustOrigin "api" where it claims it (a queued
 * input never passes through a request), and runs it the way a synchronous
 * run runs. The file holds the input and the subject only until the run leaves
 * `queued`: the follower removes it once it has read it, and `runs.cancel`
 * removes a cancelled run's. A queued run survives a restart: the next start
 * claims it. An input with no row past {@link ORPHAN_INPUT_GRACE_MS} is removed
 * and never looked at again.
 *
 * The handler is branded (`MANAGED_RUN_HANDLER`), so the gateway hands it the
 * verdict on the run input it classified at "api", and the handler records a
 * refused input before it answers; kept input arrives tagged in the run's
 * first context. Called with no verdict, the handler classifies the input
 * itself at "api", the same way, so every caller's input is checked once.
 * `sessions.list` and `sessions.fork` answer `unsupported`; `audit.tail`
 * honours `sinceTs`.
 *
 * Light: this module loads no runtime and never the server (`./index` for
 * types only), so an adapter that only queues runs can import it.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AuditLog } from "@crewhaus/audit-log";
import { boundaryRuleIds, classifyBoundary } from "@crewhaus/boundary-classifier";
import {
  CANONICAL_RUN_ID_RE,
  EXECUTION_RUN_ID_RE,
  type Trigger,
  isId,
  isStoredActor,
  parseResumeScope,
} from "@crewhaus/control-contract";
import {
  type LeaseProbe,
  type LedgerRecord,
  append,
  controlPaths,
  defaultLeaseProbe,
  foldStates,
  holderProvablyDead,
  intakeVerdict,
  publishClaim,
  readClaim,
  runsLedger,
  subjectRefOf,
} from "@crewhaus/control-records";
import type { BudgetStore } from "@crewhaus/durable-state";
import { formatRunFailure, isRunFailedError } from "@crewhaus/errors";
import { ErrorCode } from "@crewhaus/gateway-protocol";
import type { ControlPlane } from "@crewhaus/gateway-protocol/control";
import {
  createInMemoryIdempotencyStore,
  idempotencyKey,
  withIdempotency,
} from "@crewhaus/idempotency-keys";
import { auditPolicyDecision, evaluatePolicy } from "@crewhaus/policy-engine";
import {
  type InboundContent,
  type RunContext,
  type RunScope,
  cancelRun,
  createRunContext,
  isCancelReason,
  mintRunId,
  runWithScope,
  withInboundContent,
} from "@crewhaus/run-context";
import { type Tenant, buildTenant, validateTenantId, withTenant } from "@crewhaus/tenancy";
import { GatewayCodedError, MANAGED_RUN_HANDLER } from "./coded";
import type { ResolveRunEvents, RunHandler, RunInputVerdict, UsageDelta } from "./index";

export { GatewayCodedError, MANAGED_RUN_HANDLER } from "./coded";

/** What started a run this module records. */
const API_TRIGGER: Trigger = Object.freeze({ kind: "api" });

/** How many run buses `runs.subscribe` can resolve; the oldest goes past it. */
export const RUN_BUS_CAP = 256;

/** How often the follower looks for queued runs when no control port can wake it. */
export const CLAIM_POLL_MS = 2000;

/**
 * How old a queued run's input file with no row must be before the follower
 * removes it. {@link queueManagedRun} writes the input before its `queued`
 * row, so a younger one is left alone: its row may be about to land. Well
 * above that gap, and above clock skew on a shared volume.
 */
export const ORPHAN_INPUT_GRACE_MS = 5 * 60_000;

/** The longest `CREWHAUS_REPLICA_ID` a claim records (a pod name's limit). */
const REPLICA_ID_MAX = 253;

/** The most bytes of a queued run's input file read back. */
const INPUT_MAX_BYTES = 8 * 1024 * 1024;

const ZERO_USAGE: UsageDelta = Object.freeze({ input: 0, output: 0 });

/** What `sessions.list` and `sessions.fork` answer. */
const SESSIONS_UNSUPPORTED =
  "this daemon keeps each tenant's session logs under its tenants root and serves no session listing";

/** The turn the emitted daemon runs: the only spec-dependent code. */
export type ManagedTurnArgs = {
  readonly tenant: Tenant;
  readonly sessionId: string;
  readonly input: string;
  /** `runs.continue` with a session: reseat that session's history. */
  readonly isResume: boolean;
  /** The run's context: hand it to the loop, so cancel and the run's bus reach it. */
  readonly runContext: RunContext;
  /** The tenant's audit log, for the loop's durable sinks. */
  readonly log: AuditLog;
};

/** A served turn: its reply and, under `provability:`, the bundle its gate graded. */
export type ManagedTurn = { readonly reply: string; readonly proof?: unknown };

/** The control plane pieces the runs use. The emitted `__control` satisfies it. */
export type ManagedControl = Pick<ControlPlane, "onClaim" | "onActiveRuns"> & {
  readonly counters: { turns: number };
};

/** A method the daemon serves beyond the runs, such as `feedback.submit`. */
export type ManagedMethod = (args: {
  readonly params: unknown;
  readonly tenant: Tenant;
}) => Promise<unknown>;

export type CreateManagedRunsOptions = {
  /** The harness whose run ledger holds the rows. Default `process.cwd()`. */
  readonly harnessDir?: string;
  readonly tenantsRoot?: string;
  /** Pre-built tenants, as the gateway takes them. */
  readonly tenantOverrides?: Readonly<Record<string, Tenant>>;
  /** Where a queued run reserves its tenant's budget, as the gateway does for a request. */
  readonly budgetStore?: BudgetStore;
  /** The SLO intake gate the gateway admits by; a paused gate claims nothing. */
  readonly intakeGate?: () => { readonly paused: boolean; readonly reason?: string };
  /** control.v1: `runs/claim` wakes the follower, and each served turn is counted. */
  readonly control?: ManagedControl;
  /** The tenant's audit log (the gateway's, read at call time). */
  readonly getAuditLog: (tenant: Tenant) => Promise<AuditLog>;
  /** Record a turn's usage (the gateway's, read at call time). */
  readonly recordUsage: (tenantId: string, delta: UsageDelta) => Promise<void>;
  /** Run one turn. */
  readonly executeTurn: (args: ManagedTurnArgs) => Promise<ManagedTurn>;
  /** Other methods this daemon serves, by name. Any other answers `unsupported`. */
  readonly otherMethods?: Readonly<Record<string, ManagedMethod>>;
  /** Test seam: how a holder process is judged. Default `defaultLeaseProbe`. */
  readonly probe?: LeaseProbe;
  /** Test seam: the clock rows are stamped with. */
  readonly now?: () => number;
  /** Test seam: the environment read. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam: where a warning line goes. Default stderr. */
  readonly log?: (line: string) => void;
};

/** What a synchronous run answers with, as `RunsCreateResult` says. */
export type ManagedRunResult = {
  readonly runId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly reply: string;
  readonly proof?: unknown;
};

export type ManagedRuns = {
  /** The gateway's run handler, branded `MANAGED_RUN_HANDLER`. */
  readonly handler: RunHandler;
  /** `runs.subscribe`: a run's bus, for the tenant that started it only. */
  readonly resolveRunEvents: ResolveRunEvents;
  /**
   * Once, after the gateway listens: mark interrupted runs, register the
   * follower with control.v1, claim what is queued, and, with no control port
   * to wake it, look again every {@link CLAIM_POLL_MS}. Resolves when the first
   * claim pass ends. With the run ledger off it does nothing.
   */
  start(): Promise<void>;
  /** Stop looking for queued runs and claim no more. Runs in flight go on. */
  stop(): void;
  /**
   * One claim pass: every queued run of a tenant (of this deployment, when
   * both name one) whose claim this process wins, while intake is open. It
   * never rejects.
   */
  claimQueued(): Promise<void>;
};

/** How a run this module records ended. */
type Ending =
  | { readonly state: "succeeded" | "cancelled" | "waiting-for-approval" }
  | { readonly state: "failed"; readonly failureClass: string };

/** The rows of one run: its terminal row, written once. */
type RunRows = { end(ending: Ending, subject: string | undefined): Promise<void> };

const NO_ROWS: RunRows = { end: async () => undefined };

/** A run this process is running, as `runs.cancel` finds it. */
type LiveRun = { readonly tenantId: string; cancelled: boolean; ctx?: RunContext };

/**
 * The process a run's claim names. `replica` is the replica that holds it; a
 * claim without one is keyed by its `host`.
 */
type Holder = {
  readonly pid: number;
  readonly host: string;
  readonly replica?: string;
  readonly startedAtMs?: number;
};

/** The replica a holder's claim names. */
function replicaKey(holder: Holder): string {
  return holder.replica ?? holder.host;
}

/**
 * This process's replica id: `CREWHAUS_REPLICA_ID` when it is a non-empty name
 * of at most 253 characters with no control characters, else the host name.
 */
function replicaIdFrom(env: Readonly<Record<string, string | undefined>>, host: string): string {
  const raw = env["CREWHAUS_REPLICA_ID"];
  if (typeof raw !== "string" || raw === "" || raw.length > REPLICA_ID_MAX) return host;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return host;
  }
  return raw;
}

/**
 * The subject a verified token names, as a run serves it: `app:<tenant>:<sub>`.
 * It travels in the run's scope only (`RunScope.subject`).
 */
function subjectOf(tenant: Tenant, sub: string | undefined): string | undefined {
  return sub === undefined || sub === "" ? undefined : `app:${tenant.id}:${sub}`;
}

/** `session:<id>`, when the id fits a session scope. */
function sessionScope(sessionId: string): string | undefined {
  const scope = `session:${sessionId}`;
  return parseResumeScope(scope) !== null ? scope : undefined;
}

/**
 * How a thrown turn ends its run: cancelled when `cancelRun` aborted it, else
 * by its report class (read by shape: a bundle can carry two copies of
 * `@crewhaus/errors`), else `unknown`.
 */
function endingOf(err: unknown, ctx: RunContext): Ending {
  if (isCancelReason(ctx.abortSignal)) return { state: "cancelled" };
  const report = (err as { report?: { class?: unknown } } | null | undefined)?.report;
  const failureClass =
    typeof report === "object" && report !== null && typeof report.class === "string"
      ? report.class
      : undefined;
  if (failureClass === "approval_pending") return { state: "waiting-for-approval" };
  return { state: "failed", failureClass: failureClass ?? "unknown" };
}

function holderOf(record: LedgerRecord): Holder | undefined {
  const { pid, host, replica, startedAtMs } = record as Partial<Record<string, unknown>>;
  if (!Number.isSafeInteger(pid) || typeof host !== "string") return undefined;
  return {
    pid: pid as number,
    host,
    ...(typeof replica === "string" ? { replica } : {}),
    ...(typeof startedAtMs === "number" ? { startedAtMs } : {}),
  };
}

/** Whether `dir`, found on disk, lies inside `root`, found on disk. */
function landsInside(root: string, dir: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;

/** A queued run's input file, as {@link queueManagedRun} writes it. */
type QueuedInput = {
  readonly v: 1;
  readonly run: string;
  readonly tenant: string;
  readonly input: string;
  readonly sessionId?: string;
  readonly subject?: string;
};

/**
 * Remove a queued run's input file: a regular file at its name inside the
 * harness, nothing a link leads to. `false` when one is there and cannot be
 * removed; a file already gone is `true`.
 */
function removeQueuedInput(harnessDir: string, runId: string): boolean {
  const dir = join(harnessDir, controlPaths(harnessDir).inputsDir);
  const file = join(dir, `${runId}.json`);
  try {
    if (!lstatSync(file).isFile()) return false;
    if (!landsInside(harnessDir, dir)) return false;
    unlinkSync(file);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Read a queued run's input back, or `undefined` when it is not one this run can use. */
function readQueuedInput(
  harnessDir: string,
  runId: string,
  tenantId: string,
): QueuedInput | undefined {
  const dir = join(harnessDir, controlPaths(harnessDir).inputsDir);
  let fd: number | undefined;
  try {
    if (!landsInside(harnessDir, dir)) return undefined;
    fd = openSync(join(dir, `${runId}.json`), fsConstants.O_RDONLY | NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > INPUT_MAX_BYTES) return undefined;
    const body = JSON.parse(readFileSync(fd, "utf8")) as Partial<Record<string, unknown>>;
    if (
      body["v"] !== 1 ||
      body["run"] !== runId ||
      body["tenant"] !== tenantId ||
      typeof body["input"] !== "string"
    ) {
      return undefined;
    }
    const sessionId = body["sessionId"];
    const subject = body["subject"];
    return {
      v: 1,
      run: runId,
      tenant: tenantId,
      input: body["input"],
      ...(typeof sessionId === "string" ? { sessionId } : {}),
      ...(typeof subject === "string" ? { subject } : {}),
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type QueueManagedRunOptions = {
  readonly harnessDir: string;
  /** A canonical run id; minted when absent. */
  readonly runId?: string;
  /** The tenant id the run serves. */
  readonly tenant: string;
  readonly input: string;
  /** The session the run continues (its history is reseated); absent, the run starts a new one. */
  readonly sessionId?: string;
  /** Who queued it: a stored actor (`prn_…`, `sys:…` or `local:#<digest>`), never a raw `local:`. */
  readonly by: string;
  /**
   * Who the run serves, as a verified source named them. Kept in the input
   * file only, which the follower removes once it has read it.
   */
  readonly subject?: string;
  /** The deployment (`dep_…`) whose daemon may claim it. */
  readonly deployment?: string;
  readonly now?: () => number;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type QueueManagedRunAnswer =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Queue a run for a managed daemon of this harness: its input goes to
 * `.crewhaus/run/control/inputs/<run>.json` (`0600`, created exclusively, inside
 * the harness on disk), then its `queued` row, with the tenant and who queued
 * it, goes on the run ledger. The daemon's follower claims and runs it, and
 * removes the file once it has read it. The one writer of queued managed runs.
 */
export function queueManagedRun(opts: QueueManagedRunOptions): QueueManagedRunAnswer {
  const env = opts.env ?? process.env;
  if (env["CREWHAUS_RUN_LEDGER"] === "0") {
    return { ok: false, reason: "this harness records no run rows (CREWHAUS_RUN_LEDGER=0)" };
  }
  try {
    validateTenantId(opts.tenant);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (!isStoredActor(opts.by)) {
    return {
      ok: false,
      reason: "by must be a stored actor: a principal, a system actor or a digest",
    };
  }
  const runId = opts.runId ?? mintRunId();
  if (!CANONICAL_RUN_ID_RE.test(runId)) {
    return { ok: false, reason: "a queued run needs a crewhaus run id: run_ and 26 characters" };
  }
  if (opts.sessionId !== undefined && sessionScope(opts.sessionId) === undefined) {
    return { ok: false, reason: "sessionId does not fit a session id" };
  }
  if (opts.deployment !== undefined && !isId("dep", opts.deployment)) {
    return { ok: false, reason: "deployment must be a deployment id (dep_…)" };
  }
  const now = opts.now ?? Date.now;
  const record: QueuedInput = {
    v: 1,
    run: runId,
    tenant: opts.tenant,
    input: opts.input,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
  };
  const dir = join(opts.harnessDir, controlPaths(opts.harnessDir).inputsDir);
  const file = join(dir, `${runId}.json`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!landsInside(opts.harnessDir, dir)) {
      return { ok: false, reason: "the inputs directory does not lie inside the harness" };
    }
    const fd = openSync(
      file,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    return { ok: false, reason: `the run's input could not be saved: ${(err as Error).message}` };
  }
  const queued = append(runsLedger(opts.harnessDir), {
    id: runId,
    state: "queued",
    at: new Date(now()).toISOString(),
    trigger: API_TRIGGER,
    tenant: opts.tenant,
    by: opts.by,
    ...(opts.deployment !== undefined ? { deployment: opts.deployment } : {}),
  });
  if (!queued.ok) {
    rmSync(file, { force: true });
    return { ok: false, reason: `the queued row could not be written: ${queued.code}` };
  }
  return { ok: true, runId };
}

/**
 * The managed daemon's runs: the handler the gateway calls, the bus resolver
 * `runs.subscribe` reads, and the queued-run follower. See the module docblock.
 */
export function createManagedRuns(opts: CreateManagedRunsOptions): ManagedRuns {
  const harnessDir = opts.harnessDir ?? process.cwd();
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const probe = opts.probe ?? defaultLeaseProbe;
  const warnLine = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const ledgerOn = env["CREWHAUS_RUN_LEDGER"] !== "0";
  const ledger = runsLedger(harnessDir);
  const host = hostname();
  const replicaId = replicaIdFrom(env, host);
  const execution = env["CREWHAUS_EXECUTION_ID"];
  const executionField =
    execution !== undefined && EXECUTION_RUN_ID_RE.test(execution) ? { execution } : {};
  const deploymentId = env["CREWHAUS_DEPLOYMENT_ID"];
  const resumeTtlMs = Number(env["CREWHAUS_RESUME_IDEM_TTL_MS"] ?? 300_000);
  const resumeStore = createInMemoryIdempotencyStore<ManagedTurn>();
  const live = new Map<string, LiveRun>();
  const buses = new Map<
    string,
    { readonly tenantId: string; readonly bus: RunContext["eventBus"] }
  >();
  /** Queued runs this process saw leave `queued`, or found not its own. */
  const settled = new Set<string>();
  let warned = false;
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Registered at construction, so the count holds with run rows off and the
  // first beat counts. A count, not a hold: admission reads holds.
  opts.control?.onActiveRuns(() => live.size);

  const stamp = (): string => new Date(now()).toISOString();

  /** The first failed claim, append or digest warns, by code only; later ones say nothing. */
  function warnOnce(code: string): void {
    if (warned) return;
    warned = true;
    warnLine(`[managed] run records could not be written; runs go on without them (${code})`);
  }

  /** Remove a queued run's input file once the run has left `queued`; a failure warns once. */
  function forgetInput(runId: string): void {
    if (!removeQueuedInput(harnessDir, runId)) warnOnce("input-file");
  }

  function holderRecord(): LedgerRecord {
    const startedAtMs = probe.startTimeMs(process.pid);
    return {
      pid: process.pid,
      host,
      replica: replicaId,
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    };
  }

  /** Append `running`, and return how to end the run; no rows when it cannot be written. */
  function startRows(
    runId: string,
    tenantId: string,
    fields: { readonly session: string; readonly resumeScope: string | undefined },
  ): RunRows {
    const running = append(ledger, {
      id: runId,
      state: "running",
      at: stamp(),
      trigger: API_TRIGGER,
      session: fields.session,
      ...(fields.resumeScope !== undefined ? { resumeScope: fields.resumeScope } : {}),
      tenant: tenantId,
      ...executionField,
    });
    if (!running.ok) {
      warnOnce(running.code);
      return NO_ROWS;
    }
    let ended = false;
    return {
      async end(ending, subject) {
        if (ended) return;
        ended = true;
        let subjectRef: string | undefined;
        if (subject !== undefined) {
          try {
            subjectRef = await subjectRefOf(harnessDir, subject);
          } catch {
            warnOnce("subject-key");
          }
        }
        const written = append(ledger, {
          id: runId,
          state: ending.state,
          at: stamp(),
          trigger: API_TRIGGER,
          tenant: tenantId,
          ...("failureClass" in ending ? { failureClass: ending.failureClass } : {}),
          ...(subjectRef !== undefined ? { subjectRef } : {}),
        });
        if (!written.ok) warnOnce(written.code);
      },
    };
  }

  /** Win `run/<id>` and append `running`. */
  function claimAndStart(
    runId: string,
    tenantId: string,
    fields: { readonly session: string; readonly resumeScope: string | undefined },
  ): RunRows {
    if (!ledgerOn) return NO_ROWS;
    const claimed = publishClaim(ledger, `run/${runId}`, holderRecord());
    if (!claimed.ok) {
      warnOnce(claimed.code);
      return NO_ROWS;
    }
    return startRows(runId, tenantId, fields);
  }

  function registerBus(runId: string, tenantId: string, bus: RunContext["eventBus"]): void {
    buses.set(runId, { tenantId, bus });
    while (buses.size > RUN_BUS_CAP) {
      const oldest = buses.keys().next().value;
      if (oldest === undefined) break;
      buses.delete(oldest);
    }
  }

  /** The policy check a run passes before its turn. A denial throws. */
  async function checkPolicy(log: AuditLog, tenant: Tenant, input: string): Promise<void> {
    const policy = evaluatePolicy({
      toolName: "runChatLoop",
      sideEffect: "external",
      input,
      tenantId: tenant.id,
    });
    await auditPolicyDecision(log, { toolName: "runChatLoop", input, tenantId: tenant.id }, policy);
    if (policy.decision === "deny") {
      throw new Error(`policy denied: ${policy.reason ?? "no reason"}`);
    }
  }

  type TurnPlan = {
    readonly runId: string;
    readonly tenant: Tenant;
    readonly sessionId: string;
    readonly input: string;
    readonly isResume: boolean;
    readonly resumeScope: string | undefined;
    readonly subject: string | undefined;
    readonly rows: RunRows;
    readonly run: LiveRun;
    readonly log: AuditLog;
  };

  /**
   * The run's context, its turn and its terminal row, in the run's scope: what
   * started it, what it may be resumed as, and who it serves.
   */
  function runTurn(plan: TurnPlan): Promise<ManagedRunResult> {
    const scope: RunScope = {
      trigger: API_TRIGGER,
      ...(plan.resumeScope !== undefined ? { resumeScope: plan.resumeScope } : {}),
      ...(plan.subject !== undefined ? { subject: plan.subject } : {}),
    };
    return runWithScope(scope, async () => {
      const runContext = createRunContext({ runId: plan.runId, sessionId: plan.sessionId });
      registerBus(plan.runId, plan.tenant.id, runContext.eventBus);
      plan.run.ctx = runContext;
      if (plan.run.cancelled) cancelRun(plan.runId);
      const args: ManagedTurnArgs = {
        tenant: plan.tenant,
        sessionId: plan.sessionId,
        input: plan.input,
        isResume: plan.isResume,
        runContext,
        log: plan.log,
      };
      let served: ManagedTurn;
      try {
        if (plan.isResume) {
          // A duplicate resume (a client retry) answers the turn it already served.
          const guarded = withIdempotency<undefined, ManagedTurn>(() => opts.executeTurn(args), {
            store: resumeStore,
            ttlMs: resumeTtlMs,
          });
          const key = idempotencyKey(`${plan.tenant.id}:${plan.sessionId}:${plan.input}`, 0);
          served = (await guarded(undefined, key)).value;
        } else {
          served = await opts.executeTurn(args);
        }
      } catch (err) {
        // A classified failure renders its report on the daemon's stderr; the
        // daemon keeps serving, and the caller gets the error.
        if (isRunFailedError(err)) {
          process.stderr.write(`${formatRunFailure(err.report, { prefix: "[managed]" })}\n`);
        }
        await plan.rows.end(endingOf(err, runContext), plan.subject);
        throw err;
      }
      await plan.rows.end(
        isCancelReason(runContext.abortSignal) ? { state: "cancelled" } : { state: "succeeded" },
        plan.subject,
      );
      if (opts.control !== undefined) opts.control.counters.turns++;
      const inputTokens = Math.ceil(plan.input.length / 4);
      const outputTokens = Math.ceil(served.reply.length / 4);
      await opts.recordUsage(plan.tenant.id, { input: inputTokens, output: outputTokens });
      await plan.log.append({
        kind: "model_call",
        payload: { tenantId: plan.tenant.id, sessionId: plan.sessionId, inputTokens, outputTokens },
      });
      return {
        runId: plan.runId,
        sessionId: plan.sessionId,
        tenantId: plan.tenant.id,
        reply: served.reply,
        ...(served.proof !== undefined ? { proof: served.proof } : {}),
      };
    });
  }

  /**
   * The run input's verdict and, for kept input, its inbound entry. The
   * gateway's verdict when it handed one (its own scope then tags the input);
   * otherwise the input is classified here at "api", so a caller other than
   * the gateway has its input checked once too.
   */
  async function verdictFor(
    args: Parameters<RunHandler>[0],
    input: unknown,
  ): Promise<{ readonly verdict: RunInputVerdict; readonly entry?: InboundContent }> {
    if (args.inputVerdict !== undefined) return { verdict: args.inputVerdict };
    if (typeof input !== "string") {
      throw new GatewayCodedError(ErrorCode.BadRequest, "params.input must be a string");
    }
    const boundary = await classifyBoundary(input, { origin: "api" });
    const rules = boundaryRuleIds(boundary.verdict);
    const verdict: RunInputVerdict = {
      action: boundary.action,
      rules,
      score: boundary.verdict.score,
    };
    if (boundary.action === "redact") return { verdict };
    return {
      verdict,
      entry: {
        content: input,
        origin: "api",
        door: args.method,
        ...(boundary.action === "warn" ? { warning: { rules, score: verdict.score } } : {}),
      },
    };
  }

  /** `runs.create` / `runs.continue`: recorded, then run, then recorded again. */
  async function startRun(args: Parameters<RunHandler>[0]): Promise<ManagedRunResult> {
    const { method, tenant } = args;
    const p = args.params as { readonly input: string; readonly sessionId?: string };
    const { verdict, entry } = await verdictFor(args, p.input);
    const blocked = verdict.action === "redact";
    const log = await opts.getAuditLog(tenant);
    // A refused input runs no turn, so it meets no policy check either.
    if (!blocked) await checkPolicy(log, tenant, p.input);
    const sessionId = p.sessionId ?? `sess_${randomBytes(8).toString("hex")}`;
    const runId = mintRunId();
    const subject = subjectOf(tenant, args.sub);
    const resumeScope = sessionScope(sessionId);
    const run: LiveRun = { tenantId: tenant.id, cancelled: false };
    live.set(runId, run);
    try {
      const rows = claimAndStart(runId, tenant.id, { session: sessionId, resumeScope });
      if (blocked) {
        await rows.end({ state: "failed", failureClass: "input_blocked" }, subject);
        throw new GatewayCodedError(
          ErrorCode.InputBlocked,
          `input refused by the prompt-injection check (rules: ${verdict.rules.join(", ")})`,
          { origin: "api", rules: [...verdict.rules], score: verdict.score },
        );
      }
      const plan: TurnPlan = {
        runId,
        tenant,
        sessionId,
        input: p.input,
        isResume: method === "runs.continue" && p.sessionId !== undefined,
        resumeScope,
        subject,
        rows,
        run,
        log,
      };
      return await (entry === undefined
        ? runTurn(plan)
        : withInboundContent([entry], () => runTurn(plan)));
    } finally {
      live.delete(runId);
    }
  }

  /**
   * `runs.cancel`: a run of the caller's tenant that this process is running
   * is stopped (`cancelRun`); a queued one of the caller's tenant is cancelled
   * once its claim is won. `{ok: false}` for anything else, another tenant's
   * run included, so a run's existence never crosses tenants.
   */
  async function cancel(args: Parameters<RunHandler>[0]): Promise<{ ok: boolean }> {
    const { runId } = args.params as { readonly runId: string };
    const stopLive = (): { ok: boolean } | undefined => {
      const running = live.get(runId);
      if (running === undefined) return undefined;
      if (running.tenantId !== args.tenant.id) return { ok: false };
      running.cancelled = true;
      if (running.ctx !== undefined) cancelRun(runId);
      return { ok: true };
    };
    const inFlight = stopLive();
    if (inFlight !== undefined) return inFlight;
    if (!ledgerOn || !CANONICAL_RUN_ID_RE.test(runId)) return { ok: false };
    const folded = foldStates(ledger);
    if (!folded.ok) return { ok: false };
    const queued = folded.objects.get(runId);
    if (queued?.state !== "queued" || queued.record["tenant"] !== args.tenant.id) {
      return { ok: false };
    }
    const claimed = publishClaim(ledger, `run/${runId}`, holderRecord());
    // The follower got there first, and holds the run live once it claims it.
    if (!claimed.ok) return stopLive() ?? { ok: false };
    const written = append(ledger, {
      id: runId,
      state: "cancelled",
      at: stamp(),
      trigger: API_TRIGGER,
      tenant: args.tenant.id,
    });
    if (!written.ok) warnOnce(written.code);
    forgetInput(runId);
    return { ok: true };
  }

  /** Mark `interrupted` each run a provably gone process of this replica left `running`. */
  function sweep(): void {
    const folded = foldStates(ledger);
    if (!folded.ok) {
      warnOnce(folded.code);
      return;
    }
    for (const object of folded.objects.values()) {
      if (object.state !== "running" || typeof object.record["tenant"] !== "string") continue;
      if (live.has(object.id)) continue;
      const claim = readClaim(ledger, `run/${object.id}`);
      if (!claim.ok) continue;
      const holder = holderOf(claim.content.record);
      if (holder === undefined) continue;
      // A claim on this replica and this pid, made before this process started,
      // was made by an earlier process on a reused pid (a container's pid 1,
      // restarted). Only when the probe cannot tell processes on one pid apart
      // by start time; when it can, `holderProvablyDead` compares them.
      const reusedPid =
        replicaKey(holder) === replicaId &&
        holder.pid === process.pid &&
        probe.startTimeMs(process.pid) === undefined &&
        Date.parse(claim.content.at) < performance.timeOrigin;
      const judged = {
        pid: holder.pid,
        host: replicaKey(holder),
        ...(holder.startedAtMs !== undefined ? { startedAtMs: holder.startedAtMs } : {}),
      };
      // A holder on another replica is never probed: a pid means nothing across
      // pid namespaces.
      if (!reusedPid && !holderProvablyDead(judged, probe, replicaId)) continue;
      const written = append(ledger, {
        id: object.id,
        state: "interrupted",
        at: stamp(),
        trigger: API_TRIGGER,
        tenant: object.record["tenant"],
        by: "sys:reconcile",
      });
      if (!written.ok) warnOnce(written.code);
    }
  }

  function tenantNamed(id: string): Tenant {
    return (
      opts.tenantOverrides?.[id] ??
      buildTenant(id, opts.tenantsRoot !== undefined ? { tenantsRoot: opts.tenantsRoot } : {})
    );
  }

  /** Run one queued run whose claim this process won. Never rejects. */
  async function runQueued(runId: string, tenantId: string): Promise<void> {
    const run: LiveRun = { tenantId, cancelled: false };
    live.set(runId, run);
    try {
      // Read once: a run that leaves `queued` is never run again, so its
      // input and subject leave the disk here.
      const input = readQueuedInput(harnessDir, runId, tenantId);
      forgetInput(runId);
      const sessionId = input?.sessionId ?? `sess_${randomBytes(8).toString("hex")}`;
      const resumeScope = sessionScope(sessionId);
      const rows = startRows(runId, tenantId, { session: sessionId, resumeScope });
      const subject = input?.subject;
      let tenant: Tenant;
      try {
        tenant = tenantNamed(tenantId);
      } catch {
        await rows.end({ state: "failed", failureClass: "config" }, subject);
        return;
      }
      const budget = opts.budgetStore;
      const reservation =
        budget === undefined
          ? { ok: true }
          : await budget.tryReserve(tenant.id, ZERO_USAGE, tenant.budget);
      if (!reservation.ok) {
        await rows.end({ state: "failed", failureClass: "crewhaus_budget" }, subject);
        return;
      }
      try {
        if (input === undefined) {
          await rows.end({ state: "failed", failureClass: "unknown" }, subject);
          return;
        }
        // A queued input enters here, never through a request: classified at
        // "api" before anything runs, and kept text tags the run's context.
        const boundary = await classifyBoundary(input.input, { origin: "api" });
        if (boundary.action === "redact") {
          await rows.end({ state: "failed", failureClass: "input_blocked" }, subject);
          return;
        }
        const rules = boundaryRuleIds(boundary.verdict);
        const entry: InboundContent = {
          content: input.input,
          origin: "api",
          door: "queued",
          ...(boundary.action === "warn"
            ? { warning: { rules, score: boundary.verdict.score } }
            : {}),
        };
        await withTenant(tenant, () =>
          withInboundContent([entry], async () => {
            const log = await opts.getAuditLog(tenant);
            try {
              await checkPolicy(log, tenant, input.input);
            } catch (err) {
              await rows.end({ state: "failed", failureClass: "unknown" }, subject);
              throw err;
            }
            await runTurn({
              runId,
              tenant,
              sessionId,
              input: input.input,
              isResume: input.sessionId !== undefined,
              resumeScope,
              subject,
              rows,
              run,
              log,
            });
          }),
        );
      } finally {
        if (budget !== undefined) await budget.release(tenant.id, ZERO_USAGE);
      }
    } catch (err) {
      warnLine(`[managed] queued run ${runId} ended with an error: ${(err as Error).message}`);
    } finally {
      live.delete(runId);
    }
  }

  /**
   * The runs a claim pass looks at: one input file each (a queued run's input
   * is written before its row), less those this process saw leave `queued` or
   * found not its own, so a daemon with nothing queued reads one directory and
   * folds nothing. An input with no row past the grace period is removed and
   * never looked at again.
   */
  function claimCandidates(): string[] {
    let names: string[];
    try {
      names = readdirSync(join(harnessDir, controlPaths(harnessDir).inputsDir));
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => CANONICAL_RUN_ID_RE.test(id) && !settled.has(id));
  }

  /** Whether a rowless input is past the grace period, by its own mtime (a link's, never its target's). */
  function orphaned(runId: string): boolean {
    try {
      const file = join(harnessDir, controlPaths(harnessDir).inputsDir, `${runId}.json`);
      return now() - lstatSync(file).mtimeMs > ORPHAN_INPUT_GRACE_MS;
    } catch {
      // Gone already, or not readable: the next listing decides.
      return false;
    }
  }

  async function claimQueued(): Promise<void> {
    if (!ledgerOn || stopped) return;
    const candidates = claimCandidates();
    if (candidates.length === 0) return;
    const folded = foldStates(ledger);
    if (!folded.ok) {
      warnOnce(folded.code);
      return;
    }
    const runs: Promise<void>[] = [];
    for (const id of candidates) {
      if (stopped) break;
      const object = folded.objects.get(id);
      if (object === undefined) {
        // Past the grace period, an input with no row is an orphan: removed, and
        // never looked at again (one that cannot be removed warns once).
        // Younger, its row may not be written yet: the next pass looks again.
        if (orphaned(id)) {
          forgetInput(id);
          settled.add(id);
        }
        continue;
      }
      const tenantId = object.record["tenant"];
      const deployment = object.record["deployment"];
      if (object.state !== "queued") {
        // An input left behind by a run that already left `queued` (its
        // process ended before it removed it) is never read again.
        forgetInput(id);
        settled.add(id);
        continue;
      }
      if (
        typeof tenantId !== "string" ||
        (deploymentId !== undefined &&
          typeof deployment === "string" &&
          deployment !== deploymentId)
      ) {
        settled.add(id);
        continue;
      }
      if (intakeVerdict(harnessDir).state === "closed") break;
      if (opts.intakeGate?.().paused === true) break;
      const claimed = publishClaim(ledger, `run/${id}`, holderRecord());
      settled.add(id);
      if (!claimed.ok) {
        if (claimed.code !== "exists") warnOnce(claimed.code);
        continue;
      }
      runs.push(runQueued(id, tenantId));
    }
    await Promise.all(runs);
  }

  const handler: RunHandler = async (args) => {
    switch (args.method) {
      case "runs.create":
      case "runs.continue":
        return startRun(args);
      case "runs.cancel":
        return cancel(args);
      case "sessions.list":
      case "sessions.fork":
        throw new GatewayCodedError(ErrorCode.Unsupported, SESSIONS_UNSUPPORTED);
      case "audit.tail": {
        const { sinceTs } = args.params as { readonly sinceTs?: number };
        const log = await opts.getAuditLog(args.tenant);
        const rows: unknown[] = [];
        for await (const row of log.read()) {
          if (sinceTs === undefined || row.ts >= sinceTs) rows.push(row);
        }
        return { rows };
      }
      default: {
        const other = opts.otherMethods?.[args.method];
        if (other !== undefined) return other({ params: args.params, tenant: args.tenant });
        throw new GatewayCodedError(
          ErrorCode.Unsupported,
          `this daemon does not serve ${args.method}`,
        );
      }
    }
  };
  Object.defineProperty(handler, MANAGED_RUN_HANDLER, { value: true, enumerable: false });

  const resolveRunEvents: ResolveRunEvents = ({ runId, tenant }) => {
    const entry = buses.get(runId);
    if (entry === undefined || entry.tenantId !== tenant.id) return undefined;
    const bus = entry.bus;
    return {
      // The replay and the live listener attach with no yield between, so no
      // event is dropped or duplicated across the boundary.
      open: (listener: (event: unknown) => void) => {
        const replay = bus.recent();
        const close = bus.subscribe(listener);
        return { replay, close };
      },
    };
  };

  return {
    handler,
    resolveRunEvents,
    claimQueued: () => claimQueued().catch(() => undefined),
    async start(): Promise<void> {
      if (started) return;
      started = true;
      if (!ledgerOn) return;
      sweep();
      opts.control?.onClaim(() => claimQueued().catch(() => undefined));
      if (env["CREWHAUS_CONTROL_PORT"] === undefined) {
        timer = setInterval(() => void claimQueued().catch(() => undefined), CLAIM_POLL_MS);
        (timer as { unref?: () => void }).unref?.();
      }
      await claimQueued().catch(() => undefined);
    },
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Boot checks the emitted daemon makes.
// ---------------------------------------------------------------------------

export type ResolveGatewaySecretOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Test seam: where a boot line goes. Default `console.error`. */
  readonly log?: (line: string) => void;
  /** Test seam: how the boot ends. Default `process.exit`. */
  readonly exit?: (code: number) => never;
};

/**
 * The token signing secret: `CREWHAUS_GATEWAY_JWT_SECRET` when it is set (at
 * least 16 characters, else the boot ends with exit 1). Without it, a secret
 * is generated for this boot and saved to `.crewhaus/run/gateway-jwt-secret`
 * (`0600`, replaced each boot, beside a `.gitignore` of `*`), and the log names
 * the path, so the operator can mint a token from it; when it cannot be saved
 * the boot ends with exit 1, naming the variable.
 */
export function resolveGatewaySecret(opts: ResolveGatewaySecretOptions): string {
  const log = opts.log ?? ((line: string) => console.error(line));
  const exit = opts.exit ?? ((code: number): never => process.exit(code));
  const fromEnv = opts.env["CREWHAUS_GATEWAY_JWT_SECRET"];
  if (fromEnv !== undefined && fromEnv.length < 16) {
    log(
      "[managed] CREWHAUS_GATEWAY_JWT_SECRET is set but too short (min 16 chars). Refusing to start.",
    );
    return exit(1);
  }
  if (fromEnv !== undefined) return fromEnv;
  const secret = randomBytes(24).toString("hex");
  // Generated for this boot and saved for the operator, who mints a token
  // from it. Production sets CREWHAUS_GATEWAY_JWT_SECRET.
  const secretFile = `${opts.cwd}/.crewhaus/run/gateway-jwt-secret`;
  try {
    mkdirSync(dirname(secretFile), { recursive: true, mode: 0o700 });
    rmSync(secretFile, { force: true });
    const ignoreFile = `${dirname(secretFile)}/.gitignore`;
    try {
      writeFileSync(ignoreFile, "*\n", { flag: "wx" });
    } catch {}
    // An operator's own file stays. Anything else at that name is not a
    // .gitignore git reads, so it gives way to one.
    if (!lstatSync(ignoreFile).isFile()) {
      rmSync(ignoreFile, { force: true, recursive: true });
      writeFileSync(ignoreFile, "*\n", { flag: "wx" });
    }
    writeFileSync(secretFile, `${secret}\n`, { mode: 0o600, flag: "wx" });
  } catch (err) {
    log(
      `[managed] set CREWHAUS_GATEWAY_JWT_SECRET (at least 16 chars): no secret is set, and one could not be saved to ${secretFile}: ${(err as Error).message}`,
    );
    return exit(1);
  }
  log(
    "[managed] no CREWHAUS_GATEWAY_JWT_SECRET in env, so this run generated one and saved it to .crewhaus/run/gateway-jwt-secret. Set the variable to keep tokens valid across restarts.",
  );
  return secret;
}

/** Where `path` lands on disk: links followed, and a missing tail joined to its deepest existing parent. */
function onDisk(path: string): string {
  const at = resolve(path);
  try {
    return realpathSync(at);
  } catch {}
  const up = dirname(at);
  return up === at ? at : join(onDisk(up), basename(at));
}

/**
 * For a spec that declares a tool that works on files: the refusal message
 * when the tenants root is the harness directory, lies inside it or contains
 * it (such as `..`), found on disk (a root named through a link, or one that
 * does not exist yet, is compared by where it lands), else `undefined`.
 */
export function checkTenantsRoot(opts: {
  readonly cwd: string;
  readonly tenantsRoot: string;
}): string | undefined {
  const root = onDisk(resolve(opts.cwd, opts.tenantsRoot));
  const here = onDisk(opts.cwd);
  // Only `..` itself or a leading `..` segment leaves a directory: a child named `..tenants` is inside it.
  const within = (rel: string): boolean =>
    rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  // The root is the harness directory or lies inside it, or the harness lies inside the root.
  const shared = within(relative(here, root)) || within(relative(root, here));
  return shared
    ? "[managed] this spec declares a tool that works on files, so CREWHAUS_TENANTS_ROOT must neither be the harness directory nor contain it; set it to an absolute path such as /home/you/.crewhaus/tenants/<harness>."
    : undefined;
}
