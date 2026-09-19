/**
 * Writing a file that is about to contain a secret.
 *
 * Three properties, each of which has a way of going wrong quietly:
 *
 *   1. **Atomic.** The new contents are written to a temp file in the SAME
 *      directory and renamed over the target, so a reader either sees the old
 *      file or the new one. A truncate-then-write leaves a window in which a
 *      harness starting up reads a half-written `.env` and comes up with no
 *      credentials at all.
 *   2. **Never briefly world-readable.** The temp file is CREATED with mode
 *      0600 (`writeFileSync`'s `mode` applies at creation only — a chmod
 *      afterwards is a race the plaintext loses), and `wx` means it is created
 *      by us or not at all, so a pre-planted symlink at the temp path cannot
 *      redirect the write.
 *   3. **Never more permissive afterwards than before.** The rename gives the
 *      target the temp file's mode, so an existing `.env` would be silently
 *      TIGHTENED to 0600. Tightening is right, but it is a change, so the
 *      file's owner bits are put back and the group/other bits are dropped —
 *      and the result says so, rather than changing a file's permissions
 *      behind an operator's back.
 */
import { chmodSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Serial for temp names. Not randomness: two writes in one process differ. */
let serial = 0;

export type WriteReport = {
  /** e.g. "0644 -> 0600" when group/other bits were dropped. */
  readonly modeTightened?: string;
  readonly created: boolean;
};

/**
 * Write `contents` to `real` atomically, at mode 0600 or the file's own owner
 * bits, whichever is stricter.
 *
 * Throws on any failure: the callers turn that into a named failed STEP, which
 * is more useful than a boolean, because "which step failed" is the whole
 * question after a half-finished rotation.
 */
export function writeFileAtomic(real: string, contents: string): WriteReport {
  const dir = dirname(real);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  let previousMode: number | undefined;
  try {
    previousMode = statSync(real).mode & 0o777;
  } catch {
    previousMode = undefined;
  }

  serial += 1;
  // The temp file lives beside the target so the rename stays inside one
  // filesystem — a rename across devices fails with EXDEV, and the fallback
  // people reach for (copy, then delete) is exactly the non-atomic write this
  // function exists to avoid.
  const temp = join(dir, `.crewhaus-secrets.${process.pid}.${serial}.tmp`);
  try {
    writeFileSync(temp, contents, { mode: 0o600, flag: "wx" });
    renameSync(temp, real);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up: the create is what failed.
    }
    throw err;
  }

  if (previousMode === undefined) return { created: true };
  const desired = previousMode & 0o700;
  if (desired !== 0o600) chmodSync(real, desired);
  const tightened = desired !== previousMode;
  return {
    created: false,
    ...(tightened
      ? {
          modeTightened: `${previousMode.toString(8).padStart(4, "0")} -> ${desired.toString(8).padStart(4, "0")}`,
        }
      : {}),
  };
}
