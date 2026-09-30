/**
 * Checking what an extractor actually wrote, before any of it is accepted.
 *
 * `ArchiveExtract` extracts into a staging directory and promotes the result
 * only once this module has cleared it. The archive's own index is checked
 * first (names, link targets, declared sizes), but an index can lie and two
 * programs can read it differently, so the staged TREE is what decides:
 *
 *   - every symlink is resolved the way the kernel resolves it
 *     (`walkContained` from `@crewhaus/tool-safety/fs`: one component at a
 *     time, `..` after each hop, chains through other staged links included)
 *     and must lead inside the staging root;
 *   - a regular file with more hard links than the staged tree holds names
 *     for has a name OUTSIDE it: an extractor talked into linking a file from
 *     elsewhere on the same filesystem;
 *   - anything that is not a regular file, a directory or a link (a FIFO,
 *     a socket, a device) is refused: opening a FIFO blocks until a writer
 *     appears, so one planted as `data.csv` freezes the next tool to read it;
 *   - the bytes written are measured, each inode once, because a zip's
 *     declared sizes are not what `unzip` writes (a 65 KB archive whose
 *     headers both claim 1000 bytes wrote 64 MiB).
 *
 * A scan that could not see the whole tree is "incomplete", and the caller
 * refuses it: "we did not look" is not "nothing is there".
 */
import { type Dirent, lstatSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { walkContained } from "@crewhaus/tool-safety/fs";

/** How many staged entries the post-extraction scan will look at. */
export const STAGING_SCAN_BUDGET = 500_000;
/** Deeper than any path the OS lets an extractor create (PATH_MAX). */
const STAGING_MAX_DEPTH = 4096;

export type StagingScan = {
  /** Every symlink under the staged root that leads outside it: `name -> target`. */
  readonly escaping: string[];
  /** Regular files that also have a name outside the staged tree. */
  readonly linkedOut: string[];
  /**
   * Entries that are neither a regular file, a directory nor a link: a FIFO,
   * a socket or a device, `name (kind)`. Refused, never promoted: opening a
   * FIFO blocks until a writer appears.
   */
  readonly special: string[];
  /** Apparent bytes of regular files, each inode counted once. */
  readonly bytes: number;
  /**
   * True when some part of the staged tree was NOT inspected: the budget ran
   * out, a directory would not open, or an entry could not be examined.
   */
  readonly incomplete: boolean;
};

/**
 * Inspect every entry of a just-extracted tree. Nothing is skipped: not
 * `.git` (a member called `pkg/.git/pwn -> /etc/passwd` must be seen), not
 * dot-files, not deep paths.
 */
export function scanStagedTree(root: string, budget = STAGING_SCAN_BUDGET): StagingScan {
  const walked = walkContained(root, ".", {
    maxEntries: budget,
    maxDepth: STAGING_MAX_DEPTH,
    maxVisited: budget + 1,
  });
  if (!walked.ok) return { escaping: [], linkedOut: [], special: [], bytes: 0, incomplete: true };
  let incomplete = walked.truncated || walked.unreadable.length > 0;
  const escaping: string[] = [];
  const special: string[] = [];
  const inodes = new Map<string, { names: number; nlink: number; size: number; rel: string }>();
  for (const entry of walked.entries) {
    if (entry.kind === "symlink") {
      if (entry.link === undefined || !entry.link.inside) {
        escaping.push(`${entry.rel} -> ${entry.link?.text ?? "?"}`);
      }
      continue;
    }
    if (entry.kind !== "file") {
      if (entry.kind !== "directory") special.push(`${entry.rel} (${entry.kind})`);
      continue;
    }
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(entry.real);
    } catch {
      incomplete = true;
      continue;
    }
    const key = `${stats.dev}:${stats.ino}`;
    const seen = inodes.get(key);
    if (seen === undefined) {
      inodes.set(key, { names: 1, nlink: stats.nlink, size: stats.size, rel: entry.rel });
    } else {
      seen.names += 1;
    }
  }
  let bytes = 0;
  const linkedOut: string[] = [];
  for (const inode of inodes.values()) {
    bytes += inode.size;
    if (inode.nlink > inode.names) linkedOut.push(inode.rel);
  }
  const sort = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    escaping: escaping.sort(sort),
    linkedOut: linkedOut.sort(sort),
    special: special.sort(sort),
    bytes,
    incomplete,
  };
}

/**
 * Apparent bytes of the regular files under `root` so far, each inode once,
 * or `undefined` when more than `budget` entries were seen. Iterative and
 * never follows a link. Used while an extractor is still writing, so an
 * entry that vanishes mid-count is simply not counted.
 */
export function measureTree(root: string, budget = STAGING_SCAN_BUDGET): number | undefined {
  let bytes = 0;
  let seen = 0;
  const inodes = new Set<string>();
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      seen += 1;
      if (seen > budget) return undefined;
      const abs = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!dirent.isFile()) continue;
      try {
        const stats = lstatSync(abs);
        const key = `${stats.dev}:${stats.ino}`;
        if (inodes.has(key)) continue;
        inodes.add(key);
        bytes += stats.size;
      } catch {
        // gone since the listing
      }
    }
  }
  return bytes;
}

export type SizeWatch = {
  /** Fires when the tree passes `maxBytes` (or the count's own budget). */
  readonly signal: AbortSignal;
  /** True once the watch has fired. */
  exceeded(): boolean;
  stop(): void;
};

/**
 * Poll `root` every `intervalMs` and abort once it holds more than
 * `maxBytes`. The extractor runs under this signal, so a lying archive is
 * killed within about one interval of passing the cap instead of filling the
 * disk until its timeout; the scan after it is the exact check. A count runs
 * on this thread, so on a large tree the next one waits at least four times
 * as long as the last one took: the watch never takes more than a fifth of
 * the event loop.
 */
export function watchTreeSize(root: string, maxBytes: number, intervalMs = 250): SizeWatch {
  const controller = new AbortController();
  let fired = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    if (fired || stopped) return;
    const started = performance.now();
    const bytes = measureTree(root);
    if (bytes === undefined || bytes > maxBytes) {
      fired = true;
      controller.abort(new Error("the extracted content passed its byte budget"));
      return;
    }
    const took = performance.now() - started;
    timer = setTimeout(check, Math.max(intervalMs, 4 * took));
  };
  timer = setTimeout(check, intervalMs);
  return {
    signal: controller.signal,
    exceeded: () => fired,
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
