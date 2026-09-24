import type { FileKind } from "../streams/file";

/**
 * Why a contained filesystem operation refused or failed.
 *
 * Every refusal names the path AS THE CALLER GAVE IT and the reason. It never
 * names where an escaping path resolved to, and never quotes what is there:
 * a tool result is a transcript, a trace and usually an eval report, and "it
 * points at /home/u/.ssh/id_ed25519" is itself the leak.
 */
export type SafeFsCode =
  /** The path, its parent, or a link on the way resolves outside the root. */
  | "escapes-root"
  /** A symbolic link sits where this operation refuses one. */
  | "is-symlink"
  /** A FIFO, socket, device or directory where a regular file is needed (see `kind`). */
  | "not-regular-file"
  /** A regular file (or other non-directory) where a directory is needed. */
  | "not-directory"
  | "not-found"
  /** The destination exists and `overwrite` was not given. */
  | "exists"
  /** The destination's directory does not exist and `createParents` was not given. */
  | "parent-missing"
  /** The path changed between being checked and being used. */
  | "changed"
  | "permission-denied"
  /** A copy would exceed its entry or byte budget; nothing was written. */
  | "too-large"
  /** A copy whose destination is inside its own source, or the reverse. */
  | "overlaps-source"
  /** Empty, NUL-bearing, or naming the root itself where a leaf is needed. */
  | "invalid-path"
  | "io-error";

export type SafeFsFailure = {
  readonly ok: false;
  readonly code: SafeFsCode;
  /** One sentence for the model, naming the caller's path and the reason. */
  readonly reason: string;
  /** The path as the caller gave it. */
  readonly path: string;
  /** For `not-regular-file` / `not-directory`: what was found instead. */
  readonly kind?: FileKind;
  /** For a copy refused with `exists`: the destination paths already there. */
  readonly conflicts?: readonly string[];
};

/** A path quoted for a message: JSON-escaped, so a newline cannot forge a line. */
export function quote(given: string): string {
  return JSON.stringify(given);
}

export function fail(
  code: SafeFsCode,
  given: string,
  reason: string,
  extra: { kind?: FileKind; conflicts?: readonly string[] } = {},
): SafeFsFailure {
  return { ok: false, code, reason, path: given, ...extra };
}

export function escapes(given: string, what = "it"): SafeFsFailure {
  return fail(
    "escapes-root",
    given,
    `${quote(given)} escapes the workspace: ${what} resolves outside the workspace root`,
  );
}

export function notRegular(given: string, kind: FileKind): SafeFsFailure {
  return fail(
    "not-regular-file",
    given,
    `${quote(given)} is a ${kind}, not a regular file; it was not opened`,
    { kind },
  );
}

export function isSymlink(given: string, why: string): SafeFsFailure {
  return fail("is-symlink", given, `${quote(given)} is a symbolic link; ${why}`);
}

/**
 * Map a thrown `node:fs` error to a failure WITHOUT its message. Node's
 * messages quote the path the syscall used — for a write that went wrong
 * after a link was swapped in, that is the outside path — so only the code
 * travels.
 */
export function fromErrno(given: string, err: unknown, doing: string): SafeFsFailure {
  const code = (err as { code?: unknown }).code;
  switch (code) {
    case "ENOENT":
      return fail("not-found", given, `${quote(given)} does not exist`);
    case "ENOTDIR":
      return fail(
        "not-directory",
        given,
        `a component of ${quote(given)} is not a directory, so it cannot be ${doing}`,
      );
    case "EACCES":
    case "EPERM":
      return fail("permission-denied", given, `${quote(given)} cannot be ${doing}: ${code}`);
    case "ELOOP":
    case "EMLINK":
      return isSymlink(given, `it was not ${doing}, because links are not followed here`);
    case "EEXIST":
      return fail("exists", given, `${quote(given)} already exists`);
    case "EISDIR":
      return notRegular(given, "directory");
    default:
      return fail(
        "io-error",
        given,
        `${quote(given)} could not be ${doing}${typeof code === "string" ? `: ${code}` : ""}`,
      );
  }
}

/** A path whose resolution threw: a link loop, or a directory that cannot be searched. */
export function unresolvable(given: string, err: unknown): SafeFsFailure {
  if ((err as { code?: unknown }).code === "ELOOP") {
    return isSymlink(given, "its links loop or chain too deeply to resolve, so it was refused");
  }
  return fromErrno(given, err, "resolved");
}

/** A path argument a filesystem call can take at all. */
export function invalidPath(given: string): SafeFsFailure | undefined {
  if (typeof given !== "string" || given.length === 0) {
    return fail("invalid-path", String(given), "an empty path names nothing");
  }
  if (given.includes("\u0000")) {
    return fail("invalid-path", given, `${quote(given)} contains a NUL byte`);
  }
  return undefined;
}

/**
 * A caller's budget (`maxBytes`, `maxEntries`, `maxDepth` …), or a
 * `RangeError`. A budget of NaN compares false against everything, so a
 * walk given one never stopped and a read given one returned an empty file
 * as if that were its content: a programming error, thrown, never obeyed.
 */
export function requireLimit(name: string, value: number | undefined, required: boolean): void {
  if (value === undefined && !required) return;
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new RangeError(`${name} must be a number >= 0, got ${String(value)}`);
  }
}

/** Thrown by the `assert…` helpers, for call sites that prefer an exception. */
export class SafeFsError extends Error {
  override readonly name = "SafeFsError";
  readonly code: SafeFsCode;
  readonly path: string;
  readonly kind?: FileKind;

  constructor(failure: SafeFsFailure) {
    super(failure.reason);
    this.code = failure.code;
    this.path = failure.path;
    if (failure.kind !== undefined) this.kind = failure.kind;
  }
}
