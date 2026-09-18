/**
 * The one place this package crosses a boundary: asking `git` for a diff.
 *
 * `DiffLint` can be handed diff text directly, and a caller that already has
 * the patch should do exactly that. But the common case is "lint what I am
 * about to commit", and making the caller shell out, capture, and pass a
 * megabyte of patch back through a context window to get an answer about it
 * is the waste the deterministic tools exist to remove. So this module
 * spawns git, under the same two invariants `@crewhaus/tool-git` uses:
 *
 *  1. Containment. The directory git runs in is resolved against the
 *     workspace root and refused if it escapes, symlinks included (see
 *     `./paths`). Pathspecs are checked separately, because git resolves
 *     those itself and would happily walk out of the workspace.
 *  2. Boundedness. Every spawn has a deadline and forwards the caller's abort
 *     signal, and stdout is read under a cap while the pipe keeps draining —
 *     a git whose output nobody reads blocks forever, deadline or no.
 *
 * This is a deliberate second copy of tool-git's runner rather than an
 * import: `@crewhaus/tool-git` publishes its tools, not its spawn helper, and
 * a dependency on a package for one unexported function would be worse than
 * seventy lines that do one thing. What is NOT copied twice is the diff
 * parser — that one comes from `@crewhaus/tool-text`, because two parsers
 * mean two line numberings and one of them is wrong.
 */
import { statSync } from "node:fs";
import * as path from "node:path";
import { ToolPermissionError, resolveSafe } from "./paths";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
/** Largest patch this package will read, from a spawn or from the caller. */
export const MAX_DIFF_CHARS = 8_000_000;
/** Grace period for draining a pipe whose writer was killed on the deadline. */
const DRAIN_GRACE_MS = 500;

export type Refusal = { readonly ok: false; readonly message: string };
export type Resolved<T> = { readonly ok: true; readonly value: T } | Refusal;

export const refuse = (message: string): Refusal => ({ ok: false, message });

/** How much of an offending value an error message repeats back. */
const ECHO_CHARS = 80;
const echo = (value: string): string =>
  value.length > ECHO_CHARS ? `${value.slice(0, ECHO_CHARS)}…` : value;

/**
 * Refuse a caller value that git would read as an option rather than as data
 * (CWE-88, argument injection).
 *
 * An argv array keeps a caller away from the shell; it does not keep them
 * away from git's own option parser. `git diff --output=<file>` writes
 * anywhere on the disk, which defeats containment entirely, and no legal
 * revision expression begins with `-`, so refusing the shape costs nothing.
 */
export function checkRefArgs(
  toolName: string,
  values: ReadonlyArray<string | undefined>,
): Refusal | undefined {
  for (const value of values) {
    if (value === undefined) continue;
    if (value.startsWith("-")) {
      return refuse(
        `${toolName} refused "${echo(value)}": a ref or range may not begin with "-", because git would read it as an option rather than as a name.`,
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

/**
 * Validate the pathspecs a caller wants to limit the diff to.
 *
 * git resolves a pathspec relative to the directory it runs in, so an
 * absolute one, or one with `..`, reaches outside the workspace without ever
 * passing through `resolveSafe`. A leading `:` is refused too: that is git's
 * pathspec magic, and `:/` means "from the top of the repository".
 */
export function checkPathspecs(
  toolName: string,
  paths: ReadonlyArray<string>,
  cwdAbs: string,
): Refusal | undefined {
  for (const spec of paths) {
    if (spec === "") return refuse(`${toolName} refused an empty path filter.`);
    if (path.isAbsolute(spec) || spec.split(/[\\/]/).includes("..") || spec.startsWith(":")) {
      return refuse(
        `${toolName} refused the path filter "${echo(spec)}": pathspecs must be relative to the working directory, without ".." or git pathspec magic.`,
      );
    }
    try {
      // An absolute path is fine here: `resolveSafe` resolves it as written
      // and then decides containment, which is exactly the question.
      resolveSafe(toolName, path.join(cwdAbs, spec));
    } catch {
      return refuse(
        `${toolName} refused the path filter "${echo(spec)}": it resolves outside the workspace root.`,
      );
    }
  }
  return undefined;
}

export type GitRun = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
};

/**
 * Read a pipe into a string that can never exceed `cap` characters.
 *
 * The obvious `new Response(stream).text()` buffers everything before
 * anything can be capped, so a diff of a vendored tree would be in memory
 * whole before a single character was dropped. This keeps the first `cap`
 * characters and goes on draining: the writer never blocks on a full pipe,
 * the exit code stays truthful, and memory is bounded by the cap.
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
 * A killed git can leave a grandchild holding the write end open, in which
 * case the read never ends. A given-up read is reported as truncated rather
 * than passed off as "git printed nothing".
 */
async function drain(
  pending: Promise<{ text: string; truncated: boolean }>,
): Promise<{ text: string; truncated: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DRAIN_GRACE_MS);
  });
  try {
    const settled = await Promise.race([pending.catch(() => null), fallback]);
    return settled === null ? { text: "", truncated: true } : settled;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Flags applied before the subcommand. A pager or ANSI colour would be
 * unparseable and would depend on the operator's config; `core.quotepath=false`
 * keeps a non-ASCII filename from coming back octal-escaped.
 */
const GLOBAL_ARGS: ReadonlyArray<string> = [
  "--no-pager",
  "-c",
  "core.quotepath=false",
  "-c",
  "color.ui=false",
];

/** Run git once, bounded by a deadline and the caller's abort signal. */
export async function runGit(
  args: ReadonlyArray<string>,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; maxOutputChars?: number },
): Promise<GitRun> {
  const cap = opts.maxOutputChars ?? MAX_DIFF_CHARS;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", ...GLOBAL_ARGS, ...args], {
      cwd: opts.cwd,
      env: {
        ...process.env,
        // LC_ALL=C pins git's own diagnostics to one language, so the message
        // this module matches on does not change with the operator's locale.
        LC_ALL: "C",
        GIT_TERMINAL_PROMPT: "0",
        // A read must never contend for the index lock with a sibling run.
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
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
    // Both pipes are read concurrently with the wait on exit: a git that
    // fills one pipe while nobody reads it blocks forever.
    const stdoutRead = readCapped(proc.stdout as ReadableStream<Uint8Array>, cap);
    const stderrRead = readCapped(proc.stderr as ReadableStream<Uint8Array>, 8_000);
    const code = await proc.exited;
    const [out, err] = await Promise.all([drain(stdoutRead), drain(stderrRead)]);
    return { code, stdout: out.text, stderr: err.text, timedOut, truncated: out.truncated };
  } finally {
    clearTimeout(timer);
  }
}

export type DiffRequest = {
  readonly cwd?: string;
  readonly ref?: string;
  readonly range?: string;
  readonly staged?: boolean;
  readonly paths?: ReadonlyArray<string>;
  readonly timeout?: number;
};

export type CollectedDiff = {
  readonly diff: string;
  readonly truncated: boolean;
  readonly command: string;
};

/**
 * Ask git for the change set, as `-U0` unified diff text.
 *
 * `-U0` because this tool reads added lines and nothing else: context lines
 * are bytes nobody here looks at, and on a large change set they are most of
 * the patch. `--no-ext-diff` because a repository-configured external diff
 * driver can print anything at all, which would make the result depend on
 * local config.
 *
 * Every failure comes back as a sentence, never a throw: a caller mistake —
 * a ref that does not exist, a directory that is not a repository — is normal
 * traffic for this tool, and a model recovers from a sentence.
 */
export async function collectDiff(
  toolName: string,
  request: DiffRequest,
  signal?: AbortSignal,
): Promise<Resolved<CollectedDiff>> {
  if (request.ref !== undefined && request.range !== undefined) {
    return refuse(
      `${toolName} takes either \`ref\` or \`range\`, not both — a range already names both endpoints.`,
    );
  }
  const badRef = checkRefArgs(toolName, [request.ref, request.range]);
  if (badRef !== undefined) return badRef;

  let cwd: string;
  try {
    cwd = resolveSafe(toolName, request.cwd ?? ".").real;
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return refuse(
        `${toolName} refused the directory "${request.cwd ?? "."}": it resolves outside the workspace root. Pass a path inside the working directory.`,
      );
    }
    throw err;
  }
  let isDir = false;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return refuse(`${toolName} refused "${request.cwd ?? "."}": it is not an existing directory.`);
  }

  const paths = request.paths ?? [];
  const badPath = checkPathspecs(toolName, paths, cwd);
  if (badPath !== undefined) return badPath;

  const args = [
    "diff",
    "--no-ext-diff",
    "-U0",
    ...(request.staged === true ? ["--cached"] : []),
    ...(request.range !== undefined ? [request.range] : []),
    ...(request.ref !== undefined ? [request.ref] : []),
    ...(paths.length > 0 ? ["--", ...paths] : []),
  ];
  const timeoutMs = Math.min(request.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const run = await runGit(args, {
    cwd,
    timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  });

  if (run.timedOut) {
    return refuse(
      `${toolName} timed out: \`git ${args.join(" ")}\` did not finish in ${timeoutMs}ms and was killed. Narrow the change set with \`paths\`, or raise \`timeout\`.`,
    );
  }
  if (run.code === 127) return refuse(`${toolName} could not run git. ${run.stderr.trim()}`);
  if (run.code !== 0) {
    const detail = (run.stderr.trim() === "" ? run.stdout : run.stderr).trim();
    // The two failures a caller can actually act on are worth naming, because
    // "exit 128" sends them looking for the wrong problem.
    if (/not a git repository/i.test(detail)) {
      return refuse(
        `${toolName} refused "${request.cwd ?? "."}": it is not a git repository. Pass \`diff\` text instead, or run from inside a checkout.`,
      );
    }
    if (/unknown revision|bad revision|ambiguous argument/i.test(detail)) {
      return refuse(
        `${toolName} could not resolve ${request.range ?? request.ref ?? "the requested revision"}: ${detail.split("\n")[0] ?? detail}`,
      );
    }
    return refuse(
      `${toolName} failed (git exit ${run.code}): ${detail === "" ? "no output" : detail}`,
    );
  }

  return {
    ok: true,
    value: {
      diff: run.stdout,
      truncated: run.truncated,
      command: `git ${args.join(" ")}`,
    },
  };
}
