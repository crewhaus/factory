/**
 * What the two fail-closed readers share: a whole-file read with no lock, no write and
 * no environment variable, and a one-second cache per path through an injected clock.
 * Absent means the file is not there. Everything else that is not a good record is
 * unreadable, and its reason names the file and the fault, never a value from it.
 */
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveContained } from "@crewhaus/tool-safety/fs";
import { decodeStrict, parseObject, readRecordFile } from "./io";

const CACHE_MS = 1000;

export type WholeFileRead =
  | { readonly state: "absent" }
  | { readonly state: "body"; readonly body: Record<string, unknown> }
  | { readonly state: "unreadable"; readonly reason: string };

/**
 * Something else stands where the record's directory goes, so "not there" would be a
 * guess. Every ancestor of the record inside the root is judged, shallowest first, each
 * realpath-contained: the first that is missing makes the record absent, and the first
 * that exists and is not a directory makes it unreadable. Walking the path, rather than
 * judging the record's own directory, gives one answer on every OS: a path through a
 * regular file is ENOTDIR on POSIX and ENOENT on Windows.
 */
function parentIsNotDirectory(root: string, rel: string): boolean {
  const parts = dirname(rel)
    .split(/[\\/]/)
    .filter((part) => part !== "" && part !== ".");
  let prefix = "";
  for (const part of parts) {
    prefix = prefix === "" ? part : join(prefix, part);
    const at = resolveContained(root, prefix, { followLeaf: true });
    if (!at.ok) return false;
    try {
      if (!lstatSync(at.real).isDirectory()) return true;
    } catch (err) {
      return (err as { code?: unknown }).code === "ENOTDIR";
    }
  }
  return false;
}

/** One JSON object file, up to `maxBytes`. A link, a directory or a torn file is unreadable. */
export function readWholeRecord(root: string, rel: string, maxBytes: number): WholeFileRead {
  const read = readRecordFile(root, rel, maxBytes);
  if (!read.ok) {
    if (read.code !== "not-found") return { state: "unreadable", reason: read.reason };
    return parentIsNotDirectory(root, rel)
      ? { state: "unreadable", reason: `the directory of ${rel} is not a directory` }
      : { state: "absent" };
  }
  if (read.truncated) {
    return { state: "unreadable", reason: `${rel} is larger than ${maxBytes} bytes` };
  }
  if (read.bytes.length === 0) return { state: "unreadable", reason: `${rel} is empty` };
  const text = decodeStrict(read.bytes);
  const body = text === undefined ? undefined : parseObject(text);
  return body === undefined
    ? { state: "unreadable", reason: `${rel} is not a JSON object` }
    : { state: "body", body };
}

/**
 * A cached reader: a call answers from the cache while the entry is fresh, and
 * `refresh` reads the file now and keeps that answer for the next second.
 */
export type CachedReader<T> = ((harnessDir: string) => T) & {
  readonly refresh: (harnessDir: string) => T;
};

/** The reader the injected clock drives. Expired entries are dropped on insert. */
export function cachedPerPath<T>(
  readNow: (harnessDir: string) => T,
  now: () => number,
): CachedReader<T> {
  const cache = new Map<string, { readonly at: number; readonly answer: T }>();
  const fresh = (at: number, t: number): boolean => t >= at && t - at < CACHE_MS;
  const keep = (key: string, t: number, answer: T): void => {
    for (const [path, entry] of cache) {
      if (!fresh(entry.at, t)) cache.delete(path);
    }
    cache.set(key, { at: t, answer });
  };
  const read = (harnessDir: string): T => {
    const key = resolve(harnessDir);
    const t = now();
    const hit = cache.get(key);
    if (hit !== undefined && fresh(hit.at, t)) return hit.answer;
    const answer = readNow(harnessDir);
    keep(key, t, answer);
    return answer;
  };
  const refresh = (harnessDir: string): T => {
    const t = now();
    const answer = readNow(harnessDir);
    keep(resolve(harnessDir), t, answer);
    return answer;
  };
  return Object.assign(read, { refresh });
}

export function isText(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
