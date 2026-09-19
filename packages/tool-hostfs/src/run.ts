/**
 * The one place this package starts a child process, and the seam every test
 * drives instead.
 *
 * Modelled on `@crewhaus/tool-proc`'s `spawn.ts` and `@crewhaus/tool-fsx`'s
 * `proc.ts`, with their rules kept rather than re-invented:
 *
 *   - ARGV IS AN ARRAY. There is no shell in this package: no `sh -c`, no
 *     interpolated command line, nothing that could turn a caller's string
 *     into syntax. A value that reaches a command is an element of an argv
 *     array, and `assertArgv` below refuses anything that would make that
 *     untrue (a NUL byte, an empty program, a non-string).
 *   - EVERY RUN HAS A DEADLINE. SIGTERM at the deadline, SIGKILL after a
 *     grace period, and a bounded drain so a child that forked a grandchild
 *     cannot hold the pipe open past its own death.
 *   - THE ENVIRONMENT IS PINNED. A child inherits `PATH` and a C locale and
 *     nothing else, so the harness's secrets are not in `mdfind`'s
 *     environment and a machine's locale cannot change a parsed message.
 *
 * `_setRunner` replaces the whole thing. Every parser in this package is fed
 * from recorded output through that seam, because the alternative — asking
 * the real host — passes on the author's macOS and means something else
 * entirely on a Linux CI box.
 */
import { FALLBACK_PATH } from "./host";

export type RunRequest = {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  /** Cap on each captured stream; hitting it is reported, never silent. */
  readonly maxOutputChars?: number;
  readonly signal?: AbortSignal;
};

export type RunResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when the program itself is not installed (ENOENT on spawn). */
  readonly missing: boolean;
  /**
   * The output was cut at the cap. It matters here: a truncated `mdfind`
   * listing looks exactly like a complete short one, and a caller would read
   * the missing tail as "there is nothing else".
   */
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
};

/** Default cap per stream. A whole-volume `mdfind` can print megabytes. */
export const DEFAULT_MAX_OUTPUT_CHARS = 4_000_000;

export type Runner = (request: RunRequest) => Promise<RunResult>;

/** Grace between the deadline's SIGTERM and the SIGKILL that follows it. */
const KILL_GRACE_MS = 2_000;
/** A child that forked keeps the pipe open; drain for this long and move on. */
const DRAIN_GRACE_MS = 500;

export const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;

let runnerOverride: Runner | undefined;

/**
 * Refuse an argv that could not be handed to `execve` as-is.
 *
 * A NUL byte truncates an argument at the syscall boundary: a string that
 * reads as harmless here arrives at the kernel cut short at the NUL, with
 * whatever followed it gone. An empty argv[0] spawns nothing. Both are caller
 * mistakes, and both are refused before a process exists rather than after.
 */
export function assertArgv(argv: readonly string[]): string | undefined {
  const program = argv[0];
  if (program === undefined || program.trim() === "") {
    return "argv[0] must name a program to run";
  }
  for (const arg of argv) {
    if (typeof arg !== "string") return "every argv element must be a string";
    if (arg.includes("\0")) return "argv may not contain a NUL byte";
  }
  return undefined;
}

/**
 * A child's environment: `PATH` so the program can be found, and a C locale
 * so a parsed message is the same string on every machine. Nothing else is
 * inherited — `mdfind` has no business seeing an API key.
 */
function childEnv(): Record<string, string> {
  const inherited = process.env["PATH"];
  return {
    PATH: inherited === undefined || inherited === "" ? FALLBACK_PATH : inherited,
    LC_ALL: "C",
    LANG: "C",
  };
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

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...request.argv], {
      // stdin is `ignore`, so a program that would read a terminal gets EOF
      // immediately instead of blocking until the deadline.
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: 127, stdout: "", stderr: message, timedOut: false, missing: true };
  }

  let timedOut = false;
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
    // `.catch` is attached HERE and not after the race below: the loser of
    // the race stays pending, and a stream torn down with a killed process
    // rejects with nobody listening — an unhandled rejection that takes down
    // the harness rather than the command that caused it.
    const stdoutText = new Response(proc.stdout as ReadableStream<Uint8Array>)
      .text()
      .catch(() => "");
    const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>)
      .text()
      .catch(() => "");
    const code = await proc.exited;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drainFallback = new Promise<string>((resolve) => {
      drainTimer = setTimeout(() => resolve(""), DRAIN_GRACE_MS);
    });
    try {
      const [rawOut, rawErr] = await Promise.all([
        Promise.race([stdoutText, drainFallback]),
        Promise.race([stderrText, drainFallback]),
      ]);
      const cap = request.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
      const out = capText(rawOut, cap);
      const err = capText(rawErr, cap);
      return {
        code,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        missing: false,
        ...(out.truncated ? { stdoutTruncated: true } : {}),
        ...(err.truncated ? { stderrTruncated: true } : {}),
      };
    } finally {
      // One shared timer, cleared as soon as the race settles: a fresh
      // `setTimeout` per stream that nobody cancels keeps the event loop
      // awake for the full grace period after every spawn.
      if (drainTimer !== undefined) clearTimeout(drainTimer);
    }
  } finally {
    clearTimeout(term);
    clearTimeout(hardKill);
  }
}

/**
 * Test seam. Pass a function to answer every command from recorded output;
 * pass `undefined` to go back to spawning for real.
 */
export function _setRunner(runner: Runner | undefined): void {
  runnerOverride = runner;
}

/** Cut a captured stream at the cap, saying whether it was cut. */
function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** True when a runner is installed — the smoke test skips itself otherwise. */
export function _runnerInstalled(): boolean {
  return runnerOverride !== undefined;
}
