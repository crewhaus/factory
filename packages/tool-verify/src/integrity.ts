/**
 * The walk behind the integrity answers: ChecksumVerify's "nothing on disk
 * that the manifest does not mention" and GoldenCompare's tree compare.
 *
 * `filesUnder` in index.ts is a convenience walker for finding documents: it
 * skips dotfiles, `node_modules`, `dist` and the like, ignores symlinks, and
 * stops quietly at its cap. Every one of those is a hole in an integrity
 * check: an `.npmrc` or a `node_modules/x.js` slipped into a release
 * directory passed ChecksumVerify, a tampered `.github/workflows/ci.yml`
 * passed GoldenCompare, and the 20,001st file was never looked at, all with
 * `ok: true`.
 *
 * This walk sees every entry. It never follows a link (tool-safety's
 * `walkContained` lstats everything), it names a link, a FIFO or a device as
 * what it is so nothing opens one by mistake, it reports a directory it could
 * not list, and it says when it stopped early. What it leaves out is only
 * what the caller named in `exclude`, and the caller gets that list back.
 */
import { type FileKind, walkContained } from "@crewhaus/tool-safety/fs";

export type IntegrityEntry = {
  /** Slash-separated path relative to the walked directory. */
  readonly rel: string;
  /** Physical path, inside the workspace. */
  readonly real: string;
  readonly kind: FileKind;
  /** For a link: its target text, and whether that leads inside the workspace. */
  readonly link?: { readonly text: string; readonly inside: boolean; readonly dangling: boolean };
};

export type IntegrityWalk =
  | {
      readonly ok: true;
      /** Every entry that is not a directory, in sorted depth-first order. */
      readonly entries: ReadonlyArray<IntegrityEntry>;
      /** The walk stopped before the end; what it did not reach is unknown. */
      readonly truncated: boolean;
      /** Directories that could not be listed, relative to the walked one. */
      readonly unreadableDirs: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly reason: string };

/** Most entries (files, links and directories) one integrity walk visits. */
export const INTEGRITY_MAX_ENTRIES = 50_000;
/** Deepest directory level walked; deeper is `truncated`, never skipped quietly. */
export const INTEGRITY_MAX_DEPTH = 256;

let defaults = { maxEntries: INTEGRITY_MAX_ENTRIES, maxDepth: INTEGRITY_MAX_DEPTH };

/**
 * Test seam: the caps the tools walk under, so a test can reach them with a
 * handful of files instead of fifty thousand. Pass `undefined` to restore.
 */
export function _setIntegrityLimitsForTest(
  next: { readonly maxEntries: number; readonly maxDepth: number } | undefined,
): void {
  defaults = next ?? { maxEntries: INTEGRITY_MAX_ENTRIES, maxDepth: INTEGRITY_MAX_DEPTH };
}

/** The caps a tool call walks under (the constants, unless a test changed them). */
export function integrityLimits(): { readonly maxEntries: number; readonly maxDepth: number } {
  return defaults;
}

/**
 * Walk `dir` (workspace-relative; "" is the workspace root) completely,
 * except the relative paths in `exclude`, each of which leaves out that
 * entry and everything under it.
 */
export function integrityWalk(
  root: string,
  dir: string,
  options: {
    readonly maxEntries?: number;
    readonly maxDepth?: number;
    readonly exclude?: ReadonlyArray<string>;
  } = {},
): IntegrityWalk {
  const exclude = new Set((options.exclude ?? []).map((p) => p.replace(/^\.\/+|\/+$/g, "")));
  const walked = walkContained(root, dir === "" ? "." : dir, {
    maxEntries: options.maxEntries ?? defaults.maxEntries,
    maxDepth: options.maxDepth ?? defaults.maxDepth,
    ...(exclude.size === 0 ? {} : { filter: (e) => (exclude.has(e.rel) ? "prune" : "keep") }),
  });
  if (!walked.ok) return { ok: false, reason: walked.reason };
  const entries: IntegrityEntry[] = [];
  for (const e of walked.entries) {
    if (e.kind === "directory") continue;
    entries.push({
      rel: e.rel,
      real: e.real,
      kind: e.kind,
      ...(e.link === undefined ? {} : { link: e.link }),
    });
  }
  return {
    ok: true,
    entries,
    truncated: walked.truncated,
    unreadableDirs: walked.unreadable.map((u) => `${u.rel}: ${u.reason}`),
  };
}
