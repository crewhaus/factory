/**
 * The one place this package starts a child process, and the seam every test
 * drives instead of the machine.
 *
 * The conventions are `@crewhaus/tool-proc`'s (`src/spawn.ts`) and
 * `@crewhaus/tool-pkgmgr`'s (`src/run.ts`), copied rather than re-invented:
 *
 *   - ARGV IS AN ARRAY. There is no shell in this package: no `sh -c`, no
 *     `cmd /c`, no interpolated command line. A caller's value is an ELEMENT
 *     of an argv array or it does not reach a command at all. `assertArgv`
 *     refuses anything that would make that untrue BEFORE a process exists.
 *   - EVERY RUN HAS A DEADLINE. SIGTERM at the deadline, SIGKILL after a
 *     grace period, and a bounded drain. The drain bound is load-bearing
 *     here, not defensive: `xclip -i` and `wl-copy` DELIBERATELY fork a
 *     resident holder (under X11 and Wayland the writing process owns the
 *     selection, so it must outlive the tool call), and that holder inherits
 *     the stdout pipe. Reading to EOF would block until the operator copies
 *     something else — possibly for hours.
 *   - THE ENVIRONMENT IS PINNED. `PATH` plus a C locale, plus whatever the
 *     backend explicitly adds. Nothing else is inherited, so the harness's
 *     secrets are not in `pbpaste`'s environment.
 *
 * TWO DELIBERATE EXCEPTIONS, BOTH SECURITY MEASURES RATHER THAN CONVENIENCES.
 *
 * 1. `RunRequest.env` exists so a value can reach a PowerShell script WITHOUT
 *    being in the script's source. `powershell.exe -Command <script> a b c`
 *    CONCATENATES the trailing arguments onto the command string — argv is
 *    not a safe channel there the way it is for `notify-send`. So the Windows
 *    backends put caller values in the child's environment and the script
 *    reads `$env:CREWHAUS_*`. See ./lib/escape.ts, where that decision lives.
 * 2. `RunRequest.stdin` is the channel for a PAYLOAD. `ClipboardWrite` pipes
 *    its text in rather than passing it as an argument, because argv is
 *    world-readable through `ps` on both macOS and Linux and a clipboard
 *    payload is exactly the kind of thing an operator would not want in a
 *    process listing.
 *
 * ── WHY THE "REAL HOST" GATE LIVES HERE AND NOT IN host.ts ────────────────
 *
 * `host.ts` imports from this file; this file imports from nothing in the
 * package. The gate that decides whether an un-injected seam may consult the
 * real machine is read by BOTH (`hostPlatform()` and `sessionEnv()` need it
 * as much as `runHostCommand` does), so it is defined in the file at the
 * bottom of the dependency order. An earlier draft had it in `host.ts` and
 * `run.ts` importing it back, which is an ESM cycle: it happens to work while
 * every use is inside a function body, and breaks the first time either file
 * grows a module-scope constant that reads the other.
 */

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

// ---------------------------------------------------------------------------
// the real-host gate
// ---------------------------------------------------------------------------

/**
 * Whether an un-injected seam may consult the real machine.
 *
 * False under `bun test`. Bun sets `NODE_ENV=test` for its own runner
 * (verified on bun 1.3.14 by printing it from inside a test), which is the
 * only signal available without a shared setup file — and a setup file is
 * exactly the thing a new test file forgets to import.
 *
 * `@crewhaus/tool-pkgmgr` deliberately has NO equivalent: it ties its hostile
 * default to the runner seam alone and says so. This package is stricter on
 * purpose, because the failure it is guarding against is worse here. A
 * pkgmgr test that forgets `_setRunner` runs `brew list`; a test in THIS
 * package that forgets it pops a real toast on the maintainer's screen, sends
 * a real job to a real printer, reads whatever the operator last copied into
 * a transcript, or parks a `caffeinate` on their laptop. The runner-seam tie
 * is still here and is still the primary guard (see `hostPlatform`); this is
 * the belt under it, for the case where the seam was never installed at all.
 *
 * The residual cost is stated plainly: a harness deliberately run with
 * `NODE_ENV=test` gets `unavailable` from every tool here, with the reason
 * naming the gate. That is fail-closed, and it is visible rather than silent.
 */
let realHostAllowed = process.env["NODE_ENV"] !== "test";

/**
 * Opt in to (or out of) the real machine for an un-injected seam.
 *
 * Exactly one test in this package calls it with `true`, and restores it in
 * the same `finally`. Everything else drives a fixture.
 */
export function _allowRealHost(allowed: boolean): void {
  realHostAllowed = allowed;
}

export function _realHostAllowed(): boolean {
  return realHostAllowed;
}

/**
 * True when a runner is installed.
 *
 * Read by `host.ts` to decide the platform default: a test that has installed
 * a recorded runner has already declared "I am not talking to this host", so
 * if it then forgets to declare which host it is PRETENDING to be it gets a
 * platform no backend serves — identically on macOS and on Linux CI. That
 * exact bug (a test inheriting the ambient `process.platform`) cost this
 * project a CI round in tool-hostfs.
 */
export function _runnerInstalled(): boolean {
  return runnerOverride !== undefined;
}

// ---------------------------------------------------------------------------
// argv hygiene
// ---------------------------------------------------------------------------

/**
 * Programs that turn a careful argv array back into one string.
 *
 * The moment argv[0] is `sh`, every escaping guarantee in this package
 * evaporates: the elements after `-c` are source again. Refusing the family
 * structurally is cheaper than auditing each new backend for it.
 *
 * `powershell` IS NOT IN THIS LIST, and that is a carve-out, not an
 * oversight. Two of the three Windows backends here genuinely are PowerShell,
 * run as `powershell.exe <fixed flags> <registered script>` with every caller
 * value in the ENVIRONMENT. The guarantee that replaces the blanket refusal
 * is narrower and checkable: `powershellArgv` only emits a script object
 * registered at module scope, and nothing is ever appended after it (which is
 * what would put a caller's value back into source). `every powershell argv
 * is a registered script with nothing appended` in index.test.ts asserts that
 * over every recorded call.
 */
const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "fish",
  "cmd",
  "cmd.exe",
  "command.com",
  "env",
  "eval",
  "xargs",
]);

/**
 * House rule 7, enforced structurally rather than only asserted.
 *
 * No tool here acquires privilege. Being root and BECOMING root are different
 * things, and this package does neither — it uses what the process already
 * has. The check covers more than argv[0], because `systemd-inhibit sudo …`
 * is the same escalation one position over.
 */
const ESCALATORS = /^(sudo|doas|runas|pkexec|gksudo|gksu)$/i;
/**
 * `su` is refused as argv[0] only.
 *
 * As a later element it is a plausible VALUE — a CUPS destination may
 * legitimately be called `su`, and `SAFE_DESTINATION` accepts it — so
 * refusing it everywhere would reject a correct print with a message about
 * privilege that made no sense.
 */
const ESCALATOR_PROGRAMS = /^(sudo|doas|runas|pkexec|gksudo|gksu|su)$/i;

/**
 * Could this element be NAMING A PROGRAM, rather than carrying a caller value?
 *
 * ADVERSARIAL REVIEW FOUND THAT THE ANSWER MATTERS. The first version of the
 * escalation scan took `arg.split(/[\\/]/).pop()` of EVERY element and
 * matched that against `ESCALATORS`, which made
 * `OpenExternal({target:"https://docs.example.com/guides/sudo"})` — an
 * ordinary https URL the scheme allow-list had already approved — come back
 * as `argv names "…", and this package never escalates privilege`. A
 * notification body of `see /var/log/sudo` did the same. That is a refusal a
 * caller cannot act on, for a value that could never have been a program:
 * the check was reading a path SEGMENT out of data.
 *
 * It is the trap the `su` carve-out above was written for, one step further
 * out. So a path segment is only read out of an element that could plausibly
 * be a command path: no whitespace, no leading `-` (that is an option), and
 * none of `:` `=` `?` `#` (a URI, an `--opt=value`, a query). An element that
 * is EXACTLY an escalator name is still refused whatever its shape, which is
 * what catches the mistake this rule exists for — a future backend writing
 * `["systemd-inhibit", "--what=idle", "sudo", "sleep", "60"]`.
 *
 * The residual is stated rather than hidden: a caller value that is itself a
 * bare path ending in `/sudo`, in a position with no `--` in front of it, is
 * still refused — `xdg-open /ws/sudo` and `lp /ws/sudo` are the two places
 * that can happen, because neither program has a `--`. That is rare and it
 * fails closed.
 */
function couldNameAProgram(arg: string): boolean {
  return arg !== "" && !arg.startsWith("-") && !/[\s:=?#]/.test(arg);
}

export function assertArgv(argv: readonly string[]): string | undefined {
  const program = argv[0];
  if (program === undefined || program.trim() === "") {
    return "argv[0] must name a program to run";
  }
  const base = (program.split(/[\\/]/).pop() ?? program).toLowerCase();
  if (SHELLS.has(base)) {
    return `argv[0] is "${base}", and this package never runs a shell — an argv array handed to a shell is a command line again`;
  }
  if (ESCALATOR_PROGRAMS.test(base.replace(/\.exe$/i, ""))) {
    return `argv[0] is "${base}", and this package never escalates privilege`;
  }
  // Everything after the first `--` is a POSITIONAL by this package's own
  // construction — that separator is only ever emitted to make the tail
  // data — so the escalation scan stops there. The NUL check does not: a NUL
  // truncates an argument at the syscall boundary wherever it sits.
  const separator = argv.indexOf("--");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== "string") return "every argv element must be a string";
    // A NUL byte truncates an argument at the syscall boundary: a string that
    // reads as harmless here arrives at the kernel cut short at the NUL, with
    // whatever followed it gone.
    if (arg.includes("\u0000")) return "argv may not contain a NUL byte";
    if (separator >= 0 && i > separator) continue;
    const whole = arg.replace(/\.exe$/i, "");
    const argBase = couldNameAProgram(arg)
      ? (arg.split(/[\\/]/).pop() ?? arg).replace(/\.exe$/i, "")
      : whole;
    if (ESCALATORS.test(argBase)) {
      return `argv names "${arg}", and this package never escalates privilege`;
    }
  }
  return undefined;
}

/**
 * A child's environment: `PATH` so the program can be found, a C locale so a
 * parsed message is the same string on every machine, and the backend's
 * explicit additions (a display, a D-Bus address, a `CREWHAUS_*` payload).
 *
 * Nothing else. `process.env` is NOT copied in: `pbpaste` has no business
 * seeing an API key, and neither does a PowerShell one-liner. The session
 * variables a Linux backend needs arrive through `extra`, put there by a
 * backend reading the INJECTED `sessionEnv()` — so a test controls them like
 * everything else rather than inheriting whether the maintainer happened to
 * be in an SSH session.
 */
export function childEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
  const inherited = process.env["PATH"];
  const env: Record<string, string> = {
    PATH: inherited === undefined || inherited === "" ? FALLBACK_PATH : inherited,
    LC_ALL: "C",
    LANG: "C",
  };
  // `HOME` is forwarded, and it is not decoration: three of these backends
  // resolve USER-level configuration through it, and without it they silently
  // answer for a different user than the operator. `xdg-open` reads the
  // default-application table under `${XDG_DATA_HOME:-$HOME/.local/share}`
  // and with `$HOME` empty falls back to the system table, so a document
  // opens in whatever the distribution shipped rather than in the program the
  // operator chose; `lp` reads `~/.cups/client.conf` for the server and
  // default destination; and macOS `open` consults the per-user LaunchServices
  // database. It is a path, not a credential, which is why it is the one
  // inherited variable here besides `PATH`.
  const home = process.env["HOME"];
  if (home !== undefined && home !== "") env["HOME"] = home;
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

/**
 * Turn a `Bun.spawn` throw into the right kind of "it did not run".
 *
 * ADVERSARIAL REVIEW: the first version set `missing: true` for EVERY spawn
 * error, so a program that is installed but not executable by this user
 * (`EACCES`), a name that resolves to a directory (`EISDIR`/`ENOTDIR`) or an
 * argv over the kernel's limit (`E2BIG`) all came back as "the program is not
 * installed on this host" — and `WindowList` then told an operator to install
 * the `wmctrl` they already have. That is rule 6 one level below the tools:
 * "could not start it" is not "it is not there".
 *
 * Only the two errnos that genuinely mean the NAME does not resolve set
 * `missing`. Everything else is a failure carrying the errno, so the caller's
 * reason names what actually happened.
 *
 * Exported because it is the only part of the real-spawn path a test can
 * reach without spawning (house rule 4 allows exactly one real-host test, and
 * it spawns nothing).
 */
export function classifySpawnError(err: unknown): RunResult {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);
  const absent = code === "ENOENT" || code === "ENOTDIR";
  return {
    code: 127,
    stdout: "",
    stderr: absent ? message : `${code ?? "spawn failed"}: ${message}`,
    timedOut: false,
    missing: absent,
  };
}

export async function runHostCommand(request: RunRequest): Promise<RunResult> {
  // Checked BEFORE the seam, not after: an injected runner must not be able
  // to make an argv acceptable that the real spawn would refuse, or a test
  // would pass on a command no host could run.
  const bad = assertArgv(request.argv);
  if (bad !== undefined) {
    // `refused`, not a bare non-zero exit. ADVERSARIAL REVIEW: without it
    // every classifier rendered this as "the opener exited -1: <reason>",
    // which claims a process ran and reported a status. Nothing ran — the
    // argv never left this function — and `refused` is the flag every
    // classifier already maps to a plain `failed` with the reason verbatim.
    return {
      code: -1,
      stdout: "",
      stderr: bad,
      timedOut: false,
      missing: false,
      refused: true,
    };
  }
  if (runnerOverride !== undefined) return runnerOverride(request);
  if (!realHostAllowed) {
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
      stdin: request.stdin === undefined ? "ignore" : new TextEncoder().encode(request.stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv(request.env),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
  } catch (err) {
    // ENOENT means the backend is not installed on this host, which is a
    // DIFFERENT answer from "it ran and told us nothing" — and a different
    // answer again from "it is there and would not start". See
    // `classifySpawnError`.
    return classifySpawnError(err);
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
  if (!realHostAllowed) return { ok: false, reason: NO_RUNNER_REASON, missing: false };
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
    // Same distinction as `runHostCommand`: only a name that does not resolve
    // is `missing`. An inhibitor that would not START is not one that is not
    // INSTALLED, and telling an operator to install `caffeinate` on a macOS
    // box that has always had it sends them nowhere.
    const failure = classifySpawnError(err);
    return { ok: false, reason: failure.stderr, missing: failure.missing };
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
  realHostAllowed = process.env["NODE_ENV"] !== "test";
}
