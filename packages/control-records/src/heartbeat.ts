/**
 * When a daemon last said it was alive: `.crewhaus/run/control-heartbeat.json`, written
 * whole every time, atomically, at `0600`, with every directory on the way contained in
 * the harness. The caller supplies every value, the time and the process id included, so
 * this module reads no clock and no environment variable.
 */
import { dirname } from "node:path";
import { ensureDirContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import { decodeStrict, parseObject, readRecordFile } from "./io";
import { controlPaths } from "./paths";

/** A beat is a few hundred bytes; past this it is not one. */
const HEARTBEAT_MAX_BYTES = 16 * 1024;

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
  /**
   * `true` when `operator.json` could not be read: the daemon counts it as paused, and
   * `operatorRev` is `null`.
   */
  readonly operatorUnreadable: boolean;
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
      operatorUnreadable: beat.operatorUnreadable,
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

/**
 * The last beat, read tolerantly: contained in the harness, at most 16 KiB, a link at the
 * leaf refused. Each field is kept only when it has its type, so a beat from an older
 * daemon (one with no `operatorUnreadable`, say) reads as far as it goes. `undefined` when
 * there is no beat, or it is not a JSON object. Creates nothing.
 *
 * First consumers: Home's overview and its projector.
 */
export function readHeartbeat(harnessDir: string): Partial<Heartbeat> | undefined {
  let read: ReturnType<typeof readRecordFile>;
  try {
    read = readRecordFile(harnessDir, controlPaths(harnessDir).heartbeatFile, HEARTBEAT_MAX_BYTES);
  } catch {
    return undefined;
  }
  if (!read.ok || read.truncated) return undefined;
  const text = decodeStrict(read.bytes);
  const body = text === undefined ? undefined : parseObject(text);
  if (body === undefined) return undefined;
  const out: Record<string, unknown> = {};
  if (body["v"] === 1) out["v"] = 1;
  for (const key of ["pid", "activeRuns"] as const) {
    if (typeof body[key] === "number") out[key] = body[key];
  }
  if (body["activeRuns"] === null) out["activeRuns"] = null;
  if (typeof body["at"] === "string") out["at"] = body["at"];
  if (typeof body["operatorRev"] === "number" || body["operatorRev"] === null) {
    out["operatorRev"] = body["operatorRev"];
  }
  for (const key of ["paused", "disabled", "operatorUnreadable", "runLedger"] as const) {
    if (typeof body[key] === "boolean") out[key] = body[key];
  }
  return out as Partial<Heartbeat>;
}
