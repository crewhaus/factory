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
| `ReadLines` | A numbered line range, reading only as far as the range needs |
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

Archives get a second gate. `ArchiveExtract` reads the member list from the
archive's own structures **in this process** — tar's headers, zip's central
directory — rather than from `tar -t` or `unzip -Z1` output, because a member
name can contain a newline and the two tars in the wild quote control
characters differently. It refuses any member whose path escapes the
destination (zip-slip) or whose symlink target does, extracts into a staging
directory, re-checks the result for escaping links, and only then accepts it.
Hand-built malicious archives in `archive-fixtures.ts` test that, because
`tar` and `zip` refuse to *create* such an archive in the first place.

## Determinism

Same call, same tree, same bytes. Listings sort with plain `<` on the raw
string — never `localeCompare`, whose answer depends on the host's locale
data. Time bounds come from the caller as ISO strings, never from the clock;
`TouchFile` will not bump an mtime unless you give it one. Nothing samples a
random source except the temp-file suffix of an atomic write.

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
