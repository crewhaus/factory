/**
 * The mutating lease: one mutating job per harness at a time, as a file, so an `eval`
 * started in a terminal sees what a job runner is doing. A contender waits briefly, then
 * refuses and names the holder.
 *
 * Only a provably dead holder loses the lease: the same host, and a process that is gone
 * or whose pid was recycled. There is no age rule, because an eval holds it for an hour.
 * A probe that cannot answer means held.
 */
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type SafeFsFailure,
  ensureDirContained,
  resolveContained,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";
import { readWholeRecord } from "./fail-closed";
import { refusal, withControlLock } from "./io";
import { controlPaths } from "./paths";

const LEASE_MAX_BYTES = 64 * 1024;
const POLL_MS = 250;
const DEFAULT_WAIT_MS = 10_000;
/** A start time further than this from the recorded one is another process on a recycled pid. */
const START_TOLERANCE_MS = 2000;

export type LeaseHead = "server" | "resident" | "cli";

export type LeaseRecord = {
  readonly v: 1;
  readonly pid: number;
  /** The holder's start time as the probe reported it, recorded only when it answered. */
  readonly startedAt?: number;
  readonly host: string;
  readonly head: LeaseHead;
  readonly kind: string;
  readonly acquiredAt: string;
  readonly leaseRef: string;
};

/**
 * How a process is judged. `isAlive` answers `undefined` when the platform would not
 * say, which is never death. Harness-supervisor's `ProcessOps` satisfies it.
 */
export type LeaseProbe = {
  isAlive(pid: number): boolean | undefined;
  startTimeMs(pid: number): number | undefined;
};

/**
 * `kill(pid, 0)`, with an unknown start time, so holders it records carry no `startedAt`.
 *
 * First consumers: the mutating lease, and the managed daemon judging a run's holder.
 */
export const defaultLeaseProbe: LeaseProbe = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "ESRCH") return false;
      return code === "EPERM" ? true : undefined;
    }
  },
  startTimeMs: () => undefined,
};

export type LeaseRead =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly lease: LeaseRecord }
  | { readonly state: "unreadable"; readonly reason: string };

export type LeaseHolder = {
  readonly kind: string;
  readonly head: LeaseHead;
  readonly pid: number;
  readonly host: string;
  readonly since: string;
};

export type LeaseOptions = {
  readonly waitMs?: number;
  readonly probe?: LeaseProbe;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
};

export type HeldLease = {
  readonly ok: true;
  readonly lease: LeaseRecord;
  /** Removes the lease only while it is still this one. True when it removed it. */
  release(): boolean;
};

/** Refused: another holder, or a lease file or directory that cannot be used. */
export type LeaseRefused = { readonly ok: false; readonly holder: LeaseHolder } | SafeFsFailure;

type LeaseSeams = {
  /** After a holder is judged dead, before the break takes the lock. */
  readonly afterInspect?: () => void | Promise<void>;
};

let seams: LeaseSeams = {};

/** Test seam: force the race between inspecting a holder and breaking it. Pass `undefined` to restore. */
export function _setLeaseSeamsForTest(next: LeaseSeams | undefined): void {
  seams = next ?? {};
}

function parseLease(body: Record<string, unknown>): LeaseRecord | undefined {
  const { pid, startedAt, host, head, kind, acquiredAt, leaseRef } = body;
  if (body["v"] !== 1) return undefined;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return undefined;
  if (startedAt !== undefined && typeof startedAt !== "number") return undefined;
  if (typeof host !== "string" || typeof kind !== "string") return undefined;
  if (head !== "server" && head !== "resident" && head !== "cli") return undefined;
  if (typeof acquiredAt !== "string" || typeof leaseRef !== "string" || leaseRef === "") {
    return undefined;
  }
  return {
    v: 1,
    pid: pid as number,
    ...(startedAt !== undefined ? { startedAt } : {}),
    host,
    head,
    kind,
    acquiredAt,
    leaseRef,
  };
}

/**
 * The lease as it stands. A pure read.
 *
 * First consumer: Home's job runner, to show what holds a harness.
 */
export function readMutatingLease(harnessDir: string): LeaseRead {
  const rel = controlPaths(harnessDir).mutatingLeaseFile;
  const read = readWholeRecord(harnessDir, rel, LEASE_MAX_BYTES);
  if (read.state !== "body") return read;
  const lease = parseLease(read.body);
  return lease === undefined
    ? { state: "unreadable", reason: `${rel} is not a lease record` }
    : { state: "present", lease };
}

function holderOf(lease: LeaseRecord): LeaseHolder {
  const { kind, head, pid, host, acquiredAt } = lease;
  return { kind, head, pid, host, since: acquiredAt };
}

/**
 * Whether a recorded process is provably gone: on this host, and either the probe says it
 * is not alive, or a recorded start time is more than 2 seconds from the probe's (another
 * process on a recycled pid). A foreign host, a probe that cannot answer, and a holder with
 * no recorded start time whose pid answers alive are all alive.
 *
 * First consumers: the mutating lease, and command recovery judging a receipt's executor.
 */
export function holderProvablyDead(
  holder: { readonly pid: number; readonly startedAtMs?: number; readonly host: string },
  probe: LeaseProbe,
  host: string,
): boolean {
  if (holder.host !== host) return false;
  if (probe.isAlive(holder.pid) === false) return true;
  if (holder.startedAtMs === undefined) return false;
  const observed = probe.startTimeMs(holder.pid);
  return observed !== undefined && Math.abs(observed - holder.startedAtMs) > START_TOLERANCE_MS;
}

function provablyDead(lease: LeaseRecord, probe: LeaseProbe, host: string): boolean {
  return holderProvablyDead(
    {
      pid: lease.pid,
      ...(lease.startedAt !== undefined ? { startedAtMs: lease.startedAt } : {}),
      host: lease.host,
    },
    probe,
    host,
  );
}

function removeLeaseFile(harnessDir: string, rel: string): boolean {
  const at = resolveContained(harnessDir, rel, { followLeaf: false });
  if (!at.ok) return false;
  try {
    unlinkSync(at.real);
    return true;
  } catch {
    return false;
  }
}

/**
 * Break a dead holder and publish, under the control lock. The lock orders breakers; the
 * exclusive publish decides the holder. The holder is re-read inside and removed only
 * while it still carries the `leaseRef` that was judged dead.
 */
async function breakAndPublish(
  harnessDir: string,
  judged: LeaseRecord,
  text: string,
): Promise<ReturnType<typeof writeFileSafe>> {
  const paths = controlPaths(harnessDir);
  const dir = ensureDirContained(harnessDir, dirname(paths.lockFile), { mode: 0o700 });
  if (!dir.ok) return dir;
  try {
    return await withControlLock(join(dir.real, basename(paths.lockFile)), async () => {
      const now = readMutatingLease(harnessDir);
      if (now.state === "present" && now.lease.leaseRef === judged.leaseRef) {
        removeLeaseFile(harnessDir, paths.mutatingLeaseFile);
      }
      return writeFileSafe(harnessDir, paths.mutatingLeaseFile, text, {
        overwrite: false,
        mode: 0o600,
      });
    });
  } catch (err) {
    // The lock is refused or held past its wait: its message names the path and the holder.
    return refusal(
      "io-error",
      paths.lockFile,
      err instanceof Error ? err.message : `${paths.lockFile} could not be taken`,
    );
  }
}

function unreadableLease(rel: string, reason: string): SafeFsFailure {
  return refusal(
    "io-error",
    rel,
    `${reason}. It is treated as held; if nothing is running against this harness, delete ${rel} and retry.`,
  );
}

/**
 * Take the lease: publish exclusively, or poll through `sleep` until `waitMs`, then answer
 * `{ok: false, holder}`. An unreadable lease file is held, and its refusal says how to
 * clear it.
 *
 * First consumers: Home's job runner and the CLI's `eval`, `optimize`, `flywheel`, `dream`
 * and `compile`.
 */
export async function acquireMutatingLease(
  harnessDir: string,
  who: { readonly head: LeaseHead; readonly kind: string },
  options: LeaseOptions = {},
): Promise<HeldLease | LeaseRefused> {
  const seam = seams;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const probe = options.probe ?? defaultLeaseProbe;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const host = hostname();
  const rel = controlPaths(harnessDir).mutatingLeaseFile;
  const dir = ensureDirContained(harnessDir, dirname(rel), { mode: 0o700 });
  if (!dir.ok) return dir;

  const startedAt = probe.startTimeMs(process.pid);
  const lease: LeaseRecord = {
    v: 1,
    pid: process.pid,
    ...(startedAt !== undefined ? { startedAt } : {}),
    host,
    head: who.head,
    kind: who.kind,
    acquiredAt: new Date(now()).toISOString(),
    leaseRef: randomBytes(16).toString("hex"),
  };
  const text = `${JSON.stringify(lease)}\n`;
  const held: HeldLease = {
    ok: true,
    lease,
    release() {
      const current = readMutatingLease(harnessDir);
      if (current.state !== "present" || current.lease.leaseRef !== lease.leaseRef) return false;
      return removeLeaseFile(harnessDir, rel);
    },
  };

  let seen: LeaseRecord | undefined;
  for (let waited = 0; ; waited += POLL_MS) {
    const published = writeFileSafe(harnessDir, rel, text, { overwrite: false, mode: 0o600 });
    if (published.ok) return held;
    if (published.code !== "exists") return published;

    const current = readMutatingLease(harnessDir);
    if (current.state === "unreadable") return unreadableLease(rel, current.reason);
    if (current.state === "present") {
      seen = current.lease;
      if (provablyDead(current.lease, probe, host)) {
        await seam.afterInspect?.();
        const broken = await breakAndPublish(harnessDir, current.lease, text);
        if (broken.ok) return held;
        if (broken.code !== "exists") return broken;
        // Another contender got there first: it is the holder to name now.
        const winner = readMutatingLease(harnessDir);
        if (winner.state === "present") seen = winner.lease;
      }
    }
    if (waited >= waitMs) {
      return seen !== undefined
        ? { ok: false, holder: holderOf(seen) }
        : refusal("changed", rel, `${rel} kept changing while it was being taken; try again`);
    }
    await sleep(POLL_MS);
  }
}

export type WithLeaseAnswer<T> = { readonly ok: true; readonly value: T } | LeaseRefused;

/**
 * Run `fn` holding the lease; it is released when `fn` returns or throws.
 *
 * First consumers: Home's job runner and the CLI's long mutating verbs.
 */
export async function withMutatingLease<T>(
  harnessDir: string,
  who: { readonly head: LeaseHead; readonly kind: string },
  fn: (lease: LeaseRecord) => Promise<T> | T,
  options: LeaseOptions = {},
): Promise<WithLeaseAnswer<T>> {
  const lease = await acquireMutatingLease(harnessDir, who, options);
  if (!lease.ok) return lease;
  try {
    return { ok: true, value: await fn(lease.lease) };
  } finally {
    lease.release();
  }
}
