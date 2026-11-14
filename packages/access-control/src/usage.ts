/**
 * When each token and each device was last used, for the access lists: a convenience,
 * never a gate. `<hangarRoot>/access/usage.json` (`{v: 1, credentials, devices}`, `0600`,
 * written whole) sits on its own lock, so signing in never waits on the access lock, and
 * it is never one of the access ledgers and never moves the access revision: who may do
 * what is unchanged by a request.
 *
 * Writes are throttled to one per credential and per device per minute, by an in-process
 * memory and by the value already on disk, so a restart inside the minute writes nothing
 * new. A failed write is one warning, never an error a request sees.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withLedgerLock } from "@crewhaus/control-records";
import { readJsonFile, writeJsonFile } from "./files";
import { accessPaths } from "./paths";

/**
 * At most one write per credential and per device in this long.
 *
 * First consumer: {@link createUsageRecorder}.
 */
export const USAGE_THROTTLE_MS = 60_000;

const MAX_FILE_BYTES = 1024 * 1024;

export type UsageRecord = {
  readonly v: 1;
  /** `crd_…` → when it last authenticated. */
  readonly credentials: Readonly<Record<string, string>>;
  /** `dev_…` → when a session on it last authenticated. */
  readonly devices: Readonly<Record<string, string>>;
};

const EMPTY: UsageRecord = Object.freeze({
  v: 1,
  credentials: Object.freeze({}),
  devices: Object.freeze({}),
}) as UsageRecord;

function timesOf(value: unknown, prefix: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, at] of Object.entries(value)) {
    if (id.startsWith(prefix) && typeof at === "string" && !Number.isNaN(Date.parse(at))) {
      out[id] = at;
    }
  }
  return out;
}

/**
 * The usage record, tolerantly: a missing, unreadable or malformed file reads as empty,
 * and an entry that is not a time is left out. Never throws, never writes.
 *
 * First consumers: the access views' `lastUsedAt`.
 */
export function readUsage(hangarRoot: string): UsageRecord {
  try {
    const read = readJsonFile(hangarRoot, accessPaths().usage, MAX_FILE_BYTES);
    if (read.state !== "present" || read.value["v"] !== 1) return EMPTY;
    return {
      v: 1,
      credentials: timesOf(read.value["credentials"], "crd_"),
      devices: timesOf(read.value["devices"], "dev_"),
    };
  } catch {
    return EMPTY;
  }
}

export type UsageUse = { readonly credential?: string; readonly device?: string };

export type UsageRecorderOptions = {
  readonly now?: () => number;
  /** The writer, injectable so a test counts writes. */
  readonly write?: (hangarRoot: string, record: UsageRecord) => boolean;
  readonly onWarn?: (message: string) => void;
};

export type UsageRecorder = {
  /** Note one authenticated use. Resolves once written or skipped; never rejects. */
  record(use: UsageUse): Promise<void>;
};

function defaultWrite(hangarRoot: string, record: UsageRecord): boolean {
  return writeJsonFile(hangarRoot, accessPaths().usage, record).ok;
}

/**
 * A recorder for one Hangar root, with its own in-process memory. It writes nothing for a
 * root whose `access/` does not exist: no access records, nothing to note.
 *
 * First consumer: Home's authentication step.
 */
export function createUsageRecorder(
  hangarRoot: string,
  options: UsageRecorderOptions = {},
): UsageRecorder {
  const now = options.now ?? (() => Date.now());
  const write = options.write ?? defaultWrite;
  const written = new Map<string, number>();
  let warned = false;
  const paths = accessPaths();

  /** Whether the value on disk is already inside the throttle window at `at`. */
  const freshOnDisk = (onDisk: string | undefined, at: number): number | undefined => {
    const disk = onDisk === undefined ? Number.NaN : Date.parse(onDisk);
    return !Number.isNaN(disk) && at >= disk && at - disk < USAGE_THROTTLE_MS ? disk : undefined;
  };

  return {
    async record(use) {
      const at = now();
      const uses: [string, "credentials" | "devices"][] = [];
      if (typeof use.credential === "string") uses.push([use.credential, "credentials"]);
      if (typeof use.device === "string") uses.push([use.device, "devices"]);
      // Claimed before anything is awaited, so two requests at once write once.
      const due = uses.filter(([id]) => {
        const memo = written.get(id);
        return memo === undefined || at < memo || at - memo >= USAGE_THROTTLE_MS;
      });
      if (due.length === 0) return;
      for (const [id] of due) written.set(id, at);
      if (!existsSync(join(hangarRoot, paths.dir))) return;
      try {
        await withLedgerLock(
          {
            root: hangarRoot,
            records: { file: paths.usage },
            lock: paths.usageLock,
            claims: join(paths.dir, "usage-claims"),
          },
          () => {
            const current = readUsage(hangarRoot);
            const next = {
              credentials: { ...current.credentials },
              devices: { ...current.devices },
            };
            let changed = false;
            for (const [id, map] of due) {
              const disk = freshOnDisk(next[map][id], at);
              if (disk !== undefined) {
                written.set(id, disk);
                continue;
              }
              next[map][id] = new Date(at).toISOString();
              changed = true;
            }
            if (!changed) return;
            if (!write(hangarRoot, { v: 1, ...next })) {
              throw new Error("the usage record could not be written");
            }
          },
        );
      } catch (err) {
        for (const [id] of due) written.delete(id);
        if (!warned) {
          warned = true;
          options.onWarn?.(
            `access-control: when a token was last used could not be recorded: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    },
  };
}

const recorders = new Map<
  string,
  { readonly recorder: UsageRecorder; readonly at: { now: number } }
>();

/**
 * Note one authenticated use under `hangarRoot`, through one recorder per root for this
 * process. `now` is the time of the request.
 *
 * First consumer: Home's authentication step.
 */
export function recordUsage(
  hangarRoot: string,
  use: UsageUse,
  now: number,
  onWarn?: (message: string) => void,
): Promise<void> {
  let entry = recorders.get(hangarRoot);
  if (entry === undefined) {
    const at = { now };
    entry = {
      at,
      recorder: createUsageRecorder(hangarRoot, {
        now: () => at.now,
        ...(onWarn !== undefined ? { onWarn } : {}),
      }),
    };
    recorders.set(hangarRoot, entry);
  }
  entry.at.now = now;
  return entry.recorder.record(use);
}
