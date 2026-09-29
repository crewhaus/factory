import { openForReadSync } from "@crewhaus/tool-safety/fs";
import { workspaceRoot } from "../paths";

/**
 * A file's text as 0.7.0's `readFileSync(path, "utf8")` gave it: a leading
 * byte-order mark kept. tool-safety's `text` drops one, which changed a
 * file: secret's value and fingerprint, and dropped the mark from a .env
 * that EnvFileUpsert rewrote (bounds review).
 */
const KEEP_BOM = new TextDecoder("utf-8", { ignoreBOM: true });

/** The most a secret file, a .env, the journal or the lock is read to. */
export const MAX_READ_BYTES = 16 * 1024 * 1024;

/** The errno the callers here already tell apart, for each refusal. */
const ERRNO: Readonly<Record<string, string>> = {
  "not-found": "ENOENT",
  directory: "EISDIR",
  "not-directory": "ENOTDIR",
  "permission-denied": "EACCES",
  "is-symlink": "ELOOP",
  "escapes-root": "EXDEV",
  fifo: "EFTYPE",
  socket: "EFTYPE",
  "block-device": "EFTYPE",
  "character-device": "EFTYPE",
};

/**
 * A workspace file's whole text, as `readFileSync(path, "utf8")` gave it (a
 * leading byte-order mark kept), or a throw carrying an errno-style `code`
 * (`ENOENT` for a missing file).
 *
 * Opened without blocking, and only as a regular file. A FIFO with no writer
 * blocks an ordinary open for ever, and every read in this package is
 * synchronous, so a named pipe where a secret, a .env or the rotation
 * journal was expected stopped the whole harness (C074). The limit is
 * enforced while reading, and a file past it is refused, never cut: half a
 * credential is a wrong credential.
 */
export function readWorkspaceText(path: string, maxBytes = MAX_READ_BYTES): string {
  const read = openForReadSync(workspaceRoot(), path, { maxBytes });
  if (!read.ok) {
    const err = new Error(read.reason) as NodeJS.ErrnoException;
    err.code =
      ERRNO[read.code === "not-regular-file" ? (read.kind ?? read.code) : read.code] ?? "EIO";
    throw err;
  }
  if (read.truncated) {
    const err = new Error(
      `${JSON.stringify(path)} is over the ${maxBytes}-byte limit, so it was not read`,
    ) as NodeJS.ErrnoException;
    err.code = "EFBIG";
    throw err;
  }
  return KEEP_BOM.decode(read.bytes);
}
