/**
 * The half of this package that touches the world: resolving a caller-supplied
 * directory safely, spawning the real `git` binary, and turning a failed run
 * into a sentence a model can act on.
 *
 * Two invariants live here, and every tool in `./index` goes through them.
 *
 * 1. Containment. Every path a caller supplies — the `cwd` to run in, a
 *    pathspec, a new worktree's location — is resolved against the workspace
 *    root and refused if it lands outside, symlinks included. A git tool that
 *    can be pointed at another checkout is as dangerous as one that can be
 *    pointed at /etc/passwd. Containment covers refs as well as paths: a value
 *    that git would read as an option (`--output=…`) escapes the workspace just
 *    as surely as a `..`, so `checkRefArgs` refuses those too.
 * 2. Boundedness. Every spawn carries a deadline and forwards the caller's
 *    abort signal, and every result is capped. A tool that can hang forever, or
 *    return a gigabyte of patch, is a defect.
 *    Containing the `cwd` is not enough, because git works on the repository
 *    it DISCOVERS from there: `openRepo` also proves that repository's working
 *    tree and git dir are the workspace's (C071, see `./repo-bounds`), and
 *    every run carries GIT_CEILING_DIRECTORIES so discovery never climbs above
 *    the workspace root, with the inherited variables that name a repository
 *    (GIT_DIR, GIT_WORK_TREE …) dropped.
 * 3. A read runs no program the repository names (C007). See `./hardening`:
 *    every invocation switches off the fsmonitor hook, signature display and
 *    implicit bare repositories; a read also switches off external diff
 *    drivers, textconv, submodule recursion and the repository's own filter
 *    drivers, and gets the environment without the harness's credentials.
 *
 * This module is also `@crewhaus/tool-git/run`, so tool-changeset's DiffLint
 * spawns git through the same hardened runner instead of a copy of it.
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import { redactUrlCredentialsInText, withoutCredentials } from "@crewhaus/tool-safety/env";
import {
  FILTER_PROBE_ARGS,
  FILTER_PROBE_ARGS_LEGACY,
  HARDENED_CONFIG_ARGS,
  hardenReadArgs,
  neutraliseRepositoryFilters,
} from "./hardening";
import {
  alternateLeadingOut,
  isInside,
  isWorktreeOf,
  linkLeadingOut,
  realOrUndefined,
} from "./repo-bounds";

export {
  HARDENED_CONFIG_ARGS,
  hardenReadArgs,
  neutraliseRepositoryFilters,
  neutralisedNote,
} from "./hardening";

/** Default wall-clock budget for one git invocation. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Ceiling the schemas enforce, so no caller can ask for an unbounded wait. */
export const MAX_TIMEOUT_MS = 600_000;
/** How much of a single command's stdout we are willing to hand back. */
export const MAX_OUTPUT_CHARS = 400_000;
/** Grace period for draining a pipe whose writer was killed on the deadline. */
const DRAIN_GRACE_MS = 500;

/** A refusal carrying the sentence to return to the caller. */
export type Refusal = { readonly ok: false; readonly message: string };
export type Resolved<T> = { readonly ok: true; readonly value: T } | Refusal;

export const refuse = (message: string): Refusal => ({ ok: false, message });

// ---------------------------------------------------------------------------
// containment

/**
 * True when the NAME exists, whether or not it leads anywhere.
 *
 * `existsSync` follows symlinks, so it answers false for a link whose target
 * is missing — and a missing target is exactly the case that matters here: a
 * dangling link is still a door. A walk that probes with it steps straight
 * past the link, treats it as a plain missing leaf, and re-appends the name
 * to the realpath'd parent, so containment is decided on a path the link does
 * not lead to. `lstat` keeps that name in the part that gets RESOLVED.
 */
function nameExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `target` would actually land, with every symlink already followed —
 * including one whose own target does not exist yet.
 *
 * `realpathSync` gives up with ENOENT on a dangling link, so the deepest
 * ancestor that exists as a NAME is resolved, a dangling one is followed a
 * hop by hand, and the missing components are appended. This is the path
 * `git worktree add` would really create, which is the only one worth
 * checking containment against.
 */
function resolveLocation(target: string, depth = 0): string {
  if (depth > 40) throw new Error(`symlink chain at "${target}" is too long to resolve`);
  let probe = target;
  const tail: string[] = [];
  while (!nameExists(probe)) {
    tail.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let probeReal: string;
  try {
    probeReal = realpathSync(probe);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // The name is there but `realpath` cannot finish it: a dangling link.
    // `readlinkSync` throws EINVAL on anything else, which fails closed.
    // Recursing (rather than returning the raw target) resolves an absolute
    // target such as /var/folders/... to its real /private/var/... form, so a
    // legitimate in-workspace dangling link is not wrongly refused.
    const link = readlinkSync(probe);
    // A RELATIVE target resolves against the directory that actually CONTAINS
    // the link, which is not its lexical parent when that parent is itself
    // reached through a symlink. So the parent is made real first.
    const base = realpathSync(path.dirname(probe));
    probeReal = resolveLocation(path.resolve(base, link), depth + 1);
  }
  return tail.length > 0 ? path.join(probeReal, ...tail) : probeReal;
}

/**
 * Resolve `rel` against the workspace root and refuse anything that escapes it.
 *
 * Mirrors the two-stage check the filesystem tools use: a lexical test that
 * rejects `..` and absolute escapes cheaply, then a realpath test that catches
 * an in-root symlink pointing outside (CWE-59). The leaf may not exist yet — a
 * worktree is about to be created there — so the deepest ancestor that EXISTS
 * AS A NAME is resolved and the missing tail re-appended. "As a name" rather
 * than "exists": a dangling link is still followed by whatever creates the
 * path later, so `resolveLocation` follows it here too.
 */
export function resolveInsideRoot(
  toolName: string,
  rel: string,
  root: string = process.cwd(),
): Resolved<string> {
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, rel);
  const deny = (): Refusal =>
    refuse(
      `${toolName} refused the path "${rel}": it resolves outside the workspace root. Pass a path inside the working directory.`,
    );
  if (abs !== rootResolved && !abs.startsWith(`${rootResolved}${path.sep}`)) return deny();
  try {
    const rootReal = realpathSync(rootResolved);
    const real = resolveLocation(abs);
    if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) return deny();
    return { ok: true, value: real };
  } catch {
    return deny();
  }
}

/**
 * Validate the pathspecs a caller wants to limit a command to.
 *
 * git resolves a pathspec relative to the directory it runs in, so an absolute
 * one or one containing `..` would reach outside the workspace even though it
 * never passes through `resolveInsideRoot`. Both are refused outright, and each
 * survivor is additionally resolved to prove it lands inside the root. A
 * leading `:` is refused too: that is git's pathspec-magic prefix (`:(exclude)`,
 * `:/`), and `:/` in particular means "from the top of the repository".
 */
export function checkPathspecs(
  toolName: string,
  paths: readonly string[],
  cwdAbs: string,
): Resolved<string[]> {
  for (const spec of paths) {
    if (spec === "") return refuse(`${toolName} refused an empty path filter.`);
    if (path.isAbsolute(spec) || spec.split(/[\\/]/).includes("..") || spec.startsWith(":")) {
      return refuse(
        `${toolName} refused the path filter "${spec}": pathspecs must be relative to the working directory, without ".." or git pathspec magic.`,
      );
    }
    const inside = resolveInsideRoot(toolName, path.join(cwdAbs, spec));
    if (!inside.ok) return inside;
  }
  return { ok: true, value: [...paths] };
}

/** How much of an offending value an error message repeats back. */
const ECHO_CHARS = 80;

const echo = (value: string): string =>
  value.length > ECHO_CHARS ? `${value.slice(0, ECHO_CHARS)}…` : value;

/**
 * Refuse a caller value that git would read as an option rather than as data
 * (CWE-88, argument injection).
 *
 * Passing an argv array instead of a shell string stops a caller reaching the
 * shell, but it does not stop them reaching git's own option parser: every ref,
 * branch, tag and start-point below lands in argv as a bare word, and a bare
 * word beginning with `-` is an option. That is not cosmetic. `git log
 * --output=<file>` and `git diff --output=<file>` write anywhere on the disk,
 * which defeats containment entirely, and `git branch --force -D <name>` turns
 * "create a branch" into "delete that one" while the tool still reports a
 * success. No legal revision expression starts with `-`, so refusing the whole
 * shape costs a caller nothing.
 *
 * Newlines and NULs are refused for a second reason: git refnames cannot
 * contain them, and one smuggled into a value that is fed to a command reading
 * refs on stdin (`cat-file --batch-check`) would silently shift every later
 * answer onto the wrong ref.
 */
export function checkRefArgs(
  toolName: string,
  values: ReadonlyArray<string | undefined>,
): Refusal | undefined {
  for (const value of values) {
    if (value === undefined) continue;
    if (value.startsWith("-")) {
      return refuse(
        `${toolName} refused "${echo(value)}": a ref, branch or tag name may not begin with "-", because git would read it as an option rather than as a name. Pass the name exactly as GitBranchList, GitTagList or GitLog reports it.`,
      );
    }
    if (/[\0\n\r]/.test(value)) {
      return refuse(
        `${toolName} refused "${echo(value.replace(/[\0\n\r]/g, "?"))}": a ref may not contain a newline or a NUL — git forbids both in a refname.`,
      );
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// spawning

export type GitRun = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when stdout hit `MAX_OUTPUT_CHARS` and was cut. */
  readonly truncated: boolean;
  /** The argv after `git`, for error messages. */
  readonly args: readonly string[];
};

export type RunOptions = {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string;
  /**
   * A read: adds GIT_OPTIONAL_LOCKS=0 so it never contends for the index
   * lock, inserts the read switches of `hardenReadArgs`, and spawns git
   * without the harness's credentials (a read needs none: nothing here talks
   * to a remote or signs).
   */
  readonly readOnly?: boolean;
  /**
   * `-c` pairs placed before the subcommand, after the global ones: the
   * filter drivers `probeRepositoryFilters` switched off for a read.
   */
  readonly configArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputChars?: number;
  /**
   * Let discovery climb above the workspace root. Only `locateRepository`'s
   * probe sets it, so an enclosing repository is found and refused BY NAME
   * rather than reported as "not a git repository"; every other run carries
   * GIT_CEILING_DIRECTORIES, so a `.git` removed after the check cannot
   * hand the next command to an enclosing repository.
   */
  readonly discoverAboveRoot?: boolean;
};

/**
 * Flags applied to every invocation, before the subcommand.
 *
 * - `--no-pager` / `color.ui=false`: a pager or ANSI colour in the output would
 *   be both unparseable and dependent on the user's config.
 * - `core.quotepath=false`: without it git octal-escapes every non-ASCII byte
 *   in a path, so a file named `café.txt` comes back mangled.
 * - `advice.detachedHead=false`: advice text is help for a human at a terminal
 *   and only adds noise to a tool result.
 * - `HARDENED_CONFIG_ARGS`: no fsmonitor hook, no signature program, no
 *   implicit bare repository (see `./hardening`).
 */
export const GLOBAL_ARGS: readonly string[] = Object.freeze([
  "--no-pager",
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=false",
  "-c",
  "advice.detachedHead=false",
  ...HARDENED_CONFIG_ARGS,
]);

/** Ceiling on how much of a run's stderr is kept. */
const MAX_STDERR_CHARS = 8_000;

/**
 * Read a pipe into a string that can never exceed `cap` characters.
 *
 * The obvious `new Response(stream).text()` buffers the entire output before
 * anything can be capped, so a `git show` of a one-gigabyte blob would be a
 * gigabyte in memory before a single character was dropped. This keeps the
 * first `cap` characters and then goes on draining the pipe without storing
 * anything: the writer never blocks on a full pipe, the exit code stays
 * truthful, and the memory is bounded by the cap rather than by the repository.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null | undefined,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  if (stream === null || stream === undefined) return { text: "", truncated: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done === true) break;
      if (truncated) continue;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > cap) {
        text = text.slice(0, cap);
        truncated = true;
      }
    }
    if (!truncated) text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { text, truncated };
}

/**
 * Await a pipe's text, giving up after the grace period instead of hanging.
 *
 * A killed git can leave a grandchild holding the write end of the pipe open,
 * in which case the read never ends. Giving up is reported (`dropped`) rather
 * than passed off as empty output, so the caller is told its result was cut
 * short instead of quietly believing git printed nothing.
 */
async function drain(
  pending: Promise<{ text: string; truncated: boolean }>,
): Promise<{ text: string; truncated: boolean; dropped: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DRAIN_GRACE_MS);
  });
  try {
    const settled = await Promise.race([pending.catch(() => null), fallback]);
    return settled === null
      ? { text: "", truncated: false, dropped: true }
      : { ...settled, dropped: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Environment variables that tell git which repository, work tree, index or
 * object store to use instead of the one it discovers. None of them is ever
 * passed on: the repository is the one openRepo checked.
 */
export const REPOSITORY_LOCATOR_ENV: readonly string[] = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
]);

function withoutRepositoryLocators(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const name of REPOSITORY_LOCATOR_ENV) Reflect.deleteProperty(out, name);
  return out;
}

/**
 * GIT_CEILING_DIRECTORIES for a run: the workspace root's parent, so git
 * looks for a repository in the root and below and never climbs above it.
 */
function discoveryCeiling(): string | undefined {
  const rootReal = realOrUndefined(process.cwd());
  return rootReal === undefined ? undefined : path.dirname(rootReal);
}

/** Run git once, bounded by a deadline and the caller's abort signal. */
export async function runGit(args: readonly string[], opts: RunOptions): Promise<GitRun> {
  const readOnly = opts.readOnly === true;
  const argv = [
    "git",
    ...GLOBAL_ARGS,
    ...(opts.configArgs ?? []),
    ...(readOnly ? hardenReadArgs(args) : args),
  ];
  const cap = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  // LC_ALL=C pins git's own diagnostics to one language, so a message this
  // package matches on does not change with the operator's locale.
  // GIT_TERMINAL_PROMPT=0 guarantees git never blocks waiting on a terminal.
  const ceiling = discoveryCeiling();
  const pinned: Record<string, string> = {
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    ...(readOnly ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
    ...(opts.discoverAboveRoot !== true && ceiling !== undefined
      ? { GIT_CEILING_DIRECTORIES: ceiling }
      : {}),
    ...opts.env,
  };
  // The repository is the one discovered from `cwd` and checked by openRepo,
  // never one an inherited GIT_DIR or GIT_WORK_TREE names (a harness started
  // from a git hook inherits both).
  const inherited = withoutRepositoryLocators(process.env);
  // A write keeps the full environment: a commit may sign through an agent,
  // and its hooks are the repository's, approved with the write.
  const env: Record<string, string | undefined> = readOnly
    ? withoutCredentials(inherited, pinned).env
    : { ...inherited, ...pinned };

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      code: 127,
      stdout: "",
      stderr: `could not start git: ${message}. Is git installed and on PATH?`,
      timedOut: false,
      truncated: false,
      args,
    };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited between the timer firing and the kill.
    }
  }, opts.timeoutMs);

  try {
    // Both pipes are read concurrently with the wait on exit: a git that fills
    // one pipe while nobody reads it blocks forever, deadline or no deadline.
    const stdoutRead = readCapped(proc.stdout as ReadableStream<Uint8Array>, cap);
    const stderrRead = readCapped(proc.stderr as ReadableStream<Uint8Array>, MAX_STDERR_CHARS);
    const code = await proc.exited;
    const [out, err] = await Promise.all([drain(stdoutRead), drain(stderrRead)]);
    return {
      code,
      stdout: out.text,
      stderr: err.text,
      timedOut,
      // A dropped read is a cut result just as much as a capped one, and the
      // caller is told so rather than being handed a silent truncation.
      truncated: out.truncated || out.dropped,
      args,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// repository handle

/** A validated place to run git, plus a bound `run`. */
export type Repo = {
  /** Absolute, containment-checked directory git runs in. */
  readonly cwd: string;
  /** Absolute path of the repository's top level. */
  readonly root: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /**
   * The repository's own filter drivers a read switches off (`filter.<name>`
   * each). Empty for almost every repository; a tool whose result a filter
   * could change says so with `neutralisedNote` when it is not.
   */
  readonly neutralised: readonly string[];
  run(args: readonly string[], opts?: Partial<RunOptions>): Promise<GitRun>;
};

export type RepoInput = {
  readonly cwd?: string;
  readonly timeout?: number;
};

/**
 * Validate the caller's `cwd`, confirm it is inside a git repository, and hand
 * back a handle. Refusing here — by name — is why every tool can say "not a git
 * repository" rather than leaking a raw exit-128 message.
 */
export async function openRepo(
  toolName: string,
  input: RepoInput,
  signal?: AbortSignal,
): Promise<Resolved<Repo>> {
  const timeoutMs = input.timeout ?? DEFAULT_TIMEOUT_MS;
  const requested = input.cwd ?? ".";
  const resolved = resolveInsideRoot(toolName, requested);
  if (!resolved.ok) return resolved;
  const cwd = resolved.value;

  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return refuse(`${toolName} refused "${requested}": it is not an existing directory.`);
  }

  const located = await locateRepository(toolName, requested, cwd, {
    timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!located.ok) return located;
  const root = located.value.root;

  const filters = await probeRepositoryFilters(toolName, cwd, {
    timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!filters.ok) return filters;
  const { configArgs, neutralised } = filters.value;

  return {
    ok: true,
    value: {
      cwd,
      root,
      timeoutMs,
      neutralised,
      ...(signal !== undefined ? { signal } : {}),
      run: (args, opts) =>
        runGit(args, {
          cwd,
          timeoutMs,
          ...(signal !== undefined ? { signal } : {}),
          ...opts,
          // Only a read loses the repository's filters: a write that skipped
          // a clean filter would store the wrong bytes.
          ...(opts?.readOnly === true && configArgs.length > 0 ? { configArgs } : {}),
        }),
    },
  };
}

/**
 * Find the repository git will work on from `cwd`, and refuse it unless it is
 * the workspace's (C071, see `./repo-bounds`). Returns its real top level.
 *
 * One probe asks for the three places git will use. The common dir comes
 * back relative to `cwd` on some layouts, so it is resolved against `cwd`
 * (which also makes `--path-format`, git 2.31+, unnecessary). A refusal names
 * the caller's `cwd` and the reason, never the outside path it led to.
 */
export async function locateRepository(
  toolName: string,
  requested: string,
  cwd: string,
  opts: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<Resolved<{ root: string }>> {
  const probe = await runGit(
    ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
    {
      cwd,
      timeoutMs: opts.timeoutMs,
      readOnly: true,
      discoverAboveRoot: true,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    },
  );
  if (probe.code !== 0) {
    if (probe.code === 127) return refuse(probe.stderr);
    // A killed-on-the-deadline probe says nothing about whether this is a
    // repository, and reporting it as "not a git repository" would send the
    // caller looking for the wrong problem.
    if (probe.timedOut) return refuse(failure(toolName, probe));
    if (/cannot use bare repository/i.test(probe.stderr))
      return refuse(bareRefusal(toolName, requested));
    return refuse(
      `${toolName} refused "${requested}": it is not a git repository (no .git found from there). git said: ${firstLine(probe.stderr)}`,
    );
  }
  const lines = probe.stdout.split("\n").map((l) => l.trim());
  const [topRaw, gitDirRaw, commonRaw] = lines;
  const rootReal = realOrUndefined(process.cwd());
  if (
    rootReal === undefined ||
    topRaw === undefined ||
    topRaw === "" ||
    gitDirRaw === undefined ||
    gitDirRaw === "" ||
    commonRaw === undefined ||
    commonRaw === ""
  ) {
    return refuse(
      `${toolName} refused "${requested}": git did not say where this repository keeps its working tree and history, so it cannot be shown to lie inside the workspace.`,
    );
  }
  const outside = (why: string): Refusal =>
    refuse(
      `${toolName} refused "${requested}": ${why}. The git tools work only on a repository whose working tree and history are inside the workspace root — run the harness from the repository's top level, or give the workspace a repository of its own.`,
    );

  const top = realOrUndefined(topRaw);
  if (top === undefined || !isInside(rootReal, top)) {
    return outside(
      "the git repository it belongs to has its working tree outside the workspace (a repository enclosing the workspace, or one whose core.worktree points out of it)",
    );
  }
  const gitDir = realOrUndefined(gitDirRaw);
  const commonDir = realOrUndefined(path.resolve(cwd, commonRaw));
  if (gitDir === undefined || commonDir === undefined) {
    return outside("its git directory could not be resolved");
  }

  if (isInside(rootReal, gitDir)) {
    if (!isInside(rootReal, commonDir)) {
      // A git dir inside with its history outside is a `commondir` redirect
      // written inside the workspace: git never lays a worktree out that way.
      return outside(
        "its .git directory takes its history from a repository outside the workspace",
      );
    }
    for (const dir of gitDir === commonDir ? [gitDir] : [gitDir, commonDir]) {
      const link = linkLeadingOut(dir, rootReal);
      if (link !== undefined) {
        return outside(`its .git directory holds a link (${link}) leading outside the workspace`);
      }
    }
    if (alternateLeadingOut(commonDir, rootReal) !== undefined) {
      return outside(
        "its object store borrows from a repository outside the workspace (objects/info/alternates)",
      );
    }
    return { ok: true, value: { root: top } };
  }

  // The git dir is outside. Only git's own bookkeeping in that directory,
  // which nothing inside the workspace can write, may tie it to this tree.
  if (isWorktreeOf(gitDir, commonDir, top)) return { ok: true, value: { root: top } };
  if (commonDir === gitDir) {
    const wt = await runGit(
      ["config", "--file", path.join(gitDir, "config"), "--get", "core.worktree"],
      {
        cwd,
        timeoutMs: opts.timeoutMs,
        readOnly: true,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
    );
    const value = wt.code === 0 ? wt.stdout.trim() : "";
    if (value !== "" && realOrUndefined(path.resolve(gitDir, value)) === top) {
      return { ok: true, value: { root: top } };
    }
  }
  return outside(
    "its .git points at a git directory outside the workspace that does not name this directory as its working tree (a linked worktree or submodule does; a planted .git file does not — for a checkout made with --separate-git-dir, set core.worktree in that repository's config)",
  );
}

/** The refusal for a repository directory git found by being run inside it. */
export function bareRefusal(toolName: string, requested: string): string {
  return `${toolName} refused "${requested}": it is a repository directory itself (a bare repository, or a directory laid out like one) that git found by being run inside it. A read-only tool does not run git there, because that directory's own config can name programs git would run. Run it from a working tree instead.`;
}

/**
 * List the filter drivers the repository's own config defines, and the `-c`
 * pairs that switch them off for a read (see `./hardening`). The listing
 * itself runs nothing: reading config executes no helper.
 */
export async function probeRepositoryFilters(
  toolName: string,
  cwd: string,
  opts: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<Resolved<{ configArgs: readonly string[]; neutralised: readonly string[] }>> {
  const runOpts = { cwd, readOnly: true, ...opts };
  let withScope = true;
  let probe = await runGit(FILTER_PROBE_ARGS, runOpts);
  // 129 is git's usage error: a git older than 2.26 has no --show-scope.
  if (probe.code === 129 && /show-scope/.test(probe.stderr)) {
    withScope = false;
    probe = await runGit(FILTER_PROBE_ARGS_LEGACY, runOpts);
  }
  // Exit 1 is "no key matched": no filter configured anywhere.
  if (probe.code === 1 && probe.stdout === "")
    return { ok: true, value: { configArgs: [], neutralised: [] } };
  if (probe.code !== 0 || probe.timedOut || probe.truncated) {
    return refuse(
      `${toolName} could not list this repository's filter configuration, so it cannot promise a read runs no program the repository names: ${
        probe.timedOut
          ? "the listing timed out"
          : probe.truncated
            ? "the listing was cut at the output cap"
            : `git exit ${probe.code}: ${firstLine(probe.stderr)}`
      }`,
    );
  }
  const neutralisation = neutraliseRepositoryFilters(probe.stdout, withScope);
  if (!neutralisation.ok)
    return refuse(`${toolName} refused this repository: ${neutralisation.reason}.`);
  return {
    ok: true,
    value: { configArgs: neutralisation.configArgs, neutralised: neutralisation.neutralised },
  };
}

// ---------------------------------------------------------------------------
// result shaping

/** Compact JSON — the reader is a model, not a person, so no indentation. */
export const json = (value: unknown): string => JSON.stringify(value);

export function firstLine(text: string): string {
  const trimmed = text.trim();
  const nl = trimmed.indexOf("\n");
  return nl === -1 ? trimmed : trimmed.slice(0, nl);
}

/**
 * Render a failed run as one readable sentence rather than throwing. A caller
 * mistake (a ref that does not exist, a branch already checked out) is normal
 * traffic for these tools, and a model recovers from a sentence far better than
 * from a stack trace.
 */
export function failure(toolName: string, run: GitRun): string {
  if (run.timedOut) {
    return redactUrlCredentialsInText(
      `${toolName} timed out: \`git ${run.args.join(" ")}\` did not finish in time and was killed. Narrow the request or raise \`timeout\`.`,
    );
  }
  const detail = run.stderr.trim() === "" ? run.stdout.trim() : run.stderr.trim();
  // git quotes a remote's URL in some errors, userinfo and all; a
  // credential never reaches a result, even inside an error (C051).
  return redactUrlCredentialsInText(
    `${toolName} failed (git exit ${run.code}): ${detail === "" ? "no output" : detail}`,
  );
}

/** Append a truncation note when a run's stdout hit the cap. */
export function truncationNote(run: GitRun): string | undefined {
  return run.truncated
    ? `output capped at ${MAX_OUTPUT_CHARS} characters — narrow the request with paths, a range, or a smaller mode`
    : undefined;
}
