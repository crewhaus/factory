import { type Stats, lstatSync, statSync } from "node:fs";
import { type FileKind, fileKind } from "../streams/file";
import { SafeFsError, type SafeFsFailure, fromErrno, notRegular } from "./failure";

/**
 * What a path is, asked without opening it.
 *
 * Opening is the dangerous part: `open(O_RDONLY)` on a FIFO blocks until a
 * writer appears, and a synchronous open blocks the event loop with it, so
 * the turn's abort signal, every deadline and every other session in the
 * daemon stop too (flag-truth-6#3, security-11#7, security-6#12,
 * security-7#8). A `stat` never blocks on a FIFO.
 */

export type KindProbe =
  | { readonly ok: true; readonly kind: FileKind; readonly stats: Stats }
  | SafeFsFailure;

/**
 * The kind of `absPath`, or why it could not be told. `followSymlinks`
 * (default false) reports a link as `symlink`; true reports what it leads to.
 * `given` is the caller's spelling, used in the failure message.
 */
export function probeKind(
  absPath: string,
  options: { readonly followSymlinks?: boolean; readonly given?: string } = {},
): KindProbe {
  const given = options.given ?? absPath;
  try {
    const stats = options.followSymlinks === true ? statSync(absPath) : lstatSync(absPath);
    return { ok: true, kind: fileKind(stats), stats };
  } catch (err) {
    return fromErrno(given, err, "examined");
  }
}

/**
 * Throw a {@link SafeFsError} unless `absPath` is a regular file.
 *
 * For code that hands the path to something else (a child process, a
 * library that opens it itself). To READ the file, use `openForRead`, which
 * re-checks the open descriptor: a check followed by a separate
 * `readFileSync` still blocks if the path is swapped for a FIFO in between.
 */
export function assertRegularFile(
  absPath: string,
  options: { readonly followSymlinks?: boolean; readonly given?: string } = {},
): Stats {
  const probe = probeKind(absPath, options);
  if (!probe.ok) throw new SafeFsError(probe);
  if (probe.kind !== "file")
    throw new SafeFsError(notRegular(options.given ?? absPath, probe.kind));
  return probe.stats;
}
