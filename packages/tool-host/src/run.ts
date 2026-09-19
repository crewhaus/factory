/**
 * The one place this package starts a child process — and the one place an
 * argv array is written down at all.
 *
 * The conventions are `@crewhaus/tool-proc`'s, copied rather than invented:
 * argv is an ARRAY handed straight to the OS, stdin is `ignore` so a probe
 * that reads stdin gets EOF instead of hanging, every run has a deadline
 * (SIGTERM, then SIGKILL after a grace period), both streams are capped, and
 * the child's environment is pinned. tool-proc's `runOnce` is not importable
 * — that package's export map exposes its tools and nothing else — so the
 * rules are reproduced here, deliberately in the same shape.
 *
 * The difference from tool-proc is `HOST_COMMANDS`. Every command this
 * package can run is a frozen constant in that table. No caller value, and
 * no value read out of another command's output, is ever appended to an
 * argv: a port number is matched in JavaScript after parsing, an interface
 * name filters a parsed list, and the battery is read from sysfs rather than
 * from `upower -i <path>` precisely because that path would be an argv
 * element built from a probe's output. This repo has already shipped git
 * argument injection (`gitBranchCreate({name:"-D"})` ran `git branch -D
 * victim`), and the cheapest way not to ship it twice is to have no argv
 * that is not a literal — which `argv is a constant` in index.test.ts
 * asserts against the recorded calls, including for adversarial input.
 */

/** Grace between the deadline's SIGTERM and the SIGKILL behind it. */
const KILL_GRACE_MS = 2_000;
/**
 * A probe that forks (lsof does, on some platforms) keeps the pipe's write
 * end open after the child is gone, so reading to EOF can outlive the
 * process. Bound the drain and move on with what arrived.
 */
const DRAIN_GRACE_MS = 300;
/**
 * Per-stream cap.
 *
 * `netstat -an -p tcp` (macOS) and `netstat -ano` (Windows) list every TCP
 * socket in EVERY state, not just the listeners, so ~100 bytes a row puts
 * the cap at roughly five thousand connections — a number a busy host
 * passes. The cap therefore has to be reported rather than assumed away:
 * silently dropping the tail of a socket enumeration turns a listener that
 * did not fit into "that port is free", which is the one claim this package
 * exists not to make.
 */
const MAX_OUTPUT_CHARS = 512_000;

export type HostRunFailure = "not-installed" | "timed-out" | "exit-nonzero" | "spawn-failed";

export type HostRunOutcome = {
  readonly argv: readonly string[];
  /** True only when the command ran to completion with exit code 0. */
  readonly ok: boolean;
  /** -1 when the command never started. */
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * True when stdout hit the cap and the REST OF IT WAS DROPPED, so what is
   * here is a prefix of the answer rather than the answer. Optional because
   * a fake runner in a test states only what its case is about; absent reads
   * as "not truncated", which is what a short recorded fixture is.
   */
  readonly stdoutTruncated?: boolean;
  /** Why it is not `ok`. Absent when it is. */
  readonly failure?: HostRunFailure;
};

export type HostRunner = (
  argv: readonly string[],
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
) => Promise<HostRunOutcome>;

/**
 * Every command this package may run, as literals.
 *
 * Flag notes that matter to the parsers downstream:
 *   - `uname -srvm` is ONE call rather than three because three calls can
 *     straddle nothing meaningful; the version field contains spaces, which
 *     is why `parseUname` takes the first two and last one rather than
 *     splitting into four.
 *   - `sysctl` is called WITHOUT `-n`. With `-n` the output is bare values,
 *     one per line, and a key the kernel does not know (hw.cpufrequency on
 *     Apple Silicon) writes to stderr and prints NO line — so every later
 *     value shifts up one row and is read as the wrong fact. Verified on
 *     macOS 26.6.2/arm64 while capturing the fixtures. Named output costs a
 *     `key: ` prefix and cannot misalign.
 *   - `lsof -F` is the field-per-line form. The column form truncates
 *     COMMAND to nine characters (`com.docker.backend` arrives as
 *     `com.docke`), so the field form is tried first and the column parser
 *     is the fallback for an lsof that rejects `-F`.
 *   - `-n` and `-P` on lsof, `-n` on netstat/ss: never resolve a name. A
 *     probe that does reverse DNS can block for the whole timeout.
 */
export const HOST_COMMANDS = Object.freeze({
  /** POSIX kernel identity. */
  uname: Object.freeze(["uname", "-srvm"]),
  /** macOS product name / version / build. */
  swVers: Object.freeze(["sw_vers"]),
  /** macOS cpu and memory facts, keyed by name. */
  sysctl: Object.freeze([
    "sysctl",
    "hw.logicalcpu",
    "hw.physicalcpu",
    "hw.memsize",
    "machdep.cpu.brand_string",
  ]),
  /** macOS battery and power source. */
  pmset: Object.freeze(["pmset", "-g", "batt"]),
  /** Linux interfaces, JSON form (iproute2 >= 4.13). */
  ipJson: Object.freeze(["ip", "-j", "addr"]),
  /** Linux interfaces, text form — busybox `ip` has no `-j` at all. */
  ipText: Object.freeze(["ip", "addr"]),
  /** BSD/macOS interfaces. */
  ifconfig: Object.freeze(["ifconfig", "-a"]),
  /** Linux listening TCP sockets, with owner where permitted. */
  ss: Object.freeze(["ss", "-ltnp"]),
  /** Linux listening TCP sockets when iproute2 is absent. */
  netstatLinux: Object.freeze(["netstat", "-ltnp"]),
  /** macOS/BSD: every TCP socket, all users, no owner. */
  netstatBsd: Object.freeze(["netstat", "-an", "-p", "tcp"]),
  /** Windows: every TCP/UDP socket with its owning pid. */
  netstatWindows: Object.freeze(["netstat", "-ano"]),
  /** macOS/Linux owner attribution, field form. */
  lsofFields: Object.freeze(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "cfnuLPT"]),
  /** macOS/Linux owner attribution, column form (fallback). */
  lsofColumns: Object.freeze(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"]),
  /** Windows pid -> image name. `/NH` drops the localized header row. */
  tasklist: Object.freeze(["tasklist", "/FO", "CSV", "/NH"]),
  /** Windows battery. Absent on Windows 11 24H2 and later, which is reported. */
  wmicBattery: Object.freeze([
    "wmic",
    "path",
    "Win32_Battery",
    "get",
    "BatteryStatus,EstimatedChargeRemaining",
    "/format:list",
  ]),
});

/** Flat view of the table, for the test that proves no argv is built. */
export const ALL_HOST_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = Object.freeze(
  Object.values(HOST_COMMANDS),
);

/**
 * The child's environment, pinned.
 *
 * `LC_ALL`/`LANG` are the load-bearing pair: every parser here reads English
 * keywords (`LISTEN`, `status: active`, `Now drawing from`), and on a host
 * whose locale is not English the same command prints different words. TZ is
 * pinned for the same reason — nothing here prints a timestamp today, but a
 * probe that starts to would drift with the machine otherwise.
 *
 * PATH and HOME are forwarded because a probe cannot be found without the
 * first; nothing else is, so the harness's API keys stay out of `netstat`.
 */
export function hostSpawnEnv(
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: parent["PATH"] ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LC_ALL: "C",
    LANG: "C",
    TZ: "UTC",
  };
  const home = parent["HOME"];
  if (home !== undefined) env["HOME"] = home;
  // Windows resolves executables through these; without them `netstat` and
  // `tasklist` are not found even though they are installed.
  for (const name of ["SystemRoot", "windir", "PATHEXT", "COMSPEC"]) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Cap one stream, and SAY whether anything was dropped.
 *
 * Exported for its own test: the flag is what keeps a half-read socket table
 * from being reported as a complete one, and a cap that quietly returns a
 * prefix is indistinguishable from a host that really had that much to say.
 */
export function capOutput(
  text: string,
  max: number = MAX_OUTPUT_CHARS,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

export const defaultRunner: HostRunner = async (argv, options) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], {
      // The workspace root, not a caller-chosen directory: no tool here
      // takes a cwd, and every probe reads the machine rather than a path.
      cwd: process.cwd(),
      env: hostSpawnEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (err) {
    // ENOENT here means the probe is not installed, which is a DIFFERENT
    // answer from "it ran and told us nothing" — the whole point of this
    // package is that the second must never be reported as the first.
    const message = err instanceof Error ? err.message : String(err);
    const missing = /ENOENT|not found|No such file/i.test(message);
    return {
      argv,
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: message,
      failure: missing ? "not-installed" : "spawn-failed",
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
    // `.catch` is attached HERE rather than after the race below: the loser
    // stays pending, and a stream torn down with a killed process would
    // otherwise reject with nobody listening — an unhandled rejection that
    // takes down the harness rather than the probe that caused it.
    const outText = new Response(proc.stdout as ReadableStream<Uint8Array>).text().catch(() => "");
    const errText = new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => "");
    const exitCode = await proc.exited;
    const drain = (): Promise<string> =>
      new Promise((resolve) => setTimeout(() => resolve(""), DRAIN_GRACE_MS));
    const [stdout, stderr] = await Promise.all([
      Promise.race([outText, drain()]),
      Promise.race([errText, drain()]),
    ]);
    const ok = !timedOut && exitCode === 0;
    const out = capOutput(stdout);
    return {
      argv,
      ok,
      exitCode,
      stdout: out.text,
      stderr: capOutput(stderr).text,
      ...(out.truncated ? { stdoutTruncated: true } : {}),
      ...(ok ? {} : { failure: timedOut ? ("timed-out" as const) : ("exit-nonzero" as const) }),
    };
  } finally {
    clearTimeout(term);
    clearTimeout(hardKill);
  }
};

let runner: HostRunner = defaultRunner;

/**
 * Replace the command seam. Every test in this package drives recorded
 * output through this: CI is Linux, development is macOS, and a parser
 * checked against whatever the test machine happens to answer is a parser
 * checked against nothing.
 *
 * Passing `undefined` restores the real one.
 */
export function _setRunner(fn: HostRunner | undefined): void {
  runner = fn ?? defaultRunner;
}

export function runHostCommand(
  argv: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<HostRunOutcome> {
  return runner(argv, options);
}
