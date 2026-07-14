/**
 * Advisory single-writer `.lock` for the update-in-place continuity stores
 * (design §7.6). The policy is defined, not asserted:
 *
 *   1. try to create the lock file with O_EXCL (`flag: "wx"`) — atomic on
 *      POSIX, so exactly one process wins;
 *   2. on contention, wait up to `waitMs` (default 2 s), polling every
 *      `pollMs`;
 *   3. a lock whose file mtime is older than `staleMs` (default 30 s) is
 *      presumed abandoned (its holder crashed without `release()`): it is
 *      STOLEN — unlinked and re-raced — and a warning naming the dead holder
 *      is recorded via `onWarn`;
 *   4. past the deadline the acquire FAILS with a `ContinuityLockError`
 *      naming the holder pid, so "who has it" is never a mystery.
 *
 * The lock is advisory: it serializes cooperating writers (two sessions, a
 * crew of roles, a janitor tick) but does not stop a hostile process. Writers
 * additionally keep every write tmp+rename atomic so a reader never observes
 * a torn file even without the lock.
 */
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CrewhausError } from "@crewhaus/errors";

export class ContinuityLockError extends CrewhausError {
  override readonly name = "ContinuityLockError";
  constructor(message: string, cause?: unknown) {
    super("runtime", message, cause);
  }
}

export type LockPolicy = {
  /** How long to wait for a contended lock before failing. Default 2000. */
  readonly waitMs: number;
  /** A lock older than this (file mtime) is presumed abandoned and stolen.
   *  Default 30_000. */
  readonly staleMs: number;
  /** Poll interval while waiting. Default 50. */
  readonly pollMs: number;
};

export const DEFAULT_LOCK_POLICY: LockPolicy = {
  waitMs: 2_000,
  staleMs: 30_000,
  pollMs: 50,
};

export type AcquireLockOptions = Partial<LockPolicy> & {
  /** Receives the `lock_stolen` warning line. Default: `console.error`. */
  readonly onWarn?: (message: string) => void;
};

export type LockHandle = {
  readonly path: string;
  /** True when this acquisition stole a stale lock from a dead holder. */
  readonly stolen: boolean;
  release(): Promise<void>;
};

type LockFilePayload = { pid?: number; acquiredAt?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readHolder(lockPath: string): Promise<LockFilePayload> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) return parsed as LockFilePayload;
  } catch {
    // Unreadable or torn lock payload — the pid is simply unknown.
  }
  return {};
}

/**
 * Acquire the advisory lock at `lockPath` under the §7.6 policy. Resolves to
 * a handle whose `release()` unlinks the file; rejects with
 * `ContinuityLockError` (naming the holder pid) when the lock stays held past
 * `waitMs` without going stale.
 */
export async function acquireLock(
  lockPath: string,
  opts: AcquireLockOptions = {},
): Promise<LockHandle> {
  const waitMs = opts.waitMs ?? DEFAULT_LOCK_POLICY.waitMs;
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_POLICY.staleMs;
  const pollMs = opts.pollMs ?? DEFAULT_LOCK_POLICY.pollMs;
  const onWarn = opts.onWarn ?? ((message: string) => console.error(message));

  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  let stolen = false;

  for (;;) {
    try {
      const payload: LockFilePayload = {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      };
      await writeFile(lockPath, `${JSON.stringify(payload)}\n`, { flag: "wx", mode: 0o600 });
      return {
        path: lockPath,
        stolen,
        async release(): Promise<void> {
          await unlink(lockPath).catch(() => undefined);
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // Contended. Stale-steal check first so an abandoned lock never forces
    // the deadline failure.
    let mtimeMs: number | undefined;
    try {
      mtimeMs = (await stat(lockPath)).mtimeMs;
    } catch {
      // The holder released between our create attempt and the stat — retry
      // the create immediately.
      continue;
    }
    const ageMs = Date.now() - mtimeMs;
    if (ageMs > staleMs) {
      const holder = await readHolder(lockPath);
      onWarn(
        `continuity-store: lock_stolen — ${lockPath} was held by pid ${holder.pid ?? "unknown"} ` +
          `for ${Math.round(ageMs / 1000)}s (> ${Math.round(staleMs / 1000)}s stale threshold); stealing.`,
      );
      await unlink(lockPath).catch(() => undefined);
      stolen = true;
      continue; // re-race the create — another waiter may legitimately win.
    }

    if (Date.now() >= deadline) {
      const holder = await readHolder(lockPath);
      throw new ContinuityLockError(
        `continuity-store: ${lockPath} is held by pid ${holder.pid ?? "unknown"}${holder.acquiredAt !== undefined ? ` since ${holder.acquiredAt}` : ""} — waited ${waitMs}ms. If that process is gone, delete the lock file and retry.`,
      );
    }
    await sleep(pollMs);
  }
}

/** Run `fn` while holding the lock at `lockPath`; always releases. */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: AcquireLockOptions = {},
): Promise<T> {
  const handle = await acquireLock(lockPath, opts);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
