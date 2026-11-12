/**
 * The vault's file layer. Every read is contained to the vault root, per file, and
 * opens without following a link at the leaf; every write goes through a random temp
 * and a rename, or an in-place append that never follows a link; directories are made
 * one component at a time and refuse a link. Directories are 0700 and files 0600.
 */
import { closeSync, lstatSync, readSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { withFileLock } from "@crewhaus/infra-utils";
import {
  type SafeFsFailure,
  appendContained,
  ensureDirContained,
  openForReadFd,
  openForReadSync,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Why a vault operation stopped. A `reason` names the fix where there is one. */
export type VaultErrorCode =
  | "not-set-up"
  | "locked"
  | "unreadable"
  | "not-found"
  | "unsafe-path"
  | "tampered"
  | "invalid"
  | "exists";

export class VaultError extends Error {
  override readonly name = "VaultError";
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Whether `child` is `parent` or inside it, by `relative()`, never by a string prefix. */
export function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function failed(failure: SafeFsFailure): VaultError {
  const code =
    failure.code === "is-symlink" || failure.code === "escapes-root"
      ? "unsafe-path"
      : failure.code === "not-found"
        ? "not-found"
        : failure.code === "exists"
          ? "exists"
          : "unreadable";
  return new VaultError(code, failure.reason);
}

export type TextRead =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly text: string };

/** A contained regular file's text, or `absent`. A link at the leaf or any other refusal throws. */
export function readText(root: string, rel: string, maxBytes: number): TextRead {
  const read = openForReadSync(root, rel, { maxBytes, followLeafSymlink: false });
  if (!read.ok) {
    if (read.code === "not-found") return { state: "absent" };
    throw failed(read);
  }
  if (read.truncated)
    throw new VaultError("unreadable", `${rel} is larger than a vault file can be`);
  return { state: "present", text: read.text };
}

/** A small contained file and its mode bits, or `absent`. */
export function readWithMode(
  root: string,
  rel: string,
  maxBytes: number,
):
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly text: string; readonly mode: number } {
  const opened = openForReadFd(root, rel, { followLeafSymlink: false });
  if (!opened.ok) {
    if (opened.code === "not-found") return { state: "absent" };
    throw failed(opened);
  }
  try {
    const buffer = new Uint8Array(maxBytes + 1);
    let total = 0;
    for (;;) {
      const n = readSync(opened.fd, buffer, total, buffer.length - total, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new VaultError("unreadable", `${rel} is not a key file`);
    }
    return {
      state: "present",
      text: new TextDecoder().decode(buffer.subarray(0, total)),
      mode: opened.stats.mode,
    };
  } finally {
    closeSync(opened.fd);
  }
}

/** Parse a JSON record, or throw `unreadable` naming the file. */
export function parseJson(rel: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new VaultError("unreadable", `${rel} is not valid JSON`);
  }
}

/** Every complete JSON line of a JSONL text. A torn last line (no newline yet) is skipped. */
export function jsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  const lines = text.split("\n");
  // The last element is what follows the last newline: empty, or a line still being written.
  for (const line of lines.slice(0, -1)) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A damaged line is skipped, never repaired by a read.
    }
  }
  return out;
}

/** Make `rel` (a directory) inside the root, each missing component 0700, refusing a link. */
export function ensureDir(root: string, rel: string): void {
  const made = ensureDirContained(root, rel, { mode: DIR_MODE, symlinks: "refuse" });
  if (!made.ok) throw failed(made);
}

function parentOf(rel: string): string | undefined {
  const at = rel.lastIndexOf("/");
  return at === -1 ? undefined : rel.slice(0, at);
}

/** Replace `rel` with `text` atomically, never through a link; a new file is 0600. */
export function writeText(root: string, rel: string, text: string, overwrite = true): void {
  const parent = parentOf(rel);
  if (parent !== undefined) ensureDir(root, parent);
  const written = writeFileSafe(root, rel, text, { overwrite, mode: FILE_MODE });
  if (!written.ok) throw failed(written);
}

/** Append one line in place, never through a link or into a file with another name. */
export function appendLine(root: string, rel: string, line: string): number {
  const parent = parentOf(rel);
  if (parent !== undefined) ensureDir(root, parent);
  const appended = appendContained(root, rel, `${line}\n`, {
    create: true,
    mode: FILE_MODE,
    hardLinks: "refuse",
  });
  if (!appended.ok) throw failed(appended);
  return appended.size;
}

/**
 * Whether every component of `rel` below the root is a real directory: absent answers
 * `false`, a link or a file on the way throws. Deletes and directory listings go through
 * it, so neither ever acts through a link.
 */
export function realDir(root: string, rel: string): boolean {
  let at = root;
  for (const part of rel.split("/").filter((p) => p !== "")) {
    at = join(at, part);
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(at);
    } catch {
      return false;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new VaultError("unsafe-path", `${rel} is not a plain directory inside the vault`);
    }
  }
  return true;
}

/** The names in a contained directory that match `pattern`, sorted. Absent is empty. */
export function listNames(root: string, rel: string, pattern: RegExp): string[] {
  if (!realDir(root, rel)) return [];
  return readdirSync(join(root, rel))
    .filter((name) => pattern.test(name))
    .sort();
}

/** The size of a contained file, or `undefined` when it is absent. A link throws. */
export function sizeOf(root: string, rel: string): number | undefined {
  const parent = parentOf(rel);
  if (parent !== undefined && !realDir(root, parent)) return undefined;
  try {
    const entry = lstatSync(join(root, rel));
    if (!entry.isFile()) throw new VaultError("unsafe-path", `${rel} is not a plain file`);
    return entry.size;
  } catch (err) {
    if (err instanceof VaultError) throw err;
    return undefined;
  }
}

/** Delete a contained file; absent is done. Never through a link on the way. */
export function removeFile(root: string, rel: string): void {
  const parent = parentOf(rel);
  if (parent !== undefined && !realDir(root, parent)) return;
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(join(root, rel));
  } catch {
    return;
  }
  if (entry.isDirectory()) throw new VaultError("unsafe-path", `${rel} is a directory`);
  unlinkSync(join(root, rel));
}

/** Delete a contained directory and everything in it; absent is done. A link is removed, never followed. */
export function removeTree(root: string, rel: string): void {
  const parent = parentOf(rel);
  if (parent !== undefined && !realDir(root, parent)) return;
  const path = join(root, rel);
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(path);
  } catch {
    return;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    unlinkSync(path);
    return;
  }
  rmSync(path, { recursive: true, force: true });
}

/**
 * Run `fn` holding the vault's write lock, `<root>/lock`. Anything but a regular file at
 * the lock's name is refused before the lock is created: the exclusive create that takes
 * it follows a dangling link on some systems.
 */
export async function withVaultLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(root, "lock");
  let entry: ReturnType<typeof lstatSync> | undefined;
  try {
    entry = lstatSync(lockPath);
  } catch {
    // Nothing there: the exclusive create decides.
  }
  if (entry !== undefined && !entry.isFile()) {
    throw new VaultError(
      "unsafe-path",
      `${lockPath} is not a lock file — refusing to wait on it, remove it or read it. If nothing should be there, delete it and retry.`,
    );
  }
  return withFileLock(lockPath, fn, {
    label: "people vault",
    createError: (message) => new VaultError("unreadable", message),
  });
}
