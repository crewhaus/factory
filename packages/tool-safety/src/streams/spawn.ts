import { onAbort } from "../signal";
import { type CollectResult, collectBounded } from "./collect";
import { byteBudget, deadlineMs, graceMs, optionalByteBudget } from "./limits";

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
 * whole group (SIGTERM, then SIGKILL after `killGraceMs`, whether or not
 * the child itself has exited by then); and when the output could not be
 * read to the end, `outputComplete` is false and the bytes that did arrive
 * are returned — never replaced with nothing.
 *
 * Because the child leads its own group, a terminal Ctrl-C that kills the
 * host does not reach it. So the groups of commands still running are
 * killed when the host exits (`process.exit`, or the end of the event loop),
 * and on SIGINT, SIGTERM or SIGHUP when nothing else in the process listens
 * for that signal — the host then dies of it as it would have. A host that
 * handles those signals itself keeps that policy; it should pass the turn's
 * abort signal to every call, and its own exit path is covered by the exit
 * hook. {@link setHostExitCleanup} turns this off.
 *
 * POSIX only for the group kill. On Windows the tree is stopped with
 * `taskkill /T /F`, best effort, and there is no host-exit cleanup.
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
  /**
   * Milliseconds before the group is killed: a number > 0, or `Infinity`
   * for no timeout. NaN, 0 or a negative number throws a `RangeError`.
   */
  readonly timeoutMs: number;
  /**
   * Byte caps, finite numbers >= 0. For a cap in characters (`maxOutputChars`),
   * pass 3 × the characters: no UTF-16 code unit takes more than three bytes
   * of UTF-8. Then cut the decoded text to the character cap, and count
   * what was dropped from `…OmittedBytes` and the bytes of the text cut off.
   */
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
  /** The kept stdout as UTF-8; an incomplete final character is dropped when truncated. */
  readonly stdout: string;
  readonly stderr: string;
  /** The kept stdout bytes, exactly as the child wrote them: for binary output. */
  readonly stdoutRaw: Uint8Array;
  readonly stderrRaw: Uint8Array;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** Bytes the child wrote, kept or not. */
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  /** Bytes written but neither in `…Raw` nor in the tail: exactly what was dropped. */
  readonly stdoutOmittedBytes: number;
  readonly stderrOmittedBytes: number;
  /** Present when truncated with `tailBytes`. */
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly stdoutTailRaw?: Uint8Array;
  readonly stderrTailRaw?: Uint8Array;
  /**
   * Both streams were read to their end. False means the text above is what
   * arrived before reading stopped — possibly all of it, possibly not — and
   * must not be treated as the command's complete output.
   */
  readonly outputComplete: boolean;
  /** The command could not be started at all. */
  readonly spawnError?: string;
  /**
   * The errno code behind `spawnError` when there is one: `ENOENT` for a
   * command that is not installed, `EACCES` for one that may not be run.
   * Bun's message for a missing command does not contain the code.
   */
  readonly spawnErrorCode?: string;
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

// ─── Host-exit cleanup ──────────────────────────────────────────────────────

/** Process groups of commands still running, or still being killed. */
const liveGroups = new Set<number>();
let cleanupEnabled = true;
let hooksInstalled = false;
const HOST_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function killLiveGroups(): void {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  liveGroups.clear();
  uninstallHooks();
}

/** Track a group; the host hooks exist only while some group is tracked. */
function track(group: number): void {
  if (isWindows) return;
  liveGroups.add(group);
  installHooks();
}

function untrack(group: number): void {
  liveGroups.delete(group);
  if (liveGroups.size === 0) uninstallHooks();
}

const onHostExit = (): void => killLiveGroups();

function onHostSignal(sig: NodeJS.Signals): void {
  // Another listener means the host has its own policy for this signal
  // (a first Ctrl-C that only aborts the turn, say). Leave it alone.
  if (process.listenerCount(sig) > 1) return;
  killLiveGroups();
  // Die of the signal, as the host would have without this listener.
  process.kill(process.pid, sig);
}

function installHooks(): void {
  if (hooksInstalled || !cleanupEnabled || isWindows) return;
  hooksInstalled = true;
  process.on("exit", onHostExit);
  for (const sig of HOST_SIGNALS) process.on(sig, onHostSignal);
}

function uninstallHooks(): void {
  if (!hooksInstalled) return;
  hooksInstalled = false;
  process.off("exit", onHostExit);
  for (const sig of HOST_SIGNALS) process.off(sig, onHostSignal);
}

/**
 * Whether the process groups of commands still running are killed when the
 * host exits (default true; see the module comment). The listeners exist
 * only while a command runs. Turning this off removes them; turning it on
 * again installs them at the next spawn.
 */
export function setHostExitCleanup(enabled: boolean): void {
  cleanupEnabled = enabled;
  if (enabled && liveGroups.size > 0) installHooks();
  if (!enabled) uninstallHooks();
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
  // Parse every limit before anything starts: a NaN here used to become an
  // empty "complete" output, or a kill on the spot.
  const timeoutDelay = deadlineMs("timeoutMs", options.timeoutMs);
  const maxStdoutBytes = byteBudget("maxStdoutBytes", options.maxStdoutBytes);
  const maxStderrBytes = byteBudget("maxStderrBytes", options.maxStderrBytes);
  const tailBytes = optionalByteBudget("tailBytes", options.tailBytes, 0);
  const killGraceMs = graceMs("killGraceMs", options.killGraceMs, SPAWN_DEFAULTS.killGraceMs);
  const drainGraceMs = graceMs("drainGraceMs", options.drainGraceMs, SPAWN_DEFAULTS.drainGraceMs);
  const reapGraceMs = graceMs("reapGraceMs", options.reapGraceMs, SPAWN_DEFAULTS.reapGraceMs);

  const empty = {
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: false,
    killedForOverflow: false,
    abandoned: false,
    stdout: "",
    stderr: "",
    stdoutRaw: new Uint8Array(0),
    stderrRaw: new Uint8Array(0),
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutOmittedBytes: 0,
    stderrOmittedBytes: 0,
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
    const code = (err as { code?: unknown }).code;
    return {
      ...empty,
      spawnError: err instanceof Error ? err.message : String(err),
      ...(typeof code === "string" ? { spawnErrorCode: code } : {}),
      durationMs: elapsed(),
    };
  }
  const group = proc.pid;
  track(group);

  let timedOut = false;
  let aborted = false;
  let killedForOverflow = false;
  let killStarted = false;
  let hardKillSent = false;
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
    killTree(group, "SIGTERM", signalChild);
    // Not cleared when the child exits: another member of its group may
    // ignore SIGTERM, and "then SIGKILL" is the promise. The timer is
    // unref'd, and the group stays registered for host-exit cleanup until
    // it fires.
    hardKill = setTimeout(() => {
      hardKillSent = true;
      killTree(group, "SIGKILL", signalChild);
      untrack(group);
    }, killGraceMs);
    hardKill.unref?.();
    reapGiveUp = sleep(killGraceMs + reapGraceMs);
    onKillStarted();
  };

  const drainStop = new AbortController();
  const collect = (stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<CollectResult> =>
    collectBounded(stream, {
      maxBytes,
      tailBytes,
      signal: drainStop.signal,
      onChunk: (_chunk, total) => {
        if (total > maxBytes && options.onOverflow === "kill" && !killStarted) {
          killedForOverflow = true;
          beginKill();
        }
      },
    });
  const stdoutP = collect(proc.stdout as ReadableStream<Uint8Array>, maxStdoutBytes);
  const stderrP = collect(proc.stderr as ReadableStream<Uint8Array>, maxStderrBytes);

  const deadline =
    timeoutDelay === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          beginKill();
        }, timeoutDelay);
  const unsubscribe = onAbort(options.signal, () => {
    aborted = true;
    beginKill();
  });

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
      stdoutRaw: out.bytes,
      stderrRaw: err.bytes,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      stdoutBytes: out.totalBytes,
      stderrBytes: err.totalBytes,
      stdoutOmittedBytes: out.omittedBytes,
      stderrOmittedBytes: err.omittedBytes,
      ...(out.tail === undefined ? {} : { stdoutTail: out.tailText, stdoutTailRaw: out.tail }),
      ...(err.tail === undefined ? {} : { stderrTail: err.tailText, stderrTailRaw: err.tail }),
      outputComplete: out.complete && err.complete,
      durationMs: elapsed(),
    };
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
    // A kill in progress keeps its SIGKILL timer (see beginKill); otherwise
    // the command is over and its group is no longer ours to clean up.
    if (!killStarted || hardKillSent) untrack(group);
    if (!killStarted && hardKill !== undefined) clearTimeout(hardKill);
    reapGiveUp?.cancel();
    unsubscribe();
    if (!drainStop.signal.aborted) drainStop.abort();
  }
}
