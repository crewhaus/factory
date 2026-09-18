/**
 * The half of this package that touches the world: resolving a caller-supplied
 * directory, spawning a project's own toolchain, and turning a failed run into
 * a sentence a model can act on.
 *
 * Three invariants live here, and every tool in `./index` goes through them.
 *
 * 1. Containment. Every caller-supplied path — the directory to run in, a file
 *    filter, a coverage report — is resolved through `./paths` and refused if
 *    it lands outside the workspace root, symlinks included (CWE-59).
 * 2. Argument safety. Nothing is ever handed to a shell: argv is an ARRAY.
 *    That stops a caller reaching `sh`, but not a program's own option parser,
 *    so every caller value that lands in argv as a bare word is either refused
 *    when it starts with `-` (CWE-88) or placed after a `--` terminator. The
 *    bug this rule exists for shipped once already: a branch name of "-D" was
 *    read by git as an option and deleted a branch.
 * 3. Boundedness. Every spawn carries a deadline and forwards the caller's
 *    abort signal, and output is capped as it is READ, so a runner that prints
 *    a gigabyte costs a bounded amount of memory rather than the whole of it.
 */
import { statSync } from "node:fs";
import * as path from "node:path";
import { ToolPermissionError, resolveSafe } from "./paths";

/** Default wall-clock budget for one toolchain invocation. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Ceiling the schemas enforce, so no caller can ask for an unbounded wait. */
export const MAX_TIMEOUT_MS = 900_000;
/** How much of a single command's stdout is kept. */
export const MAX_OUTPUT_CHARS = 400_000;
/**
 * How much of a single command's stderr is kept.
 *
 * The same size as stdout, deliberately: `bun test` writes its ENTIRE report
 * to stderr, and so do several formatters, so a smaller stderr cap would cut
 * the very output these tools exist to parse. Memory stays bounded because
 * both streams are capped as they are read.
 */
export const MAX_STDERR_CHARS = MAX_OUTPUT_CHARS;
/** Grace for draining a pipe whose writer was killed on the deadline. */
const DRAIN_GRACE_MS = 750;
/** Grace between the deadline's SIGTERM and the SIGKILL that follows it. */
const KILL_GRACE_MS = 2_000;

/** A refusal carrying the sentence to return to the caller. */
export type Refusal = { readonly ok: false; readonly message: string };
export type Resolved<T> = { readonly ok: true; readonly value: T } | Refusal;

export const refuse = (message: string): Refusal => ({ ok: false, message });

/** Compact JSON — the reader is a model, not a person, so no indentation. */
export const json = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------------
// containment

/**
 * Resolve a caller-supplied directory inside the workspace and confirm it
 * exists. Defaults to the working directory, matching every other tool
 * package here, so a harness that trusts one boundary gets the same one.
 */
export function resolveDir(toolName: string, rel: string | undefined): Resolved<string> {
  const requested = rel ?? ".";
  let real: string;
  try {
    real = resolveSafe(toolName, requested).real;
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return refuse(
        `${toolName} refused the path "${requested}": it resolves outside the workspace root. Pass a path inside the working directory.`,
      );
    }
    throw err;
  }
  let isDir = false;
  try {
    isDir = statSync(real).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return refuse(`${toolName} refused "${requested}": it is not an existing directory.`);
  return { ok: true, value: real };
}

/** Resolve a caller-supplied file inside the workspace and confirm it exists. */
export function resolveFile(toolName: string, rel: string): Resolved<string> {
  let real: string;
  try {
    real = resolveSafe(toolName, rel).real;
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return refuse(
        `${toolName} refused the path "${rel}": it resolves outside the workspace root. Pass a path inside the working directory.`,
      );
    }
    throw err;
  }
  let isFile = false;
  try {
    isFile = statSync(real).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) return refuse(`${toolName} refused "${rel}": it is not an existing file.`);
  return { ok: true, value: real };
}

/** Resolve a caller-supplied path that may be either a file or a directory. */
export function resolveDirOrFile(toolName: string, rel: string): Resolved<string> {
  let real: string;
  try {
    real = resolveSafe(toolName, rel).real;
  } catch (err) {
    if (err instanceof ToolPermissionError) {
      return refuse(
        `${toolName} refused the path "${rel}": it resolves outside the workspace root. Pass a path inside the working directory.`,
      );
    }
    throw err;
  }
  try {
    statSync(real);
  } catch {
    return refuse(`${toolName} refused "${rel}": nothing exists at that path.`);
  }
  return { ok: true, value: real };
}

/** How much of an offending value an error message repeats back. */
const ECHO_CHARS = 80;

const echo = (value: string): string =>
  value.length > ECHO_CHARS ? `${value.slice(0, ECHO_CHARS)}…` : value;

/**
 * Refuse a caller value that the spawned program would read as an option
 * rather than as data (CWE-88, argument injection).
 *
 * Every value this guards lands in argv as a bare word, and a bare word
 * beginning with `-` is an option to essentially every runner here: `vitest
 * --outputFile=…` writes anywhere on disk, `tsc --outDir=…` emits anywhere,
 * `pytest -p <plugin>` loads code. Where the value is a path the tool also
 * places it after a `--` terminator, but the refusal comes first because a
 * terminator that a future edit drops would silently re-open the hole.
 */
export function checkOptionSafe(
  toolName: string,
  values: ReadonlyArray<string | undefined>,
  what = "value",
): Refusal | undefined {
  for (const value of values) {
    if (value === undefined) continue;
    if (value.startsWith("-")) {
      return refuse(
        `${toolName} refused the ${what} "${echo(value)}": it begins with "-", which the underlying command would read as an option rather than as data. Pass it without the leading dash.`,
      );
    }
    if (/[\0\n\r]/.test(value)) {
      return refuse(
        `${toolName} refused the ${what} "${echo(value.replace(/[\0\n\r]/g, "?"))}": a newline or NUL in an argument is never legitimate here.`,
      );
    }
  }
  return undefined;
}

/**
 * Validate an explicit command a caller supplied in place of detection.
 *
 * The program name itself is the one value that may not be refused for
 * starting with `-` — it must simply not, because `Bun.spawn(["-x"])` would
 * look up a program named `-x`. Arguments after it are the caller's own
 * business: the tool spawns what it is told, exactly as `RunCommand` in
 * `@crewhaus/tool-proc` does, and the containment that matters is the cwd.
 *
 * Because that is arbitrary execution, only the tools this package marks
 * `destructive` (`RunTests`, `RunBuild`, `Format`) take a caller-supplied
 * command. A tool that declares `readOnly` is auto-allowed by the permission
 * engine in auto mode and allowed outright in plan mode, so letting one of
 * those choose the program would hand a model an unreviewed `sh -c`.
 */
export function checkArgv(toolName: string, argv: readonly string[]): Refusal | undefined {
  const program = argv[0];
  if (program === undefined || program === "") {
    return refuse(
      `${toolName} refused an empty command: the first element must be a program name.`,
    );
  }
  if (program.startsWith("-")) {
    return refuse(
      `${toolName} refused the command "${echo(program)}": the first element must be a program name, not an option.`,
    );
  }
  if (/[\0]/.test(argv.join(""))) {
    return refuse(`${toolName} refused a command argument containing a NUL byte.`);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// spawning

export type RunResult = {
  readonly argv: readonly string[];
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when either stream was cut, by the cap or by a pipe that never closed. */
  readonly truncated: boolean;
  /**
   * True when the cut was a pipe still open after the child exited rather
   * than the cap. The two need different advice — one says narrow the run,
   * the other says a grandchild outlived its parent — so they are not
   * collapsed into one flag.
   */
  readonly dropped: boolean;
  readonly timedOut: boolean;
  /** Set when the program could not be started at all (missing binary). */
  readonly spawnError?: string;
};

export type SpawnOptions = {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxOutputChars?: number;
  readonly maxStderrChars?: number;
  readonly env?: Readonly<Record<string, string>>;
};

/**
 * Environment pinned onto every child.
 *
 * Colour is the enemy of a parser: every runner here changes its output when
 * it believes a terminal is attached, so all four of the usual switches are
 * set rather than just the one a given tool happens to honour. `CI=1` makes
 * watch-mode runners (vitest, jest) run once and exit instead of waiting for
 * a keypress that will never come. `LC_ALL=C` pins diagnostics to one
 * language so a message this package matches on does not move with the
 * operator's locale.
 */
const PINNED_ENV: Readonly<Record<string, string>> = {
  CI: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  TERM: "dumb",
  LC_ALL: "C",
  PYTHONIOENCODING: "utf-8",
};

/**
 * Read a pipe into a string that can never exceed `cap` characters.
 *
 * `new Response(stream).text()` buffers everything before anything can be
 * capped, so a test run that prints a gigabyte would be a gigabyte in memory
 * before a single character was dropped. This keeps the first `cap`
 * characters and goes on draining without storing: the writer never blocks on
 * a full pipe, the exit code stays truthful, and memory is bounded by the cap
 * rather than by the child's enthusiasm.
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
 * A killed runner can leave a grandchild (a worker, a watchman) holding the
 * write end open, in which case the read never ends. Giving up is reported
 * rather than passed off as empty output.
 */
async function drain(
  pending: Promise<{ text: string; truncated: boolean } | null>,
): Promise<{ text: string; truncated: boolean; dropped: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DRAIN_GRACE_MS);
  });
  try {
    const settled = await Promise.race([pending, fallback]);
    return settled === null
      ? { text: "", truncated: false, dropped: true }
      : { ...settled, dropped: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Run one command, bounded by a deadline and the caller's abort signal. */
export async function runProcess(argv: readonly string[], opts: SpawnOptions): Promise<RunResult> {
  const cap = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...PINNED_ENV,
    ...opts.env,
  };

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], {
      cwd: opts.cwd,
      env,
      // EOF immediately: a runner that reads stdin must not hang on a
      // terminal that is not there.
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      argv,
      code: 127,
      stdout: "",
      stderr: "",
      truncated: false,
      dropped: false,
      timedOut: false,
      spawnError: message,
    };
  }

  let timedOut = false;
  const term = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already exited between the timer firing and the signal.
    }
  }, opts.timeoutMs);
  // A test runner that traps SIGTERM to print a summary gets its chance, then
  // the signal it cannot trap.
  const hardKill = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, opts.timeoutMs + KILL_GRACE_MS);

  try {
    // Both pipes are read concurrently with the wait on exit: a child that
    // fills one pipe while nobody reads it blocks forever, deadline or no.
    //
    // The `.catch` is attached HERE rather than in `drain`, which does not run
    // until `proc.exited` has resolved: a pipe that errors while the child is
    // still running would otherwise be an unhandled rejection for the whole of
    // that wait, and a runtime configured to treat one as fatal would take the
    // harness down over a broken pipe.
    const stdoutRead = readCapped(proc.stdout as ReadableStream<Uint8Array>, cap).catch(() => null);
    const stderrRead = readCapped(
      proc.stderr as ReadableStream<Uint8Array>,
      opts.maxStderrChars ?? MAX_STDERR_CHARS,
    ).catch(() => null);
    const code = await proc.exited;
    const [out, err] = await Promise.all([drain(stdoutRead), drain(stderrRead)]);
    return {
      argv,
      code,
      stdout: out.text,
      stderr: err.text,
      // A dropped read is a cut result just as much as a capped one, and the
      // caller is told so rather than believing the child printed nothing.
      // stderr counts too: for the runners that report there, it IS the result.
      truncated: out.truncated || out.dropped || err.truncated || err.dropped,
      dropped: out.dropped || err.dropped,
      timedOut,
    };
  } finally {
    clearTimeout(term);
    clearTimeout(hardKill);
  }
}

// ---------------------------------------------------------------------------
// result shaping

/** The last `n` non-empty lines of a stream, for a short failure excerpt. */
export function tailLines(text: string, n: number): string[] {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  return lines.slice(Math.max(0, lines.length - n));
}

/**
 * Render a run that could not even start, or that died on its deadline, as
 * one readable sentence rather than an exception. A missing binary is normal
 * traffic for these tools — not every project has vitest installed — and a
 * model recovers from a sentence far better than from a stack trace.
 */
export function spawnFailure(toolName: string, run: RunResult): string | undefined {
  if (run.spawnError !== undefined) {
    return `${toolName} could not start \`${run.argv[0]}\`: ${run.spawnError}. Is it installed and on PATH? Pass \`command\` to run a different one.`;
  }
  if (run.timedOut) {
    return `${toolName} timed out: \`${displayCommand(run.argv, path.resolve(process.cwd()))}\` did not finish in time and was killed. Narrow the run or raise \`timeout\`.`;
  }
  return undefined;
}

/** Say why a run's output was cut, when it was. */
export function truncationNote(run: RunResult, cap = MAX_OUTPUT_CHARS): string | undefined {
  if (!run.truncated) return undefined;
  if (run.dropped) {
    return "a pipe was still open when the command exited and the rest of its output was given up on — usually a worker or watcher the runner left behind; re-run it more narrowly";
  }
  return `output capped at ${cap} characters — narrow the run so the important part is not cut`;
}

/**
 * The command as a result should report it.
 *
 * A detected node tool is an ABSOLUTE path into the project's own
 * `node_modules/.bin`, so echoing argv verbatim would put this machine's home
 * directory into every record — and make the same call against the same
 * project produce different bytes on a different machine, which is the one
 * promise this package makes about its output. Arguments under the workspace
 * root are reported relative to it for that reason; anything outside it is
 * left alone, because there the absolute path is the answer.
 */
export function displayCommand(argv: readonly string[], root: string): string {
  const prefix = `${path.resolve(root)}${path.sep}`;
  return argv.map((arg) => (arg.startsWith(prefix) ? relPosix(root, arg) : arg)).join(" ");
}

/** Slash-separated path relative to `root`, stable across operating systems. */
export function relPosix(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return path.sep === "/" ? rel : rel.split(path.sep).join("/");
}
