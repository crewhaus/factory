/**
 * The M2 process layer — one `HarnessSupervisor` per registered harness,
 * plus the shared port ledger, the job queue, and the control-port capture
 * that turns the read-only console into a driver.
 *
 * Everything supervision-shaped lives in `@crewhaus/harness-supervisor`;
 * this module is the manager's composition root for it and nothing more. In
 * particular:
 *
 *   - **`plan` is rebuilt on EVERY start.** `buildSpawnPlan` re-resolves the
 *     bundle, the `crewhaus` bin, and the env chain each time, so a
 *     recompile or a spec edit between two starts is picked up without
 *     recreating the supervisor.
 *   - **The preflight gate evaluates `plan.env`.** It goes through
 *     `mergedSpawnEnv`, which delegates to `buildSpawnEnv` — the same
 *     function the plan uses. Checking a different env than the spawn gets
 *     is how "passed preflight, died on a missing key" happens.
 *   - **`CREWHAUS_CONTROL_PORT=0`.** The kernel picks the port, the daemon
 *     announces it on stdout, and the pump hands us that line. Reserving a
 *     number in advance would race every other manager on the box; parsing
 *     the announcement cannot. The port is written back into the runfile so
 *     a manager restart adopts it instead of losing wake/drain.
 *   - **No `CREWHAUS_CONTROL_TOKEN` is stamped.** Omitting it makes the
 *     daemon mint `<harness>/.crewhaus/run/control-token` (0600) FRESH at
 *     every boot, which is what keeps a dead daemon's token from
 *     authenticating against its replacement. The client re-reads the file
 *     per call.
 *   - **Boot order is load-bearing**: open the port ledger → `adopt()` every
 *     registered harness → `jobQueue.restore()`. Restore last, so a job that
 *     was running when the manager died is closed as `interrupted` against a
 *     process picture that is already accurate.
 *   - **Boot adoption is not sufficient.** It only sees daemons that existed
 *     at that instant. A daemon started afterwards from a terminal, by a
 *     launchd unit, or for a harness registered later would never be
 *     adopted, and an unadopted supervisor holds no pid — so the console
 *     would report `stopped` over a live runfile and stop/drain would answer
 *     "stopped" having signalled nothing. The server therefore calls
 *     `supervisor.adoptIfRunfile()` on the request path (see `processFor` in
 *     `server.ts`); it is a no-op unless a runfile exists and this
 *     supervisor holds no pid.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type LeaseHolder, type LeaseOptions, withMutatingLease } from "@crewhaus/control-records";
import { admitExplicitStart, recordDesired } from "@crewhaus/control-service";
import { readSpecHeader } from "@crewhaus/harness-inventory";
import {
  type HangarHarnessEntry,
  type HangarRegistry,
  runsOwnCode,
} from "@crewhaus/harness-registry";
import {
  type BinResolverDeps,
  type Clock,
  type DaemonRunfile,
  type HarnessSupervisor,
  type JobQueue,
  type JobRecord,
  type JobRunContext,
  type JobRunner,
  type JobStore,
  type PortLedger,
  type ProcessOps,
  type SpawnPlan,
  SpawnPlanError,
  type SubmitInput,
  type SupervisorEvent,
  type SupervisorSnapshot,
  buildSpawnPlan,
  controlTokenPath,
  createFileJobStore,
  createHarnessSupervisor,
  createJobQueue,
  createPortLedger,
  createPrepareRunner,
  createProcessOps,
  ensureRunDir,
  homeCrewhausArgv,
  isReadOnlyJob,
  operatorRefusal,
  processOpsChild,
  readManagerSettings,
  readRunfile,
  resolveCrewhausBin,
  runClassFor,
  runLogPath,
  runManagerHook,
  runPreflightGate,
  systemClock,
  writeRunfile,
} from "@crewhaus/harness-supervisor";
import { type PreflightItem, workspaceItems } from "@crewhaus/preflight";
import { knownControlPort, parseControlPort } from "./control-client";
import { mergedSpawnEnv } from "./env-file";
import { HttpError } from "./http";
import { currentCommand } from "./receipts";
import { DEV_JOB_KIND, MCP_JOB_KIND } from "./runtime-ops";

/**
 * The job vocabulary — which jobs the M2 action faces submit, and the closed
 * `crewhaus` argv each one runs — lives in
 * `@crewhaus/harness-supervisor/job-kinds`, beside the queue that runs it.
 * Re-exported here, as the same bindings (so `instanceof JobArgumentError`
 * holds wherever it was thrown), for one release.
 */
export {
  isJobKind,
  JOB_KINDS,
  JobArgumentError,
  jobArgv,
  type JobKind,
  type JobOptions,
} from "@crewhaus/harness-supervisor/job-kinds";

/** How Home runs its own `crewhaus` for a job (from `@crewhaus/harness-supervisor`). */
export { homeCrewhausArgv };

export type ProcessLayerOptions = {
  readonly registry: HangarRegistry;
  /** The manager's own environment — the base layer of every spawn env. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  readonly onWarn: (message: string) => void;
  /** Where the durable job ledger lives (`<hangarRoot>/jobs.jsonl`). */
  readonly hangarRoot: string;
  readonly managerVersion: string;
  /**
   * The argv that runs this Home's own `crewhaus` (see {@link homeCrewhausArgv}): what a job
   * runs for a harness that does not run its own code. Without it, such a job runs the
   * `crewhaus` on `PATH`.
   */
  readonly homeCrewhaus?: readonly string[];
  /** Injected in tests — the fake never spawns anything. */
  readonly ops?: ProcessOps;
  readonly clock?: Clock;
  readonly ports?: PortLedger;
  readonly jobStore?: JobStore;
  /** Wraps the job store (the given one or the default file), so command receipts move
   *  with their jobs. */
  readonly wrapJobStore?: (store: JobStore) => JobStore;
  /** Job executor. Defaults to spawning the `crewhaus` CLI through `ops`. */
  readonly runJob?: JobRunner;
  readonly jobConcurrency?: number;
  /** Skip the preflight gate entirely (tests, and `daemon start
   *  --no-preflight`). */
  readonly noPreflight?: boolean;
  readonly pumpIntervalMs?: number;
};

/** One harness's supervision handle, memoized by harness dir. */
export type HarnessProcess = {
  readonly harnessId: string;
  readonly harnessDir: string;
  readonly target: string;
  readonly supervisor: HarnessSupervisor;
  snapshot(): SupervisorSnapshot;
  /** Build the spawn plan WITHOUT spawning — the console's "what would Start
   *  actually run" preview. Returns the plan or the typed failure (whose
   *  `remedy` the UI turns into a button: compile / add-spec / install-cli). */
  planPreview(): { readonly plan: SpawnPlan } | { readonly error: Error };
  /** The control port, from the runfile or the daemon's boot announcement. */
  controlPort(): number | undefined;
  /** Marks the next exit as an operator stop — the drain contract: the
   *  daemon answers 202 and exits 0 shortly after, and an unflagged exit 0
   *  from a long-running shape reads as "exited cleanly (unexpected)" and
   *  gets restarted. Reaches the SUPERVISOR (`markOperatorStop`), not just
   *  the display flag: a boolean this layer keeps to itself would leave the
   *  restart policy free to spawn the daemon the operator just drained. */
  markDraining(): void;
  /** Undo a `markDraining()` the drain never earned — a refused control call
   *  or a no-op drain. Without this the flag can only be cleared by an exit
   *  that is never coming, and the console's four process verbs stay
   *  disabled ("this daemon is draining") for the manager's lifetime. */
  clearDraining(): void;
  isDraining(): boolean;
  close(): void;
};

/** A Home job's submission: the queue's, plus the acknowledgements for this one job. */
export type HomeJobInput = SubmitInput & {
  /** Preflight item ids acknowledged for this job only. Never stored. */
  readonly acknowledge?: readonly string[];
};

/** The job queue as Home submits to it: every submission is checked first. */
export type HomeJobQueue = Omit<JobQueue, "submit"> & {
  /**
   * Enqueue a job, after the checks a start makes of where it runs. A harness its operator
   * disabled runs no job that runs its own code or runs or serves its spec
   * ({@link jobRunsSpec}): an `HttpError` 409 `disabled` is thrown and nothing is enqueued.
   * A directory that holds the home directory needs `workspace.holds-home` in
   * `acknowledge`, for this job, or {@link JobRefusedError} is thrown and nothing is
   * enqueued. The acknowledgement is not
   * kept: the job's record carries no trace of it, and the next job asks again.
   */
  submit(input: HomeJobInput): JobRecord;
  /** Throw the refusal {@link HomeJobQueue.submit} would for these fields, enqueuing nothing.
   *  Without `argv`, the job's verb is not known yet, so only the checks every job gets run. */
  check(
    input: Pick<HomeJobInput, "harnessDir" | "acknowledge"> & { readonly argv?: readonly string[] },
  ): void;
};

/** The `eval` read verbs, which run no spec. */
const EVAL_READ_VERBS: ReadonlySet<string> = new Set([
  "coverage",
  "plan",
  "leaderboard",
  "history",
  "baseline",
  "baselines",
  "diff",
]);

/**
 * Whether a job's `crewhaus` argv runs or serves the harness's spec: the verbs the CLI's
 * entry gate checks (`serve`, `dev`, `run`, `optimize`, `eval` but its read verbs,
 * `flywheel run`, `dream` but `status` and `init`).
 *
 * First consumer: {@link createProcessLayer}'s job check.
 */
export function jobRunsSpec(argv: readonly string[]): boolean {
  const [verb, sub = ""] = argv;
  switch (verb) {
    case "serve":
    case "dev":
    case "run":
    case "optimize":
      return true;
    case "eval":
      return !EVAL_READ_VERBS.has(sub);
    case "flywheel":
      return sub === "run";
    case "dream":
      return sub !== "status" && sub !== "init";
    default:
      return false;
  }
}

/** A Home job refused before it was enqueued, carrying the preflight item that refused it. */
export class JobRefusedError extends Error {
  override readonly name = "JobRefusedError";
  readonly item: PreflightItem;
  constructor(item: PreflightItem) {
    super(item.message);
    this.item = item;
  }
}

export type ProcessLayer = {
  /** The (memoized) supervision handle for a registered harness. */
  get(entry: HangarHarnessEntry): HarnessProcess;
  /** Already-created handles only — no side effects. */
  peek(harnessDir: string): HarnessProcess | undefined;
  /**
   * Every handle this layer currently HOLDS, in insertion order.
   *
   * The same iteration `close()` does, exposed so a caller that must reach
   * every live supervisor (manager shutdown) enumerates what this process
   * actually supervises rather than re-deriving it from the registry — a
   * harness removed, relocated or never registered mid-session still has a
   * handle here, and that handle is the only thing that can stop it.
   *
   * SIDE-EFFECT FREE, exactly like {@link peek}: no supervisor is built and
   * nothing is adopted, so enumerating is never how a daemon gets picked up.
   */
  held(): readonly HarnessProcess[];
  readonly jobs: HomeJobQueue;
  /** The process seam every supervisor here acts through: what a read judges a runfile by. */
  readonly ops: ProcessOps;
  /** Adopt every registered harness, then restore the job queue. */
  boot(): Promise<{ readonly adopted: number; readonly lost: number; readonly jobs: number }>;
  close(): void;
};

/** The `target:` the harness's spec declares right now, or undefined when the
 *  spec is absent/unreadable (the registry's cached row is then the answer). */
function liveTarget(harnessDir: string): string | undefined {
  try {
    const header = readSpecHeader(readFileSync(join(harnessDir, "crewhaus.yaml"), "utf8"));
    return header.target !== undefined && header.target !== "" ? header.target : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What holds a harness's mutating lease, in words. A CLI holder's kind is the verb it
 * runs (`crewhaus eval`); a Home holder's is a job's label, which is not always a
 * command, so it is named as a job.
 */
export function leaseHolderWords(holder: LeaseHolder): string {
  const what =
    holder.head === "cli"
      ? `\`crewhaus ${holder.kind}\` from the CLI`
      : `${holder.head === "resident" ? "the Home service's" : "Home's"} ${holder.kind} job`;
  return `${what} (pid ${holder.pid}, since ${holder.since})`;
}

/** Why a mutating job could not start: another process holds the harness. */
export function leaseRefusal(holder: LeaseHolder): string {
  return `another change is running on this harness: ${leaseHolderWords(holder)}; try again when it finishes`;
}

/**
 * Job kinds that serve until they are stopped: the MCP projection and the dev loop. They
 * take no mutating lease, as a running daemon takes none: held for a server's whole life,
 * it would refuse every terminal compile and eval on the harness until someone stopped it.
 */
export const LONG_LIVED_JOB_KINDS: ReadonlySet<string> = new Set([MCP_JOB_KIND, DEV_JOB_KIND]);

/** The env name a job's child reads to run under the lease its parent holds. */
export const LEASE_REF_ENV = "CREWHAUS_LEASE_REF";

/** Default job runner: spawn `crewhaus <argv>` in the harness root through
 *  the same `ProcessOps` seam the supervisor uses, capturing into the run
 *  dir. Never a shell — argv is passed as a vector.
 *
 *  DETACHED, like every other non-interactive spawn in the system. A job is
 *  a TREE, not a process: `crewhaus eval` connects the spec's `mcp_servers`
 *  and the bash tool spawns `sh -c`, so the thing that has to be signalled
 *  is the process GROUP. `detached: true` makes the child a group leader,
 *  which is the only thing that makes `createPosixProcessOps.signalGroup`'s
 *  `kill(-pid, sig)` succeed — attached, that call raises ESRCH and silently
 *  degrades to `kill(pid, sig)`, so cancel/shutdown reach `crewhaus eval`
 *  and leave its MCP servers holding the harness env. Nothing is lost by
 *  detaching: the child is registered as a {@link CancellableChild} below
 *  and is signalled explicitly through it. */
export function defaultJobRunner(
  ops: ProcessOps,
  harnessBin: (dir: string) => string | readonly string[] | undefined,
  lease: Omit<LeaseOptions, "probe"> = {},
): JobRunner {
  return async (job: JobRecord, ctx: JobRunContext) => {
    const found = harnessBin(job.harnessDir);
    const bin = typeof found === "string" ? [found] : found;
    if (bin === undefined || bin.length === 0) {
      return { error: "no resolvable `crewhaus` CLI (harness node_modules/.bin, then PATH)" };
    }
    ensureRunDir(job.harnessDir);
    // A mutating job holds the harness's mutating lease, the one the CLI's long verbs
    // take, so a terminal `crewhaus eval` and this job never write the tree at once. The
    // child is told the lease's ref and runs under it rather than waiting on itself. A
    // server that runs until stopped takes none (LONG_LIVED_JOB_KINDS).
    if (job.mutating && !LONG_LIVED_JOB_KINDS.has(job.kind)) {
      const held = await withMutatingLease(
        job.harnessDir,
        { head: "server", kind: job.kind },
        (held) => runJobChild(ops, bin, job, ctx, held.leaseRef),
        { ...lease, probe: ops },
      );
      if (held.ok) return held.value;
      return { error: "holder" in held ? leaseRefusal(held.holder) : held.reason };
    }
    return runJobChild(ops, bin, job, ctx, undefined);
  };
}

/**
 * A job's environment with every `PATH` entry that is not absolute left out, so a command
 * the job (or what it starts) finds on `PATH` never depends on the directory it runs in.
 */
export function absolutePathEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = { ...env };
  const sep = process.platform === "win32" ? ";" : ":";
  for (const key of Object.keys(out)) {
    if (key.toUpperCase() !== "PATH") continue;
    out[key] = (out[key] as string)
      .split(sep)
      .filter((dir) => dir !== "" && isAbsolute(dir))
      .join(sep);
  }
  return out;
}

async function runJobChild(
  ops: ProcessOps,
  bin: readonly string[],
  job: JobRecord,
  ctx: JobRunContext,
  leaseRef: string | undefined,
): Promise<{ exitCode?: number; error?: string }> {
  const logFile = runLogPath(job.harnessDir, job.jobId.replace(/^job_/, "run_"));
  const child = ops.spawn({
    argv: [...bin, ...job.argv],
    cwd: job.harnessDir,
    env: {
      ...absolutePathEnv(mergedSpawnEnv(process.env, job.harnessDir).env as Record<string, string>),
      ...(leaseRef !== undefined ? { [LEASE_REF_ENV]: leaseRef } : {}),
    },
    stdio: { mode: "file", path: logFile },
    detached: true,
  });
  // HAND THE CHILD TO THE QUEUE. Without this the queue knows a job is
  // "running" but holds nothing it can signal: `cancel()` answers false and
  // manager shutdown marks the ledger row while the process keeps going —
  // the orphan M4 exists to stop, reintroduced through the console path.
  ctx.register(processOpsChild(ops, child.pid));
  const { code } = await child.exited;
  if (code !== 0 || job.kind !== "compile") return { exitCode: code ?? 1 };

  // A manager-initiated compile replaces the bundle, which SILENTLY
  // discarded whatever the operator's post-compile step had patched into
  // it — the reason fleets had a "never use console compile jobs" rule.
  // Running the harness's own `postCompile` hook here closes that: the
  // console's compile and `daemon start --compile` leave the same bundle.
  const outcome = await runManagerHook(
    "postCompile",
    readManagerSettings(job.harnessDir).hooks.postCompile,
    {
      harnessDir: job.harnessDir,
      target: liveTarget(job.harnessDir) ?? "cli",
      ops,
      env: absolutePathEnv(
        mergedSpawnEnv(process.env, job.harnessDir).env as Record<string, string>,
      ),
      crewhausBin: bin[0],
    },
    readManagerSettings(job.harnessDir).hooks.timeoutMs,
  );
  if (outcome.ok) return { exitCode: 0 };
  // The compile itself succeeded; the job did not. Reporting 0 here would
  // leave a bundle nobody patched behind a green job row.
  return {
    exitCode: outcome.refusal.exitCode ?? 1,
    error: [outcome.refusal.message, ...outcome.refusal.output].join("\n"),
  };
}

/**
 * The `crewhaus` a Home job runs for the harness at `dir`, as an argv prefix: the harness's
 * own (contained) copy when its row was adopted with `crewhaus harness adopt` on this
 * machine; otherwise Home's own `crewhaus` (`home`, {@link homeCrewhausArgv}) when the host
 * names it, else the `crewhaus` on PATH. A directory with no registry row is not adopted.
 */
export function jobCrewhausBin(
  registry: Pick<HangarRegistry, "list">,
  dir: string,
  deps: Omit<BinResolverDeps, "allowHarnessLocal"> = {},
  home?: readonly string[],
): readonly string[] | undefined {
  const entry = registry.list().find((row) => row.dir === dir);
  const ownCode = entry !== undefined && runsOwnCode(entry);
  if (!ownCode && home !== undefined && home.length > 0) return [...home];
  const bin = resolveCrewhausBin(dir, { ...deps, allowHarnessLocal: ownCode });
  return bin === undefined ? undefined : [bin];
}

export function createProcessLayer(options: ProcessLayerOptions): ProcessLayer {
  const clock = options.clock ?? systemClock;
  const ops = options.ops ?? createProcessOps();
  const ports = options.ports ?? createPortLedger({ now: options.now });
  const handles = new Map<string, HarnessProcess>();

  const store = options.jobStore ?? createFileJobStore(`${options.hangarRoot}/jobs.jsonl`);
  const queue = createJobQueue({
    store: options.wrapJobStore !== undefined ? options.wrapJobStore(store) : store,
    run:
      options.runJob ??
      defaultJobRunner(ops, (dir) =>
        jobCrewhausBin(options.registry, dir, {}, options.homeCrewhaus),
      ),
    now: options.now,
    ...(options.jobConcurrency !== undefined ? { concurrency: options.jobConcurrency } : {}),
  });
  // The env `/proc/start`'s gate checks; an empty directory is the server's own.
  const check: HomeJobQueue["check"] = ({ harnessDir, acknowledge, argv }) => {
    // A disabled harness runs no job that runs its own code (every job of an adopted
    // harness, which runs its own `crewhaus`) or runs or serves its spec.
    if (harnessDir !== "") {
      const entry = options.registry.list().find((row) => row.dir === harnessDir);
      const ownCode = entry !== undefined && runsOwnCode(entry);
      if (ownCode || (argv !== undefined && jobRunsSpec(argv))) {
        const disabled = operatorRefusal(harnessDir);
        if (disabled !== undefined && disabled.reason === "disabled") {
          throw new HttpError(409, disabled.message, {
            ok: false,
            reason: "disabled",
            message: disabled.message,
            verb: "crewhaus daemon enable",
          });
        }
      }
    }
    const acknowledged = new Set(acknowledge ?? []);
    const refused = workspaceItems(harnessDir, mergedSpawnEnv(options.env, harnessDir).env).find(
      (item) => item.id === "workspace.holds-home" && !acknowledged.has(item.id),
    );
    if (refused !== undefined) throw new JobRefusedError(refused);
  };
  const jobs: HomeJobQueue = {
    ...queue,
    check,
    submit: ({ acknowledge, ...input }) => {
      check({
        harnessDir: input.harnessDir,
        argv: input.argv,
        ...(acknowledge !== undefined ? { acknowledge } : {}),
      });
      return queue.submit(input);
    },
  };

  const build = (entry: HangarHarnessEntry): HarnessProcess => {
    const harnessDir = entry.dir;
    // The LIVE spec's target wins over the registry row, which is a cached
    // copy that goes stale the moment someone edits `target:` — and the
    // target decides the run class, the entry file, and whether a crash is
    // restartable at all.
    const target = liveTarget(harnessDir) ?? entry.target;
    // The runfile records what the PLAN asked for, which is 0 ("kernel,
    // pick one") until the daemon announces the real number on stdout.
    let controlPort: number | undefined = knownControlPort(readRunfile(harnessDir)?.controlPort);
    let draining = false;

    const plan = (): SpawnPlan =>
      buildSpawnPlan({
        harnessDir,
        target,
        processEnv: options.env,
        crewhausBin: resolveCrewhausBin(harnessDir),
        // 0 = kernel-assigned; the daemon announces the real port on stdout.
        ports: { controlPort: 0 },
        // The PATH only — never the token itself, which the daemon mints.
        controlTokenPath: controlTokenPath(harnessDir),
      });

    const supervisor = createHarnessSupervisor({
      harnessDir,
      target,
      ops,
      clock,
      ports,
      managerVersion: options.managerVersion,
      // A person's start and stop from Home are written down for the recovery that runs
      // after a reboot.
      recordDesired: (desired) => recordDesired(harnessDir, desired),
      plan,
      // Home's Start, Restart and group start run only the active build (a harness with no
      // deployment record yet is recorded at its first start).
      admit: async ({
        harnessDir: dir,
        target: shape,
        entry: launched,
        ledgerAbsent,
        decideOnly,
      }) => {
        const command = currentCommand();
        return admitExplicitStart(dir, shape, {
          head: "home",
          entry: launched,
          ledgerAbsent,
          decideOnly,
          actor: command?.by ?? "sys:executor",
          registryId: entry.id,
          ...(command !== undefined ? { cmd: command.commandId } : {}),
          now: options.now,
        });
      },
      // The SAME prep the terminal head runs, built per start because
      // `.crewhaus/settings.json` is edited between starts like the spec is.
      // Without this the console's Restart button rebuilt the spawn plan and
      // skipped operator prep entirely — the asymmetry that made "never use
      // console compile jobs" a rule fleets had to remember.
      prepare: () =>
        createPrepareRunner({
          harnessDir,
          target,
          ops,
          env: mergedSpawnEnv(options.env, harnessDir).env as Record<string, string>,
          crewhausBin: resolveCrewhausBin(harnessDir),
          clock,
        }),
      ...(options.pumpIntervalMs !== undefined ? { pumpIntervalMs: options.pumpIntervalMs } : {}),
      ...(options.noPreflight === true
        ? {}
        : {
            gate: (gateOptions) =>
              runPreflightGate({
                harnessDir,
                // The env the spawn will really see (chain UNDER process env).
                env: mergedSpawnEnv(options.env, harnessDir).env,
                ...gateOptions,
              }),
          }),
    });

    // Watch the captured output for the control plane's boot announcement.
    // This is the ONLY way to learn a kernel-assigned control port, and
    // recording it in the runfile is what lets a manager restart adopt
    // wake/drain instead of silently losing them.
    const unsubscribe = supervisor.subscribe((event: SupervisorEvent) => {
      if (event.type === "exit") {
        controlPort = undefined;
        draining = false;
        return;
      }
      if (event.type !== "output" || event.prose === "") return;
      const port = parseControlPort(event.prose);
      if (port === undefined || port === controlPort) return;
      controlPort = port;
      const runfile: DaemonRunfile | undefined = readRunfile(harnessDir);
      if (runfile === undefined) return;
      try {
        writeRunfile(harnessDir, { ...runfile, controlPort: port });
      } catch (err) {
        options.onWarn(
          `hangar-server: could not record control port ${port} for ${harnessDir}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });

    return {
      harnessId: entry.id,
      harnessDir,
      target,
      supervisor,
      snapshot: () => supervisor.snapshot(),
      planPreview: () => {
        try {
          return { plan: plan() };
        } catch (err) {
          return { error: err instanceof Error ? err : new Error(String(err)) };
        }
      },
      controlPort: () => controlPort ?? knownControlPort(readRunfile(harnessDir)?.controlPort),
      markDraining: () => {
        draining = true;
        // The latch the exit classifier reads. A drained daemon exits 0, and
        // an unflagged exit 0 from a long-running shape is "exited cleanly
        // (unexpected)" — restartable — so without this the control-plane
        // drain is undone by our own restart policy ~500 ms later.
        supervisor.markOperatorStop();
      },
      clearDraining: () => {
        draining = false;
      },
      isDraining: () => draining,
      close: () => {
        unsubscribe();
        supervisor.close();
      },
    };
  };

  return {
    get: (entry) => {
      const existing = handles.get(entry.dir);
      if (existing !== undefined) return existing;
      const created = build(entry);
      handles.set(entry.dir, created);
      return created;
    },
    peek: (harnessDir) => handles.get(harnessDir),
    held: () => [...handles.values()],
    jobs,
    ops,
    boot: async () => {
      let adopted = 0;
      let lost = 0;
      for (const entry of options.registry.list()) {
        if (entry.missingSince !== null || !existsSync(entry.dir)) continue;
        // Only harnesses with a runfile can have anything to adopt; skipping
        // the rest keeps boot O(daemons) rather than O(fleet).
        if (readRunfile(entry.dir) === undefined) continue;
        const handle = handles.get(entry.dir) ?? build(entry);
        handles.set(entry.dir, handle);
        try {
          const result = await handle.supervisor.adopt();
          if (result === "adopted") adopted += 1;
          else if (result === "lost") lost += 1;
        } catch (err) {
          options.onWarn(
            `hangar-server: adopt failed for ${entry.dir}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      // Last: pending work re-enqueues, running work closes as `interrupted`
      // (never silently re-run) against an already-accurate process picture.
      const restored = jobs.restore();
      return { adopted, lost, jobs: restored.requeued.length };
    },
    close: () => {
      for (const handle of handles.values()) handle.close();
      handles.clear();
    },
  };
}

/** True when a job kind runs alongside other work on the same harness. */
export { isReadOnlyJob };

/** The run class a spec target is supervised under (`daemon`, `one-shot`, …). */
export { runClassFor };

/** Re-exported so route handlers can name the plan failure's remedy. */
export { SpawnPlanError };
