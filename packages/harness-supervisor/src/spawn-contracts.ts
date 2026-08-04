/**
 * The spawn contract table — ONE encoding of "how does this shape run",
 * consumed by the manager UI and the `crewhaus daemon` verbs alike.
 *
 * | Run class    | Shapes                                   | Launch |
 * |--------------|------------------------------------------|--------|
 * | interactive  | cli, browser                             | `crewhaus run <spec>` when a crewhaus bin resolves (harness `node_modules/.bin` first, then PATH), else `bun dist/agent.ts`. Attached, piped stdio (stdin carries submit/approve), tee'd to the run log. |
 * | daemon       | channel, managed, crew, voice            | `bun dist/daemon.ts`, DETACHED, stdio redirected to the log FILE (fds, never pipes — pipes die with the manager). Singleton per harness. |
 * | worker       | batch                                    | `bun dist/agent.ts` with daemon-class supervision. |
 * | one-shot job | workflow, graph, pipeline, research, eval, onchain, onchain-game | compile-if-stale → `bun dist/agent.ts`. Tracked as jobs; NEVER restarted. |
 * | mcp-server   | cli-shape projections / `expose:`        | `crewhaus serve --mcp <spec> [--sse --port N]`, port-tracked. |
 * | serverless   | cf-worker emits                          | not a process — a deployment record. |
 * | export       | claude-plugin emits                      | inspector only. |
 *
 * Invariants every spawn honours, each one a bug this ecosystem has already
 * paid for:
 *
 *   - **cwd is the harness ROOT**, never the bundle dir and never a temp
 *     dir: MCP server commands, `retrieve` data roots, `.crewhaus/`, and
 *     `.env` are all resolved relative to the directory holding
 *     `crewhaus.yaml`.
 *   - the harness `.env` chain is merged **UNDER** `process.env` — an
 *     exported variable always wins, which is what the shape UIs do too.
 *   - `CREWHAUS_TRACE=json` and `CREWHAUS_COST_TRACKING=1` are stamped so
 *     the pump has events and runs have costs.
 *   - `CREWHAUS_SESSION_DIR` / `CREWHAUS_DATASETS_DIR` / `CREWHAUS_WATCHME_ROOT`
 *     / `CREWHAUS_SHARED_DIR` are honoured AND reported as overrides, so
 *     fleet aggregators fold the resolved roots instead of silently missing
 *     a relocated harness.
 *   - only the interpreter launch can resume a session; the compiled bundle
 *     cannot, and the Run controls must say so rather than pretend.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EnvOverride, RunClass, RunKind } from "./types";

// ---------------------------------------------------------------------------
// Shape table
// ---------------------------------------------------------------------------

/** Shapes whose compiled bundle entry is `daemon.ts`. Batch's entry is
 *  `agent.ts` even though it gets daemon-class supervision. */
export const DAEMON_ENTRY_TARGETS: ReadonlySet<string> = new Set([
  "channel",
  "managed",
  "crew",
  "voice",
]);

const RUN_CLASS_BY_TARGET: Readonly<Record<string, RunClass>> = {
  cli: "interactive",
  browser: "interactive",
  channel: "daemon",
  managed: "daemon",
  crew: "daemon",
  voice: "daemon",
  batch: "worker",
  workflow: "one-shot",
  graph: "one-shot",
  pipeline: "one-shot",
  research: "one-shot",
  eval: "one-shot",
  onchain: "one-shot",
  "onchain-game": "one-shot",
};

/** The run class for a spec target. Unknown targets are treated as one-shot
 *  jobs: run it, never restart it — the conservative default for a shape
 *  this manager version has not met. */
export function runClassFor(target: string): RunClass {
  return RUN_CLASS_BY_TARGET[target] ?? "one-shot";
}

/** The bundle entry file a target's compiled bundle exposes. */
export function entryFileFor(target: string): string {
  return DAEMON_ENTRY_TARGETS.has(target) ? "daemon.ts" : "agent.ts";
}

/** Long-running classes: the ones a crash policy applies to. */
export function isSupervisedClass(runClass: RunClass): boolean {
  return runClass === "daemon" || runClass === "worker";
}

/** How a run class is ledgered. */
export function runKindFor(runClass: RunClass): RunKind {
  switch (runClass) {
    case "daemon":
    case "worker":
      return "daemon";
    case "interactive":
      return "interactive";
    case "mcp-server":
      return "mcp-server";
    default:
      return "job";
  }
}

// ---------------------------------------------------------------------------
// Locating things
// ---------------------------------------------------------------------------

export const SPEC_FILENAMES = ["crewhaus.yaml", "crewhaus.yml"] as const;

/**
 * The harness ROOT — the directory holding `crewhaus.yaml`. Compiled bundles
 * usually live in a `dist/` subdir, and running with cwd = the bundle dir
 * breaks every spec-relative path. Walk up at most four levels; fall back to
 * the given dir.
 */
export function findHarnessRoot(startDir: string): string {
  let d = resolve(startDir);
  for (let i = 0; i < 4; i++) {
    if (SPEC_FILENAMES.some((f) => existsSync(join(d, f)))) return d;
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return resolve(startDir);
}

/** The spec file at a harness root, or undefined. */
export function findSpecPath(harnessRoot: string): string | undefined {
  for (const f of SPEC_FILENAMES) {
    const p = join(harnessRoot, f);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Candidate bundle dirs, in the order `crewhaus compile -o …` produces
 *  them. The bundle may also sit directly at the harness root. */
export const BUNDLE_DIR_CANDIDATES = ["dist", "build", "."] as const;

export type BundleLocation = {
  /** Absolute bundle dir. */
  readonly bundleDir: string;
  /** Entry file name inside it. */
  readonly entry: string;
  /** Absolute entry path. */
  readonly entryPath: string;
};

/** Find the compiled bundle for a target, or undefined when nothing is
 *  compiled yet (the caller offers "Compile now" rather than failing). */
export function resolveBundle(harnessRoot: string, target: string): BundleLocation | undefined {
  const entry = entryFileFor(target);
  for (const candidate of BUNDLE_DIR_CANDIDATES) {
    const bundleDir = candidate === "." ? harnessRoot : join(harnessRoot, candidate);
    const entryPath = join(bundleDir, entry);
    if (existsSync(entryPath)) return { bundleDir, entry, entryPath };
  }
  return undefined;
}

export type BinResolverDeps = {
  /** Existence probe; injected in tests. */
  readonly exists?: (path: string) => boolean;
  /** PATH lookup; injected in tests. Returns an absolute path or undefined. */
  readonly which?: (cmd: string) => string | undefined;
};

/**
 * Resolve a runnable `crewhaus` CLI: the harness's OWN
 * `node_modules/.bin/crewhaus` first (version-matched to the harness's
 * dependencies — the mixed-version fleet is the normal case), then PATH.
 * undefined ⇒ no interpreter launch is available, so the compiled bundle is
 * the only path and resume is impossible.
 */
export function resolveCrewhausBin(
  harnessRoot: string,
  deps: BinResolverDeps = {},
): string | undefined {
  const exists = deps.exists ?? existsSync;
  const local = join(harnessRoot, "node_modules", ".bin", "crewhaus");
  if (exists(local)) return local;
  const which = deps.which ?? defaultWhich;
  return which("crewhaus");
}

function defaultWhich(cmd: string): string | undefined {
  const pathVar = process.env["PATH"] ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathVar.split(sep)) {
    if (dir === "") continue;
    const candidate = join(dir, cmd);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The env chain
// ---------------------------------------------------------------------------

const ENV_LINE_RE = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/;

/** Parse dotenv text: `KEY=VALUE`, optional `export `, surrounding quotes
 *  stripped, `#` comments skipped, no interpolation. Malformed lines are
 *  ignored, never fatal. Mirrors the tolerant parser the manager server
 *  uses for presence checks, so both see the same variables. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(ENV_LINE_RE);
    if (m === null) continue;
    const key = m[1] as string;
    let value = (m[2] ?? "").trim();
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : undefined;
    if (quote !== undefined && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** The harness env-file chain, in precedence order (later wins). */
export const ENV_FILENAMES = [".env", ".env.local"] as const;

export type EnvChain = {
  readonly vars: Record<string, string>;
  /** Chain files that existed, in read order. */
  readonly files: readonly string[];
};

/** Read `<harness>/.env` then `<harness>/.env.local`. */
export function loadEnvChain(harnessRoot: string): EnvChain {
  const vars: Record<string, string> = {};
  const files: string[] = [];
  for (const name of ENV_FILENAMES) {
    const path = join(harnessRoot, name);
    if (!existsSync(path)) continue;
    try {
      Object.assign(vars, parseEnvText(readFileSync(path, "utf8")));
      files.push(name);
    } catch {
      // Unreadable env file — presence degrades, never throws.
    }
  }
  return { vars, files };
}

/** Variables whose value relocates a harness data root. Reported so the UI
 *  can badge "override active" and aggregators can fold the resolved root. */
export const OVERRIDE_ENV_KEYS = [
  "CREWHAUS_SESSION_DIR",
  "CREWHAUS_DATASETS_DIR",
  "CREWHAUS_WATCHME_ROOT",
  "CREWHAUS_SHARED_DIR",
] as const;

export type SpawnEnvInput = {
  readonly harnessRoot: string;
  /** The manager's own environment (wins over the harness `.env` chain). */
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  /** Pre-read chain; read from disk when omitted. */
  readonly envChain?: EnvChain;
  /** Caller-stamped variables that win over everything (ports, control
   *  token; the trace stamps are applied here too). */
  readonly extra?: Readonly<Record<string, string>>;
};

export type SpawnEnv = {
  readonly env: Record<string, string>;
  readonly envFiles: readonly string[];
  readonly overrides: readonly EnvOverride[];
};

/**
 * Build the exact environment a spawn receives: harness `.env` chain UNDER
 * `process.env`, then the manager's own stamps. The same record is what the
 * preflight gate must evaluate — checking a different env than the spawn
 * gets is how "it passed preflight and then died on a missing key" happens.
 */
export function buildSpawnEnv(input: SpawnEnvInput): SpawnEnv {
  const chain = input.envChain ?? loadEnvChain(input.harnessRoot);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(chain.vars)) env[k] = v;
  for (const [k, v] of Object.entries(input.processEnv)) {
    if (typeof v === "string") env[k] = v;
  }
  env["CREWHAUS_TRACE"] = "json";
  env["CREWHAUS_COST_TRACKING"] = "1";
  for (const [k, v] of Object.entries(input.extra ?? {})) env[k] = v;

  const overrides: EnvOverride[] = [];
  for (const name of OVERRIDE_ENV_KEYS) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    const source: EnvOverride["source"] =
      input.extra?.[name] !== undefined
        ? "caller"
        : typeof input.processEnv[name] === "string"
          ? "process"
          : "env-file";
    overrides.push({ name, value, source });
  }
  return { env, envFiles: chain.files, overrides };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Typed `crewhaus run` options, mirrored from the CLI's flags. Only the
 *  interpreter launch can carry them; the compiled bundle takes none. */
export type RunOptions = {
  readonly model?: string;
  readonly prompt?: string;
  readonly budgetUsd?: number;
  readonly permissionMode?: string;
  readonly askMode?: string;
  readonly trace?: string;
  readonly streaming?: boolean;
  /** Resume this session (interpreter launches only). */
  readonly resumeSessionId?: string;
};

export const SESSION_ID_RE = /^sess_[0-9a-f]{16}$/;

/** Render typed options as `crewhaus run` flags, in a stable order so the
 *  CLI twin string a UI shows is deterministic. */
export function runOptionFlags(options: RunOptions): string[] {
  const argv: string[] = [];
  if (options.model !== undefined && options.model !== "") argv.push("--model", options.model);
  if (options.prompt !== undefined && options.prompt !== "") argv.push("--prompt", options.prompt);
  if (options.budgetUsd !== undefined && Number.isFinite(options.budgetUsd)) {
    argv.push("--budget-usd", String(options.budgetUsd));
  }
  if (options.permissionMode !== undefined && options.permissionMode !== "") {
    argv.push("--permission-mode", options.permissionMode);
  }
  if (options.askMode !== undefined && options.askMode !== "") {
    argv.push("--ask-mode", options.askMode);
  }
  if (options.trace !== undefined && options.trace !== "") argv.push("--trace", options.trace);
  if (options.streaming === true) argv.push("--streaming");
  return argv;
}

export type SpawnPlanInput = {
  /** Any directory inside the harness; the root is derived from it. */
  readonly harnessDir: string;
  /** Spec target (`readSpecHeader().target`). */
  readonly target: string;
  /** Override the run class (an mcp-server projection of a cli shape). */
  readonly runClass?: RunClass;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly envChain?: EnvChain;
  readonly bundle?: BundleLocation | undefined;
  readonly crewhausBin?: string | undefined;
  readonly specPath?: string | undefined;
  readonly options?: RunOptions;
  /** Allocated ports (the ledger decides them; this only stamps them). */
  readonly ports?: {
    readonly port?: number;
    readonly gatewayPort?: number;
    readonly controlPort?: number;
  };
  /** control.v1 bearer. Stamped into the ENV — never into argv, which every
   *  process on the machine can read. */
  readonly controlToken?: string;
  readonly controlTokenPath?: string;
  /** `bun` executable; injected for tests and unusual installs. */
  readonly bunBin?: string;
  /** HTTP+SSE instead of stdio for the mcp-server class. */
  readonly mcpSse?: boolean;
};

export type SpawnPlan = {
  readonly runClass: RunClass;
  readonly kind: RunKind;
  readonly argv: readonly string[];
  /** ALWAYS the harness root. */
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly envFiles: readonly string[];
  readonly overrides: readonly EnvOverride[];
  readonly detached: boolean;
  /** `pipe` for attached runs, `file` for detached daemons. */
  readonly stdio: "pipe" | "file";
  readonly launchMode: "interpreter" | "compiled" | "cli-verb";
  /** True only for interpreter launches — the compiled bundle cannot resume,
   *  and the Run controls must say Fresh rather than pretend. */
  readonly canResume: boolean;
  /** Whether the supervision policy may auto-restart this run. */
  readonly supervised: boolean;
  readonly entry: string;
  readonly bundleDir: string;
  readonly ports: {
    readonly port?: number;
    readonly gatewayPort?: number;
    readonly controlPort?: number;
  };
  readonly controlTokenPath?: string;
};

/** Raised when a plan cannot be built (no bundle, no spec). Carries a
 *  `remedy` the UI turns into a button rather than an error toast. */
export class SpawnPlanError extends Error {
  readonly remedy: "compile" | "add-spec" | "install-cli";
  constructor(message: string, remedy: "compile" | "add-spec" | "install-cli") {
    super(message);
    this.name = "SpawnPlanError";
    this.remedy = remedy;
  }
}

/**
 * Build the spawn plan for one run. Pure apart from the filesystem probes it
 * is not given answers for (bundle location, spec path, bin resolution) —
 * pass those in and the function is fully deterministic.
 */
export function buildSpawnPlan(input: SpawnPlanInput): SpawnPlan {
  const harnessRoot = findHarnessRoot(input.harnessDir);
  const runClass = input.runClass ?? runClassFor(input.target);
  const options = input.options ?? {};
  const bunBin = input.bunBin ?? "bun";
  const specPath = input.specPath ?? findSpecPath(harnessRoot);
  const bundle = input.bundle ?? resolveBundle(harnessRoot, input.target);
  const crewhausBin = input.crewhausBin;

  if (runClass === "serverless" || runClass === "export") {
    throw new SpawnPlanError(
      `${input.target} does not run as a process — it is a ${runClass === "serverless" ? "deployment" : "export"} artifact`,
      "compile",
    );
  }

  const extra: Record<string, string> = {};
  if (input.ports?.port !== undefined) extra["PORT"] = String(input.ports.port);
  if (input.ports?.controlPort !== undefined) {
    extra["CREWHAUS_CONTROL_PORT"] = String(input.ports.controlPort);
  }
  if (input.controlToken !== undefined && input.controlToken !== "") {
    extra["CREWHAUS_CONTROL_TOKEN"] = input.controlToken;
  }
  const { env, envFiles, overrides } = buildSpawnEnv({
    harnessRoot,
    processEnv: input.processEnv,
    ...(input.envChain !== undefined ? { envChain: input.envChain } : {}),
    extra,
  });

  const base = {
    runClass,
    kind: runKindFor(runClass),
    cwd: harnessRoot,
    env,
    envFiles,
    overrides,
    supervised: isSupervisedClass(runClass),
    ports: input.ports ?? {},
    ...(input.controlTokenPath !== undefined ? { controlTokenPath: input.controlTokenPath } : {}),
  } as const;

  if (runClass === "mcp-server") {
    if (crewhausBin === undefined) {
      throw new SpawnPlanError(
        "the mcp-server run class needs a resolvable `crewhaus` CLI (harness node_modules/.bin, then PATH)",
        "install-cli",
      );
    }
    if (specPath === undefined) {
      throw new SpawnPlanError("no crewhaus.yaml at the harness root", "add-spec");
    }
    const argv = [crewhausBin, "serve", "--mcp", specPath];
    if (input.mcpSse === true) {
      argv.push("--sse");
      if (input.ports?.port !== undefined) argv.push("--port", String(input.ports.port));
    }
    return {
      ...base,
      argv,
      detached: true,
      stdio: "file",
      launchMode: "cli-verb",
      canResume: false,
      entry: "serve --mcp",
      bundleDir: harnessRoot,
    };
  }

  // Interactive shapes prefer the interpreter: it re-reads the spec each
  // start (a free recompile) and it is the ONLY launch that can resume.
  if (runClass === "interactive" && crewhausBin !== undefined && specPath !== undefined) {
    const argv = [crewhausBin, "run", specPath, ...runOptionFlags(options)];
    const resumeId = options.resumeSessionId;
    if (resumeId !== undefined && SESSION_ID_RE.test(resumeId)) argv.push("--resume", resumeId);
    return {
      ...base,
      argv,
      detached: false,
      stdio: "pipe",
      launchMode: "interpreter",
      canResume: true,
      entry: specPath,
      bundleDir: harnessRoot,
    };
  }

  if (bundle === undefined) {
    throw new SpawnPlanError(
      `no compiled bundle for ${input.target} — expected ${entryFileFor(input.target)} under dist/ or build/`,
      "compile",
    );
  }
  const detached = runClass !== "interactive";
  return {
    ...base,
    argv: [bunBin, bundle.entryPath],
    detached,
    // Detached children write straight into the log fd; an attached run is
    // piped so the manager can carry stdin, and tees to the log itself.
    stdio: detached ? "file" : "pipe",
    launchMode: "compiled",
    canResume: false,
    entry: bundle.entry,
    bundleDir: bundle.bundleDir,
  };
}

/** The CLI twin of a plan — the command an operator could paste. Never
 *  includes the env (which carries the control token). */
export function cliTwin(plan: SpawnPlan): string {
  const argv = plan.argv.map(quoteIfNeeded);
  return `cd ${quoteIfNeeded(plan.cwd)} && ${argv.join(" ")}`;
}

function quoteIfNeeded(value: string): string {
  return value.includes(" ") ? JSON.stringify(value) : value;
}

/** True when `path` is inside `root` (lexical check on already-resolved
 *  paths; the server's realpath containment stays the security boundary). */
export function isInside(root: string, path: string): boolean {
  const r = resolve(root);
  const p = isAbsolute(path) ? resolve(path) : resolve(root, path);
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
}
