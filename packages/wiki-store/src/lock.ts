/**
 * Advisory single-writer `.lock` for the update-in-place wiki store
 * (design §7.6): wait up to 2 s → steal a lock whose mtime is > 30 s stale
 * (with a `lock_stolen` warning naming the dead holder) → fail with a
 * `WikiLockError` naming the holder pid.
 *
 * The policy IMPLEMENTATION lives in `@crewhaus/infra-utils`
 * (`acquireFileLock`/`withFileLock`) — this module shipped as a duplicated
 * copy of `continuity-store/src/lock.ts` while the two stores landed on
 * parallel 0.3.0 branches; the composition-root PR unified the policy into
 * the shared helper. This module keeps the store's public lock surface
 * (error identity, message prefix, option and handle types) exactly as its
 * tests pin it.
 */
import { CrewhausError } from "@crewhaus/errors";
import {
  DEFAULT_FILE_LOCK_POLICY,
  type FileLockHandle,
  type FileLockPolicy,
  acquireFileLock,
  withFileLock,
} from "@crewhaus/infra-utils";

export class WikiLockError extends CrewhausError {
  override readonly name = "WikiLockError";
  constructor(message: string, cause?: unknown) {
    super("runtime", message, cause);
  }
}

export type LockPolicy = FileLockPolicy;

export const DEFAULT_LOCK_POLICY: LockPolicy = DEFAULT_FILE_LOCK_POLICY;

export type AcquireLockOptions = Partial<LockPolicy> & {
  /** Receives the `lock_stolen` warning line. Default: `console.error`. */
  readonly onWarn?: (message: string) => void;
};

export type LockHandle = FileLockHandle;

const STORE_LABEL = "wiki-store";

function toFileLockOptions(opts: AcquireLockOptions) {
  return {
    ...opts,
    label: STORE_LABEL,
    createError: (message: string) => new WikiLockError(message),
  };
}

/**
 * Acquire the advisory lock at `lockPath` under the §7.6 policy. Resolves to
 * a handle whose `release()` unlinks the file; rejects with `WikiLockError`
 * (naming the holder pid) when the lock stays held past `waitMs` without
 * going stale.
 */
export async function acquireLock(
  lockPath: string,
  opts: AcquireLockOptions = {},
): Promise<LockHandle> {
  return acquireFileLock(lockPath, toFileLockOptions(opts));
}

/** Run `fn` while holding the lock at `lockPath`; always releases. */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: AcquireLockOptions = {},
): Promise<T> {
  return withFileLock(lockPath, fn, toFileLockOptions(opts));
}
