/**
 * Capped, torn-line-tolerant JSONL reading — the only way this package touches
 * an append-only log.
 *
 * NEVER A STORE `list()`. `@crewhaus/session-store`'s `PendingApprovalStore.list()`
 * COMPACTS its backing file as a side effect: it drops expired and superseded
 * lines and rewrites the file. An inbox is polled, and polling must never
 * rewrite an operator's approvals ledger — nor drop the settled records whose
 * history is half of what these tools exist to show. So reads fold the JSONL
 * directly, last-wins by `id`, the upsert rule `persist` documents.
 *
 * THE TAIL, NOT THE HEAD. `@crewhaus/hangar-server`'s reader takes the first
 * `maxBytes` of the file. For an append-only log that keeps the OLDEST records
 * and loses the newest, which for an approvals ledger is exactly backwards: the
 * pending park an operator is looking for is the most recent line. This reader
 * takes the TAIL and drops the first (torn) line, so a capped read loses
 * history rather than losing the thing waiting for a human. Either way the cut
 * is reported — see {@link JsonlRead.truncated}.
 *
 * MISSING IS NOT UNREADABLE. A file that is not there means "nothing has ever
 * been parked here"; a file that exists and could not be opened means "I do not
 * know what is parked here". They are different answers and this reader keeps
 * them apart in {@link JsonlRead.state}, because collapsing them is how a
 * blocked run gets reported as an idle one.
 */
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Default byte cap for one approvals log. Past this the tail is taken. */
export const MAX_JSONL_BYTES = 16 * 1024 * 1024;
/** Default line cap for one approvals log. */
export const MAX_JSONL_LINES = 50_000;

export type JsonlState =
  /** The file is not there. Nothing was ever written — a real, empty answer. */
  | { readonly kind: "missing" }
  /** The file was read (possibly capped — see `truncated`). */
  | { readonly kind: "read" }
  /** The file exists but could not be read. The contents are UNKNOWN. */
  | { readonly kind: "unreadable"; readonly reason: string };

export type JsonlRead = {
  readonly state: JsonlState;
  /** Parsed objects, in file order, unparseable lines skipped. */
  readonly objects: readonly unknown[];
  /** True when the byte or line cap cut the read short. */
  readonly truncated: boolean;
  /** Lines seen within the read window (parseable or not). */
  readonly lineCount: number;
  /** Lines inside the window that failed to parse (torn/garbage). */
  readonly tornCount: number;
  /** Size on disk, or `null` when it could not be measured. */
  readonly bytes: number | null;
};

type TailRead = {
  readonly state: JsonlState;
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number | null;
};

function unreadable(reason: string): TailRead {
  return { state: { kind: "unreadable", reason }, text: "", truncated: false, bytes: null };
}

/** The errno, or a stable placeholder. Never the message: node puts the
 *  ABSOLUTE path in it, which is host layout the caller did not supply. */
function errnoOf(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? "an unidentified error";
}

/**
 * How a log is opened: never through a symbolic link at the leaf (every
 * caller passes a path whose links were already resolved and checked, so a
 * link found here is one that appeared since), and never blocking on a FIFO
 * that has no writer. Both flags are absent on Windows, where they are 0.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * Read at most `maxBytes` from the TAIL of a file.
 *
 * `missing` is distinguished from every other failure: `ENOENT` on open is
 * the one failure that means "no records", and anything else (EACCES, a
 * directory, a symbolic link, a race that truncates the file under the fd) is
 * a genuine unknown. The size and the kind of file are read from the open
 * descriptor, so what is measured is what is read.
 */
export function readTailCapped(path: string, maxBytes: number): TailRead {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (err) {
    const code = errnoOf(err);
    if (code === "ENOENT") {
      // `bytes: 0`, not null: a file that is not there holds zero bytes of
      // ledger, which is a fact rather than a failed measurement — `state`
      // already separates "no file" from "empty file". `null` here would be an
      // unexplained unknown in every caller's result for the commonest case
      // there is, which trains a reader to ignore the nulls that matter.
      return { state: { kind: "missing" }, text: "", truncated: false, bytes: 0 };
    }
    // O_NOFOLLOW reports a link as ELOOP (EMLINK on FreeBSD).
    if (code === "ELOOP" || code === "EMLINK") {
      return unreadable("the path is a symbolic link, which is not followed here");
    }
    return unreadable(`the file could not be opened (${code})`);
  }
  try {
    let size: number;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return unreadable("the path is not a regular file");
      size = stat.size;
    } catch (err) {
      return unreadable(`the file could not be examined (${errnoOf(err)})`);
    }
    const take = Math.min(size, maxBytes);
    const buf = Buffer.alloc(take);
    const read = readSync(fd, buf, 0, take, size - take);
    return {
      state: { kind: "read" },
      text: buf.subarray(0, read).toString("utf8"),
      truncated: size > maxBytes,
      bytes: size,
    };
  } catch (err) {
    return unreadable(`the file could not be read (${errnoOf(err)})`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse a JSONL file under both caps. A byte-cap cut drops the FIRST partial
 * line (the tail read starts mid-record) instead of parsing it torn, and a
 * line-cap cut keeps the LAST `maxLines` — both caps discard history and keep
 * the newest records, because the newest is where a pending park lives.
 *
 * Genuinely torn lines inside the window are skipped and COUNTED, never fatal
 * and never silent: `tornCount > 0` is the caller's signal that the fold saw
 * fewer records than the file holds.
 */
export function readJsonlCapped(
  path: string,
  maxLines: number = MAX_JSONL_LINES,
  maxBytes: number = MAX_JSONL_BYTES,
): JsonlRead {
  const tail = readTailCapped(path, maxBytes);
  if (tail.state.kind !== "read") {
    return {
      state: tail.state,
      objects: [],
      truncated: false,
      lineCount: 0,
      tornCount: 0,
      bytes: tail.bytes,
    };
  }
  let lines = tail.text.split("\n").filter((l) => l.trim() !== "");
  // The tail read began mid-file, so the FIRST surviving line is the torn one.
  if (tail.truncated) lines = lines.slice(1);
  let lineTruncated = false;
  if (lines.length > maxLines) {
    lines = lines.slice(lines.length - maxLines);
    lineTruncated = true;
  }
  const objects: unknown[] = [];
  let tornCount = 0;
  for (const line of lines) {
    try {
      objects.push(JSON.parse(line));
    } catch {
      tornCount += 1; // tolerated — one torn line must not hide the rest
    }
  }
  return {
    state: tail.state,
    objects,
    truncated: tail.truncated || lineTruncated,
    lineCount: lines.length,
    tornCount,
    bytes: tail.bytes,
  };
}
