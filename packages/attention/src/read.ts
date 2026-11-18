/**
 * Every file the attention fold opens goes through one reader: realpath-contained to the
 * root it is named under, from the newest end, capped, with a link at the file's name
 * followed only while it stays inside that root. It takes no lock and writes nothing.
 *
 * `stamp` looks at a file without reading it, so a refresh over a harness whose files did
 * not change reads no content. A test hands in a reader that counts.
 */
import { statSync } from "node:fs";
import { type TailRead, readTail } from "@crewhaus/control-records";
import { resolveContained } from "@crewhaus/tool-safety/fs";

/** What one read of a file may take. */
export type ReadCaps = { readonly maxLines: number; readonly maxBytes: number };

export const READ_CAPS: ReadCaps = { maxLines: 5_000, maxBytes: 8 * 1024 * 1024 };

/** A session log is read for its failures only: its newest part. */
export const SESSION_CAPS: ReadCaps = { maxLines: 2_000, maxBytes: 1024 * 1024 };

export type AttentionReader = {
  /**
   * A file's size and change time, `absent` when it is not there, `escapes` when it lands
   * outside the root. Reads no content.
   */
  stamp(root: string, rel: string): string;
  /** The newest complete lines of a file, contained in `root`. */
  tail(root: string, rel: string, caps: ReadCaps): TailRead;
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
};
