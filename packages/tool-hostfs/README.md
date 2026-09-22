# @crewhaus/tool-hostfs

The filesystem work that is about the machine rather than about the files.

| Tool | Answers |
|---|---|
| `WatchPath` | did anything change here, in the next N milliseconds — and how many times |
| `TrashPath` | delete this, but recoverably |
| `OsIndexSearch` | where does this name live, according to the index the OS already keeps |

`@crewhaus/tool-fs` reads and writes files; `@crewhaus/tool-fsx` copies, moves
and removes them. These three need something only the operating system owns: a
change notifier, a trash, and a file index. All three of those differ per
platform in ways that change the answer, so this package is mostly about not
pretending otherwise.

## The rule that shapes the package: an empty answer has to say what it is

Each of these tools has an "I found nothing" result that a caller will act on,
and in each case "nothing" has more than one cause:

- a watch that returns no events may have run out of time, or hit its event
  cap, or been aborted, or failed to attach at all;
- a search that returns no matches may have searched an index that is
  disabled, stale, or was never built — or one whose state could not be read
  at all.

So every result names the reason. `stoppedBy` is always one of `deadline`,
`eventCap`, `aborted` or `watchError`. A search answers with an `outcome` of
`matches`, `noMatches`, `noMatchesUnverified`, `indexUnavailable`,
`unsupported` or `failed`, and an `index` block describing the state of the
thing it asked.

`noMatchesUnverified` is the one worth knowing. `noMatches` is a claim about
the filesystem, and the tool only makes it when the index behind the answer
was confirmed: on macOS that means `mdutil` said the volume is indexed. When
`mdutil` is absent, times out, or reports "unknown indexing state" — and when
the backend's own output was cut off at this package's capture ceiling — the
search came back empty and nobody checked why. That is not evidence the file
is absent, and it is not the same instruction to a caller.

## WatchPath

```jsonc
{ "path": "src", "timeoutMs": 30000, "maxEvents": 1, "recursive": true, "match": "**/*.ts" }
```

**Bounded twice.** `timeoutMs` is required and `maxEvents` defaults to 100.
Whichever bound ends the watch is reported. `maxEvents: 1` is the common
shape — "come back as soon as something settles".

**One save is one event.** Events for the same path inside a settle window
(`settleMs`, default 200ms) fold into one, which reports the `rawCount` it
absorbed. This is not cosmetic. Recorded on real machines:

| What happened | macOS 15.6 (Node) | macOS 15.6 (Bun) | Linux (Node and Bun) |
|---|---|---|---|
| append one byte | 1 × `rename` | 1 × `rename` | 1 × `change` |
| one editor save (truncate, write, flush) | 2 × `rename` | 2 × `rename` | 3 × `change` |
| one atomic save (temp + rename over) | 4 events | **2 events, none for the target** | 2 events |
| rename a file in the tree | old and new name | old name only | new name only |

A caller counting notifications counts three or four saves where a person
counted one.

**The kind is derived, not reported.** `created`, `modified` and `deleted`
come from whether the path existed before the watch and whether it exists now
— never from the platform's own event name, because on macOS *every* event is
`rename`, including a plain append. A filter on the raw name would return
nothing on macOS for exactly the case the tool exists to catch. The raw names
are still returned, as `eventTypes`, as evidence.

**Temp files are dropped by default.** A path that appears and vanishes inside
one window is an editor's temp file; it is counted in `transientDropped`, does
not consume the event cap, and can be asked for with `includeTransient`.

**Two things the notifier gets wrong are corrected, and both are reported.**

*A save the runtime never mentions.* On macOS under Bun — the runtime a
compiled harness runs on — `fs.watch` on a DIRECTORY reports an editor's temp
file appearing and vanishing and reports **nothing** for the rename that puts
it over the target. Node on the same machine reports both. So the commonest
thing anyone watches for arrives as two events about a file nobody asked about
and no event about the one they did. No processing recovers an event that
never arrived, but the filesystem still holds the evidence: when a path this
session never knew about vanishes — the temp-file signature — the containing
directory is read once and anything whose size or timestamps have moved since
the snapshot becomes an event, tagged `reconciled` so the caller can see where
it came from. Bounded to one read per directory per settle window, and skipped
for a directory too large to read cheaply.

*A change that already happened.* Still on macOS: a write made shortly
**before** the watch was attached can arrive as the watch's first event, so a
caller who writes a file and then waits for the next change is told at once
that it changed. A notification naming a path whose size and timestamps are
byte-for-byte what this session last saw is therefore dropped and counted. The
timestamps are compared at nanosecond resolution and include ctime, because a
`chmod` moves ctime and not mtime, and on APFS a chmod microseconds after a
write lands in the same millisecond.

**Two platform limits are reported rather than hidden.** On Linux a file
created inside a directory that was itself created during the watch may never
be reported (a recursive watch adds the new directory's watch after the fact
and loses the race) — the result carries a note saying so. And when the kernel
refuses another watch, `ENOSPC` is surfaced by name, with the
`fs.inotify.max_user_watches` limit that caused it, instead of looking like a
directory where nothing happened.

Settle windows and the deadline are measured on a **monotonic** clock: a wall
clock steps when NTP corrects it or a laptop wakes, and a step backwards while
a window is open is a window that never closes.

## TrashPath — Linux only, on purpose

```jsonc
{ "paths": ["build/stale.log"], "dryRun": true }
```

This tool implements the FreeDesktop trash specification and **refuses on
macOS and Windows**. That is the interesting part of it.

- **macOS.** The Finder trash is an operation — `NSFileManager`'s
  `trashItemAtURL:` — not a directory. It writes the record that makes "Put
  Back" work, and nothing on the command line performs it: Finder scripting
  needs an Automation permission and a logged-in session, and a native binding
  is a dependency this package will not add. Moving a file into `~/.Trash` by
  hand *looks* like trashing while silently losing the restore record. So the
  tool refuses and says all of that. `RemovePath` deletes, and says it deletes.
- **Windows.** The Recycle Bin is reached through the shell API
  (`IFileOperation`, or `SHFileOperation` with `FOF_ALLOWUNDO`). No Windows
  machine was available to record real behaviour from, and an unverified
  deletion path is precisely the failure this tool exists to prevent.

On Linux it does what the spec says, checked against `gio trash`'s own output
byte for byte:

- a `.trashinfo` record with the original path percent-encoded (`spaced name
  #1 (copy).txt` → `spaced%20name%20%231%20%28copy%29.txt` — note that
  `encodeURIComponent` does not encode `(` or `)`, which is why this package
  has its own encoder) and a local-time `DeletionDate`;
- the name claimed with `O_EXCL` before the move, so two processes cannot take
  the same name, and a collision becomes `simple.2.txt` — the suffix goes
  before the FIRST dot, so `archive.tar.gz` becomes `archive.2.tar.gz`;
- directories 0700, records 0600.

**The same-filesystem rule is enforced, and a cross-device trash is never a
copy.** `rename` cannot cross a filesystem. The spec's answer is a trash
directory at the top of the other filesystem: `$topdir/.Trash/$uid` when that
directory exists, is not a symlink and has the sticky bit (both checks are
security checks — a symlink points anywhere, and without the sticky bit any
user can replace another user's trashed files), and `$topdir/.Trash-$uid`
otherwise. When neither can be used the call is **refused with the reason**
and the file is left alone. `gio trash` refuses in the same situation.
Copy-then-unlink would break hard links, change the inode, double the space
used by a large tree, and — on a failure halfway — leave a half-written copy
beside an original the caller believes is in the trash.

**It cannot delete by accident.** There is no `rm`, no `rmSync`, no unlink of
anything a caller named. The single `unlinkSync` in the package removes a
`.trashinfo` record *this call just wrote* when the move that follows it
failed; it is fenced by assertions that the path is inside that trash's `info`
directory and carries the `.trashinfo` suffix, and a test scans the package's
own source to prove it is the only one.

**`dryRun` is the same code.** Every call builds a plan — resolution,
containment, device comparison, trash directory, the name it would claim — and
`dryRun` returns it. The real call applies that plan. There is no second
preview path to drift.

The name is the part that takes care. The real call claims names one at a time
with `O_EXCL`, so two files called `notes.txt` from different directories
become `notes.txt` and `notes.2.txt`. The plan predicts against the filesystem
*and* against the names already promised to earlier entries in the same call —
without that second half the preview promised both of them `files/notes.txt`,
which is a destination the real call never uses.

**Ambiguity is refused, not resolved.** The same path twice, or a path nested
inside another path in the same call, would each "succeed" while one of them
did nothing, and a caller reading `trashed: 2` would believe two things moved.
A mount point, the workspace root, and anything already inside the trash are
refused too.

## OsIndexSearch

```jsonc
{ "query": "invoice", "roots": ["src"], "limit": 20, "exclude": ["**/node_modules/**"] }
```

Named `OsIndexSearch` and not `IndexSearch` because `@crewhaus/tool-state`
already owns that name for BM25 retrieval over an index a harness builds for
itself. This one queries the machine's index and builds nothing.

| Platform | Backend | Content search |
|---|---|---|
| macOS | `mdfind` (Spotlight) | yes |
| Linux | `plocate`, then `locate` | **no** — the database indexes names only |
| Windows | — | unsupported, with the reason |

**A miss and a missing index are different answers.** Recorded from plocate
1.1.19:

```
$ plocate zzzznotathing ; echo $?      # nothing on either stream
1
$ plocate foo ; echo $?                # with no database built
/var/lib/plocate/plocate.db: No such file or directory
1
```

Same exit code. Only one of them means the filesystem has nothing. This
package separates them by the stderr text and reports anything it does not
recognise as `indexUnavailable` rather than as an empty result. On macOS the
equivalent trap is that `mdfind` exits 0 and prints nothing both for a real
miss and for an unindexed volume (and for a `-onlyin` directory that does not
exist), so an empty answer triggers an `mdutil -s` probe of the volume before
it is reported. `mdutil` says `Error: unknown indexing state` for any path that
is not a volume root, and *that* is reported as `unknown` — never as
`disabled`, which would make every ordinary directory a false alarm.

Even an enabled volume carries a caveat on an empty answer, because Spotlight
skips hidden paths, anything under a `.metadata_never_index` marker, and the
privacy list. On Linux an empty answer from a database older than
`staleAfterSeconds` (default two days) says how old it is.

**Scope is applied before the limit.** `plocate` cannot scope a search to a
directory at all, so the backend is asked for twenty times the caller's limit,
the answer is filtered to the search roots, and only then is the limit applied.
The other order answers "nothing here" while the match sits just past the cap.

**Search roots are contained to the workspace**, like every other path in this
monorepo. That is a deliberate narrowing of what an OS index could do: this
tool is a fast path over the workspace, not a way to enumerate a home
directory. Results outside the roots are dropped and counted as `outOfScope`.

**The query is data, everywhere.** On Linux the pattern is passed after `--`,
so `-dashfile` is a filename and not a flag. `mdfind` has no `--` (recorded:
`Unknown option --`, exit 1), so the caller's text never becomes an argv
element at all — it is spliced into a quoted NSPredicate literal with `\` and
`"` escaped, and the argv builder asserts the predicate starts with `kMDItem`
before it will run. An unescaped quote would otherwise close the literal and
turn a filename search into a content search over everything readable.

## Testing, and why there is almost no host in it

Every parser here takes its input through an injected seam, and every test
drives recorded output: `mdfind`, `mdutil` and `fs.watch` captured on macOS
15.6, and `plocate`, `gio trash` and `fs.watch` captured on Alpine Linux 3.19.
The fixtures, with their provenance, are in [`src/fixtures.ts`](src/fixtures.ts).

The seams: `_setRunner` (child processes), `_setWatchFactory` (`fs.watch`),
`_setPlatform`, `_setClock` and `_setMonotonicClock`, `_setIdentity`
(`$HOME`, `$XDG_DATA_HOME`, uid), `_setPathProbe` (including the device
numbers the same-filesystem rule turns on) and `_setRenamer` (so the EXDEV
branch, unreachable on a one-filesystem machine, is actually tested).
`_resetHostSeams()` puts them all back.

Exactly one test touches the real host: a smoke test that runs whatever index
the machine has and asserts only the shape of the answer. On macOS it reaches
Spotlight; on a CI container with no `plocate` it gets `indexUnavailable` —
and both are passes, because the assertion is that the tool describes itself
honestly whatever it is running on.

The trash tests do move real files on a real filesystem, in a temporary
directory. A trash that has never moved a file has not been tested.
