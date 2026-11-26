/**
 * When a process started, so a holder recorded by pid can be told apart from
 * another process on a recycled pid.
 *
 * The parsers are pure and read captured text. {@link systemLeaseProbe}
 * answers this process's own start from its own clock and reads Linux's
 * `/proc` for any other pid. It starts no program (this package imports no
 * `node:child_process`), so elsewhere another pid's start time answers
 * `undefined` ("could not tell", never death).
 */
import { readFileSync } from "node:fs";
import { type LeaseProbe, defaultLeaseProbe } from "./lease";

/**
 * Parse `ps -p <pid> -o lstart=` output (e.g. `Mon Aug  4 00:22:11 2026`).
 * Whole-second granularity, hence the tolerance on every comparison.
 *
 * First consumer: harness-supervisor's POSIX `ProcessOps`.
 */
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
 *
 * First consumers: harness-supervisor's POSIX `ProcessOps` and {@link systemLeaseProbe}.
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

/**
 * Parse `/proc/stat` for the `btime <seconds>` line.
 *
 * First consumers: harness-supervisor's POSIX `ProcessOps` and {@link systemLeaseProbe}.
 */
export function parseProcBtime(procStat: string): number | undefined {
  const m = /^btime\s+(\d+)$/m.exec(procStat);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** This process's start, from its own clock: within the probe tolerance of what `/proc` or `ps` reads. */
const OWN_START_MS = Date.now() - process.uptime() * 1000;

/**
 * A probe that can tell when a process started. `isAlive` is
 * {@link defaultLeaseProbe}'s. `startTimeMs` answers this process's own start
 * from its clock (computed once), another pid's from `/proc/<pid>/stat` and
 * `/proc/stat` on Linux, and `undefined` anywhere else or when the read
 * fails: on macOS and Windows another process's start cannot be read without
 * starting a program, which this package never does.
 *
 * First consumer: the budget ledger (`./budget`), which records its holders with it.
 */
export const systemLeaseProbe: LeaseProbe = {
  isAlive: (pid) => defaultLeaseProbe.isAlive(pid),
  startTimeMs(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    if (pid === process.pid) return OWN_START_MS;
    if (process.platform !== "linux") return undefined;
    const stat = readText(`/proc/${pid}/stat`);
    const procStat = readText("/proc/stat");
    if (stat === undefined || procStat === undefined) return undefined;
    const btime = parseProcBtime(procStat);
    return btime === undefined ? undefined : parseProcStartTime(stat, btime);
  },
};
