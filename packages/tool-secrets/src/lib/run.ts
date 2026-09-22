/**
 * The one place this package starts a child process, and the seam every test
 * drives instead.
 *
 * The conventions are `@crewhaus/tool-proc`'s, deliberately copied rather than
 * re-invented (see that package's `spawn.ts`):
 *
 *   - argv is an ARRAY handed straight to the OS. There is no shell anywhere
 *     in this package, so a service name containing a space, a quote or a
 *     `$(...)` is an argument and never syntax.
 *   - stdin is `ignore` unless the caller supplied it, so a backend that would
 *     prompt for a passphrase gets EOF instead of hanging on a terminal that
 *     is not there.
 *   - every run has a deadline: SIGTERM on expiry, SIGKILL after a grace.
 *   - both streams are capped.
 *
 * Two rules are this package's own, because what comes back on stdout here is
 * a SECRET rather than a program's chatter:
 *
 *   1. A capped stdout is reported as `truncated` and the caller must refuse
 *      to fingerprint it. A fingerprint computed over the first 64 KiB of a
 *      longer value is a confident wrong answer — it would report "unchanged"
 *      across a rotation that only altered the tail.
 *   2. The child environment is a NAMED forward list, not `process.env`. A
 *      credential helper inherits what it genuinely needs to find its own
 *      store and nothing else, so the harness's other secrets are not handed
 *      to a third-party binary.
 *
 * `_setRunner` is the seam. Every test in this package drives it from recorded
 * output; nothing in the suite runs a credential helper, because CI is Linux,
 * the author's machine is macOS, and a test that asks the real host a question
 * gets a different answer on each.
 */

/** What one command did. Modelled on tool-proc's `RunOutcome`. */
export type CommandRun = {
  readonly argv: readonly string[];
  readonly exitCode: number;
  /** Raw stdout. For a resolve backend this IS the secret — never report it. */
  readonly stdout: string;
  readonly stderr: string;
  /** stdout hit the cap: the value is incomplete and must not be fingerprinted. */
  readonly truncated: boolean;
  readonly timedOut: boolean;
  /** Set when the program could not be started at all (usually ENOENT). */
  readonly spawnError?: string;
};

export type CommandOptions = {
  readonly timeoutMs: number;
  /** Written to the child and then closed. Rotation writes the new value here
   *  rather than into argv, because argv is world-readable through `ps`. */
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
};

export type CommandRunner = (
  argv: readonly string[],
  options: CommandOptions,
) => Promise<CommandRun>;

/** A secret longer than this is pathological; past it we stop trusting it. */
export const MAX_VALUE_CHARS = 65_536;
/** Diagnostics only — enough for the first line of any helper's complaint. */
const MAX_STDERR_CHARS = 4_000;
/** Grace between the deadline's SIGTERM and the SIGKILL that follows it. */
const KILL_GRACE_MS = 2_000;
/** A killed helper can leave a grandchild holding the pipe open. */
const DRAIN_GRACE_MS = 500;

/**
 * Environment names forwarded to a credential helper, and why each one is
 * here. Everything else is dropped: the harness's own API keys have no
 * business inside `pass` or `op`.
 */
export const FORWARDED_ENV: readonly string[] = [
  // Finding the binary and the user's own store.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  // libsecret talks to the session keyring over D-Bus; without these
  // `secret-tool` fails with "Cannot autolaunch D-Bus without X11 $DISPLAY",
  // which is the single most common CI symptom and one we want to REPORT
  // rather than cause.
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  // password-store: where the tree and the GPG home live.
  "PASSWORD_STORE_DIR",
  "GNUPGHOME",
  // 1Password CLI: a service-account or Connect token, and the account it
  // should act as. These are the only credentials deliberately passed on.
  "OP_SERVICE_ACCOUNT_TOKEN",
  "OP_CONNECT_HOST",
  "OP_CONNECT_TOKEN",
  "OP_ACCOUNT",
];

/**
 * Build the child environment from a source env.
 *
 * `LC_ALL=C` pins the helper's own diagnostics to one language, so the
 * classifier in `./backends` matches the same bytes on a French laptop as in
 * CI. `GPG_TTY` is deliberately NOT forwarded and `GPG_BATCH`-style prompting
 * is left to fail: a helper that wants a passphrase should fail fast and be
 * reported, not block until the deadline.
 */
export function buildChildEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of FORWARDED_ENV) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env["LC_ALL"] = "C";
  return env;
}

/** Read a pipe into a string that can never exceed `cap` characters. */
async function readCapped(
  stream: ReadableStream<Uint8Array> | null | undefined,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  if (stream === null || stream === undefined) return { text: "", truncated: false };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done === true) break;
      // Keep draining after the cap: a helper blocked writing to a full pipe
      // never exits, and the exit code is how "not found" is detected.
      if (truncated) continue;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > cap) {
        text = text.slice(0, cap);
        truncated = true;
      }
    }
    if (!truncated) text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return { text, truncated };
}

/** Await a pipe's text, giving up after the grace instead of hanging. */
async function drain(
  pending: Promise<{ text: string; truncated: boolean }>,
): Promise<{ text: string; truncated: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), DRAIN_GRACE_MS);
  });
  try {
    const settled = await Promise.race([pending.catch(() => null), fallback]);
    // A dropped read is a CUT value, not an empty one: `truncated` is set so
    // nothing downstream fingerprints half a secret.
    return settled === null ? { text: "", truncated: true } : settled;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The production runner. Replaced wholesale in tests via `_setRunner`. */
export async function spawnRunner(
  argv: readonly string[],
  options: CommandOptions,
): Promise<CommandRun> {
  const env = buildChildEnv(process.env);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env,
      stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (err) {
    // Bun throws synchronously when the program is not on PATH — this is how
    // "the backend is not installed" is detected, rather than by probing PATH
    // ourselves and racing the answer.
    return {
      argv,
      exitCode: -1,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
      spawnError: err instanceof Error ? err.message : String(err),
    };
  }

  let timedOut = false;
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
    const stdoutRead = readCapped(proc.stdout as ReadableStream<Uint8Array>, MAX_VALUE_CHARS);
    const stderrRead = readCapped(proc.stderr as ReadableStream<Uint8Array>, MAX_STDERR_CHARS);
    const exitCode = await proc.exited;
    const [out, err] = await Promise.all([drain(stdoutRead), drain(stderrRead)]);
    return {
      argv,
      exitCode,
      stdout: out.text,
      stderr: err.text,
      truncated: out.truncated,
      timedOut,
    };
  } finally {
    clearTimeout(term);
    clearTimeout(hardKill);
  }
}

let runner: CommandRunner = spawnRunner;

/**
 * Test seam. `_setRunner(undefined)` restores the real spawner.
 *
 * Every parser in `./backends` takes its input through here, so a test can
 * replay a recorded macOS `security` failure on a Linux CI box and get the
 * same classification either way.
 */
export function _setRunner(fn: CommandRunner | undefined): void {
  runner = fn ?? spawnRunner;
}

export function runCommand(argv: readonly string[], options: CommandOptions): Promise<CommandRun> {
  return runner(argv, options);
}
