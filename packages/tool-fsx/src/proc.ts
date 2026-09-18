/**
 * Spawning, with the two properties every process-launching tool in this
 * repo owes its caller: a deadline it cannot outlive, and cooperation with
 * the turn's `AbortSignal`. Modelled on `@crewhaus/tool-bash`.
 *
 * Arguments are passed as an argv array, never as a shell string, so a file
 * name containing a space, a quote or a `;` is an argument rather than a
 * command. No tool in this package builds a shell line.
 */

export type RunResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when the executable itself could not be found. */
  readonly missing: boolean;
};

export const DEFAULT_PROCESS_TIMEOUT_MS = 60_000;
export const MAX_PROCESS_TIMEOUT_MS = 600_000;
/** Matches tool-bash: give a killed process a moment to let its pipes EOF. */
const DRAIN_GRACE_MS = 500;

export type RunOptions = {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
};

/** Run `argv` to completion, or kill it when the deadline passes. */
export async function runProcess(
  argv: ReadonlyArray<string>,
  options: RunOptions,
): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      // COPYFILE_DISABLE stops the tar on macOS from adding an `._name`
      // AppleDouble member for every file carrying an extended attribute.
      // Those members are host state, not content: without this the same
      // directory archives differently on macOS and on Linux.
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      // The runtime aborts the turn by firing this signal; Bun forwards it
      // to the child as SIGTERM, so a cancelled turn does not leave a
      // process behind.
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: 127, stdout: "", stderr: message, timedOut: false, missing: true };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already exited between the timer firing and the kill.
    }
  }, options.timeoutMs);

  try {
    const stdoutText = new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const stderrText = new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    const code = await proc.exited;
    // One shared grace timer, cleared as soon as the race settles. A fresh
    // `setTimeout` per stream that nobody cancels keeps the event loop awake
    // for the full grace period after every single spawn.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drainFallback = new Promise<string>((resolve) => {
      drainTimer = setTimeout(() => resolve(""), DRAIN_GRACE_MS);
    });
    try {
      const [stdout, stderr] = await Promise.all([
        Promise.race([stdoutText, drainFallback]),
        Promise.race([stderrText, drainFallback]),
      ]);
      return { code, stdout, stderr, timedOut, missing: false };
    } finally {
      if (drainTimer !== undefined) clearTimeout(drainTimer);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** A one-line description of a failed run, for returning to the caller. */
export function describeFailure(argv: ReadonlyArray<string>, result: RunResult): string {
  const command = argv[0] ?? "";
  if (result.missing) {
    return `\`${command}\` is not installed on this machine, so this archive format cannot be handled here`;
  }
  if (result.timedOut) {
    return `\`${command}\` was killed for exceeding its timeout`;
  }
  const detail = (result.stderr.trim() !== "" ? result.stderr : result.stdout).trim();
  const clipped = detail.length > 2000 ? `${detail.slice(0, 2000)}…` : detail;
  return `\`${command}\` exited ${result.code}${clipped === "" ? "" : `: ${clipped}`}`;
}
