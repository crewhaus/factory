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
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

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
  /** Adds GIT_OPTIONAL_LOCKS=0 so a read never contends for the index lock. */
  readonly readOnly?: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputChars?: number;
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
 */
const GLOBAL_ARGS: readonly string[] = [
  "--no-pager",
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=false",
  "-c",
  "advice.detachedHead=false",
];

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

/** Run git once, bounded by a deadline and the caller's abort signal. */
export async function runGit(args: readonly string[], opts: RunOptions): Promise<GitRun> {
  const argv = ["git", ...GLOBAL_ARGS, ...args];
  const cap = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  // LC_ALL=C pins git's own diagnostics to one language, so a message this
  // package matches on does not change with the operator's locale.
  // GIT_TERMINAL_PROMPT=0 guarantees git never blocks waiting on a terminal.
  const env: Record<string, string | undefined> = {
    ...process.env,
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    ...(opts.readOnly === true ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
    ...opts.env,
  };

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

  const top = await runGit(["rev-parse", "--show-toplevel"], {
    cwd,
    timeoutMs,
    readOnly: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (top.code !== 0) {
    if (top.code === 127) return refuse(top.stderr);
    // A killed-on-the-deadline probe says nothing about whether this is a
    // repository, and reporting it as "not a git repository" would send the
    // caller looking for the wrong problem.
    if (top.timedOut) return refuse(failure(toolName, top));
    return refuse(
      `${toolName} refused "${requested}": it is not a git repository (no .git found from there). git said: ${firstLine(top.stderr)}`,
    );
  }
  const root = top.stdout.trim();

  return {
    ok: true,
    value: {
      cwd,
      root,
      timeoutMs,
      ...(signal !== undefined ? { signal } : {}),
      run: (args, opts) =>
        runGit(args, {
          cwd,
          timeoutMs,
          ...(signal !== undefined ? { signal } : {}),
          ...opts,
        }),
    },
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
    return `${toolName} timed out: \`git ${run.args.join(" ")}\` did not finish in time and was killed. Narrow the request or raise \`timeout\`.`;
  }
  const detail = run.stderr.trim() === "" ? run.stdout.trim() : run.stderr.trim();
  return `${toolName} failed (git exit ${run.code}): ${detail === "" ? "no output" : detail}`;
}

/** Append a truncation note when a run's stdout hit the cap. */
export function truncationNote(run: GitRun): string | undefined {
  return run.truncated
    ? `output capped at ${MAX_OUTPUT_CHARS} characters — narrow the request with paths, a range, or a smaller mode`
    : undefined;
}
