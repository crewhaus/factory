import { type FileReadResult, readFileBounded, readFileBoundedSync } from "../streams/file";
import { type SafeFsFailure, fail, isSymlink, notRegular, quote, requireLimit } from "./failure";
import { type Contained, resolveContained } from "./resolve";

/**
 * Reading a caller-named file inside a root: the leaf contained, not just
 * the directory it was joined onto.
 *
 * The recurring defect: a tool contains `dir` and then reads
 * `join(dir.real, "package.json")`. A planted `package.json -> ~/.aws/credentials`
 * is followed, and the parse error or the parsed fields carry the outside
 * file into the transcript (security-9#2, security-7#1, security-7#12,
 * security-5#2, flag-truth-3#6). Here the WHOLE path is resolved physically,
 * links included, and must land inside the root; then the file is read
 * through `readFileBounded` with `O_NOFOLLOW`, so a FIFO or device is
 * refused before it is opened and a link swapped in afterwards is refused
 * on the descriptor.
 */

export type OpenForReadOptions = {
  /** Most bytes returned. The file is never read past this plus one byte. */
  readonly maxBytes: number;
  /**
   * Follow a symlink at the final component when it stays inside the root
   * (default true: an in-workspace `README.md -> docs/README.md` reads
   * normally). False refuses any link at the leaf. A link that leaves the
   * root is refused either way.
   */
  readonly followLeafSymlink?: boolean;
};

export type ContainedRead =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      /** UTF-8; an incomplete final character is dropped when truncated. */
      readonly text: string;
      readonly truncated: boolean;
      /** The size the open descriptor reported. */
      readonly size: number;
      /** Physical path that was read (inside the root). */
      readonly real: string;
      /** Slash-separated path relative to the root, as the caller named it. */
      readonly rel: string;
    }
  | SafeFsFailure;

function mapResult(target: Contained, r: FileReadResult): ContainedRead {
  const given = target.given;
  if (r.ok) {
    return {
      ok: true,
      bytes: r.bytes,
      text: r.text,
      truncated: r.truncated,
      size: r.size,
      real: target.real,
      rel: target.rel,
    };
  }
  // The stream reader's reasons name the physical path it opened; only its
  // code and kind are carried over, under the caller's spelling.
  switch (r.code) {
    case "not-found":
      return fail("not-found", given, `${quote(given)} does not exist`);
    case "not-regular-file":
      return notRegular(given, r.kind ?? "unknown");
    case "symlink-refused":
      return isSymlink(given, "links are not followed at the leaf here, so it was not read");
    case "changed-while-opening":
      return fail(
        "changed",
        given,
        `${quote(given)} was replaced while it was being opened; it was not read`,
      );
    case "permission-denied":
      return fail("permission-denied", given, `${quote(given)} cannot be read: permission denied`);
    default:
      return fail("io-error", given, `${quote(given)} could not be read`);
  }
}

function target(
  root: string,
  given: string,
  options: OpenForReadOptions,
): Contained | SafeFsFailure {
  requireLimit("maxBytes", options.maxBytes, true);
  return resolveContained(root, given, { followLeaf: options.followLeafSymlink ?? true });
}

/**
 * Read at most `maxBytes` of `given` (relative to `root`, or absolute inside
 * it). Refuses a path whose physical location is outside the root, a leaf
 * that is not a regular file, and (with `followLeafSymlink: false`) a leaf
 * that is a link.
 */
export async function openForRead(
  root: string,
  given: string,
  options: OpenForReadOptions,
): Promise<ContainedRead> {
  const at = target(root, given, options);
  if (!at.ok) return at;
  return mapResult(
    at,
    await readFileBounded(at.real, { maxBytes: options.maxBytes, followSymlinks: false }),
  );
}

/** {@link openForRead}, synchronously, for code paths that cannot await. */
export function openForReadSync(
  root: string,
  given: string,
  options: OpenForReadOptions,
): ContainedRead {
  const at = target(root, given, options);
  if (!at.ok) return at;
  return mapResult(
    at,
    readFileBoundedSync(at.real, { maxBytes: options.maxBytes, followSymlinks: false }),
  );
}
