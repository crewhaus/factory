/**
 * The file-backed store beneath every tool in this package.
 *
 * There is no database and no server: the whole of a harness's state is a
 * directory of small JSON and JSONL files under the workspace, which means it
 * can be inspected with `cat`, diffed, committed, copied to another machine,
 * and deleted by removing a folder. What this layer owns is the four things
 * that are easy to get wrong when several agents share that directory:
 *
 *   CONTAINMENT   the state directory is resolved through `resolveSafe`, so a
 *                 caller-supplied `stateDir` cannot reach outside the
 *                 workspace, and every interior path is re-checked through
 *                 `resolveWithin` — lexically AND against its real location,
 *                 so a symlink sitting inside the state directory cannot be
 *                 written through.
 *   ATOMICITY     a whole-file write goes to a temporary file and is renamed
 *                 over the target, so a reader never sees a half-written
 *                 record and a crash mid-write leaves the old one intact.
 *   EXCLUSION     read-modify-write sequences (compare-and-set, counters,
 *                 sequence allocation) run under a lock file with a deadline;
 *                 a lock older than `LOCK_STALE_MS` is treated as abandoned.
 *   TOLERANCE     every read reports "missing", "corrupt" or "too large"
 *                 rather than throwing, because a truncated file is a normal
 *                 thing to find after a killed process and the caller needs to
 *                 be told which file it was.
 *
 * The honest limits: the lock is cooperative and machine-local, so it does
 * nothing against a process that ignores it or against two machines sharing a
 * directory over NFS; and append ordering between processes is whatever
 * `O_APPEND` gives, which is atomic per write on local filesystems but not
 * guaranteed on network ones.
 */
import { createHash } from "node:crypto";
import {
  type Dirent,
  type Stats,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import * as path from "node:path";
import { compareStrings } from "./lib/names";
import {
  type SafePath,
  ToolPermissionError,
  isInside,
  resolveSafe,
  resolveWithin,
  toPosix,
} from "./paths";

/** Where state lives when the caller does not say otherwise. */
export const DEFAULT_STATE_DIR = ".crewhaus/state";

/** Largest single record, index or export file this package will read. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** How long a lock is waited for before the write is refused. */
export const LOCK_WAIT_MS = 2_000;
/** A lock file older than this is assumed to belong to a dead process. */
export const LOCK_STALE_MS = 30_000;
/** How deep a walk of the state directory goes before it calls it truncated. */
export const MAX_WALK_DEPTH = 32;

/** The outcome of reading a file that may legitimately be absent or broken. */
export type ReadOutcome<T> =
  | { readonly kind: "ok"; readonly value: T; readonly stats: Stats }
  | { readonly kind: "missing" }
  | { readonly kind: "corrupt"; readonly reason: string };

/**
 * Resolve the state directory for this call. Throws `ToolPermissionError`
 * when the caller points it outside the workspace.
 */
export function stateRoot(toolName: string, stateDir: string | undefined): SafePath {
  return resolveSafe(toolName, stateDir ?? DEFAULT_STATE_DIR);
}

/**
 * Join segments beneath the state root and check containment BOTH ways.
 *
 * Lexically first — most segments come from `encodeSegment`, which cannot
 * emit a separator, but `StateImport`'s come straight out of a document and
 * may be anything. Then through `resolveWithin`, because a lexical check is
 * blind to the case that actually gets exploited: an ordinary-looking
 * `kv/cache` that is a symlink to `/tmp`, which makes a textually-contained
 * path write outside the workspace (CWE-59). A dangling symlink is refused
 * for the same reason — `open(…, "a")` would follow it and create the target.
 *
 * The returned path is the lexical one, which is what the result messages and
 * `relativeToRoot` are expressed in; the residual check-to-use window is the
 * usual one, and is narrower than the lifetime of any single tool call.
 */
export function statePath(toolName: string, root: SafePath, ...segments: string[]): string {
  const label = segments.join("/");
  const joined = path.join(root.abs, ...segments);
  if (!isInside(root.abs, joined)) throw new ToolPermissionError(toolName, label);
  resolveWithin(toolName, root.real, joined, label);
  return joined;
}

/** Path relative to the state root, `/`-separated, for echoing in results. */
export function relativeToRoot(root: SafePath, abs: string): string {
  return toPosix(path.relative(root.abs, abs));
}

export function ensureDir(abs: string): void {
  mkdirSync(abs, { recursive: true });
}

/**
 * Read a file into a buffer sized from its own stat, never larger than
 * `maxBytes + 1`.
 *
 * `readFileSync` sizes itself from the file, so a file that grows between the
 * stat that approved it and the read that follows is read in full — the cap
 * is then a cap on what was CHECKED, not on what is allocated. One byte over
 * the expected size is enough to detect the growth and refuse it.
 */
function readCapped(abs: string, expectedBytes: number, maxBytes: number): Buffer {
  const room = Math.min(expectedBytes, maxBytes) + 1;
  const fd = openSync(abs, "r");
  try {
    const buffer = Buffer.allocUnsafe(room);
    let filled = 0;
    // `read(2)` is allowed to return fewer bytes than asked for, so a single
    // call could silently truncate a large file into "valid" content. Loop
    // until it is full or the file ends.
    for (;;) {
      const read = readSync(fd, buffer, filled, room - filled, filled);
      if (read <= 0) break;
      filled += read;
      if (filled >= room) break;
    }
    return buffer.subarray(0, filled);
  } finally {
    closeSync(fd);
  }
}

/** Read a UTF-8 file, reporting absence and over-size instead of throwing. */
export function readTextFile(abs: string, maxBytes = MAX_FILE_BYTES): ReadOutcome<string> {
  let stats: Stats;
  try {
    stats = statSync(abs);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { kind: "missing" };
    throw err;
  }
  if (stats.isDirectory())
    return { kind: "corrupt", reason: "expected a file but found a directory" };
  // A FIFO stats as size 0, and `readFileSync` on one BLOCKS UNTIL A WRITER
  // OPENS IT — forever, with no deadline anywhere in this package to stop it.
  // Sockets and devices are no better. Only a regular file is read.
  if (!stats.isFile())
    return { kind: "corrupt", reason: "not a regular file, so it is not something to read" };
  if (stats.size > maxBytes) {
    return {
      kind: "corrupt",
      reason: `file is ${stats.size} bytes, over the ${maxBytes} limit for this tool`,
    };
  }
  // Read at most `maxBytes + 1` so a file that grew between the stat and the
  // read cannot pull more than the cap into memory; the extra byte is what
  // detects the growth.
  let buffer: Buffer;
  try {
    buffer = readCapped(abs, stats.size, maxBytes);
  } catch (err) {
    // Deleted between the stat and the open: absent is the honest answer, and
    // a listing that met the file a moment ago should not fail over it.
    if (errorCode(err) === "ENOENT") return { kind: "missing" };
    throw err;
  }
  if (buffer.byteLength > stats.size || buffer.byteLength > maxBytes) {
    return {
      kind: "corrupt",
      reason: "file changed size while it was being read — retry once it has settled",
    };
  }
  if (buffer.includes(0)) {
    return {
      kind: "corrupt",
      reason: "file contains NUL bytes, so it is not the text this store writes",
    };
  }
  return { kind: "ok", value: buffer.toString("utf8"), stats };
}

/** Read and parse a JSON file. A parse failure is corruption, not a crash. */
export function readJsonFile(abs: string, maxBytes = MAX_FILE_BYTES): ReadOutcome<unknown> {
  const text = readTextFile(abs, maxBytes);
  if (text.kind !== "ok") return text;
  try {
    return { kind: "ok", value: JSON.parse(text.value), stats: text.stats };
  } catch (err) {
    return { kind: "corrupt", reason: `not valid JSON: ${(err as Error).message}` };
  }
}

let tempCounter = 0;

/**
 * Write JSON atomically: a temporary sibling, then a rename over the target.
 * The temporary name is derived from the pid and a counter rather than a
 * random suffix, so a crashed run leaves a name you can recognise.
 */
export function writeJsonAtomic(abs: string, value: unknown): number {
  ensureDir(path.dirname(abs));
  const body = `${JSON.stringify(value)}\n`;
  tempCounter += 1;
  const temp = `${abs}.tmp-${process.pid}-${tempCounter}`;
  const fd = openSync(temp, "wx");
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, abs);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // the rename failed and so did the cleanup; the original is still intact
    }
    throw err;
  }
  return Buffer.byteLength(body, "utf8");
}

/**
 * Append one line with `O_APPEND`, so the kernel places it at the end of the
 * file as a single write and two concurrent appenders cannot split each
 * other's lines.
 */
export function appendLine(abs: string, line: string): void {
  ensureDir(path.dirname(abs));
  const fd = openSync(abs, "a");
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

/**
 * Create a file only if it does not exist. The exclusive create is the
 * atomicity primitive behind `DedupeMark` and checkpoint version allocation:
 * exactly one caller can win, with no lock involved.
 */
export function createExclusive(abs: string, body: string): boolean {
  ensureDir(path.dirname(abs));
  let fd: number;
  try {
    fd = openSync(abs, "wx");
  } catch (err) {
    if (errorCode(err) === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return true;
}

export type LockOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/**
 * Run `body` while holding a lock file, waiting up to `waitMs` for it.
 *
 * Cooperative and machine-local: it serialises the read-modify-write sequences
 * in this package against each other, which is what stops two agents in one
 * workspace from clobbering a counter. It is not a distributed lock.
 */
export async function withLock<T>(
  lockPath: string,
  body: () => T | Promise<T>,
  waitMs = LOCK_WAIT_MS,
): Promise<LockOutcome<T>> {
  ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      const age = lockAgeMs(lockPath);
      if (age !== undefined && age > LOCK_STALE_MS) {
        try {
          unlinkSync(lockPath);
        } catch {
          // somebody else broke it first; loop round and try to take it
        }
        continue;
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          reason: `another writer has held the lock on ${path.basename(lockPath)} for more than ${waitMs}ms — retry, or remove the lock file if you are sure no other agent is running`,
        };
      }
      await Bun.sleep(5);
    }
  }
  try {
    return { ok: true, value: await body() };
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // already gone (broken as stale by another waiter); nothing to undo
    }
  }
}

function lockAgeMs(lockPath: string): number | undefined {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Names of the entries in a directory, sorted, or `[]` when it is absent. */
export function listNames(dirAbs: string, kind: "file" | "dir"): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch (err) {
    if (errorCode(err) === "ENOENT" || errorCode(err) === "ENOTDIR") return [];
    throw err;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.includes(".tmp-") || entry.name.endsWith(".lock")) continue;
    if (kind === "file" ? entry.isFile() : entry.isDirectory()) names.push(entry.name);
  }
  return names.sort(compareStrings);
}

export type WalkedFile = {
  /** Path relative to the walk root, `/`-separated. */
  readonly path: string;
  readonly abs: string;
  readonly bytes: number;
};

/**
 * Every regular file under `rootAbs`, sorted by relative path. Symlinks are
 * skipped rather than followed: an export should carry the state directory's
 * own bytes, never whatever a link inside it happens to point at.
 */
export function walkFiles(
  rootAbs: string,
  maxFiles: number,
  maxDepth = MAX_WALK_DEPTH,
): {
  files: WalkedFile[];
  truncated: boolean;
} {
  const files: WalkedFile[] = [];
  let truncated = false;
  const visit = (dir: string, prefix: string, depth: number): void => {
    if (truncated) return;
    // A state directory is three levels deep. Anything far past that is a
    // tree somebody else made, and the walk stops rather than descending it
    // for however long it happens to go on.
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (errorCode(err) === "ENOENT") return;
      throw err;
    }
    const sorted = entries.slice().sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of sorted) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(abs, rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.includes(".tmp-") || entry.name.endsWith(".lock")) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const bytes = fileSize(abs);
      // Deleted between the readdir and the stat: it is not in the export,
      // and that is not a reason to fail the whole export.
      if (bytes === undefined) continue;
      files.push({ path: rel, abs, bytes });
    }
  };
  visit(rootAbs, "", 0);
  return { files, truncated };
}

/** The size of a file, or `undefined` when it has gone or cannot be stat'd. */
export function fileSize(abs: string): number | undefined {
  try {
    const stats = statSync(abs);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

/** Remove a file, reporting whether it was there. */
export function removeFile(abs: string): boolean {
  try {
    unlinkSync(abs);
    return true;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
}

/** Remove a directory tree. Used only by `StateImport` in replace mode. */
export function removeTree(abs: string): void {
  rmSync(abs, { recursive: true, force: true });
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The `errno` code of a Node filesystem error, when it has one. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * A readable sentence for an I/O failure a caller can act on (permissions, a
 * full disk, a path that is not a directory). Anything else returns
 * `undefined` and is re-thrown, because a bug should not be disguised as a
 * tool result.
 */
export function describeIoError(err: unknown): string | undefined {
  const code = errorCode(err);
  if (code === undefined) return undefined;
  const message = err instanceof Error ? err.message : String(err);
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `permission denied: ${message}`;
    case "ENOSPC":
      return `no space left on the device: ${message}`;
    case "EROFS":
      return `the filesystem is read-only: ${message}`;
    case "ENOTDIR":
      return `a path component is not a directory: ${message}`;
    case "EISDIR":
      return `expected a file but found a directory: ${message}`;
    case "EMFILE":
    case "ENFILE":
      return `too many open files: ${message}`;
    case "ENAMETOOLONG":
      return `the resulting filename is too long: ${message}`;
    default:
      return undefined;
  }
}

/**
 * Atomically write raw bytes — the binary counterpart of `writeJsonAtomic`,
 * used only by `StateImport` when restoring a base64-carried entry.
 */
export function writeBuffer(abs: string, body: Buffer): number {
  ensureDir(path.dirname(abs));
  tempCounter += 1;
  const temp = `${abs}.tmp-${process.pid}-${tempCounter}`;
  const fd = openSync(temp, "wx");
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, abs);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // the rename failed and so did the cleanup; the original is still intact
    }
    throw err;
  }
  return body.byteLength;
}

/**
 * Read raw bytes, for the one case text cannot carry: a binary state file.
 * `undefined` when the file is larger than `maxBytes`, or is not a regular
 * file, rather than pulling something unbounded into memory.
 */
export function readBytes(abs: string, maxBytes = MAX_FILE_BYTES): Buffer | undefined {
  try {
    const stats = statSync(abs);
    if (!stats.isFile() || stats.size > maxBytes) return undefined;
    const buffer = readCapped(abs, stats.size, maxBytes);
    return buffer.byteLength > stats.size ? undefined : buffer;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined;
    throw err;
  }
}
