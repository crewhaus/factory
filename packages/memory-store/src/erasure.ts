/**
 * `@crewhaus/memory-store/erasure`: removing a person's facts for good, driven only by the
 * erasure door. Every other change to a fact keeps its history; this is the one that does
 * not, so it acts only on a grant the door minted: one whose scope is this store's own root
 * and spec, and that names every id.
 *
 * {@link purge} removes the named facts and {@link purgeWhere} the facts a predicate picks
 * (each still named by the grant): their lines, their tombstones and their annotations, from
 * the live file and from every archive segment. It holds the archive's lock and the fact
 * lock for the whole of it, so no fact is remembered, corrected or compacted in between and
 * a compaction never brings back what it removed. The live file is replaced through a
 * temporary file and a rename; a line a writer appended meanwhile is kept. A re-run that
 * finds nothing writes nothing.
 */
import { closeSync, readSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ErasureGrant, erasureTargets } from "@crewhaus/control-contract/knowledge";
import { withLedgerLock } from "@crewhaus/control-records";
import { openForReadFd, openForReadSync, writeFileSafe } from "@crewhaus/tool-safety/fs";
import {
  MEMORY_FILE_MAX_BYTES,
  type MemoryEntry,
  MemoryStoreError,
  isMemoryEntry,
  isMemorySpecName,
} from "./index";
import { ARCHIVE_SEGMENT_RE, isArchivedLine, memoryLayout } from "./layout";

/** The store a purge acts on. */
export type MemoryErasureAt = { readonly rootDir: string; readonly specName: string };

/** How many lines a purge removed. */
export type MemoryErasure = { readonly live: number; readonly archived: number };

type Seams = { readonly beforeFinalRead?: () => void | Promise<void> };
let seams: Seams = {};

/** Test seam: run code under both locks, before the live file's last read. Pass `undefined` to restore. */
export function _setPurgeSeamsForTest(next: Seams | undefined): void {
  seams = next ?? {};
}

function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** What the grant names for this store, or a refusal: nothing is read or written without it. */
function targetsOf(at: MemoryErasureAt, grant: ErasureGrant): ReadonlySet<string> {
  if (!isMemorySpecName(at.specName)) {
    throw new MemoryStoreError(`invalid specName "${at.specName}"`);
  }
  const root = resolve(at.rootDir);
  const targets = erasureTargets(grant, {
    store: "memory",
    spec: at.specName,
    sameRoot: (given) => sameDir(given, root),
  });
  if (targets === undefined) {
    throw new MemoryStoreError(`this erasure does not cover ${at.specName}.jsonl in ${at.rootDir}`);
  }
  return targets;
}

/** Remove these facts. Throws, changing nothing, when the grant does not name one of them. */
export async function purge(
  at: MemoryErasureAt,
  ids: readonly string[],
  grant: ErasureGrant,
): Promise<MemoryErasure> {
  const targets = targetsOf(at, grant);
  const wanted = new Set(ids);
  return eraseFacts(at, targets, () => wanted);
}

/**
 * Remove every fact `pred` picks, live or archived. Throws, changing nothing, when it picks
 * one the grant does not name.
 */
export async function purgeWhere(
  at: MemoryErasureAt,
  pred: (entry: MemoryEntry) => boolean,
  grant: ErasureGrant,
): Promise<MemoryErasure> {
  const targets = targetsOf(at, grant);
  return eraseFacts(
    at,
    targets,
    (entries) => new Set(entries.filter((entry) => pred(entry)).map((entry) => entry.id)),
  );
}

type Line = { readonly text: string; readonly value: unknown };

function parseLine(text: string): Line {
  try {
    return { text, value: JSON.parse(text) as unknown };
  } catch {
    return { text, value: undefined };
  }
}

/** Whether a line is about one of `ids`: the fact itself, or any line that names it as its target. */
function concerns(line: Line, ids: ReadonlySet<string>): boolean {
  const { value } = line;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return ids.has(record["id"] as string) || ids.has(record["target"] as string);
  }
  // A torn line cannot be read; one that holds an erased id goes with it.
  return value === undefined && [...ids].some((id) => line.text.includes(id));
}

async function eraseFacts(
  at: MemoryErasureAt,
  targets: ReadonlySet<string>,
  select: (entries: readonly MemoryEntry[]) => ReadonlySet<string>,
): Promise<MemoryErasure> {
  const root = resolve(at.rootDir);
  const { fileName, archiveDir, ledger, archiveLedger } = memoryLayout(root, at.specName);

  /** The live file from `position`, or `undefined` when it is not there. */
  function readFrom(
    position: number,
  ): { readonly bytes: Buffer; readonly ino: number } | undefined {
    const opened = openForReadFd(root, fileName, { followLeafSymlink: false });
    if (!opened.ok) {
      if (opened.code === "not-found") return undefined;
      throw new MemoryStoreError(`refusing to read ${fileName} in ${root}: ${opened.reason}`);
    }
    try {
      const { size, ino } = opened.stats;
      if (size > MEMORY_FILE_MAX_BYTES) {
        throw new MemoryStoreError(
          `${fileName} in ${root} is larger than ${MEMORY_FILE_MAX_BYTES} bytes, so it was not read`,
        );
      }
      const bytes = Buffer.alloc(Math.max(0, size - position));
      let done = 0;
      while (done < bytes.length) {
        const got = readSync(opened.fd, bytes, done, bytes.length - done, position + done);
        if (got === 0) break;
        done += got;
      }
      return { bytes: bytes.subarray(0, done), ino };
    } finally {
      closeSync(opened.fd);
    }
  }

  /** The archive's segments, contained, each with its lines. */
  function readArchive(): { readonly rel: string; readonly lines: readonly string[] }[] {
    let names: string[];
    try {
      names = readdirSync(join(root, archiveDir), { withFileTypes: true })
        .filter((entry) => entry.isFile() && ARCHIVE_SEGMENT_RE.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      const rel = join(archiveDir, name);
      const read = openForReadSync(root, rel, {
        maxBytes: MEMORY_FILE_MAX_BYTES,
        followLeafSymlink: false,
      });
      if (!read.ok) {
        if (read.code === "not-found") return [];
        throw new MemoryStoreError(`refusing to read ${rel} in ${root}: ${read.reason}`);
      }
      if (read.truncated) {
        throw new MemoryStoreError(
          `${rel} in ${root} is larger than ${MEMORY_FILE_MAX_BYTES} bytes, so it was not read`,
        );
      }
      return [{ rel, lines: split(read.text) }];
    });
  }

  /** The archived line an archive record holds. */
  function archivedLine(text: string): Line {
    const record = parseLine(text);
    if (!isArchivedLine(record.value)) return record;
    if (record.value.line !== undefined) return { text, value: record.value.line };
    return parseLine(record.value.raw ?? "");
  }

  function rewrite(rel: string, lines: readonly string[]): void {
    const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    const written = writeFileSafe(root, rel, body, { overwrite: true, mode: 0o600 });
    if (!written.ok) {
      throw new MemoryStoreError(`refusing to rewrite ${rel} in ${root}: ${written.reason}`);
    }
  }

  /** What both files hold now, and the facts to remove: every one named by the grant. */
  function read() {
    const first = readFrom(0);
    const archive = readArchive();
    const liveLines = first === undefined ? [] : split(first.bytes.toString("utf8"));
    const entries = [
      ...liveLines.map((text) => parseLine(text).value),
      ...archive.flatMap(({ lines }) => lines.map((text) => archivedLine(text).value)),
    ].filter(isMemoryEntry);
    const ids = select(entries);
    for (const id of ids) {
      if (!targets.has(id)) {
        throw new MemoryStoreError("this erasure does not name every fact it was given");
      }
    }
    const held =
      liveLines.some((text) => concerns(parseLine(text), ids)) ||
      archive.some(({ lines }) => lines.some((text) => concerns(archivedLine(text), ids)));
    return { first, archive, liveLines, ids, held };
  }

  async function erase(): Promise<MemoryErasure> {
    const { first, archive, liveLines, ids } = read();

    // The archive first: a crash in between leaves the live lines for the re-run.
    let archived = 0;
    for (const { rel, lines } of archive) {
      const kept = lines.filter((text) => !concerns(archivedLine(text), ids));
      if (kept.length === lines.length) continue;
      rewrite(rel, kept);
      archived += lines.length - kept.length;
    }
    let live = 0;
    if (first !== undefined && liveLines.some((text) => concerns(parseLine(text), ids))) {
      const end = first.bytes.lastIndexOf(0x0a) + 1;
      await seams.beforeFinalRead?.();
      // What a writer that went round a stolen lock appended meanwhile is kept. The file is
      // the same one only when its inode and every byte already read are unchanged: a file
      // system can give a new file the inode of one just removed.
      const again = readFrom(0);
      if (
        again === undefined ||
        again.ino !== first.ino ||
        again.bytes.length < end ||
        !again.bytes.subarray(0, end).equals(first.bytes.subarray(0, end))
      ) {
        throw new MemoryStoreError(
          `${fileName} in ${root} was replaced while it was being erased; nothing in it was changed`,
        );
      }
      const all = [
        ...split(first.bytes.subarray(0, end).toString("utf8")),
        ...split(again.bytes.subarray(end).toString("utf8")),
      ];
      const kept = all.filter((text) => !concerns(parseLine(text), ids));
      rewrite(fileName, kept);
      live = all.length - kept.length;
    }
    return { live, archived };
  }

  // Nothing to remove takes no lock, so it leaves nothing behind.
  if (!read().held) return { live: 0, archived: 0 };
  // The archive's lock, then the fact lock: a compaction takes them one after the other and
  // reads the file again when it was replaced under it.
  const locked = await withLedgerLock(archiveLedger, async () => {
    const inner = await withLedgerLock(ledger, async () => ({ value: await erase() }));
    return inner;
  });
  if ("value" in locked) return locked.value;
  throw new MemoryStoreError(`could not lock ${fileName} in ${root}: ${locked.reason}`);
}

function split(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "");
}
