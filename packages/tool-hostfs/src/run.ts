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
 *   - OUTPUT IS CAPPED AS IT ARRIVES. tool-safety's `spawnBounded` keeps at
 *     most the cap and drains the rest without storing it, so the child
 *     never blocks on a full pipe and its exit code stays truthful. 0.7.0
 *     read each pipe to EOF into memory and cut it afterwards, so memory
 *     was bounded by the child's output, not by the cap (C163).
 *   - THE ENVIRONMENT IS PINNED. A child inherits `PATH` and a C locale and
 *     nothing else, so the harness's secrets are not in `mdfind`'s
 *     environment and a machine's locale cannot change a parsed message.
 *
 * `_setRunner` replaces the whole thing. Every parser in this package is fed
 * from recorded output through that seam, because the alternative — asking
 * the real host — passes on the author's macOS and means something else
 * entirely on a Linux CI box.
 */
import { constants as osConstants } from "node:os";
import { spawnBounded } from "@crewhaus/tool-safety/streams";
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
  /**
   * The output could not be read to its end: the child exited but something
   * it started kept the pipe open past the drain grace. What arrived is
   * returned, and `stdoutTruncated` is set too, since the listing may be
   * missing its tail. 0.7.0 replaced such output with "", a definite-looking
   * empty answer built from nothing.
   */
  readonly outputIncomplete?: boolean;
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

  const cap = request.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const run = await spawnBounded({
    cmd: request.argv,
    env: childEnv(),
    timeoutMs: request.timeoutMs,
    // A cap in characters, collected in bytes: no UTF-16 unit takes more
    // than three bytes of UTF-8, so three bytes a character never cuts a
    // listing the character cap would have kept.
    maxStdoutBytes: cap * 3,
    maxStderrBytes: cap * 3,
    killGraceMs: KILL_GRACE_MS,
    drainGraceMs: DRAIN_GRACE_MS,
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  });
  if (run.spawnError !== undefined) {
    return { code: 127, stdout: "", stderr: run.spawnError, timedOut: false, missing: true };
  }
  const out = capText(run.stdout, cap);
  const err = capText(run.stderr, cap);
  const incomplete = !run.outputComplete;
  return {
    code: exitCodeOf(run.exitCode, run.signal),
    stdout: out.text,
    stderr: err.text,
    timedOut: run.timedOut,
    missing: false,
    ...(out.truncated || run.stdoutTruncated || incomplete ? { stdoutTruncated: true } : {}),
    ...(err.truncated || run.stderrTruncated ? { stderrTruncated: true } : {}),
    ...(incomplete ? { outputIncomplete: true } : {}),
  };
}

/** The code `Bun.spawn`'s `exited` gave: the exit status, or 128 + the signal's number. */
function exitCodeOf(exitCode: number | null, signal: string | null): number {
  if (exitCode !== null) return exitCode;
  const number =
    signal === null
      ? undefined
      : (osConstants.signals as Record<string, number | undefined>)[signal];
  return number === undefined ? -1 : 128 + number;
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
