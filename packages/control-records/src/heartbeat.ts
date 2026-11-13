/**
 * When a daemon last said it was alive: `.crewhaus/run/control-heartbeat.json`, written
 * whole every time, atomically, at `0600`, with every directory on the way contained in
 * the harness. The caller supplies every value, the time and the process id included, so
 * this module reads no clock and no environment variable.
 */
import { dirname } from "node:path";
import { ensureDirContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import { controlPaths } from "./paths";

/** One beat. No field is named like a credential. */
export type Heartbeat = {
  readonly v: 1;
  readonly pid: number;
  /** ISO time of the beat. */
  readonly at: string;
  /** The operator record's `rev`, or `null` when there is none or it cannot be read. */
  readonly operatorRev: number | null;
  readonly paused: boolean;
  readonly disabled: boolean;
  /** Runs this process is running, or `null` where it cannot count them. */
  readonly activeRuns: number | null;
  /** Whether this process records run rows. */
  readonly runLedger: boolean;
};

export type HeartbeatWrite =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Write one beat. Only the fields of {@link Heartbeat} are written, whatever else `beat`
 * carries. It never throws: a refused or failed write answers `{ok: false, reason}`.
 *
 * First consumer: the control plane's heartbeat, whose first reader is Home's "last
 * verified".
 */
export function writeHeartbeat(harnessDir: string, beat: Heartbeat): HeartbeatWrite {
  try {
    const rel = controlPaths(harnessDir).heartbeatFile;
    const body: Heartbeat = {
      v: 1,
      pid: beat.pid,
      at: beat.at,
      operatorRev: beat.operatorRev,
      paused: beat.paused,
      disabled: beat.disabled,
      activeRuns: beat.activeRuns,
      runLedger: beat.runLedger,
    };
    const dir = ensureDirContained(harnessDir, dirname(rel), { mode: 0o700 });
    if (!dir.ok) return { ok: false, reason: dir.reason };
    const written = writeFileSafe(harnessDir, rel, `${JSON.stringify(body)}\n`, {
      overwrite: true,
      mode: 0o600,
    });
    return written.ok ? { ok: true } : { ok: false, reason: written.reason };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
