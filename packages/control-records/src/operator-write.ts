/**
 * The operator record's writer: format and lock only. Who may change the record, and what
 * a change means for a running daemon, is control-service's; this module turns a change
 * into the next record, under the control lock, and nothing else.
 *
 * A change replaces each block it names whole. An absent record starts at `rev` 1 with
 * `desired: "stopped"`: a harness that has never been started from a release that writes
 * the record is not one a reboot should bring back. A present record gains one `rev`,
 * and top-level fields this release does not know are kept. A record that cannot be read
 * is never written: it counts as closed, and only a person who repairs or removes it opens
 * it again.
 *
 * The control lock is the one every harness ledger shares, and file locks are not
 * re-entrant: never call the writer while holding a ledger lock.
 */
import { basename, join } from "node:path";
import { ensureDirContained, writeFileSafe } from "@crewhaus/tool-safety/fs";
import { readWholeRecord } from "./fail-closed";
import { withControlLock } from "./io";
import {
  type OperatorDeployment,
  type OperatorIntake,
  type OperatorRead,
  type OperatorRecord,
  readOperatorRecord,
} from "./operator";
import { controlPaths } from "./paths";

const OPERATOR_MAX_BYTES = 64 * 1024;

/** What a write changes: each block named replaces that block whole. */
export type OperatorChange = {
  readonly intake?: OperatorIntake | null;
  readonly deployment?: OperatorDeployment | null;
  readonly desired?: "running" | "stopped";
};

export type OperatorWrite =
  | { readonly ok: true; readonly record: OperatorRecord }
  | { readonly ok: false; readonly reason: string };

function unreadable(rel: string, read: Extract<OperatorRead, { state: "unreadable" }>): string {
  return `${rel} can't be read (${read.reason}), so it was left as it is; repair or remove it by hand`;
}

const KNOWN = new Set(["v", "rev", "intake", "deployment", "desired"]);

/** The fields of a present record this release does not know, to keep on the next one. */
function unknownFields(harnessDir: string, rel: string): Record<string, unknown> {
  const raw = readWholeRecord(harnessDir, rel, OPERATOR_MAX_BYTES);
  if (raw.state !== "body") return {};
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw.body)) {
    if (!KNOWN.has(name)) out[name] = value;
  }
  return out;
}

/**
 * Write `.crewhaus/run/control/operator.json`: under the control lock, from a fresh read
 * (never the one-second cache), atomically (`0600`, the control directory `0700`), never
 * through a link. Then the default reader is refreshed, so every door in this process
 * answers the new record at once.
 *
 * First consumers: control-service's operator controls and `recordDesired`.
 */
export async function writeOperatorRecord(
  harnessDir: string,
  change: OperatorChange,
): Promise<OperatorWrite> {
  const paths = controlPaths(harnessDir);
  const rel = paths.operatorFile;
  // Judged before anything is created, so a record that cannot be read (a file where its
  // directory goes among them) is refused by its own reason and nothing is made beside it.
  const before = readOperatorRecord.refresh(harnessDir);
  if (before.state === "unreadable") return { ok: false, reason: unreadable(rel, before) };
  const dir = ensureDirContained(harnessDir, paths.controlDir, { mode: 0o700 });
  if (!dir.ok) return { ok: false, reason: `${rel} can't be written: ${dir.reason}` };
  try {
    return await withControlLock(
      join(dir.real, basename(paths.lockFile)),
      async (): Promise<OperatorWrite> => {
        const read = readOperatorRecord.refresh(harnessDir);
        if (read.state === "unreadable") return { ok: false, reason: unreadable(rel, read) };
        const base: OperatorRecord =
          read.state === "present"
            ? read.record
            : { v: 1, rev: 0, intake: null, deployment: null, desired: "stopped" };
        const record: OperatorRecord = {
          v: 1,
          rev: base.rev + 1,
          intake: change.intake !== undefined ? change.intake : base.intake,
          deployment: change.deployment !== undefined ? change.deployment : base.deployment,
          desired: change.desired ?? base.desired,
        };
        const kept = read.state === "present" ? unknownFields(harnessDir, rel) : {};
        const written = writeFileSafe(
          harnessDir,
          rel,
          `${JSON.stringify({ ...record, ...kept }, null, 2)}\n`,
          { overwrite: true, mode: 0o600 },
        );
        if (!written.ok) return { ok: false, reason: `${rel} can't be written: ${written.reason}` };
        readOperatorRecord.refresh(harnessDir);
        return { ok: true, record };
      },
    );
  } catch (err) {
    // The lock is refused or held past its wait: its message names the path and the holder.
    return {
      ok: false,
      reason: `${rel} can't be written: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
