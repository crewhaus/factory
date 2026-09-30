# @crewhaus/tool-fsx

Filesystem tools beyond read and write.

`@crewhaus/tool-fs` covers a file's contents — Read, Write, Edit, Glob, Grep.
This package covers everything around them: what a path *is*, what a tree
contains, moving bytes about, archives, and the two file formats a harness
edits constantly and a model should not have to hand-parse.

```yaml
tools:
  - all-fsx         # every tool below
  - -removePath     # ...except this one
```

| Tool | What it does |
|---|---|
| `Stat` | Type, size, mtime, permissions, link count, symlink target and a sha256 |
| `FileHash` | sha256 / sha1 / md5, read in chunks so file size does not matter |
| `Tree` | A directory drawn as a tree: depth-capped, entry-capped, sorted, `.gitignore`-aware |
| `DiskUsage` | Sizes rolled up per directory, largest first |
| `FindFiles` | By name glob, size range, mtime window and type — sorted |
| `ReadLines` | A numbered line range, reading only as far as the range needs, within a character budget |
| `TailFile` | The last N lines, read backwards from the end |
| `MakeDirectory` | Create a directory, with its parents |
| `TouchFile` | Create an empty file; set its timestamps when you supply one |
| `TempDir` | A scratch directory under a name you choose |
| `CopyPath` | Copy a file or tree, with `dryRun` and no accidental overwrite |
| `MovePath` | Move or rename, with the same two guards |
| `RemovePath` | Delete, with `dryRun` counting exactly what would go |
| `SplitFile` | Split into numbered parts by byte size or line count |
| `ConcatFiles` | Join files, in order, into one |
| `ArchiveCreate` | Pack a path into tar, tar.gz or zip |
| `ArchiveList` | List an archive's members and flag any that would escape |
| `ArchiveExtract` | Extract into a destination, refusing anything that escapes it |
| `FrontmatterRead` | Read a markdown file's YAML front matter as data |
| `FrontmatterWrite` | Set or remove front-matter keys, leaving the body alone |
| `NotebookRead` | A Jupyter `.ipynb` as cells, with outputs flattened |
| `NotebookEdit` | Replace, insert or delete one notebook cell |

## Containment

Every caller-supplied path goes through the same guard `@crewhaus/tool-fs`
uses: resolve it, refuse anything landing outside `process.cwd()`, and
re-check the *real* path so a symlink inside the workspace cannot point out of
it. `index.test.ts` proves it for every path-taking tool, three ways — a `..`
path, an absolute path, and an in-workspace symlink to somewhere else.

The guard covers every path a tool writes, not just the one the caller
named. `CopyPath` and `MovePath`'s cross-filesystem fallback copy with
[`@crewhaus/tool-safety`](../tool-safety)'s `copyTreeSafe`: the whole copy is
planned before a byte is written, an existing symlink anywhere under the
destination is refused (even one that stays inside the workspace, as GNU
`cp -R` refuses to merge a directory into a link), a file never replaces a
directory, and FIFOs, sockets and devices in the source are refused. Links
are copied as links, and only when, from where the copy puts them, they lead
inside the workspace or exactly where the original leads (an absolute link
out, such as a virtualenv's interpreter, reaches nothing new and is listed in
the result's `outsideLinks`). `MovePath` judges every link in the tree from its
new place before it renames anything, so `a/b/up -> ../..` cannot be moved one
level up to point out of the workspace. `SplitFile` and `ConcatFiles` write
each file through a temp created with `O_EXCL|O_NOFOLLOW` and renamed into
place, and refuse a part or destination name that is a symlink, with or
without `overwrite`. `copy-containment.test.ts` holds these.

Archives get a second gate. `ArchiveExtract` reads the member list from the
archive's own structures **in this process** — tar's headers, zip's central
directory — rather than from `tar -t` or `unzip -Z1` output, because a member
name can contain a newline and the two tars in the wild quote control
characters differently. It refuses any member whose path escapes the
destination (zip-slip) or whose link does. A link's target is resolved over
the archive's own tree one component at a time, the way the kernel will
resolve it, so `x -> a/b/y/../f` is seen to leave the destination when
`a/b/y` is itself a link to `../..`; text folding would have said `a/b/f`.
A `.tar.gz` is listed from every gzip member, as `tar -xz` reads it, and a
pax `GNU.sparse.name` is read as the member's name, as both tars read it.

It then extracts into a staging directory and checks what was actually
written before accepting any of it: every link resolved through the real
tree, every file's hard-link count (a file with a name outside the tree is
refused), every top-level name against the index, and the bytes written.
`maxBytes` (default 1 GiB, at most 16 GiB) caps the content: an archive whose
index declares more is refused before extraction, `dryRun` and `ArchiveList`
report `totalBytes`, the extractor is stopped once the staging tree passes the
cap, and a zip that wrote more than its index declared is refused as lying.
Hand-built malicious archives in `archive-fixtures.ts` test that, because
`tar` and `zip` refuse to *create* such an archive in the first place.

`ArchiveCreate` stores a symlink as a link in every format (`zip -y`, as
tar does), never the file or directory it points at, and reports any stored
link that leads outside the archived tree, since `ArchiveExtract` will refuse
it.

## Reading and rewriting files

Every read opens the file without following a link at the leaf, and refuses
a FIFO, socket or device before opening it: a plain open of a FIFO blocks
the whole process until something writes to it, and no timeout reaches it.
The walk's `.gitignore` files are read the same way, and one linked out of
the workspace, larger than 1 MiB, or not a regular file contributes no rules.

`ReadLines` returns at most `maxChars` characters of line text in all
(default 262 144, at most 4 Mi). A line that would pass the budget is cut and
listed in `truncatedLines` with its full length (`charsAtLeast` when it runs
on for more than 64 MiB), and the range stops there, with `truncated: true`;
resume from `end + 1`. Lines before `start` are counted, never held.

`FrontmatterWrite` and `NotebookEdit` rewrite a file through a temp and a
rename, and the file keeps its permission bits. A front matter key named
`__proto__` is read, kept and written like any other key; it cannot be *set*
through `FrontmatterWrite` (the input would drop it), and neither can a key
the subset could not read back.

## Determinism

Same call, same tree, same bytes. Listings sort with plain `<` on the raw
string — never `localeCompare`, whose answer depends on the host's locale
data. Time bounds come from the caller as ISO strings, never from the clock;
`TouchFile` will not bump an mtime unless you give it one. Nothing samples a
random source except the temp-file suffix of an atomic write.

## Globs

`FindFiles` names, `exclude` patterns and `.gitignore` rules share one
matcher (`compileGlob`, exported for other packages). It is not a RegExp: a
pattern is split into path segments and matched with the two-pointer
wildcard walk, so `*a*a*a*a*a*a*b` against a 255-character name costs
microseconds where a backtracking engine took hours, and a committed
`.gitignore` line cannot freeze `Tree`. A character class never matches `/`,
negated or not (`a[!x]b` does not match `a/b`), as gitignore(5) says.

## What is deliberately not here

`WatchPath`: unbounded in time, so it has no place among tools a harness may
call freely. Anything already in `@crewhaus/tool-fs`. And the `.gitignore`
matcher does not consult the git index, so a *tracked* file matching a pattern
is still hidden — stated in the source rather than glossed over, and checked
against real `git check-ignore` verdicts in the tests.

## Layout

`src/lib/` holds the pure functions — glob compilation, `.gitignore`
semantics, the front-matter subset, notebook shapes, the tar and zip parsers —
tested in `src/lib.test.ts`. `src/index.ts` wraps them as tools, tested
against real files in `src/index.test.ts` and through `executeTool` in
`src/integration.test.ts`.

## Safety flags

Reads (`Stat`, `FileHash`, `Tree`, `DiskUsage`, `FindFiles`, `ReadLines`,
`TailFile`, `ArchiveList`, `FrontmatterRead`, `NotebookRead`) are `readOnly`
and `concurrencySafe`. Everything else is `destructive` and not
concurrency-safe. `ArchiveCreate` and `ArchiveExtract` spawn `tar` / `zip`, so
they alone declare `scope: "external"` and `ioCapability: "process"`; the
other twenty are `internal` with no io capability. No tool requires a sandbox,
because none runs untrusted code. `src/index.test.ts` asserts every one of
those facts per tool, so a future addition that reaches outside has to change
the assertion deliberately.
