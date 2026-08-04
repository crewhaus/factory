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
import { join } from "node:path";
import { readSpecHeader } from "@crewhaus/harness-inventory";
import type { HangarHarnessEntry, HangarRegistry } from "@crewhaus/harness-registry";
import {
  type Clock,
  type DaemonRunfile,
  type HarnessSupervisor,
  type JobQueue,
  type JobRecord,
  type JobRunner,
  type JobStore,
  type PortLedger,
  type ProcessOps,
  type SpawnPlan,
  SpawnPlanError,
  type SupervisorEvent,
  type SupervisorSnapshot,
  buildSpawnPlan,
  controlTokenPath,
  createFileJobStore,
  createHarnessSupervisor,
  createJobQueue,
  createPortLedger,
  createProcessOps,
  ensureRunDir,
  isReadOnlyJob,
  readRunfile,
  resolveCrewhausBin,
  runClassFor,
  runLogPath,
  runPreflightGate,
  systemClock,
  writeRunfile,
} from "@crewhaus/harness-supervisor";
import { knownControlPort, parseControlPort } from "./control-client";
import { mergedSpawnEnv } from "./env-file";

/** Job kinds the M2 action faces submit. Anything else is a 400. */
export const JOB_KINDS = ["doctor", "compile", "eval", "dream-run"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: string): value is JobKind {
  return (JOB_KINDS as readonly string[]).includes(value);
}

/** Typed job options. Deliberately NOT free-form argv: a job's command line
 *  is built here from a closed vocabulary, so an HTTP body can never append
 *  a flag (or a second command) to a spawn. */
export type JobOptions = {
  /** Registered dataset name or a harness-relative dataset file. */
  readonly dataset?: string;
  /** Harness-relative graders config. */
  readonly graders?: string;
};

/** One path segment, or a harness-relative path of such segments. Keeps a
 *  job argument from becoming `../..`, an absolute path, or a flag. */
const JOB_ARG_RE =
  /^[A-Za-z0-9_][A-Za-z0-9._@:-]{0,127}(?:\/[A-Za-z0-9_][A-Za-z0-9._@:-]{0,127})*$/;

export class JobArgumentError extends Error {}

/**
 * The `crewhaus` argv for one job. Pure, and pinned by a test: this is the
 * boundary where an HTTP body turns into a command line, so it is the one
 * place a mistake becomes an injection.
 */
export function jobArgv(kind: JobKind, options: JobOptions = {}): string[] {
  const checked = (name: string, value: string): string => {
    if (!JOB_ARG_RE.test(value)) {
      throw new JobArgumentError(
        `job ${kind}: "${name}" must be a plain name or harness-relative path (got ${JSON.stringify(value)})`,
      );
    }
    return value;
  };
  switch (kind) {
    case "doctor":
      return ["doctor"];
    case "compile":
      return ["compile", "crewhaus.yaml", "-o", "dist"];
    case "dream-run":
      return ["dream", "run", "crewhaus.yaml"];
    case "eval": {
      const argv = ["eval", "crewhaus.yaml"];
      if (options.dataset !== undefined)
        argv.push("--dataset", checked("dataset", options.dataset));
      if (options.graders !== undefined)
        argv.push("--graders", checked("graders", options.graders));
      return argv;
    }
  }
}

export type ProcessLayerOptions = {
  readonly registry: HangarRegistry;
  /** The manager's own environment — the base layer of every spawn env. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  readonly onWarn: (message: string) => void;
  /** Where the durable job ledger lives (`<hangarRoot>/jobs.jsonl`). */
  readonly hangarRoot: string;
  readonly managerVersion: string;
  /** Injected in tests — the fake never spawns anything. */
  readonly ops?: ProcessOps;
  readonly clock?: Clock;
  readonly ports?: PortLedger;
  readonly jobStore?: JobStore;
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

export type ProcessLayer = {
  /** The (memoized) supervision handle for a registered harness. */
  get(entry: HangarHarnessEntry): HarnessProcess;
  /** Already-created handles only — no side effects. */
  peek(harnessDir: string): HarnessProcess | undefined;
  readonly jobs: JobQueue;
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

/** Default job runner: spawn `crewhaus <argv>` in the harness root through
 *  the same `ProcessOps` seam the supervisor uses, capturing into the run
 *  dir. Never a shell — argv is passed as a vector. */
function defaultJobRunner(
  ops: ProcessOps,
  harnessBin: (dir: string) => string | undefined,
): JobRunner {
  return async (job: JobRecord) => {
    const bin = harnessBin(job.harnessDir);
    if (bin === undefined) {
      return { error: "no resolvable `crewhaus` CLI (harness node_modules/.bin, then PATH)" };
    }
    ensureRunDir(job.harnessDir);
    const logFile = runLogPath(job.harnessDir, job.jobId.replace(/^job_/, "run_"));
    const child = ops.spawn({
      argv: [bin, ...job.argv],
      cwd: job.harnessDir,
      env: mergedSpawnEnv(process.env, job.harnessDir).env as Record<string, string>,
      stdio: { mode: "file", path: logFile },
      detached: false,
    });
    const { code } = await child.exited;
    return { exitCode: code ?? 1 };
  };
}

export function createProcessLayer(options: ProcessLayerOptions): ProcessLayer {
  const clock = options.clock ?? systemClock;
  const ops = options.ops ?? createProcessOps();
  const ports = options.ports ?? createPortLedger({ now: options.now });
  const handles = new Map<string, HarnessProcess>();

  const jobs = createJobQueue({
    store: options.jobStore ?? createFileJobStore(`${options.hangarRoot}/jobs.jsonl`),
    run: options.runJob ?? defaultJobRunner(ops, (dir) => resolveCrewhausBin(dir)),
    now: options.now,
    ...(options.jobConcurrency !== undefined ? { concurrency: options.jobConcurrency } : {}),
  });

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
      plan,
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
    jobs,
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
