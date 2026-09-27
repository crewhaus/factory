import { constants } from "node:os";
import { type SpawnBoundedResult, spawnBounded } from "@crewhaus/tool-safety/streams";

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
 *     grace period for a child that ignores the first signal. The child
 *     leads its own process group and the deadline (or an abort) signals the
 *     whole group, so a `cmd &` it started cannot outlive the timeout.
 *   - the child runs in a SESSION of its own (spawnBounded's detached spawn,
 *     setsid), so it has no controlling terminal. That is deliberate, and a
 *     change from 0.7.0: a model-run command cannot read the operator's
 *     keystrokes from /dev/tty (the answers typed into the harness's own
 *     approval prompt), cannot push input into that terminal (TIOCSTI), and
 *     a `sudo`/`ssh`/`gpg` prompt fails at once instead of waiting on a
 *     terminal the model cannot see. Bun has no "own process group but keep
 *     the terminal" spawn, and the group is what makes the deadline real.
 *     The background family (ProcessStart) keeps 0.7.0's spawn.
 *   - both streams are capped AS THEY ARE READ (C078). The foreground run is
 *     @crewhaus/tool-safety's `spawnBounded`: memory is bounded by the cap,
 *     not by what the child prints, and the reader keeps draining past the
 *     cap so a child never blocks on a full pipe.
 *   - output a grandchild still holds open after the child exits is read for
 *     a bounded grace, then reading stops and the stream is cancelled: the
 *     result keeps what arrived and says `outputIncomplete`, never "".
 */

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
  /**
   * Set when reading stopped before a stream ended: the child exited but a
   * process it started still held its output open past the drain grace. The
   * text is what arrived by then — possibly all of it, possibly not.
   */
  readonly outputIncomplete?: boolean;
};

export type RunOptions = {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  readonly maxOutputChars: number;
  readonly signal?: AbortSignal;
};

/** No UTF-16 code unit takes more than three bytes of UTF-8. */
const BYTES_PER_CHAR = 3;

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** `text` cut to at most `chars` UTF-16 units from the front, never mid-pair. */
function headChars(text: string, chars: number): string {
  if (text.length <= chars) return text;
  const cut = text.slice(0, chars);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** `text` cut to at most `chars` UTF-16 units from the end, never mid-pair. */
function tailChars(text: string, chars: number): string {
  if (chars <= 0) return "";
  if (text.length <= chars) return text;
  const cut = text.slice(text.length - chars);
  const first = cut.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? cut.slice(1) : cut;
}

/**
 * One stream, capped to `maxChars`: its head and its tail — a command's head
 * says what it started doing, its tail how it ended — with a marker stating
 * exactly how many BYTES were dropped between them. Bytes, because the part
 * past the byte budget was counted as it streamed past and never decoded.
 */
function capStream(
  head: string,
  tail: string | undefined,
  truncated: boolean,
  omittedBytes: number,
  maxChars: number,
): { text: string; truncated: boolean } {
  const headRoom = Math.floor(maxChars / 2);
  const tailRoom = maxChars - headRoom;
  if (!truncated) {
    if (head.length <= maxChars) return { text: head, truncated: false };
    const h = headChars(head, headRoom);
    const t = tailChars(head, tailRoom);
    const dropped = utf8Bytes(head) - utf8Bytes(h) - utf8Bytes(t);
    return { text: `${h}\n...[${dropped} bytes dropped]...\n${t}`, truncated: true };
  }
  const h = headChars(head, headRoom);
  const whole = tail ?? "";
  const t = tailChars(whole, tailRoom);
  const dropped =
    omittedBytes + (utf8Bytes(head) - utf8Bytes(h)) + (utf8Bytes(whole) - utf8Bytes(t));
  return { text: `${h}\n...[${dropped} bytes dropped]...\n${t}`, truncated: true };
}

/** The exit status a shell would report: 128 + the signal's number for a signalled child. */
function exitStatus(r: SpawnBoundedResult): number {
  if (r.exitCode !== null) return r.exitCode;
  if (r.signal !== null) {
    const n = (constants.signals as Record<string, number | undefined>)[r.signal];
    if (n !== undefined) return 128 + n;
  }
  return -1;
}

export async function runOnce(argv: readonly string[], options: RunOptions): Promise<RunOutcome> {
  const max = Math.max(0, options.maxOutputChars);
  const tailRoom = max - Math.floor(max / 2);
  const r = await spawnBounded({
    cmd: argv,
    cwd: options.cwd,
    env: options.env,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    timeoutMs: options.timeoutMs,
    maxStdoutBytes: max * BYTES_PER_CHAR,
    maxStderrBytes: max * BYTES_PER_CHAR,
    tailBytes: tailRoom * BYTES_PER_CHAR,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (r.spawnError !== undefined) {
    return {
      argv,
      exitCode: -1,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      durationMs: r.durationMs,
      spawnError: r.spawnError,
    };
  }
  const out = capStream(r.stdout, r.stdoutTail, r.stdoutTruncated, r.stdoutOmittedBytes, max);
  const err = capStream(r.stderr, r.stderrTail, r.stderrTruncated, r.stderrOmittedBytes, max);
  return {
    argv,
    exitCode: r.abandoned ? -1 : exitStatus(r),
    stdout: out.text,
    stderr: err.text,
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
    timedOut: r.timedOut || r.abandoned,
    durationMs: r.durationMs,
    ...(r.abandoned ? { abandoned: true } : {}),
    ...(r.outputComplete ? {} : { outputIncomplete: true }),
  };
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
