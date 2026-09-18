/**
 * Spawning, with the three properties a process-launching tool in this repo
 * owes its caller: a deadline it cannot outlive, cooperation with the turn's
 * `AbortSignal`, and an output cap that bounds MEMORY rather than being
 * applied after the fact.
 *
 * That last one is why this reads the pipes chunk by chunk instead of
 * `new Response(proc.stdout).text()`: a process that prints a gigabyte must
 * cost a bounded number of bytes here, and be killed, not buffered and then
 * measured.
 *
 * Arguments are always an argv array, never a shell string, so a file name
 * containing a space, a quote or a `;` is an argument rather than a command.
 * Nothing in this package builds a shell line.
 */

export type RunResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** True when the executable itself could not be found. */
  readonly missing: boolean;
  /** True when either stream was cut off at the byte cap. */
  readonly truncated: boolean;
};

export const DEFAULT_PROCESS_TIMEOUT_MS = 20_000;
export const MAX_PROCESS_TIMEOUT_MS = 120_000;
/** Plenty for structured probe output; a process past it is misbehaving. */
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** How long a killed process gets to let its pipes reach EOF. */
const DRAIN_GRACE_MS = 500;

export type RunOptions = {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
};

/**
 * Read a pipe until it ends, `limit` bytes have arrived, or `stop` resolves.
 *
 * That third condition is not decoration. A shell script killed mid-`sleep`
 * leaves the `sleep` holding the write end of the pipe, so waiting for EOF
 * waits for a process nobody is going to kill. `stop` fires a short grace
 * period after the child exits, and the reader is cancelled either way.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  stop: Promise<"stop">,
): Promise<{ text: string; truncated: boolean }> {
  if (stream === null) return { text: "", truncated: false };
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), stop]);
      if (next === "stop") {
        truncated = true;
        break;
      }
      const { done, value } = next;
      if (done) break;
      if (value === undefined) continue;
      if (total + value.length > limit) {
        parts.push(value.subarray(0, Math.max(0, limit - total)));
        total = limit;
        truncated = true;
        break;
      }
      parts.push(value);
      total += value.length;
    }
  } finally {
    // Cancelling releases the pipe, so the child sees EPIPE and stops
    // writing instead of blocking on a reader that has gone away.
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return { text: new TextDecoder().decode(joined), truncated };
}

/** Run `argv` to completion, or kill it when the deadline passes. */
export async function runProcess(
  argv: ReadonlyArray<string>,
  options: RunOptions,
): Promise<RunResult> {
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // Passed explicitly rather than inherited: Bun resolves the
      // executable against the env it is HANDED, and a caller that has
      // adjusted PATH since the process started expects the new one.
      env: { ...process.env },
      // The runtime aborts the turn by firing this signal; Bun forwards it
      // to the child, so a cancelled turn does not leave a process behind.
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      code: 127,
      stdout: "",
      stderr: message,
      timedOut: false,
      missing: true,
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
  }, options.timeoutMs);

  let stopReading: (value: "stop") => void = () => {};
  const stop = new Promise<"stop">((resolve) => {
    stopReading = resolve;
  });
  // Reading starts BEFORE the wait on exit: a child that fills its pipe
  // blocks until somebody drains it, and a deadlock is not a deadline.
  const stdout = readCapped(proc.stdout as ReadableStream<Uint8Array> | null, limit, stop);
  const stderr = readCapped(proc.stderr as ReadableStream<Uint8Array> | null, limit, stop);

  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await proc.exited;
    drainTimer = setTimeout(() => stopReading("stop"), DRAIN_GRACE_MS);
    const [out, err] = await Promise.all([stdout, stderr]);
    return {
      code,
      stdout: out.text,
      stderr: err.text,
      timedOut,
      missing: code === 127 && out.text === "" && err.text === "",
      truncated: out.truncated || err.truncated,
    };
  } finally {
    clearTimeout(timer);
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    stopReading("stop");
  }
}

/** A one-line description of a failed run, safe to hand back to a caller. */
export function describeFailure(argv: ReadonlyArray<string>, result: RunResult): string {
  const command = argv[0] ?? "";
  if (result.missing) {
    return `\`${command}\` is not installed on this machine, so this cannot be done here`;
  }
  if (result.timedOut) {
    return `\`${command}\` was killed for exceeding its timeout`;
  }
  const detail = (result.stderr.trim() !== "" ? result.stderr : result.stdout).trim();
  const clipped = detail.length > 2000 ? `${detail.slice(0, 2000)}…` : detail;
  return `\`${command}\` exited ${result.code}${clipped === "" ? "" : `: ${clipped}`}`;
}
