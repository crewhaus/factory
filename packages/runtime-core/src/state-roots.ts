/**
 * 0.8.0 (design/0.8.0-provability-release.md §1 principle 1, §5.2, §5.3) —
 * where the runtime keeps its own record of a run, and the files that
 * control it. The run hands these roots to permission-engine's
 * runtime-state floor (`EvaluateOptions.protectedRoots`), which no rule can
 * lift: it denies a call that writes inside one. `Bash` and `RunCommand`
 * remain outside what it can see.
 *
 * - The record the gates read as evidence: the session event logs (every
 *   `tool_use` input and `tool_result` output, verbatim — the evidence the
 *   provability gate grounds a claim on and `continuity.proof` resolves),
 *   the tool results the runtime spilled to a file (the whole output a long
 *   fetch grounds on, whose head alone the log holds) and the proof bundles
 *   (the audit artifact). Evidence is checked, never believed, only while
 *   the agent cannot write it: a `Write` that appends a hand-made fetch to
 *   the log would ground any text under any URL.
 * - The files that control the run, which decide what the agent may do
 *   next: the harness's run directory (`.crewhaus/run`: the runfiles, logs
 *   and control files a daemon keeps there), its settings file
 *   (`.crewhaus/settings.json`: permission rules, runtime hooks and the
 *   manager's spawn hooks) and Hangar's directory (the Hangar root, where
 *   `crewhaus hangar` keeps its token and settings) and registry file.
 * - The records a harness's gates and janitors keep: the deploy approvals and
 *   environments, the graders, the judge calibration, the evals, datasets,
 *   retention pins, audit trail, graph checkpoints and advice.
 * - The operator's configuration in the working directory: the environment
 *   files Bun loads there, any file `manager.envFiles` declares, and the
 *   `bunfig.toml` and `.npmrc` there.
 * - A managed run's whole tenants root, and the approvals file beside session
 *   logs that a session directory puts at the working directory.
 * - In a harness's own directory, what its next start runs. Each test here is
 *   the weakest that matches what it protects ({@link Standing}): a directory
 *   that holds a spec keeps `dist`, `build` and `node_modules` as generated
 *   trees; a compiled non-interactive bundle running from there also keeps the
 *   spec and the root `package.json`, `tsconfig.json` and `jsconfig.json`; a
 *   bundle started from inside its own directory keeps its code files, its
 *   manifest and lockfile, its dependencies and the spec's names; a compiled
 *   non-interactive bundle in a directory below keeps that directory and what
 *   lies between it and the working directory. A plain project, a project under
 *   another harness and an interactive target keep editing their own files.
 *
 * CrewHaus's own code still writes all of them; the floor applies to tool
 * calls only.
 *
 * Each root is given every way a path the canonicaliser produces can spell
 * it: absolute as resolved, absolute with symlinks followed (macOS's
 * `/var` → `/private/var`; a root that does not exist yet is followed as far
 * as it does), and workspace-relative when it lies inside the working
 * directory, as resolved and with links followed (what a tool that declares no
 * operative arguments carries, and what the floor compares a directory the
 * call acts beneath with).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_ROOT_DIR } from "@crewhaus/event-log";
import { hangarStateRoots, registryStateFiles } from "@crewhaus/harness-registry";
import { APPROVALS_DIRNAME, DEFAULT_APPROVALS_FILENAME } from "@crewhaus/session-store";
import type { Tenant } from "@crewhaus/tenancy";
import { DEFAULT_ROOT_DIR as TOOL_RESULTS_ROOT_DIR } from "@crewhaus/tool-result-store";
import { protectedRootHolding, rootsBesideStore } from "@crewhaus/tool-safety/fs";

/**
 * The files that control a run, relative to its working directory: the run
 * directory, all of it, and the settings file, exactly that file (its
 * neighbours, such as `settings.json.bak` or `.crewhaus/notes.md`, are not
 * protected).
 */
const CONTROL_FILES: readonly string[] = [
  join(".crewhaus", "run"),
  join(".crewhaus", "settings.json"),
];

/** The records a harness's gates and janitors keep. */
const GATE_RECORDS: readonly string[] = [
  join(".crewhaus", "approvals"),
  join(".crewhaus", "environments.json"),
  join(".crewhaus", "graders"),
  join(".crewhaus", "judge-calibration.json"),
  join(".crewhaus", "evals"),
  join(".crewhaus", "datasets"),
  join(".crewhaus", "retention.json"),
  join(".crewhaus", "audit"),
  join(".crewhaus", "graphs"),
  join(".crewhaus", "advice"),
  // The knowledge-sync marker: exactly that file.
  join(".crewhaus", "knowledge.json"),
];

/** Where the durable-execution idempotency store keeps its records by default. */
const IDEMPOTENCY_DIR = join(".crewhaus", "idempotency");

/**
 * The idempotency store's roots: the default directory, and the directory
 * `CREWHAUS_IDEMPOTENCY_STORE=file:<dir>` names (`@crewhaus/durable-execution`
 * reads the same variable; `file` and `file:` mean the default), resolved
 * against `cwd`. A variable can add a root and never move one.
 */
function idempotencyRoots(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const roots = [resolve(cwd, IDEMPOTENCY_DIR)];
  const raw = env["CREWHAUS_IDEMPOTENCY_STORE"];
  if (raw?.startsWith("file:") === true && raw.length > "file:".length) {
    roots.push(resolve(cwd, raw.slice("file:".length)));
  }
  return roots;
}

/** Every file Bun loads into a process started here, whichever NODE_ENV. */
const ENV_FILES: readonly string[] = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];

/** What Bun and npm read from the working directory of any process. */
const START_CONFIG: readonly string[] = ["bunfig.toml", ".npmrc"];

/** The names a spec goes by at a harness's root. */
const SPEC_NAMES: readonly string[] = ["crewhaus.yaml", "crewhaus.yml"];

/** The trees `crewhaus compile` and a package manager generate at a harness's root. */
const INSTALLED_TREES: readonly string[] = ["dist", "build", "node_modules"];

/** What a compiled non-interactive harness reads when it starts or compiles again. */
const COMPILED_INPUTS: readonly string[] = [
  ...SPEC_NAMES,
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
];

/**
 * The name `crewhaus compile` stamps in the manifest beside a bundle's entry.
 * Mirrors `BUNDLE_MANIFEST_NAME` in `@crewhaus/harness-supervisor`, which this
 * package does not depend on; a test holds the two equal.
 */
export const COMPILED_BUNDLE_NAME = "crewhaus-compiled-bundle";

/** The spec's own `target:` line. */
const TARGET_LINE = /^target:\s*["']?([A-Za-z-]+)/m;

/** The spellings of a code file's name, which all stand for one module. */
const CODE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
];

/** A bundle's code, at the top of the directory it runs from. */
const BUNDLE_CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** A lockfile at the top of the directory a bundle runs from. */
const BUNDLE_LOCK = /\.lock$/;

/**
 * What a bundle resolves its modules and installs its dependencies from, whether
 * or not each exists yet. Other JSON at the top of its directory is an agent's
 * own data: `crewhaus compile` emits no other JSON file there.
 */
const BUNDLE_CONFIG: readonly string[] = [
  "node_modules",
  "tsconfig.json",
  "jsconfig.json",
  "package.json",
];

/** The lockfile a bundle's install reads, whether or not it exists yet. */
const BUNDLE_LOCKFILES: readonly string[] = ["bun.lock", "bun.lockb"];

/** The header a target's emitter writes at the top of a bundle's entry. */
const ENTRY_TARGET = /^\/\/ Source spec: .*\(target: ([A-Za-z-]+),/m;

/**
 * The gate records a tool keeps its own store in, through a format of its own:
 * `DatasetPut` adds a version to `.crewhaus/datasets` and `EvalBaselinePin` a
 * pin to `.crewhaus/evals` ({@link relocatingFieldLeftOut}). Written out, so a
 * root added later is the floor's until someone puts it here on purpose.
 */
const TOOL_STORES: readonly string[] = [join(".crewhaus", "datasets"), join(".crewhaus", "evals")];

/** `path` with every symlink on its existing part followed, or `undefined` when nothing of it exists. */
function followed(path: string): string | undefined {
  const rest: string[] = [];
  let head = path;
  for (let depth = 0; depth < 256; depth += 1) {
    try {
      const real = realpathSync(head);
      // Rebuilt one name at a time: the list is never spread into join.
      return rest.reduceRight((built, name) => join(built, name), real);
    } catch {
      const parent = dirname(head);
      if (parent === head) return undefined;
      rest.push(basename(head));
      head = parent;
    }
  }
  return undefined;
}

/** Is `inner` `outer` itself, or inside it? */
function within(inner: string, outer: string): boolean {
  const rel = relative(outer, inner);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** `path` relative to `cwd` when it lies strictly inside it. */
function insideSpelling(cwd: string, path: string): string | undefined {
  const rel = relative(cwd, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    ? rel
    : undefined;
}

/** The run's record, unspelled: its session logs, spilled tool results and proof bundles. */
function recordRootPaths(
  sessionRootDir: string | undefined,
  tenant: Tenant | undefined,
  cwd: string,
): string[] {
  const sessions = resolve(cwd, sessionRootDir ?? DEFAULT_ROOT_DIR);
  const toolResults = resolve(cwd, tenant?.toolResultRoot ?? TOOL_RESULTS_ROOT_DIR);
  const proofs =
    tenant !== undefined
      ? resolve(cwd, tenant.sessionRoot, "..", "proofs")
      : resolve(cwd, ".crewhaus", "proofs");
  return [sessions, toolResults, proofs];
}

/**
 * The directory a managed run's tenants live under, when the session root has
 * the shape `buildTenant` gives it (`<tenantsRoot>/<id>/sessions`). An override
 * puts it somewhere else, and its parent is then no tenants root.
 */
function tenantsRootPaths(tenant: Tenant | undefined, cwd: string): string[] {
  if (tenant === undefined) return [];
  const sessions = resolve(cwd, tenant.sessionRoot);
  return basename(sessions) === "sessions" && basename(dirname(sessions)) === tenant.id
    ? [resolve(sessions, "..", "..")]
    : [];
}

/**
 * The files `manager.envFiles` declares in `<cwd>/.crewhaus/settings.json`,
 * resolved against `cwd`. Tolerant as the supervisor's own reader is, and equal
 * to it (a test holds the two together): a missing or malformed file, a key of
 * the wrong type and a bad entry each read as nothing.
 */
export function declaredEnvFiles(cwd: string): string[] {
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(resolve(cwd, ".crewhaus", "settings.json"), "utf8"));
  } catch {
    return [];
  }
  if (typeof settings !== "object" || settings === null) return [];
  const manager = (settings as Record<string, unknown>)["manager"];
  if (typeof manager !== "object" || manager === null || Array.isArray(manager)) return [];
  const declared = (manager as Record<string, unknown>)["envFiles"];
  if (!Array.isArray(declared)) return [];
  return declared
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => resolve(cwd, entry));
}

/**
 * What the working directory is to this process, which decides how much of it
 * is the harness's own installation rather than a project the run was asked to
 * edit. The same files can be both, so each answer is the weakest test that
 * matches what it protects.
 */
type Standing = {
  /**
   * A spec sits at the working directory. Its `dist`, `build` and
   * `node_modules` are generated or installed, and a tool that works on the
   * directory recompiles or installs rather than editing them by hand. A
   * project with no spec keeps them as ordinary directories.
   */
  readonly holdsSpec: boolean;
  /**
   * The process is a compiled non-interactive bundle of that spec: its entry
   * lies inside the working directory and not under `node_modules`, and the
   * spec's `target:` is present and is neither `cli` nor `browser`. The
   * directory is then this harness's installation alone, so the spec and the
   * root `package.json`, `tsconfig.json` and `jsconfig.json` are its compiled
   * inputs. An interactive target keeps editing them, as its project's files.
   */
  readonly compiledDaemon: boolean;
  /**
   * The bundle this process started from, by names relative to the working
   * directory, when the manifest `crewhaus compile` stamps sits beside the
   * entry. A directory below the working directory is named whole; when the
   * entry is a non-interactive target's, so are the spec's names at the working
   * directory and the dependencies, manifest and resolver config of each
   * directory from the bundle's parent up to it, and an interactive target's
   * bundle leaves its project to the rules. A bundle started from inside itself
   * has no spec beside it, so the manifest is the test: its dependencies, its
   * manifest, its lockfile, its resolver config and the spec's names are named,
   * whether or not each exists, with the code files and lockfiles at the top of
   * the directory present when the run starts and every other spelling of each
   * code file's name (`agent.js` and `agent.js.ts` for `agent.ts`). A file an
   * agent adds there for its own notes or data, such as `state.json`, stays the
   * rules' to decide. An interactive target in its own directory names nothing
   * here.
   */
  readonly ownBundle: readonly string[];
};

/**
 * The answers so far, by working directory and entry. Answered once per
 * process: a child loop computes its roots again, and a call that moves the
 * spec does not change the answer for the rest of the process.
 */
const STANDINGS = new Map<string, Standing>();

/** `entry` relative to the working directory, when it really lies inside it and not under `node_modules`. */
function entryInside(cwd: string, entry: string | undefined): string | undefined {
  if (entry === undefined) return undefined;
  let real: string;
  try {
    // A compiled binary's virtual entry has no real path, and lies in no directory here.
    real = realpathSync(entry);
  } catch {
    return undefined;
  }
  const rel = insideSpelling(followed(cwd) ?? cwd, real);
  return rel === undefined || rel.split(sep).includes("node_modules") ? undefined : rel;
}

/** The `target:` of the spec at `cwd`, in the order the supervisor finds a spec. */
function specTarget(cwd: string): string | undefined {
  for (const name of SPEC_NAMES) {
    let source: string;
    try {
      source = readFileSync(join(cwd, name), "utf8");
    } catch {
      continue;
    }
    return TARGET_LINE.exec(source)?.[1];
  }
  return undefined;
}

/** Does the manifest in `dir` carry the name `crewhaus compile` stamps? */
function holdsBundleManifest(dir: string): boolean {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return (
      typeof manifest === "object" &&
      manifest !== null &&
      (manifest as Record<string, unknown>)["name"] === COMPILED_BUNDLE_NAME
    );
  } catch {
    return false;
  }
}

/**
 * Is the entry a non-interactive target's? Its header names the target; an entry
 * with no such header goes by the file name the daemon targets give it.
 */
function entryNonInteractive(cwd: string, entryRel: string): boolean {
  let source: string;
  try {
    source = readFileSync(join(cwd, entryRel), "utf8");
  } catch {
    return false;
  }
  const target = ENTRY_TARGET.exec(source)?.[1];
  return target !== undefined
    ? target !== "cli" && target !== "browser"
    : basename(entryRel) === "daemon.ts";
}

/** {@link Standing.ownBundle} for a bundle in `dir`, a directory below the working directory. */
function bundleBelowNames(dir: string, nonInteractive: boolean): readonly string[] {
  if (!nonInteractive) return [dir];
  const names = new Set([dir, ...SPEC_NAMES]);
  let at = dir;
  do {
    at = dirname(at);
    for (const name of BUNDLE_CONFIG) names.add(join(at, name));
  } while (at !== ".");
  return [...names];
}

/** {@link Standing.ownBundle}, for an entry at `entryRel` in `cwd`. */
function ownBundleNames(cwd: string, entryRel: string, compiledDaemon: boolean): readonly string[] {
  const dir = dirname(entryRel);
  if (!holdsBundleManifest(join(cwd, dir))) return [];
  if (dir !== ".") {
    return bundleBelowNames(dir, compiledDaemon || entryNonInteractive(cwd, entryRel));
  }
  const names = new Set([...BUNDLE_CONFIG, ...BUNDLE_LOCKFILES, ...SPEC_NAMES]);
  try {
    for (const file of readdirSync(cwd, { withFileTypes: true })) {
      if (!file.isFile()) continue;
      if (BUNDLE_LOCK.test(file.name)) names.add(file.name);
      if (!BUNDLE_CODE.test(file.name)) continue;
      names.add(file.name);
      const stem = file.name.slice(0, file.name.lastIndexOf("."));
      for (const extension of CODE_EXTENSIONS) {
        names.add(`${stem}${extension}`);
        names.add(`${stem}.js${extension}`);
      }
      names.add(`${stem}.js.json`);
    }
  } catch {
    // An unreadable directory lists no files; the names above still hold.
  }
  return [...names];
}

/** {@link Standing}, read from the disk the first time and remembered after. */
function standingOf(cwd: string, entry: string | undefined): Standing {
  const key = `${cwd}\0${entry ?? ""}`;
  const known = STANDINGS.get(key);
  if (known !== undefined) return known;
  const holdsSpec = SPEC_NAMES.some((name) => existsSync(join(cwd, name)));
  const entryRel = entryInside(cwd, entry);
  const target = entryRel !== undefined && holdsSpec ? specTarget(cwd) : undefined;
  const compiledDaemon = target !== undefined && target !== "cli" && target !== "browser";
  const standing: Standing = {
    holdsSpec,
    compiledDaemon,
    ownBundle:
      entryRel !== undefined && (!holdsSpec || compiledDaemon)
        ? ownBundleNames(cwd, entryRel, compiledDaemon)
        : [],
  };
  STANDINGS.set(key, standing);
  return standing;
}

/** Every way the canonicaliser can spell `root`, added to `into`. */
function addSpellings(into: Set<string>, root: string, cwd: string): void {
  into.add(root);
  const real = followed(root);
  if (real !== undefined) into.add(real);
  const rel = insideSpelling(cwd, root);
  if (rel !== undefined) into.add(rel);
  // A root reached through a link has a workspace-relative name of its own.
  const realRel = real !== undefined ? insideSpelling(followed(cwd) ?? cwd, real) : undefined;
  if (realRel !== undefined) into.add(realRel);
}

/**
 * The runtime-state roots of a run, in these groups.
 *
 * - The run's record: its session-log root (`sessionRootDir` as
 *   `runChatLoop` resolved it — the tenant's, `CREWHAUS_SESSION_DIR`, or
 *   event-log's default), its tool-result spill root (the tenant's
 *   `toolResultRoot`, else `<cwd>/.crewhaus/tool-results`, where the runtime
 *   saves an output too long for the log — `@crewhaus/tool-result-store`) and
 *   its proofs root (the tenant's `proofs/`, else `<cwd>/.crewhaus/proofs`,
 *   where every spec's bundles and artifacts live). With them, a managed
 *   run's whole tenants root, when the tenant has `buildTenant`'s shape, so
 *   the files under it are the operator's and each tenant's own store's.
 * - The files that control the run, against `cwd` whatever the tenant:
 *   `.crewhaus/run` and `.crewhaus/settings.json`, which are the files the
 *   run loads its settings layer and hooks from, and the supervisor keeps
 *   its run files in, both in the harness directory the run works in; the
 *   records a harness's gates and janitors keep; the environment files Bun
 *   loads from there; and its `bunfig.toml` and `.npmrc`. These hold at every
 *   working directory, with or without a spec. Exact files stay exact: a
 *   neighbour such as `.env.example` or `.crewhaus/graders.yaml` is not one.
 * - The approvals file beside session logs a session directory puts at the
 *   working directory or above it. The record's group leaves such a root to
 *   the rules; this one file stays protected. A default run adds nothing.
 * - The files `manager.envFiles` declares ({@link declaredEnvFiles}), read
 *   from the settings file once per call. One that holds the working
 *   directory (a declared `.` or `..`) is left to the rules.
 * - Hangar's directory and registry file: every Hangar root `env` names
 *   (`CREWHAUS_HANGAR_ROOT`, `<registryRoot>/hangar`) and `~/.crewhaus/hangar`
 *   always (`hangarStateRoots` in `@crewhaus/harness-registry`, beside the
 *   `resolveHangarRoot` the CLI and the fleet tools use), and the
 *   `harnesses.json` of `<registryRoot>` and of `~/.crewhaus`
 *   (`registryStateFiles`), so a variable can add a protected root and never
 *   move one. The default follows the home directory (`homedir()`), as the
 *   Hangar server's own fallback does.
 * - The idempotency store's records: `.crewhaus/idempotency`, and the
 *   directory `CREWHAUS_IDEMPOTENCY_STORE=file:<dir>` names. One that holds
 *   the working directory (`file:.`) is left to the rules. `env` is read for
 *   these three variables alone.
 * - What the harness's next start runs, by what the working directory is to
 *   this process ({@link Standing}): `dist`, `build` and `node_modules`; the
 *   compiled inputs; and the bundle the process started from. `entry` is the
 *   process's entry file, `Bun.main` unless a test names another, and the
 *   answer is kept for the life of the process.
 *
 * The floor reads calls that write. A read of the run's record, a spilled
 * output's parts included, goes on as before.
 */
export function runtimeStateRoots(
  sessionRootDir: string | undefined,
  tenant: Tenant | undefined,
  cwd: string = process.cwd(),
  env: Readonly<Record<string, string | undefined>> = process.env,
  entry: string | undefined = (globalThis as { Bun?: { main?: string } }).Bun?.main,
): string[] {
  const sessions = resolve(cwd, sessionRootDir ?? DEFAULT_ROOT_DIR);
  const standing = standingOf(cwd, entry);
  const atCwd = (names: readonly string[]): string[] => names.map((name) => resolve(cwd, name));
  /**
   * Each group of roots, and what becomes of a root that holds the working
   * directory itself. A new kind of root is one more entry here.
   */
  const groups: ReadonlyArray<{
    readonly roots: readonly string[];
    readonly holdingCwd: "skip" | "protect";
  }> = [
    // The run's record. A root that holds the working directory itself (a
    // session dir pointed at the workspace) would refuse every write the
    // agent makes: it is left to the permission rules rather than walled
    // off whole.
    // A tenants root that holds it is left to them the same way.
    {
      roots: [...recordRootPaths(sessionRootDir, tenant, cwd), ...tenantsRootPaths(tenant, cwd)],
      holdingCwd: "skip",
    },
    // The files that control the run: the working directory's, whatever the
    // tenant. They lie inside it, so they never hold it.
    {
      roots: [...CONTROL_FILES, ...GATE_RECORDS, ...ENV_FILES, ...START_CONFIG].map((file) =>
        resolve(cwd, file),
      ),
      holdingCwd: "protect",
    },
    // The approvals file of a session root the record's group left out above,
    // and the claims, lock, decision log and key beside it: a planted claim
    // would outrank the file.
    {
      roots: within(cwd, sessions)
        ? [join(sessions, DEFAULT_APPROVALS_FILENAME), join(sessions, APPROVALS_DIRNAME)]
        : [],
      holdingCwd: "protect",
    },
    // A declared `.` or `..` must not wall off the working directory.
    { roots: declaredEnvFiles(cwd), holdingCwd: "skip" },
    // Hangar's directory, every root the environment names and the default, and
    // its registry file. One that holds the working directory stays protected:
    // the floor refuses a run inside Hangar's directory that writes there.
    { roots: [...hangarStateRoots(env), ...registryStateFiles(env)], holdingCwd: "protect" },
    // The idempotency store's records. A `file:<dir>` that holds the working
    // directory is left to the rules rather than walling it off.
    { roots: idempotencyRoots(cwd, env), holdingCwd: "skip" },
    // What the harness's next start runs. Each lies inside the working
    // directory, so none holds it.
    { roots: standing.holdsSpec ? atCwd(INSTALLED_TREES) : [], holdingCwd: "protect" },
    { roots: standing.compiledDaemon ? atCwd(COMPILED_INPUTS) : [], holdingCwd: "protect" },
    { roots: atCwd(standing.ownBundle), holdingCwd: "protect" },
  ];
  const roots = new Set<string>();
  for (const group of groups) {
    for (const root of group.roots) {
      if (group.holdingCwd === "skip" && within(cwd, root)) continue;
      addSpellings(roots, root, cwd);
    }
  }
  return [...roots];
}

/**
 * A store's own files as floor entries, each spelled as {@link runtimeStateRoots}
 * spells a root. They are protected FILES (`EvaluateOptions.protectedFiles`):
 * a call that names one, or a path inside one, is refused, but a call that
 * acts beneath a directory holding one is not, so a tool that works on the
 * whole of `.crewhaus/state` keeps working. The continuity store's files are
 * the first.
 */
export function storeFileRoots(paths: readonly string[], cwd: string = process.cwd()): string[] {
  const out = new Set<string>();
  for (const path of paths) addSpellings(out, resolve(cwd, path), cwd);
  return [...out];
}

/**
 * The roots of the run's record alone, spelled as {@link runtimeStateRoots}
 * spells them: where a tool's own store may lie with the floor reading its own
 * format rather than the path ({@link relocatingFieldLeftOut}).
 */
export function runtimeRecordRoots(
  sessionRootDir: string | undefined,
  tenant: Tenant | undefined,
  cwd: string = process.cwd(),
): string[] {
  const roots = new Set<string>();
  for (const root of recordRootPaths(sessionRootDir, tenant, cwd)) {
    if (!within(cwd, root)) addSpellings(roots, root, cwd);
  }
  return [...roots];
}

/**
 * Does the floor leave out this field declared `relocates`? A store the tool
 * reads whole (`beneath`) and a service it is moved off (`url`) are not where
 * it writes, so they stay out. A path is the store the call writes, and it
 * stays out only where that store is the field's own: a session log's field
 * (the one whose default is the session directory, EmitTraceEvent's namespaced
 * `custom.*` lines) in the run's record, or a field whose default is a gate
 * record ({@link TOOL_STORES}: DatasetPut's versions, EvalBaselinePin's pins) in
 * that record, and in no other root. The value is the one the call names, else
 * the field's default, and anything else the floor reads as it reads any path.
 * A link is followed, so a store is placed by where it leads too.
 */
export function relocatingFieldLeftOut(
  arg: {
    readonly field: string;
    readonly kind: string;
    readonly default?: string;
    readonly beneath?: unknown;
  },
  parsedInput: unknown,
  recordRoots: readonly string[],
  roots: readonly string[],
  cwd: string = process.cwd(),
): boolean {
  if (arg.kind !== "path" || arg.beneath !== undefined) return true;
  // A field read out of a nested value is not one this can place.
  if (arg.field.includes(".")) return false;
  const given =
    typeof parsedInput === "object" && parsedInput !== null
      ? (parsedInput as Record<string, unknown>)[arg.field]
      : undefined;
  const store = given === undefined || given === null ? arg.default : given;
  if (typeof store !== "string" || store === "") return false;
  const fieldDefault = arg.default;
  if (fieldDefault === undefined) return false;
  if (TOOL_STORES.some((kept) => resolve(cwd, kept) === resolve(cwd, fieldDefault))) {
    if (protectedRootHolding(store, [fieldDefault], cwd) === undefined) return false;
    return (
      protectedRootHolding(store, rootsBesideStore(fieldDefault, roots, cwd), cwd) === undefined
    );
  }
  // The session directory is the field's own wherever the run has moved it.
  const keepsLogs =
    resolve(cwd, fieldDefault) === resolve(cwd, DEFAULT_ROOT_DIR) ||
    protectedRootHolding(fieldDefault, recordRoots, cwd) !== undefined;
  if (!keepsLogs || protectedRootHolding(store, recordRoots, cwd) === undefined) return false;
  const others = roots.filter((root) => !recordRoots.includes(root));
  return protectedRootHolding(store, others, cwd) === undefined;
}

/**
 * The files a run that answers people other than its operator keeps from its
 * agent's tools, relative to its working directory. Exact names: the rest of
 * `.crewhaus/run`, such as a daemon's status file, stays readable.
 */
const CREDENTIAL_ROOTS: readonly string[] = [
  ".env", // a directory of that name; the file is caught by name too
  join(".crewhaus", "secrets"),
  join(".crewhaus", "identity.json"),
  join(".crewhaus", "run", "control-token"),
  join(".crewhaus", "run", "mcp-token"),
  join(".crewhaus", "run", "gateway-jwt-secret"),
  join(".crewhaus", "run", "logs"),
  join(".crewhaus", "run", "control", "keys"),
];

/**
 * The roots behind permission-engine's `EvaluateOptions.credentialRoots`, spelled
 * as {@link runtimeStateRoots} spells its own: resolved, with links followed, and
 * workspace-relative. A file `manager.envFiles` declares joins them
 * ({@link declaredEnvFiles}), and a declared `.` or `..`, which holds the working
 * directory, is left to the rules. A file named as `isCredentialFileName` matches
 * is found by its name, in any directory, so it needs no root here.
 */
export function credentialFileRoots(cwd: string = process.cwd()): string[] {
  const roots = new Set<string>();
  for (const root of CREDENTIAL_ROOTS) addSpellings(roots, resolve(cwd, root), cwd);
  for (const root of declaredEnvFiles(cwd)) {
    if (!within(cwd, root)) addSpellings(roots, root, cwd);
  }
  return [...roots];
}

/** Set for the whole of a run that answers people other than its operator, nested loops included. */
export const credentialFloorScope = new AsyncLocalStorage<true>();
