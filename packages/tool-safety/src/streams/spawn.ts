import { type CollectResult, collectBounded } from "./collect";

/**
 * Running a child process with every resource it can consume bounded.
 *
 * The defects this closes, all seen in shipped tools:
 *   - output read to EOF into memory and capped afterwards (a `yes` reached
 *     7 GiB in four seconds);
 *   - a drain that outlived its grace period replaced with "", so a command
 *     whose background grandchild kept the pipe open reported `ok` with empty
 *     output — a definite-looking answer built from nothing;
 *   - a timeout that signalled the child and left its children running.
 *
 * So: output is collected with {@link collectBounded} as it arrives; the
 * child runs in its own process group and a timeout or abort signals the
 * whole group (SIGTERM, then SIGKILL after `killGraceMs`); and when the
 * output could not be read to the end, `outputComplete` is false and the
 * bytes that did arrive are returned — never replaced with nothing.
 *
 * POSIX only for the group kill. On Windows the tree is stopped with
 * `taskkill /T /F`, best effort.
 *
 * A child that exits normally but leaves a background process holding its
 * pipes is NOT killed — it may be a daemon the command meant to start. The
 * drain is abandoned after `drainGraceMs` and reported incomplete.
 */

export type SpawnBoundedOptions = {
  /** argv, passed to the OS as an array — never through a shell. */
  readonly cmd: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Written to the child's stdin, which is then closed. Omitted: stdin is ignored (EOF). */
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  /** Aborting kills the process group, as a timeout does. */
  readonly signal?: AbortSignal;
  /** Of each cap, bytes kept from the END of the stream when it overflows. Default 0. */
  readonly tailBytes?: number;
  /**
   * What to do when a stream passes its cap: keep draining and discarding
   * (default), or kill the process group — for a producer whose output
   * past the cap is worthless (a verifier whose verdict is one line).
   */
  readonly onOverflow?: "drain" | "kill";
  /** SIGTERM → SIGKILL grace. Default 2000. */
  readonly killGraceMs?: number;
  /** After the child exits, how long its pipes may stay open before reading stops. Default 500. */
  readonly drainGraceMs?: number;
  /** After SIGKILL, how long to wait for the child to be reaped before giving up on it. Default 1000. */
  readonly reapGraceMs?: number;
};

export type SpawnBoundedResult = {
  /** The child's pid (and process-group id on POSIX); absent when it never started. */
  readonly pid?: number;
  /** Null when the child died of a signal, was never reaped, or never started. */
  readonly exitCode: number | null;
  /** The signal that ended the child, e.g. "SIGKILL". */
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** Killed because a stream passed its cap (`onOverflow: "kill"`). */
  readonly killedForOverflow: boolean;
  /**
   * Never reaped after SIGKILL (a process in an uninterruptible wait). The
   * result is what had arrived by then.
   */
  readonly abandoned: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** Bytes the child wrote, kept or not. */
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  /** Present when truncated with `tailBytes`. */
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  /**
   * Both streams were read to their end. False means the text above is what
   * arrived before reading stopped — possibly all of it, possibly not — and
   * must not be treated as the command's complete output.
   */
  readonly outputComplete: boolean;
  /** The command could not be started at all. */
  readonly spawnError?: string;
  readonly durationMs: number;
};

export const SPAWN_DEFAULTS = {
  killGraceMs: 2_000,
  drainGraceMs: 500,
  reapGraceMs: 1_000,
} as const;

const isWindows = process.platform === "win32";

function killTree(pid: number, sig: "SIGTERM" | "SIGKILL", fallback: (s: string) => void): void {
  if (isWindows) {
    try {
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } catch {
      fallback(sig);
    }
    return;
  }
  try {
    // Negative pid: the whole process group the detached child leads.
    process.kill(-pid, sig);
  } catch {
    // The group is gone, or was never formed; signal the child itself.
    fallback(sig);
  }
}

const sleep = (ms: number): { promise: Promise<void>; cancel: () => void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
};

export async function spawnBounded(options: SpawnBoundedOptions): Promise<SpawnBoundedResult> {
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  const killGraceMs = options.killGraceMs ?? SPAWN_DEFAULTS.killGraceMs;
  const drainGraceMs = options.drainGraceMs ?? SPAWN_DEFAULTS.drainGraceMs;
  const reapGraceMs = options.reapGraceMs ?? SPAWN_DEFAULTS.reapGraceMs;

  const empty = {
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    killedForOverflow: false,
    abandoned: false,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    outputComplete: true,
  } as const;

  if (options.signal?.aborted === true) {
    return { ...empty, aborted: true, durationMs: elapsed() };
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...options.cmd], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      stdin:
        options.stdin === undefined
          ? "ignore"
          : typeof options.stdin === "string"
            ? new TextEncoder().encode(options.stdin)
            : options.stdin,
      stdout: "pipe",
      stderr: "pipe",
      detached: !isWindows,
    });
  } catch (err) {
    return {
      ...empty,
      spawnError: err instanceof Error ? err.message : String(err),
      durationMs: elapsed(),
    };
  }

  let timedOut = false;
  let aborted = false;
  let killedForOverflow = false;
  let killStarted = false;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  let reapGiveUp: { promise: Promise<void>; cancel: () => void } | undefined;
  let onKillStarted: () => void = () => undefined;
  const killStartedP = new Promise<void>((resolve) => {
    onKillStarted = resolve;
  });

  const signalChild = (s: string): void => {
    try {
      proc.kill(s as NodeJS.Signals);
    } catch {
      // Already gone.
    }
  };
  const beginKill = (): void => {
    if (killStarted) return;
    killStarted = true;
    killTree(proc.pid, "SIGTERM", signalChild);
    hardKill = setTimeout(() => killTree(proc.pid, "SIGKILL", signalChild), killGraceMs);
    reapGiveUp = sleep(killGraceMs + reapGraceMs);
    onKillStarted();
  };

  const drainStop = new AbortController();
  const collect = (stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<CollectResult> =>
    collectBounded(stream, {
      maxBytes,
      ...(options.tailBytes === undefined ? {} : { tailBytes: options.tailBytes }),
      signal: drainStop.signal,
      onChunk: (_chunk, total) => {
        if (total > maxBytes && options.onOverflow === "kill" && !killStarted) {
          killedForOverflow = true;
          beginKill();
        }
      },
    });
  const stdoutP = collect(proc.stdout as ReadableStream<Uint8Array>, options.maxStdoutBytes);
  const stderrP = collect(proc.stderr as ReadableStream<Uint8Array>, options.maxStderrBytes);

  const deadline = setTimeout(() => {
    timedOut = true;
    beginKill();
  }, options.timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    beginKill();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let abandoned = false;
  try {
    // Wait for the child — but once a kill has started, not past the reap
    // grace: SIGKILL cannot interrupt an uninterruptible kernel wait, and
    // every other bound here is downstream of this await.
    const first = await Promise.race([
      proc.exited.then(() => "exited" as const),
      killStartedP.then(() => "killing" as const),
    ]);
    if (first === "killing" && reapGiveUp !== undefined) {
      const second = await Promise.race([
        proc.exited.then(() => "exited" as const),
        reapGiveUp.promise.then(() => "gave-up" as const),
      ]);
      abandoned = second === "gave-up";
    }

    // The child is gone (or given up on). Its pipes may still be held by a
    // grandchild; give the drain a bounded window, then stop reading.
    const grace = sleep(abandoned ? 0 : drainGraceMs);
    const drained = await Promise.race([
      Promise.all([stdoutP, stderrP]).then(() => true),
      grace.promise.then(() => false),
    ]);
    grace.cancel();
    if (!drained) drainStop.abort();
    const [out, err] = await Promise.all([stdoutP, stderrP]);

    return {
      pid: proc.pid,
      exitCode: abandoned ? null : proc.exitCode,
      signal: abandoned ? null : (proc.signalCode ?? null),
      timedOut,
      aborted,
      killedForOverflow,
      abandoned,
      stdout: out.text,
      stderr: err.text,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      stdoutBytes: out.totalBytes,
      stderrBytes: err.totalBytes,
      ...(out.tailText === undefined ? {} : { stdoutTail: out.tailText }),
      ...(err.tailText === undefined ? {} : { stderrTail: err.tailText }),
      outputComplete: out.complete && err.complete,
      durationMs: elapsed(),
    };
  } finally {
    clearTimeout(deadline);
    if (hardKill !== undefined) clearTimeout(hardKill);
    reapGiveUp?.cancel();
    options.signal?.removeEventListener("abort", onAbort);
    if (!drainStop.signal.aborted) drainStop.abort();
  }
}
