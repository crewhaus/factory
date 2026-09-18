import { capText } from "./lib/format";

/**
 * The one place this package starts a child process.
 *
 * Everything that runs a command — RunCommand, RunPipeline, Retry and the
 * background family — goes through here so a single set of rules holds:
 *
 *   - argv is passed to the OS as an ARRAY. There is no shell anywhere in
 *     this package, so a filename with a space or a `$(...)` in it is an
 *     argument and never a command.
 *   - stdin is `ignore` unless the caller supplied it, so a command that
 *     reads stdin gets EOF immediately instead of hanging on a terminal
 *     that is not there.
 *   - every run has a deadline: SIGTERM on expiry, SIGKILL after a short
 *     grace period for a child that ignores the first signal.
 *   - both streams are capped, so one chatty command cannot fill a context
 *     window.
 */

/** Grace between the deadline's SIGTERM and the SIGKILL that follows it. */
const KILL_GRACE_MS = 2_000;
/**
 * A process that forks a grandchild keeps the pipe's write end open after
 * the child itself is gone, so reading to EOF can outlive the process. Give
 * each stream a bounded drain window and move on with what arrived.
 */
const DRAIN_GRACE_MS = 500;
/**
 * After the SIGKILL, how long to keep waiting for the child to be reaped
 * before returning without it.
 *
 * SIGKILL cannot be caught, but it cannot interrupt a process wedged in an
 * uninterruptible kernel wait either — a stalled NFS read, a wayward driver.
 * `proc.exited` then never resolves, and every other bound in this file is
 * downstream of that await, so the whole call hangs with no deadline left to
 * save it. This is the last bound: past it the tool reports what it has and
 * lets go. (There is no portable way to put a process into that state, so
 * this is the one guarantee here with no test behind it.)
 */
const REAP_GRACE_MS = 1_000;

export type RunOutcome = {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Set when the command could not be started at all (e.g. no such file). */
  readonly spawnError?: string;
  /**
   * Set when the child outlived even the SIGKILL grace and was left behind:
   * the result is what had been captured by then, and `exitCode` is unknown.
   */
  readonly abandoned?: boolean;
};

export type RunOptions = {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly signal?: AbortSignal;
};

export async function runOnce(argv: readonly string[], options: RunOptions): Promise<RunOutcome> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: options.env,
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (err) {
    return {
      argv,
      exitCode: -1,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: elapsed(),
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
  }, options.timeoutMs);
  const hardKill = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }, options.timeoutMs + KILL_GRACE_MS);

  try {
    // The spread options above widen Bun's stdio inference, so name the
    // piped shape explicitly rather than let the union leak outward.
    // `.catch` is attached HERE, not after the race: the loser of the race
    // below stays pending, and a stream torn down with the killed process
    // would otherwise reject with nobody listening — an unhandled rejection
    // that takes down the harness rather than the command that caused it.
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
          options.timeoutMs + KILL_GRACE_MS + REAP_GRACE_MS,
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
    const out = capText(rawOut, options.maxOutputChars);
    const err = capText(rawErr, options.maxOutputChars);
    return {
      argv,
      exitCode,
      stdout: out.text,
      stderr: err.text,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      timedOut: timedOut || abandoned,
      durationMs: elapsed(),
      ...(abandoned ? { abandoned: true } : {}),
    };
  } finally {
    clearTimeout(term);
    clearTimeout(hardKill);
    // Unconditional: left running, this one would hold the event loop open
    // for the whole timeout on every command that finished in a millisecond.
    if (reapGiveUp !== undefined) clearTimeout(reapGiveUp);
  }
}

/** A deadline-aware sleep: resolves early (and reports it) when aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  // An ALREADY-aborted signal never fires `abort` again, so without this an
  // abort that landed a moment before the call would still cost the full
  // sleep — the one wait in the package that could outlive its own deadline.
  if (signal?.aborted === true) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
