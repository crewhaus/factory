import { randomBytes } from "node:crypto";
import {
  constants,
  type Stats,
  closeSync,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import * as path from "node:path";
import { fileKind } from "../streams/file";
import { descriptorPath, descriptorPathSupported } from "./descriptor";
import {
  SafeFsError,
  type SafeFsFailure,
  escapes,
  escapesAsWritten,
  fail,
  fromErrno,
  invalidPath,
  isSymlink,
  notRegular,
  quote,
  unresolvable,
} from "./failure";
import { type Root, isWithin, physicalPath, prepareRoot, toPosix } from "./resolve";

/**
 * Writing to a caller-named path inside a root, without writing THROUGH
 * anything planted there.
 *
 * The audit found the same shape in eight packages: the directory is
 * contained, then a leaf, a temp name or a part name is joined onto it and
 * handed to `writeFileSync`/`openSync(…, "w")`, which follow a symlink —
 * a dangling one included, which they CREATE. `baselines.json`,
 * `<slug>.md.tmp`, `<name>.part0001`, `<dest>.crewhaus-part-<pid>-0` and
 * `<golden>.tmp-<pid>` each became a write outside the workspace
 * (security-7#0, flag-truth-4#3, security-2#0, flag-truth-6#1,
 * security-11#1, security-8#13, security-9#3, security-6#7,
 * flag-truth-3#3).
 *
 * The rules here:
 *   - the destination's DIRECTORY is resolved physically and must be inside
 *     the root; a leaf that is a symlink or not a regular file is refused;
 *   - bytes go to a temp created with `O_CREAT|O_EXCL|O_NOFOLLOW` under a
 *     random name in that same real directory — `O_EXCL` fails on ANY
 *     existing name, a dangling link included — and the temp is then renamed
 *     into place. `rename` replaces a link rather than writing through it;
 *   - without `overwrite`, the temp is hard-linked into place, which fails
 *     if anything appeared at the name meanwhile, instead of clobbering it;
 *   - an overwrite keeps the replaced file's permission bits, so an edited
 *     script stays executable and a 0600 file stays 0600 (security-6#11).
 */

const O_NOFOLLOW = (constants as Record<string, number | undefined>)["O_NOFOLLOW"] ?? 0;
/**
 * Read-write, not write-only: macOS resolves `/dev/fd/<fd>` only for a
 * descriptor it could reopen for reading, and the check that a new file
 * landed where it was meant to (`createdInDir`) asks exactly that. A new
 * file is opened with the access asked for, whatever its mode bits.
 */
export const EXCLUSIVE = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW;

/**
 * Permission bits an overwrite carries over: the rwx bits. setuid and setgid
 * are dropped, as the kernel drops them when an unprivileged process writes
 * the file in place. (Bun's `fchmodSync` cannot set the special bits at all,
 * measured on 1.3.14, so asking for them would change nothing.)
 */
export const PRESERVED_MODE_BITS = 0o777;

const SPLIT = path.sep === "/" ? "/" : /[\\/]/;

export type LexicalTarget = { abs: string; base: string; known: Root };

export function lexicalIn(root: Root, given: string): LexicalTarget | SafeFsFailure {
  const bad = invalidPath(given);
  if (bad !== undefined) return bad;
  const abs = path.resolve(root.lexical, given);
  if (isWithin(root.lexical, abs)) return { abs, base: root.lexical, known: root };
  if (isWithin(root.physical, abs)) {
    return { abs, base: root.physical, known: { lexical: root.physical, physical: root.physical } };
  }
  return escapesAsWritten(given);
}

// ---------------------------------------------------------------------------
// directories
// ---------------------------------------------------------------------------

export type DirSymlinkPolicy = "refuse" | "follow-contained";

export type EnsureDirOptions = {
  /** Mode for directories this call creates (umask applies). Default 0o777. */
  readonly mode?: number;
  /**
   * An existing component that is a symlink: follow it when it stays inside
   * the root (default), or refuse any link at all — for a layout whose
   * components must be real directories, such as a trash can.
   */
  readonly symlinks?: DirSymlinkPolicy;
};

export type EnsuredDir =
  | {
      readonly ok: true;
      /** Physical path of the directory, inside the root. */
      readonly real: string;
      /** Physical paths of the directories this call created, outermost first. */
      readonly created: readonly string[];
    }
  | SafeFsFailure;

/**
 * Walk from the root to `lexAbs` one component at a time, creating what is
 * missing with a NON-recursive mkdir. `mkdirSync(…, { recursive: true })`
 * follows any link on the way, which is how a planted `datasets/evil ->
 * /outside` becomes a directory created, and then written, outside.
 */
export function ensureDirIn(
  root: Root,
  given: string,
  target: LexicalTarget,
  options: EnsureDirOptions,
  depth = 0,
): EnsuredDir {
  const policy = options.symlinks ?? "follow-contained";
  const mode = options.mode ?? 0o777;
  const created: string[] = [];
  let retries = 0;
  let cur = target.known.physical;
  const pending = path
    .relative(target.base, target.abs)
    .split(SPLIT)
    .filter((c) => c !== "" && c !== ".");
  for (let i = 0; i < pending.length; i++) {
    const next = path.join(cur, pending[i] as string);
    let st: Stats | undefined;
    try {
      st = lstatSync(next);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "ENOENT") return fromErrno(given, err, "created");
    }
    if (st === undefined) {
      try {
        mkdirSync(next, { mode });
        created.push(next);
      } catch (err) {
        // Lost a race to another creator: look again at what is there now.
        if ((err as { code?: unknown }).code === "EEXIST" && retries < 2) {
          i -= 1;
          retries += 1;
          continue;
        }
        return fromErrno(given, err, "created");
      }
      cur = next;
      continue;
    }
    if (st.isSymbolicLink()) {
      if (policy === "refuse") {
        return isSymlink(
          given,
          "a directory on its path is a symbolic link, and links are not followed here",
        );
      }
      let real: string;
      try {
        real = physicalPath(next);
      } catch (err) {
        return unresolvable(given, err);
      }
      if (!isWithin(root.physical, real)) return escapes(given, "a directory on its path");
      if (depth > 8) return unresolvable(given, { code: "ELOOP" });
      // A dangling in-root link names a directory still to be created: make
      // it, by the same component-at-a-time rule, then carry on beneath it.
      const inner = ensureDirIn(
        root,
        given,
        {
          abs: real,
          base: root.physical,
          known: { lexical: root.physical, physical: root.physical },
        },
        options,
        depth + 1,
      );
      if (!inner.ok) return inner;
      created.push(...inner.created);
      cur = inner.real;
      continue;
    }
    if (!st.isDirectory()) {
      const kind = fileKind(st);
      return fail(
        "not-directory",
        given,
        `a component of ${quote(given)} is a ${kind}, not a directory`,
        { kind },
      );
    }
    cur = next;
  }
  return { ok: true, real: cur, created };
}

/**
 * Make sure directory `given` exists inside `root`, creating each missing
 * component without following anything that is not contained. Returns its
 * physical path.
 */
export function ensureDirContained(
  root: string,
  given: string,
  options: EnsureDirOptions = {},
): EnsuredDir {
  const prepared = prepareRoot(root, given);
  if ("ok" in prepared) return prepared;
  const target = lexicalIn(prepared, given);
  if ("ok" in target) return target;
  return ensureDirIn(prepared, given, target, options);
}

// ---------------------------------------------------------------------------
// the leaf
// ---------------------------------------------------------------------------

export type LeafSymlinkPolicy = "refuse" | "follow-contained";

type Leaf = {
  ok: true;
  root: Root;
  /** The physical directory the leaf lives in, as it was checked. */
  dir: CheckedDir;
  /** Physical path of the leaf. */
  leafReal: string;
  rel: string;
  /** The regular file already there, if any. */
  existing: Stats | undefined;
};

/**
 * A directory as it was checked: its physical path and which directory it
 * was. The identity, not the spelling, is what a later check compares: on a
 * case-insensitive volume `Docs` and `docs` are one directory, and
 * `realpath` answers with the on-disk case, so comparing spellings refused
 * every write whose caller wrote the other case.
 */
export type CheckedDir = { readonly real: string; readonly dev: number; readonly ino: number };

/** `real` as a {@link CheckedDir}, or undefined when it is not a directory (a link is not). */
export function checkDir(real: string): CheckedDir | undefined {
  try {
    const st = lstatSync(real);
    return st.isDirectory() ? { real, dev: st.dev, ino: st.ino } : undefined;
  } catch {
    return undefined;
  }
}

function locateLeaf(
  rootArg: string,
  given: string,
  options: { createParents?: boolean; leafSymlink?: LeafSymlinkPolicy },
): Leaf | SafeFsFailure {
  const root = prepareRoot(rootArg, given);
  if ("ok" in root) return root;
  const target = lexicalIn(root, given);
  if ("ok" in target) return target;
  if (target.abs === target.base) {
    return fail("invalid-path", given, `${quote(given)} names the workspace root, not a file`);
  }
  const rel = toPosix(path.relative(target.base, target.abs));
  const parent: LexicalTarget = { ...target, abs: path.dirname(target.abs) };
  let dirReal: string;
  if (options.createParents === true) {
    const ensured = ensureDirIn(root, given, parent, {});
    if (!ensured.ok) return ensured;
    dirReal = ensured.real;
  } else {
    try {
      dirReal = physicalPath(parent.abs, { known: target.known });
    } catch (err) {
      return unresolvable(given, err);
    }
    if (!isWithin(root.physical, dirReal)) return escapes(given, "its directory");
    let st: Stats;
    try {
      st = lstatSync(dirReal);
    } catch (err) {
      if ((err as { code?: unknown }).code === "ENOENT") {
        return fail(
          "parent-missing",
          given,
          `the directory ${quote(given)} would go in does not exist; create it first`,
        );
      }
      return fromErrno(given, err, "written");
    }
    if (!st.isDirectory()) {
      const kind = fileKind(st);
      return fail("not-directory", given, `the parent of ${quote(given)} is a ${kind}`, { kind });
    }
  }
  const dir = checkDir(dirReal);
  if (dir === undefined) {
    return fail("changed", given, `the directory of ${quote(given)} changed while it was checked`);
  }
  createHooks.afterResolve?.(dirReal);
  return examineLeaf(root, given, rel, dir, path.basename(target.abs), options, 0);
}

function examineLeaf(
  root: Root,
  given: string,
  rel: string,
  dir: CheckedDir,
  name: string,
  options: { leafSymlink?: LeafSymlinkPolicy },
  hops: number,
): Leaf | SafeFsFailure {
  const leafReal = path.join(dir.real, name);
  let st: Stats | undefined;
  try {
    st = lstatSync(leafReal);
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") return fromErrno(given, err, "written");
  }
  if (st === undefined) return { ok: true, root, dir, leafReal, rel, existing: undefined };
  if (st.isSymbolicLink()) {
    if (options.leafSymlink !== "follow-contained" || hops > 0) {
      return isSymlink(given, "it was not written through or replaced");
    }
    let real: string;
    try {
      real = physicalPath(leafReal);
    } catch (err) {
      return unresolvable(given, err);
    }
    if (!isWithin(root.physical, real)) return escapes(given);
    const realDir = checkDir(path.dirname(real));
    if (realDir === undefined) {
      return fail(
        "parent-missing",
        given,
        `${quote(given)} is a link into a directory that does not exist, or is not a directory`,
      );
    }
    return examineLeaf(root, given, rel, realDir, path.basename(real), options, hops + 1);
  }
  if (!st.isFile()) return notRegular(given, fileKind(st));
  return { ok: true, root, dir, leafReal, rel, existing: st };
}

/**
 * The directory a file was just created in is still the directory that was
 * checked: its path leads to the same directory now, so no component was
 * swapped for a link between the check and the create. Node has no
 * `openat`, so this detects a swap after the fact rather than preventing it;
 * the caller then removes what it made (see {@link unlinkIfSame}).
 */
export function dirUnchanged(dir: CheckedDir): boolean {
  try {
    const now = statSync(dir.real);
    return now.isDirectory() && now.dev === dir.dev && now.ino === dir.ino;
  } catch {
    return false;
  }
}

type CreateHooks = {
  /** After the directory is resolved, before the leaf is examined. */
  afterResolve?: (dirReal: string) => void;
  beforeCreate?: (real: string) => void;
  afterCreate?: (real: string) => void;
};
let createHooks: CreateHooks = {};

/**
 * Test seam: run code just before and just after a file is created
 * exclusively, to swap a directory exactly there. Pass `{}` to restore.
 */
export function _setCreateHooksForTest(next: CreateHooks): void {
  createHooks = next;
}

/**
 * The file just created on `fd` is in the directory that was checked. Asked
 * of the descriptor where the kernel can say where it is (see
 * `descriptor.ts`): then a file that a swapped directory put somewhere else
 * is found where it really is and removed there, before a byte is written.
 * Elsewhere, the directory's identity is compared, as before.
 */
export function createdInDir(fd: number, dir: CheckedDir, rootPhysical: string): boolean {
  if (!descriptorPathSupported(rootPhysical)) return dirUnchanged(dir);
  const held = descriptorPath(fd);
  if (held === undefined) return dirUnchanged(dir);
  const parent = checkDir(path.dirname(held));
  if (parent !== undefined && parent.dev === dir.dev && parent.ino === dir.ino) return true;
  try {
    unlinkIfSame(held, fstatSync(fd));
  } catch {
    // Could not tell it is ours: leave it.
  }
  return false;
}

/**
 * The file open on `fd`, which this call did NOT create, is in the checked
 * directory. Like {@link createdInDir}, but it never removes anything: the
 * file may be someone else's.
 */
function openedInDir(fd: number, dir: CheckedDir, rootPhysical: string): boolean {
  if (!descriptorPathSupported(rootPhysical)) return dirUnchanged(dir);
  const held = descriptorPath(fd);
  if (held === undefined) return dirUnchanged(dir);
  const parent = checkDir(path.dirname(held));
  return parent !== undefined && parent.dev === dir.dev && parent.ino === dir.ino;
}

export function tryUnlink(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    // already gone, or never made
  }
}

/**
 * Remove `p` only if it is still the file this call created. After a
 * directory on the way was swapped, the same NAME can lead somewhere else,
 * and removing whatever is there now would delete a stranger's file.
 */
export function unlinkIfSame(p: string, made: Stats): void {
  try {
    const now = lstatSync(p);
    if (now.dev === made.dev && now.ino === made.ino) unlinkSync(p);
  } catch {
    // gone, or unreadable: leave it
  }
}

export function writeAll(fd: number, data: string | Uint8Array): number {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  let off = 0;
  while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
  return bytes.length;
}

// ---------------------------------------------------------------------------
// createExclusive
// ---------------------------------------------------------------------------

export type CreateExclusiveOptions = {
  /** Mode for the new file (umask applies). Default 0o666. */
  readonly mode?: number;
  readonly createParents?: boolean;
};

export type CreatedExclusive =
  | {
      readonly ok: true;
      /** Open for writing. The caller writes with `writeSync` and closes it. */
      readonly fd: number;
      /** Physical path of the new file. */
      readonly real: string;
      readonly rel: string;
    }
  | SafeFsFailure;

/**
 * Create `given` as a NEW regular file and open it for writing, refusing if
 * anything at all is at that name — a file, a directory, or a symlink,
 * dangling or not. For part files, partials and temps whose name a planted
 * link could be waiting at.
 */
export function createExclusive(
  root: string,
  given: string,
  options: CreateExclusiveOptions = {},
): CreatedExclusive {
  const found = locateLeaf(root, given, { createParents: options.createParents === true });
  if (!found.ok) return found;
  if (found.existing !== undefined) {
    return fail("exists", given, `${quote(given)} already exists; it was not replaced`);
  }
  let fd: number;
  try {
    createHooks.beforeCreate?.(found.leafReal);
    fd = openSync(found.leafReal, EXCLUSIVE, options.mode ?? 0o666);
    createHooks.afterCreate?.(found.leafReal);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "EEXIST" || code === "ELOOP") {
      return fail(
        "exists",
        given,
        `${quote(given)} appeared (a file or a link) while it was being created; it was not replaced`,
      );
    }
    return fromErrno(given, err, "created");
  }
  if (!createdInDir(fd, found.dir, found.root.physical)) {
    try {
      // Without the descriptor's path, the name is all there is to go by.
      unlinkIfSame(found.leafReal, fstatSync(fd));
    } finally {
      closeSync(fd);
    }
    return fail(
      "changed",
      given,
      `the directory of ${quote(given)} changed while it was being created`,
    );
  }
  return { ok: true, fd, real: found.leafReal, rel: found.rel };
}

// ---------------------------------------------------------------------------
// appendContained
// ---------------------------------------------------------------------------

const O_NONBLOCK = (constants as Record<string, number | undefined>)["O_NONBLOCK"] ?? 0;
/** An existing file: never created, never followed. Read-write for the same reason as {@link EXCLUSIVE}. */
const APPEND_EXISTING = constants.O_RDWR | constants.O_APPEND | O_NOFOLLOW | O_NONBLOCK;
/** A new file: created exclusively, so a file found in the wrong place is ours to remove. */
const APPEND_NEW = EXCLUSIVE | constants.O_APPEND;

export type AppendOptions = {
  /** Create missing parent directories, each one contained. Default false. */
  readonly createParents?: boolean;
  /** Create the file when it does not exist (default true). False refuses a missing file. */
  readonly create?: boolean;
  /** Mode for a file this call creates (umask applies). Default 0o666. */
  readonly mode?: number;
};

export type AppendResult =
  | {
      readonly ok: true;
      readonly real: string;
      readonly rel: string;
      /** The file did not exist before this call. */
      readonly created: boolean;
      /** Bytes appended. */
      readonly bytes: number;
      /** The file's size after the append. */
      readonly size: number;
    }
  | SafeFsFailure;

/**
 * Append `data` to `given` inside `root`, in place: for a log or a JSONL
 * index that many runs add to (eval-report's `index.jsonl`), and for
 * touching a file, where rewriting it through a temp would cost O(n) and
 * race other appenders.
 *
 * The directory is contained as for {@link writeFileSafe}, and a link or a
 * special file at the leaf is refused. An existing file is opened without
 * `O_CREAT`, with `O_NOFOLLOW|O_NONBLOCK`, and must be the very file that
 * was checked, in the directory that was checked (asked of the descriptor
 * where the kernel can say). A missing one is created with `O_EXCL`, and if
 * it turns out to be in the wrong place it is removed there. Either way,
 * nothing is written until the checks pass.
 *
 * Each call's bytes land at the end of the file. One `write` is atomic
 * against other appenders; a large `data` may take several, so keep records
 * small enough to append in one (a JSONL line).
 */
export function appendContained(
  root: string,
  given: string,
  data: string | Uint8Array,
  options: AppendOptions = {},
): AppendResult {
  for (let attempt = 0; ; attempt++) {
    const found = locateLeaf(root, given, { createParents: options.createParents === true });
    if (!found.ok) return found;
    const existing = found.existing;
    if (existing === undefined && options.create === false) {
      return fail("not-found", given, `${quote(given)} does not exist, and create is false`);
    }
    let fd: number;
    try {
      createHooks.beforeCreate?.(found.leafReal);
      fd = openSync(
        found.leafReal,
        existing === undefined ? APPEND_NEW : APPEND_EXISTING,
        options.mode ?? 0o666,
      );
      createHooks.afterCreate?.(found.leafReal);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      // Another appender created it first: append to theirs.
      if (code === "EEXIST" && attempt === 0) continue;
      if (code === "ENXIO") return notRegular(given, "fifo");
      return fromErrno(given, err, "appended to");
    }
    try {
      const opened = fstatSync(fd);
      if (existing === undefined) {
        if (!createdInDir(fd, found.dir, found.root.physical)) {
          return fail(
            "changed",
            given,
            `the directory of ${quote(given)} changed while it was being created; nothing was appended`,
          );
        }
      } else if (
        !opened.isFile() ||
        opened.dev !== existing.dev ||
        opened.ino !== existing.ino ||
        !openedInDir(fd, found.dir, found.root.physical)
      ) {
        return fail(
          "changed",
          given,
          `${quote(given)} changed while it was being opened; nothing was appended`,
        );
      }
      const bytes = writeAll(fd, data);
      return {
        ok: true,
        real: found.leafReal,
        rel: found.rel,
        created: existing === undefined,
        bytes,
        size: fstatSync(fd).size,
      };
    } catch (err) {
      return fromErrno(given, err, "appended to");
    } finally {
      closeSync(fd);
    }
  }
}

// ---------------------------------------------------------------------------
// atomic writes
// ---------------------------------------------------------------------------

export type WriteOptions = {
  /** Replace an existing regular file. Without it, an existing name is refused. */
  readonly overwrite: boolean;
  /** Create missing parent directories, each one contained. Default false. */
  readonly createParents?: boolean;
  /**
   * Mode for a NEW file (umask applies; default 0o666). An overwrite keeps the
   * replaced file's rwx permission bits instead.
   */
  readonly mode?: number;
  /**
   * A symlink at the leaf: refuse it (default), or write to where it leads
   * when that is inside the root, as editing `README.md -> docs/README.md`
   * edits the doc. A link out of the root is refused either way.
   */
  readonly leafSymlink?: LeafSymlinkPolicy;
};

export type WriteResult =
  | {
      readonly ok: true;
      /** Physical path written, inside the root. */
      readonly real: string;
      readonly rel: string;
      /** False when an existing file was replaced. */
      readonly created: boolean;
      readonly bytes: number;
      /** Permission bits the file now has. */
      readonly mode: number;
    }
  | SafeFsFailure;

export type AtomicWriter = {
  /** Physical path the data will land at on commit. */
  readonly real: string;
  readonly rel: string;
  /** Append bytes to the temp. Throws a `SafeFsError` if the write fails. */
  write(chunk: string | Uint8Array): void;
  /** Move the temp into place. Removes the temp on any failure. */
  commit(): WriteResult;
  /** Discard the temp. Idempotent. */
  abort(): void;
};

let linkIntoPlace: (from: string, to: string) => void = linkSync;

/**
 * Test seam: the hard-link step, so the fallback for filesystems without
 * hard links can be exercised. Pass `undefined` to restore.
 */
export function _setLinkForTest(fn: ((from: string, to: string) => void) | undefined): void {
  linkIntoPlace = fn ?? linkSync;
}

const randomSuffix = (): string => randomBytes(8).toString("hex");
let tempSuffix: () => string = randomSuffix;

/**
 * Test seam: the temp name's random part, so a test can plant something at
 * the exact name a write will use. Pass `undefined` to restore.
 */
export function _setTempSuffixForTest(fn: (() => string) | undefined): void {
  tempSuffix = fn ?? randomSuffix;
}

/** Bytes of the destination's name kept in a temp name, so it stays far under NAME_MAX (255). */
const TEMP_NAME_PREFIX_BYTES = 96;

/**
 * The start of `name`, at most `maxBytes` of UTF-8, cut on a character
 * boundary. Counting UTF-16 units instead let a name of CJK characters make
 * a temp name three times longer than NAME_MAX, and the write then failed.
 */
export function utf8Prefix(name: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of name) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += ch.length;
  }
  return name.slice(0, end);
}

export function tempName(name: string): string {
  // Unpredictable, hidden, and short enough to stay under NAME_MAX.
  return `.${utf8Prefix(name, TEMP_NAME_PREFIX_BYTES)}.${tempSuffix()}.tmp`;
}

/**
 * Open a temp beside `given` for streamed writes; `commit()` puts it in place
 * under the same rules as {@link writeFileSafe}. For a download or any writer
 * that produces its bytes in pieces.
 */
export function beginAtomicWrite(
  root: string,
  given: string,
  options: WriteOptions,
): { readonly ok: true; readonly writer: AtomicWriter } | SafeFsFailure {
  const leaf = locateLeaf(root, given, options);
  if (!leaf.ok) return leaf;
  if (leaf.existing !== undefined && !options.overwrite) {
    return fail("exists", given, `${quote(given)} already exists; pass overwrite to replace it`);
  }
  const preserved =
    leaf.existing === undefined ? undefined : leaf.existing.mode & PRESERVED_MODE_BITS;
  const temp = path.join(leaf.dir.real, tempName(path.basename(leaf.leafReal)));
  let fd: number;
  try {
    // A temp that replaces a file starts private and gets the old bits on
    // commit; a new file is created with its final mode straight away.
    createHooks.beforeCreate?.(temp);
    fd = openSync(temp, EXCLUSIVE, preserved === undefined ? (options.mode ?? 0o666) : 0o600);
    createHooks.afterCreate?.(temp);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "EEXIST" || code === "ELOOP") {
      // The name is random, so something waiting there was put there on
      // purpose. It is not followed, and it is not removed.
      return fail(
        "changed",
        given,
        `something already occupies the temporary name beside ${quote(given)}; nothing was written`,
      );
    }
    return fromErrno(given, err, "written");
  }
  let made: Stats;
  try {
    made = fstatSync(fd);
  } catch (err) {
    closeSync(fd);
    tryUnlink(temp);
    return fromErrno(given, err, "written");
  }
  if (!createdInDir(fd, leaf.dir, leaf.root.physical)) {
    closeSync(fd);
    unlinkIfSame(temp, made);
    return fail(
      "changed",
      given,
      `the directory of ${quote(given)} changed while the write was starting; nothing was written`,
    );
  }
  let open = true;
  let bytes = 0;
  const discard = (): void => {
    if (open) {
      open = false;
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    // Only while the name still leads to the temp this call made: after a
    // directory swap the same name can lead to someone else's file.
    unlinkIfSame(temp, made);
  };
  const writer: AtomicWriter = {
    real: leaf.leafReal,
    rel: leaf.rel,
    write(chunk) {
      if (!open)
        throw new SafeFsError(
          fail("changed", given, `the write to ${quote(given)} was already finished`),
        );
      try {
        bytes += writeAll(fd, chunk);
      } catch (err) {
        discard();
        throw new SafeFsError(fromErrno(given, err, "written"));
      }
    },
    abort: discard,
    commit(): WriteResult {
      if (!open) return fail("changed", given, `the write to ${quote(given)} was already finished`);
      try {
        if (preserved !== undefined) fchmodSync(fd, preserved);
        open = false;
        closeSync(fd);
      } catch (err) {
        discard();
        return fromErrno(given, err, "written");
      }
      if (!dirUnchanged(leaf.dir)) {
        discard();
        return fail(
          "changed",
          given,
          `the directory of ${quote(given)} changed during the write; nothing was replaced`,
        );
      }
      const placed = options.overwrite
        ? replaceInto(given, temp, leaf.leafReal)
        : linkInto(given, temp, leaf.leafReal);
      if (placed !== undefined) {
        unlinkIfSame(temp, made);
        return placed;
      }
      let mode: number;
      try {
        mode = lstatSync(leaf.leafReal).mode & 0o7777;
      } catch {
        mode = preserved ?? 0;
      }
      return {
        ok: true,
        real: leaf.leafReal,
        rel: leaf.rel,
        created: leaf.existing === undefined,
        bytes,
        mode,
      };
    },
  };
  return { ok: true, writer };
}

/** Overwrite allowed: rename over a regular file or an empty name, never over a link. */
export function replaceInto(
  given: string,
  temp: string,
  leafReal: string,
): SafeFsFailure | undefined {
  try {
    const st = lstatSync(leafReal);
    if (st.isSymbolicLink())
      return isSymlink(given, "one appeared during the write, so it was not replaced");
    if (!st.isFile()) return notRegular(given, fileKind(st));
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") return fromErrno(given, err, "written");
  }
  try {
    renameSync(temp, leafReal);
    return undefined;
  } catch (err) {
    return fromErrno(given, err, "written");
  }
}

/** No overwrite: a hard link fails if ANYTHING appeared at the name, instead of replacing it. */
function linkInto(given: string, temp: string, leafReal: string): SafeFsFailure | undefined {
  try {
    linkIntoPlace(temp, leafReal);
    tryUnlink(temp);
    return undefined;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "EEXIST") {
      return fail(
        "exists",
        given,
        `${quote(given)} appeared during the write; it was not replaced`,
      );
    }
    if (
      code !== "EPERM" &&
      code !== "ENOTSUP" &&
      code !== "EOPNOTSUPP" &&
      code !== "ENOSYS" &&
      code !== "EXDEV" &&
      code !== "EMLINK"
    ) {
      return fromErrno(given, err, "written");
    }
  }
  // A filesystem without hard links: check, then rename. The window between
  // the two is the only place a racing creator could be clobbered.
  try {
    lstatSync(leafReal);
    return fail("exists", given, `${quote(given)} appeared during the write; it was not replaced`);
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") return fromErrno(given, err, "written");
  }
  try {
    renameSync(temp, leafReal);
    return undefined;
  } catch (err) {
    return fromErrno(given, err, "written");
  }
}

/**
 * Write `data` to `given` inside `root` through an exclusively created,
 * randomly named temp in the same real directory, then move it into place.
 * Refuses a destination whose directory resolves outside the root, a leaf
 * that is a symlink (unless `leafSymlink: "follow-contained"` and it stays
 * inside) or not a regular file, and an existing file without `overwrite`.
 */
export function writeFileSafe(
  root: string,
  given: string,
  data: string | Uint8Array,
  options: WriteOptions,
): WriteResult {
  const begun = beginAtomicWrite(root, given, options);
  if (!begun.ok) return begun;
  try {
    begun.writer.write(data);
  } catch (err) {
    begun.writer.abort();
    if (err instanceof SafeFsError) {
      return fail(err.code, err.path, err.message);
    }
    return fromErrno(given, err, "written");
  }
  return begun.writer.commit();
}
