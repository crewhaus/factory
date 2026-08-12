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
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
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
  MANAGER_HOOK_NAMES,
  type ProcessOps,
  buildSpawnPlan,
  bundleStaleness,
  cliTwin,
  controlTokenPath,
  createHarnessSupervisor,
  createPrepareRunner,
  createProcessOps,
  formatGateRefusal,
  formatPrepareRefusal,
  loadEnvChain,
  readHookRunLog,
  readLogTail,
  readManagerSettings,
  readRunfile,
  readsBriefOnStdin,
  recentRuns,
  resolveCrewhausBin,
  runClassFor,
  runPreflightGate,
  systemClock,
} from "@crewhaus/harness-supervisor";
import { readBundleSpecStamp } from "./bundle-manifest";
import { envChainLines } from "./env-chain-view";
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
  /** Poll interval for `logs --follow`; a seam so a test can drive several
   *  polls without sleeping a wall-clock second per line. */
  readonly followPollMs?: number;
  /** `fetch` for the control.v1 calls; injected in tests. */
  readonly fetch?: typeof fetch;
};

const DAEMON_USAGE_LINES: readonly string[] = [
  "usage:",
  "  crewhaus daemon start [<dir|hrn_id>]        supervise this harness: preflight, then spawn",
  "       [--force] [--ack <id,id>]              --force waves through forceable blocking items;",
  "       [--no-preflight]                       --ack waves specific ones through by id. Missing",
  "       [--compile] [--no-compile]             channel secrets can NEVER be forced. --compile",
  "                                              recompiles first IF the spec is newer than the",
  "                                              bundle (default: manager.autoCompile).",
  "  crewhaus daemon submit [<dir|hrn_id>]       run ONE pipeline with a brief on stdin — the",
  "       --brief-file <path>                    supervised path for crew, whose input is a",
  "       [--force] [--ack <id,id>]              document. Tracked in the run ledger like any",
  "       [--no-preflight] [--compile]           job, and NEVER restarted.",
  "  crewhaus daemon stop [<dir|hrn_id>]         SIGTERM, then SIGKILL after a 15 s grace",
  "  crewhaus daemon restart [<dir|hrn_id>]      stop, then start (the plan is rebuilt, so a",
  "       [--compile] [--no-compile]             recompile between the two is picked up)",
  "  crewhaus daemon status [<dir|hrn_id>]       runfile / liveness / control port / recent runs",
  "       [--json]",
  "  crewhaus daemon logs [<dir|hrn_id>]         the SCRUBBED captured output of a run",
  "       [--tail N] [--follow] [--run <run_id>]",
  "  crewhaus daemon wake [<dir|hrn_id>]         one synthetic tick down the daemon's OWN timer",
  "       --lane heartbeat|schedule [--reason R] path, via crewhaus.control.v1",
  "  crewhaus daemon drain [<dir|hrn_id>]        stop intake, finish in-flight work, exit 0",
  "",
  "",
  "  Per-harness prep lives in <harness>/.crewhaus/settings.json under `manager`:",
  "  `autoCompile: true` makes every start recompile a stale bundle, and",
  "  `hooks.postCompile` / `hooks.preSpawn` run an operator step between compile",
  "  and spawn. A hook that exits non-zero refuses the start, like preflight.",
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
  prep: { readonly compile?: boolean } = {},
  run: { readonly briefFile?: string } = {},
): HarnessSupervisor {
  const env = opts.env ?? process.env;
  const ops = opts.ops ?? createProcessOps();
  return createHarnessSupervisor({
    harnessDir: harness.dir,
    target: harness.target,
    ops,
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
        // A crew brief, as a PATH: never in argv, and readable by the child
        // for as long as it needs it.
        ...(run.briefFile !== undefined ? { briefFile: run.briefFile } : {}),
      }),
    // Built per start, like the plan: `.crewhaus/settings.json` is edited
    // between starts exactly as the spec is.
    prepare: () =>
      createPrepareRunner({
        harnessDir: harness.dir,
        target: harness.target,
        ops,
        // The env the SPAWN receives — a prep step patching the bundle needs
        // the same credentials the daemon will run with, which is what the
        // `run.sh` wrapper it replaces has today.
        env: mergedSpawnEnv(env, harness.dir).env as Record<string, string>,
        crewhausBin: resolveCrewhausBin(harness.dir),
        ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
        ...(prep.compile !== undefined ? { compile: prep.compile } : {}),
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

type ControlTarget = { harnessDir: string; controlPort: number | undefined };

/** The control.v1 target for a harness, from its runfile. */
function controlTargetFor(harness: ResolvedHarness): ControlTarget {
  // `knownControlPort` because the runfile records the plan's request (0 =
  // "kernel, pick one") until the daemon announces the real number.
  return {
    harnessDir: harness.dir,
    controlPort: knownControlPort(readRunfile(harness.dir)?.controlPort),
  };
}

/**
 * Pump the run log once so the announced control port lands in the runfile,
 * then re-read it.
 *
 * The plan asks the kernel for a port (`CREWHAUS_CONTROL_PORT=0`) and the
 * daemon prints the real number on stdout; the supervisor captures that line
 * while draining the log and patches it into the runfile. A head that never
 * pumps therefore never learns the port — and `daemon start` exits long
 * before the announcement lands, so on the CLI-only path the runfile would
 * hold `0` forever and wake/drain would refuse with `no_control_port`
 * permanently. Pumping once here is what makes the terminal head reach a
 * daemon it started itself, with no console ever running.
 *
 * Only ever called against a LIVE runfile: adopting a stale one clears it,
 * and a read verb must not delete state out from under `daemon status`.
 */
function pumpForControlPort(
  harness: ResolvedHarness,
  supervisor: HarnessSupervisor,
): ControlTarget {
  supervisor.pumpNow();
  return controlTargetFor(harness);
}

/** crewhaus releases from this one on emit a control plane into daemon
 *  bundles; anything older cannot answer wake/drain however it is started. */
const CONTROL_V1_SINCE = "0.5.0";

/** Dotted numeric compare; a pre-release suffix rides with its release
 *  (`0.5.0-rc.1` already carries the control plane). */
function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] =>
    (v.split("-")[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < 3; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Can this harness's compiled bundle speak control.v1 at all?
 *
 * The bundle manifest's provenance stamp is the fact: `compiledWith` names
 * the release whose emitters produced it, and an UNSTAMPED bundle is one no
 * stamping crewhaus ever wrote — older than the control plane by
 * construction. Guessing instead is how an operator gets told to recompile a
 * bundle that is already current and has simply not booted far enough.
 */
function bundleSpeaksControlV1(harnessDir: string): {
  readonly speaks: boolean;
  readonly compiledWith: string | undefined;
} {
  for (const dir of ["dist", "build"]) {
    const stamp = readBundleSpecStamp(join(harnessDir, dir));
    if (stamp === undefined) continue;
    const compiledWith = stamp.compiledWith;
    if (compiledWith === undefined) return { speaks: false, compiledWith: undefined };
    return {
      speaks: compareVersions(compiledWith, CONTROL_V1_SINCE) >= 0,
      compiledWith,
    };
  }
  return { speaks: false, compiledWith: undefined };
}

/**
 * Why this harness has no control port, said precisely.
 *
 * "Recompile" is only true advice when the bundle really does predate
 * control.v1. Telling an operator to recompile a current bundle that has
 * simply not announced yet sends them down a road that changes nothing —
 * which is exactly what the single mushed sentence used to do.
 */
function noControlPortReason(harness: ResolvedHarness): string {
  const bundle = bundleSpeaksControlV1(harness.dir);
  if (bundle.speaks) {
    return "no control port recorded yet — the daemon binds one at boot and announces it on stdout; try again in a moment";
  }
  const provenance =
    bundle.compiledWith !== undefined
      ? `compiled with ${bundle.compiledWith}`
      : "the bundle carries no provenance stamp";
  return `this bundle predates crewhaus.control.v1 (${provenance}) — recompile it with \`crewhaus compile\` to enable wake/drain`;
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
    compile: "boolean",
    "no-compile": "boolean",
  });
  if (args.flags.get("compile") === true && args.flags.get("no-compile") === true) {
    throw new Error(`daemon ${verb}: --compile and --no-compile are mutually exclusive`);
  }
  const harness = resolveHarness(args.positional[0], opts);
  const ackFlag = args.flags.get("ack");
  const acknowledge =
    typeof ackFlag === "string"
      ? ackFlag
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : undefined;
  const supervisor = supervisorFor(
    harness,
    opts,
    {
      enabled: args.flags.get("no-preflight") !== true,
      force: args.flags.get("force") === true,
      ...(acknowledge !== undefined ? { acknowledge } : {}),
    },
    // Neither flag ⇒ the harness's own `manager.autoCompile` decides, so the
    // console's Restart button and this verb agree without a flag.
    args.flags.get("compile") === true
      ? { compile: true }
      : args.flags.get("no-compile") === true
        ? { compile: false }
        : {},
  );
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
          // An operator who asked for a recompile is told it happened —
          // "nothing recompiled and nobody said so" is the failure this
          // whole path exists to end.
          ...(result.prepared ?? []).map((note) => `  ${note}`),
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
      case "prepare-refused":
        return {
          lines: [`${harness.specName}:`, ...formatPrepareRefusal(result.refusal)],
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
// submit — one crew pipeline, with a brief
// ---------------------------------------------------------------------------

/**
 * `crewhaus daemon submit <dir> --brief-file brief.md`
 *
 * The supervised path for the shapes whose INPUT is a document. Crew is the
 * motivating one: its compiled bundle reads a brief on stdin and exits 2
 * without one, so `daemon start` — which spawns detached with no stdin —
 * could only ever produce an instant exit, and 2 is not in the terminal
 * code set, so the supervisor walked the backoff ladder into
 * `crash-looping`. A crew harness was effectively unsupervisable, and the
 * remedy in every fleet README was "do not daemon start this one".
 *
 * A submit is a JOB, not a daemon: one run, tracked in the same run ledger
 * with the same scrubbed log capture, and NEVER restarted. That is what
 * matches how crews are actually used — on demand, per piece.
 */
async function daemonSubmit(
  argv: readonly string[],
  opts: DaemonCommandOptions,
): Promise<DaemonCommandResult> {
  const args = parseVerbArgs("submit", argv, {
    "brief-file": "value",
    "no-preflight": "boolean",
    force: "boolean",
    ack: "value",
    compile: "boolean",
    "no-compile": "boolean",
  });
  const harness = resolveHarness(args.positional[0], opts);
  if (!readsBriefOnStdin(harness.target)) {
    // Only the brief-taking shapes have an input document. Saying which verb
    // this harness DOES take is more useful than "unsupported".
    throw new Error(
      `daemon submit: ${harness.specName} is a ${harness.target} harness, whose input is not a brief on stdin — use \`crewhaus daemon start\` (class ${runClassFor(harness.target)})`,
    );
  }
  const briefFlag = args.flags.get("brief-file");
  if (typeof briefFlag !== "string") {
    throw new Error(
      "daemon submit: --brief-file <path> is required — the brief is the run's input",
    );
  }
  // Resolved against the CALLER's cwd, not the harness: an operator submits
  // a brief they are looking at, which is rarely inside the harness.
  const briefFile = resolve(opts.cwd ?? process.cwd(), briefFlag);
  if (!existsSync(briefFile)) {
    throw new Error(`daemon submit: no brief at ${briefFile}`);
  }
  if (statSync(briefFile).size === 0) {
    // The bundle would exit 2 on an empty brief exactly as it does on none;
    // saying so here is one round trip shorter than reading the log.
    throw new Error(`daemon submit: ${briefFile} is empty — a crew brief must have content`);
  }
  const ackFlag = args.flags.get("ack");
  const supervisor = supervisorFor(
    harness,
    opts,
    {
      enabled: args.flags.get("no-preflight") !== true,
      force: args.flags.get("force") === true,
      ...(typeof ackFlag === "string"
        ? {
            acknowledge: ackFlag
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s !== ""),
          }
        : {}),
    },
    args.flags.get("compile") === true
      ? { compile: true }
      : args.flags.get("no-compile") === true
        ? { compile: false }
        : {},
    { briefFile },
  );
  try {
    const result = await supervisor.start();
    if (result.ok) {
      return {
        lines: [
          `${harness.specName}: submitted ${result.runId}${
            result.pid !== undefined ? ` (pid ${result.pid})` : ""
          }`,
          ...(result.prepared ?? []).map((note) => `  ${note}`),
          `  brief: ${briefFile}`,
          `  class ${runClassFor(harness.target)} — one run, never restarted`,
          `  logs: crewhaus daemon logs ${harness.dir} --run ${result.runId}`,
        ],
        exitCode: 0,
      };
    }
    switch (result.reason) {
      case "already-running":
        return {
          lines: [`${harness.specName}: a run is already in flight for this harness`],
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
      case "prepare-refused":
        return {
          lines: [`${harness.specName}:`, ...formatPrepareRefusal(result.refusal)],
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
    if (!result.stopped) {
      // A live daemon holds the runfile that this supervisor never adopted,
      // so nothing was signalled. Reporting "stopped" here would walk an
      // operator away from a channel bot that is still answering.
      return {
        lines: [
          `${harness.specName}: NOT stopped — a live daemon${
            result.runfile !== undefined ? ` (pid ${result.runfile.pid})` : ""
          } holds the runfile but was not adopted; nothing was signalled`,
        ],
        exitCode: 1,
      };
    }
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
    // Adopting attaches the pump; draining it once is what turns the
    // daemon's stdout announcement into a control port we can dial. Without
    // it the graceful drain this verb exists for silently degrades to
    // SIGTERM against a daemon that was listening the whole time.
    const target = pumpForControlPort(harness, supervisor);
    let outcome: ControlResult<unknown> | undefined;
    const result = await supervisor.drain(async () => {
      outcome = await control.drain(target);
      if (!outcome.ok) throw new Error(outcome.reason);
    });
    if (!result.stopped) {
      return {
        lines: [
          `${harness.specName}: NOT drained — a live daemon${
            result.runfile !== undefined ? ` (pid ${result.runfile.pid})` : ""
          } holds the runfile but was not adopted; nothing was signalled`,
        ],
        exitCode: 1,
      };
    }
    const viaSignal = outcome === undefined || !outcome.ok;
    const lines = [
      `${harness.specName}: ${viaSignal ? "stopped (SIGTERM)" : "drained"}${
        result.forced ? " — forced" : ""
      }`,
    ];
    if (viaSignal && outcome !== undefined && !outcome.ok) {
      // Honest about the degradation: this was not a graceful drain — and
      // precise about WHY, because "no control port" has two very different
      // remedies and only one of them is a recompile.
      lines.push(
        `  control.v1 unavailable (${outcome.code}): ${
          outcome.code === "no_control_port" ? noControlPortReason(harness) : outcome.reason
        }`,
      );
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

  // Adopt + pump before giving up. The port is announced on the daemon's
  // stdout and only ever reaches the runfile through the log pump, so a head
  // that starts a daemon and exits can never see it without this — which is
  // what made `wake` refuse `no_control_port` FOREVER on the CLI-only path.
  let target = controlTargetFor(harness);
  if (target.controlPort === undefined) {
    const supervisor = supervisorFor(harness, opts, { enabled: false });
    try {
      const adopted = await supervisor.adopt();
      if (adopted === "none") {
        return { lines: [`${harness.specName}: not running (no runfile)`], exitCode: 0 };
      }
      if (adopted === "lost") {
        return {
          lines: [
            `${harness.specName}: the recorded daemon is gone — the stale runfile was cleared`,
          ],
          exitCode: 0,
        };
      }
      target = pumpForControlPort(harness, supervisor);
    } finally {
      supervisor.close();
    }
  }
  if (target.controlPort === undefined) {
    // Still nothing: say which of the two causes it is, because one is
    // "wait a moment" and the other is "recompile".
    return { lines: [`no_control_port: ${noControlPortReason(harness)}`], exitCode: 0 };
  }

  const result = await control.wake(target, {
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

async function daemonStatus(
  argv: readonly string[],
  opts: DaemonCommandOptions,
): Promise<DaemonCommandResult> {
  const args = parseVerbArgs("status", argv, { json: "boolean" });
  const harness = resolveHarness(args.positional[0], opts);
  const ops = opts.ops ?? createProcessOps();
  const runfile = readRunfile(harness.dir);
  const alive = runfile !== undefined && ops.isAlive(runfile.pid);
  const runs = recentRuns(harness.dir, 5).reverse();
  const runClass = runClassFor(harness.target);
  let controlPort = knownControlPort(runfile?.controlPort);
  // Same pump wake/drain do, so the three verbs agree about the port — but
  // only against a LIVE runfile: adopting a stale one clears it, and a read
  // verb must not delete the very record it is about to report.
  if (controlPort === undefined && alive) {
    const supervisor = supervisorFor(harness, opts, { enabled: false });
    try {
      if ((await supervisor.adopt()) === "adopted") {
        controlPort = pumpForControlPort(harness, supervisor).controlPort;
      }
    } finally {
      supervisor.close();
    }
  }

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
  // The chain is reported whether or not a plan could be built: "which env
  // files does this daemon read" is exactly the question an operator has
  // when a key resolves from a shared fleet file rather than a local one,
  // and a harness with no bundle yet still answers it.
  const envChain = loadEnvChain(harness.dir);
  const settings = readManagerSettings(harness.dir);
  const hookRuns = readHookRunLog(harness.dir);
  const freshness = bundleStaleness(harness.dir, harness.target);

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
          envFiles: envChain.refs,
          bundle: freshness,
          prep: {
            autoCompile: settings.autoCompile,
            hooks: Object.fromEntries(
              MANAGER_HOOK_NAMES.filter((name) => settings.hooks[name] !== undefined).map(
                (name) => [
                  name,
                  {
                    declaredAs: settings.hooks[name]?.declaredAs ?? "",
                    lastRun: hookRuns[name] ?? null,
                  },
                ],
              ),
            ),
          },
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
        : `  control: none recorded — ${noControlPortReason(harness)}`,
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
  lines.push(...envChainLines(envChain.refs));
  lines.push(...prepLines(settings, hookRuns, freshness));
  lines.push(planError !== undefined ? `  plan: ${planError}` : `  would run: ${plan}`);
  return { lines, exitCode: 0 };
}

/**
 * The prep contract, as `status` reports it: whether a start would
 * recompile, which hooks exist, and when each last ran.
 *
 * A hook that exists but has never fired is the state worth naming — that is
 * a harness whose operator believes prep is happening and whose daemon has
 * never had it. A hook whose recorded run names a DIFFERENT declaration than
 * the current one is named too: the record is of the command that ran, not
 * of the command that would run now.
 */
function prepLines(
  settings: ReturnType<typeof readManagerSettings>,
  hookRuns: ReturnType<typeof readHookRunLog>,
  freshness: ReturnType<typeof bundleStaleness>,
): string[] {
  const declared = MANAGER_HOOK_NAMES.filter((name) => settings.hooks[name] !== undefined);
  if (!settings.autoCompile && declared.length === 0) return [];
  const lines = ["  prep (.crewhaus/settings.json → manager):"];
  if (settings.autoCompile) {
    lines.push(`    autoCompile: on · bundle: ${freshness.label}`);
  }
  for (const name of declared) {
    const hook = settings.hooks[name];
    const run = hookRuns[name];
    const last =
      run === undefined
        ? "never run"
        : `last ${run.ok ? "ok" : `FAILED${run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ""}`} at ${run.at}${
            run.declaredAs !== hook?.declaredAs ? ` — as \`${run.declaredAs}\`, since edited` : ""
          }`;
    lines.push(`    ${name}: \`${hook?.declaredAs}\` · ${last}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

const DEFAULT_LOG_TAIL = 40;
const FOLLOW_POLL_MS = 500;
/** How far back `--tail N` may reach for its N lines. */
const LOG_TAIL_BUDGET_BYTES = 512 * 1024;

/**
 * A byte cursor over a run's captured log, for `--follow`.
 *
 * `readLogTail` answers "the last N lines", which is exactly wrong to poll:
 * driving `--follow` off it made the emitted count saturate at the window
 * size, so once a run outgrew N lines every later poll had nothing new to
 * slice and the command sat silent while the daemon kept writing. A byte
 * offset — the same cursor the supervisor's own pump keeps — cannot skip a
 * line however fast the run outruns the window.
 *
 * Reads are decoded through ONE streaming decoder so a multi-byte character
 * split across a poll boundary is held, not replaced; a torn final line is
 * held the same way and completed by the next read.
 */
function createLogFollower(logFile: string, scrub: (text: string) => string) {
  let offset = 0;
  let partial = "";
  let decoder = new TextDecoder("utf-8");

  const sizeNow = (): number | undefined => {
    try {
      return statSync(logFile).size;
    } catch {
      return undefined;
    }
  };

  const readRange = (from: number, to: number): Uint8Array => {
    const fd = openSync(logFile, "r");
    try {
      const buf = Buffer.alloc(to - from);
      const read = readSync(fd, buf, 0, to - from, from);
      return buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  };

  /** Complete lines out of `text`, scrubbed; the trailing fragment is held. */
  const complete = (text: string): string[] => {
    const parts = (partial + text).split("\n");
    partial = parts.pop() ?? "";
    const out: string[] = [];
    for (const raw of parts) {
      // Scrubbed per line: the scrubber is the read-side gate, and a
      // credential never spans a newline.
      const line = scrub(raw).trimEnd();
      if (line.trim() !== "") out.push(line);
    }
    return out;
  };

  return {
    /**
     * Seek to EOF, returning the last `lines` complete lines. Establishing
     * the cursor and rendering the opening window in ONE read is what makes
     * the handover exact: nothing written between the two can be duplicated
     * or dropped.
     */
    open(lines: number, maxBytes: number): string[] {
      const size = sizeNow();
      if (size === undefined) return [];
      const from = Math.max(0, size - maxBytes);
      const slice = readRange(from, size);
      // A window taken from the middle can start mid-character; drop the
      // leading continuation bytes rather than emit replacement characters.
      let start = 0;
      while (start < slice.length && ((slice[start] as number) & 0b1100_0000) === 0b1000_0000) {
        start++;
      }
      offset = size;
      const text = decoder.decode(slice.subarray(start), { stream: true });
      // …and it can start mid-LINE, which is not a line an operator should
      // read as one. Only ever drops the row straddling the budget edge.
      const body = from > 0 ? text.slice(text.indexOf("\n") + 1) : text;
      return complete(body).slice(-lines);
    },

    /** Every complete line written since the last call. */
    next(): string[] {
      const size = sizeNow();
      if (size === undefined) return [];
      if (size < offset) {
        // Truncated or rotated under us — re-read from the top rather than
        // seek past the end and go permanently silent.
        offset = 0;
        partial = "";
        decoder = new TextDecoder("utf-8");
      }
      if (size === offset) return [];
      const slice = readRange(offset, size);
      offset = size;
      return complete(decoder.decode(slice, { stream: true }));
    },
  };
}

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

  if (args.flags.get("follow") !== true) {
    // `tail` is the LINE count the operator asked for; the byte budget only
    // bounds how far back we may reach to find those lines.
    const lines =
      logFile === undefined ? [] : readLogTail(logFile, scrub, LOG_TAIL_BUDGET_BYTES, tail);
    return { lines: [`— ${runId} —`, ...lines.slice(-tail)], exitCode: 0 };
  }

  // Follow: open at the tail, then emit every line written after it, until
  // the run closes or the operator interrupts. The cursor is a BYTE offset,
  // not an index into a sliding window — see `createLogFollower`.
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const ops = opts.ops ?? createProcessOps();
  const pollMs = opts.followPollMs ?? FOLLOW_POLL_MS;
  write(`— ${runId} (following; Ctrl-C to stop) —`);
  const follower = logFile === undefined ? undefined : createLogFollower(logFile, scrub);
  for (const line of follower?.open(tail, LOG_TAIL_BUDGET_BYTES) ?? []) write(line);
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
  };
  process.once("SIGINT", onSigint);
  try {
    for (;;) {
      if (interrupted) break;
      const rf = readRunfile(harness.dir);
      const alive = rf !== undefined && ops.isAlive(rf.pid);
      // Read AFTER the liveness check on the last pass too: a daemon that
      // exits mid-poll still wrote its final lines, and dropping them is how
      // a crash's last words disappear.
      for (const line of follower?.next() ?? []) write(line);
      if (!alive) break;
      await new Promise<void>((r) => setTimeout(r, pollMs));
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
  "submit",
  "stop",
  "restart",
  "status",
  "logs",
  "wake",
  "drain",
] as const;

/**
 * HM-188 — lead the output with the win32 supervision notice.
 *
 * Only `start` and `restart` carry it, for two reasons. The failure the
 * notice names IS the start path: a wrong liveness verdict on Windows is
 * what lets a restart spawn a SECOND copy of a channel daemon (double
 * message processing, double provider spend). And the notice's own remedy is
 * "confirm with `crewhaus daemon status`" — printing it above `status` would
 * be circular, and above `status --json` it would corrupt the document a
 * caller is piping into `jq`.
 */
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
    case "submit":
      return await daemonSubmit(rest, opts);
    case "restart":
      return await daemonStart(rest, opts, true);
    case "stop":
      return await daemonStop(rest, opts);
    case "drain":
      return await daemonDrain(rest, opts);
    case "wake":
      return await daemonWake(rest, opts);
    case "status":
      return await daemonStatus(rest, opts);
    case "logs":
      return await daemonLogs(rest, opts);
    default:
      throw new Error(`unknown daemon verb "${verb}" (expected: ${DAEMON_VERBS.join(" | ")})`);
  }
}
