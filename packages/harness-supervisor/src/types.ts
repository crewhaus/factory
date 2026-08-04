/**
 * The vocabulary of the process layer: run classes, run kinds, supervision
 * states, the runfile, and the run-ledger entry.
 *
 * Two facts shape every type here:
 *
 *   1. **All harness state is cwd-local.** Ops state lives under
 *      `<harness>/.crewhaus/run/` — never in a central manager directory —
 *      so `state backup` / `retire` capture run history for free, and a
 *      harness copied to another machine carries its own history with it.
 *      The manager keeps only pointers.
 *   2. **A runfile is a claim, not a fact.** It records the pid, the OS
 *      process start time, and a fingerprint of the exact argv+cwd, so a
 *      reader can tell "this daemon is still running" from "some unrelated
 *      process inherited that pid". Restored/backed-up runfiles fail the
 *      start-time check and read as stale, harmlessly.
 */

/** Which supervision contract a compiled shape runs under. */
export type RunClass =
  /** cli, browser — attached, stdin-carrying REPL runs. */
  | "interactive"
  /** channel, managed, crew, voice — detached, singleton, restart-policied. */
  | "daemon"
  /** batch — an `agent.ts` entry with daemon-class supervision. */
  | "worker"
  /** workflow, graph, pipeline, research, eval, onchain(-game) — run to
   *  completion, tracked as jobs, NEVER restarted. */
  | "one-shot"
  /** `crewhaus serve --mcp` and `expose:` projections — port-tracked. */
  | "mcp-server"
  /** cf-worker emits — a deployment record, not a process. */
  | "serverless"
  /** claude-plugin emits — an inspector target, not a process. */
  | "export";

/** How a run is ledgered. Coarser than {@link RunClass} on purpose: the
 *  ledger answers "what kind of thing was this", the class answers "how is
 *  it supervised". */
export type RunKind = "daemon" | "interactive" | "job" | "mcp-server";

/**
 * The supervision state machine:
 *
 * ```
 * stopped → preflight → starting → running → (draining) →
 *   stopped | crashed | parked | terminal | crash-looping
 * ```
 *
 *   - `parked`        — exit 36, an approval is pending. NOT a failure.
 *   - `terminal`      — an exit class that must never auto-restart
 *                       (spec/config/auth/billing/budget).
 *   - `crash-looping` — the restart window was exhausted; manual start only,
 *                       with forensics attached.
 */
export type SupervisionState =
  | "stopped"
  | "preflight"
  | "starting"
  | "running"
  | "draining"
  | "crashed"
  | "parked"
  | "terminal"
  | "crash-looping";

/** Directory + file names under `<harness>/.crewhaus/run/`. */
export const RUN_DIR_SEGMENTS = [".crewhaus", "run"] as const;
export const RUNFILE_NAME = "daemon.json";
export const RUN_LEDGER_NAME = "runs.jsonl";
export const LOGS_DIR_NAME = "logs";
export const CONTROL_TOKEN_NAME = "control-token";

/** Runfile schema version — readers migrate on read, never abort. */
export const RUNFILE_VERSION = 1;

/**
 * `<harness>/.crewhaus/run/daemon.json` — the single-writer claim on the
 * harness's daemon slot, written atomically (tmp + rename, 0600).
 *
 * Liveness requires ALL THREE of `pid`, `pidStartTimeMs`, and
 * `argvFingerprint` to still match reality; pid alone is not enough (pids
 * are reused), and start-time alone is not enough (a recycled pid can start
 * at any time).
 */
export type DaemonRunfile = {
  readonly v: number;
  readonly pid: number;
  /** Epoch ms of the OS process start time, as the process-ops adapter
   *  reports it. Second-granularity on some platforms — compare with
   *  {@link START_TIME_TOLERANCE_MS}, never for equality. */
  readonly pidStartTimeMs: number;
  /** Digest of the exact `[cwd, ...argv]` that was spawned. */
  readonly argvFingerprint: string;
  /** The public/webhook port, when the run class has one. */
  readonly port?: number;
  /** The spec's `gateway.port`, recorded separately from `port`. */
  readonly gatewayPort?: number;
  /** The control.v1 port (loopback by default). */
  readonly controlPort?: number;
  /** Path to the minted control.v1 bearer (0600). The TOKEN itself is never
   *  written here and never passed in argv. */
  readonly controlTokenPath?: string;
  /** The bundle entry that was launched, relative to `bundleDir`. */
  readonly entry: string;
  /** Absolute path of the compiled-bundle directory. */
  readonly bundleDir: string;
  readonly runId: string;
  readonly startedAt: string;
  /** The manager version that wrote this runfile (mixed-version fleets are
   *  the normal case, so every record is version-stamped). */
  readonly managerVersion: string;
};

/** How far apart two start-time readings may be and still count as the same
 *  process. `ps -o lstart=` reports whole seconds on macOS, so an exact
 *  comparison would reject every adoption. Two seconds is far below any
 *  realistic pid-reuse window, and the argv fingerprint is the second
 *  independent guard. */
export const START_TIME_TOLERANCE_MS = 2_000;

/** One line of `<harness>/.crewhaus/run/runs.jsonl`.
 *
 *  The ledger is APPEND-ONLY: a run is opened with a full record and closed
 *  by appending a second, partial record carrying the same `runId` (see
 *  {@link RunLedgerPatch}). Readers fold by `runId`, later wins. A crash
 *  mid-run therefore leaves an open entry rather than a corrupt one. */
export type RunLedgerEntry = {
  readonly runId: string;
  readonly kind: RunKind;
  readonly argv: readonly string[];
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly exitCode?: number;
  /** `@crewhaus/errors` failure class, when the exit code carries one. */
  readonly failureClass?: string;
  /** The session the run wrote, once it is known from the trace stream. */
  readonly sessionId?: string;
  /** Log file path, relative to the run dir (`logs/<runId>.log`). */
  readonly logFile: string;
  /** True when the stop escalated past the grace period to SIGKILL. */
  readonly forced?: boolean;
};

/** A closing/annotating append against an existing `runId`. */
export type RunLedgerPatch = Partial<Omit<RunLedgerEntry, "runId">> & {
  readonly runId: string;
};

/** Retention policy for `logs/` — last N runs or M bytes, whichever bites
 *  first. Configurable per harness in `.crewhaus/settings.json` under
 *  `manager.logRetention`. */
export type RetentionPolicy = {
  readonly runs: number;
  readonly bytes: number;
};

export const DEFAULT_RETENTION: RetentionPolicy = { runs: 20, bytes: 50 * 1024 * 1024 };

/** Injected clock. `now` is epoch ms; the timer seam lets the restart
 *  backoff and the stop grace period run instantly under test. */
export type Clock = {
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

/** The real clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** An environment variable the operator relocated (session dir, datasets
 *  dir, watchme root, shared dir). Reported so the UI can badge "override
 *  active" and so fleet aggregators fold the RESOLVED roots instead of
 *  silently missing a relocated harness. */
export type EnvOverride = {
  readonly name: string;
  readonly value: string;
  readonly source: "env-file" | "process" | "caller";
};
