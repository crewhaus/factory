/**
 * `@crewhaus/tool-safety/fs` — filesystem operations on caller-named paths
 * that contain the LEAF and everything under it, not just the directory the
 * caller named.
 *
 * - {@link resolveContained}: where a path physically lands, links followed
 *   the way the kernel follows them, refused if outside the root.
 * - {@link openForRead}: at most N bytes of a contained regular file.
 * - {@link writeFileSafe} / {@link beginAtomicWrite}: temp + rename, never
 *   through a link, permission bits kept on overwrite.
 * - {@link appendContained}: an in-place append that never follows a link
 *   or opens a file outside the root.
 * - {@link createExclusive}: a new file at an exact name, refused if
 *   anything (a dangling link included) is already there.
 * - {@link ensureDirContained}: `mkdir -p` that does not follow a link out.
 * - {@link walkContained}: the one walk; links and special files reported,
 *   never followed.
 * - {@link copyTreeSafe}: a planned copy with every destination path and
 *   every link's new target checked before a byte is written.
 * - {@link checkRelocatedLinks}: before a rename, every link in the tree
 *   judged from where the rename will put it; no content budget.
 * - {@link probeKind} / {@link assertRegularFile}: what a path is, without
 *   opening it.
 *
 * Every refusal is a {@link SafeFsFailure} naming the caller's path and the
 * reason, never where an escaping path led or what is there.
 */
export {
  type SafeFsCode,
  type SafeFsFailure,
  SafeFsError,
} from "./failure";
export { type FileKind, fileKind } from "../streams/file";
export { type KindProbe, assertRegularFile, probeKind } from "./kind";
export { type Contained, type ResolveOptions, joinRel, resolveContained } from "./resolve";
export {
  type ContainedFd,
  type ContainedRead,
  type OpenForReadOptions,
  openForRead,
  openForReadFd,
  openForReadSync,
} from "./read";
export {
  type AppendOptions,
  type AppendResult,
  type AtomicWriter,
  type CreateExclusiveOptions,
  type CreatedExclusive,
  type DirSymlinkPolicy,
  type EnsureDirOptions,
  type EnsuredDir,
  type LeafSymlinkPolicy,
  type WriteOptions,
  type WriteResult,
  appendContained,
  beginAtomicWrite,
  createExclusive,
  ensureDirContained,
  writeFileSafe,
} from "./write";
export {
  type Unreadable,
  type WalkDecision,
  type WalkEntry,
  type WalkOptions,
  type WalkResult,
  type WalkTruncation,
  walkContained,
} from "./walk";
export {
  RELOCATE_DEFAULTS,
  type RelocateOptions,
  type RelocateResult,
  checkRelocatedLinks,
} from "./relocate";
export {
  type CopyEntry,
  type CopyOptions,
  type CopyResult,
  type CopySkip,
  type CopySymlinkPolicy,
  copyTreeSafe,
} from "./copy";
