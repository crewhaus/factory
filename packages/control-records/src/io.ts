/**
 * The one place this package opens and reads a record file, so a test can count
 * the work. tool-safety's own hooks are not reachable from `./fs`, so the count
 * is taken here, one step before them.
 */
import { readSync } from "node:fs";
import {
  type ContainedFd,
  type ContainedRead,
  type SafeFsCode,
  type SafeFsFailure,
  openForReadFd,
  openForReadSync,
} from "@crewhaus/tool-safety/fs";

/** What a test can watch: every open by the path it named, every read by where and how much. */
export type IoTap = {
  readonly open?: (given: string) => void;
  readonly read?: (position: number, length: number) => void;
};

let tap: IoTap = {};

/** Test seam: count opens and reads. Pass `undefined` to restore. */
export function _setIoTapForTest(next: IoTap | undefined): void {
  tap = next ?? {};
}

/** Open a record for a streaming read. The caller must `closeSync(fd)`. */
export function openRecordFd(root: string, given: string, followLeafSymlink = false): ContainedFd {
  tap.open?.(given);
  return openForReadFd(root, given, { followLeafSymlink });
}

/** Read at most `maxBytes` of a small whole-file record. A link at the leaf is refused. */
export function readRecordFile(root: string, given: string, maxBytes: number): ContainedRead {
  tap.open?.(given);
  return openForReadSync(root, given, { maxBytes, followLeafSymlink: false });
}

/** Read `length` bytes at `position`, fewer only at the end of the file. */
export function readAt(fd: number, into: Uint8Array, length: number, position: number): number {
  tap.read?.(position, length);
  let done = 0;
  while (done < length) {
    const got = readSync(fd, into, done, length - done, position + done);
    if (got === 0) break;
    done += got;
  }
  return done;
}

/** A refusal in tool-safety's own shape, for the reasons only this package can give. */
export function refusal(code: SafeFsCode, path: string, reason: string): SafeFsFailure {
  return { ok: false, code, path, reason };
}

/**
 * A thrown `node:fs` error as a refusal, by its code alone: Node's message quotes
 * the path the syscall used, and a refusal names only the caller's path.
 */
export function ioFailure(path: string, err: unknown, doing: string): SafeFsFailure {
  const code = (err as { code?: unknown }).code;
  const suffix = typeof code === "string" ? `: ${code}` : "";
  return refusal(
    code === "EACCES" || code === "EPERM" ? "permission-denied" : "io-error",
    path,
    `${JSON.stringify(path)} could not be ${doing}${suffix}`,
  );
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The bytes as text, or `undefined` when they are not UTF-8. */
export function decodeStrict(bytes: Uint8Array): string | undefined {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** The value as a plain JSON object, or `undefined`. An array or `null` is not one. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The text parsed to a JSON object, or `undefined`. */
export function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** A caller's cap: a programming error when it is not a number of things. */
export function requireCap(name: string, value: number): void {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new RangeError(`control-records: ${name} must be a number >= 0, got ${String(value)}`);
  }
}
