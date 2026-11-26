/**
 * Writing the delivery records: one line per event, each under the harness's control lock
 * after a fold, so two writers never decide on the same state. A line is content-free (ids,
 * SHAs, codes, counts), its keys come from a closed set, and it stays under one row's size.
 * What a check printed, the acceptance judge's reasons and the text a pull request was
 * published with are content: they live in 0600 files under `work/checks/<wi>/`, redacted.
 *
 * The publish hold is a claim file, `claims/work-publish/<wi>.json`, taken exclusively by the
 * process that publishes and broken only when that process is provably dead.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  MACHINES,
  WORKSPACE_LOG_KEYS,
  WORK_PR_LOG_KEYS,
  WORK_PUBLISH_LOG_KEYS,
  canTransition,
  isId,
} from "@crewhaus/control-contract";
import {
  type LeaseProbe,
  type LedgerRecord,
  defaultLeaseProbe,
  expireClaimHeldBy,
  foldStates,
  holderProvablyDead,
  publishClaim,
  readClaim,
  withLedgerLock,
} from "@crewhaus/control-records";
import {
  ensureDirContained,
  openForReadSync,
  resolveContained,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";
import {
  type FoldedWorkspace,
  type OutcomeLine,
  type PublishLine,
  type WorkspaceLine,
  outcomesLedger,
  publishLedger,
  readAttempts,
  readWorkspaces,
  workDirOf,
  workspacesLedger,
} from "../work-items/index";

/** The largest check log, reasons file or publish text kept, in bytes. */
export const CHECK_LOG_MAX_BYTES = 256 * 1024;
/** A line of this many bytes or more is never appended. */
const MAX_LINE_BYTES = 4096;

/** A record that could not be written: the reason, never content. */
export class DeliveryRecordError extends Error {
  override readonly name = "DeliveryRecordError";
}

function assertKeys(line: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  const stray = Object.keys(line).filter((k) => !keys.includes(k));
  if (stray.length > 0) {
    throw new DeliveryRecordError(
      `a delivery line has keys outside its set: ${stray.sort().join(", ")}`,
    );
  }
  if (Buffer.byteLength(JSON.stringify(line)) + 1 >= MAX_LINE_BYTES) {
    throw new DeliveryRecordError("a delivery line is larger than one row");
  }
}

/** Append one workspace line, after a fold that says the move is legal. */
export async function appendWorkspace(harnessDir: string, line: WorkspaceLine): Promise<void> {
  assertKeys(line as unknown as Record<string, unknown>, WORKSPACE_LOG_KEYS);
  const ledger = workspacesLedger(harnessDir);
  const answer = await withLedgerLock(ledger, (append) => {
    const current = readWorkspaces(harnessDir).get(line.id);
    if (current === undefined && line.state !== "open") {
      return { ok: false as const, reason: "a workspace is opened before it is anything else" };
    }
    return append(line as unknown as LedgerRecord);
  });
  if (!answer.ok) throw new DeliveryRecordError(answer.reason);
}

/** Append one attempt line. A move the machine refuses throws, and nothing is appended. */
export async function appendAttempt(harnessDir: string, line: PublishLine): Promise<void> {
  assertKeys(line as unknown as Record<string, unknown>, WORK_PUBLISH_LOG_KEYS);
  const ledger = publishLedger(harnessDir);
  const answer = await withLedgerLock(ledger, (append) => {
    const fold = foldStates(ledger);
    if (!fold.ok) return fold;
    const from = fold.objects.get(line.id)?.state;
    const legal =
      from === undefined
        ? (MACHINES["work-publish"].entry as readonly string[]).includes(line.state)
        : canTransition("work-publish", from, line.state);
    if (!legal) {
      return {
        ok: false as const,
        reason: `publish attempt ${line.id} cannot move from ${from ?? "nothing"} to ${line.state}`,
      };
    }
    return append(line as unknown as LedgerRecord);
  });
  if (!answer.ok) throw new DeliveryRecordError(answer.reason);
}

/**
 * Append one outcome line when it changes what the newest one says. Answers whether a line
 * was written: a repeat, and a move the machine refuses, write nothing.
 */
export async function appendOutcome(
  harnessDir: string,
  line: OutcomeLine,
  same: (newest: OutcomeLine | undefined) => boolean,
  newestOf: () => OutcomeLine | undefined,
): Promise<boolean> {
  assertKeys(line as unknown as Record<string, unknown>, WORK_PR_LOG_KEYS);
  const ledger = outcomesLedger(harnessDir);
  const answer = await withLedgerLock<{ ok: true; wrote: boolean } | { ok: false; reason: string }>(
    ledger,
    (append) => {
      if (same(newestOf())) return { ok: true, wrote: false };
      const written = append(line as unknown as LedgerRecord);
      return written.ok ? { ok: true, wrote: true } : { ok: false, reason: written.reason };
    },
  );
  if (!answer.ok) throw new DeliveryRecordError(answer.reason);
  return answer.wrote;
}

/** The next attempt's number for an item. */
export function nextAttempt(harnessDir: string, wi: string): number {
  return (readAttempts(harnessDir).get(wi)?.at(-1)?.attempt ?? 0) + 1;
}

/** Another item's workspace on the same name (its first ten id characters), when there is one. */
export function workspaceNameTaken(
  workspaces: ReadonlyMap<string, FoldedWorkspace>,
  wi: string,
  name: string,
): boolean {
  for (const [id, w] of workspaces) {
    if (id === wi) continue;
    if (worktreeNameOf(w.branch) === name) return true;
  }
  return false;
}

/** The worktree's directory name: the branch's last part up to its first dash. */
export function worktreeNameOf(branch: string): string {
  const last = branch.split("/").at(-1) ?? branch;
  const dash = last.indexOf("-");
  return dash === -1 ? last : last.slice(0, dash);
}

// ---------------------------------------------------------------------------
// The publish hold
// ---------------------------------------------------------------------------

export type PublishHold = { release(): Promise<void> };

/**
 * Take the publish hold for an item, or answer `undefined` when a live process has it. A
 * holder that is provably dead (this host, and its process is gone or its pid recycled) is
 * broken once; its attempt is left for the caller to settle.
 */
export async function takePublishHold(
  harnessDir: string,
  wi: string,
  now: () => number,
  probe: LeaseProbe = defaultLeaseProbe,
): Promise<PublishHold | undefined> {
  if (!isId("wi", wi)) throw new DeliveryRecordError("a work item is named wi_…");
  const ledger = publishLedger(harnessDir);
  const claim = `work-publish/${wi}`;
  const host = hostname();
  const startedAtMs = probe.startTimeMs(process.pid);
  const record = {
    id: `hold_${randomBytes(12).toString("hex")}`,
    pid: process.pid,
    host,
    at: new Date(now()).toISOString(),
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
  };
  for (let tries = 0; tries < 2; tries += 1) {
    const published = publishClaim(ledger, claim, record);
    if (published.ok) {
      return {
        release: async () => {
          await expireClaimHeldBy(ledger, claim, record.id);
        },
      };
    }
    if (published.code !== "exists") throw new DeliveryRecordError(published.reason);
    const held = readClaim(ledger, claim);
    if (!held.ok) {
      if (held.code === "not-found") continue;
      return undefined;
    }
    const { pid, host: holderHost, startedAtMs: since, id } = held.content.record;
    if (
      typeof pid !== "number" ||
      typeof holderHost !== "string" ||
      typeof id !== "string" ||
      !holderProvablyDead(
        {
          pid,
          host: holderHost,
          ...(typeof since === "number" ? { startedAtMs: since } : {}),
        },
        probe,
        host,
      )
    ) {
      return undefined;
    }
    const broken = await expireClaimHeldBy(ledger, claim, id);
    if (!broken.ok) return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Content files
// ---------------------------------------------------------------------------

/** An item's check logs, reasons and publish texts, relative to the harness. */
export function checksDirOf(harnessDir: string, wi: string): string {
  return join(workDirOf(harnessDir), "checks", wi);
}

/** Cut to the size a content file keeps, the end kept: a failing check says why last. */
function capped(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= CHECK_LOG_MAX_BYTES) return text;
  const note = "[the start of this log was cut]\n";
  return `${note}${bytes.subarray(bytes.length - (CHECK_LOG_MAX_BYTES - note.length)).toString("utf8")}`;
}

/**
 * Write one content file for an item, 0600, contained, replacing an earlier one of the same
 * name. Answers its name: what a record keeps.
 */
export function writeCheckFile(harnessDir: string, wi: string, name: string, text: string): string {
  if (!isId("wi", wi) || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name)) {
    throw new DeliveryRecordError("a check file is named plainly");
  }
  const dir = checksDirOf(harnessDir, wi);
  const made = ensureDirContained(harnessDir, dir, { mode: 0o700 });
  if (!made.ok) throw new DeliveryRecordError(made.reason);
  const written = writeFileSafe(harnessDir, join(dir, name), capped(text), {
    overwrite: true,
    mode: 0o600,
  });
  if (!written.ok) throw new DeliveryRecordError(written.reason);
  return name;
}

/** Read one content file back, contained, or `undefined`. */
export function readCheckFile(harnessDir: string, wi: string, name: string): string | undefined {
  if (!isId("wi", wi) || !/^[a-z0-9][a-z0-9.-]{0,63}$/.test(name)) return undefined;
  const read = openForReadSync(harnessDir, join(checksDirOf(harnessDir, wi), name), {
    maxBytes: CHECK_LOG_MAX_BYTES + 1024,
    followLeafSymlink: false,
  });
  return read.ok ? read.text : undefined;
}

/** Remove a directory this package made, contained: never followed out of the harness. */
export function removeContainedDir(harnessDir: string, rel: string): void {
  const at = resolveContained(harnessDir, rel, { followLeaf: false });
  const root = resolveContained(harnessDir, ".");
  if (!at.ok || !root.ok) return;
  const inside = relative(root.real, at.real);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return;
  rmSync(at.real, { recursive: true, force: true });
}
