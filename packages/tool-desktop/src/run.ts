/**
 * The one place this package starts a child process, and the seam every test
 * drives instead of the machine.
 *
 * The conventions are `@crewhaus/tool-proc`'s and `@crewhaus/tool-hostfs`'s,
 * kept rather than re-invented:
 *
 *   - ARGV IS AN ARRAY. There is no shell in this package: no `sh -c`, no
 *     `cmd /c`, no interpolated command line. A caller's value is an ELEMENT
 *     of an argv array or it does not reach a command at all.
 *   - EVERY RUN HAS A DEADLINE. SIGTERM at the deadline, SIGKILL after a
 *     grace period, and a bounded drain. The drain bound is load-bearing
 *     here, not defensive: `xclip -i` and `wl-copy` DELIBERATELY fork a
 *     resident holder (under X11 and Wayland the writing process owns the
 *     selection, so it must outlive the tool call), and that holder inherits
 *     the stdout pipe. Reading to EOF would block until the operator copies
 *     something else — possibly for hours.
 *   - THE ENVIRONMENT IS PINNED. `PATH` plus a C locale, plus whatever the
 *     caller of `runHostCommand` explicitly adds. Nothing else is inherited,
 *     so the harness's secrets are not in `pbpaste`'s environment.
 *
 * ONE DELIBERATE EXCEPTION, AND IT IS A SECURITY MEASURE, NOT A CONVENIENCE.
 * `RunRequest.env` exists so a value can reach a PowerShell script WITHOUT
 * being in the script's source. `powershell.exe -Command <script> a b c`
 * CONCATENATES the trailing arguments into the command string — argv is not a
 * safe channel there the way it is for `notify-send`. So the Windows backends
 * put caller values in the child's environment and the script reads
 * `$env:CREWHAUS_*`. See ./lib/escape.ts, which is where that decision lives.
 *
 * STDIN IS THE CHANNEL FOR A PAYLOAD. `ClipboardWrite` pipes the text in
 * rather than passing it as an argument, because argv is world-readable
 * through `ps` on both macOS and Linux and a clipboard payload is exactly the
 * kind of thing an operator would not want in a process listing.
 */
import { _realHostAllowed } from "./host";

/** `PATH` for a child, with a floor so a stripped harness env still spawns. */
export const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type RunRequest = {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  /** Piped to the child. `undefined` ⇒ stdin is closed, so a program that
   *  would read a terminal gets EOF instead of blocking to its deadline. */
  readonly stdin?: string;
  /** Extra environment for the child — see the header. */
  readonly env?: Readonly<Record<string, string>>;
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
   * The stream was cut at the cap. It matters: a truncated window listing
   * looks exactly like a complete short one, and a caller reads the missing
   * tail as "there is nothing else".
   */
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
  /** Set when no runner was installed and the real host was not allowed. */
  readonly refused?: boolean;
};

/**
 * A process this package started and deliberately did not wait for.
 *
 * Only `PowerAssertion` uses it: a sleep inhibitor IS the lifetime of a child
 * process, so the tool has to return while the child keeps running.
 */
export type DetachResult =
  | { readonly ok: true; readonly pid: number }
  | { readonly ok: false; readonly reason: string; readonly missing: boolean };

export type Runner = (request: RunRequest) => Promise<RunResult>;
export type Detacher = (request: RunRequest) => Promise<DetachResult>;

/** Grace between the deadline's SIGTERM and the SIGKILL that follows it. */
const KILL_GRACE_MS = 2_000;
/** A child that forked a holder keeps the pipe open; drain this long and move on. */
const DRAIN_GRACE_MS = 500;

export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
export const MAX_COMMAND_TIMEOUT_MS = 120_000;
/**
 * Per-stream cap.
 *
 * A clipboard can legitimately hold a whole file, and `ClipboardRead` applies
 * its OWN, much smaller cap on top of this one — this is only the ceiling
 * past which the process pipe stops being drained.
 */
export const DEFAULT_MAX_OUTPUT_CHARS = 4_000_000;

let runnerOverride: Runner | undefined;
let detacherOverride: Detacher | undefined;

/**
 * Refuse an argv that could not be handed to `execve` as-is.
 *
 * A NUL byte truncates an argument at the syscall boundary: a string that
 * reads as harmless here arrives at the kernel cut short at the NUL, with
 * whatever followed it gone. An empty argv[0] spawns nothing. Both are caller
 * mistakes and both are refused before a process exists rather than after.
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
 * A child's environment: `PATH` so the program can be found, a C locale so a
 * parsed message is the same string on every machine, and the caller's
 * explicit additions. Nothing else — `pbpaste` has no business seeing an API
 * key, and neither does a PowerShell one-liner.
 */
export function childEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
  const inherited = process.env["PATH"];
  const env: Record<string, string> = {
    PATH: inherited === undefined || inherited === "" ? FALLBACK_PATH : inherited,
    LC_ALL: "C",
    LANG: "C",
  };
  // A desktop backend needs the session variables to find the display at all;
  // they are forwarded from the seam's view of the session rather than from
  // `process.env` so a test controls them like everything else.
  for (const [key, value] of Object.entries(extra ?? {})) env[key] = value;
  return env;
}

/** Cut a captured stream at the cap, saying whether it was cut. */
export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/**
 * The refusal an un-injected runner produces under test.
 *
 * Shaped like a real failure so every caller's existing "the command did not
 * work" branch handles it, and worded so the test author sees immediately
 * what they forgot.
 */
export const NO_RUNNER_REASON =
  "no runner is installed and this process is not allowed to touch the real host (see _setRunner / _allowRealHost)";

export async function runHostCommand(request: RunRequest): Promise<RunResult> {
  // Checked BEFORE the seam, not after: an injected runner must not be able
  // to make an argv acceptable that the real spawn would refuse, or a test
  // would pass on a command no host could run.
  const bad = assertArgv(request.argv);
  if (bad !== undefined) {
    return { code: -1, stdout: "", stderr: bad, timedOut: false, missing: false };
  }
  if (runnerOverride !== undefined) return runnerOverride(request);
  if (!_realHostAllowed()) {
    return {
      code: -1,
      stdout: "",
      stderr: NO_RUNNER_REASON,
      timedOut: false,
      missing: false,
      refused: true,
    };
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...request.argv], {
      stdin:
        request.stdin === undefined ? "ignore" : new TextEncoder().encode(request.stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(request.env),
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
 * Start a child and return its pid without waiting for it.
 *
 * `stdio` is all `ignore`: a detached holder that inherited this process's
 * pipes would keep them open after the harness exits, and a holder whose
 * stdout nobody reads eventually blocks on a full pipe — an inhibitor that
 * stops inhibiting halfway through the job it was held for.
 */
export async function detachHostCommand(request: RunRequest): Promise<DetachResult> {
  const bad = assertArgv(request.argv);
  if (bad !== undefined) return { ok: false, reason: bad, missing: false };
  if (detacherOverride !== undefined) return detacherOverride(request);
  if (!_realHostAllowed()) return { ok: false, reason: NO_RUNNER_REASON, missing: false };
  try {
    const proc = Bun.spawn([...request.argv], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: childEnv(request.env),
    });
    proc.unref();
    return { ok: true, pid: proc.pid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message, missing: true };
  }
}

/**
 * Test seam. Pass a function to answer every command from recorded output;
 * pass `undefined` to go back to the (refused, under test) real spawn.
 */
export function _setRunner(runner: Runner | undefined): void {
  runnerOverride = runner;
}

export function _setDetacher(detacher: Detacher | undefined): void {
  detacherOverride = detacher;
}

export function _resetRunSeams(): void {
  runnerOverride = undefined;
  detacherOverride = undefined;
}
