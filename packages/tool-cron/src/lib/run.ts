/**
 * The one place this package starts a child process — and the seam every
 * test drives instead of the machine.
 *
 * The spawn is `@crewhaus/tool-safety`'s `spawnBounded`, the one tool-proc
 * uses too: argv is an ARRAY, stdin is closed unless supplied, every run has
 * a deadline with a SIGTERM and then a SIGKILL behind it (to the child's
 * whole process group), both streams are capped AS THEY ARE READ, and a pipe
 * a grandchild still holds after the child exits is read for a bounded
 * grace and then cut, with the result saying so (C078). 0.7.0 kept a copy
 * here that buffered each stream whole before capping it, and on a drain
 * that outlived the grace returned "" — which every reader took for an
 * empty listing.
 *
 * Two rules on top of tool-proc's, both specific to reading a scheduler:
 *
 *   1. **The environment is pinned, and pinned to `C`/`UTC`.** `systemctl`
 *      prints timestamps in the caller's locale and zone, and `schtasks` on
 *      Windows prints LOCALISED COLUMN HEADERS — the classic reason a parser
 *      that works in en_US silently returns nothing in de_DE. Forcing
 *      `LC_ALL=C` and `TZ=UTC` makes the bytes the same everywhere. The
 *      cost is that a time we echo from systemd is UTC, which the result
 *      says out loud rather than leaving the reader to guess.
 *   2. **`XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` are forwarded.**
 *      Without them `systemctl --user` cannot reach the user bus and fails
 *      with "Failed to connect to bus" — a pinned-env bug that looks exactly
 *      like "this host has no timers".
 *
 * The scheduler readers never reach this runner in a test: `_setRunner`
 * replaces it, and the suite drives recorded fixtures. That is deliberate —
 * CI is Linux, development is macOS, and a test that asked the real host
 * what it had scheduled would assert something different on each. The
 * runner itself is tested (run.test.ts) with `sh`, never with a scheduler.
 */
import { constants } from "node:os";
import { type SpawnBoundedResult, spawnBounded } from "@crewhaus/tool-safety/streams";

/**
 * A child that forks a grandchild leaves the pipe's write end open after it
 * is gone, so reading to EOF can outlive the process. The drain is bounded
 * by this, and what arrived is returned with `outputIncomplete`.
 * (`launchctl` does exactly this on macOS.) SIGKILL follows SIGTERM after
 * spawnBounded's 2 s grace, and a child that is not reaped 1 s after that
 * (`systemctl` wedged on a dead bus) is abandoned, as before.
 */
export const DRAIN_GRACE_MS = 500;
/** Per-stream cap. A crontab or a unit listing that exceeds this is not one. */
export const MAX_OUTPUT_CHARS = 512_000;
/** Default per-command deadline. Every scheduler command here is local. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/** The PATH a child gets when the harness itself has none. */
const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * Harness variables a scheduler command genuinely needs. Everything else is
 * dropped, so a secret in the harness's environment never reaches a child.
 */
const FORWARDED_ENV = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  // `systemctl --user` talks to the per-user bus through these two.
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
]);

export type HostCommand = {
  /** The program and each argument as separate strings. Never a shell line. */
  readonly argv: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs?: number;
};

export type HostResult = {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Set when the stream hit `MAX_OUTPUT_CHARS` and what came back is a
   * PREFIX of what the command printed.
   *
   * This flag is the whole point of capping rather than the cap itself. A
   * truncated `crontab -l` parses perfectly — the tail is simply missing, and
   * the last surviving line is cut mid-command — so a rewrite built from it
   * would install a schedule with the caller's other jobs silently deleted.
   * Every reader below treats a truncated stream as "could not read this",
   * never as "this is what the host has".
   */
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
  readonly timedOut: boolean;
  /**
   * Set when the child outlived even the SIGKILL grace and was left behind
   * (tool-proc's convention): the result is whatever had been captured, and
   * `exitCode` is not the child's.
   */
  readonly abandoned?: boolean;
  /**
   * Set when reading stopped before a stream ended: the command exited but a
   * process it started still held its output open past `DRAIN_GRACE_MS`.
   * What came back is what arrived by then — possibly all of it, possibly
   * not — so every reader treats it as unreadable, never as the listing.
   */
  readonly outputIncomplete?: boolean;
  /**
   * Set when the program could not be started at all — the honest signal for
   * "this host does not have `systemctl`", which is a different answer from
   * "systemctl ran and reported nothing".
   */
  readonly spawnError?: string;
};

export type HostRunner = (cmd: HostCommand) => Promise<HostResult>;

/**
 * NUL cannot be in an argument (execve would truncate it), and neither can a
 * newline in any identifier this package passes on — a label or unit name
 * with one in it is not something a scheduler produced.
 *
 * The leading-dash rule is the one that has already cost this repo a real
 * bug: `gitBranchCreate({name:"-D"})` ran `git branch -D victim`. Every value
 * this package puts in an argv comes from a host listing rather than from the
 * caller, and each is still checked here, because "it came from the host" is
 * a property of today's code path and not a guarantee about tomorrow's.
 */
export function checkArgument(what: string, value: string): string | undefined {
  if (value === "") return `${what} is empty`;
  if (value.includes("\0")) return `${what} contains a NUL byte`;
  if (/[\n\r]/.test(value)) return `${what} contains a newline`;
  if (value.startsWith("-")) {
    return `${what} starts with "-", which a command would read as a flag (${JSON.stringify(value)})`;
  }
  return undefined;
}

/** A stream's kept head, cut to `MAX_OUTPUT_CHARS`, and whether anything was not kept. */
function capHead(text: string, truncatedAsRead: boolean): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: truncatedAsRead };
  return { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}

/** The child's environment: pinned, minimal, and the same on every machine. */
export function buildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of FORWARDED_ENV) {
    const value = source[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
  if (env["PATH"] === undefined) env["PATH"] = FALLBACK_PATH;
  // Locale and zone are pinned, not forwarded: see the header.
  env["LC_ALL"] = "C";
  env["LANG"] = "C";
  env["TZ"] = "UTC";
  // systemd reads both; without them `systemctl` paginates and colourises,
  // and a pager waiting for a keypress is a command that never exits.
  env["SYSTEMD_PAGER"] = "";
  env["SYSTEMD_COLORS"] = "0";
  return env;
}

const defaultRunner: HostRunner = async (cmd) => {
  const r = await spawnBounded({
    cmd: cmd.argv,
    // No `cwd` is passed: every path this package touches is absolute, and
    // inheriting the harness's directory keeps the child from depending on
    // one this tool chose.
    env: buildEnv(),
    ...(cmd.stdin !== undefined ? { stdin: cmd.stdin } : {}),
    timeoutMs: cmd.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    // A prefix, never head-and-tail: a listing's reader needs its start, and
    // the flag below tells it the rest is missing. Three bytes per character
    // is the most UTF-8 ever needs, so MAX_OUTPUT_CHARS always fits.
    maxStdoutBytes: MAX_OUTPUT_CHARS * 3,
    maxStderrBytes: MAX_OUTPUT_CHARS * 3,
    drainGraceMs: DRAIN_GRACE_MS,
  });
  if (r.spawnError !== undefined) {
    return {
      argv: cmd.argv,
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnError: r.spawnError,
    };
  }
  const out = capHead(r.stdout, r.stdoutTruncated);
  const err = capHead(r.stderr, r.stderrTruncated);
  return {
    argv: cmd.argv,
    exitCode: r.abandoned ? -1 : exitStatus(r),
    stdout: out.text,
    stderr: err.text,
    // Carried, not dropped: a prefix of a scheduler's output is not that
    // scheduler's output, and the readers have to be able to tell.
    ...(out.truncated ? { stdoutTruncated: true } : {}),
    ...(err.truncated ? { stderrTruncated: true } : {}),
    timedOut: r.timedOut || r.abandoned,
    ...(r.abandoned ? { abandoned: true } : {}),
    ...(r.outputComplete ? {} : { outputIncomplete: true }),
  };
};

/** The status a shell would report: 128 + the signal's number for a signalled child. */
function exitStatus(r: SpawnBoundedResult): number {
  if (r.exitCode !== null) return r.exitCode;
  if (r.signal !== null) {
    const n = (constants.signals as Record<string, number | undefined>)[r.signal];
    if (n !== undefined) return 128 + n;
  }
  return -1;
}

let runner: HostRunner = defaultRunner;

/**
 * Test-only injection point, the convention this repo already uses for a
 * network seam (`_setRegistryFetch`) and a clock (`_setClock`). `undefined`
 * restores the real runner; a suite that sets it must restore it, or the next
 * file in the same bun process inherits the stub.
 */
export function _setRunner(fn: HostRunner | undefined): void {
  runner = fn ?? defaultRunner;
}

export function runHost(cmd: HostCommand): Promise<HostResult> {
  return runner(cmd);
}

/**
 * Why this result is not an answer, in one sentence — or `undefined` when it
 * is one.
 *
 * Three different things are collapsed into "exit code 1" by a naive reader,
 * and a caller's next move differs for each: a command that was KILLED at its
 * deadline (house rule: a failure a timeout could also explain has to name
 * the timeout), a command whose output was CUT, and a command that simply
 * failed. Every reader in this package funnels through here so none of them
 * can forget one.
 */
export function unreadableReason(
  result: HostResult,
  what: string,
  timeoutMs: number,
): string | undefined {
  if (result.spawnError !== undefined) return `${what} could not be started: ${result.spawnError}`;
  if (result.abandoned === true) {
    return `${what} ignored SIGTERM and SIGKILL and was left behind, so its output is incomplete`;
  }
  if (result.timedOut) return `${what} did not finish within ${timeoutMs}ms`;
  if (result.outputIncomplete === true) {
    return `${what} exited, but a process it started kept its output open past ${DRAIN_GRACE_MS}ms, so what came back may be incomplete`;
  }
  if (result.stdoutTruncated === true) {
    return `${what} printed more than ${MAX_OUTPUT_CHARS} characters, so what came back is a PREFIX of its output, not the whole of it`;
  }
  return undefined;
}

/** True when the command was not found on this host at all. */
export function isMissingProgram(result: HostResult): boolean {
  if (result.spawnError !== undefined) return true;
  // Bun surfaces ENOENT as a throw, but a wrapper script that execs a missing
  // program reports it the shell's way, so both are treated as absent.
  return result.exitCode === 127;
}
