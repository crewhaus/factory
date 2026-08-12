/**
 * The process-ops adapter pair. Everything platform-specific about spawning,
 * signalling, and inspecting a child lives behind {@link ProcessOps} so the
 * supervisor itself is portable and unit-testable without spawning anything.
 *
 * POSIX  — detached process groups, `SIGTERM`/`SIGKILL` to the GROUP
 *          (`kill(-pgid)`), start time from `/proc/<pid>/stat` field 22 on
 *          Linux and `ps -p <pid> -o lstart=` elsewhere.
 * Windows — `CREATE_NEW_PROCESS_GROUP` (what Node's `detached: true` maps
 *          to), `taskkill /PID <pid> /T` for the tree, and PowerShell
 *          `Get-Process` `StartTime` for the start-time probe. Best-effort
 *          by design: Windows has no signal semantics, so the signal-free
 *          control.v1 drain endpoint is the graceful path there and
 *          `taskkill` is the escalation behind it.
 *
 * Both adapters take an injected {@link CommandRunner} so the OUTPUT PARSERS
 * are unit-tested against captured strings rather than against whatever
 * processes happen to exist on the test machine. The default runner passes
 * an argv ARRAY to `spawnSync` — no shell, so no interpolation surface.
 *
 * Daemons are spawned with stdio redirected to a log FILE DESCRIPTOR, never
 * to pipes: pipes die with the manager, and a daemon that outlives the
 * manager must keep writing its log. Interactive runs use pipes (stdin is
 * required for submit/approve prompts) and the caller tees them to the log.
 */
import { type SpawnSyncOptions, spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";

/** A handle on a spawned child. Deliberately narrower than Node's
 *  `ChildProcess`: the supervisor only ever needs these few things. */
export type SpawnedProcess = {
  readonly pid: number | undefined;
  /** Resolves once with `{ code, signal }` — `code` is null when the child
   *  died from a signal. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  /** Piped stdout/stderr (attached runs only; undefined when the child
   *  writes straight to a log fd). */
  readonly stdout?: AsyncIterable<Uint8Array> | undefined;
  readonly stderr?: AsyncIterable<Uint8Array> | undefined;
  /** Write to the child's stdin (attached runs only). */
  readonly write?: ((chunk: string) => void) | undefined;
  /** Close the child's stdin (one-shot prompts run to EOF). */
  readonly closeStdin?: (() => void) | undefined;
  /** Detach the handle from the parent's event loop so the manager can exit
   *  while a detached daemon keeps running. */
  readonly unref?: (() => void) | undefined;
};

/** Where a child's stdout/stderr go. */
export type SpawnStdio =
  /** Attached: pipes, which the caller tees to the run log. */
  | { readonly mode: "pipe" }
  /** Detached: the OS writes straight into this file (append). */
  | { readonly mode: "file"; readonly path: string };

export type SpawnRequest = {
  readonly argv: readonly string[];
  /** ALWAYS the harness root — never the bundle dir, never a temp dir. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdio: SpawnStdio;
  /**
   * Feed the child's stdin from this file, read-only.
   *
   * For the shapes whose INPUT is a document: a compiled crew bundle reads
   * its brief on stdin and exits 2 without one. A pipe would not do — the
   * run is detached and outlives the manager that started it, so the writer
   * must be the kernel, exactly as it is for the log fd on the other end.
   */
  readonly stdinFile?: string;
  /** Own process group (POSIX) / `CREATE_NEW_PROCESS_GROUP` (Windows). */
  readonly detached: boolean;
};

export type ProcessOps = {
  readonly platform: "posix" | "windows";
  spawn(req: SpawnRequest): SpawnedProcess;
  /** True when a process with this pid exists (EPERM counts as alive: it
   *  exists, we just may not signal it). */
  isAlive(pid: number): boolean;
  /** Epoch ms the process started, or undefined when it is gone/unknown. */
  startTimeMs(pid: number): number | undefined;
  /** The running process's command line, or undefined when it is gone or
   *  the platform will not say. Lossy by nature (`ps` joins argv with
   *  spaces), so callers match tokens IN ORDER rather than compare
   *  digests — see {@link argvMatchesCommandLine}. */
  commandLine(pid: number): string | undefined;
  /** Graceful stop: SIGTERM to the process GROUP on POSIX, `taskkill /T`
   *  on Windows. */
  terminate(pid: number): void;
  /** Escalation after the grace period: SIGKILL / `taskkill /F`. */
  forceKill(pid: number): void;
};

/** Synchronous command seam — returns stdout, or undefined when the command
 *  fails or is unavailable. Always argv-array based; never a shell string. */
export type CommandRunner = (cmd: string, args: readonly string[]) => string | undefined;

const defaultCommandRunner: CommandRunner = (cmd, args) => {
  const opts: SpawnSyncOptions = { encoding: "utf8", timeout: 5_000, windowsHide: true };
  try {
    const res = spawnSync(cmd, [...args], opts);
    if (res.status !== 0 || typeof res.stdout !== "string") return undefined;
    return res.stdout;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------
// argv fingerprint
// ---------------------------------------------------------------------------

/**
 * The fingerprint stored in a runfile: a digest of the exact `[cwd, ...argv]`
 * the manager spawned. A recycled pid whose start time happens to land inside
 * the tolerance window still fails this check unless it is running the very
 * same command from the very same directory.
 */
export function argvFingerprint(cwd: string, argv: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([cwd, ...argv]))
    .digest("hex")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Start-time parsers (pure — unit-tested against captured output)
// ---------------------------------------------------------------------------

/** Parse `ps -p <pid> -o lstart=` output (e.g. `Mon Aug  4 00:22:11 2026`).
 *  Whole-second granularity, hence the tolerance on every comparison. */
export function parsePsLstart(stdout: string): number | undefined {
  const line = stdout.trim();
  if (line === "") return undefined;
  const ms = Date.parse(line);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Derive a start time from Linux `/proc` inputs:
 *   - `statLine` — the contents of `/proc/<pid>/stat`; field 22 is the
 *     process start time in clock ticks since boot. The comm field (2) is
 *     parenthesised and may itself contain spaces and parentheses, so the
 *     split happens AFTER the last `)`.
 *   - `btimeSeconds` — `btime` from `/proc/stat`, the boot time in epoch
 *     seconds.
 *   - `clockTicksPerSecond` — `USER_HZ`, 100 on every mainstream build.
 */
export function parseProcStartTime(
  statLine: string,
  btimeSeconds: number,
  clockTicksPerSecond = 100,
): number | undefined {
  const close = statLine.lastIndexOf(")");
  if (close === -1) return undefined;
  const fields = statLine
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // After the comm field, field 3 (state) is index 0, so field 22 is index 19.
  const ticks = Number(fields[19]);
  if (!Number.isFinite(ticks) || !Number.isFinite(btimeSeconds)) return undefined;
  return Math.round(btimeSeconds * 1000 + (ticks / clockTicksPerSecond) * 1000);
}

/** Parse `/proc/stat` for the `btime <seconds>` line. */
export function parseProcBtime(procStat: string): number | undefined {
  const m = /^btime\s+(\d+)$/m.exec(procStat);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse the PowerShell start-time probe's round-trip (`o`) timestamp. */
export function parseWindowsStartTime(stdout: string): number | undefined {
  const line = stdout.trim();
  if (line === "") return undefined;
  const ms = Date.parse(line);
  return Number.isFinite(ms) ? ms : undefined;
}

/** True when two start-time readings describe the same process launch. */
export function startTimesMatch(a: number, b: number, toleranceMs: number): boolean {
  return Math.abs(a - b) <= toleranceMs;
}

/** `/proc/<pid>/cmdline` is NUL-separated with a trailing NUL. */
export function parseProcCmdline(raw: string): string | undefined {
  const parts = raw.split("\0").filter((p) => p !== "");
  return parts.length === 0 ? undefined : parts.join(" ");
}

/**
 * True when `argv` is the command line the OS reports — every token present,
 * in order. A digest comparison is impossible here: `ps` joins argv with
 * spaces, so quoting and embedded spaces are already lost by the time we can
 * read it. Token-order matching still rejects an unrelated process that
 * inherited the pid, which is the property adoption needs.
 */
export function argvMatchesCommandLine(commandLine: string, argv: readonly string[]): boolean {
  const line = commandLine.trim();
  if (line === "") return false;
  let idx = 0;
  for (const token of argv) {
    if (token === "") continue;
    const at = line.indexOf(token, idx);
    if (at === -1) return false;
    idx = at + token.length;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Shared spawn plumbing
// ---------------------------------------------------------------------------

function nodeSpawnAdapter(req: SpawnRequest, windowsHide: boolean): SpawnedProcess {
  const [cmd, ...args] = req.argv;
  if (cmd === undefined) throw new Error("spawn: empty argv");
  let fd: number | undefined;
  // The child reads this one; opened read-only and handed over the same way
  // the log fd is, so a detached run keeps its input after we exit.
  let inFd: number | undefined;
  if (req.stdinFile !== undefined) inFd = openSync(req.stdinFile, "r");
  let stdio: Array<"pipe" | "ignore" | number>;
  if (req.stdio.mode === "pipe") {
    stdio = [inFd ?? "pipe", "pipe", "pipe"];
  } else {
    // Append + create, 0600: two runs never truncate each other's log, and
    // the fd survives the manager because the CHILD holds it.
    fd = openSync(req.stdio.path, "a", 0o600);
    stdio = [inFd ?? "ignore", fd, fd];
  }
  const child = nodeSpawn(cmd, args, {
    cwd: req.cwd,
    env: { ...req.env },
    stdio,
    detached: req.detached,
    windowsHide,
  });
  // The parent's copies of the handed-over fds are not needed once the child
  // owns them.
  for (const handedOver of [fd, inFd]) {
    if (handedOver === undefined) continue;
    try {
      closeSync(handedOver);
    } catch {
      // Already closed by a failed spawn — nothing to clean up.
    }
  }
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal: signal ?? null }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });
  return {
    pid: child.pid,
    exited,
    stdout: child.stdout ?? undefined,
    stderr: child.stderr ?? undefined,
    write: child.stdin !== null ? (chunk: string) => void child.stdin?.write(chunk) : undefined,
    closeStdin: child.stdin !== null ? () => child.stdin?.end() : undefined,
    unref: () => child.unref(),
  };
}

// ---------------------------------------------------------------------------
// POSIX
// ---------------------------------------------------------------------------

export type PosixProcessOpsOptions = {
  readonly run?: CommandRunner;
  /** `linux` uses the `/proc` fast path; anything else uses `ps`. */
  readonly platform?: string;
  /** Reads a small text file, returning undefined when absent. Injected so
   *  the `/proc` path is testable off Linux. */
  readonly readText?: (path: string) => string | undefined;
  /** Signal sender; defaults to `process.kill`. */
  readonly kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
};

function readTextSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** POSIX adapter: signals, detached process groups, `/proc` or `ps` start
 *  times. */
export function createPosixProcessOps(opts: PosixProcessOpsOptions = {}): ProcessOps {
  const run = opts.run ?? defaultCommandRunner;
  const platform = opts.platform ?? process.platform;
  const readText = opts.readText ?? readTextSafe;
  const kill =
    opts.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal));

  const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    // Negative pid = the whole process group, which is why daemons are
    // spawned detached: one signal reaches the daemon AND everything it
    // spawned (MCP servers, sub-processes).
    try {
      kill(-pid, signal);
      return;
    } catch {
      // No group (or already gone) — fall back to the bare pid.
    }
    try {
      kill(pid, signal);
    } catch {
      // Already dead: terminating a dead process is a no-op, not an error.
    }
  };

  return {
    platform: "posix",
    spawn: (req) => nodeSpawnAdapter(req, false),
    isAlive: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    startTimeMs: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      if (platform === "linux") {
        const stat = readText(`/proc/${pid}/stat`);
        const procStat = readText("/proc/stat");
        if (stat !== undefined && procStat !== undefined) {
          const btime = parseProcBtime(procStat);
          if (btime !== undefined) {
            const ms = parseProcStartTime(stat, btime);
            if (ms !== undefined) return ms;
          }
        }
      }
      const out = run("ps", ["-p", String(pid), "-o", "lstart="]);
      return out === undefined ? undefined : parsePsLstart(out);
    },
    commandLine: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      if (platform === "linux") {
        const raw = readText(`/proc/${pid}/cmdline`);
        if (raw !== undefined) {
          const parsed = parseProcCmdline(raw);
          if (parsed !== undefined) return parsed;
        }
      }
      const out = run("ps", ["-p", String(pid), "-o", "args="]);
      const line = out?.trim();
      return line === undefined || line === "" ? undefined : line;
    },
    terminate: (pid) => signalGroup(pid, "SIGTERM"),
    forceKill: (pid) => signalGroup(pid, "SIGKILL"),
  };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

export type WindowsProcessOpsOptions = {
  readonly run?: CommandRunner;
};

/**
 * Windows adapter. `detached: true` maps to `CREATE_NEW_PROCESS_GROUP`, the
 * tree is stopped with `taskkill /T` (a close request) and escalated with
 * `/T /F`, and start times come from PowerShell.
 *
 * Best-effort by contract: `taskkill` without `/F` only closes windowed
 * processes gracefully, so on Windows the honest graceful path for a daemon
 * is the signal-free control.v1 drain endpoint, with `taskkill` behind it.
 */
export function createWindowsProcessOps(opts: WindowsProcessOpsOptions = {}): ProcessOps {
  const run = opts.run ?? defaultCommandRunner;
  return {
    platform: "windows",
    spawn: (req) => nodeSpawnAdapter(req, true),
    isAlive: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      const out = run("powershell", [
        "-NoProfile",
        "-Command",
        `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { "1" } else { "0" }`,
      ]);
      return out !== undefined && out.trim() === "1";
    },
    startTimeMs: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      const out = run("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString("o")`,
      ]);
      return out === undefined ? undefined : parseWindowsStartTime(out);
    },
    commandLine: (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      const out = run("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ]);
      const line = out?.trim();
      return line === undefined || line === "" ? undefined : line;
    },
    terminate: (pid) => {
      run("taskkill", ["/PID", String(pid), "/T"]);
    },
    forceKill: (pid) => {
      run("taskkill", ["/PID", String(pid), "/T", "/F"]);
    },
  };
}

/** The adapter for the current platform. */
export function createProcessOps(platform: string = process.platform): ProcessOps {
  return platform === "win32" ? createWindowsProcessOps() : createPosixProcessOps({ platform });
}
