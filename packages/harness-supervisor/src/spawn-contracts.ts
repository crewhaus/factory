/**
 * The spawn contract table — ONE encoding of "how does this shape run",
 * consumed by the manager UI and the `crewhaus daemon` verbs alike.
 *
 * | Run class    | Shapes                                   | Launch |
 * |--------------|------------------------------------------|--------|
 * | interactive  | cli, browser                             | `crewhaus run <spec>` when a crewhaus bin resolves (harness `node_modules/.bin` first, then PATH), else `bun dist/agent.ts`. Attached, piped stdio (stdin carries submit/approve), tee'd to the run log. |
 * | daemon       | channel, managed, voice                  | `bun dist/daemon.ts`, DETACHED, stdio redirected to the log FILE (fds, never pipes — pipes die with the manager). Singleton per harness. |
 * | worker       | batch                                    | `bun dist/agent.ts` with daemon-class supervision. |
 * | one-shot job | workflow, graph, pipeline, research, eval, onchain, onchain-game, crew | compile-if-stale → `bun dist/agent.ts` (crew: `dist/daemon.ts` with a BRIEF on stdin). Tracked as jobs; NEVER restarted. |
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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readDeployments } from "@crewhaus/control-records";
import { readManagerSettings } from "./manager-settings";
import type { EnvOverride, RunClass, RunKind } from "./types";

// ---------------------------------------------------------------------------
// Shape table
// ---------------------------------------------------------------------------

/**
 * Shapes whose compiled bundle takes its INPUT as a document on stdin —
 * a brief — rather than as messages, a schedule, or a prompt.
 *
 * Crew is the only one today, and it is why `crewhaus daemon submit` exists:
 * these cannot be started like a daemon, because "start" for them means
 * "run this piece of work".
 */
export const BRIEF_TARGETS: ReadonlySet<string> = new Set(["crew"]);

/** True when this shape's compiled bundle reads a brief on stdin. */
export function readsBriefOnStdin(target: string): boolean {
  return BRIEF_TARGETS.has(target);
}

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
  // A crew bundle is a ONE-SHOT and always was: its emitted `daemon.ts` reads
  // a brief on stdin, runs the pipeline and exits — the emitter's own comment
  // says so. Classing it `daemon` launched it detached with no stdin, where
  // it exited 2 immediately ("no input on stdin"); 2 is not in the terminal
  // set, so the supervisor read that as a crash and walked the backoff ladder
  // into `crash-looping`. A crew harness was effectively unsupervisable.
  // See `crewhaus daemon submit --brief-file`.
  crew: "one-shot",
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
    if (!existsSync(entryPath)) continue;
    // A root entry is a bundle only when crewhaus compiled it there: a deployment record
    // names a root entry, or compile's stamped manifest sits at the root.
    if (candidate === "." && !rootBundleCompiled(harnessRoot)) continue;
    return { bundleDir, entry, entryPath };
  }
  return undefined;
}

/** The `name` `crewhaus compile` stamps into a manifest it wrote. */
const COMPILED_MANIFEST_NAME = "crewhaus-compiled-bundle";

/** Whether `crewhaus compile` put a bundle at the harness root. */
export function rootBundleCompiled(harnessRoot: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(harnessRoot, "package.json"), "utf8")) as {
      name?: unknown;
    };
    if (manifest.name === COMPILED_MANIFEST_NAME) return true;
  } catch {
    // No manifest, or not ours: the records decide.
  }
  const read = readDeployments(harnessRoot);
  if (read.state !== "present") return false;
  return read.records.some((record) => {
    const artifact = record["artifact"];
    if (typeof artifact !== "object" || artifact === null) return false;
    const entry = (artifact as { entry?: unknown }).entry;
    return typeof entry === "string" && entry !== "" && !entry.includes("/");
  });
}

export type BinResolverDeps = {
  /** Existence probe; injected in tests. */
  readonly exists?: (path: string) => boolean;
  /** PATH lookup; injected in tests. Returns an absolute path or undefined. */
  readonly which?: (cmd: string) => string | undefined;
  /** Real-path resolution; injected in tests. Throws for a path that does not resolve. */
  readonly realpath?: (path: string) => string;
  /**
   * Whether the harness's own `node_modules/.bin/crewhaus` may be used. Default
   * true. Home passes false for its jobs on a harness not adopted on this
   * machine, so they run Home's own `crewhaus`.
   */
  readonly allowHarnessLocal?: boolean;
};

/** `inner` resolves inside `root` (both real paths), by the `relative()` rule. */
function realInside(root: string, inner: string): boolean {
  const rel = relative(root, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a runnable `crewhaus` CLI: the harness's OWN
 * `node_modules/.bin/crewhaus` first (version-matched to the harness's
 * dependencies — the mixed-version fleet is the normal case), then PATH.
 * The harness's own copy is used only when its real path is inside the
 * harness's real directory; one that resolves anywhere else is passed over
 * for the `crewhaus` on PATH.
 * undefined ⇒ no interpreter launch is available, so the compiled bundle is
 * the only path and resume is impossible.
 */
export function resolveCrewhausBin(
  harnessRoot: string,
  deps: BinResolverDeps = {},
): string | undefined {
  const exists = deps.exists ?? existsSync;
  const realpath = deps.realpath ?? realpathSync;
  if (deps.allowHarnessLocal !== false) {
    const local = join(harnessRoot, "node_modules", ".bin", "crewhaus");
    if (exists(local)) {
      try {
        if (realInside(realpath(harnessRoot), realpath(local))) return local;
      } catch {
        // A local bin that does not resolve is not one to run.
      }
    }
  }
  const which = deps.which ?? defaultWhich;
  return which("crewhaus");
}

/**
 * The argv that runs this process's own `crewhaus` (Home's, for its jobs) in another
 * directory without taking code or settings from it. A compiled `crewhaus` is its own executable, built to read no
 * `bunfig.toml` from the directory it runs in. A `crewhaus` run as a script by Bun (`main`)
 * runs as `bun --no-env-file --config=<emptyConfig> <main>`, so the directory's env files
 * and `bunfig.toml` are not read. Undefined when `execPath` is neither.
 */
export function homeCrewhausArgv(self: {
  readonly execPath: string;
  readonly main: string;
  readonly emptyConfig: string;
}): string[] | undefined {
  const compiled = self.main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(self.main);
  if (compiled) return [self.execPath];
  const runtime = (self.execPath.split(/[\\/]/).at(-1) ?? "").toLowerCase();
  if (runtime !== "bun" && runtime !== "bun.exe") return undefined;
  if (!isAbsolute(self.main)) return undefined;
  return [self.execPath, "--no-env-file", `--config=${self.emptyConfig}`, self.main];
}

/**
 * The first `cmd` on this process's `PATH`, as an absolute path. Only absolute `PATH`
 * entries are searched, so the answer never depends on the directory a caller later runs
 * it in.
 */
function defaultWhich(cmd: string): string | undefined {
  const pathVar = process.env["PATH"] ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of pathVar.split(sep)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const candidate = join(dir, cmd);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The env chain
// ---------------------------------------------------------------------------

const ENV_LINE_RE = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/;

/**
 * Parse dotenv text: `KEY=VALUE`, optional `export `, surrounding quotes
 * stripped, `#` comments skipped, no interpolation. Malformed lines are
 * ignored, never fatal.
 *
 * This is THE dotenv reader for the workspace — `@crewhaus/hangar-server`
 * re-exports it rather than keeping a second copy, because this function
 * decides what the spawned daemon actually receives and a divergent second
 * reader would mean the console reporting one value and the child getting
 * another.
 *
 * A DOUBLE-quoted value is unescaped (see {@link unquoteEnvValue}); a
 * single-quoted one is taken literally.
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(ENV_LINE_RE);
    if (m === null) continue;
    const key = m[1] as string;
    out[key] = unquoteEnvValue((m[2] ?? "").trim());
  }
  return out;
}

/**
 * Turn one raw `.env` scalar back into its value.
 *
 * Inside DOUBLE quotes, `\\` and `\"` are unescaped — the exact reverse of
 * the writer's `encodeEnvValue` in `env-writer.ts` beside it, which escapes
 * both when it has to quote. Without that step the two halves disagreed and
 * a value containing a backslash or a double quote came back altered:
 * `K="a\"b"` read as `a\"b`, not `a"b`. Nothing in the current credential
 * set reaches the quoting path (tokens are all `[A-Za-z0-9_.-]`), so this
 * was latent rather than live — but a secret that changes shape on a
 * round trip is the worst possible thing for a file whose whole job is
 * carrying secrets to a child process.
 *
 * Inside SINGLE quotes there is nothing to reverse: the writer never emits
 * them, and every dotenv implementation treats them as literal.
 *
 * Unquoted, a trailing ` #` comment is stripped — which is why a value that
 * contains one has to be quoted on the way out in the first place.
 */
export function unquoteEnvValue(raw: string): string {
  const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : undefined;
  if (quote !== undefined && raw.length >= 2 && raw.endsWith(quote)) {
    const inner = raw.slice(1, -1);
    return quote === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner;
  }
  const hash = raw.indexOf(" #");
  return hash === -1 ? raw : raw.slice(0, hash).trim();
}

/** The two harness-local env files that decide the chain's mode when the manager's
 *  environment sets no `NODE_ENV`, in precedence order (later wins). {@link envFilenamesFor}
 *  names every file a mode reads. */
export const ENV_FILENAMES = [".env", ".env.local"] as const;

/** The mode an env-file chain is read for: Bun's, from `NODE_ENV`. */
export type EnvMode = "development" | "production" | "test";

/** Bun's mode for a `NODE_ENV`: `production` and `test` as named, anything else `development`. */
export function envModeOf(nodeEnv: string | undefined): EnvMode {
  return nodeEnv === "production" || nodeEnv === "test" ? nodeEnv : "development";
}

/**
 * The harness-local env files a mode reads, lowest precedence first, as Bun reads them:
 * `.env`, `.env.<mode>`, `.env.local`, `.env.<mode>.local`; under `test` there is no
 * `.env.local`.
 */
export function envFilenamesFor(mode: EnvMode): readonly string[] {
  return mode === "test"
    ? [".env", ".env.test", ".env.test.local"]
    : [".env", `.env.${mode}`, ".env.local", `.env.${mode}.local`];
}

/** One file in the chain, whether or not it exists. */
export type EnvFileRef = {
  /** As declared: a chain filename (`.env`) or a `manager.envFiles` entry
   *  (`../.env`) verbatim. This is what an operator recognizes. */
  readonly declaredAs: string;
  /** Resolved absolute path — what was actually read. */
  readonly path: string;
  /** `shared` files come from `manager.envFiles` and load UNDER the local
   *  chain; `harness` files are the harness's own (see {@link envFilenamesFor}). */
  readonly scope: "shared" | "harness";
  /** False for a declared file that is absent or unreadable. A declared
   *  file that is not there is REPORTED, never silently skipped: that is
   *  the whole failure mode of the `.env → ../.env` symlink it replaces. */
  readonly present: boolean;
};

export type EnvChain = {
  readonly vars: Record<string, string>;
  /** Files that existed, in read order, named as declared. */
  readonly files: readonly string[];
  /** Every file in the chain including declared-but-absent ones, in read
   *  order — the merged-spawn-env story a manager can render. */
  readonly refs: readonly EnvFileRef[];
};

export type LoadEnvChainOptions = {
  /** Shared files to load UNDER the harness-local chain, in order. Defaults
   *  to `manager.envFiles` from `<harness>/.crewhaus/settings.json`; pass
   *  `[]` to read the harness-local chain alone. */
  readonly sharedFiles?: readonly string[];
  /** The `NODE_ENV` the manager's environment starts the child with. When it is
   *  undefined, the `NODE_ENV` the shared files, `.env` and `.env.local` set decides the
   *  mode, else `development`. */
  readonly nodeEnv?: string | undefined;
};

/**
 * Read the env chain a spawn from this harness sees, LOWEST precedence
 * first: every declared shared file (`manager.envFiles`), then the
 * harness's own files in Bun's order for the mode (`.env`, `.env.<mode>`,
 * `.env.local`, `.env.<mode>.local`; see {@link envFilenamesFor}). The mode
 * comes from the `NODE_ENV` the child starts with: the manager's, else the
 * one the shared files, `.env` and `.env.local` set. A supervised daemon
 * reads no env file itself, so this chain, filtered, is all it gets from
 * the harness's files.
 *
 * Shared files exist for the fleet case: sibling harnesses that share one
 * Anthropic key, one search provider, one set of opt-ins. Before this the
 * only way to do that was a `.env → ../.env` symlink per member — which
 * works (readFile follows it) but is invisible convention: `harness show`
 * and preflight reported the chain as if it were local, a copied harness
 * silently carried a dangling symlink, and Windows symlinks are their own
 * adventure. A declaration is visible to the tooling, travels with the
 * harness, and degrades to a REPORTED absence rather than a silent one.
 *
 * Precedence is unchanged by all of this: shared < harness-local <
 * `process.env` < caller extras (see {@link buildSpawnEnv}).
 *
 * A shared entry is resolved against the harness ROOT when relative, and
 * taken verbatim when absolute. No `~` expansion and no shell — the string
 * is a path, not a command. The harness directory is already the trust
 * boundary for supervision (`run.sh` and `.crewhaus/settings.json` both
 * live there), so an entry may point outside the harness — which is the
 * point, `../.env` is the motivating case — and every entry is reported so
 * "what does this daemon actually read" is answerable without guessing.
 */
export function loadEnvChain(harnessRoot: string, options: LoadEnvChainOptions = {}): EnvChain {
  const vars: Record<string, string> = {};
  const files: string[] = [];
  const refs: EnvFileRef[] = [];

  const read = (declaredAs: string, path: string, scope: EnvFileRef["scope"]): void => {
    if (!existsSync(path)) {
      // A shared file is DECLARED, so its absence is a fact worth carrying.
      // A local chain file is optional by construction — most harnesses have
      // no `.env.local` — so an absent one is simply not part of the chain.
      if (scope === "shared") refs.push({ declaredAs, path, scope, present: false });
      return;
    }
    try {
      Object.assign(vars, parseEnvText(readFileSync(path, "utf8")));
      files.push(declaredAs);
      refs.push({ declaredAs, path, scope, present: true });
    } catch {
      // Unreadable env file — presence degrades, never throws.
      refs.push({ declaredAs, path, scope, present: false });
    }
  };

  const shared = options.sharedFiles ?? readManagerSettings(harnessRoot).envFiles;
  for (const declared of shared) {
    read(declared, isAbsolute(declared) ? declared : resolve(harnessRoot, declared), "shared");
  }
  const mode = envModeOf(options.nodeEnv ?? nodeEnvOfFiles(harnessRoot, vars));
  for (const name of envFilenamesFor(mode)) read(name, join(harnessRoot, name), "harness");
  return { vars, files, refs };
}

/** The `NODE_ENV` the shared files (already folded into `shared`), `.env` and `.env.local`
 *  set, later winning; undefined when none sets it. */
function nodeEnvOfFiles(
  harnessRoot: string,
  shared: Readonly<Record<string, string>>,
): string | undefined {
  let nodeEnv = shared["NODE_ENV"];
  for (const name of ENV_FILENAMES) {
    const path = join(harnessRoot, name);
    if (!existsSync(path)) continue;
    try {
      const value = parseEnvText(readFileSync(path, "utf8"))["NODE_ENV"];
      if (value !== undefined) nodeEnv = value;
    } catch {
      // Unreadable: it sets nothing, as the chain itself reports.
    }
  }
  return nodeEnv;
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
  /** The directory the manager was started in, whose env files Bun loaded into
   *  `processEnv`. Defaults to `process.cwd()`. */
  readonly managerCwd?: string;
  /** Caller-stamped variables that win over everything (ports, control
   *  token; the trace stamps are applied here too). */
  readonly extra?: Readonly<Record<string, string>>;
  /** The platform whose name rules apply; `process.platform` when omitted. */
  readonly platform?: NodeJS.Platform;
};

export type SpawnEnv = {
  readonly env: Record<string, string>;
  readonly envFiles: readonly string[];
  /** The full chain including declared-but-absent shared files. */
  readonly envFileRefs: readonly EnvFileRef[];
  readonly overrides: readonly EnvOverride[];
  /** Loader settings the env files named and the spawn left out: names only. */
  readonly dropped: readonly string[];
};

/**
 * Loader and interpreter settings a supervised start takes only from the environment the
 * manager was started with, never from a harness's env files. Matched by exact name here
 * and by family in `LOADER_ENV_PREFIXES`. On Windows, where an environment name is one
 * name in any letter case, a name matches in any spelling; elsewhere names are compared as
 * written.
 */
export const LOADER_ENV_KEYS = [
  "BUN_OPTIONS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "CHVM_DIR",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "IFS",
  "PATH",
  "GCONV_PATH",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "RUBYOPT",
  "RUBYLIB",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_EXEC_PATH",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_TEMPLATE_DIR",
] as const;

/** Families matched by prefix. Never a bare `NODE_` or `BUN_`: `NODE_ENV` is an app setting. */
export const LOADER_ENV_PREFIXES = ["GIT_CONFIG_", "LD_", "DYLD_", "BASH_FUNC_"] as const;

const LOADER_ENV_KEY_SET: ReadonlySet<string> = new Set(LOADER_ENV_KEYS);

/** A name as `platform` compares it: upper-cased on Windows, as written elsewhere. */
function envNameOn(platform: NodeJS.Platform): (name: string) => string {
  return platform === "win32" ? (name) => name.toUpperCase() : (name) => name;
}

/**
 * Whether a name is a loader setting a spawn takes only from the manager's environment. On
 * Windows (`platform`, `process.platform` when omitted) every spelling of the name matches.
 */
export function isLoaderEnvKey(
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const compared = envNameOn(platform)(name);
  return (
    LOADER_ENV_KEY_SET.has(compared) ||
    LOADER_ENV_PREFIXES.some((prefix) => compared.startsWith(prefix))
  );
}

/** Every env file Bun loads into a process started in a directory, whichever `NODE_ENV`. */
export const BUN_DOTENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
] as const;

/**
 * The names an env file's lines assign, in any spelling Bun's loader takes: leading spaces,
 * an `export ` prefix, spaces around the `=` (or `:`), CRLF endings. Over-matching (a line
 * inside another key's multi-line quoted value) only leaves a setting out.
 */
export function dotenvAssignedNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const raw of text.split(/\r?\n|\r/)) {
    let line = raw.trimStart();
    if (/^export[ \t]/.test(line)) line = line.slice(6).trimStart();
    const m = /^([^\s=:#]+)[ \t]*[=:]/.exec(line);
    if (m !== null) names.add(m[1] as string);
  }
  return names;
}

/**
 * The loader settings any of Bun's env files in `dirs` assigns, by name, whatever the value
 * and whichever mode would read the file. A caller leaves each one out by name, whatever
 * value it holds. On Windows (`platform`, `process.platform` when omitted) the names are
 * upper-cased, so every spelling of one setting is one name.
 */
export function loaderKeysInEnvFiles(
  dirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Set<string> {
  const compared = envNameOn(platform);
  const found = new Set<string>();
  for (const dir of new Set(dirs)) {
    for (const name of BUN_DOTENV_FILES) {
      let text: string;
      try {
        text = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      for (const key of dotenvAssignedNames(text)) {
        if (isLoaderEnvKey(key, platform)) found.add(compared(key));
      }
    }
  }
  return found;
}

/**
 * Build the exact environment a spawn receives: harness `.env` chain UNDER
 * `process.env`, then the manager's own stamps. The same record is what the
 * preflight gate must evaluate — checking a different env than the spawn
 * gets is how "it passed preflight and then died on a missing key" happens.
 *
 * On Windows (`platform`), names that differ only in letter case are one name: the env
 * holds one spelling of each, the later source's, and a loader setting is taken only from
 * the manager's environment, whatever spelling either side uses.
 */
export function buildSpawnEnv(input: SpawnEnvInput): SpawnEnv {
  const platform = input.platform ?? process.platform;
  const compared = envNameOn(platform);
  const chain =
    input.envChain ?? loadEnvChain(input.harnessRoot, { nodeEnv: input.processEnv["NODE_ENV"] });
  const env: Record<string, string> = {};
  // The spelling `env` holds for each compared name, so a later source replaces it.
  const spelling = new Map<string, string>();
  const set = (k: string, v: string): void => {
    const name = compared(k);
    const held = spelling.get(name);
    if (held !== undefined && held !== k) Reflect.deleteProperty(env, held);
    spelling.set(name, k);
    env[k] = v;
  };
  const dropped = new Set<string>();
  for (const [k, v] of Object.entries(chain.vars)) {
    if (isLoaderEnvKey(k, platform)) {
      dropped.add(k);
      continue;
    }
    set(k, v);
  }
  const chainHolds = (k: string, v: string): boolean =>
    Object.entries(chain.vars).some(([ck, cv]) => cv === v && compared(ck) === compared(k));
  // A loader setting any of Bun's env files in the harness or the manager's directory
  // assigns is left out by name, whatever its value. `PATH` is the one exception: the child
  // always runs with the manager's `PATH`.
  const fromFiles = loaderKeysInEnvFiles(
    [input.harnessRoot, input.managerCwd ?? process.cwd()],
    platform,
  );
  for (const [k, v] of Object.entries(input.processEnv)) {
    if (typeof v !== "string") continue;
    const name = compared(k);
    const loader = isLoaderEnvKey(k, platform);
    if (loader && name !== "PATH" && (fromFiles.has(name) || chainHolds(k, v))) {
      dropped.add(k);
      continue;
    }
    if (loader) for (const d of [...dropped]) if (compared(d) === name) dropped.delete(d);
    set(k, v);
  }
  set("CREWHAUS_TRACE", "json");
  set("CREWHAUS_COST_TRACKING", "1");
  for (const [k, v] of Object.entries(input.extra ?? {})) set(k, v);

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
  return {
    env,
    envFiles: chain.files,
    envFileRefs: chain.refs,
    overrides,
    dropped: [...dropped].sort(),
  };
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
  /**
   * The brief a crew run consumes on stdin, as a file path.
   *
   * Crew is the one shape whose INPUT is a document rather than a message:
   * its compiled bundle reads stdin and exits 2 without it. Passing a path
   * (not the text) keeps a brief out of argv, which every process on this
   * machine can read, and lets a detached run keep reading after the manager
   * that started it has gone.
   */
  readonly briefFile?: string;
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
  /** The full chain including declared-but-absent shared files, so a manager
   *  can render the merged-spawn-env story rather than a bare filename list. */
  readonly envFileRefs: readonly EnvFileRef[];
  readonly overrides: readonly EnvOverride[];
  readonly detached: boolean;
  /** `pipe` for attached runs, `file` for detached daemons. */
  readonly stdio: "pipe" | "file";
  /** File the child's stdin is read from — a crew brief. */
  readonly stdinFile?: string;
  readonly launchMode: "interpreter" | "compiled" | "cli-verb";
  /** True only for interpreter launches — the compiled bundle cannot resume,
   *  and the Run controls must say Fresh rather than pretend. */
  readonly canResume: boolean;
  /** Whether the supervision policy may auto-restart this run. */
  readonly supervised: boolean;
  readonly entry: string;
  readonly bundleDir: string;
  /** The spec a launch from source runs (`interpreter`, `cli-verb`). */
  readonly specPath?: string;
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
  readonly remedy: "compile" | "add-spec" | "install-cli" | "submit-brief";
  constructor(message: string, remedy: "compile" | "add-spec" | "install-cli" | "submit-brief") {
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
  const { env, envFiles, envFileRefs, overrides } = buildSpawnEnv({
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
    envFileRefs,
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
      specPath,
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
      specPath,
    };
  }

  if (bundle === undefined) {
    throw new SpawnPlanError(
      `no compiled bundle for ${input.target} — expected ${entryFileFor(input.target)} under dist/ or build/`,
      "compile",
    );
  }
  // Crew reads a BRIEF on stdin and exits 2 without one. Refusing at plan
  // time is what stops a supervised start from spawning a process that is
  // guaranteed to die — which, before the class was corrected, walked the
  // crash-backoff ladder into `crash-looping` and made a crew harness
  // effectively unsupervisable.
  if (readsBriefOnStdin(input.target) && input.briefFile === undefined) {
    throw new SpawnPlanError(
      "a crew bundle reads its brief on stdin — start it with `crewhaus daemon submit <dir> --brief-file <file>` (or run `bun dist/daemon.ts < brief.md` by hand)",
      "submit-brief",
    );
  }
  const detached = runClass !== "interactive";
  return {
    ...base,
    // The daemon reads no env file itself: the filtered chain in `env` is all it gets
    // from the harness's files, and what it starts inherits only that.
    argv: [bunBin, "--no-env-file", bundle.entryPath],
    detached,
    ...(input.briefFile !== undefined ? { stdinFile: input.briefFile } : {}),
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
  const argv = plan.argv.map(shellQuote);
  return `cd ${shellQuote(plan.cwd)} && ${argv.join(" ")}`;
}

/**
 * POSIX single-quoting — the only quoting that is actually safe.
 *
 * Inside single quotes the shell expands NOTHING, so `$(…)`, backticks,
 * `${…}`, `;`, `|`, `&`, `(`, `)` and whitespace are all inert. The one
 * character that cannot appear is `'` itself, which is closed, escaped, and
 * reopened (`'\''`) — the standard idiom.
 *
 * This matters because the twin is presented as "the exact command an
 * operator could paste": a harness directory is an attacker-influenceable
 * name on a shared mount or in a cloned repo, and a conditional quote (only
 * when the value contains a space) or a JSON double-quote leaves every
 * expansion live. Quoting is therefore UNCONDITIONAL — a twin that is
 * uglier than it needs to be is strictly better than one that runs
 * something else.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** True when `path` is inside `root` (lexical check on already-resolved
 *  paths; the server's realpath containment stays the security boundary). */
export function isInside(root: string, path: string): boolean {
  const r = resolve(root);
  const p = isAbsolute(path) ? resolve(path) : resolve(root, path);
  // `relative()` rather than a string prefix, because a hardcoded "/" is
  // wrong on Windows: `resolve` returns `D:\a\b\c`, which never startsWith
  // `D:\a\b/`, so EVERY genuinely-inside path read as outside. That failed
  // CLOSED — the manager refused legitimate reads rather than allowing
  // illegitimate ones — but it broke the feature wholesale, and the sibling
  // case it exists to reject (`/a/bc` under `/a/b`) is exactly what a naive
  // prefix test gets wrong in the OTHER direction on POSIX.
  const rel = relative(r, p);
  if (rel === "") return true; // the root itself
  if (rel.startsWith("..")) return false; // above, or a sibling
  return !isAbsolute(rel); // a different drive on Windows
}
