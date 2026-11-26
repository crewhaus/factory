/**
 * Every file the attention fold opens goes through one reader: realpath-contained to the
 * root it is named under, from the newest end, capped, with a link at the file's name
 * followed only while it stays inside that root. It takes no lock and writes nothing.
 *
 * `stamp` looks at a file without reading it, so a refresh over a harness whose files did
 * not change reads no content. A test hands in a reader that counts.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type TailRead, readRecordFile, readTail } from "@crewhaus/control-records";
import { resolveContained } from "@crewhaus/tool-safety/fs";

/** What one read of a file may take. */
export type ReadCaps = { readonly maxLines: number; readonly maxBytes: number };

export const READ_CAPS: ReadCaps = { maxLines: 5_000, maxBytes: 8 * 1024 * 1024 };

/** A session log is read for its failures only: its newest part. */
export const SESSION_CAPS: ReadCaps = { maxLines: 2_000, maxBytes: 1024 * 1024 };

/** At most this many entries of one folder are listed, newest first. */
export const LIST_MAX = 200;

/** A folder with more entries than this is listed in part, whatever it holds. */
const LIST_SCANNED_MAX = 20_000;

/** A folder's matching entries, newest first by their own change time. */
export type Listing =
  | {
      readonly state: "read";
      readonly entries: readonly { readonly name: string; readonly changedMs: number }[];
      /** More matched than were listed. */
      readonly truncated: boolean;
    }
  | { readonly state: "absent" }
  | { readonly state: "refused" };

export type AttentionReader = {
  /**
   * A file's size and change time, `absent` when it is not there, `escapes` when it lands
   * outside the root. Reads no content.
   */
  stamp(root: string, rel: string): string;
  /** The newest complete lines of a file, contained in `root`. */
  tail(root: string, rel: string, caps: ReadCaps): TailRead;
  /**
   * What a file is once every link is followed (device and inode), so a file reached by
   * several names is read once; `undefined` when it is not there or lands outside `root`.
   */
  identity?(root: string, rel: string): string | undefined;
  /**
   * A folder's entries whose name matches, newest first, at most {@link LIST_MAX}.
   * Contained in `root`; reads no file. A reader without it lists nothing.
   */
  list?(root: string, rel: string, match: RegExp): Listing;
  /**
   * One small file that holds one JSON object, read whole and contained in `root`;
   * `undefined` when it is not there, is larger than `maxBytes`, or holds anything else.
   */
  object?(root: string, rel: string, maxBytes: number): Record<string, unknown> | undefined;
};

export const DEFAULT_READER: AttentionReader = {
  stamp(root, rel) {
    const contained = resolveContained(root, rel);
    if (contained.ok !== true) return "escapes";
    try {
      const stats = statSync(contained.real);
      return `${stats.size}:${stats.mtimeMs}`;
    } catch {
      return "absent";
    }
  },
  tail(root, rel, caps) {
    return readTail(root, rel, { ...caps, followLeafSymlink: true });
  },
  identity(root, rel) {
    const contained = resolveContained(root, rel);
    if (contained.ok !== true) return undefined;
    try {
      const stats = statSync(contained.real);
      return `${stats.dev}:${stats.ino}`;
    } catch {
      return undefined;
    }
  },
  list(root, rel, match) {
    const contained = resolveContained(root, rel);
    if (contained.ok !== true) return { state: "refused" };
    let names: string[];
    try {
      names = readdirSync(contained.real);
    } catch (err) {
      return { state: (err as { code?: unknown }).code === "ENOENT" ? "absent" : "refused" };
    }
    const matching = names.filter((name) => match.test(name));
    const entries: { name: string; changedMs: number }[] = [];
    for (const name of matching.slice(0, LIST_SCANNED_MAX)) {
      try {
        entries.push({ name, changedMs: statSync(join(contained.real, name)).mtimeMs });
      } catch {
        // Gone since the listing.
      }
    }
    entries.sort((a, b) => b.changedMs - a.changedMs || (a.name < b.name ? -1 : 1));
    return {
      state: "read",
      entries: entries.slice(0, LIST_MAX),
      truncated: matching.length > LIST_MAX,
    };
  },
  object(root, rel, maxBytes) {
    const read = readRecordFile(root, rel, maxBytes);
    if (!read.ok || read.truncated) return undefined;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(read.bytes).toString("utf8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  },
};
