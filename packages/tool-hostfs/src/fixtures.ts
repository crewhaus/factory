/**
 * Recorded host output. Every parser in this package is tested from these
 * bytes and from nothing else.
 *
 * WHY THIS FILE EXISTS. These three tools read a real machine, and the
 * machine differs: this package was written on macOS 15.6 (Darwin 25.6.0) and
 * its CI runs on Linux. A test that shelled out to the host would pass here,
 * and on CI would either fail or — the outcome that actually costs a day —
 * pass while asserting something entirely different, because `mdfind` is not
 * installed there and `plocate` is not installed here. So every fixture below
 * was captured by running the real program on the real OS, and pasted in
 * verbatim, including its trailing spaces.
 *
 * PROVENANCE, per block:
 *
 *   macOS      Darwin 25.6.0 (macOS 15.6), Apple Silicon, 2026-09-18.
 *              `mdfind`/`mdutil` as shipped with the OS.
 *   Linux      Alpine Linux 3.19 in Docker (kernel 5.10.124-linuxkit),
 *              plocate 1.1.19, GLib 2.80 `gio`, 2026-09-18.
 *   Node       macOS captures on node v25.6.1, Linux on node v24.3.0.
 *
 * ONE BLOCK IS NOT A RECORDING and is labelled as such: the "indexing
 * disabled" form of `mdutil -s`. Every volume on the capture host has
 * Spotlight enabled, and disabling it would have required root and would have
 * changed the machine. That string comes from `mdutil`'s documented output
 * and the parser is written so that anything it does not recognise reads as
 * `unknown` — the safe answer — rather than as `enabled`.
 */

import type { RawWatchEvent } from "./lib/coalesce";

// ---------------------------------------------------------------------------
// fs.watch — recorded event sequences
// ---------------------------------------------------------------------------

/**
 * One recorded notification, exactly as `fs.watch`'s callback delivered it,
 * with the milliseconds since the watch was attached.
 */
export type RecordedWatchEvent = {
  readonly dt: number;
  readonly eventType: string;
  readonly filename: string | null;
};

/**
 * macOS, `fs.watch(dir, { recursive: true })`.
 *
 * THE HEADLINE: every single event is `rename`, including appending one byte
 * to an existing file. There is no `change` anywhere in the macOS capture. A
 * tool that let a caller filter on the raw event type would return nothing on
 * this OS for an ordinary file modification.
 */
export const MACOS_WATCH: Readonly<Record<string, readonly RecordedWatchEvent[]>> = Object.freeze({
  /** `appendFileSync` on an existing file. */
  appendWrite: [{ dt: 93, eventType: "rename", filename: "log.txt" }],
  /** Write `doc.md.tmp12345`, then rename it over `doc.md` — how most editors save. */
  atomicSave: [
    { dt: 93, eventType: "rename", filename: "doc.md.tmp12345" },
    { dt: 145, eventType: "rename", filename: "doc.md.tmp12345" },
    { dt: 145, eventType: "rename", filename: "doc.md" },
    { dt: 145, eventType: "rename", filename: "doc.md" },
  ],
  /** Truncate, write, flush: ONE logical save, several notifications. */
  threeWriteSave: [
    { dt: 94, eventType: "rename", filename: "app.ts" },
    { dt: 146, eventType: "rename", filename: "app.ts" },
  ],
  /** `mkdir -p pkg/src` then a file inside it. macOS reports all three. */
  createNested: [
    { dt: 95, eventType: "rename", filename: "pkg" },
    { dt: 95, eventType: "rename", filename: "pkg/src" },
    { dt: 146, eventType: "rename", filename: "pkg/src/new.ts" },
  ],
  deleteFile: [{ dt: 94, eventType: "rename", filename: "gone.txt" }],
  /** A rename inside the tree: macOS reports BOTH names. */
  renameFile: [
    { dt: 94, eventType: "rename", filename: "old.txt" },
    { dt: 94, eventType: "rename", filename: "new.txt" },
  ],
});

/**
 * Linux, same script, same Node API.
 *
 * Three divergences from macOS, all of them load-bearing:
 *   - a modification is `change` here and `rename` there;
 *   - `createNested` reports ONLY `pkg`. The file created inside the
 *     brand-new directory is missed, because a recursive watch adds the inotify
 *     watch for a new directory after the fact and loses the race;
 *   - a rename reports only the NEW name, where macOS reports both.
 */
export const LINUX_WATCH: Readonly<Record<string, readonly RecordedWatchEvent[]>> = Object.freeze({
  appendWrite: [{ dt: 83, eventType: "change", filename: "log.txt" }],
  atomicSave: [
    { dt: 83, eventType: "rename", filename: "doc.md.tmp12345" },
    { dt: 126, eventType: "rename", filename: "doc.md" },
  ],
  threeWriteSave: [
    { dt: 92, eventType: "change", filename: "app.ts" },
    { dt: 103, eventType: "change", filename: "app.ts" },
    { dt: 115, eventType: "change", filename: "app.ts" },
  ],
  createNested: [{ dt: 89, eventType: "rename", filename: "pkg" }],
  deleteFile: [{ dt: 83, eventType: "rename", filename: "gone.txt" }],
  renameFile: [{ dt: 91, eventType: "rename", filename: "new.txt" }],
});

/**
 * macOS again, same script — but run under BUN 1.3.14 instead of Node, which
 * is the runtime a compiled harness actually uses. The two disagree, and the
 * disagreement is the reason `watch-session.ts` reconciles:
 *
 *     scenario      node (v25.6.1)                          bun (1.3.14)
 *     atomic-save   tmp, tmp, doc.md, doc.md                tmp, tmp
 *     rename-file   old.txt, new.txt                        old.txt
 *     create-nested pkg, pkg/src, pkg/src/new.ts            pkg, pkg/src/new.ts
 *
 * Under Bun, THE RENAME ONTO THE TARGET IS NEVER REPORTED — not with
 * `recursive: true`, and not with `recursive: false` either (checked
 * separately, three runs each, identical every time). So the single most
 * common thing a caller watches for, "my file was saved", arrives as two
 * events about a temp file they never asked about and no event about the file
 * they did. Watching the FILE itself does report it, as `change`.
 *
 * A second Bun-on-macOS observation, from driving the real tool: a write made
 * shortly BEFORE the watch is attached can arrive as the watch's first event.
 * A caller who writes a file and then waits for the next change is told
 * immediately that it changed — which is why an event whose path is
 * byte-for-byte unchanged is dropped as stale.
 */
export const MACOS_WATCH_UNDER_BUN: Readonly<Record<string, readonly RecordedWatchEvent[]>> =
  Object.freeze({
    /** The rename onto `doc.md` is simply absent. */
    atomicSave: [
      { dt: 90, eventType: "rename", filename: "doc.md.tmpABC" },
      { dt: 122, eventType: "rename", filename: "doc.md.tmpABC" },
    ],
    renameFile: [{ dt: 92, eventType: "rename", filename: "old.txt" }],
  });

/**
 * Linux under Bun 1.2.23 (Alpine 3.19), for comparison: identical to the Node
 * capture above, including the missing `pkg/src/new.ts`. The runtime gap is a
 * macOS one.
 */
export const LINUX_WATCH_UNDER_BUN_MATCHES_NODE = true;

/**
 * Turn a recording into the reducer's input.
 *
 * `existsNow` is what an `lstat` would have answered at that moment, which
 * the live watcher observes for real; a recording carries it as a supplied
 * fact so the fold can be tested without a filesystem.
 */
export function replay(
  recorded: readonly RecordedWatchEvent[],
  existsAt: (filename: string, index: number) => boolean,
  baseMs = 1_000_000,
): readonly RawWatchEvent[] {
  return recorded.map((event, index) => ({
    atMs: baseMs + event.dt,
    eventType: event.eventType,
    path: event.filename ?? "",
    existsNow: existsAt(event.filename ?? "", index),
  }));
}

// ---------------------------------------------------------------------------
// mdfind / mdutil — macOS
// ---------------------------------------------------------------------------

/** `mdfind -0 'kMDItemFSName == "*.app"c' -onlyin /Applications`, first six of 106. */
export const MDFIND_APPS_STDOUT = [
  "/Applications/Safari.app",
  "/Applications/Visual Studio Code.app",
  "/Applications/Brave Browser.app",
  "/Applications/Utilities/Adobe Creative Cloud Experience/CCXProcess/CCXProcess.app",
  "/Applications/Claude.app",
  "/Applications/Utilities/Adobe Creative Cloud/ACC/Creative Cloud.app",
].join("\0");

/**
 * A query that matches nothing: exit 0, both streams empty.
 *
 * `mdfind -0 'kMDItemFSName == "*.md"c' -onlyin /no/such/dir` produces
 * exactly the same thing — which is why an empty answer is never reported
 * without asking `mdutil` what state the index is in.
 */
export const MDFIND_EMPTY_STDOUT = "";

/** `mdfind 'kMDItemFSName =='` — a malformed predicate. Note: on STDOUT, exit 1. */
export const MDFIND_BAD_QUERY_STDOUT = "Failed to create query for 'kMDItemFSName =='.\n";

/** `mdfind -- x`. There is no `--` separator; this is the whole reason for that rule. */
export const MDFIND_DOUBLE_DASH_STDOUT = `Unknown option --

Usage: mdfind [-live] [-count] [-onlyin directory] [-name fileName | -s smartFolderName | query]
list the files matching the query
query can be an expression or a sequence of words

\t-attr <attr>      Fetches the value of the specified attribute
\t-count            Query only reports matching items count
\t-onlyin <dir>     Search only within given directory
\t-live             Query should stay active
\t-name <name>      Search on file name only
\t-reprint          Reprint results on live update
\t-s <name>         Show contents of smart folder <name>
\t-0                Use NUL (\`\`\\0'') as a path separator, for use with xargs -0.
`;

/** `mdutil -s /` on a volume with Spotlight on. The trailing space is real. */
export const MDUTIL_ENABLED_STDOUT = "/:\n\tIndexing enabled. \n";

/** `mdutil -s /System/Volumes/Data` — same shape, different volume. */
export const MDUTIL_ENABLED_DATA_STDOUT = "/System/Volumes/Data:\n\tIndexing enabled. \n";

/**
 * `mdutil -s /tmp` — a path that is not a volume root. Exit code 0.
 *
 * This is the case that must NOT be read as "disabled": the volume is indexed
 * fine, `mdutil` was simply asked about the wrong kind of path.
 */
export const MDUTIL_UNKNOWN_STDOUT =
  "/System/Volumes/Data/private/tmp:\n\tError: unknown indexing state.\n";

/** `mdutil -s /Volumes/nonexistent`. Exit code 0, despite the word Error. */
export const MDUTIL_INVALID_PATH_STDOUT = "Error: invalid path `/Volumes/nonexistent'.\n";

/**
 * NOT A RECORDING — see the header. This is `mdutil`'s documented output for
 * a volume with indexing turned off, kept here so the parser has something to
 * be tested against for that branch. Every volume on the capture host is
 * indexed, and turning one off would have meant changing the machine.
 */
export const MDUTIL_DISABLED_STDOUT_UNVERIFIED = "/Volumes/Backup:\n\tIndexing disabled. \n";

// ---------------------------------------------------------------------------
// plocate — Linux
// ---------------------------------------------------------------------------

/** `plocate -0 report` with a fresh database. */
export const PLOCATE_MATCH_STDOUT = "/srv/data/report-2024.txt\0";

/** `plocate -0 --limit 2 txt`: two hits, NUL-terminated, in database order. */
export const PLOCATE_TWO_MATCHES_STDOUT = "/srv/data/-dashfile.txt\0/srv/data/report-2024.txt\0";

/** `plocate -0 -- -dashfile` — a pattern that starts with a dash, after `--`. */
export const PLOCATE_DASH_PATTERN_STDOUT = "/srv/data/-dashfile.txt\0";

/**
 * `plocate -0 zzzznotathing12345` — a genuine miss.
 *
 * EXIT CODE 1. Both streams empty. Identical exit code to the no-database
 * case below, which is the trap this package is written around.
 */
export const PLOCATE_NO_MATCH = Object.freeze({ code: 1, stdout: "", stderr: "" });

/** `plocate foo` before `updatedb` has ever run. Exit 1, message on stderr. */
export const PLOCATE_NO_DATABASE = Object.freeze({
  code: 1,
  stdout: "",
  stderr: "/var/lib/plocate/plocate.db: No such file or directory\n",
});

/** `plocate --statistics` on 1.1.19: the option does not exist. Exit 1. */
export const PLOCATE_UNRECOGNISED_OPTION = Object.freeze({
  code: 1,
  stdout: "",
  stderr: "plocate: unrecognized option: statistics\n",
});

/** `plocate --version`, for the record of which build produced the above. */
export const PLOCATE_VERSION_STDOUT = `plocate 1.1.19
Copyright 2020 Steinar H. Gunderson
License GPLv2+: GNU GPL version 2 or later <https://gnu.org/licenses/gpl.html>.
This is free software: you are free to change and redistribute it.
There is NO WARRANTY, to the extent permitted by law.
`;

// ---------------------------------------------------------------------------
// gio trash — the FreeDesktop reference implementation
// ---------------------------------------------------------------------------

/**
 * `.trashinfo` files written by `gio trash` (GLib 2.80) on Linux, read back
 * byte for byte. `renderTrashInfo` is asserted to reproduce these exactly.
 *
 * Note `spaced name #1 (copy).txt`: `(`, `)` and `#` are all percent-encoded,
 * which `encodeURIComponent` does not do — the reason this package has its
 * own encoder.
 */
export const GIO_TRASHINFO = Object.freeze({
  simple: "[Trash Info]\nPath=/root/work/simple.txt\nDeletionDate=2026-09-19T01:29:18\n",
  spaced:
    "[Trash Info]\nPath=/root/work/spaced%20name%20%231%20%28copy%29.txt\nDeletionDate=2026-09-19T01:29:18\n",
  unicode:
    "[Trash Info]\nPath=/root/work/uni-caf%C3%A9-%C3%BC.txt\nDeletionDate=2026-09-19T01:29:18\n",
  directory: "[Trash Info]\nPath=/root/work/tree\nDeletionDate=2026-09-19T01:29:18\n",
});

/**
 * The original names, in the same order, and the names they were given inside
 * `Trash/files`. `simple.txt` was trashed twice: the second one became
 * `simple.2.txt` — the collision scheme this package reproduces.
 */
export const GIO_TRASH_NAMES = Object.freeze([
  { original: "/root/work/simple.txt", stored: "simple.txt" },
  { original: "/root/work/spaced name #1 (copy).txt", stored: "spaced name #1 (copy).txt" },
  { original: "/root/work/uni-café-ü.txt", stored: "uni-café-ü.txt" },
  { original: "/root/work/tree", stored: "tree" },
  { original: "/root/work/simple.txt", stored: "simple.2.txt" },
]);

/**
 * A SECOND capture, made because the obvious guess about collision names was
 * wrong. Each of these was trashed three times from `/root/work`, and these
 * are the names `Trash/files` ended up holding:
 *
 *     archive.tar.gz  →  archive.tar.gz, archive.2.tar.gz, archive.3.tar.gz
 *     .env            →  .env, .2.env, .3.env
 *     plaindir        →  plaindir, plaindir.2, plaindir.3
 *
 * So the suffix goes before the FIRST dot, not the last, and a leading dot
 * counts as one. `archive.tar.2.gz` — the last-dot answer — is a name that no
 * longer says what the file is.
 */
export const GIO_COLLISION_NAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "archive.tar.gz": ["archive.tar.gz", "archive.2.tar.gz", "archive.3.tar.gz"],
  ".env": [".env", ".2.env", ".3.env"],
  plaindir: ["plaindir", "plaindir.2", "plaindir.3"],
});

/**
 * `gio trash` on a file on a second filesystem (a tmpfs mounted at
 * /mnt/vol), with the home trash on another device. Exit 1:
 *
 *     gio: file:///mnt/vol/onvol.txt: Trashing on system internal mounts is not supported
 *
 * The reference implementation REFUSES rather than copying the file across
 * the device boundary, and the file was still there afterwards. That is the
 * behaviour this package copies: a cross-device trash is a refusal, never a
 * copy-then-unlink.
 */
export const GIO_CROSS_DEVICE_STDERR =
  "gio: file:///mnt/vol/onvol.txt: Trashing on system internal mounts is not supported\n";
