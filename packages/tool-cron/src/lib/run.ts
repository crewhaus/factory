/**
 * The one place this package starts a child process — and the seam every
 * test drives instead of the machine.
 *
 * The conventions here are `@crewhaus/tool-proc`'s (`src/spawn.ts`), copied
 * rather than re-invented: argv is an ARRAY, stdin is closed unless supplied,
 * every run has a deadline with a SIGTERM and then a SIGKILL behind it, and
 * both streams are capped so one chatty command cannot fill a context window.
 * They are copied instead of imported because tool-proc publishes only its
 * tools from `src/index.ts`; `runOnce` is not on its public surface, and
 * reaching past a package's exports map to grab it would be worse than a
 * documented copy.
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
 * Nothing in this file is reachable from a test: `_setRunner` replaces all of
 * it, and the suite drives recorded fixtures. That is deliberate — CI is
 * Linux, development is macOS, and a test that asked the real host what it
 * had scheduled would assert something different on each.
 */

/** Grace between the deadline's SIGTERM and the SIGKILL that follows it. */
const KILL_GRACE_MS = 2_000;
/**
 * After the SIGKILL, how long to keep waiting for the child to be reaped.
 *
 * tool-proc's `REAP_GRACE_MS`, and here for its reason: SIGKILL cannot be
 * caught, but it cannot interrupt a process wedged in an uninterruptible
 * kernel wait either, and `systemctl` talking to a dead bus over a stale
 * socket is exactly the shape of command that gets stuck there. Every other
 * bound in this file is downstream of `await proc.exited`, so without this
 * one a wedged child hangs the whole tool with no deadline left to save it.
 * (There is no portable way to put a process into that state, so this is the
 * one guarantee here with no test behind it — same as in tool-proc.)
 */
const REAP_GRACE_MS = 1_000;
/**
 * A child that forks a grandchild leaves the pipe's write end open after it
 * is gone, so reading to EOF can outlive the process. Bound the drain and
 * return what arrived. (`launchctl` does exactly this on macOS.)
 */
const DRAIN_GRACE_MS = 500;
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

function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
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
  const timeoutMs = cmd.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...cmd.argv], {
      // No `cwd` is passed: every path this package touches is absolute, and
      // inheriting the harness's directory keeps the child from depending on
      // one this tool chose.
      env: buildEnv(),
      stdin: cmd.stdin === undefined ? "ignore" : new TextEncoder().encode(cmd.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      argv: cmd.argv,
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnError: err instanceof Error ? err.message : String(err),
    };
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
  }, timeoutMs);
  const hardKill = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, timeoutMs + KILL_GRACE_MS);

  try {
    // `.catch` is attached here, not after the race below: a stream torn down
    // with a killed process rejects, and an unhandled rejection takes down the
    // harness rather than the command that caused it.
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
          timeoutMs + KILL_GRACE_MS + REAP_GRACE_MS,
        );
      }),
    ]);
    const abandoned = reaped === abandonedMarker;
    const exitCode = abandoned ? -1 : (reaped as number);
    const drainFallback = (): Promise<string> =>
      new Promise((resolve) => setTimeout(() => resolve(""), DRAIN_GRACE_MS));
    const [rawOut, rawErr] = await Promise.all([
      Promise.race([stdoutText, drainFallback()]),
      Promise.race([stderrText, drainFallback()]),
    ]);
    const out = capText(rawOut);
    const err = capText(rawErr);
    return {
      argv: cmd.argv,
      exitCode,
      stdout: out.text,
      stderr: err.text,
      // Carried, not dropped: a prefix of a scheduler's output is not that
      // scheduler's output, and the readers have to be able to tell.
      ...(out.truncated ? { stdoutTruncated: true } : {}),
      ...(err.truncated ? { stderrTruncated: true } : {}),
      timedOut: timedOut || abandoned,
      ...(abandoned ? { abandoned: true } : {}),
    };
  } finally {
    clearTimeout(term);
    clearTimeout(hardKill);
    // Unconditional: left running, this would hold the event loop open for
    // the whole timeout on every command that finished in a millisecond.
    if (reapGiveUp !== undefined) clearTimeout(reapGiveUp);
  }
};

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
