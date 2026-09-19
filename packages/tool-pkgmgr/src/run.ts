/**
 * The one place this package starts a child process, and the seam every test
 * drives instead of the machine.
 *
 * The conventions are `@crewhaus/tool-proc`'s (`src/spawn.ts`) and
 * `@crewhaus/tool-host`'s (`src/run.ts`), copied rather than re-invented —
 * those packages export their tools and not their runners, and reaching past
 * an exports map would be worse than a documented copy:
 *
 *   - ARGV IS AN ARRAY. There is no shell in this package. No `sh -c`, no
 *     `cmd /c`, no interpolated command line, nothing that could turn a
 *     package name into syntax. `assertArgv` refuses anything that would make
 *     that untrue before a process exists.
 *   - EVERY RUN HAS A DEADLINE. SIGTERM at the deadline, SIGKILL after a
 *     grace period, and a bounded drain so a manager that forks (apt-get
 *     forks dpkg; brew forks git) cannot hold the pipe open past its death.
 *   - THE ENVIRONMENT IS PINNED, AND PINNED NON-INTERACTIVE. Every parser
 *     here reads English keywords out of a manager's output, and `apt-cache
 *     policy`, `dnf`, `pacman` and `brew` all translate theirs through
 *     gettext, so `LC_ALL=C` is what makes the bytes the same on a German
 *     laptop and an English CI box. `DEBIAN_FRONTEND=noninteractive` and
 *     `NONINTERACTIVE=1` are the other half: a manager that opens a dialog or
 *     asks a question on a pipe is a command that never exits, and this
 *     package's whole contract is that it does not hang and does not prompt.
 *
 * `_setRunner` replaces all of it. Every parser in this package is fed from
 * output recorded on a real machine, because CI is a Linux container with no
 * package manager at all and this was written on macOS: a parser checked
 * against whatever the test host happens to answer is a parser checked
 * against nothing.
 */

/** Grace between the deadline's SIGTERM and the SIGKILL that follows it. */
const KILL_GRACE_MS = 2_000;
/**
 * A child that forks a grandchild leaves the pipe's write end open after it
 * is gone, so reading to EOF can outlive the process. Bound the drain and
 * return what arrived. `apt-get` and `brew` both do this.
 */
const DRAIN_GRACE_MS = 500;
/**
 * After the SIGKILL, how long to keep waiting for the child to be reaped.
 *
 * tool-proc's `REAP_GRACE_MS`, and here for its reason: SIGKILL cannot be
 * caught, but it cannot interrupt a process wedged in an uninterruptible
 * kernel wait either — and a package manager blocked on a stale NFS mount or
 * a dead network filesystem under `/var/lib` is exactly that shape. Every
 * other bound here is downstream of `await proc.exited`, so without this one
 * a wedged child hangs the tool with no deadline left to save it. (There is
 * no portable way to put a process into that state, so this is the one
 * guarantee here with no test behind it — same as in tool-proc.)
 */
const REAP_GRACE_MS = 1_000;

/**
 * Per-stream cap.
 *
 * `apt-get install -s` on a package with a large dependency closure prints a
 * line per unpacked package, and `brew info --json=v2` for a formula with
 * many bottles is tens of kilobytes. The cap is generous because the flag
 * matters more than the number: a truncated simulation parses perfectly and
 * is simply MISSING packages, so every reader below treats a truncated stream
 * as "could not determine" rather than as the answer.
 */
export const MAX_OUTPUT_CHARS = 512_000;

/** Default per-command deadline. Every command here reads a local index. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
/** Ceiling a caller may raise a deadline to. An install is the slow case. */
export const MAX_COMMAND_TIMEOUT_MS = 600_000;

/** `PATH` for a child when the harness itself has none. */
export const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type RunRequest = {
  /** The program and each argument as separate strings. Never a shell line. */
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  /** Extra pinned variables for this command (see `MANAGER_ENV`). */
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputChars?: number;
  readonly signal?: AbortSignal;
};

export type RunResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /**
   * True when the program itself is not installed (ENOENT on spawn).
   *
   * This is the distinction the whole package turns on: "there is no `dnf` on
   * this host" is a different fact from "`dnf` ran and said the package is
   * not there", and reporting the first as the second is the bug class rule 6
   * names.
   */
  readonly missing: boolean;
  /**
   * The stream hit the cap and what came back is a PREFIX of what the command
   * printed. Optional because a recorded fixture states only what its case is
   * about; absent reads as "not truncated", which a short fixture is.
   */
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
  /** Set when the child outlived even the SIGKILL grace and was left behind. */
  readonly abandoned?: boolean;
};

export type Runner = (request: RunRequest) => Promise<RunResult>;

let runnerOverride: Runner | undefined;

/**
 * Refuse an argv that could not be handed to `execve` as-is.
 *
 * A NUL byte truncates an argument at the syscall boundary: a string that
 * reads as harmless here arrives at the kernel cut short at the NUL, with
 * whatever followed it gone. An empty argv[0] spawns nothing. Both are caller
 * mistakes and both are refused before a process exists rather than after.
 *
 * The shell check is the belt to `lib/names.ts`'s braces: nothing in this
 * package may run an interpreter, because the moment argv[0] is `sh` the
 * careful argv array below becomes one string again and every escaping
 * guarantee in this package evaporates.
 */
const INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "env",
  "eval",
  "xargs",
]);

export function assertArgv(argv: readonly string[]): string | undefined {
  const program = argv[0];
  if (program === undefined || program.trim() === "") {
    return "argv[0] must name a program to run";
  }
  const base = program.split(/[\\/]/).pop() ?? program;
  if (INTERPRETERS.has(base.toLowerCase())) {
    return `argv[0] is "${base}", and this package never runs a shell or an interpreter`;
  }
  for (const arg of argv) {
    if (typeof arg !== "string") return "every argv element must be a string";
    if (arg.includes("\0")) return "argv may not contain a NUL byte";
  }
  return undefined;
}

/**
 * The child's environment: pinned, minimal, and the same on every machine.
 *
 * `PATH` and `HOME` are forwarded because a manager cannot be found without
 * the first and Homebrew cannot find its prefix without the second. Nothing
 * else from the harness is, so the harness's API keys are not in `apt-get`'s
 * environment. The Windows four are forwarded because `winget.exe` and
 * `choco.exe` are not resolvable without them.
 *
 * `LC_ALL`/`LANG`/`TZ` are pinned rather than forwarded — see the header.
 */
export function buildEnv(
  extra: Readonly<Record<string, string>> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: source["PATH"] !== undefined && source["PATH"] !== "" ? source["PATH"] : FALLBACK_PATH,
    LC_ALL: "C",
    LANG: "C",
    LANGUAGE: "C",
    TZ: "UTC",
  };
  const home = source["HOME"];
  if (home !== undefined && home !== "") env["HOME"] = home;
  for (const name of ["SystemRoot", "windir", "PATHEXT", "COMSPEC", "LOCALAPPDATA", "ProgramData"]) {
    const value = source[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

/** Cut a stream at the cap, saying whether anything was dropped. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** Run `argv` to completion, or kill it when the deadline passes. */
export async function runHostCommand(request: RunRequest): Promise<RunResult> {
  // Checked BEFORE the seam, not after: an injected runner must not be able
  // to make an argv acceptable that the real spawn would refuse, or a test
  // would pass on a command the host could never run.
  const bad = assertArgv(request.argv);
  if (bad !== undefined) {
    return { code: -1, stdout: "", stderr: bad, timedOut: false, missing: false };
  }
  if (runnerOverride !== undefined) return runnerOverride(request);
  return spawnHostCommand(request);
}

async function spawnHostCommand(request: RunRequest): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...request.argv], {
      // The workspace root, not a caller-chosen directory: no tool here takes
      // a path, and every command reads the machine rather than a tree.
      cwd: process.cwd(),
      // stdin is `ignore`, so a manager that would read a terminal gets EOF
      // immediately instead of blocking until the deadline. This is the other
      // half of the non-interactive contract: `apt-get` without a tty and
      // with a closed stdin cannot sit on a confirmation prompt.
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: buildEnv(request.env ?? {}),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // ENOENT means the manager is not installed, which is a DIFFERENT answer
    // from "it ran and told us nothing".
    const missing = /ENOENT|not found|No such file/i.test(message);
    return { code: -1, stdout: "", stderr: message, timedOut: false, missing };
  }

  let timedOut = false;
  let reapGiveUp: ReturnType<typeof setTimeout> | undefined;
  const term = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already gone between the timer firing and the signal.
    }
  }, request.timeoutMs);
  const hardKill = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, request.timeoutMs + KILL_GRACE_MS);

  try {
    // `.catch` is attached HERE and not after the race: the loser stays
    // pending, and a stream torn down with a killed process rejects with
    // nobody listening — an unhandled rejection that takes down the harness
    // rather than the command that caused it.
    const stdoutText = new Response(proc.stdout as ReadableStream<Uint8Array>)
      .text()
      .catch(() => "");
    const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>)
      .text()
      .catch(() => "");
    const abandonedMarker = Symbol("abandoned");
    const reaped = await Promise.race([
      proc.exited,
      new Promise<typeof abandonedMarker>((resolve) => {
        reapGiveUp = setTimeout(
          () => resolve(abandonedMarker),
          request.timeoutMs + KILL_GRACE_MS + REAP_GRACE_MS,
        );
      }),
    ]);
    const abandoned = reaped === abandonedMarker;
    const code = abandoned ? -1 : (reaped as number);
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drainFallback = new Promise<string>((resolve) => {
      drainTimer = setTimeout(() => resolve(""), DRAIN_GRACE_MS);
    });
    try {
      const [rawOut, rawErr] = await Promise.all([
        Promise.race([stdoutText, drainFallback]),
        Promise.race([stderrText, drainFallback]),
      ]);
      const cap = request.maxOutputChars ?? MAX_OUTPUT_CHARS;
      const out = capText(rawOut, cap);
      const err = capText(rawErr, cap);
      return {
        code,
        stdout: out.text,
        stderr: err.text,
        timedOut: timedOut || abandoned,
        missing: false,
        ...(out.truncated ? { stdoutTruncated: true } : {}),
        ...(err.truncated ? { stderrTruncated: true } : {}),
        ...(abandoned ? { abandoned: true } : {}),
      };
    } finally {
      // One shared timer, cleared as soon as the race settles: a fresh
      // `setTimeout` per stream that nobody cancels keeps the event loop
      // awake for the full grace period after every command.
      if (drainTimer !== undefined) clearTimeout(drainTimer);
    }
  } finally {
    clearTimeout(term);
    clearTimeout(hardKill);
    if (reapGiveUp !== undefined) clearTimeout(reapGiveUp);
  }
}

/**
 * Test seam. Pass a function to answer every command from recorded output;
 * pass `undefined` to go back to spawning for real.
 */
export function _setRunner(runner: Runner | undefined): void {
  runnerOverride = runner;
}

/**
 * True when a runner is installed.
 *
 * Read by `host.ts` to decide the platform default, and by the one smoke test
 * that is allowed to touch the real host so it can skip itself. See
 * `hostPlatform()` for why the two seams are tied together.
 */
export function _runnerInstalled(): boolean {
  return runnerOverride !== undefined;
}
