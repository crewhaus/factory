/**
 * Hangar M2 — the `crewhaus daemon` verb family: start, stop, restart,
 * inspect, tail, wake, and drain a supervised harness from the terminal.
 *
 * ONE STATE TREE, TWO HEADS. These verbs drive
 * `@crewhaus/harness-supervisor` DIRECTLY — never the manager server — so
 * they work with no console running, and so nothing that the console can do
 * is unavailable to a shell script. That is only safe because all
 * supervision state is harness-local (`<harness>/.crewhaus/run/`): the
 * runfile is the singleton lock whoever wrote it, the ledger is
 * append-only, and the log pump resumes from a byte-exact cursor. A daemon
 * this command starts is adopted by the next console boot, and vice versa.
 *
 * The safety rules the server enforces apply here for the same reasons:
 *
 *   - preflight gates EVERY start, and missing channel secrets can never be
 *     forced (the compiled daemon exits 2 on exactly that set);
 *   - the preflight env is the SPAWN env (`buildSpawnEnv`: the harness
 *     `.env` chain UNDER `process.env`), never `process.env` alone;
 *   - `CREWHAUS_CONTROL_PORT` is stamped in the ENV as 0 and the daemon
 *     announces the real port on stdout — the token is NEVER in argv;
 *   - `logs` renders the SCRUBBED capture, never the raw
 *     `logs/<runId>.log`, which is unscrubbed by construction.
 *
 * Factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Side-effect-free on import, mirroring `hangar-cmd.ts`: every function
 * takes injected env/clock/process-ops seams and returns lines + an exit
 * code. Bad arguments throw plain `Error`s; the entry file routes them
 * through `die()`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type ControlLane,
  type ControlResult,
  createControlClient,
  harnessScrubber,
  isControlLane,
  knownControlPort,
  mergedSpawnEnv,
  runDetail,
  runLogFile,
} from "@crewhaus/hangar-server";
import { readSpecHeader } from "@crewhaus/harness-inventory";
import { type HangarRegistry, openHangarRegistry } from "@crewhaus/harness-registry";
import {
  type Clock,
  type HarnessSupervisor,
  type ProcessOps,
  buildSpawnPlan,
  cliTwin,
  controlTokenPath,
  createHarnessSupervisor,
  createProcessOps,
  formatGateRefusal,
  readLogTail,
  readRunfile,
  recentRuns,
  resolveCrewhausBin,
  runClassFor,
  runPreflightGate,
  systemClock,
} from "@crewhaus/harness-supervisor";
import { cliVersion } from "./version";

/** What a verb returns: lines for stdout + the process exit code. */
export type DaemonCommandResult = {
  readonly lines: readonly string[];
  readonly exitCode: 0 | 1;
};

export type DaemonCommandOptions = {
  /** Environment the registry, the spawn env, and preflight consult.
   *  Injected by tests; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Clock (epoch ms + the timer seam the stop grace uses). */
  readonly clock?: Clock;
  /** Process ops; injected by tests so nothing is ever really spawned. */
  readonly ops?: ProcessOps;
  /** Working directory the bare (harness-less) form resolves against. */
  readonly cwd?: string;
  /** Line sink for `logs --follow`, which blocks; defaults to stdout. */
  readonly write?: (line: string) => void;
  /** `fetch` for the control.v1 calls; injected in tests. */
  readonly fetch?: typeof fetch;
};

const DAEMON_USAGE_LINES: readonly string[] = [
  "usage:",
  "  crewhaus daemon start [<dir|hrn_id>]        supervise this harness: preflight, then spawn",
  "       [--force] [--ack <id,id>]              --force waves through forceable blocking items;",
  "       [--no-preflight]                       --ack waves specific ones through by id. Missing",
  "                                              channel secrets can NEVER be forced.",
  "  crewhaus daemon stop [<dir|hrn_id>]         SIGTERM, then SIGKILL after a 15 s grace",
  "  crewhaus daemon restart [<dir|hrn_id>]      stop, then start (the plan is rebuilt, so a",
  "                                              recompile between the two is picked up)",
  "  crewhaus daemon status [<dir|hrn_id>]       runfile / liveness / control port / recent runs",
  "       [--json]",
  "  crewhaus daemon logs [<dir|hrn_id>]         the SCRUBBED captured output of a run",
  "       [--tail N] [--follow] [--run <run_id>]",
  "  crewhaus daemon wake [<dir|hrn_id>]         one synthetic tick down the daemon's OWN timer",
  "       --lane heartbeat|schedule [--reason R] path, via crewhaus.control.v1",
  "  crewhaus daemon drain [<dir|hrn_id>]        stop intake, finish in-flight work, exit 0",
  "",
  "  With no <dir|hrn_id>, the harness is the current directory (the standalone-",
  "  harness convention). These verbs drive the supervisor DIRECTLY, so they work",
  "  with no Hangar console running — and a daemon started either way is adopted",
  "  by the other. All state is harness-local, under .crewhaus/run/.",
];

// ---------------------------------------------------------------------------
// Tiny per-verb flag parsing (hangar-cmd posture: throw plain Errors)
// ---------------------------------------------------------------------------

type VerbFlagSpec = Readonly<Record<string, "value" | "boolean">>;

type VerbArgs = {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
};

function parseVerbArgs(verb: string, argv: readonly string[], spec: VerbFlagSpec): VerbArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const kind = spec[name];
      if (kind === undefined) {
        const known = Object.keys(spec).map((k) => `--${k}`);
        throw new Error(
          `daemon ${verb}: unknown flag "${a}"${known.length > 0 ? ` (expected: ${known.join(", ")})` : ""}`,
        );
      }
      if (kind === "value") {
        const v = argv[i + 1];
        if (v === undefined) throw new Error(`daemon ${verb}: ${a} requires a value`);
        flags.set(name, v);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Resolving the harness
// ---------------------------------------------------------------------------

export type ResolvedHarness = {
  readonly dir: string;
  readonly target: string;
  readonly specName: string;
};

function openRegistrySafe(opts: DaemonCommandOptions): HangarRegistry | undefined {
  try {
    return openHangarRegistry({ ...(opts.env !== undefined ? { env: opts.env } : {}) });
  } catch {
    return undefined;
  }
}

/**
 * Resolve `[<dir|hrn_id>]` to a harness. A bare verb means the CURRENT
 * DIRECTORY — the standalone-harness convention every other cwd-relative
 * verb follows — and an `hrn_` id (or a registered dir) resolves through
 * the registry so the two heads name harnesses the same way.
 */
export function resolveHarness(
  ref: string | undefined,
  opts: DaemonCommandOptions,
): ResolvedHarness {
  const cwd = opts.cwd ?? process.cwd();
  let dir: string;
  if (ref === undefined || ref === "") {
    dir = resolve(cwd);
  } else if (ref.startsWith("hrn_")) {
    const entry = openRegistrySafe(opts)?.get(ref);
    if (entry === undefined) {
      throw new Error(`no registered harness matches "${ref}" — see \`crewhaus harness list\``);
    }
    dir = entry.dir;
  } else {
    dir = resolve(cwd, ref);
  }
  const specPath = join(dir, "crewhaus.yaml");
  if (!existsSync(specPath)) {
    throw new Error(
      `${dir} is not a harness — no crewhaus.yaml here (run this from inside the harness, or pass a dir/hrn_ id)`,
    );
  }
  let header: { name?: string; target?: string } = {};
  try {
    header = readSpecHeader(readFileSync(specPath, "utf8"));
  } catch {
    header = {};
  }
  return {
    dir,
    target: header.target ?? "cli",
    specName: header.name ?? dir.split("/").filter(Boolean).at(-1) ?? dir,
  };
}

// ---------------------------------------------------------------------------
// The supervisor
// ---------------------------------------------------------------------------

/** Build a supervisor for one harness with the CLI's own seams. The plan is
 *  a closure, not a value: it is rebuilt on every start so a recompile
 *  between two starts is picked up. */
export function supervisorFor(
  harness: ResolvedHarness,
  opts: DaemonCommandOptions,
  gate: { readonly enabled: boolean; readonly force?: boolean; readonly acknowledge?: string[] },
): HarnessSupervisor {
  const env = opts.env ?? process.env;
  return createHarnessSupervisor({
    harnessDir: harness.dir,
    target: harness.target,
    ops: opts.ops ?? createProcessOps(),
    clock: opts.clock ?? systemClock,
    managerVersion: cliVersion() ?? "0.0.0",
    plan: () =>
      buildSpawnPlan({
        harnessDir: harness.dir,
        target: harness.target,
        processEnv: env,
        crewhausBin: resolveCrewhausBin(harness.dir),
        // Kernel-assigned; the daemon announces the real port on stdout.
        ports: { controlPort: 0 },
        // The PATH only. A token in argv is readable by every process here.
        controlTokenPath: controlTokenPath(harness.dir),
      }),
    ...(gate.enabled
      ? {
          gate: (gateOptions) =>
            runPreflightGate({
              harnessDir: harness.dir,
              // The env the SPAWN receives, not process.env: checking a
              // different record is how "passed preflight, died on a
              // missing key" happens.
              env: mergedSpawnEnv(env, harness.dir).env,
              ...gateOptions,
              ...(gate.force === true ? { force: true } : {}),
              ...(gate.acknowledge !== undefined ? { acknowledge: gate.acknowledge } : {}),
            }),
        }
      : {}),
  });
}

/** The control.v1 target for a harness, from its runfile. */
function controlTargetFor(harness: ResolvedHarness): {
  harnessDir: string;
  controlPort: number | undefined;
} {
  // `knownControlPort` because the runfile records the plan's request (0 =
  // "kernel, pick one") until the daemon announces the real number.
  return {
    harnessDir: harness.dir,
    controlPort: knownControlPort(readRunfile(harness.dir)?.controlPort),
  };
}

/** Render a control refusal as the operator-facing line + exit code. */
function controlLines(
  result: ControlResult<unknown>,
  ok: (body: unknown) => string[],
): DaemonCommandResult {
  if (result.ok) return { lines: ok(result.body), exitCode: 0 };
  const lines = [`${result.code}: ${result.reason}`];
  if (result.retryable) lines.push("  this one is retryable — try again in a moment");
  // An expected refusal (no control port, lane not armed, draining) is a
  // FACT about the bundle, not a failure of the command.
  return { lines, exitCode: result.expected ? 0 : 1 };
}

// ---------------------------------------------------------------------------
// start / restart
// ---------------------------------------------------------------------------

async function daemonStart(
  argv: readonly string[],
  opts: DaemonCommandOptions,
  restart: boolean,
): Promise<DaemonCommandResult> {
  const verb = restart ? "restart" : "start";
  const args = parseVerbArgs(verb, argv, {
    force: "boolean",
    ack: "value",
    "no-preflight": "boolean",
  });
  const harness = resolveHarness(args.positional[0], opts);
  const ackFlag = args.flags.get("ack");
  const acknowledge =
    typeof ackFlag === "string"
      ? ackFlag
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : undefined;
  const supervisor = supervisorFor(harness, opts, {
    enabled: args.flags.get("no-preflight") !== true,
    force: args.flags.get("force") === true,
    ...(acknowledge !== undefined ? { acknowledge } : {}),
  });
  try {
    // A restart from the terminal is by construction a restart of a daemon
    // THIS process did not spawn, so it has to adopt off the runfile first:
    // a supervisor with no pid stops nothing, leaves the runfile in place,
    // and then refuses its own start with "already running".
    if (restart) await supervisor.adopt();
    const result = restart ? await supervisor.restart() : await supervisor.start();
    if (result.ok) {
      const plan = supervisor.snapshot();
      return {
        lines: [
          `${harness.specName}: ${restart ? "restarted" : "started"} ${result.runId}${
            result.pid !== undefined ? ` (pid ${result.pid})` : ""
          }`,
          `  class ${runClassFor(harness.target)} · state ${plan.state}`,
          `  logs: crewhaus daemon logs ${harness.dir} --run ${result.runId}`,
        ],
        exitCode: 0,
      };
    }
    switch (result.reason) {
      case "already-running":
        return {
          lines: [
            `${harness.specName}: already running${
              result.runfile !== undefined
                ? ` (pid ${result.runfile.pid}, run ${result.runfile.runId})`
                : ""
            } — the runfile is the lock`,
          ],
          exitCode: 1,
        };
      case "preflight-blocked":
        return {
          lines: [
            ...formatGateRefusal(result.gate),
            "",
            "  re-run with --force to wave through the forceable items,",
            "  or --ack <id,id> to wave specific ones through by id.",
          ],
          exitCode: 1,
        };
      case "plan-failed":
        return { lines: [`${harness.specName}: ${result.error.message}`], exitCode: 1 };
    }
  } finally {
    supervisor.close();
  }
}

// ---------------------------------------------------------------------------
// stop / drain
// ---------------------------------------------------------------------------

async function daemonStop(
  argv: readonly string[],
  opts: DaemonCommandOptions,
): Promise<DaemonCommandResult> {
  const args = parseVerbArgs("stop", argv, { grace: "value" });
  const harness = resolveHarness(args.positional[0], opts);
  const supervisor = supervisorFor(harness, opts, { enabled: false });
  try {
    // Adopt first: a daemon this process did not spawn is exactly the case
    // `stop` exists for, and without adoption there is no pid to signal.
    const adopted = await supervisor.adopt();
    if (adopted === "none") {
      return { lines: [`${harness.specName}: not running (no runfile)`], exitCode: 0 };
    }
    if (adopted === "lost") {
      return {
        lines: [`${harness.specName}: the recorded daemon is gone — the stale runfile was cleared`],
        exitCode: 0,
      };
    }
    const graceFlag = args.flags.get("grace");
    const graceMs = typeof graceFlag === "string" ? Number(graceFlag) : undefined;
    if (graceMs !== undefined && (!Number.isFinite(graceMs) || graceMs < 0)) {
      throw new Error("daemon stop: --grace must be a non-negative number of ms");
    }
    const result = await supervisor.stop(graceMs !== undefined ? { graceMs } : {});
    return {
      lines: [
        `${harness.specName}: stopped${result.forced ? " (SIGKILL — it ignored SIGTERM)" : ""}`,
      ],
      exitCode: 0,
    };
  } finally {
    supervisor.close();
  }
}

async function daemonDrain(
  argv: readonly string[],
  opts: DaemonCommandOptions,
): Promise<DaemonCommandResult> {
  const args = parseVerbArgs("drain", argv, {});
  const harness = resolveHarness(args.positional[0], opts);
  const control = createControlClient(opts.fetch !== undefined ? { fetch: opts.fetch } : {});
  const supervisor = supervisorFor(harness, opts, { enabled: false });
  try {
    const adopted = await supervisor.adopt();
    if (adopted !== "adopted") {
      return { lines: [`${harness.specName}: not running`], exitCode: 0 };
    }
    let outcome: ControlResult<unknown> | undefined;
    const result = await supervisor.drain(async () => {
      outcome = await control.drain(controlTargetFor(harness));
      if (!outcome.ok) throw new Error(outcome.reason);
    });
    const viaSignal = outcome === undefined || !outcome.ok;
    const lines = [
      `${harness.specName}: ${viaSignal ? "stopped (SIGTERM)" : "drained"}${
        result.forced ? " — forced" : ""
      }`,
    ];
    if (viaSignal && outcome !== undefined && !outcome.ok) {
      // Honest about the degradation: this was not a graceful drain.
      lines.push(`  control.v1 unavailable (${outcome.code}): ${outcome.reason}`);
    }
    return { lines, exitCode: 0 };
  } finally {
    supervisor.close();
  }
}

// ---------------------------------------------------------------------------
// wake
// ---------------------------------------------------------------------------

async function daemonWake(
  argv: readonly string[],
  opts: DaemonCommandOptions,
): Promise<DaemonCommandResult> {
  const args = parseVerbArgs("wake", argv, { lane: "value", reason: "value" });
  const harness = resolveHarness(args.positional[0], opts);
  const laneFlag = args.flags.get("lane");
  if (typeof laneFlag !== "string" || !isControlLane(laneFlag)) {
    throw new Error("daemon wake: --lane must be heartbeat or schedule");
  }
  const lane: ControlLane = laneFlag;
  const reasonFlag = args.flags.get("reason");
  const control = createControlClient(opts.fetch !== undefined ? { fetch: opts.fetch } : {});
  const result = await control.wake(controlTargetFor(harness), {
    lane,
    ...(typeof reasonFlag === "string" ? { reason: reasonFlag } : {}),
    by: "crewhaus daemon wake",
  });
  return controlLines(result, (body) => {
    const wake = body as { sessionId?: string };
    return [
      `${harness.specName}: ${lane} tick accepted${
        wake.sessionId !== undefined ? ` (session ${wake.sessionId})` : ""
      }`,
      "  the tick runs down the daemon's OWN timer path — the same code the schedule fires",
    ];
  });
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function daemonStatus(argv: readonly string[], opts: DaemonCommandOptions): DaemonCommandResult {
  const args = parseVerbArgs("status", argv, { json: "boolean" });
  const harness = resolveHarness(args.positional[0], opts);
  const ops = opts.ops ?? createProcessOps();
  const runfile = readRunfile(harness.dir);
  const alive = runfile !== undefined && ops.isAlive(runfile.pid);
  const runs = recentRuns(harness.dir, 5).reverse();
  const runClass = runClassFor(harness.target);
  const controlPort = knownControlPort(runfile?.controlPort);

  let plan: string | undefined;
  let planError: string | undefined;
  try {
    plan = cliTwin(
      buildSpawnPlan({
        harnessDir: harness.dir,
        target: harness.target,
        processEnv: opts.env ?? process.env,
        crewhausBin: resolveCrewhausBin(harness.dir),
        ports: { controlPort: 0 },
        controlTokenPath: controlTokenPath(harness.dir),
      }),
    );
  } catch (err) {
    planError = err instanceof Error ? err.message : String(err);
  }

  if (args.flags.get("json") === true) {
    return {
      lines: JSON.stringify(
        {
          specName: harness.specName,
          dir: harness.dir,
          target: harness.target,
          runClass,
          running: alive,
          runfile: runfile ?? null,
          controlPort: controlPort ?? null,
          recentRuns: runs,
          plan: plan ?? null,
          planError: planError ?? null,
        },
        null,
        2,
      ).split("\n"),
      exitCode: 0,
    };
  }

  const lines: string[] = [];
  if (runfile === undefined) {
    lines.push(`${harness.specName}: not running (no runfile) · class ${runClass}`);
  } else if (alive) {
    lines.push(
      `${harness.specName}: running · pid ${runfile.pid} · run ${runfile.runId} · since ${runfile.startedAt}`,
    );
    lines.push(
      controlPort !== undefined
        ? `  control: crewhaus.control.v1 on 127.0.0.1:${controlPort}`
        : "  control: none recorded — wake/drain unavailable (pre-0.5.0 bundle, or it has not announced yet)",
    );
  } else {
    // A runfile whose pid is gone: the record of a daemon that died while
    // nothing was watching. Reported, not silently swallowed.
    lines.push(
      `${harness.specName}: NOT running, but a runfile remains (pid ${runfile.pid} is gone) — the next start clears it`,
    );
  }
  if (runs.length > 0) {
    lines.push("  recent runs:");
    for (const run of runs) {
      lines.push(
        `    ${run.runId}  ${run.kind}  ${run.startedAt}${
          run.endedAt !== undefined
            ? ` → ${run.endedAt}${run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ""}`
            : " (open)"
        }${run.forced === true ? " [forced]" : ""}`,
      );
    }
  }
  lines.push(planError !== undefined ? `  plan: ${planError}` : `  would run: ${plan}`);
  return { lines, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

const DEFAULT_LOG_TAIL = 40;
const FOLLOW_POLL_MS = 500;

async function daemonLogs(
  argv: readonly string[],
  opts: DaemonCommandOptions,
): Promise<DaemonCommandResult> {
  const args = parseVerbArgs("logs", argv, { tail: "value", follow: "boolean", run: "value" });
  const harness = resolveHarness(args.positional[0], opts);
  const tailFlag = args.flags.get("tail");
  const tail = typeof tailFlag === "string" ? Number(tailFlag) : DEFAULT_LOG_TAIL;
  if (!Number.isInteger(tail) || tail <= 0) {
    throw new Error(`daemon logs: --tail must be a positive integer (got "${String(tailFlag)}")`);
  }
  const runFlag = args.flags.get("run");
  const runId =
    typeof runFlag === "string"
      ? runFlag
      : (readRunfile(harness.dir)?.runId ?? latestRun(harness.dir));
  if (runId === undefined) {
    return { lines: [`${harness.specName}: no runs recorded yet`], exitCode: 0 };
  }
  const detail = runDetail(harness.dir, runId, { maxEvents: tail });
  if (detail === undefined) {
    return { lines: [`${harness.specName}: no such run "${runId}"`], exitCode: 1 };
  }
  const logFile = runLogFile(harness.dir, runId);
  // NEVER the raw file: `logs/<runId>.log` is unscrubbed by construction,
  // and the scrubber is what turns the harness's own credential values into
  // «NAME» before a byte leaves this process.
  const scrub = harnessScrubber(harness.dir);
  const render = (): string[] =>
    logFile === undefined ? [] : readLogTail(logFile, scrub, 512 * 1024).slice(-tail);

  if (args.flags.get("follow") !== true) {
    return { lines: [`— ${runId} —`, ...render()], exitCode: 0 };
  }

  // Follow: poll the scrubbed tail and emit only what is new, until the run
  // closes or the operator interrupts. No timer seam here on purpose —
  // `--follow` blocks by definition and is never exercised by a unit test.
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const ops = opts.ops ?? createProcessOps();
  write(`— ${runId} (following; Ctrl-C to stop) —`);
  let emitted = 0;
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
  };
  process.once("SIGINT", onSigint);
  try {
    for (;;) {
      const all = logFile === undefined ? [] : readLogTail(logFile, scrub, 4 * 1024 * 1024);
      for (const line of all.slice(emitted)) write(line);
      emitted = all.length;
      if (interrupted) break;
      const rf = readRunfile(harness.dir);
      if (rf === undefined || !ops.isAlive(rf.pid)) break;
      await new Promise<void>((r) => setTimeout(r, FOLLOW_POLL_MS));
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
  return { lines: [], exitCode: 0 };
}

/** The newest run in the ledger, when no runfile names one. */
function latestRun(harnessDir: string): string | undefined {
  const runs = recentRuns(harnessDir, 1);
  return runs[0]?.runId;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export const DAEMON_VERBS = [
  "start",
  "stop",
  "restart",
  "status",
  "logs",
  "wake",
  "drain",
] as const;

/** Run `crewhaus daemon <verb> …`. Bad arguments throw plain `Error`s (the
 *  entry file routes them through `die()`); everything else returns lines +
 *  an exit code. */
export async function runDaemonCommand(
  argv: readonly string[],
  opts: DaemonCommandOptions = {},
): Promise<DaemonCommandResult> {
  const verb = argv[0] ?? "";
  if (verb === "" || verb === "--help" || verb === "-h") {
    return { lines: DAEMON_USAGE_LINES, exitCode: 0 };
  }
  const rest = argv.slice(1);
  switch (verb) {
    case "start":
      return await daemonStart(rest, opts, false);
    case "restart":
      return await daemonStart(rest, opts, true);
    case "stop":
      return await daemonStop(rest, opts);
    case "drain":
      return await daemonDrain(rest, opts);
    case "wake":
      return await daemonWake(rest, opts);
    case "status":
      return daemonStatus(rest, opts);
    case "logs":
      return await daemonLogs(rest, opts);
    default:
      throw new Error(`unknown daemon verb "${verb}" (expected: ${DAEMON_VERBS.join(" | ")})`);
  }
}
